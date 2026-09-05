import { createHash } from "node:crypto";

export const PORTABLE_SUMMARY_CUSTOM_TYPE = "codex-compaction-coordinator:portable-summary";

const HASH_DOMAINS = {
    branchRoot: "codex-compaction-coordinator:branch-root:v1",
    plaintextCoverage: "codex-compaction-coordinator:plaintext-coverage:v1",
    entries: "codex-compaction-coordinator:entries:v1",
    transcript: "codex-compaction-coordinator:transcript:v1",
    chunk: "codex-compaction-coordinator:chunk:v1",
    summary: "codex-compaction-coordinator:summary:v1",
    coverage: "codex-compaction-coordinator:coverage:v1",
} as const;

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

type JsonObject = Record<string, unknown>;

export type PortableSummarizerProvenance = {
    provider: string;
    api: string;
    modelId: string;
    thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | null;
    contextWindow: number;
    maxOutputTokens: number;
    promptFingerprint: string;
};

export type PortableSummaryUsage = {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        total: number;
    };
};

export type PortableRecordPredecessor =
    | { kind: "branch-root"; coverageFingerprint: string }
    | {
        kind: "plaintext-compaction";
        entryId: string;
        firstKeptEntryId: string;
        summaryFingerprint: string;
        coverageFingerprint: string;
    }
    | {
        kind: "portable-record";
        recordId: string;
        summaryFingerprint: string;
        coverageFingerprint: string;
    };

export type PortableCheckpointIdentity = {
    entryId: string;
    // V1 records permit inline-custom storage, while newly created records use pi-compaction
    storage: "inline-custom" | "pi-compaction";
    modelKey: string;
    checkpointFingerprint: string;
};

export type PortableRangeIdentity = {
    firstEntryId: string | null;
    lastEntryId: string | null;
    entryCount: number;
    entriesFingerprint: string;
    transcriptLength: number;
    transcriptFingerprint: string;
    // Absent on saved records created with Pi's stock serializer; retain their original proofs.
    toolResultChars?: number | null;
};

export type PortableSummaryRecordV1 = {
    kind: typeof PORTABLE_SUMMARY_CUSTOM_TYPE;
    version: 1;
    recordId: string;
    predecessor: PortableRecordPredecessor;
    checkpoint: PortableCheckpointIdentity;
    range: PortableRangeIdentity;
    state: "partial" | "complete";
    endOffset: number;
    coverageFingerprint: string;
    summary: string | null;
    step:
        | {
            kind: "summary-call";
            startOffset: number;
            chunkFingerprint: string;
            summarizer: PortableSummarizerProvenance;
            usage: PortableSummaryUsage | null;
        }
        | {
            kind: "carry-forward";
            startOffset: 0;
            chunkFingerprint: string;
        };
};

export type PortableBaselineProof =
    | {
        kind: "branch-root";
        summary: null;
        coverageFingerprint: string;
    }
    | {
        kind: "plaintext-compaction";
        entryId: string;
        firstKeptEntryId: string;
        summary: string;
        summaryFingerprint: string;
        coverageFingerprint: string;
    };

export type PortableCheckpointPlan = {
    checkpoint: PortableCheckpointIdentity;
    range: PortableRangeIdentity;
    sourceText: string;
    serializeSource: (toolResultChars: number | null) => string;
};

type PreparedPortableSource = Pick<PortableCheckpointPlan, "range" | "sourceText">;

const preparedSources = new WeakMap<PortableCheckpointPlan, Map<number | null, PreparedPortableSource>>();

/** Memoize the exact transcript and range proof per immutable checkpoint plan and tool-text limit. */
export function preparePortableSource(
    plan: PortableCheckpointPlan,
    toolResultChars: number | null,
): PreparedPortableSource {
    let sources = preparedSources.get(plan);
    if (!sources) {
        sources = new Map();
        preparedSources.set(plan, sources);
    }
    const cached = sources.get(toolResultChars);
    if (cached) return cached;
    const sourceText = plan.serializeSource(toolResultChars);
    const prepared = {
        sourceText,
        range: {
            ...plan.range,
            transcriptLength: sourceText.length,
            transcriptFingerprint: fingerprintPortableTranscript(sourceText),
            toolResultChars,
        },
    };
    sources.set(toolResultChars, prepared);
    return prepared;
}

export type PortableRecordSource = {
    entryId: string;
    data: unknown;
    activePosition: number | null;
    relevantIfMalformed: boolean;
};

