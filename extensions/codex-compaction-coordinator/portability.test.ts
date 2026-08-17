import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";

import type { AssistantMessage, Provider } from "@earendil-works/pi-ai";
import type { AgentMessage, ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";

import {
    openGroundedPortableSummarizerSession,
    type GroundedPortableSummarizerDependencies,
} from "../grounded-compaction/index.ts";
import {
    registerGroundedPortableSummarizer,
    type GroundedPortableSummarizerOpener,
} from "../grounded-compaction/portable-summarizer.ts";
import {
    PORTABLE_SUMMARY_CUSTOM_TYPE,
    canonicalJson,
    fingerprintBranchRootCoverage,
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
    type PortableCheckpointPlan,
    type PortableSummaryRecordV1,
    type PortableSummaryUsage,
} from "./portable-record.ts";
import {
    GROUNDED_PORTABLE_SUMMARIZER_EVENT,
    derivePortablePlan,
    normalizeGroundedPortableSummarizerResponse,
    projectPortableTail,
    registerCodexCompactionPortability,
} from "./portability.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const CHECKPOINT_FINGERPRINT_DOMAIN = "pi-codex-compaction:checkpoint:v1";
const UUIDS = [
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-4000-8000-000000000002",
    "00000000-0000-4000-8000-000000000003",
    "00000000-0000-4000-8000-000000000004",
    "00000000-0000-4000-8000-000000000005",
    "00000000-0000-4000-8000-000000000006",
];

type Hook = (event: any, context: any) => Promise<any> | any;
type SummaryRequest = {
    previousSummary: string | null;
    sourceText: string;
    startOffset: number;
    coverageEntries: readonly SessionEntry[];
    signal: AbortSignal;
};

class TestEventBus {
    private readonly emitter = new EventEmitter();

    on(eventName: string, listener: (payload: unknown) => void): () => void {
        this.emitter.on(eventName, listener);
        return () => this.emitter.off(eventName, listener);
    }

    emit(eventName: string, payload: unknown): void {
        this.emitter.emit(eventName, payload);
    }
}

function userEntry(id: string, text: string, parentId: string | null = null): SessionEntry {
    return {
        type: "message",
        id,
        parentId,
        timestamp: "2026-07-24T00:00:00.000Z",
        message: {
            role: "user",
            content: [{ type: "text", text }],
            timestamp: 1,
        },
    } as SessionEntry;
}

function assistantEntry(id: string, text: string, parentId: string | null): SessionEntry {
    return {
        type: "message",
        id,
        parentId,
        timestamp: "2026-07-24T00:00:01.000Z",
        message: {
            role: "assistant",
            content: [{ type: "text", text }],
            api: "anthropic-messages",
            provider: "anthropic",
            model: "claude-test",
            usage: {
                input: 1,
                output: 1,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 2,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: 2,
        },
    } as SessionEntry;
}

function nativeDetails(model = "gpt-test"): Record<string, unknown> {
    return {
        strategy: "openai-responses-compaction-v2",
        provider: "openai-codex",
        api: "openai-codex-responses",
        model,
        baseUrl: "https://chatgpt.com/backend-api",
        compactedWindow: [{ type: "compaction_summary", encrypted_content: "sealed" }],
        createdAt: "2026-07-24T00:00:02.000Z",
    };
}

function checkpointEntry(
    id: string,
    parentId: string | null,
    details: unknown = nativeDetails(),
): SessionEntry {
    return {
        type: "compaction",
        id,
        parentId,
        timestamp: "2026-07-24T00:00:02.000Z",
        summary: "[OpenAI native compaction checkpoint]",
        firstKeptEntryId: parentId ?? id,
        tokensBefore: 12_345,
        details,
    } as SessionEntry;
}

function displayEntry(id: string, parentId: string): SessionEntry {
    return {
        type: "custom",
        id,
        parentId,
        timestamp: "2026-07-24T00:00:02.500Z",
        customType: "codex-native-compaction-display",
        data: { content: "display metadata" },
    } as SessionEntry;
}

function plaintextEntry(
    id: string,
    parentId: string | null,
    firstKeptEntryId: string,
    summary: string,
): SessionEntry {
    return {
        type: "compaction",
        id,
        parentId,
        timestamp: "2026-07-24T00:00:03.000Z",
        summary,
        firstKeptEntryId,
        tokensBefore: 100,
    } as SessionEntry;
}

function descriptor(
    entryId: string,
    entryIndex: number,
    rawDetails: unknown = nativeDetails(),
) {
    return {
        entryId,
        entryIndex,
        storage: "pi-compaction" as const,
        modelKey: "openai-codex:openai-codex-responses:gpt-test",
        checkpointFingerprint: hashPortableValue(CHECKPOINT_FINGERPRINT_DOMAIN, rawDetails),
        tokensBefore: 12_345,
    };
}

function branchRoot(): PortableBaselineProof {
    return {
        kind: "branch-root",
        summary: null,
        coverageFingerprint: fingerprintBranchRootCoverage(),
    };
}

function checkpointPlan(entryId: string, sourceText: string, entries: unknown[] = []): PortableCheckpointPlan {
    return {
        checkpoint: {
            entryId,
            storage: "inline-custom",
            modelKey: "model-key",
            checkpointFingerprint: HASH_A,
        },
        range: {
            firstEntryId: entries.length > 0 ? "first" : null,
            lastEntryId: entries.length > 0 ? "last" : null,
            entryCount: entries.length,
            entriesFingerprint: fingerprintPortableEntries(entries),
            transcriptLength: sourceText.length,
            transcriptFingerprint: fingerprintPortableTranscript(sourceText),
        },
        sourceText,
    };
}

const PROVENANCE = {
    provider: "anthropic",
    api: "anthropic-messages",
    modelId: "claude-test",
    thinkingLevel: "high" as const,
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    promptFingerprint: HASH_B,
};

function recordFor(params: {
    recordId: string;
    checkpoint: PortableCheckpointPlan;
    predecessorChain?: PortableChain;
    baseline?: PortableBaselineProof;
    startOffset: number;
    endOffset: number;
    summary: string | null;
    carry?: boolean;
}): PortableSummaryRecordV1 {
    const baseline = params.baseline ?? branchRoot();
    const chain = params.predecessorChain;
    const predecessor = chain?.tip
        ? {
            kind: "portable-record" as const,
            recordId: chain.tip.record.recordId,
            summaryFingerprint: fingerprintPortableSummary(chain.tip.record.summary),
            coverageFingerprint: chain.tip.record.coverageFingerprint,
        }
        : baseline.kind === "branch-root"
            ? { kind: "branch-root" as const, coverageFingerprint: baseline.coverageFingerprint }
            : {
                kind: "plaintext-compaction" as const,
                entryId: baseline.entryId,
                firstKeptEntryId: baseline.firstKeptEntryId,
                summaryFingerprint: baseline.summaryFingerprint,
                coverageFingerprint: baseline.coverageFingerprint,
            };
    const predecessorCoverageFingerprint = chain?.coverageFingerprint ?? baseline.coverageFingerprint;
    return parsePortableSummaryRecord({
        kind: PORTABLE_SUMMARY_CUSTOM_TYPE,
        version: 1,
        recordId: params.recordId,
        predecessor,
        checkpoint: params.checkpoint.checkpoint,
        range: params.checkpoint.range,
        state: params.endOffset === params.checkpoint.sourceText.length ? "complete" : "partial",
        endOffset: params.endOffset,
        coverageFingerprint: fingerprintPortableCoverage({
            predecessorCoverageFingerprint,
            checkpoint: params.checkpoint.checkpoint,
            range: params.checkpoint.range,
            endOffset: params.endOffset,
        }),
        summary: params.summary,
        step: params.carry
            ? {
                kind: "carry-forward",
                startOffset: 0,
                chunkFingerprint: fingerprintPortableChunk(""),
            }
            : {
                kind: "summary-call",
                startOffset: params.startOffset,
                chunkFingerprint: fingerprintPortableChunk(
                    params.checkpoint.sourceText.slice(params.startOffset, params.endOffset),
                ),
                summarizer: PROVENANCE,
                usage: null,
            },
    });
}

function source(entryId: string, record: unknown, activePosition: number | null = null) {
    return {
        entryId,
        data: record,
        activePosition,
        relevantIfMalformed: activePosition !== null,
    };
}

function chainFor(
    records: Array<{ entryId: string; record: PortableSummaryRecordV1; activePosition?: number | null }>,
    checkpoints: PortableCheckpointPlan[],
    baseline = branchRoot(),
): PortableChain {
    return selectBestPortableChain({
        sources: records.map((candidate) =>
            source(candidate.entryId, candidate.record, candidate.activePosition ?? null)),
        baseline,
        checkpoints,
    });
}

describe("portable record v1 trust boundary", () => {
    it("canonicalizes keys, separates hash domains, and strictly parses valid records", () => {
        assert.equal(canonicalJson({ z: 1, a: { y: 2, x: 3 } }), '{"a":{"x":3,"y":2},"z":1}');
        assert.equal(hashPortableValue("domain", { b: 2, a: 1 }), hashPortableValue("domain", { a: 1, b: 2 }));
        assert.notEqual(fingerprintPortableSummary("same"), fingerprintPortableTranscript("same"));

        const plan = checkpointPlan("checkpoint", "source", [{ id: "entry" }]);
        const record = recordFor({
            recordId: UUIDS[0]!,
            checkpoint: plan,
            startOffset: 0,
            endOffset: plan.sourceText.length,
            summary: "summary",
        });
        assert.equal(parsePortableSummaryRecord(record).recordId, UUIDS[0]);
    });

    it("parses summarizer provenance and usage without constructing a full portable record", () => {
        const usage: PortableSummaryUsage = {
            input: 10,
            output: 4,
            cacheRead: 2,
            cacheWrite: 1,
            totalTokens: 17,
            cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
        };
        assert.deepEqual(parsePortableSummarizerProvenance(PROVENANCE), PROVENANCE);
        assert.deepEqual(parsePortableSummaryUsage(usage), usage);
        assert.throws(() => parsePortableSummarizerProvenance({ ...PROVENANCE, provider: "" }));
        assert.throws(() => parsePortableSummaryUsage({ ...usage, input: -1 }));
    });

    it("rejects unknown fields, unsupported versions, invalid UUIDs, offsets, usage, and carry state", () => {
        const plan = checkpointPlan("checkpoint", "source", [{ id: "entry" }]);
        const record = recordFor({
            recordId: UUIDS[0]!,
            checkpoint: plan,
            startOffset: 0,
            endOffset: plan.sourceText.length,
            summary: "summary",
        });
        for (const invalid of [
            { ...record, extra: true },
            { ...record, version: 2 },
            { ...record, recordId: "not-a-uuid" },
            { ...record, state: "partial" },
            { ...record, endOffset: plan.sourceText.length + 1 },
            { ...record, summary: "   " },
            {
                ...record,
                step: {
                    ...record.step,
                    usage: {
                        input: -1,
                        output: 0,
                        cacheRead: 0,
                        cacheWrite: 0,
                        totalTokens: 0,
                        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                    },
                },
            },
        ]) {
            assert.throws(() => parsePortableSummaryRecord(invalid));
        }
        assert.throws(() => parsePortableSummaryRecord({
            ...record,
            range: { ...record.range, transcriptLength: 0 },
            endOffset: 0,
            summary: null,
            step: { kind: "carry-forward", startOffset: 0, chunkFingerprint: HASH_A },
        }));
    });

    it("validates contiguous chronological chains and cumulative empty-range carry-forward", () => {
        const firstPlan = checkpointPlan("checkpoint-1", "abcdef", [{ id: "first" }]);
        const secondPlan = checkpointPlan("checkpoint-2", "");
        const firstPartial = recordFor({
            recordId: UUIDS[0]!,
            checkpoint: firstPlan,
            startOffset: 0,
            endOffset: 3,
            summary: "partial",
        });
        const partialChain = chainFor([{ entryId: "record-1", record: firstPartial }], [firstPlan, secondPlan]);
        const firstComplete = recordFor({
            recordId: UUIDS[1]!,
            checkpoint: firstPlan,
            predecessorChain: partialChain,
            startOffset: 3,
            endOffset: 6,
            summary: "complete",
        });
        const completeChain = chainFor([
            { entryId: "record-1", record: firstPartial },
            { entryId: "record-2", record: firstComplete },
        ], [firstPlan, secondPlan]);
        const carry = recordFor({
            recordId: UUIDS[2]!,
            checkpoint: secondPlan,
            predecessorChain: completeChain,
            startOffset: 0,
            endOffset: 0,
            summary: "complete",
            carry: true,
        });
        const chain = chainFor([
            { entryId: "record-1", record: firstPartial },
            { entryId: "record-2", record: firstComplete },
            { entryId: "record-3", record: carry },
        ], [firstPlan, secondPlan]);
        assert.equal(chain.tip?.record.recordId, UUIDS[2]);
        assert.equal(chain.completedCheckpoints, 2);
        assert.equal(chain.partialOffset, 0);
        assert.equal(chain.summary, "complete");
        assert.equal(chain.coverageFingerprint, carry.coverageFingerprint);
    });

    it("ranks by completed checkpoints, partial offset, active position, then record ID", () => {
        const plan = checkpointPlan("checkpoint", "abcdefgh", [{ id: "first" }]);
        const shorterActive = recordFor({
            recordId: UUIDS[3]!,
            checkpoint: plan,
            startOffset: 0,
            endOffset: 3,
            summary: "shorter",
        });
        const longerOffBranch = recordFor({
            recordId: UUIDS[2]!,
            checkpoint: plan,
            startOffset: 0,
            endOffset: 5,
            summary: "longer",
        });
        let chain = chainFor([
            { entryId: "active", record: shorterActive, activePosition: 20 },
            { entryId: "off", record: longerOffBranch },
        ], [plan]);
        assert.equal(chain.tip?.record.recordId, longerOffBranch.recordId);

        const sameOffsetActive = recordFor({
            recordId: UUIDS[1]!,
            checkpoint: plan,
            startOffset: 0,
            endOffset: 5,
            summary: "active",
        });
        chain = chainFor([
            { entryId: "off", record: longerOffBranch },
            { entryId: "active", record: sameOffsetActive, activePosition: 12 },
        ], [plan]);
        assert.equal(chain.tip?.record.recordId, sameOffsetActive.recordId);

        const lexicographicallySmall = recordFor({
            recordId: UUIDS[0]!,
            checkpoint: plan,
            startOffset: 0,
            endOffset: 5,
            summary: "lexical",
        });
        chain = chainFor([
            { entryId: "larger", record: longerOffBranch },
            { entryId: "smaller", record: lexicographicallySmall },
        ], [plan]);
        assert.equal(chain.tip?.record.recordId, lexicographicallySmall.recordId);
    });

    it("blocks malformed active records but ignores malformed and divergent off-branch facts", () => {
        const plan = checkpointPlan("checkpoint", "source", [{ id: "first" }]);
        assert.throws(() => selectBestPortableChain({
            sources: [source("active-malformed", { version: 99 }, 4)],
            baseline: branchRoot(),
            checkpoints: [plan],
        }), (error) => {
            assert.equal(error instanceof MalformedPortableRecordError, true);
            assert.equal((error as MalformedPortableRecordError).recordEntryId, "active-malformed");
            return true;
        });
        assert.equal(selectBestPortableChain({
            sources: [source("off-malformed", { version: 99 })],
            baseline: branchRoot(),
            checkpoints: [plan],
        }).tip, null);

        const divergent = recordFor({
            recordId: UUIDS[0]!,
            checkpoint: { ...plan, range: { ...plan.range, entriesFingerprint: HASH_B } },
            startOffset: 0,
            endOffset: plan.sourceText.length,
            summary: "summary",
        });
        assert.equal(chainFor([{ entryId: "off-divergent", record: divergent }], [plan]).tip, null);
        assert.throws(() => chainFor([
            { entryId: "active-divergent", record: divergent, activePosition: 5 },
        ], [plan]), /range proof/);
    });

    it("rejects duplicate IDs, cycles, skipped checkpoints, and mismatched predecessor proofs", () => {
        const firstPlan = checkpointPlan("checkpoint-1", "a", [{ id: "first" }]);
        const secondPlan = checkpointPlan("checkpoint-2", "b", [{ id: "second" }]);
        const first = recordFor({
            recordId: UUIDS[0]!,
            checkpoint: firstPlan,
            startOffset: 0,
            endOffset: 1,
            summary: "first",
        });
        assert.throws(() => chainFor([
            { entryId: "duplicate-a", record: first, activePosition: 1 },
            { entryId: "duplicate-b", record: first },
        ], [firstPlan]), /duplicated/);
        const skipped = recordFor({
            recordId: UUIDS[1]!,
            checkpoint: secondPlan,
            startOffset: 0,
            endOffset: 1,
            summary: "skipped",
        });
        assert.throws(() => chainFor([
            { entryId: "skipped", record: skipped, activePosition: 2 },
        ], [firstPlan, secondPlan]), /baseline predecessor/);

        const cyclicBase = {
            ...first,
            predecessor: {
                kind: "portable-record" as const,
                recordId: UUIDS[2]!,
                summaryFingerprint: HASH_A,
                coverageFingerprint: HASH_A,
            },
        };
        const cyclicNext = {
            ...first,
            recordId: UUIDS[2]!,
            predecessor: {
                kind: "portable-record" as const,
                recordId: UUIDS[0]!,
                summaryFingerprint: HASH_A,
                coverageFingerprint: HASH_A,
            },
        };
        assert.throws(() => selectBestPortableChain({
            sources: [
                source("cycle-a", cyclicBase, 1),
                source("cycle-b", cyclicNext, 2),
            ],
            baseline: branchRoot(),
            checkpoints: [firstPlan],
        }), /cycle/);

        const wrongPredecessor = {
            ...first,
            predecessor: { kind: "branch-root" as const, coverageFingerprint: HASH_B },
        };
        assert.throws(() => selectBestPortableChain({
            sources: [source("wrong-predecessor", wrongPredecessor, 1)],
            baseline: branchRoot(),
            checkpoints: [firstPlan],
        }), /baseline predecessor/);
    });
});

type HarnessOptions = {
    branch: SessionEntry[];
    grounded?: "available" | "unavailable" | "error" | "malformed";
    groundedOpenSession?: GroundedPortableSummarizerOpener;
    summarize?: (request: SummaryRequest, callIndex: number) => Promise<{
        summary: string;
        endOffset: number;
        usage: PortableSummaryUsage | null;
    }>;
    appendFailure?: Error;
    omitAppend?: boolean;
    onAppend?: (record: PortableSummaryRecordV1) => void;
};

function createHarness(options: HarnessOptions) {
    const bus = new TestEventBus();
    const hooks = new Map<string, Hook[]>();
    let branch = [...options.branch];
    let entries = [...options.branch];
    let sessionId = "session-1";
    let cwd = "/repo";
    const defaultModel = {
        id: "claude-test",
        name: "Claude Test",
        provider: "anthropic",
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        reasoning: true,
        input: ["text"],
        contextWindow: 200_000,
        maxTokens: 16_384,
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    };
    let model: typeof defaultModel | undefined = defaultModel;
    let activeController = new AbortController();
    let appendedEntryId = 0;
    let uuidIndex = 0;
    let branchClones = 0;
    let entryReads = 0;
    let groundedQueries = 0;
    let groundedBranchEntries: readonly SessionEntry[] = [];
    let openCalls = 0;
    let summaryCalls = 0;
    let derivedPlans = 0;
    let entryFingerprints = 0;
    let prefixHashes = 0;
    let portableRecordValidations = 0;
    let abortCalls = 0;
    let providerDispatches = 0;
    const notices: Array<{ message: string; level: string }> = [];
    const summaryRequests: SummaryRequest[] = [];
    const pi = {
        events: bus,
        on(eventName: string, hook: Hook) {
            hooks.set(eventName, [...(hooks.get(eventName) ?? []), hook]);
        },
        appendEntry(customType: string, data: unknown) {
            if (options.appendFailure) throw options.appendFailure;
            if (options.omitAppend) return;
            const entry = {
                type: "custom",
                id: `portable-entry-${++appendedEntryId}`,
                parentId: branch.at(-1)?.id ?? null,
                timestamp: new Date(1_750_000_000_000 + appendedEntryId).toISOString(),
                customType,
                data,
            } as SessionEntry;
            branch = [...branch, entry];
            entries = [...entries, entry];
            options.onAppend?.(parsePortableSummaryRecord(data));
        },
    } as unknown as ExtensionAPI;

    registerCodexCompactionPortability(pi, {
        now: () => 1_750_000_000_000,
        randomUUID: () => UUIDS[uuidIndex++] ?? `00000000-0000-4000-8000-${String(uuidIndex).padStart(12, "0")}`,
        cloneBranch: (value) => {
            branchClones += 1;
            return structuredClone(value) as SessionEntry[];
        },
        onPlanDerived: () => { derivedPlans += 1; },
        onEntryFingerprint: () => { entryFingerprints += 1; },
        onPrefixHash: () => { prefixHashes += 1; },
        onPortableRecordValidation: () => { portableRecordValidations += 1; },
    });
    bus.on(GROUNDED_PORTABLE_SUMMARIZER_EVENT, (payload) => {
        groundedQueries += 1;
        groundedBranchEntries = (payload as { branchEntries: readonly SessionEntry[] }).branchEntries;
    });
    if (options.groundedOpenSession) {
        registerGroundedPortableSummarizer(pi, options.groundedOpenSession);
    } else {
        bus.on(GROUNDED_PORTABLE_SUMMARIZER_EVENT, (payload) => {
            const query = payload as { response: unknown };
            if (options.grounded === "unavailable") return;
            if (options.grounded === "error") {
                query.response = { status: "error", error: "configured summarizer failed" };
                return;
            }
            if (options.grounded === "malformed") {
                query.response = { status: "available", openSession: "not-a-function" };
                return;
            }
            query.response = {
                status: "available",
                openSession: async () => {
                    openCalls += 1;
                    return {
                        descriptor: PROVENANCE,
                        summarizeNext: async (request: SummaryRequest) => {
                            const callIndex = summaryCalls++;
                            summaryRequests.push(request);
                            return options.summarize
                                ? options.summarize(request, callIndex)
                                : {
                                    summary: `summary-${callIndex + 1}`,
                                    endOffset: request.sourceText.length,
                                    usage: null,
                                };
                        },
                    };
                },
            };
        });
    }

    const context = (controller = activeController) => ({
        cwd,
        model,
        signal: controller.signal,
        abort() {
            abortCalls += 1;
            controller.abort();
        },
        hasUI: true,
        ui: {
            notify(message: string, level: string) {
                notices.push({ message, level });
            },
        },
        modelRegistry: {
            getAll: () => model ? [model] : [],
            getProvider: (provider: string) => (
                model?.provider === provider ? { id: provider, name: provider } as Provider : undefined
            ),
            getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }),
        },
        sessionManager: {
            getSessionId: () => sessionId,
            getBranch: () => branch,
            getEntries: () => {
                entryReads += 1;
                return entries;
            },
            getLeafId: () => branch.at(-1)?.id,
        },
    });

    const transformContext = async (
        eventMessages: any[] = [],
        controller = activeController,
    ) => {
        let messages = eventMessages;
        let result: any;
        for (const hook of hooks.get("context") ?? []) {
            const candidate = await hook({ messages }, context(controller));
            if (candidate?.messages) messages = candidate.messages;
            if (candidate !== undefined) result = candidate;
        }
        return result;
    };

    return {
        bus,
        hooks,
        context,
        notices,
        summaryRequests,
        get branch() { return branch; },
        get entries() { return entries; },
        get branchClones() { return branchClones; },
        get entryReads() { return entryReads; },
        get groundedQueries() { return groundedQueries; },
        get groundedBranchEntries() { return groundedBranchEntries; },
        get openCalls() { return openCalls; },
        get summaryCalls() { return summaryCalls; },
        get derivedPlans() { return derivedPlans; },
        get entryFingerprints() { return entryFingerprints; },
        get prefixHashes() { return prefixHashes; },
        get portableRecordValidations() { return portableRecordValidations; },
        get abortCalls() { return abortCalls; },
        get providerDispatches() { return providerDispatches; },
        setBranch(next: SessionEntry[]) { branch = next; },
        setEntries(next: SessionEntry[]) { entries = next; },
        setSessionId(next: string) { sessionId = next; },
        setCwd(next: string) { cwd = next; },
        setModel(next: typeof model) { model = next; },
        resetSignal() { activeController = new AbortController(); },
        abort() { activeController.abort(); },
        runContext: transformContext,
        runContextWithController(controller: AbortController, eventMessages: any[] = []) {
            return transformContext(eventMessages, controller);
        },
        async runProviderBoundary(eventMessages: any[] = []) {
            const contextResult = await transformContext(eventMessages);
            if (activeController.signal.aborted) {
                return { contextResult, providerDispatched: false };
            }
            providerDispatches += 1;
            return { contextResult, providerDispatched: true };
        },
        async runProviderBoundaryWithController(controller: AbortController, eventMessages: any[] = []) {
            const contextResult = await transformContext(eventMessages, controller);
            if (controller.signal.aborted) {
                return { contextResult, providerDispatched: false };
            }
            providerDispatches += 1;
            return { contextResult, providerDispatched: true };
        },
        async lifecycle(eventName: string) {
            for (const hook of hooks.get(eventName) ?? []) {
                await hook({ type: eventName }, context());
            }
        },
    };
}

