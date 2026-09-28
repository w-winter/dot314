// A terminal failure can end a query after its tool-use turn already reached
// Pi (Claude Code dies, or hits a usage limit, while Pi runs the tool). The
// delivered turn must stay as it was, so the failure is reported by the
// tool-result callback that directly follows, which finds no live query: as
// its own fresh error message, exactly once. An abort is never reported that
// way; a fresh query drops an unreported failure; and it never reaches a
// callback of another lane or a call the failed query did not make.
import "./lib/debug-env.mjs";

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { AssistantMessageFrameEncoder, Type } from "@earendil-works/pi-ai";
import { runAgentLoop } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/index.js";
import { __testSetBridgeIntegrityState, __testSetSdkQueryFactory, streamClaudeAgentSdk } from "../src/index.ts";
import { setExtensionApi } from "../src/bridge-state.ts";
import { ctx, resetStack } from "../src/query-state.ts";
import { runInRequestLane } from "../src/request-lane.ts";
import { consumeLikePi, encodeLikePi } from "./lib/pi-frame-consumer.mjs";

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
const MYTOOL = { name: "mytool", description: "test tool", parameters: { type: "object", properties: {} } };

let root;
let hold;
beforeEach(() => {
	hold = setInterval(() => {}, 1000);
	root = mkdtempSync(join(tmpdir(), "bridge-late-failure-"));
	process.env.CLAUDE_CONFIG_DIR = root;
	process.env.CLAUDE_CODE_OAUTH_TOKEN = "offline-test";
	process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT = "0";
	process.env.CLAUDE_BRIDGE_DIAG_PATH = join(root, "diag.log");
	resetStack();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: { notify: () => {} } });
	setExtensionApi({ events: { emit: () => {} }, appendEntry: () => {} });
});

afterEach(() => {
	clearInterval(hold);
	__testSetSdkQueryFactory();
	setExtensionApi(undefined);
	resetStack();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
	delete process.env.CLAUDE_CONFIG_DIR;
	delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
	delete process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT;
	delete process.env.CLAUDE_BRIDGE_DIAG_PATH;
	rmSync(root, { recursive: true, force: true });
});

const toolTurn = (id = "call-1") => [
	{ type: "message_start", message: { id: `m-${id}`, model: model.id, usage: { input_tokens: 1 } } },
	{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name: "mcp__custom-tools__mytool", input: {} } },
	{ type: "content_block_stop", index: 0 },
	{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
	{ type: "message_stop" },
].map((event) => ({ type: "stream_event", event }));

const FAILURES = {
	"an execution error (surfaced at completion)": { tail: () => ({ type: "result", subtype: "error_during_execution", errors: ["API Error: 500 internal server error"] }), message: "API Error: 500 internal server error" },
	"a usage limit (surfaced inside consumeQuery)": { tail: () => ({ type: "result", subtype: "error_during_execution", errors: ["You've hit your weekly limit · resets Thursday 4am"] }), message: "You've hit your weekly limit · resets Thursday 4am" },
	"a process throw (surfaced by the query's catch)": { tail: () => new Error("Claude Code process exited with code 1"), message: "Claude Code process exited with code 1" },
};

/** Tool turn, then (after `gate`) the failure. `closed` resolves at teardown. */
function installFailingQuery(tail, gate = Promise.resolve()) {
	let markClosed;
	const closed = new Promise((resolve) => { markClosed = resolve; });
	__testSetSdkQueryFactory(() => ({
		async *[Symbol.asyncIterator]() {
			yield { type: "system", subtype: "init", session_id: "33333333-3333-4333-8333-333333333333" };
			for (const message of toolTurn()) yield message;
			await gate;
			const failure = tail();
			if (failure instanceof Error) throw failure;
			yield failure;
		},
		close() { markClosed(); },
		async interrupt() {},
	}));
	return closed;
}

/** Pi's real loop; every provider stream is encoded like Pi does. */
async function runPiTurn(sessionId, closed, releaseFailure, onToolRun = () => {}) {
	const streams = [];
	let executions = 0;
	const history = await runAgentLoop(
		[{ role: "user", content: "run it", timestamp: Date.now() }],
		{ messages: [], tools: [{
			name: "mytool", label: "My tool", description: "test tool", parameters: Type.Object({}),
			async execute() {
				executions++;
				releaseFailure();
				// Finish only after the failed query is torn down, so Pi's
				// tool-result callback finds no live query.
				await closed;
				onToolRun();
				return { content: [{ type: "text", text: "REAL RESULT" }], details: {} };
			},
		}] },
		{ model, convertToLlm: (messages) => messages, sessionId },
		async () => {},
		undefined,
		(m, context, options) => {
			const inner = streamClaudeAgentSdk(m, context, options);
			const events = [];
			const encoder = new AssistantMessageFrameEncoder();
			streams.push(events);
			return {
				async *[Symbol.asyncIterator]() {
					for await (const event of inner) {
						events.push(event);
						await Promise.resolve();
						encoder.encode(event);
						yield event;
					}
				},
				result: () => inner.result(),
			};
		},
	);
	for (const events of streams) encodeLikePi(events);
	return { history, executions };
}

