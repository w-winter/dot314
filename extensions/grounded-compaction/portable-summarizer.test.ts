import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Api, AssistantMessage, Model, Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";

import type { FilesTouchedEntry } from "../_shared/files-touched-core.ts";
import {
    DEFAULT_SYSTEM_PROMPT,
    PORTABLE_SUMMARY_MAX_OUTPUT_TOKENS,
    buildSummaryUserPrompt,
    estimateInputTokens,
    openGroundedPortableSummarizerSession,
    type GroundedCompactionConfig,
    type GroundedPortableSummarizerDependencies,
} from "./index.ts";
import {
    GROUNDED_PORTABLE_SUMMARIZER_EVENT,
    mergeGroundedPortableSummarizerResponse,
    normalizeGroundedPortableSummarizerResponse,
    registerGroundedPortableSummarizer,
    type GroundedPortableSummarizerQuery,
    type GroundedPortableSummarizerSession,
    type PortableSummaryUsage,
} from "./portable-summarizer.ts";

const PROMPT_CONTRACT = "Keep the portable checkpoint concise and precise";

const EXPECTED_USAGE: PortableSummaryUsage = {
    input: 101,
    output: 23,
    cacheRead: 7,
    cacheWrite: 5,
    totalTokens: 136,
    cost: {
        input: 0.1,
        output: 0.2,
        cacheRead: 0.03,
        cacheWrite: 0.04,
        total: 0.37,
    },
};

function createModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
    return {
        id: "gpt-portable",
        name: "GPT Portable",
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com",
        reasoning: true,
        input: ["text"],
        cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
        },
        contextWindow: 20_000,
        maxTokens: 4_000,
        ...overrides,
    };
}

function createAssistantResponse(
    text = "portable summary",
    overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-portable",
        usage: structuredClone(EXPECTED_USAGE),
        stopReason: "stop",
        timestamp: Date.now(),
        ...overrides,
    };
}

function thinkingEntry(level: string): SessionEntry {
    return {
        id: `thinking-${level}`,
        type: "thinking_level_change",
        thinkingLevel: level,
        timestamp: new Date().toISOString(),
    } as SessionEntry;
}

function createConfig(overrides: Partial<GroundedCompactionConfig> = {}): GroundedCompactionConfig {
    return {
        includeFilesTouched: {
            inCompactionSummary: true,
            inBranchSummary: true,
        },
        defaultPreset: "current",
        presets: {},
        ...overrides,
    };
}

function createContext(models: Model<Api>[], currentModel = models[0]) {
    return {
        model: currentModel,
        cwd: "/workspace",
        modelRegistry: {
            getAll: () => models,
            getProvider: (provider: string) => (
                models.some((model) => model.provider === provider)
                    ? { id: provider, name: provider } as Provider
                    : undefined
            ),
            getApiKeyAndHeaders: async () => ({
                ok: true as const,
                apiKey: "secret-test-key",
                headers: { "x-secret": "secret-test-header" },
            }),
        },
    } as GroundedPortableSummarizerQuery["context"];
}

function createDependencies(
    overrides: Partial<GroundedPortableSummarizerDependencies> = {},
): GroundedPortableSummarizerDependencies {
    return {
        complete: async () => createAssistantResponse(),
        collectFilesTouched: () => [],
        loadConfig: async () => createConfig({
            includeFilesTouched: {
                inCompactionSummary: false,
                inBranchSummary: true,
            },
        }),
        loadCompactionPrompt: async () => PROMPT_CONTRACT,
        ...overrides,
    };
}

function createOpenRequest(
    models = [createModel()],
    branchEntries: readonly SessionEntry[] = [],
): Pick<GroundedPortableSummarizerQuery, "context" | "branchEntries"> {
    return {
        context: createContext(models),
        branchEntries,
    };
}

