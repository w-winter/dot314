import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { hashPortableValue } from "./portable-record.ts";

const NATIVE_COMPACTION_STRATEGY = "openai-responses-compaction-v2";
const NATIVE_COMPACTION_SUMMARY = "[OpenAI native compaction checkpoint]";
const NATIVE_COMPACTION_DISPLAY_TYPE = "codex-native-compaction-display";

// hashPortableValue inserts the NUL separator, so the persisted V1 domain string excludes it
const CHECKPOINT_FINGERPRINT_DOMAIN = "pi-codex-compaction:checkpoint:v1";

const DETAIL_KEYS = new Set([
    "strategy",
    "provider",
    "api",
    "model",
    "baseUrl",
    "compactedWindow",
    "compactResponseId",
    "createdAt",
    "requestMeta",
    "usage",
]);
const REQUIRED_DETAIL_KEYS = [
    "strategy",
    "provider",
    "api",
    "model",
    "baseUrl",
    "compactedWindow",
    "createdAt",
] as const;
const REQUEST_META_KEYS = new Set(["tokensBefore", "previousSummaryPresent", "compactedKeptWindow"]);
const USAGE_KEYS = ["inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens"] as const;

type StructuredJsonPrimitive = null | string | number | boolean;
type StructuredJsonValue = StructuredJsonPrimitive | StructuredJsonObject | StructuredJsonValue[];
type StructuredJsonObject = { readonly [key: string]: StructuredJsonValue };

export type ConversionNativeCheckpointDetails = {
    readonly strategy: typeof NATIVE_COMPACTION_STRATEGY;
    readonly provider: string;
    readonly api: string;
    readonly model: string;
    readonly baseUrl: string;
    readonly compactedWindow: readonly StructuredJsonObject[];
    readonly compactResponseId?: string;
    readonly createdAt: string;
    readonly requestMeta?: Readonly<{
        tokensBefore?: number;
        previousSummaryPresent?: boolean;
        compactedKeptWindow?: boolean;
    }>;
    readonly usage?: Readonly<{
        inputTokens: number;
        cachedInputTokens: number;
        cacheWriteInputTokens: number;
        outputTokens: number;
    }>;
};

export type NativeCheckpointDescriptor = {
    readonly entryId: string;
    readonly entryIndex: number;
    readonly storage: "pi-compaction";
    readonly modelKey: string;
    readonly checkpointFingerprint: string;
    readonly tokensBefore: number;
};

export type NativePortabilityBaseline =
    | { readonly kind: "branch-root" }
    | {
        readonly kind: "plaintext-compaction";
        readonly entryId: string;
        readonly entryIndex: number;
        readonly firstKeptEntryId: string;
    };

export type NativeEpoch = {
    readonly status: "available";
    readonly baseline: NativePortabilityBaseline;
    readonly checkpoints: readonly NativeCheckpointDescriptor[];
};

export type NativeEpochErrorReasonCode =
    | "NATIVE_BASELINE_MALFORMED"
    | "NATIVE_CHECKPOINT_MALFORMED"
    | "NATIVE_CHECKPOINT_TOKEN_COUNT_INVALID";

export type NativeEpochError = {
    readonly status: "error";
    readonly reasonCode: NativeEpochErrorReasonCode;
    readonly message: string;
    readonly nativeEntryIndex: number;
    readonly nativeEntryId?: string;
};

export type NativeEpochResult = NativeEpoch | NativeEpochError;

const ERROR_MESSAGES: Readonly<Record<NativeEpochErrorReasonCode, string>> = {
    NATIVE_BASELINE_MALFORMED: "The active plaintext compaction baseline is malformed",
    NATIVE_CHECKPOINT_MALFORMED: "The active native compaction checkpoint is malformed or unsupported",
    NATIVE_CHECKPOINT_TOKEN_COUNT_INVALID: "The active native compaction checkpoint has an invalid token count",
};

class MalformedNativeCheckpointDetailsError extends Error {
    constructor() {
        super(ERROR_MESSAGES.NATIVE_CHECKPOINT_MALFORMED);
        this.name = "MalformedNativeCheckpointDetailsError";
    }
}

function malformedDetails(): never {
    throw new MalformedNativeCheckpointDetailsError();
}

function isRecord(value: unknown): value is Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function hasOnlyEnumerableStringKeys(value: Record<string, unknown>): boolean {
    return Reflect.ownKeys(value).length === Object.keys(value).length;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
    return hasOnlyEnumerableStringKeys(value) && Object.keys(value).every((key) => allowed.has(key));
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
    const keys = Object.keys(value);
    return hasOnlyEnumerableStringKeys(value)
        && keys.length === expected.length
        && expected.every((key) => Object.hasOwn(value, key))
        && keys.every((key) => expected.includes(key));
}

function ownRecord(value: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(value));
}

function parseNonblankString(value: unknown): string {
    if (typeof value !== "string" || value.trim().length === 0) return malformedDetails();
    return value;
}

function parseNonnegativeFiniteNumber(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return malformedDetails();
    return value;
}

