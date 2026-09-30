import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createSession, openSession } from "cc-session-io";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { __testGetBridgeIntegrityState, __testSetBridgeIntegrityState, __testSetSdkQueryFactory, onPiHistoryReplaced, streamClaudeAgentSdk } from "../src/index.ts";
import { cancelScheduledToolUseEnd } from "../src/assistant-stream.ts";
import { ctx, resetStack } from "../src/query-state.ts";

const model = { id: "claude-haiku-4-5", api: "claude-bridge", provider: "pi-claude", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const tool = { name: "echo", description: "Return a value", parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } };
const sessionId = "11111111-1111-4111-8111-111111111111";
const system = { role: "system", content: "Pi instructions", toolsAdded: [tool], timestamp: 0 };
const user = (content) => ({ role: "user", content, timestamp: Date.now() });
// Pi keeps one message object (and its timestamp) for the prompt across every
// provider call of the turn; the bridge identifies user messages by it.
const runEcho = user("run echo");
const toolCall = { role: "assistant", content: [{ type: "toolCall", id: "t0", name: "echo", arguments: { id: "t0" } }], timestamp: Date.now() };
const toolResult = { role: "toolResult", toolCallId: "t0", content: [{ type: "text", text: "tool output" }], timestamp: Date.now() };
const collect = async (stream) => { const events = []; for await (const event of stream) events.push(event); return events; };
async function waitFor(check) {
	const deadline = Date.now() + 1000;
	while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(check(), true, "query did not settle");
}

function waitingQuery(record, childToolName, throwsOnClose = false, id = "t0") {
	const gate = Promise.withResolvers();
	record.closed = false;
	record.release = () => gate.resolve();
	return {
		async *[Symbol.asyncIterator]() {
			yield { type: "system", subtype: "init", session_id: sessionId };
			yield { type: "assistant", message: { content: [
				...(childToolName ? [{ type: "tool_use", id: "c0", name: childToolName, input: {} }] : []),
				{ type: "tool_use", id, name: "mcp__custom-tools__echo", input: { id } },
			] } };
			await gate.promise;
		},
		close() { record.closed = true; gate.resolve(); if (throwsOnClose) throw new Error("transport closed"); },
		async interrupt() { record.closed = true; gate.resolve(); },
	};
}

function answeringQuery(session) {
	return {
		async *[Symbol.asyncIterator]() {
			yield { type: "system", subtype: "init", session_id: session };
			yield { type: "result", subtype: "success", result: "resumed" };
		},
		close() {},
		async interrupt() {},
	};
}

/** A waitingQuery whose tool call Claude Code gives up on while Pi's tool
 *  still runs: the MCP handler is invoked, then Claude Code answers the call
 *  itself (`record.gaveUp` resolves). A steer delivered with tool results
 *  goes to the running query; one whose results are all for calls Claude
 *  Code gave up on is a production path that still defers it to a
 *  continuation, which the tests using this exercise. */
function abandoningQuery(record, options) {
	const gate = Promise.withResolvers();
	record.closed = false;
	record.release = () => gate.resolve();
	record.gaveUp = Promise.withResolvers();
	return {
		async *[Symbol.asyncIterator]() {
			yield { type: "system", subtype: "init", session_id: sessionId };
			yield { type: "assistant", message: { content: [{ type: "tool_use", id: "t0", name: "mcp__custom-tools__echo", input: { id: "t0" } }] } };
			const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
			await options.mcpServers["custom-tools"].instance.connect(serverTransport);
			const client = new Client({ name: "fake-claude-code", version: "1.0.0" });
			await client.connect(clientTransport);
			void client.callTool({ name: "echo", arguments: { id: "t0" }, _meta: { "claudecode/toolUseId": "t0" } }).catch(() => {});
			while (!ctx().pendingToolCalls.has("t0")) await new Promise((resolve) => setTimeout(resolve, 1));
			yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t0", content: "Claude Code stopped waiting for this call", is_error: true }] } };
			record.gaveUp.resolve();
			await gate.promise;
		},
		close() { record.closed = true; gate.resolve(); },
		async interrupt() { record.closed = true; gate.resolve(); },
	};
}

function throwingContinuation(record) {
	const gate = Promise.withResolvers();
	record.closed = false;
	return {
		async *[Symbol.asyncIterator]() {
			yield { type: "system", subtype: "init", session_id: sessionId };
			yield { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "mcp__custom-tools__echo", input: { id: "t1" } }] } };
			await gate.promise;
			throw new Error("child exited during restart");
		},
		close() { record.closed = true; gate.resolve(); },
		async interrupt() { record.closed = true; gate.resolve(); },
	};
}

