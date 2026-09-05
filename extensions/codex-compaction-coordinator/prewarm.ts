import { randomUUID } from "node:crypto";

import type { Api, Model } from "@earendil-works/pi-ai";
import type {
    ExtensionAPI,
    ExtensionContext,
    SessionEntry,
} from "@earendil-works/pi-coding-agent";

import {
    PORTABILITY_COMMAND_USAGE,
    PORTABILITY_MODE_CUSTOM_TYPE,
    MalformedPortabilityModeEntryError,
    createPortabilityModeRecord,
    parsePortabilityCommand,
    resolveSessionPortabilityMode,
    type PortabilityMode,
} from "./portability-mode.ts";
import {
    PORTABLE_SUMMARY_CUSTOM_TYPE,
    canonicalJson,
    hashPortableValue,
    parsePortableSummarizerProvenance,
    parsePortableToolResultChars,
    preparePortableSource,
    type PortableChain,
    type PortableSummarizerProvenance,
    type PortableSummaryRecordV1,
} from "./portable-record.ts";
import {
    describeNativeEpoch,
    type NativeEpoch,
    type NativeEpochResult,
} from "./native-checkpoint-source.ts";
import {
    LAZY_PORTABILITY_SETTLED_EVENT,
    advancePortableChain,
    assertFreshPlan,
    buildCarryForwardRecord,
    buildSummaryCallRecord,
    cloneProjectionSafeBranch,
    derivePortablePlan,
    discoverChain,
    extendChainWithAppendedRecord,
    queryGrounded,
    type DerivedPortablePlan,
    type GroundedPortableSummarizerSession,
    type PortabilitySnapshot,
} from "./portability.ts";

const PREWARM_KEY_DOMAIN = "codex-compaction-coordinator:prewarm:v1";

type PrewarmPhase = "idle" | "preparing" | "awaiting-provider" | "awaiting-commit" | "commit" | "ready" | "error";

type PrewarmOperation = {
    key: string;
    snapshot: PortabilitySnapshot;
    epoch: NativeEpoch;
    plan: DerivedPortablePlan;
    controller: AbortController;
    invalidation: Promise<void>;
    invalidate: () => void;
    runInvalidation: Promise<void>;
    invalidateRun: () => void;
    runSequence: number;
    activeRunId: number;
    runModelKey: string;
    restartForModel: boolean;
    backgroundInterest: boolean;
    phase: PrewarmPhase;
    durableChain: PortableChain;
    speculativeChain: PortableChain;
    pendingRecords: PortableSummaryRecordV1[];
    computeComplete: boolean;
    providerCallSequence: number;
    activeProviderCallId: number | null;
    fulfilledProviderCallId: number | null;
    cancelledProviderCallId: number | null;
    opening: boolean;
    running: boolean;
    promise: Promise<void>;
    failure?: { phase: string; message: string };
    readyNotified: boolean;
    handoffToLazy: boolean;
};

type PrewarmDependencies = {
    randomUUID: () => string;
    cloneBranch: (branch: readonly SessionEntry[]) => SessionEntry[];
};

const DEFAULT_DEPENDENCIES: PrewarmDependencies = {
    randomUUID,
    cloneBranch: (branch) => structuredClone(branch) as SessionEntry[],
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCanonicalCodexModel(model: { provider: string; api: string }): boolean {
    return model.provider === "openai-codex" && model.api === "openai-codex-responses";
}

function modelKey(model: { provider: string; api: string; id: string }): string {
    return `${model.provider}:${model.api}:${model.id}`;
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "error"): void {
    if (ctx.hasUI) ctx.ui.notify(message, level);
}

type CallerWaitResult = "complete" | "caller-abort" | "operation-invalidated" | "run-invalidated";

function waitForCaller(
    promise: Promise<void>,
    signal: AbortSignal,
    invalidation: Promise<void>,
    runInvalidation: Promise<void>,
): Promise<CallerWaitResult> {
    if (signal.aborted) return Promise.resolve("caller-abort");
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (complete: () => void): void => {
            if (settled) return;
            settled = true;
            signal.removeEventListener("abort", onAbort);
            complete();
        };
        const onAbort = () => finish(() => resolve("caller-abort"));
        signal.addEventListener("abort", onAbort, { once: true });
        promise.then(
            () => finish(() => resolve("complete")),
            (error: unknown) => finish(() => reject(error)),
        );
        invalidation.then(() => finish(() => resolve("operation-invalidated")));
        runInvalidation.then(() => finish(() => resolve("run-invalidated")));
    });
}

