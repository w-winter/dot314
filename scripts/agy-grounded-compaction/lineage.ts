import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
    extractPreForkNativeRequests,
    extractUserRequestText,
    makeCheckpointKey,
    nativeRequestMatchesUserText,
    parseTranscriptRecords,
    type NativeUserRequest,
    type TranscriptRecord,
} from "./transcript.ts";

export interface PersistedCheckpointRecord {
    readonly stepIndex: number;
    readonly createdAt: string;
    readonly status: "injected" | "skipped-empty" | "failed";
    readonly summary?: string;
    readonly model?: string;
    readonly updatedAt: string;
}

export interface PersistedHookState {
    readonly version: 2;
    readonly parentConversationId?: string;
    readonly forkStepIndex?: number;
    readonly checkpoints: Readonly<Record<string, PersistedCheckpointRecord>>;
}

export interface LineageSegment {
    readonly conversationId: string;
    readonly transcriptPath: string;
    readonly startStepInclusive: number;
    readonly endStepExclusive: number | null;
}

export interface PriorInjectedCheckpoint {
    readonly stepIndex: number;
    readonly summary: string;
}

export type ResolvedLineage =
    | Readonly<{
        kind: "complete";
        records: readonly TranscriptRecord[];
        segments: readonly LineageSegment[];
        parentConversationId?: string;
        forkStepIndex?: number;
        priorInjectedCheckpoint: PriorInjectedCheckpoint | null;
    }>
    | Readonly<{
        kind: "forked-unresolved";
        records: readonly TranscriptRecord[];
        firstStepIndex: number;
        priorInjectedCheckpoint: PriorInjectedCheckpoint | null;
    }>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getStateDir(transcriptPath: string): string {
    // transcriptPath is <appDataDir>/brain/<conversationId>/.system_generated/logs/transcript_full.jsonl
    return path.resolve(path.dirname(transcriptPath), "..", "grounded-compaction");
}

function getBrainRoot(transcriptPath: string): string {
    return path.resolve(path.dirname(transcriptPath), "..", "..", "..");
}

function conversationTranscriptPath(brainRoot: string, conversationId: string): string {
    return path.join(brainRoot, conversationId, ".system_generated", "logs", "transcript_full.jsonl");
}

function conversationCompactTranscriptPath(brainRoot: string, conversationId: string): string {
    return path.join(brainRoot, conversationId, ".system_generated", "logs", "transcript.jsonl");
}

function parseCheckpointRecord(value: unknown): PersistedCheckpointRecord | null {
    if (
        !isRecord(value)
        || typeof value.stepIndex !== "number"
        || !Number.isInteger(value.stepIndex)
        || typeof value.createdAt !== "string"
        || (value.status !== "injected" && value.status !== "skipped-empty" && value.status !== "failed")
        || typeof value.updatedAt !== "string"
    ) {
        return null;
    }
    return {
        stepIndex: value.stepIndex,
        createdAt: value.createdAt,
        status: value.status,
        ...(typeof value.summary === "string" ? { summary: value.summary } : {}),
        ...(typeof value.model === "string" ? { model: value.model } : {}),
        updatedAt: value.updatedAt,
    };
}

export async function loadState(stateFile: string): Promise<PersistedHookState> {
    try {
        const raw: unknown = JSON.parse(await readFile(stateFile, "utf8"));
        if (!isRecord(raw) || raw.version !== 2 || !isRecord(raw.checkpoints)) {
            return { version: 2, checkpoints: {} };
        }
        const checkpoints: Record<string, PersistedCheckpointRecord> = {};
        for (const [key, entry] of Object.entries(raw.checkpoints)) {
            const parsed = parseCheckpointRecord(entry);
            if (parsed) {
                checkpoints[key] = parsed;
            }
        }
        const parentConversationId =
            typeof raw.parentConversationId === "string" && raw.parentConversationId.trim()
                ? raw.parentConversationId.trim()
                : undefined;
        const forkStepIndex =
            typeof raw.forkStepIndex === "number" && Number.isInteger(raw.forkStepIndex) && raw.forkStepIndex > 0
                ? raw.forkStepIndex
                : undefined;
        return {
            version: 2,
            ...(parentConversationId ? { parentConversationId } : {}),
            ...(forkStepIndex !== undefined ? { forkStepIndex } : {}),
            checkpoints,
        };
    } catch {
        return { version: 2, checkpoints: {} };
    }
}

