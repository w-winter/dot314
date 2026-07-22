/**
 * Context Limit Fallback
 *
 * Switches the current session to a configured, strictly larger-context model once the active
 * model reaches the point where compaction would trigger: the model-aware-compaction threshold
 * when one is configured, otherwise Pi's native auto-compaction point (contextWindow - reserveTokens).
 * Shared configuration supplies defaults and the allowed fallback models; `/context-limit-fallback`
 * stores an explicit override in the current session.
 *
 * This extension only switches the model. It never compacts, summarizes, or mutates usage.
 */

import {
    type ExtensionAPI,
    type ExtensionContext,
    type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface ConfiguredModelReference {
    readonly value: string;
    readonly provider: string;
    readonly modelId: string;
}

export interface ContextLimitFallbackConfig {
    readonly fallback: {
        readonly enabled: boolean;
        readonly selected: ConfiguredModelReference | undefined;
        readonly models: readonly ConfiguredModelReference[];
    };
}

export interface ContextLimitFallbackOptions {
    readonly configPath?: string;
    readonly thresholdConfigPath?: string;
    readonly settingsPath?: string;
}

export interface ThresholdConfig {
    readonly global: number;
    readonly models: Readonly<Record<string, number>>;
}

type JsonObject = Record<string, unknown>;
type PersistedFallbackSessionState =
    | { readonly enabled: false; readonly selected: "" }
    | { readonly enabled: true; readonly selected: string };
type EffectiveFallbackSessionState =
    | { readonly enabled: false }
    | { readonly enabled: true; readonly selected: ConfiguredModelReference };

const DEFAULT_RESERVE_TOKENS = 16384;
const FALLBACK_STATE_ENTRY_TYPE = "context-limit-fallback-state";
const EXTENSION_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(EXTENSION_DIRECTORY, "config.json");
const THRESHOLD_CONFIG_PATH = join(EXTENSION_DIRECTORY, "..", "model-aware-compaction", "config.json");
// Pi's native auto-compaction reserve, used when model-aware-compaction sets no threshold for a model.
const AGENT_DIRECTORY = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const SETTINGS_PATH = join(AGENT_DIRECTORY, "settings.json");
const DEFAULT_RAW_CONFIG = {
    fallback: {
        enabled: false,
        selected: "",
        models: [],
    },
};

class SwitchError extends Error {}

function isObject(value: unknown): value is JsonObject {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function parseModelReference(value: string): ConfiguredModelReference {
    const separatorIndex = value.indexOf("/");
    if (
        value.trim() !== value
        || separatorIndex <= 0
        || separatorIndex === value.length - 1
    ) {
        throw new Error(`Model reference must be canonical provider/modelId: ${JSON.stringify(value)}`);
    }

    const provider = value.slice(0, separatorIndex);
    const modelId = value.slice(separatorIndex + 1);
    if (provider.trim() !== provider || modelId.trim() !== modelId) {
        throw new Error(`Model reference must be canonical provider/modelId: ${JSON.stringify(value)}`);
    }

    return { value, provider, modelId };
}

export function parseConfig(value: unknown): ContextLimitFallbackConfig {
    if (!isObject(value)) {
        throw new Error("config must be an object");
    }
    if (!isObject(value.fallback)) {
        throw new Error("fallback must be an object");
    }
    if (typeof value.fallback.enabled !== "boolean") {
        throw new Error("fallback.enabled must be a boolean");
    }
    if (typeof value.fallback.selected !== "string") {
        throw new Error("fallback.selected must be a string");
    }
    if (!Array.isArray(value.fallback.models) || !value.fallback.models.every((model) => typeof model === "string")) {
        throw new Error("fallback.models must be an array of canonical provider/modelId strings");
    }

    const fallbackModels = value.fallback.models.map(parseModelReference);
    if (new Set(fallbackModels.map((model) => model.value)).size !== fallbackModels.length) {
        throw new Error("fallback.models entries must be unique");
    }

    const selectedValue = value.fallback.selected;
    const selected = selectedValue === "" ? undefined : parseModelReference(selectedValue);
    if (selected && !fallbackModels.some((model) => model.value === selected.value)) {
        throw new Error("fallback.selected must be one of the configured fallback.models");
    }
    if (value.fallback.enabled && !selected) {
        throw new Error("fallback.enabled requires a fallback selection");
    }

    return {
        fallback: {
            enabled: value.fallback.enabled,
            selected,
            models: fallbackModels,
        },
    };
}

export function loadConfig(configPath = CONFIG_PATH): ContextLimitFallbackConfig {
    if (!existsSync(configPath)) {
        return parseConfig(DEFAULT_RAW_CONFIG);
    }

    try {
        return parseConfig(JSON.parse(readFileSync(configPath, "utf8")) as unknown);
    } catch (error) {
        if (error instanceof Error) {
            error.message = `Invalid context-limit-fallback config at ${configPath}: ${error.message}`;
        }
        throw error;
    }
}

function parsePercent(value: unknown, owner: string): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
        throw new Error(`${owner} must be a finite number from 0 to 100`);
    }
    return Math.floor(value);
}

