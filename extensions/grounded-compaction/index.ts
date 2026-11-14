import { createHash, randomUUID } from "node:crypto";

import { getCurrentSystemMessage, type Api, type Context, type Model, type SimpleStreamOptions, type SystemMessage } from "@earendil-works/pi-ai";
import type { completeSimple } from "@earendil-works/pi-ai/compat";
import type {
    ExtensionAPI,
    SessionBeforeCompactEvent,
    SessionBeforeTreeEvent,
    SessionBeforeTreeResult,
    SessionEntry,
    SessionProjection,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { buildSessionProjection, prepareBranchEntries } from "@earendil-works/pi-coding-agent";

import { estimateInputTokens } from "../_shared/compaction-serialization.ts";
import { collectFilesTouched, registerFilesTouchedTracking } from "../_shared/files-touched-core.ts";
import type { GroundedRetentionRecord } from "../_shared/grounded-compaction-record.ts";
import { appendRequiredReading, requiredReadingRecord, RequiredReadingError, type RequiredReadingRecord } from "./required-reading.ts";
import { registerReadingGate } from "./reading-gate.ts";
import {
    assertCompactionOwner, captureRetentionSnapshot, prepareRetentionSources, publishSelectedSidecars,
    readPreparedSummaryBody, RetentionError, selectRetainedSupplement, serializeRetentionSpan,
    remainingContinuationTokens,
    type RetentionSnapshot, type RetentionSources,
} from "./retention.ts";
import {
    CURRENT_PRESET_SENTINEL,
    EXTENSION_DIR,
    loadConfig,
    parseCompactInstructions,
    resolveDefaultSummarizer,
    resolvePresetSummarizer,
    type FilesTouchedMode,
    type GroundedCompactionConfig,
    type ResolvedSummarizer,
    type SummarizerContext,
    type ThinkingLevel,
} from "./configuration.ts";
import {
    DEFAULT_SYSTEM_PROMPT,
    FILES_TOUCHED_HEADING,
    FINAL_FILES_TOUCHED_HEADING,
    appendReaderLedger,
    buildBranchSummaryInstructions,
    buildFilesTouchedLedger,
    buildSummaryUserPrompt,
    loadBranchSummaryPromptContract,
    loadCompactionPromptContract,
    serializePreparedMessages,
    stripGroundedCompactionManifestTail,
    type FilesTouchedLedger,
} from "./prompts.ts";
import type { PreviousSummaryLookup } from "./registration.ts";
import {
    registerGroundedPortableSummarizer,
    type GroundedPortableSummarizerOpenRequest,
    type GroundedPortableSummarizerOpener,
    type GroundedPortableSummarizerSession,
} from "./portable-summarizer.ts";
import { registerGroundedCompactionHandlers } from "./registration.ts";
import {
    CompactionAbortedError,
    IncompleteSummaryError,
    executePortableSummaryRequestResult,
    executePreflightedSummaryBatch,
    isAbortError,
    isSignalAborted,
    preflightSummaryBatch,
    prepareSummaryBatch,
    prepareSummaryRequest,
    selectOrdinarySummaryRoute,
    throwIfAborted,
    type PortableSummaryCompletion,
    type SummaryExecutionDeps,
    type SummaryExecutionRoute,
} from "./summary-execution.ts";

export { estimateInputTokens } from "../_shared/compaction-serialization.ts";
export {
    DEFAULT_CONFIG,
    getEffectiveThinkingLevel,
    loadConfig,
    parseCompactInstructions,
    parseConfig,
    resolveDefaultSummarizer,
    resolvePresetMatch,
    resolvePresetSummarizer,
    type FilesTouchedMode,
    type GroundedCompactionConfig,
    type IncludeFilesTouchedSettings,
    type ParsedCompactInstructions,
    type PresetMatchResult,
    type ResolvedSummarizer,
    type ThinkingLevel,
} from "./configuration.ts";
export {
    DEFAULT_COMPACTION_PROMPT_CONTRACT,
    DEFAULT_SYSTEM_PROMPT,
    buildBranchSummaryInstructions,
    buildSummaryUserPrompt,
    formatManifestOperations,
    loadBranchSummaryPromptContract,
    loadCompactionPromptContract,
    renderFilesTouchedManifestBlock,
    serializePreparedMessages,
    stripGroundedCompactionManifestTail,
    type FilesTouchedLedger,
} from "./prompts.ts";
export { queryGroundedCompactionDelegation } from "./registration.ts";

type NotifyLevel = "info" | "warning" | "error";

export interface GroundedCompactionDetails {
    model: string;
    thinkingLevel?: ThinkingLevel;
    groundedRetention?: GroundedRetentionRecord;
    groundedReading?: RequiredReadingRecord;
}

type HookContext = SummarizerContext & {
    hasUI: boolean;
    ui: {
        notify(message: string, level?: NotifyLevel): void;
    };
    cwd?: string | null;
    sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionDir" | "getSessionId" | "getLeafId" | "getBranch" | "getEntries">;
};

type RunDeps = {
    /** Supplied by tests; ordinary compaction uses the session's model registry. */
    complete?: typeof completeSimple;
    collectFilesTouched: typeof collectFilesTouched;
    loadConfig: (extensionDir?: string) => Promise<GroundedCompactionConfig>;
    loadCompactionPrompt: (extensionDir?: string) => Promise<string>;
    loadBranchSummaryPrompt: (extensionDir?: string) => Promise<string | undefined>;
};

type CompactionRunDeps = RunDeps & {
    /** Asks other extensions for readable text standing in for the previous compaction entry's stored summary. */
    queryPreviousSummary: PreviousSummaryLookup;
};

/** Runs one ordinary compaction; registration supplies the event-bus previous-summary query. */
export type GroundedCompactionRunner = (
    event: SessionBeforeCompactEvent,
    ctx: ExtensionContext,
    queryPreviousSummary: PreviousSummaryLookup,
) => ReturnType<typeof runGroundedCompaction>;

export type GroundedPortableSummarizerDependencies = {
    /** Overrides provider-backed completion through the model registry. */
    complete?: PortableSummaryCompletion;
    collectFilesTouched: typeof collectFilesTouched;
    loadConfig: RunDeps["loadConfig"];
    loadCompactionPrompt: RunDeps["loadCompactionPrompt"];
};

const PORTABLE_SUMMARIZER_PROMPT_VERSION = 2;

export const PORTABLE_SUMMARY_MAX_OUTPUT_TOKENS = 16_384;

// Portable transcripts contain code and tool output, which tokenize more densely than ordinary prose.
const PORTABLE_SOURCE_CHARACTERS_PER_TOKEN = 2;

const DEFAULT_DEPS: RunDeps = {
    collectFilesTouched,
    loadConfig,
    loadCompactionPrompt: loadCompactionPromptContract,
    loadBranchSummaryPrompt: loadBranchSummaryPromptContract,
};

const DEFAULT_PORTABLE_DEPS: GroundedPortableSummarizerDependencies = {
    collectFilesTouched,
    loadConfig,
    loadCompactionPrompt: loadCompactionPromptContract,
};

function notify(ctx: HookContext, message: string, level: NotifyLevel = "warning"): void {
    if (ctx.hasUI) {
        ctx.ui.notify(message, level);
    }
}

function createPortablePromptFingerprint(promptContract: string, filesTouchedMode: FilesTouchedMode): string {
    return createHash("sha256")
        .update(`grounded-compaction:portable-prompt:v${PORTABLE_SUMMARIZER_PROMPT_VERSION}\0`)
        .update(DEFAULT_SYSTEM_PROMPT)
        .update("\0")
        .update(promptContract)
        .update("\0")
        .update(filesTouchedMode)
        .digest("hex");
}

function resolvePortableModelLimits(model: Model<Api>): { contextWindow: number; maxOutputTokens: number } {
    if (!Number.isSafeInteger(model.contextWindow) || model.contextWindow < 4) {
        throw new Error(
            `Portable summarizer model ${model.provider}/${model.id} has an invalid or unusably small contextWindow`,
        );
    }
    if (!Number.isSafeInteger(model.maxTokens) || model.maxTokens < 1) {
        throw new Error(
            `Portable summarizer model ${model.provider}/${model.id} has an invalid or unusably small maxTokens`,
        );
    }
    const maxOutputTokens = Math.min(
        PORTABLE_SUMMARY_MAX_OUTPUT_TOKENS,
        model.maxTokens,
        Math.floor(model.contextWindow / 4),
    );
    if (maxOutputTokens < 1) {
        throw new Error(`Portable summarizer model ${model.provider}/${model.id} cannot produce output`);
    }
    return { contextWindow: model.contextWindow, maxOutputTokens };
}

function moveBeforeSplitSurrogate(sourceText: string, startOffset: number, endOffset: number): number {
    if (endOffset <= startOffset || endOffset >= sourceText.length) return endOffset;
    const previousCodeUnit = sourceText.charCodeAt(endOffset - 1);
    const nextCodeUnit = sourceText.charCodeAt(endOffset);
    const splitsSurrogatePair = previousCodeUnit >= 0xD800
        && previousCodeUnit <= 0xDBFF
        && nextCodeUnit >= 0xDC00
        && nextCodeUnit <= 0xDFFF;
    return splitsSurrogatePair ? endOffset - 1 : endOffset;
}

function selectPortableChunkEndOffset(
    sourceText: string,
    startOffset: number,
    maxSourceCharacters: number,
): number {
    if (sourceText.length - startOffset <= maxSourceCharacters) return sourceText.length;
    const hardEndOffset = startOffset + maxSourceCharacters;
    const searchStartOffset = startOffset + Math.floor(maxSourceCharacters * 3 / 4);
    const finalQuarter = sourceText.slice(searchStartOffset, hardEndOffset);
    const doubleNewlineIndex = finalQuarter.lastIndexOf("\n\n");
    let endOffset: number;
    if (doubleNewlineIndex >= 0) {
        endOffset = searchStartOffset + doubleNewlineIndex + 2;
    } else {
        const newlineIndex = finalQuarter.lastIndexOf("\n");
        if (newlineIndex >= 0) {
            endOffset = searchStartOffset + newlineIndex + 1;
        } else {
            endOffset = hardEndOffset;
            for (let index = hardEndOffset - 1; index >= searchStartOffset; index -= 1) {
                if (/\s/u.test(sourceText[index])) {
                    endOffset = index + 1;
                    break;
                }
            }
        }
    }
    return moveBeforeSplitSurrogate(sourceText, startOffset, endOffset);
}

function validatePortableSummaryRequest(request: {
    previousSummary: string | null;
    sourceText: string;
    startOffset: number;
    coverageEntries: readonly SessionEntry[];
}): void {
    if (request.previousSummary !== null && !request.previousSummary.trim()) {
        throw new Error("Portable summarizer previousSummary must be null or nonblank text");
    }
    if (typeof request.sourceText !== "string") {
        throw new Error("Portable summarizer sourceText must be a string");
    }
    if (!Array.isArray(request.coverageEntries)) {
        throw new Error("Portable summarizer coverageEntries must be an array");
    }
    if (
        !Number.isSafeInteger(request.startOffset)
        || request.startOffset < 0
        || request.startOffset > request.sourceText.length
    ) {
        throw new Error("Portable summarizer startOffset is outside sourceText");
    }
    if (request.startOffset === request.sourceText.length) {
        throw new Error("Portable summarizer has no source text remaining");
    }
}

export async function openGroundedPortableSummarizerSession(
    request: GroundedPortableSummarizerOpenRequest,
    signal: AbortSignal,
    deps: GroundedPortableSummarizerDependencies = DEFAULT_PORTABLE_DEPS,
): Promise<GroundedPortableSummarizerSession> {
    if (signal.aborted) throw new CompactionAbortedError();
    const [config, promptContract] = await Promise.all([
        deps.loadConfig(EXTENSION_DIR),
        deps.loadCompactionPrompt(EXTENSION_DIR),
    ]);
    if (signal.aborted) throw new CompactionAbortedError();

    if (
        config.defaultPreset === CURRENT_PRESET_SENTINEL
        && request.context.model.provider === "openai-codex"
        && request.context.model.api === "openai-codex-responses"
    ) {
        throw new Error("Portable summarizer current preset requires an active non-Codex model");
    }
    const summarizer = config.defaultPreset === CURRENT_PRESET_SENTINEL
        ? await resolveDefaultSummarizer(request.context, request.branchEntries)
        : await resolvePresetSummarizer(request.context, config, config.defaultPreset);
    if (signal.aborted) throw new CompactionAbortedError();
    const provider = request.context.modelRegistry.getProvider(summarizer.model.provider);
    if (!provider) {
        throw new Error(`Provider '${summarizer.model.provider}' is not registered`);
    }

    const complete = deps.complete ?? ((model: Model<Api>, context: Context, options: SimpleStreamOptions | undefined) =>
        request.context.modelRegistry.streamSimple(model, context, {
            ...options,
            sessionId: randomUUID(),
            cacheRetention: "none",
        }).result());
    const { contextWindow, maxOutputTokens } = resolvePortableModelLimits(summarizer.model);
    const descriptor = {
        provider: summarizer.model.provider,
        api: summarizer.model.api,
        modelId: summarizer.model.id,
        thinkingLevel: summarizer.reasoningLevel ?? null,
        contextWindow,
        maxOutputTokens,
        promptFingerprint: createPortablePromptFingerprint(promptContract, config.includeFilesTouched.inCompactionSummary),
    } satisfies GroundedPortableSummarizerSession["descriptor"];
    let ledgerCache: { coverageEntries: readonly SessionEntry[]; ledger: FilesTouchedLedger } | undefined;

    return {
        descriptor,
        toolResultChars: config.toolResultChars,
        async summarizeNext(summaryRequest) {
            validatePortableSummaryRequest(summaryRequest);
            if (summaryRequest.signal.aborted) throw new CompactionAbortedError();

            // Coverage runs through the checkpoint; later branch activity must not shape a reusable checkpoint summary
            if (ledgerCache?.coverageEntries !== summaryRequest.coverageEntries) {
                ledgerCache = {
                    coverageEntries: summaryRequest.coverageEntries,
                    ledger: buildFilesTouchedLedger({
                        mode: config.includeFilesTouched.inCompactionSummary,
                        entries: [...summaryRequest.coverageEntries],
                        cwd: request.context.cwd,
                        heading: FINAL_FILES_TOUCHED_HEADING,
                        collectFilesTouchedImpl: deps.collectFilesTouched,
                    }),
                };
            }
            const ledger = ledgerCache.ledger;
            const previousSummary = stripGroundedCompactionManifestTail(
                summaryRequest.previousSummary ?? undefined,
            );
            const buildPrompt = (serializedConversation: string) => buildSummaryUserPrompt({
                mode: "history",
                promptContract,
                serializedConversation,
                previousSummary,
                filesTouchedLedger: ledger,
            });
            const fixedPromptTokens = estimateInputTokens(`${DEFAULT_SYSTEM_PROMPT}\n\n${buildPrompt("")}`);
            const maxSourceCharacters = (
                contextWindow - maxOutputTokens - fixedPromptTokens
            ) * PORTABLE_SOURCE_CHARACTERS_PER_TOKEN;
            if (maxSourceCharacters < 1) {
                throw new Error(
                    `Portable summary prompt leaves no source capacity for ${summarizer.model.provider}/${summarizer.model.id}`,
                );
            }
            const endOffset = selectPortableChunkEndOffset(
                summaryRequest.sourceText,
                summaryRequest.startOffset,
                maxSourceCharacters,
            );
            if (endOffset <= summaryRequest.startOffset) {
                throw new Error("Portable summary capacity cannot fit one UTF-16-safe source character");
            }
            const userPrompt = buildPrompt(summaryRequest.sourceText.slice(summaryRequest.startOffset, endOffset));
            const result = await executePortableSummaryRequestResult(
                {
                    request: {
                        mode: "history",
                        systemPrompt: DEFAULT_SYSTEM_PROMPT,
                        userPrompt,
                        estimatedInputTokens: estimateInputTokens(`${DEFAULT_SYSTEM_PROMPT}\n\n${userPrompt}`),
                    },
                    summarizer,
                    provider,
                    maxOutputTokens,
                    signal: summaryRequest.signal,
                },
                { complete },
            );
            const summaryBody = stripGroundedCompactionManifestTail(result.summary);
            if (!summaryBody) throw new Error("Portable summarization returned no summary body");
            return {
                summary: appendReaderLedger(summaryBody, ledger),
                endOffset,
                usage: result.usage,
            };
        },
    };
}

function buildSuccessResult(
    event: SessionBeforeCompactEvent,
    summary: string,
    summarizer: ResolvedSummarizer,
    groundedRetention?: GroundedRetentionRecord,
    groundedReading?: RequiredReadingRecord,
) {
    const details: GroundedCompactionDetails = { model: `${summarizer.model.provider}/${summarizer.model.id}` };
    if (summarizer.reasoningLevel !== undefined) details.thinkingLevel = summarizer.reasoningLevel;
    if (groundedRetention) details.groundedRetention = groundedRetention;
    if (groundedReading) details.groundedReading = groundedReading;
    return {
        compaction: {
            summary,
            firstKeptEntryId: event.preparation.firstKeptEntryId,
            tokensBefore: event.preparation.tokensBefore,
            details,
        },
    };
}

function describePresetFallback(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function resolveConfiguredDefaultSummarizer(
    ctx: HookContext,
    config: GroundedCompactionConfig,
    branchEntries: SessionEntry[],
    signal: AbortSignal,
): Promise<ResolvedSummarizer> {
    if (config.defaultPreset === CURRENT_PRESET_SENTINEL) {
        return resolveDefaultSummarizer(ctx, branchEntries);
    }

    try {
        return await resolvePresetSummarizer(ctx, config, config.defaultPreset);
    } catch (error) {
        if (isAbortError(error)) {
            throw error;
        }
        throwIfAborted(signal);
        notify(
            ctx,
            `Configured defaultPreset '${config.defaultPreset}' failed (${describePresetFallback(error)}). `
                + "Falling back to the current session model.",
            "warning",
        );
        return resolveDefaultSummarizer(ctx, branchEntries);
    }
}

export async function runGroundedBranchSummaryAugmentation(
    event: SessionBeforeTreeEvent,
    ctx: HookContext,
    deps: RunDeps = DEFAULT_DEPS,
): Promise<SessionBeforeTreeResult | undefined> {
    if (event.signal.aborted || !event.preparation.userWantsSummary || event.preparation.entriesToSummarize.length === 0) {
        return undefined;
    }

    let enforceReading = false;
    try {
        const config = await deps.loadConfig(EXTENSION_DIR);
        enforceReading = config.enforceBranchMandatoryReading;
        const promptContract = await deps.loadBranchSummaryPrompt(EXTENSION_DIR);

        const mode = config.includeFilesTouched.inBranchSummary;
        if (!enforceReading && !promptContract && mode === "off") {
            return undefined;
        }

        const filesTouchedLedger = buildFilesTouchedLedger({
            mode,
            entries: event.preparation.entriesToSummarize,
            cwd: ctx.cwd,
            heading: FILES_TOUCHED_HEADING,
            collectFilesTouchedImpl: deps.collectFilesTouched,
        });
        const instructions = buildBranchSummaryInstructions({
            promptContract,
            focusText: event.preparation.customInstructions,
            filesTouchedLedger,
        });
        if (!enforceReading) return instructions;

        const summarizer = await resolveDefaultSummarizer(ctx, ctx.sessionManager.getBranch());
        const contract = instructions?.customInstructions ?? "Summarize the abandoned branch with Goal, Constraints & Preferences, Progress, Key Decisions and Next Steps.";
        const requestParams = {
            mode: "history" as const, promptContract: contract, enforceMandatoryReading: true,
            filesTouchedLedger: { mode: "off" as const },
            focusText: instructions ? undefined : event.preparation.customInstructions,
        };
        const fixed = prepareSummaryRequest({ ...requestParams, serializedConversation: "" });
        const capacity = summarizer.model.contextWindow - summarizer.model.maxTokens - fixed.estimatedInputTokens;
        if (capacity <= 0) throw new RequiredReadingError("Branch summary instructions leave no source capacity");
        const prepared = prepareBranchEntries(event.preparation.entriesToSummarize, capacity);
        const request = prepareSummaryRequest({
            ...requestParams,
            serializedConversation: serializePreparedMessages(prepared.messages, config.toolResultChars),
        });
        const plan = preflightSummaryBatch({ batch: { kind: "history-only", history: request }, summarizer, reserveTokens: summarizer.model.maxTokens });
        const result = await executePreflightedSummaryBatch(plan, event.signal, {
            complete: deps.complete ?? ((model, context, options) => ctx.modelRegistry.streamSimple(model, context, {
                ...options, sessionId: randomUUID(), cacheRetention: "none",
            }).result()),
        });
        throwIfAborted(event.signal);
        if (!result.reading) throw new RequiredReadingError("Branch summary has no required-reading record");
        return { summary: {
            summary: appendReaderLedger(appendRequiredReading(result.summaryBody, result.reading), filesTouchedLedger),
            details: { groundedReading: result.reading },
        } };
    } catch (error) {
        if (isSignalAborted(event.signal)) {
            return enforceReading ? { cancel: true } : undefined;
        }

        const message = error instanceof Error ? error.message : String(error);
        notify(ctx, `Grounded branch-summary augmentation failed: ${message}`, "warning");
        return enforceReading ? { cancel: true } : undefined;
    }
}

export async function runGroundedCompaction(
    event: SessionBeforeCompactEvent,
    ctx: HookContext,
    deps: CompactionRunDeps,
): Promise<{ compaction: { summary: string; firstKeptEntryId: string; tokensBefore: number; details: GroundedCompactionDetails } } | { cancel: true } | undefined> {
    let summarizerIdentity = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unresolved";
    let enforceReading = false;
    const failsClosed = (cause: unknown) => enforceReading || cause instanceof RetentionError || cause instanceof IncompleteSummaryError || cause instanceof RequiredReadingError;
    const reportFailure = (cause: unknown, prefix: string) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        if (failsClosed(cause)) {
            const diagnostic = JSON.stringify({
                operation: "grounded-compaction", code: cause instanceof RetentionError ? cause.code : cause instanceof IncompleteSummaryError ? "incomplete-summary" : "required-reading-failed",
                summarizer: summarizerIdentity, sessionId: ctx.sessionManager.getSessionId(),
                entryIds: cause instanceof RetentionError ? cause.entryIds : [], message,
            });
            if (ctx.hasUI) ctx.ui.notify(diagnostic, "warning");
            else process.stderr.write(`${diagnostic}\n`);
        } else notify(ctx, `${prefix}: ${message}`, "warning");
    };
    try {
        throwIfAborted(event.signal);
        let initialProjection: SessionProjection;
        let systemMessage: SystemMessage | undefined;
        try {
            initialProjection = buildSessionProjection(event.branchEntries);
            systemMessage = structuredClone(getCurrentSystemMessage(initialProjection.messages));
        }
        catch (cause) { throw new RetentionError("session-state", "Compaction prompt/tool state could not be captured", [], { cause }); }
        const owner = {
            sessionId: ctx.sessionManager.getSessionId(), sessionDir: ctx.sessionManager.getSessionDir(),
            leafId: ctx.sessionManager.getLeafId(), model: ctx.model ? { ...ctx.model } : undefined,
            systemMessage,
        };
        const config = await deps.loadConfig(EXTENSION_DIR);
        enforceReading = config.enforceCompactionMandatoryReading;
        let retention: { budget: number; snapshot: RetentionSnapshot; sources: RetentionSources } | undefined;
        if (config.verbatimUserMessageTokens !== null) {
            const snapshot = captureRetentionSnapshot(event, owner);
            retention = {
                budget: config.verbatimUserMessageTokens, snapshot,
                sources: prepareRetentionSources(event, snapshot, config.verbatimUserMessageFlagChars),
            };
        }
        const summaryDeps: SummaryExecutionDeps = {
            ...deps,
            // Keep one-off summaries off the active conversation's Claude session lane.
            complete: deps.complete ?? ((model, context, options) => ctx.modelRegistry.streamSimple(model, context, {
                ...options,
                sessionId: randomUUID(),
                cacheRetention: "none",
            }).result()),
        };
        const promptContract = await deps.loadCompactionPrompt(EXTENSION_DIR);
        const parsedInstructions = parseCompactInstructions(event.customInstructions);
        const filesTouchedLedger = buildFilesTouchedLedger({
            mode: config.includeFilesTouched.inCompactionSummary,
            entries: event.branchEntries,
            cwd: ctx.cwd,
            heading: FINAL_FILES_TOUCHED_HEADING,
            collectFilesTouchedImpl: deps.collectFilesTouched,
        });
        const projection = retention?.snapshot.projection ?? initialProjection;
        const previousSummary = readPreparedSummaryBody(event, projection, (compactionEntryId) => deps.queryPreviousSummary({
            compactionEntryId,
            branchEntries: event.branchEntries,
            sessionEntries: ctx.sessionManager.getEntries(),
        }));
        const previousCompaction = projection.entries.map((entry) => entry.sourceEntry).findLast((entry) => entry.type === "compaction");
        const batch = prepareSummaryBatch({
            enforceMandatoryReading: config.enforceCompactionMandatoryReading,
            previousReading: config.enforceCompactionMandatoryReading && previousCompaction ? requiredReadingRecord(previousCompaction) : undefined,
            event,
            promptContract,
            toolResultChars: config.toolResultChars,
            focusText: parsedInstructions.focusText,
            previousSummary,
            filesTouchedLedger,
            retention: retention ? {
                history: serializeRetentionSpan(retention.sources.history, retention.sources, config.toolResultChars),
                turnPrefix: serializeRetentionSpan(retention.sources.turnPrefix, retention.sources, config.toolResultChars),
            } : undefined,
        });
        const reserveTokens = event.preparation.settings.reserveTokens;
        const finish = async (summary: Awaited<ReturnType<typeof executePreflightedSummaryBatch>>, summarizer: ResolvedSummarizer) => {
            throwIfAborted(event.signal);
            assertCompactionOwner(owner, ctx.sessionManager, ctx.model);
            const summaryBody = summary.reading ? appendRequiredReading(summary.summaryBody, summary.reading) : summary.summaryBody;
            if (!retention) {
                const text = appendReaderLedger(summaryBody, filesTouchedLedger);
                remainingContinuationTokens({
                    branchEntries: event.branchEntries, projection, summary: text,
                    firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore,
                    contextWindow: owner.model?.contextWindow, reserveTokens,
                });
                return buildSuccessResult(event, text, summarizer, undefined, summary.reading);
            }
            const { snapshot, sources, budget } = retention;
            const result = selectRetainedSupplement({
                event, snapshot, sources, decisions: new Map([...sources.carriedDecisions, ...summary.decisions]),
                summaryBody, ledger: filesTouchedLedger, budget,
            });
            await publishSelectedSidecars(result.selected, event.signal);
            assertCompactionOwner(owner, ctx.sessionManager, ctx.model);
            throwIfAborted(event.signal);
            return buildSuccessResult(event, result.summary, summarizer, result.record, summary.reading);
        };

        if (parsedInstructions.usesPresetDirective) {
            let summarizer: ResolvedSummarizer;
            try {
                if (!parsedInstructions.presetQuery) {
                    notify(ctx, "Malformed preset directive. Falling back to the current session model.", "warning");
                    summarizer = await resolveDefaultSummarizer(ctx, event.branchEntries);
                } else if (parsedInstructions.presetQuery === CURRENT_PRESET_SENTINEL) {
                    summarizer = await resolveDefaultSummarizer(ctx, event.branchEntries);
                } else {
                    try {
                        summarizer = await resolvePresetSummarizer(ctx, config, parsedInstructions.presetQuery);
                    } catch (error) {
                        if (isAbortError(error)) {
                            throw error;
                        }
                        throwIfAborted(event.signal);
                        notify(
                            ctx,
                            `Preset '${parsedInstructions.presetQuery}' failed (${describePresetFallback(error)}). `
                                + "Falling back to the current session model.",
                            "warning",
                        );
                        summarizer = await resolveDefaultSummarizer(ctx, event.branchEntries);
                    }
                }

                const plan = preflightSummaryBatch({ batch, summarizer, reserveTokens });
                summarizerIdentity = `${summarizer.model.provider}/${summarizer.model.id}`;
                const summary = await executePreflightedSummaryBatch(
                    plan,
                    event.signal,
                    summaryDeps,
                );
                return await finish(summary, summarizer);
            } catch (error) {
                if (isAbortError(error) || event.signal.aborted) {
                    return { cancel: true };
                }
                reportFailure(error, "Grounded preset compaction failed");
                return { cancel: true };
            }
        }

        const defaultSummarizer = await resolveConfiguredDefaultSummarizer(
            ctx,
            config,
            event.branchEntries,
            event.signal,
        );
        let route: SummaryExecutionRoute;
        try {
            route = await selectOrdinarySummaryRoute({
                batch,
                defaultSummarizer,
                config,
                ctx,
                reserveTokens,
            });
        } catch (error) {
            if (isAbortError(error) || event.signal.aborted) {
                return { cancel: true };
            }
            notify(ctx, `Grounded compaction capacity routing failed: ${describePresetFallback(error)}`, "warning");
            return { cancel: true };
        }

        if (route.kind === "large-context") {
            if (event.signal.aborted) {
                return { cancel: true };
            }
            const issue = route.defaultCapacityFailure.issue;
            if (issue.kind !== "request-too-large") {
                throw new Error("Invalid large-context route without a request capacity failure");
            }
            notify(
                ctx,
                `Grounded compaction ${issue.mode} request does not fit ${issue.modelKey}; routing to `
                    + `${route.presetName} (${route.plan.capacity.modelKey}).`,
                "info",
            );
        }

        try {
            summarizerIdentity = `${route.plan.summarizer.model.provider}/${route.plan.summarizer.model.id}`;
            const summary = await executePreflightedSummaryBatch(
                route.plan,
                event.signal,
                summaryDeps,
            );
            return await finish(summary, route.plan.summarizer);
        } catch (error) {
            if (isAbortError(error) || event.signal.aborted) {
                return { cancel: true };
            }
            reportFailure(error, "Grounded compaction failed");
            return route.kind === "large-context" || failsClosed(error) ? { cancel: true } : undefined;
        }
    } catch (error) {
        if (isAbortError(error) || event.signal.aborted) {
            return { cancel: true };
        }

        reportFailure(error, "Grounded compaction failed");
        return failsClosed(error) || parseCompactInstructions(event.customInstructions).usesPresetDirective ? { cancel: true } : undefined;
    }
}

export interface GroundedCompactionExtensionDependencies {
    loadConfig?: RunDeps["loadConfig"];
    runCompaction?: GroundedCompactionRunner;
    runBranchSummary?: typeof runGroundedBranchSummaryAugmentation;
    openPortableSession?: GroundedPortableSummarizerOpener;
}

export function registerGroundedCompaction(
    pi: ExtensionAPI,
    dependencies: GroundedCompactionExtensionDependencies = {},
): void {
    registerReadingGate(pi, dependencies.loadConfig ?? loadConfig);
    registerGroundedCompactionHandlers(pi, {
        runCompaction: dependencies.runCompaction
            ?? ((event, ctx, queryPreviousSummary) => runGroundedCompaction(event, ctx, { ...DEFAULT_DEPS, queryPreviousSummary })),
        runBranchSummary: dependencies.runBranchSummary ?? runGroundedBranchSummaryAugmentation,
    });
    registerGroundedPortableSummarizer(
        pi,
        dependencies.openPortableSession ?? openGroundedPortableSummarizerSession,
    );
}

export default function groundedCompactionExtension(pi: ExtensionAPI): void {
    registerFilesTouchedTracking(pi);
    registerGroundedCompaction(pi);
}