export async function saveStateAtomically(stateDir: string, state: PersistedHookState): Promise<void> {
    await mkdir(stateDir, { recursive: true });
    const target = path.join(stateDir, "state.json");
    const tmp = path.join(stateDir, `state.${process.pid}.${Date.now()}.tmp`);
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(tmp, target);
}

interface LoadedAncestorChain {
    readonly records: readonly TranscriptRecord[];
    readonly segments: readonly LineageSegment[];
    readonly stateByConversation: ReadonlyMap<string, PersistedHookState>;
    readonly reachesRoot: boolean;
}

async function loadSavedAncestorChain(params: {
    brainRoot: string;
    conversationId: string;
    endStepExclusive: number;
    visited: Set<string>;
}): Promise<LoadedAncestorChain | null> {
    if (params.visited.has(params.conversationId)) {
        return null;
    }
    params.visited.add(params.conversationId);

    const tPath = conversationTranscriptPath(params.brainRoot, params.conversationId);
    let raw: string;
    try {
        raw = await readFile(tPath, "utf8");
    } catch {
        return null;
    }

    const allRecords = parseTranscriptRecords(raw);
    const localSlice = allRecords.filter((r) => r.stepIndex < params.endStepExclusive);
    const state = await loadState(path.join(getStateDir(tPath), "state.json"));
    const stateByConversation = new Map<string, PersistedHookState>([[params.conversationId, state]]);

    const firstLocalStep = localSlice[0]?.stepIndex ?? params.endStepExclusive;
    if (firstLocalStep === 0) {
        return {
            records: localSlice,
            segments: [
                {
                    conversationId: params.conversationId,
                    transcriptPath: tPath,
                    startStepInclusive: 0,
                    endStepExclusive: params.endStepExclusive,
                },
            ],
            stateByConversation,
            reachesRoot: true,
        };
    }

    if (state.parentConversationId) {
        const parentCutoff = state.forkStepIndex !== undefined
            ? Math.min(state.forkStepIndex, firstLocalStep)
            : firstLocalStep;
        const parentChain = await loadSavedAncestorChain({
            brainRoot: params.brainRoot,
            conversationId: state.parentConversationId,
            endStepExclusive: parentCutoff,
            visited: new Set(params.visited),
        });
        if (parentChain) {
            for (const [id, st] of parentChain.stateByConversation) {
                stateByConversation.set(id, st);
            }
            const segments: LineageSegment[] = [...parentChain.segments];
            if (localSlice.length > 0) {
                segments.push({
                    conversationId: params.conversationId,
                    transcriptPath: tPath,
                    startStepInclusive: localSlice[0].stepIndex,
                    endStepExclusive: params.endStepExclusive,
                });
            }
            return {
                records: [...parentChain.records, ...localSlice].sort((a, b) => a.stepIndex - b.stepIndex),
                segments,
                stateByConversation,
                reachesRoot: parentChain.reachesRoot,
            };
        }
    }

    if (localSlice.length === 0) {
        return null;
    }

    return {
        records: localSlice,
        segments: [
            {
                conversationId: params.conversationId,
                transcriptPath: tPath,
                startStepInclusive: localSlice[0].stepIndex,
                endStepExclusive: params.endStepExclusive,
            },
        ],
        stateByConversation,
        reachesRoot: false,
    };
}

function matchesTrailingPreForkRequests(
    records: readonly TranscriptRecord[],
    preForkRequests: readonly NativeUserRequest[],
): boolean {
    const users: string[] = [];
    for (const record of records) {
        if (record.kind !== "USER_INPUT") {
            continue;
        }
        const text = extractUserRequestText(record.content);
        if (text) {
            users.push(text);
        }
    }
    if (users.length < preForkRequests.length) {
        return false;
    }
    const tail = users.slice(users.length - preForkRequests.length);
    for (let i = 0; i < preForkRequests.length; i += 1) {
        if (!nativeRequestMatchesUserText(preForkRequests[i], tail[i])) {
            return false;
        }
    }
    return true;
}

