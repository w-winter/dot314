import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

const FilesTouchedModeSchema = Type.Union([Type.Literal("off"), Type.Literal("writer"), Type.Literal("writerAndReader")]);

/** Who sees the files-touched manifest: nobody, the summary writer only, or the writer and the reader of the saved summary */
export type FilesTouchedMode = Static<typeof FilesTouchedModeSchema>;

export interface IncludeFilesTouchedSettings {
    inCompactionSummary: FilesTouchedMode;
    inBranchSummary: FilesTouchedMode;
}

const JsonObjectSchema = Type.Record(Type.String(), Type.Unknown());
type JsonObject = Static<typeof JsonObjectSchema>;
const PositiveIntegerSchema = Type.Integer({ minimum: 1 });
const PositiveSafeIntegerSchema = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });

export type ReasoningLevel = Exclude<ThinkingLevel, "off">;

export type PresetConfig = {
    model: string;
    thinkingLevel?: ThinkingLevel;
};

export interface GroundedCompactionConfig {
    includeFilesTouched: IncludeFilesTouchedSettings;
    defaultPreset: string;
    largeContextPreset?: string;
    toolResultChars: number | null;
    verbatimUserMessageTokens: number | null;
    verbatimUserMessageFlagChars: number;
    presets: Record<string, PresetConfig>;
}

export interface ParsedCompactInstructions {
    usesPresetDirective: boolean;
    presetQuery?: string;
    focusText?: string;
}

export interface ResolvedSummarizer {
    model: Model<Api>;
    apiKey?: string;
    headers?: ProviderHeaders;
    reasoningLevel?: ThinkingLevel;
}

export interface PresetMatchResult {
    kind: "matched" | "ambiguous" | "unmatched";
    name?: string;
    preset?: PresetConfig;
}

/** The model and registry access a summarizer needs, narrowed from Pi's extension context. */
export type SummarizerContext = {
    model?: Model<Api>;
    modelRegistry: {
        getAll(): Model<Api>[];
        streamSimple: ExtensionContext["modelRegistry"]["streamSimple"];
        getApiKeyAndHeaders(model: Model<Api>): Promise<
            | { ok: true; apiKey?: string; headers?: ProviderHeaders }
            | { ok: false; error: string }
        >;
    };
};

export const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));

const CONFIG_PATH = path.join(EXTENSION_DIR, "config.json");

export const CURRENT_PRESET_SENTINEL = "current";

const DEFAULT_INCLUDE_FILES_TOUCHED_SETTINGS: IncludeFilesTouchedSettings = {
    inCompactionSummary: "writer",
    inBranchSummary: "writer",
};

const FILES_TOUCHED_MODES_TEXT = '"off", "writer", or "writerAndReader"';

export const DEFAULT_CONFIG: GroundedCompactionConfig = {
    includeFilesTouched: DEFAULT_INCLUDE_FILES_TOUCHED_SETTINGS,
    defaultPreset: CURRENT_PRESET_SENTINEL,
    toolResultChars: null,
    verbatimUserMessageTokens: null,
    verbatimUserMessageFlagChars: 8000,
    presets: {},
};

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This normalizer parses an untrusted configuration field.
function normalizeThinkingLevel(value: unknown): ThinkingLevel | undefined {
    if (!Check(Type.String(), value)) {
        return undefined;
    }

    const normalized = value.trim().toLowerCase();
    if (
        normalized === "off"
        || normalized === "minimal"
        || normalized === "low"
        || normalized === "medium"
        || normalized === "high"
        || normalized === "xhigh"
    ) {
        return normalized;
    }

    return undefined;
}