function assertReportedOnce(history, executions, message) {
	const assistants = history.filter((entry) => entry.role === "assistant");
	assert.equal(executions, 1);
	assert.equal(assistants.length, 2, "the tool turn, then the failure as its own message");
	assert.equal(assistants[0].stopReason, "toolUse", "the delivered tool turn is never changed");
	assert.equal(assistants[0].errorMessage, undefined);
	assert.deepEqual(assistants[0].content.map((block) => block.id), ["call-1"]);
	assert.equal(history.find((entry) => entry.role === "toolResult")?.content[0].text, "REAL RESULT");
	assert.equal(assistants[1].stopReason, "error", "Pi ends the turn with the failure, not as if Claude had finished");
	assert.equal(assistants[1].errorMessage, message);
	assert.deepEqual(assistants[1].content, [], "a fresh message: nothing of the delivered turn");
	assert.notEqual(assistants[1], assistants[0]);
}

describe("a terminal failure after the tool turn reached Pi", () => {
	for (const [kind, { tail, message }] of Object.entries(FAILURES)) {
		it(`reports ${kind} on the tool-result callback that follows`, async () => {
			const gate = Promise.withResolvers();
			const closed = installFailingQuery(tail, gate.promise);
			const { history, executions } = await runPiTurn(`late-${kind.length}`, closed, gate.resolve);
			assertReportedOnce(history, executions, message);
		});
	}

	it("reports it on the callback for a call Claude Code already gave up on", async () => {
		const gate = Promise.withResolvers();
		const closed = installFailingQuery(FAILURES["an execution error (surfaced at completion)"].tail, gate.promise);
		const sessionId = "late-abandoned";
		const { history, executions } = await runPiTurn(sessionId, closed, gate.resolve, () => {
			// As noteAbandonedToolCalls records it when Claude Code answers the
			// call itself (a CC-side limit) while Pi still runs it.
			runInRequestLane(sessionId, () => ctx().abandonedToolCalls.set("call-1", { toolName: "mytool", reason: "timed out" }));
		});
		assertReportedOnce(history, executions, "API Error: 500 internal server error");
	});
});

// --- Direct provider calls: who may report a held failure ---

const promptContext = () => [
	{ role: "system", content: "test system prompt", toolsAdded: [MYTOOL], timestamp: 0 },
	{ role: "user", content: "run it", timestamp: 1 },
];
const toolResult = (toolCallId = "call-1") => ({ role: "toolResult", toolCallId, toolName: "mytool", content: [{ type: "text", text: "REAL RESULT" }], isError: false, timestamp: 3 });

/** A query that fails right after delivering its tool turn; returns Pi's context for the tool-result callback. */
async function failAfterToolTurn(sessionId) {
	const closed = installFailingQuery(FAILURES["an execution error (surfaced at completion)"].tail);
	const messages = promptContext();
	const first = await consumeLikePi(streamClaudeAgentSdk(model, { messages }, { sessionId }));
	assert.equal(first.final.stopReason, "toolUse");
	await closed;
	await new Promise((resolve) => setTimeout(resolve, 10));
	return [...messages, first.final];
}

async function callback(sessionId, messages, options = {}) {
	// An orphaned callback's stream is a lone terminal event. Pi feeds only
	// start/update events to its frame encoder, so a done without start is
	// valid there (the helper's encoder would reject it); collect it plainly.
	const events = [];
	for await (const event of streamClaudeAgentSdk(model, { messages }, { sessionId, ...options })) events.push(event);
	return events.at(-1);
}

describe("who reports a held terminal failure", () => {
	it("reports it once: a second callback ends normally", async () => {
		const history = await failAfterToolTurn("held-once");
		const first = await callback("held-once", [...history, toolResult()]);
		assert.equal(first.type, "error");
		const again = await callback("held-once", [...history, toolResult()]);
		assert.equal(again.type, "done");
	});

	it("never reports it on an aborted callback", async () => {
		const history = await failAfterToolTurn("held-abort");
		const controller = new AbortController();
		controller.abort();
		const aborted = await callback("held-abort", [...history, toolResult()], { signal: controller.signal });
		assert.equal(aborted.type, "done");
		const after = await callback("held-abort", [...history, toolResult()]);
		assert.equal(after.type, "done", "the abort consumed it");
	});

	it("a fresh query drops it", async () => {
		const history = await failAfterToolTurn("held-fresh");
		__testSetSdkQueryFactory(() => ({
			async *[Symbol.asyncIterator]() { yield { type: "result", subtype: "success", result: "fresh answer" }; },
			close() {},
			async interrupt() {},
		}));
		// The conversation's own next prompt, after a run that ended without
		// the tool-result callback (a terminate:true batch): its history
		// carries the failed query's tool turn and result. A request without
		// them is another conversation's and runs apart (unit-foreign-calls).
		const fresh = await callback("held-fresh", [...history, toolResult(), { role: "user", content: "new prompt", timestamp: 5 }]);
		assert.equal(fresh.type, "done");
		const late = await callback("held-fresh", [...history, toolResult()]);
		assert.equal(late.type, "done");
	});

	it("never reaches another lane or a call the failed query did not make", async () => {
		const history = await failAfterToolTurn("held-lane");
		const otherLane = await callback("some-other-session", [...history, toolResult()]);
		assert.equal(otherLane.type, "done", "another lane has its own state");
		const foreignCall = await callback("held-lane", [...history.slice(0, -1), { ...history.at(-1), content: [{ type: "toolCall", id: "not-ours", name: "mytool", arguments: {} }] }, toolResult("not-ours")]);
		assert.equal(foreignCall.type, "done", "a result for another call does not report it");
		// The call above is not this query's callback, so it runs apart and
		// leaves the held failure alone: the query's own callback reports it.
		const own = await callback("held-lane", [...history, toolResult()]);
		assert.equal(own.type, "error", "the query's own callback still reports it");
		const late = await callback("held-lane", [...history, toolResult()]);
		assert.equal(late.type, "done", "only the callback that directly follows may report it");
	});
});

