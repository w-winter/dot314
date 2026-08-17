import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
    registerGroundedCompaction,
    runGroundedBranchSummaryAugmentation,
    runGroundedCompaction,
} from "../grounded-compaction/index.ts";
import { registerModelAwareCompaction } from "../model-aware-compaction/index.ts";
import codexCompactionCoordinator, {
    CODEX_COMPACTION_COORDINATION_EVENT,
    type CodexCompactionCoordinationQuery,
} from "./index.ts";

type EventListener = (payload: unknown) => unknown;
type Hook = (event: unknown, ctx: unknown) => unknown;

class TestEventBus {
    readonly emitter = new EventEmitter();
    readonly listenerErrors: unknown[] = [];

    on(eventName: string, listener: EventListener): () => void {
        const wrapped = (payload: unknown) => {
            try {
                Promise.resolve(listener(payload)).catch((error: unknown) => {
                    this.listenerErrors.push(error);
                });
            } catch (error) {
                this.listenerErrors.push(error);
            }
        };
        this.emitter.on(eventName, wrapped);
        return () => this.emitter.off(eventName, wrapped);
    }

    emit(eventName: string, payload: unknown): void {
        this.emitter.emit(eventName, payload);
    }
}

function createHarness(bus = new TestEventBus()) {
    const hooks = new Map<string, Hook[]>();
    const entryRenderers = new Map<string, unknown>();
    const pi = {
        events: bus,
        on(eventName: string, hook: Hook) {
            hooks.set(eventName, [...(hooks.get(eventName) ?? []), hook]);
        },
        registerCommand() {
            return undefined;
        },
        registerEntryRenderer(customType: string, renderer: unknown) {
            entryRenderers.set(customType, renderer);
        },
    } as unknown as ExtensionAPI;
    codexCompactionCoordinator(pi);
    return { bus, hooks, entryRenderers };
}

function codexModel() {
    return {
        id: "gpt-test",
        name: "GPT Test",
        provider: "openai-codex",
        api: "openai-codex-responses",
        baseUrl: "https://chatgpt.com/backend-api",
        reasoning: true,
        input: ["text"],
        contextWindow: 128_000,
        maxTokens: 16_384,
        cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0, total: 0 },
    };
}

function groundedQuery(model = codexModel()): CodexCompactionCoordinationQuery {
    return {
        kind: "grounded-session-compaction",
        model,
        response: { status: "unavailable" },
    };
}

