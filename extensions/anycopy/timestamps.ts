import type { SessionEntry } from "@earendil-works/pi-coding-agent";

const padTwoDigits = (value: number): string => value.toString().padStart(2, "0");

const parseBaseTimestamp = (entry: SessionEntry): number | null => {
	const timestampMs = Date.parse(entry.timestamp);
	return Number.isFinite(timestampMs) ? timestampMs : null;
};

export const getEntryTimestampMs = (entry: SessionEntry): number | null => {
	if (entry.type !== "message") return parseBaseTimestamp(entry);

	const timestamp = (entry.message as { timestamp?: unknown }).timestamp;
	if (typeof timestamp === "number" && Number.isFinite(timestamp)) return timestamp;

	return parseBaseTimestamp(entry);
};

export const formatCompactTimestamp = (timestampMs: number, nowMs: number = Date.now()): string => {
	const timestampDate = new Date(timestampMs);
	const now = new Date(nowMs);
	const time = `${padTwoDigits(timestampDate.getHours())}:${padTwoDigits(timestampDate.getMinutes())}`;

	const sameYear = timestampDate.getFullYear() === now.getFullYear();
	const sameDay =
		sameYear && timestampDate.getMonth() === now.getMonth() && timestampDate.getDate() === now.getDate();

	if (sameDay) return time;

	const monthAndDay = `${timestampDate.getMonth() + 1}/${timestampDate.getDate()}`;
	if (sameYear) return `${monthAndDay} ${time}`;

	return `${padTwoDigits(timestampDate.getFullYear() % 100)}/${monthAndDay} ${time}`;
};
