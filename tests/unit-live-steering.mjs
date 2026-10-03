// A steer Pi hands the bridge together with tool results goes to the RUNNING
// Claude Code query, before those results are released, so Claude's very next
// response follows it. Priority "next": Claude Code 2.1.283 answers a pending
// MCP call with an interrupted error under "now" and discards its result.
import "./lib/debug-env.mjs";

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Type } from "@earendil-works/pi-ai";
import { openSession } from "cc-session-io";

import { __testGetBridgeIntegrityState, __testSetBridgeIntegrityState, __testSetSdkQueryFactory, conversationFingerprint, onPiHistoryReplaced, streamClaudeAgentSdk } from "../src/index.ts";
import { setExtensionApi } from "../src/bridge-state.ts";
import { historyDigest } from "../src/history-digest.ts";
import { ctx, resetStack } from "../src/query-state.ts";
import { runInRequestLane } from "../src/request-lane.ts";

const model = { id: "claude-haiku-4-5", name: "Claude Haiku", api: "claude-bridge", provider: "pi-claude", baseUrl: "claude-bridge", reasoning: true, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 8192 };
const SLOW = { name: "slow_tool", description: "A slow tool", parameters: Type.Object({}) };
const SESSION = "live-session";
const LANE = "LIVE";

let clock = Date.now();
const user = (content) => ({ role: "user", content, timestamp: clock++ });
const toolResult = (id) => ({ role: "toolResult", toolCallId: id, toolName: SLOW.name, content: [{ type: "text", text: `result ${id}` }], isError: false, timestamp: clock++ });
const system = { role: "system", content: "test system prompt", toolsAdded: [SLOW], timestamp: 0 };
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
async function collect(stream) {
	const events = [];
	for await (const event of stream) events.push(event);
	return events;
}
async function waitFor(check, what) {
	const deadline = Date.now() + 1000;
	while (!check() && Date.now() < deadline) await tick(5);
	assert.ok(check(), `timed out waiting for ${what}`);
}
async function promptText(prompt) {
	if (typeof prompt === "string") return prompt;
	const parts = [];
	for await (const message of prompt) for (const block of message.message.content) if (block.type === "text") parts.push(block.text);
	return parts.join("");
}
const textTurn = (text) => [
	{ type: "stream_event", event: { type: "message_start", message: { id: `m-${text}-${clock++}`, model: model.id, usage: { input_tokens: 1 } } } },
	{ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
	{ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } },
	{ type: "stream_event", event: { type: "content_block_stop", index: 0 } },
	{ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } } },
	{ type: "stream_event", event: { type: "message_stop" } },
];

/** Fake Claude Code. The first query calls `slow_tool` once per id of each
 *  entry of `turns`, through the real MCP server, one handler after the other
 *  like the SDK; `abandon` makes it give up on each call (answer it itself)
 *  instead of waiting. Every later query records its prompt and answers.
 *  streamInput is the SDK's: it takes an item, "writes" it (waiting for
 *  `observed.writeGate`), and only then asks for the next one; `writeFails`
 *  makes the write throw. */
