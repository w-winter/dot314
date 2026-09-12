/**
 * Tests for shouldRestorePersistedBridgeEntry.
 *
 * The guard exists to keep forks from inheriting the parent's pointer at the
 * parent's external Claude jsonl. When pi forks a session, createBranchedSession
 * duplicates every non-label entry (including our claude-bridge-session markers)
 * from root→leaf into the fork pi.jsonl. The guard rejects markers whose
 * piSessionId or cwd does not match the active session, forcing the bridge
 * down the rebuild path instead.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldRestorePersistedBridgeEntry } from "../src/index.ts";

const ENTRY = (overrides = {}) => ({
	sessionId: "claude-abc",
	cursor: 12,
	cwd: "/repo",
	piSessionId: "pi-A",
	fingerprint: "deadbeef",
	updatedAt: "2026-01-01T00:00:00Z",
	...overrides,
});

describe("shouldRestorePersistedBridgeEntry", () => {
	it("accepts an entry whose piSessionId and cwd match the active session", () => {
		assert.equal(shouldRestorePersistedBridgeEntry(ENTRY(), "pi-A", "/repo"), undefined);
	});

	it("rejects entries copied across pi sessions (the fork case)", () => {
		const reason = shouldRestorePersistedBridgeEntry(ENTRY({ piSessionId: "pi-PARENT" }), "pi-FORK", "/repo");
		assert.match(reason ?? "", /piSessionId mismatch/);
	});

	it("rejects legacy entries that predate piSessionId tagging", () => {
		const reason = shouldRestorePersistedBridgeEntry(ENTRY({ piSessionId: undefined }), "pi-A", "/repo");
		assert.match(reason ?? "", /missing piSessionId/);
	});

	it("rejects entries whose cwd no longer matches", () => {
		const reason = shouldRestorePersistedBridgeEntry(ENTRY({ cwd: "/old" }), "pi-A", "/new");
		assert.match(reason ?? "", /cwd mismatch/);
	});

	it("accepts when current cwd is unknown (older host plumbing)", () => {
		assert.equal(shouldRestorePersistedBridgeEntry(ENTRY(), "pi-A", undefined), undefined);
	});

	it("accepts when current piSessionId is unknown but the entry has one", () => {
		// Without a current id we cannot prove a mismatch; the fingerprint check
		// downstream will catch most divergences. Accepting here matches the
		// defensive 'when in doubt let downstream filter' policy.
		assert.equal(shouldRestorePersistedBridgeEntry(ENTRY(), undefined, "/repo"), undefined);
	});
});
