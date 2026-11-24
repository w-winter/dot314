import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
    getStateDir,
    loadState,
    resolveConversationLineage,
    saveStateAtomically,
    type LineageSegment,
    type ResolvedLineage,
} from "./lineage.ts";
import {
    loadSharedGroundedConfig,
    loadSharedPromptContract,
    runPiSummarizer,
    type PiSummaryRequest,
    type PiSummaryResult,
    type SharedGroundedConfig,
} from "./summarizer.ts";
import {
    GROUNDED_COMPACTION_MARKER,
    chunkInjectedPayload,
    collectAgyFilesTouchedBlock,
    findLatestActiveCheckpoint,
    parseCompactCommand,
    parseNativeUserRequests,
    parseTranscriptRecords,
    selectVerbatimUserMessages,
    serializeSpanForSummary,
} from "./transcript.ts";

export interface PreInvocationHookInput {
    readonly conversationId: string;
    readonly transcriptPath: string;
    readonly invocationNum: number;
    readonly lastUserInput?: string;
}

export interface InjectedSystemStep {
    readonly systemMessage: {
        readonly systemMessage: string;
    };
}

export interface PreInvocationHookOutput {
    readonly injectSteps?: readonly InjectedSystemStep[];
}

export interface HookDeps {
    readonly loadConfig: () => Promise<SharedGroundedConfig>;
    readonly loadPromptContract: () => Promise<string>;
    readonly runSummarizer: (request: PiSummaryRequest) => Promise<PiSummaryResult>;
}

const DEFAULT_DEPS: HookDeps = {
    loadConfig: () => loadSharedGroundedConfig(),
    loadPromptContract: () => loadSharedPromptContract(),
    runSummarizer: (request) => runPiSummarizer(request),
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readCompactTranscriptForScan(transcriptPath: string): Promise<string | null> {
    const compactSibling = path.join(path.dirname(transcriptPath), "transcript.jsonl");
    for (const candidate of [compactSibling, transcriptPath]) {
        try {
            return await readFile(candidate, "utf8");
        } catch {
            continue;
        }
    }
    return null;
}

async function appendHookLog(stateDir: string, entry: Record<string, unknown>): Promise<void> {
    await mkdir(stateDir, { recursive: true });
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry });
    await appendFile(path.join(stateDir, "hook.log"), `${line}\n`, "utf8");
}

function formatSegmentPaths(segments: readonly LineageSegment[]): string {
    if (segments.length === 1) {
        return `Any Retrieval cues listed below refer to raw pre-compaction history preserved on disk at ${segments[0].transcriptPath} (and its compact sibling transcript.jsonl).`;
    }
    const lines = ["Any Retrieval cues listed below refer to raw history preserved across these stitched transcript logs:"];
    for (let i = 0; i < segments.length; i += 1) {
        const seg = segments[i];
        const range = seg.endStepExclusive === null
            ? `steps ${seg.startStepInclusive}..`
            : `steps ${seg.startStepInclusive}..${seg.endStepExclusive - 1}`;
        const label = i === segments.length - 1 ? "Post-fork history" : "Pre-fork history";
        lines.push(`- ${label} (${range}): ${seg.transcriptPath}`);
    }
    return lines.join("\n");
}

function buildPrecedenceHeader(params: {
    checkpointStep: number;
    model: string;
    thinkingLevel?: string;
    verbatimCount: number;
    verbatimTokens: number;
    omittedNativeCount: number;
    lineage: ResolvedLineage;
    transcriptPath: string;
}): string {
    const modelLabel = params.thinkingLevel ? `${params.model} (${params.thinkingLevel})` : params.model;
    const verbatimNote = params.verbatimCount > 0
        ? ` Followed by ${params.verbatimCount} verbatim pre-compaction user messages (~${params.verbatimTokens} tokens).`
        : params.omittedNativeCount > 0
            ? " All pre-compaction user messages were already retained verbatim in Antigravity's # User Requests section above."
            : "";

    if (params.lineage.kind === "forked-unresolved") {
        const start = params.lineage.firstStepIndex;
        const end = params.checkpointStep - 1;
        return [
            `Post-fork grounded compaction supplement generated externally by ${modelLabel} for native compaction step ${params.checkpointStep} (covers post-fork steps ${start}..${end} only; pre-fork history (steps 0..${start - 1}) was unavailable on disk).${verbatimNote}`,
            `Treat this summary and any verbatim user messages below as authoritative ONLY for post-fork steps ${start}..${end}. Rely on Antigravity's earlier automatic compaction checkpoint for pre-fork goals, constraints, and decisions from steps 0..${start - 1}, and ask the user if anything appears contradictory or ambiguous.`,
            `Post-fork raw history (steps ${start}..) is preserved on disk at ${params.transcriptPath} (and its compact sibling transcript.jsonl).`,
        ].join("\n");
    }

    const stitchedNote = params.lineage.segments.length > 1 ? " (including stitched pre-fork parent lineage)" : "";
    return [
        `Authoritative grounded compaction checkpoint generated externally by ${modelLabel} for native compaction step ${params.checkpointStep}${stitchedNote}.${verbatimNote}`,
        "Where this grounded summary conflicts with Antigravity's earlier automatic compaction checkpoint, treat this grounded summary and any verbatim user messages below as authoritative.",
        formatSegmentPaths(params.lineage.segments),
    ].join("\n");
}

