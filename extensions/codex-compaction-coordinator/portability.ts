import { randomUUID } from "node:crypto";

import type { Api, Model } from "@earendil-works/pi-ai";
import {
    convertToLlm,
    serializeConversation,
    sessionEntryToContextMessages,
    type AgentMessage,
    type ExtensionAPI,
    type ExtensionContext,
    type SessionEntry,
} from "@earendil-works/pi-coding-agent";

import { isCoordinatorMetadataEntry } from "./portability-mode.ts";
import {
    describeNativeEpoch,
    fingerprintConversionNativeCheckpointDetails,
    isConversionNativeCheckpointCandidate,
    isConversionNativeCompactionDisplayEntry,
    parseConversionNativeCheckpointDetails,
    type NativeCheckpointDescriptor,
    type NativeEpoch,
    type NativeEpochError,
} from "./native-checkpoint-source.ts";
import {
    PORTABLE_SUMMARY_CUSTOM_TYPE,
    canonicalJson,
    fingerprintBranchRootCoverage,
    fingerprintPlaintextCoverage,
    fingerprintPortableChunk,
    fingerprintPortableCoverage,
    fingerprintPortableEntries,
    fingerprintPortableSummary,
    fingerprintPortableTranscript,
    hashPortableValue,
    MalformedPortableRecordError,
    parsePortableSummarizerProvenance,
    parsePortableSummaryRecord,
    parsePortableSummaryUsage,
    selectBestPortableChain,
    type PortableBaselineProof,
    type PortableChain,
    type PortableCheckpointIdentity,
    type PortableCheckpointPlan,
    type PortableRangeIdentity,
    type PortableRecordPredecessor,
    type PortableRecordSource,
    type PortableSummarizerProvenance,
    type PortableSummaryRecordV1,
    type PortableSummaryUsage,
    type ValidatedPortableRecord,
} from "./portable-record.ts";

export const GROUNDED_PORTABLE_SUMMARIZER_EVENT = "grounded-compaction:portable-summarizer-query";
export const LAZY_PORTABILITY_SETTLED_EVENT = "codex-compaction-coordinator:lazy-portability-settled";

const EPOCH_FINGERPRINT_DOMAIN = "codex-compaction-coordinator:epoch:v1";
const PLAN_KEY_DOMAIN = "codex-compaction-coordinator:plan-key:v1";
const ENTRY_CACHE_DOMAIN = "codex-compaction-coordinator:memo-entry:v1";
const EMPTY_CONTEXT: { messages: AgentMessage[] } = { messages: [] };

type ModelIdentity = { provider: string; api: string; id: string };

export type GroundedPortableSummarizerSession = {
    descriptor: PortableSummarizerProvenance;
    summarizeNext(request: {
        previousSummary: string | null;
        sourceText: string;
        startOffset: number;
        coverageEntries: readonly SessionEntry[];
        signal: AbortSignal;
    }): Promise<{
        summary: string;
        endOffset: number;
        usage: PortableSummaryUsage | null;
    }>;
};
export type GroundedPortableSummarizerResponse =
    | { status: "unavailable" }
    | {
        status: "available";
        openSession: (signal: AbortSignal) => Promise<GroundedPortableSummarizerSession>;
    }
    | { status: "error"; error: string };

export type DerivedCheckpointPlan = PortableCheckpointPlan & {
    descriptor: NativeCheckpointDescriptor;
    coverageEntries: readonly SessionEntry[];
};

export type DerivedPortablePlan = {
    baseline: PortableBaselineProof;
    checkpoints: readonly DerivedCheckpointPlan[];
    baselineEntryIndex: number;
    latestCheckpointIndex: number;
    latestCheckpointId: string;
    nonPortableEpochFingerprint: string;
};

export type PortabilitySnapshot = {
    sessionId: string;
    cwd: string;
    model: Model<Api>;
    groundedBranchEntries: readonly SessionEntry[];
};

type OperationWaiter = {
    signal: AbortSignal;
    abortContext: () => void;
};

type OperationPhase = "preparing" | "awaiting-provider" | "commit" | "settled";

type ActiveOperation = {
    key: string;
    controller: AbortController;
    promise: Promise<AgentMessage[]>;
    waiters: Set<OperationWaiter>;
    phase: OperationPhase;
    settled: boolean;
};

type DiscoveryMemo = {
    key: string;
    plan: DerivedPortablePlan;
};

type RuntimeDependencies = {
    now: () => number;
    randomUUID: () => string;
    cloneBranch: (branch: readonly SessionEntry[]) => SessionEntry[];
    onPlanDerived: () => void;
    onEntryFingerprint: () => void;
    onPrefixHash: () => void;
    onPortableRecordValidation: () => void;
};

const DEFAULT_DEPENDENCIES: RuntimeDependencies = {
    now: Date.now,
    randomUUID,
    cloneBranch: (branch) => structuredClone(branch) as SessionEntry[],
    onPlanDerived: () => undefined,
    onEntryFingerprint: () => undefined,
    onPrefixHash: () => undefined,
    onPortableRecordValidation: () => undefined,
};

class PortabilityAbortedError extends Error {
    constructor() {
        super("Codex checkpoint portability was aborted");
        this.name = "AbortError";
    }
}

class NativeEpochDiscoveryError extends Error {
    readonly reasonCode: NativeEpochError["reasonCode"];
    readonly nativeEntryIndex: number;
    readonly nativeEntryId?: string;

