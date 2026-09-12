/**
 * Tests for QueryContext class and context stack infrastructure.
 * Exercises isolation, guards, deferred message merging, and context pinning
 * using the real module — no API calls, no extension activation.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ctx, pushContext, popContext, resetStack, stackDepth } from "../src/query-state.js";

const fakeModel = { api: "anthropic", provider: "anthropic", id: "test-model" };

describe("QueryContext class", () => {
	beforeEach(() => resetStack());

	it("turnBlocks throws before resetTurnState", () => {
		assert.throws(() => ctx().turnBlocks, /turnBlocks accessed before resetTurnState/);
	});

	it("turnBlocks reflects turnOutput.content after resetTurnState", () => {
		ctx().resetTurnState(fakeModel);
		assert.ok(Array.isArray(ctx().turnBlocks));
		assert.strictEqual(ctx().turnBlocks.length, 0);

		ctx().turnBlocks.push({ type: "text", text: "hello" });
		assert.strictEqual(ctx().turnOutput.content.length, 1);
		assert.strictEqual(ctx().turnOutput.content[0].text, "hello");
		// Same array reference
		assert.strictEqual(ctx().turnBlocks, ctx().turnOutput.content);
	});

	it("resetTurnState preserves active tool tracking across result-delivery callbacks", () => {
		ctx().turnToolCallIds = ["id1", "id2"];
		ctx().recordToolCall("id1", "read", { path: "a" });
		ctx().markToolResultDelivered("id1");
		ctx().resetTurnState(fakeModel);

		assert.deepStrictEqual(ctx().turnToolCallIds, ["id1", "id2"]);
		assert.deepStrictEqual(ctx().turnToolCalls.map((call) => call.id), ["id1"]);
		assert.ok(ctx().deliveredToolResultIds.has("id1"));
	});

	it("resetToolTracking clears tool-call matching state for a new assistant message", () => {
		ctx().recordToolCall("id1", "read", { path: "a" });
		ctx().markToolResultDelivered("id1");
		ctx().markToolResultResolved("id1");
		ctx().resetToolTracking();

		assert.deepStrictEqual(ctx().turnToolCallIds, []);
		assert.deepStrictEqual(ctx().turnToolCalls, []);
		assert.strictEqual(ctx().deliveredToolResultIds.size, 0);
		assert.strictEqual(ctx().resolvedToolResultIds.size, 0);
	});

	it("claimToolCall matches handler invocation by tool name and args, not stream position", () => {
		ctx().recordToolCall("call-read", "read", { path: "a.txt" });
		ctx().recordToolCall("call-grep", "grep", { pattern: "needle", path: "src" });

		const second = ctx().claimToolCall("grep", { path: "src", pattern: "needle" });
		assert.equal(second.toolCallId, "call-grep");
		assert.equal(second.match, "tool-args");

		const first = ctx().claimToolCall("read", { path: "a.txt" });
		assert.equal(first.toolCallId, "call-read");
		assert.equal(first.match, "tool-args");
	});

	it("claimToolCall handles same-tool parallel calls invoked out of stream order", () => {
		ctx().recordToolCall("read-a", "read", { path: "a.txt" });
		ctx().recordToolCall("read-b", "read", { path: "b.txt" });
		ctx().recordToolCall("grep-src", "grep", { path: "src", pattern: "needle" });
		ctx().recordToolCall("grep-tests", "grep", { path: "tests", pattern: "needle" });

		const readSecond = ctx().claimToolCall("read", { path: "b.txt" });
		const grepSecond = ctx().claimToolCall("grep", { pattern: "needle", path: "tests" });
		const readFirst = ctx().claimToolCall("read", { path: "a.txt" });
		const grepFirst = ctx().claimToolCall("grep", { path: "src", pattern: "needle" });

		assert.equal(readSecond.toolCallId, "read-b");
		assert.equal(grepSecond.toolCallId, "grep-tests");
		assert.equal(readFirst.toolCallId, "read-a");
		assert.equal(grepFirst.toolCallId, "grep-src");
		for (const claim of [readSecond, grepSecond, readFirst, grepFirst]) {
			assert.equal(claim.match, "tool-args");
			assert.equal(claim.ambiguous, false);
		}
	});

	it("claimToolCall refuses to fall back to a different tool type", () => {
		ctx().recordToolCall("bash-1", "bash", { command: "echo ok", timeout: 120 });

		const claim = ctx().claimToolCall("write", { path: "out.txt", content: "ok" });

		assert.equal(claim.toolCallId, undefined);
		assert.equal(claim.match, "none");
		assert.equal(claim.available, 1);
		assert.equal(ctx().claimedToolCallIds.has("bash-1"), false);
	});

	it("claimToolCall allows sole same-name call before arguments finalize", () => {
		ctx().recordToolCall("read-pending", "read", {});

		const claim = ctx().claimToolCall("read", { path: "README.md" });

		assert.equal(claim.toolCallId, "read-pending");
		assert.equal(claim.match, "tool-name");
		assert.equal(claim.ambiguous, false);
	});

	it("claimToolCall claims the sole same-name call even when recorded args diverge", () => {
		// Recorded args = raw streamed input; handler args = zod-validated copy.
		// A stripped/extra key must not strand the only call this handler can be.
		ctx().recordToolCall("edit-1", "edit", { path: "a.ts", edits: [{ oldText: "x", newText: "y", stray: true }] });

		const claim = ctx().claimToolCall("edit", { path: "a.ts", edits: [{ oldText: "x", newText: "y" }] });

		assert.equal(claim.toolCallId, "edit-1");
		assert.equal(claim.match, "tool-name");
		assert.equal(claim.argsMismatch, true);
		assert.equal(ctx().claimedToolCallIds.has("edit-1"), true);
	});

	it("claimToolCall still refuses when several same-name calls all mismatch", () => {
		ctx().recordToolCall("edit-a", "edit", { path: "a.ts", edits: [] });
		ctx().recordToolCall("edit-b", "edit", { path: "b.ts", edits: [] });

		const claim = ctx().claimToolCall("edit", { path: "c.ts", edits: [] });

		assert.equal(claim.toolCallId, undefined);
		assert.equal(claim.match, "none");
		assert.equal(claim.available, 2);
	});

	it("takeStaleQueuedResults drains the queue and names tools across message resets", () => {
		ctx().recordToolCall("bash-lost", "bash", { command: "echo hi", timeout: 120 });
		ctx().pendingResults.set("bash-lost", { content: [{ type: "text", text: "hi" }] });
		ctx().resetToolTracking(); // per-message records are cleared at a child-message boundary

		const progress = ctx().toolResultProgress();
		assert.equal(progress.queuedCount, 1);
		assert.deepEqual(progress.toolNames, [{ name: "bash", count: 1 }], "query-scoped names survive the reset");

		const stale = ctx().takeStaleQueuedResults();
		assert.deepEqual(stale, [{ id: "bash-lost", toolName: "bash" }]);
		assert.equal(ctx().pendingResults.size, 0);
		assert.deepEqual(ctx().takeStaleQueuedResults(), [], "second drain is empty");
	});

	it("toolResultProgress reports teardown mismatch counts", () => {
		ctx().recordToolCall("t0", "read", { path: "a" });
		ctx().recordToolCall("t1", "grep", { pattern: "x" });
		ctx().markToolResultDelivered("t0");
		ctx().markToolResultResolved("t0");
		ctx().pendingResults.set("t1", { toolCallId: "t1", content: [{ type: "text", text: "queued" }] });
		ctx().markToolResultDelivered("t1");

		const progress = ctx().toolResultProgress();
		assert.equal(progress.expectedCount, 2);
		assert.equal(progress.deliveredCount, 2);
		assert.equal(progress.resolvedCount, 1);
		assert.deepStrictEqual(progress.queuedIds, ["t1"]);
		assert.deepStrictEqual(progress.unresolvedIds, ["t1"]);
		assert.deepStrictEqual(progress.toolNames, [{ name: "grep", count: 1 }]);
	});

	it("toolResultProgress reports unmatched result ids", () => {
		ctx().recordToolCall("t0", "read", { path: "a" });
		ctx().markToolResultUnmatched("unknown-result");

		const progress = ctx().toolResultProgress();

		assert.deepStrictEqual(progress.unmatchedResultIds, ["unknown-result"]);
		assert.equal(progress.unmatchedResultCount, 1);
	});
});

describe("context stack guards", () => {
	beforeEach(() => resetStack());

	it("pushContext throws with no active query", () => {
		assert.throws(() => pushContext(), /no active query/);
	});

	it("popContext throws on empty stack", () => {
		assert.throws(() => popContext(), /empty stack/);
	});
});

describe("stack isolation and restore", () => {
	beforeEach(() => resetStack());

	it("push/pop isolates state and restores parent", () => {
		// Parent setup
		ctx().activeQuery = { id: "parent" };
		ctx().pendingToolCalls.set("t1", { toolName: "read", resolve: () => {} });
		ctx().latestCursor = 42;
		ctx().deferredUserMessages = ["parent-msg"];

		// Push — child should be clean
		pushContext();
		assert.strictEqual(ctx().activeQuery, null);
		assert.strictEqual(ctx().pendingToolCalls.size, 0);
		assert.strictEqual(ctx().pendingResults.size, 0);
		assert.strictEqual(ctx().latestCursor, 0);
		assert.deepStrictEqual(ctx().deferredUserMessages, []);

		// Mutate child
		ctx().activeQuery = { id: "child" };
		ctx().pendingToolCalls.set("t2", { toolName: "write", resolve: () => {} });
		ctx().latestCursor = 99;

		// Pop — parent restored
		popContext();
		assert.deepStrictEqual(ctx().activeQuery, { id: "parent" });
		assert.strictEqual(ctx().pendingToolCalls.size, 1);
		assert.ok(ctx().pendingToolCalls.has("t1"));
		assert.strictEqual(ctx().latestCursor, 42);
	});

	it("deferred messages merge on pop in FIFO order", () => {
		ctx().activeQuery = { id: "parent" };
		ctx().deferredUserMessages = ["parent-1", "parent-2"];

		pushContext();
		ctx().deferredUserMessages = ["child-1", "child-2"];

		popContext();
		assert.deepStrictEqual(
			ctx().deferredUserMessages,
			["parent-1", "parent-2", "child-1", "child-2"],
		);
	});

	it("triple-nested isolation — each level independent, pop restores", () => {
		// Level 0 (root)
		ctx().activeQuery = { id: "L0" };
		ctx().latestCursor = 10;
		ctx().deferredUserMessages = ["L0-msg"];

		// Level 1
		pushContext();
		assert.strictEqual(stackDepth(), 1);
		ctx().activeQuery = { id: "L1" };
		ctx().latestCursor = 20;
		ctx().deferredUserMessages = ["L1-msg"];

		// Level 2
		pushContext();
		assert.strictEqual(stackDepth(), 2);
		ctx().activeQuery = { id: "L2" };
		ctx().latestCursor = 30;
		ctx().deferredUserMessages = ["L2-msg"];

		// Pop L2 → L1 (L2's deferred merge into L1)
		popContext();
		assert.strictEqual(stackDepth(), 1);
		assert.deepStrictEqual(ctx().activeQuery, { id: "L1" });
		assert.strictEqual(ctx().latestCursor, 20);
		assert.deepStrictEqual(ctx().deferredUserMessages, ["L1-msg", "L2-msg"]);

		// Pop L1 → L0 (L1+L2's deferred merge into L0)
		popContext();
		assert.strictEqual(stackDepth(), 0);
		assert.deepStrictEqual(ctx().activeQuery, { id: "L0" });
		assert.strictEqual(ctx().latestCursor, 10);
		assert.deepStrictEqual(ctx().deferredUserMessages, ["L0-msg", "L1-msg", "L2-msg"]);
	});
});

describe("context pinning (MCP handler closure pattern)", () => {
	beforeEach(() => resetStack());

	it("captured context ref stays valid across push/pop", () => {
		ctx().activeQuery = { id: "parent" };
		ctx().pendingToolCalls.set("t1", { toolName: "read", resolve: () => {} });

		// Simulate handler capturing parent context before push
		const capturedCtx = ctx();

		pushContext();
		// After push, ctx() is the child — but capturedCtx still points to parent
		assert.notStrictEqual(ctx(), capturedCtx);
		assert.strictEqual(capturedCtx.pendingToolCalls.size, 1);
		assert.ok(capturedCtx.pendingToolCalls.has("t1"));

		// Mutate child — captured parent unaffected
		ctx().pendingToolCalls.set("t2", { toolName: "write", resolve: () => {} });
		assert.strictEqual(capturedCtx.pendingToolCalls.size, 1);

		// Pop restores parent as current
		popContext();
		assert.strictEqual(ctx(), capturedCtx);
	});

	it("captured parent context tracks a parent result while child query is current", () => {
		ctx().activeQuery = { id: "parent" };
		ctx().recordToolCall("parent-tool", "read", { path: "parent.txt" });
		const capturedParent = ctx();

		pushContext();
		ctx().activeQuery = { id: "child" };
		ctx().recordToolCall("child-tool", "read", { path: "child.txt" });

		capturedParent.markToolResultDelivered("parent-tool");
		capturedParent.markToolResultResolved("parent-tool");
		const parentProgress = capturedParent.toolResultProgress();
		const childProgress = ctx().toolResultProgress();

		assert.equal(parentProgress.resolvedCount, 1);
		assert.equal(childProgress.resolvedCount, 0);
		assert.deepStrictEqual(childProgress.missingDeliveredIds, ["child-tool"]);

		popContext();
		assert.strictEqual(ctx(), capturedParent);
	});
});
