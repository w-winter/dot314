import assert from "node:assert/strict";
import { mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
    getThresholdPercent,
    loadCompactionConfig,
    parseCompactionConfig,
    registerModelAwareCompaction,
} from "./index.ts";

type EventHandler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;
type TestAssistant = {
    role: "assistant";
    stopReason: "stop" | "error" | "aborted";
    usage: { totalTokens: number };
};

const tempDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(tempDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function createTempConfig(value: unknown): string {
    const directory = mkdtempSync(join(tmpdir(), "model-aware-compaction-"));
    tempDirectories.push(directory);
    const configPath = join(directory, "config.json");
    writeFileSync(configPath, JSON.stringify(value));
    return configPath;
}

function createAssistant(stopReason: TestAssistant["stopReason"] = "stop"): TestAssistant {
    return { role: "assistant", stopReason, usage: { totalTokens: 10 } };
}

type HandlerRegistry = Map<string, EventHandler[]>;

function createHarness(configPath: string, autoCompactionEnabled = true): HandlerRegistry {
    const handlers = new Map<string, EventHandler[]>();
    const pi = {
        on(eventName: string, handler: EventHandler) {
            handlers.set(eventName, [...(handlers.get(eventName) ?? []), handler]);
        },
    } as unknown as ExtensionAPI;
    registerModelAwareCompaction(pi, {
        configPath,
        isAutoCompactionEnabled: () => autoCompactionEnabled,
    });
    return handlers;
}

function createContext(options: {
    readonly usedTokens?: number;
    readonly notifications?: Array<{ message: string; level: string }>;
} = {}): ExtensionContext {
    const notifications = options.notifications ?? [];
    return {
        cwd: process.cwd(),
        model: { id: "capable-x", contextWindow: 100 },
        hasUI: true,
        getContextUsage: () => ({ tokens: options.usedTokens ?? 80 }),
        getSystemPrompt: () => "",
        sessionManager: {
            getBranch: () => [],
            getEntries: () => [],
            getLeafId: () => undefined,
        },
        ui: {
            notify(message: string, level: string) {
                notifications.push({ message, level });
            },
        },
    } as unknown as ExtensionContext;
}

async function emit(
    handlers: Map<string, EventHandler[]>,
    eventName: string,
    event: unknown,
    ctx: ExtensionContext,
): Promise<void> {
    for (const handler of handlers.get(eventName) ?? []) {
        await handler(event, ctx);
    }
}

async function emitAgentEnd(
    handlers: Map<string, EventHandler[]>,
    ctx: ExtensionContext,
    assistant: TestAssistant,
    willRetry = false,
): Promise<void> {
    await emit(handlers, "message_end", { type: "message_end", message: assistant }, ctx);
    const laterAssistant = { ...assistant, usage: { ...assistant.usage } };
    await emit(handlers, "turn_end", { type: "turn_end", message: laterAssistant }, ctx);
    await emit(handlers, "agent_end", {
        type: "agent_end",
        messages: [laterAssistant],
        willRetry,
    }, ctx);
}

describe("configuration", () => {
    it("parses strict percentages and preserves exact, first-wildcard, and global precedence", () => {
        const config = parseCompactionConfig({
            global: 75.9,
            models: { "capable-exact": 40.9, "capable-*": 60.9, "capable-x*": 20.9 },
        });
        assert.equal(config.global, 75);
        assert.equal(getThresholdPercent(config, "capable-exact"), 40);
        assert.equal(getThresholdPercent(config, "capable-x"), 60);
        assert.equal(getThresholdPercent(config, "other"), 75);
    });

    it("treats question marks as literal wildcard-pattern characters", () => {
        const config = parseCompactionConfig({
            global: 75,
            models: { "literal?*": 40 },
        });
        assert.equal(getThresholdPercent(config, "literal?model"), 40);
        assert.equal(getThresholdPercent(config, "literal-model"), 75);
    });

    it("rejects malformed policy instead of clamping or substituting a default", () => {
        for (const value of [
            null,
            {},
            { global: 70, models: [] },
            { global: -1, models: {} },
            { global: 101, models: {} },
            { global: 70, models: { "capable-*": "80" } },
        ]) {
            assert.throws(() => parseCompactionConfig(value));
        }
    });

    it("treats a missing file as no configured policy and qualifies malformed errors", () => {
        const configPath = createTempConfig({ global: 70, models: {} });
        unlinkSync(configPath);
        assert.equal(loadCompactionConfig(configPath), undefined);

        writeFileSync(configPath, "{");
        assert.throws(
            () => loadCompactionConfig(configPath),
            (error: unknown) => error instanceof Error && error.message.includes(configPath),
        );
    });
});

describe("agent_end nudge", () => {
    it("does not mutate usage when configuration is missing", async () => {
        const configPath = createTempConfig({ global: 50, models: {} });
        unlinkSync(configPath);
        const handlers = createHarness(configPath);
        const assistant = createAssistant();
        await emitAgentEnd(handlers, createContext(), assistant);
        assert.equal(assistant.usage.totalTokens, 10);
    });

    it("throws for malformed configuration before mutating usage", async () => {
        const configPath = createTempConfig({ global: 50, models: {} });
        writeFileSync(configPath, "{");
        const handlers = createHarness(configPath);
        const assistant = createAssistant();
        await assert.rejects(
            () => emitAgentEnd(handlers, createContext(), assistant),
            (error: unknown) => error instanceof Error && error.message.includes(configPath),
        );
        assert.equal(assistant.usage.totalTokens, 10);
    });

    it("hot-reads policy changes on the next agent end", async () => {
        const configPath = createTempConfig({ global: 90, models: {} });
        const handlers = createHarness(configPath);
        const ctx = createContext({ usedTokens: 80 });
        const firstAssistant = createAssistant();
        await emitAgentEnd(handlers, ctx, firstAssistant);
        assert.equal(firstAssistant.usage.totalTokens, 10);

        writeFileSync(configPath, JSON.stringify({ global: 50, models: {} }));
        const secondAssistant = createAssistant();
        await emitAgentEnd(handlers, ctx, secondAssistant);
        assert.equal(secondAssistant.usage.totalTokens, 101);
    });

    it("uses only public context APIs when the threshold is reached", async () => {
        const configPath = createTempConfig({ global: 50, models: {} });
        const handlers = createHarness(configPath);
        const ctx = createContext();
        assert.equal("getAutoCompactionSettings" in ctx, false);

        const assistant = createAssistant();
        await emitAgentEnd(handlers, ctx, assistant);
        assert.equal(assistant.usage.totalTokens, 101);
    });

    it("does not mutate usage for retry-pending or aborted events", async () => {
        const configPath = createTempConfig({ global: 50, models: {} });
        const handlers = createHarness(configPath);
        const ctx = createContext();
        const retryAssistant = createAssistant("error");
        await emitAgentEnd(handlers, ctx, retryAssistant, true);
        assert.equal(retryAssistant.usage.totalTokens, 10);

        const abortedAssistant = createAssistant("aborted");
        await emitAgentEnd(handlers, ctx, abortedAssistant);
        assert.equal(abortedAssistant.usage.totalTokens, 10);
    });

    it("does not reuse an earlier assistant after an aborted run", async () => {
        const configPath = createTempConfig({ global: 50, models: {} });
        const notifications: Array<{ message: string; level: string }> = [];
        const handlers = createHarness(configPath);

        const firstAssistant = createAssistant();
        await emitAgentEnd(handlers, createContext({ usedTokens: 40, notifications }), firstAssistant);
        assert.equal(firstAssistant.usage.totalTokens, 10);

        const abortedAssistant = createAssistant("aborted");
        await emitAgentEnd(handlers, createContext({ usedTokens: 80, notifications }), abortedAssistant);
        assert.equal(firstAssistant.usage.totalTokens, 10);
        assert.equal(abortedAssistant.usage.totalTokens, 10);
        assert.equal(notifications.length, 0);

        const thirdAssistant = createAssistant();
        await emitAgentEnd(handlers, createContext({ usedTokens: 80, notifications }), thirdAssistant);
        assert.equal(thirdAssistant.usage.totalTokens, 101);
        assert.equal(notifications.length, 1);
    });

    it("nudges once a configured threshold is reached", async () => {
        const configPath = createTempConfig({ global: 50, models: {} });
        const notifications: Array<{ message: string; level: string }> = [];
        const handlers = createHarness(configPath);
        const assistant = createAssistant();
        await emitAgentEnd(handlers, createContext({ notifications }), assistant);
        assert.equal(assistant.usage.totalTokens, 101);
        assert.match(notifications[0].message, /model-aware threshold/);
    });
});
