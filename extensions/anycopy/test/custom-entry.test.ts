import assert from "node:assert/strict";
import test from "node:test";
import { formatCustomEntryContent, formatCustomEntryPreview } from "../custom-entry.ts";

test("formatCustomEntryContent includes persisted object data", () => {
	assert.equal(
		formatCustomEntryContent("system-prompt-request-evidence", {
			requestId: "req-1",
			accepted: true,
		}),
		"Custom entry: system-prompt-request-evidence\n\nRequest id: req-1\nAccepted: true",
	);
});

test("formatCustomEntryContent preserves string data", () => {
	assert.equal(formatCustomEntryContent("note", "body"), "Custom entry: note\n\nbody");
});

test("formatCustomEntryContent keeps a useful fallback when data is absent", () => {
	assert.equal(formatCustomEntryContent("marker", undefined), "Custom entry: marker");
});

test("formatCustomEntryContent keeps lowercase at suffixes numeric", () => {
	assert.equal(
		formatCustomEntryContent("metrics", { stat: 42, format: 7 }),
		"Custom entry: metrics\n\nStat: 42\nFormat: 7",
	);
});

test("formatCustomEntryPreview renders structured evidence in local time as readable markdown", () => {
	const previousTimeZone = process.env.TZ;
	process.env.TZ = "Europe/Moscow";
	try {
		const preview = formatCustomEntryPreview("system-prompt-request-evidence", {
			capturedAt: 1786757631626,
			promptKind: "coordinator",
			chars: 44823,
			contextFiles: [{ path: "/home/adams/.pi/agent/AGENTS.md", chars: 1309 }],
			provenance: { capture: "before_provider_request" },
		});

		assert.match(preview, /^\*\*Custom entry:\*\* `system-prompt-request-evidence`/);
		assert.match(preview, /\*\*Captured at:\*\* 15 Aug 2026, 04:33:51 GMT\+3/);
		assert.match(preview, /\*\*Characters:\*\* 44,823/);
		assert.match(preview, /\*\*Context files \(1\)\*\*/);
		assert.match(preview, /1\. \/home\/adams\/\.pi\/agent\/AGENTS\.md/);
		assert.doesNotMatch(preview, /\n\s*1\.\s*\n/);
		assert.match(preview, /\*\*Provenance\*\*/);
	} finally {
		if (previousTimeZone === undefined) delete process.env.TZ;
		else process.env.TZ = previousTimeZone;
	}
});
