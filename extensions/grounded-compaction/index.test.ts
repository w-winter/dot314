import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
    convertToLlm,
    serializeConversation,
    type SessionBeforeCompactEvent,
    type SessionBeforeTreeEvent,
    type SessionEntry,
} from "@earendil-works/pi-coding-agent";

import {
    DEFAULT_COMPACTION_PROMPT_CONTRACT,
    DEFAULT_CONFIG,
    DEFAULT_SYSTEM_PROMPT,
    buildBranchSummaryInstructions,
    buildSummaryUserPrompt,
    deriveSummaryEntrySpans,
    estimateInputTokens,
    formatManifestOperations,
    getEffectiveThinkingLevel,
    loadBranchSummaryPromptContract,
    loadCompactionPromptContract,
    loadConfig,
    parseCompactInstructions,
    parseConfig,
    renderFilesTouchedManifestBlock,
    resolvePresetMatch,
    runGroundedBranchSummaryAugmentation,
    runGroundedCompaction,
    serializePreparedMessages,
    stripGroundedCompactionManifestTail,
    type GroundedCompactionConfig,
} from "./index.ts";

type TestContext = {
    hasUI: boolean;
    ui: {
        notify(message: string, level?: string): void;
    };
    model?: Model<Api>;
    cwd?: string | null;
    modelRegistry: {
        getAll(): Model<Api>[];
        getApiKeyAndHeaders(model: Model<Api>): Promise<
            | { ok: true; apiKey?: string; headers?: Record<string, string> }
            | { ok: false; error: string }
        >;
    };
};

type GroundedRunDeps = NonNullable<Parameters<typeof runGroundedCompaction>[2]>;

const tempDirs: string[] = [];

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function createModel(overrides?: Partial<Model<Api>>): Model<Api> {
    return {
        id: "claude-sonnet-4",
        name: "Claude Sonnet 4",
        provider: "anthropic",
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        reasoning: true,
        input: ["text"],
        cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
        },
        contextWindow: 200_000,
        maxTokens: 8_000,
        ...overrides,
    };
}

function createAssistantResponse(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-sonnet-4",
        usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
            },
        },
        stopReason,
        timestamp: Date.now(),
    };
}

function messageEntry(id: string, role: "user" | "assistant" | "toolResult", text: string): SessionEntry {
    if (role === "toolResult") {
        return {
            id,
            type: "message",
            message: {
                role,
                toolCallId: `tool-${id}`,
                toolName: "read",
                content: [{ type: "text", text }],
                isError: false,
                timestamp: Date.now(),
            },
        } as SessionEntry;
    }

    return {
        id,
        type: "message",
        message: {
            role,
            content: [{ type: "text", text }],
            timestamp: Date.now(),
            ...(role === "assistant"
                ? {
                    api: "anthropic-messages",
                    provider: "anthropic",
                    model: "claude-sonnet-4",
                    usage: {
                        input: 0,
                        output: 0,
                        cacheRead: 0,
                        cacheWrite: 0,
                        totalTokens: 0,
                        cost: {
                            input: 0,
                            output: 0,
                            cacheRead: 0,
                            cacheWrite: 0,
                            total: 0,
                        },
                    },
                    stopReason: "stop",
                }
                : {}),
        },
    } as SessionEntry;
}

function thinkingEntry(level: string): SessionEntry {
    return {
        id: `thinking-${level}`,
        type: "thinking_level_change",
        thinkingLevel: level,
        timestamp: new Date().toISOString(),
    } as SessionEntry;
}

function customMessageEntry(id: string, text: string): SessionEntry {
    return {
        id,
        type: "custom_message",
        customType: "note",
        content: text,
        display: "full",
        timestamp: new Date().toISOString(),
    } as SessionEntry;
}

function compactionEntry(id: string, summary: string, firstKeptEntryId = "first-kept"): SessionEntry {
    return {
        id,
        type: "compaction",
        summary,
        firstKeptEntryId,
        tokensBefore: 100,
        timestamp: new Date().toISOString(),
    } as SessionEntry;
}

function createContext(
    models: Model<Api>[],
    currentModel = models[0],
    authFailures: ReadonlySet<string> = new Set(),
): {
    ctx: TestContext;
    notifications: string[];
    notificationLevels: Array<{ message: string; level?: string }>;
    authLookups: string[];
} {
    const notifications: string[] = [];
    const notificationLevels: Array<{ message: string; level?: string }> = [];
    const authLookups: string[] = [];

    return {
        notifications,
        notificationLevels,
        authLookups,
        ctx: {
            hasUI: true,
            ui: {
                notify(message, level) {
                    notifications.push(message);
                    notificationLevels.push({ message, level });
                },
            },
            model: currentModel,
            cwd: "/repo",
            modelRegistry: {
                getAll() {
                    return models;
                },
                async getApiKeyAndHeaders(model) {
                    const reference = `${model.provider}/${model.id}`;
                    authLookups.push(reference);
                    if (authFailures.has(reference)) {
                        return { ok: false as const, error: `no credentials for ${reference}` };
                    }
                    return { ok: true as const, apiKey: "test-key" };
                },
            },
        },
    };
}

function createEvent(overrides?: Partial<SessionBeforeCompactEvent>): SessionBeforeCompactEvent {
    const historyEntry = messageEntry("history-user", "user", "Fix the failing tests");
    const keptEntry = messageEntry("kept-assistant", "assistant", "Investigating");

    return {
        type: "session_before_compact",
        customInstructions: undefined,
        signal: new AbortController().signal,
        branchEntries: [historyEntry, keptEntry],
        preparation: {
            firstKeptEntryId: keptEntry.id,
            messagesToSummarize: [historyEntry.message],
            turnPrefixMessages: [],
            isSplitTurn: false,
            tokensBefore: 321,
            previousSummary: undefined,
            fileOps: {
                read: new Set(),
                write: new Set(),
                edit: new Set(),
                delete: new Set(),
                move: [],
            },
            settings: {
                enabled: true,
                reserveTokens: 800,
                keepRecentTokens: 400,
            },
        },
        ...overrides,
    } as SessionBeforeCompactEvent;
}

function createTreeEvent(overrides?: Partial<SessionBeforeTreeEvent>): SessionBeforeTreeEvent {
    const branchEntries = [
        messageEntry("tree-user", "user", "Check branch work"),
        messageEntry("tree-assistant", "assistant", "Investigating tree summary"),
    ];

    return {
        type: "session_before_tree",
        signal: new AbortController().signal,
        preparation: {
            targetId: "target-1",
            oldLeafId: "leaf-1",
            commonAncestorId: "ancestor-1",
            entriesToSummarize: branchEntries,
            userWantsSummary: true,
            customInstructions: undefined,
            replaceInstructions: false,
            label: undefined,
        },
        ...overrides,
    } as SessionBeforeTreeEvent;
}

function createTestConfig(overrides: Partial<GroundedCompactionConfig> = {}): GroundedCompactionConfig {
    return {
        includeFilesTouched: {
            inCompactionSummary: false,
            inBranchSummary: false,
        },
        defaultPreset: "current",
        toolResultChars: null,
        presets: {},
        ...overrides,
    };
}

function createDeps(overrides: Partial<GroundedRunDeps> = {}): GroundedRunDeps {
    return {
        complete: async () => createAssistantResponse("summary"),
        collectFilesTouched: () => [],
        loadConfig: async () => createTestConfig(),
        loadCompactionPrompt: async () => "Keep it concise",
        loadBranchSummaryPrompt: async () => undefined,
        ...overrides,
    };
}

