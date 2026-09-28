// Provider level: a user message Pi hands the bridge while a Claude query is
// running must reach Claude, exactly once. With a tool result for the query,
// the bridge writes it to the running query (live); otherwise it queues it
// and replays it as a continuation after the query. The cursor is an
// acknowledgement: it may pass a user message only once that message is
// delivered, accepted for delivery, or owned by a rebuild.
//
// Pi converts `custom` messages (intercom, subagent notifications) to role
// `user` before calling the provider, so they take this same path.
import "./lib/debug-env.mjs";

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Type } from "@earendil-works/pi-ai";
import { ExtensionRunner, convertToLlm, createExtensionRuntime } from "@earendil-works/pi-coding-agent";

import { __testSetBridgeIntegrityState, __testGetBridgeIntegrityState, __testSetSdkQueryFactory, streamClaudeAgentSdk } from "../src/index.ts";
import { setExtensionApi } from "../src/bridge-state.ts";
import { ctx, resetStack } from "../src/query-state.ts";
import { runInRequestLane } from "../src/request-lane.ts";

const model = {
	id: "claude-haiku-4-5",
	name: "Claude Haiku",
	api: "claude-bridge",
	provider: "pi-claude",
	baseUrl: "claude-bridge",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8192,
};

const SLOW = { name: "slow_tool", description: "A slow tool", parameters: Type.Object({}) };

async function collect(stream) {
	const events = [];
	for await (const event of stream) events.push(event);
	return events;
}

async function promptText(prompt) {
	if (typeof prompt === "string") return prompt;
	const parts = [];
	for await (const message of prompt) {
		const content = message.message.content;
		if (typeof content === "string") parts.push(content);
		else for (const block of content) if (block.type === "text") parts.push(block.text);
	}
	return parts.join("");
}

const textTurn = (text, sessionId) => [
	{ type: "system", subtype: "init", session_id: sessionId },
	{ type: "stream_event", event: { type: "message_start", message: { model: model.id, usage: { input_tokens: 1 } } } },
	{ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
	{ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } },
	{ type: "stream_event", event: { type: "content_block_stop", index: 0 } },
	{ type: "stream_event", event: { type: "message_stop" } },
	{ type: "result", subtype: "success", session_id: sessionId },
];

/** Fake Claude Code. The first query runs one assistant message per entry of
 *  `turns`, each calling `slow_tool` once per id in it, and waits for Pi's
 *  results through the real MCP server before the next; then it answers.
 *  Steering written to the running query is recorded in `live`. Every later
 *  query is a deferred-replay continuation; its prompt text is recorded. */
function installFakeClaudeCode(observed, turns) {
	__testSetSdkQueryFactory(({ prompt, options }) => {
		observed.queries += 1;
		const first = observed.queries === 1;
		let closed = false;
		return {
			async *[Symbol.asyncIterator]() {
				if (!first) {
					observed.continuationPrompts.push(await promptText(prompt));
					for (const message of textTurn(`continuation ${observed.queries - 1}`, "steer-session")) {
						if (closed) return;
						yield message;
					}
					return;
				}
				const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
				await options.mcpServers["custom-tools"].instance.connect(serverTransport);
				const client = new Client({ name: "fake-claude-code", version: "1.0.0" });
				await client.connect(clientTransport);
				yield { type: "system", subtype: "init", session_id: "steer-session" };
				for (const [turn, callIds] of turns.entries()) {
					yield { type: "stream_event", event: { type: "message_start", message: { id: `m${turn + 1}`, model: model.id, usage: { input_tokens: 1 } } } };
					for (const [index, id] of callIds.entries()) {
						yield { type: "stream_event", event: { type: "content_block_start", index, content_block: { type: "tool_use", id, name: `mcp__custom-tools__${SLOW.name}`, input: {} } } };
						yield { type: "stream_event", event: { type: "content_block_stop", index } };
					}
					yield { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } } };
					yield { type: "stream_event", event: { type: "message_stop" } };
					const results = await Promise.all(callIds.map((id) => client.callTool({ name: SLOW.name, arguments: {}, _meta: { "claudecode/toolUseId": id } })));
					if (closed) return;
					yield { type: "user", message: { content: callIds.map((id, i) => ({ type: "tool_result", tool_use_id: id, content: results[i].content })) } };
				}
				for (const message of textTurn("tools done", "steer-session").slice(1)) {
					if (closed) return;
					yield message;
				}
			},
			async streamInput(input) {
				for await (const message of input) observed.live.push(await promptText((async function* () { yield message; })()));
			},
			close() { closed = true; },
			async interrupt() { closed = true; },
		};
	});
}

