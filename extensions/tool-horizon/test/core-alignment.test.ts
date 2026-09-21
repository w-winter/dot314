import assert from "node:assert/strict";
import test from "node:test";

import type { SystemMessage } from "@earendil-works/pi-ai";

import {
	adaptSessionEntryProjection,
	alignContextMessageEntriesExactly,
	buildContextMessageEntries,
	collectCompactedAwayMessages,
	matchContextMessageEntryPrefix,
	type EventMessage,
	type SessionEntry,
} from "../core.ts";

const TIMESTAMP = "2026-07-29T00:00:00.000Z";

function messageEntry(id: string, message: Record<string, unknown>, parentId: string | null = null): SessionEntry {
	return { id, parentId, type: "message", timestamp: TIMESTAMP, message } as unknown as SessionEntry;
}

function customMessageEntry(
	id: string,
	customType: string,
	content: unknown,
	parentId: string | null = null,
): SessionEntry {
	return { id, parentId, type: "custom_message", timestamp: TIMESTAMP, customType, content } as unknown as SessionEntry;
}

function customEntry(id: string, parentId: string | null = null): SessionEntry {
	return { id, parentId, type: "custom", timestamp: TIMESTAMP, customType: "state", data: {} } as unknown as SessionEntry;
}

function compactionEntry(
	id: string,
	firstKeptEntryId: string,
	parentId: string | null = null,
	systemMessage?: SystemMessage,
): SessionEntry {
	const entry: Extract<SessionEntry, { type: "compaction" }> = {
		id,
		parentId,
		type: "compaction",
		timestamp: TIMESTAMP,
		summary: `${id} summary`,
		tokensBefore: 1234,
		firstKeptEntryId,
	};
	if (systemMessage !== undefined) entry.systemMessage = systemMessage;
	return entry;
}

function linearBranch(...entries: SessionEntry[]): SessionEntry[] {
	return entries.map((entry, index) => ({
		...entry,
		parentId: index > 0 ? entries[index - 1].id : null,
	})) as SessionEntry[];
}

function leafId(entries: SessionEntry[]): string | null {
	return entries.at(-1)?.id ?? null;
}

function project(entries: SessionEntry[], selectedLeafId: string | null = leafId(entries)) {
	return buildContextMessageEntries(entries, selectedLeafId);
}

function payloadOf(entries: SessionEntry[], selectedLeafId: string | null = leafId(entries)): EventMessage[] {
	return project(entries, selectedLeafId).map((entry) => entry.message);
}

function userMessage(text: string): Record<string, unknown> {
	return { role: "user", content: [{ type: "text", text }] };
}

function assistantMessage(text: string): Record<string, unknown> {
	return { role: "assistant", content: [{ type: "text", text }] };
}

test("test_public_context_projection_normalizes_null_message_content", () => {
	for (const role of ["user", "assistant", "toolResult"]) {
		const branch = linearBranch(messageEntry(`m-${role}`, { role, content: null }));
		assert.deepEqual(project(branch)[0]?.message.content, [], `expected normalized content for role ${role}`);
	}

	const missingBranch = linearBranch(messageEntry("m-missing", { role: "user" }));
	assert.deepEqual(project(missingBranch)[0]?.message.content, []);
});

test("test_public_context_projection_preserves_non_null_content_and_other_roles", () => {
	const content = [{ type: "text", text: "hello" }];
	const userBranch = linearBranch(messageEntry("m1", { role: "user", content }));
	const otherBranch = linearBranch(messageEntry("m2", { role: "bashExecution", content: null }));

	assert.deepEqual(project(userBranch)[0]?.message.content, content);
	assert.equal(project(otherBranch)[0]?.message.content, null);
});

test("test_public_context_projection_normalizes_absent_custom_message_content", () => {
	const branch = linearBranch(customMessageEntry("c1", "checkpoint", undefined));
	const projected = project(branch);

	assert.equal(projected[0]?.sourceType, "custom_message");
	assert.deepEqual(projected[0]?.message.content, []);
});

test("test_context_projection_adapter_accepts_zero_message_projection", () => {
	assert.deepEqual(adaptSessionEntryProjection(customEntry("state"), []), []);
});

test("test_context_projection_adapter_preserves_multiple_messages_for_one_entry", () => {
	const entry = messageEntry("multi", userMessage("source"));
	const projected = adaptSessionEntryProjection(entry, [
		{ role: "user", content: [{ type: "text", text: "one" }] },
		{ role: "user", content: [{ type: "text", text: "two" }] },
	]);

	assert.deepEqual(projected.map((item) => item.id), ["multi", "multi"]);
	assert.deepEqual(projected.map((item) => item.message.content), [
		[{ type: "text", text: "one" }],
		[{ type: "text", text: "two" }],
	]);
});