/** A waitingQuery whose MCP handler for its call is invoked and waits for
 *  Pi's result; `record.answer` is what Claude Code gets back for it. */
function handlerWaitingQuery(record, options) {
	const gate = Promise.withResolvers();
	record.closed = false;
	record.release = () => gate.resolve();
	return {
		async *[Symbol.asyncIterator]() {
			yield { type: "system", subtype: "init", session_id: sessionId };
			yield { type: "assistant", message: { content: [{ type: "tool_use", id: "t0", name: "mcp__custom-tools__echo", input: { id: "t0" } }] } };
			const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
			await options.mcpServers["custom-tools"].instance.connect(serverTransport);
			const client = new Client({ name: "fake-claude-code", version: "1.0.0" });
			await client.connect(clientTransport);
			record.answer = client.callTool({ name: "echo", arguments: { id: "t0" }, _meta: { "claudecode/toolUseId": "t0" } });
			while (!ctx().pendingToolCalls.has("t0")) await new Promise((resolve) => setTimeout(resolve, 1));
			await gate.promise;
		},
		close() { record.closed = true; gate.resolve(); },
		async interrupt() { record.closed = true; gate.resolve(); },
	};
}

function importedMessages(root, id) {
	return readFileSync(openSession({ sessionId: id, projectPath: root, claudeDir: root }).jsonlPath, "utf8")
		.trim().split("\n").map((line) => JSON.parse(line).message);
}

async function withWaitingQuery(run, childToolName, throwsOnClose = false, firstQuery = undefined) {
	const root = mkdtempSync(join(tmpdir(), "bridge-compact-"));
	const env = { CLAUDE_CONFIG_DIR: root, PI_CODING_AGENT_DIR: root, CLAUDE_CODE_OAUTH_TOKEN: "offline-test", CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT: "0" };
	const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
	Object.assign(process.env, env);
	resetStack();
	const oldSession = createSession({ sessionId, projectPath: root, claudeDir: root });
	oldSession.importMessages([{ role: "user", content: "old history" }]);
	oldSession.save();
	const oldBytes = readFileSync(oldSession.jsonlPath, "utf8");
	__testSetBridgeIntegrityState({ sharedSession: { sessionId, cursor: 2, cwd: root }, ui: { notify() {} } });
	const record = {};
	const calls = [];
	const queued = [];
	__testSetSdkQueryFactory(({ prompt, options }) => {
		calls.push({ prompt, options });
		if (calls.length === 1) return firstQuery ? firstQuery(record, options) : waitingQuery(record, childToolName, throwsOnClose);
		return (queued.shift() ?? (() => answeringQuery(options.resume)))();
	});
	try {
		const opening = await collect(streamClaudeAgentSdk(model, { messages: [system, runEcho] }, { cwd: root }));
		assert.equal(opening.filter((event) => event.type === "done").length, 1);
		assert.notEqual(ctx().activeQuery, null);
		await run({ root, record, calls, queued, oldSession, oldBytes, opening });
	} finally {
		record.release();
		cancelScheduledToolUseEnd(ctx());
		__testSetSdkQueryFactory();
		__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
		resetStack();
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	}
}