function parseThresholdConfig(value: unknown): ThresholdConfig {
    if (!isObject(value)) {
        throw new Error("config must be an object");
    }
    if (!isObject(value.models)) {
        throw new Error("models must be an object");
    }
    return {
        global: parsePercent(value.global, "global"),
        models: Object.fromEntries(
            Object.entries(value.models).map(([pattern, threshold]) => [
                pattern,
                parsePercent(threshold, `models.${JSON.stringify(pattern)}`),
            ]),
        ),
    };
}

// Pi compacts when used tokens exceed contextWindow - reserveTokens (default reserve 16384).
function loadReserveTokens(settingsPath = SETTINGS_PATH): number {
    try {
        const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as JsonObject;
        const compaction = isObject(parsed.compaction) ? parsed.compaction : undefined;
        const value = compaction?.reserveTokens;
        if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
            return Math.floor(value);
        }
        return DEFAULT_RESERVE_TOKENS;
    } catch {
        return DEFAULT_RESERVE_TOKENS;
    }
}

export function loadThresholdConfig(thresholdConfigPath = THRESHOLD_CONFIG_PATH): ThresholdConfig | undefined {
    let configText: string;
    try {
        configText = readFileSync(thresholdConfigPath, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return undefined;
        }
        throw new Error(
            `Could not read model-aware-compaction config at ${thresholdConfigPath}: ${errorMessage(error)}`,
        );
    }
    try {
        return parseThresholdConfig(JSON.parse(configText) as unknown);
    } catch (error) {
        throw new Error(`Invalid model-aware-compaction config at ${thresholdConfigPath}: ${errorMessage(error)}`);
    }
}

export function getThresholdPercent(config: ThresholdConfig, modelId: string): number {
    if (config.models[modelId] !== undefined) {
        return config.models[modelId];
    }
    for (const [pattern, threshold] of Object.entries(config.models)) {
        if (!pattern.includes("*")) {
            continue;
        }
        const escapedPattern = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
        const regex = new RegExp(`^${escapedPattern.replace(/\*/g, ".*")}$`);
        if (regex.test(modelId)) {
            return threshold;
        }
    }
    return config.global;
}

