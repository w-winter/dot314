// readcache/replay.ts - replay-aware trust reconstruction for rp_exec(read_file)

import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

import { SCOPE_FULL } from "./constants.js";
import { extractInvalidationFromSessionEntry, extractReadMetaFromSessionEntry } from "./meta.js";
import type {
    KnowledgeMap,
    RpReadcacheInvalidationV1,
    RpReadcacheMetaV1,
    ScopeKey,
    ScopeRangeKey,
    ScopeTrust,
} from "./types.js";

type SessionManagerView = ExtensionContext["sessionManager"];

type RangeBlockersByPath = Map<string, Set<ScopeRangeKey>>;

const OVERLAY_SEQ_START = 1_000_000_000;

interface ReplayMemoEntry {
    knowledge: KnowledgeMap;
    blockedRangesByPath: RangeBlockersByPath;
}

interface OverlayState {
    leafId: string | null;
    knowledge: KnowledgeMap;
}

export interface ReplayRuntimeState {
    memoByLeaf: Map<string, ReplayMemoEntry>;
    overlayBySession: Map<string, OverlayState>;
    nextOverlaySeq: number;
}

export interface ReplayBoundary {
    startIndex: number;
    boundaryKey: string;
}

function cloneKnowledgeMap(source: KnowledgeMap): KnowledgeMap {
    const cloned: KnowledgeMap = new Map();
    for (const [pathKey, scopes] of source.entries()) {
        const clonedScopes = new Map<ScopeKey, ScopeTrust>();
        for (const [scopeKey, trust] of scopes.entries()) {
            clonedScopes.set(scopeKey, { ...trust });
        }
        cloned.set(pathKey, clonedScopes);
    }
    return cloned;
}

function cloneRangeBlockersByPath(source: RangeBlockersByPath): RangeBlockersByPath {
    const cloned: RangeBlockersByPath = new Map();
    for (const [pathKey, scopes] of source.entries()) {
        cloned.set(pathKey, new Set(scopes));
    }
    return cloned;
}

function cloneReplayMemoEntry(source: ReplayMemoEntry): ReplayMemoEntry {
    return {
        knowledge: cloneKnowledgeMap(source.knowledge),
        blockedRangesByPath: cloneRangeBlockersByPath(source.blockedRangesByPath),
    };
}

function getMemoKey(sessionId: string, leafId: string | null, boundaryKey: string): string {
    return `${sessionId}:${leafId ?? "null"}:${boundaryKey}`;
}

function ensureScopeMap(knowledge: KnowledgeMap, pathKey: string): Map<ScopeKey, ScopeTrust> {
    const existing = knowledge.get(pathKey);
    if (existing) {
        return existing;
    }
    const created = new Map<ScopeKey, ScopeTrust>();
    knowledge.set(pathKey, created);
    return created;
}

function isRangeScope(scopeKey: ScopeKey): scopeKey is ScopeRangeKey {
    return scopeKey !== SCOPE_FULL;
}

function ensureRangeBlockerSet(blockedRangesByPath: RangeBlockersByPath, pathKey: string): Set<ScopeRangeKey> {
    const existing = blockedRangesByPath.get(pathKey);
    if (existing) {
        return existing;
    }
    const created = new Set<ScopeRangeKey>();
    blockedRangesByPath.set(pathKey, created);
    return created;
}

function setRangeBlocker(blockedRangesByPath: RangeBlockersByPath, pathKey: string, scopeKey: ScopeRangeKey): void {
    const scopes = ensureRangeBlockerSet(blockedRangesByPath, pathKey);
    scopes.add(scopeKey);
}

function clearRangeBlocker(blockedRangesByPath: RangeBlockersByPath, pathKey: string, scopeKey: ScopeRangeKey): void {
    const scopes = blockedRangesByPath.get(pathKey);
    if (!scopes) {
        return;
    }
    scopes.delete(scopeKey);
    if (scopes.size === 0) {
        blockedRangesByPath.delete(pathKey);
    }
}

export function getTrust(knowledge: KnowledgeMap, pathKey: string, scopeKey: ScopeKey): ScopeTrust | undefined {
    return knowledge.get(pathKey)?.get(scopeKey);
}

export function setTrust(knowledge: KnowledgeMap, pathKey: string, scopeKey: ScopeKey, hash: string, seq: number): void {
    const scopes = ensureScopeMap(knowledge, pathKey);
    scopes.set(scopeKey, { hash, seq });
}

