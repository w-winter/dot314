// readcache/read-file.ts - read_file wrapper with pi-readcache-like behavior

import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  DEFAULT_EXCLUDED_PATH_PATTERNS,
  MAX_DIFF_FILE_BYTES,
  MAX_DIFF_FILE_LINES,
  SCOPE_FULL,
  scopeRange,
} from "./constants.js";
import { computeUnifiedDiff, isDiffUseful } from "./diff.js";
import { buildRpReadcacheMetaV1 } from "./meta.js";
import { hashBytes, loadObject, persistObjectIfAbsent } from "./object-store.js";
import { buildKnowledgeForLeaf, isRangeScopeBlockedByInvalidation, overlaySet, type ReplayRuntimeState } from "./replay.js";
import { compareSlices, splitLines, truncateForReadcache } from "./text.js";
import type {
  ReadCacheDebugReason,
  ReadCacheDebugV1,
  RpReadcacheMetaV1,
  ScopeKey,
  ScopeTrust,
} from "./types.js";
import type { McpToolResult } from "../types.js";
import type { RpBinding } from "../types.js";
import { resolveReadFilePath } from "./resolve.js";

const UTF8_STRICT_DECODER = new TextDecoder("utf-8", { fatal: true });

export interface ReadFileArgs {
  path: string;
  start_line?: number;
  limit?: number;
  bypass_cache?: boolean;
}

interface CurrentTextState {
  bytes: Buffer;
  text: string;
  totalLines: number;
  currentHash: string;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("Operation aborted");
  }
}

function isExcludedPath(pathKey: string): boolean {
  const baseName = basename(pathKey).toLowerCase();
  return DEFAULT_EXCLUDED_PATH_PATTERNS.some((pattern) => {
    if (pattern === ".env*") {
      return baseName.startsWith(".env");
    }
    if (pattern.startsWith("*")) {
      return baseName.endsWith(pattern.slice(1));
    }
    return baseName === pattern;
  });
}

function normalizeStartEnd(
  startLine: number | undefined,
  limit: number | undefined,
  totalLines: number
): { start: number; end: number; totalLines: number } {
  if (!Number.isInteger(totalLines) || totalLines <= 0) {
    throw new Error(`Invalid totalLines: ${String(totalLines)}`);
  }

  if (startLine === undefined) {
    const end = limit !== undefined ? Math.min(totalLines, Math.max(1, limit)) : totalLines;
    return { start: 1, end, totalLines };
  }

  if (!Number.isInteger(startLine) || startLine === 0) {
    throw new Error(`Invalid start_line: ${String(startLine)}`);
  }

  if (startLine < 0) {
    const n = Math.abs(startLine);
    const start = Math.max(1, totalLines - n + 1);
    return { start, end: totalLines, totalLines };
  }

  const start = Math.min(startLine, totalLines);

  if (limit === undefined) {
    return { start, end: totalLines, totalLines };
  }

  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`Invalid limit: ${String(limit)}`);
  }

  const end = Math.min(totalLines, start + limit - 1);
  return { start, end, totalLines };
}

function scopeKeyForRange(start: number, end: number, totalLines: number): ScopeKey {
  if (start <= 1 && end >= totalLines) {
    return SCOPE_FULL;
  }
  return scopeRange(start, end);
}

function buildUnchangedMarker(
  scopeKey: ScopeKey,
  start: number,
  end: number,
  totalLines: number,
  outsideRangeChanged: boolean
): string {
  if (scopeKey === SCOPE_FULL) {
    return `[readcache: unchanged, ${totalLines} lines]`;
  }
  if (outsideRangeChanged) {
    return `[readcache: unchanged in lines ${start}-${end}; changes exist outside this range]`;
  }
  return `[readcache: unchanged in lines ${start}-${end} of ${totalLines}]`;
}

function buildDiffPayload(changedLines: number, totalLines: number, diffText: string): string {
  return `[readcache: ${changedLines} lines changed of ${totalLines}]\n${diffText}`;
}

function buildDebugInfo(
  scopeKey: ScopeKey,
  baseHash: string | undefined,
  reason: ReadCacheDebugReason,
  overrides: Partial<Omit<ReadCacheDebugV1, "reason" | "scope" | "baseHashFound" | "diffAttempted">> & {
    diffAttempted?: boolean;
  } = {}
): ReadCacheDebugV1 {
  return {
    reason,
    scope: scopeKey === SCOPE_FULL ? "full" : "range",
    baseHashFound: baseHash !== undefined,
    diffAttempted: overrides.diffAttempted ?? false,
    ...overrides,
  };
}