describe("codex compaction coordinator", () => {
    it("registers portability context and lifecycle hooks alongside the synchronous protocols", () => {
        const { hooks, entryRenderers } = createHarness();
        assert.equal(entryRenderers.has("codex-compaction-coordinator:portable-summary"), true);
        assert.equal(hooks.get("context")?.length, 2);
        assert.equal(hooks.get("session_start")?.length, 2);
        assert.equal(hooks.get("session_tree")?.length, 2);
        assert.equal(hooks.get("model_select")?.length, 2);
        assert.equal(hooks.get("agent_end")?.length, 1);
        assert.equal(hooks.get("session_compact")?.length, 1);
        assert.equal(hooks.get("session_shutdown")?.length, 3);
    });

    it("delegates grounded compaction only for the exact Codex provider and API", () => {
        const { bus } = createHarness();
        const canonical = groundedQuery();
        bus.emit(CODEX_COMPACTION_COORDINATION_EVENT, canonical);
        assert.deepEqual(canonical.response, {
            status: "available",
            decision: "delegate-to-pi-pipeline",
        });

        for (const model of [
            { ...codexModel(), provider: "openai" },
            { ...codexModel(), api: "openai-responses" },
            { ...codexModel(), provider: "OpenAI-Codex" },
            { ...codexModel(), api: "OpenAI-Codex-Responses" },
        ]) {
            const query = groundedQuery(model);
            bus.emit(CODEX_COMPACTION_COORDINATION_EVENT, query);
            assert.deepEqual(query.response, { status: "unavailable" });
        }
    });

    it("turns malformed coordination responses into explicit errors", () => {
        for (const response of [
            { status: "error", error: "invalid coordination", extra: true },
            Object.assign(Object.create({ status: "unavailable" }), {
                disguise: true,
            }),
            Object.assign(Object.create({ status: "available" }), {
                decision: "delegate-to-pi-pipeline",
                disguise: true,
            }),
            Object.assign(Object.create({ decision: "delegate-to-pi-pipeline" }), {
                status: "available",
                disguise: true,
            }),
            Object.assign(Object.create({ status: "error" }), {
                error: "invalid coordination",
                disguise: true,
            }),
        ]) {
            const { bus } = createHarness();
            const query = groundedQuery();
            query.response = response as unknown as typeof query.response;
            bus.emit(CODEX_COMPACTION_COORDINATION_EVENT, query);
            assert.deepEqual(query.response, {
                status: "error",
                error: "Invalid compaction coordination response",
            });
        }
    });

    it("unsubscribes during session shutdown before a new runtime initializes", async () => {
        const bus = new TestEventBus();
        const first = createHarness(bus);
        for (const hook of first.hooks.get("session_shutdown") ?? []) {
            await hook({ type: "session_shutdown", reason: "reload" }, {});
        }

        const staleQuery = groundedQuery();
        bus.emit(CODEX_COMPACTION_COORDINATION_EVENT, staleQuery);
        assert.deepEqual(staleQuery.response, { status: "unavailable" });

        createHarness(bus);
        const activeQuery = groundedQuery();
        bus.emit(CODEX_COMPACTION_COORDINATION_EVENT, activeQuery);
        assert.equal(activeQuery.response.status, "available");
    });
});

describe("synchronous event protocol", () => {
    it("swallows listener throws and leaves the initialized response unchanged", () => {
        const bus = new TestEventBus();
        bus.on(CODEX_COMPACTION_COORDINATION_EVENT, () => {
            throw new Error("listener failed");
        });
        const query = groundedQuery();
        bus.emit(CODEX_COMPACTION_COORDINATION_EVENT, query);
        assert.deepEqual(query.response, { status: "unavailable" });
    });

    it("does not expose mutation performed after an await to the synchronous caller", async () => {
        const bus = new TestEventBus();
        bus.on(CODEX_COMPACTION_COORDINATION_EVENT, async (payload) => {
            await Promise.resolve();
            const query = payload as CodexCompactionCoordinationQuery;
            query.response = { status: "available", decision: "delegate-to-pi-pipeline" };
        });
        const query = groundedQuery();
        bus.emit(CODEX_COMPACTION_COORDINATION_EVENT, query);
        assert.deepEqual(query.response, { status: "unavailable" });
        await Promise.resolve();
        assert.equal(query.response.status, "available");
    });
});

type ParticipantHook = (event: unknown, ctx: Record<string, unknown>) => unknown;

function createParticipantHarness() {
    const bus = new TestEventBus();
    const hooks = new Map<string, ParticipantHook[]>();
    const pi = {
        events: bus,
        on(eventName: string, hook: ParticipantHook) {
            hooks.set(eventName, [...(hooks.get(eventName) ?? []), hook]);
        },
        registerCommand() {
            return undefined;
        },
        registerEntryRenderer() {
            return undefined;
        },
    } as unknown as ExtensionAPI;
    codexCompactionCoordinator(pi);
    return { bus, hooks, pi };
}

async function runHooks(
    hooks: ParticipantHook[],
    event: unknown,
    ctx: Record<string, unknown>,
): Promise<unknown> {
    let result: unknown;
    for (const hook of hooks) {
        const candidate = await hook(event, ctx);
        if (candidate !== undefined) result = candidate;
        if ((candidate as { cancel?: boolean } | undefined)?.cancel) return candidate;
    }
    return result;
}