    constructor(response: NativeEpochError) {
        super(response.message);
        this.name = "NativeEpochDiscoveryError";
        this.reasonCode = response.reasonCode;
        this.nativeEntryIndex = response.nativeEntryIndex;
        this.nativeEntryId = response.nativeEntryId;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    const actualKeys = Object.keys(value);
    return actualKeys.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
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

function findOwnEntryIndex(branch: readonly SessionEntry[], entryId: string): number {
    return branch.findIndex((entry) => ownEntryId(entry) === entryId);
}

function isCanonicalCodexModel(model: ModelIdentity): boolean {
    return model.provider === "openai-codex" && model.api === "openai-codex-responses";
}

export function normalizeGroundedPortableSummarizerResponse(
    value: unknown,
): GroundedPortableSummarizerResponse {
    if (!isRecord(value)) {
        return { status: "error", error: "Invalid grounded portable summarizer response" };
    }
    if (value.status === "unavailable" && hasExactKeys(value, ["status"])) return { status: "unavailable" };
    if (
        value.status === "error"
        && hasExactKeys(value, ["status", "error"])
        && isNonblankString(value.error)
    ) {
        return { status: "error", error: value.error };
    }
    if (
        value.status === "available"
        && hasExactKeys(value, ["status", "openSession"])
        && typeof value.openSession === "function"
    ) {
        return {
            status: "available",
            openSession: value.openSession as (
                signal: AbortSignal
            ) => Promise<GroundedPortableSummarizerSession>,
        };
    }
    return { status: "error", error: "Invalid grounded portable summarizer response" };
}

function portableCheckpointIdentity(descriptor: NativeCheckpointDescriptor): PortableCheckpointIdentity {
    return {
        entryId: descriptor.entryId,
        storage: descriptor.storage,
        modelKey: descriptor.modelKey,
        checkpointFingerprint: descriptor.checkpointFingerprint,
    };
}

function isPortableEntry(entry: SessionEntry): boolean {
    return entry.type === "custom" && entry.customType === PORTABLE_SUMMARY_CUSTOM_TYPE;
}

function isProjectionMetadataEntry(entry: SessionEntry): boolean {
    return isCoordinatorMetadataEntry(entry) || isConversionNativeCompactionDisplayEntry(entry);
}

function isPortableSourceEntry(entry: SessionEntry): boolean {
    return entry.type !== "compaction" && !isProjectionMetadataEntry(entry);
}

function portableSourceEntries(entries: readonly SessionEntry[]): SessionEntry[] {
    return entries.filter(isPortableSourceEntry).map((entry) => {
        if (ownEntryId(entry) === undefined) throw new Error("Portable source entry has an invalid identity");
        return entry;
    });
}

export function cloneProjectionSafeBranch(
    branch: readonly SessionEntry[],
    cloneBranch: (entries: readonly SessionEntry[]) => SessionEntry[],
): SessionEntry[] {
    return cloneBranch(portableSourceEntries(branch));
}

type ProjectionIdentityEntry = {
    sourceEntry: SessionEntry;
    projectedEntry: SessionEntry;
    entryId: string;
};

function projectionIdentityPairs(
    branch: readonly SessionEntry[],
    entries: readonly SessionEntry[],
): ProjectionIdentityEntry[] {
    const entriesById = new Map<string, SessionEntry>();
    const metadataIds = new Set<string>();
    for (const entry of branch) {
        const entryId = ownEntryId(entry);
        if (isProjectionMetadataEntry(entry)) {
            if (entryId === undefined) throw new Error("Projection metadata entry has an invalid identity");
            metadataIds.add(entryId);
        }
        if (entryId !== undefined) entriesById.set(entryId, entry);
    }
    return entries.map((entry) => {
        const entryId = ownEntryId(entry);
        if (entryId === undefined) throw new Error("Portable source entry has an invalid identity");
        let parentId = entry.parentId;
        const visited = new Set<string>();
        while (parentId !== null && metadataIds.has(parentId)) {
            if (visited.has(parentId)) throw new Error("Projection metadata parent chain is cyclic");
            visited.add(parentId);
            parentId = entriesById.get(parentId)?.parentId ?? null;
        }
        return {
            sourceEntry: entry,
            projectedEntry: parentId === entry.parentId ? entry : { ...entry, parentId } as SessionEntry,
            entryId,
        };
    });
}

function projectionIdentityEntries(
    branch: readonly SessionEntry[],
    entries: readonly SessionEntry[],
): SessionEntry[] {
    return projectionIdentityPairs(branch, entries).map(({ projectedEntry }) => projectedEntry);
}

function revalidateEpochAgainstBranch(
    branch: readonly SessionEntry[],
    response: NativeEpoch,
): void {
    if (response.baseline.kind === "plaintext-compaction") {
        const entry = branch[response.baseline.entryIndex];
        if (
            !entry
            || !Object.hasOwn(entry, "id")
            || !isNonblankString(entry.id)
            || entry.id !== response.baseline.entryId
            || !Object.hasOwn(entry, "type")
            || entry.type !== "compaction"
            || isConversionNativeCheckpointCandidate(entry)
            || !Object.hasOwn(entry, "summary")
            || !isNonblankString(entry.summary)
            || !Object.hasOwn(entry, "firstKeptEntryId")
            || entry.firstKeptEntryId !== response.baseline.firstKeptEntryId
        ) {
            throw new Error("The plaintext compaction baseline does not match the active branch");
        }
        const keptEntryIndex = findOwnEntryIndex(branch, entry.firstKeptEntryId);
        if (keptEntryIndex < 0 || keptEntryIndex >= response.baseline.entryIndex) {
            throw new Error("The plaintext compaction baseline has an invalid kept boundary");
        }
    }
    const baselineIndex = response.baseline.kind === "branch-root" ? -1 : response.baseline.entryIndex;
    const checkpointEntryIds = new Set<string>();
    let previousCheckpointIndex = baselineIndex;
    for (const descriptor of response.checkpoints) {
        if (checkpointEntryIds.has(descriptor.entryId) || descriptor.entryIndex <= previousCheckpointIndex) {
            throw new Error("Native checkpoints are not strictly ordered and unique on the active branch");
        }
        checkpointEntryIds.add(descriptor.entryId);
        previousCheckpointIndex = descriptor.entryIndex;
        const entry = branch[descriptor.entryIndex];
        if (
            descriptor.storage !== "pi-compaction"
            || !entry
            || !Object.hasOwn(entry, "id")
            || !isNonblankString(entry.id)
            || entry.id !== descriptor.entryId
            || !Object.hasOwn(entry, "type")
            || entry.type !== "compaction"
            || !isConversionNativeCheckpointCandidate(entry)
            || !Object.hasOwn(entry, "tokensBefore")
            || !isSafeNonnegativeInteger(entry.tokensBefore)
            || entry.tokensBefore !== descriptor.tokensBefore
            || !Object.hasOwn(entry, "details")
        ) {
            throw new Error(`Native checkpoint ${descriptor.entryId} does not match the active branch`);
        }
        const details = parseConversionNativeCheckpointDetails(entry.details);
        if (`${details.provider}:${details.api}:${details.model}` !== descriptor.modelKey) {
            throw new Error(`Native checkpoint ${descriptor.entryId} model identity does not match persisted details`);
        }
        if (fingerprintConversionNativeCheckpointDetails(entry.details) !== descriptor.checkpointFingerprint) {
            throw new Error(`Native checkpoint ${descriptor.entryId} fingerprint does not match persisted details`);
        }
    }
}

function serializeRange(entries: readonly SessionEntry[]): string {
    const messages = entries
        .flatMap((entry) => sessionEntryToContextMessages(entry));
    return serializeConversation(convertToLlm(messages));
}

export function derivePortablePlan(
    branch: readonly SessionEntry[],
    response: NativeEpoch,
    onPrefixHash: () => void = () => undefined,
): DerivedPortablePlan {
    revalidateEpochAgainstBranch(branch, response);
    const baselineEntryIndex = response.baseline.kind === "branch-root" ? -1 : response.baseline.entryIndex;
    let rangeStartIndex = 0;
    let baseline: PortableBaselineProof;
    if (response.baseline.kind === "branch-root") {
        baseline = {
            kind: "branch-root",
            summary: null,
            coverageFingerprint: fingerprintBranchRootCoverage(),
        };
    } else {
        const entry = branch[response.baseline.entryIndex]!;
        if (entry.type !== "compaction" || !isNonblankString(entry.summary)) {
            throw new Error(`Plaintext compaction entry ${response.baseline.entryId} has a blank summary`);
        }
        rangeStartIndex = findOwnEntryIndex(branch, response.baseline.firstKeptEntryId);
        if (rangeStartIndex < 0 || rangeStartIndex >= response.baseline.entryIndex) {
            throw new Error(`Plaintext compaction entry ${response.baseline.entryId} has an invalid kept boundary`);
        }
        const summaryFingerprint = fingerprintPortableSummary(entry.summary);
        baseline = {
            kind: "plaintext-compaction",
            entryId: response.baseline.entryId,
            firstKeptEntryId: response.baseline.firstKeptEntryId,
            summary: entry.summary,
            summaryFingerprint,
            coverageFingerprint: fingerprintPlaintextCoverage({
                entryId: response.baseline.entryId,
                firstKeptEntryId: response.baseline.firstKeptEntryId,
                summaryFingerprint,
            }),
        };
    }

    let coverageCursor = 0;
    const cumulativeCoverageEntries: SessionEntry[] = [];
    const checkpoints: DerivedCheckpointPlan[] = response.checkpoints.map((descriptor, checkpointIndex) => {
        for (const entry of branch.slice(coverageCursor, descriptor.entryIndex)) {
            if (isPortableSourceEntry(entry)) cumulativeCoverageEntries.push(entry);
        }
        coverageCursor = descriptor.entryIndex + 1;
        const coverageEntries = [...cumulativeCoverageEntries];

        const startIndex = checkpointIndex === 0
            ? rangeStartIndex
            : response.checkpoints[checkpointIndex - 1]!.entryIndex + 1;
        const entries = branch.slice(startIndex, descriptor.entryIndex).filter(isPortableSourceEntry);
        const identityPairs = projectionIdentityPairs(branch, entries);
        const identityEntries = identityPairs.map(({ projectedEntry }) => projectedEntry);
        const sourceText = serializeRange(entries);
        const range: PortableRangeIdentity = {
            firstEntryId: identityPairs[0]?.entryId ?? null,
            lastEntryId: identityPairs.at(-1)?.entryId ?? null,
            entryCount: entries.length,
            entriesFingerprint: fingerprintPortableEntries(identityEntries),
            transcriptLength: sourceText.length,
            transcriptFingerprint: fingerprintPortableTranscript(sourceText),
        };
        return {
            descriptor,
            checkpoint: portableCheckpointIdentity(descriptor),
            range,
            sourceText,
            coverageEntries,
        };
    });
    const latestCheckpoint = response.checkpoints.at(-1);
    const latestCheckpointIndex = latestCheckpoint?.entryIndex ?? baselineEntryIndex;
    const nonPortablePrefix = projectionIdentityEntries(branch, branch
        .slice(0, latestCheckpointIndex + 1)
        .filter((entry) => !isProjectionMetadataEntry(entry)));
    onPrefixHash();
    return {
        baseline,
        checkpoints,
        baselineEntryIndex,
        latestCheckpointIndex,
        latestCheckpointId: latestCheckpoint?.entryId ?? "",
        nonPortableEpochFingerprint: hashPortableValue(EPOCH_FINGERPRINT_DOMAIN, nonPortablePrefix),
    };
}

function discoverSources(
    entries: readonly SessionEntry[],
    branch: readonly SessionEntry[],
    baselineEntryIndex: number,
): PortableRecordSource[] {
    const activePositions = new Map(branch.map((entry, index) => [entry.id, index]));
    return entries.flatMap((entry) => {
        if (!isPortableEntry(entry)) return [];
        const activePosition = activePositions.get(entry.id) ?? null;
        return [{
            entryId: entry.id,
            data: entry.data,
            activePosition,
            relevantIfMalformed: activePosition !== null && activePosition > baselineEntryIndex,
        }];
    });
}

export function discoverChain(
    plan: DerivedPortablePlan,
    entries: readonly SessionEntry[],
    branch: readonly SessionEntry[],
    onPortableRecordValidation: () => void,
): PortableChain {
    const sources = discoverSources(entries, branch, plan.baselineEntryIndex);
    for (let index = 0; index < sources.length; index += 1) onPortableRecordValidation();
    return selectBestPortableChain({
        sources,
        baseline: plan.baseline,
        checkpoints: plan.checkpoints,
    });
}

function predecessorForChain(chain: PortableChain, baseline: PortableBaselineProof): PortableRecordPredecessor {
    if (chain.tip) {
        return {
            kind: "portable-record",
            recordId: chain.tip.record.recordId,
            summaryFingerprint: fingerprintPortableSummary(chain.tip.record.summary),
            coverageFingerprint: chain.tip.record.coverageFingerprint,
        };
    }
    if (baseline.kind === "branch-root") {
        return { kind: "branch-root", coverageFingerprint: baseline.coverageFingerprint };
    }
    return {
        kind: "plaintext-compaction",
        entryId: baseline.entryId,
        firstKeptEntryId: baseline.firstKeptEntryId,
        summaryFingerprint: baseline.summaryFingerprint,
        coverageFingerprint: baseline.coverageFingerprint,
    };
}

export function buildCarryForwardRecord(params: {
    chain: PortableChain;
    baseline: PortableBaselineProof;
    checkpoint: DerivedCheckpointPlan;
    recordId: string;
}): PortableSummaryRecordV1 {
    const predecessor = predecessorForChain(params.chain, params.baseline);
    const coverageFingerprint = fingerprintPortableCoverage({
        predecessorCoverageFingerprint: params.chain.coverageFingerprint,
        checkpoint: params.checkpoint.checkpoint,
        range: params.checkpoint.range,
        endOffset: 0,
    });
    return parsePortableSummaryRecord({
        kind: PORTABLE_SUMMARY_CUSTOM_TYPE,
        version: 1,
        recordId: params.recordId,
        predecessor,
        checkpoint: params.checkpoint.checkpoint,
        range: params.checkpoint.range,
        state: "complete",
        endOffset: 0,
        coverageFingerprint,
        summary: params.chain.summary,
        step: {
            kind: "carry-forward",
            startOffset: 0,
            chunkFingerprint: fingerprintPortableChunk(""),
        },
    });
}

export function buildSummaryCallRecord(params: {
    chain: PortableChain;
    baseline: PortableBaselineProof;
    checkpoint: DerivedCheckpointPlan;
    recordId: string;
    startOffset: number;
    result: { summary: string; endOffset: number; usage: PortableSummaryUsage | null };
    descriptor: PortableSummarizerProvenance;
}): PortableSummaryRecordV1 {
    if (
        !isNonblankString(params.result.summary)
        || !isSafeNonnegativeInteger(params.result.endOffset)
        || params.result.endOffset <= params.startOffset
        || params.result.endOffset > params.checkpoint.sourceText.length
    ) {
        throw new Error("Grounded portable summarizer returned an invalid range or summary");
    }
    const predecessor = predecessorForChain(params.chain, params.baseline);
    let usage: PortableSummaryUsage | null;
    try {
        usage = parsePortableSummaryUsage(params.result.usage);
    } catch {
        throw new Error("Grounded portable summarizer returned invalid usage");
    }
    const coverageFingerprint = fingerprintPortableCoverage({
        predecessorCoverageFingerprint: params.chain.coverageFingerprint,
        checkpoint: params.checkpoint.checkpoint,
        range: params.checkpoint.range,
        endOffset: params.result.endOffset,
    });
    return parsePortableSummaryRecord({
        kind: PORTABLE_SUMMARY_CUSTOM_TYPE,
        version: 1,
        recordId: params.recordId,
        predecessor,
        checkpoint: params.checkpoint.checkpoint,
        range: params.checkpoint.range,
        state: params.result.endOffset === params.checkpoint.sourceText.length ? "complete" : "partial",
        endOffset: params.result.endOffset,
        coverageFingerprint,
        summary: params.result.summary,
        step: {
            kind: "summary-call",
            startOffset: params.startOffset,
            chunkFingerprint: fingerprintPortableChunk(
                params.checkpoint.sourceText.slice(params.startOffset, params.result.endOffset),
            ),
            summarizer: params.descriptor,
            usage,
        },
    });
}

export function extendChainWithAppendedRecord(params: {
    chain: PortableChain;
    record: PortableSummaryRecordV1;
    branchBeforeAppend: readonly SessionEntry[];
    branchAfterAppend: readonly SessionEntry[];
    onPortableRecordValidation: () => void;
}): PortableChain {
    const appendedEntry = params.branchAfterAppend[params.branchBeforeAppend.length];
    const expectedParentId = params.branchBeforeAppend.at(-1)?.id ?? null;
    if (
        !appendedEntry
        || appendedEntry.type !== "custom"
        || appendedEntry.customType !== PORTABLE_SUMMARY_CUSTOM_TYPE
        || appendedEntry.parentId !== expectedParentId
    ) {
        throw new Error(`Portable record ${params.record.recordId} was not durably appended`);
    }
    params.onPortableRecordValidation();
    const persistedRecord = parsePortableSummaryRecord(appendedEntry.data);
    if (canonicalJson(persistedRecord) !== canonicalJson(params.record)) {
        throw new Error(`Portable record ${params.record.recordId} was not durably appended`);
    }
    const source: ValidatedPortableRecord = {
        entryId: appendedEntry.id,
        activePosition: params.branchBeforeAppend.length,
        record: persistedRecord,
    };
    return {
        tip: source,
        completedCheckpoints: persistedRecord.state === "complete"
            ? params.chain.completedCheckpoints + 1
            : params.chain.completedCheckpoints,
        partialOffset: persistedRecord.state === "partial" ? persistedRecord.endOffset : 0,
        summary: persistedRecord.summary,
        coverageFingerprint: persistedRecord.coverageFingerprint,
    };
}

export function advancePortableChain(
    chain: PortableChain,
    record: PortableSummaryRecordV1,
): PortableChain {
    return {
        tip: {
            entryId: `pending:${record.recordId}`,
            activePosition: null,
            record,
        },
        completedCheckpoints: record.state === "complete"
            ? chain.completedCheckpoints + 1
            : chain.completedCheckpoints,
        partialOffset: record.state === "partial" ? record.endOffset : 0,
        summary: record.summary,
        coverageFingerprint: record.coverageFingerprint,
    };
}

export function assertFreshPlan(
    snapshot: PortabilitySnapshot,
    ctx: ExtensionContext,
    plannedEpoch: NativeEpoch,
): SessionEntry[] {
    if (
        ctx.sessionManager.getSessionId() !== snapshot.sessionId
        || ctx.cwd !== snapshot.cwd
    ) {
        throw new PortabilityAbortedError();
    }
    const liveBranch = ctx.sessionManager.getBranch() as SessionEntry[];
    const currentEpoch = describeNativeEpoch(liveBranch);
    if (currentEpoch.status === "error") throw new NativeEpochDiscoveryError(currentEpoch);
    if (
        currentEpoch.checkpoints.length === 0
        || canonicalJson(currentEpoch) !== canonicalJson(plannedEpoch)
    ) {
        throw new Error("The active native checkpoint epoch changed during Codex checkpoint portability");
    }
    // Session entries are append-only and immutable, so each commit can recheck native authority and source
    // identities against the live branch without rebuilding the portable plan
    revalidateEpochAgainstBranch(liveBranch, currentEpoch);
    portableSourceEntries(liveBranch);
    return liveBranch;
}

export function queryGrounded(
    pi: ExtensionAPI,
    snapshot: PortabilitySnapshot,
    ctx: ExtensionContext,
): Extract<GroundedPortableSummarizerResponse, { status: "available" }> {
    const query = {
        kind: "open-portable-summarizer",
        context: {
            model: snapshot.model,
            modelRegistry: ctx.modelRegistry,
            cwd: snapshot.cwd,
        },
        branchEntries: snapshot.groundedBranchEntries,
        response: { status: "unavailable" },
    };
    pi.events.emit(GROUNDED_PORTABLE_SUMMARIZER_EVENT, query);
    const response = normalizeGroundedPortableSummarizerResponse(query.response);
    if (response.status === "unavailable") {
        throw new Error("Grounded portable summarizer is unavailable for a native checkpoint epoch");
    }
    if (response.status === "error") throw new Error(response.error);
    return response;
}

export function projectPortableTail(
    branch: readonly SessionEntry[],
    plan: DerivedPortablePlan,
): AgentMessage[] {
    const checkpointIndex = plan.latestCheckpointIndex;
    const checkpoint = branch[checkpointIndex];
    if (!checkpoint || ownEntryId(checkpoint) !== plan.latestCheckpointId) {
        throw new Error("The active branch no longer contains the covered native checkpoint");
    }
    return portableSourceEntries(branch.slice(checkpointIndex + 1))
        .flatMap((entry) => sessionEntryToContextMessages(entry));
}

function buildInjectedMessages(params: {
    branch: readonly SessionEntry[];
    plan: DerivedPortablePlan;
    chain: PortableChain;
    now: number;
}): AgentMessage[] {
    const tail = projectPortableTail(params.branch, params.plan);
    if (params.chain.summary === null && tail.length === 0) {
        throw new Error("Portable checkpoint projection would produce empty context");
    }
    if (params.chain.summary === null) return tail;
    const latestDescriptor = params.plan.checkpoints.at(-1)!.descriptor;
    return [{
        role: "compactionSummary",
        summary: params.chain.summary,
        tokensBefore: latestDescriptor.tokensBefore,
        timestamp: params.now,
    }, ...tail] as AgentMessage[];
}

function throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw new PortabilityAbortedError();
}

function isAbort(error: unknown): boolean {
    return error instanceof PortabilityAbortedError
        || (error instanceof Error && error.name === "AbortError");
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "error"): void {
    if (ctx.hasUI) ctx.ui.notify(message, level);
}

const FAILURE_REASON_BY_PHASE: Readonly<Record<string, string>> = {
    "epoch-query": "NATIVE_EPOCH_QUERY_FAILED",
    plan: "PORTABLE_PLAN_FAILED",
    "record-discovery": "PORTABLE_RECORD_DISCOVERY_FAILED",
    "grounded-discovery": "SUMMARIZER_DISCOVERY_FAILED",
    "grounded-open": "SUMMARIZER_OPEN_FAILED",
    "summary-call": "SUMMARIZER_CALL_FAILED",
    append: "DURABLE_APPEND_FAILED",
    injection: "CONTEXT_PROJECTION_FAILED",
};

function failureReasonForPhase(phase: string): string {
    return FAILURE_REASON_BY_PHASE[phase] ?? "UNEXPECTED_PORTABILITY_FAILURE";
}

const FAILURE_MESSAGE_BY_PHASE: Readonly<Record<string, string>> = {
    "epoch-query": "Native checkpoint epoch discovery failed",
    plan: "Portable checkpoint plan derivation failed",
    "record-discovery": "Portable checkpoint record discovery failed",
    "grounded-discovery": "Portable summarizer discovery failed",
    "grounded-open": "Portable summarizer session opening failed",
    "summary-call": "Portable summarizer call failed",
    append: "Portable checkpoint durable append failed",
    injection: "Portable checkpoint context projection failed",
};

type SafeFailureDiagnostic = {
    reasonCode: string;
    message: string;
    recordEntryId?: string;
    nativeEntryIndex?: number;
    nativeEntryId?: string;
};

function safeFailureDiagnostic(
    phase: string,
    error: unknown,
    nativeEntryId?: string,
): SafeFailureDiagnostic {
    if (error instanceof NativeEpochDiscoveryError) {
        return {
            reasonCode: error.reasonCode,
            message: error.message,
            nativeEntryIndex: error.nativeEntryIndex,
            nativeEntryId: error.nativeEntryId ?? nativeEntryId,
        };
    }
    if (error instanceof MalformedPortableRecordError) {
        return {
            reasonCode: "MALFORMED_PORTABLE_RECORD",
            message: error.message,
            recordEntryId: error.recordEntryId,
            nativeEntryId,
        };
    }
    return {
        reasonCode: failureReasonForPhase(phase),
        message: FAILURE_MESSAGE_BY_PHASE[phase] ?? "Codex checkpoint portability failed",
        nativeEntryId,
    };
}

export function registerCodexCompactionPortability(
    pi: ExtensionAPI,
    dependencies: Partial<RuntimeDependencies> = {},
): void {
    const runtime = { ...DEFAULT_DEPENDENCIES, ...dependencies };
    const activeOperations = new Map<string, ActiveOperation>();
    let discoveryMemo: DiscoveryMemo | undefined;
    let entryFingerprintCache = new WeakMap<object, string>();

    const memoPrefixFingerprints = (entries: readonly ProjectionIdentityEntry[]): string[] => {
        const seenEntryIds = new Set<string>();
        return entries.map(({ sourceEntry, projectedEntry, entryId }) => {
            if (seenEntryIds.has(entryId)) {
                throw new Error(`Duplicate session entry identity ${entryId}`);
            }
            seenEntryIds.add(entryId);
            const cached = entryFingerprintCache.get(sourceEntry);
            if (cached !== undefined) return cached;
            runtime.onEntryFingerprint();
            const fingerprint = hashPortableValue(ENTRY_CACHE_DOMAIN, projectedEntry);
            entryFingerprintCache.set(sourceEntry, fingerprint);
            return fingerprint;
        });
    };

    const abortRemainingWaiters = (operation: ActiveOperation): void => {
        for (const waiter of [...operation.waiters]) {
            if (!waiter.signal.aborted) waiter.abortContext();
        }
    };

    const cancelOperation = (operation: ActiveOperation): void => {
        if (activeOperations.get(operation.key) === operation) activeOperations.delete(operation.key);
        abortRemainingWaiters(operation);
        operation.controller.abort();
    };

    const invalidate = (): void => {
        for (const operation of [...activeOperations.values()]) cancelOperation(operation);
        discoveryMemo = undefined;
        entryFingerprintCache = new WeakMap<object, string>();
    };

    const deferUnobservedCancellation = (operation: ActiveOperation): void => {
        queueMicrotask(() => {
            if (
                operation.settled
                || operation.waiters.size > 0
                || operation.phase === "commit"
                || activeOperations.get(operation.key) !== operation
            ) {
                return;
            }
            activeOperations.delete(operation.key);
            operation.controller.abort();
        });
    };

    const waitForOperation = (
        operation: ActiveOperation,
        signal: AbortSignal,
        abortContext: () => void,
    ): Promise<AgentMessage[]> => new Promise((resolve, reject) => {
        const waiter: OperationWaiter = { signal, abortContext };
        operation.waiters.add(waiter);
        const finish = (complete: () => void): void => {
            if (!operation.waiters.delete(waiter)) return;
            signal.removeEventListener("abort", abortWait);
            if (!operation.settled && operation.waiters.size === 0) deferUnobservedCancellation(operation);
            complete();
        };
        const abortWait = () => finish(() => resolve([]));
        if (signal.aborted) {
            abortWait();
            return;
        }
        signal.addEventListener("abort", abortWait, { once: true });
        operation.promise.then(
            (messages) => finish(() => resolve(messages)),
            (error: unknown) => finish(() => reject(error)),
        );
    });

    for (const lifecycleEvent of ["session_start", "session_tree", "model_select", "session_shutdown"] as const) {
        pi.on(lifecycleEvent, invalidate);
    }

    pi.on("context", async (_event, ctx) => {
        if (!ctx.model || isCanonicalCodexModel(ctx.model)) return undefined;
        try {
        let phase = "epoch-query";
        let checkpointId: string | undefined;
        try {
            const sessionId = ctx.sessionManager.getSessionId();
            const liveBranch = ctx.sessionManager.getBranch() as SessionEntry[];
            const response = describeNativeEpoch(liveBranch);
            if (response.status === "error") throw new NativeEpochDiscoveryError(response);
            if (response.checkpoints.length === 0) return undefined;
            checkpointId = response.checkpoints.at(-1)!.entryId;

            const snapshot: PortabilitySnapshot = {
                sessionId,
                cwd: ctx.cwd,
                model: ctx.model,
                groundedBranchEntries: cloneProjectionSafeBranch(liveBranch, runtime.cloneBranch),
            };
            const currentEntries = ctx.sessionManager.getEntries() as SessionEntry[];
            phase = "plan";
            const latestIndex = response.checkpoints.at(-1)!.entryIndex;
            const nonPortablePrefix = projectionIdentityPairs(liveBranch, liveBranch
                .slice(0, latestIndex + 1)
                .filter((entry) => !isProjectionMetadataEntry(entry)));
            const portableEntryIds = currentEntries
                .filter(isPortableEntry)
                .map((entry) => entry.id);
            const memoKey = canonicalJson({
                sessionId: snapshot.sessionId,
                baseline: response.baseline,
                checkpoints: response.checkpoints,
                prefix: memoPrefixFingerprints(nonPortablePrefix),
                portableEntryIds,
            });
            let plan: DerivedPortablePlan;
            if (discoveryMemo?.key === memoKey) {
                revalidateEpochAgainstBranch(liveBranch, response);
                plan = discoveryMemo.plan;
            } else {
                plan = derivePortablePlan(liveBranch, response, runtime.onPrefixHash);
                runtime.onPlanDerived();
            }
            discoveryMemo = { key: memoKey, plan };
            const operationKey = hashPortableValue(PLAN_KEY_DOMAIN, {
                sessionId: snapshot.sessionId,
                cwd: snapshot.cwd,
                model: {
                    provider: snapshot.model.provider,
                    api: snapshot.model.api,
                    id: snapshot.model.id,
                },
                epoch: plan.nonPortableEpochFingerprint,
                baseline: response.baseline,
                latestCheckpoint: response.checkpoints.at(-1),
            });

            const existingOperation = activeOperations.get(operationKey);
            if (existingOperation) {
                return {
                    messages: await waitForOperation(existingOperation, ctx.signal, () => ctx.abort()),
                };
            }
            for (const activeOperation of [...activeOperations.values()]) cancelOperation(activeOperation);
            const controller = new AbortController();
            let operation!: ActiveOperation;
            const operationPromise = (async (): Promise<AgentMessage[]> => {
                await Promise.resolve();
                let operationPhase = "record-discovery";
                let currentCheckpointId = checkpointId;
                let startedCall = false;
                let appendedCall = false;
                try {
                    let branch = ctx.sessionManager.getBranch() as SessionEntry[];
                    const entries = ctx.sessionManager.getEntries() as SessionEntry[];
                    let chain = discoverChain(plan, entries, branch, runtime.onPortableRecordValidation);
                    if (chain.completedCheckpoints < plan.checkpoints.length) {
                        operationPhase = "grounded-discovery";
                        const grounded = queryGrounded(pi, snapshot, ctx);
                        let summarizer: GroundedPortableSummarizerSession | undefined;
                        while (chain.completedCheckpoints < plan.checkpoints.length) {
                            operation.phase = "preparing";
                            throwIfAborted(controller.signal);
                            if (operation.waiters.size === 0) return [];
                            const checkpoint = plan.checkpoints[chain.completedCheckpoints]!;
                            currentCheckpointId = checkpoint.checkpoint.entryId;
                            const startOffset = chain.partialOffset;
                            let record: PortableSummaryRecordV1;
                            if (checkpoint.sourceText.length === 0) {
                                operation.phase = "commit";
                                operationPhase = "append";
                                if (activeOperations.get(operationKey) !== operation) {
                                    throw new PortabilityAbortedError();
                                }
                                record = buildCarryForwardRecord({
                                    chain,
                                    baseline: plan.baseline,
                                    checkpoint,
                                    recordId: runtime.randomUUID(),
                                });
                            } else {
                                if (!summarizer) {
                                    operationPhase = "grounded-open";
                                    operation.phase = "awaiting-provider";
                                    const openedSession = await grounded.openSession(controller.signal);
                                    operation.phase = "preparing";
                                    throwIfAborted(controller.signal);
                                    if (
                                        operation.waiters.size === 0
                                        || activeOperations.get(operationKey) !== operation
                                    ) {
                                        return [];
                                    }
                                    let descriptor: PortableSummarizerProvenance;
                                    try {
                                        descriptor = parsePortableSummarizerProvenance(openedSession.descriptor);
                                    } catch {
                                        throw new Error("Grounded portable summarizer returned invalid provenance");
                                    }
                                    summarizer = { ...openedSession, descriptor };
                                }
                                if (!startedCall) {
                                    notify(ctx, "Materializing portable Codex checkpoint history…", "info");
                                    startedCall = true;
                                }
                                operationPhase = "summary-call";
                                operation.phase = "awaiting-provider";
                                const result = await summarizer.summarizeNext({
                                    previousSummary: chain.summary,
                                    sourceText: checkpoint.sourceText,
                                    startOffset,
                                    coverageEntries: checkpoint.coverageEntries,
                                    signal: controller.signal,
                                });
                                operation.phase = "commit";
                                operationPhase = "append";
                                if (activeOperations.get(operationKey) !== operation) {
                                    throw new PortabilityAbortedError();
                                }
                                record = buildSummaryCallRecord({
                                    chain,
                                    baseline: plan.baseline,
                                    checkpoint,
                                    recordId: runtime.randomUUID(),
                                    startOffset,
                                    result,
                                    descriptor: summarizer.descriptor,
                                });
                                appendedCall = true;
                            }

                            const branchBeforeAppend = assertFreshPlan(snapshot, ctx, response);
                            pi.appendEntry(PORTABLE_SUMMARY_CUSTOM_TYPE, record);
                            discoveryMemo = undefined;
                            branch = ctx.sessionManager.getBranch() as SessionEntry[];
                            chain = extendChainWithAppendedRecord({
                                chain,
                                record,
                                branchBeforeAppend,
                                branchAfterAppend: branch,
                                onPortableRecordValidation: runtime.onPortableRecordValidation,
                            });
                            throwIfAborted(controller.signal);
                            if (operation.waiters.size === 0) return [];
                        }
                    }

                    operation.phase = "preparing";
                    operationPhase = "injection";
                    if (
                        operation.waiters.size === 0
                        || activeOperations.get(operationKey) !== operation
                    ) {
                        throw new PortabilityAbortedError();
                    }
                    branch = assertFreshPlan(snapshot, ctx, response);
                    chain = discoverChain(
                        plan,
                        ctx.sessionManager.getEntries() as SessionEntry[],
                        branch,
                        runtime.onPortableRecordValidation,
                    );
                    if (chain.completedCheckpoints !== plan.checkpoints.length || chain.tip?.record.state !== "complete") {
                        throw new Error("The latest native checkpoint does not have a complete portable chain");
                    }
                    const messages = buildInjectedMessages({ branch, plan, chain, now: runtime.now() });
                    if (startedCall && appendedCall) {
                        notify(ctx, "Portable Codex checkpoint history is ready.", "info");
                    }
                    return messages;
                } catch (error) {
                    if (isAbort(error)) {
                        if (!controller.signal.aborted) abortRemainingWaiters(operation);
                        return [];
                    }
                    if (controller.signal.aborted) return [];
                    notify(ctx, `Codex checkpoint portability failed during ${operationPhase}.`, "error");
                    const diagnostic = safeFailureDiagnostic(operationPhase, error, currentCheckpointId);
                    console.error({
                        component: "codex-compaction-coordinator",
                        code: "PORTABILITY_OPERATION_FAILED",
                        ...diagnostic,
                        phase: operationPhase,
                        sessionId: snapshot.sessionId,
                        model: {
                            provider: snapshot.model.provider,
                            api: snapshot.model.api,
                            id: snapshot.model.id,
                        },
                    });
                    abortRemainingWaiters(operation);
                    return [];
                }
            })();
            operation = {
                key: operationKey,
                controller,
                promise: operationPromise,
                waiters: new Set(),
                phase: "preparing",
                settled: false,
            };
            operation.promise = operationPromise.finally(() => {
                operation.phase = "settled";
                operation.settled = true;
                if (activeOperations.get(operationKey) === operation) activeOperations.delete(operationKey);
            });
            activeOperations.set(operationKey, operation);
            return { messages: await waitForOperation(operation, ctx.signal, () => ctx.abort()) };
        } catch (error) {
            if (ctx.signal.aborted) return EMPTY_CONTEXT;
            notify(ctx, `Codex checkpoint portability failed during ${phase}.`, "error");
            const diagnostic = safeFailureDiagnostic(phase, error, checkpointId);
            console.error({
                component: "codex-compaction-coordinator",
                code: "PORTABILITY_CONTEXT_FAILED",
                ...diagnostic,
                phase,
                sessionId: ctx.sessionManager.getSessionId(),
                model: ctx.model ? {
                    provider: ctx.model.provider,
                    api: ctx.model.api,
                    id: ctx.model.id,
                } : null,
            });
            ctx.abort();
            return EMPTY_CONTEXT;
        }
        } finally {
            pi.events.emit(LAZY_PORTABILITY_SETTLED_EVENT, {
                sessionId: ctx.sessionManager.getSessionId(),
                context: ctx,
            });
        }
    });
}