async function siblingMightMatchLastRequest(params: {
    brainRoot: string;
    siblingId: string;
    forkStepIndex: number;
    lastPreForkRequest: NativeUserRequest;
}): Promise<boolean> {
    const stateFile = path.join(
        getStateDir(conversationTranscriptPath(params.brainRoot, params.siblingId)),
        "state.json",
    );
    const state = await loadState(stateFile);
    if (state.parentConversationId) {
        return true;
    }

    const compactPath = conversationCompactTranscriptPath(params.brainRoot, params.siblingId);
    let compactRaw: string;
    try {
        compactRaw = await readFile(compactPath, "utf8");
    } catch {
        return true;
    }

    const compactRecords = parseTranscriptRecords(compactRaw);
    if (compactRecords.length === 0 || compactRecords[0].stepIndex >= params.forkStepIndex) {
        return false;
    }

    let lastUserText: string | null = null;
    for (let i = compactRecords.length - 1; i >= 0; i -= 1) {
        const rec = compactRecords[i];
        if (rec.stepIndex >= params.forkStepIndex || rec.kind !== "USER_INPUT") {
            continue;
        }
        const text = extractUserRequestText(rec.content);
        if (text) {
            lastUserText = text;
            break;
        }
    }
    if (!lastUserText) {
        return false;
    }

    const headProbe = params.lastPreForkRequest.text.slice(0, 60);
    return lastUserText.startsWith(headProbe);
}

async function discoverUniqueParent(params: {
    brainRoot: string;
    childConversationId: string;
    forkStepIndex: number;
    preForkRequests: readonly NativeUserRequest[];
}): Promise<{ parentId: string; chain: LoadedAncestorChain } | null> {
    let entries;
    try {
        entries = await readdir(params.brainRoot, { withFileTypes: true });
    } catch {
        return null;
    }

    const lastPreForkRequest = params.preForkRequests[params.preForkRequests.length - 1];
    const matches: Array<{ parentId: string; chain: LoadedAncestorChain }> = [];

    for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === params.childConversationId) {
            continue;
        }
        const maybe = await siblingMightMatchLastRequest({
            brainRoot: params.brainRoot,
            siblingId: entry.name,
            forkStepIndex: params.forkStepIndex,
            lastPreForkRequest,
        });
        if (!maybe) {
            continue;
        }

        const chain = await loadSavedAncestorChain({
            brainRoot: params.brainRoot,
            conversationId: entry.name,
            endStepExclusive: params.forkStepIndex,
            visited: new Set([params.childConversationId]),
        });
        if (!chain || !chain.reachesRoot || chain.records.length === 0) {
            continue;
        }
        if (matchesTrailingPreForkRequests(chain.records, params.preForkRequests)) {
            matches.push({ parentId: entry.name, chain });
            if (matches.length > 1) {
                return null;
            }
        }
    }

    return matches.length === 1 ? matches[0] : null;
}

function findPriorInjectedInSegments(params: {
    records: readonly TranscriptRecord[];
    segments: readonly LineageSegment[];
    stateByConversation: ReadonlyMap<string, PersistedHookState>;
    currentCheckpointStep: number;
}): PriorInjectedCheckpoint | null {
    for (let i = params.records.length - 1; i >= 0; i -= 1) {
        const record = params.records[i];
        if (record.kind !== "CHECKPOINT" || record.stepIndex >= params.currentCheckpointStep) {
            continue;
        }
        const ownerSegment = params.segments.find(
            (seg) =>
                record.stepIndex >= seg.startStepInclusive
                && (seg.endStepExclusive === null || record.stepIndex < seg.endStepExclusive),
        );
        if (!ownerSegment) {
            continue;
        }
        const ownerState = params.stateByConversation.get(ownerSegment.conversationId);
        if (!ownerState) {
            continue;
        }
        const key = makeCheckpointKey(record.stepIndex, record.createdAt);
        const saved = Object.hasOwn(ownerState.checkpoints, key) ? ownerState.checkpoints[key] : undefined;
        if (saved?.status === "injected" && saved.summary) {
            return { stepIndex: record.stepIndex, summary: saved.summary };
        }
    }
    return null;
}