function parseFallbackSessionState(
    value: unknown,
    configuredModels: readonly ConfiguredModelReference[],
): EffectiveFallbackSessionState {
    if (!isObject(value)) {
        throw new Error("state must be an object");
    }
    const keys = Object.keys(value).sort();
    if (keys.length !== 2 || keys[0] !== "enabled" || keys[1] !== "selected") {
        throw new Error('state must contain exactly "enabled" and "selected"');
    }
    if (typeof value.enabled !== "boolean") {
        throw new Error("enabled must be a boolean");
    }
    if (typeof value.selected !== "string") {
        throw new Error("selected must be a string");
    }
    if (!value.enabled) {
        if (value.selected !== "") {
            throw new Error("disabled state requires an empty selection");
        }
        return { enabled: false };
    }
    if (value.selected === "") {
        throw new Error("enabled state requires a selection");
    }

    const selected = parseModelReference(value.selected);
    const configuredModel = configuredModels.find((model) => model.value === selected.value);
    if (!configuredModel) {
        throw new Error("selected model must be one of the configured fallback.models");
    }
    return { enabled: true, selected: configuredModel };
}

function stateFromConfig(config: ContextLimitFallbackConfig): EffectiveFallbackSessionState {
    if (!config.fallback.enabled) {
        return { enabled: false };
    }
    return { enabled: true, selected: config.fallback.selected! };
}

function resolveFallbackSessionState(
    branchEntries: readonly SessionEntry[],
    config: ContextLimitFallbackConfig,
): EffectiveFallbackSessionState {
    for (let index = branchEntries.length - 1; index >= 0; index -= 1) {
        const entry = branchEntries[index];
        if (entry.type !== "custom" || entry.customType !== FALLBACK_STATE_ENTRY_TYPE) {
            continue;
        }
        try {
            return parseFallbackSessionState(entry.data, config.fallback.models);
        } catch (error) {
            throw new Error(`Invalid "${FALLBACK_STATE_ENTRY_TYPE}" session entry: ${errorMessage(error)}`);
        }
    }
    return stateFromConfig(config);
}

function requireContextWindow(value: unknown, owner: string): number {
    if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
        throw new SwitchError(`${owner} context window must be a positive finite integer`);
    }
    return value;
}

function resolveUsedTokens(ctx: ExtensionContext): number | undefined {
    const tokens = ctx.getContextUsage()?.tokens;
    if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0) {
        return undefined;
    }
    return tokens;
}

function modelReference(model: { readonly provider: string; readonly id: string }): string {
    return `${model.provider}/${model.id}`;
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "error"): void {
    if (ctx.hasUI) {
        ctx.ui.notify(message, level);
        return;
    }
    const logger = level === "info" ? console.info : console.error;
    logger(`[context-limit-fallback] ${message}`);
}

async function maybeSwitchToFallback(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    state: EffectiveFallbackSessionState,
    thresholds: ThresholdConfig | undefined,
    reserveTokens: number,
): Promise<void> {
    if (!state.enabled) {
        return;
    }

    const activeModel = ctx.model;
    const selected = state.selected;
    if (!activeModel) {
        return;
    }
    if (activeModel.provider === selected.provider && activeModel.id === selected.modelId) {
        return;
    }

    const usedTokens = resolveUsedTokens(ctx);
    if (usedTokens === undefined) {
        return;
    }

    try {
        const activeContextWindow = requireContextWindow(
            activeModel.contextWindow,
            `active model ${modelReference(activeModel)}`,
        );
        // A present model-aware config uses used% >= threshold%; when absent, mirror Pi's native
        // shouldCompact exactly: switch only when usedTokens > contextWindow - reserveTokens.
        const reachedThreshold = thresholds
            ? usedTokens >= Math.floor((getThresholdPercent(thresholds, activeModel.id) / 100) * activeContextWindow)
            : usedTokens > activeContextWindow - reserveTokens;
        if (!reachedThreshold) {
            return;
        }

        const fallbackModel = ctx.modelRegistry.getAll().find(
            (model) => model.provider === selected.provider && model.id === selected.modelId,
        );
        if (!fallbackModel) {
            throw new SwitchError(`${selected.value} is not registered`);
        }

        const fallbackContextWindow = requireContextWindow(
            fallbackModel.contextWindow,
            `fallback model ${selected.value}`,
        );
        if (fallbackContextWindow <= activeContextWindow) {
            throw new SwitchError(
                `${selected.value} must have a larger context window than ${modelReference(activeModel)} `
                + `(${fallbackContextWindow} <= ${activeContextWindow})`,
            );
        }

        if (!await pi.setModel(fallbackModel)) {
            throw new SwitchError(`No API key for ${selected.value}`);
        }
    } catch (error) {
        notify(ctx, `Could not switch to context-limit fallback: ${errorMessage(error)}`, "error");
        return;
    }

    notify(ctx, `Switched to context-limit fallback: ${selected.value}`, "info");
}

