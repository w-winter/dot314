// index.ts - RepoPrompt MCP Extension for Pi
//
// First-class RepoPrompt integration with:
// - Auto-detection of matching windows based on cwd
// - Syntax highlighting for code blocks
// - Delta-powered diff highlighting (with graceful fallback)
// - Safety guards for destructive operations
// - Persistent window binding across sessions

import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolRenderResultOptions,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Text, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import type {
  RpToolParams,
  RpConfig,
  RpBinding,
  RpWindow,
  RpTab,
  RpToolMeta,
  McpContent,
  McpToolResult,
  AutoSelectionEntryData,
  AutoSelectionEntrySliceData,
  AutoSelectionEntryRangeData,
  ActiveAppEntryData,
  RpAppId,
} from "./types.js";
import { ACTIVE_APP_ENTRY_TYPE, AUTO_SELECTION_ENTRY_TYPE, BINDING_ENTRY_TYPE, RP_APP_IDS } from "./types.js";
import { getAppCliCommand, getAppLabel, getAppTargetConfig, getServerCommand, inferAppPath, loadConfig } from "./config.js";
import { getRpClient, resetRpClient } from "./client.js";
import {
  getBinding,
  clearBinding,
  restoreBinding,
  autoDetectAndBind,
  bindToWindow,
  bindToTab,
  createAndBindTab,
  ensureBindingHasTab,
  fetchWindowTabs,
  fetchWindows,
  findRecoveryWindowBySelectionPaths,
  getBindingArgs,
} from "./binding.js";
import {
  createAdaptiveDiffAwareOutputComponent,
  containsFencedDiffBlock,
  renderRpOutput,
  prepareCollapsedView,
} from "./render.js";
import { checkGuards, normalizeToolName, isNoopEdit, isEditOperation } from "./guards.js";
import { normalizeToolResultText } from "./result-normalization.js";
import { buildForwardedUserArgs } from "./tool-forwarding-policy.js";
import { normalizeFileActionResult } from "./file-action-normalization.js";
import { summarizeRpCall, summarizeRpResult } from "./presentation-summary.js";
import { extractJsonContent, extractTextContent } from "./mcp-json.js";
import { resolveToolName } from "./tool-names.js";

import { readFileWithCache } from "./readcache/read-file.js";
import { RP_READCACHE_CUSTOM_TYPE, SCOPE_FULL, scopeRange } from "./readcache/constants.js";
import { buildInvalidationV1 } from "./readcache/meta.js";
import { clearReplayRuntimeState, createReplayRuntimeState } from "./readcache/replay.js";
import type { RpReadcacheMetaV1, ScopeKey } from "./readcache/types.js";
import { getStoreStats, pruneObjectsOlderThan } from "./readcache/object-store.js";
import { clearRootsCache, resolveReadFilePath } from "./readcache/resolve.js";

import {
  applyFullReadToSelectionState,
  applySliceReadToSelectionState,
  computeSliceRangeFromReadArgs,
  countFileLines,
  inferSelectionStatus,
  inferSelectionSliceRanges,
  isWholeFileReadFromArgs,
  toPosixPath,
} from "./auto-select.js";
import {
  clearPendingTransitionSelectionState,
  getPendingTransitionState,
  setPendingTransitionSelectionState,
  setPendingTransitionTargetState,
} from "./transition-state.js";
import type { PendingTransitionRetryMode, PendingTransitionTargetIdentity } from "./transition-state.js";

function parseSummaryCount(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().replaceAll(",", "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseSelectionSummaryNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    return parseSummaryCount(value);
  }

  return undefined;
}

export function parseWorkspaceContextSelectionSummaryFromText(
  text: string
): { fileCount?: number; tokens?: number } | null {
  const selectedFilesMatch = text.match(/\bSelected files:\s*([\d,]+)\s+total\b/i);
  const selectionTokensMatch = text.match(/\bSelection:\s*([\d,]+)/i);
  const selectionLineMatch = text.match(/(?:^|\n)###\s+Selection\s*\n([\d,]+)\s+files\s+•\s+([\d,]+)\s+tokens\b/i);

  const fileCount = selectedFilesMatch
    ? parseSummaryCount(selectedFilesMatch[1])
    : selectionLineMatch
      ? parseSummaryCount(selectionLineMatch[1])
      : undefined;
  const tokens = selectionTokensMatch
    ? parseSummaryCount(selectionTokensMatch[1])
    : selectionLineMatch
      ? parseSummaryCount(selectionLineMatch[2])
      : undefined;

  if (fileCount === undefined && tokens === undefined) {
    return null;
  }

  return { fileCount, tokens };
}

export function parseSelectionSummaryFromJson(
  value: unknown
): { fileCount?: number; tokens?: number } | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const root = value as Record<string, unknown>;
  const selection =
    root.selection && typeof root.selection === "object"
      ? (root.selection as Record<string, unknown>)
      : null;
  const summary =
    root.summary && typeof root.summary === "object" ? (root.summary as Record<string, unknown>) : null;

  const candidates = [root, selection, summary].filter(Boolean) as Array<Record<string, unknown>>;

  let fileCount: number | undefined;
  let tokens: number | undefined;

  for (const candidate of candidates) {
    fileCount ??= parseSelectionSummaryNumber(candidate.fileCount ?? candidate.file_count);
    tokens ??= parseSelectionSummaryNumber(candidate.tokens ?? candidate.totalTokens ?? candidate.total_tokens);

    if (fileCount !== undefined && tokens !== undefined) {
      break;
    }
  }

  if (fileCount === undefined && tokens === undefined) {
    return null;
  }

  return { fileCount, tokens };
}

export function recoverAutoSelectionStateForTabRecovery(
  previousState: AutoSelectionEntryData | null,
  previousBinding: RpBinding | null,
  nextBinding: RpBinding | null
): AutoSelectionEntryData | null {
  if (!previousState || !previousBinding?.tab || !nextBinding?.tab || previousBinding.tab === nextBinding.tab) {
    return null;
  }

  if (previousState.fullPaths.length === 0 && previousState.slicePaths.length === 0) {
    return null;
  }

  if (previousState.app !== previousBinding.app || previousBinding.app !== nextBinding.app) {
    return null;
  }

  return {
    ...previousState,
    app: nextBinding.app,
    windowId: nextBinding.windowId,
    tab: nextBinding.tab,
    workspace: nextBinding.workspace,
  };
}

export function buildSelectionPathFromResolved(
  inputPath: string,
  resolved: { absolutePath: string | null; repoRoot: string | null }
): string {
  if (!resolved.absolutePath || !resolved.repoRoot) {
    return toPosixPath(inputPath);
  }

  const rel = path.relative(resolved.repoRoot, resolved.absolutePath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return toPosixPath(inputPath);
  }

  const rootHint = path.basename(resolved.repoRoot);
  const relPosix = rel.split(path.sep).join("/");

  return `${rootHint}/${relPosix}`;
}

export function deriveRepoRelativePathFromInput(
  inputPath: string,
  binding: RpBinding | null,
  resolved: { repoRoot: string | null }
): string | null {
  const normalized = toPosixPath(inputPath).replace(/^\/+/, "");
  if (!normalized) {
    return null;
  }

  const rootHints = new Set<string>();
  if (binding?.workspace) {
    rootHints.add(binding.workspace);
  }
  if (resolved.repoRoot) {
    rootHints.add(path.basename(resolved.repoRoot));
  }

  const colonIdx = normalized.indexOf(":");
  if (colonIdx > 0) {
    const rootHint = normalized.slice(0, colonIdx).trim();
    const relPath = normalized.slice(colonIdx + 1).replace(/^\/+/, "");
    if (rootHints.has(rootHint) && relPath) {
      return relPath;
    }
  }

  const segments = normalized.split("/").filter(Boolean);
  if (segments.length >= 2) {
    const [rootHint, ...rest] = segments;
    const relPath = rest.join("/");
    if (rootHint && rootHints.has(rootHint) && relPath) {
      return relPath;
    }
  }

  return null;
}

export interface AutoSelectSlicePlan {
  candidatePaths: string[];
  selectionMode: "full" | "slices" | "codemap_only" | null;
  observedRanges: AutoSelectionEntryRangeData[] | null;
  baseStateTracksSelectionPath: boolean;
  uiAlreadyCoversNewSlice: boolean;
  normalizedSelectionPath: string;
  nextState: AutoSelectionEntryData;
  desiredSlice: AutoSelectionEntrySliceData | null;
  removeVariants: string[];
  repoRel: string | null;
}

function inferObservedSliceRangesForCandidates(
  selectionText: string,
  candidatePaths: string[]
): AutoSelectionEntryRangeData[] | null {
  for (const candidate of candidatePaths) {
    const ranges = inferSelectionSliceRanges(selectionText, candidate);
    if (ranges) {
      return ranges;
    }
  }

  return null;
}

function selectionRangesEqual(
  left: AutoSelectionEntryRangeData[] | null | undefined,
  right: AutoSelectionEntryRangeData[] | null | undefined
): boolean {
  return JSON.stringify(normalizeAutoSelectionRangesForPlan(left ?? [])) ===
    JSON.stringify(normalizeAutoSelectionRangesForPlan(right ?? []));
}

function normalizeAutoSelectionRangesForPlan(
  ranges: AutoSelectionEntryRangeData[]
): AutoSelectionEntryRangeData[] {
  const normalized = ranges
    .map((range) => ({
      start_line: Number(range.start_line),
      end_line: Number(range.end_line),
    }))
    .filter((range) => Number.isFinite(range.start_line) && Number.isFinite(range.end_line))
    .filter((range) => range.start_line > 0 && range.end_line >= range.start_line)
    .sort((a, b) => {
      if (a.start_line !== b.start_line) {
        return a.start_line - b.start_line;
      }
      return a.end_line - b.end_line;
    });

  const merged: AutoSelectionEntryRangeData[] = [];
  for (const range of normalized) {
    if (merged.length === 0) {
      merged.push(range);
      continue;
    }

    const last = merged[merged.length - 1];
    if (range.start_line <= last.end_line + 1) {
      last.end_line = Math.max(last.end_line, range.end_line);
      continue;
    }

    merged.push(range);
  }

  return merged;
}

function autoSelectionStateTracksAnyCandidatePath(
  state: AutoSelectionEntryData,
  candidatePaths: Iterable<string>
): boolean {
  const candidatePathKeys = new Set([...candidatePaths].map((p) => toPosixPath(p).replace(/\/+$/, "")));

  return state.fullPaths.some((p) => candidatePathKeys.has(toPosixPath(p).replace(/\/+$/, ""))) ||
    state.slicePaths.some((item) => candidatePathKeys.has(toPosixPath(item.path).replace(/\/+$/, "")));
}

function normalizeAutoSelectionStateForPlan(state: AutoSelectionEntryData): AutoSelectionEntryData {
  const fullPaths = [...new Set(state.fullPaths.map((p) => toPosixPath(String(p).trim())).filter(Boolean))].sort();
  const fullSet = new Set(fullPaths);
  const sliceMap = new Map<string, AutoSelectionEntryRangeData[]>();

  for (const item of state.slicePaths) {
    const pathKey = toPosixPath(String(item.path).trim());
    if (!pathKey || fullSet.has(pathKey)) {
      continue;
    }

    const existing = sliceMap.get(pathKey) ?? [];
    existing.push(...normalizeAutoSelectionRangesForPlan(item.ranges));
    sliceMap.set(pathKey, existing);
  }

  const slicePaths: AutoSelectionEntrySliceData[] = [...sliceMap.entries()]
    .map(([pathKey, ranges]) => ({
      path: pathKey,
      ranges: normalizeAutoSelectionRangesForPlan(ranges),
    }))
    .filter((item: AutoSelectionEntrySliceData) => item.ranges.length > 0)
    .sort((a, b) => a.path.localeCompare(b.path));

  return {
    ...state,
    fullPaths,
    slicePaths,
  };
}

export function planAutoSelectSliceUpdate(args: {
  selectionText: string;
  inputPath: string;
  selectionPath: string;
  binding: RpBinding | null;
  resolved: { absolutePath: string | null; repoRoot: string | null };
  baseState: AutoSelectionEntryData;
  sliceRange: AutoSelectionEntryRangeData;
}): AutoSelectSlicePlan {
  const { selectionText, inputPath, selectionPath, binding, resolved, baseState, sliceRange } = args;

  const candidatePaths = new Set<string>();
  candidatePaths.add(toPosixPath(selectionPath));
  candidatePaths.add(toPosixPath(inputPath));

  if (resolved.absolutePath) {
    candidatePaths.add(toPosixPath(resolved.absolutePath));
  }

  const derivedRepoRel = deriveRepoRelativePathFromInput(inputPath, binding, resolved);
  if (derivedRepoRel) {
    candidatePaths.add(toPosixPath(derivedRepoRel));
  }

  if (resolved.absolutePath && resolved.repoRoot) {
    const rel = path.relative(resolved.repoRoot, resolved.absolutePath);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
      candidatePaths.add(toPosixPath(rel.split(path.sep).join("/")));
    }
  }

  let selectionStatus: ReturnType<typeof inferSelectionStatus> = null;

  for (const candidate of candidatePaths) {
    const status = inferSelectionStatus(selectionText, candidate);
    if (!status) {
      continue;
    }

    if (status.mode === "full") {
      selectionStatus = status;
      break;
    }

    if (status.mode === "codemap_only" && status.codemapManual === true) {
      selectionStatus = status;
      break;
    }

    if (selectionStatus === null) {
      selectionStatus = status;
      continue;
    }

    if (selectionStatus.mode === "codemap_only" && status.mode === "slices") {
      selectionStatus = status;
    }
  }

  const normalizedSelectionPath = toPosixPath(selectionPath);
  const baseStateTracksSelectionPath = autoSelectionStateTracksAnyCandidatePath(baseState, candidatePaths);

  const observedRanges =
    selectionStatus?.mode === "slices"
      ? inferObservedSliceRangesForCandidates(selectionText, [...candidatePaths])
      : null;

  let mergeState = baseState;
  if (observedRanges) {
    const candidatePathKeys = new Set([...candidatePaths].map((p) => toPosixPath(p).replace(/\/+$/, "")));

    mergeState = {
      ...baseState,
      fullPaths: baseState.fullPaths.filter((p) => !candidatePathKeys.has(toPosixPath(p).replace(/\/+$/, ""))),
      slicePaths: baseState.slicePaths.filter(
        (item) => !candidatePathKeys.has(toPosixPath(item.path).replace(/\/+$/, ""))
      ),
    };

    for (const range of observedRanges) {
      mergeState = applySliceReadToSelectionState(mergeState, normalizedSelectionPath, range);
    }
  }

  const nextState = normalizeAutoSelectionStateForPlan(
    applySliceReadToSelectionState(mergeState, normalizedSelectionPath, sliceRange)
  );

  const repoRel =
    resolved.absolutePath && resolved.repoRoot
      ? toPosixPath(path.relative(resolved.repoRoot, resolved.absolutePath).split(path.sep).join("/"))
      : derivedRepoRel;

  const rootHint = resolved.repoRoot ? path.basename(resolved.repoRoot) : null;
  const rootScoped = rootHint && repoRel ? `${rootHint}/${repoRel}` : null;

  const removeVariants = new Set<string>();
  removeVariants.add(normalizedSelectionPath);

  if (repoRel) {
    removeVariants.add(repoRel);
  }

  if (rootScoped) {
    removeVariants.add(rootScoped);
  }

  if (rootHint && repoRel) {
    removeVariants.add(`${rootHint}:${repoRel}`);
  }

  if (resolved.absolutePath) {
    removeVariants.add(toPosixPath(resolved.absolutePath));
  }

  const normalizedInput = toPosixPath(inputPath);
  if (path.isAbsolute(inputPath) || normalizedInput.includes("/")) {
    removeVariants.add(normalizedInput);
  }

  const desiredSlice = nextState.slicePaths.find((item) => item.path === normalizedSelectionPath) ?? null;
  const uiAlreadyCoversNewSlice = selectionRangesEqual(observedRanges, desiredSlice?.ranges);

  return {
    candidatePaths: [...candidatePaths],
    selectionMode: selectionStatus?.mode ?? null,
    observedRanges,
    baseStateTracksSelectionPath,
    uiAlreadyCoversNewSlice,
    normalizedSelectionPath,
    nextState,
    desiredSlice,
    removeVariants: [...removeVariants],
    repoRel,
  };
}