function installFakeClaudeCode(turns, { abandon = false, writeFails = false } = {}) {
	const observed = { queries: 0, prompts: [], resumes: [], inputs: [], log: [], results: {}, writeGate: null, abandoned: Promise.withResolvers() };
	__testSetSdkQueryFactory(({ prompt, options }) => {
		observed.queries += 1;
		observed.resumes.push(options.resume ?? null);
		const first = observed.queries === 1;
		let closed = false;
		const closing = Promise.withResolvers();
		return {
			async *[Symbol.asyncIterator]() {
				if (!first) {
					observed.prompts.push(await promptText(prompt));
					yield { type: "system", subtype: "init", session_id: options.resume ?? SESSION };
					for (const message of textTurn(`continuation ${observed.queries - 1}`)) yield message;
					yield { type: "result", subtype: "success" };
					return;
				}
				const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
				await options.mcpServers["custom-tools"].instance.connect(serverTransport);
				const client = new Client({ name: "fake-claude-code", version: "1.0.0" });
				await client.connect(clientTransport);
				yield { type: "system", subtype: "init", session_id: SESSION };
				for (const [turn, ids] of turns.entries()) {
					yield { type: "stream_event", event: { type: "message_start", message: { id: `tool-turn-${turn}`, model: model.id, usage: { input_tokens: 1 } } } };
					for (const [index, id] of ids.entries()) {
						yield { type: "stream_event", event: { type: "content_block_start", index, content_block: { type: "tool_use", id, name: `mcp__custom-tools__${SLOW.name}`, input: {} } } };
						yield { type: "stream_event", event: { type: "content_block_stop", index } };
					}
					yield { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } } };
					yield { type: "stream_event", event: { type: "message_stop" } };
					const content = [];
					const late = [];
					for (const id of ids) {
						const call = client.callTool({ name: SLOW.name, arguments: {}, _meta: { "claudecode/toolUseId": id } }).then((result) => {
							observed.log.push(`result:${id}`);
							observed.results[id] = result.content[0]?.text;
							return result;
						});
						if (abandon) {
							await waitFor(() => runInRequestLane(LANE, () => ctx().pendingToolCalls.has(id)), `the ${id} handler`);
							content.push({ type: "tool_result", tool_use_id: id, content: "Claude Code stopped waiting for this call", is_error: true });
							late.push(call);
							continue;
						}
						const result = await Promise.race([call, closing.promise]);
						if (closed) return;
						content.push({ type: "tool_result", tool_use_id: id, content: result.content });
					}
					yield { type: "user", message: { content } };
					if (abandon) {
						observed.abandoned.resolve();
						// Stays active until Pi's late results arrive.
						await Promise.race([Promise.all(late), closing.promise]);
					}
				}
				for (const message of textTurn("done")) {
					if (closed) return;
					yield message;
				}
				yield { type: "result", subtype: "success", session_id: SESSION };
			},
			async streamInput(input) {
				for await (const message of input) {
					observed.inputs.push(message);
					observed.log.push("write");
					if (writeFails) throw new Error("transport write failed");
					await observed.writeGate?.promise;
				}
			},
			close() { closed = true; closing.resolve(); },
			async interrupt() { closed = true; closing.resolve(); },
		};
	});
	return observed;
}

/** Starts a query that stops on its tool turn; returns the tool-use reply. */
async function startToolTurn(messages) {
	const events = await collect(streamClaudeAgentSdk(model, { messages }, { sessionId: LANE }));
	const done = events.find((event) => event.type === "done");
	assert.equal(done?.reason, "toolUse");
	return done.message;
}
const record = () => runInRequestLane(LANE, () => __testGetBridgeIntegrityState().sharedSession);
const terminals = (events) => events.filter((event) => event.type === "done" || event.type === "error");
const syncPaths = () => [...readFileSync(process.env.CLAUDE_BRIDGE_DEBUG_PATH, "utf8").matchAll(/syncResult: path=([a-z-]+)/g)].map((match) => match[1]);

let root;
let integrity;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "bridge-live-steering-"));
	process.env.CLAUDE_CONFIG_DIR = root;
	process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token";
	process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT = "0";
	process.env.CLAUDE_BRIDGE_DIAG_PATH = join(root, "diag.log");
	integrity = [];
	resetStack();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: { notify: () => {} } });
	setExtensionApi({ events: { emit: () => {} }, appendEntry: (_type, data) => integrity.push(data.label) });
});