async function withoutConsoleError<T>(action: () => Promise<T>): Promise<T> {
    const original = console.error;
    console.error = () => undefined;
    try {
        return await action();
    } finally {
        console.error = original;
    }
}

function basicBranch(): SessionEntry[] {
    const user = userEntry("user-1", "remember alpha");
    const checkpoint = checkpointEntry("checkpoint-1", user.id);
    const tail = userEntry("tail-1", "visible tail", checkpoint.id);
    return [user, checkpoint, tail];
}

describe("portable protocol normalization and branch projection", () => {
    it("rejects malformed grounded participant responses", () => {
        assert.equal(normalizeGroundedPortableSummarizerResponse({
            status: "available",
            openSession: "invalid",
        }).status, "error");
    });

    it("rejects duplicate and out-of-order checkpoints at authoritative branch revalidation", () => {
        const branch = basicBranch();
        const duplicateResponse = {
            status: "available",
            baseline: { kind: "branch-root" },
            checkpoints: [descriptor(branch[1]!.id, 1), descriptor(branch[1]!.id, 1)],
        } as const;
        assert.throws(() => derivePortablePlan(branch, duplicateResponse), /strictly ordered and unique/);

        const between = userEntry("between", "between", branch[1]!.id);
        const secondCheckpoint = checkpointEntry("checkpoint-2", between.id);
        const extendedBranch = [...branch.slice(0, 2), between, secondCheckpoint];
        assert.throws(() => derivePortablePlan(extendedBranch, {
            status: "available",
            baseline: { kind: "branch-root" },
            checkpoints: [descriptor(secondCheckpoint.id, 3), descriptor(branch[1]!.id, 1)],
        }), /strictly ordered and unique/);
    });

    it("requires an own checkpoint ID during authoritative revalidation", () => {
        const branch = basicBranch();
        const checkpoint = branch[1]!;
        delete (checkpoint as unknown as Record<string, unknown>).id;
        Object.defineProperty(Object.prototype, "id", {
            value: "checkpoint-1",
            configurable: true,
            writable: true,
        });
        try {
            assert.throws(() => derivePortablePlan(branch, {
                status: "available",
                baseline: { kind: "branch-root" },
                checkpoints: [descriptor("checkpoint-1", 1)],
            }), /does not match the active branch/);
        } finally {
            delete (Object.prototype as Record<string, unknown>).id;
        }
    });

    it("rejects inherited source IDs before locating a plaintext kept boundary", () => {
        const discarded = userEntry("discarded", "discarded");
        const inheritedMatch = userEntry("inherited-match", "must remain discarded", discarded.id);
        delete (inheritedMatch as unknown as Record<string, unknown>).id;
        const kept = userEntry("kept", "kept", discarded.id);
        const baseline = plaintextEntry("baseline", kept.id, kept.id, "persisted baseline");
        const checkpoint = checkpointEntry("checkpoint", baseline.id);
        const branch = [discarded, inheritedMatch, kept, baseline, checkpoint];
        Object.defineProperty(Object.prototype, "id", {
            value: kept.id,
            configurable: true,
            writable: true,
        });
        try {
            assert.throws(() => derivePortablePlan(branch, {
                status: "available",
                baseline: {
                    kind: "plaintext-compaction",
                    entryId: baseline.id,
                    entryIndex: 3,
                    firstKeptEntryId: kept.id,
                },
                checkpoints: [descriptor(checkpoint.id, 4)],
            }), /invalid identity/);
        } finally {
            delete (Object.prototype as Record<string, unknown>).id;
        }
    });

    it("derives plaintext kept ranges and exact tail messages without portable or compaction entries", () => {
        const discarded = userEntry("discarded", "discarded");
        const kept = userEntry("kept", "kept", discarded.id);
        const baseline = plaintextEntry("baseline", kept.id, kept.id, "persisted baseline");
        const checkpoint = checkpointEntry("checkpoint", baseline.id);
        const tailCompaction = plaintextEntry("tail-compaction", checkpoint.id, kept.id, "ignored tail summary");
        const tail = assistantEntry("tail", "tail answer", tailCompaction.id);
        const portable = {
            type: "custom",
            id: "portable",
            parentId: tail.id,
            timestamp: "2026-07-24T00:00:05.000Z",
            customType: PORTABLE_SUMMARY_CUSTOM_TYPE,
            data: {},
        } as SessionEntry;
        const branch = [discarded, kept, baseline, checkpoint, tailCompaction, tail, portable];
        const plan = derivePortablePlan(branch, {
            status: "available",
            baseline: {
                kind: "plaintext-compaction",
                entryId: baseline.id,
                entryIndex: 2,
                firstKeptEntryId: kept.id,
            },
            checkpoints: [descriptor(checkpoint.id, 3)],
        });
        assert.equal(plan.baseline.summary, "persisted baseline");
        assert.equal(plan.checkpoints[0]!.range.firstEntryId, kept.id);
        assert.equal(plan.checkpoints[0]!.range.lastEntryId, kept.id);
        assert.deepEqual(plan.checkpoints[0]!.coverageEntries.map((entry) => entry.id), [discarded.id, kept.id]);
        const projected = projectPortableTail(branch, plan);
        assert.equal(projected.length, 1);
        assert.equal(projected[0]!.role, "assistant");
    });

    it("excludes conversion display metadata and projects descendant parent identity through it", () => {
        const user = userEntry("user", "first source");
        const firstCheckpoint = checkpointEntry("checkpoint-1", user.id);
        const firstDisplay = displayEntry("display-1", firstCheckpoint.id);
        const between = userEntry("between", "second source", firstDisplay.id);
        const secondCheckpoint = checkpointEntry("checkpoint-2", between.id);
        const secondDisplay = displayEntry("display-2", secondCheckpoint.id);
        const tail = userEntry("tail", "visible tail", secondDisplay.id);
        const branch = [user, firstCheckpoint, firstDisplay, between, secondCheckpoint, secondDisplay, tail];
        const plan = derivePortablePlan(branch, {
            status: "available",
            baseline: { kind: "branch-root" },
            checkpoints: [
                descriptor(firstCheckpoint.id, 1),
                descriptor(secondCheckpoint.id, 4),
            ],
        });

        const secondRange = plan.checkpoints[1]!;
        assert.equal(secondRange.range.entryCount, 1);
        assert.equal(secondRange.range.firstEntryId, between.id);
        assert.equal(
            secondRange.range.entriesFingerprint,
            fingerprintPortableEntries([{ ...between, parentId: firstCheckpoint.id }]),
        );
        assert.deepEqual(secondRange.coverageEntries.map((entry) => entry.id), [user.id, between.id]);
        assert.deepEqual(projectPortableTail(branch, plan).map((message) => message.role), ["user"]);
    });

    it("rejects index drift before projecting a tail from an inherited ID match", () => {
        const inheritedMatch = userEntry("inherited-match", "must not become tail");
        delete (inheritedMatch as unknown as Record<string, unknown>).id;
        const source = userEntry("source", "source");
        const checkpoint = checkpointEntry("checkpoint", source.id);
        const tail = userEntry("tail", "visible tail", checkpoint.id);
        const branch = [source, checkpoint, tail];
        const plan = derivePortablePlan(branch, {
            status: "available",
            baseline: { kind: "branch-root" },
            checkpoints: [descriptor(checkpoint.id, 1)],
        });
        const driftedBranch = [inheritedMatch, ...branch];
        Object.defineProperty(Object.prototype, "id", {
            value: checkpoint.id,
            configurable: true,
            writable: true,
        });
        try {
            assert.throws(
                () => projectPortableTail(driftedBranch, plan),
                /no longer contains the covered native checkpoint/,
            );
        } finally {
            delete (Object.prototype as Record<string, unknown>).id;
        }
    });
});

