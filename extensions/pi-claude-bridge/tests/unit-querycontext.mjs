/**
 * Tests for the QueryContext class and the lane's current context.
 * Exercises tool-call matching, progress reporting, and context pinning
 * using the real module — no API calls, no extension activation.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ctx, detachContext, resetStack } from "../src/query-state.js";

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

describe("context pinning (MCP handler closure pattern)", () => {
	beforeEach(() => resetStack());

	it("a captured context stays valid after a quarantine hands the lane to a new context", () => {
		ctx().activeQuery = { id: "aborted" };
		ctx().recordToolCall("old-tool", "read", { path: "old.txt" });
		ctx().pendingToolCalls.set("old-tool", { toolName: "read", resolve: () => {} });
		ctx().detachedFromSharedSession = true;

		// A handler captures its query's context, then the query is quarantined.
		const captured = ctx();
		detachContext(captured);
		assert.notStrictEqual(ctx(), captured);
		assert.strictEqual(ctx().activeQuery, null, "the next query starts on a clean context");
		assert.strictEqual(ctx().pendingToolCalls.size, 0);
		assert.strictEqual(ctx().detachedFromSharedSession, true, "a late orphaned result stays attributed to the detached query");

		// The next query's state and the captured one stay apart.
		ctx().activeQuery = { id: "next" };
		ctx().recordToolCall("new-tool", "read", { path: "new.txt" });
		captured.markToolResultDelivered("old-tool");
		captured.markToolResultResolved("old-tool");
		assert.equal(captured.toolResultProgress().resolvedCount, 1);
		assert.equal(ctx().toolResultProgress().resolvedCount, 0);
		assert.deepStrictEqual(ctx().toolResultProgress().missingDeliveredIds, ["new-tool"]);
		assert.strictEqual(captured.pendingToolCalls.size, 1);

		// Detaching an already replaced context is a no-op.
		const next = ctx();
		detachContext(captured);
		assert.strictEqual(ctx(), next);
	});
});
