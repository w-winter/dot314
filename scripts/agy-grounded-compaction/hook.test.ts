import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { processPreInvocation, type HookDeps, type PreInvocationHookInput } from "./hook.ts";
import {
    buildAgySummaryPrompt,
    parsePiListModelsContextWindows,
    selectPresetForPrompt,
    type SharedGroundedConfig,
} from "./summarizer.ts";
import {
    DEFAULT_MAX_CHUNK_BYTES,
    GROUNDED_COMPACTION_MARKER,
    chunkInjectedPayload,
    collectAgyFilesTouchedBlock,
    extractUserRequestText,
    findLatestActiveCheckpoint,
    parseCompactCommand,
    parseNativeUserRequests,
    parseTranscriptRecords,
    selectVerbatimUserMessages,
    serializeSpanForSummary,
} from "./transcript.ts";

function makeJsonl(records: Record<string, unknown>[]): string {
    return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

function userRecord(stepIndex: number, text: string, createdAt = "2026-11-24T06:00:00Z"): Record<string, unknown> {
    return {
        step_index: stepIndex,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        status: "DONE",
        created_at: createdAt,
        content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-24T01:00:00-05:00.\n</ADDITIONAL_METADATA>`,
    };
}

function plannerRecord(
    stepIndex: number,
    content: string,
    toolCalls?: Array<{ name: string; args: Record<string, unknown> }>,
    createdAt = "2026-11-24T06:00:05Z",
): Record<string, unknown> {
    return {
        step_index: stepIndex,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: createdAt,
        model: "gemini-4-neon-xhigh",
        input_tokens: 10000,
        cache_read_tokens: 0,
        output_tokens: 100,
        content,
        ...(toolCalls ? { tool_calls: toolCalls } : {}),
    };
}

function toolResultRecord(stepIndex: number, content: string, status = "DONE", error?: string): Record<string, unknown> {
    return {
        step_index: stepIndex,
        source: "SYSTEM",
        type: "GENERIC",
        status,
        created_at: "2026-11-24T06:00:06Z",
        content,
        ...(error ? { error } : {}),
    };
}

function checkpointRecord(
    stepIndex: number,
    content = "# Resuming from a compaction\n<summary>native</summary>",
    createdAt = "2026-11-24T06:05:00Z",
): Record<string, unknown> {
    return {
        step_index: stepIndex,
        source: "SYSTEM",
        type: "CHECKPOINT",
        status: "DONE",
        created_at: createdAt,
        input_tokens: 50000,
        cache_read_tokens: 790000,
        output_tokens: 1500,
        content,
    };
}

function makeNativeCheckpointContent(requests: readonly string[], summary = "native summary"): string {
    const numbered = requests.map((text, index) => `${index + 1}. ${text}`).join("\n");
    return [
        "# Resuming from a compaction",
        "",
        "# User Requests",
        "The following were user requests from the truncated conversation in chronological order:",
        numbered,
        "",
        `<summary>\n${summary}\n</summary>`,
    ].join("\n");
}

function systemRecord(stepIndex: number, content: string): Record<string, unknown> {
    return {
        step_index: stepIndex,
        source: "SYSTEM_SDK",
        type: "SYSTEM_MESSAGE",
        status: "DONE",
        created_at: "2026-11-24T06:05:10Z",
        content,
    };
}

describe("transcript parsing, retention, files-touched, and chunking", () => {
    it("extracts user requests and detects /compact directives accurately", () => {
        assert.equal(
            extractUserRequestText("<USER_REQUEST>\nFix parser bug\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nfoo\n</ADDITIONAL_METADATA>"),
            "Fix parser bug",
        );
        assert.deepEqual(parseCompactCommand("/compact"), { isCompact: true });
        assert.deepEqual(parseCompactCommand("/compact   keep auth notes  "), {
            isCompact: true,
            focusText: "keep auth notes",
        });
        assert.deepEqual(parseCompactCommand("explain /compact behavior"), { isCompact: false });
        assert.deepEqual(parseCompactCommand("/compaction-check"), { isCompact: false });
    });

    it("finds the latest active CHECKPOINT even across multiple checkpoints and rewinds", () => {
        const jsonl = makeJsonl([
            userRecord(0, "hello"),
            checkpointRecord(10, "cp1", "2026-11-24T06:05:00Z"),
            userRecord(12, "more work"),
            checkpointRecord(42, "cp2", "2026-11-24T06:10:00Z"),
            plannerRecord(43, "after"),
        ]);
        assert.deepEqual(findLatestActiveCheckpoint(jsonl), {
            stepIndex: 42,
            createdAt: "2026-11-24T06:10:00Z",
            key: "42@2026-11-24T06:10:00Z",
        });
        assert.equal(findLatestActiveCheckpoint(makeJsonl([userRecord(0, "no checkpoint")])), null);

        // Rewinding past checkpoint 42 removes it from the active branch.
        const rewoundPastCp2 = makeJsonl([
            userRecord(0, "hello"),
            checkpointRecord(10, "cp1", "2026-11-24T06:05:00Z"),
            userRecord(12, "abandoned work"),
            checkpointRecord(42, "cp2", "2026-11-24T06:10:00Z"),
            userRecord(12, "replacement work", "2026-11-24T06:15:00Z"),
        ]);
        assert.deepEqual(findLatestActiveCheckpoint(rewoundPastCp2), {
            stepIndex: 10,
            createdAt: "2026-11-24T06:05:00Z",
            key: "10@2026-11-24T06:05:00Z",
        });

        // Rewinding past ALL checkpoints leaves no active checkpoint.
        const rewoundPastAll = makeJsonl([
            userRecord(0, "hello"),
            userRecord(2, "old branch"),
            checkpointRecord(10, "cp1", "2026-11-24T06:05:00Z"),
            userRecord(2, "new branch", "2026-11-24T06:20:00Z"),
        ]);
        assert.equal(findLatestActiveCheckpoint(rewoundPastAll), null);
    });

    it("reconstructs active branch across /rewind while keeping out-of-order parallel tool flushes intact", () => {
        const jsonl = makeJsonl([
            userRecord(0, "root goal"),
            plannerRecord(1, "parallel tools", [
                { name: "read_file", args: { Path: "/repo/first.ts" } },
                { name: "read_file", args: { Path: "/repo/second.ts" } },
            ]),
            // Parallel tool results flushed out of order (step 3 before step 2, neither previously seen).
            toolResultRecord(3, "SECOND_RESULT"),
            toolResultRecord(2, "FIRST_RESULT"),
            // Abandoned timeline starting at step 4 (including an unknown record type at step 4 on first rewind).
            { step_index: 4, type: "UNKNOWN_EVENT", created_at: "2026-11-24T06:01:00Z" },
            userRecord(5, "abandoned prompt A"),
            plannerRecord(6, "abandoned reply A", [{ name: "write_file", args: { Path: "/repo/abandoned.ts" } }]),
            // First rewind back to step 4, later abandoned by a second rewind back to step 4.
            userRecord(4, "abandoned prompt B", "2026-11-24T06:02:00Z"),
            plannerRecord(5, "abandoned reply B"),
            // Final active rewind back to step 4.
            userRecord(4, "active replacement prompt", "2026-11-24T06:03:00Z"),
            plannerRecord(5, "active replacement reply", [{ name: "edit_file", args: { Path: "/repo/kept.ts" } }]),
            toolResultRecord(6, "KEPT_EDIT_OK"),
            checkpointRecord(7, "active cp", "2026-11-24T06:04:00Z"),
        ]);

        const records = parseTranscriptRecords(jsonl);
        const span = serializeSpanForSummary(records, -1, 7, null);
        assert.ok(span.serializedConversation.includes("root goal"));
        assert.ok(span.serializedConversation.includes("active replacement prompt"));
        assert.ok(!span.serializedConversation.includes("abandoned prompt A"));
        assert.ok(!span.serializedConversation.includes("abandoned prompt B"));
        assert.ok(!span.serializedConversation.includes("abandoned reply"));
        // Step 2 must sort ahead of step 3 so FIFO tool pairing stays accurate.
        assert.ok(span.serializedConversation.indexOf("FIRST_RESULT") < span.serializedConversation.indexOf("SECOND_RESULT"));

        const files = collectAgyFilesTouchedBlock(records, 7);
        assert.ok(files.includes("R  /repo/first.ts"));
        assert.ok(files.includes("R  /repo/second.ts"));
        assert.ok(files.includes("E  /repo/kept.ts"));
        assert.ok(!files.includes("/repo/abandoned.ts"));

        const verbatim = selectVerbatimUserMessages(records, 7, 10_000);
        assert.equal(verbatim.selectedCount, 2);
        assert.ok(verbatim.section.includes("root goal"));
        assert.ok(verbatim.section.includes("active replacement prompt"));
        assert.ok(!verbatim.section.includes("abandoned prompt"));
    });

    it("serializes only the requested span, excludes self-injected chunks and native checkpoints, and pairs FIFO tool outputs", () => {
        const records = parseTranscriptRecords(makeJsonl([
            userRecord(0, "initial goal"),
            plannerRecord(1, "reading file", [{ name: "read_file", args: { Path: "/repo/a.ts" } }]),
            toolResultRecord(2, "0123456789abcdef"),
            checkpointRecord(3, "native checkpoint 1"),
            systemRecord(4, `${GROUNDED_COMPACTION_MARKER} checkpoint=3 part=1/1]\nold injected summary`),
            userRecord(5, "follow-up fix"),
            plannerRecord(6, "editing file", [{ name: "edit_file", args: { Path: "/repo/a.ts" } }]),
            toolResultRecord(7, "edited ok"),
            userRecord(8, "/compact keep edge case"),
            checkpointRecord(9, "native checkpoint 2"),
        ]));

        const span = serializeSpanForSummary(records, 3, 9, 10);
        assert.equal(span.hasContent, true);
        assert.equal(span.focusText, "keep edge case");
        assert.ok(span.serializedConversation.includes("follow-up fix"));
        assert.ok(span.serializedConversation.includes("edit_file"));
        assert.ok(span.serializedConversation.includes("edited ok"));
        assert.ok(!span.serializedConversation.includes("initial goal"));
        assert.ok(!span.serializedConversation.includes("old injected summary"));
        assert.ok(!span.serializedConversation.includes("native checkpoint"));

        const spanWithTruncation = serializeSpanForSummary(records, -1, 3, 6);
        assert.ok(spanWithTruncation.serializedConversation.includes("012345"));
        assert.ok(spanWithTruncation.serializedConversation.includes("10 more characters truncated"));
    });

    it("collects cumulative agy files-touched operations strictly before the checkpoint", () => {
        const records = parseTranscriptRecords(makeJsonl([
            plannerRecord(1, "", [
                { name: "read_file", args: { Path: "/repo/a.ts" } },
                { name: "view_file", args: { AbsolutePath: "/repo/b.ts" } },
            ]),
            plannerRecord(2, "", [
                { name: "edit_file", args: { Path: "/repo/a.ts" } },
                { name: "write_file", args: { Path: "/repo/c.ts" } },
                { name: "replace_file_content", args: { TargetFile: "/repo/b.ts" } },
            ]),
            checkpointRecord(3),
            plannerRecord(4, "", [{ name: "write_to_file", args: { TargetFile: "/repo/after.ts" } }]),
        ]));

        const block = collectAgyFilesTouchedBlock(records, 3);
        assert.ok(block.includes("RE /repo/a.ts"));
        assert.ok(block.includes("RE /repo/b.ts"));
        assert.ok(block.includes("W  /repo/c.ts"));
        assert.ok(!block.includes("/repo/after.ts"));
    });

    it("selects verbatim user messages newest-first within budget, skips oversized ones, uses safe fences, and excludes /compact", () => {
        const records = parseTranscriptRecords(makeJsonl([
            userRecord(0, "oldest small prompt", "2026-11-23T22:00:00Z"),
            userRecord(2, "HUGE ".repeat(2000), "2026-11-24T01:00:00Z"),
            userRecord(4, "middle with ```triple\n````quad backticks", "2026-11-24T02:00:00Z"),
            userRecord(6, "/compact"),
            userRecord(8, "/compact focus note only"),
            userRecord(10, "newest small prompt", "2026-11-24T03:00:00Z"),
            checkpointRecord(11),
            userRecord(12, "after checkpoint prompt", "2026-11-24T04:00:00Z"),
        ]));

        const result = selectVerbatimUserMessages(records, 11, 350);
        assert.equal(result.selectedCount, 3);
        assert.ok(result.estimatedTokens <= 350);
        assert.ok(result.section.includes("oldest small prompt"));
        assert.ok(result.section.includes("middle with ```triple"));
        assert.ok(result.section.includes("newest small prompt"));
        assert.ok(!result.section.includes("HUGE HUGE"));
        assert.ok(!result.section.includes("/compact"));
        assert.ok(!result.section.includes("after checkpoint prompt"));
        // Dynamic fence must exceed the quadruple backticks in message 4.
        assert.ok(result.section.includes("`````step-4 02:00"));
        // Chronological order: oldest appears before middle, which appears before newest.
        assert.ok(result.section.indexOf("oldest small prompt") < result.section.indexOf("middle with"));
        assert.ok(result.section.indexOf("middle with") < result.section.indexOf("newest small prompt"));
    });

    it("parses native # User Requests and deduplicates only untruncated messages already retained by Antigravity", () => {
        const longPrompt = `Long prompt header\n${"detail line\n".repeat(40)}TAIL_UNIQUE_99`;
        const truncatedInNative = `${longPrompt.slice(0, 60)}\n<truncated 440 bytes>`;
        const cpContent = makeNativeCheckpointContent([
            "second short prompt\nwith multiline body",
            truncatedInNative,
            "/compact",
        ]);

        const parsed = parseNativeUserRequests(cpContent);
        assert.deepEqual(parsed, [
            { text: "second short prompt\nwith multiline body", truncated: false },
            { text: longPrompt.slice(0, 60), truncated: true },
            { text: "/compact", truncated: false },
        ]);

        const records = parseTranscriptRecords(makeJsonl([
            userRecord(0, "oldest prompt dropped by agy cap", "2026-11-24T01:00:00Z"),
            userRecord(2, "second short prompt\nwith multiline body", "2026-11-24T02:00:00Z"),
            userRecord(4, longPrompt, "2026-11-24T03:00:00Z"),
            userRecord(6, "/compact", "2026-11-24T04:00:00Z"),
            checkpointRecord(7, cpContent),
        ]));

        const deduped = selectVerbatimUserMessages(records, 7, 10_000, parsed);
        assert.equal(deduped.selectedCount, 2);
        assert.equal(deduped.omittedNativeCount, 1);
        assert.ok(deduped.section.includes("oldest prompt dropped by agy cap"));
        assert.ok(deduped.section.includes("TAIL_UNIQUE_99"));
        assert.ok(!deduped.section.includes("second short prompt\nwith multiline body"));
        assert.ok(deduped.section.includes("already retained verbatim in Antigravity's # User Requests"));

        // When every user message is already retained verbatim by Antigravity, emit nothing.
        const allRetainedCp = makeNativeCheckpointContent(["only short prompt", "/compact"]);
        const shortRecs = parseTranscriptRecords(makeJsonl([
            userRecord(0, "only short prompt"),
            userRecord(2, "/compact"),
            checkpointRecord(3, allRetainedCp),
        ]));
        const emptyDedup = selectVerbatimUserMessages(shortRecs, 3, 10_000, parseNativeUserRequests(allRetainedCp));
        assert.equal(emptyDedup.section, "");
        assert.equal(emptyDedup.selectedCount, 0);
        assert.equal(emptyDedup.omittedNativeCount, 1);
    });

    it("enforces strict UTF-8 byte ceiling and lossless round-trip across diverse chunked payloads", () => {
        const payloads = [
            "short summary only",
            `${"Line with UTF-8 日本語 🚀 café\n".repeat(2500)}TAIL_MARKER_1`,
            `${"🚀".repeat(15000)}TAIL_MARKER_SINGLE_LONG_LINE`,
            `${"paragraph A\n\n".repeat(1200)}${"`".repeat(20)}\nEND_OF_BIG_BLOCK`,
        ];

        for (const bodyText of payloads) {
            const maxChunkBytes = 4096;
            const headerBlock = "Authoritative grounded compaction header.";
            const chunks = chunkInjectedPayload({
                checkpointStep: 77,
                headerBlock,
                bodyText,
                maxChunkBytes,
            });

            assert.ok(chunks.length >= 1);
            const reconstructedParts: string[] = [];
            chunks.forEach((chunk, index) => {
                const bytes = Buffer.byteLength(chunk, "utf8");
                assert.ok(
                    bytes <= maxChunkBytes,
                    `chunk ${index + 1}/${chunks.length} exceeded byte limit: ${bytes} > ${maxChunkBytes}`,
                );
                assert.ok(chunk.startsWith(`${GROUNDED_COMPACTION_MARKER} checkpoint=77 part=${index + 1}/${chunks.length}]\n`));
                const firstNewline = chunk.indexOf("\n");
                let content = chunk.slice(firstNewline + 1);
                if (index === 0) {
                    assert.ok(content.startsWith(`${headerBlock}\n\n`));
                    content = content.slice(headerBlock.length + 2);
                }
                reconstructedParts.push(content);
            });

            // Joining reconstructed parts (with or without boundary newlines preserved verbatim) matches bodyText exactly.
            assert.equal(reconstructedParts.join(""), bodyText);
        }

        // Verify default ceiling handles a 260 KB payload cleanly into <= 38 KB chunks.
        const largeBody = "user message text 0123456789\n".repeat(9000);
        const defaultChunks = chunkInjectedPayload({
            checkpointStep: 120,
            headerBlock: "Header",
            bodyText: largeBody,
        });
        assert.ok(defaultChunks.length >= 7);
        for (const chunk of defaultChunks) {
            assert.ok(Buffer.byteLength(chunk, "utf8") <= DEFAULT_MAX_CHUNK_BYTES);
        }
        const stripped = defaultChunks
            .map((chunk, i) => {
                const afterTag = chunk.slice(chunk.indexOf("\n") + 1);
                return i === 0 ? afterTag.slice("Header\n\n".length) : afterTag;
            })
            .join("");
        assert.equal(stripped, largeBody);
    });
});

