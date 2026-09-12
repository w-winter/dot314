// Must load before any bridge module: diag assertions need the debug flag
// set when src/debug.ts is evaluated.
import "./lib/debug-env.mjs";

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { QueryContext } from "../src/query-state.js";
import { __testGetBridgeIntegrityState, __testSetBridgeIntegrityState, INTEGRITY_CUSTOM_TYPE, appendIntegrityEntry, reapStaleQueuedResults, reportToolResultMismatch } from "../src/index.js";
import { setExtensionApi } from "../src/bridge-state.js";

let dir;
let diagPath;
let notifications;

function makeMismatchContext() {
	const queryCtx = new QueryContext();
	queryCtx.activeQuery = { id: "query" };
	queryCtx.recordToolCall("t0", "read", { path: "safe.txt" });
	queryCtx.recordToolCall("t1", "bash", { command: "echo should-not-leak" });
	queryCtx.markToolResultDelivered("t0");
	queryCtx.markToolResultResolved("t0");
	queryCtx.markToolResultDelivered("t1");
	queryCtx.pendingResults.set("t1", { toolCallId: "t1", content: [{ type: "text", text: "queued" }] });
	return queryCtx;
}

function readDiagEntries() {
	return readFileSync(diagPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

describe("tool-result integrity reporting", () => {
	beforeEach(() => {
		dir = mkdtempSync("/tmp/claude-bridge-integrity-");
		diagPath = join(dir, "diag.log");
		process.env.CLAUDE_BRIDGE_DIAG_PATH = diagPath;
		notifications = [];
		__testSetBridgeIntegrityState({
			ui: { notify: (message, level) => notifications.push({ message, level }) },
			sharedSession: { sessionId: "session-12345678", cursor: 4, cwd: "/repo" },
		});
	});

	afterEach(() => {
		__testSetBridgeIntegrityState({ ui: null, sharedSession: null });
		delete process.env.CLAUDE_BRIDGE_DIAG_PATH;
		rmSync(dir, { recursive: true, force: true });
	});

	it("query teardown emits one diagnostic, notifies, and marks rebuild without forceRotate", () => {
		const reported = reportToolResultMismatch(makeMismatchContext(), "query teardown", "/repo");

		assert.equal(reported, true);
		assert.equal(notifications.length, 1);
		assert.equal(notifications[0].level, "error");
		assert.match(notifications[0].message, /delivered 2\/2, resolved 1\/2/);
		// with DEBUG on the diag log is real, so the toast points at
		// it — and not at the DEBUG-off guidance to re-run with the env var.
		assert.ok(notifications[0].message.includes(`see ${diagPath}`), "DEBUG-on toast points at the diag log");
		assert.ok(!notifications[0].message.includes("CLAUDE_BRIDGE_DEBUG=1"), "no env-var guidance when the log exists");
		const entries = readDiagEntries();
		assert.equal(entries.length, 1);
		assert.equal(entries[0].label, "tool_result_delivery_mismatch");
		assert.equal(entries[0].progress.expectedCount, 2);
		assert.deepEqual(entries[0].progress.queuedIds, ["t1"]);
		assert.equal(JSON.stringify(entries[0]).includes("should-not-leak"), false);
		assert.equal(statSync(diagPath).mode & 0o777, 0o600);
		const { sharedSession } = __testGetBridgeIntegrityState();
		assert.equal(sharedSession.needsRebuild, true);
		assert.equal(sharedSession.forceRotate, undefined);
	});

	it("expected abort teardown marks forceRotate without raising an integrity error", () => {
		const queryCtx = makeMismatchContext();
		const options = { expectedInterruption: true, forceRotate: true };
		assert.equal(reportToolResultMismatch(queryCtx, "abort", "/repo", options), true);
		assert.equal(reportToolResultMismatch(queryCtx, "abort", "/repo", options), false);

		assert.equal(statSync(diagPath, { throwIfNoEntry: false }), undefined);
		assert.equal(notifications.length, 0);
		const { sharedSession } = __testGetBridgeIntegrityState();
		assert.equal(sharedSession.needsRebuild, true);
		assert.equal(sharedSession.forceRotate, true);
	});

	it("unexpected interruptions still report loudly with forceRotate", () => {
		const queryCtx = makeMismatchContext();
		assert.equal(reportToolResultMismatch(queryCtx, "stream idle timeout", "/repo", { forceRotate: true }), true);

		assert.equal(readDiagEntries().length, 1);
		assert.equal(notifications.length, 1);
		const { sharedSession } = __testGetBridgeIntegrityState();
		assert.equal(sharedSession.needsRebuild, true);
		assert.equal(sharedSession.forceRotate, true);
	});

	it("notification failure does not throw or skip rebuild marking", () => {
		__testSetBridgeIntegrityState({
			ui: { notify: () => { throw new Error("notify failed"); } },
			sharedSession: { sessionId: "session-12345678", cursor: 4, cwd: "/repo" },
		});

		assert.doesNotThrow(() => reportToolResultMismatch(makeMismatchContext(), "query teardown", "/repo"));
		assert.equal(readDiagEntries().length, 1);
		assert.equal(__testGetBridgeIntegrityState().sharedSession.needsRebuild, true);
	});
});

describe("integrity entries persisted to the pi session", () => {
	let sessionEntries;

	beforeEach(() => {
		dir = mkdtempSync("/tmp/claude-bridge-integrity-");
		diagPath = join(dir, "diag.log");
		process.env.CLAUDE_BRIDGE_DIAG_PATH = diagPath;
		notifications = [];
		sessionEntries = [];
		__testSetBridgeIntegrityState({
			ui: { notify: (message, level) => notifications.push({ message, level }) },
			sharedSession: { sessionId: "session-12345678", cursor: 4, cwd: "/repo" },
		});
		setExtensionApi({ appendEntry: (customType, data) => sessionEntries.push({ customType, data }) });
	});

	afterEach(() => {
		setExtensionApi(undefined);
		__testSetBridgeIntegrityState({ ui: null, sharedSession: null });
		delete process.env.CLAUDE_BRIDGE_DIAG_PATH;
		rmSync(dir, { recursive: true, force: true });
	});

	it("a mismatch report is persisted as a claude-bridge-integrity entry", () => {
		reportToolResultMismatch(makeMismatchContext(), "query teardown", "/repo");

		assert.equal(sessionEntries.length, 1);
		assert.equal(sessionEntries[0].customType, INTEGRITY_CUSTOM_TYPE);
		assert.equal(sessionEntries[0].data.label, "tool_result_delivery_mismatch");
		assert.deepEqual(sessionEntries[0].data.queuedIds, ["t1"]);
		assert.deepEqual(sessionEntries[0].data.toolNames, [{ name: "bash", count: 1 }]);
		assert.equal(JSON.stringify(sessionEntries[0]).includes("should-not-leak"), false, "never tool arguments or output");
	});

	it("appendIntegrityEntry reports false when no pi session exists and never throws", () => {
		setExtensionApi(undefined);
		assert.equal(appendIntegrityEntry("anything", { count: 1 }), false);
		setExtensionApi({ appendEntry: () => { throw new Error("append failed"); } });
		assert.doesNotThrow(() => appendIntegrityEntry("anything", { count: 1 }));
		assert.equal(appendIntegrityEntry("anything", { count: 1 }), false);
	});

	it("reaping stale queued results parks them consumably, diags, notifies, and persists", () => {
		const queryCtx = new QueryContext();
		queryCtx.recordToolCall("bash-lost", "bash", { command: "echo should-not-leak" });
		queryCtx.pendingResults.set("bash-lost", { toolCallId: "bash-lost", content: [{ type: "text", text: "should-not-leak" }] });
		queryCtx.resetToolTracking();

		reapStaleQueuedResults(queryCtx);

		assert.equal(queryCtx.pendingResults.size, 0);
		// Parked, not destroyed: a handler firing after the boundary still gets
		// its real result.
		assert.equal(queryCtx.reapedResults.size, 1);
		assert.equal(queryCtx.reapedResults.get("bash-lost").content[0].text, "should-not-leak");
		const diag = readDiagEntries();
		assert.equal(diag.length, 1);
		assert.equal(diag[0].label, "stale_queued_tool_results_parked");
		assert.deepEqual(diag[0].stale, [{ id: "bash-lost", toolName: "bash" }]);
		assert.equal(sessionEntries.length, 1);
		assert.equal(sessionEntries[0].data.label, "stale_queued_tool_results_parked");
		assert.equal(notifications.length, 1);
		assert.equal(notifications[0].level, "warning");
		assert.match(notifications[0].message, /bash/);
		assert.equal(JSON.stringify(diag).includes("should-not-leak"), false, "diag never carries tool output");
		assert.equal(JSON.stringify(sessionEntries).includes("should-not-leak"), false, "session entry never carries tool output");
	});

	it("reaping nothing appends nothing", () => {
		reapStaleQueuedResults(new QueryContext());
		assert.equal(sessionEntries.length, 0);
		assert.equal(notifications.length, 0);
	});
});
