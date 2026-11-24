import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { parseCliArgs, runAsk, runLineage, type AskRunnerDeps } from "./cli.ts";
import {
    loadSessionAskSettings,
    loadSessionLineage,
    parseAgentDefinition,
    renderSessionTranscript,
} from "./session.ts";

interface FixtureToolCall {
    readonly name: string;
    readonly args: { readonly Path: string };
}

interface FixtureRecord {
    readonly step_index: number;
    readonly source: string;
    readonly type: string;
    readonly status: string;
    readonly created_at: string;
    readonly content: string;
    tool_calls?: readonly FixtureToolCall[];
    error?: string;
}

function makeJsonl(records: readonly FixtureRecord[]): string {
    return `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
}

function userRecord(stepIndex: number, text: string, createdAt = "2026-11-24T06:00:00Z"): FixtureRecord {
    return {
        step_index: stepIndex,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        status: "DONE",
        created_at: createdAt,
        content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nlocal time\n</ADDITIONAL_METADATA>`,
    };
}

function plannerRecord(
    stepIndex: number,
    content: string,
    toolCalls?: readonly FixtureToolCall[],
    createdAt = "2026-11-24T06:00:05Z",
): FixtureRecord {
    const rec: FixtureRecord = {
        step_index: stepIndex,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: createdAt,
        content,
    };
    if (toolCalls) {
        rec.tool_calls = toolCalls;
    }
    return rec;
}

function toolResultRecord(stepIndex: number, content: string, status = "DONE", error?: string): FixtureRecord {
    const rec: FixtureRecord = {
        step_index: stepIndex,
        source: "SYSTEM",
        type: "GENERIC",
        status,
        created_at: "2026-11-24T06:00:06Z",
        content,
    };
    if (error) {
        rec.error = error;
    }
    return rec;
}

function checkpointRecord(stepIndex: number, requests: readonly string[], createdAt = "2026-11-24T06:05:00Z"): FixtureRecord {
    const numbered = requests.map((r, i) => `${i + 1}. ${r}`).join("\n");
    return {
        step_index: stepIndex,
        source: "SYSTEM",
        type: "CHECKPOINT",
        status: "DONE",
        created_at: createdAt,
        content: [
            "# Resuming from a compaction",
            "",
            "# User Requests",
            "The following were user requests from the truncated conversation in chronological order:",
            numbered,
            "",
            "<summary>\nnative summary\n</summary>",
        ].join("\n"),
    };
}

describe("agy-session-ask CLI argument parsing and config loading", () => {
    it("parses lineage and ask subcommands with options cleanly", () => {
        const lineage = parseCliArgs(["lineage", "--cid", "abc-123", "--json"]);
        assert.deepEqual(lineage, {
            kind: "lineage",
            cid: "abc-123",
            json: true,
        });

        const ask = parseCliArgs([
            "ask",
            "--path",
            "~/brain/x/transcript_full.jsonl",
            "--no-ancestors",
            "--model",
            "openai-codex/gpt-6-luna",
            "--thinking",
            "high",
            "What",
            "timeout",
            "was",
            "chosen?",
        ]);
        assert.deepEqual(ask, {
            kind: "ask",
            path: "~/brain/x/transcript_full.jsonl",
            includeAncestors: false,
            model: "openai-codex/gpt-6-luna",
            thinking: "high",
            question: "What timeout was chosen?",
        });

        assert.equal(parseCliArgs(["--help"]).kind, "help");
        assert.equal(parseCliArgs(["ask", "--cid", "abc"]).kind, "error");
        assert.equal(parseCliArgs(["ask", "missing target"]).kind, "error");
    });

    it("parses agent frontmatter including thinking levels supported by pi CLI", () => {
        const parsed = parseAgentDefinition([
            "---",
            "name: session-ask-analyst",
            "model: openai-codex/gpt-5.6-luna",
            "thinking: max",
            "---",
            "",
            "You are a session transcript analyst.",
        ].join("\n"));

        assert.equal(parsed.model, "openai-codex/gpt-5.6-luna");
        assert.equal(parsed.thinkingLevel, "max");
        assert.equal(parsed.body, "You are a session transcript analyst.");
    });

    it("loads real extensions/session-ask/config.json and agents/session-ask-analyst.md", async () => {
        const settings = await loadSessionAskSettings();
        assert.ok(settings.model.includes("/"));
        assert.ok(settings.systemPrompt.includes("session transcript analyst"));
        assert.ok(settings.toolResultMaxChars > 0);
    });
});

