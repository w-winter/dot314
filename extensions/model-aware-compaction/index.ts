/**
 * Model-Aware Compaction
 *
 * Adds per-model context-usage thresholds to Pi's built-in auto-compaction.
 * Thresholds are percent-used (0–100), configured in config.json.
 *
 * Design constraint: extensions cannot access InteractiveMode's compaction queue
 * (the "Queued message for after compaction" mechanism). Calling ctx.compact()
 * directly skips the compaction-summary UI and won't auto-send queued messages.
 *
 * Approach: at agent_end, if a model-specific threshold is exceeded, inflate
 * lastAssistant.usage.totalTokens past the context window. Pi's _checkCompaction()
 * then fires its normal pipeline — loader → compact → summary → queued-message
 * flush — preserving the full native UX. The inflated value is ephemeral;
 * compaction rebuilds messages from the session file.
 *
 * Session event handlers (session_start, session_switch, session_tree,
 * session_before_compact, session_compact) reset internal state — cooldown
 * timers, cached message references — to stay consistent across navigations.
 *
 * Requires compaction.enabled: true in settings.json. See README.md for
 * threshold tuning and reserveTokens guidance.
 */

import {
    buildSessionContext,
    estimateTokens,
    type ExtensionAPI,
    type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface CompactionConfig {
    global: number;
    models: Record<string, number>;
}

const DEFAULT_THRESHOLD_PERCENT = 85;
const DEFAULT_CONTEXT_WINDOW = 128000;

// Prevent thrashing
const COMPACTION_COOLDOWN_MS = 15000;

function normalizePercent(value: unknown, fallback: number): number {
    if (typeof value !== "number" || Number.isNaN(value)) {
        return fallback;
    }

    return Math.max(0, Math.min(100, Math.floor(value)));
}

function loadConfig(): CompactionConfig {
    try {
        const extensionDirectory = dirname(fileURLToPath(import.meta.url));
        const configPath = join(extensionDirectory, "config.json");
        const configData = readFileSync(configPath, "utf-8");
        const parsedConfig = JSON.parse(configData);

        return {
            global: normalizePercent(parsedConfig.global, DEFAULT_THRESHOLD_PERCENT),
            models:
                typeof parsedConfig.models === "object" && parsedConfig.models !== null
                    ? (parsedConfig.models as Record<string, number>)
                    : {},
        };
    } catch {
        return { global: DEFAULT_THRESHOLD_PERCENT, models: {} };
    }
}

function getThresholdPercent(config: CompactionConfig, modelId: string): number {
    if (config.models[modelId] !== undefined) {
        return normalizePercent(config.models[modelId], config.global);
    }

    for (const [pattern, threshold] of Object.entries(config.models)) {
        if (!pattern.includes("*")) {
            continue;
        }

        const escapedPattern = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
        const regex = new RegExp("^" + escapedPattern.replace(/\*/g, ".*") + "$");

        if (regex.test(modelId)) {
            return normalizePercent(threshold, config.global);
        }
    }

    return config.global;
}

function estimateSystemPromptTokens(ctx: ExtensionContext): number {
    const promptText = ctx.getSystemPrompt();
    return Math.ceil(promptText.length / 4);  // ~4 chars/token rough heuristic
}

function estimateLeafTokens(ctx: ExtensionContext): number {
    const sessionContext = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
    const messagesTokens = sessionContext.messages.reduce((sum, msg) => sum + estimateTokens(msg), 0);

    // System prompt (AGENTS.md, tool descriptions, etc.) isn't in SessionContext.messages
    return messagesTokens + estimateSystemPromptTokens(ctx);
}

function getLastBranchCompactionMs(ctx: ExtensionContext): number | undefined {
    const branchEntries = ctx.sessionManager.getBranch();

    for (let i = branchEntries.length - 1; i >= 0; i -= 1) {
        const entry = branchEntries[i];
        if (entry.type !== "compaction") {
            continue;
        }

        // SessionEntry.timestamp is an ISO string
        const ms = Date.parse(entry.timestamp);
        return Number.isNaN(ms) ? undefined : ms;
    }

    return undefined;
}

function readJsonFile(filePath: string): unknown | undefined {
    try {
        if (!existsSync(filePath)) {
            return undefined;
        }

        const text = readFileSync(filePath, "utf-8");
        return JSON.parse(text) as unknown;
    } catch {
        return undefined;
    }
}

function getCompactionEnabledFromSettings(settings: unknown): boolean | undefined {
    if (!settings || typeof settings !== "object") {
        return undefined;
    }

    const maybe = (settings as any)?.compaction?.enabled;
    return typeof maybe === "boolean" ? maybe : undefined;
}

function findProjectSettingsPath(startDir: string): string | undefined {
    // Best-effort: walk up to root, looking for .pi/settings.json
    let current = startDir;

    for (let i = 0; i < 20; i += 1) {
        const candidate = join(current, ".pi", "settings.json");
        if (existsSync(candidate)) {
            return candidate;
        }

        const parent = dirname(current);
        if (parent === current) {
            break;
        }
        current = parent;
    }

    return undefined;
}

function isAutoCompactionEnabled(ctx: ExtensionContext): boolean {
    // Mirrors SettingsManager.getCompactionEnabled default behavior: true if unset
    const globalSettingsPath = join(homedir(), ".pi", "agent", "settings.json");
    const globalEnabled = getCompactionEnabledFromSettings(readJsonFile(globalSettingsPath));

    const projectSettingsPath = findProjectSettingsPath(ctx.cwd);
    const projectEnabled = projectSettingsPath
        ? getCompactionEnabledFromSettings(readJsonFile(projectSettingsPath))
        : undefined;

    return projectEnabled ?? globalEnabled ?? true;
}

/** Fallback when turn_end didn't capture a reference (e.g., extension loaded mid-session) */
function findLastNonErrorAssistantMessage(messages: unknown[]): any | undefined {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const msg = messages[i] as any;
        if (!msg || msg.role !== "assistant") {
            continue;
        }

        if (msg.stopReason === "error" || msg.stopReason === "aborted") {
            continue;
        }

        if (!msg.usage) {
            continue;
        }

        return msg;
    }

    return undefined;
}