function parseDenseArray<T>(value: unknown[], parseItem: (item: unknown) => T): T[] {
    const enumerableKeys = Object.keys(value);
    const ownKeys = Reflect.ownKeys(value);
    if (
        ownKeys.length !== enumerableKeys.length + 1
        || !ownKeys.includes("length")
        || enumerableKeys.length !== value.length
    ) {
        return malformedDetails();
    }
    const enumerableKeySet = new Set(enumerableKeys);
    const parsed: T[] = [];
    for (let index = 0; index < value.length; index += 1) {
        if (!enumerableKeySet.has(String(index))) return malformedDetails();
        parsed.push(parseItem(value[index]));
    }
    return parsed;
}

function parseStructuredValue(value: unknown): StructuredJsonValue {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") {
        if (!Number.isFinite(value)) return malformedDetails();
        return value;
    }
    if (Array.isArray(value)) {
        return parseDenseArray(value, parseStructuredValue);
    }
    if (!isRecord(value)) return malformedDetails();
    if (!hasOnlyEnumerableStringKeys(value)) return malformedDetails();
    return Object.fromEntries(
        Object.entries(value).map(([key, nested]) => [key, parseStructuredValue(nested)]),
    );
}

function parseStructuredObject(value: unknown): StructuredJsonObject {
    if (!isRecord(value)) return malformedDetails();
    return parseStructuredValue(value) as StructuredJsonObject;
}

function parseRequestMeta(value: unknown): ConversionNativeCheckpointDetails["requestMeta"] {
    if (value === undefined) return undefined;
    if (!isRecord(value) || !hasOnlyKeys(value, REQUEST_META_KEYS)) return malformedDetails();
    const ownValue = ownRecord(value);
    return {
        ...(!Object.hasOwn(ownValue, "tokensBefore") || ownValue.tokensBefore === undefined
            ? {}
            : { tokensBefore: parseNonnegativeFiniteNumber(ownValue.tokensBefore) }),
        ...(!Object.hasOwn(ownValue, "previousSummaryPresent") || ownValue.previousSummaryPresent === undefined
            ? {}
            : typeof ownValue.previousSummaryPresent === "boolean"
                ? { previousSummaryPresent: ownValue.previousSummaryPresent }
                : malformedDetails()),
        ...(!Object.hasOwn(ownValue, "compactedKeptWindow") || ownValue.compactedKeptWindow === undefined
            ? {}
            : typeof ownValue.compactedKeptWindow === "boolean"
                ? { compactedKeptWindow: ownValue.compactedKeptWindow }
                : malformedDetails()),
    };
}

function parseUsage(value: unknown): ConversionNativeCheckpointDetails["usage"] {
    if (value === undefined) return undefined;
    if (!isRecord(value) || !hasExactKeys(value, USAGE_KEYS)) return malformedDetails();
    const ownValue = ownRecord(value);
    return {
        inputTokens: parseNonnegativeFiniteNumber(ownValue.inputTokens),
        cachedInputTokens: parseNonnegativeFiniteNumber(ownValue.cachedInputTokens),
        cacheWriteInputTokens: parseNonnegativeFiniteNumber(ownValue.cacheWriteInputTokens),
        outputTokens: parseNonnegativeFiniteNumber(ownValue.outputTokens),
    };
}

export function parseConversionNativeCheckpointDetails(value: unknown): ConversionNativeCheckpointDetails {
    if (
        !isRecord(value)
        || !hasOnlyKeys(value, DETAIL_KEYS)
        || !REQUIRED_DETAIL_KEYS.every((key) => Object.hasOwn(value, key))
    ) {
        return malformedDetails();
    }
    const ownValue = ownRecord(value);
    if (ownValue.strategy !== NATIVE_COMPACTION_STRATEGY || !Array.isArray(ownValue.compactedWindow)) {
        return malformedDetails();
    }
    const compactResponseId = !Object.hasOwn(ownValue, "compactResponseId")
        || ownValue.compactResponseId === undefined
        ? undefined
        : parseNonblankString(ownValue.compactResponseId);
    return {
        strategy: NATIVE_COMPACTION_STRATEGY,
        provider: parseNonblankString(ownValue.provider),
        api: parseNonblankString(ownValue.api),
        model: parseNonblankString(ownValue.model),
        baseUrl: parseNonblankString(ownValue.baseUrl),
        compactedWindow: parseDenseArray(ownValue.compactedWindow, parseStructuredObject),
        ...(compactResponseId === undefined ? {} : { compactResponseId }),
        createdAt: parseNonblankString(ownValue.createdAt),
        ...(!Object.hasOwn(ownValue, "requestMeta") || ownValue.requestMeta === undefined
            ? {}
            : { requestMeta: parseRequestMeta(ownValue.requestMeta) }),
        ...(!Object.hasOwn(ownValue, "usage") || ownValue.usage === undefined
            ? {}
            : { usage: parseUsage(ownValue.usage) }),
    };
}

export function fingerprintConversionNativeCheckpointDetails(value: unknown): string {
    const details = parseConversionNativeCheckpointDetails(value);
    return hashPortableValue(CHECKPOINT_FINGERPRINT_DOMAIN, details);
}

