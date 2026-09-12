/**
 * Tests for draining MCP handlers that are still waiting when a query tears down.
 * A drained handler must resolve as an ERROR naming the teardown cause — never as
 * a successful result whose text merely says the turn died, which a consumer
 * cannot tell apart from a tool that genuinely returned that string.
 * Uses the real module — no API calls, no extension activation.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { QueryContext, ctx, drainPendingToolCalls, interruptedToolCallResult, resetStack, toolCallDrainCause } from "../src/query-state.js";

// Registers a waiting handler the same way buildMcpServers does: the handler's
// return value IS this promise, so awaiting it is what a real tool call sees.
function registerWaitingCall(queryCtx, toolCallId, toolName = "read") {
	return new Promise((resolve) => {
		queryCtx.pendingToolCalls.set(toolCallId, {
			toolName,
			resolve: (result) => {
				queryCtx.markToolResultResolved(toolCallId);
				resolve(result);
			},
		});
	});
}

describe("pending tool call drain", () => {
	beforeEach(() => resetStack());

	it("resolves a waiting call as an error, not a success carrying teardown text", async () => {
		const waiting = registerWaitingCall(ctx(), "call-1");
		assert.equal(drainPendingToolCalls(ctx(), "query-end"), 1);

		const result = await waiting;
		assert.equal(result.isError, true, "drained tool call must be marked as an error");
		assert.equal(result.content[0].type, "text");
		assert.match(result.content[0].text, /the query ended before this tool call's result was delivered/);
	});

	it("names the abort cause distinctly from a plain query end", async () => {
		const waiting = registerWaitingCall(ctx(), "call-abort");
		assert.equal(drainPendingToolCalls(ctx(), "abort"), 1);

		const result = await waiting;
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /the turn was aborted/);
		assert.doesNotMatch(result.content[0].text, /the query ended/);
	});

	it("names the stream-idle timeout cause distinctly", async () => {
		const waiting = registerWaitingCall(ctx(), "call-idle");
		assert.equal(drainPendingToolCalls(ctx(), "stream-idle-timeout"), 1);

		const result = await waiting;
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /stream went idle and the turn timed out/);
	});

	it("every cause is an error and every cause reads differently", () => {
		const texts = new Set();
		for (const cause of ["abort", "stream-idle-timeout", "query-end"]) {
			const result = interruptedToolCallResult(cause);
			assert.equal(result.isError, true, `${cause} must be an error result`);
			assert.ok(result.content[0].text.length > 0);
			texts.add(result.content[0].text);
		}
		assert.equal(texts.size, 3, "each teardown cause must produce its own message");
	});

	it("drains every waiting handler, clears the map, and marks them resolved", async () => {
		const first = registerWaitingCall(ctx(), "call-a", "read");
		const second = registerWaitingCall(ctx(), "call-b", "grep");

		assert.equal(drainPendingToolCalls(ctx(), "abort"), 2);
		assert.equal(ctx().pendingToolCalls.size, 0);
		for (const result of await Promise.all([first, second])) assert.equal(result.isError, true);
		assert.ok(ctx().resolvedToolResultIds.has("call-a"));
		assert.ok(ctx().resolvedToolResultIds.has("call-b"));
	});

	it("is a no-op with nothing waiting", () => {
		assert.equal(drainPendingToolCalls(ctx(), "query-end"), 0);
	});

	it("is scoped to the context it is given and leaves other queries alone", async () => {
		const other = new QueryContext();
		let otherResolved = false;
		void registerWaitingCall(other, "other-call").then(() => { otherResolved = true; });
		const mine = registerWaitingCall(ctx(), "my-call");

		assert.equal(drainPendingToolCalls(ctx(), "query-end"), 1);
		await mine;
		await new Promise((resolve) => setImmediate(resolve));

		assert.equal(otherResolved, false, "another query's handlers must not be drained");
		assert.equal(other.pendingToolCalls.size, 1);
	});
});

describe("teardown cause selection", () => {
	it("maps a plain end with stragglers to query-end", () => {
		assert.equal(toolCallDrainCause({}), "query-end");
		assert.equal(toolCallDrainCause({ wasAborted: false, signalAborted: false, streamIdleTimedOut: false }), "query-end");
	});

	it("maps our own abort handler and pi's abort signal to abort", () => {
		assert.equal(toolCallDrainCause({ wasAborted: true }), "abort");
		assert.equal(toolCallDrainCause({ signalAborted: true }), "abort");
	});

	it("maps a stream-idle timeout to stream-idle-timeout", () => {
		assert.equal(toolCallDrainCause({ streamIdleTimedOut: true }), "stream-idle-timeout");
	});

	it("prefers abort when a timeout and an abort both fired", () => {
		assert.equal(toolCallDrainCause({ streamIdleTimedOut: true, wasAborted: true }), "abort");
		assert.equal(toolCallDrainCause({ streamIdleTimedOut: true, signalAborted: true }), "abort");
	});
});