function createQuery(model = createModel()): GroundedPortableSummarizerQuery {
    return {
        kind: "open-portable-summarizer",
        context: createContext([model]),
        branchEntries: [],
        response: { status: "unavailable" },
    };
}

function fixedPromptTokens(previousSummary: string | null, promptContract = PROMPT_CONTRACT): number {
    const emptySourcePrompt = buildSummaryUserPrompt({
        mode: "history",
        promptContract,
        serializedConversation: "",
        previousSummary: previousSummary ?? undefined,
    });
    return estimateInputTokens(`${DEFAULT_SYSTEM_PROMPT}\n\n${emptySourcePrompt}`);
}

function createCapacityModel(
    sourceTokenCapacity: number,
    previousSummary: string | null = null,
    promptContract = PROMPT_CONTRACT,
): Model<Api> {
    return createModel({
        contextWindow: fixedPromptTokens(previousSummary, promptContract) + 1 + sourceTokenCapacity,
        maxTokens: 1,
    });
}

async function openSession(params: {
    model?: Model<Api>;
    branchEntries?: readonly SessionEntry[];
    dependencies?: GroundedPortableSummarizerDependencies;
    signal?: AbortSignal;
} = {}): Promise<GroundedPortableSummarizerSession> {
    const model = params.model ?? createModel();
    return openGroundedPortableSummarizerSession(
        createOpenRequest([model], params.branchEntries ?? []),
        params.signal ?? new AbortController().signal,
        params.dependencies ?? createDependencies(),
    );
}

type EventListener = (payload: unknown) => void;
type Hook = (event: unknown, context: unknown) => unknown;

class TestEventBus {
    private readonly listeners = new Map<string, Set<EventListener>>();

    on(eventName: string, listener: EventListener): () => void {
        const eventListeners = this.listeners.get(eventName) ?? new Set<EventListener>();
        eventListeners.add(listener);
        this.listeners.set(eventName, eventListeners);
        return () => eventListeners.delete(listener);
    }

    emit(eventName: string, payload: unknown): void {
        for (const listener of this.listeners.get(eventName) ?? []) {
            listener(payload);
        }
    }
}

function createPi(bus = new TestEventBus()) {
    const hooks = new Map<string, Hook[]>();
    const pi = {
        events: bus,
        on(eventName: string, hook: Hook) {
            const eventHooks = hooks.get(eventName) ?? [];
            eventHooks.push(hook);
            hooks.set(eventName, eventHooks);
        },
    } as unknown as ExtensionAPI;
    return { pi, bus, hooks };
}

async function runShutdown(hooks: Map<string, Hook[]>): Promise<void> {
    for (const hook of hooks.get("session_shutdown") ?? []) {
        await hook({ type: "session_shutdown", reason: "reload" }, {});
    }
}