describe("compaction while Claude waits for a Pi tool result", () => {
	it("restarts on Pi's new history without executing the tool again", async () => {
		await withWaitingQuery(async ({ root, record, calls, oldSession, oldBytes }) => {
			onPiHistoryReplaced("session_compact");
			const events = await collect(streamClaudeAgentSdk(model, { messages: [system, user("summary"), toolCall, toolResult] }, { cwd: root }));
			assert.equal(record.closed, true);
			assert.equal(calls.length, 2);
			assert.notEqual(calls[1].options.resume, sessionId);
			assert.equal(readFileSync(oldSession.jsonlPath, "utf8"), oldBytes);
			const imported = importedMessages(root, calls[1].options.resume);
			const blocks = imported.flatMap((message) => Array.isArray(message.content) ? message.content : []);
			assert.deepEqual(blocks.filter((block) => block.type === "tool_result").map((block) => block.content), ["tool output"]);
			assert.deepEqual(blocks.filter((block) => block.type === "tool_use").map((block) => block.id), ["t0"]);
			assert.equal(events.filter((event) => event.type === "done").length, 1);
			assert.equal(events.some((event) => event.type === "toolcall_start"), false);
			assert.equal(__testGetBridgeIntegrityState().sharedSession?.sessionId, calls[1].options.resume);
		});
	});

	it("gives the restarted query the real result, and the drain error only to the discarded one", async () => {
		await withWaitingQuery(async ({ root, record, calls }) => {
			await waitFor(() => ctx().pendingToolCalls.has("t0"));
			onPiHistoryReplaced("session_compact");
			const events = await collect(streamClaudeAgentSdk(model, { messages: [system, user("summary"), toolCall, toolResult] }, { cwd: root }));
			assert.equal(calls.length, 2);
			assert.equal(events.filter((event) => event.type === "done").length, 1);
			assert.equal(events.some((event) => event.type === "error"), false, "Pi gets no error");
			const answer = await record.answer;
			assert.equal(answer.isError, true);
			assert.equal(answer.content[0].text, "Claude bridge: the bridge restarted the query on Pi's replaced history before this tool call's result was delivered. The call did not complete and produced no output.");
			const imported = importedMessages(root, calls[1].options.resume);
			const blocks = imported.flatMap((message) => Array.isArray(message.content) ? message.content : []);
			assert.deepEqual(blocks.filter((block) => block.type === "tool_result").map((block) => [block.content, block.is_error === true]), [["tool output", false]], "the restarted query holds the real result, not an error");
		}, undefined, false, handlerWaitingQuery);
	});

	it("still fails the waiting handler of a query that ends, saying the query ended", async () => {
		await withWaitingQuery(async ({ record }) => {
			await waitFor(() => ctx().pendingToolCalls.has("t0"));
			record.release();
			const answer = await record.answer;
			assert.equal(answer.isError, true);
			assert.equal(answer.content[0].text, "Claude bridge: the query ended before this tool call's result was delivered. The call did not complete and produced no output.");
		}, undefined, false, handlerWaitingQuery);
	});

	for (const childToolName of ["mcp__claude_ai_slack__post_message", "mcp__linear__create_issue"]) {
		it("keeps the child-side call on its original history: " + childToolName, async () => {
			await withWaitingQuery(async ({ root, record, calls }) => {
				onPiHistoryReplaced("session_compact");
				streamClaudeAgentSdk(model, { messages: [system, user("summary"), toolCall, toolResult] }, { cwd: root });
				assert.equal(record.closed, false);
				assert.equal(calls.length, 1);
				assert.equal(ctx().pendingResults.get("t0")?.content[0]?.text, "tool output");
				record.release();
				await waitFor(() => ctx().activeQuery === null);
				assert.equal(__testGetBridgeIntegrityState().sharedSession?.needsRebuild, true);
				// The compacted context's summary is history Claude already has; it
				// must not come back as a continuation prompt.
				assert.equal(calls.length, 1, "the compaction summary is not replayed to Claude as a steer");
			}, childToolName);
		});
	}

	it("restarts a later connector-free query in the same session", async () => {
		await withWaitingQuery(async ({ root, record, calls, queued }) => {
			streamClaudeAgentSdk(model, { messages: [system, runEcho, toolCall, toolResult] }, { cwd: root });
			record.release();
			await waitFor(() => ctx().activeQuery === null);

			const later = {};
			queued.push(() => waitingQuery(later));
			await collect(streamClaudeAgentSdk(model, { messages: [system, runEcho, toolCall, toolResult, user("again")] }, { cwd: root }));
			onPiHistoryReplaced("session_compact");
			const events = await collect(streamClaudeAgentSdk(model, { messages: [system, user("summary"), toolCall, toolResult] }, { cwd: root }));
			assert.equal(later.closed, true);
			assert.equal(calls.length, 3);
			assert.equal(events.filter((event) => event.type === "done").length, 1);
		}, "mcp__claude_ai_slack__post_message");
	});

	it("ends the callback on abort without changing the delivered tool-use turn", async () => {
		await withWaitingQuery(async ({ root, record, calls, opening }) => {
			await waitFor(() => ctx().pendingToolCalls.has("t0"));
			onPiHistoryReplaced("session_compact");
			// The callback's signal is its own: the query started without one.
			const abort = new AbortController();
			const events = collect(streamClaudeAgentSdk(model, { messages: [system, user("summary"), toolCall, toolResult] }, { cwd: root, signal: abort.signal }));
			assert.notEqual(ctx().restartRequest, null, "the abort lands while the restart is pending");
			abort.abort();
			const result = await events;
			assert.equal(calls.length, 1);
			assert.equal(result.at(-1)?.type, "error");
			assert.equal(result.at(-1)?.reason, "aborted");
			assert.deepEqual(result.at(-1)?.error.content, []);
			assert.equal(opening.find((event) => event.type === "done").message.stopReason, "toolUse");
			const answer = await record.answer;
			assert.equal(answer.isError, true);
			assert.equal(answer.content[0].text, "Claude bridge: the turn was aborted before this tool call's result was delivered. The call did not complete and produced no output.");
		}, undefined, false, handlerWaitingQuery);
	});

	it("rebuilds in place when no Claude query is active at compaction", async () => {
		await withWaitingQuery(async ({ root, record, calls }) => {
			record.release();
			await waitFor(() => ctx().activeQuery === null);
			onPiHistoryReplaced("session_compact");
			assert.equal(__testGetBridgeIntegrityState().sharedSession?.forceRotate, undefined);
			await collect(streamClaudeAgentSdk(model, { messages: [system, user("summary"), user("next prompt")] }, { cwd: root }));
			assert.equal(calls[1].options.resume, sessionId);
		});
	});

	it("restarts a deferred continuation on compacted history", async () => {
		await withWaitingQuery(async ({ root, record, calls, queued }) => {
			const continuation = {};
			queued.push(() => waitingQuery(continuation, undefined, false, "t1"));
			await record.gaveUp.promise;
			// Before the compaction, Pi's context still holds the query's prompt.
			const steered = [system, runEcho, toolCall, toolResult, user("steer one")];
			streamClaudeAgentSdk(model, { messages: steered }, { cwd: root });
			streamClaudeAgentSdk(model, { messages: [...steered, user("steer two")] }, { cwd: root });
			record.release();
			await waitFor(() => calls.length === 2);
			assert.equal(calls[1].prompt, "steer one");
			onPiHistoryReplaced("session_compact");
			const continued = await collect(streamClaudeAgentSdk(model, { messages: [system, user("summary"), { ...toolCall, content: [{ type: "toolCall", id: "t1", name: "echo", arguments: { id: "t1" } }] }, { ...toolResult, toolCallId: "t1" }, user("steer two")] }, { cwd: root }));
			assert.equal(continuation.closed, true);
			assert.equal(calls.length, 3);
			assert.notEqual(calls[2].options.resume, sessionId);
			assert.equal(importedMessages(root, calls[2].options.resume).filter((message) => message.content === "steer two").length, 1);
			assert.equal(continued.filter((event) => event.type === "done").length, 1);
		}, undefined, false, abandoningQuery);
	});

	it("keeps a deferred steer when the killed continuation throws", async () => {
		await withWaitingQuery(async ({ root, record, calls, queued }) => {
			const continuation = {};
			queued.push(() => throwingContinuation(continuation));
			await record.gaveUp.promise;
			const steered = [system, runEcho, toolCall, toolResult, user("steer one")];
			streamClaudeAgentSdk(model, { messages: steered }, { cwd: root });
			streamClaudeAgentSdk(model, { messages: [...steered, user("steer two")] }, { cwd: root });
			record.release();
			await waitFor(() => calls.length === 2);
			onPiHistoryReplaced("session_compact");
			const result = await collect(streamClaudeAgentSdk(model, { messages: [system, user("summary"), { ...toolCall, content: [{ type: "toolCall", id: "t1", name: "echo", arguments: { id: "t1" } }] }, { ...toolResult, toolCallId: "t1" }, user("steer two")] }, { cwd: root }));
			assert.equal(continuation.closed, true);
			assert.equal(calls.length, 3);
			assert.equal(result.filter((event) => event.type === "done").length, 1);
			assert.equal(importedMessages(root, calls[2].options.resume).filter((message) => message.content === "steer two").length, 1);
		}, undefined, false, abandoningQuery);
	});

	it("restarts even if the killed child's close throws", async () => {
		await withWaitingQuery(async ({ root, calls }) => {
			onPiHistoryReplaced("session_compact");
			const events = await collect(streamClaudeAgentSdk(model, { messages: [system, user("summary"), toolCall, toolResult] }, { cwd: root }));
			assert.equal(calls.length, 2);
			assert.equal(events.filter((event) => event.type === "done").length, 1);
		}, undefined, true);
	});
});
