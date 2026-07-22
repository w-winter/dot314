import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

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
type ThinkingLevel = Parameters<ExtensionAPI["setThinkingLevel"]>[0];
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
        models: [
            { model: "anthropic/large", thinkingLevel: "xhigh" },
            { model: "openai/other-large", thinkingLevel: "medium" },
        ],
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
    thinkingLevel?: ThinkingLevel;
    setModel?: (model: TestModel) => Promise<boolean>;
    setThinkingLevel?: (level: ThinkingLevel) => void;
    appendEntry?: (customType: string, data: unknown) => void;
} = {}) {
    const handlers = new Map<string, EventHandler[]>();
    const commands = new Map<string, CommandHandler>();
    const registeredEvents: string[] = [];
    const appendedEntries: Array<{ customType: string; data: unknown }> = [];
    const transitionCalls: string[] = [];
    let thinkingLevel = options.thinkingLevel ?? "medium";
    const pi = {
        on(eventName: string, handler: EventHandler) {
            registeredEvents.push(eventName);
            handlers.set(eventName, [...(handlers.get(eventName) ?? []), handler]);
        },
        registerCommand(name: string, command: { handler: CommandHandler }) {
            commands.set(name, command.handler);
        },
        async setModel(model: TestModel) {
            transitionCalls.push(`set-model:${model.provider}/${model.id}`);
            return options.setModel?.(model) ?? true;
        },
        getThinkingLevel() {
            return thinkingLevel;
        },
        setThinkingLevel(level: ThinkingLevel) {
            transitionCalls.push(`set-thinking-level:${level}`);
            thinkingLevel = level;
            options.setThinkingLevel?.(level);
        },
        appendEntry(customType: string, data: unknown) {
            options.appendEntry?.(customType, data);
            appendedEntries.push({ customType, data });
        },
    } as unknown as ExtensionAPI;
    return { appendedEntries, commands, handlers, pi, registeredEvents, transitionCalls };
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
    const modelEntry = (model: string, thinkingLevel: string) => ({ model, thinkingLevel });

    it("parses canonical model entries with required thinking levels", () => {
        const config = parseConfig(VALID_CONFIG);
        assert.equal(config.fallback.enabled, true);
        assert.deepEqual(config.fallback.models, [
            { value: "anthropic/large", provider: "anthropic", modelId: "large", thinkingLevel: "xhigh" },
            { value: "openai/other-large", provider: "openai", modelId: "other-large", thinkingLevel: "medium" },
        ]);
        assert.deepEqual(config.fallback.selected, config.fallback.models[0]);
    });

    it("loads the checked-in live and example model policies", () => {
        for (const fileName of ["config.json", "config.json.example"]) {
            const config = loadConfig(fileURLToPath(new URL(fileName, import.meta.url)));
            assert.equal(config.fallback.models[0].value, "anthropic/claude-opus-4-8");
            assert.equal(config.fallback.models[0].thinkingLevel, "xhigh");
            assert.equal(config.fallback.models[1].value, "openai-codex/gpt-5.4");
            assert.equal(config.fallback.models[1].thinkingLevel, "medium");
        }
    });

    it("accepts every Pi thinking level", () => {
        const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
        for (const thinkingLevel of thinkingLevels) {
            const config = parseConfig({
                fallback: {
                    enabled: true,
                    selected: "anthropic/large",
                    models: [modelEntry("anthropic/large", thinkingLevel)],
                },
            });
            assert.equal(config.fallback.selected?.thinkingLevel, thinkingLevel);
        }
    });

    it("uses disabled defaults when the configuration file is missing", () => {
        assert.deepEqual(loadConfig(join(createTempDirectory(), "missing.json")), {
            fallback: { enabled: false, selected: undefined, models: [] },
        });
    });

    it("rejects malformed fallback fields and model entries", () => {
        assert.throws(() => parseConfig({}), /fallback must be an object/);
        assert.throws(() => parseConfig({ fallback: { enabled: "yes", selected: "", models: [] } }), /enabled/);
        assert.throws(() => parseConfig({ fallback: { enabled: false, selected: 5, models: [] } }), /selected/);
        assert.throws(() => parseConfig({ fallback: { enabled: false, selected: "", models: "x" } }), /models/);
        for (const entry of [
            "anthropic/large",
            null,
            [],
            { thinkingLevel: "high" },
            { model: "anthropic/large" },
            { model: 5, thinkingLevel: "high" },
            { model: "anthropic/large", thinkingLevel: 5 },
            { model: "anthropic/large", thinkingLevel: "High" },
            { model: "anthropic/large", thinkingLevel: " high" },
        ]) {
            assert.throws(() => parseConfig({ fallback: { enabled: false, selected: "", models: [entry] } }));
        }
        assert.throws(
            () => parseConfig({
                fallback: {
                    enabled: false,
                    selected: "",
                    models: [modelEntry(" anthropic/large", "high")],
                },
            }),
            /fallback\.models\[0\]\.model/,
        );
    });

    it("rejects noncanonical, duplicate, unavailable, and empty enabled selections", () => {
        assert.throws(() => parseModelReference(" anthropic/large"), /canonical/);
        assert.throws(() => parseConfig({
            fallback: {
                enabled: false,
                selected: "",
                models: [modelEntry("anthropic/large", "high"), modelEntry("anthropic/large", "medium")],
            },
        }), /unique/);
        assert.throws(() => parseConfig({
            fallback: { enabled: true, selected: "anthropic/missing", models: [modelEntry("anthropic/large", "high")] },
        }), /configured/);
        assert.throws(() => parseConfig({
            fallback: { enabled: true, selected: "", models: [modelEntry("anthropic/large", "high")] },
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

    it("sets the model before its configured thinking level at the threshold", async () => {
        const notifications: Array<{ message: string; level: string }> = [];
        const harness = setup();
        const ctx = switchingContext({ usageTokens: 75, notifications });
        await emit(harness.handlers, "session_start", ctx);
        await emit(harness.handlers, "agent_end", ctx);
        assert.deepEqual(harness.transitionCalls, [
            "set-model:anthropic/large",
            "set-thinking-level:xhigh",
        ]);
        assert.equal(harness.pi.getThinkingLevel(), "xhigh");
        assert.deepEqual(notifications, [{
            message: "Switched to context-limit fallback: anthropic/large",
            level: "info",
        }]);
    });

    it("does not switch below the threshold or while disabled", async () => {
        const harness = setup();
        const below = switchingContext({ usageTokens: 74 });
        await emit(harness.handlers, "session_start", below);
        await emit(harness.handlers, "agent_end", below);
        const disabled = switchingContext({ branch: [stateEntry(false, "")] });
        await emit(harness.handlers, "session_start", disabled);
        await emit(harness.handlers, "agent_end", disabled);
        assert.deepEqual(harness.transitionCalls, []);
    });

    it("does nothing without an active model or usage, or once fallback is active", async () => {
        const harness = setup();
        for (const ctx of [
            createContext({ models: [createModel("large", 1000)], usageTokens: 100 }),
            switchingContext({ usageTokens: null }),
            createContext({ currentModel: createModel("large", 1000), usageTokens: 1000 }),
        ]) {
            await emit(harness.handlers, "session_start", ctx);
            await emit(harness.handlers, "agent_end", ctx);
        }
        assert.deepEqual(harness.transitionCalls, []);
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
            assert.deepEqual(harness.transitionCalls, []);
        }
    });

    it("reports model failures without setting a thinking level", async () => {
        for (const setModel of [async () => false, async () => { throw new Error("provider failed"); }]) {
            const notifications: Array<{ message: string; level: string }> = [];
            const harness = setup(VALID_CONFIG, { setModel });
            const ctx = switchingContext({ notifications });
            await emit(harness.handlers, "session_start", ctx);
            await emit(harness.handlers, "agent_end", ctx);
            assert.equal(notifications[0].level, "error");
            assert.equal(harness.transitionCalls.some((call) => call.startsWith("set-thinking-level:")), false);
        }
    });

    it("applies configured thinking after a late model-switch rejection", async () => {
        const notifications: Array<{ message: string; level: string }> = [];
        let currentModel = createModel("capable-x", 100);
        const harness = setup(VALID_CONFIG, {
            setModel: async (model) => {
                currentModel = model;
                throw new Error("late model event failed");
            },
        });
        const ctx = switchingContext({ currentModel, notifications });
        Object.defineProperty(ctx, "model", { get: () => currentModel });
        await emit(harness.handlers, "session_start", ctx);
        await emit(harness.handlers, "agent_end", ctx);
        assert.deepEqual(harness.transitionCalls, [
            "set-model:anthropic/large",
            "set-thinking-level:xhigh",
        ]);
        assert.deepEqual(notifications, [{
            message: "Context-limit fallback model anthropic/large became active, but model switching reported: "
                + "late model event failed",
            level: "error",
        }]);
    });

    it("reports outcome-neutral thinking persistence failures", async () => {
        const notifications: Array<{ message: string; level: string }> = [];
        const harness = setup(VALID_CONFIG, {
            setThinkingLevel: () => { throw new Error("thinking append failed"); },
        });
        const ctx = switchingContext({ notifications });
        await emit(harness.handlers, "session_start", ctx);
        await emit(harness.handlers, "agent_end", ctx);
        assert.deepEqual(harness.transitionCalls, [
            "set-model:anthropic/large",
            "set-thinking-level:xhigh",
        ]);
        assert.equal(harness.pi.getThinkingLevel(), "xhigh");
        assert.deepEqual(notifications, [{
            message: "Context-limit fallback model anthropic/large is active, but applying configured thinking level "
                + "xhigh reported: thinking append failed",
            level: "error",
        }]);
    });

    it("reports combined retained model and thinking failures", async () => {
        const notifications: Array<{ message: string; level: string }> = [];
        let currentModel = createModel("capable-x", 100);
        const harness = setup(VALID_CONFIG, {
            setModel: async (model) => {
                currentModel = model;
                throw new Error("late model event failed");
            },
            setThinkingLevel: () => { throw new Error("thinking append failed"); },
        });
        const ctx = switchingContext({ currentModel, notifications });
        Object.defineProperty(ctx, "model", { get: () => currentModel });
        await emit(harness.handlers, "session_start", ctx);
        await emit(harness.handlers, "agent_end", ctx);
        assert.deepEqual(harness.transitionCalls, [
            "set-model:anthropic/large",
            "set-thinking-level:xhigh",
        ]);
        assert.equal(harness.pi.getThinkingLevel(), "xhigh");
        assert.deepEqual(notifications, [{
            message: "Context-limit fallback model anthropic/large is active, but applying configured thinking level "
                + "xhigh reported: thinking append failed. Model switching also reported: late model event failed",
            level: "error",
        }]);
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
        models?: TestModel[];
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
            ...(options.models ? { models: options.models } : {}),
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

    it("shows thinking in registry labels and persists only the selected model", async () => {
        const subject = setupCommand({
            selection: "other-large name — openai/other-large — thinking: medium",
        });
        const before = readFileSync(subject.configPath, "utf8");
        await subject.handler("", subject.ctx);
        assert.equal(readFileSync(subject.configPath, "utf8"), before);
        assert.deepEqual(subject.appendedEntries[0], {
            customType: "context-limit-fallback-state",
            data: { enabled: true, selected: "openai/other-large" },
        });
        assert.equal(
            subject.notifications[0].message,
            "Context-limit fallback set to openai/other-large with thinking level medium for this session",
        );
    });

    it("shows thinking in labels for unregistered models", async () => {
        const subject = setupCommand({
            selection: "openai/other-large — thinking: medium",
            models: [createModel("large", 1000)],
        });
        await subject.handler("", subject.ctx);
        assert.deepEqual(subject.appendedEntries[0], {
            customType: "context-limit-fallback-state",
            data: { enabled: true, selected: "openai/other-large" },
        });
    });

    it("appends even when the selection equals the shared default", async () => {
        const subject = setupCommand({
            selection: "large name — anthropic/large — thinking: xhigh",
        });
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

    it("uses a command-selected model and thinking level on the next agent_end", async () => {
        const subject = setupCommand({
            selection: "other-large name — openai/other-large — thinking: medium",
        });
        await subject.handler("", subject.ctx);
        await emit(subject.handlers, "agent_end", subject.ctx);
        assert.deepEqual(subject.transitionCalls, [
            "set-model:openai/other-large",
            "set-thinking-level:medium",
        ]);
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