afterEach(() => {
	__testSetSdkQueryFactory();
	setExtensionApi(undefined);
	resetStack();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
	for (const key of ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT", "CLAUDE_BRIDGE_DIAG_PATH"]) delete process.env[key];
	rmSync(root, { recursive: true, force: true });
});

it("writes the steer with priority next before releasing any result, once, and resumes warm on the next turn", async () => {
	const observed = installFakeClaudeCode([["t1"], ["t2"]]);
	const start = [system, user("start")];
	const first = await startToolTurn(start);
	const steered = [...start, first, toolResult("t1"), user("STEER")];
	const second = terminals(await collect(streamClaudeAgentSdk(model, { messages: steered }, { sessionId: LANE })));
	assert.equal(second[0]?.reason, "toolUse", "the second tool turn reaches Pi through the steered callback");
	assert.deepEqual(observed.inputs.map((input) => [input.message.content, input.priority, input.parent_tool_use_id]), [["STEER", "next", null]]);
	assert.deepEqual(observed.log.slice(0, 2), ["write", "result:t1"], "the steer is written before the result is released");
	// Pi's next callback carries the same steer again.
	const repeated = [...steered, second[0].message, toolResult("t2")];
	const last = terminals(await collect(streamClaudeAgentSdk(model, { messages: repeated }, { sessionId: LANE })));
	assert.equal(last.at(-1).type, "done");
	assert.equal(observed.inputs.length, 1, "a repeated callback does not resend the steer");
	assert.equal(observed.results.t2, "result t2");
	await tick(10);
	assert.deepEqual(observed.prompts, [], "a live steer is never replayed as a continuation");
	assert.notEqual(record()?.needsRebuild, true);
	await collect(streamClaudeAgentSdk(model, { messages: [...repeated, last.at(-1).message, user("next")] }, { sessionId: LANE }));
	assert.deepEqual(syncPaths().slice(-2), ["clean-start", "reuse"], "the next turn resumes the session warm");
	assert.equal(observed.resumes.at(-1), SESSION);
});

it("still defers a steer from a text-only callback to a continuation", async () => {
	const gate = Promise.withResolvers();
	let queries = 0;
	const prompts = [];
	const inputs = [];
	__testSetSdkQueryFactory(({ prompt }) => {
		queries += 1;
		const first = queries === 1;
		return {
			async *[Symbol.asyncIterator]() {
				if (!first) prompts.push(await promptText(prompt));
				yield { type: "system", subtype: "init", session_id: SESSION };
				yield* textTurn(first ? "original" : "steer answered");
				if (first) await gate.promise;
				yield { type: "result", subtype: "success", session_id: SESSION };
			},
			async streamInput(input) { for await (const message of input) inputs.push(message); },
			close() {},
			async interrupt() {},
		};
	});
	const start = [system, user("start")];
	streamClaudeAgentSdk(model, { messages: start }, { sessionId: LANE });
	await tick(10);
	const text = { role: "assistant", content: [{ type: "text", text: "original" }], api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: clock++ };
	const callback = collect(streamClaudeAgentSdk(model, { messages: [...start, text, user("TEXT-STEER")] }, { sessionId: LANE }));
	gate.resolve();
	assert.equal((await callback).at(-1).type, "done");
	assert.deepEqual(inputs, [], "no live write without a tool result");
	assert.deepEqual(prompts, ["TEXT-STEER"]);
});

it("sends an image steer as blocks", async () => {
	const observed = installFakeClaudeCode([["t1"]]);
	const start = [system, user("start")];
	const first = await startToolTurn(start);
	const image = user([{ type: "text", text: "look" }, { type: "image", data: "aGk=", mimeType: "image/png" }]);
	await collect(streamClaudeAgentSdk(model, { messages: [...start, first, toolResult("t1"), image] }, { sessionId: LANE }));
	assert.deepEqual(observed.inputs[0].message.content, [{ type: "text", text: "look" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "aGk=" } }]);
	assert.equal(observed.results.t1, "result t1");
});

it("sends a steer that starts with a slash as client-composed, so Claude Code does not hold it as a command", async () => {
	const observed = installFakeClaudeCode([["t1"]]);
	const start = [system, user("start")];
	const first = await startToolTurn(start);
	await collect(streamClaudeAgentSdk(model, { messages: [...start, first, toolResult("t1"), user("  /tmp/shot.png")] }, { sessionId: LANE }));
	assert.equal(observed.inputs[0].message.content, "  /tmp/shot.png");
	assert.equal(observed.inputs[0].client_composed, true);
	assert.equal(observed.results.t1, "result t1");
});