export function isConversionNativeCheckpointCandidate(entry: SessionEntry): boolean {
    if (!Object.hasOwn(entry, "type") || entry.type !== "compaction") return false;
    if (Object.hasOwn(entry, "summary") && entry.summary === NATIVE_COMPACTION_SUMMARY) return true;
    return Object.hasOwn(entry, "details")
        && isRecord(entry.details)
        && Object.hasOwn(entry.details, "strategy")
        && entry.details.strategy === NATIVE_COMPACTION_STRATEGY;
}

export function isConversionNativeCompactionDisplayEntry(entry: SessionEntry): boolean {
    return Object.hasOwn(entry, "type")
        && entry.type === "custom"
        && Object.hasOwn(entry, "customType")
        && entry.customType === NATIVE_COMPACTION_DISPLAY_TYPE;
}

function isSafeNonnegativeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNonblankString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

function ownEntryId(entry: SessionEntry): string | undefined {
    return Object.hasOwn(entry, "id") && isNonblankString(entry.id) ? entry.id : undefined;
}

function epochError(
    reasonCode: NativeEpochErrorReasonCode,
    nativeEntryIndex: number,
    entry: SessionEntry,
): NativeEpochError {
    const nativeEntryId = ownEntryId(entry);
    return {
        status: "error",
        reasonCode,
        message: ERROR_MESSAGES[reasonCode],
        nativeEntryIndex,
        ...(nativeEntryId === undefined ? {} : { nativeEntryId }),
    };
}

export function describeNativeEpoch(branch: readonly SessionEntry[]): NativeEpochResult {
    let baselineEntryIndex = -1;
    for (let index = 0; index < branch.length; index += 1) {
        const entry = branch[index]!;
        if (Object.hasOwn(entry, "type") && entry.type === "compaction"
            && !isConversionNativeCheckpointCandidate(entry)) {
            baselineEntryIndex = index;
        }
    }

    const activeCandidates = branch
        .map((entry, entryIndex) => ({ entry, entryIndex }))
        .filter(({ entry, entryIndex }) =>
            entryIndex > baselineEntryIndex && isConversionNativeCheckpointCandidate(entry));
    if (activeCandidates.length === 0) {
        return { status: "available", baseline: { kind: "branch-root" }, checkpoints: [] };
    }

    let baseline: NativePortabilityBaseline = { kind: "branch-root" };
    if (baselineEntryIndex >= 0) {
        const entry = branch[baselineEntryIndex]!;
        const entryId = ownEntryId(entry);
        if (
            entryId === undefined
            || !Object.hasOwn(entry, "type")
            || entry.type !== "compaction"
            || !Object.hasOwn(entry, "summary")
            || !isNonblankString(entry.summary)
            || !Object.hasOwn(entry, "firstKeptEntryId")
            || !isNonblankString(entry.firstKeptEntryId)
        ) {
            return epochError("NATIVE_BASELINE_MALFORMED", baselineEntryIndex, entry);
        }
        const keptEntryIndex = branch.findIndex((candidate) =>
            Object.hasOwn(candidate, "id") && candidate.id === entry.firstKeptEntryId);
        if (keptEntryIndex < 0 || keptEntryIndex >= baselineEntryIndex) {
            return epochError("NATIVE_BASELINE_MALFORMED", baselineEntryIndex, entry);
        }
        baseline = {
            kind: "plaintext-compaction",
            entryId,
            entryIndex: baselineEntryIndex,
            firstKeptEntryId: entry.firstKeptEntryId,
        };
    }

    const checkpoints: NativeCheckpointDescriptor[] = [];
    for (const { entry, entryIndex } of activeCandidates) {
        if (!Object.hasOwn(entry, "type") || entry.type !== "compaction") continue;
        const entryId = ownEntryId(entry);
        if (entryId === undefined) {
            return epochError("NATIVE_CHECKPOINT_MALFORMED", entryIndex, entry);
        }
        let details: ConversionNativeCheckpointDetails;
        if (!Object.hasOwn(entry, "details")) {
            return epochError("NATIVE_CHECKPOINT_MALFORMED", entryIndex, entry);
        }
        try {
            details = parseConversionNativeCheckpointDetails(entry.details);
        } catch {
            return epochError("NATIVE_CHECKPOINT_MALFORMED", entryIndex, entry);
        }
        if (!Object.hasOwn(entry, "tokensBefore") || !isSafeNonnegativeInteger(entry.tokensBefore)) {
            return epochError("NATIVE_CHECKPOINT_TOKEN_COUNT_INVALID", entryIndex, entry);
        }
        checkpoints.push({
            entryId,
            entryIndex,
            storage: "pi-compaction",
            modelKey: `${details.provider}:${details.api}:${details.model}`,
            checkpointFingerprint: hashPortableValue(CHECKPOINT_FINGERPRINT_DOMAIN, details),
            tokensBefore: entry.tokensBefore,
        });
    }
    return { status: "available", baseline, checkpoints };
}
