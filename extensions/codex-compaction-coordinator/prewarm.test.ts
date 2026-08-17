import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";

import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";

import { registerGroundedPortableSummarizer } from "../grounded-compaction/portable-summarizer.ts";
import { PORTABILITY_MODE_CUSTOM_TYPE } from "./portability-mode.ts";
import { PORTABLE_SUMMARY_CUSTOM_TYPE } from "./portable-record.ts";
import { registerCodexCompactionPortability } from "./portability.ts";
import { registerCodexCompactionPrewarm } from "./prewarm.ts";

type Hook = (event: any, ctx: any) => Promise<any> | any;

class Bus {
    private readonly emitter = new EventEmitter();

    on(name: string, listener: (payload: unknown) => void): () => void {
        this.emitter.on(name, listener);
        return () => this.emitter.off(name, listener);
    }

    emit(name: string, payload: unknown): void {
        this.emitter.emit(name, payload);
    }
}

function userEntry(id: string, text: string, parentId: string | null = null): SessionEntry {
    return {
        type: "message",
        id,
        parentId,
        timestamp: "2026-07-25T00:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text }], timestamp: 1 },
    } as SessionEntry;
}

function checkpointEntry(parentId: string, id = "checkpoint-1"): SessionEntry {
    return {
        type: "compaction",
        id,
        parentId,
        timestamp: "2026-07-25T00:00:01.000Z",
        summary: "[OpenAI native compaction checkpoint]",
        firstKeptEntryId: parentId,
        tokensBefore: 12_345,
        details: {
            strategy: "openai-responses-compaction-v2",
            provider: "openai-codex",
            api: "openai-codex-responses",
            model: "gpt-test",
            baseUrl: "https://chatgpt.com/backend-api",
            compactedWindow: [{ type: "compaction_summary", encrypted_content: "sealed" }],
            createdAt: "2026-07-25T00:00:01.000Z",
        },
    } as SessionEntry;
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolver, rejecter) => {
        resolve = resolver;
        reject = rejecter;
    });
    return { promise, resolve, reject };
}

function createHarness(
    summaryPromise?: Promise<{ summary: string; endOffset: number; usage: null }>,
    ignoreAbort = false,
    summarizeOverride?: (
        request: { sourceText: string; signal: AbortSignal },
        callIndex: number,
    ) => Promise<{ summary: string; endOffset: number; usage: null }>,
    openSessionPromise?: Promise<void>,
    openSessionOverride?: (openIndex: number, signal: AbortSignal) => Promise<void>,
) {
    const bus = new Bus();
    const hooks = new Map<string, Hook[]>();
    const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
    const user = userEntry("user-1", "remember alpha");
    let branch = [user, checkpointEntry(user.id)];
    let entries = [...branch];
    let model = {
        id: "gpt-test",
        name: "GPT Test",
        provider: "openai-codex",
        api: "openai-codex-responses",
        contextWindow: 128_000,
        maxTokens: 16_384,
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    let customId = 0;
    let failPortableAppends = false;
    let summaryCalls = 0;
    let latestSourceLength = 0;
    let latestOpenSignal: AbortSignal | undefined;
    let openCalls = 0;
    const openedBranchEntries: Array<readonly SessionEntry[]> = [];
    const openedModelIds: string[] = [];
    let abortCalls = 0;
    const notices: string[] = [];
    const pi = {
        events: bus,
        on(name: string, hook: Hook) {
            hooks.set(name, [...(hooks.get(name) ?? []), hook]);
        },
        registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) {
            commands.set(name, command.handler);
        },
        appendEntry(customType: string, data: unknown) {
            if (customType === PORTABLE_SUMMARY_CUSTOM_TYPE && failPortableAppends) {
                throw new Error("append unavailable");
            }
            const entry = {
                type: "custom",
                id: `custom-${++customId}`,
                parentId: branch.at(-1)?.id ?? null,
                timestamp: "2026-07-25T00:00:02.000Z",
                customType,
                data,
            } as SessionEntry;
            branch = [...branch, entry];
            entries = [...entries, entry];
        },
    } as unknown as ExtensionAPI;

    registerCodexCompactionPrewarm(pi, {
        randomUUID: () => `00000000-0000-4000-8000-${String(customId + 1).padStart(12, "0")}`,
    });
    registerGroundedPortableSummarizer(pi, async (request, signal) => {
        latestOpenSignal = signal;
        openedModelIds.push(request.context.model.id);
        openedBranchEntries.push(request.branchEntries);
        const openIndex = openCalls++;
        if (openSessionOverride) await openSessionOverride(openIndex, signal);
        else if (openSessionPromise) await openSessionPromise;
        return {
            descriptor: {
                provider: "anthropic",
                api: "anthropic-messages",
                modelId: "claude-test",
                thinkingLevel: "off",
                contextWindow: 200_000,
                maxOutputTokens: 8_192,
                promptFingerprint: "a".repeat(64),
            },
            summarizeNext: async (request) => {
                summaryCalls += 1;
                latestSourceLength = request.sourceText.length;
                if (summarizeOverride) return summarizeOverride(request, summaryCalls - 1);
                if (summaryPromise) {
                    if (ignoreAbort) return summaryPromise;
                    return Promise.race([
                        summaryPromise,
                        new Promise<never>((_resolve, reject) => {
                            request.signal.addEventListener("abort", () => {
                                reject(new DOMException("aborted", "AbortError"));
                            }, { once: true });
                        }),
                    ]);
                }
                return {
                    summary: "portable summary",
                    endOffset: request.sourceText.length,
                    usage: null,
                };
            },
        };
    });

    const context = (controller = new AbortController()) => {
        return {
            cwd: "/repo",
            model,
            signal: controller.signal,
            abort() { abortCalls += 1; controller.abort(); },
            hasUI: true,
            ui: {
                notify(message: string) { notices.push(message); },
            },
            modelRegistry: {
                getAll: () => [model],
                getProvider: () => ({}),
                getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }),
            },
            sessionManager: {
                getSessionId: () => "session-1",
                getBranch: () => branch,
                getEntries: () => entries,
                getLeafId: () => branch.at(-1)?.id,
            },
        };
    };

    const runHooks = async (name: string) => {
        const ctx = context();
        for (const hook of hooks.get(name) ?? []) await hook({ type: name }, ctx);
    };

    return {
        bus,
        pi,
        commands,
        context,
        hooks,
        notices,
        get branch() { return branch; },
        get entries() { return entries; },
        get summaryCalls() { return summaryCalls; },
        get latestSourceLength() { return latestSourceLength; },
        get latestOpenSignal() { return latestOpenSignal; },
        get openCalls() { return openCalls; },
        get openedBranchEntries() { return openedBranchEntries; },
        get openedModelIds() { return openedModelIds; },
        get abortCalls() { return abortCalls; },
        setModel(next: typeof model) { model = next; },
        setBranch(next: SessionEntry[]) { branch = next; },
        setFailPortableAppends(value: boolean) { failPortableAppends = value; },
        appendUserAndCheckpoint() {
            const user = userEntry("user-2", "later visible work", branch.at(-1)?.id ?? null);
            const checkpoint = checkpointEntry(user.id, "checkpoint-2");
            branch = [...branch, user, checkpoint];
            entries = [...entries, user, checkpoint];
        },
        runHooks,
        async command(args: string) { await commands.get("codex-portability")!(args, context()); },
        async flush() { await new Promise((resolve) => setTimeout(resolve, 0)); },
    };
}