it("sends a prompt that starts with a slash as client-composed, so Claude Code does not run it as its own command", async () => {
	const prompts = [];
	__testSetSdkQueryFactory(({ prompt }) => ({
		async *[Symbol.asyncIterator]() {
			prompts.push(typeof prompt === "string" ? prompt : (await prompt[Symbol.asyncIterator]().next()).value);
			yield { type: "system", subtype: "init", session_id: SESSION };
			yield* textTurn("ok");
			yield { type: "result", subtype: "success", session_id: SESSION };
		},
		async streamInput() {},
		close() {},
		async interrupt() {},
	}));
	const start = [system, user("/review this")];
	const reply = terminals(await collect(streamClaudeAgentSdk(model, { messages: start }, { sessionId: LANE })))[0].message;
	await collect(streamClaudeAgentSdk(model, { messages: [...start, reply, user("hello")] }, { sessionId: LANE }));
	assert.deepEqual(prompts, [
		{ type: "user", message: { role: "user", content: "/review this" }, parent_tool_use_id: null, client_composed: true },
		"hello",
	]);
});

it("gives every staggered parallel handler its result", async () => {
	const observed = installFakeClaudeCode([["t1", "t2"]]);
	const start = [system, user("start")];
	const first = await startToolTurn(start);
	const events = await collect(streamClaudeAgentSdk(model, { messages: [...start, first, toolResult("t1"), toolResult("t2"), user("STEER")] }, { sessionId: LANE }));
	assert.equal(events.at(-1).type, "done");
	assert.deepEqual(observed.log, ["write", "result:t1", "result:t2"]);
	assert.deepEqual(observed.results, { t1: "result t1", t2: "result t2" });
});

it("fails the request once on a failed write, releases nothing and rebuilds instead of replaying", async () => {
	const observed = installFakeClaudeCode([["t1"]], { writeFails: true });
	// A warm session the query resumes.
	runInRequestLane(LANE, () => __testSetBridgeIntegrityState({ sharedSession: { sessionId: SESSION, cursor: 1, cwd: process.cwd(), historyDigest: historyDigest([system]) } }));
	const start = [system, user("start")];
	const first = await startToolTurn(start);
	assert.equal(observed.resumes[0], SESSION);
	const events = terminals(await collect(streamClaudeAgentSdk(model, { messages: [...start, first, toolResult("t1"), user("STEER")] }, { sessionId: LANE })));
	assert.equal(events.length, 1);
	assert.equal(events[0].type, "error");
	assert.match(events[0].error.errorMessage, /could not deliver steering/);
	await waitFor(() => runInRequestLane(LANE, () => ctx().activeQuery === null), "the query to end");
	await tick(10);
	assert.notEqual(observed.results.t1, "result t1", "the tool result is never released");
	assert.equal(observed.queries, 1, "the steer is never replayed as a continuation");
	assert.equal(record()?.needsRebuild, true);
	assert.equal(record()?.forceRotate, true);
	assert.ok(integrity.includes("steering_delivery_failed"));
});

it("releases nothing and reports no second error when the request is cancelled during the write", async () => {
	const observed = installFakeClaudeCode([["t1"]]);
	observed.writeGate = Promise.withResolvers();
	const start = [system, user("start")];
	const first = await startToolTurn(start);
	const abort = new AbortController();
	const events = collect(streamClaudeAgentSdk(model, { messages: [...start, first, toolResult("t1"), user("STEER")] }, { sessionId: LANE, signal: abort.signal }));
	await waitFor(() => observed.inputs.length === 1, "the write");
	abort.abort();
	observed.writeGate.resolve();
	const ended = terminals(await events);
	assert.deepEqual(ended.map((event) => [event.type, event.reason]), [["error", "aborted"]]);
	await tick(10);
	assert.notEqual(observed.results.t1, "result t1");
	assert.equal(observed.queries, 1);
});

