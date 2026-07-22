import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

import {
    getThresholdPercent,
    loadConfig,
    loadThresholdConfig,
    parseConfig,
    parseModelReference,
    registerContextLimitFallback,
} from "./index.ts";

type EventHandler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;
type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void> | void;
type TestModel = {
    id: string;
    name: string;
    provider: string;
    contextWindow: number;
};
type TestEntry = { type: "custom"; customType: string; data: unknown };

const VALID_CONFIG = {
    fallback: {
        enabled: true,
        selected: "anthropic/large",
        models: ["anthropic/large", "openai/other-large"],
    },
};
const DEFAULT_THRESHOLDS = { global: 75, models: {} };
const tempDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(tempDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function createTempDirectory(): string {
    const path = mkdtempSync(join(tmpdir(), "context-limit-fallback-"));
    tempDirectories.push(path);
    return path;
}

function createModel(id: string, contextWindow: number, provider = "anthropic"): TestModel {
    return { id, name: `${id} name`, provider, contextWindow };
}

function stateEntry(enabled: boolean, selected: string): TestEntry {
    return { type: "custom", customType: "context-limit-fallback-state", data: { enabled, selected } };
}

function createHarness(options: {
    setModel?: (model: TestModel) => Promise<boolean>;
    appendEntry?: (customType: string, data: unknown) => void;
} = {}) {
    const handlers = new Map<string, EventHandler[]>();
    const commands = new Map<string, CommandHandler>();
    const registeredEvents: string[] = [];
    const appendedEntries: Array<{ customType: string; data: unknown }> = [];
    const pi = {
        on(eventName: string, handler: EventHandler) {
            registeredEvents.push(eventName);
            handlers.set(eventName, [...(handlers.get(eventName) ?? []), handler]);
        },
        registerCommand(name: string, command: { handler: CommandHandler }) {
            commands.set(name, command.handler);
        },
        setModel: options.setModel ?? (async () => true),
        appendEntry(customType: string, data: unknown) {
            options.appendEntry?.(customType, data);
            appendedEntries.push({ customType, data });
        },
    } as unknown as ExtensionAPI;
    return { appendedEntries, commands, handlers, pi, registeredEvents };
}

function createContext(options: {
    branch?: TestEntry[];
    currentModel?: TestModel;
    models?: TestModel[];
    usageTokens?: number | null;
    select?: () => Promise<string | undefined>;
    notifications?: Array<{ message: string; level: string }>;
    hasUI?: boolean;
} = {}): ExtensionContext {
    const notifications = options.notifications ?? [];
    return {
        model: options.currentModel,
        hasUI: options.hasUI ?? true,
        cwd: "/tmp",
        getContextUsage: () => (options.usageTokens === null ? undefined : { tokens: options.usageTokens ?? 0 }),
        sessionManager: {
            getBranch: () => (options.branch ?? []) as unknown as SessionEntry[],
        },
        modelRegistry: {
            getAll: () => options.models ?? [],
        },
        ui: {
            select: options.select ?? (async () => undefined),
            notify(message: string, level: string) {
                notifications.push({ message, level });
            },
        },
    } as unknown as ExtensionContext;
}

async function emit(
    handlers: Map<string, EventHandler[]>,
    eventName: string,
    ctx: ExtensionContext,
): Promise<void> {
    for (const handler of handlers.get(eventName) ?? []) {
        await handler({}, ctx);
    }
}

function setup(
    config: unknown = VALID_CONFIG,
    harnessOptions: Parameters<typeof createHarness>[0] = {},
    thresholds: unknown = DEFAULT_THRESHOLDS,
    reserveTokens = 16384,
) {
    const directory = createTempDirectory();
    const configPath = join(directory, "config.json");
    const thresholdConfigPath = join(directory, "thresholds.json");
    const settingsPath = join(directory, "settings.json");
    writeFileSync(configPath, JSON.stringify(config));
    if (thresholds !== null) {
        writeFileSync(thresholdConfigPath, JSON.stringify(thresholds));
    }
    writeFileSync(settingsPath, JSON.stringify({ compaction: { reserveTokens } }));
    const harness = createHarness(harnessOptions);
    registerContextLimitFallback(harness.pi, { configPath, thresholdConfigPath, settingsPath });
    return { ...harness, configPath };
}

function switchingContext(options: Parameters<typeof createContext>[0] = {}): ExtensionContext {
    return createContext({
        currentModel: createModel("capable-x", 100),
        models: [createModel("large", 1000), createModel("other-large", 900, "openai")],
        usageTokens: 90,
        ...options,
    });
}

describe("configuration", () => {
    it("parses canonical defaults and allowed model references", () => {
        const config = parseConfig(VALID_CONFIG);
        assert.equal(config.fallback.enabled, true);
        assert.equal(config.fallback.models.length, 2);
        assert.deepEqual(config.fallback.selected, {
            value: "anthropic/large",
            provider: "anthropic",
            modelId: "large",
        });
    });

    it("uses disabled defaults when the configuration file is missing", () => {
        assert.deepEqual(loadConfig(join(createTempDirectory(), "missing.json")), {
            fallback: { enabled: false, selected: undefined, models: [] },
        });
    });

    it("rejects malformed fallback fields", () => {
        assert.throws(() => parseConfig({}), /fallback must be an object/);
        assert.throws(() => parseConfig({ fallback: { enabled: "yes", selected: "", models: [] } }), /enabled/);
        assert.throws(() => parseConfig({ fallback: { enabled: false, selected: 5, models: [] } }), /selected/);
        assert.throws(() => parseConfig({ fallback: { enabled: false, selected: "", models: "x" } }), /models/);
    });

    it("rejects noncanonical, duplicate, unavailable, and empty enabled selections", () => {
        assert.throws(() => parseModelReference(" anthropic/large"), /canonical/);
        assert.throws(() => parseConfig({
            fallback: { enabled: false, selected: "", models: ["anthropic/large", "anthropic/large"] },
        }), /unique/);
        assert.throws(() => parseConfig({
            fallback: { enabled: true, selected: "anthropic/missing", models: ["anthropic/large"] },
        }), /configured/);
        assert.throws(() => parseConfig({
            fallback: { enabled: true, selected: "", models: ["anthropic/large"] },
        }), /selection/);
    });

    it("qualifies invalid configuration errors with the path", () => {
        const configPath = join(createTempDirectory(), "config.json");
        writeFileSync(configPath, JSON.stringify({ fallback: { enabled: true, selected: "", models: [] } }));
        assert.throws(
            () => loadConfig(configPath),
            (error: unknown) => error instanceof Error
                && error.message.includes(configPath)
                && /requires a fallback selection/.test(error.message),
        );
    });
});

describe("threshold resolution", () => {
    it("resolves exact, first matching wildcard, and global thresholds", () => {
        const config = { global: 75, models: { "capable-exact": 40, "capable-*": 60, "capable-x*": 20 } };
        assert.equal(getThresholdPercent(config, "capable-exact"), 40);
        assert.equal(getThresholdPercent(config, "capable-x"), 60);
        assert.equal(getThresholdPercent(config, "other"), 75);
    });

    it("matches model-aware wildcard patterns like gpt-5.6*luna*", () => {
        const config = { global: 95, models: { "gpt-5.6*luna*": 4 } };
        assert.equal(getThresholdPercent(config, "gpt-5.6-luna"), 4);
        assert.equal(getThresholdPercent(config, "gpt-5.6-codex"), 95);
    });

    it("parses a present model-aware config and treats a missing file as absent", () => {
        const path = join(createTempDirectory(), "thresholds.json");
        writeFileSync(path, JSON.stringify({ global: 70, models: { "claude-*": 81 } }));
        const config = loadThresholdConfig(path)!;
        assert.equal(getThresholdPercent(config, "claude-opus-4-8"), 81);
        assert.equal(getThresholdPercent(config, "other"), 70);
        assert.equal(loadThresholdConfig(join(createTempDirectory(), "missing.json")), undefined);
    });

    it("rejects a present model-aware config that omits global or is out of range", () => {
        const missingGlobal = join(createTempDirectory(), "missing-global.json");
        writeFileSync(missingGlobal, JSON.stringify({ models: {} }));
        assert.throws(() => loadThresholdConfig(missingGlobal), /Invalid model-aware-compaction config/);
        const outOfRange = join(createTempDirectory(), "out-of-range.json");
        writeFileSync(outOfRange, JSON.stringify({ global: 150, models: {} }));
        assert.throws(() => loadThresholdConfig(outOfRange), /Invalid model-aware-compaction config/);
    });
});

describe("session-local state", () => {
    it("registers reconstruction, switching, and command hooks", () => {
        const harness = setup();
        assert.deepEqual(harness.registeredEvents, ["session_start", "session_tree", "agent_end"]);
        assert.deepEqual([...harness.commands.keys()], ["context-limit-fallback"]);
    });

    it("uses shared defaults when the branch has no state entry", async () => {
        let calls = 0;
        const harness = setup(VALID_CONFIG, { setModel: async () => { calls += 1; return true; } });
        const ctx = switchingContext();
        await emit(harness.handlers, "session_start", ctx);
        await emit(harness.handlers, "agent_end", ctx);
        assert.equal(calls, 1);
    });

    it("uses the latest matching entry and ignores unrelated malformed entries", async () => {
        let selected = "";
        const harness = setup(VALID_CONFIG, {
            setModel: async (model) => { selected = `${model.provider}/${model.id}`; return true; },
        });
        const ctx = switchingContext({ branch: [
            { type: "custom", customType: "other", data: null },
            stateEntry(false, ""),
            stateEntry(true, "openai/other-large"),
        ] });
        await emit(harness.handlers, "session_start", ctx);
        await emit(harness.handlers, "agent_end", ctx);
        assert.equal(selected, "openai/other-large");
    });

    it("uses a later valid state despite an earlier malformed matching entry", async () => {
        let calls = 0;
        const harness = setup(VALID_CONFIG, { setModel: async () => { calls += 1; return true; } });
        const ctx = switchingContext({ branch: [
            { type: "custom", customType: "context-limit-fallback-state", data: null },
            stateEntry(true, "anthropic/large"),
        ] });
        await emit(harness.handlers, "session_start", ctx);
        await emit(harness.handlers, "agent_end", ctx);
        assert.equal(calls, 1);
    });

    it("rejects malformed latest owned state variants", async () => {
        const invalidStates = [
            null,
            { enabled: true, selected: "" },
            { enabled: false, selected: "anthropic/large" },
            { enabled: true, selected: "anthropic/missing" },
            { enabled: true, selected: "anthropic/large", extra: true },
        ];
        for (const data of invalidStates) {
            const harness = setup();
            const ctx = switchingContext({ branch: [
                { type: "custom", customType: "context-limit-fallback-state", data },
            ] });
            await assert.rejects(
                () => emit(harness.handlers, "session_start", ctx),
                /Invalid "context-limit-fallback-state" session entry/,
            );
        }
    });

    it("does not leak prior session state when reconstruction fails", async () => {
        let calls = 0;
        const harness = setup(VALID_CONFIG, { setModel: async () => { calls += 1; return true; } });
        await emit(harness.handlers, "session_start", switchingContext({
            branch: [stateEntry(true, "anthropic/large")],
        }));
        await assert.rejects(() => emit(harness.handlers, "session_start", switchingContext({ branch: [
            { type: "custom", customType: "context-limit-fallback-state", data: null },
        ] })));
        await emit(harness.handlers, "agent_end", switchingContext());
        assert.equal(calls, 0);
    });

    it("isolates two sessions and restores the first session on return", async () => {
        const selected: string[] = [];
        const harness = setup(VALID_CONFIG, {
            setModel: async (model) => { selected.push(`${model.provider}/${model.id}`); return true; },
        });
        const sessionA = switchingContext({ branch: [stateEntry(true, "openai/other-large")] });
        const sessionB = switchingContext({ branch: [stateEntry(false, "")] });
        await emit(harness.handlers, "session_start", sessionA);
        await emit(harness.handlers, "agent_end", sessionA);
        await emit(harness.handlers, "session_start", sessionB);
        await emit(harness.handlers, "agent_end", sessionB);
        await emit(harness.handlers, "session_start", sessionA);
        await emit(harness.handlers, "agent_end", sessionA);
        assert.deepEqual(selected, ["openai/other-large", "openai/other-large"]);
    });

    it("restores sibling-specific states on session_tree and inherits ancestor state", async () => {
        const selected: string[] = [];
        const harness = setup(VALID_CONFIG, {
            setModel: async (model) => { selected.push(`${model.provider}/${model.id}`); return true; },
        });
        const ancestor = stateEntry(true, "anthropic/large");
        const inherited = switchingContext({ branch: [ancestor] });
        const disabledSibling = switchingContext({ branch: [ancestor, stateEntry(false, "")] });
        const otherSibling = switchingContext({ branch: [ancestor, stateEntry(true, "openai/other-large")] });
        for (const ctx of [inherited, disabledSibling, otherSibling]) {
            await emit(harness.handlers, "session_tree", ctx);
            await emit(harness.handlers, "agent_end", ctx);
        }
        assert.deepEqual(selected, ["anthropic/large", "openai/other-large"]);
    });
});

describe("threshold handoff", () => {
    it("switches strictly above Pi's native contextWindow - reserveTokens point when model-aware is absent", async () => {
        let calls = 0;
        const harness = setup(
            VALID_CONFIG,
            { setModel: async () => { calls += 1; return true; } },
            null,
            16384,
        );
        const native = (usageTokens: number) => switchingContext({
            currentModel: createModel("capable-x", 100000),
            models: [createModel("large", 1000000)],
            usageTokens,
        });
        const atBoundary = native(83616); // 100000 - 16384; Pi does not compact at equality
        await emit(harness.handlers, "session_start", atBoundary);
        await emit(harness.handlers, "agent_end", atBoundary);
        assert.equal(calls, 0);
        const above = native(83617);
        await emit(harness.handlers, "session_start", above);
        await emit(harness.handlers, "agent_end", above);
        assert.equal(calls, 1);
    });

    it("uses reserveTokens from settings for the native interception point", async () => {
        let calls = 0;
        const harness = setup(
            VALID_CONFIG,
            { setModel: async () => { calls += 1; return true; } },
            null,
            50000,
        );
        const ctx = switchingContext({
            currentModel: createModel("capable-x", 100000),
            models: [createModel("large", 1000000)],
            usageTokens: 50001,
        });
        await emit(harness.handlers, "session_start", ctx);
        await emit(harness.handlers, "agent_end", ctx);
        assert.equal(calls, 1);
    });

    it("reports an error and does not switch when the model-aware config is present but malformed", async () => {
        let calls = 0;
        const notifications: Array<{ message: string; level: string }> = [];
        const harness = setup(
            VALID_CONFIG,
            { setModel: async () => { calls += 1; return true; } },
            { models: {} },
        );
        const ctx = switchingContext({ notifications });
        await emit(harness.handlers, "session_start", ctx);
        await emit(harness.handlers, "agent_end", ctx);
        assert.equal(calls, 0);
        assert.equal(notifications[0].level, "error");
        assert.match(notifications[0].message, /Invalid model-aware-compaction config/);
    });

    it("switches when usage reaches the current session threshold", async () => {
        let calls = 0;
        const notifications: Array<{ message: string; level: string }> = [];
        const harness = setup(VALID_CONFIG, { setModel: async () => { calls += 1; return true; } });
        const ctx = switchingContext({ usageTokens: 75, notifications });
        await emit(harness.handlers, "session_start", ctx);
        await emit(harness.handlers, "agent_end", ctx);
        assert.equal(calls, 1);
        assert.deepEqual(notifications, [{
            message: "Switched to context-limit fallback: anthropic/large",
            level: "info",
        }]);
    });

    it("does not switch below the threshold or while disabled", async () => {
        let calls = 0;
        const harness = setup(VALID_CONFIG, { setModel: async () => { calls += 1; return true; } });
        const below = switchingContext({ usageTokens: 74 });
        await emit(harness.handlers, "session_start", below);
        await emit(harness.handlers, "agent_end", below);
        const disabled = switchingContext({ branch: [stateEntry(false, "")] });
        await emit(harness.handlers, "session_start", disabled);
        await emit(harness.handlers, "agent_end", disabled);
        assert.equal(calls, 0);
    });

    it("does nothing without an active model or usage, or once fallback is active", async () => {
        let calls = 0;
        const harness = setup(VALID_CONFIG, { setModel: async () => { calls += 1; return true; } });
        for (const ctx of [
            createContext({ models: [createModel("large", 1000)], usageTokens: 100 }),
            switchingContext({ usageTokens: null }),
            createContext({ currentModel: createModel("large", 1000), usageTokens: 1000 }),
        ]) {
            await emit(harness.handlers, "session_start", ctx);
            await emit(harness.handlers, "agent_end", ctx);
        }
        assert.equal(calls, 0);
    });

    it("reports invalid active, absent, invalid, and non-larger fallback models", async () => {
        const cases = [
            switchingContext({ currentModel: createModel("capable-x", 0) }),
            switchingContext({ models: [] }),
            switchingContext({ models: [createModel("large", 0)] }),
            switchingContext({ models: [createModel("large", 100)] }),
        ];
        for (const ctx of cases) {
            const notifications: Array<{ message: string; level: string }> = [];
            ctx.ui.notify = (message: string, level: string) => notifications.push({ message, level });
            const harness = setup();
            await emit(harness.handlers, "session_start", ctx);
            await emit(harness.handlers, "agent_end", ctx);
            assert.equal(notifications[0].level, "error");
        }
    });

    it("reports missing credentials and thrown provider failures", async () => {
        for (const setModel of [async () => false, async () => { throw new Error("provider failed"); }]) {
            const notifications: Array<{ message: string; level: string }> = [];
            const harness = setup(VALID_CONFIG, { setModel });
            const ctx = switchingContext({ notifications });
            await emit(harness.handlers, "session_start", ctx);
            await emit(harness.handlers, "agent_end", ctx);
            assert.equal(notifications[0].level, "error");
        }
    });

    it("reports automatic failures through console without UI", async () => {
        const messages: string[] = [];
        const originalError = console.error;
        console.error = (message?: unknown) => messages.push(String(message));
        try {
            const harness = setup();
            const ctx = switchingContext({ models: [], hasUI: false });
            await emit(harness.handlers, "session_start", ctx);
            await emit(harness.handlers, "agent_end", ctx);
        } finally {
            console.error = originalError;
        }
        assert.match(messages[0], /^\[context-limit-fallback\].*is not registered/);
    });
});

describe("command", () => {
    function setupCommand(options: {
        selection?: string;
        appendEntry?: (customType: string, data: unknown) => void;
        setModel?: (model: TestModel) => Promise<boolean>;
        hasUI?: boolean;
    } = {}) {
        const notifications: Array<{ message: string; level: string }> = [];
        const harness = setup(VALID_CONFIG, {
            appendEntry: options.appendEntry,
            setModel: options.setModel,
        });
        const ctx = switchingContext({
            select: async () => options.selection,
            notifications,
            hasUI: options.hasUI,
        });
        return {
            ...harness,
            ctx,
            notifications,
            handler: harness.commands.get("context-limit-fallback")!,
        };
    }

    it("appends an explicit disabled snapshot without changing shared config", async () => {
        const subject = setupCommand({ selection: "Disabled" });
        const before = readFileSync(subject.configPath, "utf8");
        await subject.handler("", subject.ctx);
        assert.equal(readFileSync(subject.configPath, "utf8"), before);
        assert.deepEqual(subject.appendedEntries, [{
            customType: "context-limit-fallback-state",
            data: { enabled: false, selected: "" },
        }]);
        assert.match(subject.notifications[0].message, /disabled for this session/);
    });

    it("uses registry labels and appends a complete selected snapshot", async () => {
        const subject = setupCommand({ selection: "other-large name — openai/other-large" });
        const before = readFileSync(subject.configPath, "utf8");
        await subject.handler("", subject.ctx);
        assert.equal(readFileSync(subject.configPath, "utf8"), before);
        assert.deepEqual(subject.appendedEntries[0], {
            customType: "context-limit-fallback-state",
            data: { enabled: true, selected: "openai/other-large" },
        });
        assert.match(subject.notifications[0].message, /for this session/);
    });

    it("appends even when the selection equals the shared default", async () => {
        const subject = setupCommand({ selection: "large name — anthropic/large" });
        await subject.handler("", subject.ctx);
        assert.equal(subject.appendedEntries.length, 1);
    });

    it("cancellation, unknown selection, and headless invocation append nothing", async () => {
        for (const options of [
            { selection: undefined },
            { selection: "unknown" },
            { selection: "Disabled", hasUI: false },
        ]) {
            const subject = setupCommand(options);
            await subject.handler("", subject.ctx);
            assert.equal(subject.appendedEntries.length, 0);
        }
    });

    it("uses an enabled command selection on the next agent_end", async () => {
        let selectedModel = "";
        const subject = setupCommand({
            selection: "other-large name — openai/other-large",
            setModel: async (model) => { selectedModel = `${model.provider}/${model.id}`; return true; },
        });
        await subject.handler("", subject.ctx);
        await emit(subject.handlers, "agent_end", subject.ctx);
        assert.equal(selectedModel, "openai/other-large");
    });

    it("stops switching after a disabled command selection", async () => {
        let calls = 0;
        const subject = setupCommand({
            selection: "Disabled",
            setModel: async () => { calls += 1; return true; },
        });
        await subject.handler("", subject.ctx);
        await emit(subject.handlers, "agent_end", subject.ctx);
        assert.equal(calls, 0);
    });

    it("retains the prior state when append fails", async () => {
        let calls = 0;
        const subject = setupCommand({
            selection: "Disabled",
            appendEntry: () => { throw new Error("append failed"); },
            setModel: async () => { calls += 1; return true; },
        });
        await emit(subject.handlers, "session_start", subject.ctx);
        await subject.handler("", subject.ctx);
        await emit(subject.handlers, "agent_end", subject.ctx);
        assert.equal(calls, 1);
        assert.match(subject.notifications[0].message, /Could not update.*append failed/);
    });
});
