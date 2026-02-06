/**
 * Model-Aware Compaction Thresholds
 *
 * Triggers automatic compaction based on model-specific percentage thresholds
 * of context window usage. Configure thresholds in config.json keyed by model ID.
 *
 * Works alongside other extensions that intercept compaction events (like
 * agentic-compaction) since it uses ctx.compact() which fires session_before_compact.
 *
 * For this to work properly, set `"compaction": { "enabled": false }` in your settings.json.
 *
 */

import type { ExtensionAPI, Model } from "@mariozechner/pi-coding-agent";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface CompactionConfig {
    global: number;
    models: Record<string, number>;
}

const DEFAULT_GLOBAL_THRESHOLD = 85;
const DEFAULT_CONTEXT_WINDOW = 128000;

function loadConfig(): CompactionConfig {
    try {
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = dirname(__filename);
        const configPath = join(__dirname, "config.json");
        const configData = readFileSync(configPath, "utf-8");
        const parsed = JSON.parse(configData);

        return {
            global: typeof parsed.global === "number" ? parsed.global : DEFAULT_GLOBAL_THRESHOLD,
            models: typeof parsed.models === "object" && parsed.models !== null
                ? parsed.models
                : {},
        };
    } catch (error) {
        console.error("[model-aware-compaction] Failed to load config:", error);
        return { global: DEFAULT_GLOBAL_THRESHOLD, models: {} };
    }
}

function getThresholdForModel(config: CompactionConfig, modelId: string): number {
    // Check for exact match first
    if (config.models[modelId] !== undefined) {
        return config.models[modelId];
    }

    // Check for wildcard/prefix matches (e.g., "claude-*" matches all Claude models)
    for (const [pattern, threshold] of Object.entries(config.models)) {
        if (pattern.includes("*")) {
            // Escape regex special chars except *, then replace * with .*
            const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
            const regex = new RegExp("^" + escaped.replace(/\*/g, ".*") + "$");
            if (regex.test(modelId)) {
                return threshold;
            }
        }
    }

    // Fall back to global default
    return config.global;
}

function clampPercentage(value: number): number {
    return Math.max(0, Math.min(100, value));
}

export default function (pi: ExtensionAPI) {
    const config = loadConfig();
    let currentModel: Model | undefined;

    // Track current model
    pi.on("model_select", async (event) => {
        currentModel = event.model;

        const threshold = getThresholdForModel(config, event.model.id);
        const windowSize = event.model.contextWindow || DEFAULT_CONTEXT_WINDOW;
        const triggerAt = Math.floor(windowSize * (threshold / 100));

        console.log(
            `[model-aware-compaction] Model: ${event.model.id}, ` +
            `Window: ${windowSize.toLocaleString()}, Threshold: ${threshold}%, ` +
            `Triggers at: ${triggerAt.toLocaleString()} tokens`
        );
    });

    // Check context usage after each turn and trigger compaction if needed
    pi.on("turn_end", async (_event, ctx) => {
        if (!currentModel) {
            return;
        }

        const usage = ctx.getContextUsage();
        if (!usage) {
            return;
        }

        const modelId = currentModel.id;
        const windowSize = currentModel.contextWindow || DEFAULT_CONTEXT_WINDOW;
        const thresholdPercent = clampPercentage(getThresholdForModel(config, modelId));
        const thresholdTokens = Math.floor(windowSize * (thresholdPercent / 100));

        if (usage.tokens > thresholdTokens) {
            const remaining = windowSize - usage.tokens;
            const remainingPercent = Math.floor((remaining / windowSize) * 100);

            if (ctx.hasUI) {
                ctx.ui.notify(
                    `Model-aware compaction: ${modelId} at ${usage.tokens.toLocaleString()} tokens ` +
                    `(${remainingPercent}% remaining), threshold ${thresholdPercent}%`,
                    "info"
                );
            }

            console.log(
                `[model-aware-compaction] Triggering compaction for ${modelId}: ` +
                `${usage.tokens.toLocaleString()} > ${thresholdTokens.toLocaleString()} ` +
                `(${thresholdPercent}% of ${windowSize.toLocaleString()})`
            );

            // Trigger compaction - this fires session_before_compact event
            // so other extensions (like agentic-compaction) can intercept and customize
            ctx.compact({
                onComplete: (result) => {
                    console.log(
                        `[model-aware-compaction] Compaction completed for ${modelId}, ` +
                        `summarized ${result?.summarizedCount ?? "unknown"} messages`
                    );
                    if (ctx.hasUI) {
                        ctx.ui.notify("Model-aware compaction completed", "success");
                    }
                },
                onError: (error) => {
                    console.error(
                        `[model-aware-compaction] Compaction failed for ${modelId}:`,
                        error.message
                    );
                    if (ctx.hasUI) {
                        ctx.ui.notify(`Compaction failed: ${error.message}`, "error");
                    }
                },
            });
        }
    });
}
