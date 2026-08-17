import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
    fingerprintPortableChunk,
    type PortableSummaryRecordV1,
} from "./portable-record.ts";
import { describePortableSummaryForDisplay } from "./portable-summary-renderer.ts";

const HASH = "a".repeat(64);

function summaryRecord(overrides: Partial<PortableSummaryRecordV1> = {}): PortableSummaryRecordV1 {
    return {
        kind: "codex-compaction-coordinator:portable-summary",
        version: 1,
        recordId: "00000000-0000-4000-8000-000000000001",
        predecessor: { kind: "branch-root", coverageFingerprint: HASH },
        checkpoint: {
            entryId: "checkpoint",
            storage: "pi-compaction",
            modelKey: "openai-codex:openai-codex-responses:gpt-test",
            checkpointFingerprint: HASH,
        },
        range: {
            firstEntryId: "first",
            lastEntryId: "last",
            entryCount: 2,
            entriesFingerprint: HASH,
            transcriptLength: 6,
            transcriptFingerprint: HASH,
        },
        state: "complete",
        endOffset: 6,
        coverageFingerprint: HASH,
        summary: "Portable plaintext summary",
        step: {
            kind: "summary-call",
            startOffset: 0,
            chunkFingerprint: fingerprintPortableChunk("source"),
            summarizer: {
                provider: "anthropic",
                api: "anthropic-messages",
                modelId: "claude-test",
                thinkingLevel: "low",
                contextWindow: 200_000,
                maxOutputTokens: 8_192,
                promptFingerprint: HASH,
            },
            usage: null,
        },
        ...overrides,
    };
}

describe("portable summary entry display", () => {
    it("describes a complete model-generated summary", () => {
        assert.deepEqual(describePortableSummaryForDisplay(summaryRecord()), {
            summary: "Portable plaintext summary",
            entryCount: 2,
            provider: "anthropic",
            modelId: "claude-test",
        });
    });

    it("hides partial records", () => {
        assert.equal(describePortableSummaryForDisplay(summaryRecord({
            state: "partial",
            endOffset: 3,
        })), undefined);
    });

    it("hides carry-forward records and malformed data", () => {
        assert.equal(describePortableSummaryForDisplay(summaryRecord({
            range: {
                firstEntryId: null,
                lastEntryId: null,
                entryCount: 0,
                entriesFingerprint: HASH,
                transcriptLength: 0,
                transcriptFingerprint: HASH,
            },
            endOffset: 0,
            step: {
                kind: "carry-forward",
                startOffset: 0,
                chunkFingerprint: fingerprintPortableChunk(""),
            },
        })), undefined);
        assert.equal(describePortableSummaryForDisplay({ version: 99 }), undefined);
    });
});