async function resolveLiveBindingTabLabel(binding: RpBinding | null): Promise<string | null> {
  const client = getRpClient();
  if (!binding?.tab) {
    return null;
  }

  const fallbackLabel = `${binding.tab} [bound]`;
  if (!client.isConnected) {
    return fallbackLabel;
  }

  try {
    const tabs = await fetchWindowTabs(binding.windowId, client);
    const liveTab = tabs.find((tab) => tab.id === binding.tab || tab.name === binding.tab);
    if (!liveTab) {
      return fallbackLabel;
    }

    if (liveTab.isActive === true) {
      return `${liveTab.name} [bound, in-focus]`;
    }
    if (liveTab.isActive === false) {
      return `${liveTab.name} [bound, out-of-focus]`;
    }
    return `${liveTab.name} [bound]`;
  } catch {
    return fallbackLabel;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool Parameters Schema
// ─────────────────────────────────────────────────────────────────────────────

const RpToolSchema = Type.Object({
  // Mode selection (priority: call > describe > search > windows > bind > status)
  call: Type.Optional(Type.String({ description: "Tool name to call (e.g., 'read_file', 'apply_edits')" })),
  args: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Arguments for tool call" })),
  describe: Type.Optional(Type.String({ description: "Tool name to describe (shows parameters)" })),
  search: Type.Optional(Type.String({ description: "Search query for tools (space-separated words OR'd)" })),
  windows: Type.Optional(Type.Boolean({ description: "List all RepoPrompt windows" })),
  bind: Type.Optional(
    Type.Object({
      window: Type.Number({ description: "Window ID to bind to" }),
      tab: Type.Optional(Type.String({ description: "Tab name or ID to bind to" })),
    })
  ),

  // Safety overrides
  allowDelete: Type.Optional(Type.Boolean({ description: "Allow delete operations (default: false)" })),
  confirmEdits: Type.Optional(
    Type.Boolean({ description: "Confirm edit-like operations (required when confirmEdits is enabled)" })
  ),
});

// ─────────────────────────────────────────────────────────────────────────────
// Extension Entry Point
// ─────────────────────────────────────────────────────────────────────────────

export default function repopromptMcp(pi: ExtensionAPI) {
  let config: RpConfig = loadConfig();
    let activeApp: RpAppId = config.activeApp;
  let connectedApp: RpAppId | null = null;
  let initPromise: Promise<void> | null = null;
  let shutdownRequested = false;
  let extensionPaused = false;

  function isRpAppId(value: unknown): value is RpAppId {
    return RP_APP_IDS.includes(value as RpAppId);
  }

  function loadRuntimeConfig(): RpConfig {
    config = loadConfig({ activeApp });
      activeApp = config.activeApp;
    return config;
  }

  function activeAppLabel(app: RpAppId = activeApp): string {
    return getAppLabel(config, app);
  }

  function activeAppDisplay(app: RpAppId = activeApp): string {
    return `${activeAppLabel(app)} (${app})`;
  }

  function findLatestSessionApp(ctx: ExtensionContext, fallback: RpAppId): RpAppId {
    const entries = ctx.sessionManager.getBranch();

    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type !== "custom") {
        continue;
      }

      if (entry.customType === ACTIVE_APP_ENTRY_TYPE) {
        const data = entry.data as ActiveAppEntryData | undefined;
        if (isRpAppId(data?.app)) {
          return data.app;
        }
      }

      if (entry.customType === BINDING_ENTRY_TYPE || entry.customType === AUTO_SELECTION_ENTRY_TYPE) {
        const data = entry.data as { app?: unknown } | undefined;
        if (isRpAppId(data?.app)) {
          return data.app;
        }
      }
    }

    return fallback;
  }

  function restoreRuntimeApp(ctx: ExtensionContext): void {
    const loadedConfig = loadConfig();
    activeApp = findLatestSessionApp(ctx, loadedConfig.activeApp);
    config = loadConfig({ activeApp });
  }

  function persistActiveApp(app: RpAppId): void {
    pi.appendEntry(ACTIVE_APP_ENTRY_TYPE, { app });
  }

  function markConnectedApp(app: RpAppId): void {
    connectedApp = app;
  }

  async function resetConnectionForActiveAppChange(previousApp: RpAppId): Promise<void> {
    if (previousApp === activeApp) {
      return;
    }

    initPromise = null;
    connectedApp = null;
    clearBinding();
    clearReadcacheCaches();
    clearRootsCache();
    resetAutoSelectionRuntimeState();
    clearPendingTransitionSelectionState();
    await resetRpClient();
  }

  pi.on("before_agent_start", async () => {
    // Reload config so display knobs (collapsedMaxLines etc.) apply without requiring /reload
    config = loadRuntimeConfig();
    if (config.toolCallTimeoutMs !== undefined) {
      getRpClient().setToolCallTimeoutMs(config.toolCallTimeoutMs);
    }
  });

  // Replay-aware read_file caching state (optional; guarded by config.readcacheReadFile)
  const readcacheRuntimeState = createReplayRuntimeState();

  const clearReadcacheCaches = (): void => {
    clearReplayRuntimeState(readcacheRuntimeState);
  };

  type AutoSelectionSyncOptions = {
    provisionTab?: boolean;
    recoverClosedTab?: boolean;
    reuseSoleEmptyTab?: boolean;
    allowSyntheticSource?: boolean;
    preserveSourceSelection?: boolean;
  };

  const STARTUP_AUTO_SELECTION_SYNC_OPTIONS: AutoSelectionSyncOptions = {
    provisionTab: true,
    recoverClosedTab: false,
    reuseSoleEmptyTab: false,
    allowSyntheticSource: true,
  };

  const TRANSITION_AUTO_SELECTION_SYNC_OPTIONS: AutoSelectionSyncOptions = {
    provisionTab: false,
    recoverClosedTab: true,
    reuseSoleEmptyTab: true,
    allowSyntheticSource: false,
  };

  let activeAutoSelectionState: AutoSelectionEntryData | null = null;
  let autoSelectionUpdateQueue: Promise<void> = Promise.resolve();
  let ownsLiveAutoSelection = false;

  function runAutoSelectionUpdate<T>(task: () => Promise<T>): Promise<T> {
    const queued = autoSelectionUpdateQueue.then(task, task);
    autoSelectionUpdateQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  function sameOptionalTab(a?: string, b?: string): boolean {
    return (a ?? undefined) === (b ?? undefined);
  }

  function sameBindingForAutoSelection(
    binding: RpBinding | null,
    state: AutoSelectionEntryData | null
  ): boolean {
    if (!binding || !state) {
      return false;
    }

    if (!sameOptionalTab(binding.tab, state.tab)) {
      return false;
    }

    if (binding.app !== state.app) {
      return false;
    }

    if (binding.windowId === state.windowId) {
      return true;
    }

    if (binding.workspace && state.workspace && binding.workspace === state.workspace) {
      return true;
    }

    return false;
  }

  function makeEmptyAutoSelectionState(binding: RpBinding): AutoSelectionEntryData {
    return {
      app: binding.app,
      windowId: binding.windowId,
      tab: binding.tab,
      workspace: binding.workspace,
      fullPaths: [],
      slicePaths: [],
    };
  }

  function normalizeAutoSelectionRanges(ranges: AutoSelectionEntryRangeData[]): AutoSelectionEntryRangeData[] {
    const normalized = ranges
      .map((range) => ({
        start_line: Number(range.start_line),
        end_line: Number(range.end_line),
      }))
      .filter((range) => Number.isFinite(range.start_line) && Number.isFinite(range.end_line))
      .filter((range) => range.start_line > 0 && range.end_line >= range.start_line)
      .sort((a, b) => {
        if (a.start_line !== b.start_line) {
          return a.start_line - b.start_line;
        }
        return a.end_line - b.end_line;
      });

    const merged: AutoSelectionEntryRangeData[] = [];
    for (const range of normalized) {
      if (merged.length === 0) {
        merged.push(range);
        continue;
      }

      const last = merged[merged.length - 1];
      if (range.start_line <= last.end_line + 1) {
        last.end_line = Math.max(last.end_line, range.end_line);
        continue;
      }

      merged.push(range);
    }

    return merged;
  }

  function normalizeAutoSelectionState(state: AutoSelectionEntryData): AutoSelectionEntryData {
    const fullPaths = [...new Set(state.fullPaths.map((p) => toPosixPath(String(p).trim())).filter(Boolean))].sort();

    const fullSet = new Set(fullPaths);

    const sliceMap = new Map<string, AutoSelectionEntryRangeData[]>();
    for (const item of state.slicePaths) {
      const pathKey = toPosixPath(String(item.path).trim());
      if (!pathKey || fullSet.has(pathKey)) {
        continue;
      }

      const existing = sliceMap.get(pathKey) ?? [];
      existing.push(...normalizeAutoSelectionRanges(item.ranges));
      sliceMap.set(pathKey, existing);
    }

    const slicePaths: AutoSelectionEntrySliceData[] = [...sliceMap.entries()]
      .map(([pathKey, ranges]) => ({
        path: pathKey,
        ranges: normalizeAutoSelectionRanges(ranges),
      }))
      .filter((item) => item.ranges.length > 0)
      .sort((a, b) => a.path.localeCompare(b.path));

    return {
      app: state.app,
      windowId: state.windowId,
      tab: state.tab,
      workspace: typeof state.workspace === "string" ? state.workspace : undefined,
      fullPaths,
      slicePaths,
    };
  }

  function autoSelectionStatesEqual(a: AutoSelectionEntryData | null, b: AutoSelectionEntryData | null): boolean {
    if (!a && !b) {
      return true;
    }

    if (!a || !b) {
      return false;
    }

    const left = normalizeAutoSelectionState(a);
    const right = normalizeAutoSelectionState(b);

    return JSON.stringify(left) === JSON.stringify(right);
  }

  function parseAutoSelectionEntryData(
    value: unknown,
    binding: RpBinding
  ): AutoSelectionEntryData | null {
    if (!value || typeof value !== "object") {
      return null;
    }

    const obj = value as Record<string, unknown>;

    if (obj.app !== binding.app) {
      return null;
    }

    const windowId = typeof obj.windowId === "number" ? obj.windowId : undefined;
    const tab = typeof obj.tab === "string" ? obj.tab : undefined;
    const workspace = typeof obj.workspace === "string" ? obj.workspace : undefined;

    const tabMatches = sameOptionalTab(tab, binding.tab);
    const windowMatches = windowId === binding.windowId;
    const workspaceMatches = Boolean(workspace && binding.workspace && workspace === binding.workspace);

    if (!tabMatches || (!windowMatches && !workspaceMatches)) {
      return null;
    }

    const fullPaths = Array.isArray(obj.fullPaths)
      ? obj.fullPaths.filter((p): p is string => typeof p === "string")
      : [];

    const slicePathsRaw = Array.isArray(obj.slicePaths) ? obj.slicePaths : [];
    const slicePaths: AutoSelectionEntrySliceData[] = slicePathsRaw
      .map((raw) => {
        if (!raw || typeof raw !== "object") {
          return null;
        }

        const row = raw as Record<string, unknown>;
        const pathValue = typeof row.path === "string" ? row.path : null;
        const rangesRaw = Array.isArray(row.ranges) ? row.ranges : [];

        if (!pathValue) {
          return null;
        }

        const ranges: AutoSelectionEntryRangeData[] = rangesRaw
          .map((rangeRaw) => {
            if (!rangeRaw || typeof rangeRaw !== "object") {
              return null;
            }

            const rangeObj = rangeRaw as Record<string, unknown>;
            const start = typeof rangeObj.start_line === "number" ? rangeObj.start_line : NaN;
            const end = typeof rangeObj.end_line === "number" ? rangeObj.end_line : NaN;

            if (!Number.isFinite(start) || !Number.isFinite(end)) {
              return null;
            }

            return {
              start_line: start,
              end_line: end,
            };
          })
          .filter((range): range is AutoSelectionEntryRangeData => range !== null);

        return {
          path: pathValue,
          ranges,
        };
      })
      .filter((item): item is AutoSelectionEntrySliceData => item !== null);

    return normalizeAutoSelectionState({
      app: binding.app,
      windowId: binding.windowId,
      tab: binding.tab,
      workspace: binding.workspace ?? workspace,
      fullPaths,
      slicePaths,
    });
  }

  function findAutoSelectionStateInEntries(
    entries: Array<{ type: string; customType?: string; data?: unknown }>,
    binding: RpBinding
  ): AutoSelectionEntryData | null {
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type !== "custom" || entry.customType !== AUTO_SELECTION_ENTRY_TYPE) {
        continue;
      }

      const parsed = parseAutoSelectionEntryData(entry.data, binding);
      if (parsed) {
        return parsed;
      }
    }

    return null;
  }

  function getAutoSelectionStateFromBranch(
    ctx: ExtensionContext,
    binding: RpBinding
  ): AutoSelectionEntryData {
    const entries = ctx.sessionManager.getBranch();
    return findAutoSelectionStateInEntries(entries, binding) ?? makeEmptyAutoSelectionState(binding);
  }

  function resetAutoSelectionRuntimeState(): void {
    activeAutoSelectionState = null;
    autoSelectionUpdateQueue = Promise.resolve();
    ownsLiveAutoSelection = false;
  }

  function commitLiveAutoSelectionState(state: AutoSelectionEntryData | null): void {
    activeAutoSelectionState = state ? normalizeAutoSelectionState(state) : null;
    ownsLiveAutoSelection = true;
  }

  function hasManagedAutoSelectionPaths(state: AutoSelectionEntryData | null): boolean {
    return state !== null && autoSelectionManagedPaths(state).length > 0;
  }

  function updatePendingTransitionSelectionFromLiveState(): void {
    if (!ownsLiveAutoSelection) {
      return;
    }

    if (!hasManagedAutoSelectionPaths(activeAutoSelectionState)) {
      clearPendingTransitionSelectionState();
      return;
    }

    setPendingTransitionSelectionState(activeAutoSelectionState);
  }

  function autoSelectionRetryModeForSessionStartReason(
    reason: "startup" | "reload" | "new" | "resume" | "fork"
  ): PendingTransitionRetryMode {
    return reason === "startup" || reason === "reload" ? "startup" : "transition";
  }

  function autoSelectionRetryModeForSyncOptions(
    options: AutoSelectionSyncOptions
  ): PendingTransitionRetryMode {
    return options.provisionTab === false ? "transition" : "startup";
  }

  function autoSelectionSyncOptionsForRetryMode(
    retryMode: PendingTransitionRetryMode
  ): AutoSelectionSyncOptions {
    return retryMode === "startup"
      ? STARTUP_AUTO_SELECTION_SYNC_OPTIONS
      : TRANSITION_AUTO_SELECTION_SYNC_OPTIONS;
  }

  function autoSelectionSyncOptionsForSessionStartReason(
    reason: "startup" | "reload" | "new" | "resume" | "fork"
  ): AutoSelectionSyncOptions {
    return autoSelectionSyncOptionsForRetryMode(autoSelectionRetryModeForSessionStartReason(reason));
  }

  function reconnectAutoSelectionSyncOptions(): AutoSelectionSyncOptions {
    return autoSelectionSyncOptionsForRetryMode(getPendingTransitionState()?.retryMode ?? "startup");
  }

  function persistAutoSelectionState(state: AutoSelectionEntryData): void {
    const normalized = normalizeAutoSelectionState(state);
    commitLiveAutoSelectionState(normalized);
    pi.appendEntry(AUTO_SELECTION_ENTRY_TYPE, normalized);
  }

  function adoptAutoSelectionStateForBinding(ctx: ExtensionContext, binding: RpBinding): RpBinding {
    clearPendingTransitionSelectionState();
    const state = config.autoSelectReadSlices === true && binding.tab
      ? getAutoSelectionStateFromBranch(ctx, binding)
      : null;
    commitLiveAutoSelectionState(state);
    return binding;
  }

  function getPendingTransitionTargetIdentity(ctx: ExtensionContext): PendingTransitionTargetIdentity {
    return {
      app: activeApp,
      sessionFile: ctx.sessionManager.getSessionFile() ?? null,
      sessionId: ctx.sessionManager.getSessionId(),
    };
  }

  function samePendingTransitionTargetIdentity(
    left: PendingTransitionTargetIdentity | null,
    right: PendingTransitionTargetIdentity | null
  ): boolean {
    return left?.app === right?.app && left?.sessionFile === right?.sessionFile && left?.sessionId === right?.sessionId;
  }

  function seedPendingTransitionTargetForSessionStart(
    ctx: ExtensionContext,
    options: AutoSelectionSyncOptions
  ): void {
    const binding = getBinding();
    const state = config.autoSelectReadSlices === true && binding?.tab
      ? getAutoSelectionStateFromBranch(ctx, binding)
      : null;

    setPendingTransitionTargetState(
      getPendingTransitionTargetIdentity(ctx),
      binding,
      state,
      autoSelectionRetryModeForSyncOptions(options)
    );
  }

  function throwOnMcpToolResultError(result: McpToolResult, fallbackMessage: string): void {
    if (!result.isError) {
      return;
    }

    throw new Error(extractTextContent(result.content) || fallbackMessage);
  }

  function isIgnorableOldBindingRemovalError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    const lower = message.toLowerCase();

    return (
      (lower.includes("window") && lower.includes("not found")) ||
      (lower.includes("tab") && lower.includes("not found")) ||
      (lower.includes("context") && lower.includes("not found")) ||
      lower.includes("does not host context_id")
    );
  }

  function bindingArgsForAutoSelectionState(state: AutoSelectionEntryData): Record<string, unknown> {
    return {
      _windowID: state.windowId,
      ...(state.tab ? { context_id: state.tab } : {}),
    };
  }

  function autoSelectionManagedPaths(state: AutoSelectionEntryData): string[] {
    const fromSlices = state.slicePaths.map((item) => item.path);
    return [...new Set([...state.fullPaths, ...fromSlices])];
  }

  function autoSelectionSliceKey(item: AutoSelectionEntrySliceData): string {
    return JSON.stringify(normalizeAutoSelectionRanges(item.ranges));
  }

  async function removeAutoSelectionPaths(
    client: ReturnType<typeof getRpClient>,
    manageSelectionToolName: string,
    state: AutoSelectionEntryData,
    paths: string[]
  ): Promise<void> {
    if (paths.length === 0) {
      return;
    }

    const result = await client.callTool(manageSelectionToolName, {
      op: "remove",
      paths,
      ...bindingArgsForAutoSelectionState(state),
    });
    throwOnMcpToolResultError(result, "RepoPrompt manage_selection remove failed");
  }

  async function addAutoSelectionFullPaths(
    client: ReturnType<typeof getRpClient>,
    manageSelectionToolName: string,
    state: AutoSelectionEntryData,
    paths: string[]
  ): Promise<void> {
    if (paths.length === 0) {
      return;
    }

    const result = await client.callTool(manageSelectionToolName, {
      op: "add",
      mode: "full",
      paths,
      ...bindingArgsForAutoSelectionState(state),
    });
    throwOnMcpToolResultError(result, "RepoPrompt manage_selection add(full) failed");
  }

  async function addAutoSelectionSlices(
    client: ReturnType<typeof getRpClient>,
    manageSelectionToolName: string,
    state: AutoSelectionEntryData,
    slices: AutoSelectionEntrySliceData[]
  ): Promise<void> {
    if (slices.length === 0) {
      return;
    }

    const result = await client.callTool(manageSelectionToolName, {
      op: "add",
      slices,
      ...bindingArgsForAutoSelectionState(state),
    });
    throwOnMcpToolResultError(result, "RepoPrompt manage_selection add(slices) failed");
  }

  async function reconcileAutoSelectionWithinBinding(
    client: ReturnType<typeof getRpClient>,
    manageSelectionToolName: string,
    currentState: AutoSelectionEntryData,
    desiredState: AutoSelectionEntryData
  ): Promise<void> {
    const currentModeByPath = new Map<string, "full" | "slices">();
    for (const p of currentState.fullPaths) {
      currentModeByPath.set(p, "full");
    }
    for (const s of currentState.slicePaths) {
      if (!currentModeByPath.has(s.path)) {
        currentModeByPath.set(s.path, "slices");
      }
    }

    const desiredModeByPath = new Map<string, "full" | "slices">();
    for (const p of desiredState.fullPaths) {
      desiredModeByPath.set(p, "full");
    }
    for (const s of desiredState.slicePaths) {
      if (!desiredModeByPath.has(s.path)) {
        desiredModeByPath.set(s.path, "slices");
      }
    }

    const desiredSliceByPath = new Map<string, AutoSelectionEntrySliceData>();
    for (const s of desiredState.slicePaths) {
      desiredSliceByPath.set(s.path, s);
    }

    const currentSliceByPath = new Map<string, AutoSelectionEntrySliceData>();
    for (const s of currentState.slicePaths) {
      currentSliceByPath.set(s.path, s);
    }

    const removePaths = new Set<string>();
    const addFullPaths: string[] = [];
    const addSlices: AutoSelectionEntrySliceData[] = [];

    for (const [pathKey] of currentModeByPath) {
      if (!desiredModeByPath.has(pathKey)) {
        removePaths.add(pathKey);
      }
    }

    for (const [pathKey, mode] of desiredModeByPath) {
      const currentMode = currentModeByPath.get(pathKey);

      if (mode === "full") {
        if (currentMode === "full") {
          continue;
        }

        if (currentMode === "slices") {
          removePaths.add(pathKey);
        }

        addFullPaths.push(pathKey);
        continue;
      }

      const desiredSlice = desiredSliceByPath.get(pathKey);
      if (!desiredSlice) {
        continue;
      }

      if (currentMode === "full") {
        removePaths.add(pathKey);
        addSlices.push(desiredSlice);
        continue;
      }

      if (currentMode === "slices") {
        const currentSlice = currentSliceByPath.get(pathKey);
        if (currentSlice && autoSelectionSliceKey(currentSlice) === autoSelectionSliceKey(desiredSlice)) {
          continue;
        }

        removePaths.add(pathKey);
        addSlices.push(desiredSlice);
        continue;
      }

      addSlices.push(desiredSlice);
    }

    await removeAutoSelectionPaths(client, manageSelectionToolName, currentState, [...removePaths]);
    await addAutoSelectionFullPaths(client, manageSelectionToolName, desiredState, addFullPaths);
    await addAutoSelectionSlices(client, manageSelectionToolName, desiredState, addSlices);
  }

  async function reconcileAutoSelectionStates(
    currentState: AutoSelectionEntryData | null,
    desiredState: AutoSelectionEntryData | null,
    options: { preserveSourceSelection?: boolean } = {}
  ): Promise<void> {
    if (autoSelectionStatesEqual(currentState, desiredState)) {
      return;
    }

    const client = getRpClient();
    if (!client.isConnected) {
      return;
    }

    const manageSelectionToolName = resolveToolName(client.tools, "manage_selection");
    if (!manageSelectionToolName) {
      return;
    }

    if (currentState && desiredState) {
      const sameBinding =
        currentState.app === desiredState.app &&
        currentState.windowId === desiredState.windowId &&
        sameOptionalTab(currentState.tab, desiredState.tab);

      if (sameBinding) {
        await reconcileAutoSelectionWithinBinding(client, manageSelectionToolName, currentState, desiredState);
        return;
      }

      if (options.preserveSourceSelection !== true) {
        try {
          await removeAutoSelectionPaths(
            client,
            manageSelectionToolName,
            currentState,
            autoSelectionManagedPaths(currentState)
          );
        } catch (error) {
          if (!isIgnorableOldBindingRemovalError(error)) {
            throw error;
          }
        }
      }

      await addAutoSelectionFullPaths(client, manageSelectionToolName, desiredState, desiredState.fullPaths);
      await addAutoSelectionSlices(client, manageSelectionToolName, desiredState, desiredState.slicePaths);
      return;
    }

    if (currentState && !desiredState) {
      if (options.preserveSourceSelection === true) {
        return;
      }

      try {
        await removeAutoSelectionPaths(
          client,
          manageSelectionToolName,
          currentState,
          autoSelectionManagedPaths(currentState)
        );
      } catch (error) {
        if (!isIgnorableOldBindingRemovalError(error)) {
          throw error;
        }
      }
      return;
    }

    if (!currentState && desiredState) {
      await addAutoSelectionFullPaths(client, manageSelectionToolName, desiredState, desiredState.fullPaths);
      await addAutoSelectionSlices(client, manageSelectionToolName, desiredState, desiredState.slicePaths);
    }
  }

  async function ensureBindingTargetsLiveWindow(
    ctx: ExtensionContext,
    options: {
      provisionTab?: boolean;
      recoverClosedTab?: boolean;
      reuseSoleEmptyTab?: boolean;
      hasRecoverableState?: boolean;
      recoveryPaths?: string[];
    } = {}
  ): Promise<RpBinding | null> {
    const binding = getBinding();
    if (!binding) {
      return null;
    }

    const client = getRpClient();
    if (!client.isConnected) {
      return binding;
    }

    let windows: RpWindow[];
    try {
      windows = await fetchWindows(pi, config);
    } catch {
      return binding;
    }

    if (windows.length === 0) {
      return binding;
    }

    let liveBinding = binding;

    if (!windows.some((w) => w.id === binding.windowId)) {
      if (!binding.workspace) {
        clearBinding();
        return null;
      }

      const workspaceMatches = windows.filter((w) => w.workspace === binding.workspace);
      const rootRecovery = options.recoveryPaths && options.recoveryPaths.length > 0
        ? await findRecoveryWindowBySelectionPaths(windows, options.recoveryPaths, ctx.cwd)
        : { window: null, ambiguous: false, matches: [] };
      const match = workspaceMatches.length === 1 ? workspaceMatches[0] : rootRecovery.window;

      if (match) {
        try {
          liveBinding = await bindToWindow(pi, match.id, binding.tab, config);
        } catch {
          clearBinding();
          return null;
        }
      } else {
        clearBinding();

        if (ctx.hasUI) {
          if (workspaceMatches.length > 1) {
            ctx.ui.notify(
              `RepoPrompt: binding for workspace "${binding.workspace}" is ambiguous after restart. Re-bind with /rp bind.`,
              "warning"
            );
          } else if (rootRecovery.ambiguous) {
            ctx.ui.notify(
              "RepoPrompt: multiple open workspaces contain this session's required roots. Re-bind with /rp bind.",
              "warning"
            );
          } else if (options.recoveryPaths && options.recoveryPaths.length > 0) {
            ctx.ui.notify(
              "RepoPrompt: no open workspace contains this session's required roots. Re-bind with /rp bind.",
              "warning"
            );
          } else {
            ctx.ui.notify(
              `RepoPrompt: workspace "${binding.workspace}" not found after restart. Re-bind with /rp bind.`,
              "warning"
            );
          }
        }

        return null;
      }
    }

    try {
      return await ensureBindingHasTab(pi, ctx, config, undefined, {
        createIfMissing: options.provisionTab !== false,
        recoverIfMissing: options.recoverClosedTab === true && options.hasRecoverableState === true,
        reuseSoleEmptyTab: options.reuseSoleEmptyTab === true,
      });
    } catch {
      if (ctx.hasUI && options.provisionTab !== false) {
        ctx.ui.notify(
          `RepoPrompt: failed to provision a safe tab for window ${liveBinding.windowId}; keeping current binding.`,
          "warning"
        );
      }
      return getBinding();
    }
  }

  async function syncAutoSelectionToCurrentBranch(
    ctx: ExtensionContext,
    options: AutoSelectionSyncOptions = reconnectAutoSelectionSyncOptions(),
    pendingTargetPolicy: "reuse" | "refresh" = "reuse"
  ): Promise<RpBinding | null> {
    return await runAutoSelectionUpdate(async () => {
      const transitionTargetIdentity = getPendingTransitionTargetIdentity(ctx);
      const pendingTransitionState = getPendingTransitionState();
      const pendingTargetMatchesCurrentSession = samePendingTransitionTargetIdentity(
        pendingTransitionState?.targetIdentity ?? null,
        transitionTargetIdentity
      );
      const reusePendingTarget = pendingTargetPolicy === "reuse" && pendingTargetMatchesCurrentSession;

      const desiredBindingBeforeRecovery = reusePendingTarget
        ? pendingTransitionState?.targetBinding ?? getBinding()
        : getBinding();
      const desiredStateBeforeRecovery = reusePendingTarget
        ? pendingTransitionState?.targetState ?? null
        : config.autoSelectReadSlices === true && desiredBindingBeforeRecovery?.tab
          ? getAutoSelectionStateFromBranch(ctx, desiredBindingBeforeRecovery)
          : null;

      if (!reusePendingTarget) {
        setPendingTransitionTargetState(
          transitionTargetIdentity,
          desiredBindingBeforeRecovery,
          desiredStateBeforeRecovery,
          autoSelectionRetryModeForSyncOptions(options)
        );
      }

      const recoveryPaths = desiredStateBeforeRecovery ? autoSelectionManagedPaths(desiredStateBeforeRecovery) : [];
      const hasRecoverableState = recoveryPaths.length > 0;
      const liveBinding = await ensureBindingTargetsLiveWindow(ctx, {
        ...options,
        hasRecoverableState,
        recoveryPaths,
      });

      if (config.autoSelectReadSlices !== true) {
        clearPendingTransitionSelectionState();
        activeAutoSelectionState = null;
        return liveBinding;
      }

      const candidateSourceState =
        pendingTransitionState?.sourceState ??
        activeAutoSelectionState ??
        (options.allowSyntheticSource === true ? desiredStateBeforeRecovery : null);
      const sourceState = candidateSourceState?.app === activeApp ? candidateSourceState : null;

      let desiredState = liveBinding?.tab ? getAutoSelectionStateFromBranch(ctx, liveBinding) : null;
      let recoveredState = false;

      if (
        liveBinding?.tab &&
        desiredState &&
        desiredStateBeforeRecovery &&
        autoSelectionManagedPaths(desiredState).length === 0
      ) {
        const recovered = recoverAutoSelectionStateForTabRecovery(
          desiredStateBeforeRecovery,
          desiredBindingBeforeRecovery,
          liveBinding
        );
        if (recovered) {
          desiredState = recovered;
          recoveredState = true;
        }
      }

      await reconcileAutoSelectionStates(sourceState, desiredState, {
        preserveSourceSelection: options.preserveSourceSelection,
      });

      if (recoveredState && desiredState) {
        persistAutoSelectionState(desiredState);
      } else {
        commitLiveAutoSelectionState(desiredState);
      }

      clearPendingTransitionSelectionState();
      return liveBinding;
    });
  }

  function getBaseAutoSelectionState(
    ctx: ExtensionContext | undefined,
    binding: RpBinding
  ): AutoSelectionEntryData {
    if (sameBindingForAutoSelection(binding, activeAutoSelectionState)) {
      return activeAutoSelectionState as AutoSelectionEntryData;
    }

    if (ctx) {
      return getAutoSelectionStateFromBranch(ctx, binding);
    }

    return makeEmptyAutoSelectionState(binding);
  }

  async function ensureTabScopedBinding(
    ctx: ExtensionContext,
    reason = "RepoPrompt binding has no tab. Re-bind with /rp bind."
  ): Promise<RpBinding> {
    const binding = await syncAutoSelectionToCurrentBranch(ctx);

    if (!binding) {
      throw new Error("RepoPrompt is not bound. Use /rp bind first.");
    }

    if (!binding.tab) {
      throw new Error(reason);
    }

    return binding;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Lifecycle Events
  // ───────────────────────────────────────────────────────────────────────────

  pi.on("session_start", async (event, ctx) => {
    shutdownRequested = false;
    extensionPaused = false;
    connectedApp = null;
    restoreRuntimeApp(ctx);
    clearReadcacheCaches();
    clearRootsCache();
    resetAutoSelectionRuntimeState();

    if (ctx.hasUI) {
      // This extension used to set a status bar item; clear it to avoid persisting stale UI state
      ctx.ui.setStatus("rp", undefined);
    }

    restoreBinding(ctx, config);

    // Best-effort stale cache pruning (only when readcache is enabled)
    if (config.readcacheReadFile === true) {
      void pruneObjectsOlderThan(ctx.cwd).catch(() => {
        // Fail-open
      });
    }

    const syncOptions = autoSelectionSyncOptionsForSessionStartReason(event.reason);
    seedPendingTransitionTargetForSessionStart(ctx, syncOptions);

    // Non-blocking initialization
    const pendingInit = initializeExtension(pi, ctx, config, markConnectedApp);
    initPromise = pendingInit;

    pendingInit.then(async () => {
      if (initPromise === pendingInit) {
        initPromise = null;
      }
      if (shutdownRequested) {
        return;
      }
      await syncAutoSelectionToCurrentBranch(ctx, syncOptions, "refresh");
    }).catch(async () => {
      if (initPromise === pendingInit) {
        initPromise = null;
      }
      if (shutdownRequested) {
        return;
      }
      // If autoLaunchApp is enabled, try opening the app and retrying once
      const targetConfig = getAppTargetConfig(config, activeApp);
      if (targetConfig.autoLaunchApp) {
        const appPath = inferAppPath(config, activeApp);
        const launched = await tryLaunchApp(appPath);
        if (launched) {
          try {
            await resetRpClient();
            connectedApp = null;
            clearRootsCache();
            await initializeExtension(pi, ctx, config, markConnectedApp);
            await syncAutoSelectionToCurrentBranch(ctx, syncOptions, "refresh");
            return;
          } catch {
            // Fall through to pause
          }
        }
      }

      extensionPaused = true;
      if (ctx.hasUI) {
        ctx.ui.notify(
          `${activeAppLabel()} unavailable — extension paused. Use /rp reconnect or /rp app when ready.`,
          "warning"
        );
      }
    });
  });

  pi.on("session_compact", async () => {
    clearReadcacheCaches();
  });

  pi.on("session_shutdown", async () => {
    shutdownRequested = true;
    initPromise = null;
    updatePendingTransitionSelectionFromLiveState();

    // Never block Pi shutdown on an MCP startup handshake that may be stuck waiting on the app
    clearBinding();
    clearReadcacheCaches();
    clearRootsCache();
    resetAutoSelectionRuntimeState();
    await resetRpClient();
    connectedApp = null;
  });

  pi.on("session_tree", async (_event, ctx) => {
    const previousApp = activeApp;
    restoreRuntimeApp(ctx);
    await resetConnectionForActiveAppChange(previousApp);
    clearReadcacheCaches();
    clearRootsCache();
    restoreBinding(ctx, config);
    await syncAutoSelectionToCurrentBranch(
      ctx,
      { ...TRANSITION_AUTO_SELECTION_SYNC_OPTIONS, preserveSourceSelection: true },
      "refresh"
    );
    if (ctx.hasUI) {
      ctx.ui.setStatus("rp", undefined);
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Commands
  // ───────────────────────────────────────────────────────────────────────────

  pi.registerCommand("rp", {
    description: "RepoPrompt status and commands. Usage: /rp [status|app [ce|classic]|windows|bind [id] [tab]|tab [new|name]|oracle|reconnect|readcache-status|readcache-refresh]",
    handler: async (args, ctx) => {
      const trimmedArgs = args.trim();
      const parts = trimmedArgs ? trimmedArgs.split(/\s+/) : [];
      const subcommand = parts[0]?.toLowerCase() ?? "status";

      // Allow status/reconnect while disconnected or paused
      const alwaysAllowed = new Set([
        "app",
        "reconnect",
        "status",
        "readcache-status",
        "readcache_status",
        "readcache-refresh",
        "readcache_refresh",
      ]);

      if (extensionPaused && !alwaysAllowed.has(subcommand)) {
        ctx.ui.notify("RepoPrompt extension is paused. Use /rp app or /rp reconnect to resume.", "warning");
        return;
      }

      if (!alwaysAllowed.has(subcommand)) {
        await ensureConnected(ctx, { syncAutoSelection: subcommand !== "tab" });
      }

      switch (subcommand) {
        case "status":
          await showStatus(ctx);
          break;

        case "app":
          await handleAppCommand(parts.slice(1), ctx);
          break;

        case "readcache-status":
        case "readcache_status":
          await showReadcacheStatus(ctx);
          break;

        case "readcache-refresh":
        case "readcache_refresh":
          await handleReadcacheRefresh(parts.slice(1), ctx);
          break;

        case "windows":
          await showWindows(ctx);
          break;

        case "bind": {
          const windowIdArg = parts[1];
          const tab = windowIdArg ? parts.slice(2).join(" ") || undefined : undefined;

          let windowId: number | null = null;

          if (!windowIdArg) {
            if (!ctx.hasUI) {
              console.error("Usage: /rp bind <window_id> [tab]");
              return;
            }

            try {
              const windows = await fetchWindows(pi, config);
              if (windows.length === 0) {
                ctx.ui.notify("No RepoPrompt windows found", "warning");
                return;
              }

              const selected = await promptForWindowSelection(ctx, windows);
              if (!selected) {
                ctx.ui.notify("Cancelled", "info");
                return;
              }

              windowId = selected.id;
            } catch (err) {
              ctx.ui.notify(`Failed to list windows: ${err instanceof Error ? err.message : err}`, "error");
              return;
            }
          } else {
            const parsed = parseInt(windowIdArg, 10);
            if (!Number.isFinite(parsed)) {
              ctx.ui.notify("Usage: /rp bind [window_id] [tab]", "error");
              return;
            }
            windowId = parsed;
          }

          try {
            let binding = tab
              ? await bindToTab(pi, windowId, tab, config)
              : await bindToWindow(pi, windowId, undefined, config);

            binding = (await syncAutoSelectionToCurrentBranch(ctx)) ?? binding;
            const tabLabel = await resolveBindingTabLabel(binding);
            ctx.ui.notify(
              `Bound to window ${binding.windowId}` +
              (binding.workspace ? ` (${binding.workspace})` : "") +
              (tabLabel ? `, tab "${tabLabel}"` : ""),
              "info"
            );
          } catch (err) {
            ctx.ui.notify(`Failed to bind: ${err instanceof Error ? err.message : err}`, "error");
          }
          break;
        }

        case "tab": {
          const rawArgs = args.trim();
          const rest = rawArgs.replace(/^tab\b/i, "").trim();
          const argv = splitCommandLine(rest);
          const requested = argv.join(" ").trim();

          try {
            const window = await resolveWindowForTabCommand(ctx, pi, config);
            if (!window) {
              ctx.ui.notify("No RepoPrompt windows found", "warning");
              return;
            }

            let binding: RpBinding | null = null;

            if (!requested) {
              if (!ctx.hasUI) {
                ctx.ui.notify("Usage: /rp tab [new|<tab name or id>]", "error");
                return;
              }

              const tabs = await fetchWindowTabs(window.id);
              const selected = await promptForTabSelection(ctx, tabs);
              if (!selected) {
                ctx.ui.notify("Cancelled", "info");
                return;
              }

              binding = selected.kind === "create"
                ? await createAndBindTab(pi, window.id, config)
                : await bindToTab(pi, window.id, selected.tab.id, config);
            } else if (/^new$/i.test(requested)) {
              binding = await createAndBindTab(pi, window.id, config);
            } else {
              binding = await bindToTab(pi, window.id, requested, config);
            }

            binding = adoptAutoSelectionStateForBinding(ctx, binding);
            const tabLabel = await resolveBindingTabLabel(binding);
            ctx.ui.notify(
              `Bound to window ${binding.windowId}` +
              (binding.workspace ? ` (${binding.workspace})` : "") +
              (tabLabel ? `, tab "${tabLabel}"` : ""),
              "info"
            );
          } catch (err) {
            ctx.ui.notify(`Failed to switch tab: ${err instanceof Error ? err.message : err}`, "error");
          }
          break;
        }

        case "oracle": {
          const rawArgs = args.trim();
          const rest = rawArgs.replace(/^oracle\b/i, "").trim();

          if (!rest) {
            ctx.ui.notify(
              "Usage: /rp oracle [--mode <chat|plan|edit|review>] [--name <chat name>] [--continue|--chat-id <id>] <message>",
              "error"
            );
            return;
          }

          const argv = splitCommandLine(rest);

          let mode: string | undefined;
          let chatName: string | undefined;
          let newChat = true;
          let chatId: string | undefined;

          const messageParts: string[] = [];

          for (let i = 0; i < argv.length; i++) {
            const token = argv[i];

            if (token === "--mode" && i + 1 < argv.length) {
              mode = argv[i + 1];
              i++;
              continue;
            }

            if (token === "--name" && i + 1 < argv.length) {
              chatName = argv[i + 1];
              i++;
              continue;
            }

            if (token === "--continue") {
              newChat = false;
              continue;
            }

            if (token === "--chat-id" && i + 1 < argv.length) {
              chatId = argv[i + 1];
              newChat = false;
              i++;
              continue;
            }

            messageParts.push(token);
          }

          const message = messageParts.join(" ").trim();
          if (!message) {
            ctx.ui.notify("No message provided", "error");
            return;
          }

          const resolvedMode = mode ?? config.oracleDefaultMode ?? "chat";
          const allowedModes = new Set(["chat", "plan", "edit", "review"]);
          if (!allowedModes.has(resolvedMode)) {
            ctx.ui.notify(
              `Invalid oracle mode "${resolvedMode}". Use chat|plan|edit|review (or set oracleDefaultMode accordingly).`,
              "error"
            );
            return;
          }

          const client = getRpClient();

          try {
            await ensureTabScopedBinding(ctx, "RepoPrompt binding has no tab. Use /rp bind or /rp tab new first.");

            const oracleSendToolName = resolveToolName(client.tools, "oracle_send");
            if (!oracleSendToolName) {
              ctx.ui.notify("RepoPrompt tool 'oracle_send' not available", "error");
              return;
            }

            const callArgs: Record<string, unknown> = {
              new_chat: newChat,
              message,
              mode: resolvedMode,
              ...getBindingArgs(),
            };

            if (chatName) callArgs.chat_name = chatName;
            if (chatId) callArgs.chat_id = chatId;

            const result = await client.callTool(oracleSendToolName, callArgs);

            const text = extractTextContent(result.content);

            if (result.isError) {
              ctx.ui.notify(text || "Oracle chat failed", "error");
              return;
            }

            ctx.ui.notify(text || "(empty reply)", "info");
          } catch (err) {
            ctx.ui.notify(`Oracle chat failed: ${err instanceof Error ? err.message : err}`, "error");
          }

          break;
        }

        case "reconnect": {
          const wasPaused = extensionPaused;
          try {
            config = loadRuntimeConfig();
            await resetRpClient();
            connectedApp = null;
            clearBinding();
            clearRootsCache();
            extensionPaused = false;
            await initializeExtension(pi, ctx, config, markConnectedApp);
            await syncAutoSelectionToCurrentBranch(ctx, reconnectAutoSelectionSyncOptions());
            ctx.ui.notify(`${activeAppDisplay()} reconnected`, "info");

            if (wasPaused) {
              pi.sendMessage(
                {
                  customType: "rp-availability",
                  content: `${activeAppDisplay()} (\`rp\` tool) is now available.`,
                  display: false,
                },
                { triggerTurn: false },
              );
            }
          } catch (err) {
            extensionPaused = true;
            ctx.ui.notify(`Reconnection failed: ${err instanceof Error ? err.message : err}`, "error");
          }
          break;
        }

        default:
          ctx.ui.notify(
            "RepoPrompt commands:\n" +
            "  /rp status                               - Show connection and binding status\n" +
            "  /rp app [ce|classic]                     - Show or switch the active RepoPrompt app\n" +
            "  /rp windows                              - List available windows\n" +
            "  /rp bind                                 - Open the interactive picker and bind\n" +
            "  /rp bind <id> [tab]                      - Direct/advanced bind when you already know the ids\n" +
            "  /rp oracle [opts] <message>              - Start/continue a RepoPrompt chat with current selection\n" +
            "  /rp reconnect                            - Reconnect to RepoPrompt\n" +
            "  /rp readcache-status                     - Show read_file cache status\n" +
            "  /rp readcache-refresh <path> [start-end] - Invalidate cached trust for next read_file",
            "info"
          );
      }
    },
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Main Tool Registration
  // ───────────────────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "rp",
    label: "RepoPrompt",
    description: `RepoPrompt integration - file selection, code structure, edits, and more.

Usage:
  rp({ })                              → Status (bound window, connection)
  rp({ windows: true })                → List all RepoPrompt windows
  rp({ bind: { window: 1 } })          → Bind to a specific window
  rp({ search: "query" })              → Search for tools
  rp({ describe: "tool_name" })        → Show tool parameters
  rp({ call: "tool_name", args: {...}})→ Call a tool

Common tools: read_file, get_file_tree, get_code_structure, file_search,
apply_edits, manage_selection, workspace_context

Mode priority: call > describe > search > windows > bind > status`,

    parameters: RpToolSchema,

    async execute(_toolCallId, params: RpToolParams, _signal, onUpdate, _ctx) {
      if (extensionPaused) {
        throw new Error(
          `The rp tool is not currently available because ${activeAppDisplay()} is disconnected. ` +
          "The user can run /rp app or /rp reconnect when the selected app is running."
        );
      }

      // Provide a no-op if onUpdate is undefined
      const safeOnUpdate = onUpdate ?? (() => {});

      // Only modes that need MCP require a connection
      if (params.call || params.describe || params.search || params.windows || params.bind) {
        await ensureConnected(_ctx as ExtensionContext | undefined);
      }

      // Mode resolution: call > describe > search > windows > bind > status
      if (params.call) {
        return executeToolCall(params, safeOnUpdate, _ctx as ExtensionContext | undefined);
      }
      if (params.describe) {
        return executeDescribe(params.describe);
      }
      if (params.search) {
        return executeSearch(params.search);
      }
      if (params.windows) {
        return executeListWindows();
      }
      if (params.bind) {
        return executeBinding(pi, params.bind.window, params.bind.tab, _ctx as ExtensionContext | undefined);
      }
      return executeStatus(_ctx as ExtensionContext | undefined);
    },

    renderCall(args: Record<string, unknown>, theme: Theme) {
      let text = theme.fg("toolTitle", theme.bold("rp"));
      const summarizedCall = summarizeRpCall(args);

      if (summarizedCall) {
        text += " " + theme.fg("muted", summarizedCall);
        return new Text(text, 0, 0);
      }

      if (args.call) {
        text += " " + theme.fg("accent", String(args.call));
        if (args.args && typeof args.args === "object") {
          const keys = Object.keys(args.args as object);
          if (keys.length > 0) {
            text += theme.fg("muted", ` (${keys.join(", ")})`);
          }
        }
      } else if (args.search) {
        text += " " + theme.fg("muted", `search: "${args.search}"`);
      } else if (args.describe) {
        text += " " + theme.fg("muted", `describe: ${args.describe}`);
      } else if (args.windows) {
        text += " " + theme.fg("muted", "windows");
      } else if (args.bind) {
        const bind = args.bind as { window: number; tab?: string };
        text += " " + theme.fg("muted", `bind: window ${bind.window}`);
      } else {
        text += " " + theme.fg("muted", "status");
      }

      // Show binding info
      const binding = getBinding();
      if (binding) {
        text += theme.fg("dim", ` → W${binding.windowId}`);
        if (binding.workspace) {
          text += theme.fg("dim", ` (${binding.workspace})`);
        }
      }

      return new Text(text, 0, 0);
    },

    renderResult(
      result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
      options: ToolRenderResultOptions,
      theme: Theme
    ) {
      const details = (result.details ?? {}) as Record<string, unknown>;

      const textContent = result.content
        .filter((c) => c.type === "text")
        .map((c) => c.text || "")
        .join("\n");

      if (options.isPartial) {
        return new Text(theme.fg("warning", "Running…"), 0, 0);
      }

      const isError = result.isError || details.isError;
      if (isError) {
        return new Text(theme.fg("error", "↳ " + textContent), 0, 0);
      }

      const successPrefix = theme.fg("success", "↳ ");
      const collapsedMaxLines = config.collapsedMaxLines ?? 15;
      const normalizedToolName = typeof details.tool === "string" ? normalizeToolName(details.tool) : undefined;
      const detailsDiff = typeof details.diff === "string" ? details.diff : undefined;
      const fileActionAction = normalizedToolName === "file_actions" && typeof details.args === "object" && details.args !== null
        ? (details.args as Record<string, unknown>).action
        : undefined;
      const shouldBypassCollapsedTruncation = typeof detailsDiff === "string" && (
        normalizedToolName === "apply_edits"
        || (normalizedToolName === "file_actions" && (fileActionAction === "create" || fileActionAction === "delete"))
      );
      const useAdaptiveDiffRendering =
        (normalizedToolName === "git" || normalizedToolName === "apply_edits" || normalizedToolName === "file_actions") &&
        ((typeof detailsDiff === "string" && detailsDiff.trim().length > 0) || containsFencedDiffBlock(textContent));

      if (useAdaptiveDiffRendering) {
        return createAdaptiveDiffAwareOutputComponent(textContent, theme, {
          toolName: normalizedToolName,
          expanded: options.expanded === true,
          collapsedMaxLines,
          successPrefix,
          diffText: detailsDiff,
          diffFilePath: typeof details.filePath === "string" ? details.filePath : undefined,
          disableCollapsedTruncation: shouldBypassCollapsedTruncation,
          diffConfig: {
            diffViewMode: config.diffViewMode ?? "auto",
            diffSplitMinWidth: config.diffSplitMinWidth ?? 120,
            addRowBgMixRatio: fileActionAction === "create" && typeof details.addRowBgMixRatio === "number"
              ? details.addRowBgMixRatio
              : undefined,
            removeRowBgMixRatio: fileActionAction === "delete" && typeof details.removeRowBgMixRatio === "number"
              ? details.removeRowBgMixRatio
              : undefined,
          },
        });
      }

      const summarizedResult = summarizeRpResult(details);
      if (!options.expanded && summarizedResult) {
        return new Text(`${successPrefix}${summarizedResult.primary}`, 0, 0);
      }

      const prefixFirstLine = (value: string, prefix: string): string => {
        if (!value) {
          return prefix.trimEnd();
        }
        const idx = value.indexOf("\n");
        if (idx < 0) {
          return `${prefix}${value}`;
        }
        return `${prefix}${value.slice(0, idx)}${value.slice(idx)}`;
      };

      if (!options.expanded) {
        const { content, truncated, totalLines } = prepareCollapsedView(
          textContent,
          theme,
          collapsedMaxLines
        );

        if (collapsedMaxLines === 0) {
          const remaining = totalLines;
          const hidden = theme.fg("muted", "(output hidden)");
          const moreText = remaining > 0 ? theme.fg("muted", `\n… (${remaining} more lines)`) : "";
          return new Text(`${successPrefix}${hidden}${moreText}`, 0, 0);
        }

        if (truncated) {
          const remaining = totalLines - collapsedMaxLines;
          const moreText = theme.fg("muted", `\n… (${remaining} more lines)`);
          return new Text(`${prefixFirstLine(content, successPrefix)}${moreText}`, 0, 0);
        }

        return new Text(prefixFirstLine(content, successPrefix), 0, 0);
      }

      const highlighted = renderRpOutput(textContent, theme);
      return new Text(`${successPrefix}\n${highlighted}`, 0, 0);
    },
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Helper Functions
  // ───────────────────────────────────────────────────────────────────────────

  async function ensureConnected(
    ctx?: ExtensionContext,
    options: { syncAutoSelection?: boolean } = {}
  ): Promise<void> {
    if (initPromise) {
      await initPromise;
    }

    // Reload config so connection/runtime knobs apply without requiring /reload
    config = loadRuntimeConfig();

    const client = getRpClient();
    if (config.toolCallTimeoutMs !== undefined) {
      client.setToolCallTimeoutMs(config.toolCallTimeoutMs);
    }
    if (client.isConnected && connectedApp === activeApp) {
      return;
    }

    if (client.isConnected && connectedApp !== activeApp) {
      await resetRpClient();
      connectedApp = null;
    }

    // Lazy reconnect: allow the user to install/configure RepoPrompt after Pi starts
    // and have `rp(...)` work without requiring a restart.
    const server = getServerCommand(config, activeApp);
    if (!server) {
      throw new Error(
        `${activeAppDisplay()} MCP server not found. Install ${getAppCliCommand(activeApp)} ` +
          "or configure ~/.pi/agent/extensions/repoprompt-mcp.json"
      );
    }

    const targetConfig = getAppTargetConfig(config, activeApp);
    await client.connect(server.command, server.args, targetConfig.env, config.toolCallTimeoutMs);
    connectedApp = activeApp;

    if (ctx && options.syncAutoSelection !== false) {
      try {
        await syncAutoSelectionToCurrentBranch(ctx, reconnectAutoSelectionSyncOptions());
      } catch {
        // Fail-open
      }
    }
  }

  function parseNumber(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === "string") {
      const normalized = value.replace(/,/g, "").trim();
      const parsed = parseInt(normalized, 10);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }

    return undefined;
  }

  function splitCommandLine(input: string): string[] {
    const args: string[] = [];
    let current = "";
    let quote: "\"" | "'" | null = null;

    const pushCurrent = () => {
      const trimmed = current;
      if (trimmed.length > 0) {
        args.push(trimmed);
      }
      current = "";
    };

    for (let i = 0; i < input.length; i++) {
      const ch = input[i] ?? "";

      if (quote) {
        if (ch === quote) {
          quote = null;
          continue;
        }

        // Allow simple escapes inside double quotes
        if (quote === "\"" && ch === "\\" && i + 1 < input.length) {
          current += input[i + 1] ?? "";
          i++;
          continue;
        }

        current += ch;
        continue;
      }

      if (ch === "\"" || ch === "'") {
        quote = ch as "\"" | "'";
        continue;
      }

      if (/\s/.test(ch)) {
        pushCurrent();
        continue;
      }

      if (ch === "\\" && i + 1 < input.length) {
        current += input[i + 1] ?? "";
        i++;
        continue;
      }

      current += ch;
    }

    pushCurrent();
    return args;
  }

  async function getSelectionSummary(): Promise<{ fileCount?: number; tokens?: number } | null> {
    const binding = getBinding();
    const client = getRpClient();

    if (!binding?.tab || !client.isConnected) {
      return null;
    }

    try {
      const workspaceContextToolName = resolveToolName(client.tools, "workspace_context");
      if (!workspaceContextToolName) {
        return null;
      }

      const result = await client.callTool(workspaceContextToolName, {
        include: ["selection", "tokens"],
        ...getBindingArgs(),
      });

      if (result.isError) {
        return null;
      }

      const json = extractJsonContent(result.content);
      const fromJson = parseSelectionSummaryFromJson(json);
      if (fromJson) {
        return fromJson;
      }

      const text = extractTextContent(result.content);
      return parseWorkspaceContextSelectionSummaryFromText(text);
    } catch {
      return null;
    }
  }

  async function getSelectionFilesText(
    binding: RpBinding | null,
    bindingArgsOverride?: Record<string, unknown>
  ): Promise<string | null> {
    const client = getRpClient();

    if (!binding?.tab || !client.isConnected) {
      return null;
    }

    try {
      const manageSelectionToolName = resolveToolName(client.tools, "manage_selection");
      if (!manageSelectionToolName) {
        return null;
      }

      const result = await client.callTool(manageSelectionToolName, {
        op: "get",
        view: "files",
        ...(bindingArgsOverride ?? getBindingArgs()),
      });

      if (result.isError) {
        return null;
      }

      return extractTextContent(result.content);
    } catch {
      return null;
    }
  }

  async function autoSelectReadFileInRepoPromptSelection(
    ctx: ExtensionContext | undefined,
    binding: RpBinding | null,
    inputPath: string,
    startLine: number | undefined,
    limit: number | undefined,
    bindingArgsOverride?: Record<string, unknown>
  ): Promise<void> {
    if (config.autoSelectReadSlices !== true) {
      return;
    }

    const client = getRpClient();
    if (!client.isConnected || !binding?.tab) {
      return;
    }

    const manageSelectionToolName = resolveToolName(client.tools, "manage_selection");
    if (!manageSelectionToolName) {
      return;
    }

    const cwd = ctx?.cwd ?? process.cwd();
    const resolved = await resolveReadFilePath(inputPath, cwd, binding);
    const baseState = getBaseAutoSelectionState(ctx, binding);
    const selectionPath = buildSelectionPathFromResolved(inputPath, resolved);

    const selectionText = await getSelectionFilesText(binding, bindingArgsOverride);
    if (selectionText === null) {
      return;
    }

    const candidatePaths = new Set<string>();
    candidatePaths.add(toPosixPath(selectionPath));
    candidatePaths.add(toPosixPath(inputPath));

    if (resolved.absolutePath) {
      candidatePaths.add(toPosixPath(resolved.absolutePath));
    }

    const derivedRepoRel = deriveRepoRelativePathFromInput(inputPath, binding, resolved);
    if (derivedRepoRel) {
      candidatePaths.add(toPosixPath(derivedRepoRel));
    }

    if (resolved.absolutePath && resolved.repoRoot) {
      const rel = path.relative(resolved.repoRoot, resolved.absolutePath);
      if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
        candidatePaths.add(toPosixPath(rel.split(path.sep).join("/")));
      }
    }

    let selectionStatus: ReturnType<typeof inferSelectionStatus> = null;

    for (const candidate of candidatePaths) {
      const status = inferSelectionStatus(selectionText, candidate);
      if (!status) {
        continue;
      }

      if (status.mode === "full") {
        selectionStatus = status;
        break;
      }

      if (status.mode === "codemap_only" && status.codemapManual === true) {
        selectionStatus = status;
        break;
      }

      if (selectionStatus === null) {
        selectionStatus = status;
        continue;
      }

      if (selectionStatus.mode === "codemap_only" && status.mode === "slices") {
        selectionStatus = status;
      }
    }

    if (selectionStatus?.mode === "full") {
      return;
    }

    if (selectionStatus?.mode === "codemap_only" && selectionStatus.codemapManual === true) {
      return;
    }

    let totalLines: number | undefined;

    if (typeof startLine === "number" && resolved.absolutePath) {
      try {
        totalLines = await countFileLines(resolved.absolutePath);
      } catch {
        totalLines = undefined;
      }
    }

    if (isWholeFileReadFromArgs(startLine, limit, totalLines)) {
      const nextState = normalizeAutoSelectionState(
        applyFullReadToSelectionState(baseState, selectionPath)
      );

      if (autoSelectionStatesEqual(baseState, nextState)) {
        commitLiveAutoSelectionState(nextState);
        return;
      }

      await reconcileAutoSelectionWithinBinding(client, manageSelectionToolName, baseState, nextState);
      persistAutoSelectionState(nextState);
      return;
    }

    const sliceRange = computeSliceRangeFromReadArgs(startLine, limit, totalLines);

    if (sliceRange) {
      const currentBindingArgs = bindingArgsOverride ?? getBindingArgs();
      const plan = planAutoSelectSliceUpdate({
        selectionText,
        inputPath,
        selectionPath,
        binding,
        resolved,
        baseState,
        sliceRange,
      });

      if (plan.uiAlreadyCoversNewSlice) {
        persistAutoSelectionState(plan.nextState);
        return;
      }

      if (!plan.desiredSlice) {
        commitLiveAutoSelectionState(plan.nextState);
        return;
      }

      const removeResult = await client.callTool(manageSelectionToolName, {
        op: "remove",
        paths: plan.removeVariants,
        strict: true,
        ...currentBindingArgs,
      });
      if (removeResult.isError) {
        throw new Error(extractTextContent(removeResult.content) || "RepoPrompt manage_selection remove failed");
      }

      const addResult = await client.callTool(manageSelectionToolName, {
        op: "add",
        slices: [plan.desiredSlice],
        strict: true,
        ...currentBindingArgs,
      });
      if (addResult.isError) {
        throw new Error(extractTextContent(addResult.content) || "RepoPrompt manage_selection add(slices) failed");
      }

      persistAutoSelectionState(plan.nextState);
      return;
    }

    const nextState = normalizeAutoSelectionState(
      applyFullReadToSelectionState(baseState, selectionPath)
    );

    if (autoSelectionStatesEqual(baseState, nextState)) {
      commitLiveAutoSelectionState(nextState);
      return;
    }

    await reconcileAutoSelectionWithinBinding(client, manageSelectionToolName, baseState, nextState);
    persistAutoSelectionState(nextState);
  }

  async function resolveBindingTabLabel(binding: RpBinding | null): Promise<string | null> {
    return await resolveLiveBindingTabLabel(binding);
  }

  function capturedAutoSelectionForAppSwitch(ctx: ExtensionContext): AutoSelectionEntryData | null {
    const binding = getBinding();
    const state = ownsLiveAutoSelection && activeAutoSelectionState
      ? activeAutoSelectionState
      : binding?.tab
        ? getAutoSelectionStateFromBranch(ctx, binding)
        : null;

    if (!state) {
      return null;
    }

    const normalized = normalizeAutoSelectionState(state);
    return autoSelectionManagedPaths(normalized).length > 0 ? normalized : null;
  }

  async function promptForAppSelection(ctx: ExtensionContext): Promise<RpAppId | null> {
    if (!ctx.hasUI) {
      return null;
    }

    const choices = RP_APP_IDS.map((app) => {
      const label = getAppLabel(config, app);
      return app === activeApp ? `${label} (${app}) — current` : `${label} (${app})`;
    });

    const choice = await ctx.ui.select("RepoPrompt app", choices);
    if (!choice) {
      return null;
    }

    return choice.includes("(classic)") ? "classic" : "ce";
  }

  async function switchActiveApp(nextApp: RpAppId, ctx: ExtensionContext): Promise<void> {
    if (nextApp === activeApp) {
      ctx.ui.notify(`RepoPrompt app: ${activeAppDisplay()}`, "info");
      return;
    }

    const sourceState = capturedAutoSelectionForAppSwitch(ctx);
    const recoveryPaths = sourceState ? autoSelectionManagedPaths(sourceState) : [];

    activeApp = nextApp;
    config = loadRuntimeConfig();
    persistActiveApp(nextApp);

    initPromise = null;
    clearBinding();
    clearReadcacheCaches();
    clearRootsCache();
    resetAutoSelectionRuntimeState();
    clearPendingTransitionSelectionState();
    await resetRpClient();
    connectedApp = null;

    const server = getServerCommand(config, activeApp);
    if (!server) {
      extensionPaused = true;
      ctx.ui.notify(
        `${activeAppDisplay()} MCP server not found. Configure ~/.pi/agent/extensions/repoprompt-mcp.json ` +
          `or install ${getAppCliCommand(activeApp)}.`,
        "error"
      );
      return;
    }

    const targetConfig = getAppTargetConfig(config, activeApp);
    const client = getRpClient();

    try {
      extensionPaused = false;
      await client.connect(server.command, server.args, targetConfig.env, config.toolCallTimeoutMs);
      connectedApp = activeApp;
    } catch (err) {
      extensionPaused = true;
      ctx.ui.notify(
        `Failed to connect to ${activeAppDisplay()}: ${err instanceof Error ? err.message : err}`,
        "error"
      );
      return;
    }

    if (recoveryPaths.length === 0) {
      ctx.ui.notify(`${activeAppDisplay()} selected. Not bound; use /rp bind to choose a window.`, "info");
      return;
    }

    let windows: RpWindow[];
    try {
      windows = await fetchWindows(pi, config);
    } catch (err) {
      ctx.ui.notify(
        `${activeAppDisplay()} selected, but window recovery failed: ${err instanceof Error ? err.message : err}. ` +
          "Use /rp bind.",
        "warning"
      );
      return;
    }

    const recovery = await findRecoveryWindowBySelectionPaths(windows, recoveryPaths, ctx.cwd);
    if (!recovery.window) {
      const reason = recovery.ambiguous
        ? "multiple windows contain this session's required roots"
        : "no open window contains this session's required roots";
      ctx.ui.notify(`${activeAppDisplay()} selected, but ${reason}. Use /rp bind.`, "warning");
      return;
    }

    try {
      const initialBinding = await bindToWindow(pi, recovery.window.id, undefined, config);
      const recoveredBinding = await ensureBindingHasTab(pi, ctx, config, undefined, {
        reuseSoleEmptyTab: true,
      }) ?? initialBinding;

      if (sourceState && recoveredBinding.tab) {
        const targetState = normalizeAutoSelectionState({
          ...sourceState,
          app: activeApp,
          windowId: recoveredBinding.windowId,
          tab: recoveredBinding.tab,
          workspace: recoveredBinding.workspace,
        });

        await reconcileAutoSelectionStates(null, targetState);
        persistAutoSelectionState(targetState);
      }

      const tabLabel = await resolveBindingTabLabel(recoveredBinding);
      ctx.ui.notify(
        `${activeAppDisplay()} selected and bound to window ${recoveredBinding.windowId}` +
          (recoveredBinding.workspace ? ` (${recoveredBinding.workspace})` : "") +
          (tabLabel ? `, tab "${tabLabel}"` : ""),
        "info"
      );
    } catch (err) {
      clearBinding();
      ctx.ui.notify(
        `${activeAppDisplay()} selected, but handover failed: ${err instanceof Error ? err.message : err}. ` +
          "Use /rp bind.",
        "warning"
      );
    }
  }

  async function handleAppCommand(argsParts: string[], ctx: ExtensionContext): Promise<void> {
    const requested = argsParts[0]?.toLowerCase();

    if (!requested) {
      const selected = await promptForAppSelection(ctx);
      if (!selected) {
        ctx.ui.notify(`RepoPrompt app: ${activeAppDisplay()}`, "info");
        return;
      }
      await switchActiveApp(selected, ctx);
      return;
    }

    if (!isRpAppId(requested)) {
      ctx.ui.notify("Usage: /rp app [ce|classic]", "error");
      return;
    }

    await switchActiveApp(requested, ctx);
  }

  async function showStatus(ctx: ExtensionContext): Promise<void> {
    const client = getRpClient();
    const binding = client.isConnected ? await syncAutoSelectionToCurrentBranch(ctx) : getBinding();
    const tabLabel = await resolveBindingTabLabel(binding);

    let msg = `RepoPrompt Status\n`;
    msg += `─────────────────\n`;
    msg += `App: ${activeAppDisplay()}\n`;
    if (extensionPaused) {
      msg += `Extension: ⏸ paused (use /rp app or /rp reconnect to resume)\n`;
    }
    msg += `Connection: ${client.isConnected ? "✓ connected" : "✗ disconnected"}\n`;
    msg += `Tools: ${client.tools.length}\n`;

    if (binding) {
      msg += `\nBound to:\n`;
      msg += `  Window: ${binding.windowId}\n`;
      if (binding.workspace) msg += `  Workspace: ${binding.workspace}\n`;
      if (tabLabel) msg += `  Tab: ${tabLabel}\n`;
      if (binding.autoDetected) msg += `  (auto-detected from cwd)\n`;

      const selectionSummary = await getSelectionSummary();
      if (selectionSummary) {
        msg += `\nSelection:\n`;
        if (typeof selectionSummary.fileCount === "number") {
          msg += `  Files: ${selectionSummary.fileCount}\n`;
        }
        if (typeof selectionSummary.tokens === "number") {
          msg += `  Tokens: ~${selectionSummary.tokens}\n`;
        }
      }
    } else {
      msg += `\nNot bound to any window. Use /rp bind to open the interactive picker, or rp({ windows: true }) for the raw window list\n`;
    }

    ctx.ui.notify(msg, "info");
  }

  async function showReadcacheStatus(ctx: ExtensionContext): Promise<void> {
    let msg = "RepoPrompt read_file cache\n";
    msg += "──────────────────────\n";
    msg += `Enabled: ${config.readcacheReadFile === true ? "✓" : "✗"}\n`;

    if (config.readcacheReadFile !== true) {
      msg += "\nEnable by setting readcacheReadFile=true in:\n";
      msg += "  ~/.pi/agent/extensions/repoprompt-mcp.json\n";
      ctx.ui.notify(msg, "info");
      return;
    }

    try {
      const stats = await getStoreStats(ctx.cwd);
      msg += `\nObject store (under ${ctx.cwd}/.pi/readcache):\n`;
      msg += `  Objects: ${stats.objects}\n`;
      msg += `  Bytes: ${stats.bytes}\n`;
    } catch {
      msg += "\nObject store: (unavailable)\n";
    }

    msg += "\nUsage:\n";
    msg += "  rp({ call: \"read_file\", args: { path: \"...\" } })\n";
    msg += "  rp({ call: \"read_file\", args: { path: \"...\", bypass_cache: true } })\n";
    msg += "  /rp readcache-refresh <path> [start-end]\n";

    ctx.ui.notify(msg, "info");
  }

  async function handleReadcacheRefresh(argsParts: string[], ctx: ExtensionContext): Promise<void> {
    if (argsParts.length === 0 || !argsParts[0]) {
      ctx.ui.notify("Usage: /rp readcache-refresh <path> [start-end]", "error");
      return;
    }

    const pathInput = argsParts[0];
    const rangeInput = argsParts[1];

    let scopeKey: ScopeKey = SCOPE_FULL;

    if (rangeInput) {
      const match = rangeInput.match(/^(\d+)-(\d+)$/);
      if (!match) {
        ctx.ui.notify("Invalid range. Use <start-end> like 1-120", "error");
        return;
      }

      const start = parseInt(match[1], 10);
      const end = parseInt(match[2], 10);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end < start) {
        ctx.ui.notify("Invalid range. Use <start-end> like 1-120", "error");
        return;
      }

      scopeKey = scopeRange(start, end);
    }

    const binding = getBinding();
    const resolved = await resolveReadFilePath(pathInput, ctx.cwd, binding);

    if (!resolved.absolutePath) {
      ctx.ui.notify(`Could not resolve path: ${pathInput}`, "error");
      return;
    }

    pi.appendEntry(RP_READCACHE_CUSTOM_TYPE, buildInvalidationV1(resolved.absolutePath, scopeKey));

    ctx.ui.notify(
      `Invalidated readcache for ${resolved.absolutePath}` + (scopeKey === SCOPE_FULL ? "" : ` (${scopeKey})`),
      "info"
    );
  }

  async function showWindows(ctx: ExtensionContext): Promise<void> {
    const windows = await fetchWindows(pi, config);

    if (windows.length === 0) {
      ctx.ui.notify("No RepoPrompt windows found", "warning");
      return;
    }

    let msg = `RepoPrompt Windows — ${activeAppDisplay()}\n`;
    msg += `──────────────────\n`;

    const binding = getBinding();
    for (const w of windows) {
      const isBound = binding?.windowId === w.id;
      const marker = isBound ? " ← bound" : "";
      msg += `  ${w.id}: ${w.workspace}${marker}\n`;
    }

    msg += `\nUse /rp bind to open the interactive picker`;

    ctx.ui.notify(msg, "info");
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Tool Execution Modes
  // ───────────────────────────────────────────────────────────────────────────

  async function executeStatus(ctx?: ExtensionContext) {
    const client = getRpClient();
    const binding = ctx && client.isConnected ? await syncAutoSelectionToCurrentBranch(ctx) : getBinding();
    const tabLabel = await resolveBindingTabLabel(binding);

    const server = getServerCommand(config, activeApp);

    let text = `RepoPrompt: ${client.status}\n`;
    text += `App: ${activeAppDisplay()}\n`;
    if (client.error) {
      text += `Error: ${client.error}\n`;
    }
    text += `Tools: ${client.tools.length}\n`;
    if (!server) {
      text += `Server: (not configured / not auto-detected)\n`;
      text += `Hint: configure ~/.pi/agent/extensions/repoprompt-mcp.json for ${activeAppDisplay()}\n`;
    }

    if (binding) {
      text += `\nBound to window ${binding.windowId}`;
      if (binding.workspace) text += ` (${binding.workspace})`;
      if (tabLabel) text += `, tab ${JSON.stringify(tabLabel)}`;
      if (binding.autoDetected) text += " [auto-detected]";
    } else {
      text += `\nNot bound. Human users should prefer /rp bind for the interactive picker; rp({ windows: true }) and rp({ bind: { window: <id> } }) remain available for direct/tool-driven routing`;
    }

    return {
      content: [{ type: "text" as const, text }],
      details: {
        mode: "status",
        app: activeApp,
        appLabel: activeAppLabel(),
        status: client.status,
        error: client.error,
        binding,
        tabLabel,
        toolsCount: client.tools.length,
      },
    };
  }

  async function executeListWindows() {
    const windows = await fetchWindows(pi, config);

    if (windows.length === 0) {
      return {
        content: [{ type: "text" as const, text: `No ${activeAppDisplay()} windows found. Is it running?` }],
        details: { mode: "windows", app: activeApp, appLabel: activeAppLabel(), windows: [] },
      };
    }

    let text = `## RepoPrompt Windows — ${activeAppDisplay()}\n\n`;

    const binding = getBinding();
    for (const w of windows) {
      const isBound = binding?.windowId === w.id;
      const marker = isBound ? " ✓" : "";
      text += `- Window \`${w.id}\` • ${w.workspace}${marker}\n`;
    }

    text += `\nUse /rp bind for the interactive picker, or rp({ bind: { window: <id> } }) for direct/tool-driven binding`;

    return {
      content: [{ type: "text" as const, text }],
      details: { mode: "windows", app: activeApp, appLabel: activeAppLabel(), windows, count: windows.length },
    };
  }

  async function executeBinding(
    extensionApi: ExtensionAPI,
    windowId: number,
    tab?: string,
    ctx?: ExtensionContext
  ) {
    let binding = tab
      ? await bindToTab(extensionApi, windowId, tab, config)
      : await bindToWindow(extensionApi, windowId, undefined, config);

    if (ctx) {
      binding = (await syncAutoSelectionToCurrentBranch(ctx)) ?? binding;
    }

    const tabLabel = await resolveBindingTabLabel(binding);

    let text = `## Bound ✅\n`;
    text += `- **Window**: ${binding.windowId}\n`;
    if (binding.workspace) text += `- **Workspace**: ${binding.workspace}\n`;
    if (tabLabel) text += `- **Tab**: ${tabLabel}\n`;

    return {
      content: [{ type: "text" as const, text }],
      details: { mode: "bind", app: activeApp, appLabel: activeAppLabel(), binding, tabLabel },
    };
  }

  async function executeSearch(query: string) {
    const client = getRpClient();
    const tools = client.tools;

    // Split query into terms and match any
    const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 0);

    const matches = tools.filter((tool) => {
      const searchText = `${tool.name} ${tool.description}`.toLowerCase();
      return terms.some((term) => searchText.includes(term));
    });

    if (matches.length === 0) {
      return {
        content: [{ type: "text" as const, text: `No tools matching "${query}"` }],
        details: { mode: "search", query, matches: [], count: 0 },
      };
    }

    let text = `## Found ${matches.length} tool(s) matching "${query}"\n\n`;

    for (const tool of matches) {
      text += `**${tool.name}**\n`;
      text += `  ${tool.description || "(no description)"}\n`;
      if (tool.inputSchema) {
        text += `  Parameters: ${formatSchemaCompact(tool.inputSchema)}\n`;
      }
      text += `\n`;
    }

    return {
      content: [{ type: "text" as const, text: text.trim() }],
      details: { mode: "search", query, matches: matches.map((m) => m.name), count: matches.length },
    };
  }

  async function executeDescribe(toolName: string) {
    const client = getRpClient();
    const normalized = normalizeToolName(toolName);

    const tool = client.tools.find(
      (t) => t.name === toolName || t.name === normalized || normalizeToolName(t.name) === normalized
    );

    if (!tool) {
      return {
        content: [{ type: "text" as const, text: `Tool "${toolName}" not found. Use rp({ search: "..." }) to search.` }],
        details: { mode: "describe", error: "not_found", requestedTool: toolName },
      };
    }

    let text = `## ${tool.name}\n\n`;
    text += `${tool.description || "(no description)"}\n\n`;

    if (tool.inputSchema) {
      text += `### Parameters\n\n`;
      text += formatSchema(tool.inputSchema);
    } else {
      text += `No parameters defined.\n`;
    }

    return {
      content: [{ type: "text" as const, text }],
      details: { mode: "describe", tool },
    };
  }

  async function executeToolCall(
    params: RpToolParams,
    onUpdate: (partialResult: { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }) => void,
    ctx?: ExtensionContext
  ) {
    const client = getRpClient();
    const toolName = normalizeToolName(params.call!);

    // Validate tool exists
    const tool = client.tools.find(
      (t) => t.name === toolName || normalizeToolName(t.name) === toolName
    );

    if (!tool) {
      return {
        content: [{ type: "text" as const, text: `Tool "${params.call}" not found. Use rp({ search: "..." }) to search.` }],
        details: { mode: "call", error: "not_found", requestedTool: params.call },
      };
    }

    // Check safety guards
    const guardResult = checkGuards(tool.name, params.args, config, {
      allowDelete: params.allowDelete,
      confirmEdits: params.confirmEdits,
    });

    if (!guardResult.allowed) {
      return {
        content: [{ type: "text" as const, text: guardResult.reason! }],
        details: { mode: "call", error: "blocked", tool: tool.name },
      };
    }

    const userArgs = (params.args ?? {}) as Record<string, unknown>;
    const normalizedTool = normalizeToolName(tool.name);

    if (
      getBinding() &&
      !getBinding()?.tab &&
      normalizedTool !== "manage_workspaces" &&
      normalizedTool !== "list_windows" &&
      normalizedTool !== "bind_context" &&
      normalizedTool !== "agent_run" &&
      normalizedTool !== "agent_manage"
    ) {
      if (!ctx) {
        return {
          content: [{ type: "text" as const, text: "RepoPrompt binding has no tab. Re-bind with /rp bind before calling tab-scoped tools." }],
          details: { mode: "call", error: "missing_tab_binding", tool: tool.name },
          isError: true,
        };
      }

      try {
        await ensureTabScopedBinding(ctx, "RepoPrompt binding has no tab. Re-bind with /rp bind before calling tab-scoped tools.");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: message }],
          details: { mode: "call", error: "missing_tab_binding", tool: tool.name, message },
          isError: true,
        };
      }
    }

    // Merge binding args with user args (strip wrapper-only args before forwarding)
    const bindingArgs = getBindingArgs();

    const bypassCache = normalizedTool === "read_file" && userArgs.bypass_cache === true;

    const forwardedUserArgs = buildForwardedUserArgs({
      toolName: normalizedTool,
      userArgs,
    });

    const mergedArgs = { ...forwardedUserArgs, ...bindingArgs };

    const fileActionDeleteSnapshot = normalizedTool === "file_actions"
      && userArgs.action === "delete"
      && typeof userArgs.path === "string"
      ? (() => {
        try {
          return fs.readFileSync(userArgs.path, "utf8");
        } catch {
          return undefined;
        }
      })()
      : undefined;

    onUpdate({
      content: [{ type: "text", text: `Calling ${tool.name}…` }],
      details: { mode: "call", tool: tool.name, status: "running" },
    });

    let rpReadcache: RpReadcacheMetaV1 | null = null;

    try {
      let result = await client.callTool(tool.name, mergedArgs);

      const pathArg = typeof userArgs.path === "string" ? (userArgs.path as string) : null;
      const startLine = parseNumber(userArgs.start_line);
      const limit = parseNumber(userArgs.limit);

      const shouldReadcache =
        config.readcacheReadFile === true &&
        normalizedTool === "read_file" &&
        typeof userArgs.path === "string" &&
        ctx !== undefined;

      if (shouldReadcache && !result.isError) {
        const cached = await readFileWithCache(
          result,
          {
            path: pathArg as string,
            ...(startLine !== undefined ? { start_line: startLine } : {}),
            ...(limit !== undefined ? { limit } : {}),
            ...(bypassCache ? { bypass_cache: true } : {}),
          },
          ctx,
          getBinding(),
          readcacheRuntimeState
        );

        result = cached.toolResult;
        rpReadcache = cached.meta;
      }

      const shouldAutoSelectRead =
        config.autoSelectReadSlices === true &&
        normalizedTool === "read_file" &&
        pathArg !== null &&
        ctx !== undefined;

      if (shouldAutoSelectRead && !result.isError) {
        const selectionBinding = getBinding();
        try {
          await runAutoSelectionUpdate(async () => {
            await autoSelectReadFileInRepoPromptSelection(
              ctx,
              selectionBinding,
              pathArg,
              startLine,
              limit,
              bindingArgs
            );
          });
        } catch {
          // Fail-open
        }
      }

      // Transform content to text
      const textContent = result.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      const normalizedTextResult = result.isError
        ? null
        : normalizeToolResultText({
          toolName: normalizedTool,
          text: textContent,
        });
      const normalizedFileActionResult = result.isError
        ? null
        : normalizeFileActionResult({
          action: userArgs.action,
          path: userArgs.path,
          content: userArgs.content,
          deletedContent: fileActionDeleteSnapshot,
        });

      // Check for noop edits
      const editNoop = isEditOperation(tool.name) && isNoopEdit(textContent);

      // Build response
      type RpResponseContent =
        | { type: "text"; text: string }
        | { type: "image"; data: string; mimeType: string };

      const content: RpResponseContent[] = result.content.map((c) => {
        if (c.type === "text") {
          return { type: "text", text: c.text };
        }
        if (c.type === "image") {
          return { type: "image", data: c.data, mimeType: c.mimeType };
        }
        return { type: "text", text: JSON.stringify(c) };
      });

      const nonPrimaryContent: RpResponseContent[] = [];
      for (const c of result.content) {
        if (c.type === "text") {
          continue;
        }
        if (c.type === "image") {
          nonPrimaryContent.push({ type: "image", data: c.data, mimeType: c.mimeType });
          continue;
        }
        nonPrimaryContent.push({ type: "text", text: JSON.stringify(c) });
      }

      let responseContent = normalizedTextResult
        ? [{ type: "text" as const, text: normalizedTextResult.contentText }, ...nonPrimaryContent]
        : normalizedFileActionResult?.contentText
          ? [{ type: "text" as const, text: normalizedFileActionResult.contentText }, ...nonPrimaryContent]
          : content.length > 0
            ? content
            : [{ type: "text" as const, text: "(empty result)" }];

      if (editNoop && !result.isError) {
        responseContent = [
          { type: "text" as const, text: "⚠ No changes applied (no-op edit)" },
          ...responseContent,
        ];
      }

      return {
        content: responseContent,
        details: {
          mode: "call",
          tool: tool.name,
          args: params.args,
          warning: guardResult.warning,
          editNoop,
          rpReadcache: rpReadcache ?? undefined,
          ...(normalizedTextResult ? normalizedTextResult.details : {}),
          ...(normalizedFileActionResult ?? {}),
        },
        isError: result.isError,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // Include schema in error for self-correction
      let errorText = `Failed to call ${tool.name}: ${message}`;
      if (tool.inputSchema) {
        errorText += `\n\nExpected parameters:\n${formatSchema(tool.inputSchema)}`;
      }

      return {
        content: [{ type: "text" as const, text: errorText }],
        details: { mode: "call", error: "call_failed", tool: tool.name, message },
        isError: true,
      };
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Initialization
// ─────────────────────────────────────────────────────────────────────────────

type TabSelectionChoice =
  | { kind: "create" }
  | { kind: "existing"; tab: RpTab };

function formatTabSelectionLabel(tab: RpTab): string {
  const annotations: string[] = [];
  if (tab.isBound === true) {
    annotations.push("currently bound");
  }
  if (tab.isActive === true) {
    annotations.push("in focus");
  }

  return annotations.length > 0 ? `${tab.name} — ${annotations.join(", ")}` : tab.name;
}

async function resolveWindowForTabCommand(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  config: RpConfig
): Promise<RpWindow | null> {
  const binding = getBinding();
  if (binding) {
    const windows = await fetchWindows(pi, config);
    return (
      windows.find((window) => window.id === binding.windowId) ?? {
        id: binding.windowId,
        workspace: binding.workspace ?? "",
        roots: [],
      }
    );
  }

  if (!ctx.hasUI) {
    throw new Error("Not bound to any RepoPrompt window. Use /rp bind <window_id> first");
  }

  const windows = await fetchWindows(pi, config);
  if (windows.length === 0) {
    return null;
  }

  return await promptForWindowSelection(ctx, windows);
}

async function promptForTabSelection(
  ctx: ExtensionContext,
  tabs: RpTab[]
): Promise<TabSelectionChoice | null> {
  if (!ctx.hasUI) {
    return null;
  }

  const choices: TabSelectionChoice[] = [
    { kind: "create" },
    ...tabs.map((tab): TabSelectionChoice => ({ kind: "existing", tab })),
  ];

  return await ctx.ui.custom<TabSelectionChoice | null>(
    (tui, theme, _kb, done) => {
      let selectedIndex = 0;

      return {
        render(width: number) {
          const w = Math.max(44, width);
          const lines: string[] = [];

          const header =
            theme.fg("accent", theme.bold("RepoPrompt")) +
            theme.fg("dim", " — select tab for current branch");

          lines.push(theme.fg("dim", "┌" + "─".repeat(w - 2) + "┐"));
          const headerPad = Math.max(0, w - 4 - visibleWidth(header));
          lines.push(theme.fg("dim", "│ ") + header + " ".repeat(headerPad) + theme.fg("dim", " │"));
          lines.push(theme.fg("dim", "├" + "─".repeat(w - 2) + "┤"));

          for (let i = 0; i < choices.length; i++) {
            const choice = choices[i];
            const pointer = i === selectedIndex ? theme.fg("success", "❯ ") : "  ";
            const label = choice.kind === "create"
              ? theme.fg("accent", "Create new tab")
              : formatTabSelectionLabel(choice.tab);
            const row = pointer + label;
            const rowPad = Math.max(0, w - 4 - visibleWidth(row));
            lines.push(theme.fg("dim", "│ ") + row + " ".repeat(rowPad) + theme.fg("dim", " │"));
          }

          lines.push(theme.fg("dim", "├" + "─".repeat(w - 2) + "┤"));

          const footer = theme.fg("dim", "↑↓/jk navigate • Enter select • Esc cancel");
          const footerPad = Math.max(0, w - 4 - visibleWidth(footer));
          lines.push(theme.fg("dim", "│ ") + footer + " ".repeat(footerPad) + theme.fg("dim", " │"));
          lines.push(theme.fg("dim", "└" + "─".repeat(w - 2) + "┘"));

          return lines;
        },
        handleInput(data: string) {
          if (matchesKey(data, "escape") || data === "q" || data === "Q") {
            done(null);
            return;
          }

          if (matchesKey(data, "return") || matchesKey(data, "enter")) {
            done(choices[selectedIndex] ?? null);
            return;
          }

          if (matchesKey(data, "up") || data === "k") {
            selectedIndex = Math.max(0, selectedIndex - 1);
            tui.requestRender();
            return;
          }

          if (matchesKey(data, "down") || data === "j") {
            selectedIndex = Math.min(choices.length - 1, selectedIndex + 1);
            tui.requestRender();
            return;
          }

          if (data.length === 1 && data >= "1" && data <= "9") {
            const idx = parseInt(data, 10) - 1;
            if (idx >= 0 && idx < choices.length) {
              done(choices[idx]);
            }
          }
        },
        invalidate() {},
      };
    },
    { overlay: true }
  );
}

async function promptForWindowSelection(
  ctx: ExtensionContext,
  candidates: RpWindow[]
): Promise<RpWindow | null> {
  if (!ctx.hasUI || candidates.length === 0) {
    return null;
  }

  return await ctx.ui.custom<RpWindow | null>(
    (tui, theme, _kb, done) => {
      let selectedIndex = 0;

      return {
        render(width: number) {
          const w = Math.max(40, width);
          const lines: string[] = [];

          const header =
            theme.fg("accent", theme.bold("RepoPrompt")) +
            theme.fg("dim", " — select window to bind");

          lines.push(theme.fg("dim", "┌" + "─".repeat(w - 2) + "┐"));
          const headerPad = Math.max(0, w - 4 - visibleWidth(header));
          lines.push(theme.fg("dim", "│ ") + header + " ".repeat(headerPad) + theme.fg("dim", " │"));
          lines.push(theme.fg("dim", "├" + "─".repeat(w - 2) + "┤"));

          for (let i = 0; i < candidates.length; i++) {
            const win = candidates[i];
            const pointer = i === selectedIndex ? theme.fg("success", "❯ ") : "  ";
            const label = `${win.id}: ${win.workspace || "(unnamed)"}`;
            const row = pointer + label;

            const rowPad = Math.max(0, w - 4 - visibleWidth(row));
            lines.push(theme.fg("dim", "│ ") + row + " ".repeat(rowPad) + theme.fg("dim", " │"));
          }

          lines.push(theme.fg("dim", "├" + "─".repeat(w - 2) + "┤"));

          const footer = theme.fg("dim", "↑↓/jk navigate • Enter select • Esc cancel");
          const footerPad = Math.max(0, w - 4 - visibleWidth(footer));
          lines.push(theme.fg("dim", "│ ") + footer + " ".repeat(footerPad) + theme.fg("dim", " │"));
          lines.push(theme.fg("dim", "└" + "─".repeat(w - 2) + "┘"));

          return lines;
        },
        handleInput(data: string) {
          if (matchesKey(data, "escape") || data === "q" || data === "Q") {
            done(null);
            return;
          }

          if (matchesKey(data, "return") || matchesKey(data, "enter")) {
            done(candidates[selectedIndex] ?? null);
            return;
          }

          if (matchesKey(data, "up") || data === "k") {
            selectedIndex = Math.max(0, selectedIndex - 1);
            tui.requestRender();
            return;
          }

          if (matchesKey(data, "down") || data === "j") {
            selectedIndex = Math.min(candidates.length - 1, selectedIndex + 1);
            tui.requestRender();
            return;
          }

          if (data.length === 1 && data >= "1" && data <= "9") {
            const idx = parseInt(data, 10) - 1;
            if (idx >= 0 && idx < candidates.length) {
              done(candidates[idx]);
            }
          }
        },
        invalidate() {},
      };
    },
    { overlay: true }
  );
}

/**
 * Try to launch the RepoPrompt app via `open`. Returns true if the app was launched
 * and appears to have started (the MCP server binary exists inside the bundle).
 */
async function tryLaunchApp(appPath: string): Promise<boolean> {
  if (process.platform !== "darwin") {
    return false;
  }
  try {
    await new Promise<void>((resolve, reject) => {
      execFile("open", ["-a", appPath], (err) => (err ? reject(err) : resolve()));
    });
    // Give the app time to start its MCP server
    await new Promise((resolve) => setTimeout(resolve, 4000));
    return true;
  } catch {
    return false;
  }
}

async function initializeExtension(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: RpConfig,
  onConnected?: (app: RpAppId) => void
): Promise<void> {
  // Try to restore binding from session
  restoreBinding(ctx, config);

  // Get server command
  const app = config.activeApp;
  const targetConfig = getAppTargetConfig(config, app);
  const server = getServerCommand(config, app);
  if (!server) {
    if (ctx.hasUI) {
      ctx.ui.notify(
        `${getAppLabel(config, app)} MCP server not found. Install ${getAppCliCommand(app)} ` +
          "or configure ~/.pi/agent/extensions/repoprompt-mcp.json",
        "warning"
      );
    }
    return;
  }

  // Connect to RepoPrompt
  const client = getRpClient();
  await client.connect(server.command, server.args, targetConfig.env, config.toolCallTimeoutMs);
  onConnected?.(app);

  // Notify connection
  if (ctx.hasUI) {
    ctx.ui.notify(`${getAppLabel(config, app)}: connected (${client.tools.length} tools)`, "info");
  }

  // Auto-detect and bind if enabled
  if (config.autoBindOnStart && !getBinding()) {
    try {
      const { binding, windows, ambiguity } = await autoDetectAndBind(pi, config);

      if (binding) {
        const reconciledBinding = await ensureBindingHasTab(pi, ctx, config, undefined, {
          reuseSoleEmptyTab: true,
        });

        if (ctx.hasUI) {
          const activeBinding = reconciledBinding ?? binding;
          const tabLabel = await resolveLiveBindingTabLabel(activeBinding);
          ctx.ui.notify(
            `${getAppLabel(config, app)}: auto-bound to window ${activeBinding.windowId}` +
            ` (${activeBinding.workspace ?? "unknown"})` +
            (tabLabel ? `, tab "${tabLabel}"` : ""),
            "info"
          );
        }
      } else if (ambiguity && ambiguity.candidates.length > 0 && ctx.hasUI) {
        const selected = await promptForWindowSelection(ctx, ambiguity.candidates);

        if (selected) {
          const chosenBinding = await bindToWindow(pi, selected.id, undefined, config);
          const reconciledBinding = await ensureBindingHasTab(pi, ctx, config, undefined, {
            reuseSoleEmptyTab: true,
          });
          const tabLabel = await resolveLiveBindingTabLabel(reconciledBinding ?? chosenBinding);
          ctx.ui.notify(
            `${getAppLabel(config, app)}: bound to window ${(reconciledBinding ?? chosenBinding).windowId}` +
            ` (${(reconciledBinding ?? chosenBinding).workspace ?? "unknown"})` +
            (tabLabel ? `, tab "${tabLabel}"` : ""),
            "info"
          );
        } else {
          const candidatesText = ambiguity.candidates
            .map((w) => `${w.id}: ${w.workspace}`)
            .join(", ");

          ctx.ui.notify(
            `${getAppLabel(config, app)}: multiple matching windows for cwd (${candidatesText}). ` +
              "Use /rp bind to choose from the interactive picker.",
            "warning"
          );
        }
      } else if (windows.length > 0 && ctx.hasUI) {
        ctx.ui.notify(
          `${getAppLabel(config, app)}: ${windows.length} window(s) available. ` +
            "Use /rp bind for the interactive picker or rp({ windows: true }) for the raw list",
          "info"
        );
      }
    } catch (err) {
      // Auto-detect failed, not critical
      console.error("RepoPrompt auto-detect failed:", err);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema Formatting
// ─────────────────────────────────────────────────────────────────────────────

function formatSchema(schema: unknown, indent = ""): string {
  if (!schema || typeof schema !== "object") {
    return `${indent}(no schema)`;
  }

  const s = schema as Record<string, unknown>;

  if (s.type === "object" && s.properties && typeof s.properties === "object") {
    const props = s.properties as Record<string, unknown>;
    const required = Array.isArray(s.required) ? (s.required as string[]) : [];

    if (Object.keys(props).length === 0) {
      return `${indent}(no parameters)`;
    }

    const lines: string[] = [];
    for (const [name, propSchema] of Object.entries(props)) {
      const isRequired = required.includes(name);
      lines.push(formatProperty(name, propSchema, isRequired, indent));
    }
    return lines.join("\n");
  }

  if (s.type) {
    return `${indent}(${s.type})`;
  }

  return `${indent}(complex schema)`;
}

function formatProperty(name: string, schema: unknown, required: boolean, indent: string): string {
  if (!schema || typeof schema !== "object") {
    return `${indent}${name}${required ? " *" : ""}`;
  }

  const s = schema as Record<string, unknown>;
  const parts: string[] = [];

  let typeStr = "";
  if (s.type) {
    typeStr = Array.isArray(s.type) ? s.type.join(" | ") : String(s.type);
  } else if (s.enum) {
    typeStr = "enum";
  }

  if (Array.isArray(s.enum)) {
    const enumVals = s.enum.map((v) => JSON.stringify(v)).join(", ");
    typeStr = `enum: ${enumVals}`;
  }

  parts.push(`${indent}${name}`);
  if (typeStr) parts.push(`(${typeStr})`);
  if (required) parts.push("*required*");

  if (s.description && typeof s.description === "string") {
    parts.push(`- ${s.description}`);
  }

  return parts.join(" ");
}

function formatSchemaCompact(schema: unknown): string {
  if (!schema || typeof schema !== "object") {
    return "(no schema)";
  }

  const s = schema as Record<string, unknown>;

  if (s.type === "object" && s.properties && typeof s.properties === "object") {
    const props = Object.keys(s.properties as object);
    const required = Array.isArray(s.required) ? (s.required as string[]) : [];

    return props
      .map((p) => (required.includes(p) ? `${p}*` : p))
      .join(", ");
  }

  return "(complex)";
}