test("test_build_context_message_entries_follows_explicit_parent_linked_leaf", () => {
	const root = messageEntry("root", userMessage("root"));
	const left = messageEntry("left", assistantMessage("left"), "root");
	const right = messageEntry("right", assistantMessage("right"), "root");
	const entries = [root, left, right];

	assert.deepEqual(project(entries, "right").map((entry) => entry.id), ["root", "right"]);
	assert.deepEqual(payloadOf(entries, "right").map((message) => message.content), [
		[{ type: "text", text: "root" }],
		[{ type: "text", text: "right" }],
	]);
});

test("test_match_context_message_entry_prefix_maps_exact_entries_in_order", () => {
	const branch = linearBranch(messageEntry("e1", userMessage("one")), messageEntry("e2", assistantMessage("two")));
	const result = matchContextMessageEntryPrefix(project(branch), payloadOf(branch));

	assert.ok(!("kind" in result));
	assert.equal(result.entryIdToRawPayloadIndex.get("e1"), 0);
	assert.equal(result.entryIdToRawPayloadIndex.get("e2"), 1);
	assert.equal(result.nextRawPayloadIndex, 2);
	assert.equal(result.remainingContextEntryIndex, 2);
	assert.deepEqual(result.skippedCustomMessageEntryIds, []);
});

test("test_match_context_message_entry_prefix_skips_unmatched_custom_messages", () => {
	const required = linearBranch(messageEntry("e1", userMessage("one")), messageEntry("e2", assistantMessage("two")));
	const branch = linearBranch(
		customMessageEntry("c0", "checkpoint", "leading"),
		messageEntry("e1", userMessage("one")),
		customMessageEntry("c1", "checkpoint", "middle"),
		messageEntry("e2", assistantMessage("two")),
	);
	const result = matchContextMessageEntryPrefix(project(branch), payloadOf(required));

	if ("kind" in result) throw new Error("unexpected alignment error");
	assert.equal(result.entryIdToRawPayloadIndex.get("e1"), 0);
	assert.equal(result.entryIdToRawPayloadIndex.get("e2"), 1);
	assert.deepEqual(result.skippedCustomMessageEntryIds, ["c0", "c1"]);
	assert.equal(result.nextRawPayloadIndex, 2);
});

test("test_match_context_message_entry_prefix_rejects_non_custom_mismatch", () => {
	const branch = linearBranch(messageEntry("e1", userMessage("one")), messageEntry("e2", assistantMessage("two")));
	const payloadBranch = linearBranch(
		messageEntry("e1", userMessage("one")),
		messageEntry("e2", assistantMessage("DIFFERENT")),
	);
	const result = matchContextMessageEntryPrefix(project(branch), payloadOf(payloadBranch));

	assert.ok("kind" in result);
	assert.equal(result.contextEntryIndex, 1);
	assert.equal(result.rawPayloadIndex, 1);
	assert.equal(result.sourceType, "message");
	assert.ok(result.mismatchFields.includes("text"));
});

test("test_align_context_message_entries_exactly_rejects_unconsumed_raw_payload", () => {
	const branch = linearBranch(messageEntry("e1", userMessage("one")));
	const payloadBranch = linearBranch(
		messageEntry("e1", userMessage("one")),
		messageEntry("e2", assistantMessage("extra")),
	);
	const result = alignContextMessageEntriesExactly(project(branch), payloadOf(payloadBranch));

	assert.ok(!(result instanceof Map));
	if (result instanceof Map) throw new Error("expected failure");
	assert.equal(result.kind, "unconsumed-raw-payload");
	assert.equal(result.firstUnmatchedRawPayloadIndex, 1);
	assert.equal(result.rawPayloadLength, 2);
});

test("test_align_context_message_entries_exactly_rejects_remaining_non_custom_entries", () => {
	const branch = linearBranch(messageEntry("e1", userMessage("one")), messageEntry("e2", assistantMessage("two")));
	const payloadBranch = linearBranch(messageEntry("e1", userMessage("one")));
	const result = alignContextMessageEntriesExactly(project(branch), payloadOf(payloadBranch));

	if (result instanceof Map) throw new Error("expected failure");
	assert.equal(result.kind, "remaining-context-entries");
	assert.equal(result.firstRemainingContextEntryIndex, 1);
	assert.deepEqual(result.remainingNonCustomEntryIds, ["e2"]);
});

