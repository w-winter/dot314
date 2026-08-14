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
import { Box, Container, Text, matchesKey, visibleWidth, type Component } from "@earendil-works/pi-tui";
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
  ToolCatalogFreshness,
} from "./types.js";
import {
  ACTIVE_APP_ENTRY_TYPE,
  AUTO_SELECTION_ENTRY_TYPE,
  BINDING_ENTRY_TYPE,
  DEFAULT_TOOL_CALL_TIMEOUT_MS,
  RP_APP_IDS,
} from "./types.js";
import { getAppCliCommand, getAppLabel, getAppTargetConfig, getServerCommand, inferAppPath, loadConfig } from "./config.js";
import { getRpClient, resetRpClient } from "./client.js";
import type { ToolCatalogRevisionToken } from "./client.js";
import {
  getBinding,
  getVerifiedBinding,
  getRouteSelectorDecision,
  getRouteState,
  getRouteStatusSnapshot,
  clearBinding,
  restoreBinding,
  adoptObservedStickyRoute,
  autoDetectAndBind,
  bindToWindow,
  bindToTab,
  createAndBindTab,
  ensureBindingHasTab,
  establishRoutingInventoryContract,
  fetchWindowTabs,
  fetchWindows,
  executeLeasedRouteDependentCall,
  executeRoutingMutation,
  findRecoveryWindowBySelectionPaths,
  issueLeasedRouteDispatch,
  quarantineRoute,
  reconcileObservedInventoryRoute,
  routeDispatchLeaseBinding,
  routeDispatchLeaseIsCurrent,
  observeRouteStatus,
  resetRoutingInventoryContractSession,
  runRouteChange,
  waitForRoutePublication,
  RoutingMutationBlockedError,
} from "./binding.js";
import type { RouteStatusObservation, RoutingMutationIssuanceGuard } from "./binding.js";
import { displayIdentityFor, routeStore, type RouteDispatchLease } from "./route-state.js";
import {
  createAdaptiveDiffAwareOutputComponent,
  containsFencedDiffBlock,
  renderRpOutput,
  prepareCollapsedView,
} from "./render.js";
import { checkGuards, normalizeToolName, isNoopEdit, isEditOperation } from "./guards.js";
import { normalizeToolResultText } from "./result-normalization.js";
import {
  buildForwardedCallArgs,
  buildForwardedUserArgs,
  classifyForwardingOperation,
  isRoutingMutationClass,
  operationForTool,
  type OperationClassification,
} from "./tool-forwarding-policy.js";
import { normalizeFileActionResult } from "./file-action-normalization.js";
import { summarizeRpCall, summarizeRpResult } from "./presentation-summary.js";
import { extractJsonContent, extractTextContent } from "./mcp-json.js";
import { resolveToolName } from "./tool-names.js";
import { targetContractForApp } from "./target-contract.js";
import type { TargetCapabilities } from "./target-contract.js";
import {
  ContextBuilderJobError,
  ContextBuilderJobManager,
} from "./context-builder-jobs.js";
import type { RepoPromptJobResetReason, RepoPromptJobTarget } from "./mcp-tool-jobs.js";
import {
  resolveAgentRunObservationTimeoutSeconds,
  resolveBackgroundWaitPolicy,
  type BackgroundWaitPolicyResolver,
} from "./background-wait-policy.js";
import {
  ORACLE_SEND_TOOL_NAME,
  ORACLE_SEND_WAIT_TOOL_NAME,
  OracleSendJobError,
  OracleSendJobManager,
} from "./oracle-send-jobs.js";
import {
  AGENT_RUN_WAIT_GUIDANCE,
  QUEUE_STEER_ACCEPTED_EVENT,
  ObserverInterruptControlError,
  SteeringWaitCoordinator,
  classifyAgentRunCall,
  runObserverInterruptibleCall,
  supportsObserverInterruptibleAgentWait,
} from "./steerable-waits.js";

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

function requireVerifiedRouteArgs(): Readonly<Record<string, unknown>> {
  const decision = getRouteSelectorDecision({});
  if (decision.kind !== "selectors") {
    throw new Error(decision.diagnostic);
  }
  return decision.args;
}

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

