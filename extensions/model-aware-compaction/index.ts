import {
    buildSessionContext,
    estimateTokens,
    type ExtensionAPI,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface CompactionConfig {
    global: number;
    models: Record<string, number>;
}

export interface ModelAwareCompactionDependencies {
    configPath?: string;
    isAutoCompactionEnabled?: (cwd: string) => boolean;
}

type EffectiveCompactionPolicy =
    | { status: "unavailable"; reason: "missing-policy" }
    | { status: "unavailable"; reason: "auto-compaction-disabled"; thresholdPercent: number }
    | { status: "available"; thresholdPercent: number };

type AssistantMessageWithUsage = {
    role: "assistant";
    stopReason?: string;
    usage: { totalTokens?: number };
};

const DEFAULT_CONTEXT_WINDOW = 128000;
const COMPACTION_COOLDOWN_MS = 15000;
const NUDGE_COOLDOWN_MS = 5000;
const DEFAULT_CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), "config.json");

function parsePercent(value: unknown, path: string): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
        throw new Error(`${path} must be a number from 0 to 100`);
    }

    return Math.floor(value);
}

export function parseCompactionConfig(value: unknown): CompactionConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("config must be an object");
    }

    const config = value as Record<string, unknown>;
    if (config.models === null || typeof config.models !== "object" || Array.isArray(config.models)) {
        throw new Error("config.models must be an object");
    }

    const models = Object.fromEntries(
        Object.entries(config.models).map(([modelId, threshold]) => [
            modelId,
            parsePercent(threshold, `config.models.${modelId}`),
        ]),
    );

    return {
        global: parsePercent(config.global, "config.global"),
        models,
    };
}

export function loadCompactionConfig(configPath = DEFAULT_CONFIG_PATH): CompactionConfig | undefined {
    if (!existsSync(configPath)) {
        return undefined;
    }

    try {
        return parseCompactionConfig(JSON.parse(readFileSync(configPath, "utf-8")) as unknown);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid model-aware compaction config at ${configPath}: ${message}`, { cause: error });
    }
}

export function getThresholdPercent(config: CompactionConfig, modelId: string): number {
    if (Object.hasOwn(config.models, modelId)) {
        return config.models[modelId]!;
    }

    for (const [pattern, threshold] of Object.entries(config.models)) {
        if (!pattern.includes("*")) {
            continue;
        }

        const escapedPattern = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
        const regex = new RegExp(`^${escapedPattern.replace(/\*/g, ".*")}$`);
        if (regex.test(modelId)) {
            return threshold;
        }
    }

    return config.global;
}

function estimateSystemPromptTokens(ctx: ExtensionContext): number {
    return Math.ceil(ctx.getSystemPrompt().length / 4);
}

function estimateLeafTokens(ctx: ExtensionContext): number {
    const sessionContext = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
    const messageTokens = sessionContext.messages.reduce((sum, message) => sum + estimateTokens(message), 0);
    return messageTokens + estimateSystemPromptTokens(ctx);
}

function getLastBranchCompactionMs(ctx: ExtensionContext): number | undefined {
    const branchEntries = ctx.sessionManager.getBranch();

    for (let index = branchEntries.length - 1; index >= 0; index -= 1) {
        const entry = branchEntries[index];
        if (entry.type !== "compaction") {
            continue;
        }

        const timestampMs = Date.parse(entry.timestamp);
        return Number.isNaN(timestampMs) ? undefined : timestampMs;
    }

    return undefined;
}

function readJsonFile(filePath: string): unknown | undefined {
    if (!existsSync(filePath)) {
        return undefined;
    }

    try {
        return JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid Pi settings JSON at ${filePath}: ${message}`, { cause: error });
    }
}

function getCompactionEnabledFromSettings(settings: unknown): boolean | undefined {
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
        return undefined;
    }

    const compaction = (settings as Record<string, unknown>).compaction;
    if (!compaction || typeof compaction !== "object" || Array.isArray(compaction)) {
        return undefined;
    }

    const enabled = (compaction as Record<string, unknown>).enabled;
    return typeof enabled === "boolean" ? enabled : undefined;
}

function findProjectSettingsPath(startDirectory: string): string | undefined {
    let currentDirectory = startDirectory;

    for (let depth = 0; depth < 20; depth += 1) {
        const candidate = join(currentDirectory, ".pi", "settings.json");
        if (existsSync(candidate)) {
            return candidate;
        }

        const parentDirectory = dirname(currentDirectory);
        if (parentDirectory === currentDirectory) {
            break;
        }
        currentDirectory = parentDirectory;
    }

    return undefined;
}

function isAutoCompactionEnabled(cwd: string): boolean {
    const globalSettingsPath = join(homedir(), ".pi", "agent", "settings.json");
    const globalEnabled = getCompactionEnabledFromSettings(readJsonFile(globalSettingsPath));
    const projectSettingsPath = findProjectSettingsPath(cwd);
    const projectEnabled = projectSettingsPath
        ? getCompactionEnabledFromSettings(readJsonFile(projectSettingsPath))
        : undefined;

    return projectEnabled ?? globalEnabled ?? true;
}

