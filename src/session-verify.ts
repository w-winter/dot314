// Pure session-file integrity check. Returns an array of warning strings;
// callers decide how to surface them (debug log, piUI, diagDump, etc.).
// Extracted from index.ts so tests can import without activating the extension.

import { closeSync, openSync, readSync, statSync } from "fs";
import { StringDecoder } from "node:string_decoder";

interface JsonlSummary {
	count: number;
	firstLine?: string;
	lastLine?: string;
}

function forEachJsonlLine(path: string, onLine: (line: string) => void): void {
	const fd = openSync(path, "r");
	const buffer = Buffer.allocUnsafe(64 * 1024);
	const decoder = new StringDecoder("utf8");
	let pending = "";
	try {
		for (;;) {
			const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;
			pending += decoder.write(buffer.subarray(0, bytesRead));
			let start = 0;
			for (;;) {
				const newline = pending.indexOf("\n", start);
				if (newline < 0) {
					pending = pending.slice(start);
					break;
				}
				const line = pending.slice(start, newline);
				onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
				start = newline + 1;
			}
		}
		pending += decoder.end();
		if (pending.length > 0) onLine(pending.endsWith("\r") ? pending.slice(0, -1) : pending);
	} finally {
		closeSync(fd);
	}
}

function summarizeJsonl(path: string): JsonlSummary {
	const summary: JsonlSummary = { count: 0 };
	forEachJsonlLine(path, (line) => {
		if (!line.trim()) return;
		summary.count += 1;
		if (summary.firstLine === undefined) summary.firstLine = line;
		summary.lastLine = line;
	});
	return summary;
}

export function verifyWrittenSession(jsonlPath: string, expectedSessionId: string, expectedRecordCount: number): string[] {
	const warnings = [];
	let st;
	try {
		st = statSync(jsonlPath);
	} catch (e) {
		warnings.push(`file missing after save — path=${jsonlPath} err=${e.message}`);
		return warnings;
	}
	let summary;
	try {
		summary = summarizeJsonl(jsonlPath);
	} catch (e) {
		warnings.push(`file unreadable — path=${jsonlPath} size=${st.size} err=${e.message}`);
		return warnings;
	}
	if (summary.count !== expectedRecordCount) {
		warnings.push(`record count mismatch — expected=${expectedRecordCount} actual=${summary.count} path=${jsonlPath} bytes=${st.size}`);
		return warnings;
	}
	try {
		const firstRec = JSON.parse(summary.firstLine ?? "");
		const lastRec = JSON.parse(summary.lastLine ?? "");
		if (firstRec.sessionId !== expectedSessionId || lastRec.sessionId !== expectedSessionId) {
			warnings.push(`sessionId drift — expected=${expectedSessionId} first=${firstRec.sessionId} last=${lastRec.sessionId}`);
		}
	} catch (e) {
		warnings.push(`malformed JSONL — path=${jsonlPath} err=${e.message}`);
	}
	return warnings;
}