function codexContext(assistantUsage?: { totalTokens: number }): Record<string, unknown> {
    return {
        cwd: "/repo",
        model: codexModel(),
        hasUI: false,
        ui: { notify: () => undefined },
        getContextUsage: () => ({ tokens: 80_000 }),
        getSystemPrompt: () => "",
        sessionManager: {
            getBranch: () => [],
            getEntries: () => [],
            getLeafId: () => undefined,
        },
        assistantUsage,
    };
}

describe("combined compaction ownership", () => {
    it("runs the real grounded registration in either order without grounded work", async () => {
        for (const order of ["grounded-first", "native-first"] as const) {
            const { hooks, pi } = createParticipantHarness();
            let groundedRuns = 0;
            registerGroundedCompaction(pi, {
                runCompaction: (async () => {
                    groundedRuns += 1;
                    return { owner: "grounded" };
                }) as typeof runGroundedCompaction,
                runBranchSummary: (async () => undefined) as typeof runGroundedBranchSummaryAugmentation,
            });
            const grounded = hooks.get("session_before_compact")![0];
            const native: ParticipantHook = () => ({ owner: "native" });
            const orderedHooks = order === "grounded-first" ? [grounded, native] : [native, grounded];
            assert.deepEqual(await runHooks(orderedHooks, {}, codexContext()), { owner: "native" });
            assert.equal(groundedRuns, 0);
        }
    });

    it("leaves canonical Codex compaction ownership to Pi's pipeline", async () => {
        const { hooks, pi } = createParticipantHarness();
        let groundedRuns = 0;
        registerGroundedCompaction(pi, {
            runCompaction: (async () => {
                groundedRuns += 1;
                return { owner: "grounded" };
            }) as typeof runGroundedCompaction,
            runBranchSummary: (async () => undefined) as typeof runGroundedBranchSummaryAugmentation,
        });
        const result = await runHooks(hooks.get("session_before_compact") ?? [], {}, codexContext());
        assert.equal(result, undefined);
        assert.equal(groundedRuns, 0);
    });

    it("carries a real model-aware nudge into Pi's normal compaction ownership", async () => {
        const directory = mkdtempSync(join(tmpdir(), "compaction-coordination-"));
        try {
            const configPath = join(directory, "config.json");
            writeFileSync(configPath, JSON.stringify({ global: 50, models: {} }));
            const { hooks, pi } = createParticipantHarness();
            registerModelAwareCompaction(pi, {
                configPath,
                isAutoCompactionEnabled: () => true,
            });
            registerGroundedCompaction(pi, {
                runCompaction: (async () => ({ owner: "grounded" })) as typeof runGroundedCompaction,
                runBranchSummary: (async () => undefined) as typeof runGroundedBranchSummaryAugmentation,
            });
            const assistant = { role: "assistant", stopReason: "stop", usage: { totalTokens: 10 } };
            const ctx = codexContext();
            await runHooks(hooks.get("message_end") ?? [], { message: assistant }, ctx);
            await runHooks(hooks.get("agent_end") ?? [], { messages: [assistant], willRetry: false }, ctx);
            assert.equal(assistant.usage.totalTokens, 128001);
            assert.equal(await runHooks(hooks.get("session_before_compact") ?? [], {}, ctx), undefined);
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it("preserves grounded ownership for non-Codex models", async () => {
        const { hooks, pi } = createParticipantHarness();
        registerGroundedCompaction(pi, {
            runCompaction: (async () => ({ owner: "grounded" })) as typeof runGroundedCompaction,
            runBranchSummary: (async () => undefined) as typeof runGroundedBranchSummaryAugmentation,
        });
        const ctx = {
            ...codexContext(),
            model: { id: "claude-sonnet", provider: "anthropic", api: "anthropic-messages" },
        };
        assert.deepEqual(await runHooks(hooks.get("session_before_compact") ?? [], {}, ctx), {
            owner: "grounded",
        });
    });
});