function mergeKnowledge(base: KnowledgeMap, overlay: KnowledgeMap): KnowledgeMap {
    const merged = cloneKnowledgeMap(base);
    for (const [pathKey, overlayScopes] of overlay.entries()) {
        const targetScopes = ensureScopeMap(merged, pathKey);
        for (const [scopeKey, trust] of overlayScopes.entries()) {
            targetScopes.set(scopeKey, { ...trust });
        }
    }
    return merged;
}

function ensureOverlayForLeaf(runtimeState: ReplayRuntimeState, sessionId: string, leafId: string | null): OverlayState {
    const existing = runtimeState.overlayBySession.get(sessionId);
    if (!existing || existing.leafId !== leafId) {
        const fresh: OverlayState = {
            leafId,
            knowledge: new Map(),
        };
        runtimeState.overlayBySession.set(sessionId, fresh);
        return fresh;
    }
    return existing;
}

function leafHasChildren(sessionManager: SessionManagerView, leafId: string | null): boolean {
    if (!leafId) {
        return false;
    }
    return sessionManager.getEntries().some((entry) => entry.parentId === leafId);
}

function replaySnapshotFromBranch(branchEntries: SessionEntry[], startIndex: number): ReplayMemoEntry {
    const knowledge: KnowledgeMap = new Map();
    const blockedRangesByPath: RangeBlockersByPath = new Map();
    const normalizedStart = Math.max(0, Math.min(startIndex, branchEntries.length));
    let seq = 0;

    for (let index = normalizedStart; index < branchEntries.length; index += 1) {
        const entry = branchEntries[index];
        if (!entry) {
            continue;
        }

        const meta = extractReadMetaFromSessionEntry(entry);
        if (meta) {
            seq += 1;
            applyReadMetaTransition(knowledge, meta, seq, blockedRangesByPath);
            continue;
        }

        const invalidation = extractInvalidationFromSessionEntry(entry);
        if (invalidation) {
            applyInvalidation(knowledge, invalidation, blockedRangesByPath);
        }
    }

    return {
        knowledge,
        blockedRangesByPath,
    };
}

function getReplayMemoEntryForLeaf(
    sessionManager: SessionManagerView,
    runtimeState: ReplayRuntimeState,
): { memoEntry: ReplayMemoEntry; sessionId: string; leafId: string | null } {
    const sessionId = sessionManager.getSessionId();
    const leafId = sessionManager.getLeafId();
    const branchEntries = sessionManager.getBranch();
    const boundary = findReplayStartIndex(branchEntries);
    const memoKey = getMemoKey(sessionId, leafId, boundary.boundaryKey);

    let memoEntry = runtimeState.memoByLeaf.get(memoKey);
    if (!memoEntry) {
        const replayMemo = replaySnapshotFromBranch(branchEntries, boundary.startIndex);
        memoEntry = cloneReplayMemoEntry(replayMemo);
        runtimeState.memoByLeaf.set(memoKey, memoEntry);
    }

    return {
        memoEntry,
        sessionId,
        leafId,
    };
}

export function createReplayRuntimeState(): ReplayRuntimeState {
    return {
        memoByLeaf: new Map(),
        overlayBySession: new Map(),
        nextOverlaySeq: OVERLAY_SEQ_START,
    };
}

export function clearReplayRuntimeState(runtimeState: ReplayRuntimeState): void {
    runtimeState.memoByLeaf.clear();
    runtimeState.overlayBySession.clear();
    runtimeState.nextOverlaySeq = OVERLAY_SEQ_START;
}

export function findReplayStartIndex(branchEntries: SessionEntry[]): ReplayBoundary {
    for (let index = branchEntries.length - 1; index >= 0; index -= 1) {
        const entry = branchEntries[index];
        if (!entry || entry.type !== "compaction") {
            continue;
        }

        return {
            startIndex: Math.min(index + 1, branchEntries.length),
            boundaryKey: `compaction:${entry.id}`,
        };
    }

    return {
        startIndex: 0,
        boundaryKey: "root",
    };
}