// Pi stamps each message at creation. A monotonic clock keeps two test
// messages from sharing a millisecond by accident.
let clock = Date.now();
const stamp = () => clock++;
const user = (text) => ({ role: "user", content: text, timestamp: stamp() });
// What Pi's convertToLlm makes of a `custom` message (intercom, subagent notify).
const customAsUser = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: stamp() });
// A Pi `custom` agent message before convertToLlm (intercom, subagent notify).
const custom = (text) => ({ role: "custom", customType: "intercom", content: text, display: true, timestamp: stamp() });
/** Pi's own path to the provider: the extension `context` handler runs through
 *  ExtensionRunner.emitContext (which Pi installs as transformContext) and the
 *  result goes through convertToLlm. */
async function piTransform(agentMessages, handler) {
	const extension = {
		path: "<steer-ownership-test>",
		resolvedPath: "<steer-ownership-test>",
		handlers: new Map([["context", [handler]]]),
		tools: new Map(),
		messageRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
	const runner = new ExtensionRunner([extension], createExtensionRuntime(), process.cwd(), undefined, undefined);
	const errors = [];
	runner.onError?.((error) => errors.push(error));
	const transformed = await runner.emitContext(agentMessages);
	assert.deepEqual(errors, [], "the context handler must run cleanly");
	return convertToLlm(transformed);
}
const toolResult = (id) => ({ role: "toolResult", toolCallId: id, toolName: SLOW.name, content: [{ type: "text", text: `result ${id}` }], isError: false, timestamp: Date.now() });
// Pi 0.87.1 records prompt-section and tool-loadout updates as mid-conversation
// system messages in the provider context.
const systemUpdate = () => ({ role: "system", content: "", sections: { note: "updated" }, timestamp: Date.now() });

const userText = (message) => typeof message.content === "string" ? message.content : message.content.map((block) => block.text ?? "").join("");
// Pi's ExtensionRunner.emitContext structuredClones the context, so a message
// that went through a real transform is matched by what Pi identifies it by.
const messageKey = (message) => `${message.timestamp}|${userText(message)}`;

/** Every user message below `cursor` that the query did not start with
 *  (wherever a transform moved it) and that no rebuild owns (`rebuildOwned`)
 *  must be owned by the deferred queue, in order. Both sets match by object
 *  or, for cloned messages, by timestamp and text. Returns the offending
 *  text, if any. */
function unownedBelowCursor(messages, startedWith, rebuildOwned, cursor, queuedTexts) {
	const queued = queuedTexts.join("\u0000");
	const ownedKeys = new Set([...startedWith, ...rebuildOwned].filter((message) => message.role === "user").map(messageKey));
	let searchFrom = 0;
	for (let i = 0; i < Math.min(cursor, messages.length); i++) {
		if (messages[i].role !== "user" || startedWith.has(messages[i]) || rebuildOwned.has(messages[i]) || ownedKeys.has(messageKey(messages[i]))) continue;
		const text = userText(messages[i]);
		const at = queued.indexOf(text, searchFrom);
		if (at === -1) return text;
		searchFrom = at + text.length;
	}
	return undefined;
}

const snapshotOwnership = (sessionId) => runInRequestLane(sessionId, () => ({
	queued: ctx().deferredUserMessages.map((entry) => entry.text),
	latestCursor: ctx().latestCursor,
	sharedCursor: __testGetBridgeIntegrityState().sharedSession?.cursor ?? 0,
}));

/** Runs one tool turn, then Pi's callback with `suffixAfterResults` appended
 *  behind the tool results, and returns what the bridge queued and replayed.
 *  `earlier` is history the query starts with ahead of its prompt; `project`
 *  stands in for an extension's context transform and returns the callback
 *  context from (starting messages, assistant tool message, suffix). */
async function runCallback(sessionId, callIds, buildSuffix, { earlier = [], project, rebuildOwned = new Set() } = {}) {
	const observed = { queries: 0, continuationPrompts: [], live: [] };
	installFakeClaudeCode(observed, [callIds]);
	const initial = {
		messages: [
			{ role: "system", content: "test system prompt", toolsAdded: [SLOW], timestamp: 0 },
			...earlier,
			user("start"),
		],
	};
	const first = await collect(streamClaudeAgentSdk(model, initial, { sessionId }));
	const done = first.find((event) => event.type === "done");
	assert.equal(done?.reason, "toolUse", "the first turn must end on the tool call");
	const suffix = buildSuffix();
	const messages = project ? await project(initial.messages, done.message, suffix) : [...initial.messages, done.message, ...suffix];
	const callback = collect(streamClaudeAgentSdk(model, { messages }, { sessionId }));
	// The ownership decision is synchronous inside the provider call.
	const snapshot = snapshotOwnership(sessionId);
	const events = await callback;
	const startedWith = new Set(initial.messages);
	return { observed, messages, startedWith, rebuildOwned, snapshot, events };
}

function assertDeliveredOnceInOrder(result, steers) {
	const { observed, messages, startedWith, rebuildOwned, snapshot, events } = result;
	const cursor = Math.max(snapshot.latestCursor, snapshot.sharedCursor);
	// What reached Claude: steering written to the running query, then
	// continuation prompts.
	const delivered = [...observed.live, ...observed.continuationPrompts];
	assert.equal(
		unownedBelowCursor(messages, startedWith, rebuildOwned, cursor, [...observed.live, ...snapshot.queued]),
		undefined,
		`the cursor (${cursor}) passed a user message that was neither delivered nor queued; live=${JSON.stringify(observed.live)} queued=${JSON.stringify(snapshot.queued)}`,
	);
	const replayed = delivered.join("\u0000");
	let searchFrom = 0;
	for (const steer of steers) {
		const at = replayed.indexOf(steer);
		assert.notEqual(at, -1, `${steer} never reached Claude; delivered=${JSON.stringify(delivered)}`);
		assert.equal(replayed.indexOf(steer, at + steer.length), -1, `${steer} reached Claude more than once`);
		assert.ok(at >= searchFrom, `${steer} reached Claude out of order: ${JSON.stringify(delivered)}`);
		searchFrom = at + steer.length;
	}
	const replayedParts = delivered.flatMap((prompt) => prompt.split("\n\n"));
	for (const message of startedWith) {
		if (message.role !== "user") continue;
		assert.ok(!replayedParts.includes(userText(message)), `history the query started with was replayed: ${userText(message)}; delivered=${JSON.stringify(delivered)}`);
	}
	assert.ok(events.some((event) => event.type === "done"), "the callback's Pi stream must complete");
}

/** Two tool turns in one query, so Pi calls back twice. `project1`/`project2`
 *  build each callback context from the previous one plus the new assistant
 *  message; both run through the same (possibly transforming) projection. */
async function runTwoCallbacks(sessionId, { earlier, project1, project2 }) {
	const observed = { queries: 0, continuationPrompts: [], live: [] };
	installFakeClaudeCode(observed, [["call-1"], ["call-2"]]);
	const initial = { messages: [{ role: "system", content: "test system prompt", toolsAdded: [SLOW], timestamp: 0 }, ...earlier, user("start")] };
	const first = await collect(streamClaudeAgentSdk(model, initial, { sessionId }));
	const done1 = first.find((event) => event.type === "done");
	assert.equal(done1?.reason, "toolUse");
	const messages1 = project1(initial.messages, done1.message);
	const callback1 = await collect(streamClaudeAgentSdk(model, { messages: messages1 }, { sessionId }));
	const done2 = callback1.find((event) => event.type === "done");
	assert.equal(done2?.reason, "toolUse", "the second tool turn reaches Pi through the first callback's stream");
	const snapshot1 = snapshotOwnership(sessionId);
	const live1 = [...observed.live];
	const messages2 = project2(messages1, done2.message);
	const callback2 = collect(streamClaudeAgentSdk(model, { messages: messages2 }, { sessionId }));
	const snapshot2 = snapshotOwnership(sessionId);
	const events = await callback2;
	return { observed, snapshot1, snapshot2, live1, events, startedWith: new Set(initial.messages) };
}

const sharedRecord = (sessionId) => runInRequestLane(sessionId, () => __testGetBridgeIntegrityState().sharedSession);

let diagDir;
const diagLabels = () => {
	const path = join(diagDir, "diag.log");
	return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line).label) : [];
};
beforeEach(() => {
	process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT = "0";
	process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token";
	diagDir = mkdtempSync(join(tmpdir(), "bridge-diag-"));
	process.env.CLAUDE_BRIDGE_DIAG_PATH = join(diagDir, "diag.log");
	resetStack();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: { notify: () => {} } });
	setExtensionApi({ events: { emit: () => {} }, appendEntry: () => {} });
});