it("releases nothing when Pi replaces the history during the write, and restarts on it", async () => {
	const observed = installFakeClaudeCode([["t1"]]);
	observed.writeGate = Promise.withResolvers();
	const start = [system, user("start")];
	const first = await startToolTurn(start);
	const events = collect(streamClaudeAgentSdk(model, { messages: [...start, first, toolResult("t1"), user("STEER")] }, { sessionId: LANE }));
	await waitFor(() => observed.inputs.length === 1, "the write");
	runInRequestLane(LANE, () => onPiHistoryReplaced("session_compact"));
	observed.writeGate.resolve();
	assert.equal(terminals(await events).at(-1).type, "done");
	assert.notEqual(observed.results.t1, "result t1", "no result reaches the stale query");
	assert.equal(observed.queries, 2);
	assert.match(observed.prompts[0], /rewritten by Pi/);
	assert.notEqual(observed.resumes[1], SESSION, "the restart rotates the session");
});

it("leaves the parent's record untouched when another conversation's forked query fails its write", async () => {
	const parent = { sessionId: "parent-session", cursor: 40, cwd: process.cwd(), conversationFingerprint: conversationFingerprint([system, user("the parent's own prompt")]), historyDigest: "h1:parent" };
	runInRequestLane(LANE, () => __testSetBridgeIntegrityState({ sharedSession: parent }));
	const observed = installFakeClaudeCode([["t1"]], { writeFails: true });
	const start = [system, user("a foreign one-shot")];
	const first = await startToolTurn(start);
	const events = terminals(await collect(streamClaudeAgentSdk(model, { messages: [...start, first, toolResult("t1"), user("STEER")] }, { sessionId: LANE })));
	assert.match(events.at(-1).error.errorMessage, /could not deliver steering/);
	await tick(20);
	assert.equal(observed.queries, 1);
	assert.deepEqual(record(), parent);
});

it("does not write a steer live when every result is for a call Claude Code gave up on", async () => {
	const observed = installFakeClaudeCode([["t1"]], { abandon: true });
	const start = [system, user("start")];
	const first = await startToolTurn(start);
	await observed.abandoned.promise;
	const events = await collect(streamClaudeAgentSdk(model, { messages: [...start, first, toolResult("t1"), user("STEER")] }, { sessionId: LANE }));
	assert.equal(events.at(-1).type, "done");
	assert.deepEqual(observed.inputs, []);
	assert.deepEqual(observed.prompts, ["STEER"], "the steer reaches Claude as a continuation");
});

// --- A query that ends while its steering write is still pending ---
// The lane is not kept in use for the write, so the next prompt may claim
// the lane's record before the old write completes.

/** First query: hands Pi `t1`, then fails once `observed.fail` resolves.
 *  Its steering write is held until `observed.writeGate` resolves. Later
 *  queries record their prompt and answer. */