describe("grounded portable summarizer protocol", () => {
    it("registers lazily and mutates a query synchronously", async () => {
        const { pi, bus } = createPi();
        let openCalls = 0;
        registerGroundedPortableSummarizer(pi, async () => {
            openCalls += 1;
            return openSession();
        });

        assert.equal(openCalls, 0);
        const query = createQuery();
        bus.emit(GROUNDED_PORTABLE_SUMMARIZER_EVENT, query);
        assert.equal(query.response.status, "available");
        assert.equal(openCalls, 0);

        assert.equal(query.response.status, "available");
        await query.response.openSession(new AbortController().signal);
        assert.equal(openCalls, 1);
    });

    it("does not advertise availability for an incomplete model registry", () => {
        const { pi, bus } = createPi();
        let openCalls = 0;
        registerGroundedPortableSummarizer(pi, async () => {
            openCalls += 1;
            return openSession();
        });
        const query = createQuery();
        delete (query.context.modelRegistry as unknown as Record<string, unknown>).getProvider;

        bus.emit(GROUNDED_PORTABLE_SUMMARIZER_EVENT, query);

        assert.deepEqual(query.response, { status: "unavailable" });
        assert.equal(openCalls, 0);
    });

    it("requires cwd and exact context keys before advertising availability", () => {
        const { pi, bus } = createPi();
        registerGroundedPortableSummarizer(pi, async () => openSession());

        for (const mutate of [
            (context: Record<string, unknown>) => delete context.cwd,
            (context: Record<string, unknown>) => { context.extra = true; },
        ]) {
            const query = createQuery();
            mutate(query.context as unknown as Record<string, unknown>);
            bus.emit(GROUNDED_PORTABLE_SUMMARIZER_EVENT, query);
            assert.deepEqual(query.response, { status: "unavailable" });
        }
    });

    it("rejects malformed responses and extra fields", () => {
        assert.deepEqual(normalizeGroundedPortableSummarizerResponse(null), {
            status: "error",
            error: "Invalid grounded portable summarizer response",
        });
        assert.equal(normalizeGroundedPortableSummarizerResponse({
            status: "unavailable",
            extra: true,
        }).status, "error");
        assert.equal(normalizeGroundedPortableSummarizerResponse({
            status: "error",
            error: "broken",
            extra: true,
        }).status, "error");
    });

    it("makes duplicate available responders deterministic in either order", () => {
        for (const reverse of [false, true]) {
            const { pi, bus } = createPi();
            const responders = [
                async () => openSession(),
                async () => openSession(),
            ];
            if (reverse) responders.reverse();
            for (const responder of responders) {
                registerGroundedPortableSummarizer(pi, responder);
            }

            const query = createQuery();
            bus.emit(GROUNDED_PORTABLE_SUMMARIZER_EVENT, query);
            assert.deepEqual(query.response, {
                status: "error",
                error: "Multiple grounded portable summarizer responders",
            });
        }
    });

    it("keeps explicit errors dominant in either merge order", async () => {
        const available = {
            status: "available" as const,
            openSession: async () => openSession(),
        };
        const error = { status: "error" as const, error: "owned failure" };

        assert.deepEqual(mergeGroundedPortableSummarizerResponse(available, error), error);
        assert.deepEqual(mergeGroundedPortableSummarizerResponse(error, available), error);
    });

    it("unsubscribes on session shutdown", async () => {
        const { pi, bus, hooks } = createPi();
        registerGroundedPortableSummarizer(pi, async () => openSession());
        await runShutdown(hooks);

        const query = createQuery();
        bus.emit(GROUNDED_PORTABLE_SUMMARIZER_EVENT, query);
        assert.deepEqual(query.response, { status: "unavailable" });
    });
});

