import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";

import {
    DEFAULT_COMPACTION_PROMPT_CONTRACT,
    buildBranchSummaryInstructions,
    buildSummaryUserPrompt,
    formatManifestOperations,
    getEffectiveThinkingLevel,
    renderFilesTouchedManifestBlock,
    serializePreparedMessages,
    stripGroundedCompactionManifestTail,
} from "./index.ts";
import { messageEntry, thinkingEntry } from "./test/fixtures.ts";

describe("grounded-compaction prompt assembly", () => {
    it("prepends stronger update guidance when previousSummary exists", () => {
        const prompt = buildSummaryUserPrompt({
            mode: "history",
            promptContract: DEFAULT_COMPACTION_PROMPT_CONTRACT,
            serializedConversation: "[User]: hi",
            previousSummary: "Older summary",
            filesTouchedLedger: { mode: "off" },
        });

        assert.match(prompt, /## Update instructions/);
        assert.match(prompt, /Preserve still-valid information from the previous compaction summary/);
        assert.match(prompt, /## Previous compaction summary/);
    });

    it("adds a split-turn note to the history prompt only when part of a split turn", () => {
        const splitPrompt = buildSummaryUserPrompt({
            mode: "history",
            promptContract: DEFAULT_COMPACTION_PROMPT_CONTRACT,
            serializedConversation: "[User]: hi",
            splitTurn: true,
            filesTouchedLedger: { mode: "off" },
        });
        assert.match(splitPrompt, /## Split-turn note/);
        assert.match(splitPrompt, /as of the end of your span/);

        const plainPrompt = buildSummaryUserPrompt({
            mode: "history",
            promptContract: DEFAULT_COMPACTION_PROMPT_CONTRACT,
            serializedConversation: "[User]: hi",
            filesTouchedLedger: { mode: "off" },
        });
        assert.doesNotMatch(plainPrompt, /## Split-turn note/);
    });

    it("uses the narrow split-turn contract with only the shared style section", () => {
        const prompt = buildSummaryUserPrompt({
            mode: "turn-prefix",
            promptContract: DEFAULT_COMPACTION_PROMPT_CONTRACT,
            serializedConversation: "[User]: hi",
            filesTouchedLedger: { mode: "off" },
        });

        assert.match(prompt, /## Split-turn instructions/);
        assert.match(prompt, /Original request/);
        assert.match(prompt, /Early progress/);
        assert.match(prompt, /Context needed to understand the kept suffix/);
        assert.match(prompt, /Do not present this as a full-session status report/);
        assert.match(prompt, /## Shared style guidance/);
        assert.match(prompt, /Be dense, not terse/);
        assert.doesNotMatch(prompt, /# Style/);
        assert.doesNotMatch(prompt, /## Purpose & acceptance/);
        assert.doesNotMatch(prompt, /# Coverage audit/);
    });
});

describe("grounded-compaction message serialization", () => {
    const messages = [
        messageEntry("serialize-user", "user", "Inspect the result").message,
        messageEntry("serialize-tool", "toolResult", "abcdef").message,
    ];

    it("preserves complete tool-result text by default", () => {
        assert.equal(
            serializePreparedMessages(messages),
            "[User]: Inspect the result\n\n[Tool result]: abcdef",
        );
    });

    it("matches Pi's head-only truncation format when a limit is configured", () => {
        assert.equal(
            serializePreparedMessages(messages, 3),
            "[User]: Inspect the result\n\n[Tool result]: abc\n\n[... 3 more characters truncated]",
        );
    });

    it("does not truncate tool-result text at the exact limit", () => {
        assert.equal(serializePreparedMessages(messages, 6), serializePreparedMessages(messages));
        assert.match(serializePreparedMessages(messages, 5), /\[\.\.\. 1 more characters truncated\]$/);
    });

    it("matches Pi's native serialization when configured with Pi's limit", () => {
        const assistantMessage = messageEntry("serialize-assistant", "assistant", "unused").message;
        assert.ok(assistantMessage.role === "assistant");
        const parityMessages: Parameters<typeof convertToLlm>[0] = [
            messages[0],
            {
                ...assistantMessage,
                content: [
                    { type: "thinking", thinking: "Inspecting" },
                    { type: "text", text: "Found the call" },
                    { type: "toolCall", id: "call-read", name: "read", arguments: { path: "src/a.ts" } },
                ],
            },
            messageEntry("serialize-large-tool", "toolResult", "x".repeat(2_001)).message,
        ];

        assert.equal(
            serializePreparedMessages(parityMessages, 2_000),
            serializeConversation(convertToLlm(parityMessages)),
        );
    });
});

describe("grounded-compaction branch-summary instruction builder", () => {
    it("applies branch audience instructions with custom and stock contracts", () => {
        const block = "## Files touched\nR=read, W=write, E=edit, M=move/rename, D=delete\n\n```text\nR  src/a.ts\n```";
        const focusText = "Focus on parser regressions";
        const build = (mode: "off" | "writer" | "writerAndReader", promptContract?: string) => buildBranchSummaryInstructions({
            promptContract,
            focusText,
            filesTouchedLedger: mode === "off" ? { mode } : { mode, block },
        });

        assert.equal(build("off"), undefined);
        assert.deepEqual(build("off", "# Contract\nUse this shape"), {
            customInstructions: `# Contract\nUse this shape\n\n## Additional focus\nIncorporate this user-provided focus while staying faithful to the actual branch history.\n\n${focusText}`,
            replaceInstructions: true,
        });

        for (const promptContract of ["# Contract\nUse this shape", undefined]) {
            const writer = build("writer", promptContract);
            assert.ok(writer);
            assert.equal(writer.replaceInstructions, promptContract !== undefined);
            assert.ok(writer.customInstructions.includes(block));
            assert.ok(writer.customInstructions.includes(focusText));
            assert.match(writer.customInstructions, /factual reference for you only/);
            assert.match(writer.customInstructions, /use the final canonical path/);
            assert.doesNotMatch(writer.customInstructions, /verbatim/i);

            const writerAndReader = build("writerAndReader", promptContract);
            assert.ok(writerAndReader);
            assert.equal(writerAndReader.replaceInstructions, promptContract !== undefined);
            assert.ok(writerAndReader.customInstructions.includes(block));
            assert.match(writerAndReader.customInstructions, /verbatim in the summary body/);
            assert.match(writerAndReader.customInstructions, /use the final canonical path/);
        }
        assert.match(build("writerAndReader")?.customInstructions ?? "", /^Also include the authoritative files-touched block below/);
        assert.match(build("writer")?.customInstructions ?? "", /^Use the files-touched block below as reference/);
    });
});

describe("grounded-compaction helpers", () => {
    it("tracks the latest thinking level on the branch", () => {
        assert.equal(getEffectiveThinkingLevel([thinkingEntry("low"), thinkingEntry("high")]), "high");
        assert.equal(getEffectiveThinkingLevel([]), "off");
    });

    it("renders and strips files-touched manifests exactly once", () => {
        const manifest = renderFilesTouchedManifestBlock([
            {
                path: "/repo/src/a.ts",
                displayPath: "src/a.ts",
                operations: new Set(["read", "edit"]),
                lastTimestamp: 1,
            },
            {
                path: "/repo/src/b.ts",
                displayPath: "src/b.ts",
                operations: new Set(["write"]),
                lastTimestamp: 2,
            },
        ]);

        assert.equal(formatManifestOperations({
            path: "",
            displayPath: "",
            operations: new Set(["read", "edit"]),
            lastTimestamp: 0,
        }), "RE");
        assert.equal(
            manifest,
            [
                "## Files touched",
                "R=read, W=write, E=edit, M=move/rename, D=delete",
                "",
                "```text",
                "RE src/a.ts",
                "W  src/b.ts",
                "```",
            ].join("\n"),
        );

        assert.equal(stripGroundedCompactionManifestTail(`Summary\n\n${manifest}`), "Summary");
        const cumulative = "## Files touched (cumulative)\nR=read, W=write, E=edit, M=move/rename, D=delete\n\n```text\nRE src/a.ts\n```";
        assert.equal(stripGroundedCompactionManifestTail(`Summary\n\n---\n\n${cumulative}`), "Summary");
        assert.equal(stripGroundedCompactionManifestTail(`Summary\n\n${manifest}\n\n---\n\n${cumulative}\n`), "Summary");
        assert.equal(stripGroundedCompactionManifestTail(cumulative), undefined);
        const midBody = `Summary\n\n---\n\n${cumulative}\n\n## Critical evidence\n\n\`\`\`text\nkeep me\n\`\`\``;
        assert.equal(stripGroundedCompactionManifestTail(midBody), midBody);
    });
});