async function resolveLiveBindingTabLabel(
  binding: RpBinding | null,
  config: RpConfig
): Promise<string | null> {
  const client = getRpClient();
  if (!binding?.tab || !client.isConnected) {
    return null;
  }

  try {
    const tabs = await fetchWindowTabs(binding.windowId, client, config);
    const liveTab = tabs.find((tab) => tab.id === binding.tab || tab.name === binding.tab);
    if (!liveTab) {
      return null;
    }

    if (liveTab.isActive === true) {
      return `${liveTab.name} [bound, in-focus]`;
    }
    if (liveTab.isActive === false) {
      return `${liveTab.name} [bound, out-of-focus]`;
    }
    return `${liveTab.name} [bound]`;
  } catch {
    return null;
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

const CONTEXT_BUILDER_TOOL_NAME = "context_builder";
const CONTEXT_BUILDER_WAIT_TOOL_NAME = "context_builder_wait";
const CONTEXT_BUILDER_WAIT_TOOL: RpToolMeta = {
  name: CONTEXT_BUILDER_WAIT_TOOL_NAME,
  description: (
    "Wait for a Context Builder job started by rp({ call: \"context_builder\", ... }). " +
    "A wait may return running shortly before a known or configured prompt-cache deadline; otherwise it " +
    "remains pending until the job settles. If it returns running, repeat the same wait as your next action. " +
    "The terminal result can be consumed once; cancelling a wait or reaching a cache deadline does not cancel " +
    "the job. Accepted Pi steering can interrupt only the current observation; Pi delivers the message, the job " +
    "continues, and the same job_id remains usable. Reconnects, app switches, extension reloads, and session " +
    `shutdown invalidate the job ID. Oracle sends use the separate ${ORACLE_SEND_WAIT_TOOL_NAME} protocol.`
  ),
  inputSchema: {
    type: "object",
    properties: {
      job_id: {
        type: "string",
        minLength: 1,
        description: "Opaque job ID returned by context_builder",
      },
    },
    required: ["job_id"],
    additionalProperties: false,
  },
};
const ORACLE_SEND_WAIT_TOOL: RpToolMeta = {
  name: ORACLE_SEND_WAIT_TOOL_NAME,
  description: (
    "Wait for an Oracle send job started by rp({ call: \"oracle_send\", ... }). " +
    "A wait may return running shortly before a known or configured prompt-cache deadline; otherwise it " +
    "remains pending until the job settles. If it returns running, repeat the same wait as your next action. " +
    "The terminal result can be consumed once; cancelling a wait or reaching a cache deadline does not cancel " +
    "the job. Accepted Pi steering can interrupt only the current observation; Pi delivers the message, the job " +
    "continues, and the same job_id remains usable. Reconnects, app switches, extension reloads, and session " +
    `shutdown invalidate the job ID. Context Builder uses the separate ${CONTEXT_BUILDER_WAIT_TOOL_NAME} protocol.`
  ),
  inputSchema: {
    type: "object",
    properties: {
      job_id: {
        type: "string",
        minLength: 1,
        description: "Opaque job ID returned by oracle_send",
      },
    },
    required: ["job_id"],
    additionalProperties: false,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Self-Rendered Tool Shell
//
// `rp` owns its tool shell (renderShell: "self") so that a wrapper-owned wait which is
// still running occupies no rows at all. Pi renders no lines - and no separator - for a
// self-rendered tool whose components produce no lines, so hiding a row means leaving the
// shell box childless. Every visible row must therefore recreate the framing Pi supplies
// by default: one Box(1, 1, background) whose background tracks pending/error/success.
// ─────────────────────────────────────────────────────────────────────────────

type LocalWaitToolName = typeof CONTEXT_BUILDER_WAIT_TOOL_NAME | typeof ORACLE_SEND_WAIT_TOOL_NAME;

/** Renderer state for one tool execution. Owned by Pi via the render context. */
interface RpRenderState {
  shell?: Box;
}

/** Render context fields this extension reads. Pi passes a wider context. */
interface RpRenderCallContext {
  state: RpRenderState;
  argsComplete: boolean;
}

interface RpRenderResultContext {
  state: RpRenderState;
  args: Record<string, unknown>;
  isError: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function localWaitToolName(value: unknown): LocalWaitToolName | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = normalizeToolName(value);
  return normalized === CONTEXT_BUILDER_WAIT_TOOL_NAME || normalized === ORACLE_SEND_WAIT_TOOL_NAME
    ? normalized
    : null;
}

/**
 * A wait call row is hidden only when its arguments satisfy the same invariant the wait
 * executors enforce: exactly one non-empty job_id. Arguments stream in, so before they are
 * complete the job_id is not yet present; hide on the tool name alone during that window so
 * a valid wait never flashes a row that then disappears. Once arguments are complete, an
 * invalid wait stays visible so its validation error is diagnosable.
 */
function isHiddenWaitCall(args: Record<string, unknown>, argsComplete: boolean): boolean {
  if (!localWaitToolName(args.call)) {
    return false;
  }
  if (!argsComplete) {
    return true;
  }
  const callArgs = asRecord(args.args);
  if (!callArgs) {
    return false;
  }
  const keys = Object.keys(callArgs);
  if (keys.length !== 1 || keys[0] !== "job_id") {
    return false;
  }
  return typeof callArgs.job_id === "string" && callArgs.job_id.trim().length > 0;
}

/**
 * Hide only the two wrapper-owned running states: a wait's own partial update, and the
 * cache-aware heartbeat whose nested job belongs to the wait that produced it. Background
 * start results also carry a running job, and mismatched or malformed job metadata is not
 * evidence of a heartbeat, so both stay visible. Any error is always visible.
 */
function isHiddenWaitResult(
  args: Record<string, unknown>,
  details: Record<string, unknown>,
  isPartial: boolean,
  isError: boolean,
): boolean {
  if (isError) {
    return false;
  }
  const waitTool = localWaitToolName(details.tool);
  if (!waitTool || localWaitToolName(args.call) !== waitTool) {
    return false;
  }
  const callArgs = asRecord(args.args);
  const expectedJobId = callArgs?.job_id;
  if (typeof expectedJobId !== "string" || expectedJobId.trim().length === 0) {
    return false;
  }
  if (isPartial) {
    return details.status === "running" && details.jobId === expectedJobId;
  }
  const waitObservation = asRecord(details.waitObservation);
  if (waitObservation?.result === "interrupted_by_steering") {
    return false;
  }
  const jobField = waitTool === CONTEXT_BUILDER_WAIT_TOOL_NAME ? "contextBuilderJob" : "oracleSendJob";
  const job = asRecord(details[jobField]);
  return job?.status === "running" && job.jobId === expectedJobId;
}

function shellBackground(theme: Theme, isPartial: boolean, isError: boolean): (text: string) => string {
  const slot = isPartial ? "toolPendingBg" : isError ? "toolErrorBg" : "toolSuccessBg";
  return (text: string) => theme.bg(slot, text);
}

/**
 * Rebuild the row's shell from the current snapshot. Rebuilding rather than appending keeps
 * repeated partials, duplicate final renders, expansion toggles, and theme invalidation
 * idempotent, and guarantees hidden heartbeat content cannot survive into a later row.
 */
function rebuildRpShell(
  state: RpRenderState,
  background: (text: string) => string,
  children: Component[],
): Box {
  const shell = state.shell ?? new Box(1, 1, background);
  state.shell = shell;
  shell.setBgFn(background);
  shell.clear();
  for (const child of children) {
    shell.addChild(child);
  }
  return shell;
}

class BackgroundJobExecutionError extends Error {
  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = "BackgroundJobExecutionError";
  }
}

interface BackgroundStartProtocol {
  readonly toolName: typeof CONTEXT_BUILDER_TOOL_NAME | typeof ORACLE_SEND_TOOL_NAME;
  readonly bindingMessage: string;
  readonly missingTabCode: string;
  readonly startCancelledCode: string;
  readonly startCancelledMessage: string;
  readonly startAbortedCode: string;
  readonly startAbortedMessage: string;
  throwError(code: string, message: string): never;
}

/** Result of the serialized portion of an active-app switch, consumed by the handover phase */
interface AppSwitchHandover {
  connected: boolean;
  sourceState: AutoSelectionEntryData | null;
  recoveryPaths: string[];
}

interface RepoPromptMcpDependencies {
  contextBuilderJobs?: ContextBuilderJobManager;
  oracleSendJobs?: OracleSendJobManager;
  steeringWaitCoordinator?: SteeringWaitCoordinator;
  resolveBackgroundWaitPolicy?: BackgroundWaitPolicyResolver;
  launchApp?: (appPath: string) => Promise<boolean>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Extension Entry Point
// ─────────────────────────────────────────────────────────────────────────────

export default function repopromptMcp(pi: ExtensionAPI, dependencies: RepoPromptMcpDependencies = {}) {
  const contextBuilderJobs = dependencies.contextBuilderJobs ?? new ContextBuilderJobManager();
  const oracleSendJobs = dependencies.oracleSendJobs ?? new OracleSendJobManager();
  const steeringWaitCoordinator = dependencies.steeringWaitCoordinator ?? new SteeringWaitCoordinator();
  const backgroundWaitPolicyResolver = dependencies.resolveBackgroundWaitPolicy ?? resolveBackgroundWaitPolicy;
  const launchApp = dependencies.launchApp ?? tryLaunchApp;
  let config: RpConfig = loadConfig();
  let activeApp: RpAppId = config.activeApp;
  let connectedApp: RpAppId | null = null;
  let initPromise: Promise<void> | null = null;
  let shutdownRequested = false;
  let extensionPaused = false;
  let backgroundJobLifecycleGeneration = 0;
  let connectionLifecycleController = new AbortController();
  let connectionTransition: Promise<void> | null = null;
  let connectionRecovery: { signal: AbortSignal; promise: Promise<void> } | null = null;

  pi.events.on(QUEUE_STEER_ACCEPTED_EVENT, (payload: unknown) => {
    steeringWaitCoordinator.observeQueueSteerAccepted(payload);
  });

  function resolveCurrentBackgroundWaitPolicy(ctx?: ExtensionContext) {
    const waitConfig = loadConfig({ activeApp });
    return backgroundWaitPolicyResolver({
      heartbeatEnabled: waitConfig.backgroundWaitHeartbeatEnabled ?? true,
      cacheTtlMsByModel: waitConfig.backgroundWaitCacheTtlMsByModel ?? {},
      model: ctx?.model,
      processCacheRetention: process.env.PI_CACHE_RETENTION,
    });
  }

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

  type FreshRoutingContractDecision =
    | {
        readonly kind: "supported";
        readonly capabilities: TargetCapabilities;
        readonly toolCatalogFreshness: ToolCatalogFreshness;
        readonly catalogRevision: ToolCatalogRevisionToken;
      }
    | {
        readonly kind: "blocked";
        readonly error: "catalog_changed" | "catalog_stale" | "unsupported_contract";
        readonly message: string;
        readonly toolCatalogFreshness: ToolCatalogFreshness;
        readonly catalogRevision: ToolCatalogRevisionToken;
      };

  function inspectFreshRoutingContract(
    expectedRevision?: ToolCatalogRevisionToken
  ): FreshRoutingContractDecision {
    const client = getRpClient();
    if (expectedRevision && !client.ownsToolCatalogRevision(expectedRevision)) {
      return {
        kind: "blocked",
        error: "catalog_changed",
        message:
          "RepoPrompt tool catalog changed after routing classification; restart the call against the new catalog",
        toolCatalogFreshness: client.toolCatalogFreshness,
        catalogRevision: expectedRevision,
      };
    }
    const catalogRevision = expectedRevision ?? client.captureToolCatalogRevision();
    const toolCatalogFreshness = catalogRevision.freshness;
    if (toolCatalogFreshness !== "fresh") {
      return {
        kind: "blocked",
        error: "catalog_stale",
        message:
          "RepoPrompt routing requires a fresh compatible tool catalog; current catalog is " +
          toolCatalogFreshness,
        toolCatalogFreshness,
        catalogRevision,
      };
    }

    const contract = targetContractForApp(activeApp);
    const result = contract.inspectCapabilities(client.tools);
    if (result.kind === "unsupported") {
      const message =
        `Unsupported ${activeAppLabel()} routing contract: ${result.diagnostics.join("; ")}`;
      clearBinding();
      extensionPaused = true;
      return {
        kind: "blocked",
        error: "unsupported_contract",
        message,
        toolCatalogFreshness,
        catalogRevision,
      };
    }

    return {
      kind: "supported",
      capabilities: result.capabilities,
      toolCatalogFreshness,
      catalogRevision,
    };
  }

  function routingMutationIssuanceGuard(expectedRevision: ToolCatalogRevisionToken) {
    return {
      validate() {
        const decision = inspectFreshRoutingContract(expectedRevision);
        return decision.kind === "blocked"
          ? { kind: "blocked" as const, error: decision.error, diagnostic: decision.message }
          : { kind: "allowed" as const };
      },
    };
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

  function invalidateConnectionLifecycle(reason: string): void {
    if (!connectionLifecycleController.signal.aborted) {
      connectionLifecycleController.abort(new Error(`RepoPrompt connection lifecycle superseded: ${reason}`));
    }
    initPromise = null;
    connectionRecovery = null;
  }

  /**
   * Publish the post-connect recovery flight for the current lifecycle
   *
   * Tool dispatch waits on this instead of on the connection transition, so binding and selection
   * recovery gate calls without blocking a later reconnect, app switch, or shutdown
   */
  function registerConnectionRecovery(signal: AbortSignal, work: Promise<void>): Promise<void> {
    const flight = work.then(
      () => undefined,
      () => undefined,
    ).finally(() => {
      if (connectionRecovery?.promise === flight) {
        connectionRecovery = null;
      }
    });
    connectionRecovery = { signal, promise: flight };
    return flight;
  }

  /** Wait for a promise only while its connection lifecycle remains current */
  async function awaitWithinConnectionLifecycle(work: Promise<void>, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const handleAbort = () => reject(signal.reason);
      signal.addEventListener("abort", handleAbort, { once: true });
      void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", handleAbort));
    });
  }

  /** Wait for the current lifecycle's recovery so calls never dispatch against an unrecovered binding */
  async function awaitConnectionRecovery(signal: AbortSignal): Promise<void> {
    for (;;) {
      signal.throwIfAborted();
      const flight = connectionRecovery;
      if (!flight || flight.signal !== signal) {
        return;
      }
      await awaitWithinConnectionLifecycle(flight.promise, signal);
      if (connectionRecovery === flight) {
        return;
      }
    }
  }

  function beginConnectionLifecycle(reason: string): AbortSignal {
    invalidateConnectionLifecycle(reason);
    connectionLifecycleController = new AbortController();
    return connectionLifecycleController.signal;
  }

  function connectionLifecycleIsCurrent(signal: AbortSignal): boolean {
    return signal === connectionLifecycleController.signal && !signal.aborted && !shutdownRequested;
  }

  async function runConnectionTransition<T>(
    signal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    while (connectionTransition) {
      await connectionTransition;
    }
    signal.throwIfAborted();

    const operationPromise = operation(signal);
    const transition = operationPromise.then(() => undefined, () => undefined);
    connectionTransition = transition;
    try {
      return await operationPromise;
    } finally {
      if (connectionTransition === transition) {
        connectionTransition = null;
      }
    }
  }

  async function resetClientAndBackgroundJobs(reason: RepoPromptJobResetReason): Promise<void> {
    steeringWaitCoordinator.invalidateActiveObservers();
    backgroundJobLifecycleGeneration += 1;
    contextBuilderJobs.reset(reason);
    oracleSendJobs.reset(reason);
    clearBinding();
    resetRoutingInventoryContractSession();
    await resetRpClient();
  }

  async function resetConnectionForActiveAppChange(previousApp: RpAppId): Promise<void> {
    if (previousApp === activeApp) {
      return;
    }

    const lifecycleSignal = beginConnectionLifecycle("active_app_change");
    await runConnectionTransition(lifecycleSignal, async (signal) => {
      signal.throwIfAborted();
      connectedApp = null;
      clearBinding();
      clearReadcacheCaches();
      clearRootsCache();
      resetAutoSelectionRuntimeState();
      clearPendingTransitionSelectionState();
      await resetClientAndBackgroundJobs("active_app_change");
    });
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

  async function adoptAutoSelectionStateForCurrentBinding(
    ctx: ExtensionContext,
    binding: RpBinding
  ): Promise<RpBinding> {
    return await runAutoSelectionUpdate(async () => {
      const currentBinding = getVerifiedBinding();
      if (
        currentBinding?.app !== binding.app ||
        currentBinding.windowId !== binding.windowId ||
        currentBinding.tab !== binding.tab
      ) {
        throw new RoutingMutationBlockedError(
          "route_superseded",
          "A newer RepoPrompt route superseded explicit binding"
        );
      }

      return adoptAutoSelectionStateForBinding(ctx, binding);
    });
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
    issuanceGuard: ReturnType<typeof routingMutationIssuanceGuard>,
    signal: AbortSignal | undefined,
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
      return getVerifiedBinding();
    }

    const windows = await fetchWindows(pi, config, client, signal);
    signal?.throwIfAborted();
    if (windows.length === 0) {
      clearBinding();
      return null;
    }

    let liveBinding = binding;

    if (!windows.some((w) => w.id === binding.windowId)) {
      if (!binding.workspace) {
        clearBinding();
        return null;
      }

      const workspaceMatches = windows.filter((w) => w.workspace === binding.workspace);
      const rootRecovery = options.recoveryPaths && options.recoveryPaths.length > 0
        ? await findRecoveryWindowBySelectionPaths(windows, options.recoveryPaths, ctx.cwd, signal)
        : { window: null, ambiguous: false, matches: [] };
      const match = workspaceMatches.length === 1 ? workspaceMatches[0] : rootRecovery.window;

      if (match) {
        try {
          liveBinding = await bindToWindow(
            pi,
            match.id,
            undefined,
            config,
            undefined,
            signal,
            ctx,
            issuanceGuard
          );
        } catch (error) {
          signal?.throwIfAborted();
          if (error instanceof RoutingMutationBlockedError) {
            throw error;
          }
          clearBinding();
          const diagnostic = error instanceof Error ? error.message : String(error);
          throw new Error(
            `RepoPrompt failed to verify replacement window ${match.id} for workspace "${binding.workspace}": ${diagnostic}`,
            { cause: error },
          );
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
      }, signal, issuanceGuard);
    } catch (error) {
      signal?.throwIfAborted();
      throw error;
    }
  }

  async function syncAutoSelectionToCurrentBranch(
    ctx: ExtensionContext,
    options: AutoSelectionSyncOptions = reconnectAutoSelectionSyncOptions(),
    pendingTargetPolicy: "reuse" | "refresh" = "reuse",
    expectedRevision?: ToolCatalogRevisionToken,
    signal?: AbortSignal
  ): Promise<RpBinding | null> {
    const contractDecision = inspectFreshRoutingContract(expectedRevision);
    if (contractDecision.kind === "blocked") {
      if (ctx.hasUI) {
        ctx.ui.notify(contractDecision.message, "warning");
      }
      return null;
    }

    return await runAutoSelectionUpdate(async () => {
      signal?.throwIfAborted();
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
      const liveBinding = await ensureBindingTargetsLiveWindow(
        ctx,
        routingMutationIssuanceGuard(contractDecision.catalogRevision),
        signal,
        {
          ...options,
          hasRecoverableState,
          recoveryPaths,
        }
      );
      signal?.throwIfAborted();

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
      signal?.throwIfAborted();

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
  ): Promise<RpBinding & { tab: string }> {
    const binding = await syncAutoSelectionToCurrentBranch(ctx);

    if (!binding) {
      throw new Error("RepoPrompt is not bound. Use /rp bind first.");
    }

    if (!binding.tab) {
      throw new Error(reason);
    }

    return { ...binding, tab: binding.tab };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Lifecycle Events
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Finish a freshly established connection: observe routing state, then reconcile branch selection
   *
   * Runs outside the serialized connection transition so a slow RepoPrompt window or selection
   * operation cannot delay an explicit reconnect, app switch, or shutdown
   */
  async function completeConnectionRecovery(
    ctx: ExtensionContext,
    syncOptions: AutoSelectionSyncOptions,
    pendingTargetPolicy: "reuse" | "refresh",
    lifecycleSignal: AbortSignal,
    allowTabRecovery: boolean,
  ): Promise<void> {
    const contractDecision = inspectFreshRoutingContract();
    if (contractDecision.kind === "blocked") {
      if (ctx.hasUI) {
        ctx.ui.notify(contractDecision.message, "warning");
      }
      return;
    }

    let observedWindowOnly = false;
    try {
      const stickyRoute = await adoptObservedStickyRoute(
        pi,
        config,
        getRpClient(),
        lifecycleSignal
      );
      lifecycleSignal.throwIfAborted();
      observedWindowOnly = stickyRoute.kind === "intent";
      if (stickyRoute.kind === "conflict" && ctx.hasUI) {
        ctx.ui.notify(
          `${activeAppLabel()}: ${stickyRoute.diagnostic}. Restoring this branch's route explicitly.`,
          "warning"
        );
      }
      await autoBindAfterConnect(
        pi,
        ctx,
        config,
        lifecycleSignal,
        routingMutationIssuanceGuard(contractDecision.catalogRevision)
      );
    } catch (error) {
      if (!connectionLifecycleIsCurrent(lifecycleSignal)) {
        return;
      }
      const diagnostic = error instanceof Error ? error.message : String(error);
      console.warn(
        `[repoprompt-mcp] app=${activeApp} route=intent operation_class=routing_observation ` +
        `cause=connection_recovery_failed: ${diagnostic.split(/\r?\n/u, 1)[0]}`
      );
      if (ctx.hasUI) {
        ctx.ui.notify(
          `${activeAppLabel()}: route observation failed. Run /rp bind or /rp reconnect to retry.`,
          "warning"
        );
      }
      return;
    }

    if (!allowTabRecovery && observedWindowOnly) {
      return;
    }

    try {
      await syncAutoSelectionToCurrentBranch(
        ctx,
        syncOptions,
        pendingTargetPolicy,
        contractDecision.catalogRevision,
        lifecycleSignal
      );
    } catch (err) {
      if (!connectionLifecycleIsCurrent(lifecycleSignal)) {
        return;
      }
      // The pending transition target is retained by the sync itself, so the next reconnect retries it
      const diagnostic = err instanceof Error ? err.message : String(err);
      console.warn(
        `[repoprompt-mcp] app=${activeApp} route=intent operation_class=selection_recovery ` +
        `cause=recovery_failed: ${diagnostic.split(/\r?\n/u, 1)[0]}`
      );
      if (ctx.hasUI) {
        ctx.ui.notify(
          `${activeAppLabel()}: selection recovery failed. Run /rp bind or /rp reconnect to retry.`,
          "warning"
        );
      }
    }
  }

  async function retryStartupAfterConnectionFailure(
    ctx: ExtensionContext,
    syncOptions: AutoSelectionSyncOptions,
    lifecycleSignal: AbortSignal,
  ): Promise<void> {
    // If autoLaunchApp is enabled, try opening the app and retrying once
    const targetConfig = getAppTargetConfig(config, activeApp);
    if (targetConfig.autoLaunchApp) {
      const appPath = inferAppPath(config, activeApp);
      const launched = await launchApp(appPath);
      if (!connectionLifecycleIsCurrent(lifecycleSignal)) {
        return;
      }
      if (launched) {
        try {
          await runConnectionTransition(lifecycleSignal, async (signal) => {
            await resetClientAndBackgroundJobs("startup_retry");
            signal.throwIfAborted();
            connectedApp = null;
            clearRootsCache();
            await initializeExtension(pi, ctx, config, markConnectedApp, signal);
          });
          await completeConnectionRecovery(ctx, syncOptions, "refresh", lifecycleSignal, false);
          return;
        } catch {
          if (!connectionLifecycleIsCurrent(lifecycleSignal)) {
            return;
          }
          // Fall through to pause
        }
      }
    }

    if (!connectionLifecycleIsCurrent(lifecycleSignal)) {
      return;
    }
    extensionPaused = true;
    if (ctx.hasUI) {
      ctx.ui.notify(
        `${activeAppLabel()} unavailable — extension paused. Use /rp reconnect or /rp app when ready.`,
        "warning"
      );
    }
  }

  pi.on("input", (event, ctx) => {
    if (event.source === "interactive" && event.streamingBehavior === "steer") {
      steeringWaitCoordinator.observeStockSteerCandidate({
        sessionId: ctx.sessionManager.getSessionId(),
        pendingMessagesBefore: ctx.hasPendingMessages(),
        hasPendingMessages: () => ctx.hasPendingMessages(),
      });
    }
    return { action: "continue" };
  });

  pi.on("session_start", async (event, ctx) => {
    shutdownRequested = false;
    steeringWaitCoordinator.beginSession(ctx.sessionManager.getSessionId());
    const lifecycleSignal = beginConnectionLifecycle("session_start");
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
    const pendingInit = initializeExtension(pi, ctx, config, markConnectedApp, lifecycleSignal);
    initPromise = pendingInit;

    // Connection failure and post-connection recovery failure have different semantics, so they are
    // handled by separate settlement paths rather than by one chained catch
    void registerConnectionRecovery(
      lifecycleSignal,
      pendingInit.then(
        async () => {
          if (initPromise !== pendingInit || !connectionLifecycleIsCurrent(lifecycleSignal)) {
            return;
          }
          initPromise = null;
          await completeConnectionRecovery(ctx, syncOptions, "refresh", lifecycleSignal, false);
        },
        async () => {
          if (initPromise !== pendingInit || !connectionLifecycleIsCurrent(lifecycleSignal)) {
            return;
          }
          initPromise = null;
          await retryStartupAfterConnectionFailure(ctx, syncOptions, lifecycleSignal);
        },
      ),
    );
  });

  pi.on("session_compact", async () => {
    clearReadcacheCaches();
  });

  pi.on("session_shutdown", async () => {
    shutdownRequested = true;
    invalidateConnectionLifecycle("session_shutdown");
    updatePendingTransitionSelectionFromLiveState();

    // Never block Pi shutdown on an MCP startup handshake that may be stuck waiting on the app
    clearBinding();
    clearReadcacheCaches();
    clearRootsCache();
    resetAutoSelectionRuntimeState();
    await resetClientAndBackgroundJobs("session_shutdown");
    steeringWaitCoordinator.shutdown();
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

      let commandCatalogRevision: ToolCatalogRevisionToken | undefined;
      if (!alwaysAllowed.has(subcommand)) {
        const routingContractSubcommand = subcommand === "windows"
          || subcommand === "bind"
          || subcommand === "tab"
          || subcommand === "oracle";
        await ensureConnected(ctx, { syncAutoSelection: !routingContractSubcommand });
        if (routingContractSubcommand) {
          const contractDecision = inspectFreshRoutingContract();
          if (contractDecision.kind === "blocked") {
            ctx.ui.notify(contractDecision.message, "error");
            return;
          }
          commandCatalogRevision = contractDecision.catalogRevision;
        }
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

          if (!commandCatalogRevision) {
            throw new Error("Routing contract revision was not captured for interactive bind");
          }
          const issuanceGuard = routingMutationIssuanceGuard(commandCatalogRevision);
          try {
            let binding = tab
              ? await bindToTab(pi, windowId, tab, config, undefined, undefined, issuanceGuard)
              : await bindToWindow(
                  pi,
                  windowId,
                  undefined,
                  config,
                  undefined,
                  undefined,
                  ctx,
                  issuanceGuard
                );

            binding = await adoptAutoSelectionStateForCurrentBinding(ctx, binding);
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
          if (!commandCatalogRevision) {
            throw new Error("Routing contract revision was not captured for interactive tab binding");
          }
          const issuanceGuard = routingMutationIssuanceGuard(commandCatalogRevision);

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

              const tabs = await fetchWindowTabs(window.id, getRpClient(), config);
              const selected = await promptForTabSelection(ctx, tabs);
              if (!selected) {
                ctx.ui.notify("Cancelled", "info");
                return;
              }

              binding = selected.kind === "create"
                ? await createAndBindTab(pi, window.id, config, undefined, undefined, issuanceGuard)
                : await bindToTab(
                    pi,
                    window.id,
                    selected.tab.id,
                    config,
                    undefined,
                    undefined,
                    issuanceGuard
                  );
            } else if (/^new$/i.test(requested)) {
              binding = await createAndBindTab(
                pi,
                window.id,
                config,
                undefined,
                undefined,
                issuanceGuard
              );
            } else {
              binding = await bindToTab(
                pi,
                window.id,
                requested,
                config,
                undefined,
                undefined,
                issuanceGuard
              );
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
          const targetContract = targetContractForApp(activeApp);
          const targetName = `${activeAppDisplay()} target ${targetContract.id}`;
          const expectedModeText = targetContract.oracleModes.join("|");
          const rawArgs = args.trim();
          const rest = rawArgs.replace(/^oracle\b/i, "").trim();

          if (!rest) {
            ctx.ui.notify(
              `Usage for ${targetName}: /rp oracle [--mode <${expectedModeText}>] ` +
                "[--name <chat name>] [--continue|--chat-id <id>] <message>",
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
            ctx.ui.notify(`No Oracle message provided for ${targetName}`, "error");
            return;
          }

          const client = getRpClient();
          const contractDecision = inspectFreshRoutingContract();
          if (contractDecision.kind === "blocked") {
            ctx.ui.notify(contractDecision.message, "error");
            return;
          }

          const oracleCapability = contractDecision.capabilities.oracle;
          if (oracleCapability.kind === "unavailable") {
            ctx.ui.notify(`Oracle is unavailable for ${targetName}: ${oracleCapability.diagnostic}`, "error");
            return;
          }

          const supportedModeText = oracleCapability.value.modes.join("|");
          const resolvedMode = mode ?? config.oracleDefaultMode ?? "chat";
          const allowedModes = new Set<string>(oracleCapability.value.modes);
          if (!allowedModes.has(resolvedMode)) {
            const modeDiagnostic = mode === undefined && config.oracleDefaultMode !== undefined
              ? `Configured oracleDefaultMode "${resolvedMode}" is not supported by ${targetName}.`
              : `Oracle mode "${resolvedMode}" is not supported by ${targetName}.`;
            ctx.ui.notify(`${modeDiagnostic} Supported modes: ${supportedModeText}.`, "error");
            return;
          }

          try {
            await ensureTabScopedBinding(ctx, "RepoPrompt binding has no tab. Use /rp bind or /rp tab new first.");

            const oracleSendToolName = resolveToolName(client.tools, "oracle_send");
            if (!oracleSendToolName) {
              ctx.ui.notify(`Oracle is unavailable for ${targetName}: oracle_send is no longer advertised`, "error");
              return;
            }

            const callArgs: Record<string, unknown> = {
              new_chat: newChat,
              message,
              mode: resolvedMode,
            };

            if (chatName) callArgs.chat_name = chatName;
            if (chatId) callArgs.chat_id = chatId;

            const issued = await issueLeasedRouteDispatch({}, (lease) => {
              const issuanceDecision = inspectFreshRoutingContract(contractDecision.catalogRevision);
              if (issuanceDecision.kind === "blocked") {
                return { kind: "blocked" as const, decision: issuanceDecision };
              }
              return {
                kind: "started" as const,
                request: executeLeasedRouteDependentCall(
                  lease,
                  config,
                  client,
                  () => client.callTool(
                    oracleSendToolName,
                    buildForwardedCallArgs({
                      forwardingClass: "route_dependent",
                      userArgs: callArgs,
                      verifiedSelectors: lease.selectors,
                    })
                  )
                ),
              };
            });
            if (issued.kind === "blocked" || issued.kind === "conflict") {
              ctx.ui.notify(issued.diagnostic, "error");
              return;
            }
            if (issued.request.kind === "blocked") {
              ctx.ui.notify(issued.request.decision.message, "error");
              return;
            }
            const result = await issued.request.request;
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
          const lifecycleSignal = beginConnectionLifecycle("reconnect");
          try {
            await runConnectionTransition(lifecycleSignal, async (signal) => {
              config = loadRuntimeConfig();
              await resetClientAndBackgroundJobs("reconnect");
              signal.throwIfAborted();
              connectedApp = null;
              clearBinding();
              clearRootsCache();
              extensionPaused = false;
              try {
                await initializeExtension(pi, ctx, config, markConnectedApp, signal);
              } catch (err) {
                signal.throwIfAborted();
                // Publish the paused state before the transition is released so calls queued
                // behind this reconnect observe it instead of starting their own connection
                extensionPaused = true;
                throw err;
              }
              signal.throwIfAborted();
              registerConnectionRecovery(
                signal,
                completeConnectionRecovery(ctx, reconnectAutoSelectionSyncOptions(), "reuse", signal, true),
              );
            });
            await awaitConnectionRecovery(lifecycleSignal);
          } catch (err) {
            if (!connectionLifecycleIsCurrent(lifecycleSignal)) {
              break;
            }
            extensionPaused = true;
            ctx.ui.notify(`Reconnection failed: ${err instanceof Error ? err.message : err}`, "error");
            break;
          }

          if (!connectionLifecycleIsCurrent(lifecycleSignal)) {
            break;
          }
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
          break;
        }

        default: {
          const targetContract = targetContractForApp(activeApp);
          const oracleModes = targetContract.oracleModes.join("|");
          ctx.ui.notify(
            `RepoPrompt commands for ${activeAppDisplay()} target ${targetContract.id}:\n` +
            "  /rp status                               - Show connection and binding status\n" +
            "  /rp app [ce|classic]                     - Show or switch the active RepoPrompt app\n" +
            "  /rp windows                              - List available windows\n" +
            "  /rp bind                                 - Open the interactive picker and bind\n" +
            "  /rp bind <id> [tab]                      - Direct/advanced bind when you already know the ids\n" +
            `  /rp oracle [--mode <${oracleModes}>] <message> - Start/continue Oracle with current selection\n` +
            "  /rp reconnect                            - Reconnect to RepoPrompt\n" +
            "  /rp readcache-status                     - Show read_file cache status\n" +
            "  /rp readcache-refresh <path> [start-end] - Invalidate cached trust for next read_file",
            "info"
          );
          break;
        }
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
  rp({ call: "context_builder", args: {...} })
                                          → Start Context Builder and receive a job_id
  rp({ call: "context_builder_wait", args: { job_id: "..." } })
                                          → Wait for completion or a cache-aware running heartbeat
  rp({ call: "oracle_send", args: {...} })
                                          → Start Oracle and receive a job_id
  rp({ call: "oracle_send_wait", args: { job_id: "..." } })
                                          → Wait for completion or a cache-aware running heartbeat

Context Builder and generic Oracle sends use asynchronous start/wait protocols with one-shot terminal results.
Accepted Pi steering can release their current wait observation while the underlying job continues.
${AGENT_RUN_WAIT_GUIDANCE}
Other forwarded RepoPrompt tools return their results directly.

Common tools: read_file, get_file_tree, get_code_structure, file_search,
apply_edits, manage_selection, workspace_context

Mode priority: call > describe > search > windows > bind > status`,

    parameters: RpToolSchema,

    async execute(_toolCallId, params: RpToolParams, signal, onUpdate, _ctx) {
      const mode = params.call
        ? "call"
        : params.describe
          ? "describe"
          : params.search
            ? "search"
            : params.windows
              ? "windows"
              : params.bind
                ? "bind"
                : "status";
      const normalizedCall = mode === "call" ? normalizeToolName(params.call ?? "") : "";
      const preflightOperation = mode === "call"
        ? operationForTool(normalizedCall, (params.args ?? {}) as Record<string, unknown>)
        : undefined;
      const preflightClassification = mode === "call"
        ? classifyForwardingOperation(normalizedCall, preflightOperation)
        : null;
      if (preflightClassification?.kind === "rejected") {
        return {
          content: [{ type: "text" as const, text: preflightClassification.diagnostic }],
          details: { mode: "call", error: "blocked", tool: normalizedCall },
          isError: true,
        };
      }
      const resolvedCallClassification = preflightClassification?.kind === "classified"
        ? preflightClassification
        : null;
      const preflightForwardingClass = resolvedCallClassification?.forwardingClass ?? null;
      const explicitRoutingBoundary = mode === "windows" || mode === "bind"
        || preflightForwardingClass === "routing_observation"
        || preflightForwardingClass === "routing_mutation"
        || preflightForwardingClass === "workspace_observation"
        || preflightForwardingClass === "workspace_routing_mutation";
      const backgroundProtocol = backgroundStartProtocolFor(normalizedCall);
      const executionParams = backgroundProtocol
        ? { ...params, args: structuredClone(params.args ?? {}) }
        : params;
      const waitingForBackgroundJob = isLocalWaitTool(normalizedCall);
      const localDiagnosticMode = mode === "status" || mode === "search" || mode === "describe";
      if (backgroundProtocol && signal?.aborted) {
        throwBackgroundStartAborted(backgroundProtocol);
      }
      if (extensionPaused && !waitingForBackgroundJob && !localDiagnosticMode) {
        throw new Error(
          `The rp tool is not currently available because ${activeAppDisplay()} is disconnected. ` +
          "The user can run /rp app or /rp reconnect when the selected app is running."
        );
      }

      // Provide a no-op if onUpdate is undefined
      const safeOnUpdate = onUpdate ?? (() => {});

      // Wrapper-owned waits and paused diagnostics read only extension runtime state
      const lazyCatalogDiagnostic = !extensionPaused && (mode === "search" || mode === "describe");
      const requiresConnection = mode === "call"
        ? !waitingForBackgroundJob
        : mode === "windows" || mode === "bind" || lazyCatalogDiagnostic;
      if (requiresConnection) {
        const connectionWork = ensureConnected(
          _ctx as ExtensionContext | undefined,
          { syncAutoSelection: !explicitRoutingBoundary && !lazyCatalogDiagnostic }
        );
        if (backgroundProtocol) {
          await awaitBackgroundJobStartPhase(
            connectionWork,
            signal,
            () => backgroundStartAbortedError(backgroundProtocol),
          );
        } else {
          await connectionWork;
        }
      }

      let explicitModeCatalogRevision: ToolCatalogRevisionToken | null = null;
      if (mode === "windows" || mode === "bind") {
        const contractDecision = inspectFreshRoutingContract();
        if (contractDecision.kind === "blocked") {
          return {
            content: [{ type: "text" as const, text: contractDecision.message }],
            details: {
              mode,
              error: contractDecision.error,
              toolCatalogFreshness: contractDecision.toolCatalogFreshness,
            },
            isError: true,
          };
        }
        explicitModeCatalogRevision = contractDecision.catalogRevision;
      }

      // Mode resolution: call > describe > search > windows > bind > status
      if (mode === "call" && executionParams.call) {
        return executeToolCall(
          executionParams,
          preflightOperation,
          resolvedCallClassification!,
          safeOnUpdate,
          signal,
          _ctx as ExtensionContext | undefined
        );
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
        if (!explicitModeCatalogRevision) {
          throw new Error("Routing contract revision was not captured for tool-driven binding");
        }
        return executeBinding(
          pi,
          params.bind.window,
          params.bind.tab,
          _ctx as ExtensionContext | undefined,
          explicitModeCatalogRevision
        );
      }
      return executeStatus(_ctx as ExtensionContext | undefined);
    },

    renderShell: "self",

    renderCall(args: Record<string, unknown>, theme: Theme, context: RpRenderCallContext) {
      // Always return the shell: a childless Box renders zero lines, so hiding a running
      // wait means declining to give the shell content rather than swapping components.
      return rebuildRpShell(
        context.state,
        shellBackground(theme, true, false),
        isHiddenWaitCall(args, context.argsComplete) ? [] : [createRpCallContent(args, theme)],
      );
    },

    renderResult(
      result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
      options: ToolRenderResultOptions,
      theme: Theme,
      context: RpRenderResultContext,
    ) {
      const details = asRecord(result.details) ?? {};
      const isPartial = options.isPartial === true;
      const isError = context.isError || result.isError === true || details.isError === true;

      // renderCall already ran this pass, so leaving the shell as it left it keeps a hidden
      // wait childless and prevents stale result content from surviving.
      if (!isHiddenWaitResult(context.args, details, isPartial, isError)) {
        // The shell is mounted from renderCall, so this renderer mutates it in place and adds
        // nothing of its own. A settled wait first becomes visible here, which is why the call
        // header is added unconditionally rather than reusing the call-row predicate.
        rebuildRpShell(context.state, shellBackground(theme, isPartial, isError), [
          createRpCallContent(context.args, theme),
          createRpResultContent(result, options, theme, isError),
        ]);
      }

      return new Container();
    },
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool Row Content
  //
  // Foreground content only. The self-rendered shell owns padding and background, so these
  // must not add a Box, spacer, or background of their own.
  // ─────────────────────────────────────────────────────────────────────────────

  function createRpCallContent(args: Record<string, unknown>, theme: Theme): Component {
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
  }

  function createRpResultContent(
      result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
      options: ToolRenderResultOptions,
      theme: Theme,
      isError: boolean,
  ): Component {
      const details = (result.details ?? {}) as Record<string, unknown>;

      const textContent = result.content
        .filter((c) => c.type === "text")
        .map((c) => c.text || "")
        .join("\n");

      if (options.isPartial) {
        return new Text(theme.fg("warning", "Running…"), 0, 0);
      }

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
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Helper Functions
  // ───────────────────────────────────────────────────────────────────────────

  async function ensureConnected(
    ctx?: ExtensionContext,
    options: { syncAutoSelection?: boolean } = {}
  ): Promise<void> {
    for (;;) {
      const lifecycleSignal = connectionLifecycleController.signal;
      try {
        // A published recovery owns connection establishment for this lifecycle. Wait before
        // entering the transition so a lazy call cannot create a competing same-lifecycle client.
        await awaitConnectionRecovery(lifecycleSignal);
        lifecycleSignal.throwIfAborted();
        if (lifecycleSignal !== connectionLifecycleController.signal) {
          continue;
        }

        await runConnectionTransition(lifecycleSignal, async (signal) => {
          const connected = await ensureConnectedWithinTransition(signal);
          if (connected && ctx && options.syncAutoSelection !== false) {
            restoreBinding(ctx, config);
            const recovery = (async () => {
              try {
                await syncAutoSelectionToCurrentBranch(ctx, reconnectAutoSelectionSyncOptions());
                signal.throwIfAborted();
              } catch {
                signal.throwIfAborted();
                // Fail-open
              }
            })();
            registerConnectionRecovery(signal, recovery);
          }
        });

        // Recovery owns the tab-scoped target this call depends on. It remains outside the
        // transition lock, but is published before a fresh connection releases that lock.
        await awaitConnectionRecovery(lifecycleSignal);
        lifecycleSignal.throwIfAborted();
        if (lifecycleSignal !== connectionLifecycleController.signal) {
          continue;
        }
        if (extensionPaused) {
          throw new Error(
            `The rp tool is not currently available because ${activeAppDisplay()} is disconnected. ` +
            "The user can run /rp app or /rp reconnect when the selected app is running."
          );
        }

        const client = getRpClient();
        if (!client.isConnected || connectedApp !== activeApp) {
          continue;
        }
        return;
      } catch (err) {
        if (lifecycleSignal.aborted && !shutdownRequested) {
          continue;
        }
        throw err;
      }
    }
  }

  /** Establishes the connection and reports whether this call performed a fresh connect */
  async function ensureConnectedWithinTransition(signal: AbortSignal): Promise<boolean> {
    if (initPromise) {
      await initPromise;
      signal.throwIfAborted();
    }
    if (extensionPaused) {
      throw new Error(
        `The rp tool is not currently available because ${activeAppDisplay()} is disconnected. ` +
        "The user can run /rp app or /rp reconnect when the selected app is running."
      );
    }

    // Reload config so connection/runtime knobs apply without requiring /reload
    config = loadRuntimeConfig();

    let client = getRpClient();
    if (config.toolCallTimeoutMs !== undefined) {
      client.setToolCallTimeoutMs(config.toolCallTimeoutMs);
    }
    if (client.isConnected && connectedApp === activeApp) {
      return false;
    }

    const replacingConnection = connectedApp !== null && (!client.isConnected || connectedApp !== activeApp);
    if (replacingConnection) {
      const resetReason = connectedApp === activeApp ? "reconnect" : "connected_app_change";
      await resetClientAndBackgroundJobs(resetReason);
      signal.throwIfAborted();
      connectedApp = null;
      client = getRpClient();
      if (config.toolCallTimeoutMs !== undefined) {
        client.setToolCallTimeoutMs(config.toolCallTimeoutMs);
      }
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
    await client.connect(server.command, server.args, targetConfig.env, config.toolCallTimeoutMs, signal);
    signal.throwIfAborted();
    await establishRoutingInventoryContract(config, client, signal);
    signal.throwIfAborted();
    connectedApp = activeApp;
    return true;
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
        ...requireVerifiedRouteArgs(),
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
        ...(bindingArgsOverride ?? requireVerifiedRouteArgs()),
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
      const currentBindingArgs = bindingArgsOverride ?? requireVerifiedRouteArgs();
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
    return await resolveLiveBindingTabLabel(binding, config);
  }

  function capturedAutoSelectionForAppSwitch(ctx: ExtensionContext): AutoSelectionEntryData | null {
    const binding = getVerifiedBinding();
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

    const lifecycleSignal = beginConnectionLifecycle("active_app_change");
    let handover: AppSwitchHandover;
    try {
      handover = await runConnectionTransition(lifecycleSignal, async (signal) => {
        const sourceState = capturedAutoSelectionForAppSwitch(ctx);
        const recoveryPaths = sourceState ? autoSelectionManagedPaths(sourceState) : [];

        activeApp = nextApp;
        config = loadRuntimeConfig();
        persistActiveApp(nextApp);

        clearBinding();
        clearReadcacheCaches();
        clearRootsCache();
        resetAutoSelectionRuntimeState();
        clearPendingTransitionSelectionState();
        await resetClientAndBackgroundJobs("active_app_change");
        signal.throwIfAborted();
        connectedApp = null;

        const server = getServerCommand(config, activeApp);
        if (!server) {
          extensionPaused = true;
          ctx.ui.notify(
            `${activeAppDisplay()} MCP server not found. Configure ~/.pi/agent/extensions/repoprompt-mcp.json ` +
              `or install ${getAppCliCommand(activeApp)}.`,
            "error"
          );
          return { connected: false, sourceState, recoveryPaths };
        }

        const targetConfig = getAppTargetConfig(config, activeApp);
        const client = getRpClient();

        try {
          extensionPaused = false;
          await client.connect(server.command, server.args, targetConfig.env, config.toolCallTimeoutMs, signal);
          signal.throwIfAborted();
          await establishRoutingInventoryContract(config, client, signal);
          signal.throwIfAborted();
          connectedApp = activeApp;
        } catch (err) {
          signal.throwIfAborted();
          // Publish the paused state before the transition is released so calls queued behind
          // this app switch observe it instead of starting their own connection
          extensionPaused = true;
          ctx.ui.notify(
            `Failed to connect to ${activeAppDisplay()}: ${err instanceof Error ? err.message : err}`,
            "error"
          );
          return { connected: false, sourceState, recoveryPaths };
        }

        const connectedHandover = { connected: true, sourceState, recoveryPaths };
        registerConnectionRecovery(
          signal,
          completeAppSwitchHandover(ctx, connectedHandover, signal),
        );
        return connectedHandover;
      });
      if (handover.connected) {
        await awaitConnectionRecovery(lifecycleSignal);
      }
    } catch (err) {
      if (connectionLifecycleIsCurrent(lifecycleSignal)) {
        throw err;
      }
      return;
    }

    if (!handover.connected || !connectionLifecycleIsCurrent(lifecycleSignal)) {
      return;
    }
  }

  /**
   * Bind a window and replay the previous selection after switching RepoPrompt apps
   *
   * Runs outside the serialized connection transition so slow window and tab operations cannot
   * block a later reconnect, app switch, or shutdown
   */
  async function completeAppSwitchHandover(
    ctx: ExtensionContext,
    handover: AppSwitchHandover,
    signal: AbortSignal,
  ): Promise<void> {
    const { sourceState, recoveryPaths } = handover;
    const contractDecision = inspectFreshRoutingContract();
    if (contractDecision.kind === "blocked") {
      ctx.ui.notify(contractDecision.message, "warning");
      return;
    }

    try {
      const stickyRoute = await adoptObservedStickyRoute(pi, config, getRpClient(), signal);
      signal.throwIfAborted();
      if (stickyRoute.kind === "conflict") {
        ctx.ui.notify(
          `${activeAppDisplay()} selected, but ${stickyRoute.diagnostic}. Use /rp bind.`,
          "warning"
        );
        return;
      }
      if (recoveryPaths.length === 0) {
        if (stickyRoute.kind === "adopted") {
          const tabLabel = await resolveBindingTabLabel(stickyRoute.binding);
          signal.throwIfAborted();
          ctx.ui.notify(
            `${activeAppDisplay()} selected and bound to window ${stickyRoute.binding.windowId}` +
              (stickyRoute.binding.workspace ? ` (${stickyRoute.binding.workspace})` : "") +
              (tabLabel ? `, tab "${tabLabel}"` : ""),
            "info"
          );
        } else {
          ctx.ui.notify(`${activeAppDisplay()} selected. Not bound; use /rp bind to choose a window.`, "info");
        }
        return;
      }

      let windows: RpWindow[];
      try {
        windows = await fetchWindows(pi, config, undefined, signal);
        signal.throwIfAborted();
      } catch (err) {
        signal.throwIfAborted();
        ctx.ui.notify(
          `${activeAppDisplay()} selected, but window recovery failed: ${err instanceof Error ? err.message : err}. ` +
            "Use /rp bind.",
          "warning"
        );
        return;
      }

      const recovery = await findRecoveryWindowBySelectionPaths(
        windows,
        recoveryPaths,
        ctx.cwd,
        signal
      );
      signal.throwIfAborted();
      if (!recovery.window) {
        const reason = recovery.ambiguous
          ? "multiple windows contain this session's required roots"
          : "no open window contains this session's required roots";
        ctx.ui.notify(`${activeAppDisplay()} selected, but ${reason}. Use /rp bind.`, "warning");
        return;
      }

      const issuanceGuard = routingMutationIssuanceGuard(contractDecision.catalogRevision);
      try {
        const initialBinding = await bindToWindow(
          pi,
          recovery.window.id,
          undefined,
          config,
          undefined,
          signal,
          ctx,
          issuanceGuard
        );
        signal.throwIfAborted();
        const recoveredBinding = await ensureBindingHasTab(pi, ctx, config, undefined, {
          reuseSoleEmptyTab: true,
        }, signal, issuanceGuard) ?? initialBinding;
        signal.throwIfAborted();

        if (sourceState && recoveredBinding.tab) {
          const targetState = normalizeAutoSelectionState({
            ...sourceState,
            app: activeApp,
            windowId: recoveredBinding.windowId,
            tab: recoveredBinding.tab,
            workspace: recoveredBinding.workspace,
          });

          await reconcileAutoSelectionStates(null, targetState);
          signal.throwIfAborted();
          persistAutoSelectionState(targetState);
        }

        const tabLabel = await resolveBindingTabLabel(recoveredBinding);
        signal.throwIfAborted();
        ctx.ui.notify(
          `${activeAppDisplay()} selected and bound to window ${recoveredBinding.windowId}` +
            (recoveredBinding.workspace ? ` (${recoveredBinding.workspace})` : "") +
            (tabLabel ? `, tab "${tabLabel}"` : ""),
          "info"
        );
      } catch (err) {
        signal.throwIfAborted();
        if (!(err instanceof RoutingMutationBlockedError)) {
          clearBinding();
        }
        ctx.ui.notify(
          `${activeAppDisplay()} selected, but handover failed: ${err instanceof Error ? err.message : err}. ` +
            "Use /rp bind.",
          "warning"
        );
      }
    } catch (error) {
      if (signal.aborted) {
        return;
      }
      ctx.ui.notify(
        `${activeAppDisplay()} selected, but handover failed: ${error instanceof Error ? error.message : error}. ` +
          "Use /rp bind.",
        "warning",
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

  const STALE_TOOL_CATALOG_WARNING =
    "Tool catalog is stale; results come from the last successful catalog and may be incomplete.";

  function formatToolCatalogStatus(freshness: ToolCatalogFreshness, toolsCount: number): string {
    if (freshness === "fresh") {
      return `Tool catalog: fresh (${toolsCount} tools)`;
    }
    if (freshness === "stale") {
      return `Tool catalog: stale (${toolsCount} last-known tools)`;
    }
    return "Tool catalog: unavailable";
  }

  function formatStaleToolAbsence(toolName: string): string {
    return (
      `Tool catalog is stale; "${toolName}" is absent from the last successful catalog, ` +
      "so availability cannot be determined."
    );
  }

  function routeStatusWithoutObservation(): RouteStatusObservation {
    const routeSnapshot = getRouteStatusSnapshot();
    const state = routeSnapshot.state;
    const displayIdentity = displayIdentityFor(routeSnapshot);
    if (state.kind === "unbound") {
      return { routeState: "unbound" };
    }
    if (state.kind === "intent") {
      return {
        routeState: "intent",
        diagnostic: "Restored route intent cannot be verified while RepoPrompt is disconnected",
        displayIdentity: displayIdentity!,
      };
    }
    if (state.kind === "quarantined") {
      return {
        routeState: "quarantined",
        diagnostic: state.diagnostic,
        displayIdentity,
      };
    }
    return {
      routeState: "observation_failed",
      diagnostic: "The last verified route cannot be observed while RepoPrompt is disconnected",
      displayIdentity,
    };
  }

  async function currentRouteStatus(): Promise<RouteStatusObservation> {
    const client = getRpClient();
    return client.isConnected ? await observeRouteStatus(config, client) : routeStatusWithoutObservation();
  }

  function formatRouteIdentity(identity: NonNullable<ReturnType<typeof displayIdentityFor>>): string {
    const workspace = identity.workspace ? ` (${identity.workspace})` : "";
    const context = identity.tabContextId ? `, context ${identity.tabContextId}` : "";
    return `window ${identity.windowId}${workspace}${context}`;
  }

  function formatRouteStatus(route: RouteStatusObservation): string {
    switch (route.routeState) {
      case "verified_tab": {
        const focus = route.tab.isActive === true
          ? "in-focus"
          : route.tab.isActive === false
            ? "out-of-focus"
            : "focus unknown";
        return [
          "Route: verified tab",
          `  Window: ${route.window.id}`,
          ...(route.window.workspace ? [`  Workspace: ${route.window.workspace}`] : []),
          `  Tab: ${route.tab.name} [bound, ${focus}]`,
          `  Context: ${route.tab.contextId}`,
          ...(route.persistenceDiagnostic ? [`  Persistence: degraded — ${route.persistenceDiagnostic}`] : []),
        ].join("\n");
      }
      case "stale":
        return [
          "Route: stale/missing",
          ...(route.displayIdentity ? [`  Intent: ${formatRouteIdentity(route.displayIdentity)}`] : []),
          `  Diagnostic: ${route.diagnostic}`,
        ].join("\n");
      case "intent":
        return [
          "Route: intent (unverified)",
          `  Intent: ${formatRouteIdentity(route.displayIdentity)}`,
          `  Diagnostic: ${route.diagnostic}`,
        ].join("\n");
      case "quarantined":
        return [
          "Route: quarantined (possible partial routing change)",
          ...(route.displayIdentity ? [`  Intent: ${formatRouteIdentity(route.displayIdentity)}`] : []),
          `  Diagnostic: ${route.diagnostic}`,
          "  Recovery: run /rp reconnect or bind explicitly",
        ].join("\n");
      case "observation_failed":
        return [
          "Route: unverified (observation failed)",
          ...(route.displayIdentity ? [`  Intent: ${formatRouteIdentity(route.displayIdentity)}`] : []),
          `  Diagnostic: ${route.diagnostic}`,
        ].join("\n");
      case "unsupported":
        return `Route: unsupported contract\n  Diagnostic: ${route.diagnostic}`;
      case "unbound":
        return [
          "Route: unbound",
          ...(route.diagnostic ? [`  Diagnostic: ${route.diagnostic}`] : []),
          "  Use /rp bind to choose a window",
        ].join("\n");
    }
  }

  async function showStatus(ctx: ExtensionContext): Promise<void> {
    const client = getRpClient();
    const toolCatalogFreshness = client.toolCatalogFreshness;
    const tools = client.tools;
    const routeStatus = await currentRouteStatus();

    let msg = `RepoPrompt Status\n`;
    msg += `─────────────────\n`;
    msg += `App: ${activeAppDisplay()}\n`;
    if (extensionPaused) {
      msg += `Extension: ⏸ paused (use /rp app or /rp reconnect to resume)\n`;
    }
    msg += `Connection: ${client.isConnected ? "✓ connected" : "✗ disconnected"}\n`;
    msg += `${formatToolCatalogStatus(toolCatalogFreshness, tools.length)}\n`;
    if (client.error) {
      msg += `Error: ${client.error}\n`;
    }
    msg += `\n${formatRouteStatus(routeStatus)}\n`;

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

    const binding = getVerifiedBinding();
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

    const binding = getVerifiedBinding();
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

  async function executeStatus(_ctx?: ExtensionContext) {
    const client = getRpClient();
    const toolCatalogFreshness = client.toolCatalogFreshness;
    const tools = client.tools;
    const status = client.status;
    const clientError = client.error;
    const route = await currentRouteStatus();
    const binding: RpBinding | null = route.routeState === "verified_tab"
      ? {
          app: activeApp,
          windowId: route.window.id,
          tab: route.tab.contextId,
          ...(route.window.workspace ? { workspace: route.window.workspace } : {}),
        }
      : null;
    const tabLabel = route.routeState === "verified_tab" ? route.tab.name : null;

    const server = getServerCommand(config, activeApp);

    let text = `RepoPrompt: ${status}\n`;
    text += `App: ${activeAppDisplay()}\n`;
    if (clientError) {
      text += `Error: ${clientError}\n`;
    }
    text += `${formatToolCatalogStatus(toolCatalogFreshness, tools.length)}\n`;
    if (!server) {
      text += `Server: (not configured / not auto-detected)\n`;
      text += `Hint: configure ~/.pi/agent/extensions/repoprompt-mcp.json for ${activeAppDisplay()}\n`;
    }
    text += `\n${formatRouteStatus(route)}`;

    return {
      content: [{ type: "text" as const, text }],
      details: {
        mode: "status",
        app: activeApp,
        appLabel: activeAppLabel(),
        status,
        error: clientError,
        routeState: route.routeState,
        route,
        binding,
        tabLabel,
        toolsCount: tools.length,
        toolCatalogFreshness,
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

    const binding = getVerifiedBinding();
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
    tab: string | undefined,
    ctx: ExtensionContext | undefined,
    catalogRevision: ToolCatalogRevisionToken
  ) {
    const issuanceGuard = routingMutationIssuanceGuard(catalogRevision);
    let binding: RpBinding;
    try {
      binding = tab
        ? await bindToTab(extensionApi, windowId, tab, config, undefined, undefined, issuanceGuard)
        : await bindToWindow(
            extensionApi,
            windowId,
            undefined,
            config,
            undefined,
            undefined,
            ctx,
            issuanceGuard
          );

      if (ctx) {
        binding = await adoptAutoSelectionStateForCurrentBinding(ctx, binding);
      }
    } catch (error) {
      if (error instanceof RoutingMutationBlockedError) {
        return {
          content: [{ type: "text" as const, text: error.message }],
          details: { mode: "bind", error: error.code },
          isError: true,
        };
      }
      throw error;
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

  function presentTool(tool: RpToolMeta): RpToolMeta {
    const normalized = normalizeToolName(tool.name);
    if (normalized === CONTEXT_BUILDER_TOOL_NAME) {
      return {
        ...tool,
        description: (
          `${tool.description || "Build deep repository context and produce a response."} ` +
          "This wrapper starts Context Builder asynchronously and returns a job_id immediately. " +
          `Call ${CONTEXT_BUILDER_WAIT_TOOL_NAME} with that ID. A wait returns on completion or shortly before ` +
          "a known or configured prompt-cache deadline; otherwise it remains pending until settlement. " +
          "Consume the terminal result before starting another job on the same app/window/tab."
        ),
      };
    }
    if (normalized === ORACLE_SEND_TOOL_NAME) {
      return {
        ...tool,
        description: (
          `${tool.description || "Consult Oracle."} ` +
          "This wrapper starts every generic Oracle send asynchronously and returns a job_id immediately. " +
          `Call ${ORACLE_SEND_WAIT_TOOL_NAME} with that ID. A wait returns on completion or shortly before ` +
          "a known or configured prompt-cache deadline; otherwise it remains pending until settlement. " +
          "Consume the terminal result before starting another Oracle send on the same app/window/tab. " +
          "The /rp oracle command remains synchronous."
        ),
      };
    }
    // Advertise steerability only where the forwarding path below will actually honor it.
    if (normalized === "agent_run" && supportsObserverInterruptibleAgentWait(activeApp)) {
      return {
        ...tool,
        description: `${tool.description || "Run RepoPrompt agents."} ${AGENT_RUN_WAIT_GUIDANCE}`,
      };
    }
    return tool;
  }

  function presentedTools(tools: RpToolMeta[]): RpToolMeta[] {
    return [
      ...tools
        .filter((tool) => !isLocalWaitTool(normalizeToolName(tool.name)))
        .map(presentTool),
      CONTEXT_BUILDER_WAIT_TOOL,
      ORACLE_SEND_WAIT_TOOL,
    ];
  }

  async function executeSearch(query: string) {
    const client = getRpClient();
    const toolCatalogFreshness = client.toolCatalogFreshness;
    const tools = presentedTools(client.tools);

    // Split query into terms and match any
    const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 0);

    const matches = tools.filter((tool) => {
      const searchText = `${tool.name} ${tool.description}`.toLowerCase();
      return terms.some((term) => searchText.includes(term));
    });

    if (matches.length === 0) {
      if (toolCatalogFreshness === "stale") {
        return {
          content: [{
            type: "text" as const,
            text: (
              `Tool catalog is stale; the last successful catalog has no tools matching "${query}", ` +
              "so this is not an authoritative negative result."
            ),
          }],
          details: {
            mode: "search",
            query,
            matches: [],
            count: 0,
            error: "catalog_stale",
            toolCatalogFreshness,
          },
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: `No tools matching "${query}"` }],
        details: { mode: "search", query, matches: [], count: 0, toolCatalogFreshness },
      };
    }

    const includesCatalogTool = matches.some((tool) => !isLocalWaitTool(normalizeToolName(tool.name)));
    let text = toolCatalogFreshness === "stale" && includesCatalogTool
      ? `${STALE_TOOL_CATALOG_WARNING}\n\n`
      : "";
    text += `## Found ${matches.length} tool(s) matching "${query}"\n\n`;

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
      details: {
        mode: "search",
        query,
        matches: matches.map((match) => match.name),
        count: matches.length,
        toolCatalogFreshness,
      },
    };
  }

  async function executeDescribe(toolName: string) {
    const client = getRpClient();
    const toolCatalogFreshness = client.toolCatalogFreshness;
    const tools = presentedTools(client.tools);
    const normalized = normalizeToolName(toolName);

    const tool = tools.find(
      (candidate) => (
        candidate.name === toolName ||
        candidate.name === normalized ||
        normalizeToolName(candidate.name) === normalized
      )
    );

    if (!tool) {
      if (toolCatalogFreshness === "stale") {
        return {
          content: [{ type: "text" as const, text: formatStaleToolAbsence(toolName) }],
          details: {
            mode: "describe",
            error: "catalog_stale",
            requestedTool: toolName,
            toolCatalogFreshness,
          },
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: `Tool "${toolName}" not found. Use rp({ search: "..." }) to search.` }],
        details: { mode: "describe", error: "not_found", requestedTool: toolName, toolCatalogFreshness },
      };
    }

    let text = toolCatalogFreshness === "stale" && !isLocalWaitTool(normalizeToolName(tool.name))
      ? `${STALE_TOOL_CATALOG_WARNING}\n\n`
      : "";
    text += `## ${tool.name}\n\n`;
    text += `${tool.description || "(no description)"}\n\n`;

    if (tool.inputSchema) {
      text += `### Parameters\n\n`;
      text += formatSchema(tool.inputSchema);
    } else {
      text += `No parameters defined.\n`;
    }

    return {
      content: [{ type: "text" as const, text }],
      details: { mode: "describe", tool, toolCatalogFreshness },
    };
  }

  type RpResponseContent =
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string };

  function buildToolCallResponse(options: {
    result: McpToolResult;
    toolName: string;
    userArgs: Record<string, unknown>;
    originalArgs?: Record<string, unknown>;
    warning?: string;
    toolCatalogFreshness: ToolCatalogFreshness;
    rpReadcache?: RpReadcacheMetaV1 | null;
    fileActionDeleteSnapshot?: string;
    contextBuilderJob?: Record<string, unknown>;
    oracleSendJob?: Record<string, unknown>;
  }) {
    const normalizedTool = normalizeToolName(options.toolName);
    const textContent = options.result.content
      .filter((content): content is { type: "text"; text: string } => content.type === "text")
      .map((content) => content.text)
      .join("\n");
    const normalizedTextResult = options.result.isError
      ? null
      : normalizeToolResultText({ toolName: normalizedTool, text: textContent });
    const normalizedFileActionResult = options.result.isError
      ? null
      : normalizeFileActionResult({
          action: options.userArgs.action,
          path: options.userArgs.path,
          content: options.userArgs.content,
          deletedContent: options.fileActionDeleteSnapshot,
        });
    const editNoop = isEditOperation(options.toolName) && isNoopEdit(textContent);
    const content: RpResponseContent[] = options.result.content.map((item) => {
      if (item.type === "text") {
        return { type: "text", text: item.text };
      }
      if (item.type === "image") {
        return { type: "image", data: item.data, mimeType: item.mimeType };
      }
      return { type: "text", text: JSON.stringify(item) };
    });
    const nonPrimaryContent: RpResponseContent[] = [];
    for (const item of options.result.content) {
      if (item.type === "text") {
        continue;
      }
      if (item.type === "image") {
        nonPrimaryContent.push({ type: "image", data: item.data, mimeType: item.mimeType });
        continue;
      }
      nonPrimaryContent.push({ type: "text", text: JSON.stringify(item) });
    }
    let responseContent = normalizedTextResult
      ? [{ type: "text" as const, text: normalizedTextResult.contentText }, ...nonPrimaryContent]
      : normalizedFileActionResult?.contentText
        ? [{ type: "text" as const, text: normalizedFileActionResult.contentText }, ...nonPrimaryContent]
        : content.length > 0
          ? content
          : [{ type: "text" as const, text: "(empty result)" }];

    if (editNoop && !options.result.isError) {
      responseContent = [
        { type: "text" as const, text: "⚠ No changes applied (no-op edit)" },
        ...responseContent,
      ];
    }

    return {
      content: responseContent,
      details: {
        mode: "call",
        tool: options.toolName,
        args: options.originalArgs,
        warning: options.warning,
        editNoop,
        toolCatalogFreshness: options.toolCatalogFreshness,
        rpReadcache: options.rpReadcache ?? undefined,
        ...(normalizedTextResult ? normalizedTextResult.details : {}),
        ...(normalizedFileActionResult ?? {}),
        ...(options.contextBuilderJob ? { contextBuilderJob: options.contextBuilderJob } : {}),
        ...(options.oracleSendJob ? { oracleSendJob: options.oracleSendJob } : {}),
      },
      isError: options.result.isError,
    };
  }

  function buildToolCallFailureResponse(options: {
    toolName: string;
    message: string;
    toolInputSchema?: unknown;
    oracleSendJob?: Record<string, unknown>;
  }) {
    let errorText = `Failed to call ${options.toolName}: ${options.message}`;
    if (options.toolInputSchema) {
      errorText += `\n\nExpected parameters:\n${formatSchema(options.toolInputSchema)}`;
    }
    return {
      content: [{ type: "text" as const, text: errorText }],
      details: {
        mode: "call",
        error: "call_failed",
        tool: options.toolName,
        message: options.message,
        ...(options.oracleSendJob ? { oracleSendJob: options.oracleSendJob } : {}),
      },
      isError: true,
    };
  }

  function missingTabBindingResponse(toolName: string, message: string) {
    return {
      content: [{ type: "text" as const, text: message }],
      details: { mode: "call", error: "missing_tab_binding", tool: toolName, message },
      isError: true,
    };
  }

  function isBackgroundStartTool(toolName: string): boolean {
    return backgroundStartProtocolFor(toolName) !== null;
  }

  function isLocalWaitTool(toolName: string): boolean {
    return localWaitToolName(toolName) !== null;
  }

  function throwContextBuilderError(code: string, message: string): never {
    throw new BackgroundJobExecutionError(code, message);
  }

  function throwOracleSendError(code: string, message: string): never {
    throw new BackgroundJobExecutionError(code, message);
  }

  function backgroundStartProtocolFor(toolName: string): BackgroundStartProtocol | null {
    if (toolName === CONTEXT_BUILDER_TOOL_NAME) {
      return {
        toolName: CONTEXT_BUILDER_TOOL_NAME,
        bindingMessage: "Context Builder requires a bound RepoPrompt tab.",
        missingTabCode: "missing_tab_binding",
        startCancelledCode: "context_builder_start_cancelled",
        startCancelledMessage: "Context Builder start was cancelled because the RepoPrompt connection changed.",
        startAbortedCode: "context_builder_start_aborted",
        startAbortedMessage: "Context Builder was cancelled before the background job started.",
        throwError: throwContextBuilderError,
      };
    }
    if (toolName === ORACLE_SEND_TOOL_NAME) {
      return {
        toolName: ORACLE_SEND_TOOL_NAME,
        bindingMessage: "Oracle send requires a bound RepoPrompt tab.",
        missingTabCode: "oracle_send_missing_tab_binding",
        startCancelledCode: "oracle_send_start_cancelled",
        startCancelledMessage: "Oracle send was cancelled because the RepoPrompt connection changed.",
        startAbortedCode: "oracle_send_start_aborted",
        startAbortedMessage: "Oracle send was cancelled before the background job started.",
        throwError: throwOracleSendError,
      };
    }
    return null;
  }

  function backgroundStartAbortedError(protocol: BackgroundStartProtocol): BackgroundJobExecutionError {
    return new BackgroundJobExecutionError(protocol.startAbortedCode, protocol.startAbortedMessage);
  }

  function throwBackgroundStartAborted(protocol: BackgroundStartProtocol): never {
    throw backgroundStartAbortedError(protocol);
  }

  async function awaitBackgroundJobStartPhase<T>(
    work: Promise<T>,
    signal: AbortSignal | undefined,
    createAbortError: () => BackgroundJobExecutionError,
  ): Promise<T> {
    if (!signal) {
      return work;
    }
    if (signal.aborted) {
      throw createAbortError();
    }

    return await new Promise<T>((resolve, reject) => {
      const handleAbort = () => reject(createAbortError());
      const removeAbortListener = () => signal.removeEventListener("abort", handleAbort);
      signal.addEventListener("abort", handleAbort, { once: true });
      void work.then(
        (value) => {
          removeAbortListener();
          resolve(value);
        },
        (error) => {
          removeAbortListener();
          reject(error);
        },
      );
    });
  }

  async function executeContextBuilderWait(
    params: RpToolParams,
    onUpdate: (
      partialResult: { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }
    ) => void,
    signal?: AbortSignal,
    ctx?: ExtensionContext,
  ) {
    const args = params.args ?? {};
    const keys = Object.keys(args);
    const jobId = typeof args.job_id === "string" ? args.job_id.trim() : "";
    if (jobId.length === 0 || keys.length !== 1 || keys[0] !== "job_id") {
      throwContextBuilderError(
        "invalid_context_builder_wait_args",
        "context_builder_wait requires exactly one non-empty string argument: job_id.",
      );
    }

    onUpdate({
      content: [{ type: "text", text: `Waiting for Context Builder job ${jobId}…` }],
      details: { mode: "call", tool: CONTEXT_BUILDER_WAIT_TOOL_NAME, status: "running", jobId },
    });

    const waitPolicy = resolveCurrentBackgroundWaitPolicy(ctx);
    const observer = steeringWaitCoordinator.registerObserver();

    try {
      const outcome = await contextBuilderJobs.wait(jobId, waitPolicy, {
        callerSignal: signal,
        steeringSignal: observer.signal,
      });
      if (outcome.status === "running") {
        return {
          content: [{
            type: "text" as const,
            text: (
              `Context Builder job "${jobId}" is still running. As your next action, call ` +
              `rp({ call: "${CONTEXT_BUILDER_WAIT_TOOL_NAME}", args: { job_id: "${jobId}" } }) again.`
            ),
          }],
          details: {
            mode: "call",
            tool: CONTEXT_BUILDER_WAIT_TOOL_NAME,
            contextBuilderJob: { jobId, status: "running", target: outcome.descriptor.target },
          },
        };
      }
      if (outcome.status === "interrupted_by_steering") {
        return {
          content: [{
            type: "text" as const,
            text: (
              `Observation of Context Builder job "${jobId}" was interrupted by accepted steering. ` +
              "The job was not cancelled or consumed; Pi will deliver the accepted message. " +
              `Respond to it, then wait again with the same job_id when appropriate.`
            ),
          }],
          details: {
            mode: "call",
            tool: CONTEXT_BUILDER_WAIT_TOOL_NAME,
            contextBuilderJob: { jobId, status: "running", target: outcome.descriptor.target },
            waitObservation: {
              result: "interrupted_by_steering",
              owner: "repoprompt-mcp",
              scope: "observer",
            },
          },
        };
      }

      if (outcome.result.isError) {
        throwContextBuilderError(
          "context_builder_tool_failed",
          extractTextContent(outcome.result.content) || "Context Builder returned an error.",
        );
      }

      return buildToolCallResponse({
        result: outcome.result,
        toolName: outcome.descriptor.toolName,
        userArgs: { ...outcome.descriptor.userArgs },
        originalArgs: { ...outcome.descriptor.userArgs },
        toolCatalogFreshness: outcome.descriptor.toolCatalogFreshness,
        contextBuilderJob: { jobId, status: "completed", target: outcome.descriptor.target },
      });
    } catch (error) {
      if (error instanceof ContextBuilderJobError) {
        throwContextBuilderError(error.code, error.message);
      }
      throw error;
    } finally {
      observer.dispose();
    }
  }

  async function executeOracleSendWait(
    params: RpToolParams,
    onUpdate: (
      partialResult: { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }
    ) => void,
    signal?: AbortSignal,
    ctx?: ExtensionContext,
  ) {
    const args = params.args ?? {};
    const keys = Object.keys(args);
    const jobId = typeof args.job_id === "string" ? args.job_id.trim() : "";
    if (jobId.length === 0 || keys.length !== 1 || keys[0] !== "job_id") {
      throwOracleSendError(
        "invalid_oracle_send_wait_args",
        "oracle_send_wait requires exactly one non-empty string argument: job_id.",
      );
    }

    onUpdate({
      content: [{ type: "text", text: `Waiting for Oracle send job ${jobId}…` }],
      details: { mode: "call", tool: ORACLE_SEND_WAIT_TOOL_NAME, status: "running", jobId },
    });

    const waitPolicy = resolveCurrentBackgroundWaitPolicy(ctx);
    const observer = steeringWaitCoordinator.registerObserver();

    try {
      const outcome = await oracleSendJobs.wait(jobId, waitPolicy, {
        callerSignal: signal,
        steeringSignal: observer.signal,
      });
      const oracleSendJob = {
        jobId,
        status: outcome.status === "interrupted_by_steering" ? "running" : outcome.status,
        target: outcome.descriptor.target,
      };
      if (outcome.status === "running") {
        return {
          content: [{
            type: "text" as const,
            text: (
              `Oracle send job "${jobId}" is still running. As your next action, call ` +
              `rp({ call: "${ORACLE_SEND_WAIT_TOOL_NAME}", args: { job_id: "${jobId}" } }) again.`
            ),
          }],
          details: { mode: "call", tool: ORACLE_SEND_WAIT_TOOL_NAME, oracleSendJob },
        };
      }
      if (outcome.status === "interrupted_by_steering") {
        return {
          content: [{
            type: "text" as const,
            text: (
              `Observation of Oracle send job "${jobId}" was interrupted by accepted steering. ` +
              "The job was not cancelled or consumed; Pi will deliver the accepted message. " +
              "Respond to it, then wait again with the same job_id when appropriate."
            ),
          }],
          details: {
            mode: "call",
            tool: ORACLE_SEND_WAIT_TOOL_NAME,
            oracleSendJob,
            waitObservation: {
              result: "interrupted_by_steering",
              owner: "repoprompt-mcp",
              scope: "observer",
            },
          },
        };
      }
      if (outcome.status === "failed") {
        return buildToolCallFailureResponse({
          toolName: outcome.descriptor.toolName,
          message: outcome.message,
          toolInputSchema: outcome.descriptor.toolInputSchema,
          oracleSendJob,
        });
      }
      return buildToolCallResponse({
        result: outcome.result,
        toolName: outcome.descriptor.toolName,
        userArgs: { ...outcome.descriptor.userArgs },
        originalArgs: { ...outcome.descriptor.userArgs },
        toolCatalogFreshness: outcome.descriptor.toolCatalogFreshness,
        oracleSendJob,
      });
    } catch (error) {
      if (error instanceof OracleSendJobError) {
        throwOracleSendError(error.code, error.message);
      }
      throw error;
    } finally {
      observer.dispose();
    }
  }

  async function executeToolCall(
    params: RpToolParams,
    operation: unknown,
    operationClassification: Extract<OperationClassification, { kind: "classified" }>,
    onUpdate: (
      partialResult: { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }
    ) => void,
    signal?: AbortSignal,
    ctx?: ExtensionContext
  ) {
    const toolName = normalizeToolName(params.call!);
    if (toolName === CONTEXT_BUILDER_WAIT_TOOL_NAME) {
      return executeContextBuilderWait(params, onUpdate, signal, ctx);
    }
    if (toolName === ORACLE_SEND_WAIT_TOOL_NAME) {
      return executeOracleSendWait(params, onUpdate, signal, ctx);
    }

    const client = getRpClient();
    const toolCatalogFreshness = client.toolCatalogFreshness;
    const tools = client.tools;

    // Validate tool exists
    const tool = tools.find(
      (candidate) => candidate.name === toolName || normalizeToolName(candidate.name) === toolName
    );

    if (!tool) {
      if (isBackgroundStartTool(toolName)) {
        const code = toolCatalogFreshness === "stale" ? "catalog_stale" : "not_found";
        const message = toolCatalogFreshness === "stale"
          ? formatStaleToolAbsence(params.call!)
          : `Tool "${params.call}" not found. Use rp({ search: "..." }) to search.`;
        if (toolName === CONTEXT_BUILDER_TOOL_NAME) {
          throwContextBuilderError(code, message);
        }
        throwOracleSendError(code, message);
      }

      if (toolCatalogFreshness === "stale") {
        return {
          content: [{ type: "text" as const, text: formatStaleToolAbsence(params.call!) }],
          details: {
            mode: "call",
            error: "catalog_stale",
            requestedTool: params.call,
            toolCatalogFreshness,
          },
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: `Tool "${params.call}" not found. Use rp({ search: "..." }) to search.` }],
        details: { mode: "call", error: "not_found", requestedTool: params.call, toolCatalogFreshness },
      };
    }

    // Check safety guards
    const guardResult = checkGuards(tool.name, params.args, config, {
      allowDelete: params.allowDelete,
      confirmEdits: params.confirmEdits,
    });

    if (!guardResult.allowed) {
      if (isBackgroundStartTool(toolName)) {
        if (toolName === CONTEXT_BUILDER_TOOL_NAME) {
          throwContextBuilderError("blocked", guardResult.reason!);
        }
        throwOracleSendError("blocked", guardResult.reason!);
      }
      return {
        content: [{ type: "text" as const, text: guardResult.reason! }],
        details: { mode: "call", error: "blocked", tool: tool.name },
      };
    }

    const userArgs = (params.args ?? {}) as Record<string, unknown>;
    const normalizedTool = normalizeToolName(tool.name);
    const backgroundProtocol = backgroundStartProtocolFor(normalizedTool);
    const concreteToolName = tool.name;
    const toolInputSchema = backgroundProtocol ? structuredClone(tool.inputSchema) : tool.inputSchema;
    const backgroundStartGeneration = backgroundProtocol ? backgroundJobLifecycleGeneration : null;
    const backgroundUserArgs = backgroundProtocol ? structuredClone(userArgs) : null;
    const forwardingClass = operationClassification.forwardingClass;
    const routingContractRequired = forwardingClass !== "route_independent";
    let routingCatalogRevision: ToolCatalogRevisionToken | null = null;
    if (routingContractRequired) {
      const contractDecision = inspectFreshRoutingContract();
      if (contractDecision.kind === "blocked") {
        if (backgroundProtocol) {
          backgroundProtocol.throwError(
            contractDecision.error === "unsupported_contract" ? "blocked" : contractDecision.error,
            contractDecision.message
          );
        }
        return {
          content: [{ type: "text" as const, text: contractDecision.message }],
          details: {
            mode: "call",
            error: contractDecision.error,
            tool: tool.name,
            toolCatalogFreshness: contractDecision.toolCatalogFreshness,
          },
          isError: true,
        };
      }
      routingCatalogRevision = contractDecision.catalogRevision;
    }
    if (forwardingClass === "route_dependent") {
      await waitForRoutePublication(signal);
    }

    let binding = getVerifiedBinding();
    let backgroundTarget: RepoPromptJobTarget | null = null;
    const tabBindingMessage =
      "RepoPrompt binding has no verified tab. Re-bind with /rp bind before calling tab-scoped tools.";
    const needsVerifiedRoute = forwardingClass === "route_dependent" && binding === null;
    const needsTabScopedBinding = backgroundProtocol !== null && !binding?.tab;

    if (needsVerifiedRoute || needsTabScopedBinding) {
      const message = backgroundProtocol ? backgroundProtocol.bindingMessage : tabBindingMessage;
      if (!backgroundProtocol) {
        return missingTabBindingResponse(tool.name, message);
      }
      if (!binding) {
        backgroundProtocol.throwError(backgroundProtocol.missingTabCode, message);
        throw new Error("Background start error helper returned unexpectedly");
      }
      if (!ctx) {
        backgroundProtocol.throwError(backgroundProtocol.missingTabCode, message);
        throw new Error("Background start error helper returned unexpectedly");
      }

      try {
        const verifiedBinding = await awaitBackgroundJobStartPhase(
          ensureTabScopedBinding(ctx, message),
          signal,
          () => backgroundStartAbortedError(backgroundProtocol),
        );
        binding = verifiedBinding;
      } catch (error) {
        if (error instanceof BackgroundJobExecutionError) {
          throw error;
        }
        if (backgroundStartGeneration !== backgroundJobLifecycleGeneration) {
          backgroundProtocol.throwError(
            backgroundProtocol.startCancelledCode,
            backgroundProtocol.startCancelledMessage,
          );
        }
        if (signal?.aborted) {
          throwBackgroundStartAborted(backgroundProtocol);
        }
        const errorMessage = error instanceof Error ? error.message : String(error);
        backgroundProtocol.throwError(backgroundProtocol.missingTabCode, errorMessage);
      }
    }

    const bypassCache = normalizedTool === "read_file" && userArgs.bypass_cache === true;
    const forwardedUserArgs = buildForwardedUserArgs({
      toolName: normalizedTool,
      userArgs: backgroundUserArgs ?? userArgs,
    });
    let dispatchLease: RouteDispatchLease | null = null;
    let backgroundIssuanceRevision: ToolCatalogRevisionToken | null = null;
    let bindingArgs: Readonly<Record<string, unknown>> = {};
    if (forwardingClass === "route_dependent" && backgroundProtocol) {
      if (!routingCatalogRevision) {
        throw new Error("Routing contract revision was not captured for background dispatch");
      }
      const issued = await issueLeasedRouteDispatch({
        callerArgs: forwardedUserArgs,
      }, (lease) => ({
        lease,
        contractDecision: inspectFreshRoutingContract(routingCatalogRevision),
      }), signal);
      if (issued.kind === "blocked" || issued.kind === "conflict") {
        return {
          content: [{ type: "text" as const, text: issued.diagnostic }],
          details: { mode: "call", error: issued.kind, tool: tool.name },
          isError: true,
        };
      }
      if (issued.request.contractDecision.kind === "blocked") {
        backgroundProtocol.throwError(
          issued.request.contractDecision.error === "unsupported_contract"
            ? "blocked"
            : issued.request.contractDecision.error,
          issued.request.contractDecision.message
        );
      }
      const decision = issued.request.lease;
      dispatchLease = decision;
      backgroundIssuanceRevision = issued.request.contractDecision.catalogRevision;
      binding = routeDispatchLeaseBinding(decision);
      bindingArgs = decision.selectors;
      if (binding.tab) {
        backgroundTarget = {
          app: binding.app,
          windowId: binding.windowId,
          tab: binding.tab,
          publicationGeneration: decision.publicationGeneration,
        };
      }
    }
    const resolvedBackgroundTarget = backgroundTarget;
    const resolvedBackgroundLease = backgroundProtocol ? dispatchLease : null;
    const resolvedBackgroundConfig = backgroundProtocol ? structuredClone(config) : null;
    const resolvedBackgroundCatalogRevision = backgroundProtocol ? backgroundIssuanceRevision : null;
    const mergedArgs = buildForwardedCallArgs({
      forwardingClass,
      userArgs: forwardedUserArgs,
      verifiedSelectors: bindingArgs,
    });

    if (backgroundProtocol) {
      if (backgroundStartGeneration !== backgroundJobLifecycleGeneration) {
        backgroundProtocol.throwError(
          backgroundProtocol.startCancelledCode,
          backgroundProtocol.startCancelledMessage,
        );
      }
      if (signal?.aborted) {
        throwBackgroundStartAborted(backgroundProtocol);
      }
      if (
        !resolvedBackgroundTarget ||
        !resolvedBackgroundLease ||
        !resolvedBackgroundConfig ||
        !resolvedBackgroundCatalogRevision ||
        !backgroundUserArgs
      ) {
        throw new Error("Background job start invariant violated");
      }
      const backgroundStartContract = inspectFreshRoutingContract(resolvedBackgroundCatalogRevision);
      if (backgroundStartContract.kind === "blocked") {
        backgroundProtocol.throwError(
          backgroundStartContract.error === "unsupported_contract"
            ? "blocked"
            : backgroundStartContract.error,
          backgroundStartContract.message
        );
      }
      const backgroundRunCatalogRevision = backgroundStartContract.catalogRevision;

      if (normalizedTool === CONTEXT_BUILDER_TOOL_NAME) {
        try {
          const started = contextBuilderJobs.start({
            descriptor: {
              target: resolvedBackgroundTarget,
              toolName: concreteToolName,
              userArgs: backgroundUserArgs,
              toolCatalogFreshness,
            },
            run: (jobSignal) => {
              const runContract = inspectFreshRoutingContract(backgroundRunCatalogRevision);
              if (runContract.kind === "blocked") {
                throw new Error(runContract.message);
              }
              return executeLeasedRouteDependentCall(
                resolvedBackgroundLease,
                resolvedBackgroundConfig,
                client,
                () => client.callTool(concreteToolName, mergedArgs, undefined, jobSignal)
              );
            },
          });
          const jobId = started.jobId;
          return {
            content: [{
              type: "text" as const,
              text: (
                `Context Builder started in the background. Job ID: "${jobId}". Call ` +
                `rp({ call: "${CONTEXT_BUILDER_WAIT_TOOL_NAME}", args: { job_id: "${jobId}" } }) ` +
                "to retrieve the result."
              ),
            }],
            details: {
              mode: "call",
              tool: concreteToolName,
              contextBuilderJob: { jobId, status: "running", target: started.descriptor.target },
              toolCatalogFreshness,
            },
          };
        } catch (error) {
          if (error instanceof ContextBuilderJobError) {
            throwContextBuilderError(error.code, error.message);
          }
          throw error;
        }
      }

      try {
        const started = oracleSendJobs.start({
          descriptor: {
            target: resolvedBackgroundTarget,
            toolName: concreteToolName,
            userArgs: backgroundUserArgs,
            toolCatalogFreshness,
            toolInputSchema,
          },
          run: (jobSignal) => {
            const runContract = inspectFreshRoutingContract(backgroundRunCatalogRevision);
            if (runContract.kind === "blocked") {
              throw new Error(runContract.message);
            }
            return executeLeasedRouteDependentCall(
              resolvedBackgroundLease,
              resolvedBackgroundConfig,
              client,
              () => client.callTool(concreteToolName, mergedArgs, undefined, jobSignal)
            );
          },
        });
        const jobId = started.jobId;
        return {
          content: [{
            type: "text" as const,
            text: (
              `Oracle send started in the background. Job ID: "${jobId}". Call ` +
              `rp({ call: "${ORACLE_SEND_WAIT_TOOL_NAME}", args: { job_id: "${jobId}" } }) ` +
              "to retrieve the result."
            ),
          }],
          details: {
            mode: "call",
            tool: concreteToolName,
            oracleSendJob: { jobId, status: "running", target: started.descriptor.target },
            toolCatalogFreshness,
          },
        };
      } catch (error) {
        if (error instanceof OracleSendJobError) {
          throwOracleSendError(error.code, error.message);
        }
        throw error;
      }
    }

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
      const agentRunClassification = normalizedTool === "agent_run" && supportsObserverInterruptibleAgentWait(activeApp)
        ? classifyAgentRunCall(userArgs)
        : null;
      let result: McpToolResult;
      if (agentRunClassification?.kind === "steerable_wait") {
        const waitPolicy = resolveCurrentBackgroundWaitPolicy(ctx);
        const toolCallTimeoutMs = config.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS;
        const timeout = resolveAgentRunObservationTimeoutSeconds({ waitPolicy, toolCallTimeoutMs });
        const agentRunArgs = { ...mergedArgs, timeout };
        const observer = steeringWaitCoordinator.registerObserver();
        const lifecycleSignal = connectionLifecycleController.signal;
        try {
          const observed = await runObserverInterruptibleCall({
            run: (requestSignal) => client.callTool(tool.name, agentRunArgs, toolCallTimeoutMs, requestSignal),
            steeringSignal: observer.signal,
            callerSignal: signal,
            lifecycleSignal,
          });
          if (observed.kind === "interrupted_by_steering") {
            const sessionIds = agentRunClassification.target.kind === "single"
              ? [agentRunClassification.target.sessionId]
              : [...agentRunClassification.target.sessionIds];
            return {
              content: [{
                type: "text" as const,
                text: (
                  "Observation of the explicit RepoPrompt agent wait was interrupted by accepted steering. " +
                  "No agent_run cancel operation was sent; Pi will deliver the accepted message. " +
                  "Respond to it, then repeat the same explicit wait with these session IDs when appropriate: " +
                  sessionIds.join(", ")
                ),
              }],
              details: {
                mode: "call",
                tool: tool.name,
                toolCatalogFreshness,
                waitObservation: {
                  result: "interrupted_by_steering",
                  owner: "repoprompt-mcp",
                  scope: "observer",
                  sessionIds,
                },
              },
            };
          }
          result = observed.value;
        } finally {
          observer.dispose();
        }
      } else if (isRoutingMutationClass(forwardingClass)) {
        if (!routingCatalogRevision) {
          throw new Error("Routing contract revision was not captured for mutation dispatch");
        }
        const expectedContextId = normalizedTool === "bind_context"
          && operation === "bind"
          && typeof userArgs.context_id === "string"
          ? userArgs.context_id
          : null;
        const mutation = await executeRoutingMutation({
          operationLabel: `${normalizedTool} ${String(operation)}`,
          operationClass: forwardingClass,
          config,
          client,
          signal,
          issuanceGuard: routingMutationIssuanceGuard(routingCatalogRevision),
          ...(expectedContextId
            ? { expectedBoundContext: { contextId: expectedContextId } }
            : {}),
          dispatch: () => client.callTool(tool.name, mergedArgs, undefined, signal),
          reconcile: (inventory) => reconcileObservedInventoryRoute(pi, config, inventory, signal),
        });
        if (mutation.kind === "blocked") {
          return {
            content: [{ type: "text" as const, text: mutation.diagnostic }],
            details: { mode: "call", error: mutation.error, tool: tool.name },
            isError: true,
          };
        }
        if (mutation.kind === "failed") {
          const failureResponse = buildToolCallResponse({
            result: mutation.result,
            toolName: tool.name,
            userArgs,
            originalArgs: params.args,
            warning: guardResult.warning,
            toolCatalogFreshness,
          });
          return {
            ...failureResponse,
            details: {
              ...failureResponse.details,
              error: "routing_mutation_failed",
              routingReconciliation: {
                cause: mutation.cause,
                priorAuthorityPreserved: mutation.priorAuthorityPreserved,
                upstreamIsError: true,
              },
            },
          };
        }
        if (mutation.kind === "superseded") {
          const failureResponse = buildToolCallResponse({
            result: {
              ...mutation.result,
              isError: true,
              content: [
                ...mutation.result.content,
                {
                  type: "text",
                  text:
                    `${mutation.diagnostic}. The upstream mutation may have partially succeeded, ` +
                    "but newer routing authority remains authoritative.",
                },
              ],
            },
            toolName: tool.name,
            userArgs,
            originalArgs: params.args,
            warning: guardResult.warning,
            toolCatalogFreshness,
          });
          return {
            ...failureResponse,
            details: {
              ...failureResponse.details,
              error: "routing_mutation_superseded",
              routingReconciliation: {
                cause: mutation.cause,
                possiblePartialSuccess: mutation.possiblePartialSuccess,
                upstreamIsError: false,
              },
            },
          };
        }
        if (mutation.kind === "quarantined") {
          const failureResponse = buildToolCallResponse({
            result: {
              ...mutation.result,
              isError: true,
              content: [
                ...mutation.result.content,
                {
                  type: "text",
                  text:
                    "RepoPrompt routing state was quarantined because post-operation observation failed. " +
                    `The requested operation could not be verified: ${mutation.diagnostic}. ` +
                    "The upstream mutation may have partially succeeded. Run /rp reconnect or bind " +
                    "explicitly before another route-dependent call.",
                },
              ],
            },
            toolName: tool.name,
            userArgs,
            originalArgs: params.args,
            warning: guardResult.warning,
            toolCatalogFreshness,
          });
          return {
            ...failureResponse,
            details: {
              ...failureResponse.details,
              error: "routing_reconciliation_failed",
              routingReconciliation: {
                cause: "post_mutation_observation_failed",
                possiblePartialSuccess: true,
                upstreamIsError: mutation.result.isError === true,
              },
            },
          };
        }
        result = mutation.result;
      } else if (forwardingClass === "route_dependent") {
        if (!routingCatalogRevision) {
          throw new Error("Routing contract revision was not captured for route-dependent dispatch");
        }
        const issued = await issueLeasedRouteDispatch({
          callerArgs: forwardedUserArgs,
        }, (lease) => {
          const issuanceDecision = inspectFreshRoutingContract(routingCatalogRevision);
          if (issuanceDecision.kind === "blocked") {
            return { kind: "blocked" as const, decision: issuanceDecision };
          }
          const dispatchArgs = buildForwardedCallArgs({
            forwardingClass,
            userArgs: forwardedUserArgs,
            verifiedSelectors: lease.selectors,
          });
          return {
            kind: "started" as const,
            request: executeLeasedRouteDependentCall(
              lease,
              config,
              client,
              () => client.callTool(tool.name, dispatchArgs, undefined, signal)
            ),
          };
        }, signal);
        if (issued.kind === "blocked" || issued.kind === "conflict") {
          return {
            content: [{ type: "text" as const, text: issued.diagnostic }],
            details: { mode: "call", error: issued.kind, tool: tool.name },
            isError: true,
          };
        }
        if (issued.request.kind === "blocked") {
          return {
            content: [{ type: "text" as const, text: issued.request.decision.message }],
            details: {
              mode: "call",
              error: issued.request.decision.error,
              tool: tool.name,
            },
            isError: true,
          };
        }
        dispatchLease = issued.lease;
        bindingArgs = issued.lease.selectors;
        result = await issued.request.request;
      } else {
        result = await client.callTool(tool.name, mergedArgs, undefined, signal);
      }

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
          dispatchLease ? routeDispatchLeaseBinding(dispatchLease) : null,
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

      if (shouldAutoSelectRead
        && !result.isError
        && dispatchLease
        && routeDispatchLeaseIsCurrent(dispatchLease)) {
        const selectionBinding = routeDispatchLeaseBinding(dispatchLease);
        const selectionLease = dispatchLease;
        try {
          await runAutoSelectionUpdate(async () => {
            if (!routeDispatchLeaseIsCurrent(selectionLease)) {
              return;
            }
            await autoSelectReadFileInRepoPromptSelection(
              ctx,
              selectionBinding,
              pathArg,
              startLine,
              limit,
              selectionLease.selectors
            );
          });
        } catch {
          // Fail-open
        }
      }

      return buildToolCallResponse({
        result,
        toolName: tool.name,
        userArgs,
        originalArgs: params.args,
        warning: guardResult.warning,
        toolCatalogFreshness,
        rpReadcache,
        fileActionDeleteSnapshot,
      });
    } catch (error) {
      if (error instanceof ObserverInterruptControlError) {
        const message = error.code === "caller_aborted"
          ? "The current agent wait request was cancelled; no child cancellation was requested."
          : "The RepoPrompt connection lifecycle changed during the agent wait; no child cancellation was requested.";
        return {
          content: [{ type: "text" as const, text: message }],
          details: {
            mode: "call",
            error: error.code,
            tool: tool.name,
            waitObservation: {
              result: error.code,
              owner: "repoprompt-mcp",
              scope: "observer",
            },
          },
          isError: true,
        };
      }
      return buildToolCallFailureResponse({
        toolName: tool.name,
        message: error instanceof Error ? error.message : String(error),
        toolInputSchema: tool.inputSchema,
      });
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
    const observedWindow = windows.find((window) => window.id === binding.windowId);
    if (observedWindow) {
      return observedWindow;
    }
    if (!ctx.hasUI) {
      throw new Error(
        `RepoPrompt window ${binding.windowId} is not present in the observed inventory. Re-bind before choosing a tab`
      );
    }
    return windows.length > 0 ? await promptForWindowSelection(ctx, windows) : null;
  }

  if (!ctx.hasUI) {
    throw new Error("Not bound to any RepoPrompt window. Use /rp bind <window_id> first");
  }

  const windows = await fetchWindows(pi, config);
  return windows.length > 0 ? await promptForWindowSelection(ctx, windows) : null;
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
  onConnected: ((app: RpAppId) => void) | undefined,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();

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
  await client.connect(server.command, server.args, targetConfig.env, config.toolCallTimeoutMs, signal);
  signal.throwIfAborted();
  await establishRoutingInventoryContract(config, client, signal);
  signal.throwIfAborted();
  onConnected?.(app);

  // Notify connection
  if (ctx.hasUI) {
    ctx.ui.notify(`${getAppLabel(config, app)}: connected (${client.tools.length} tools)`, "info");
  }
}

/**
 * Auto-detect and bind a window after a connection is established
 *
 * Runs outside the serialized connection transition because window and tab discovery are
 * long-running RepoPrompt operations that must never block an explicit reconnect or app switch
 */
function guardRoutePublication(
  issuanceGuard: RoutingMutationIssuanceGuard,
  expectedPublicationGeneration: number
): RoutingMutationIssuanceGuard {
  return {
    validate() {
      const issuance = issuanceGuard.validate();
      if (issuance.kind === "blocked") {
        return issuance;
      }
      return routeStore.ownsPublicationGeneration(expectedPublicationGeneration)
        ? { kind: "allowed" as const }
        : {
            kind: "blocked" as const,
            error: "route_superseded",
            diagnostic: "A newer RepoPrompt route superseded automatic startup binding",
          };
    },
  };
}

async function autoBindAfterConnect(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: RpConfig,
  signal: AbortSignal,
  issuanceGuard: RoutingMutationIssuanceGuard,
): Promise<void> {
  const app = config.activeApp;
  signal.throwIfAborted();

  const existingBinding = getBinding();
  if (config.autoBindOnStart && !getVerifiedBinding() && !existingBinding?.tab) {
    try {
      const detectionGeneration = routeStore.snapshotPublicationGeneration();
      const detection = await autoDetectAndBind(
        pi,
        config,
        signal,
        undefined,
        detectionGeneration
      );
      signal.throwIfAborted();
      if (detection.kind === "superseded") {
        return;
      }
      const { windows } = detection;

      if (detection.binding) {
        const verifiedBinding = detection.binding.tab
          ? detection.binding
          : await ensureBindingHasTab(
              pi,
              ctx,
              config,
              undefined,
              { reuseSoleEmptyTab: true },
              signal,
              guardRoutePublication(issuanceGuard, detection.publicationGeneration)
            );
        if (!verifiedBinding) {
          throw new Error("Automatic startup binding did not produce a verified tab");
        }
        signal.throwIfAborted();
        if (ctx.hasUI) {
          const tabLabel = await resolveLiveBindingTabLabel(verifiedBinding, config);
          signal.throwIfAborted();
          ctx.ui.notify(
            `${getAppLabel(config, app)}: auto-bound to window ${verifiedBinding.windowId}` +
              ` (${verifiedBinding.workspace ?? "unknown"})` +
              (tabLabel ? `, tab "${tabLabel}"` : ""),
            "info"
          );
        }
      } else if (detection.ambiguity && detection.ambiguity.candidates.length > 0 && ctx.hasUI) {
        const selected = await promptForWindowSelection(ctx, detection.ambiguity.candidates);
        signal.throwIfAborted();

        if (selected) {
          const chosenBinding = await bindToWindow(
            pi,
            selected.id,
            undefined,
            config,
            undefined,
            signal,
            ctx,
            issuanceGuard
          );
          signal.throwIfAborted();
          const tabLabel = await resolveLiveBindingTabLabel(chosenBinding, config);
          signal.throwIfAborted();
          ctx.ui.notify(
            `${getAppLabel(config, app)}: bound to window ${chosenBinding.windowId}` +
            ` (${chosenBinding.workspace ?? "unknown"})` +
            (tabLabel ? `, tab "${tabLabel}"` : ""),
            "info"
          );
        } else {
          const candidatesText = detection.ambiguity.candidates
            .map((w) => `${w.id}: ${w.workspace}`)
            .join(", ");

          ctx.ui.notify(
            `${getAppLabel(config, app)}: multiple matching windows for cwd (${candidatesText}). ` +
              "Use /rp bind to choose from the interactive picker.",
            "warning"
          );
        }
      } else if (detection.rootsUnavailableWindowIds && ctx.hasUI) {
        ctx.ui.notify(
          `${getAppLabel(config, app)}: cannot auto-bind because roots are unavailable for windows ` +
            detection.rootsUnavailableWindowIds.join(", "),
          "warning"
        );
      } else if (windows.length > 0 && ctx.hasUI) {
        ctx.ui.notify(
          `${getAppLabel(config, app)}: ${windows.length} window(s) available. ` +
            "Use /rp bind for the interactive picker or rp({ windows: true }) for the raw list",
          "info"
        );
      }
    } catch (err) {
      signal.throwIfAborted();
      if (err instanceof RoutingMutationBlockedError && err.code === "route_superseded") {
        return;
      }
      const diagnostic = err instanceof Error ? err.message : String(err);
      console.warn(
        `[repoprompt-mcp] app=${app} route=intent operation_class=startup_auto_bind ` +
        `cause=bind_failed: ${diagnostic.split(/\r?\n/u, 1)[0]}`
      );
      if (ctx.hasUI) {
        ctx.ui.notify(
          `${getAppLabel(config, app)}: automatic tab binding failed. Run /rp bind to choose a tab.`,
          "warning"
        );
      }
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
