import assert from "node:assert/strict";
import { mock, test } from "node:test";

import type { Message } from "@earendil-works/pi-ai";
import * as pi from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { describeNativeEpoch } from "./native-checkpoint-source.ts";
import {
    PORTABLE_SUMMARY_CUSTOM_TYPE,
    fingerprintPortableChunk,
    fingerprintPortableCoverage,
    fingerprintPortableTranscript,
    preparePortableSource,
    selectBestPortableChain,
    type PortableRangeIdentity,
} from "./portable-record.ts";

// Model Pi's newer serializer before loading the coordinator that consumes it.
mock.module("@earendil-works/pi-coding-agent", {
    namedExports: {
        ...pi,
        serializeConversation: (messages: Message[]) => pi.serializeConversation(messages.map((message) =>
            message.role === "assistant"
                ? { ...message, content: message.content.filter((block) => block.type !== "thinking") }
                : message)),
    },
});
const coordinator = import("./portability.ts");

const timestamp = "2026-10-31T00:00:00.000Z";
const branch: SessionEntry[] = [
    {
        type: "message", id: "assistant", parentId: null, timestamp,
        message: {
            role: "assistant",
            content: [
                { type: "thinking", thinking: "Inspecting the file" },
                { type: "text", text: "Reading" },
                { type: "toolCall", id: "call", name: "read", arguments: { path: "src/a.ts" } },
            ],
            api: "openai-codex-responses", provider: "openai-codex", model: "gpt-test",
            usage: {
                input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "toolUse", timestamp: 1,
        },
    },
    {
        type: "message", id: "result", parentId: "assistant", timestamp,
        message: {
            role: "toolResult", toolCallId: "call", toolName: "read",
            content: [{ type: "text", text: "abcdefgh" }], isError: false, timestamp: 2,
        },
    },
    {
        type: "compaction", id: "checkpoint", parentId: "result", timestamp,
        summary: "[OpenAI native compaction checkpoint]",
        firstKeptEntryId: "result", tokensBefore: 100,
        details: {
            strategy: "openai-responses-compaction-v2", provider: "openai-codex",
            api: "openai-codex-responses", model: "gpt-test", baseUrl: "https://example.com",
            compactedWindow: [{ type: "compaction_summary", encrypted_content: "sealed" }],
            createdAt: timestamp,
        },
    },
];

for (const limit of [undefined, null, 4]) {
    test(`reuses saved transcript proofs after a host serializer change (tool limit ${limit})`, async () => {
        const { derivePortablePlan } = await coordinator;
        const epoch = describeNativeEpoch(branch);
        assert.equal(epoch.status, "available");
        const plan = derivePortablePlan(branch, epoch, () => {});
        const checkpoint = plan.checkpoints[0]!;
        const toolText = limit === 4 ? "abcd\n\n[... 4 more characters truncated]" : "abcdefgh";
        const savedText = [
            "[Assistant thinking]: Inspecting the file",
            "[Assistant]: Reading",
            '[Assistant tool calls]: read(path="src/a.ts")',
            `[Tool result]: ${toolText}`,
        ].join("\n\n");
        const range: PortableRangeIdentity = {
            ...checkpoint.range,
            transcriptLength: savedText.length,
            transcriptFingerprint: fingerprintPortableTranscript(savedText),
        };
        if (limit !== undefined) range.toolResultChars = limit;
        const record = {
            kind: PORTABLE_SUMMARY_CUSTOM_TYPE, version: 1,
            recordId: "00000000-0000-4000-8000-000000000001",
            predecessor: { kind: "branch-root", coverageFingerprint: plan.baseline.coverageFingerprint },
            checkpoint: checkpoint.checkpoint, range, state: "complete", endOffset: savedText.length,
            coverageFingerprint: fingerprintPortableCoverage({
                predecessorCoverageFingerprint: plan.baseline.coverageFingerprint,
                checkpoint: checkpoint.checkpoint, range, endOffset: savedText.length,
            }),
            summary: "Saved portable summary",
            step: {
                kind: "summary-call", startOffset: 0, chunkFingerprint: fingerprintPortableChunk(savedText),
                summarizer: {
                    provider: "anthropic", api: "anthropic-messages", modelId: "claude-test",
                    thinkingLevel: "high", contextWindow: 200_000, maxOutputTokens: 8_192,
                    promptFingerprint: "a".repeat(64),
                },
                usage: null,
            },
        };
        const chain = selectBestPortableChain({
            sources: [{ entryId: "saved", data: record, activePosition: 3, relevantIfMalformed: true }],
            baseline: plan.baseline, checkpoints: plan.checkpoints,
        });
        assert.equal(chain.completedCheckpoints, 1);
        assert.equal(chain.summary, "Saved portable summary");
        const current = limit === undefined ? checkpoint : preparePortableSource(checkpoint, limit);
        assert.equal(current.sourceText, savedText);
    });
}