function selectBaseTrust(
  pathKnowledge: Map<ScopeKey, ScopeTrust> | undefined,
  scopeKey: ScopeKey,
  rangeScopeBlocked: boolean
): ScopeTrust | undefined {
  if (!pathKnowledge) {
    return undefined;
  }

  if (scopeKey === SCOPE_FULL) {
    return pathKnowledge.get(SCOPE_FULL);
  }

  if (rangeScopeBlocked) {
    return undefined;
  }

  const exactTrust = pathKnowledge.get(scopeKey);
  const fullTrust = pathKnowledge.get(SCOPE_FULL);

  if (!exactTrust) {
    return fullTrust;
  }
  if (!fullTrust) {
    return exactTrust;
  }

  return exactTrust.seq >= fullTrust.seq ? exactTrust : fullTrust;
}

async function readCurrentTextStrict(absolutePath: string): Promise<CurrentTextState | undefined> {
  let fileBytes: Buffer;
  try {
    fileBytes = await readFile(absolutePath);
  } catch {
    return undefined;
  }

  let text: string;
  try {
    text = UTF8_STRICT_DECODER.decode(fileBytes);
  } catch {
    return undefined;
  }

  const totalLines = splitLines(text).length;
  return {
    bytes: fileBytes,
    text,
    totalLines,
    currentHash: hashBytes(fileBytes),
  };
}

async function persistAndOverlay(
  runtimeState: ReplayRuntimeState,
  ctx: ExtensionContext,
  repoRoot: string,
  pathKey: string,
  scopeKey: ScopeKey,
  servedHash: string,
  text: string
): Promise<void> {
  try {
    await persistObjectIfAbsent(repoRoot, servedHash, text);
  } catch {
    // Fail-open
  }

  overlaySet(runtimeState, ctx.sessionManager, pathKey, scopeKey, servedHash);
}

function attachMetaToBaseline(baseline: McpToolResult, meta: RpReadcacheMetaV1): McpToolResult {
  return {
    ...baseline,
    // No structured details channel here; we attach rpReadcache meta in Pi tool result details
    // (handled by caller)
    content: baseline.content,
  };
}

export interface ReadFileWithCacheResult {
  toolResult: McpToolResult;
  meta: RpReadcacheMetaV1 | null;
  markerText: string | null;
}

