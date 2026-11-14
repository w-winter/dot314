import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
    createEventBus,
    type ExtensionAPI,
    type SessionBeforeCompactEvent,
    type SessionBeforeCompactResult,
    type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";

import {
    DEFAULT_SYSTEM_PROMPT,
    registerGroundedCompaction,
    runGroundedBranchSummaryAugmentation,
    runGroundedCompaction,
} from "./index.ts";
import {
    createModel,
    createAssistantResponse,
    messageEntry,
    thinkingEntry,
    createContext,
    createEvent,
    createTreeEvent,
    createTestConfig,
    createDeps,
    type TestContext,
} from "./test/fixtures.ts";

describe("grounded-compaction runtime", () => {
    it("cancels empty or ledger-only retention responses without stock fallback", async () => {
        const ledger = "## Files touched\nR=read, W=write, E=edit, M=move/rename, D=delete\n\n```text\nR  file.ts\n```";
        for (const body of ["", "  \n", `## Grounded retention decisions\n\n\`\`\`json\n{"decisions":[]}\n\`\`\`\n\n${ledger}`]) {
            const event = createEvent();
            const { ctx, notifications } = createContext([createModel()]);
            ctx.sessionManager.getLeafId = () => event.branchEntries.at(-1)!.id;
            ctx.sessionManager.getBranch = () => event.branchEntries;
            const result = await runGroundedCompaction(event, ctx, createDeps({
                loadConfig: async () => createTestConfig({ verbatimUserMessageTokens: 4000 }),
                complete: async () => createAssistantResponse(body),
            }));
            assert.deepEqual(result, { cancel: true });
            assert.match(notifications.at(-1) ?? "", /invalid-decisions/);
        }
    });

    it("cancels an uncloneable enabled retention snapshot before calling the provider", async () => {
        const event = createEvent();
        event.branchEntries.push({ type: "custom", id: "runtime", parentId: event.branchEntries.at(-1)!.id,
            timestamp: new Date().toISOString(), customType: "runtime", data: { callback: () => undefined } });
        const { ctx, notifications } = createContext([createModel()]);
        ctx.sessionManager.getLeafId = () => "runtime";
        let calls = 0;
        const result = await runGroundedCompaction(event, ctx, createDeps({
            loadConfig: async () => createTestConfig({ verbatimUserMessageTokens: 4000 }),
            complete: async () => { calls++; return createAssistantResponse("unexpected"); },
        }));
        assert.deepEqual(result, { cancel: true });
        assert.equal(calls, 0);
        assert.match(notifications.at(-1) ?? "", /session-state/);
    });
    it("does not require cloneable tool metadata when retention is disabled", async () => {
        const { ctx } = createContext([createModel()]);
        const event = createEvent();
        event.branchEntries.push({
            type: "custom", id: "runtime-metadata", parentId: event.branchEntries.at(-1)!.id,
            timestamp: new Date().toISOString(), customType: "runtime", data: { callback: () => undefined },
        });
        const result = await runGroundedCompaction(event, ctx, createDeps());
        assert.ok(result && "compaction" in result);
    });
    it("summarizes with an extension-registered Claude provider", async () => {
        const claude = createModel({ provider: "pi-claude", api: "claude-bridge", id: "claude-opus-5-5" });
        const { ctx } = createContext([claude]);
        let selectedModel: string | undefined;
        let requestSessionId: string | undefined;
        ctx.modelRegistry.streamSimple = (model, context, options) => {
            selectedModel = model.id;
            requestSessionId = options?.sessionId;
            assert.equal(context.systemPrompt, DEFAULT_SYSTEM_PROMPT);
            assert.equal(options?.cacheRetention, "none");
            const stream = createAssistantMessageEventStream();
            stream.push({ type: "done", reason: "stop", message: createAssistantResponse("compacted") });
            stream.end();
            return stream;
        };

        const result = await runGroundedCompaction(createEvent(), ctx, createDeps({
            complete: undefined,
            loadConfig: async () => createTestConfig({
                defaultPreset: "claude",
                presets: { claude: { model: "pi-claude/claude-opus-5-5" } },
            }),
        }));

        assert.ok(result && "compaction" in result);
        assert.equal(result.compaction.summary, "compacted");
        assert.equal(selectedModel, claude.id);
        assert.ok(requestSessionId);
    });

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
                    inCompactionSummary: "off",
                    inBranchSummary: "off",
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
                    includeFilesTouched: { inCompactionSummary: "off", inBranchSummary: "off" },
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
                    inCompactionSummary: "off",
                    inBranchSummary: "off",
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
                    inCompactionSummary: "off",
                    inBranchSummary: "off",
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
                    inCompactionSummary: "off",
                    inBranchSummary: "off",
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
                    inCompactionSummary: "off",
                    inBranchSummary: "off",
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
                    includeFilesTouched: { inCompactionSummary: "off", inBranchSummary: "off" },
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
                    written: new Set(),
                    edited: new Set(),
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
                "_This section summarizes the early part of the current split turn. It is more recent than the sections above it; where they conflict, prefer this section. The kept conversation after this summary is more recent still and supersedes both._",
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
                    written: new Set(),
                    edited: new Set(),
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
                "_This section summarizes the early part of the current split turn. It is more recent than the sections above it; where they conflict, prefer this section. The kept conversation after this summary is more recent still and supersedes both._",
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
                    written: new Set(),
                    edited: new Set(),
                },
                settings: {
                    enabled: true,
                    reserveTokens: 800,
                    keepRecentTokens: 400,
                },
            },
        });

        const prompts: string[] = [];
        const collected: SessionEntry[][] = [];
        const result = await runGroundedCompaction(event, ctx, createDeps({
            complete: async (_model, context) => {
                // SAFETY: each summary request is one user message whose first content part is the prompt text.
                const promptText = (context.messages[0].content as Array<{ text?: string }>)[0].text ?? "";
                prompts.push(promptText);
                return createAssistantResponse(promptText.includes("Summarize this compaction history span")
                    ? "history summary\n\n---\n\n## Files touched (cumulative)\nR=read, W=write, E=edit, M=move/rename, D=delete\n\n```text\nE  src/whole.ts\n```"
                    : "turn summary");
            },
            collectFilesTouched: (entries) => {
                collected.push(entries);
                return [{
                    path: "/repo/src/whole.ts",
                    displayPath: "src/whole.ts",
                    operations: new Set(["edit"]),
                    lastTimestamp: 4,
                }];
            },
            loadConfig: async () => createTestConfig({
                includeFilesTouched: {
                    inCompactionSummary: "writerAndReader",
                    inBranchSummary: "off",
                },
                defaultPreset: "current",
                presets: {},
            }),
        }));

        assert.ok(result && "compaction" in result);
        assert.deepEqual(collected, [event.branchEntries]);
        assert.equal(prompts.length, 2);
        for (const prompt of prompts) {
            assert.match(prompt, /## Cumulative files-touched reference/);
            assert.match(prompt, /E  src\/whole\.ts/);
            assert.match(prompt, /will append this cumulative ledger verbatim/);
        }
        assert.equal(
            result.compaction.summary,
            [
                "history summary",
                "",
                "---",
                "",
                "**Turn Context (split turn):**",
                "",
                "_This section summarizes the early part of the current split turn. It is more recent than the sections above it; where they conflict, prefer this section. The kept conversation after this summary is more recent still and supersedes both._",
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

    it("routes the whole-branch ledger to the configured audiences", async () => {
        const reproducedLedger = "## Files touched (cumulative)\nR=read, W=write, E=edit, M=move/rename, D=delete\n\n```text\nE  src/kept.ts\n```";
        for (const mode of ["off", "writer", "writerAndReader"] as const) {
            const { ctx } = createContext([createModel()]);
            const event = createEvent();
            const collected: SessionEntry[][] = [];
            let promptText = "";
            const result = await runGroundedCompaction(event, ctx, createDeps({
                complete: async (_model, context) => {
                    // SAFETY: each summary request is one user message whose first content part is the prompt text.
                    promptText = (context.messages[0].content as Array<{ text?: string }>)[0].text ?? "";
                    return createAssistantResponse(`Body\n\n---\n\n${reproducedLedger}`);
                },
                collectFilesTouched: (entries) => {
                    collected.push(entries);
                    return [{ path: "/repo/src/kept.ts", displayPath: "src/kept.ts", operations: new Set(["edit"]), lastTimestamp: 1 }];
                },
                loadConfig: async () => createTestConfig({ includeFilesTouched: { inCompactionSummary: mode, inBranchSummary: "off" } }),
            }));

            assert.ok(result && "compaction" in result, mode);
            if (mode === "off") {
                assert.deepEqual(collected, []);
                assert.doesNotMatch(promptText, /Cumulative files-touched reference/);
                assert.equal(result.compaction.summary, "Body");
            } else if (mode === "writer") {
                assert.deepEqual(collected, [event.branchEntries]);
                assert.match(promptText, /## Cumulative files-touched reference/);
                assert.match(promptText, /E  src\/kept\.ts/);
                assert.match(promptText, /will not be included in the summary/);
                assert.equal(result.compaction.summary, "Body");
            } else {
                assert.deepEqual(collected, [event.branchEntries]);
                assert.match(promptText, /will append this cumulative ledger verbatim/);
                assert.equal(result.compaction.summary, `Body\n\n---\n\n${reproducedLedger}`);
            }
        }
    });

    it("rejects incomplete ordinary summaries on every route", async () => {
        const sessionModel = createModel({ id: "session", contextWindow: 100, maxTokens: 50 });
        const presetModel = createModel({ id: "preset", contextWindow: 200_000 });
        const largeModel = createModel({ id: "large", contextWindow: 1_000_000 });
        const presets = { preset: { model: "anthropic/preset" }, large: { model: "anthropic/large" } };
        const routes = [
            { name: "session default", models: [createModel({ id: "session" })], config: {}, customInstructions: undefined },
            { name: "configured default", models: [sessionModel, presetModel], config: { defaultPreset: "preset", presets }, customInstructions: undefined },
            { name: "explicit preset", models: [sessionModel, presetModel], config: { presets }, customInstructions: "-p preset" },
            { name: "large context", models: [sessionModel, largeModel], config: { largeContextPreset: "large", presets }, customInstructions: undefined },
        ];

        for (const route of routes) {
            const { ctx, notifications } = createContext(route.models);
            let completeCalls = 0;
            const result = await runGroundedCompaction(createEvent({ customInstructions: route.customInstructions }), ctx, createDeps({
                complete: async () => {
                    completeCalls += 1;
                    return createAssistantResponse("## Brief\n- Partial summary cut off mid", "length");
                },
                loadConfig: async () => createTestConfig(route.config),
            }));

            assert.deepEqual(result, { cancel: true }, route.name);
            assert.ok(completeCalls > 0, route.name);
            assert.match(notifications.at(-1) ?? "", /output token limit|incomplete/i, route.name);
        }
    });

    it("rejects a model response containing only a ledger", async () => {
        const { ctx, notifications } = createContext([createModel()]);
        const result = await runGroundedCompaction(createEvent(), ctx, createDeps({
            complete: async () => createAssistantResponse(
                "## Files touched (cumulative)\nR=read, W=write, E=edit, M=move/rename, D=delete\n\n```text\nR  a.ts\n```",
            ),
            loadConfig: async () => createTestConfig({ includeFilesTouched: { inCompactionSummary: "writer", inBranchSummary: "off" } }),
        }));

        assert.equal(result, undefined);
        assert.ok(notifications.some((message) => /Summarization returned no summary body/.test(message)));
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
                        inCompactionSummary: "off",
                        inBranchSummary: "writerAndReader",
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
                        inCompactionSummary: "off",
                        inBranchSummary: "writerAndReader",
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
                        inCompactionSummary: "off",
                        inBranchSummary: "writerAndReader",
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
                        inCompactionSummary: "off",
                        inBranchSummary: "writerAndReader",
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
                        inCompactionSummary: "off",
                        inBranchSummary: "writer",
                    },
                    defaultPreset: "current",
                    presets: {},
                }),
            }),
        );

        assert.deepEqual(capturedEntries, entriesToSummarize);
        assert.ok(result);
        assert.equal(result.replaceInstructions, false);
        assert.match(result.customInstructions ?? "", /factual reference for you only/);
        assert.doesNotMatch(result.customInstructions ?? "", /verbatim/i);
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