afterEach(() => {
	delete process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT;
	delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
	delete process.env.CLAUDE_BRIDGE_DIAG_PATH;
	rmSync(diagDir, { recursive: true, force: true });
	__testSetSdkQueryFactory();
	setExtensionApi(undefined);
	resetStack();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
});

describe("mid-query user messages are owned before the cursor passes them", () => {
	it("queues a user message followed by a non-user message (toolResult, user, system)", async () => {
		const result = await runCallback("steer-then-system", ["call-1"], () => [
			toolResult("call-1"),
			user("STEER-ALPHA"),
			systemUpdate(),
		]);
		assertDeliveredOnceInOrder(result, ["STEER-ALPHA"]);
	});

	it("queues both users when a tool result splits them (toolResult, user, toolResult, user)", async () => {
		const result = await runCallback("steer-split-by-result", ["call-1", "call-2"], () => [
			toolResult("call-1"),
			user("STEER-FIRST"),
			toolResult("call-2"),
			user("STEER-SECOND"),
		]);
		assertDeliveredOnceInOrder(result, ["STEER-FIRST", "STEER-SECOND"]);
	});

	it("queues a custom-as-user message after a user, then a non-user message", async () => {
		const result = await runCallback("steer-custom-then-system", ["call-1"], () => [
			toolResult("call-1"),
			user("STEER-TYPED"),
			customAsUser("INTERCOM-CUSTOM"),
			systemUpdate(),
		]);
		assertDeliveredOnceInOrder(result, ["STEER-TYPED", "INTERCOM-CUSTOM"]);
	});

	it("keeps the trailing-run case unchanged (toolResult, user, custom-as-user)", async () => {
		const result = await runCallback("steer-custom-trailing", ["call-1"], () => [
			toolResult("call-1"),
			user("STEER-TYPED"),
			customAsUser("INTERCOM-CUSTOM"),
		]);
		assertDeliveredOnceInOrder(result, ["STEER-TYPED", "INTERCOM-CUSTOM"]);
		assert.deepEqual(result.observed.live, ["STEER-TYPED\n\nINTERCOM-CUSTOM"], "a contiguous trailing run is still sent as one message");
	});

	it("never re-queues the original prompt or earlier history", async () => {
		const result = await runCallback("steer-no-prompt-replay", ["call-1"], () => [
			toolResult("call-1"),
			systemUpdate(),
		]);
		assert.deepEqual(result.snapshot.queued, [], "nothing new to queue");
		assert.deepEqual(result.observed.live, [], "nothing new to send");
		assert.deepEqual(result.observed.continuationPrompts, [], "no continuation without a new user message");
		assert.equal(result.observed.queries, 1);
	});
});