function installEndingQuery() {
	const observed = { queries: 0, prompts: [], resumes: [], inputs: [], results: {}, pulled: Promise.withResolvers(), fail: Promise.withResolvers(), writeGate: Promise.withResolvers(), inputDone: Promise.withResolvers() };
	__testSetSdkQueryFactory(({ prompt, options }) => {
		observed.queries += 1;
		const first = observed.queries === 1;
		observed.resumes.push(options.resume ?? null);
		return {
			async *[Symbol.asyncIterator]() {
				if (!first) {
					observed.prompts.push(await promptText(prompt));
					yield { type: "system", subtype: "init", session_id: options.resume ?? SESSION };
					yield* textTurn("replacement answer");
					yield { type: "result", subtype: "success", session_id: options.resume ?? SESSION };
					return;
				}
				const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
				await options.mcpServers["custom-tools"].instance.connect(serverTransport);
				const client = new Client({ name: "fake-claude-code", version: "1.0.0" });
				await client.connect(clientTransport);
				yield { type: "system", subtype: "init", session_id: SESSION };
				yield { type: "stream_event", event: { type: "message_start", message: { id: "ending-tool-turn", model: model.id, usage: { input_tokens: 1 } } } };
				yield { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: `mcp__custom-tools__${SLOW.name}`, input: {} } } };
				yield { type: "stream_event", event: { type: "content_block_stop", index: 0 } };
				yield { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } } };
				yield { type: "stream_event", event: { type: "message_stop" } };
				void client.callTool({ name: SLOW.name, arguments: {}, _meta: { "claudecode/toolUseId": "t1" } }).then((result) => { observed.results.t1 = result.content[0]?.text; }, () => {});
				await observed.fail.promise;
				yield { type: "result", subtype: "error_during_execution", errors: ["API Error: 500 internal server error"] };
			},
			async streamInput(input) {
				for await (const message of input) {
					observed.inputs.push(message);
					observed.pulled.resolve();
					await observed.writeGate.promise;
				}
				observed.inputDone.resolve();
			},
			close() {},
			async interrupt() {},
		};
	});
	return observed;
}

/** The query fails while its steering write is held; returns Pi's history
 *  (with the error message Pi appended) and the fake's observations. */
async function endDuringHeldWrite() {
	const observed = installEndingQuery();
	const start = [system, user("start")];
	const first = await startToolTurn(start);
	const steered = [...start, first, toolResult("t1"), user("STEER-ENDED-WRITE")];
	const callback = collect(streamClaudeAgentSdk(model, { messages: steered }, { sessionId: LANE }));
	await observed.pulled.promise;
	observed.fail.resolve();
	const failed = terminals(await callback);
	assert.equal(failed.at(-1).type, "error");
	await waitFor(() => runInRequestLane(LANE, () => ctx().activeQuery === null), "the query to end");
	await tick(10);
	return { observed, history: [...steered, failed.at(-1).error] };
}

async function finishOldWrite(observed) {
	observed.writeGate.resolve();
	await observed.inputDone.promise;
	await tick(10);
}

it("an ended query's steering write leaves a replacement's record alone, even under the same session id", async () => {
	const { observed, history } = await endDuringHeldWrite();
	await collect(streamClaudeAgentSdk(model, { messages: [...history, user("next")] }, { sessionId: LANE }));
	assert.equal(syncPaths().at(-1), "rebuild");
	const replacement = structuredClone(record());
	assert.equal(replacement.sessionId, SESSION, "the rebuild kept the Claude session id");
	assert.notEqual(replacement.needsRebuild, true);
	assert.notEqual(replacement.forceRotate, true);
	assert.match(replacement.historyDigest, /^h1:/);
	await finishOldWrite(observed);
	assert.deepEqual(record(), replacement, "the old write must not mark the replacement's record");
	assert.notEqual(observed.results.t1, "result t1", "no old tool result was released");
});

it("an ended query's steering write that completes before any new query leaves the record marked for rebuild", async () => {
	const { observed } = await endDuringHeldWrite();
	await finishOldWrite(observed);
	assert.equal(record()?.needsRebuild, true);
});

it("a steer whose query ended during the write reaches Claude once, through the next rebuild", async () => {
	const { observed, history } = await endDuringHeldWrite();
	await finishOldWrite(observed);
	await collect(streamClaudeAgentSdk(model, { messages: [...history, user("next")] }, { sessionId: LANE }));
	assert.equal(syncPaths().at(-1), "rebuild");
	const resumed = observed.resumes.at(-1);
	const imported = readFileSync(openSession({ sessionId: resumed, projectPath: process.cwd(), claudeDir: root }).jsonlPath, "utf8");
	const delivered = [...observed.prompts, imported].join("\n");
	assert.equal(delivered.split("STEER-ENDED-WRITE").length - 1, 1, `the steer reaches Claude exactly once: prompts=${JSON.stringify(observed.prompts)}`);
	assert.deepEqual(observed.prompts, ["next"]);
});