export class MalformedPortableRecordError extends Error {
    readonly recordEntryId: string;

    constructor(recordEntryId: string) {
        super("Active portable checkpoint record is malformed");
        this.name = "MalformedPortableRecordError";
        this.recordEntryId = recordEntryId;
    }
}

export type ValidatedPortableRecord = {
    entryId: string;
    activePosition: number | null;
    record: PortableSummaryRecordV1;
};

export type PortableChain = {
    tip: ValidatedPortableRecord | null;
    completedCheckpoints: number;
    partialOffset: number;
    summary: string | null;
    coverageFingerprint: string;
};

function isRecord(value: unknown): value is JsonObject {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: JsonObject, keys: readonly string[]): boolean {
    const actualKeys = Object.keys(value);
    return actualKeys.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isSafeNonnegativeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSafePositiveInteger(value: unknown): value is number {
    return isSafeNonnegativeInteger(value) && value > 0;
}

function isNonnegativeFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonblankString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

function isHash(value: unknown): value is string {
    return typeof value === "string" && HASH_PATTERN.test(value);
}

function canonicalizeJson(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalizeJson);
    if (!isRecord(value)) return value;
    return Object.fromEntries(
        Object.keys(value)
            .sort()
            .map((key) => [key, canonicalizeJson(value[key])]),
    );
}

export function canonicalJson(value: unknown): string {
    return JSON.stringify(canonicalizeJson(value));
}

export function hashPortableValue(domain: string, value: unknown): string {
    return createHash("sha256")
        .update(domain)
        .update("\0")
        .update(typeof value === "string" ? value : canonicalJson(value))
        .digest("hex");
}

export function fingerprintPortableEntries(entries: readonly unknown[]): string {
    return hashPortableValue(HASH_DOMAINS.entries, entries);
}

export function fingerprintPortableTranscript(transcript: string): string {
    return hashPortableValue(HASH_DOMAINS.transcript, transcript);
}

export function fingerprintPortableChunk(chunk: string): string {
    return hashPortableValue(HASH_DOMAINS.chunk, chunk);
}

export function fingerprintPortableSummary(summary: string | null): string {
    return hashPortableValue(HASH_DOMAINS.summary, { summary });
}

export function fingerprintBranchRootCoverage(): string {
    return hashPortableValue(HASH_DOMAINS.branchRoot, { kind: "branch-root" });
}

export function fingerprintPlaintextCoverage(params: {
    entryId: string;
    firstKeptEntryId: string;
    summaryFingerprint: string;
}): string {
    return hashPortableValue(HASH_DOMAINS.plaintextCoverage, params);
}

export function fingerprintPortableCoverage(params: {
    predecessorCoverageFingerprint: string;
    checkpoint: PortableCheckpointIdentity;
    range: PortableRangeIdentity;
    endOffset: number;
}): string {
    return hashPortableValue(HASH_DOMAINS.coverage, params);
}

function parsePredecessor(value: unknown): PortableRecordPredecessor {
    if (!isRecord(value)) throw new Error("Portable record predecessor is invalid");
    if (
        value.kind === "branch-root"
        && hasExactKeys(value, ["kind", "coverageFingerprint"])
        && isHash(value.coverageFingerprint)
    ) {
        return { kind: "branch-root", coverageFingerprint: value.coverageFingerprint };
    }
    if (
        value.kind === "plaintext-compaction"
        && hasExactKeys(value, [
            "kind",
            "entryId",
            "firstKeptEntryId",
            "summaryFingerprint",
            "coverageFingerprint",
        ])
        && isNonblankString(value.entryId)
        && isNonblankString(value.firstKeptEntryId)
        && isHash(value.summaryFingerprint)
        && isHash(value.coverageFingerprint)
    ) {
        return {
            kind: "plaintext-compaction",
            entryId: value.entryId,
            firstKeptEntryId: value.firstKeptEntryId,
            summaryFingerprint: value.summaryFingerprint,
            coverageFingerprint: value.coverageFingerprint,
        };
    }
    if (
        value.kind === "portable-record"
        && hasExactKeys(value, ["kind", "recordId", "summaryFingerprint", "coverageFingerprint"])
        && typeof value.recordId === "string"
        && UUID_V4_PATTERN.test(value.recordId)
        && isHash(value.summaryFingerprint)
        && isHash(value.coverageFingerprint)
    ) {
        return {
            kind: "portable-record",
            recordId: value.recordId,
            summaryFingerprint: value.summaryFingerprint,
            coverageFingerprint: value.coverageFingerprint,
        };
    }
    throw new Error("Portable record predecessor is invalid");
}