describe("grounded-compaction parsing", () => {
    it("parses plain focus text without a preset", () => {
        assert.deepEqual(parseCompactInstructions("focus on parser regressions"), {
            usesPresetDirective: false,
            focusText: "focus on parser regressions",
        });
    });

    it("parses a preset and preserves trailing focus text", () => {
        assert.deepEqual(parseCompactInstructions("--preset cheap focus on parser regressions"), {
            usesPresetDirective: true,
            presetQuery: "cheap",
            focusText: "focus on parser regressions",
        });
    });

    it("parses the -p preset alias and preserves trailing focus text", () => {
        assert.deepEqual(parseCompactInstructions("-p cheap focus on parser regressions"), {
            usesPresetDirective: true,
            presetQuery: "cheap",
            focusText: "focus on parser regressions",
        });
    });

    it("treats malformed leading preset syntax as a consumed directive", () => {
        assert.deepEqual(parseCompactInstructions("--preset"), {
            usesPresetDirective: true,
        });
        assert.deepEqual(parseCompactInstructions("-p"), {
            usesPresetDirective: true,
        });
    });
});

describe("grounded-compaction config", () => {
    it("parses valid config and preserves defaults when optional fields are omitted", () => {
        assert.deepEqual(parseConfig({}), DEFAULT_CONFIG);
    });

    it("normalizes boolean includeFilesTouched across both features", () => {
        assert.deepEqual(parseConfig({ includeFilesTouched: false }).includeFilesTouched, {
            inCompactionSummary: false,
            inBranchSummary: false,
        });
    });

    it("accepts explicit per-feature includeFilesTouched settings", () => {
        assert.deepEqual(
            parseConfig({
                includeFilesTouched: {
                    inCompactionSummary: true,
                    inBranchSummary: false,
                },
            }).includeFilesTouched,
            {
                inCompactionSummary: true,
                inBranchSummary: false,
            },
        );
    });

    it("rejects partial includeFilesTouched objects", () => {
        assert.throws(() => {
            parseConfig({
                includeFilesTouched: {
                    inCompactionSummary: true,
                },
            });
        }, /includeFilesTouched\.inBranchSummary must be a boolean/);
    });

    it("rejects a defaultPreset that is neither current nor a declared preset", () => {
        assert.throws(() => {
            parseConfig({
                includeFilesTouched: true,
                defaultPreset: "fast",
                presets: {},
            });
        }, /defaultPreset 'fast' was not found in presets/);
    });

    it("rejects malformed preset entries", () => {
        assert.throws(() => {
            parseConfig({
                includeFilesTouched: true,
                presets: {
                    cheap: {
                        model: "",
                    },
                },
            });
        }, /preset 'cheap' must define model/);
    });

    it("loads missing config and prompt files from embedded defaults", async () => {
        const tempDir = await mkdtemp(path.join(os.tmpdir(), "grounded-compaction-test-"));
        tempDirs.push(tempDir);

        await assert.doesNotReject(async () => {
            const loadedConfig = await loadConfig(tempDir);
            const compactionPrompt = await loadCompactionPromptContract(tempDir);
            const branchSummaryPrompt = await loadBranchSummaryPromptContract(tempDir);
            assert.deepEqual(loadedConfig, DEFAULT_CONFIG);
            assert.equal(compactionPrompt, DEFAULT_COMPACTION_PROMPT_CONTRACT);
            assert.equal(branchSummaryPrompt, undefined);
        });
    });

    it("loads compaction prompt overrides but falls back when the file is blank", async () => {
        const tempDir = await mkdtemp(path.join(os.tmpdir(), "grounded-compaction-test-"));
        tempDirs.push(tempDir);

        await writeFile(path.join(tempDir, "compaction-prompt.md"), "\n\n", "utf8");
        assert.equal(await loadCompactionPromptContract(tempDir), DEFAULT_COMPACTION_PROMPT_CONTRACT);

        await writeFile(path.join(tempDir, "compaction-prompt.md"), "Use bullet points", "utf8");
        assert.equal(await loadCompactionPromptContract(tempDir), "Use bullet points");
    });

    it("treats missing or blank branch-summary prompts as absent", async () => {
        const tempDir = await mkdtemp(path.join(os.tmpdir(), "grounded-compaction-test-"));
        tempDirs.push(tempDir);

        assert.equal(await loadBranchSummaryPromptContract(tempDir), undefined);

        await writeFile(path.join(tempDir, "branch-summary-prompt.md"), "\n\n", "utf8");
        assert.equal(await loadBranchSummaryPromptContract(tempDir), undefined);

        await writeFile(path.join(tempDir, "branch-summary-prompt.md"), "Use this contract", "utf8");
        assert.equal(await loadBranchSummaryPromptContract(tempDir), "Use this contract");
    });

    it("accepts a declared defaultPreset", () => {
        const config = parseConfig({
            includeFilesTouched: true,
            defaultPreset: "fast",
            presets: {
                fast: {
                    model: "openai-codex/gpt-5.4-mini",
                    thinkingLevel: "medium",
                },
            },
        });

        assert.equal(config.defaultPreset, "fast");
    });

    it("accepts an exact declared largeContextPreset", () => {
        const config = parseConfig({
            defaultPreset: "fast",
            largeContextPreset: "large",
            presets: {
                fast: { model: "openai-codex/gpt-5.4-mini" },
                large: { model: "openai-codex/gpt-5.4" },
            },
        });

        assert.equal(config.largeContextPreset, "large");
    });

    it("uses full tool results by default and accepts a positive character limit", () => {
        assert.equal(parseConfig({}).toolResultChars, null);
        assert.equal(parseConfig({ toolResultChars: null }).toolResultChars, null);
        assert.equal(parseConfig({ toolResultChars: 8_000 }).toolResultChars, 8_000);
    });

    it("rejects invalid toolResultChars values", () => {
        for (const toolResultChars of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "2000"]) {
            assert.throws(
                () => parseConfig({ toolResultChars }),
                /toolResultChars must be null or a positive integer/,
            );
        }
    });

    it("rejects invalid largeContextPreset references", () => {
        const presets = {
            fast: { model: "openai-codex/gpt-5.4-mini" },
            large: { model: "openai-codex/gpt-5.4" },
        };

        assert.throws(
            () => parseConfig({ defaultPreset: "fast", largeContextPreset: " ", presets }),
            /largeContextPreset must be a non-empty string/,
        );
        assert.throws(
            () => parseConfig({ defaultPreset: "fast", largeContextPreset: "Large", presets }),
            /largeContextPreset 'Large' was not found in presets/,
        );
        assert.throws(
            () => parseConfig({ defaultPreset: "fast", largeContextPreset: "fast", presets }),
            /largeContextPreset must differ from defaultPreset/,
        );
        assert.throws(
            () => parseConfig({ defaultPreset: "fast", largeContextPreset: 5, presets }),
            /largeContextPreset must be a non-empty string/,
        );
    });
});

describe("grounded-compaction preset resolution", () => {
    const presets: GroundedCompactionConfig["presets"] = {
        cheap: { model: "google/gemini-2.5-flash" },
        CheapCase: { model: "google/gemini-2.5-pro" },
        expensive: { model: "anthropic/claude-sonnet-4" },
        "fast-debug": { model: "openrouter/deepseek" },
    };

    it("matches exact case-sensitive names first", () => {
        const result = resolvePresetMatch(presets, "cheap");
        assert.equal(result.kind, "matched");
        assert.equal(result.name, "cheap");
    });

    it("supports deterministic prefix and normalized substring matching", () => {
        assert.equal(resolvePresetMatch(presets, "exp").name, "expensive");
        assert.equal(resolvePresetMatch(presets, "debug").name, "fast-debug");
    });

    it("treats ambiguous matches as ambiguous", () => {
        const result = resolvePresetMatch(presets, "cheapcase");
        assert.equal(result.kind, "matched");
        assert.equal(result.name, "CheapCase");

        const ambiguous = resolvePresetMatch(
            {
                alpha: { model: "a/b" },
                alpine: { model: "c/d" },
            },
            "alp",
        );
        assert.equal(ambiguous.kind, "ambiguous");
    });
});

