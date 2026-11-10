import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSessionProjection, convertToLlm, type CompactionEntry } from "@earendil-works/pi-coding-agent";
import { estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";

import {
    DEFAULT_SYSTEM_PROMPT,
    buildSummaryUserPrompt,
    estimateInputTokens,
    runGroundedCompaction,
    serializePreparedMessages,
} from "./index.ts";
import {
    createModel,
    createAssistantResponse,
    messageEntry,
    createContext,
    createEvent,
    createTestConfig,
    createDeps,
} from "./test/fixtures.ts";

describe("grounded-compaction capacity routing", () => {
    it("requires retention-disabled summaries to fit the continuing model, including exact equality", async () => {
        const writer = createModel({ id: "writer", contextWindow: 200_000, maxTokens: 32_000 });
        const continuing = createModel({ id: "continuing", contextWindow: 20_000 });
        const event = createEvent();
        event.preparation.settings.reserveTokens = 2000;
        const body = "x".repeat(70_000);
        const { ctx } = createContext([continuing, writer], continuing);
        const deps = createDeps({
            loadConfig: async () => createTestConfig({ defaultPreset: "writer", presets: { writer: { model: "anthropic/writer" } } }),
            complete: async () => createAssistantResponse(body),
        });
        assert.deepEqual(await runGroundedCompaction(event, ctx, deps), { cancel: true });
        const draft: CompactionEntry = {
            type: "compaction", id: "prospective", parentId: event.branchEntries.at(-1)!.id,
            timestamp: new Date().toISOString(), summary: body,
            firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore,
        };
        const tokens = convertToLlm(buildSessionProjection([...event.branchEntries, draft]).messages)
            .reduce((sum, message) => sum + estimateMessageTokens(message), 0);
        continuing.contextWindow = tokens + event.preparation.settings.reserveTokens;
        const result = await runGroundedCompaction(event, ctx, deps);
        assert.ok(result && "compaction" in result);
        assert.equal(result.compaction.summary, body);
        continuing.contextWindow -= 1;
        assert.deepEqual(await runGroundedCompaction(event, ctx, deps), { cancel: true });
    });

    it("checks the merged split-turn body against continuation capacity when retention is disabled", async () => {
        const writer = createModel({ id: "writer", contextWindow: 200_000, maxTokens: 32_000 });
        const continuing = createModel({ id: "continuing", contextWindow: 20_000 });
        const base = createEvent();
        const earlier = messageEntry("earlier", "user", "Earlier request");
        const prefix = messageEntry("prefix", "user", "Current request");
        const kept = messageEntry("kept", "assistant", "Kept suffix");
        const event = createEvent({ branchEntries: [earlier, prefix, kept], preparation: {
            ...base.preparation, firstKeptEntryId: kept.id, isSplitTurn: true,
            messagesToSummarize: [earlier.message], turnPrefixMessages: [prefix.message],
            settings: { ...base.preparation.settings, reserveTokens: 2000 },
        } });
        let calls = 0;
        const { ctx } = createContext([continuing, writer], continuing);
        const result = await runGroundedCompaction(event, ctx, createDeps({
            loadConfig: async () => createTestConfig({ defaultPreset: "writer", presets: { writer: { model: "anthropic/writer" } } }),
            complete: async () => { calls++; return createAssistantResponse("x".repeat(35_000)); },
        }));
        assert.equal(calls, 2);
        assert.deepEqual(result, { cancel: true });
        assert.equal(event.preparation.firstKeptEntryId, kept.id);
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
            filesTouchedLedger: { mode: "off" },
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
        const continuingModel = createModel({ id: "continuing" });
        const { ctx, notifications, notificationLevels } = createContext([continuingModel, fastModel, largeModel], continuingModel);
        const calledModels: string[] = [];

        const result = await runGroundedCompaction(createEvent(), ctx, createDeps({
            complete: async (model) => {
                calledModels.push(model.id);
                return createAssistantResponse("large summary");
            },
            loadConfig: async () => createTestConfig({
                includeFilesTouched: { inCompactionSummary: "off", inBranchSummary: "off" },
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
                    includeFilesTouched: { inCompactionSummary: "off", inBranchSummary: "off" },
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
        const continuingModel = createModel({ id: "continuing" });
        const { ctx } = createContext([continuingModel, fastModel, largeModel], continuingModel);
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
                assert.ok(options);
                capturedBudgets.push(options.maxTokens);
                return createAssistantResponse(model.id === "large" ? "large summary" : "unexpected summary");
            },
            loadConfig: async () => createTestConfig({
                includeFilesTouched: { inCompactionSummary: "off", inBranchSummary: "off" },
                defaultPreset: "fast",
                largeContextPreset: "large",
                presets: { fast: { model: "anthropic/fast" }, large: { model: "anthropic/large" } },
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
                    includeFilesTouched: { inCompactionSummary: "off", inBranchSummary: "off" },
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
                includeFilesTouched: { inCompactionSummary: "off", inBranchSummary: "off" },
                defaultPreset: "current",
                largeContextPreset: "large",
                presets: { large: { model: "anthropic/large" } },
            }),
        }));

        assert.equal(result, undefined);
        assert.deepEqual(calledModels, ["default"]);
        assert.equal(authLookups.includes("anthropic/large"), false);
    });

    it("reserves and requests model maxTokens when it is smaller than reserveTokens", async () => {
        const model = createModel({ maxTokens: 125 });
        const { ctx } = createContext([model]);
        let capturedMaxTokens: number | undefined;

        const result = await runGroundedCompaction(createEvent(), ctx, createDeps({
            complete: async (_model, _context, options) => {
                assert.ok(options);
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
            filesTouchedLedger: { mode: "off" },
        });
        const estimatedInputTokens = estimateInputTokens(`${DEFAULT_SYSTEM_PROMPT}\n\n${userPrompt}`);
        const model = createModel({ id: "exact-writer", contextWindow: estimatedInputTokens + maxTokens, maxTokens });
        const continuingModel = createModel({ id: "continuing" });
        const { ctx } = createContext([continuingModel, model], continuingModel);
        let completeCalls = 0;

        const result = await runGroundedCompaction(event, ctx, createDeps({
            loadConfig: async () => createTestConfig({ defaultPreset: "exact", presets: { exact: { model: "anthropic/exact-writer" } } }),
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

    it("separates output allowance from preflight headroom", async () => {
        const event = createEvent();
        const reserveTokens = event.preparation.settings.reserveTokens;
        const userPrompt = buildSummaryUserPrompt({
            mode: "history",
            promptContract: "Keep it concise",
            serializedConversation: serializePreparedMessages(event.preparation.messagesToSummarize),
            filesTouchedLedger: { mode: "off" },
        });
        const estimatedInputTokens = estimateInputTokens(`${DEFAULT_SYSTEM_PROMPT}\n\n${userPrompt}`);
        // Fits with reserveTokens of headroom, but not with the model's whole output limit
        const model = createModel({ contextWindow: estimatedInputTokens + reserveTokens, maxTokens: 5_000 });
        const { ctx } = createContext([model]);
        let capturedMaxTokens: number | undefined;

        const result = await runGroundedCompaction(event, ctx, createDeps({
            complete: async (_model, _context, options) => {
                assert.ok(options);
                capturedMaxTokens = options.maxTokens;
                return createAssistantResponse("summary");
            },
        }));

        assert.ok(result && "compaction" in result);
        assert.equal(capturedMaxTokens, 5_000);
    });

    it("counts the whole assembled prompt, not just the serialized conversation", async () => {
        const baseEvent = createEvent();
        const conversationOnly = buildSummaryUserPrompt({
            mode: "history",
            promptContract: "Keep it concise",
            serializedConversation: serializePreparedMessages(baseEvent.preparation.messagesToSummarize),
            filesTouchedLedger: { mode: "off" },
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
                includeFilesTouched: { inCompactionSummary: "off", inBranchSummary: "off" },
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
                includeFilesTouched: { inCompactionSummary: "off", inBranchSummary: "off" },
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
                includeFilesTouched: { inCompactionSummary: "off", inBranchSummary: "off" },
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
                includeFilesTouched: { inCompactionSummary: "off", inBranchSummary: "off" },
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
                        includeFilesTouched: { inCompactionSummary: "off", inBranchSummary: "off" },
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
});