export async function processPreInvocation(
    input: PreInvocationHookInput,
    deps: HookDeps = DEFAULT_DEPS,
): Promise<PreInvocationHookOutput> {
    // Do not inject right before /compact runs and resets model context.
    if (input.invocationNum === 0 && input.lastUserInput && parseCompactCommand(input.lastUserInput).isCompact) {
        return {};
    }

    const scanContent = await readCompactTranscriptForScan(input.transcriptPath);
    if (!scanContent) {
        return {};
    }

    const latestCheckpoint = findLatestActiveCheckpoint(scanContent);
    if (latestCheckpoint === null) {
        return {};
    }

    const stateDir = getStateDir(input.transcriptPath);
    const stateFile = path.join(stateDir, "state.json");
    const existingState = await loadState(stateFile);
    if (Object.hasOwn(existingState.checkpoints, latestCheckpoint.key)) {
        return {};
    }

    const fullContent = await readFile(input.transcriptPath, "utf8");
    const childRecords = parseTranscriptRecords(fullContent);
    const checkpointRec = childRecords.find(
        (rec) => rec.kind === "CHECKPOINT" && rec.stepIndex === latestCheckpoint.stepIndex,
    );
    const nativeUserRequests = checkpointRec ? parseNativeUserRequests(checkpointRec.content) : [];

    const lineage = await resolveConversationLineage({
        conversationId: input.conversationId,
        transcriptPath: input.transcriptPath,
        childRecords,
        childState: existingState,
        checkpointStep: latestCheckpoint.stepIndex,
        nativeUserRequests,
    });

    const parentFields = lineage.kind === "complete" && lineage.parentConversationId
        ? {
            parentConversationId: lineage.parentConversationId,
            ...(lineage.forkStepIndex !== undefined ? { forkStepIndex: lineage.forkStepIndex } : {}),
        }
        : {
            ...(existingState.parentConversationId ? { parentConversationId: existingState.parentConversationId } : {}),
            ...(existingState.forkStepIndex !== undefined ? { forkStepIndex: existingState.forkStepIndex } : {}),
        };

    const config = await deps.loadConfig();
    const priorInjected = lineage.priorInjectedCheckpoint;
    const spanStartExclusive = priorInjected ? priorInjected.stepIndex : -1;
    const span = serializeSpanForSummary(
        lineage.records,
        spanStartExclusive,
        latestCheckpoint.stepIndex,
        config.toolResultChars,
    );

    if (!span.hasContent) {
        await saveStateAtomically(stateDir, {
            version: 2,
            ...parentFields,
            checkpoints: {
                ...existingState.checkpoints,
                [latestCheckpoint.key]: {
                    stepIndex: latestCheckpoint.stepIndex,
                    createdAt: latestCheckpoint.createdAt,
                    status: "skipped-empty",
                    updatedAt: new Date().toISOString(),
                },
            },
        });
        await appendHookLog(stateDir, {
            event: "skipped-empty",
            conversationId: input.conversationId,
            checkpointStep: latestCheckpoint.stepIndex,
            checkpointKey: latestCheckpoint.key,
            lineageKind: lineage.kind,
            spanStartExclusive,
        });
        return {};
    }

    const filesTouchedBlock =
        config.includeFilesTouched === "off"
            ? undefined
            : collectAgyFilesTouchedBlock(lineage.records, latestCheckpoint.stepIndex);

    try {
        const promptContract = await deps.loadPromptContract();
        const summaryResult = await deps.runSummarizer({
            config,
            promptContract,
            serializedConversation: span.serializedConversation,
            previousSummary: priorInjected?.summary,
            focusText: span.focusText,
            filesTouchedBlock,
            ...(lineage.kind === "forked-unresolved" ? { missingPrefixBeforeStep: lineage.firstStepIndex } : {}),
        });

        const verbatim = config.verbatimUserMessageTokens
            ? selectVerbatimUserMessages(
                lineage.records,
                latestCheckpoint.stepIndex,
                config.verbatimUserMessageTokens,
                nativeUserRequests,
            )
            : { section: "", selectedCount: 0, estimatedTokens: 0, omittedNativeCount: 0 };

        const bodyParts = [summaryResult.summary.trim()];
        if (config.includeFilesTouched === "writerAndReader" && filesTouchedBlock) {
            bodyParts.push(`---\n\n${filesTouchedBlock}`);
        }
        if (verbatim.section) {
            bodyParts.push(`---\n\n${verbatim.section}`);
        }

        const headerBlock = buildPrecedenceHeader({
            checkpointStep: latestCheckpoint.stepIndex,
            model: summaryResult.model,
            thinkingLevel: summaryResult.thinkingLevel,
            verbatimCount: verbatim.selectedCount,
            verbatimTokens: verbatim.estimatedTokens,
            omittedNativeCount: verbatim.omittedNativeCount,
            lineage,
            transcriptPath: input.transcriptPath,
        });

        const chunks = chunkInjectedPayload({
            checkpointStep: latestCheckpoint.stepIndex,
            headerBlock,
            bodyText: bodyParts.join("\n\n"),
        });

        await saveStateAtomically(stateDir, {
            version: 2,
            ...parentFields,
            checkpoints: {
                ...existingState.checkpoints,
                [latestCheckpoint.key]: {
                    stepIndex: latestCheckpoint.stepIndex,
                    createdAt: latestCheckpoint.createdAt,
                    status: "injected",
                    summary: summaryResult.summary.trim(),
                    model: summaryResult.model,
                    updatedAt: new Date().toISOString(),
                },
            },
        });

        await appendHookLog(stateDir, {
            event: "injected",
            conversationId: input.conversationId,
            checkpointStep: latestCheckpoint.stepIndex,
            checkpointKey: latestCheckpoint.key,
            lineageKind: lineage.kind,
            parentConversationId: parentFields.parentConversationId ?? null,
            model: summaryResult.model,
            thinkingLevel: summaryResult.thinkingLevel ?? null,
            durationMs: summaryResult.durationMs,
            summaryChars: summaryResult.summary.length,
            verbatimCount: verbatim.selectedCount,
            verbatimTokens: verbatim.estimatedTokens,
            omittedNativeCount: verbatim.omittedNativeCount,
            chunkCount: chunks.length,
        });

        return {
            injectSteps: chunks.map((chunk) => ({
                systemMessage: { systemMessage: chunk },
            })),
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const logPath = path.join(stateDir, "hook.log");
        await saveStateAtomically(stateDir, {
            version: 2,
            ...parentFields,
            checkpoints: {
                ...existingState.checkpoints,
                [latestCheckpoint.key]: {
                    stepIndex: latestCheckpoint.stepIndex,
                    createdAt: latestCheckpoint.createdAt,
                    status: "failed",
                    updatedAt: new Date().toISOString(),
                },
            },
        });
        await appendHookLog(stateDir, {
            event: "failed",
            conversationId: input.conversationId,
            checkpointStep: latestCheckpoint.stepIndex,
            checkpointKey: latestCheckpoint.key,
            lineageKind: lineage.kind,
            error: message,
        });
        return {
            injectSteps: [
                {
                    systemMessage: {
                        systemMessage: `${GROUNDED_COMPACTION_MARKER} error checkpoint=${latestCheckpoint.stepIndex}]\nGrounded compaction failed (${message}). Details logged to ${logPath}. Continue using Antigravity's native compaction checkpoint.`,
                    },
                },
            ],
        };
    }
}

function parseStdinHookInput(raw: string): PreInvocationHookInput | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (
        !isRecord(parsed)
        || typeof parsed.conversationId !== "string"
        || typeof parsed.transcriptPath !== "string"
        || typeof parsed.invocationNum !== "number"
    ) {
        return null;
    }
    return {
        conversationId: parsed.conversationId,
        transcriptPath: parsed.transcriptPath,
        invocationNum: parsed.invocationNum,
        ...(typeof parsed.lastUserInput === "string" ? { lastUserInput: parsed.lastUserInput } : {}),
    };
}

async function readStdinUtf8(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : (chunk as Buffer));
    }
    return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
    const raw = await readStdinUtf8();
    const input = parseStdinHookInput(raw);
    if (!input) {
        process.stdout.write("{}\n");
        return;
    }
    const output = await processPreInvocation(input);
    process.stdout.write(`${JSON.stringify(output)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`agy-grounded-compaction fatal: ${message}\n`);
        process.stdout.write("{}\n");
    });
}