describe("Codex portability prewarm", () => {
    it("defaults to lazy and keeps status read-only", async () => {
        const harness = createHarness();
        await harness.command("status");
        await harness.flush();
        assert.equal(harness.summaryCalls, 0);
        assert.equal(harness.entries.some((entry) => entry.type === "custom" && entry.customType === PORTABILITY_MODE_CUSTOM_TYPE), false);
        assert.match(harness.notices.at(-1)!, /mode=lazy/);
    });

    it("prewarms immediately but commits only at a safe boundary", async () => {
        const harness = createHarness();
        await harness.command("prewarm");
        await harness.flush();
        assert.equal(harness.summaryCalls, 1);
        assert.equal(harness.branch.some((entry) => entry.type === "custom" && entry.customType === PORTABLE_SUMMARY_CUSTOM_TYPE), false);

        await harness.runHooks("agent_end");
        assert.equal(harness.branch.filter((entry) => entry.type === "custom" && entry.customType === PORTABLE_SUMMARY_CUSTOM_TYPE).length, 1);
    });

    it("does not expose native compacted windows to prewarm grounded discovery", async () => {
        const harness = createHarness();
        await harness.command("prewarm");
        await harness.flush();

        assert.deepEqual(harness.openedBranchEntries[0]!.map((entry) => entry.id), ["user-1"]);
        assert.equal(JSON.stringify(harness.openedBranchEntries).includes("sealed"), false);
    });

    it("rejects malformed post-checkpoint source identities before prewarm provider work", async () => {
        const harness = createHarness();
        const tail = userEntry("tail", "must not leak", harness.branch.at(-1)!.id);
        delete (tail as unknown as Record<string, unknown>).id;
        harness.setBranch([...harness.branch, tail]);

        await harness.command("prewarm");
        await harness.flush();

        assert.equal(harness.openCalls, 0);
        assert.equal(harness.summaryCalls, 0);
        assert.equal(harness.branch.some((entry) => entry.type === "custom"
            && entry.customType === PORTABLE_SUMMARY_CUSTOM_TYPE), false);
    });

    it("commits a paid result that fulfills after the turn becomes append-safe", async () => {
        const pending = deferred<{ summary: string; endOffset: number; usage: null }>();
        const harness = createHarness(pending.promise);
        await harness.command("prewarm");
        await harness.flush();

        await harness.runHooks("agent_end");
        pending.resolve({ summary: "late paid summary", endOffset: harness.latestSourceLength, usage: null });
        await harness.flush();

        assert.equal(harness.summaryCalls, 1);
        assert.equal(harness.branch.filter((entry) =>
            entry.type === "custom" && entry.customType === PORTABLE_SUMMARY_CUSTOM_TYPE).length, 1);
    });

    it("lets an incoming non-Codex context join and commit in-flight work without a duplicate call", async () => {
        const pending = deferred<{ summary: string; endOffset: number; usage: null }>();
        const harness = createHarness(pending.promise);
        await harness.command("prewarm");
        await harness.flush();
        harness.setModel({ ...harness.context().model, provider: "anthropic", api: "anthropic-messages" });
        await harness.runHooks("model_select");
        const contextHook = harness.hooks.get("context")![0]!;
        const contextPromise = contextHook({ messages: [] }, harness.context());
        pending.resolve({ summary: "joined summary", endOffset: harness.latestSourceLength, usage: null });
        await contextPromise;
        assert.equal(harness.summaryCalls, 1);
        assert.equal(harness.branch.filter((entry) => entry.type === "custom" && entry.customType === PORTABLE_SUMMARY_CUSTOM_TYPE).length, 1);
        assert.equal(harness.abortCalls, 0);
    });

    it("cancels unfulfilled background work when switching back to lazy", async () => {
        const pending = deferred<{ summary: string; endOffset: number; usage: null }>();
        const harness = createHarness(pending.promise);
        await harness.command("prewarm");
        await harness.flush();
        await harness.command("lazy");
        await harness.flush();
        assert.equal(harness.summaryCalls, 1);
        assert.equal(harness.branch.some((entry) => entry.type === "custom" && entry.customType === PORTABLE_SUMMARY_CUSTOM_TYPE), false);
    });

    it("cancels the current unfulfilled chunk while retaining an earlier pending chunk", async () => {
        let secondCallAborted = false;
        const harness = createHarness(undefined, false, async (request, callIndex) => {
            if (callIndex === 0) {
                return {
                    summary: "partial summary",
                    endOffset: Math.max(1, Math.floor(request.sourceText.length / 2)),
                    usage: null,
                };
            }
            return new Promise((_resolve, reject) => {
                request.signal.addEventListener("abort", () => {
                    secondCallAborted = true;
                    reject(new DOMException("aborted", "AbortError"));
                }, { once: true });
            });
        });
        await harness.command("prewarm");
        await harness.flush();
        assert.equal(harness.summaryCalls, 2);
        await harness.command("lazy");
        await harness.flush();
        assert.equal(secondCallAborted, true);
        await harness.runHooks("agent_end");
        assert.equal(harness.branch.filter((entry) => entry.type === "custom" && entry.customType === PORTABLE_SUMMARY_CUSTOM_TYPE).length, 1);
    });

    it("cancels an active chunk after a safe boundary commits its prefix", async () => {
        let secondCallAborted = false;
        const harness = createHarness(undefined, false, async (request, callIndex) => {
            if (callIndex === 0) {
                return {
                    summary: "durable prefix",
                    endOffset: Math.max(1, Math.floor(request.sourceText.length / 2)),
                    usage: null,
                };
            }
            return new Promise((_resolve, reject) => {
                request.signal.addEventListener("abort", () => {
                    secondCallAborted = true;
                    reject(new DOMException("aborted", "AbortError"));
                }, { once: true });
            });
        });
        await harness.command("prewarm");
        await harness.flush();
        assert.equal(harness.summaryCalls, 2);

        await harness.runHooks("agent_end");
        assert.equal(harness.branch.filter((entry) =>
            entry.type === "custom" && entry.customType === PORTABLE_SUMMARY_CUSTOM_TYPE).length, 1);
        await harness.command("lazy");
        await harness.flush();

        assert.equal(secondCallAborted, true);
    });

    it("rejects a current-chunk result that resolves only after lazy cancellation", async () => {
        const lateResult = deferred<{ summary: string; endOffset: number; usage: null }>();
        const harness = createHarness(undefined, false, async (request, callIndex) => {
            if (callIndex === 0) {
                return {
                    summary: "partial summary",
                    endOffset: Math.max(1, Math.floor(request.sourceText.length / 2)),
                    usage: null,
                };
            }
            return lateResult.promise;
        });
        await harness.command("prewarm");
        await harness.flush();
        await harness.command("lazy");
        await harness.flush();
        lateResult.resolve({ summary: "late result", endOffset: harness.latestSourceLength, usage: null });
        await harness.flush();
        await harness.runHooks("agent_end");
        assert.equal(harness.summaryCalls, 2);
        assert.equal(harness.branch.filter((entry) => entry.type === "custom" && entry.customType === PORTABLE_SUMMARY_CUSTOM_TYPE).length, 1);
    });

    it("lets a cancelled joiner return while shared background work continues", async () => {
        const pending = deferred<{ summary: string; endOffset: number; usage: null }>();
        const harness = createHarness(pending.promise);
        await harness.command("prewarm");
        await harness.flush();
        harness.setModel({ ...harness.context().model, provider: "anthropic", api: "anthropic-messages" });
        const controller = new AbortController();
        const join = harness.hooks.get("context")![0]!({ messages: [] }, harness.context(controller));
        controller.abort();
        assert.deepEqual(await join, { messages: [] });
        assert.equal(harness.summaryCalls, 1);

        pending.resolve({ summary: "background result", endOffset: harness.latestSourceLength, usage: null });
        await harness.flush();
        await harness.runHooks("agent_end");
        assert.equal(harness.branch.filter((entry) => entry.type === "custom" && entry.customType === PORTABLE_SUMMARY_CUSTOM_TYPE).length, 1);
    });

    it("restarts settled incomplete work when prewarm is enabled again", async () => {
        const harness = createHarness(undefined, false, async (request, callIndex) => {
            if (callIndex === 0) {
                return new Promise((_resolve, reject) => {
                    request.signal.addEventListener("abort", () => {
                        reject(new DOMException("aborted", "AbortError"));
                    }, { once: true });
                });
            }
            return { summary: "resumed summary", endOffset: request.sourceText.length, usage: null };
        });
        await harness.command("prewarm");
        await harness.flush();
        await harness.command("lazy");
        await harness.flush();
        await harness.command("prewarm");
        await harness.flush();
        assert.equal(harness.summaryCalls, 2);
        await harness.runHooks("agent_end");
        assert.equal(harness.branch.filter((entry) => entry.type === "custom" && entry.customType === PORTABLE_SUMMARY_CUSTOM_TYPE).length, 1);
    });

    it("reserves a waiter that switches from prewarm to lazy before completion", async () => {
        const firstCall = deferred<{ summary: string; endOffset: number; usage: null }>();
        const lazyRemainder = deferred<{ summary: string; endOffset: number; usage: null }>();
        const harness = createHarness(undefined, false, async (request, callIndex) => {
            if (callIndex === 0) return firstCall.promise;
            return lazyRemainder.promise;
        });
        registerCodexCompactionPortability(harness.pi);
        await harness.command("prewarm");
        await harness.flush();
        harness.setModel({ ...harness.context().model, provider: "anthropic", api: "anthropic-messages" });
        const hooks = harness.hooks.get("context")!;
        const ctx = harness.context();
        const prewarmWaiter = hooks[0]!({ messages: [] }, ctx);

        await harness.command("lazy");
        firstCall.resolve({
            summary: "partial paid result",
            endOffset: Math.max(1, Math.floor(harness.latestSourceLength / 2)),
            usage: null,
        });
        assert.equal(await prewarmWaiter, undefined);
        const lazy = hooks[1]!({ messages: [] }, ctx);
        await harness.flush();
        assert.equal(harness.summaryCalls, 2);

        await harness.command("prewarm");
        await harness.flush();
        assert.equal(harness.summaryCalls, 2);
        lazyRemainder.resolve({
            summary: "lazy completion",
            endOffset: harness.latestSourceLength,
            usage: null,
        });
        await lazy;
    });

    it("reopens the current preset with the newly selected model", async () => {
        const harness = createHarness(undefined, false, async (request, callIndex) => {
            if (callIndex === 0) {
                return new Promise((_resolve, reject) => {
                    request.signal.addEventListener("abort", () => {
                        reject(new DOMException("aborted", "AbortError"));
                    }, { once: true });
                });
            }
            return { summary: "model-b summary", endOffset: request.sourceText.length, usage: null };
        });
        await harness.command("prewarm");
        await harness.flush();
        await harness.command("lazy");
        await harness.flush();
        harness.setModel({ ...harness.context().model, id: "gpt-model-b", name: "GPT Model B" });
        await harness.runHooks("model_select");

        await harness.command("prewarm");
        await harness.flush();

        assert.deepEqual(harness.openedModelIds, ["gpt-test", "gpt-model-b"]);
    });

    it("retries a failed prewarm operation automatically after model selection", async () => {
        const harness = createHarness(undefined, false, async (request, callIndex) => {
            if (callIndex === 0) throw new Error("model-a failure");
            return { summary: "model-b retry", endOffset: request.sourceText.length, usage: null };
        });
        const originalError = console.error;
        console.error = () => undefined;
        try {
            await harness.command("prewarm");
            await harness.flush();
            harness.setModel({ ...harness.context().model, id: "automatic-model-b", name: "Automatic Model B" });
            await harness.runHooks("model_select");
            await harness.flush();
        } finally {
            console.error = originalError;
        }

        assert.deepEqual(harness.openedModelIds, ["gpt-test", "automatic-model-b"]);
        assert.equal(harness.summaryCalls, 2);
    });

    it("retires a stalled superseded opener on model selection", async () => {
        const stalledOpen = deferred<void>();
        const openSignals: AbortSignal[] = [];
        const harness = createHarness(
            undefined,
            true,
            undefined,
            undefined,
            async (openIndex, signal) => {
                openSignals.push(signal);
                if (openIndex === 0) await stalledOpen.promise;
            },
        );
        await harness.command("prewarm");
        await harness.flush();
        harness.setModel({ ...harness.context().model, id: "selected-model-b", name: "Selected Model B" });
        await harness.runHooks("model_select");
        await harness.flush();

        assert.equal(openSignals[0]?.aborted, true);
        assert.equal(openSignals.length, 2);
        assert.deepEqual(harness.openedModelIds, ["gpt-test", "selected-model-b"]);
    });

    it("retries with the selected model when a superseded in-flight call fails", async () => {
        const modelACall = deferred<{ summary: string; endOffset: number; usage: null }>();
        const harness = createHarness(undefined, false, async (request, callIndex) => {
            if (callIndex === 0) return modelACall.promise;
            return { summary: "model-b retry", endOffset: request.sourceText.length, usage: null };
        });
        const originalError = console.error;
        console.error = () => undefined;
        try {
            await harness.command("prewarm");
            await harness.flush();
            harness.setModel({ ...harness.context().model, id: "selected-model-b", name: "Selected Model B" });
            await harness.runHooks("model_select");
            modelACall.reject(new Error("superseded model-a failure"));
            await harness.flush();
            await harness.flush();
        } finally {
            console.error = originalError;
        }

        assert.deepEqual(harness.openedModelIds, ["gpt-test", "selected-model-b"]);
        assert.equal(harness.summaryCalls, 2);
    });

    it("preserves a superseded paid chunk and runs the remainder on the selected model", async () => {
        const modelACall = deferred<{ summary: string; endOffset: number; usage: null }>();
        const harness = createHarness(undefined, false, async (request, callIndex) => {
            if (callIndex === 0) return modelACall.promise;
            return { summary: "model-b completion", endOffset: request.sourceText.length, usage: null };
        });
        await harness.command("prewarm");
        await harness.flush();
        harness.setModel({ ...harness.context().model, id: "selected-model-b", name: "Selected Model B" });
        await harness.runHooks("model_select");
        modelACall.resolve({
            summary: "model-a paid prefix",
            endOffset: Math.max(1, Math.floor(harness.latestSourceLength / 2)),
            usage: null,
        });
        await harness.flush();
        await harness.flush();

        assert.deepEqual(harness.openedModelIds, ["gpt-test", "selected-model-b"]);
        assert.equal(harness.summaryCalls, 2);
        await harness.runHooks("agent_end");
        assert.equal(harness.branch.filter((entry) =>
            entry.type === "custom" && entry.customType === PORTABLE_SUMMARY_CUSTOM_TYPE).length, 2);
    });

    it("restarts prewarm with the model selected while lazy ownership drains", async () => {
        const lazyCall = deferred<{ summary: string; endOffset: number; usage: null }>();
        const harness = createHarness(undefined, false, async (request, callIndex) => {
            if (callIndex === 0) return lazyCall.promise;
            return { summary: "model-b prewarm", endOffset: request.sourceText.length, usage: null };
        });
        registerCodexCompactionPortability(harness.pi);
        harness.setModel({ ...harness.context().model, provider: "anthropic", api: "anthropic-messages" });
        const hooks = harness.hooks.get("context")!;
        const modelAContext = harness.context();
        await hooks[0]!({ messages: [] }, modelAContext);
        const lazy = hooks[1]!({ messages: [] }, modelAContext);
        await harness.flush();

        await harness.command("prewarm");
        harness.setModel({ ...harness.context().model, id: "model-b", name: "Model B" });
        await harness.runHooks("model_select");
        const originalError = console.error;
        console.error = () => undefined;
        try {
            lazyCall.reject(new Error("lazy model-a failed"));
            await lazy;
            await harness.flush();
        } finally {
            console.error = originalError;
        }

        assert.deepEqual(harness.openedModelIds, ["gpt-test", "model-b"]);
    });

    it("preserves a fulfilled result when switching back to lazy and commits it later", async () => {
        const pending = deferred<{ summary: string; endOffset: number; usage: null }>();
        const harness = createHarness(pending.promise);
        await harness.command("prewarm");
        await harness.flush();
        pending.resolve({ summary: "paid summary", endOffset: harness.latestSourceLength, usage: null });
        await harness.command("lazy");
        await harness.flush();
        assert.equal(harness.summaryCalls, 1);
        await harness.runHooks("agent_end");
        assert.equal(harness.branch.filter((entry) => entry.type === "custom" && entry.customType === PORTABLE_SUMMARY_CUSTOM_TYPE).length, 1);
    });

    it("releases a context waiter immediately when lifecycle invalidates non-cooperative work", async () => {
        const pending = deferred<{ summary: string; endOffset: number; usage: null }>();
        const harness = createHarness(pending.promise, true);
        await harness.command("prewarm");
        await harness.flush();
        harness.setModel({ ...harness.context().model, provider: "anthropic", api: "anthropic-messages" });
        const waiting = harness.hooks.get("context")![0]!({ messages: [] }, harness.context());
        await harness.runHooks("session_tree");
        const result = await Promise.race([
            waiting,
            new Promise((_, reject) => setTimeout(() => reject(new Error("waiter did not release")), 50)),
        ]);
        assert.deepEqual(result, { messages: [] });
        assert.equal(harness.abortCalls, 1);
    });

    it("aborts a pending session opener when switching to lazy", async () => {
        const pendingOpen = deferred<void>();
        const harness = createHarness(undefined, false, undefined, pendingOpen.promise);
        await harness.command("prewarm");
        await harness.flush();
        assert.equal(harness.latestOpenSignal?.aborted, false);
        await harness.command("lazy");
        await harness.flush();
        assert.equal(harness.latestOpenSignal?.aborted, true);

        harness.setModel({ ...harness.context().model, provider: "anthropic", api: "anthropic-messages" });
        const result = await harness.hooks.get("context")![0]!({ messages: [] }, harness.context());
        assert.equal(result, undefined);
    });

    it("prevents a retired opener from hiding its replacement from lazy cancellation", async () => {
        const openerA = deferred<void>();
        const openerB = deferred<void>();
        const signals: AbortSignal[] = [];
        const harness = createHarness(
            undefined,
            false,
            undefined,
            undefined,
            async (openIndex, signal) => {
                signals.push(signal);
                await (openIndex === 0 ? openerA.promise : openerB.promise);
            },
        );
        await harness.command("prewarm");
        await harness.flush();
        await harness.command("lazy");
        await harness.flush();
        await harness.command("prewarm");
        await harness.flush();
        assert.equal(signals.length, 2);

        openerA.resolve();
        await harness.flush();
        assert.equal(signals[1]!.aborted, false);
        await harness.command("lazy");
        await harness.flush();
        assert.equal(signals[1]!.aborted, true);

        harness.setModel({ ...harness.context().model, provider: "anthropic", api: "anthropic-messages" });
        const result = await Promise.race([
            harness.hooks.get("context")![0]!({ messages: [] }, harness.context()),
            new Promise((_, reject) => setTimeout(() => reject(new Error("replacement opener blocked handoff")), 50)),
        ]);
        assert.equal(result, undefined);
    });

    it("commits a pending prefix when lazy retirement wakes an existing joiner", async () => {
        const secondCall = deferred<{ summary: string; endOffset: number; usage: null }>();
        const harness = createHarness(undefined, true, async (request, callIndex) => {
            if (callIndex === 0) {
                return {
                    summary: "pending prefix",
                    endOffset: Math.max(1, Math.floor(request.sourceText.length / 2)),
                    usage: null,
                };
            }
            return secondCall.promise;
        });
        await harness.command("prewarm");
        await harness.flush();
        harness.setModel({ ...harness.context().model, provider: "anthropic", api: "anthropic-messages" });
        const waiting = harness.hooks.get("context")![0]!({ messages: [] }, harness.context());
        await harness.command("lazy");
        await harness.flush();
        assert.equal(await waiting, undefined);
        assert.equal(harness.branch.filter((entry) => entry.type === "custom" && entry.customType === PORTABLE_SUMMARY_CUSTOM_TYPE).length, 1);
        await harness.runHooks("agent_end");
        assert.equal(harness.branch.filter((entry) => entry.type === "custom" && entry.customType === PORTABLE_SUMMARY_CUSTOM_TYPE).length, 1);
    });

    it("retires a non-cooperative cancelled call so lazy handoff and re-enable do not hang", async () => {
        const never = deferred<{ summary: string; endOffset: number; usage: null }>();
        const harness = createHarness(never.promise, true);
        await harness.command("prewarm");
        await harness.flush();
        await harness.command("lazy");
        await harness.flush();
        harness.setModel({ ...harness.context().model, provider: "anthropic", api: "anthropic-messages" });
        const handoffContext = harness.context();
        const lazyResult = await Promise.race([
            harness.hooks.get("context")![0]!({ messages: [] }, handoffContext),
            new Promise((_, reject) => setTimeout(() => reject(new Error("lazy handoff hung")), 50)),
        ]);
        assert.equal(lazyResult, undefined);
        harness.bus.emit("codex-compaction-coordinator:lazy-portability-settled", {
            sessionId: "session-1",
            context: handoffContext,
        });

        await harness.command("prewarm");
        await harness.flush();
        assert.equal(harness.summaryCalls, 2);
    });

    it("hands multiple joined callers to lazy without aborting peers", async () => {
        const secondCall = deferred<{ summary: string; endOffset: number; usage: null }>();
        const harness = createHarness(undefined, true, async (request, callIndex) => {
            if (callIndex === 0) {
                return {
                    summary: "pending prefix",
                    endOffset: Math.max(1, Math.floor(request.sourceText.length / 2)),
                    usage: null,
                };
            }
            return secondCall.promise;
        });
        await harness.command("prewarm");
        await harness.flush();
        harness.setModel({ ...harness.context().model, provider: "anthropic", api: "anthropic-messages" });
        const first = harness.hooks.get("context")![0]!({ messages: [] }, harness.context());
        const second = harness.hooks.get("context")![0]!({ messages: [] }, harness.context());
        await harness.command("lazy");
        await harness.flush();
        assert.equal(await first, undefined);
        assert.equal(await second, undefined);
        assert.equal(harness.abortCalls, 0);
        assert.equal(harness.branch.filter((entry) => entry.type === "custom" && entry.customType === PORTABLE_SUMMARY_CUSTOM_TYPE).length, 1);
    });

    it("reserves every peer that observes the same failed handoff", async () => {
        const laterFailure = deferred<{ summary: string; endOffset: number; usage: null }>();
        const harness = createHarness(undefined, true, async (request, callIndex) => {
            if (callIndex === 0) {
                return {
                    summary: "pending prefix",
                    endOffset: Math.max(1, Math.floor(request.sourceText.length / 2)),
                    usage: null,
                };
            }
            if (callIndex === 1) return laterFailure.promise;
            return { summary: "retry completion", endOffset: request.sourceText.length, usage: null };
        });
        const originalError = console.error;
        console.error = () => undefined;
        try {
            harness.setModel({ ...harness.context().model, provider: "anthropic", api: "anthropic-messages" });
            await harness.command("prewarm");
            await harness.flush();
            const firstContext = harness.context();
            const secondContext = harness.context();
            const first = harness.hooks.get("context")![0]!({ messages: [] }, firstContext);
            const second = harness.hooks.get("context")![0]!({ messages: [] }, secondContext);
            laterFailure.reject(new Error("later failure"));
            assert.equal(await first, undefined);
            assert.equal(await second, undefined);
            assert.equal(harness.summaryCalls, 2);

            harness.bus.emit("codex-compaction-coordinator:lazy-portability-settled", {
                sessionId: "session-1",
                context: firstContext,
            });
            await harness.runHooks("agent_end");
            await harness.flush();
            assert.equal(harness.summaryCalls, 2);

            harness.bus.emit("codex-compaction-coordinator:lazy-portability-settled", {
                sessionId: "session-1",
                context: secondContext,
            });
            await harness.flush();
            assert.equal(harness.summaryCalls, 3);
        } finally {
            console.error = originalError;
        }
    });

    it("isolates a retired run's late rejection from its replacement", async () => {
        const oldRun = deferred<{ summary: string; endOffset: number; usage: null }>();
        const replacement = deferred<{ summary: string; endOffset: number; usage: null }>();
        const harness = createHarness(undefined, true, async (_request, callIndex) => (
            callIndex === 0 ? oldRun.promise : replacement.promise
        ));
        const originalError = console.error;
        console.error = () => undefined;
        try {
            await harness.command("prewarm");
            await harness.flush();
            await harness.command("lazy");
            await harness.flush();
            await harness.command("prewarm");
            await harness.flush();
            replacement.resolve({
                summary: "replacement summary",
                endOffset: harness.latestSourceLength,
                usage: null,
            });
            await harness.flush();
            const noticeCount = harness.notices.length;
            oldRun.reject(new Error("late old-run failure"));
            await harness.flush();
            assert.equal(harness.notices.length, noticeCount);
            await harness.runHooks("agent_end");
            assert.equal(harness.branch.filter((entry) => entry.type === "custom" && entry.customType === PORTABLE_SUMMARY_CUSTOM_TYPE).length, 1);
        } finally {
            console.error = originalError;
        }
    });

    it("preserves pending progress when lazy cancels a restarted opener", async () => {
        const pendingOpen = deferred<void>();
        const harness = createHarness(
            undefined,
            false,
            async (request, callIndex) => {
                if (callIndex === 0) {
                    return {
                        summary: "pending prefix",
                        endOffset: Math.max(1, Math.floor(request.sourceText.length / 2)),
                        usage: null,
                    };
                }
                throw new Error("later chunk failed");
            },
            undefined,
            async (openIndex) => {
                if (openIndex === 1) await pendingOpen.promise;
            },
        );
        const originalError = console.error;
        console.error = () => undefined;
        try {
            await harness.command("prewarm");
            await harness.flush();
            await harness.command("prewarm");
            await harness.flush();
            assert.equal(harness.openCalls, 2);
            await harness.command("lazy");
            await harness.flush();
            assert.equal(harness.latestOpenSignal?.aborted, true);
            await harness.runHooks("agent_end");
            assert.equal(harness.branch.filter((entry) => entry.type === "custom" && entry.customType === PORTABLE_SUMMARY_CUSTOM_TYPE).length, 1);
        } finally {
            console.error = originalError;
        }
    });

    it("commits a compatible pending prefix before lazy processes a later checkpoint", async () => {
        const harness = createHarness();
        await harness.command("prewarm");
        await harness.flush();
        await harness.command("lazy");
        await harness.flush();
        harness.appendUserAndCheckpoint();
        harness.setModel({ ...harness.context().model, provider: "anthropic", api: "anthropic-messages" });
        const result = await harness.hooks.get("context")![0]!({ messages: [] }, harness.context());
        assert.equal(result, undefined);
        assert.equal(harness.abortCalls, 0);
        assert.equal(harness.summaryCalls, 1);
        assert.equal(harness.branch.filter((entry) =>
            entry.type === "custom" && entry.customType === PORTABLE_SUMMARY_CUSTOM_TYPE).length, 1);
    });

    it("reserves changed-epoch lazy handoff until its matching settlement", async () => {
        const lazyNewEpoch = deferred<{ summary: string; endOffset: number; usage: null }>();
        const harness = createHarness(undefined, true, async (request, callIndex) => {
            if (callIndex === 0) {
                return { summary: "old pending", endOffset: request.sourceText.length, usage: null };
            }
            return lazyNewEpoch.promise;
        });
        registerCodexCompactionPortability(harness.pi);
        await harness.command("prewarm");
        await harness.flush();
        await harness.command("lazy");
        await harness.flush();
        harness.appendUserAndCheckpoint();
        harness.setModel({ ...harness.context().model, provider: "anthropic", api: "anthropic-messages" });
        const hooks = harness.hooks.get("context")!;
        const ctx = harness.context();
        assert.equal(await hooks[0]!({ messages: [] }, ctx), undefined);
        const lazy = hooks[1]!({ messages: [] }, ctx);
        await harness.flush();
        assert.equal(harness.summaryCalls, 2);

        await harness.command("prewarm");
        await harness.runHooks("agent_end");
        await harness.flush();
        assert.equal(harness.summaryCalls, 2);
        lazyNewEpoch.resolve({
            summary: "new epoch summary",
            endOffset: harness.latestSourceLength,
            usage: null,
        });
        await lazy;
    });

    it("preserves an error-phase pending prefix across a compatible epoch extension", async () => {
        const harness = createHarness(undefined, false, async (request, callIndex) => {
            if (callIndex === 0) {
                return {
                    summary: "stale prefix",
                    endOffset: Math.max(1, Math.floor(request.sourceText.length / 2)),
                    usage: null,
                };
            }
            throw new Error("later chunk failed");
        });
        const originalError = console.error;
        console.error = () => undefined;
        try {
            await harness.command("prewarm");
            await harness.flush();
            harness.appendUserAndCheckpoint();
            harness.setModel({ ...harness.context().model, provider: "anthropic", api: "anthropic-messages" });
            const result = await harness.hooks.get("context")![0]!({ messages: [] }, harness.context());
            assert.equal(result, undefined);
            assert.equal(harness.abortCalls, 0);
            assert.equal(harness.branch.filter((entry) =>
                entry.type === "custom" && entry.customType === PORTABLE_SUMMARY_CUSTOM_TYPE).length, 1);
        } finally {
            console.error = originalError;
        }
    });

    it("retires obsolete work when the native epoch becomes empty", async () => {
        const pending = deferred<{ summary: string; endOffset: number; usage: null }>();
        const harness = createHarness(pending.promise, true);
        await harness.command("prewarm");
        await harness.flush();
        const activeSignal = harness.latestOpenSignal;
        harness.setBranch(harness.branch.slice(0, 1));
        await harness.runHooks("session_compact");
        await harness.flush();
        assert.equal(activeSignal?.aborted, true);
    });

    it("ignores a provider result that arrives after lifecycle invalidation", async () => {
        const pending = deferred<{ summary: string; endOffset: number; usage: null }>();
        const harness = createHarness(pending.promise, true);
        await harness.command("prewarm");
        await harness.flush();
        await harness.command("lazy");
        await harness.runHooks("session_tree");
        pending.resolve({ summary: "stale summary", endOffset: harness.latestSourceLength, usage: null });
        await harness.flush();
        assert.equal(harness.branch.some((entry) => entry.type === "custom" && entry.customType === PORTABLE_SUMMARY_CUSTOM_TYPE), false);
    });

    it("hands a failed prewarm join to lazy without a second prewarm call", async () => {
        const pending = deferred<{ summary: string; endOffset: number; usage: null }>();
        const harness = createHarness(pending.promise);
        const originalError = console.error;
        console.error = () => undefined;
        try {
            await harness.command("prewarm");
            await harness.flush();
            pending.reject(new Error("provider failed"));
            await harness.flush();
            harness.setModel({ ...harness.context().model, provider: "anthropic", api: "anthropic-messages" });
            const result = await harness.hooks.get("context")![0]!({ messages: [] }, harness.context());
            assert.equal(result, undefined);
            assert.equal(harness.summaryCalls, 1);
        } finally {
            console.error = originalError;
        }
    });

    it("notifies for active-signal AbortError failures from opening and summarizing", async () => {
        for (const phase of ["open", "summary"] as const) {
            const harness = phase === "open"
                ? createHarness(undefined, false, undefined, undefined, async () => {
                    throw new DOMException("provider aborted", "AbortError");
                })
                : createHarness(undefined, false, async () => {
                    throw new DOMException("provider aborted", "AbortError");
                });
            const originalError = console.error;
            console.error = () => undefined;
            try {
                await harness.command("prewarm");
                await harness.flush();
                assert.match(harness.notices.at(-1) ?? "", /failed/);
            } finally {
                console.error = originalError;
            }
        }
    });

    it("restarts prewarm after tree invalidates an active lazy handoff", async () => {
        const harness = createHarness(undefined, false, async (request, callIndex) => {
            if (callIndex === 0) throw new Error("initial prewarm failure");
            return { summary: "tree retry", endOffset: request.sourceText.length, usage: null };
        });
        const originalError = console.error;
        console.error = () => undefined;
        try {
            await harness.command("prewarm");
            await harness.flush();
            harness.setModel({ ...harness.context().model, provider: "anthropic", api: "anthropic-messages" });
            const oldContext = harness.context();
            await harness.hooks.get("context")![0]!({ messages: [] }, oldContext);

            await harness.runHooks("session_tree");
            harness.bus.emit("codex-compaction-coordinator:lazy-portability-settled", {
                sessionId: "session-1",
                context: oldContext,
            });
            await harness.flush();

            assert.equal(harness.summaryCalls, 2);
        } finally {
            console.error = originalError;
        }
    });

    it("clears a deferred tree restart when reservations drain in lazy mode", async () => {
        const harness = createHarness();
        harness.setModel({ ...harness.context().model, provider: "anthropic", api: "anthropic-messages" });
        const oldContext = harness.context();
        await harness.hooks.get("context")![0]!({ messages: [] }, oldContext);
        await harness.command("prewarm");
        await harness.runHooks("session_tree");
        await harness.command("lazy");
        harness.bus.emit("codex-compaction-coordinator:lazy-portability-settled", {
            sessionId: "session-1",
            context: oldContext,
        });
        await harness.flush();
        assert.equal(harness.summaryCalls, 0);

        harness.setModel({ ...harness.context().model, id: "later-model", name: "Later Model" });
        await harness.command("prewarm");
        await harness.flush();
        assert.deepEqual(harness.openedModelIds, ["later-model"]);
    });

    it("ignores stale lifecycle settlement when a newer lazy reservation exists", async () => {
        const harness = createHarness();
        harness.setModel({ ...harness.context().model, provider: "anthropic", api: "anthropic-messages" });
        const prewarmHook = harness.hooks.get("context")![0]!;
        const oldContext = harness.context();
        await prewarmHook({ messages: [] }, oldContext);
        await harness.runHooks("session_tree");
        const newContext = harness.context();
        await prewarmHook({ messages: [] }, newContext);

        await harness.command("prewarm");
        await harness.flush();
        assert.equal(harness.summaryCalls, 0);
        harness.bus.emit("codex-compaction-coordinator:lazy-portability-settled", {
            sessionId: "session-1",
            context: oldContext,
        });
        await harness.flush();
        assert.equal(harness.summaryCalls, 0);

        harness.bus.emit("codex-compaction-coordinator:lazy-portability-settled", {
            sessionId: "session-1",
            context: newContext,
        });
        await harness.flush();
        assert.equal(harness.summaryCalls, 1);
    });

    it("does not start competing prewarm work during lazy-first materialization", async () => {
        const lazyResult = deferred<{ summary: string; endOffset: number; usage: null }>();
        const harness = createHarness(lazyResult.promise);
        registerCodexCompactionPortability(harness.pi);
        harness.setModel({ ...harness.context().model, provider: "anthropic", api: "anthropic-messages" });
        const hooks = harness.hooks.get("context")!;
        const ctx = harness.context();
        await hooks[0]!({ messages: [] }, ctx);
        const lazy = hooks[1]!({ messages: [] }, ctx);
        await harness.flush();
        assert.equal(harness.summaryCalls, 1);

        await harness.command("prewarm");
        await harness.runHooks("agent_end");
        harness.bus.emit("codex-compaction-coordinator:lazy-portability-settled", {
            sessionId: "session-1",
            context: harness.context(),
        });
        await harness.flush();
        assert.equal(harness.summaryCalls, 1);

        lazyResult.resolve({
            summary: "lazy-first result",
            endOffset: harness.latestSourceLength,
            usage: null,
        });
        await lazy;
        await harness.flush();
        assert.equal(harness.summaryCalls, 1);
        assert.equal(harness.branch.filter((entry) => entry.type === "custom" && entry.customType === PORTABLE_SUMMARY_CUSTOM_TYPE).length, 1);
    });

    it("tracks every lazy waiter that joins after prewarm is selected", async () => {
        const lazyResult = deferred<{ summary: string; endOffset: number; usage: null }>();
        const harness = createHarness(lazyResult.promise);
        registerCodexCompactionPortability(harness.pi);
        harness.setModel({ ...harness.context().model, provider: "anthropic", api: "anthropic-messages" });
        const hooks = harness.hooks.get("context")!;
        const firstController = new AbortController();
        const firstContext = harness.context(firstController);
        await hooks[0]!({ messages: [] }, firstContext);
        const firstLazy = hooks[1]!({ messages: [] }, firstContext);
        await harness.flush();
        assert.equal(harness.summaryCalls, 1);

        await harness.command("prewarm");
        const secondContext = harness.context();
        await hooks[0]!({ messages: [] }, secondContext);
        const secondLazy = hooks[1]!({ messages: [] }, secondContext);
        firstController.abort();
        await firstLazy;
        await harness.flush();
        assert.equal(harness.summaryCalls, 1);

        lazyResult.resolve({
            summary: "shared lazy result",
            endOffset: harness.latestSourceLength,
            usage: null,
        });
        await secondLazy;
        await harness.flush();
        assert.equal(harness.summaryCalls, 1);
    });

    it("does not restart prewarm while lazy handoff is still materializing", async () => {
        const lazyCompletion = deferred<{ summary: string; endOffset: number; usage: null }>();
        const harness = createHarness(undefined, false, async (request, callIndex) => {
            if (callIndex === 0) {
                return {
                    summary: "background prefix",
                    endOffset: Math.max(1, Math.floor(request.sourceText.length / 2)),
                    usage: null,
                };
            }
            if (callIndex === 1) throw new Error("background remainder failed");
            return lazyCompletion.promise;
        });
        registerCodexCompactionPortability(harness.pi);
        const originalError = console.error;
        console.error = () => undefined;
        try {
            await harness.command("prewarm");
            await harness.flush();
            harness.setModel({ ...harness.context().model, provider: "anthropic", api: "anthropic-messages" });
            const contextHooks = harness.hooks.get("context")!;
            const ctx = harness.context();
            await contextHooks[0]!({ messages: [] }, ctx);
            const lazy = contextHooks[1]!({ messages: [] }, ctx);
            await harness.flush();
            assert.equal(harness.summaryCalls, 3);

            await harness.command("prewarm");
            await harness.runHooks("agent_end");
            await harness.flush();
            assert.equal(harness.summaryCalls, 3);

            lazyCompletion.resolve({
                summary: "lazy completion",
                endOffset: harness.latestSourceLength,
                usage: null,
            });
            await lazy;
            await harness.flush();
            assert.equal(harness.summaryCalls, 3);
        } finally {
            console.error = originalError;
        }
    });

    it("cancels a retry opener after a fulfilled invalid summary result", async () => {
        const retryOpen = deferred<void>();
        const harness = createHarness(
            undefined,
            false,
            async () => ({ summary: "invalid", endOffset: 0, usage: null }),
            undefined,
            async (openIndex) => {
                if (openIndex === 1) await retryOpen.promise;
            },
        );
        const originalError = console.error;
        console.error = () => undefined;
        try {
            await harness.command("prewarm");
            await harness.flush();
            await harness.command("prewarm");
            await harness.flush();
            assert.equal(harness.openCalls, 2);
            assert.equal(harness.latestOpenSignal?.aborted, false);
            await harness.command("lazy");
            await harness.flush();
            assert.equal(harness.latestOpenSignal?.aborted, true);
        } finally {
            console.error = originalError;
        }
    });

    it("rediscovers durable lazy progress when prewarm is enabled again", async () => {
        const harness = createHarness(undefined, false, async (request, callIndex) => {
            if (callIndex === 0) {
                return {
                    summary: "background prefix",
                    endOffset: Math.max(1, Math.floor(request.sourceText.length / 2)),
                    usage: null,
                };
            }
            if (callIndex === 1) throw new Error("background remainder failed");
            return { summary: "lazy completion", endOffset: request.sourceText.length, usage: null };
        });
        registerCodexCompactionPortability(harness.pi);
        const originalError = console.error;
        console.error = () => undefined;
        try {
            await harness.command("prewarm");
            await harness.flush();
            harness.setModel({ ...harness.context().model, provider: "anthropic", api: "anthropic-messages" });
            let messages: unknown[] = [];
            for (const hook of harness.hooks.get("context") ?? []) {
                const result = await hook({ messages }, harness.context());
                if (result?.messages) messages = result.messages;
            }
            assert.equal(harness.summaryCalls, 3);
            assert.equal(harness.branch.filter((entry) => entry.type === "custom" && entry.customType === PORTABLE_SUMMARY_CUSTOM_TYPE).length, 2);

            await harness.command("prewarm");
            await harness.flush();
            assert.equal(harness.summaryCalls, 3);
        } finally {
            console.error = originalError;
        }
    });

    it("commits a successful pending prefix before handing a later failure to lazy", async () => {
        const harness = createHarness(undefined, false, async (request, callIndex) => {
            if (callIndex === 0) {
                return {
                    summary: "durable prefix",
                    endOffset: Math.max(1, Math.floor(request.sourceText.length / 2)),
                    usage: null,
                };
            }
            throw new Error("later chunk failed");
        });
        const originalError = console.error;
        console.error = () => undefined;
        try {
            await harness.command("prewarm");
            await harness.flush();
            assert.equal(harness.summaryCalls, 2);
            harness.setModel({ ...harness.context().model, provider: "anthropic", api: "anthropic-messages" });
            const result = await harness.hooks.get("context")![0]!({ messages: [] }, harness.context());
            assert.equal(result, undefined);
            assert.equal(harness.summaryCalls, 2);
            assert.equal(harness.branch.filter((entry) => entry.type === "custom" && entry.customType === PORTABLE_SUMMARY_CUSTOM_TYPE).length, 1);
        } finally {
            console.error = originalError;
        }
    });

    it("preserves a pending prefix when retrying the same epoch after failure", async () => {
        const harness = createHarness(undefined, false, async (request, callIndex) => {
            if (callIndex === 0) {
                return {
                    summary: "pending prefix",
                    endOffset: Math.max(1, Math.floor(request.sourceText.length / 2)),
                    usage: null,
                };
            }
            if (callIndex === 1) throw new Error("later chunk failed");
            return { summary: "completed retry", endOffset: request.sourceText.length, usage: null };
        });
        const originalError = console.error;
        console.error = () => undefined;
        try {
            await harness.command("prewarm");
            await harness.flush();
            assert.equal(harness.summaryCalls, 2);
            await harness.command("prewarm");
            await harness.flush();
            assert.equal(harness.summaryCalls, 3);
            await harness.runHooks("agent_end");
            assert.equal(harness.branch.filter((entry) => entry.type === "custom" && entry.customType === PORTABLE_SUMMARY_CUSTOM_TYPE).length, 2);
        } finally {
            console.error = originalError;
        }
    });

    it("blocks a waiting context from committing after tree invalidation", async () => {
        const pending = deferred<{ summary: string; endOffset: number; usage: null }>();
        const harness = createHarness(pending.promise, true);
        await harness.command("prewarm");
        await harness.flush();
        harness.setModel({ ...harness.context().model, provider: "anthropic", api: "anthropic-messages" });
        const controller = new AbortController();
        const waiting = harness.hooks.get("context")![0]!({ messages: [] }, harness.context(controller));
        await harness.runHooks("session_tree");
        pending.resolve({ summary: "stale result", endOffset: harness.latestSourceLength, usage: null });
        assert.deepEqual(await waiting, { messages: [] });
        assert.equal(harness.abortCalls, 1);
        assert.equal(harness.branch.some((entry) => entry.type === "custom" && entry.customType === PORTABLE_SUMMARY_CUSTOM_TYPE), false);
    });

    it("fails closed on a malformed latest mode entry when native history exists", async () => {
        const harness = createHarness();
        harness.pi.appendEntry(PORTABILITY_MODE_CUSTOM_TYPE, {});
        harness.setModel({ ...harness.context().model, provider: "anthropic", api: "anthropic-messages" });
        const result = await harness.hooks.get("context")![0]!({ messages: [] }, harness.context());
        assert.deepEqual(result, { messages: [] });
        assert.equal(harness.abortCalls, 1);
        assert.equal(harness.summaryCalls, 0);
    });

    it("retries a failed durable append without repeating the paid summary call", async () => {
        const harness = createHarness();
        await harness.command("prewarm");
        await harness.flush();
        harness.setFailPortableAppends(true);
        await harness.runHooks("agent_end");
        assert.equal(harness.summaryCalls, 1);
        assert.equal(harness.branch.some((entry) => entry.type === "custom" && entry.customType === PORTABLE_SUMMARY_CUSTOM_TYPE), false);

        harness.setFailPortableAppends(false);
        await harness.runHooks("agent_end");
        assert.equal(harness.summaryCalls, 1);
        assert.equal(harness.branch.filter((entry) => entry.type === "custom" && entry.customType === PORTABLE_SUMMARY_CUSTOM_TYPE).length, 1);
    });

    it("schedules the latest epoch after a future Pi compaction boundary", async () => {
        const harness = createHarness();
        await harness.command("prewarm");
        await harness.flush();
        await harness.runHooks("agent_end");
        harness.appendUserAndCheckpoint();

        await harness.runHooks("session_compact");
        await harness.flush();
        assert.equal(harness.summaryCalls, 2);
        await harness.runHooks("agent_end");
        assert.equal(harness.branch.filter((entry) => entry.type === "custom" && entry.customType === PORTABLE_SUMMARY_CUSTOM_TYPE).length, 2);
    });

    it("reconciles a Pi compaction epoch extension before committing paid progress", async () => {
        const harness = createHarness();
        await harness.command("prewarm");
        await harness.flush();
        assert.equal(harness.summaryCalls, 1);
        harness.appendUserAndCheckpoint();

        await harness.runHooks("session_compact");
        await harness.flush();

        assert.equal(harness.summaryCalls, 2);
        assert.equal(harness.branch.filter((entry) =>
            entry.type === "custom" && entry.customType === PORTABLE_SUMMARY_CUSTOM_TYPE).length, 2);
    });

    it("extends undurable paid progress when a later checkpoint joins the epoch", async () => {
        const harness = createHarness();
        await harness.command("prewarm");
        await harness.flush();
        assert.equal(harness.summaryCalls, 1);
        assert.equal(harness.branch.some((entry) =>
            entry.type === "custom" && entry.customType === PORTABLE_SUMMARY_CUSTOM_TYPE), false);

        harness.appendUserAndCheckpoint();
        await harness.runHooks("session_compact");
        await harness.flush();
        assert.equal(harness.summaryCalls, 2);

        await harness.runHooks("agent_end");
        assert.equal(harness.branch.filter((entry) =>
            entry.type === "custom" && entry.customType === PORTABLE_SUMMARY_CUSTOM_TYPE).length, 2);
    });

    it("preserves an in-flight retained-prefix result during tree contraction", async () => {
        const firstCall = deferred<{ summary: string; endOffset: number; usage: null }>();
        const harness = createHarness(firstCall.promise, true);
        harness.appendUserAndCheckpoint();
        await harness.command("prewarm");
        await harness.flush();
        assert.equal(harness.summaryCalls, 1);

        harness.setBranch(harness.branch.slice(0, 2));
        await harness.runHooks("session_tree");
        firstCall.resolve({ summary: "retained result", endOffset: harness.latestSourceLength, usage: null });
        await harness.flush();
        await harness.runHooks("agent_end");

        assert.equal(harness.summaryCalls, 1);
        assert.equal(harness.branch.filter((entry) =>
            entry.type === "custom" && entry.customType === PORTABLE_SUMMARY_CUSTOM_TYPE).length, 1);
    });

    it("reports ready after contraction removes a failed checkpoint suffix", async () => {
        const harness = createHarness(undefined, false, async (request, callIndex) => {
            if (callIndex === 0) {
                return { summary: "first ready", endOffset: request.sourceText.length, usage: null };
            }
            throw new Error("second checkpoint failed");
        });
        const originalError = console.error;
        console.error = () => undefined;
        try {
            harness.appendUserAndCheckpoint();
            await harness.command("prewarm");
            await harness.flush();
            await harness.runHooks("agent_end");
            await harness.flush();

            harness.setBranch(harness.branch.slice(0, 2));
            await harness.runHooks("session_tree");
            await harness.flush();
            await harness.command("status");

            assert.match(harness.notices.at(-1) ?? "", /work=ready/);
            assert.match(harness.notices.at(-1) ?? "", /last error=Portable summarizer call failed/);
        } finally {
            console.error = originalError;
        }
    });

    it("preserves pending progress when tree selects an exact checkpoint prefix", async () => {
        const harness = createHarness();
        harness.appendUserAndCheckpoint();
        await harness.command("prewarm");
        await harness.flush();
        assert.equal(harness.summaryCalls, 2);

        harness.setBranch(harness.branch.slice(0, 2));
        await harness.runHooks("session_tree");
        await harness.flush();
        assert.equal(harness.summaryCalls, 2);

        await harness.runHooks("agent_end");
        assert.equal(harness.branch.filter((entry) =>
            entry.type === "custom" && entry.customType === PORTABLE_SUMMARY_CUSTOM_TYPE).length, 1);
    });

    it("ignores a queued schedule from before tree invalidation", async () => {
        const harness = createHarness();
        const command = harness.command("prewarm");
        await harness.runHooks("session_tree");
        await command;
        await harness.flush();
        assert.equal(harness.summaryCalls, 1);
    });

    it("resolves mode from global entries rather than the active tree branch", async () => {
        const harness = createHarness();
        await harness.command("prewarm");
        const branchWithoutMode = harness.branch.slice(0, 2);
        harness.setBranch(branchWithoutMode);
        await harness.runHooks("session_tree");
        await harness.flush();
        assert.equal(harness.summaryCalls, 1);
        await harness.command("status");
        assert.match(harness.notices.at(-1) ?? "", /mode=prewarm/);
    });
});