describe("grounded portable summarizer resolution", () => {
    it("uses the current non-Codex model and branch thinking level", async () => {
        const model = createModel();
        let authenticatedModel: Model<Api> | undefined;
        const request = createOpenRequest([model], [thinkingEntry("high")]);
        request.context.modelRegistry.getApiKeyAndHeaders = async (candidate) => {
            authenticatedModel = candidate;
            return { ok: true as const, apiKey: "test-key" };
        };

        const session = await openGroundedPortableSummarizerSession(
            request,
            new AbortController().signal,
            createDependencies(),
        );

        assert.equal(authenticatedModel, model);
        assert.deepEqual(session.descriptor, {
            provider: "openai",
            api: "openai-responses",
            modelId: "gpt-portable",
            thinkingLevel: "high",
            contextWindow: 20_000,
            maxOutputTokens: 4_000,
            promptFingerprint: session.descriptor.promptFingerprint,
        });
        assert.match(session.descriptor.promptFingerprint, /^[a-f0-9]{64}$/);
    });

    it("uses the configured named default preset and reasoning level", async () => {
        const activeModel = createModel({ id: "active" });
        const presetModel = createModel({
            provider: "anthropic",
            api: "anthropic-messages",
            id: "preset-model",
            name: "Preset Model",
        });
        const request = createOpenRequest([activeModel, presetModel]);
        let authenticatedModel: Model<Api> | undefined;
        request.context.modelRegistry.getApiKeyAndHeaders = async (candidate) => {
            authenticatedModel = candidate;
            return { ok: true as const, apiKey: "preset-key" };
        };

        const session = await openGroundedPortableSummarizerSession(
            request,
            new AbortController().signal,
            createDependencies({
                loadConfig: async () => createConfig({
                    defaultPreset: "portable",
                    presets: {
                        portable: {
                            model: "anthropic/preset-model",
                            thinkingLevel: "low",
                        },
                    },
                }),
            }),
        );

        assert.equal(authenticatedModel, presetModel);
        assert.equal(session.descriptor.provider, "anthropic");
        assert.equal(session.descriptor.modelId, "preset-model");
        assert.equal(session.descriptor.thinkingLevel, "low");
    });

    it("rejects preset and authentication failures without falling back", async () => {
        const activeModel = createModel({ id: "active" });
        let authCalls = 0;
        const request = createOpenRequest([activeModel]);
        request.context.modelRegistry.getApiKeyAndHeaders = async () => {
            authCalls += 1;
            return { ok: true as const, apiKey: "active-key" };
        };

        await assert.rejects(
            openGroundedPortableSummarizerSession(
                request,
                new AbortController().signal,
                createDependencies({
                    loadConfig: async () => createConfig({
                        defaultPreset: "missing",
                        presets: {
                            missing: { model: "anthropic/not-registered" },
                        },
                    }),
                }),
            ),
            /not registered/,
        );
        assert.equal(authCalls, 0);

        request.context.modelRegistry.getApiKeyAndHeaders = async () => {
            authCalls += 1;
            return { ok: false as const, error: "authentication denied" };
        };
        await assert.rejects(
            openGroundedPortableSummarizerSession(
                request,
                new AbortController().signal,
                createDependencies(),
            ),
            /authentication denied/,
        );
        assert.equal(authCalls, 1);
    });

    it("hot-loads config and prompt on every open", async () => {
        let configReads = 0;
        let promptReads = 0;
        const dependencies = createDependencies({
            loadConfig: async () => {
                configReads += 1;
                return createConfig();
            },
            loadCompactionPrompt: async () => {
                promptReads += 1;
                return `prompt-${promptReads}`;
            },
        });

        const first = await openSession({ dependencies });
        const second = await openSession({ dependencies });

        assert.equal(configReads, 2);
        assert.equal(promptReads, 2);
        assert.notEqual(first.descriptor.promptFingerprint, second.descriptor.promptFingerprint);
    });

    it("rejects canonical Codex for the current preset", async () => {
        const model = createModel({
            provider: "openai-codex",
            api: "openai-codex-responses",
        });
        await assert.rejects(openSession({ model }), /active non-Codex model/);
    });

    it("rejects invalid and unusably small model limits", async () => {
        for (const contextWindow of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 3]) {
            await assert.rejects(
                openSession({ model: createModel({ contextWindow }) }),
                /contextWindow/,
            );
        }
        for (const maxTokens of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
            await assert.rejects(
                openSession({ model: createModel({ maxTokens }) }),
                /maxTokens/,
            );
        }
    });

    it("chooses the minimum portable output limit", async () => {
        assert.equal((await openSession({
            model: createModel({ contextWindow: 100_000, maxTokens: 20_000 }),
        })).descriptor.maxOutputTokens, PORTABLE_SUMMARY_MAX_OUTPUT_TOKENS);
        assert.equal((await openSession({
            model: createModel({ contextWindow: 100_000, maxTokens: 700 }),
        })).descriptor.maxOutputTokens, 700);
        assert.equal((await openSession({
            model: createModel({ contextWindow: 1_000, maxTokens: 700 }),
        })).descriptor.maxOutputTokens, 250);
    });
});