function resolveEffectiveCompactionPolicy(
    modelId: string,
    cwd: string,
    configPath: string,
    resolveAutoCompactionEnabled: (cwd: string) => boolean,
): EffectiveCompactionPolicy {
    const config = loadCompactionConfig(configPath);
    if (!config) {
        return { status: "unavailable", reason: "missing-policy" };
    }

    const thresholdPercent = getThresholdPercent(config, modelId);
    if (!resolveAutoCompactionEnabled(cwd)) {
        return { status: "unavailable", reason: "auto-compaction-disabled", thresholdPercent };
    }

    return { status: "available", thresholdPercent };
}

function isUsableAssistantMessage(value: unknown): value is AssistantMessageWithUsage {
    if (!value || typeof value !== "object") {
        return false;
    }

    const message = value as Record<string, unknown>;
    if (message.role !== "assistant" || message.stopReason === "error" || message.stopReason === "aborted") {
        return false;
    }

    return Boolean(message.usage && typeof message.usage === "object" && !Array.isArray(message.usage));
}

function findCurrentAssistantMessage(messages: unknown[]): AssistantMessageWithUsage | undefined {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message && typeof message === "object" && (message as Record<string, unknown>).role === "assistant") {
            return isUsableAssistantMessage(message) ? message : undefined;
        }
    }

    return undefined;
}

export function registerModelAwareCompaction(
    pi: ExtensionAPI,
    dependencies: ModelAwareCompactionDependencies = {},
): void {
    const configPath = dependencies.configPath ?? DEFAULT_CONFIG_PATH;
    const resolveAutoCompactionEnabled = dependencies.isAutoCompactionEnabled ?? isAutoCompactionEnabled;
    let lastCompactionMs = 0;
    let lastNudgeMs = 0;
    let lastAssistantMessageRef: AssistantMessageWithUsage | undefined;

    const resetPendingNudge = () => {
        lastAssistantMessageRef = undefined;
        lastNudgeMs = 0;
    };

    pi.on("session_start", (_event, ctx) => {
        resetPendingNudge();
        lastCompactionMs = getLastBranchCompactionMs(ctx) ?? 0;
    });

    pi.on("session_tree", (_event, ctx) => {
        resetPendingNudge();
        const branchCompactionMs = getLastBranchCompactionMs(ctx);
        if (branchCompactionMs !== undefined) {
            lastCompactionMs = Math.max(lastCompactionMs, branchCompactionMs);
        }
    });

    pi.on("session_before_compact", () => {
        resetPendingNudge();
    });

    pi.on("session_compact", () => {
        lastCompactionMs = Date.now();
        resetPendingNudge();
    });

    pi.on("session_shutdown", () => {
        lastCompactionMs = 0;
        resetPendingNudge();
    });

    pi.on("message_end", (event) => {
        const message = (event as { message?: unknown }).message;
        if (!message || typeof message !== "object" || (message as Record<string, unknown>).role !== "assistant") {
            return;
        }

        lastAssistantMessageRef = isUsableAssistantMessage(message) ? message : undefined;
    });

    pi.on("agent_end", (event, ctx) => {
        const agentEndEvent = event as { messages?: unknown[]; willRetry?: boolean };
        const currentAssistantMessage = lastAssistantMessageRef;
        lastAssistantMessageRef = undefined;
        if (agentEndEvent.willRetry) {
            return;
        }

        if (!ctx.model) {
            return;
        }

        const policy = resolveEffectiveCompactionPolicy(
            ctx.model.id,
            ctx.cwd,
            configPath,
            resolveAutoCompactionEnabled,
        );
        if (policy.status === "unavailable" && policy.reason === "missing-policy") {
            return;
        }

        const branchCompactionMs = getLastBranchCompactionMs(ctx);
        if (branchCompactionMs !== undefined) {
            lastCompactionMs = Math.max(lastCompactionMs, branchCompactionMs);
        }

        const now = Date.now();
        if (now - lastCompactionMs < COMPACTION_COOLDOWN_MS) {
            return;
        }

        const contextWindow = ctx.model.contextWindow || DEFAULT_CONTEXT_WINDOW;
        const thresholdPercent = policy.thresholdPercent;
        const thresholdTokens = Math.floor((thresholdPercent / 100) * contextWindow);
        const usedTokens = ctx.getContextUsage()?.tokens ?? estimateLeafTokens(ctx);
        if (usedTokens < thresholdTokens) {
            return;
        }

        if (policy.status === "unavailable") {
            if (ctx.hasUI) {
                ctx.ui.notify(
                    "Auto-compact is disabled. Enable it in /settings so model-aware-compaction can trigger " +
                        "Pi's built-in auto-compaction",
                    "warning",
                );
            }
            return;
        }

        const lastAssistant = currentAssistantMessage ?? findCurrentAssistantMessage(agentEndEvent.messages ?? []);
        if (!lastAssistant || now - lastNudgeMs < NUDGE_COOLDOWN_MS) {
            return;
        }
        lastNudgeMs = now;

        if (ctx.hasUI) {
            ctx.ui.notify(
                `Auto-compacting via model-aware threshold: ${ctx.model.id} (>= ${thresholdPercent}% used)`,
                "info",
            );
        }

        lastAssistant.usage.totalTokens = Math.max(lastAssistant.usage.totalTokens ?? 0, contextWindow + 1);
    });
}

export default function modelAwareCompaction(pi: ExtensionAPI): void {
    registerModelAwareCompaction(pi);
}