function parseCheckpoint(value: unknown): PortableCheckpointIdentity {
    if (
        !isRecord(value)
        || !hasExactKeys(value, ["entryId", "storage", "modelKey", "checkpointFingerprint"])
        || !isNonblankString(value.entryId)
        || (value.storage !== "inline-custom" && value.storage !== "pi-compaction")
        || !isNonblankString(value.modelKey)
        || !isHash(value.checkpointFingerprint)
    ) {
        throw new Error("Portable record checkpoint is invalid");
    }
    return {
        entryId: value.entryId,
        storage: value.storage,
        modelKey: value.modelKey,
        checkpointFingerprint: value.checkpointFingerprint,
    };
}

/** Parse an untrusted tool-text limit; reject values other than null or positive safe integers. */
export function parsePortableToolResultChars(value: unknown): number | null {
    if (value !== null && !isSafePositiveInteger(value)) {
        throw new Error("Portable toolResultChars must be null or a positive integer");
    }
    return value;
}

function parseRange(value: unknown): PortableRangeIdentity {
    if (
        !isRecord(value)
        || !hasExactKeys(value, [
            "firstEntryId",
            "lastEntryId",
            "entryCount",
            "entriesFingerprint",
            "transcriptLength",
            "transcriptFingerprint",
            ...(Object.hasOwn(value, "toolResultChars") ? ["toolResultChars"] : []),
        ])
        || (value.firstEntryId !== null && !isNonblankString(value.firstEntryId))
        || (value.lastEntryId !== null && !isNonblankString(value.lastEntryId))
        || !isSafeNonnegativeInteger(value.entryCount)
        || !isHash(value.entriesFingerprint)
        || !isSafeNonnegativeInteger(value.transcriptLength)
        || !isHash(value.transcriptFingerprint)
        || (value.entryCount === 0
            ? value.firstEntryId !== null || value.lastEntryId !== null
            : value.firstEntryId === null || value.lastEntryId === null)
    ) {
        throw new Error("Portable record range is invalid");
    }
    const range: PortableRangeIdentity = {
        firstEntryId: value.firstEntryId,
        lastEntryId: value.lastEntryId,
        entryCount: value.entryCount,
        entriesFingerprint: value.entriesFingerprint,
        transcriptLength: value.transcriptLength,
        transcriptFingerprint: value.transcriptFingerprint,
    };
    if (Object.hasOwn(value, "toolResultChars")) {
        range.toolResultChars = parsePortableToolResultChars(value.toolResultChars);
    }
    return range;
}

export function parsePortableSummarizerProvenance(value: unknown): PortableSummarizerProvenance {
    if (
        !isRecord(value)
        || !hasExactKeys(value, [
            "provider",
            "api",
            "modelId",
            "thinkingLevel",
            "contextWindow",
            "maxOutputTokens",
            "promptFingerprint",
        ])
        || !isNonblankString(value.provider)
        || !isNonblankString(value.api)
        || !isNonblankString(value.modelId)
        || (value.thinkingLevel !== null
            && (typeof value.thinkingLevel !== "string" || !THINKING_LEVELS.has(value.thinkingLevel)))
        || !isSafePositiveInteger(value.contextWindow)
        || !isSafePositiveInteger(value.maxOutputTokens)
        || !isHash(value.promptFingerprint)
    ) {
        throw new Error("Portable record summarizer provenance is invalid");
    }
    return {
        provider: value.provider,
        api: value.api,
        modelId: value.modelId,
        thinkingLevel: value.thinkingLevel as PortableSummarizerProvenance["thinkingLevel"],
        contextWindow: value.contextWindow,
        maxOutputTokens: value.maxOutputTokens,
        promptFingerprint: value.promptFingerprint,
    };
}