/**
 * Resolves full session lineage for `conversationId`.
 * Non-forked sessions (`firstStepIndex === 0`) return immediately with zero directory scanning.
 * Forked sessions reuse saved `parentConversationId` or perform a fail-closed unique match
 * against sibling transcripts using Antigravity's native `# User Requests`.
 */
export async function resolveConversationLineage(params: {
    conversationId: string;
    transcriptPath: string;
    childRecords: readonly TranscriptRecord[];
    childState: PersistedHookState;
    checkpointStep: number;
    nativeUserRequests: readonly NativeUserRequest[];
}): Promise<ResolvedLineage> {
    const childSegment: LineageSegment = {
        conversationId: params.conversationId,
        transcriptPath: params.transcriptPath,
        startStepInclusive: params.childRecords[0]?.stepIndex ?? 0,
        endStepExclusive: null,
    };
    const childStateMap = new Map<string, PersistedHookState>([[params.conversationId, params.childState]]);

    if (params.childRecords.length === 0 || params.childRecords[0].stepIndex === 0) {
        return {
            kind: "complete",
            records: params.childRecords,
            segments: [childSegment],
            priorInjectedCheckpoint: findPriorInjectedInSegments({
                records: params.childRecords,
                segments: [childSegment],
                stateByConversation: childStateMap,
                currentCheckpointStep: params.checkpointStep,
            }),
        };
    }

    const firstStepIndex = params.childRecords[0].stepIndex;
    const brainRoot = getBrainRoot(params.transcriptPath);

    let resolvedParentId = params.childState.parentConversationId;
    let ancestorChain: LoadedAncestorChain | null = null;

    if (resolvedParentId) {
        const cutoff = params.childState.forkStepIndex !== undefined
            ? Math.min(params.childState.forkStepIndex, firstStepIndex)
            : firstStepIndex;
        const loaded = await loadSavedAncestorChain({
            brainRoot,
            conversationId: resolvedParentId,
            endStepExclusive: cutoff,
            visited: new Set([params.conversationId]),
        });
        if (loaded?.reachesRoot) {
            ancestorChain = loaded;
        } else {
            resolvedParentId = undefined;
        }
    }

    if (!ancestorChain) {
        const preForkRequests = extractPreForkNativeRequests(
            params.nativeUserRequests,
            params.childRecords,
            params.checkpointStep,
        );
        if (preForkRequests && preForkRequests.length > 0) {
            const discovered = await discoverUniqueParent({
                brainRoot,
                childConversationId: params.conversationId,
                forkStepIndex: firstStepIndex,
                preForkRequests,
            });
            if (discovered) {
                resolvedParentId = discovered.parentId;
                ancestorChain = discovered.chain;
            }
        }
    }

    if (!ancestorChain || !resolvedParentId) {
        return {
            kind: "forked-unresolved",
            records: params.childRecords,
            firstStepIndex,
            priorInjectedCheckpoint: findPriorInjectedInSegments({
                records: params.childRecords,
                segments: [childSegment],
                stateByConversation: childStateMap,
                currentCheckpointStep: params.checkpointStep,
            }),
        };
    }

    const combinedRecords = [...ancestorChain.records, ...params.childRecords].sort(
        (a, b) => a.stepIndex - b.stepIndex,
    );
    const combinedSegments: LineageSegment[] = [...ancestorChain.segments, childSegment];
    const combinedStateMap = new Map<string, PersistedHookState>(ancestorChain.stateByConversation);
    combinedStateMap.set(params.conversationId, params.childState);

    return {
        kind: "complete",
        records: combinedRecords,
        segments: combinedSegments,
        parentConversationId: resolvedParentId,
        forkStepIndex: firstStepIndex,
        priorInjectedCheckpoint: findPriorInjectedInSegments({
            records: combinedRecords,
            segments: combinedSegments,
            stateByConversation: combinedStateMap,
            currentCheckpointStep: params.checkpointStep,
        }),
    };
}