describe("preset routing and prompt construction", () => {
    it("parses pi --list-models context windows and routes oversized prompts to largeContextPreset", () => {
        const listOutput = [
            "provider      model                  context  max-out  thinking  images",
            "pi-claude     claude-opus-5-5        200K     64K      yes       yes",
            "openai-codex  gpt-6-luna             1.1M     128K     yes       yes",
        ].join("\n");
        const windows = parsePiListModelsContextWindows(listOutput);
        assert.equal(windows.get("pi-claude/claude-opus-5-5"), 200_000);
        assert.equal(windows.get("openai-codex/gpt-6-luna"), 1_100_000);

        const config: SharedGroundedConfig = {
            defaultPreset: "default",
            largeContextPreset: "large",
            toolResultChars: null,
            verbatimUserMessageTokens: 64_000,
            includeFilesTouched: "writer",
            presets: {
                default: { model: "pi-claude/claude-opus-5-5", thinkingLevel: "medium" },
                large: { model: "openai-codex/gpt-6-luna", thinkingLevel: "xhigh" },
            },
        };

        const small = selectPresetForPrompt({ config, estimatedInputTokens: 80_000, contextWindows: windows });
        assert.equal(small.model, "pi-claude/claude-opus-5-5");
        assert.equal(small.routedToLarge, false);

        const large = selectPresetForPrompt({ config, estimatedInputTokens: 170_000, contextWindows: windows });
        assert.equal(large.model, "openai-codex/gpt-6-luna");
        assert.equal(large.thinkingLevel, "xhigh");
        assert.equal(large.routedToLarge, true);
    });

    it("includes previousSummary update guidance and files-touched reference when configured", () => {
        const prompt = buildAgySummaryPrompt({
            promptContract: "# Contract\nBe dense.",
            serializedConversation: "USER: hi",
            previousSummary: "## Brief\nPrior work.",
            focusText: "emphasize tests",
            filesTouchedBlock: "## Files touched\nR=read, W=write, E=edit, M=move/rename, D=delete\n\n```text\nRE /a.ts\n```",
            includeFilesTouchedMode: "writer",
        });

        assert.ok(prompt.userPrompt.includes("## Update instructions"));
        assert.ok(prompt.userPrompt.includes("## Previous compaction summary"));
        assert.ok(prompt.userPrompt.includes("Prior work."));
        assert.ok(prompt.userPrompt.includes("## User compaction note"));
        assert.ok(prompt.userPrompt.includes("emphasize tests"));
        assert.ok(prompt.userPrompt.includes("## Cumulative files-touched reference"));
        assert.ok(prompt.userPrompt.includes("RE /a.ts"));
    });

    it("adds an explicit partial-history notice to pi when a forked session has unresolved pre-fork history", () => {
        const prompt = buildAgySummaryPrompt({
            promptContract: "# Contract\nBe dense.",
            serializedConversation: "[User step=27]: try approach B",
            includeFilesTouchedMode: "off",
            missingPrefixBeforeStep: 27,
        });
        assert.ok(prompt.userPrompt.includes("## Partial-history notice"));
        assert.ok(prompt.userPrompt.includes("steps 0..26"));
        assert.ok(prompt.userPrompt.includes("Do not mistake the first visible post-fork message"));
    });
});