export function parsePortableSummaryUsage(value: unknown): PortableSummaryUsage | null {
    if (value === null) return null;
    if (
        !isRecord(value)
        || !hasExactKeys(value, ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"])
        || !isSafeNonnegativeInteger(value.input)
        || !isSafeNonnegativeInteger(value.output)
        || !isSafeNonnegativeInteger(value.cacheRead)
        || !isSafeNonnegativeInteger(value.cacheWrite)
        || !isSafeNonnegativeInteger(value.totalTokens)
        || !isRecord(value.cost)
        || !hasExactKeys(value.cost, ["input", "output", "cacheRead", "cacheWrite", "total"])
        || !isNonnegativeFiniteNumber(value.cost.input)
        || !isNonnegativeFiniteNumber(value.cost.output)
        || !isNonnegativeFiniteNumber(value.cost.cacheRead)
        || !isNonnegativeFiniteNumber(value.cost.cacheWrite)
        || !isNonnegativeFiniteNumber(value.cost.total)
    ) {
        throw new Error("Portable record usage is invalid");
    }
    return {
        input: value.input,
        output: value.output,
        cacheRead: value.cacheRead,
        cacheWrite: value.cacheWrite,
        totalTokens: value.totalTokens,
        cost: {
            input: value.cost.input,
            output: value.cost.output,
            cacheRead: value.cost.cacheRead,
            cacheWrite: value.cost.cacheWrite,
            total: value.cost.total,
        },
    };
}

function parseStep(value: unknown): PortableSummaryRecordV1["step"] {
    if (!isRecord(value)) throw new Error("Portable record step is invalid");
    if (
        value.kind === "summary-call"
        && hasExactKeys(value, ["kind", "startOffset", "chunkFingerprint", "summarizer", "usage"])
        && isSafeNonnegativeInteger(value.startOffset)
        && isHash(value.chunkFingerprint)
    ) {
        return {
            kind: "summary-call",
            startOffset: value.startOffset,
            chunkFingerprint: value.chunkFingerprint,
            summarizer: parsePortableSummarizerProvenance(value.summarizer),
            usage: parsePortableSummaryUsage(value.usage),
        };
    }
    if (
        value.kind === "carry-forward"
        && hasExactKeys(value, ["kind", "startOffset", "chunkFingerprint"])
        && value.startOffset === 0
        && isHash(value.chunkFingerprint)
    ) {
        return {
            kind: "carry-forward",
            startOffset: 0,
            chunkFingerprint: value.chunkFingerprint,
        };
    }
    throw new Error("Portable record step is invalid");
}

export function parsePortableSummaryRecord(value: unknown): PortableSummaryRecordV1 {
    if (
        !isRecord(value)
        || !hasExactKeys(value, [
            "kind",
            "version",
            "recordId",
            "predecessor",
            "checkpoint",
            "range",
            "state",
            "endOffset",
            "coverageFingerprint",
            "summary",
            "step",
        ])
        || value.kind !== PORTABLE_SUMMARY_CUSTOM_TYPE
        || value.version !== 1
        || typeof value.recordId !== "string"
        || !UUID_V4_PATTERN.test(value.recordId)
        || (value.state !== "partial" && value.state !== "complete")
        || !isSafeNonnegativeInteger(value.endOffset)
        || !isHash(value.coverageFingerprint)
        || (value.summary !== null && !isNonblankString(value.summary))
    ) {
        throw new Error("Portable summary record v1 is invalid");
    }

    const predecessor = parsePredecessor(value.predecessor);
    const checkpoint = parseCheckpoint(value.checkpoint);
    const range = parseRange(value.range);
    const step = parseStep(value.step);
    if (value.endOffset > range.transcriptLength) {
        throw new Error("Portable record offset exceeds its transcript");
    }
    if ((value.state === "complete") !== (value.endOffset === range.transcriptLength)) {
        throw new Error("Portable record state does not match its end offset");
    }
    if (step.kind === "summary-call") {
        if (
            step.startOffset >= value.endOffset
            || value.summary === null
            || fingerprintPortableChunk("") === step.chunkFingerprint
        ) {
            throw new Error("Portable summary-call step does not advance");
        }
    } else if (
        range.transcriptLength !== 0
        || value.endOffset !== 0
        || value.state !== "complete"
        || step.chunkFingerprint !== fingerprintPortableChunk("")
    ) {
        throw new Error("Portable carry-forward step is invalid");
    }

    return {
        kind: PORTABLE_SUMMARY_CUSTOM_TYPE,
        version: 1,
        recordId: value.recordId,
        predecessor,
        checkpoint,
        range,
        state: value.state,
        endOffset: value.endOffset,
        coverageFingerprint: value.coverageFingerprint,
        summary: value.summary,
        step,
    };
}

function predecessorMatchesBaseline(
    predecessor: PortableRecordPredecessor,
    baseline: PortableBaselineProof,
): boolean {
    if (baseline.kind === "branch-root") {
        return predecessor.kind === "branch-root"
            && predecessor.coverageFingerprint === baseline.coverageFingerprint;
    }
    return predecessor.kind === "plaintext-compaction"
        && predecessor.entryId === baseline.entryId
        && predecessor.firstKeptEntryId === baseline.firstKeptEntryId
        && predecessor.summaryFingerprint === baseline.summaryFingerprint
        && predecessor.coverageFingerprint === baseline.coverageFingerprint;
}

function rangeMatches(left: PortableRangeIdentity, right: PortableRangeIdentity): boolean {
    return canonicalJson(left) === canonicalJson(right);
}

function chainRank(chain: PortableChain): readonly [number, number, number, number, string] {
    const tip = chain.tip;
    return [
        chain.completedCheckpoints,
        chain.partialOffset,
        tip?.activePosition === null || tip === null ? 0 : 1,
        tip?.activePosition ?? -1,
        tip?.record.recordId ?? "",
    ];
}

function isBetterChain(candidate: PortableChain, current: PortableChain): boolean {
    const candidateRank = chainRank(candidate);
    const currentRank = chainRank(current);
    for (let index = 0; index < 4; index++) {
        if (candidateRank[index] !== currentRank[index]) {
            return (candidateRank[index] as number) > (currentRank[index] as number);
        }
    }
    return (candidateRank[4] as string).localeCompare(currentRank[4] as string) < 0;
}

export function selectBestPortableChain(params: {
    sources: readonly PortableRecordSource[];
    baseline: PortableBaselineProof;
    checkpoints: readonly PortableCheckpointPlan[];
    /** When opening a summarizer, resume only partial work whose source text still matches. */
    resumeToolResultChars?: number | null;
}): PortableChain {
    const checkpointIndices = new Map(
        params.checkpoints.map((checkpoint, index) => [canonicalJson(checkpoint.checkpoint), index]),
    );
    const checkpointIndexFor = (record: PortableSummaryRecordV1): number =>
        checkpointIndices.get(canonicalJson(record.checkpoint)) ?? -1;
    const parsed: ValidatedPortableRecord[] = [];
    for (const source of params.sources) {
        try {
            parsed.push({
                entryId: source.entryId,
                activePosition: source.activePosition,
                record: parsePortableSummaryRecord(source.data),
            });
        } catch {
            if (source.relevantIfMalformed) throw new MalformedPortableRecordError(source.entryId);
        }
    }

    const byRecordId = new Map<string, ValidatedPortableRecord[]>();
    for (const source of parsed) {
        const existing = byRecordId.get(source.record.recordId);
        if (existing) existing.push(source);
        else byRecordId.set(source.record.recordId, [source]);
    }

    const validationMemo = new Map<ValidatedPortableRecord, PortableChain | Error>();
    const validating = new Set<ValidatedPortableRecord>();
    const validate = (source: ValidatedPortableRecord): PortableChain => {
        const memoized = validationMemo.get(source);
        if (memoized instanceof Error) throw memoized;
        if (memoized) return memoized;
        if (validating.has(source)) throw new Error(`Portable record ${source.record.recordId} forms a cycle`);
        validating.add(source);
        try {
            const record = source.record;
            if ((byRecordId.get(record.recordId) ?? []).length !== 1) {
                throw new Error(`Portable record ${record.recordId} is duplicated`);
            }
            const checkpointIndex = checkpointIndexFor(record);
            if (checkpointIndex < 0) throw new Error(`Portable record ${record.recordId} has a stale checkpoint`);
            const checkpointPlan = params.checkpoints[checkpointIndex]!;
            const expectedPlan = record.range.toolResultChars === undefined
                ? checkpointPlan
                : preparePortableSource(checkpointPlan, record.range.toolResultChars);
            if (!rangeMatches(record.range, expectedPlan.range)) {
                throw new Error(`Portable record ${record.recordId} has mismatched range proof`);
            }

            let predecessorChain: PortableChain;
            let expectedStartOffset: number;
            if (record.predecessor.kind === "portable-record") {
                const matches = byRecordId.get(record.predecessor.recordId) ?? [];
                if (matches.length !== 1) {
                    throw new Error(`Portable record ${record.recordId} has an ambiguous predecessor`);
                }
                predecessorChain = validate(matches[0]!);
                const predecessorTip = predecessorChain.tip!;
                if (
                    record.predecessor.summaryFingerprint
                        !== fingerprintPortableSummary(predecessorTip.record.summary)
                    || record.predecessor.coverageFingerprint !== predecessorTip.record.coverageFingerprint
                ) {
                    throw new Error(`Portable record ${record.recordId} has mismatched predecessor proof`);
                }
                const predecessorCheckpointIndex = checkpointIndexFor(predecessorTip.record);
                if (predecessorCheckpointIndex === checkpointIndex) {
                    if (predecessorTip.record.state === "complete") {
                        throw new Error(`Portable record ${record.recordId} continues a complete checkpoint`);
                    }
                    if (predecessorTip.record.range.transcriptFingerprint !== record.range.transcriptFingerprint) {
                        throw new Error(`Portable record ${record.recordId} has mismatched predecessor transcript`);
                    }
                    expectedStartOffset = predecessorTip.record.endOffset;
                } else if (predecessorCheckpointIndex === checkpointIndex - 1) {
                    if (predecessorTip.record.state !== "complete") {
                        throw new Error(`Portable record ${record.recordId} skips an incomplete checkpoint`);
                    }
                    expectedStartOffset = 0;
                } else {
                    throw new Error(`Portable record ${record.recordId} skips or reorders checkpoints`);
                }
            } else {
                if (checkpointIndex !== 0 || !predecessorMatchesBaseline(record.predecessor, params.baseline)) {
                    throw new Error(`Portable record ${record.recordId} has a mismatched baseline predecessor`);
                }
                predecessorChain = {
                    tip: null,
                    completedCheckpoints: 0,
                    partialOffset: 0,
                    summary: params.baseline.summary,
                    coverageFingerprint: params.baseline.coverageFingerprint,
                };
                expectedStartOffset = 0;
            }

            if (record.step.startOffset !== expectedStartOffset) {
                throw new Error(`Portable record ${record.recordId} has a noncontiguous offset`);
            }
            const expectedChunk = expectedPlan.sourceText.slice(record.step.startOffset, record.endOffset);
            if (record.step.chunkFingerprint !== fingerprintPortableChunk(expectedChunk)) {
                throw new Error(`Portable record ${record.recordId} has a mismatched chunk proof`);
            }
            if (record.step.kind === "carry-forward" && record.summary !== predecessorChain.summary) {
                throw new Error(`Portable record ${record.recordId} changes a carry-forward summary`);
            }
            const expectedCoverage = fingerprintPortableCoverage({
                predecessorCoverageFingerprint: predecessorChain.coverageFingerprint,
                checkpoint: record.checkpoint,
                range: record.range,
                endOffset: record.endOffset,
            });
            if (record.coverageFingerprint !== expectedCoverage) {
                throw new Error(`Portable record ${record.recordId} has a mismatched coverage proof`);
            }

            const completedCheckpoints = record.state === "complete" ? checkpointIndex + 1 : checkpointIndex;
            const result: PortableChain = {
                tip: source,
                completedCheckpoints,
                partialOffset: record.state === "partial" ? record.endOffset : 0,
                summary: record.summary,
                coverageFingerprint: record.coverageFingerprint,
            };
            validationMemo.set(source, result);
            return result;
        } catch (error) {
            const normalized = error instanceof Error ? error : new Error(String(error));
            validationMemo.set(source, normalized);
            throw normalized;
        } finally {
            validating.delete(source);
        }
    };

    let best: PortableChain = {
        tip: null,
        completedCheckpoints: 0,
        partialOffset: 0,
        summary: params.baseline.summary,
        coverageFingerprint: params.baseline.coverageFingerprint,
    };
    for (const source of parsed) {
        if (checkpointIndexFor(source.record) < 0) continue;
        try {
            const chain = validate(source);
            if (source.record.state === "partial" && params.resumeToolResultChars !== undefined) {
                const expected = preparePortableSource(
                    params.checkpoints[checkpointIndexFor(source.record)]!,
                    params.resumeToolResultChars,
                );
                if (source.record.range.transcriptFingerprint !== expected.range.transcriptFingerprint) continue;
            }
            if (isBetterChain(chain, best)) best = chain;
        } catch (error) {
            if (source.activePosition !== null) throw error;
        }
    }
    return best;
}
