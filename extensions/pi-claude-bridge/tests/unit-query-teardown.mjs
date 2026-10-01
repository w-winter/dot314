/**
 * Tests for query teardown keyed to the CAPTURED query context (audit C1).
 *
 * A quarantined query (abort, stream-idle timeout) ends after its lane was
 * handed to a new context, which the next prompt's query may already use.
 * Teardown keyed on the live ctx() would mutate that query's state and skip
 * the quarantined query's own drain entirely. These tests require
 * teardownQuery to touch only the context it was given.
 * Uses the real module — no API calls, no extension activation.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Route diag/integrity output away from the real user dir BEFORE the modules load.
const scratch = mkdtempSync(join(tmpdir(), "claude-bridge-teardown-test-"));
process.env.CLAUDE_BRIDGE_DIAG_PATH = join(scratch, "diag.log");
process.env.PI_CODING_AGENT_DIR = scratch;

const { ctx, detachContext, resetStack } = await import("../src/query-state.js");
const { teardownQuery } = await import("../src/query-teardown.js");
const { __testGetBridgeIntegrityState, __testSetBridgeIntegrityState } = await import("../src/bridge-state.js");

import { describe, it, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";

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

describe("teardownQuery", () => {
	beforeEach(() => resetStack());

	it("tears down a plain outermost query: drains handlers, clears results, releases activeQuery", async () => {
		const queryCtx = ctx();
		const sdkQuery = { id: "sdk-query" };
		queryCtx.activeQuery = sdkQuery;
		queryCtx.recordToolCall("call-1", "read", { path: "a" });
		const waiting = registerWaitingCall(queryCtx, "call-1");
		queryCtx.pendingResults.set("call-2", { content: [], isError: false });

		assert.equal(teardownQuery(queryCtx, sdkQuery, "query-end", "/tmp"), true);
		assert.equal(queryCtx.activeQuery, null);
		assert.equal(queryCtx.pendingToolCalls.size, 0);
		assert.equal(queryCtx.pendingResults.size, 0);
		const result = await waiting;
		assert.equal(result.isError, true);
	});

	it("no-ops when the query is no longer the context's active one", () => {
		const queryCtx = ctx();
		const replacement = { id: "continuation" };
		queryCtx.activeQuery = replacement;
		registerWaitingCall(queryCtx, "call-1");

		assert.equal(teardownQuery(queryCtx, { id: "original" }, "query-end", "/tmp"), false);
		assert.equal(queryCtx.activeQuery, replacement);
		assert.equal(queryCtx.pendingToolCalls.size, 1);
	});

	it("a quarantined query drains its OWN handlers, not the next query's on the lane's new context", async () => {
		// The C1 defect scenario: the query ends after the lane was handed to a
		// new context. Live-ctx teardown drained the new query's handlers and
		// left the ended query's leaked; keyed teardown does the reverse.
		const aborted = ctx();
		const abortedQuery = { id: "aborted-query" };
		aborted.activeQuery = abortedQuery;
		aborted.recordToolCall("aborted-call", "bash", { cmd: "ls" });
		const abortedWaiting = registerWaitingCall(aborted, "aborted-call", "bash");

		detachContext(aborted);
		const next = ctx();
		next.activeQuery = { id: "next-query" };
		next.recordToolCall("next-call", "read", { path: "b" });
		registerWaitingCall(next, "next-call");

		assert.equal(teardownQuery(aborted, abortedQuery, "abort", "/tmp"), true);

		// The ended query's handler drained as an abort error; it is released.
		const result = await abortedWaiting;
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /aborted/);
		assert.equal(aborted.activeQuery, null);

		// The next query is untouched and still the live context.
		assert.equal(ctx(), next);
		assert.equal(next.pendingToolCalls.size, 1);
		assert.notEqual(next.activeQuery, null);
	});
});

describe("teardownQuery shared-record gating (#1001)", () => {
	const parentRecord = () => ({
		sessionId: "parent-session",
		cursor: 40,
		cwd: "/repo",
		conversationFingerprint: "u:aaaaaaaaaaaa|a:bbbbbbbbbbbb",
	});

	beforeEach(() => {
		resetStack();
		__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
	});

	afterEach(() => __testSetBridgeIntegrityState({ sharedSession: null, ui: null }));

	// Simulates a query dying with an unresolved tool call: recorded, a handler
	// still waiting, teardown drains it. This path must not mark the PARENT's
	// record needsRebuild/forceRotate from a detached query.
	const teardownWithUnresolvedCall = async (queryCtx, cause) => {
		const sdkQuery = { id: "sdk-query" };
		queryCtx.activeQuery = sdkQuery;
		queryCtx.recordToolCall("call-1", "bash", { cmd: "ls" });
		const waiting = registerWaitingCall(queryCtx, "call-1", "bash");
		assert.equal(teardownQuery(queryCtx, sdkQuery, cause, "/tmp"), true);
		const result = await waiting;
		assert.equal(result.isError, true);
	};

	it("a detached (foreign one-shot) query's unresolved tool call leaves the parent record untouched", async () => {
		const record = parentRecord();
		__testSetBridgeIntegrityState({ sharedSession: { ...record } });
		const queryCtx = ctx();
		queryCtx.detachedFromSharedSession = true;

		await teardownWithUnresolvedCall(queryCtx, "abort");

		assert.equal(queryCtx.reportedToolResultMismatch, true, "the mismatch is still reported (diagnostics keep flowing)");
		assert.deepEqual(
			__testGetBridgeIntegrityState().sharedSession,
			record,
			"a detached query must never mark the parent record needsRebuild/forceRotate",
		);
	});

	it("an outermost claiming query's unresolved tool call still marks the record for rebuild", async () => {
		__testSetBridgeIntegrityState({ sharedSession: parentRecord() });

		await teardownWithUnresolvedCall(ctx(), "abort");

		const record = __testGetBridgeIntegrityState().sharedSession;
		assert.equal(record.needsRebuild, true);
		assert.equal(record.forceRotate, true, "an abnormal teardown still rotates the claiming query's session id");
	});
});