export function applyReadMetaTransition(
    knowledge: KnowledgeMap,
    meta: RpReadcacheMetaV1,
    seq: number,
    blockedRangesByPath?: RangeBlockersByPath,
): void {
    const { pathKey, scopeKey, servedHash, baseHash, mode } = meta;
    const fullTrust = getTrust(knowledge, pathKey, SCOPE_FULL);
    const rangeTrust = scopeKey === SCOPE_FULL ? undefined : getTrust(knowledge, pathKey, scopeKey);

    if (mode === "full" || mode === "baseline_fallback") {
        setTrust(knowledge, pathKey, scopeKey, servedHash, seq);
        if (blockedRangesByPath && isRangeScope(scopeKey)) {
            clearRangeBlocker(blockedRangesByPath, pathKey, scopeKey);
        }
        return;
    }

    if (mode === "unchanged" && scopeKey === SCOPE_FULL) {
        if (!baseHash) {
            return;
        }
        if (!fullTrust || fullTrust.hash !== baseHash) {
            return;
        }
        if (servedHash !== baseHash) {
            return;
        }
        setTrust(knowledge, pathKey, SCOPE_FULL, servedHash, seq);
        return;
    }

    if (mode === "diff" && scopeKey === SCOPE_FULL) {
        if (!baseHash) {
            return;
        }
        if (!fullTrust || fullTrust.hash !== baseHash) {
            return;
        }
        setTrust(knowledge, pathKey, SCOPE_FULL, servedHash, seq);
        return;
    }

    if (mode === "unchanged_range" && scopeKey !== SCOPE_FULL) {
        if (!baseHash) {
            return;
        }
        if (rangeTrust?.hash !== baseHash && fullTrust?.hash !== baseHash) {
            return;
        }
        setTrust(knowledge, pathKey, scopeKey, servedHash, seq);
    }
}

export function applyInvalidation(
    knowledge: KnowledgeMap,
    invalidation: RpReadcacheInvalidationV1,
    blockedRangesByPath?: RangeBlockersByPath,
): void {
    const scopes = knowledge.get(invalidation.pathKey);

    if (invalidation.scopeKey === SCOPE_FULL) {
        knowledge.delete(invalidation.pathKey);
        blockedRangesByPath?.delete(invalidation.pathKey);
        return;
    }

    if (blockedRangesByPath && isRangeScope(invalidation.scopeKey)) {
        setRangeBlocker(blockedRangesByPath, invalidation.pathKey, invalidation.scopeKey);
    }

    if (!scopes) {
        return;
    }

    scopes.delete(invalidation.scopeKey);
    if (scopes.size === 0) {
        knowledge.delete(invalidation.pathKey);
    }
}

export function buildKnowledgeForLeaf(sessionManager: SessionManagerView, runtimeState: ReplayRuntimeState): KnowledgeMap {
    const { memoEntry, sessionId, leafId } = getReplayMemoEntryForLeaf(sessionManager, runtimeState);
    const overlayState = ensureOverlayForLeaf(runtimeState, sessionId, leafId);
    if (leafHasChildren(sessionManager, leafId)) {
        overlayState.knowledge.clear();
    }
    return mergeKnowledge(memoEntry.knowledge, overlayState.knowledge);
}

export function isRangeScopeBlockedByInvalidation(
    sessionManager: SessionManagerView,
    runtimeState: ReplayRuntimeState,
    pathKey: string,
    scopeKey: ScopeKey,
): boolean {
    if (!isRangeScope(scopeKey)) {
        return false;
    }

    const { memoEntry, sessionId, leafId } = getReplayMemoEntryForLeaf(sessionManager, runtimeState);
    const blockedScopes = memoEntry.blockedRangesByPath.get(pathKey);
    if (!blockedScopes?.has(scopeKey)) {
        return false;
    }

    const overlayState = ensureOverlayForLeaf(runtimeState, sessionId, leafId);
    const overlayScopeTrust = overlayState.knowledge.get(pathKey)?.get(scopeKey);
    return overlayScopeTrust === undefined;
}

export function overlaySet(
    runtimeState: ReplayRuntimeState,
    sessionManager: SessionManagerView,
    pathKey: string,
    scopeKey: ScopeKey,
    servedHash: string,
): void {
    const sessionId = sessionManager.getSessionId();
    const leafId = sessionManager.getLeafId();
    const overlayState = ensureOverlayForLeaf(runtimeState, sessionId, leafId);
    const seq = runtimeState.nextOverlaySeq;
    runtimeState.nextOverlaySeq += 1;
    setTrust(overlayState.knowledge, pathKey, scopeKey, servedHash, seq);
}