function controlledMessage(phase: string): string {
    const messages: Record<string, string> = {
        discovery: "Native checkpoint discovery failed",
        plan: "Portable checkpoint planning failed",
        "grounded-open": "Portable summarizer session opening failed",
        "summary-call": "Portable summarizer call failed",
        append: "Portable checkpoint durable append failed",
        mode: "Portability mode resolution failed",
    };
    return messages[phase] ?? "Portable checkpoint prewarm failed";
}

function operationKey(
    sessionId: string,
    cwd: string,
    epoch: NativeEpoch,
    plan: DerivedPortablePlan,
): string {
    return hashPortableValue(PREWARM_KEY_DOMAIN, {
        sessionId,
        cwd,
        baseline: epoch.baseline,
        checkpoints: epoch.checkpoints,
        epoch: plan.nonPortableEpochFingerprint,
    });
}

export function registerCodexCompactionPrewarm(
    pi: ExtensionAPI,
    dependencies: Partial<PrewarmDependencies> = {},
): void {
    const runtime = { ...DEFAULT_DEPENDENCIES, ...dependencies };
    let mode: PortabilityMode = "lazy";
    let modeError: MalformedPortabilityModeEntryError | undefined;
    let operation: PrewarmOperation | undefined;
    let lastError: { phase: string; message: string } | undefined;
    const lazyReservationByContext = new WeakMap<object, string>();
    const activeLazyReservations = new Set<string>();
    let reservationSequence = 0;
    let generation = 0;
    let appendSafeContext: ExtensionContext | undefined;
    let restartAfterLazyContext: ExtensionContext | undefined;

    const operationAcceptsPlan = (
        current: PrewarmOperation,
        snapshot: PortabilitySnapshot,
        epoch: NativeEpoch,
        plan: DerivedPortablePlan,
    ): boolean => {
        if (
            current.snapshot.sessionId !== snapshot.sessionId
            || current.snapshot.cwd !== snapshot.cwd
            || canonicalJson(current.epoch.baseline) !== canonicalJson(epoch.baseline)
        ) {
            return false;
        }
        const sharedLength = Math.min(current.plan.checkpoints.length, plan.checkpoints.length);
        return current.plan.checkpoints.slice(0, sharedLength).every((checkpoint, index) =>
            canonicalJson(checkpoint) === canonicalJson(plan.checkpoints[index]));
    };

    const refreshMode = (ctx: ExtensionContext): void => {
        try {
            mode = resolveSessionPortabilityMode(ctx.sessionManager.getEntries() as SessionEntry[]).mode;
            modeError = undefined;
        } catch (error) {
            if (!(error instanceof MalformedPortabilityModeEntryError)) throw error;
            modeError = error;
            lastError = { phase: "mode", message: controlledMessage("mode") };
        }
    };

    const releaseOperationWaiters = (current: PrewarmOperation): void => {
        current.invalidate();
        let invalidate!: () => void;
        current.invalidation = new Promise<void>((resolve) => { invalidate = resolve; });
        current.invalidate = invalidate;
    };

    const clearOperation = (): void => {
        generation += 1;
        restartAfterLazyContext = undefined;
        activeLazyReservations.clear();
        operation?.invalidate();
        operation?.controller.abort();
        operation = undefined;
    };

    const reserveLazyOwnership = (ctx: ExtensionContext): void => {
        const contextIdentity = ctx as object;
        const existing = lazyReservationByContext.get(contextIdentity);
        if (existing && activeLazyReservations.has(existing)) return;
        const reservation = `${generation}:${++reservationSequence}`;
        lazyReservationByContext.set(contextIdentity, reservation);
        activeLazyReservations.add(reservation);
        if (mode === "prewarm") restartAfterLazyContext = ctx;
    };

    const markLazyHandoff = (current: PrewarmOperation, ctx: ExtensionContext): void => {
        current.backgroundInterest = false;
        current.handoffToLazy = true;
        reserveLazyOwnership(ctx);
    };

    const commitPending = (current: PrewarmOperation, ctx: ExtensionContext): void => {
        while (current.pendingRecords.length > 0) {
            current.phase = "commit";
            const record = current.pendingRecords[0]!;
            const before = assertFreshPlan(current.snapshot, ctx, current.epoch);
            pi.appendEntry(PORTABLE_SUMMARY_CUSTOM_TYPE, record);
            const after = ctx.sessionManager.getBranch() as SessionEntry[];
            current.durableChain = extendChainWithAppendedRecord({
                chain: current.durableChain,
                record,
                branchBeforeAppend: before,
                branchAfterAppend: after,
                onPortableRecordValidation: () => undefined,
            });
            current.pendingRecords.shift();
        }
        current.phase = current.opening || current.activeProviderCallId !== null
            ? "awaiting-provider"
            : current.computeComplete
                ? "ready"
                : "preparing";
        if (current.phase === "ready" && mode === "prewarm" && !current.readyNotified) {
            current.readyNotified = true;
            notify(ctx, "Portable Codex checkpoint history is prewarmed.", "info");
        }
    };

    const reconcileOperationPlan = (current: PrewarmOperation, ctx: ExtensionContext): boolean => {
        const liveBranch = ctx.sessionManager.getBranch() as SessionEntry[];
        const epoch = describeNativeEpoch(liveBranch);
        if (epoch.status === "available" && epoch.checkpoints.length === 0) return false;
        if (epoch.status === "error") throw new Error(epoch.message);
        const snapshot: PortabilitySnapshot = {
            sessionId: ctx.sessionManager.getSessionId(),
            cwd: ctx.cwd,
            model: (ctx.model ?? current.snapshot.model) as Model<Api>,
            groundedBranchEntries: cloneProjectionSafeBranch(liveBranch, runtime.cloneBranch),
        };
        const plan = derivePortablePlan(liveBranch, epoch);
        const key = operationKey(snapshot.sessionId, snapshot.cwd, epoch, plan);
        if (current.key !== key && !operationAcceptsPlan(current, snapshot, epoch, plan)) return false;
        const contractsCheckpointPrefix = plan.checkpoints.length < current.plan.checkpoints.length;
        if (contractsCheckpointPrefix) {
            const activeCheckpointIsRetained = current.running
                && current.speculativeChain.completedCheckpoints < plan.checkpoints.length;
            if (!activeCheckpointIsRetained) retireRun(current);
            const durableChain = discoverChain(
                plan,
                ctx.sessionManager.getEntries() as SessionEntry[],
                liveBranch,
                () => undefined,
            );
            const retainedRecords: PortableSummaryRecordV1[] = [];
            let speculativeChain = durableChain;
            for (const record of current.pendingRecords) {
                const checkpointIndex = plan.checkpoints.findIndex((checkpoint) =>
                    canonicalJson(checkpoint.checkpoint) === canonicalJson(record.checkpoint));
                if (
                    checkpointIndex !== speculativeChain.completedCheckpoints
                    || record.step.startOffset !== speculativeChain.partialOffset
                ) {
                    continue;
                }
                retainedRecords.push(record);
                speculativeChain = advancePortableChain(speculativeChain, record);
            }
            current.durableChain = durableChain;
            current.speculativeChain = speculativeChain;
            current.pendingRecords = retainedRecords;
        }
        current.key = key;
        if (current.running && current.runModelKey !== modelKey(snapshot.model)) {
            if (current.opening) retireRun(current);
            else current.restartForModel = true;
        }
        current.snapshot = snapshot;
        current.epoch = epoch;
        current.plan = plan;
        current.computeComplete = current.speculativeChain.completedCheckpoints >= plan.checkpoints.length;
        if (contractsCheckpointPrefix) {
            current.failure = undefined;
            current.phase = current.pendingRecords.length > 0
                ? "awaiting-commit"
                : current.computeComplete
                    ? "ready"
                    : current.running
                        ? "awaiting-provider"
                        : "preparing";
        }
        if (!current.computeComplete) current.readyNotified = false;
        return true;
    };

    const runOperation = async (
        current: PrewarmOperation,
        ctx: ExtensionContext,
        operationGeneration: number,
        runId: number,
    ): Promise<void> => {
        let phase = "grounded-open";
        const runController = current.controller;
        current.running = true;
        try {
            if (current.speculativeChain.completedCheckpoints >= current.plan.checkpoints.length) {
                current.computeComplete = true;
                current.phase = current.pendingRecords.length > 0 ? "awaiting-commit" : "ready";
                return;
            }
            const grounded = queryGrounded(pi, current.snapshot, ctx);
            current.phase = "awaiting-provider";
            current.opening = true;
            const opened = await grounded.openSession(runController.signal);
            if (
                runController.signal.aborted
                || operationGeneration !== generation
                || operation !== current
                || current.activeRunId !== runId
            ) {
                return;
            }
            current.opening = false;
            if (current.restartForModel) return;
            let descriptor: PortableSummarizerProvenance;
            try {
                descriptor = parsePortableSummarizerProvenance(opened.descriptor);
            } catch {
                throw new Error("Grounded portable summarizer returned invalid provenance");
            }
            const summarizer: GroundedPortableSummarizerSession = {
                ...opened,
                descriptor,
                toolResultChars: parsePortableToolResultChars(opened.toolResultChars),
            };
            if (current.speculativeChain.partialOffset > 0) {
                current.speculativeChain = discoverChain(
                    current.plan,
                    ctx.sessionManager.getEntries(),
                    ctx.sessionManager.getBranch(),
                    () => undefined,
                    { resumeToolResultChars: summarizer.toolResultChars, pendingRecords: current.pendingRecords },
                );
            }
            while (current.speculativeChain.completedCheckpoints < current.plan.checkpoints.length) {
                if (
                    current.controller.signal.aborted
                    || operationGeneration !== generation
                    || operation !== current
                    || current.activeRunId !== runId
                ) return;
                if (!current.backgroundInterest) return;
                const plannedCheckpoint = current.plan.checkpoints[current.speculativeChain.completedCheckpoints]!;
                const checkpoint = {
                    ...plannedCheckpoint,
                    ...preparePortableSource(plannedCheckpoint, summarizer.toolResultChars),
                };
                const startOffset = current.speculativeChain.partialOffset;
                let record: PortableSummaryRecordV1;
                if (checkpoint.sourceText.length === 0) {
                    record = buildCarryForwardRecord({
                        chain: current.speculativeChain,
                        baseline: current.plan.baseline,
                        checkpoint,
                        recordId: runtime.randomUUID(),
                    });
                } else {
                    phase = "summary-call";
                    current.phase = "awaiting-provider";
                    const providerCallId = ++current.providerCallSequence;
                    current.activeProviderCallId = providerCallId;
                    current.fulfilledProviderCallId = null;
                    current.cancelledProviderCallId = null;
                    const result = await summarizer.summarizeNext({
                        previousSummary: current.speculativeChain.summary,
                        sourceText: checkpoint.sourceText,
                        startOffset,
                        coverageEntries: checkpoint.coverageEntries,
                        signal: runController.signal,
                    }).then((fulfilled) => {
                        if (
                            current.activeRunId === runId
                            && current.activeProviderCallId === providerCallId
                        ) {
                            current.fulfilledProviderCallId = providerCallId;
                        }
                        return fulfilled;
                    });
                    if (
                        operationGeneration !== generation
                        || operation !== current
                        || current.activeRunId !== runId
                        || current.cancelledProviderCallId === providerCallId
                    ) {
                        return;
                    }
                    record = buildSummaryCallRecord({
                        chain: current.speculativeChain,
                        baseline: current.plan.baseline,
                        checkpoint,
                        recordId: runtime.randomUUID(),
                        startOffset,
                        result,
                        descriptor,
                    });
                }
                // Queue a fulfilled paid result before observing a switch back to lazy
                current.pendingRecords.push(record);
                current.activeProviderCallId = null;
                current.fulfilledProviderCallId = null;
                current.cancelledProviderCallId = null;
                current.speculativeChain = advancePortableChain(current.speculativeChain, record);
                current.phase = "awaiting-commit";
                if (appendSafeContext) {
                    phase = "append";
                    commitPending(current, appendSafeContext);
                }
                if (current.restartForModel) return;
            }
            current.computeComplete = true;
            current.phase = current.pendingRecords.length > 0 ? "awaiting-commit" : "ready";
        } catch (error) {
            if (runController.signal.aborted) return;
            if (
                operationGeneration !== generation
                || operation !== current
                || current.activeRunId !== runId
            ) {
                return;
            }
            current.phase = "error";
            current.failure = { phase, message: controlledMessage(phase) };
            lastError = current.failure;
            console.error({
                component: "codex-compaction-coordinator",
                code: "PORTABILITY_PREWARM_FAILED",
                phase,
                message: current.failure.message,
                sessionId: current.snapshot.sessionId,
            });
            notify(ctx, `Codex portability prewarm failed during ${phase}.`, "error");
            throw error;
        } finally {
            if (current.activeRunId === runId) {
                current.opening = false;
                current.running = false;
                const shouldRestart = current.restartForModel
                    && current.backgroundInterest
                    && operation === current
                    && current.speculativeChain.completedCheckpoints < current.plan.checkpoints.length;
                if (shouldRestart) queueMicrotask(() => {
                    if (
                        operation === current
                        && !current.running
                        && current.backgroundInterest
                        && current.speculativeChain.completedCheckpoints < current.plan.checkpoints.length
                    ) {
                        startRun(current, ctx);
                    }
                });
            }
        }
    };

    function retireRun(current: PrewarmOperation): void {
        current.invalidateRun();
        current.controller.abort();
        current.activeRunId = ++current.runSequence;
        current.opening = false;
        current.running = false;
        current.activeProviderCallId = null;
        current.fulfilledProviderCallId = null;
        current.promise = Promise.resolve();
    }

    function startRun(current: PrewarmOperation, ctx: ExtensionContext): void {
        current.invalidateRun();
        let invalidateRun!: () => void;
        current.runInvalidation = new Promise<void>((resolve) => { invalidateRun = resolve; });
        current.invalidateRun = invalidateRun;
        current.controller = new AbortController();
        current.activeProviderCallId = null;
        current.fulfilledProviderCallId = null;
        current.cancelledProviderCallId = null;
        current.failure = undefined;
        current.phase = "preparing";
        current.runModelKey = modelKey(current.snapshot.model);
        current.restartForModel = false;
        const runId = ++current.runSequence;
        current.activeRunId = runId;
        current.promise = runOperation(current, ctx, generation, runId).catch(() => undefined);
    }

    const ensureOperation = (ctx: ExtensionContext): PrewarmOperation | undefined => {
        if (modeError || mode !== "prewarm") return operation;
        if (activeLazyReservations.size > 0 && !operation) {
            return undefined;
        }
        const liveBranch = ctx.sessionManager.getBranch() as SessionEntry[];
        const epoch = describeNativeEpoch(liveBranch);
        if (epoch.status === "available" && epoch.checkpoints.length === 0) {
            if (operation) clearOperation();
            return undefined;
        }
        if (epoch.status === "error") throw new Error(epoch.message);
        const snapshot: PortabilitySnapshot = {
            sessionId: ctx.sessionManager.getSessionId(),
            cwd: ctx.cwd,
            model: ctx.model as Model<Api>,
            groundedBranchEntries: cloneProjectionSafeBranch(liveBranch, runtime.cloneBranch),
        };
        const plan = derivePortablePlan(liveBranch, epoch);
        const key = operationKey(snapshot.sessionId, snapshot.cwd, epoch, plan);
        if (operation?.key === key && operation.handoffToLazy && activeLazyReservations.size > 0) {
            return operation;
        }
        if (operation?.key === key && !operation.handoffToLazy) {
            if (!reconcileOperationPlan(operation, ctx)) throw new Error("Portable checkpoint plan reconciliation failed");
            operation.backgroundInterest = true;
            operation.handoffToLazy = false;
            if (!operation.running && !operation.computeComplete) startRun(operation, ctx);
            return operation;
        }
        if (operation && !operation.handoffToLazy && operationAcceptsPlan(operation, snapshot, epoch, plan)) {
            if (!reconcileOperationPlan(operation, ctx)) throw new Error("Portable checkpoint plan reconciliation failed");
            operation.backgroundInterest = true;
            operation.readyNotified = false;
            if (!operation.running && !operation.computeComplete) startRun(operation, ctx);
            return operation;
        }
        clearOperation();
        const durableChain = discoverChain(
            plan,
            ctx.sessionManager.getEntries() as SessionEntry[],
            liveBranch,
            () => undefined,
        );
        const controller = new AbortController();
        let invalidate!: () => void;
        const invalidation = new Promise<void>((resolve) => { invalidate = resolve; });
        let invalidateRun!: () => void;
        const runInvalidation = new Promise<void>((resolve) => { invalidateRun = resolve; });
        const next = {
            key,
            snapshot,
            epoch,
            plan,
            controller,
            invalidation,
            invalidate,
            runInvalidation,
            invalidateRun,
            runSequence: 0,
            activeRunId: 0,
            runModelKey: modelKey(snapshot.model),
            restartForModel: false,
            backgroundInterest: true,
            phase: "preparing" as PrewarmPhase,
            durableChain,
            speculativeChain: durableChain,
            pendingRecords: [],
            computeComplete: false,
            providerCallSequence: 0,
            activeProviderCallId: null,
            fulfilledProviderCallId: null,
            cancelledProviderCallId: null,
            opening: false,
            running: false,
            promise: Promise.resolve(),
            readyNotified: false,
            handoffToLazy: false,
        } satisfies PrewarmOperation;
        operation = next;
        if (durableChain.completedCheckpoints >= plan.checkpoints.length) {
            next.computeComplete = true;
            next.phase = "ready";
            return next;
        }
        notify(ctx, "Prewarming portable Codex checkpoint history…", "info");
        startRun(next, ctx);
        return next;
    };

    const schedule = (ctx: ExtensionContext): void => {
        const scheduledGeneration = generation;
        queueMicrotask(() => {
            if (scheduledGeneration !== generation) return;
            try {
                ensureOperation(ctx);
            } catch (error) {
                const phase = "discovery";
                lastError = { phase, message: controlledMessage(phase) };
                console.error({
                    component: "codex-compaction-coordinator",
                    code: "PORTABILITY_PREWARM_FAILED",
                    phase,
                    message: lastError.message,
                    sessionId: ctx.sessionManager.getSessionId(),
                });
                notify(ctx, "Codex portability prewarm failed during discovery.", "error");
            }
        });
    };

    // This hook runs before lazy portability so a provider switch can join and commit prewarm work before
    // authoritative chain discovery and projection
    pi.on("context", async (_event, ctx) => {
        appendSafeContext = undefined;
        if (!ctx.model || isCanonicalCodexModel(ctx.model)) return undefined;
        let joinedOperation: PrewarmOperation | undefined;
        try {
            refreshMode(ctx);
            if (modeError) {
                const epoch = describeNativeEpoch(ctx.sessionManager.getBranch() as SessionEntry[]);
                if (epoch.status === "available" && epoch.checkpoints.length === 0) return undefined;
                ctx.abort();
                notify(ctx, "Codex portability mode state is malformed.", "error");
                return { messages: [] };
            }
            if (operation && !reconcileOperationPlan(operation, ctx)) clearOperation();
            if (operation?.handoffToLazy) {
                if (operation.pendingRecords.length > 0) commitPending(operation, ctx);
                reserveLazyOwnership(ctx);
                return undefined;
            }
            if (mode === "prewarm" && operation?.phase === "error") {
                const failed = operation;
                joinedOperation = failed;
                if (failed.pendingRecords.length > 0) commitPending(failed, ctx);
                markLazyHandoff(failed, ctx);
                return undefined;
            }
            const current = mode === "prewarm" ? ensureOperation(ctx) : operation;
            if (!current) {
                if (mode === "lazy" || activeLazyReservations.size > 0) {
                    const epoch = describeNativeEpoch(ctx.sessionManager.getBranch() as SessionEntry[]);
                    if (epoch.status === "available" && epoch.checkpoints.length > 0) reserveLazyOwnership(ctx);
                }
                return undefined;
            }
            joinedOperation = current;
            if (mode === "lazy" && !current.running) {
                if (current.pendingRecords.length > 0) commitPending(current, ctx);
                markLazyHandoff(current, ctx);
                return undefined;
            }
            const waiterGeneration = generation;
            current.backgroundInterest = mode === "prewarm";
            let waitResult: CallerWaitResult;
            while (true) {
                waitResult = await waitForCaller(
                    current.promise,
                    ctx.signal,
                    current.invalidation,
                    current.runInvalidation,
                );
                if (
                    waitResult !== "run-invalidated"
                    || generation !== waiterGeneration
                    || operation !== current
                    || !current.running
                ) {
                    break;
                }
            }
            if (waitResult === "caller-abort" || ctx.signal.aborted) return { messages: [] };
            if (
                waitResult === "operation-invalidated"
                || generation !== waiterGeneration
                || operation !== current
            ) {
                ctx.abort();
                return { messages: [] };
            }
            if (current.handoffToLazy) {
                reserveLazyOwnership(ctx);
                return undefined;
            }
            if (waitResult === "run-invalidated") {
                if (current.pendingRecords.length > 0) commitPending(current, ctx);
                markLazyHandoff(current, ctx);
                return undefined;
            }
            if (current.phase === "error") {
                if (current.pendingRecords.length > 0) commitPending(current, ctx);
                markLazyHandoff(current, ctx);
                return undefined;
            }
            refreshMode(ctx);
            if (modeError) throw modeError;
            if (mode === "lazy") {
                if (current.pendingRecords.length > 0) commitPending(current, ctx);
                markLazyHandoff(current, ctx);
                return undefined;
            }
            commitPending(current, ctx);
            return undefined;
        } catch {
            if (ctx.signal.aborted) return { messages: [] };
            if (joinedOperation && operation === joinedOperation) {
                let authorityChanged = false;
                let liveEpoch: NativeEpochResult | undefined;
                try {
                    liveEpoch = describeNativeEpoch(ctx.sessionManager.getBranch() as SessionEntry[]);
                    authorityChanged = liveEpoch.status !== "available"
                        || canonicalJson(liveEpoch) !== canonicalJson(joinedOperation.epoch);
                } catch {
                    authorityChanged = true;
                }
                if (authorityChanged) {
                    clearOperation();
                    if (liveEpoch?.status === "available" && liveEpoch.checkpoints.length > 0) {
                        reserveLazyOwnership(ctx);
                    }
                    return undefined;
                }
            }
            ctx.abort();
            notify(ctx, "Codex portability prewarm could not be committed for this provider request.", "error");
            return { messages: [] };
        }
    });

    const safeBoundary = (_event: unknown, ctx: ExtensionContext): void => {
        appendSafeContext = ctx;
        try {
            refreshMode(ctx);
            if (operation && !reconcileOperationPlan(operation, ctx)) {
                clearOperation();
                return;
            }
            if (operation?.pendingRecords.length) commitPending(operation, ctx);
        } catch {
            // Preserve paid results for a retry when authority is unchanged; retire only stale epochs
            const pendingOperation = operation;
            const liveEpoch = describeNativeEpoch(ctx.sessionManager.getBranch() as SessionEntry[]);
            if (
                pendingOperation
                && (liveEpoch.status !== "available"
                    || canonicalJson(liveEpoch) !== canonicalJson(pendingOperation.epoch))
            ) {
                clearOperation();
            }
            lastError = { phase: "append", message: controlledMessage("append") };
            notify(ctx, "Codex portability prewarm could not commit durable progress.", "error");
        } finally {
            if (mode === "prewarm" && !modeError) schedule(ctx);
        }
    };
    pi.on("agent_end", safeBoundary);
    pi.on("session_compact", safeBoundary);

    const reconstructAndSchedule = (_event: unknown, ctx: ExtensionContext): void => {
        appendSafeContext = undefined;
        clearOperation();
        refreshMode(ctx);
        if (mode === "prewarm" && !modeError) schedule(ctx);
    };
    pi.on("session_start", reconstructAndSchedule);
    pi.on("session_tree", (_event, ctx) => {
        appendSafeContext = undefined;
        refreshMode(ctx);
        if (mode !== "prewarm" || modeError) {
            clearOperation();
            return;
        }
        if (operation?.handoffToLazy || activeLazyReservations.size > 0) {
            generation += 1;
            operation?.invalidate();
            operation?.controller.abort();
            operation = undefined;
            restartAfterLazyContext = ctx;
            return;
        }
        if (operation) releaseOperationWaiters(operation);
        schedule(ctx);
    });
    pi.on("model_select", (_event, ctx) => {
        refreshMode(ctx);
        if (activeLazyReservations.size > 0) restartAfterLazyContext = ctx;
        if (mode === "prewarm" && !modeError) schedule(ctx);
    });

    let unsubscribeLazySettled = pi.events.on(LAZY_PORTABILITY_SETTLED_EVENT, (payload: unknown) => {
        if (
            !isRecord(payload)
            || typeof payload.sessionId !== "string"
            || !isRecord(payload.context)
            || !isRecord(payload.context.sessionManager)
            || typeof payload.context.sessionManager.getSessionId !== "function"
            || payload.context.sessionManager.getSessionId() !== payload.sessionId
        ) {
            return;
        }
        const contextIdentity = payload.context as object;
        const reservation = lazyReservationByContext.get(contextIdentity);
        if (!reservation || !activeLazyReservations.delete(reservation)) return;
        lazyReservationByContext.delete(contextIdentity);
        if (activeLazyReservations.size === 0) {
            const scheduleContext = restartAfterLazyContext ?? payload.context as ExtensionContext;
            restartAfterLazyContext = undefined;
            if (mode === "prewarm") schedule(scheduleContext);
        }
    });

    pi.registerCommand("codex-portability", {
        description: "Choose lazy or prewarmed portable Codex summaries for this session",
        handler: async (argumentsText, ctx) => {
            if (!ctx.hasUI) return;
            let command;
            try {
                command = parsePortabilityCommand(argumentsText);
            } catch {
                notify(ctx, PORTABILITY_COMMAND_USAGE, "error");
                return;
            }
            refreshMode(ctx);
            if (command === "status") {
                let checkpoints = "0/0 complete";
                try {
                    const branch = ctx.sessionManager.getBranch() as SessionEntry[];
                    const epoch = describeNativeEpoch(branch);
                    if (epoch.status === "available") {
                        if (epoch.checkpoints.length === 0) {
                            checkpoints = "0/0 complete";
                        } else {
                            const plan = derivePortablePlan(branch, epoch);
                            const chain = discoverChain(
                                plan,
                                ctx.sessionManager.getEntries() as SessionEntry[],
                                branch,
                                () => undefined,
                            );
                            checkpoints = `${chain.completedCheckpoints}/${plan.checkpoints.length} complete`;
                        }
                    } else if (epoch.status === "error") {
                        checkpoints = "error";
                    }
                } catch {
                    checkpoints = "error";
                }
                const work = operation
                    ? `${operation.phase}; pending=${operation.pendingRecords.length}`
                    : "idle";
                notify(
                    ctx,
                    `Codex portability: mode=${modeError ? "error" : mode}; checkpoints=${checkpoints}; `
                        + `work=${work}; last error=${lastError?.message ?? "none"}`,
                    modeError ? "error" : "info",
                );
                return;
            }
            const previousMode = mode;
            try {
                pi.appendEntry(PORTABILITY_MODE_CUSTOM_TYPE, createPortabilityModeRecord(command));
                refreshMode(ctx);
            } catch {
                notify(ctx, "Could not persist the Codex portability mode.", "error");
                return;
            }
            if (command === "lazy") {
                if (operation) {
                    operation.backgroundInterest = false;
                    if (operation.opening || operation.activeProviderCallId !== null) {
                        const currentOperation = operation;
                        const providerCallId = currentOperation.activeProviderCallId;
                        setTimeout(() => {
                            if (currentOperation.backgroundInterest) return;
                            if (currentOperation.opening && providerCallId === null) {
                                retireRun(currentOperation);
                                return;
                            }
                            if (
                                providerCallId !== null
                                && currentOperation.activeProviderCallId === providerCallId
                                && currentOperation.fulfilledProviderCallId !== providerCallId
                            ) {
                                currentOperation.cancelledProviderCallId = providerCallId;
                                retireRun(currentOperation);
                            }
                        }, 0);
                    }
                }
            } else {
                if (activeLazyReservations.size > 0) restartAfterLazyContext = ctx;
                schedule(ctx);
            }
            notify(
                ctx,
                previousMode === command
                    ? command === "prewarm"
                        ? "Codex portability remains prewarm; discovery retried."
                        : "Codex portability remains lazy."
                    : `Codex portability mode set to ${command}.`,
                "info",
            );
        },
    });

    pi.on("session_shutdown", () => {
        clearOperation();
        mode = "lazy";
        modeError = undefined;
        lastError = undefined;
        unsubscribeLazySettled?.();
        unsubscribeLazySettled = undefined;
    });
}