/** The compaction hook as this test calls it; registration passes the context through to `runGroundedCompaction`. */
type CompactionHook = (event: SessionBeforeCompactEvent, ctx: TestContext) => Promise<SessionBeforeCompactResult | undefined>;
/** Any Pi hook, as the registration double receives it. */
type RegisteredHook = (event: never, ctx: never) => object | void;

describe("previous-summary query", () => {
    it("cancels compaction when another extension answers with a malformed previous summary", async () => {
        for (const answer of [
            { status: "available", summary: "  " },
            { status: "available", summary: "Readable text", extra: true },
            { status: "error", error: "" },
            { status: "pending" },
        ]) {
            let compactionHook: CompactionHook | undefined;
            const events = createEventBus();
            events.on("grounded-compaction:previous-summary-query", (payload) => {
                if (Check(Type.Object({ response: Type.Unknown() }), payload)) payload.response = answer;
            });
            const api: Partial<ExtensionAPI> = {
                events,
                registerCommand: () => undefined,
                on: (eventName: string, hook: RegisteredHook) => {
                    if (eventName === "session_before_compact") {
                        // SAFETY: Pi passes the compaction event's own handler, which forwards this test context unchanged.
                        compactionHook = hook as CompactionHook;
                    }
                    return () => undefined;
                },
            };
            const { ctx, notifications } = createContext([createModel()]);
            let summarizerCalls = 0;
            // SAFETY: this double supplies the event, hook and command registration methods used here.
            registerGroundedCompaction(api as ExtensionAPI, {
                runCompaction: (event, hookContext, queryPreviousSummary) => runGroundedCompaction(event, hookContext, createDeps({
                    complete: async () => {
                        summarizerCalls += 1;
                        return createAssistantResponse("## Brief\nDone.");
                    },
                    queryPreviousSummary,
                })),
            });

            assert.ok(compactionHook);
            const result = await compactionHook(createEvent({ preparation: { ...createEvent().preparation, previousSummary: "Stored summary" } }), ctx);

            assert.deepEqual(result, { cancel: true }, JSON.stringify(answer));
            assert.equal(summarizerCalls, 0);
            assert.match(notifications.join("\n"), /invalid previous-summary response/);
        }
    });
});
