import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export type EditorEnhancementsConfig = {
    doubleEscapeCommand?: string | null;
    commandRemap?: Record<string, string>;
};

export type EditorEnhancementsRuntimeConfig = {
    doubleEscapeCommand: string | null;
    commandRemap: Record<string, string>;
};

const DEFAULT_CONFIG: EditorEnhancementsRuntimeConfig = {
    doubleEscapeCommand: null,
    commandRemap: {},
};

export function normalizeCommandName(value: unknown): string | null {
    if (typeof value !== "string") return null;

    const trimmed = value.trim();
    if (!trimmed) return null;

    const normalized = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
    return normalized || null;
}

export function normalizeCommandRemap(value: unknown): Record<string, string> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};

    const result: Record<string, string> = {};
    for (const [from, to] of Object.entries(value as Record<string, unknown>)) {
        const normalizedFrom = normalizeCommandName(from);
        const normalizedTo = normalizeCommandName(to);
        if (normalizedFrom && normalizedTo) {
            result[normalizedFrom] = normalizedTo;
        }
    }
    return result;
}

export function loadConfig(): EditorEnhancementsRuntimeConfig {
    const extensionDir = path.dirname(fileURLToPath(import.meta.url));
    const configPath = path.join(extensionDir, "config.json");

    if (!fs.existsSync(configPath)) {
        return DEFAULT_CONFIG;
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as EditorEnhancementsConfig;
        return {
            doubleEscapeCommand: normalizeCommandName(parsed.doubleEscapeCommand),
            commandRemap: normalizeCommandRemap(parsed.commandRemap),
        };
    } catch {
        return DEFAULT_CONFIG;
    }
}