describe("coordinator lazy portability orchestration", () => {
    it("bypasses canonical Codex, missing models, and empty native epochs", async () => {
        const harness = createHarness({ branch: basicBranch() });
        const activeModel = harness.context().model;
        if (!activeModel) throw new Error("Expected the test model");
        const codex = {
            ...activeModel,
            provider: "openai-codex",
            api: "openai-codex-responses",
        };
        harness.setModel(undefined);
        assert.equal(await harness.runContext([{ role: "user" }]), undefined);
        assert.equal(harness.branchClones, 0);
        harness.setModel(codex);
        assert.equal(await harness.runContext([{ role: "user" }]), undefined);
        assert.equal(harness.branchClones, 0);

        const empty = createHarness({ branch: [userEntry("only-user", "no native checkpoint")] });
        empty.setModel({ ...codex, provider: "OpenAI-Codex" });
        assert.equal(await empty.runContext([{ role: "user" }]), undefined);
        assert.equal(empty.groundedQueries, 0);
    });

    it("clones only after a native epoch contains checkpoints", async () => {
        const empty = createHarness({ branch: [userEntry("only-user", "no native checkpoint")] });
        assert.equal(await empty.runContext(), undefined);
        assert.equal(empty.branchClones, 0);
        assert.equal(empty.entryReads, 0);
        assert.equal(empty.groundedQueries, 0);

        const realEpoch = createHarness({ branch: basicBranch() });
        const result = await realEpoch.runContext();
        assert.equal(result.messages[0].role, "compactionSummary");
        assert.equal(realEpoch.branchClones > 0, true);
    });

    it("does not expose native compacted windows to lazy grounded discovery", async () => {
        const harness = createHarness({ branch: basicBranch() });
        await harness.runContext();

        assert.deepEqual(harness.groundedBranchEntries.map((entry) => entry.id), ["user-1", "tail-1"]);
        assert.equal(JSON.stringify(harness.groundedBranchEntries).includes("sealed"), false);
    });

    it("fails closed before grounded discovery for malformed active native details", async () => {
        const user = userEntry("user", "must not leak");
        const checkpoint = checkpointEntry("checkpoint", user.id, { secret: "native-secret-sentinel" });
        const harness = createHarness({ branch: [user, checkpoint] });

        await withoutConsoleError(async () => {
            const result = await harness.runContext([{ role: "user", content: "must not leak" }]);
            assert.deepEqual(result.messages, []);
        });
        assert.equal(harness.groundedQueries, 0);
        assert.equal(harness.summaryCalls, 0);
        assert.equal(harness.branch.some((entry) => entry.type === "custom"
            && entry.customType === PORTABLE_SUMMARY_CUSTOM_TYPE), false);
        assert.equal(harness.notices.some((notice) => notice.level === "error"), true);
    });

    it("fails closed before grounded discovery for a missing own checkpoint ID", async () => {
        const branch = basicBranch().slice(0, 2);
        delete (branch[1] as unknown as Record<string, unknown>).id;
        const harness = createHarness({ branch });

        await withoutConsoleError(async () => {
            const result = await harness.runContext([{ role: "user", content: "must not leak" }]);
            assert.deepEqual(result.messages, []);
        });
        assert.equal(harness.groundedQueries, 0);
        assert.equal(harness.summaryCalls, 0);
        assert.equal(harness.abortCalls, 1);
        assert.equal(harness.branch.some((entry) => entry.type === "custom"
            && entry.customType === PORTABLE_SUMMARY_CUSTOM_TYPE), false);
    });

    it("rejects portable source entries without own nonblank IDs before grounded discovery", async () => {
        const malformedSources = [
            () => {
                const entry = userEntry("source", "must not leak");
                delete (entry as unknown as Record<string, unknown>).id;
                return entry;
            },
            () => ({ ...userEntry("source", "must not leak"), id: " " }) as SessionEntry,
            () => ({ ...userEntry("source", "must not leak"), id: 1 }) as unknown as SessionEntry,
        ];
        for (const createSource of malformedSources) {
            const source = createSource();
            const harness = createHarness({ branch: [source, checkpointEntry("checkpoint", "source")] });
            await withoutConsoleError(async () => {
                const result = await harness.runContext();
                assert.deepEqual(result.messages, []);
            });
            assert.equal(harness.groundedQueries, 0);
            assert.equal(harness.openCalls, 0);
            assert.equal(harness.summaryCalls, 0);
        }

        const inheritedSource = userEntry("source", "must not leak");
        delete (inheritedSource as unknown as Record<string, unknown>).id;
        Object.defineProperty(Object.prototype, "id", { value: "source", configurable: true });
        try {
            const harness = createHarness({ branch: [inheritedSource, checkpointEntry("checkpoint", "source")] });
            await withoutConsoleError(async () => {
                const result = await harness.runContext();
                assert.deepEqual(result.messages, []);
            });
            assert.equal(harness.groundedQueries, 0);
            assert.equal(harness.summaryCalls, 0);
        } finally {
            delete (Object.prototype as Record<string, unknown>).id;
        }
    });

    it("rejects malformed intermediate source identities before grounded discovery", async () => {
        const first = userEntry("first", "first source");
        const middle = userEntry("middle", "must not leak", first.id);
        delete (middle as unknown as Record<string, unknown>).id;
        const last = userEntry("last", "last source", "middle");
        const harness = createHarness({ branch: [first, middle, last, checkpointEntry("checkpoint", last.id)] });

        await withoutConsoleError(async () => {
            const result = await harness.runContext();
            assert.deepEqual(result.messages, []);
        });
        assert.equal(harness.groundedQueries, 0);
        assert.equal(harness.summaryCalls, 0);
    });

    it("rejects malformed projection metadata identities before grounded discovery", async () => {
        const user = userEntry("user", "first source");
        const firstCheckpoint = checkpointEntry("checkpoint-1", user.id);
        const display = displayEntry("display", firstCheckpoint.id);
        delete (display as unknown as Record<string, unknown>).id;
        const between = userEntry("between", "must not leak", "display");
        const secondCheckpoint = checkpointEntry("checkpoint-2", between.id);
        const harness = createHarness({ branch: [user, firstCheckpoint, display, between, secondCheckpoint] });

        await withoutConsoleError(async () => {
            const result = await harness.runContext();
            assert.deepEqual(result.messages, []);
        });
        assert.equal(harness.groundedQueries, 0);
        assert.equal(harness.summaryCalls, 0);
    });

    it("rejects malformed post-checkpoint source identities before grounded discovery", async () => {
        const source = userEntry("source", "source");
        const checkpoint = checkpointEntry("checkpoint", source.id);
        const tail = userEntry("tail", "must not leak", checkpoint.id);
        delete (tail as unknown as Record<string, unknown>).id;
        const harness = createHarness({ branch: [source, checkpoint, tail] });

        await withoutConsoleError(async () => {
            const result = await harness.runContext();
            assert.deepEqual(result.messages, []);
        });
        assert.equal(harness.groundedQueries, 0);
        assert.equal(harness.openCalls, 0);
        assert.equal(harness.summaryCalls, 0);
    });

    it("rejects malformed live tail drift before durable append", async () => {
        let harness: ReturnType<typeof createHarness>;
        harness = createHarness({
            branch: basicBranch(),
            summarize: async (request) => {
                const malformedTail = userEntry("tail-1", "must not append", "checkpoint-1");
                delete (malformedTail as unknown as Record<string, unknown>).id;
                harness.setBranch([harness.branch[0]!, harness.branch[1]!, malformedTail]);
                return { summary: "paid result", endOffset: request.sourceText.length, usage: null };
            },
        });

        await withoutConsoleError(async () => {
            const result = await harness.runContext();
            assert.deepEqual(result.messages, []);
        });
        assert.equal(harness.summaryCalls, 1);
        assert.equal(harness.branch.some((entry) => entry.type === "custom"
            && entry.customType === PORTABLE_SUMMARY_CUSTOM_TYPE), false);
    });

    it("rejects malformed post-checkpoint source identities during direct projection", () => {
        const branch = basicBranch();
        const plan = derivePortablePlan(branch, {
            status: "available",
            baseline: { kind: "branch-root" },
            checkpoints: [descriptor("checkpoint-1", 1)],
        });
        delete (branch[2] as unknown as Record<string, unknown>).id;

        assert.throws(() => projectPortableTail(branch, plan), /invalid identity/);
    });

    it("rejects inherited metadata IDs before projecting pre-checkpoint history", async () => {
        const inheritedMatch = displayEntry("inherited-match", "root");
        delete (inheritedMatch as unknown as Record<string, unknown>).id;
        const source = userEntry("source", "must not become tail");
        const checkpoint = checkpointEntry("checkpoint-1", source.id);
        const tail = userEntry("tail", "visible tail", checkpoint.id);
        const harness = createHarness({ branch: [inheritedMatch, source, checkpoint, tail] });
        Object.defineProperty(Object.prototype, "id", {
            value: checkpoint.id,
            configurable: true,
            writable: true,
        });
        try {
            await withoutConsoleError(async () => {
                const result = await harness.runContext();
                assert.deepEqual(result.messages, []);
            });
            assert.equal(harness.groundedQueries, 0);
            assert.equal(harness.summaryCalls, 0);
        } finally {
            delete (Object.prototype as Record<string, unknown>).id;
        }
    });

    it("materializes once, persists before injection, emits exact summary plus tail, and reuses silently", async () => {
        const harness = createHarness({ branch: basicBranch() });
        const first = await harness.runContext([{ role: "custom", customType: "native-marker" }]);
        assert.equal(first.messages.length, 2);
        assert.equal(first.messages[0].role, "compactionSummary");
        assert.equal(first.messages[0].summary, "summary-1");
        assert.equal(first.messages[0].timestamp, 1_750_000_000_000);
        assert.equal(first.messages[0].tokensBefore, 12_345);
        assert.equal(first.messages[1].role, "user");
        assert.equal(harness.summaryCalls, 1);
        assert.equal(harness.groundedQueries, 1);
        assert.equal(harness.branch.filter((entry) => entry.type === "custom"
            && entry.customType === PORTABLE_SUMMARY_CUSTOM_TYPE).length, 1);
        assert.deepEqual(harness.notices.map((notice) => notice.level), ["info", "info"]);

        const noticeCount = harness.notices.length;
        const second = await harness.runContext([{ role: "user", content: "ignored event context" }]);
        assert.deepEqual(second.messages, first.messages);
        assert.equal(harness.summaryCalls, 1);
        assert.equal(harness.groundedQueries, 1);
        assert.equal(harness.notices.length, noticeCount);
    });

    it("settles a completed operation before its waiter cleanup can abort the controller", async () => {
        const harness = createHarness({ branch: basicBranch() });
        const result = await harness.runContext();
        assert.equal(result.messages[0].role, "compactionSummary");
        assert.equal(harness.summaryRequests[0]!.signal.aborted, false);
    });

    it("uses Pi checkpoint tokens and persists normalized nested-call usage", async () => {
        const user = userEntry("user", "remember usage");
        const checkpoint = checkpointEntry("pi-checkpoint", user.id);
        const usage = {
            input: 10,
            output: 4,
            cacheRead: 2,
            cacheWrite: 1,
            totalTokens: 17,
            cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
        };
        const harness = createHarness({
            branch: [user, checkpoint],
            summarize: async (request) => ({
                summary: "summary with usage",
                endOffset: request.sourceText.length,
                usage,
            }),
        });
        const result = await harness.runContext();
        assert.equal(result.messages[0].tokensBefore, 12_345);
        const portableEntry = harness.branch.at(-1)!;
        if (portableEntry.type !== "custom") throw new Error("Expected a portable custom entry");
        const record = parsePortableSummaryRecord(portableEntry.data);
        assert.equal(record.step.kind, "summary-call");
        assert.deepEqual(record.step.kind === "summary-call" ? record.step.usage : null, usage);
    });

    it("processes checkpoints and chunks earliest-to-latest with an empty-range carry record", async () => {
        const user = userEntry("user", "abcdef");
        const firstCheckpoint = checkpointEntry("checkpoint-1", user.id);
        const between = userEntry("between", "ghijkl", firstCheckpoint.id);
        const secondCheckpoint = checkpointEntry("checkpoint-2", between.id);
        const thirdCheckpoint = checkpointEntry("checkpoint-3", secondCheckpoint.id);
        const requests: SummaryRequest[] = [];
        const harness = createHarness({
            branch: [user, firstCheckpoint, between, secondCheckpoint, thirdCheckpoint],
            summarize: async (request, callIndex) => {
                requests.push(request);
                const remaining = request.sourceText.length - request.startOffset;
                return {
                    summary: `cumulative-${callIndex + 1}`,
                    endOffset: request.startOffset + Math.max(1, Math.ceil(remaining / 2)),
                    usage: null,
                };
            },
        });
        const result = await harness.runContext();
        assert.equal(result.messages[0].summary, `cumulative-${requests.length}`);
        assert.equal(requests[0]!.startOffset, 0);
        for (let index = 1; index < requests.length; index++) {
            assert.equal(requests[index]!.previousSummary, `cumulative-${index}`);
        }
        const firstCheckpointRequests = requests.filter((request) => request.coverageEntries.length === 1);
        const secondCheckpointRequests = requests.filter((request) => request.coverageEntries.length === 2);
        assert.equal(firstCheckpointRequests.length > 1, true);
        assert.equal(secondCheckpointRequests.length > 1, true);
        assert.equal(firstCheckpointRequests.every((request) => (
            request.coverageEntries === firstCheckpointRequests[0]!.coverageEntries
        )), true);
        assert.equal(secondCheckpointRequests.every((request) => (
            request.coverageEntries === secondCheckpointRequests[0]!.coverageEntries
        )), true);
        assert.notEqual(firstCheckpointRequests[0]!.coverageEntries, secondCheckpointRequests[0]!.coverageEntries);
        assert.deepEqual(
            secondCheckpointRequests[0]!.coverageEntries.map((entry) => entry.id),
            [user.id, between.id],
        );
        const records = harness.branch.filter((entry) =>
            entry.type === "custom" && entry.customType === PORTABLE_SUMMARY_CUSTOM_TYPE);
        assert.equal(records.length, requests.length + 1);
        assert.equal(parsePortableSummaryRecord(records.at(-1)!.data).step.kind, "carry-forward");
        assert.equal(harness.openCalls, 1);
    });

    it("validates many durable chunks with linear work and constant full-entry reads", async () => {
        const user = userEntry("user", "x".repeat(240));
        const checkpoint = checkpointEntry("checkpoint", user.id);
        const harness = createHarness({
            branch: [user, checkpoint],
            summarize: async (request, callIndex) => ({
                summary: `cumulative-${callIndex + 1}`,
                endOffset: Math.min(request.startOffset + 8, request.sourceText.length),
                usage: null,
            }),
        });

        const result = await harness.runContext();
        assert.equal(result.messages[0].role, "compactionSummary");
        assert.equal(harness.summaryCalls >= 20, true);
        assert.equal(harness.branchClones, 1);
        assert.equal(harness.prefixHashes, 1);
        assert.equal(harness.portableRecordValidations, harness.summaryCalls * 2);
        assert.equal(harness.entryReads, 3);
    });

    it("commits a fulfilled paid chunk before honoring last-waiter cancellation", async () => {
        let markStarted!: () => void;
        let resolveSummary!: (result: {
            summary: string;
            endOffset: number;
            usage: PortableSummaryUsage | null;
        }) => void;
        const started = new Promise<void>((resolve) => { markStarted = resolve; });
        const fulfilled = new Promise<{
            summary: string;
            endOffset: number;
            usage: PortableSummaryUsage | null;
        }>((resolve) => { resolveSummary = resolve; });
        let summaryCalls = 0;
        const startOffsets: number[] = [];
        const harness = createHarness({
            branch: basicBranch().slice(0, 2),
            groundedOpenSession: async () => ({
                descriptor: PROVENANCE,
                summarizeNext: (request) => {
                    summaryCalls += 1;
                    startOffsets.push(request.startOffset);
                    if (summaryCalls === 1) {
                        markStarted();
                        return fulfilled;
                    }
                    return Promise.resolve({
                        summary: "resumed-after-fulfilled",
                        endOffset: request.sourceText.length,
                        usage: null,
                    });
                },
            }),
        });
        const controller = new AbortController();
        const first = harness.runContextWithController(controller);
        await started;

        resolveSummary({ summary: "durable-fulfilled", endOffset: 1, usage: null });
        controller.abort();

        assert.deepEqual((await first).messages, []);
        const persistedAfterAbort = harness.branch.filter((entry) =>
            entry.type === "custom" && entry.customType === PORTABLE_SUMMARY_CUSTOM_TYPE);
        assert.equal(persistedAfterAbort.length, 1);
        assert.equal(parsePortableSummaryRecord(persistedAfterAbort[0]!.data).endOffset, 1);
        assert.equal(summaryCalls, 1);
        await Promise.resolve();
        await Promise.resolve();

        const next = await harness.runContextWithController(new AbortController());
        assert.equal(next.messages[0].summary, "resumed-after-fulfilled");
        assert.deepEqual(startOffsets, [0, 1]);
        assert.equal(summaryCalls, 2);
        assert.equal(harness.branch.filter((entry) =>
            entry.type === "custom" && entry.customType === PORTABLE_SUMMARY_CUSTOM_TYPE).length, 2);
    });

    it("applies lifecycle invalidation immediately during commit", async () => {
        let harness: ReturnType<typeof createHarness>;
        harness = createHarness({
            branch: basicBranch().slice(0, 2),
            summarize: async (request) => ({
                summary: "durable-before-lifecycle-stop",
                endOffset: Math.min(request.startOffset + 1, request.sourceText.length),
                usage: null,
            }),
            onAppend: () => { void harness.lifecycle("model_select"); },
        });

        const result = await harness.runProviderBoundary();
        assert.deepEqual(result.contextResult.messages, []);
        assert.equal(result.providerDispatched, false);
        assert.equal(harness.abortCalls, 1);
        assert.equal(harness.summaryCalls, 1);
        assert.equal(harness.branch.filter((entry) =>
            entry.type === "custom" && entry.customType === PORTABLE_SUMMARY_CUSTOM_TYPE).length, 1);
        assert.equal(harness.notices.some((notice) => notice.level === "error"), false);
    });

    it("resumes a durable partial after cancellation without repeating the paid chunk", async () => {
        const branch = basicBranch().slice(0, 2);
        let shouldAbort = true;
        let harness: ReturnType<typeof createHarness>;
        harness = createHarness({
            branch,
            summarize: async (request) => ({
                summary: `offset-${request.startOffset + 1}`,
                endOffset: Math.min(request.startOffset + 1, request.sourceText.length),
                usage: null,
            }),
            onAppend: () => {
                if (!shouldAbort) return;
                shouldAbort = false;
                harness.abort();
            },
        });
        const first = await harness.runContext();
        assert.deepEqual(first.messages, []);
        assert.equal(harness.summaryRequests[0]!.startOffset, 0);
        const persistedAfterAbort = harness.branch.filter((entry) =>
            entry.type === "custom" && entry.customType === PORTABLE_SUMMARY_CUSTOM_TYPE).length;
        assert.equal(persistedAfterAbort, 1);

        harness.resetSignal();
        const result = await harness.runContext();
        assert.equal(result.messages[0].role, "compactionSummary");
        assert.equal(harness.summaryRequests[1]!.startOffset, 1);
    });

    it("reuses a validated sibling record after tree return without grounded discovery", async () => {
        const originalBranch = basicBranch();
        const harness = createHarness({ branch: originalBranch });
        const first = await harness.runContext();
        const allEntries = harness.entries;
        harness.setBranch(originalBranch);
        harness.setEntries(allEntries);
        await harness.lifecycle("session_tree");
        harness.notices.splice(0);
        const reused = await harness.runContext();
        assert.deepEqual(reused.messages, first.messages);
        assert.equal(harness.groundedQueries, 1);
        assert.deepEqual(harness.notices, []);
    });

    it("joins identical operations and cancels lifecycle-invalidated work before append", async () => {
        let resolveSummary!: (value: { summary: string; endOffset: number; usage: null }) => void;
        const summaryPromise = new Promise<{ summary: string; endOffset: number; usage: null }>((resolve) => {
            resolveSummary = resolve;
        });
        const harness = createHarness({
            branch: basicBranch().slice(0, 2),
            summarize: async (request) => summaryPromise.then((result) => ({
                ...result,
                endOffset: request.sourceText.length,
            })),
        });
        const firstController = new AbortController();
        const secondController = new AbortController();
        const logged: unknown[] = [];
        const originalConsoleError = console.error;
        console.error = (...args: unknown[]) => { logged.push(args); };
        try {
            const first = harness.runProviderBoundaryWithController(firstController);
            const second = harness.runProviderBoundaryWithController(secondController);
            await Promise.resolve();
            await Promise.resolve();
            assert.equal(harness.summaryCalls, 1);
            await harness.lifecycle("model_select");
            resolveSummary({ summary: "late", endOffset: 1, usage: null });
            const [firstResult, secondResult] = await Promise.all([first, second]);
            assert.deepEqual(firstResult.contextResult.messages, []);
            assert.deepEqual(secondResult.contextResult.messages, []);
            assert.equal(firstResult.providerDispatched, false);
            assert.equal(secondResult.providerDispatched, false);
        } finally {
            console.error = originalConsoleError;
        }
        assert.equal(firstController.signal.aborted, true);
        assert.equal(secondController.signal.aborted, true);
        assert.equal(harness.abortCalls, 2);
        assert.equal(harness.providerDispatches, 0);
        assert.deepEqual(logged, []);
        assert.equal(harness.branch.some((entry) => entry.type === "custom"
            && entry.customType === PORTABLE_SUMMARY_CUSTOM_TYPE), false);
        assert.equal(harness.notices.some((notice) => notice.level === "error"), false);
    });

    it("cancels identical-operation waiters independently across separate signals", async () => {
        let markStarted!: () => void;
        let resolveSummary!: () => void;
        const started = new Promise<void>((resolve) => { markStarted = resolve; });
        const summaryReady = new Promise<void>((resolve) => { resolveSummary = resolve; });
        const harness = createHarness({
            branch: basicBranch().slice(0, 2),
            summarize: async (request) => {
                markStarted();
                await summaryReady;
                return { summary: "shared", endOffset: request.sourceText.length, usage: null };
            },
        });
        const firstController = new AbortController();
        const secondController = new AbortController();
        const first = harness.runContextWithController(firstController);
        const second = harness.runContextWithController(secondController);
        await started;
        await Promise.resolve();

        firstController.abort();
        assert.deepEqual((await first).messages, []);
        assert.equal(harness.summaryCalls, 1);
        assert.equal(harness.abortCalls, 0);
        assert.equal(harness.branch.some((entry) => entry.type === "custom"
            && entry.customType === PORTABLE_SUMMARY_CUSTOM_TYPE), false);

        resolveSummary();
        const result = await second;
        assert.equal(result.messages[0].summary, "shared");
        assert.equal(harness.branch.filter((entry) => entry.type === "custom"
            && entry.customType === PORTABLE_SUMMARY_CUSTOM_TYPE).length, 1);
        assert.equal(secondController.signal.aborted, false);
    });

    it("retires a held plan before joining callers on a newer checkpoint epoch", async () => {
        let markFirstStarted!: () => void;
        const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
        let activeSummaries = 0;
        let maxActiveSummaries = 0;
        const initialBranch = basicBranch().slice(0, 2);
        const harness = createHarness({
            branch: initialBranch,
            summarize: async (request, callIndex) => {
                activeSummaries += 1;
                maxActiveSummaries = Math.max(maxActiveSummaries, activeSummaries);
                try {
                    if (callIndex === 0) {
                        markFirstStarted();
                        await new Promise<void>((_resolve, reject) => {
                            request.signal.addEventListener("abort", () => {
                                const error = new Error("superseded plan");
                                error.name = "AbortError";
                                reject(error);
                            }, { once: true });
                        });
                    }
                    return {
                        summary: `replacement-${callIndex}`,
                        endOffset: request.sourceText.length,
                        usage: null,
                    };
                } finally {
                    activeSummaries -= 1;
                }
            },
        });

        const firstController = new AbortController();
        const secondController = new AbortController();
        const logged: unknown[] = [];
        const originalConsoleError = console.error;
        console.error = (...args: unknown[]) => { logged.push(args); };
        let firstReplacement!: { messages: AgentMessage[] };
        let secondReplacement!: { messages: AgentMessage[] };
        try {
            const firstSuperseded = harness.runProviderBoundaryWithController(firstController);
            const secondSuperseded = harness.runProviderBoundaryWithController(secondController);
            await firstStarted;
            const between = userEntry("between-checkpoints", "new checkpoint input", initialBranch[1]!.id);
            const nextCheckpoint = checkpointEntry("checkpoint-2", between.id);
            const nextBranch = [...initialBranch, between, nextCheckpoint];
            harness.setBranch(nextBranch);
            harness.setEntries(nextBranch);

            const firstReplacementWaiter = harness.runContext();
            const secondReplacementWaiter = harness.runContext();
            const [firstSupersededResult, secondSupersededResult] = await Promise.all([
                firstSuperseded,
                secondSuperseded,
            ]);
            assert.deepEqual(firstSupersededResult.contextResult.messages, []);
            assert.deepEqual(secondSupersededResult.contextResult.messages, []);
            assert.equal(firstSupersededResult.providerDispatched, false);
            assert.equal(secondSupersededResult.providerDispatched, false);
            [firstReplacement, secondReplacement] = await Promise.all([
                firstReplacementWaiter,
                secondReplacementWaiter,
            ]);
        } finally {
            console.error = originalConsoleError;
        }

        assert.deepEqual(secondReplacement.messages, firstReplacement.messages);
        assert.equal(firstController.signal.aborted, true);
        assert.equal(secondController.signal.aborted, true);
        assert.deepEqual(logged, []);
        assert.equal(harness.summaryCalls, 3);
        assert.equal(harness.openCalls, 2);
        assert.equal(maxActiveSummaries, 1);
        assert.equal(harness.abortCalls, 2);
        assert.equal(harness.providerDispatches, 0);
        assert.equal(harness.branch.filter((entry) => entry.type === "custom"
            && entry.customType === PORTABLE_SUMMARY_CUSTOM_TYPE).length, 2);
        assert.equal(harness.notices.some((notice) => notice.level === "error"), false);
    });

    it("blocks pending work when a native checkpoint or plaintext authority changes the epoch", async () => {
        for (const driftKind of ["native", "plaintext"] as const) {
            let markStarted!: () => void;
            let continueSummary!: () => void;
            const started = new Promise<void>((resolve) => { markStarted = resolve; });
            const resume = new Promise<void>((resolve) => { continueSummary = resolve; });
            const initialBranch = basicBranch().slice(0, 2);
            const harness = createHarness({
                branch: initialBranch,
                summarize: async (request) => {
                    markStarted();
                    await resume;
                    return { summary: "stale", endOffset: request.sourceText.length, usage: null };
                },
            });
            const pending = withoutConsoleError(() => harness.runProviderBoundary());
            await started;
            const authority = driftKind === "native"
                ? checkpointEntry("checkpoint-2", initialBranch.at(-1)!.id)
                : plaintextEntry(
                    "plaintext-authority",
                    initialBranch.at(-1)!.id,
                    initialBranch[0]!.id,
                    "new plaintext authority",
                );
            harness.setBranch([...initialBranch, authority]);
            harness.setEntries([...initialBranch, authority]);
            continueSummary();

            const result = await pending;
            assert.deepEqual(result.contextResult.messages, []);
            assert.equal(result.providerDispatched, false);
            assert.equal(harness.abortCalls, 1);
            assert.equal(harness.branch.some((entry) => entry.type === "custom"
                && entry.customType === PORTABLE_SUMMARY_CUSTOM_TYPE), false);
            assert.equal(harness.notices.some((notice) => notice.level === "error"), true);
        }
    });

    it("blocks injection when the native epoch changes after append", async () => {
        const initialBranch = basicBranch().slice(0, 2);
        let harness: ReturnType<typeof createHarness>;
        harness = createHarness({
            branch: initialBranch,
            onAppend: () => {
                const checkpoint = checkpointEntry("checkpoint-2", harness.branch.at(-1)!.id);
                harness.setBranch([...harness.branch, checkpoint]);
                harness.setEntries([...harness.entries, checkpoint]);
            },
        });

        const result = await withoutConsoleError(() => harness.runProviderBoundary());
        assert.deepEqual(result.contextResult.messages, []);
        assert.equal(result.providerDispatched, false);
        assert.equal(harness.abortCalls, 1);
        assert.equal(harness.branch.filter((entry) => entry.type === "custom"
            && entry.customType === PORTABLE_SUMMARY_CUSTOM_TYPE).length, 1);
        assert.equal(harness.notices.some((notice) => notice.level === "error"), true);
        assert.equal(harness.notices.some((notice) => notice.message.includes("is ready")), false);
    });

    it("reports provider failures once and cancels in-flight provider work without durable output", async () => {
        const externalErrorSentinel = "provider-secret-source-sentinel";
        const providerFailure = createHarness({
            branch: basicBranch().slice(0, 2),
            summarize: async () => {
                throw new Error(externalErrorSentinel);
            },
        });
        const logged: unknown[] = [];
        const originalConsoleError = console.error;
        console.error = (...args: unknown[]) => { logged.push(args); };
        try {
            const failed = await providerFailure.runProviderBoundary();
            assert.deepEqual(failed.contextResult.messages, []);
            assert.equal(failed.providerDispatched, false);
        } finally {
            console.error = originalConsoleError;
        }
        assert.equal(logged.length, 1);
        const diagnostic = (logged[0] as [{ code?: unknown; reasonCode?: unknown; message?: unknown }])[0];
        assert.equal(diagnostic.code, "PORTABILITY_OPERATION_FAILED");
        assert.equal(diagnostic.reasonCode, "SUMMARIZER_CALL_FAILED");
        assert.equal(diagnostic.message, "Portable summarizer call failed");
        assert.equal(JSON.stringify(logged).includes(externalErrorSentinel), false);
        assert.equal(JSON.stringify(providerFailure.notices).includes(externalErrorSentinel), false);
        assert.equal(providerFailure.abortCalls, 1);
        assert.equal(providerFailure.providerDispatches, 0);
        assert.deepEqual(providerFailure.notices.map((notice) => notice.level), ["info", "error"]);
        assert.equal(providerFailure.branch.some((entry) => entry.type === "custom"
            && entry.customType === PORTABLE_SUMMARY_CUSTOM_TYPE), false);

        let markStarted!: () => void;
        const started = new Promise<void>((resolve) => { markStarted = resolve; });
        const cancelled = createHarness({
            branch: basicBranch().slice(0, 2),
            summarize: async (request) => new Promise<never>((_, reject) => {
                markStarted();
                request.signal.addEventListener("abort", () => {
                    const error = new Error("cancelled");
                    error.name = "AbortError";
                    reject(error);
                }, { once: true });
            }),
        });
        const cancelledResult = cancelled.runContext();
        await started;
        cancelled.abort();
        assert.deepEqual((await cancelledResult).messages, []);
        assert.equal(cancelled.abortCalls, 0);
        assert.equal(cancelled.notices.some((notice) => notice.level === "error"), false);
        assert.equal(cancelled.branch.some((entry) => entry.type === "custom"
            && entry.customType === PORTABLE_SUMMARY_CUSTOM_TYPE), false);
    });

    it("aborts joined contexts for a provider-aborted grounded response with active signals", async () => {
        let markProviderStarted!: () => void;
        let releaseProvider!: () => void;
        let providerCalls = 0;
        const providerStarted = new Promise<void>((resolve) => { markProviderStarted = resolve; });
        const providerReleased = new Promise<void>((resolve) => { releaseProvider = resolve; });
        const dependencies: GroundedPortableSummarizerDependencies = {
            collectFilesTouched: () => [],
            complete: async (_model, _context, options) => {
                providerCalls += 1;
                markProviderStarted();
                await providerReleased;
                assert.equal(options?.signal?.aborted, false);
                return {
                    role: "assistant",
                    content: [],
                    api: "anthropic-messages",
                    provider: "anthropic",
                    model: "claude-test",
                    usage: {
                        input: 1,
                        output: 0,
                        cacheRead: 0,
                        cacheWrite: 0,
                        totalTokens: 1,
                        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                    },
                    stopReason: "aborted",
                    errorMessage: "provider aborted",
                    timestamp: 1,
                } satisfies AssistantMessage;
            },
            loadConfig: async () => ({
                includeFilesTouched: { inCompactionSummary: false, inBranchSummary: false },
                defaultPreset: "current",
                presets: {},
            }),
            loadCompactionPrompt: async () => "Keep the checkpoint concise",
        };
        const groundedOpenSession: GroundedPortableSummarizerOpener = (request, signal) => {
            return openGroundedPortableSummarizerSession(request, signal, dependencies);
        };
        const harness = createHarness({
            branch: basicBranch().slice(0, 2),
            groundedOpenSession,
        });
        const firstController = new AbortController();
        const secondController = new AbortController();
        const logged: unknown[] = [];
        const originalConsoleError = console.error;
        console.error = (...args: unknown[]) => { logged.push(args); };
        try {
            const first = harness.runProviderBoundaryWithController(firstController);
            const second = harness.runProviderBoundaryWithController(secondController);
            await providerStarted;
            releaseProvider();
            const [firstResult, secondResult] = await Promise.all([first, second]);
            assert.deepEqual(firstResult.contextResult.messages, []);
            assert.deepEqual(secondResult.contextResult.messages, []);
            assert.equal(firstResult.providerDispatched, false);
            assert.equal(secondResult.providerDispatched, false);
        } finally {
            console.error = originalConsoleError;
        }

        assert.equal(firstController.signal.aborted, true);
        assert.equal(secondController.signal.aborted, true);
        assert.equal(providerCalls, 1);
        assert.equal(harness.abortCalls, 2);
        assert.deepEqual(logged, []);
        assert.equal(harness.notices.some((notice) => notice.level === "error"), false);
        assert.equal(harness.providerDispatches, 0);
        assert.equal(harness.branch.some((entry) => entry.type === "custom"
            && entry.customType === PORTABLE_SUMMARY_CUSTOM_TYPE), false);
    });

    it("logs safe entry identities for malformed portable and native records", async () => {
        const malformedPortableBranch = basicBranch();
        malformedPortableBranch.push({
            type: "custom",
            id: "malformed-portable-entry",
            parentId: malformedPortableBranch.at(-1)!.id,
            timestamp: "2026-07-24T00:00:06.000Z",
            customType: PORTABLE_SUMMARY_CUSTOM_TYPE,
            data: { version: 99, secret: "portable-secret-sentinel" },
        } as SessionEntry);
        const cases = [
            {
                harness: createHarness({ branch: malformedPortableBranch }),
                reasonCode: "MALFORMED_PORTABLE_RECORD",
                message: "Active portable checkpoint record is malformed",
                identityField: "recordEntryId",
                identity: "malformed-portable-entry",
            },
            {
                harness: createHarness({ branch: [
                    userEntry("native-source", "native source"),
                    checkpointEntry("malformed-native-entry", "native-source", {
                        secret: "native-secret-sentinel",
                    }),
                ] }),
                reasonCode: "NATIVE_CHECKPOINT_MALFORMED",
                message: "The active native compaction checkpoint is malformed or unsupported",
                identityField: "nativeEntryId",
                identity: "malformed-native-entry",
            },
        ] as const;

        for (const testCase of cases) {
            const logged: unknown[] = [];
            const originalConsoleError = console.error;
            console.error = (...args: unknown[]) => { logged.push(args); };
            try {
                const result = await testCase.harness.runProviderBoundary();
                assert.deepEqual(result.contextResult.messages, []);
                assert.equal(result.providerDispatched, false);
            } finally {
                console.error = originalConsoleError;
            }
            assert.equal(logged.length, 1);
            const diagnostic = (logged[0] as [Record<string, unknown>])[0];
            assert.equal(diagnostic.reasonCode, testCase.reasonCode);
            assert.equal(diagnostic.message, testCase.message);
            assert.equal(diagnostic[testCase.identityField], testCase.identity);
            assert.equal(JSON.stringify(logged).includes("secret-sentinel"), false);
        }
    });

    it("fails closed for grounded absence, non-durable appends, malformed records, and empty projections", async () => {
        const failures = [
            createHarness({ branch: basicBranch(), grounded: "unavailable" }),
            createHarness({ branch: basicBranch(), appendFailure: new Error("disk full") }),
            createHarness({ branch: basicBranch(), omitAppend: true }),
            createHarness({ branch: [checkpointEntry("checkpoint-1", null)] }),
        ];
        const malformedBranch = basicBranch();
        malformedBranch.push({
            type: "custom",
            id: "malformed-portable",
            parentId: malformedBranch.at(-1)!.id,
            timestamp: "2026-07-24T00:00:06.000Z",
            customType: PORTABLE_SUMMARY_CUSTOM_TYPE,
            data: { version: 99 },
        } as SessionEntry);
        failures.push(createHarness({ branch: malformedBranch }));

        await withoutConsoleError(async () => {
            for (const harness of failures) {
                const result = await harness.runProviderBoundary([{ role: "user", content: "must not leak" }]);
                assert.deepEqual(result.contextResult.messages, []);
                assert.equal(result.providerDispatched, false);
                assert.equal(harness.abortCalls, 1);
                assert.equal(harness.providerDispatches, 0);
                assert.equal(harness.notices.some((notice) => notice.level === "error"), true);
                assert.equal(harness.notices.some((notice) => notice.message.includes("is ready")), false);
            }
        });
    });

    it("ignores malformed off-branch records and blocks unexpected checkpoint-position drift", async () => {
        const branch = basicBranch().slice(0, 2);
        const malformedOffBranch = {
            type: "custom",
            id: "off-branch-malformed",
            parentId: null,
            timestamp: "2026-07-24T00:00:08.000Z",
            customType: PORTABLE_SUMMARY_CUSTOM_TYPE,
            data: { version: 99 },
        } as SessionEntry;
        let harness: ReturnType<typeof createHarness>;
        harness = createHarness({
            branch,
            summarize: async (request) => {
                const inserted = userEntry("inserted-before-checkpoint", "unexpected branch", branch[0]!.id);
                harness.setBranch([branch[0]!, inserted, branch[1]!]);
                return { summary: "must-not-append", endOffset: request.sourceText.length, usage: null };
            },
        });
        harness.setEntries([...branch, malformedOffBranch]);
        await withoutConsoleError(async () => {
            const result = await harness.runContext();
            assert.deepEqual(result.messages, []);
        });
        assert.equal(harness.branch.some((entry) => entry.type === "custom"
            && entry.customType === PORTABLE_SUMMARY_CUSTOM_TYPE), false);
    });

    it("invalidates discovery memo on portable/lifecycle changes but not fresh tail entries", async () => {
        const harness = createHarness({ branch: basicBranch() });
        await harness.runContext();
        const initialPrefixFingerprints = harness.entryFingerprints;
        assert.equal(initialPrefixFingerprints, 2);
        await harness.runContext();
        assert.equal(harness.entryFingerprints, initialPrefixFingerprints);
        const afterDurableRefresh = harness.derivedPlans;
        const tail = userEntry("new-tail", "new tail", harness.branch.at(-1)!.id);
        harness.setBranch([...harness.branch, tail]);
        harness.setEntries([...harness.entries, tail]);
        await harness.runContext();
        assert.equal(harness.derivedPlans, afterDurableRefresh);
        assert.equal(harness.entryFingerprints, initialPrefixFingerprints);

        await harness.lifecycle("session_tree");
        await harness.runContext();
        assert.equal(harness.derivedPlans, afterDurableRefresh + 1);
        assert.equal(harness.entryFingerprints, initialPrefixFingerprints * 2);
        const extraPortable = {
            type: "custom",
            id: "stale-portable-fact",
            parentId: null,
            timestamp: "2026-07-24T00:00:09.000Z",
            customType: PORTABLE_SUMMARY_CUSTOM_TYPE,
            data: { version: 99 },
        } as SessionEntry;
        harness.setEntries([...harness.entries, extraPortable]);
        await harness.runContext();
        assert.equal(harness.derivedPlans, afterDurableRefresh + 2);
        assert.equal(harness.entryFingerprints, initialPrefixFingerprints * 2);

        const checkpoint = harness.branch.find((entry) => entry.id === "checkpoint-1");
        if (!checkpoint) throw new Error("Expected checkpoint entry");
        const changedUser = userEntry("user-1", "changed prefix content");
        harness.setBranch([changedUser, checkpoint]);
        harness.setEntries([changedUser, checkpoint]);
        await harness.runContextWithController(new AbortController());
        assert.equal(harness.entryFingerprints, initialPrefixFingerprints * 2 + 1);

        const newUser = userEntry("new-prefix-entry", "new prefix content");
        const newCheckpoint = checkpointEntry("new-checkpoint", newUser.id);
        harness.setBranch([newUser, newCheckpoint]);
        harness.setEntries([newUser, newCheckpoint]);
        await harness.runContextWithController(new AbortController());
        assert.equal(harness.entryFingerprints, initialPrefixFingerprints * 2 + 3);
    });

    it("reuses projected entry fingerprints across display metadata parents", async () => {
        const user = userEntry("user", "first source");
        const firstCheckpoint = checkpointEntry("checkpoint-1", user.id);
        const display = displayEntry("display", firstCheckpoint.id);
        const between = userEntry("between", "second source", display.id);
        const secondCheckpoint = checkpointEntry("checkpoint-2", between.id);
        const tail = userEntry("tail", "visible tail", secondCheckpoint.id);
        const harness = createHarness({
            branch: [user, firstCheckpoint, display, between, secondCheckpoint, tail],
        });

        await harness.runContext();
        const initialFingerprints = harness.entryFingerprints;
        assert.equal(initialFingerprints, 4);
        await harness.runContext();
        assert.equal(harness.entryFingerprints, initialFingerprints);

        const replacement = userEntry("between", "changed second source", display.id);
        const replacedBranch = [user, firstCheckpoint, display, replacement, secondCheckpoint, tail];
        harness.setBranch(replacedBranch);
        harness.setEntries(replacedBranch);
        await harness.runContextWithController(new AbortController());
        assert.equal(harness.entryFingerprints, initialFingerprints + 1);

        await harness.lifecycle("session_tree");
        await harness.runContextWithController(new AbortController());
        assert.equal(harness.entryFingerprints, initialFingerprints * 2 + 1);
    });
});
