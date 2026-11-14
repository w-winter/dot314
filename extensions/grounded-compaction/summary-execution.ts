import type { Api, AssistantMessage, Context, Message, Model, Provider, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { completeSimple } from "@earendil-works/pi-ai/compat";
import type { SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";

import { estimateInputTokens } from "../_shared/compaction-serialization.ts";
import type { SavedRetentionDecision } from "../_shared/grounded-compaction-record.ts";
import { parseRetentionResponse, RetentionError, type RetentionSpan } from "./retention.ts";
import { REQUIRED_READING_INSTRUCTIONS, parseRequiredReadingResponse, type RequiredReadingRecord } from "./required-reading.ts";
import {
    resolvePresetSummarizer,
    toReasoningLevel,
    type GroundedCompactionConfig,
    type ResolvedSummarizer,
    type SummarizerContext,
} from "./configuration.ts";
import type { PortableSummaryUsage } from "./portable-summarizer.ts";
import {
    DEFAULT_SYSTEM_PROMPT,
    RETENTION_RESPONSE_INSTRUCTIONS,
    buildSummaryUserPrompt,
    mergeSplitTurnSummary,
    serializePreparedMessages,
    stripGroundedCompactionManifestTail,
    type FilesTouchedLedger,
    type SummaryMode,
} from "./prompts.ts";

export type PreparedSummaryRequest = Readonly<{
    mode: SummaryMode;
    systemPrompt: string;
    userPrompt: string;
    estimatedInputTokens: number;
    retention?: RetentionSpan;
    enforceMandatoryReading?: boolean;
}>;

export type PreparedSummaryBatch =
    | Readonly<{
        kind: "history-only";
        history: PreparedSummaryRequest;
    }>
    | Readonly<{
        kind: "split-turn";
        history?: PreparedSummaryRequest;
        turnPrefix: PreparedSummaryRequest;
        carriedHistorySummary?: string;
        carriedReading?: RequiredReadingRecord;
    }>;

/**
 * A summarizer's fit check. `reservedOutputTokens` is the headroom preflight keeps free for the response;
 * `requestedOutputTokens` is the output limit the completion asks for. The provider decides the limit it enforces.
 */
type ModelSummaryCapacity = Readonly<{
    modelKey: string;
    contextWindow: number;
    reservedOutputTokens: number;
    requestedOutputTokens: number;
}>;

type PreflightedSummaryBatch = Readonly<{
    batch: PreparedSummaryBatch;
    summarizer: ResolvedSummarizer;
    capacity: ModelSummaryCapacity;
}>;

export type SummaryExecutionRoute =
    | Readonly<{ kind: "default"; plan: PreflightedSummaryBatch }>
    | Readonly<{
        kind: "large-context";
        presetName: string;
        plan: PreflightedSummaryBatch;
        defaultCapacityFailure: SummaryCapacityError;
    }>;

type SummaryCapacityIssue =
    | Readonly<{ kind: "invalid-reserve-tokens"; reserveTokens: number }>
    | Readonly<{ kind: "invalid-context-window"; modelKey: string; contextWindow: number }>
    | Readonly<{ kind: "invalid-max-output-tokens"; modelKey: string; maxTokens: number }>
    | Readonly<{
        kind: "request-too-large";
        modelKey: string;
        mode: SummaryMode;
        estimatedInputTokens: number;
        reservedOutputTokens: number;
        contextWindow: number;
    }>;

export type SummaryExecutionDeps = { complete: typeof completeSimple };

export type PortableSummaryCompletion = (
    model: Model<Api>,
    context: Context,
    options: SimpleStreamOptions | undefined,
    provider: Provider,
) => Promise<AssistantMessage>;

export class CompactionAbortedError extends Error {
    constructor() {
        super("Compaction aborted");
        this.name = "AbortError";
    }
}

/** A summary that stopped at its output limit; installing it would drop whatever it had not yet written. */
export class IncompleteSummaryError extends Error {
    constructor() {
        super("Summarization reached the output token limit before finishing");
        this.name = "IncompleteSummaryError";
    }
}

function describeSummaryCapacityIssue(issue: SummaryCapacityIssue): string {
    switch (issue.kind) {
        case "invalid-reserve-tokens":
            return `Invalid summary reserveTokens: ${issue.reserveTokens}`;
        case "invalid-context-window":
            return `${issue.modelKey} context window must be a positive finite number; received ${issue.contextWindow}`;
        case "invalid-max-output-tokens":
            return `${issue.modelKey} maxTokens must be a positive finite number; received ${issue.maxTokens}`;
        case "request-too-large":
            return `Estimated ${issue.mode} summary request (${issue.estimatedInputTokens} + ${issue.reservedOutputTokens}) `
                + `exceeds ${issue.modelKey} context window ${issue.contextWindow}`;
    }
}

export class SummaryCapacityError extends Error {
    readonly issue: SummaryCapacityIssue;

    constructor(issue: SummaryCapacityIssue) {
        super(describeSummaryCapacityIssue(issue));
        this.name = "SummaryCapacityError";
        this.issue = issue;
    }
}

export function prepareSummaryRequest(params: {
    mode: SummaryMode;
    promptContract: string;
    serializedConversation: string;
    previousSummary?: string;
    focusText?: string;
    filesTouchedLedger: FilesTouchedLedger;
    splitTurn?: boolean;
    retention?: RetentionSpan;
    enforceMandatoryReading?: boolean;
}): PreparedSummaryRequest {
    const userPrompt = buildSummaryUserPrompt(params);
    const systemPrompt = DEFAULT_SYSTEM_PROMPT
        + (params.retention ? `\n\n${RETENTION_RESPONSE_INSTRUCTIONS}` : "")
        + (params.enforceMandatoryReading ? `\n\n${REQUIRED_READING_INSTRUCTIONS}` : "");
    return {
        mode: params.mode,
        systemPrompt,
        userPrompt,
        estimatedInputTokens: estimateInputTokens(`${systemPrompt}\n\n${userPrompt}`),
        retention: params.retention,
        enforceMandatoryReading: params.enforceMandatoryReading,
    };
}

function resolveModelSummaryCapacity(model: Model<Api>, reserveTokens: number): ModelSummaryCapacity {
    const modelKey = `${model.provider}/${model.id}`;
    if (!Number.isFinite(reserveTokens) || reserveTokens <= 0) {
        throw new SummaryCapacityError({ kind: "invalid-reserve-tokens", reserveTokens });
    }
    if (!Number.isFinite(model.contextWindow) || model.contextWindow <= 0) {
        throw new SummaryCapacityError({
            kind: "invalid-context-window",
            modelKey,
            contextWindow: model.contextWindow,
        });
    }
    if (!Number.isFinite(model.maxTokens) || model.maxTokens <= 0) {
        throw new SummaryCapacityError({
            kind: "invalid-max-output-tokens",
            modelKey,
            maxTokens: model.maxTokens,
        });
    }

    return {
        modelKey,
        contextWindow: model.contextWindow,
        reservedOutputTokens: Math.min(reserveTokens, model.maxTokens),
        requestedOutputTokens: model.maxTokens,
    };
}

export function preflightSummaryBatch(params: {
    batch: PreparedSummaryBatch;
    summarizer: ResolvedSummarizer;
    reserveTokens: number;
}): PreflightedSummaryBatch {
    const capacity = resolveModelSummaryCapacity(params.summarizer.model, params.reserveTokens);
    const requests = params.batch.kind === "history-only"
        ? [params.batch.history]
        : [params.batch.history, params.batch.turnPrefix].filter(
            (request): request is PreparedSummaryRequest => request !== undefined,
        );

    for (const request of requests) {
        if (request.estimatedInputTokens + capacity.reservedOutputTokens > capacity.contextWindow) {
            throw new SummaryCapacityError({
                kind: "request-too-large",
                modelKey: capacity.modelKey,
                mode: request.mode,
                estimatedInputTokens: request.estimatedInputTokens,
                reservedOutputTokens: capacity.reservedOutputTokens,
                contextWindow: capacity.contextWindow,
            });
        }
    }

    return { batch: params.batch, summarizer: params.summarizer, capacity };
}

function buildSummaryRequestMessage(userPrompt: string): Message {
    return {
        role: "user",
        content: [{ type: "text", text: userPrompt }],
        timestamp: Date.now(),
    };
}

function getTextFromAssistantResponse(response: AssistantMessage): string {
    return response.content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join("\n")
        .trim();
}

type SummaryCallResult = {
    summary: string;
    usage: PortableSummaryUsage | null;
};

function normalizeSummaryUsage(usage: AssistantMessage["usage"] | undefined): PortableSummaryUsage | null {
    if (!usage) return null;
    return {
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        totalTokens: usage.totalTokens,
        cost: {
            input: usage.cost.input,
            output: usage.cost.output,
            cacheRead: usage.cost.cacheRead,
            cacheWrite: usage.cost.cacheWrite,
            total: usage.cost.total,
        },
    };
}

async function executePreparedSummaryRequestResult(params: {
    request: PreparedSummaryRequest;
    summarizer: ResolvedSummarizer;
    maxOutputTokens: number;
    signal: AbortSignal;
}, deps: Pick<SummaryExecutionDeps, "complete">): Promise<SummaryCallResult> {
    if (params.signal.aborted) {
        throw new CompactionAbortedError();
    }

    const reasoningLevel = toReasoningLevel(params.summarizer.reasoningLevel);
    const options = reasoningLevel
        ? {
            apiKey: params.summarizer.apiKey,
            headers: params.summarizer.headers,
            maxTokens: params.maxOutputTokens,
            signal: params.signal,
            reasoning: reasoningLevel,
        }
        : {
            apiKey: params.summarizer.apiKey,
            headers: params.summarizer.headers,
            maxTokens: params.maxOutputTokens,
            signal: params.signal,
        };

    const response = await deps.complete(
        params.summarizer.model,
        {
            systemPrompt: params.request.systemPrompt,
            messages: [buildSummaryRequestMessage(params.request.userPrompt)],
        },
        options,
    );

    if (isSignalAborted(params.signal) || response.stopReason === "aborted") {
        throw new CompactionAbortedError();
    }
    if (response.stopReason === "error") {
        throw new Error(response.errorMessage || "Summarization failed");
    }
    if (response.stopReason === "length") {
        throw new IncompleteSummaryError();
    }

    const summary = getTextFromAssistantResponse(response);
    if (!summary) {
        if (params.request.retention) throw new RetentionError("invalid-decisions", "Retention response is empty");
        throw new Error("Summarization returned empty output");
    }
    return { summary, usage: normalizeSummaryUsage(response.usage) };
}

export async function executePortableSummaryRequestResult(params: {
    request: PreparedSummaryRequest;
    summarizer: ResolvedSummarizer;
    provider: Provider;
    maxOutputTokens: number;
    signal: AbortSignal;
}, deps: { complete: PortableSummaryCompletion }): Promise<SummaryCallResult> {
    if (params.signal.aborted) throw new CompactionAbortedError();
    const reasoningLevel = toReasoningLevel(params.summarizer.reasoningLevel);
    const options: SimpleStreamOptions = {
        apiKey: params.summarizer.apiKey,
        headers: params.summarizer.headers,
        maxTokens: params.maxOutputTokens,
        signal: params.signal,
    };
    if (reasoningLevel) options.reasoning = reasoningLevel;
    const response = await deps.complete(
        params.summarizer.model,
        {
            systemPrompt: params.request.systemPrompt,
            messages: [buildSummaryRequestMessage(params.request.userPrompt)],
        },
        options,
        params.provider,
    );
    if (isSignalAborted(params.signal) || response.stopReason === "aborted") {
        throw new CompactionAbortedError();
    }
    if (response.stopReason === "error") {
        throw new Error(response.errorMessage || "Summarization failed");
    }
    if (response.stopReason === "length") {
        throw new Error("Portable summarization reached the output token limit");
    }
    const summary = getTextFromAssistantResponse(response);
    if (!summary) throw new Error("Summarization returned empty output");
    return { summary, usage: normalizeSummaryUsage(response.usage) };
}

async function executePreparedSummaryRequest(params: {
    request: PreparedSummaryRequest;
    summarizer: ResolvedSummarizer;
    maxOutputTokens: number;
    signal: AbortSignal;
}, deps: SummaryExecutionDeps): Promise<string> {
    return (await executePreparedSummaryRequestResult(params, deps)).summary;
}

export function prepareSummaryBatch(params: {
    event: SessionBeforeCompactEvent;
    promptContract: string;
    toolResultChars: number | null;
    focusText?: string;
    previousSummary?: string;
    filesTouchedLedger: FilesTouchedLedger;
    retention?: { history: RetentionSpan; turnPrefix: RetentionSpan };
    enforceMandatoryReading?: boolean;
    previousReading?: RequiredReadingRecord;
}): PreparedSummaryBatch {
    const { event, promptContract, toolResultChars, focusText, previousSummary, filesTouchedLedger } = params;
    if (event.preparation.isSplitTurn && event.preparation.turnPrefixMessages.length > 0) {
        const history = event.preparation.messagesToSummarize.length > 0
            ? prepareSummaryRequest({
                enforceMandatoryReading: params.enforceMandatoryReading,
                mode: "history",
                promptContract,
                retention: params.retention?.history,
                serializedConversation: params.retention ? params.retention.history.text : serializePreparedMessages(
                    event.preparation.messagesToSummarize,
                    toolResultChars,
                ),
                previousSummary,
                focusText,
                filesTouchedLedger,
                splitTurn: true,
            })
            : undefined;
        const turnPrefix = prepareSummaryRequest({
            enforceMandatoryReading: params.enforceMandatoryReading,
            mode: "turn-prefix",
            promptContract,
            retention: params.retention?.turnPrefix,
            serializedConversation: params.retention ? params.retention.turnPrefix.text : serializePreparedMessages(
                event.preparation.turnPrefixMessages,
                toolResultChars,
            ),
            focusText,
            filesTouchedLedger,
        });
        return {
            kind: "split-turn",
            history,
            turnPrefix,
            carriedHistorySummary: history ? undefined : previousSummary,
            carriedReading: history ? undefined : params.previousReading,
        };
    }

    return {
        kind: "history-only",
        history: prepareSummaryRequest({
            enforceMandatoryReading: params.enforceMandatoryReading,
            mode: "history",
            promptContract,
            retention: params.retention?.history,
            serializedConversation: params.retention ? params.retention.history.text : serializePreparedMessages(
                event.preparation.messagesToSummarize,
                toolResultChars,
            ),
            previousSummary,
            focusText,
            filesTouchedLedger,
        }),
    };
}

export async function executePreflightedSummaryBatch(
    plan: PreflightedSummaryBatch,
    signal: AbortSignal,
    deps: SummaryExecutionDeps,
): Promise<{ summaryBody: string; decisions: ReadonlyMap<string, SavedRetentionDecision>; reading?: RequiredReadingRecord }> {
    // Each output is stripped before merging so a copied ledger cannot survive inside the merged summary
    const execute = async (request: PreparedSummaryRequest) => {
        const response = await executePreparedSummaryRequest(
            {
                request,
                summarizer: plan.summarizer,
                maxOutputTokens: plan.capacity.requestedOutputTokens,
                signal,
            },
            deps,
        );
        const readingResponse = request.enforceMandatoryReading ? parseRequiredReadingResponse(response) : undefined;
        const body = readingResponse ? readingResponse.summaryBody : response;
        const parsed = request.retention
            ? parseRetentionResponse(body, request.retention.offered)
            : { summaryBody: body, decisions: new Map<string, SavedRetentionDecision>() };
        const summaryBody = stripGroundedCompactionManifestTail(parsed.summaryBody);
        if (!summaryBody) {
            if (request.retention) throw new RetentionError("invalid-decisions", "Retention response has no summary body after ledger cleanup");
            throw new Error("Summarization returned no summary body");
        }
        return { summaryBody, decisions: parsed.decisions, reading: readingResponse?.reading };
    };

    if (plan.batch.kind === "history-only") {
        return execute(plan.batch.history);
    }

    const [historySummary, turnPrefixSummary] = await Promise.all([
        plan.batch.history ? execute(plan.batch.history) : Promise.resolve({
            summaryBody: plan.batch.carriedHistorySummary, decisions: new Map<string, SavedRetentionDecision>(), reading: plan.batch.carriedReading,
        }),
        execute(plan.batch.turnPrefix),
    ]);
    return {
        summaryBody: mergeSplitTurnSummary(historySummary.summaryBody, turnPrefixSummary.summaryBody),
        decisions: new Map([...historySummary.decisions, ...turnPrefixSummary.decisions]),
        reading: turnPrefixSummary.reading ? {
            version: 1,
            paths: [...new Set([...(historySummary.reading?.paths ?? []), ...turnPrefixSummary.reading.paths])],
        } : undefined,
    };
}

export function isAbortError(cause: unknown): boolean {
    return cause instanceof CompactionAbortedError;
}

export function isSignalAborted(signal: AbortSignal): boolean {
    return signal.aborted;
}

export function throwIfAborted(signal: AbortSignal): void {
    if (isSignalAborted(signal)) {
        throw new CompactionAbortedError();
    }
}

export async function selectOrdinarySummaryRoute(params: {
    batch: PreparedSummaryBatch;
    defaultSummarizer: ResolvedSummarizer;
    config: GroundedCompactionConfig;
    ctx: SummarizerContext;
    reserveTokens: number;
}): Promise<SummaryExecutionRoute> {
    try {
        return {
            kind: "default",
            plan: preflightSummaryBatch({
                batch: params.batch,
                summarizer: params.defaultSummarizer,
                reserveTokens: params.reserveTokens,
            }),
        };
    } catch (error) {
        if (!(error instanceof SummaryCapacityError) || error.issue.kind !== "request-too-large") {
            throw error;
        }

        const presetName = params.config.largeContextPreset;
        if (!presetName) {
            throw error;
        }

        const largeSummarizer = await resolvePresetSummarizer(params.ctx, params.config, presetName);
        const largeCapacity = resolveModelSummaryCapacity(largeSummarizer.model, params.reserveTokens);
        if (largeCapacity.contextWindow <= error.issue.contextWindow) {
            throw new Error(
                `Configured largeContextPreset '${presetName}' must have a strictly larger context window than `
                    + `${error.issue.modelKey} (${largeCapacity.contextWindow} <= ${error.issue.contextWindow})`,
            );
        }
        const plan = preflightSummaryBatch({
            batch: params.batch,
            summarizer: largeSummarizer,
            reserveTokens: params.reserveTokens,
        });

        return {
            kind: "large-context",
            presetName,
            plan,
            defaultCapacityFailure: error,
        };
    }
}