describe("grounded-compaction summary spans", () => {
    it("derives stock history span for non-split compaction", () => {
        const entries = [
            compactionEntry("old-compaction", "older", "custom-1"),
            customMessageEntry("custom-1", "carry context"),
            messageEntry("assistant-1", "assistant", "done"),
            messageEntry("keep-1", "assistant", "keep this"),
        ];

        const spans = deriveSummaryEntrySpans({
            branchEntries: entries,
            firstKeptEntryId: "keep-1",
            isSplitTurn: false,
        });

        assert.equal(spans.boundaryStart, 1);
        assert.deepEqual(spans.historyEntries.map((entry) => entry.id), ["custom-1", "assistant-1"]);
        assert.deepEqual(spans.turnPrefixEntries, []);
    });

    it("resumes repeated compactions from the previous kept boundary", () => {
        const entries = [
            messageEntry("dropped-user", "user", "Already compacted away"),
            messageEntry("kept-user", "user", "Still in context after the last compaction"),
            messageEntry("kept-assistant", "assistant", "Still in context too"),
            compactionEntry("old-compaction", "older", "kept-user"),
            customMessageEntry("fresh-note", "Fresh work after the prior compaction"),
            messageEntry("keep-1", "assistant", "Keep this newest reply"),
        ];

        const spans = deriveSummaryEntrySpans({
            branchEntries: entries,
            firstKeptEntryId: "keep-1",
            isSplitTurn: false,
        });

        assert.equal(spans.boundaryStart, 1);
        assert.deepEqual(
            spans.historyEntries.map((entry) => entry.id),
            ["kept-user", "kept-assistant", "old-compaction", "fresh-note"],
        );
    });

    it("derives history and turn-prefix spans for split turns", () => {
        const entries = [
            messageEntry("old-user", "user", "Previous turn"),
            messageEntry("old-assistant", "assistant", "Previous answer"),
            customMessageEntry("turn-start", "User note for current turn"),
            messageEntry("kept", "assistant", "Suffix to keep"),
        ];

        const spans = deriveSummaryEntrySpans({
            branchEntries: entries,
            firstKeptEntryId: "kept",
            isSplitTurn: true,
        });

        assert.deepEqual(spans.historyEntries.map((entry) => entry.id), ["old-user", "old-assistant"]);
        assert.deepEqual(spans.turnPrefixEntries.map((entry) => entry.id), ["turn-start"]);
    });
});