// Extensions transform the provider context on every call (Pi installs the
// extension `context` event as transformContext), and context pruners drop or
// rewrite older messages. A callback context therefore need not extend the
// one the query started with, and no position in the starting context is a
// delivery boundary.
describe("mid-query user ownership survives context transforms", () => {
	const earlierFour = () => [user("earlier-one"), user("earlier-two"), user("earlier-three"), user("earlier-four")];

	it("delivers a steer behind a pruned history (callback context shorter than at start)", async () => {
		// Stage D2 review reproduction: 6 messages at start, 5 in the callback.
		const result = await runCallback("steer-after-prune", ["call-1"], () => [
			toolResult("call-1"),
			user("STEER-AFTER-PRUNE"),
		], {
			earlier: earlierFour(),
			project: (initial, assistant, suffix) => [initial[0], initial.at(-1), assistant, ...suffix],
		});
		assert.equal(result.messages.length, 5);
		assertDeliveredOnceInOrder(result, ["STEER-AFTER-PRUNE"]);
		assert.deepEqual(result.observed.live, ["STEER-AFTER-PRUNE"]);
		assert.deepEqual(result.observed.continuationPrompts, []);
		assert.ok(!diagLabels().includes("user_message_identity_unresolved"), "plain pruning identifies every message; steer ownership needs no rebuild");
		// The pruned messages are history Claude already holds, and Pi's view of
		// it changed under the cursor: the next turn rebuilds from Pi's history
		// (history-digest.ts), which is independent of steer ownership.
		assert.equal(sharedRecord("steer-after-prune")?.needsRebuild, true);
	});

	it("never replays the prompt when inserted messages grow the context ahead of it", async () => {
		const result = await runCallback("steer-after-growth", ["call-1"], () => [
			toolResult("call-1"),
			user("STEER-AFTER-GROWTH"),
		], {
			earlier: [user("earlier-one")],
			project: (initial, assistant, suffix) => [initial[0], systemUpdate(), systemUpdate(), ...initial.slice(1), assistant, ...suffix],
		});
		assertDeliveredOnceInOrder(result, ["STEER-AFTER-GROWTH"]);
		assert.deepEqual(result.observed.live, ["STEER-AFTER-GROWTH"]);
		assert.deepEqual(result.observed.continuationPrompts, []);
	});

	it("hands a rewritten earlier message to a rebuild, never replays it, and still delivers the steer", async () => {
		const rewritten = [];
		const result = await runCallback("steer-after-rewrite", ["call-1"], () => [
			toolResult("call-1"),
			user("STEER-AFTER-REWRITE"),
		], {
			earlier: [user("earlier-one: a long pasted log")],
			project: (initial, assistant, suffix) => {
				// An extension replaces the older message's content and keeps its
				// timestamp, as Pi's pruners do for tool results.
				const replaced = { ...initial[1], content: "earlier-one: [log pruned]" };
				rewritten.push(replaced);
				return [initial[0], systemUpdate(), replaced, ...initial.slice(2), assistant, ...suffix];
			},
			rebuildOwned: new Set(),
		});
		for (const message of rewritten) result.rebuildOwned.add(message);
		assertDeliveredOnceInOrder(result, ["STEER-AFTER-REWRITE"]);
		assert.deepEqual(result.observed.live, ["STEER-AFTER-REWRITE"], "neither the rewritten message nor the prompt is sent");
		assert.deepEqual(result.observed.continuationPrompts, []);
		assert.equal(sharedRecord("steer-after-rewrite")?.needsRebuild, true, "the rewritten message is owned by a rebuild");
	});

	it("never replays the prompt when a transform re-creates it under a new timestamp", async () => {
		const copies = [];
		const result = await runCallback("steer-after-restamp", ["call-1"], () => [
			toolResult("call-1"),
			user("STEER-AFTER-RESTAMP"),
		], {
			project: (initial, assistant, suffix) => {
				const copy = { ...initial.at(-1), timestamp: stamp() };
				copies.push(copy);
				return [initial[0], copy, assistant, ...suffix];
			},
		});
		for (const copy of copies) result.rebuildOwned.add(copy);
		assertDeliveredOnceInOrder(result, ["STEER-AFTER-RESTAMP"]);
		assert.deepEqual(result.observed.live, ["STEER-AFTER-RESTAMP"]);
		assert.deepEqual(result.observed.continuationPrompts, []);
		assert.equal(sharedRecord("steer-after-restamp")?.needsRebuild, true, "the unidentifiable copy is owned by a rebuild");
	});

	it("delivers each steer exactly once across two callbacks when the history is pruned in between", async () => {
		const { observed, live1, events, startedWith } = await runTwoCallbacks("steer-prune-between", {
			earlier: [user("earlier-one"), user("earlier-two")],
			project1: (initial, assistant) => [...initial, assistant, toolResult("call-1"), user("STEER-ONE")],
			// Keep the system prompt and only the newest messages: the first
			// steer survives at a lower index, everything older is gone.
			project2: (previous, assistant) => [previous[0], previous.at(-1), assistant, toolResult("call-2"), user("STEER-TWO")],
		});
		assert.deepEqual(live1, ["STEER-ONE"]);
		assert.deepEqual(observed.live, ["STEER-ONE", "STEER-TWO"], "the second callback sends only the new steer");
		assert.ok(events.some((event) => event.type === "done"));
		assert.deepEqual(observed.continuationPrompts, []);
		for (const message of startedWith) {
			if (message.role === "user") assert.ok(!observed.live.includes(userText(message)));
		}
	});

	it("never replays an older message rewritten under new content AND a new timestamp (stage D2 review 2)", async () => {
		// Stage D2 review 2 reproduction. Neither the timestamp nor the content
		// of the rewritten message matches anything the query owns. It sits
		// before the assistant message the bridge produced while an owned
		// message (the original) is missing, so it may be that message
		// rewritten: a rebuild owns it, and it is never replayed as a steer.
		const rewritten = [];
		const result = await runCallback("steer-after-rewrite-restamp", ["call-1"], () => [
			toolResult("call-1"),
			user("STEER"),
		], {
			earlier: [user("earlier-one: a long pasted log")],
			project: (initial, assistant, suffix) => {
				const replaced = user("earlier-one: [log pruned]");
				rewritten.push(replaced);
				return [initial[0], replaced, initial.at(-1), assistant, ...suffix];
			},
		});
		for (const message of rewritten) result.rebuildOwned.add(message);
		assert.deepEqual(result.observed.live, ["STEER"], "only the new steer is sent; the rewritten history is not sent as an instruction");
		assert.deepEqual(result.observed.continuationPrompts, []);
		assertDeliveredOnceInOrder(result, ["STEER"]);
		assert.ok(diagLabels().includes("user_message_identity_unresolved"), `the ambiguous message is logged; diag=${JSON.stringify(diagLabels())}`);
		assert.equal(sharedRecord("steer-after-rewrite-restamp")?.needsRebuild, true, "a rebuild owns the rewritten message");
	});

	it("delivers a new custom message a real Pi extension moves before the anchor (stage D2 review 3)", async () => {
		// Stage D2 review 3 reproduction, through Pi's own ExtensionRunner and
		// convertToLlm. The message is new (created after the query started)
		// and keeps its content and timestamp; only its position moves. Every
		// owned message is still present, so nothing was rewritten: it is new.
		const result = await runCallback("steer-relocated", ["call-1"], () => [
			toolResult("call-1"),
			custom("STEER-RELOCATED"),
		], {
			project: (initial, assistant, suffix) => piTransform([...initial, assistant, ...suffix], ({ messages }) => ({
				messages: [...messages.slice(0, 2), messages.at(-1), ...messages.slice(2, -1)],
			})),
		});
		assert.deepEqual(result.messages.map((message) => message.role), ["system", "user", "user", "assistant", "toolResult"]);
		assert.deepEqual(result.observed.live, ["STEER-RELOCATED"]);
		assert.deepEqual(result.observed.continuationPrompts, []);
		assertDeliveredOnceInOrder(result, ["STEER-RELOCATED"]);
		assert.notEqual(sharedRecord("steer-relocated")?.needsRebuild, true, "a moved new message needs no rebuild");
	});

	it("hands a moved new message to a rebuild when an owned message is also pruned away, and still delivers a later steer", async () => {
		// With an owned message missing, a pre-anchor unknown message may be
		// its rewrite or moved new input. Neither dropping nor replaying it is
		// safe, so a rebuild owns it. The steer after the anchor is still new.
		const result = await runCallback("steer-relocated-pruned", ["call-1"], () => [
			toolResult("call-1"),
			custom("STEER-RELOCATED-PRUNED"),
			user("STEER-AFTER"),
		], {
			earlier: [user("earlier-one: a long pasted log")],
			// [system, earlier-one, start, assistant, toolResult, custom, STEER-AFTER]
			// becomes [system, custom, start, assistant, toolResult, STEER-AFTER].
			project: (initial, assistant, suffix) => piTransform([...initial, assistant, ...suffix], ({ messages }) => ({
				messages: [messages[0], messages[5], ...messages.slice(2, 5), messages[6]],
			})),
		});
		assert.deepEqual(result.messages.map((message) => message.role), ["system", "user", "user", "assistant", "toolResult", "user"]);
		const relocated = result.messages[1];
		assert.equal(userText(relocated), "STEER-RELOCATED-PRUNED");
		result.rebuildOwned.add(relocated);
		assert.deepEqual(result.observed.live, ["STEER-AFTER"], "the ambiguous message is not sent as a steer");
		assert.deepEqual(result.observed.continuationPrompts, []);
		assertDeliveredOnceInOrder(result, ["STEER-AFTER"]);
		assert.equal(sharedRecord("steer-relocated-pruned")?.needsRebuild, true, "a rebuild owns the ambiguous message: nothing is silently dropped");
		assert.ok(diagLabels().includes("user_message_identity_unresolved"), `diag=${JSON.stringify(diagLabels())}`);
	});

	it("hands a fully replaced context with no known message to a rebuild, replaying nothing and losing nothing", async () => {
		// No owned user, no assistant this query produced, no tool result an
		// earlier callback delivered: nothing tells old from new. The call-1
		// result is delivered by THIS callback, so it is new, not an anchor.
		const replacedUsers = [];
		const result = await runCallback("steer-replaced-context", ["call-1"], () => [
			toolResult("call-1"),
			user("STEER-REPLACED"),
		], {
			earlier: [user("earlier-one")],
			project: (initial, _assistant, suffix) => {
				const summary = user("Summary of the conversation so far: ...");
				replacedUsers.push(summary, suffix[1]);
				return [initial[0], summary, ...suffix];
			},
		});
		for (const message of replacedUsers) result.rebuildOwned.add(message);
		assert.deepEqual(result.snapshot.queued, [], "nothing is queued as a steer");
		assert.deepEqual(result.observed.live, [], "nothing is sent as a steer");
		assert.deepEqual(result.observed.continuationPrompts, [], "nothing is replayed");
		assertDeliveredOnceInOrder(result, []);
		assert.equal(sharedRecord("steer-replaced-context")?.needsRebuild, true, "the rebuild owns every unmatched user message");
		assert.ok(diagLabels().includes("user_message_identity_unresolved"));
	});

	it("delivers a steer once when a later callback carries it again", async () => {
		const { observed, live1, events, startedWith } = await runTwoCallbacks("steer-repeated-callback", {
			earlier: [],
			project1: (initial, assistant) => [...initial, assistant, toolResult("call-1"), user("STEER-ONCE")],
			// Pi's next callback carries the same steer again, now followed by the
			// next tool turn.
			project2: (previous, assistant) => [...previous, assistant, toolResult("call-2")],
		});
		assert.deepEqual(live1, ["STEER-ONCE"]);
		assert.deepEqual(observed.live, ["STEER-ONCE"], "the repeated steer is not sent again");
		assert.ok(events.some((event) => event.type === "done"));
		assert.deepEqual(observed.continuationPrompts, []);
		for (const message of startedWith) {
			if (message.role === "user") assert.ok(!observed.live.includes(userText(message)));
		}
	});
});