describe("grounded portable summarizer capacity and execution", () => {
    it("uses exact fixed overhead and completes an exact-fit chunk", async () => {
        const model = createCapacityModel(10);
        let promptText = "";
        let maxTokens = 0;
        const session = await openSession({
            model,
            dependencies: createDependencies({
                complete: async (_model, context, options, provider) => {
                    promptText = (context.messages[0].content[0] as { text: string }).text;
                    maxTokens = options?.maxTokens ?? 0;
                    assert.equal(provider.id, model.provider);
                    return createAssistantResponse();
                },
            }),
        });
        const sourceText = "x".repeat(40);
        const result = await session.summarizeNext({
            previousSummary: null,
            sourceText,
            startOffset: 0,
            coverageEntries: [],
            signal: new AbortController().signal,
        });

        assert.equal(result.endOffset, sourceText.length);
        assert.equal(maxTokens, 1);
        assert.match(promptText, new RegExp(sourceText));
    });

    it("accounts for predecessor summary in fixed overhead", async () => {
        const previousSummary = "p".repeat(80);
        const predecessorOverhead = fixedPromptTokens(previousSummary) - fixedPromptTokens(null);
        const sourceTokenCapacity = predecessorOverhead + 20;
        const model = createCapacityModel(sourceTokenCapacity, null);
        const withoutPrevious = await openSession({ model });
        const withPrevious = await openSession({ model });
        const sourceText = "x".repeat(sourceTokenCapacity * 8);

        const first = await withoutPrevious.summarizeNext({
            previousSummary: null,
            sourceText,
            startOffset: 0,
            coverageEntries: [],
            signal: new AbortController().signal,
        });
        const second = await withPrevious.summarizeNext({
            previousSummary,
            sourceText,
            startOffset: 0,
            coverageEntries: [],
            signal: new AbortController().signal,
        });

        assert.ok(second.endOffset < first.endOffset);
    });

    it("prefers double newline, then newline, then whitespace, then the hard boundary", async () => {
        const model = createCapacityModel(10);
        const session = await openSession({ model });
        const signal = new AbortController().signal;

        const doubleNewline = `${"a".repeat(31)}\n\n${"b".repeat(4)}\n${"c".repeat(20)}`;
        assert.equal((await session.summarizeNext({
            previousSummary: null,
            sourceText: doubleNewline,
            startOffset: 0,
            coverageEntries: [],
            signal,
        })).endOffset, 33);

        const newline = `${"a".repeat(35)}\n${"b".repeat(20)}`;
        assert.equal((await session.summarizeNext({
            previousSummary: null,
            sourceText: newline,
            startOffset: 0,
            coverageEntries: [],
            signal,
        })).endOffset, 36);

        const whitespace = `${"a".repeat(37)} ${"b".repeat(20)}`;
        assert.equal((await session.summarizeNext({
            previousSummary: null,
            sourceText: whitespace,
            startOffset: 0,
            coverageEntries: [],
            signal,
        })).endOffset, 38);

        const hard = "a".repeat(60);
        assert.equal((await session.summarizeNext({
            previousSummary: null,
            sourceText: hard,
            startOffset: 0,
            coverageEntries: [],
            signal,
        })).endOffset, 40);
    });

    it("fails when fixed overhead leaves no source capacity", async () => {
        const model = createCapacityModel(0);
        const session = await openSession({ model });
        await assert.rejects(
            session.summarizeNext({
                previousSummary: null,
                sourceText: "source",
                startOffset: 0,
                coverageEntries: [],
                signal: new AbortController().signal,
            }),
            /leaves no source capacity/,
        );
    });

    it("moves backward rather than splitting a UTF-16 surrogate pair", async () => {
        const model = createCapacityModel(1);
        let promptText = "";
        const session = await openSession({
            model,
            dependencies: createDependencies({
                complete: async (_model, context) => {
                    promptText = (context.messages[0].content[0] as { text: string }).text;
                    return createAssistantResponse();
                },
            }),
        });
        const result = await session.summarizeNext({
            previousSummary: null,
            sourceText: "aaa😀rest",
            startOffset: 0,
            coverageEntries: [],
            signal: new AbortController().signal,
        });

        assert.equal(result.endOffset, 3);
        assert.equal(promptText.includes("😀"), false);
        assert.equal(promptText.includes("\uD83D"), false);
    });

    it("returns exact normalized usage without mutating it", async () => {
        const response = createAssistantResponse();
        const session = await openSession({
            dependencies: createDependencies({ complete: async () => response }),
        });
        const result = await session.summarizeNext({
            previousSummary: null,
            sourceText: "source",
            startOffset: 0,
            coverageEntries: [],
            signal: new AbortController().signal,
        });

        assert.deepEqual(result.usage, EXPECTED_USAGE);
        assert.notEqual(result.usage, response.usage);
        assert.notEqual(result.usage?.cost, response.usage.cost);
    });

    it("rebuilds and caches one cumulative manifest from exact supplied coverage", async () => {
        const firstCoverage = [thinkingEntry("low")];
        const expandedCoverage = [...firstCoverage, thinkingEntry("high")];
        const collected: Array<{ entries: readonly SessionEntry[]; cwd: string | null | undefined }> = [];
        const prompts: string[] = [];
        const file = (displayPath: string): FilesTouchedEntry => ({
            path: `/workspace/${displayPath}`,
            displayPath,
            operations: new Set(["read"]),
            lastTimestamp: 1,
        });
        const session = await openSession({
            branchEntries: [thinkingEntry("tail")],
            dependencies: createDependencies({
                loadConfig: async () => createConfig(),
                collectFilesTouched: (entries, cwd) => {
                    collected.push({ entries, cwd });
                    return entries.length === 1 ? [file("before.ts")] : [file("before.ts"), file("later.ts")];
                },
                complete: async (_model, context) => {
                    prompts.push((context.messages[0].content[0] as { text: string }).text);
                    return createAssistantResponse(
                        "updated\n\n---\n\n## Files touched (cumulative)\n"
                        + "R=read, W=write, E=edit, M=move/rename, D=delete\n\n```text\nR  stale.ts\n```",
                    );
                },
            }),
        });
        const previousSummary = "previous\n\n---\n\n## Files touched (cumulative)\n"
            + "R=read, W=write, E=edit, M=move/rename, D=delete\n\n```text\nR  old.ts\n```";

        const first = await session.summarizeNext({
            previousSummary,
            sourceText: "source",
            startOffset: 0,
            coverageEntries: firstCoverage,
            signal: new AbortController().signal,
        });
        const repeated = await session.summarizeNext({
            previousSummary: first.summary,
            sourceText: "source",
            startOffset: 0,
            coverageEntries: firstCoverage,
            signal: new AbortController().signal,
        });
        const expanded = await session.summarizeNext({
            previousSummary: repeated.summary,
            sourceText: "source",
            startOffset: 0,
            coverageEntries: expandedCoverage,
            signal: new AbortController().signal,
        });

        assert.equal(collected.length, 2);
        assert.deepEqual(collected.map(({ entries }) => entries), [firstCoverage, expandedCoverage]);
        assert.deepEqual(collected.map(({ cwd }) => cwd), ["/workspace", "/workspace"]);
        assert.equal(prompts.every((prompt) => !prompt.includes("old.ts") && !prompt.includes("before.ts")), true);
        assert.equal((first.summary.match(/## Files touched/g) ?? []).length, 1);
        assert.equal((repeated.summary.match(/## Files touched/g) ?? []).length, 1);
        assert.match(expanded.summary, /R  before\.ts/);
        assert.match(expanded.summary, /R  later\.ts/);
        assert.doesNotMatch(expanded.summary, /stale\.ts|old\.ts/);
    });

    it("omits manifests when disabled and fails collection before provider dispatch", async () => {
        let completionCalls = 0;
        const disabled = await openSession({
            dependencies: createDependencies({
                collectFilesTouched: () => { throw new Error("must not collect"); },
                complete: async () => {
                    completionCalls += 1;
                    return createAssistantResponse("summary");
                },
            }),
        });
        const inherited = "previous\n\n---\n\n## Files touched (cumulative)\n"
            + "R=read, W=write, E=edit, M=move/rename, D=delete\n\n```text\nR  old.ts\n```";
        const result = await disabled.summarizeNext({
            previousSummary: inherited,
            sourceText: "source",
            startOffset: 0,
            coverageEntries: [],
            signal: new AbortController().signal,
        });
        assert.equal(completionCalls, 1);
        assert.equal(result.summary, "summary");

        const failing = await openSession({
            dependencies: createDependencies({
                loadConfig: async () => createConfig(),
                collectFilesTouched: () => { throw new Error("collection failed"); },
                complete: async () => {
                    completionCalls += 1;
                    return createAssistantResponse();
                },
            }),
        });
        await assert.rejects(failing.summarizeNext({
            previousSummary: null,
            sourceText: "source",
            startOffset: 0,
            coverageEntries: [],
            signal: new AbortController().signal,
        }), /collection failed/);
        assert.equal(completionCalls, 1);
    });

    it("surfaces provider errors, output limits, and empty output", async () => {
        const providerError = await openSession({
            dependencies: createDependencies({
                complete: async () => createAssistantResponse("", {
                    stopReason: "error",
                    errorMessage: "provider unavailable",
                }),
            }),
        });
        await assert.rejects(
            providerError.summarizeNext({
                previousSummary: null,
                sourceText: "source",
                startOffset: 0,
                coverageEntries: [],
                signal: new AbortController().signal,
            }),
            /provider unavailable/,
        );

        const outputLimited = await openSession({
            dependencies: createDependencies({
                complete: async () => createAssistantResponse("truncated", { stopReason: "length" }),
            }),
        });
        await assert.rejects(
            outputLimited.summarizeNext({
                previousSummary: null,
                sourceText: "source",
                startOffset: 0,
                coverageEntries: [],
                signal: new AbortController().signal,
            }),
            /output token limit/,
        );

        const emptyOutput = await openSession({
            dependencies: createDependencies({ complete: async () => createAssistantResponse("  ") }),
        });
        await assert.rejects(
            emptyOutput.summarizeNext({
                previousSummary: null,
                sourceText: "source",
                startOffset: 0,
                coverageEntries: [],
                signal: new AbortController().signal,
            }),
            /empty output/,
        );
    });

    it("honors cancellation before opening, before completion, and during completion", async () => {
        const openController = new AbortController();
        openController.abort();
        await assert.rejects(
            openSession({ signal: openController.signal }),
            /Compaction aborted/,
        );

        let completionCalls = 0;
        const session = await openSession({
            dependencies: createDependencies({
                complete: async () => {
                    completionCalls += 1;
                    return createAssistantResponse();
                },
            }),
        });
        const beforeController = new AbortController();
        beforeController.abort();
        await assert.rejects(
            session.summarizeNext({
                previousSummary: null,
                sourceText: "source",
                startOffset: 0,
                coverageEntries: [],
                signal: beforeController.signal,
            }),
            /Compaction aborted/,
        );
        assert.equal(completionCalls, 0);

        const duringController = new AbortController();
        const duringSession = await openSession({
            dependencies: createDependencies({
                complete: async () => {
                    duringController.abort();
                    return createAssistantResponse();
                },
            }),
        });
        await assert.rejects(
            duringSession.summarizeNext({
                previousSummary: null,
                sourceText: "source",
                startOffset: 0,
                coverageEntries: [],
                signal: duringController.signal,
            }),
            /Compaction aborted/,
        );
    });
});