test("test_align_context_message_entries_exactly_allows_trailing_custom_messages", () => {
	const required = linearBranch(messageEntry("e1", userMessage("one")));
	const branch = linearBranch(
		messageEntry("e1", userMessage("one")),
		customMessageEntry("c1", "checkpoint", "trailing"),
	);
	const result = alignContextMessageEntriesExactly(project(branch), payloadOf(required));

	assert.ok(result instanceof Map);
	if (!(result instanceof Map)) throw new Error("expected success");
	assert.equal(result.get("e1"), 0);
	assert.equal(result.has("c1"), false);
});

test("test_match_context_message_entry_prefix_maps_duplicate_looking_messages_sequentially", () => {
	const branch = linearBranch(
		messageEntry("dup-a", userMessage("same text")),
		messageEntry("dup-b", userMessage("same text")),
	);
	const result = matchContextMessageEntryPrefix(project(branch), payloadOf(branch));

	if ("kind" in result) throw new Error("unexpected alignment error");
	assert.equal(result.entryIdToRawPayloadIndex.get("dup-a"), 0);
	assert.equal(result.entryIdToRawPayloadIndex.get("dup-b"), 1);
});

test("test_align_context_message_entries_exactly_maps_compaction_entry", () => {
	const branch = linearBranch(
		messageEntry("dropped", userMessage("before firstKept")),
		messageEntry("kept", userMessage("kept message")),
		compactionEntry("comp-1", "kept"),
		messageEntry("after", assistantMessage("after compaction")),
	);
	const contextEntries = project(branch);
	const result = alignContextMessageEntriesExactly(contextEntries, contextEntries.map((entry) => entry.message));

	if (!(result instanceof Map)) throw new Error("expected success");
	assert.equal(result.get("comp-1"), 0, "compaction summary occupies the first payload slot");
	assert.equal(result.get("kept"), 1);
	assert.equal(result.get("after"), 2);
	assert.equal(result.has("dropped"), false, "entries before firstKeptEntryId are not in the payload");
});

test("test_align_context_message_entries_exactly_maps_compaction_system_state_to_its_summary_boundary", () => {
	const systemMessage = {
		role: "system",
		content: "Project instructions",
		toolsAdded: [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
		timestamp: 0,
	};
	const branch = linearBranch(
		messageEntry("kept", userMessage("kept message")),
		compactionEntry("comp-1", "kept", null, systemMessage),
		messageEntry("after", assistantMessage("after compaction")),
	);
	const contextEntries = project(branch);
	const result = alignContextMessageEntriesExactly(contextEntries, contextEntries.map((entry) => entry.message));

	if (!(result instanceof Map)) throw new Error("expected success");
	assert.deepEqual(contextEntries.slice(0, 2).map((entry) => entry.message.role), ["system", "compactionSummary"]);
	assert.equal(result.get("comp-1"), 1, "the compaction boundary maps to its summary, not its system snapshot");
	assert.equal(result.get("kept"), 2);
	assert.equal(result.get("after"), 3);
});

test("test_align_context_message_entries_exactly_succeeds_on_branch_derived_payload", () => {
	const branch = linearBranch(
		messageEntry("e1", userMessage("hello")),
		messageEntry("e2", { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }] }),
		messageEntry("e3", { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "file body" }] }),
		messageEntry("e4", assistantMessage("done")),
	);
	const result = alignContextMessageEntriesExactly(project(branch), payloadOf(branch));

	if (!(result instanceof Map)) throw new Error("expected success");
	assert.deepEqual([...result.entries()], [["e1", 0], ["e2", 1], ["e3", 2], ["e4", 3]]);
});

test("test_collect_compacted_away_messages_uses_latest_compaction", () => {
	const branch = linearBranch(
		messageEntry("e1", userMessage("first")),
		messageEntry("e2", userMessage("second")),
		compactionEntry("c1", "e2"),
		messageEntry("e3", userMessage("third")),
		compactionEntry("c2", "e3"),
		messageEntry("e4", userMessage("fourth")),
	);

	assert.deepEqual(collectCompactedAwayMessages(branch, "e4").map((message) => message.content), [
		[{ type: "text", text: "first" }],
		[{ type: "text", text: "second" }],
	]);
});

test("test_collect_compacted_away_messages_omits_zero_projection_entries", () => {
	const branch = linearBranch(
		messageEntry("early", userMessage("early")),
		customEntry("state"),
		messageEntry("kept", userMessage("kept")),
		compactionEntry("compaction", "kept"),
	);

	assert.deepEqual(collectCompactedAwayMessages(branch, "compaction").map((message) => message.content), [
		[{ type: "text", text: "early" }],
	]);
});