export default function (pi: ExtensionAPI) {
    const config = loadConfig();

    let lastCompactionMs = 0;
    let lastNudgeMs = 0;

    // Best-effort reference to the last assistant message object used by Pi's internal compaction check
    let lastAssistantMessageRef: any | undefined;

    // -- Session lifecycle -------------------------------------------------------
    // Reset cooldowns and cached message refs on navigation/branching, and track
    // compaction timestamps for debounce.

    pi.on("session_start", async (_event, ctx) => {
        lastAssistantMessageRef = undefined;
        lastCompactionMs = 0;
        lastNudgeMs = 0;

        const branchCompactionMs = getLastBranchCompactionMs(ctx);
        if (branchCompactionMs !== undefined) {
            lastCompactionMs = Math.max(lastCompactionMs, branchCompactionMs);
        }
    });

    pi.on("session_switch", async (_event, ctx) => {
        lastAssistantMessageRef = undefined;
        lastCompactionMs = 0;
        lastNudgeMs = 0;

        const branchCompactionMs = getLastBranchCompactionMs(ctx);
        if (branchCompactionMs !== undefined) {
            lastCompactionMs = Math.max(lastCompactionMs, branchCompactionMs);
        }
    });

    pi.on("session_tree", async (_event, ctx) => {
        lastAssistantMessageRef = undefined;
        lastNudgeMs = 0;

        const branchCompactionMs = getLastBranchCompactionMs(ctx);
        if (branchCompactionMs !== undefined) {
            lastCompactionMs = Math.max(lastCompactionMs, branchCompactionMs);
        }
    });

    pi.on("session_before_compact", async (_event, _ctx) => {
        lastAssistantMessageRef = undefined;
        lastNudgeMs = 0;
    });

    pi.on("session_compact", async (_event, _ctx) => {
        lastCompactionMs = Date.now();
        lastAssistantMessageRef = undefined;
        lastNudgeMs = 0;
    });

    // Capture the last assistant message reference so we can mutate it reliably in agent_end
    pi.on("turn_end", async (event, _ctx) => {
        const msg = (event as any)?.message;
        if (!msg || msg.role !== "assistant") {
            return;
        }

        if (msg.stopReason === "error" || msg.stopReason === "aborted") {
            return;
        }

        if (!msg.usage) {
            return;
        }

        lastAssistantMessageRef = msg;
    });

    // Trigger after an agent run completes (matches Pi built-in auto-compaction timing)
    pi.on("agent_end", async (event, ctx) => {
        const branchCompactionMs = getLastBranchCompactionMs(ctx);
        if (branchCompactionMs !== undefined) {
            lastCompactionMs = Math.max(lastCompactionMs, branchCompactionMs);
        }

        const now = Date.now();
        if (now - lastCompactionMs < COMPACTION_COOLDOWN_MS) {
            return;
        }

        const model = ctx.model;
        if (!model) {
            return;
        }

        const contextWindow = model.contextWindow || DEFAULT_CONTEXT_WINDOW;
        const thresholdPercent = getThresholdPercent(config, model.id);
        const thresholdTokens = Math.floor((thresholdPercent / 100) * contextWindow);

        const usage = ctx.getContextUsage();
        const usedTokens = usage?.tokens ?? estimateLeafTokens(ctx);

        if (usedTokens < thresholdTokens) {
            return;
        }

        if (!isAutoCompactionEnabled(ctx)) {
            if (ctx.hasUI) {
                ctx.ui.notify(
                    "Auto-compact is disabled. " +
                        "Enable it in /settings so model-aware-compaction can trigger Pi's built-in auto-compaction",
                    "warning",
                );
            }
            return;
        }

        // Nudge Pi's built-in auto-compaction check (which runs right after this handler)
        const lastAssistant =
            lastAssistantMessageRef ?? findLastNonErrorAssistantMessage((event as any)?.messages ?? []);
        if (!lastAssistant) {
            return;
        }

        const nudgeNow = Date.now();
        if (nudgeNow - lastNudgeMs < 5000) {
            return;
        }
        lastNudgeMs = nudgeNow;

        if (ctx.hasUI) {
            ctx.ui.notify(
                `Auto-compacting via model-aware threshold: ${model.id} (>= ${thresholdPercent}% used)`,
                "info",
            );
        }

        // Force auto-compaction by bumping totalTokens above Pi's internal shouldCompact threshold
        const forcedTokens = contextWindow + 1;
        lastAssistant.usage.totalTokens = Math.max(lastAssistant.usage.totalTokens ?? 0, forcedTokens);

        // Note: we deliberately don't set a footer/statusline indicator here.
        // If Pi's auto-compaction is enabled, its own UI will show the compaction loader + result.
    });
}