describe("PreInvocation hook state machine and failure handling", () => {
    async function createTempBrain(): Promise<{ brainDir: string; logsDir: string; transcriptPath: string; compactPath: string }> {
        const brainDir = await mkdtemp(path.join(os.tmpdir(), "agy-gc-test-"));
        const logsDir = path.join(brainDir, ".system_generated", "logs");
        await writeFile(path.join(brainDir, ".keep"), "");
        const fs = await import("node:fs/promises");
        await fs.mkdir(logsDir, { recursive: true });
        return {
            brainDir,
            logsDir,
            transcriptPath: path.join(logsDir, "transcript_full.jsonl"),
            compactPath: path.join(logsDir, "transcript.jsonl"),
        };
    }

    const baseConfig: SharedGroundedConfig = {
        defaultPreset: "default",
        largeContextPreset: "large",
        toolResultChars: null,
        verbatimUserMessageTokens: 64_000,
        includeFilesTouched: "writer",
        presets: {
            default: { model: "pi-claude/claude-opus-5-5", thinkingLevel: "medium" },
            large: { model: "openai-codex/gpt-6-luna", thinkingLevel: "xhigh" },
        },
    };

    it("returns empty output on fast path without CHECKPOINT, and skips /compact on invocationNum=0", async () => {
        const { brainDir, transcriptPath, compactPath } = await createTempBrain();
        try {
            const raw = makeJsonl([userRecord(0, "hello"), plannerRecord(1, "hi")]);
            await writeFile(transcriptPath, raw);
            await writeFile(compactPath, raw);

            let summarizeCalls = 0;
            const deps: HookDeps = {
                loadConfig: async () => baseConfig,
                loadPromptContract: async () => "# Contract\nSummarize.",
                runSummarizer: async () => {
                    summarizeCalls += 1;
                    return { summary: "## Brief\nok", model: "pi-claude/claude-opus-5-5", thinkingLevel: "medium", durationMs: 10 };
                },
            };

            const input: PreInvocationHookInput = {
                conversationId: "conv-1",
                transcriptPath,
                invocationNum: 0,
                lastUserInput: "next prompt",
            };
            assert.deepEqual(await processPreInvocation(input, deps), {});
            assert.equal(summarizeCalls, 0);

            // Even with a checkpoint present, invocationNum=0 for /compact must not inject right before /compact wipes context.
            const withCheckpoint = makeJsonl([userRecord(0, "hello"), plannerRecord(1, "hi"), checkpointRecord(2)]);
            await writeFile(transcriptPath, withCheckpoint);
            await writeFile(compactPath, withCheckpoint);
            assert.deepEqual(
                await processPreInvocation({ ...input, invocationNum: 0, lastUserInput: "/compact now" }, deps),
                {},
            );
            assert.equal(summarizeCalls, 0);
        } finally {
            await rm(brainDir, { recursive: true, force: true });
        }
    });

    it("injects exactly once per checkpoint, carries previousSummary on checkpoint #2, and skips empty forked spans", async () => {
        const { brainDir, transcriptPath, compactPath } = await createTempBrain();
        try {
            const calls: Array<{ previousSummary?: string; serialized: string }> = [];
            const deps: HookDeps = {
                loadConfig: async () => baseConfig,
                loadPromptContract: async () => "# Contract\nSummarize.",
                runSummarizer: async (req) => {
                    calls.push({ previousSummary: req.previousSummary, serialized: req.serializedConversation });
                    return {
                        summary: `## Brief\nSummary #${calls.length}`,
                        model: "pi-claude/claude-opus-5-5",
                        thinkingLevel: "medium",
                        durationMs: 25,
                    };
                },
            };

            const phase1 = makeJsonl([
                userRecord(0, "Goal G1: build hook"),
                plannerRecord(1, "Investigating", [{ name: "read_file", args: { Path: "/repo/x.ts" } }]),
                toolResultRecord(2, "contents of x"),
                checkpointRecord(3),
            ]);
            await writeFile(transcriptPath, phase1);
            await writeFile(compactPath, phase1);

            const baseInput: PreInvocationHookInput = {
                conversationId: "conv-2",
                transcriptPath,
                invocationNum: 0,
                lastUserInput: "continue",
            };

            const out1 = await processPreInvocation(baseInput, deps);
            assert.ok(out1.injectSteps && out1.injectSteps.length >= 1);
            const joined1 = out1.injectSteps.map((s) => s.systemMessage.systemMessage).join("\n");
            assert.ok(joined1.includes("Summary #1"));
            assert.ok(joined1.includes("Goal G1: build hook"));
            assert.equal(calls.length, 1);
            assert.equal(calls[0].previousSummary, undefined);

            // Second turn on the same checkpoint must NOT re-fire.
            const out1Repeat = await processPreInvocation({ ...baseInput, invocationNum: 1 }, deps);
            assert.deepEqual(out1Repeat, {});
            assert.equal(calls.length, 1);

            // Second compaction later in the same session passes Summary #1 as previousSummary and only fresh span (3, 7).
            const phase2 = makeJsonl([
                userRecord(0, "Goal G1: build hook"),
                plannerRecord(1, "Investigating"),
                toolResultRecord(2, "contents of x"),
                checkpointRecord(3),
                systemRecord(4, joined1),
                userRecord(5, "Now add tests"),
                plannerRecord(6, "Adding tests"),
                checkpointRecord(7),
            ]);
            await writeFile(transcriptPath, phase2);
            await writeFile(compactPath, phase2);

            const out2 = await processPreInvocation(baseInput, deps);
            assert.ok(out2.injectSteps && out2.injectSteps.length >= 1);
            assert.equal(calls.length, 2);
            assert.equal(calls[1].previousSummary, "## Brief\nSummary #1");
            assert.ok(calls[1].serialized.includes("Now add tests"));
            assert.ok(!calls[1].serialized.includes("Goal G1: build hook"));
            assert.ok(!calls[1].serialized.includes("Summary #1"));

            // Verbatim user messages still include BOTH pre-checkpoint user messages (0 and 5).
            const joined2 = out2.injectSteps.map((s) => s.systemMessage.systemMessage).join("\n");
            assert.ok(joined2.includes("Goal G1: build hook"));
            assert.ok(joined2.includes("Now add tests"));
        } finally {
            await rm(brainDir, { recursive: true, force: true });
        }
    });

    it("skips empty forked sessions without calling summarizer and handles summarizer failures without retry loops", async () => {
        const { brainDir, transcriptPath, compactPath } = await createTempBrain();
        try {
            // Forked session whose transcript only has /compact + CHECKPOINT.
            const forked = makeJsonl([userRecord(27, "/compact"), checkpointRecord(28)]);
            await writeFile(transcriptPath, forked);
            await writeFile(compactPath, forked);

            let calls = 0;
            const skipDeps: HookDeps = {
                loadConfig: async () => baseConfig,
                loadPromptContract: async () => "# Contract",
                runSummarizer: async () => {
                    calls += 1;
                    return { summary: "should not run", model: "pi-claude/claude-opus-5-5", durationMs: 1 };
                },
            };
            const skipOut = await processPreInvocation(
                { conversationId: "forked", transcriptPath, invocationNum: 0, lastUserInput: "hello" },
                skipDeps,
            );
            assert.deepEqual(skipOut, {});
            assert.equal(calls, 0);

            // Next checkpoint with real content where summarizer fails: injects notice once, logs error, does NOT retry-loop.
            const failing = makeJsonl([
                userRecord(27, "/compact"),
                checkpointRecord(28),
                userRecord(29, "do real work"),
                plannerRecord(30, "working"),
                checkpointRecord(31),
            ]);
            await writeFile(transcriptPath, failing);
            await writeFile(compactPath, failing);

            const failDeps: HookDeps = {
                loadConfig: async () => baseConfig,
                loadPromptContract: async () => "# Contract",
                runSummarizer: async () => {
                    calls += 1;
                    throw new Error("auth expired");
                },
            };

            const failOut = await processPreInvocation(
                { conversationId: "forked", transcriptPath, invocationNum: 0, lastUserInput: "next" },
                failDeps,
            );
            assert.equal(calls, 1);
            assert.ok(failOut.injectSteps && failOut.injectSteps.length === 1);
            assert.ok(failOut.injectSteps[0].systemMessage.systemMessage.includes("auth expired"));

            // Subsequent invocation for checkpoint 31 does NOT retry-loop.
            const retryOut = await processPreInvocation(
                { conversationId: "forked", transcriptPath, invocationNum: 1, lastUserInput: "next" },
                failDeps,
            );
            assert.deepEqual(retryOut, {});
            assert.equal(calls, 1);

            const logContent = await readFile(
                path.join(brainDir, ".system_generated", "grounded-compaction", "hook.log"),
                "utf8",
            );
            assert.ok(logContent.includes("auth expired"));
        } finally {
            await rm(brainDir, { recursive: true, force: true });
        }
    });

    it("handles rewind past a prior checkpoint and compacting again at a lower or reused step_index", async () => {
        const { brainDir, transcriptPath, compactPath } = await createTempBrain();
        try {
            const calls: Array<{ previousSummary?: string; serialized: string }> = [];
            const deps: HookDeps = {
                loadConfig: async () => baseConfig,
                loadPromptContract: async () => "# Contract",
                runSummarizer: async (req) => {
                    calls.push({ previousSummary: req.previousSummary, serialized: req.serializedConversation });
                    return {
                        summary: `## Brief\nSummary #${calls.length}`,
                        model: "pi-claude/claude-opus-5-5",
                        thinkingLevel: "medium",
                        durationMs: 10,
                    };
                },
            };

            const baseInput: PreInvocationHookInput = {
                conversationId: "conv-rewind",
                transcriptPath,
                invocationNum: 0,
                lastUserInput: "continue",
            };

            // 1. Compact at step 10.
            const phase1 = makeJsonl([
                userRecord(0, "root goal"),
                plannerRecord(1, "step 1"),
                userRecord(2, "old branch work"),
                plannerRecord(3, "old reply"),
                checkpointRecord(10, "old cp 10", "2026-11-24T06:05:00Z"),
            ]);
            await writeFile(transcriptPath, phase1);
            await writeFile(compactPath, phase1);

            const out1 = await processPreInvocation(baseInput, deps);
            assert.ok(out1.injectSteps && out1.injectSteps.length >= 1);
            assert.equal(calls.length, 1);

            // 2. Rewind back to step 2 (before checkpoint 10!), do new work, and compact at LOWER step 5.
            const phase2 = makeJsonl([
                userRecord(0, "root goal"),
                plannerRecord(1, "step 1"),
                userRecord(2, "old branch work"),
                plannerRecord(3, "old reply"),
                checkpointRecord(10, "old cp 10", "2026-11-24T06:05:00Z"),
                userRecord(2, "rewound fresh work", "2026-11-24T06:10:00Z"),
                plannerRecord(3, "rewound fresh reply"),
                checkpointRecord(5, "new cp 5", "2026-11-24T06:11:00Z"),
            ]);
            await writeFile(transcriptPath, phase2);
            await writeFile(compactPath, phase2);

            const out2 = await processPreInvocation(baseInput, deps);
            assert.ok(out2.injectSteps && out2.injectSteps.length >= 1);
            assert.equal(calls.length, 2);
            // Old checkpoint 10 was rewound away, so previousSummary must be undefined and old branch work excluded.
            assert.equal(calls[1].previousSummary, undefined);
            assert.ok(calls[1].serialized.includes("root goal"));
            assert.ok(calls[1].serialized.includes("rewound fresh work"));
            assert.ok(!calls[1].serialized.includes("old branch work"));

            // 3. Rewind again back to step 2 and compact at the REUSED step_index 10 with a newer timestamp.
            const phase3 = makeJsonl([
                userRecord(0, "root goal"),
                plannerRecord(1, "step 1"),
                userRecord(2, "old branch work"),
                plannerRecord(3, "old reply"),
                checkpointRecord(10, "old cp 10", "2026-11-24T06:05:00Z"),
                userRecord(2, "rewound fresh work", "2026-11-24T06:10:00Z"),
                plannerRecord(3, "rewound fresh reply"),
                checkpointRecord(5, "new cp 5", "2026-11-24T06:11:00Z"),
                userRecord(2, "third branch work", "2026-11-24T06:20:00Z"),
                plannerRecord(3, "third reply"),
                checkpointRecord(10, "reused step 10 cp", "2026-11-24T06:21:00Z"),
            ]);
            await writeFile(transcriptPath, phase3);
            await writeFile(compactPath, phase3);

            const out3 = await processPreInvocation(baseInput, deps);
            assert.ok(out3.injectSteps && out3.injectSteps.length >= 1);
            assert.equal(calls.length, 3);
            assert.equal(calls[2].previousSummary, undefined);
            assert.ok(calls[2].serialized.includes("third branch work"));
            assert.ok(!calls[2].serialized.includes("rewound fresh work"));
            assert.ok(!calls[2].serialized.includes("old branch work"));

            // 4. Rewind AFTER active checkpoint 10 (say to step 12) and compact again at step 15: MUST carry Summary #3!
            const phase4 = makeJsonl([
                userRecord(0, "root goal"),
                plannerRecord(1, "step 1"),
                userRecord(2, "third branch work", "2026-11-24T06:20:00Z"),
                plannerRecord(3, "third reply"),
                checkpointRecord(10, "reused step 10 cp", "2026-11-24T06:21:00Z"),
                userRecord(12, "abandoned post-cp10"),
                plannerRecord(13, "abandoned reply"),
                userRecord(12, "kept post-cp10", "2026-11-24T06:25:00Z"),
                plannerRecord(13, "kept reply"),
                checkpointRecord(15, "cp 15", "2026-11-24T06:26:00Z"),
            ]);
            await writeFile(transcriptPath, phase4);
            await writeFile(compactPath, phase4);

            const out4 = await processPreInvocation(baseInput, deps);
            assert.ok(out4.injectSteps && out4.injectSteps.length >= 1);
            assert.equal(calls.length, 4);
            assert.equal(calls[3].previousSummary, "## Brief\nSummary #3");
            assert.ok(calls[3].serialized.includes("kept post-cp10"));
            assert.ok(!calls[3].serialized.includes("abandoned post-cp10"));
            assert.ok(!calls[3].serialized.includes("third branch work"));
        } finally {
            await rm(brainDir, { recursive: true, force: true });
        }
    });

    it("auto-resolves fork parent via # User Requests, carries parent previousSummary, chains forks, and fails closed on ambiguity", async () => {
        const brainRoot = await mkdtemp(path.join(os.tmpdir(), "agy-gc-brainroot-"));
        async function writeSession(
            id: string,
            records: Record<string, unknown>[],
        ): Promise<{ transcriptPath: string; compactPath: string; statePath: string }> {
            const logsDir = path.join(brainRoot, id, ".system_generated", "logs");
            await mkdir(logsDir, { recursive: true });
            const raw = makeJsonl(records);
            const transcriptPath = path.join(logsDir, "transcript_full.jsonl");
            const compactPath = path.join(logsDir, "transcript.jsonl");
            await writeFile(transcriptPath, raw);
            await writeFile(compactPath, raw);
            return {
                transcriptPath,
                compactPath,
                statePath: path.join(brainRoot, id, ".system_generated", "grounded-compaction", "state.json"),
            };
        }

        try {
            const calls: Array<{ previousSummary?: string; serialized: string; missingPrefixBeforeStep?: number }> = [];
            const deps: HookDeps = {
                loadConfig: async () => baseConfig,
                loadPromptContract: async () => "# Contract",
                runSummarizer: async (req) => {
                    calls.push({
                        previousSummary: req.previousSummary,
                        serialized: req.serializedConversation,
                        missingPrefixBeforeStep: req.missingPrefixBeforeStep,
                    });
                    return {
                        summary: `## Brief\nSummary #${calls.length}`,
                        model: "pi-claude/claude-opus-5-5",
                        thinkingLevel: "medium",
                        durationMs: 12,
                    };
                },
            };

            // 1. Parent compacts at step 4, then continues with step 6 before forking at step 8.
            const parentLongPrompt = `Originating Goal G1: build offline widget.\n${"constraint detail\n".repeat(40)}PREFORK_TAIL_77`;
            const parentCp1 = makeNativeCheckpointContent([
                `${parentLongPrompt.slice(0, 50)}\n<truncated 500 bytes>`,
                "/compact",
            ]);
            const parent = await writeSession("parent-1", [
                userRecord(0, parentLongPrompt, "2026-11-24T05:00:00Z"),
                plannerRecord(1, "reading spec", [{ name: "read_file", args: { Path: "/repo/spec.md" } }]),
                toolResultRecord(2, "spec text"),
                userRecord(3, "/compact"),
                checkpointRecord(4, parentCp1, "2026-11-24T05:05:00Z"),
            ]);
            await processPreInvocation(
                { conversationId: "parent-1", transcriptPath: parent.transcriptPath, invocationNum: 0, lastUserInput: "go" },
                deps,
            );
            assert.equal(calls.length, 1);

            // Parent does post-compaction work at steps 6-7 (and later continues separately at step 8+).
            await writeSession("parent-1", [
                userRecord(0, parentLongPrompt, "2026-11-24T05:00:00Z"),
                plannerRecord(1, "reading spec", [{ name: "read_file", args: { Path: "/repo/spec.md" } }]),
                toolResultRecord(2, "spec text"),
                userRecord(3, "/compact"),
                checkpointRecord(4, parentCp1, "2026-11-24T05:05:00Z"),
                userRecord(6, "explore approach A in parent", "2026-11-24T05:10:00Z"),
                plannerRecord(7, "approach A notes"),
                userRecord(8, "parent-only later message", "2026-11-24T05:30:00Z"),
                plannerRecord(9, "parent-only later reply"),
            ]);

            // 2. Child 1 forks from parent-1 at step 8, does approach B at steps 8-9, and compacts at step 11 (Scenario c).
            const child1Cp = makeNativeCheckpointContent([
                `${parentLongPrompt.slice(0, 50)}\n<truncated 500 bytes>`,
                "/compact",
                "explore approach A in parent",
                "try approach B in child-1",
                "/compact",
            ]);
            const child1 = await writeSession("child-1", [
                userRecord(8, "try approach B in child-1", "2026-11-24T05:15:00Z"),
                plannerRecord(9, "approach B reply", [{ name: "write_file", args: { Path: "/repo/b.ts" } }]),
                userRecord(10, "/compact"),
                checkpointRecord(11, child1Cp, "2026-11-24T05:16:00Z"),
            ]);

            const c1Out = await processPreInvocation(
                { conversationId: "child-1", transcriptPath: child1.transcriptPath, invocationNum: 0, lastUserInput: "next" },
                deps,
            );
            assert.equal(calls.length, 2);
            // Inherited parent-1's grounded summary from step 4!
            assert.equal(calls[1].previousSummary, "## Brief\nSummary #1");
            assert.equal(calls[1].missingPrefixBeforeStep, undefined);
            // Serialized span covers (4, 11): parent's steps 6-7 + child-1's steps 8-9, NOT parent-only step 8!
            assert.ok(calls[1].serialized.includes("explore approach A in parent"));
            assert.ok(calls[1].serialized.includes("try approach B in child-1"));
            assert.ok(!calls[1].serialized.includes("parent-only later message"));

            const c1Injected = (c1Out.injectSteps ?? []).map((s) => s.systemMessage.systemMessage).join("\n");
            // Header lists BOTH parent-1 and child-1 transcript paths for Retrieval cues.
            assert.ok(c1Injected.includes(parent.transcriptPath));
            assert.ok(c1Injected.includes(child1.transcriptPath));
            assert.ok(c1Injected.includes("authoritative"));
            // Verbatim user messages retain truncated parentLongPrompt (with PREFORK_TAIL_77) while deduping untruncated prompts!
            assert.ok(c1Injected.includes("PREFORK_TAIL_77"));
            assert.ok(!c1Injected.includes("```step-6 "));
            assert.ok(!c1Injected.includes("```step-8 "));

            // 3. Chained fork: child-2 forks from child-1 at step 12, does work at step 12, compacts at step 14.
            const child2Cp = makeNativeCheckpointContent([
                `${parentLongPrompt.slice(0, 50)}\n<truncated 500 bytes>`,
                "/compact",
                "explore approach A in parent",
                "try approach B in child-1",
                "/compact",
                "refine approach B in child-2",
                "/compact",
            ]);
            const child2 = await writeSession("child-2", [
                userRecord(12, "refine approach B in child-2", "2026-11-24T05:20:00Z"),
                plannerRecord(13, "refined B"),
                userRecord(14, "/compact"),
                checkpointRecord(15, child2Cp, "2026-11-24T05:21:00Z"),
            ]);
            const c2Out = await processPreInvocation(
                { conversationId: "child-2", transcriptPath: child2.transcriptPath, invocationNum: 0, lastUserInput: "next" },
                deps,
            );
            assert.equal(calls.length, 3);
            // Inherited child-1's Summary #2 and walks parent-1 -> child-1 -> child-2!
            assert.equal(calls[2].previousSummary, "## Brief\nSummary #2");
            assert.equal(calls[2].missingPrefixBeforeStep, undefined);
            const c2Injected = (c2Out.injectSteps ?? []).map((s) => s.systemMessage.systemMessage).join("\n");
            assert.ok(c2Injected.includes(parent.transcriptPath));
            assert.ok(c2Injected.includes(child1.transcriptPath));
            assert.ok(c2Injected.includes(child2.transcriptPath));

            // 4. Ambiguous fork (two siblings share identical pre-fork prompt) MUST fail closed!
            await writeSession("ambig-a", [userRecord(0, "same generic prompt"), plannerRecord(1, "r1")]);
            await writeSession("ambig-b", [userRecord(0, "same generic prompt"), plannerRecord(1, "r2")]);
            const ambigChildCp = makeNativeCheckpointContent([
                "same generic prompt",
                "post-fork unique work",
                "/compact",
            ]);
            const ambigChild = await writeSession("ambig-child", [
                userRecord(2, "post-fork unique work", "2026-11-24T06:00:00Z"),
                plannerRecord(3, "working"),
                userRecord(4, "/compact"),
                checkpointRecord(5, ambigChildCp, "2026-11-24T06:01:00Z"),
            ]);
            const ambigOut = await processPreInvocation(
                { conversationId: "ambig-child", transcriptPath: ambigChild.transcriptPath, invocationNum: 0, lastUserInput: "next" },
                deps,
            );
            assert.equal(calls.length, 4);
            assert.equal(calls[3].missingPrefixBeforeStep, 2);
            const ambigInjected = (ambigOut.injectSteps ?? []).map((s) => s.systemMessage.systemMessage).join("\n");
            assert.ok(ambigInjected.includes("post-fork steps 2..4 only"));
            assert.ok(ambigInjected.includes("pre-fork history (steps 0..1) was unavailable"));
            assert.ok(!ambigInjected.includes("ambig-a"));
            assert.ok(!ambigInjected.includes("ambig-b"));
        } finally {
            await rm(brainRoot, { recursive: true, force: true });
        }
    });
});
