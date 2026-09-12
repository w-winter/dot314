/**
 * Tests for session integrity helpers:
 *   - repairToolPairing (from cc-session-io): pairs orphan tool_use blocks
 *     with synthetic tool_result so imported history never starts mid-turn.
 *   - verifyWrittenSession (from session-verify.js): warns if the JSONL file
 *     doesn't round-trip (missing file, record-count mismatch, sessionId drift).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { repairToolPairing } from "cc-session-io";
import { verifyWrittenSession } from "../src/session-verify.js";
import { findUnpairedToolUses, insertLostToolResultPlaceholders, summarizeMissingToolNames } from "../src/tool-pairing-audit.js";

// --- repairToolPairing ---

describe("repairToolPairing", () => {
	it("passes through a paired tool_use/tool_result", () => {
		const msgs = [
			{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "X", input: {} }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
		];
		const repaired = repairToolPairing(msgs);
		assert.equal(repaired.length, msgs.length);
	});

	it("synthesizes a tool_result for an orphan tool_use", () => {
		const msgs = [
			{ role: "assistant", content: [{ type: "tool_use", id: "orphan", name: "X", input: {} }] },
			{ role: "user", content: "next turn" },
		];
		const repaired = repairToolPairing(msgs);
		// Prepends a synthetic tool_result block to the next user message (in-place, same count).
		assert.equal(repaired.length, msgs.length);
		const nextUser = repaired[1];
		assert.equal(nextUser.role, "user");
		assert.ok(Array.isArray(nextUser.content));
		assert.equal(nextUser.content[0].type, "tool_result");
		assert.equal(nextUser.content[0].tool_use_id, "orphan");
		assert.equal(nextUser.content[0].is_error, true);
	});

	it("empty input returns empty", () => {
		assert.deepEqual(repairToolPairing([]), []);
	});
});

describe("tool pairing audit", () => {
	it("detects every tool_use that repairToolPairing would pad with a synthetic result", () => {
		const msgs = [
			{ role: "assistant", content: [
				{ type: "tool_use", id: "ok", name: "Read", input: {} },
				{ type: "tool_use", id: "lost-a", name: "Grep", input: {} },
				{ type: "tool_use", id: "lost-b", name: "Grep", input: {} },
			] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "ok", content: "fine" }] },
		];

		const missing = findUnpairedToolUses(msgs);
		assert.deepEqual(missing.map((item) => item.id), ["lost-a", "lost-b"]);
		assert.deepEqual(summarizeMissingToolNames(missing), [{ name: "Grep", count: 2 }]);
	});

	it("detects a missing result before the next normal user turn", () => {
		const msgs = [
			{ role: "assistant", content: [{ type: "tool_use", id: "orphan", name: "Bash", input: {} }] },
			{ role: "user", content: "next prompt" },
		];

		const missing = findUnpairedToolUses(msgs);
		assert.equal(missing.length, 1);
		assert.equal(missing[0].id, "orphan");
		assert.equal(missing[0].toolName, "Bash");
		assert.equal(missing[0].userIndex, 1);
	});
});

describe("insertLostToolResultPlaceholders", () => {
	it("prepends explicit error results to the following user message", () => {
		const msgs = [
			{ role: "assistant", content: [
				{ type: "tool_use", id: "ok", name: "Read", input: {} },
				{ type: "tool_use", id: "lost", name: "Bash", input: {} },
			] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "ok", content: "fine" }] },
		];

		insertLostToolResultPlaceholders(msgs, findUnpairedToolUses(msgs));

		assert.equal(msgs.length, 2);
		assert.equal(msgs[1].content[0].type, "tool_result");
		assert.equal(msgs[1].content[0].tool_use_id, "lost");
		assert.equal(msgs[1].content[0].is_error, true);
		assert.match(msgs[1].content[0].content, /Treat the call as failed/);
		assert.equal(msgs[1].content[1].tool_use_id, "ok", "real result preserved after placeholders");
		assert.deepEqual(findUnpairedToolUses(msgs), [], "nothing left for repairToolPairing to pad");
	});

	it("wraps a string user message and keeps its text", () => {
		const msgs = [
			{ role: "assistant", content: [{ type: "tool_use", id: "orphan", name: "Bash", input: {} }] },
			{ role: "user", content: "next prompt" },
		];

		insertLostToolResultPlaceholders(msgs, findUnpairedToolUses(msgs));

		assert.equal(msgs[1].content[0].type, "tool_result");
		assert.equal(msgs[1].content[0].tool_use_id, "orphan");
		assert.deepEqual(msgs[1].content[1], { type: "text", text: "next prompt" });
		assert.deepEqual(findUnpairedToolUses(msgs), []);
	});

	it("inserts a new user message when the tool_use is the last message", () => {
		const msgs = [
			{ role: "assistant", content: [{ type: "tool_use", id: "tail", name: "Bash", input: {} }] },
		];

		insertLostToolResultPlaceholders(msgs, findUnpairedToolUses(msgs));

		assert.equal(msgs.length, 2);
		assert.equal(msgs[1].role, "user");
		assert.equal(msgs[1].content[0].tool_use_id, "tail");
		assert.deepEqual(findUnpairedToolUses(msgs), []);
	});

	it("handles several affected assistant messages without index drift", () => {
		const msgs = [
			{ role: "assistant", content: [{ type: "tool_use", id: "a", name: "Bash", input: {} }] },
			{ role: "assistant", content: [{ type: "tool_use", id: "b", name: "Read", input: {} }] },
			{ role: "user", content: "closing prompt" },
		];

		insertLostToolResultPlaceholders(msgs, findUnpairedToolUses(msgs));

		assert.equal(msgs.length, 4);
		assert.equal(msgs[1].role, "user");
		assert.equal(msgs[1].content[0].tool_use_id, "a");
		assert.equal(msgs[3].content[0].tool_use_id, "b");
		assert.deepEqual(findUnpairedToolUses(msgs), []);
	});
});

describe("verifyWrittenSession", () => {
	const dir = mkdtempSync("/tmp/verify-session-");
	const path = join(dir, "session.jsonl");
	const SID = "abc-123";
	const rec = (sessionId, i) => JSON.stringify({ sessionId, idx: i });
	after(() => rmSync(dir, { recursive: true, force: true }));

	it("no warnings when file round-trips correctly", () => {
		writeFileSync(path, [rec(SID, 0), rec(SID, 1), rec(SID, 2)].join("\n") + "\n");
		assert.deepEqual(verifyWrittenSession(path, SID, 3), []);
	});

	it("warns when file is missing", () => {
		const missing = join(dir, "nope.jsonl");
		const warnings = verifyWrittenSession(missing, SID, 0);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /file missing/);
	});

	it("warns on record count mismatch", () => {
		writeFileSync(path, [rec(SID, 0), rec(SID, 1)].join("\n") + "\n");
		const warnings = verifyWrittenSession(path, SID, 5);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /record count mismatch.*expected=5.*actual=2/);
	});

	it("warns on sessionId drift", () => {
		writeFileSync(path, [rec(SID, 0), rec("different-sid", 1)].join("\n") + "\n");
		const warnings = verifyWrittenSession(path, SID, 2);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /sessionId drift/);
	});

	it("warns on malformed JSONL", () => {
		writeFileSync(path, "not json\n");
		const warnings = verifyWrittenSession(path, SID, 1);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /malformed JSONL/);
	});
});