export function normalizeOptionalText(value?: string): string | undefined {
    const trimmed = value?.trim();
    return trimmed || undefined;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This parser owns validation of the external audience setting.
function parseIncludeFilesTouchedSettings(value: unknown): IncludeFilesTouchedSettings {
    if (value === undefined) {
        return structuredClone(DEFAULT_INCLUDE_FILES_TOUCHED_SETTINGS);
    }

    if (Check(FilesTouchedModeSchema, value)) {
        return {
            inCompactionSummary: value,
            inBranchSummary: value,
        };
    }

    if (!Check(JsonObjectSchema, value)) {
        throw new Error(
            `Invalid grounded-compaction config: includeFilesTouched must be ${FILES_TOUCHED_MODES_TEXT}, or an object with inCompactionSummary and inBranchSummary`,
        );
    }

    const { inCompactionSummary, inBranchSummary } = value;
    if (!Check(FilesTouchedModeSchema, inCompactionSummary)) {
        throw new Error(`Invalid grounded-compaction config: includeFilesTouched.inCompactionSummary must be ${FILES_TOUCHED_MODES_TEXT}`);
    }
    if (!Check(FilesTouchedModeSchema, inBranchSummary)) {
        throw new Error(`Invalid grounded-compaction config: includeFilesTouched.inBranchSummary must be ${FILES_TOUCHED_MODES_TEXT}`);
    }

    return { inCompactionSummary, inBranchSummary };
}

function parsePresets(value: JsonObject): GroundedCompactionConfig["presets"] {
    const presetsValue = value.presets === undefined ? {} : value.presets;
    if (!Check(JsonObjectSchema, presetsValue)) {
        throw new Error("Invalid grounded-compaction config: presets must be an object");
    }
    const presets: Record<string, PresetConfig> = {};
    for (const [presetName, presetValue] of Object.entries(presetsValue)) {
        if (!presetName.trim()) {
            throw new Error("Invalid grounded-compaction config: preset names must be non-empty strings");
        }
        if (!Check(JsonObjectSchema, presetValue)) {
            throw new Error(`Invalid grounded-compaction config: preset '${presetName}' must be an object`);
        }
        if (!Check(Type.String(), presetValue.model) || !presetValue.model.trim()) {
            throw new Error(`Invalid grounded-compaction config: preset '${presetName}' must define model`);
        }
        const thinkingLevel = presetValue.thinkingLevel === undefined ? undefined : normalizeThinkingLevel(presetValue.thinkingLevel);
        if (presetValue.thinkingLevel !== undefined && !thinkingLevel) {
            throw new Error(`Invalid grounded-compaction config: preset '${presetName}' has an invalid thinkingLevel`);
        }
        presets[presetName] = { model: presetValue.model.trim(), thinkingLevel };
    }
    return presets;
}

function parseRetentionSettings(value: JsonObject): Pick<GroundedCompactionConfig, "verbatimUserMessageTokens" | "verbatimUserMessageFlagChars"> {
    const verbatimUserMessageTokens = value.verbatimUserMessageTokens === undefined
        ? DEFAULT_CONFIG.verbatimUserMessageTokens : value.verbatimUserMessageTokens;
    if (verbatimUserMessageTokens !== null && !Check(PositiveSafeIntegerSchema, verbatimUserMessageTokens)) {
        throw new Error("Invalid grounded-compaction config: verbatimUserMessageTokens must be null or a positive safe integer");
    }
    const verbatimUserMessageFlagChars = value.verbatimUserMessageFlagChars === undefined
        ? DEFAULT_CONFIG.verbatimUserMessageFlagChars : value.verbatimUserMessageFlagChars;
    if (!Check(PositiveSafeIntegerSchema, verbatimUserMessageFlagChars)) {
        throw new Error("Invalid grounded-compaction config: verbatimUserMessageFlagChars must be a positive safe integer");
    }
    return { verbatimUserMessageTokens, verbatimUserMessageFlagChars };
}

function parsePresetName(value: JsonObject, key: "defaultPreset" | "largeContextPreset"): string | undefined {
    const name = value[key];
    if (name === undefined) return undefined;
    if (!Check(Type.String(), name) || !name.trim()) {
        throw new Error(`Invalid grounded-compaction config: ${key} must be a non-empty string`);
    }
    return name.trim();
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Public parser boundary: JSON input is checked here before constructing the internal config.
export function parseConfig(value: unknown): GroundedCompactionConfig {
    if (!Check(JsonObjectSchema, value)) {
        throw new Error("Invalid grounded-compaction config: top-level value must be an object");
    }
    const { verbatimUserMessageTokens, verbatimUserMessageFlagChars } = parseRetentionSettings(value);
    const includeFilesTouched = parseIncludeFilesTouchedSettings(value.includeFilesTouched);
    const toolResultChars =
        value.toolResultChars === undefined || value.toolResultChars === null
            ? null
            : Check(PositiveIntegerSchema, value.toolResultChars)
                ? value.toolResultChars
                : (() => {
                    throw new Error(
                        "Invalid grounded-compaction config: toolResultChars must be null or a positive integer",
                    );
                })();

    const defaultPreset = parsePresetName(value, "defaultPreset") ?? DEFAULT_CONFIG.defaultPreset;
    const largeContextPreset = parsePresetName(value, "largeContextPreset");

    const presets = parsePresets(value);

    if (defaultPreset !== CURRENT_PRESET_SENTINEL && !Object.hasOwn(presets, defaultPreset)) {
        throw new Error(
            `Invalid grounded-compaction config: defaultPreset '${defaultPreset}' was not found in presets`,
        );
    }

    if (largeContextPreset && !Object.hasOwn(presets, largeContextPreset)) {
        throw new Error(
            `Invalid grounded-compaction config: largeContextPreset '${largeContextPreset}' was not found in presets`,
        );
    }
    if (largeContextPreset === defaultPreset) {
        throw new Error("Invalid grounded-compaction config: largeContextPreset must differ from defaultPreset");
    }

    const config: GroundedCompactionConfig = {
        includeFilesTouched,
        defaultPreset,
        toolResultChars,
        verbatimUserMessageTokens,
        verbatimUserMessageFlagChars,
        presets,
    };
    if (largeContextPreset) config.largeContextPreset = largeContextPreset;
    return config;
}

export async function loadConfig(extensionDir = EXTENSION_DIR): Promise<GroundedCompactionConfig> {
    const configPath = path.join(extensionDir, path.basename(CONFIG_PATH));

    try {
        const raw = await readFile(configPath, "utf8");
        return parseConfig(JSON.parse(raw));
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return structuredClone(DEFAULT_CONFIG);
        }

        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to load grounded-compaction config from ${configPath}: ${message}`);
    }
}

export function parseCompactInstructions(text?: string): ParsedCompactInstructions {
    const trimmed = text?.trim() ?? "";
    if (!trimmed) {
        return { usesPresetDirective: false };
    }

    if (!trimmed.startsWith("--preset") && !trimmed.startsWith("-p")) {
        return {
            usesPresetDirective: false,
            focusText: trimmed,
        };
    }

    const match = trimmed.match(/^(?:--preset|-p)(?:\s+(\S+)(?:\s+([\s\S]*\S))?)?\s*$/);
    if (!match) {
        return { usesPresetDirective: true };
    }

    const presetQuery = match.at(1)?.trim();
    const focusText = match.at(2)?.trim();
    if (!presetQuery) {
        return { usesPresetDirective: true };
    }

    return {
        usesPresetDirective: true,
        presetQuery,
        focusText: focusText || undefined,
    };
}

function normalizePresetKey(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function resolvePresetMatch(
    presets: Record<string, PresetConfig>,
    query: string,
): PresetMatchResult {
    const presetNames = Object.keys(presets);
    if (!query.trim()) {
        return { kind: "unmatched" };
    }

    const exactCaseSensitive = presetNames.filter((name) => name === query);
    if (exactCaseSensitive.length === 1) {
        return {
            kind: "matched",
            name: exactCaseSensitive[0],
            preset: presets[exactCaseSensitive[0]],
        };
    }

    let sawAmbiguity = exactCaseSensitive.length > 1;
    const lowerQuery = query.toLowerCase();

    const exactCaseInsensitive = presetNames.filter((name) => name.toLowerCase() === lowerQuery);
    if (exactCaseInsensitive.length === 1) {
        return {
            kind: "matched",
            name: exactCaseInsensitive[0],
            preset: presets[exactCaseInsensitive[0]],
        };
    }
    sawAmbiguity ||= exactCaseInsensitive.length > 1;

    const prefixMatches = presetNames.filter((name) => name.toLowerCase().startsWith(lowerQuery));
    if (prefixMatches.length === 1) {
        return {
            kind: "matched",
            name: prefixMatches[0],
            preset: presets[prefixMatches[0]],
        };
    }
    sawAmbiguity ||= prefixMatches.length > 1;

    const normalizedQuery = normalizePresetKey(query);
    const substringMatches = normalizedQuery
        ? presetNames.filter((name) => normalizePresetKey(name).includes(normalizedQuery))
        : [];
    if (substringMatches.length === 1) {
        return {
            kind: "matched",
            name: substringMatches[0],
            preset: presets[substringMatches[0]],
        };
    }
    sawAmbiguity ||= substringMatches.length > 1;

    return { kind: sawAmbiguity ? "ambiguous" : "unmatched" };
}

export function getEffectiveThinkingLevel(branchEntries: readonly SessionEntry[]): ThinkingLevel {
    let thinkingLevel: ThinkingLevel = "off";

    for (const entry of branchEntries) {
        if (entry.type !== "thinking_level_change") {
            continue;
        }

        const parsed = normalizeThinkingLevel(entry.thinkingLevel);
        if (parsed) {
            thinkingLevel = parsed;
        }
    }

    return thinkingLevel;
}

export function toReasoningLevel(level?: ThinkingLevel): ReasoningLevel | undefined {
    if (!level || level === "off") {
        return undefined;
    }

    return level;
}

function parseProviderModel(value: string) {
    const separatorIndex = value.indexOf("/");
    if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
        throw new Error(`Invalid preset model '${value}'. Expected provider/modelId`);
    }

    const provider = value.slice(0, separatorIndex).trim();
    const modelId = value.slice(separatorIndex + 1).trim();
    if (!provider || !modelId) {
        throw new Error(`Invalid preset model '${value}'. Expected provider/modelId`);
    }

    return { provider, modelId };
}

export async function resolveDefaultSummarizer(
    ctx: SummarizerContext,
    branchEntries: readonly SessionEntry[],
): Promise<ResolvedSummarizer> {
    if (!ctx.model) {
        throw new Error("No active session model is available for compaction");
    }

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
    if (!auth.ok) {
        throw new Error(auth.error);
    }

    const thinkingLevel = getEffectiveThinkingLevel(branchEntries);
    return {
        model: ctx.model,
        apiKey: auth.apiKey,
        headers: auth.headers,
        reasoningLevel: ctx.model.reasoning ? thinkingLevel : undefined,
    };
}

export async function resolvePresetSummarizer(
    ctx: SummarizerContext,
    config: GroundedCompactionConfig,
    presetQuery: string,
): Promise<ResolvedSummarizer> {
    const presetMatch = resolvePresetMatch(config.presets, presetQuery);
    if (presetMatch.kind === "ambiguous") {
        throw new Error(`Preset '${presetQuery}' is ambiguous`);
    }

    if (presetMatch.kind === "unmatched" || !presetMatch.name || !presetMatch.preset) {
        throw new Error(`Preset '${presetQuery}' was not found`);
    }

    const { provider, modelId } = parseProviderModel(presetMatch.preset.model);
    const model = ctx.modelRegistry.getAll().find((candidate) => {
        return candidate.provider === provider && candidate.id === modelId;
    });
    if (!model) {
        throw new Error(`Preset '${presetMatch.name}' model ${provider}/${modelId} is not registered`);
    }

    const reasoningLevel = toReasoningLevel(presetMatch.preset.thinkingLevel);
    if (reasoningLevel && !model.reasoning) {
        throw new Error(`Preset '${presetMatch.name}' requires reasoning but ${provider}/${modelId} does not support it`);
    }

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
        throw new Error(auth.error);
    }

    return {
        model,
        apiKey: auth.apiKey,
        headers: auth.headers,
        reasoningLevel: presetMatch.preset.thinkingLevel,
    };
}