describe("grounded-compaction prompt assembly", () => {
    it("prepends stronger update guidance when previousSummary exists", () => {
        const prompt = buildSummaryUserPrompt({
            mode: "history",
            promptContract: DEFAULT_COMPACTION_PROMPT_CONTRACT,
            serializedConversation: "[User]: hi",
            previousSummary: "Older summary",
        });

        assert.match(prompt, /## Update instructions/);
        assert.match(prompt, /Preserve still-valid information from the previous compaction summary/);
        assert.match(prompt, /## Previous compaction summary/);
    });

    it("prepends a stock-like split-turn contract ahead of the shared prompt contract", () => {
        const prompt = buildSummaryUserPrompt({
            mode: "turn-prefix",
            promptContract: DEFAULT_COMPACTION_PROMPT_CONTRACT,
            serializedConversation: "[User]: hi",
        });

        assert.match(prompt, /## Split-turn instructions/);
        assert.match(prompt, /Original request/);
        assert.match(prompt, /Early progress/);
        assert.match(prompt, /Context needed to understand the kept suffix/);
        assert.match(prompt, /Do not present this as a full-session status report/);
        assert.match(prompt, /## Shared prompt contract/);
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
        const parityMessages = [
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
        ] as Parameters<typeof convertToLlm>[0];

        assert.equal(
            serializePreparedMessages(parityMessages, 2_000),
            serializeConversation(convertToLlm(parityMessages)),
        );
    });
});

describe("grounded-compaction branch-summary instruction builder", () => {
    it("returns undefined when neither a prompt contract nor manifest is present", () => {
        assert.equal(buildBranchSummaryInstructions({ focusText: "keep parser detail" }), undefined);
    });

    it("uses replaceInstructions when a branch-summary prompt contract exists", () => {
        const result = buildBranchSummaryInstructions({
            promptContract: "# Contract\nUse this shape",
            focusText: "Focus on parser regressions",
            filesTouchedManifestBlock: "## Files touched\nR=read, W=write, E=edit, M=move/rename, D=delete\n\n```text\nR  src/a.ts\n```",
        });

        assert.ok(result);
        assert.equal(result.replaceInstructions, true);
        assert.match(result.customInstructions, /# Contract/);
        assert.match(result.customInstructions, /## Additional focus/);
        assert.match(result.customInstructions, /Focus on parser regressions/);
        assert.match(result.customInstructions, /## Authoritative files touched/);
        assert.match(result.customInstructions, /Reproduce it verbatim/);
    });

    it("uses additive instructions when only files grounding is active", () => {
        const result = buildBranchSummaryInstructions({
            focusText: "Focus on parser regressions",
            filesTouchedManifestBlock: "## Files touched\nR=read, W=write, E=edit, M=move/rename, D=delete\n\n```text\nR  src/a.ts\n```",
        });

        assert.ok(result);
        assert.equal(result.replaceInstructions, false);
        assert.match(result.customInstructions, /^Also include the authoritative files-touched block below/);
        assert.match(result.customInstructions, /User focus:/);
        assert.match(result.customInstructions, /Focus on parser regressions/);
        assert.match(result.customInstructions, /Authoritative files touched: reproduce this block verbatim/);
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
        assert.equal(
            stripGroundedCompactionManifestTail(
                `Summary\n\n---\n\n## Files touched (cumulative)\nR=read, W=write, E=edit, M=move/rename, D=delete\n\n\`\`\`text\nRE src/a.ts\n\`\`\``,
            ),
            "Summary",
        );
    });
});

describe("grounded-compaction runtime", () => {
    it("uses a configured defaultPreset", async () => {
        const openAiModel = createModel({
            provider: "openai",
            api: "openai-responses",
            id: "gpt-5.4",
            name: "GPT-5.4",
        });
        const fastModel = createModel({
            provider: "openai-codex",
            api: "openai-codex-responses",
            id: "gpt-5.4-mini",
            name: "GPT-5.4 Mini",
        });
        const { ctx } = createContext([openAiModel, fastModel], openAiModel);
        const event = createEvent();

        let selectedModelId = "";
        const result = await runGroundedCompaction(event, ctx, createDeps({
            complete: async (model) => {
                selectedModelId = model.id;
                return createAssistantResponse("summary from configured default preset");
            },
            loadConfig: async () => createTestConfig({
                includeFilesTouched: {
                    inCompactionSummary: false,
                    inBranchSummary: false,
                },
                defaultPreset: "fast",
                presets: {
                    fast: {
                        model: "openai-codex/gpt-5.4-mini",
                        thinkingLevel: "medium",
                    },
                },
            }),
        }));

        assert.ok(result && "compaction" in result);
        assert.equal(selectedModelId, "gpt-5.4-mini");
        assert.deepEqual(result.compaction.details, {
            model: "openai-codex/gpt-5.4-mini",
            thinkingLevel: "medium",
        });
    });

    it("applies toolResultChars to the prompt used for compaction", async () => {
        const event = createEvent();
        const toolResult = messageEntry("history-tool", "toolResult", "abcdefghij");
        const model = createModel();
        const { ctx } = createContext([model]);
        let promptText = "";

        const result = await runGroundedCompaction(
            createEvent({
                branchEntries: [toolResult, ...event.branchEntries.slice(1)],
                preparation: {
                    ...event.preparation,
                    messagesToSummarize: [toolResult.message],
                },
            }),
            ctx,
            createDeps({
                complete: async (_model, context) => {
                    promptText = ((context.messages[0].content as Array<{ text?: string }>)[0].text ?? "") as string;
                    return createAssistantResponse("summary");
                },
                loadConfig: async () => createTestConfig({
                    includeFilesTouched: { inCompactionSummary: false, inBranchSummary: false },
                    defaultPreset: "current",
                    toolResultChars: 4,
                    presets: {},
                }),
            }),
        );

        assert.ok(result && "compaction" in result);
        assert.match(promptText, /\[Tool result\]: abcd\n\n\[\.\.\. 6 more characters truncated\]/);
        assert.equal(promptText.includes("abcdefghij"), false);
    });

    it("uses the configured tool-result limit when selecting the capacity route", async () => {
        const baseEvent = createEvent();
        const toolResult = messageEntry("capacity-tool", "toolResult", "x".repeat(4_000));
        const reserveTokens = 50;
        const event = createEvent({
            branchEntries: [toolResult, ...baseEvent.branchEntries.slice(1)],
            preparation: {
                ...baseEvent.preparation,
                messagesToSummarize: [toolResult.message],
                settings: { ...baseEvent.preparation.settings, reserveTokens },
            },
        });
        const cappedPrompt = buildSummaryUserPrompt({
            mode: "history",
            promptContract: "Keep it concise",
            serializedConversation: serializePreparedMessages(event.preparation.messagesToSummarize, 4),
        });
        const defaultModel = createModel({
            id: "default",
            contextWindow: estimateInputTokens(`${DEFAULT_SYSTEM_PROMPT}\n\n${cappedPrompt}`) + reserveTokens,
            maxTokens: reserveTokens,
        });
        const largeModel = createModel({
            provider: "openai-codex",
            id: "large",
            contextWindow: 1_000_000,
            maxTokens: 1_000,
        });
        const loadConfigWithLimit = (toolResultChars: number | null) => async () => createTestConfig({
            defaultPreset: "current",
            largeContextPreset: "large",
            toolResultChars,
            presets: { large: { model: "openai-codex/large" } },
        });

        const cappedContext = createContext([defaultModel, largeModel], defaultModel);
        const cappedCalls: string[] = [];
        const cappedResult = await runGroundedCompaction(event, cappedContext.ctx, createDeps({
            complete: async (model) => {
                cappedCalls.push(model.id);
                return createAssistantResponse("capped summary");
            },
            loadConfig: loadConfigWithLimit(4),
        }));

        assert.ok(cappedResult && "compaction" in cappedResult);
        assert.deepEqual(cappedCalls, ["default"]);
        assert.equal(cappedContext.authLookups.includes("openai-codex/large"), false);

        const fullContext = createContext([defaultModel, largeModel], defaultModel);
        const fullCalls: string[] = [];
        const fullResult = await runGroundedCompaction(event, fullContext.ctx, createDeps({
            complete: async (model) => {
                fullCalls.push(model.id);
                return createAssistantResponse("large summary");
            },
            loadConfig: loadConfigWithLimit(null),
        }));

        assert.ok(fullResult && "compaction" in fullResult);
        assert.deepEqual(fullCalls, ["large"]);
        assert.equal(fullContext.authLookups.includes("openai-codex/large"), true);
    });

    it("cancels an oversized ordinary request instead of falling through to Pi compaction", async () => {
        const tooSmallModel = createModel({ contextWindow: 100, maxTokens: 50 });
        const { ctx, notifications } = createContext([tooSmallModel]);
        let completeCalls = 0;

        const result = await runGroundedCompaction(createEvent(), ctx, createDeps({
            complete: async () => {
                completeCalls += 1;
                return createAssistantResponse("must not run");
            },
        }));

        assert.deepEqual(result, { cancel: true });
        assert.equal(completeCalls, 0);
        assert.match(notifications.at(-1) ?? "", /context window|capacity/i);
    });

    it("reroutes an oversized ordinary request before calling the default provider", async () => {
        const fastModel = createModel({
            provider: "openai-codex",
            id: "gpt-5.4-mini",
            contextWindow: 100,
            maxTokens: 50,
        });
        const largeModel = createModel({
            provider: "openai-codex",
            id: "gpt-5.4",
            contextWindow: 10_000,
            maxTokens: 800,
        });
        const { ctx, notifications, notificationLevels } = createContext([fastModel, largeModel], fastModel);
        const calledModels: string[] = [];

        const result = await runGroundedCompaction(createEvent(), ctx, createDeps({
            complete: async (model) => {
                calledModels.push(model.id);
                return createAssistantResponse("large summary");
            },
            loadConfig: async () => createTestConfig({
                includeFilesTouched: { inCompactionSummary: false, inBranchSummary: false },
                defaultPreset: "fast",
                largeContextPreset: "large",
                presets: {
                    fast: { model: "openai-codex/gpt-5.4-mini", thinkingLevel: "low" },
                    large: { model: "openai-codex/gpt-5.4", thinkingLevel: "medium" },
                },
            }),
        }));

        assert.deepEqual(calledModels, ["gpt-5.4"]);
        assert.ok(result && "compaction" in result);
        assert.deepEqual(result.compaction.details, {
            model: "openai-codex/gpt-5.4",
            thinkingLevel: "medium",
        });
        assert.match(notifications.at(-1) ?? "", /routing to large/i);
        assert.equal(notificationLevels.at(-1)?.level, "info");
    });

    it("requires the configured large model to have a strictly larger context window", async () => {
        for (const largeContextWindow of [100, 50]) {
            const fastModel = createModel({ id: "fast", contextWindow: 100, maxTokens: 50 });
            const candidateModel = createModel({
                provider: "anthropic",
                id: "large",
                contextWindow: largeContextWindow,
                maxTokens: 10,
            });
            const { ctx, notifications } = createContext([fastModel, candidateModel], fastModel);
            let completeCalls = 0;

            const result = await runGroundedCompaction(createEvent(), ctx, createDeps({
                complete: async () => {
                    completeCalls += 1;
                    return createAssistantResponse("must not run");
                },
                loadConfig: async () => createTestConfig({
                    includeFilesTouched: { inCompactionSummary: false, inBranchSummary: false },
                    defaultPreset: "current",
                    largeContextPreset: "large",
                    presets: { large: { model: "anthropic/large" } },
                }),
            }));

            assert.deepEqual(result, { cancel: true });
            assert.equal(completeCalls, 0);
            assert.match(notifications.at(-1) ?? "", /strictly larger context window/i);
        }
    });

    it("uses one large-context model for every split-turn summary call", async () => {
        const fastModel = createModel({ id: "fast", contextWindow: 500, maxTokens: 50 });
        const largeModel = createModel({ id: "large", contextWindow: 10_000, maxTokens: 500 });
        const { ctx } = createContext([fastModel, largeModel], fastModel);
        const oldUser = messageEntry("old-user", "user", "Short prior turn");
        const currentUser = messageEntry("current-user", "user", "x".repeat(2_000));
        const keptAssistant = messageEntry("kept-assistant", "assistant", "Kept suffix");
        const baseEvent = createEvent();
        const calledModels: string[] = [];
        const capturedBudgets: Array<number | undefined> = [];
        const event = createEvent({
            branchEntries: [oldUser, currentUser, keptAssistant],
            preparation: {
                ...baseEvent.preparation,
                firstKeptEntryId: keptAssistant.id,
                messagesToSummarize: [oldUser.message],
                turnPrefixMessages: [currentUser.message],
                isSplitTurn: true,
            },
        });

        const result = await runGroundedCompaction(event, ctx, createDeps({
            complete: async (model, _context, options) => {
                calledModels.push(model.id);
                capturedBudgets.push(options.maxTokens);
                return createAssistantResponse(model.id === "large" ? "large summary" : "unexpected summary");
            },
            loadConfig: async () => createTestConfig({
                includeFilesTouched: { inCompactionSummary: false, inBranchSummary: false },
                defaultPreset: "current",
                largeContextPreset: "large",
                presets: { large: { model: "anthropic/large" } },
            }),
        }));

        assert.ok(result && "compaction" in result);
        assert.deepEqual(calledModels, ["large", "large"]);
        assert.deepEqual(capturedBudgets, [500, 500]);
        assert.equal(result.compaction.details.model, "anthropic/large");
    });

    it("preflights every split-turn request before starting provider work", async () => {
        const model = createModel({ contextWindow: 500, maxTokens: 50 });
        const { ctx } = createContext([model]);
        const oldUser = messageEntry("old-user", "user", "Short prior turn");
        const currentUser = messageEntry("current-user", "user", "x".repeat(20_000));
        const keptAssistant = messageEntry("kept-assistant", "assistant", "Kept suffix");
        const baseEvent = createEvent();
        let completeCalls = 0;
        const event = createEvent({
            branchEntries: [oldUser, currentUser, keptAssistant],
            preparation: {
                ...baseEvent.preparation,
                firstKeptEntryId: keptAssistant.id,
                messagesToSummarize: [oldUser.message],
                turnPrefixMessages: [currentUser.message],
                isSplitTurn: true,
            },
        });

        const result = await runGroundedCompaction(event, ctx, createDeps({
            complete: async () => {
                completeCalls += 1;
                return createAssistantResponse("must not run");
            },
        }));

        assert.deepEqual(result, { cancel: true });
        assert.equal(completeCalls, 0);
    });

    it("keeps explicit presets authoritative instead of using largeContextPreset", async () => {
        const fastModel = createModel({
            provider: "openai-codex",
            id: "gpt-5.4-mini",
            contextWindow: 100,
            maxTokens: 50,
        });
        const largeModel = createModel({
            provider: "openai-codex",
            id: "gpt-5.4",
            contextWindow: 10_000,
            maxTokens: 800,
        });
        const { ctx } = createContext([fastModel, largeModel], fastModel);
        let completeCalls = 0;

        const result = await runGroundedCompaction(
            createEvent({ customInstructions: "-p fast" }),
            ctx,
            createDeps({
                complete: async () => {
                    completeCalls += 1;
                    return createAssistantResponse("must not run");
                },
                loadConfig: async () => createTestConfig({
                    includeFilesTouched: { inCompactionSummary: false, inBranchSummary: false },
                    defaultPreset: "fast",
                    largeContextPreset: "large",
                    presets: {
                        fast: { model: "openai-codex/gpt-5.4-mini" },
                        large: { model: "openai-codex/gpt-5.4" },
                    },
                }),
            }),
        );

        assert.deepEqual(result, { cancel: true });
        assert.equal(completeCalls, 0);
    });

    it("does not use largeContextPreset after a non-capacity provider failure", async () => {
        const defaultModel = createModel({ id: "default" });
        const largeModel = createModel({ provider: "anthropic", id: "large", contextWindow: 1_000_000 });
        const { ctx, authLookups } = createContext([defaultModel, largeModel], defaultModel);
        const calledModels: string[] = [];

        const result = await runGroundedCompaction(createEvent(), ctx, createDeps({
            complete: async (model) => {
                calledModels.push(model.id);
                return createAssistantResponse("", "error");
            },
            loadConfig: async () => createTestConfig({
                includeFilesTouched: { inCompactionSummary: false, inBranchSummary: false },
                defaultPreset: "current",
                largeContextPreset: "large",
                presets: { large: { model: "anthropic/large" } },
            }),
        }));

        assert.equal(result, undefined);
        assert.deepEqual(calledModels, ["default"]);
        assert.equal(authLookups.includes("anthropic/large"), false);
    });

    it("uses model maxTokens as the shared preflight and completion output budget", async () => {
        const model = createModel({ maxTokens: 125 });
        const { ctx } = createContext([model]);
        let capturedMaxTokens: number | undefined;

        const result = await runGroundedCompaction(createEvent(), ctx, createDeps({
            complete: async (_model, _context, options) => {
                capturedMaxTokens = options.maxTokens;
                return createAssistantResponse("summary");
            },
        }));

        assert.ok(result && "compaction" in result);
        assert.equal(capturedMaxTokens, 125);
    });

    it("accepts a summary request at exact context-window equality", async () => {
        const event = createEvent();
        const maxTokens = 125;
        const userPrompt = buildSummaryUserPrompt({
            mode: "history",
            promptContract: "Keep it concise",
            serializedConversation: serializePreparedMessages(event.preparation.messagesToSummarize),
        });
        const estimatedInputTokens = estimateInputTokens(`${DEFAULT_SYSTEM_PROMPT}\n\n${userPrompt}`);
        const model = createModel({ contextWindow: estimatedInputTokens + maxTokens, maxTokens });
        const { ctx } = createContext([model]);
        let completeCalls = 0;

        const result = await runGroundedCompaction(event, ctx, createDeps({
            complete: async () => {
                completeCalls += 1;
                return createAssistantResponse("summary");
            },
        }));

        assert.ok(result && "compaction" in result);
        assert.equal(completeCalls, 1);
    });

    it("rejects invalid model capacity limits before provider execution", async () => {
        for (const overrides of [
            { contextWindow: 0 },
            { contextWindow: -1 },
            { contextWindow: Number.NaN },
            { contextWindow: Number.POSITIVE_INFINITY },
            { maxTokens: 0 },
            { maxTokens: -1 },
            { maxTokens: Number.NaN },
            { maxTokens: Number.POSITIVE_INFINITY },
        ]) {
            const model = createModel(overrides);
            const { ctx } = createContext([model]);
            let completeCalls = 0;
            const result = await runGroundedCompaction(createEvent(), ctx, createDeps({
                complete: async () => {
                    completeCalls += 1;
                    return createAssistantResponse("must not run");
                },
            }));

            assert.deepEqual(result, { cancel: true });
            assert.equal(completeCalls, 0);
        }
    });

    it("uses reserveTokens as the output budget when it is smaller than model maxTokens", async () => {
        const model = createModel({ maxTokens: 5_000 });
        const { ctx } = createContext([model]);
        let capturedMaxTokens: number | undefined;

        const result = await runGroundedCompaction(createEvent(), ctx, createDeps({
            complete: async (_model, _context, options) => {
                capturedMaxTokens = options.maxTokens;
                return createAssistantResponse("summary");
            },
        }));

        assert.ok(result && "compaction" in result);
        assert.equal(capturedMaxTokens, 800);
    });

    it("counts the whole assembled prompt, not just the serialized conversation", async () => {
        const baseEvent = createEvent();
        const conversationOnly = buildSummaryUserPrompt({
            mode: "history",
            promptContract: "Keep it concise",
            serializedConversation: serializePreparedMessages(baseEvent.preparation.messagesToSummarize),
        });
        const maxTokens = 50;
        const model = createModel({
            contextWindow: estimateInputTokens(`${DEFAULT_SYSTEM_PROMPT}\n\n${conversationOnly}`) + maxTokens + 100,
            maxTokens,
        });
        const { ctx } = createContext([model]);
        let completeCalls = 0;
        const event = createEvent({
            preparation: { ...baseEvent.preparation, previousSummary: "p".repeat(20_000) },
        });

        const result = await runGroundedCompaction(event, ctx, createDeps({
            complete: async () => {
                completeCalls += 1;
                return createAssistantResponse("must not run");
            },
        }));

        assert.deepEqual(result, { cancel: true });
        assert.equal(completeCalls, 0);
    });

    it("never resolves largeContextPreset for invalid capacity limits", async () => {
        const brokenModel = createModel({ id: "broken", contextWindow: 0 });
        const largeModel = createModel({ id: "large", contextWindow: 1_000_000 });
        const { ctx, authLookups } = createContext([brokenModel, largeModel], brokenModel);
        let completeCalls = 0;

        const result = await runGroundedCompaction(createEvent(), ctx, createDeps({
            complete: async () => {
                completeCalls += 1;
                return createAssistantResponse("must not run");
            },
            loadConfig: async () => createTestConfig({
                includeFilesTouched: { inCompactionSummary: false, inBranchSummary: false },
                defaultPreset: "current",
                largeContextPreset: "large",
                presets: { large: { model: "anthropic/large" } },
            }),
        }));

        assert.deepEqual(result, { cancel: true });
        assert.equal(completeCalls, 0);
        assert.equal(authLookups.includes("anthropic/large"), false);
    });

    it("starts no provider call when the large candidate cannot fit every split-turn request", async () => {
        const fastModel = createModel({ id: "fast", contextWindow: 100, maxTokens: 50 });
        const largeModel = createModel({ id: "large", contextWindow: 3_000, maxTokens: 50 });
        const { ctx, authLookups } = createContext([fastModel, largeModel], fastModel);
        const oldUser = messageEntry("old-user", "user", "Short prior turn");
        const currentUser = messageEntry("current-user", "user", "x".repeat(20_000));
        const keptAssistant = messageEntry("kept-assistant", "assistant", "Kept suffix");
        const baseEvent = createEvent();
        let completeCalls = 0;
        const event = createEvent({
            branchEntries: [oldUser, currentUser, keptAssistant],
            preparation: {
                ...baseEvent.preparation,
                firstKeptEntryId: keptAssistant.id,
                messagesToSummarize: [oldUser.message],
                turnPrefixMessages: [currentUser.message],
                isSplitTurn: true,
            },
        });

        const result = await runGroundedCompaction(event, ctx, createDeps({
            complete: async () => {
                completeCalls += 1;
                return createAssistantResponse("must not run");
            },
            loadConfig: async () => createTestConfig({
                includeFilesTouched: { inCompactionSummary: false, inBranchSummary: false },
                defaultPreset: "current",
                largeContextPreset: "large",
                presets: { large: { model: "anthropic/large" } },
            }),
        }));

        assert.deepEqual(result, { cancel: true });
        assert.equal(completeCalls, 0);
        assert.equal(authLookups.includes("anthropic/large"), true);
    });

    it("cancels when the large candidate cannot authenticate", async () => {
        const fastModel = createModel({ id: "fast", contextWindow: 100, maxTokens: 50 });
        const largeModel = createModel({ provider: "anthropic", id: "large", contextWindow: 1_000_000 });
        const { ctx } = createContext([fastModel, largeModel], fastModel, new Set(["anthropic/large"]));
        let completeCalls = 0;

        const result = await runGroundedCompaction(createEvent(), ctx, createDeps({
            complete: async () => {
                completeCalls += 1;
                return createAssistantResponse("must not run");
            },
            loadConfig: async () => createTestConfig({
                includeFilesTouched: { inCompactionSummary: false, inBranchSummary: false },
                defaultPreset: "current",
                largeContextPreset: "large",
                presets: { large: { model: "anthropic/large" } },
            }),
        }));

        assert.deepEqual(result, { cancel: true });
        assert.equal(completeCalls, 0);
    });

    it("cancels instead of stock fallback when the rerouted model fails", async () => {
        const fastModel = createModel({ id: "fast", contextWindow: 100, maxTokens: 50 });
        const largeModel = createModel({ provider: "anthropic", id: "large", contextWindow: 1_000_000 });
        const { ctx } = createContext([fastModel, largeModel], fastModel);

        const result = await runGroundedCompaction(createEvent(), ctx, createDeps({
            complete: async () => createAssistantResponse("", "error"),
            loadConfig: async () => createTestConfig({
                includeFilesTouched: { inCompactionSummary: false, inBranchSummary: false },
                defaultPreset: "current",
                largeContextPreset: "large",
                presets: { large: { model: "anthropic/large" } },
            }),
        }));

        assert.deepEqual(result, { cancel: true });
    });

    it("never resolves largeContextPreset for explicit or malformed directives", async () => {
        for (const customInstructions of ["-p current", "--preset"]) {
            const fastModel = createModel({ id: "fast", contextWindow: 100, maxTokens: 50 });
            const largeModel = createModel({ provider: "anthropic", id: "large", contextWindow: 1_000_000 });
            const { ctx, authLookups } = createContext([fastModel, largeModel], fastModel);
            let completeCalls = 0;

            const result = await runGroundedCompaction(
                createEvent({ customInstructions }),
                ctx,
                createDeps({
                    complete: async () => {
                        completeCalls += 1;
                        return createAssistantResponse("must not run");
                    },
                    loadConfig: async () => createTestConfig({
                        includeFilesTouched: { inCompactionSummary: false, inBranchSummary: false },
                        defaultPreset: "current",
                        largeContextPreset: "large",
                        presets: { large: { model: "anthropic/large" } },
                    }),
                }),
            );

            assert.deepEqual(result, { cancel: true });
            assert.equal(completeCalls, 0);
            assert.equal(authLookups.includes("anthropic/large"), false);
        }
    });

    it("cancels quietly when the compaction signal is already aborted", async () => {
        const { ctx, notifications } = createContext([createModel()]);
        const controller = new AbortController();
        controller.abort();
        let completeCalls = 0;

        const result = await runGroundedCompaction(
            createEvent({ customInstructions: "--preset", signal: controller.signal }),
            ctx,
            createDeps({
                complete: async () => {
                    completeCalls += 1;
                    return createAssistantResponse("must not run");
                },
            }),
        );

        assert.deepEqual(result, { cancel: true });
        assert.equal(completeCalls, 0);
        assert.deepEqual(notifications, []);
    });

    it("falls back from a configured defaultPreset to the current session model", async () => {
        const openAiModel = createModel({
            provider: "openai",
            api: "openai-responses",
            id: "gpt-5.4",
            name: "GPT-5.4",
        });
        const { ctx, notifications } = createContext([openAiModel], openAiModel);
        const event = createEvent();

        let selectedModelId = "";
        const result = await runGroundedCompaction(event, ctx, createDeps({
            complete: async (model) => {
                selectedModelId = model.id;
                return createAssistantResponse("summary from session fallback");
            },
            loadConfig: async () => createTestConfig({
                includeFilesTouched: {
                    inCompactionSummary: false,
                    inBranchSummary: false,
                },
                defaultPreset: "fast",
                presets: {
                    fast: {
                        model: "openai-codex/gpt-5.4-mini",
                        thinkingLevel: "medium",
                    },
                },
            }),
        }));

        assert.ok(result && "compaction" in result);
        assert.equal(selectedModelId, "gpt-5.4");
        assert.deepEqual(result.compaction.details, {
            model: "openai/gpt-5.4",
            thinkingLevel: "off",
        });
        assert.equal(notifications.length, 1);
        assert.match(notifications[0], /Configured defaultPreset 'fast' failed/i);
    });

    it("uses /compact -p current to override a configured defaultPreset", async () => {
        const openAiModel = createModel({
            provider: "openai",
            api: "openai-responses",
            id: "gpt-5.4",
            name: "GPT-5.4",
        });
        const fastModel = createModel({
            provider: "openai-codex",
            api: "openai-codex-responses",
            id: "gpt-5.4-mini",
            name: "GPT-5.4 Mini",
        });
        const { ctx, notifications } = createContext([openAiModel, fastModel], openAiModel);
        const event = createEvent({
            customInstructions: "-p current focus on parser regressions",
            branchEntries: [thinkingEntry("high"), ...createEvent().branchEntries],
        });

        let selectedModelId = "";
        const result = await runGroundedCompaction(event, ctx, createDeps({
            complete: async (model, context) => {
                selectedModelId = model.id;
                const promptText = ((context.messages[0].content as Array<{ text?: string }>)[0].text ?? "") as string;
                assert.match(promptText, /focus on parser regressions/);
                assert.equal(promptText.includes("--preset"), false);
                return createAssistantResponse("summary from current override");
            },
            loadConfig: async () => createTestConfig({
                includeFilesTouched: {
                    inCompactionSummary: false,
                    inBranchSummary: false,
                },
                defaultPreset: "fast",
                presets: {
                    fast: {
                        model: "openai-codex/gpt-5.4-mini",
                        thinkingLevel: "medium",
                    },
                },
            }),
        }));

        assert.ok(result && "compaction" in result);
        assert.equal(selectedModelId, "gpt-5.4");
        assert.deepEqual(result.compaction.details, {
            model: "openai/gpt-5.4",
            thinkingLevel: "high",
        });
        assert.deepEqual(notifications, []);
    });

    it("falls back from a parsed preset request to the current session model without leaking the directive", async () => {
        const openAiModel = createModel({
            provider: "openai",
            api: "openai-responses",
            id: "gpt-5.4",
            name: "GPT-5.4",
        });
        const { ctx, notifications } = createContext([openAiModel]);
        const event = createEvent({
            customInstructions: "--preset missing focus on parser regressions",
        });

        let promptText = "";
        const result = await runGroundedCompaction(event, ctx, createDeps({
            complete: async (_model, context) => {
                promptText = ((context.messages[0].content as Array<{ text?: string }>)[0].text ?? "") as string;
                return createAssistantResponse("summary from default path");
            },
            loadConfig: async () => createTestConfig({
                includeFilesTouched: {
                    inCompactionSummary: false,
                    inBranchSummary: false,
                },
                defaultPreset: "current",
                presets: {},
            }),
        }));

        assert.ok(result && "compaction" in result);
        assert.equal(result.compaction.summary, "summary from default path");
        assert.match(promptText, /focus on parser regressions/);
        assert.equal(promptText.includes("--preset"), false);
        assert.equal(notifications.length, 1);
        assert.match(notifications[0], /falling back to the current session model/i);
    });

    it("cancels when a parsed preset request falls back and the default path also fails", async () => {
        const { ctx } = createContext([createModel()]);
        const event = createEvent({
            customInstructions: "--preset missing keep parser detail",
        });

        const result = await runGroundedCompaction(event, ctx, createDeps({
            complete: async () => createAssistantResponse("", "error"),
            loadConfig: async () => createTestConfig({
                includeFilesTouched: {
                    inCompactionSummary: false,
                    inBranchSummary: false,
                },
                defaultPreset: "current",
                presets: {},
            }),
        }));

        assert.deepEqual(result, { cancel: true });
    });

    it("does not retry a resolved explicit preset after provider failure", async () => {
        const currentModel = createModel({ id: "current" });
        const explicitModel = createModel({ id: "explicit" });
        const { ctx } = createContext([currentModel, explicitModel], currentModel);
        const calledModels: string[] = [];

        const result = await runGroundedCompaction(
            createEvent({ customInstructions: "-p explicit" }),
            ctx,
            createDeps({
                complete: async (model) => {
                    calledModels.push(model.id);
                    return createAssistantResponse("", "error");
                },
                loadConfig: async () => createTestConfig({
                    includeFilesTouched: { inCompactionSummary: false, inBranchSummary: false },
                    defaultPreset: "current",
                    presets: { explicit: { model: "anthropic/explicit" } },
                }),
            }),
        );

        assert.deepEqual(result, { cancel: true });
        assert.deepEqual(calledModels, ["explicit"]);
    });

    it("uses only the turn-context section when a split turn has no earlier history span", async () => {
        const { ctx } = createContext([createModel()]);
        const currentUser = messageEntry("current-user", "user", "Current turn start");
        const keptAssistant = messageEntry("kept-assistant", "assistant", "Kept suffix");
        const event = createEvent({
            branchEntries: [currentUser, keptAssistant],
            preparation: {
                firstKeptEntryId: keptAssistant.id,
                messagesToSummarize: [],
                turnPrefixMessages: [currentUser.message],
                isSplitTurn: true,
                tokensBefore: 777,
                previousSummary: undefined,
                fileOps: {
                    read: new Set(),
                    write: new Set(),
                    edit: new Set(),
                    delete: new Set(),
                    move: [],
                },
                settings: {
                    enabled: true,
                    reserveTokens: 800,
                    keepRecentTokens: 400,
                },
            },
        });

        let callCount = 0;
        const result = await runGroundedCompaction(event, ctx, createDeps({
            complete: async () => {
                callCount += 1;
                return createAssistantResponse("turn summary only");
            },
        }));

        assert.ok(result && "compaction" in result);
        assert.equal(callCount, 1);
        assert.equal(
            result.compaction.summary,
            [
                "**Turn Context (split turn):**",
                "",
                "_This section summarizes only the earlier part of the current split turn. More recent kept context may supersede status or next steps below._",
                "",
                "turn summary only",
            ].join("\n"),
        );
        assert.equal(result.compaction.summary.includes("No prior history."), false);
    });

    it("carries forward previousSummary when a split turn has no fresh history span", async () => {
        const { ctx } = createContext([createModel()]);
        const currentUser = messageEntry("current-user", "user", "Current turn start");
        const keptAssistant = messageEntry("kept-assistant", "assistant", "Kept suffix");
        const event = createEvent({
            branchEntries: [currentUser, keptAssistant],
            preparation: {
                firstKeptEntryId: keptAssistant.id,
                messagesToSummarize: [],
                turnPrefixMessages: [currentUser.message],
                isSplitTurn: true,
                tokensBefore: 888,
                previousSummary: "Older summary\n\n## Files touched\nR=read, W=write, E=edit, M=move/rename, D=delete\n\n```text\nR  stale.ts\n```",
                fileOps: {
                    read: new Set(),
                    write: new Set(),
                    edit: new Set(),
                    delete: new Set(),
                    move: [],
                },
                settings: {
                    enabled: true,
                    reserveTokens: 800,
                    keepRecentTokens: 400,
                },
            },
        });

        let callCount = 0;
        const result = await runGroundedCompaction(event, ctx, createDeps({
            complete: async () => {
                callCount += 1;
                return createAssistantResponse("turn summary only");
            },
        }));

        assert.ok(result && "compaction" in result);
        assert.equal(callCount, 1);
        assert.equal(
            result.compaction.summary,
            [
                "Older summary",
                "",
                "---",
                "",
                "**Turn Context (split turn):**",
                "",
                "_This section summarizes only the earlier part of the current split turn. More recent kept context may supersede status or next steps below._",
                "",
                "turn summary only",
            ].join("\n"),
        );
        assert.equal(result.compaction.summary.includes("stale.ts"), false);
    });

    it("preserves split-turn merge shape and appends exactly one whole-branch manifest", async () => {
        const currentModel = createModel();
        const { ctx } = createContext([currentModel]);
        const oldUser = messageEntry("old-user", "user", "Previous turn");
        const oldAssistant = messageEntry("old-assistant", "assistant", "Previous reply");
        const currentUser = messageEntry("current-user", "user", "Current turn start");
        const keptAssistant = messageEntry("kept-assistant", "assistant", "Kept suffix");
        const event = createEvent({
            branchEntries: [oldUser, oldAssistant, currentUser, keptAssistant],
            preparation: {
                firstKeptEntryId: keptAssistant.id,
                messagesToSummarize: [oldUser.message, oldAssistant.message],
                turnPrefixMessages: [currentUser.message],
                isSplitTurn: true,
                tokensBefore: 999,
                previousSummary: "Earlier summary\n\n## Files touched\nR=read, W=write, E=edit, M=move/rename, D=delete\n\n```text\nR  stale.ts\n```",
                fileOps: {
                    read: new Set(),
                    write: new Set(),
                    edit: new Set(),
                    delete: new Set(),
                    move: [],
                },
                settings: {
                    enabled: true,
                    reserveTokens: 800,
                    keepRecentTokens: 400,
                },
            },
        });

        let callIndex = 0;
        const result = await runGroundedCompaction(event, ctx, createDeps({
            complete: async () => {
                callIndex += 1;
                return createAssistantResponse(callIndex === 1 ? "history summary" : "turn summary");
            },
            collectFilesTouched: (entries) => {
                if (entries.length === 4) {
                    return [{
                        path: "/repo/src/whole.ts",
                        displayPath: "src/whole.ts",
                        operations: new Set(["edit"]),
                        lastTimestamp: 4,
                    }];
                }

                if (entries.length === 2) {
                    return [{
                        path: "/repo/src/history.ts",
                        displayPath: "src/history.ts",
                        operations: new Set(["read"]),
                        lastTimestamp: 2,
                    }];
                }

                return [{
                    path: "/repo/src/turn.ts",
                    displayPath: "src/turn.ts",
                    operations: new Set(["write"]),
                    lastTimestamp: 3,
                }];
            },
            loadConfig: async () => createTestConfig({
                includeFilesTouched: {
                    inCompactionSummary: true,
                    inBranchSummary: false,
                },
                defaultPreset: "current",
                presets: {},
            }),
        }));

        assert.ok(result && "compaction" in result);
        assert.equal(callIndex, 2);
        assert.equal(
            result.compaction.summary,
            [
                "history summary",
                "",
                "---",
                "",
                "**Turn Context (split turn):**",
                "",
                "_This section summarizes only the earlier part of the current split turn. More recent kept context may supersede status or next steps below._",
                "",
                "turn summary",
                "",
                "---",
                "",
                "## Files touched (cumulative)",
                "R=read, W=write, E=edit, M=move/rename, D=delete",
                "",
                "```text",
                "E  src/whole.ts",
                "```",
            ].join("\n"),
        );
        assert.equal(result.compaction.firstKeptEntryId, keptAssistant.id);
        assert.equal(result.compaction.tokensBefore, 999);
        assert.equal((result.compaction.summary.match(/## Files touched/g) ?? []).length, 1);
    });
});

describe("grounded-compaction tree augmentation runtime", () => {
    it("returns undefined when the user does not want a summary", async () => {
        const { ctx } = createContext([createModel()]);
        const result = await runGroundedBranchSummaryAugmentation(
            createTreeEvent({
                preparation: {
                    ...createTreeEvent().preparation,
                    userWantsSummary: false,
                },
            }),
            ctx,
            createDeps({
                loadConfig: async () => createTestConfig({
                    includeFilesTouched: {
                        inCompactionSummary: false,
                        inBranchSummary: true,
                    },
                    defaultPreset: "current",
                    presets: {},
                }),
            }),
        );

        assert.equal(result, undefined);
    });

    it("returns undefined when entriesToSummarize is empty", async () => {
        const { ctx } = createContext([createModel()]);
        const result = await runGroundedBranchSummaryAugmentation(
            createTreeEvent({
                preparation: {
                    ...createTreeEvent().preparation,
                    entriesToSummarize: [],
                },
            }),
            ctx,
            createDeps({
                loadConfig: async () => createTestConfig({
                    includeFilesTouched: {
                        inCompactionSummary: false,
                        inBranchSummary: true,
                    },
                    defaultPreset: "current",
                    presets: {},
                }),
            }),
        );

        assert.equal(result, undefined);
    });

    it("uses replaceInstructions when a branch-summary prompt contract exists", async () => {
        const { ctx } = createContext([createModel()]);
        const result = await runGroundedBranchSummaryAugmentation(
            createTreeEvent({
                preparation: {
                    ...createTreeEvent().preparation,
                    customInstructions: "Focus on parser regressions",
                },
            }),
            ctx,
            createDeps({
                collectFilesTouched: () => [{
                    path: "/repo/src/tree.ts",
                    displayPath: "src/tree.ts",
                    operations: new Set(["read"]),
                    lastTimestamp: 1,
                }],
                loadConfig: async () => createTestConfig({
                    includeFilesTouched: {
                        inCompactionSummary: false,
                        inBranchSummary: true,
                    },
                    defaultPreset: "current",
                    presets: {},
                }),
                loadBranchSummaryPrompt: async () => "# Branch prompt\nUse this exact outline",
            }),
        );

        assert.ok(result);
        assert.equal(result.replaceInstructions, true);
        assert.match(result.customInstructions ?? "", /# Branch prompt/);
        assert.match(result.customInstructions ?? "", /Focus on parser regressions/);
        assert.match(result.customInstructions ?? "", /## Files touched/);
        assert.equal(result.summary, undefined);
        assert.equal(result.cancel, undefined);
        assert.equal(result.label, undefined);
    });

    it("uses additive instructions when only files-touched augmentation is active", async () => {
        const { ctx } = createContext([createModel()]);
        const result = await runGroundedBranchSummaryAugmentation(
            createTreeEvent({
                preparation: {
                    ...createTreeEvent().preparation,
                    customInstructions: "Preserve command history detail",
                },
            }),
            ctx,
            createDeps({
                collectFilesTouched: () => [{
                    path: "/repo/src/tree.ts",
                    displayPath: "src/tree.ts",
                    operations: new Set(["edit"]),
                    lastTimestamp: 1,
                }],
                loadConfig: async () => createTestConfig({
                    includeFilesTouched: {
                        inCompactionSummary: false,
                        inBranchSummary: true,
                    },
                    defaultPreset: "current",
                    presets: {},
                }),
                loadBranchSummaryPrompt: async () => undefined,
            }),
        );

        assert.ok(result);
        assert.equal(result.replaceInstructions, false);
        assert.match(result.customInstructions ?? "", /^Also include the authoritative files-touched block below/);
        assert.match(result.customInstructions ?? "", /Preserve command history detail/);
        assert.match(result.customInstructions ?? "", /E  src\/tree.ts/);
    });

    it("uses entriesToSummarize for file recovery", async () => {
        const { ctx } = createContext([createModel()]);
        const entriesToSummarize = [
            messageEntry("tree-user", "user", "Inspect repo"),
            messageEntry("tree-assistant", "assistant", "Done"),
        ];
        let capturedEntries: SessionEntry[] = [];
        const result = await runGroundedBranchSummaryAugmentation(
            createTreeEvent({
                preparation: {
                    ...createTreeEvent().preparation,
                    entriesToSummarize,
                },
            }),
            ctx,
            createDeps({
                collectFilesTouched: (entries) => {
                    capturedEntries = entries;
                    return [];
                },
                loadConfig: async () => createTestConfig({
                    includeFilesTouched: {
                        inCompactionSummary: false,
                        inBranchSummary: true,
                    },
                    defaultPreset: "current",
                    presets: {},
                }),
            }),
        );

        assert.deepEqual(capturedEntries, entriesToSummarize);
        assert.ok(result);
        assert.equal(result.replaceInstructions, false);
    });

    it("returns undefined and warns on failure instead of canceling", async () => {
        const { ctx, notifications } = createContext([createModel()]);
        const result = await runGroundedBranchSummaryAugmentation(
            createTreeEvent(),
            ctx,
            createDeps({
                loadConfig: async () => {
                    throw new Error("broken config");
                },
            }),
        );

        assert.equal(result, undefined);
        assert.equal(notifications.length, 1);
        assert.match(notifications[0], /Grounded branch-summary augmentation failed: broken config/);
    });
});