export async function readFileWithCache(
  baselineResult: McpToolResult,
  args: ReadFileArgs,
  ctx: ExtensionContext,
  binding: RpBinding | null,
  runtimeState: ReplayRuntimeState,
  signal?: AbortSignal
): Promise<ReadFileWithCacheResult> {
  throwIfAborted(signal);

  const resolved = await resolveReadFilePath(args.path, ctx.cwd, binding);
  if (!resolved.absolutePath) {
    return { toolResult: baselineResult, meta: null, markerText: null };
  }

  if (isExcludedPath(resolved.absolutePath)) {
    return { toolResult: baselineResult, meta: null, markerText: null };
  }

  const current = await readCurrentTextStrict(resolved.absolutePath);
  if (!current) {
    return { toolResult: baselineResult, meta: null, markerText: null };
  }

  const repoRoot = resolved.repoRoot ?? ctx.cwd;

  let start: number;
  let end: number;
  let totalLines: number;

  try {
    const normalized = normalizeStartEnd(args.start_line, args.limit, current.totalLines);
    start = normalized.start;
    end = normalized.end;
    totalLines = normalized.totalLines;
  } catch {
    return { toolResult: baselineResult, meta: null, markerText: null };
  }

  const pathKey = resolved.absolutePath;
  const scopeKey = scopeKeyForRange(start, end, totalLines);

  if (args.bypass_cache === true) {
    const meta = buildRpReadcacheMetaV1({
      pathKey,
      scopeKey,
      servedHash: current.currentHash,
      mode: "full",
      totalLines,
      rangeStart: start,
      rangeEnd: end,
      bytes: current.bytes.byteLength,
      debug: buildDebugInfo(scopeKey, undefined, "bypass_cache"),
    });

    await persistAndOverlay(runtimeState, ctx, repoRoot, pathKey, scopeKey, current.currentHash, current.text);
    return { toolResult: attachMetaToBaseline(baselineResult, meta), meta, markerText: null };
  }

  const knowledge = buildKnowledgeForLeaf(ctx.sessionManager, runtimeState);
  const pathKnowledge = knowledge.get(pathKey);
  const rangeScopeBlocked = isRangeScopeBlockedByInvalidation(ctx.sessionManager, runtimeState, pathKey, scopeKey);
  const baseHash = selectBaseTrust(pathKnowledge, scopeKey, rangeScopeBlocked)?.hash;

  if (!baseHash) {
    const meta = buildRpReadcacheMetaV1({
      pathKey,
      scopeKey,
      servedHash: current.currentHash,
      mode: "full",
      totalLines,
      rangeStart: start,
      rangeEnd: end,
      bytes: current.bytes.byteLength,
      debug: buildDebugInfo(scopeKey, baseHash, "no_base_hash"),
    });

    await persistAndOverlay(runtimeState, ctx, repoRoot, pathKey, scopeKey, current.currentHash, current.text);
    return { toolResult: attachMetaToBaseline(baselineResult, meta), meta, markerText: null };
  }

  if (baseHash === current.currentHash) {
    const mode = scopeKey === SCOPE_FULL ? "unchanged" : "unchanged_range";
    const meta = buildRpReadcacheMetaV1({
      pathKey,
      scopeKey,
      servedHash: current.currentHash,
      baseHash,
      mode,
      totalLines,
      rangeStart: start,
      rangeEnd: end,
      bytes: current.bytes.byteLength,
      debug: buildDebugInfo(scopeKey, baseHash, "hash_match"),
    });

    const marker = buildUnchangedMarker(scopeKey, start, end, totalLines, false);
    await persistAndOverlay(runtimeState, ctx, repoRoot, pathKey, scopeKey, current.currentHash, current.text);

    return {
      toolResult: { content: [{ type: "text", text: marker }], isError: false },
      meta,
      markerText: marker,
    };
  }

  const baseText = await loadObject(repoRoot, baseHash);

  const fallbackResult = async (
    reason: ReadCacheDebugReason,
    overrides: Partial<Omit<ReadCacheDebugV1, "reason" | "scope" | "baseHashFound" | "diffAttempted">> & {
      diffAttempted?: boolean;
    } = {}
  ): Promise<ReadFileWithCacheResult> => {
    const meta = buildRpReadcacheMetaV1({
      pathKey,
      scopeKey,
      servedHash: current.currentHash,
      baseHash,
      mode: "baseline_fallback",
      totalLines,
      rangeStart: start,
      rangeEnd: end,
      bytes: current.bytes.byteLength,
      debug: buildDebugInfo(scopeKey, baseHash, reason, overrides),
    });

    await persistAndOverlay(runtimeState, ctx, repoRoot, pathKey, scopeKey, current.currentHash, current.text);
    return { toolResult: attachMetaToBaseline(baselineResult, meta), meta, markerText: null };
  };

  if (!baseText) {
    return fallbackResult("base_object_missing", { baseObjectFound: false });
  }

  if (scopeKey !== SCOPE_FULL) {
    if (compareSlices(baseText, current.text, start, end)) {
      const meta = buildRpReadcacheMetaV1({
        pathKey,
        scopeKey,
        servedHash: current.currentHash,
        baseHash,
        mode: "unchanged_range",
        totalLines,
        rangeStart: start,
        rangeEnd: end,
        bytes: current.bytes.byteLength,
        debug: buildDebugInfo(scopeKey, baseHash, "range_slice_unchanged", { outsideRangeChanged: true }),
      });

      const marker = buildUnchangedMarker(scopeKey, start, end, totalLines, true);
      await persistAndOverlay(runtimeState, ctx, repoRoot, pathKey, scopeKey, current.currentHash, current.text);
      return {
        toolResult: { content: [{ type: "text", text: marker }], isError: false },
        meta,
        markerText: marker,
      };
    }

    return fallbackResult("range_slice_changed", { outsideRangeChanged: true });
  }

  const baseBytes = Buffer.byteLength(baseText, "utf-8");
  const largestBytes = Math.max(baseBytes, current.bytes.byteLength);
  if (largestBytes > MAX_DIFF_FILE_BYTES) {
    return fallbackResult("diff_file_too_large_bytes", { diffAttempted: true, largestBytes });
  }

  const maxLines = Math.max(splitLines(baseText).length, totalLines);
  if (maxLines > MAX_DIFF_FILE_LINES) {
    return fallbackResult("diff_file_too_large_lines", { diffAttempted: true, maxLines });
  }

  const diff = computeUnifiedDiff(baseText, current.text, args.path);
  if (!diff) {
    return fallbackResult("diff_unavailable_or_empty", { diffAttempted: true });
  }

  if (!isDiffUseful(diff.diffText, baseText, current.text)) {
    return fallbackResult("diff_not_useful", { diffAttempted: true, diffBytes: diff.diffBytes });
  }

  const diffPayload = buildDiffPayload(diff.changedLines, totalLines, diff.diffText);
  const truncation = truncateForReadcache(diffPayload);
  if (truncation.truncated) {
    return fallbackResult("diff_payload_truncated", {
      diffAttempted: true,
      diffBytes: diff.diffBytes,
      diffChangedLines: diff.changedLines,
    });
  }

  const meta = buildRpReadcacheMetaV1({
    pathKey,
    scopeKey,
    servedHash: current.currentHash,
    baseHash,
    mode: "diff",
    totalLines,
    rangeStart: start,
    rangeEnd: end,
    bytes: current.bytes.byteLength,
    debug: buildDebugInfo(scopeKey, baseHash, "diff_emitted", {
      diffAttempted: true,
      diffBytes: diff.diffBytes,
      diffChangedLines: diff.changedLines,
    }),
  });

  await persistAndOverlay(runtimeState, ctx, repoRoot, pathKey, scopeKey, current.currentHash, current.text);

  return {
    toolResult: { content: [{ type: "text", text: truncation.content }], isError: false },
    meta,
    markerText: truncation.content,
  };
}