export function registerContextLimitFallback(
    pi: ExtensionAPI,
    options: ContextLimitFallbackOptions = {},
): void {
    const config = loadConfig(options.configPath ?? CONFIG_PATH);
    const thresholdConfigPath = options.thresholdConfigPath ?? THRESHOLD_CONFIG_PATH;
    const settingsPath = options.settingsPath ?? SETTINGS_PATH;
    let currentSessionState: EffectiveFallbackSessionState | undefined;

    const reconstruct = (ctx: ExtensionContext): void => {
        currentSessionState = undefined;
        currentSessionState = resolveFallbackSessionState(ctx.sessionManager.getBranch(), config);
    };

    pi.registerCommand("context-limit-fallback", {
        description: "Choose the larger-context model for this session",
        handler: async (_args, ctx) => {
            if (!ctx.hasUI) {
                return;
            }

            const registryModels = ctx.modelRegistry.getAll();
            const choices = config.fallback.models.map((configuredModel) => {
                const registeredModel = registryModels.find(
                    (model) => model.provider === configuredModel.provider && model.id === configuredModel.modelId,
                );
                return {
                    label: registeredModel
                        ? `${registeredModel.name} — ${configuredModel.value}`
                        : configuredModel.value,
                    reference: configuredModel.value,
                };
            });
            const selectedLabel = await ctx.ui.select(
                "Context-limit fallback for this session",
                ["Disabled", ...choices.map((choice) => choice.label)],
            );
            if (selectedLabel === undefined) {
                return;
            }

            const selectedChoice = choices.find((choice) => choice.label === selectedLabel);
            const persistedState: PersistedFallbackSessionState | undefined = selectedLabel === "Disabled"
                ? { enabled: false, selected: "" }
                : selectedChoice
                    ? { enabled: true, selected: selectedChoice.reference }
                    : undefined;
            if (!persistedState) {
                return;
            }

            const previousState = currentSessionState;
            try {
                const effectiveState = parseFallbackSessionState(persistedState, config.fallback.models);
                pi.appendEntry(FALLBACK_STATE_ENTRY_TYPE, persistedState);
                currentSessionState = effectiveState;
                notify(
                    ctx,
                    effectiveState.enabled
                        ? `Context-limit fallback set to ${effectiveState.selected.value} for this session`
                        : "Context-limit fallback disabled for this session",
                    "info",
                );
            } catch (error) {
                currentSessionState = previousState;
                notify(
                    ctx,
                    `Could not update context-limit fallback for this session: ${errorMessage(error)}`,
                    "error",
                );
            }
        },
    });

    pi.on("session_start", (_event, ctx) => {
        reconstruct(ctx);
    });

    pi.on("session_tree", (_event, ctx) => {
        reconstruct(ctx);
    });

    pi.on("agent_end", async (_event, ctx) => {
        if (!currentSessionState) {
            return;
        }
        let thresholds: ThresholdConfig | undefined;
        try {
            thresholds = loadThresholdConfig(thresholdConfigPath);
        } catch (error) {
            notify(ctx, `Could not switch to context-limit fallback: ${errorMessage(error)}`, "error");
            return;
        }
        await maybeSwitchToFallback(
            pi,
            ctx,
            currentSessionState,
            thresholds,
            loadReserveTokens(settingsPath),
        );
    });
}

export default function contextLimitFallback(pi: ExtensionAPI): void {
    registerContextLimitFallback(pi);
}