describe("a usage limit that ends the query while Pi runs the tool", () => {
	it("is reported on the tool-result callback that arrives before the query wound down", async () => {
		// consumeQuery holds the usage-limit result while Pi runs the tool; the
		// query is still active when Pi's tool-result callback comes in.
		const callbackArrived = Promise.withResolvers();
		const resultSent = Promise.withResolvers();
		let markClosed;
		const closed = new Promise((resolve) => { markClosed = resolve; });
		const limit = "You've hit your weekly limit · resets Thursday 4am";
		__testSetSdkQueryFactory(() => ({
			async *[Symbol.asyncIterator]() {
				yield { type: "system", subtype: "init", session_id: "33333333-3333-4333-8333-333333333333" };
				for (const message of toolTurn()) yield message;
				yield { type: "result", subtype: "error_during_execution", errors: [limit] };
				resultSent.resolve();
				await callbackArrived.promise;
			},
			close() { markClosed(); },
			async interrupt() {},
		}));
		let calls = 0;
		const history = await runAgentLoop(
			[{ role: "user", content: "run it", timestamp: Date.now() }],
			{ messages: [], tools: [{
				name: "mytool", label: "My tool", description: "test tool", parameters: Type.Object({}),
				async execute() {
					await resultSent.promise;
					return { content: [{ type: "text", text: "REAL RESULT" }], details: {} };
				},
			}] },
			{ model, convertToLlm: (messages) => messages, sessionId: "late-usage-limit-active" },
			async () => {},
			undefined,
			(m, context, options) => {
				const stream = streamClaudeAgentSdk(m, context, options);
				if (++calls === 2) callbackArrived.resolve();
				return stream;
			},
		);
		await closed;
		const assistants = history.filter((entry) => entry.role === "assistant");
		assert.equal(assistants.length, 2);
		assert.equal(assistants[0].stopReason, "toolUse", "the delivered tool turn is never changed");
		assert.equal(assistants[1].stopReason, "error");
		assert.equal(assistants[1].errorMessage, limit);
		assert.deepEqual(assistants[1].content, [], "a fresh message");
		// Pi's auto-retry drops the error message and calls again with the
		// tool result last: the failure was reported, so it is not repeated.
		const retry = await callback("late-usage-limit-active", history.slice(0, -1));
		assert.equal(retry.type, "done", "reported exactly once");
	});
});

describe("a cancelled request is never held for a later callback", () => {
	it("a continuation that delivered its tool turn, then was cancelled and threw, holds nothing", async () => {
		// The original query answers and a steer is deferred; the continuation
		// hands Pi a tool call (the Pi turn ends), then Pi cancels the request
		// and Claude Code's iterator throws.
		const controller = new AbortController();
		let queryCtx;
		let queries = 0;
		__testSetSdkQueryFactory(() => {
			queries += 1;
			if (queries === 1) {
				queryCtx = ctx();
				ctx().deferredUserMessages.push({ text: "steer" });
				return {
					async *[Symbol.asyncIterator]() {
						yield { type: "system", subtype: "init", session_id: "55555555-5555-4555-8555-555555555555" };
						yield { type: "assistant", message: { id: "m0", model: model.id, content: [{ type: "text", text: "FIRST" }] } };
						yield { type: "result", subtype: "success", result: "FIRST" };
					},
					close() {},
					async interrupt() {},
				};
			}
			return {
				async *[Symbol.asyncIterator]() {
					for (const message of toolTurn("call-c1")) yield message;
					await new Promise((resolve) => setTimeout(resolve, 10));
					controller.abort();
					throw new Error("Operation aborted");
				},
				close() {},
				async interrupt() {},
			};
		});
		const events = [];
		for await (const event of streamClaudeAgentSdk(model, { messages: promptContext() }, { sessionId: "held-cancelled", signal: controller.signal })) events.push(event);
		assert.equal(events.at(-1).type, "done");
		assert.equal(events.at(-1).reason, "toolUse", "the continuation's tool turn reached Pi");
		await new Promise((resolve) => setTimeout(resolve, 40));
		assert.ok(queryCtx, "captured the query's context");
		assert.equal(queryCtx.undeliveredFailure, null, "a cancellation is never held for the next callback");
	});
});