describe("agy-session-ask lineage resolution, rewind pruning, and rendering", () => {
    it("resolves parent->child fork lineage via state.json or CHECKPOINT and renders clean step-indexed transcript", async () => {
        const brainRoot = await mkdtemp(path.join(os.tmpdir(), "agy-sa-brain-"));
        async function writeSession(id: string, records: readonly FixtureRecord[]): Promise<string> {
            const logsDir = path.join(brainRoot, id, ".system_generated", "logs");
            await mkdir(logsDir, { recursive: true });
            const fullPath = path.join(logsDir, "transcript_full.jsonl");
            const raw = makeJsonl(records);
            await writeFile(fullPath, raw);
            await writeFile(path.join(logsDir, "transcript.jsonl"), raw);
            return fullPath;
        }

        try {
            await writeSession("parent-a", [
                userRecord(0, "Original secret deadline: Nov 30, 2026."),
                plannerRecord(1, "Noted deadline.", [{ name: "read_file", args: { Path: "/repo/plan.md" } }]),
                toolResultRecord(2, "PLAN_CONTENT_XYZ"),
                userRecord(3, "abandoned wrong turn"),
                plannerRecord(4, "abandoned reply"),
                userRecord(3, "Keep strict JSON logs.", "2026-11-24T06:02:00Z"),
                plannerRecord(4, "Confirmed strict JSON logs."),
            ]);

            await writeSession("child-b", [
                userRecord(5, "Forked follow-up question."),
                plannerRecord(6, "Forked answer."),
                userRecord(7, "/compact"),
                checkpointRecord(8, [
                    "Original secret deadline: Nov 30, 2026.",
                    "Keep strict JSON logs.",
                    "Forked follow-up question.",
                    "/compact",
                ]),
            ]);

            const lineage = await loadSessionLineage({
                cid: "child-b",
                brainRoot,
                includeAncestors: true,
            });
            assert.equal(lineage.kind, "complete");
            assert.equal(lineage.segments.length, 2);
            assert.equal(lineage.segments[0].conversationId, "parent-a");
            assert.equal(lineage.segments[1].conversationId, "child-b");

            const rendered = renderSessionTranscript(lineage.records, { toolResultMaxChars: 500 });
            assert.ok(rendered.includes("[step 0] USER"));
            assert.ok(rendered.includes("Original secret deadline: Nov 30, 2026."));
            assert.ok(rendered.includes("Keep strict JSON logs."));
            assert.ok(rendered.includes("Forked follow-up question."));
            assert.ok(!rendered.includes("abandoned wrong turn"));
            assert.ok(rendered.includes("[step 8] CHECKPOINT"));
            assert.ok(!rendered.includes("native summary"));

            const lineageText = await runLineage({ kind: "lineage", cid: "child-b", json: false, brainRoot });
            assert.ok(lineageText.includes("parent-a"));
            assert.ok(lineageText.includes("child-b"));

            const calls: Array<{ mode: "inline" | "tools"; promptLength: number; hasTranscriptFile: boolean }> = [];
            const deps: AskRunnerDeps = {
                runPiQuery: async (req) => {
                    calls.push({
                        mode: req.mode,
                        promptLength: req.userPrompt.length,
                        hasTranscriptFile: Boolean(req.transcriptDir),
                    });
                    return { answer: "**Answer**\nNov 30, 2026 [step 0].", model: req.model, durationMs: 10 };
                },
            };

            const answerSmall = await runAsk(
                {
                    kind: "ask",
                    cid: "child-b",
                    includeAncestors: true,
                    brainRoot,
                    question: "What was the original deadline?",
                },
                deps,
            );
            assert.ok(answerSmall.includes("Nov 30, 2026"));
            assert.equal(calls.length, 1);
            assert.equal(calls[0].mode, "inline");
            assert.equal(calls[0].hasTranscriptFile, false);

            const answerLarge = await runAsk(
                {
                    kind: "ask",
                    cid: "child-b",
                    includeAncestors: true,
                    brainRoot,
                    question: "What was the original deadline?",
                },
                { ...deps, inlineThresholdChars: 50 },
            );
            assert.ok(answerLarge.includes("Nov 30, 2026"));
            assert.equal(calls.length, 2);
            assert.equal(calls[1].mode, "tools");
            assert.equal(calls[1].hasTranscriptFile, true);
        } finally {
            await rm(brainRoot, { recursive: true, force: true });
        }
    });

    it("reports unresolved fork prefix honestly when parent cannot be matched", async () => {
        const brainRoot = await mkdtemp(path.join(os.tmpdir(), "agy-sa-unres-"));
        try {
            const logsDir = path.join(brainRoot, "orphan-fork", ".system_generated", "logs");
            await mkdir(logsDir, { recursive: true });
            const raw = makeJsonl([
                userRecord(20, "only post-fork prompt"),
                plannerRecord(21, "post-fork reply"),
            ]);
            await writeFile(path.join(logsDir, "transcript_full.jsonl"), raw);
            await writeFile(path.join(logsDir, "transcript.jsonl"), raw);

            const lineage = await loadSessionLineage({
                cid: "orphan-fork",
                brainRoot,
                includeAncestors: true,
            });
            assert.equal(lineage.kind, "forked-unresolved");
            assert.equal(lineage.firstStepIndex, 20);
        } finally {
            await rm(brainRoot, { recursive: true, force: true });
        }
    });
});
