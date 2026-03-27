import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Api, AssistantMessage, Model } from "@mariozechner/pi-ai";
import type { SessionBeforeCompactEvent, SessionBeforeTreeEvent, SessionEntry } from "@mariozechner/pi-coding-agent";

import {
    DEFAULT_COMPACTION_PROMPT_CONTRACT,
    DEFAULT_CONFIG,
    buildBranchSummaryInstructions,
    buildSummaryUserPrompt,
    deriveSummaryEntrySpans,
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

function compactionEntry(id: string, summary: string): SessionEntry {
    return {
        id,
        type: "compaction",
        summary,
        tokensBefore: 100,
        timestamp: new Date().toISOString(),
    } as SessionEntry;
}

function createContext(models: Model<Api>[], currentModel = models[0]): { ctx: TestContext; notifications: string[] } {
    const notifications: string[] = [];

    return {
        notifications,
        ctx: {
            hasUI: true,
            ui: {
                notify(message) {
                    notifications.push(message);
                },
            },
            model: currentModel,
            cwd: "/repo",
            modelRegistry: {
                getAll() {
                    return models;
                },
                async getApiKeyAndHeaders() {
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

function createDeps(overrides: Partial<GroundedRunDeps> = {}): GroundedRunDeps {
    return {
        complete: async () => createAssistantResponse("summary"),
        collectFilesTouched: () => [],
        loadConfig: async () => ({
            includeFilesTouched: {
                inCompactionSummary: false,
                inBranchSummary: false,
            },
            defaultPreset: "current",
            presets: {},
        }),
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
            compactionEntry("old-compaction", "older"),
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
            loadConfig: async () => ({
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
            loadConfig: async () => ({
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
            loadConfig: async () => ({
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
            loadConfig: async () => ({
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
            loadConfig: async () => ({
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
            loadConfig: async () => ({
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
                loadConfig: async () => ({
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
                loadConfig: async () => ({
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
                loadConfig: async () => ({
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
                loadConfig: async () => ({
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
                loadConfig: async () => ({
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
