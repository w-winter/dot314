import assert from "node:assert/strict";
import test from "node:test";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { formatCompactTimestamp, getEntryTimestampMs } from "../timestamps.ts";

const createMessageEntry = (overrides: {
	baseTimestamp?: string;
	messageTimestamp?: unknown;
} = {}): SessionEntry => ({
	type: "message",
	id: "message-entry",
	parentId: null,
	timestamp: overrides.baseTimestamp ?? "2026-05-15T10:00:00.000Z",
	message: { role: "user", content: "hello", timestamp: overrides.messageTimestamp },
});

const createCustomEntry = (timestamp: string, data: Record<string, unknown> = {}): SessionEntry => ({
	type: "custom",
	customType: "example",
	data,
	id: "custom-entry",
	parentId: null,
	timestamp,
});

const NOW_MS = new Date(2026, 4, 15, 12, 0).getTime();

test("getEntryTimestampMs prefers finite message timestamps", () => {
	const messageTimestamp = new Date("2026-05-16T12:00:00.000Z").getTime();
	const baseTimestamp = "2026-05-15T10:00:00.000Z";

	assert.equal(
		getEntryTimestampMs(createMessageEntry({ baseTimestamp, messageTimestamp })),
		messageTimestamp,
	);
});

test("getEntryTimestampMs falls back to base message timestamps for invalid nested values", () => {
	const baseTimestamp = "2026-05-15T10:00:00.000Z";
	const baseTimestampMs = Date.parse(baseTimestamp);

	for (const messageTimestamp of [
		undefined,
		"2026-05-16T12:00:00.000Z",
		Number.NaN,
		Infinity,
		-Infinity,
	]) {
		assert.equal(
			getEntryTimestampMs(createMessageEntry({ baseTimestamp, messageTimestamp })),
			baseTimestampMs,
		);
	}
});

test("getEntryTimestampMs uses base timestamps for non-message entries", () => {
	const baseTimestamp = "2026-05-15T10:00:00.000Z";
	const nestedTimestamp = new Date("2026-05-16T12:00:00.000Z").getTime();

	assert.equal(
		getEntryTimestampMs(createCustomEntry(baseTimestamp, { message: { timestamp: nestedTimestamp } })),
		Date.parse(baseTimestamp),
	);
});

test("getEntryTimestampMs returns null for invalid base timestamps", () => {
	assert.equal(
		getEntryTimestampMs(createMessageEntry({ baseTimestamp: "not a timestamp" })),
		null,
	);
	assert.equal(getEntryTimestampMs(createCustomEntry("not a timestamp")), null);
});

test("formatCompactTimestamp returns HH:MM for same-day timestamps", () => {
	const sameDayTimestamp = new Date(2026, 4, 15, 3, 4).getTime();

	assert.equal(formatCompactTimestamp(sameDayTimestamp, NOW_MS), "03:04");
});

test("formatCompactTimestamp returns M/D HH:MM for same-year timestamps", () => {
	const timestamp = new Date(2026, 0, 2, 3, 4).getTime();

	assert.equal(formatCompactTimestamp(timestamp, NOW_MS), "1/2 03:04");
});

test("formatCompactTimestamp returns YY/M/D HH:MM for different-year timestamps", () => {
	const timestamp = new Date(2025, 0, 2, 3, 4).getTime();

	assert.equal(formatCompactTimestamp(timestamp, NOW_MS), "25/1/2 03:04");
});
