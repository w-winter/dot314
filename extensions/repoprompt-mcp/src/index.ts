// index.ts - RepoPrompt MCP Extension for Pi
//
// First-class RepoPrompt integration with:
// - Auto-detection of matching windows based on cwd
// - Syntax highlighting for code blocks
// - Delta-powered diff highlighting (with graceful fallback)
// - Safety guards for destructive operations
// - Persistent window binding across sessions

import * as path from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolRenderResultOptions,
  Theme,
} from "@mariozechner/pi-coding-agent";
import { Text, matchesKey, visibleWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

import type {
  RpToolParams,
  RpConfig,
  RpBinding,
  RpWindow,
  RpToolMeta,
  McpContent,
  AutoSelectionEntryData,
  AutoSelectionEntrySliceData,
  AutoSelectionEntryRangeData,
} from "./types.js";
import { AUTO_SELECTION_ENTRY_TYPE } from "./types.js";
import { loadConfig, getServerCommand } from "./config.js";
import { getRpClient, resetRpClient } from "./client.js";
import {
  getBinding,
  clearBinding,
  restoreBinding,
  autoDetectAndBind,
  bindToWindow,
  fetchWindows,
  getBindingArgs,
} from "./binding.js";
import { renderRpOutput, prepareCollapsedView } from "./render.js";
import { checkGuards, normalizeToolName, isNoopEdit, isEditOperation } from "./guards.js";
import { extractJsonContent, extractTextContent } from "./mcp-json.js";
import { resolveToolName } from "./tool-names.js";

import { readFileWithCache } from "./readcache/read-file.js";
import { RP_READCACHE_CUSTOM_TYPE, SCOPE_FULL, scopeRange } from "./readcache/constants.js";
import { buildInvalidationV1 } from "./readcache/meta.js";
import { clearReplayRuntimeState, createReplayRuntimeState } from "./readcache/replay.js";
import type { RpReadcacheMetaV1, ScopeKey } from "./readcache/types.js";
import { getStoreStats, pruneObjectsOlderThan } from "./readcache/object-store.js";
import { resolveReadFilePath } from "./readcache/resolve.js";

import {
  computeSliceRangeFromReadArgs,
  countFileLines,
  inferSelectionStatus,
  toPosixPath,
} from "./auto-select.js";

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

  // Formatting
  raw: Type.Optional(Type.Boolean({ description: "Return raw output without formatting" })),
});

// ─────────────────────────────────────────────────────────────────────────────
// Extension Entry Point
// ─────────────────────────────────────────────────────────────────────────────

export default function repopromptMcp(pi: ExtensionAPI) {
  let config: RpConfig = loadConfig();
  let initPromise: Promise<void> | null = null;

  pi.on("before_agent_start", async () => {
    // Reload config so display knobs (collapsedMaxLines etc.) apply without requiring /reload
    config = loadConfig();
  });

  // Replay-aware read_file caching state (optional; guarded by config.readcacheReadFile)
  const readcacheRuntimeState = createReplayRuntimeState();

  const clearReadcacheCaches = (): void => {
    clearReplayRuntimeState(readcacheRuntimeState);
  };

  let activeAutoSelectionState: AutoSelectionEntryData | null = null;

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
      const last = merged[merged.length - 1];
      if (!last) {
        merged.push(range);
        continue;
      }

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
      const pathKey = toPosixPath(String(item.path ?? "").trim());
      if (!pathKey || fullSet.has(pathKey)) {
        continue;
      }

      const existing = sliceMap.get(pathKey) ?? [];
      existing.push(...normalizeAutoSelectionRanges(item.ranges ?? []));
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
      windowId: binding.windowId,
      tab: binding.tab,
      workspace: binding.workspace ?? workspace,
      fullPaths,
      slicePaths,
    });
  }

  function getAutoSelectionStateFromBranch(
    ctx: ExtensionContext,
    binding: RpBinding
  ): AutoSelectionEntryData {
    const entries = ctx.sessionManager.getBranch();

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

    return makeEmptyAutoSelectionState(binding);
  }

  function persistAutoSelectionState(state: AutoSelectionEntryData): void {
    const normalized = normalizeAutoSelectionState(state);
    activeAutoSelectionState = normalized;
    pi.appendEntry(AUTO_SELECTION_ENTRY_TYPE, normalized);
  }

  function bindingArgsForAutoSelectionState(state: AutoSelectionEntryData): Record<string, unknown> {
    return {
      _windowID: state.windowId,
      ...(state.tab ? { _tabID: state.tab } : {}),
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

    await client.callTool(manageSelectionToolName, {
      op: "remove",
      paths,
      ...bindingArgsForAutoSelectionState(state),
    });
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

    await client.callTool(manageSelectionToolName, {
      op: "add",
      mode: "full",
      paths,
      ...bindingArgsForAutoSelectionState(state),
    });
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

    await client.callTool(manageSelectionToolName, {
      op: "add",
      slices,
      ...bindingArgsForAutoSelectionState(state),
    });
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
    desiredState: AutoSelectionEntryData | null
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
        currentState.windowId === desiredState.windowId &&
        sameOptionalTab(currentState.tab, desiredState.tab);

      if (sameBinding) {
        await reconcileAutoSelectionWithinBinding(client, manageSelectionToolName, currentState, desiredState);
        return;
      }

      try {
        await removeAutoSelectionPaths(
          client,
          manageSelectionToolName,
          currentState,
          autoSelectionManagedPaths(currentState)
        );
      } catch {
        // Old binding/window may no longer exist after RepoPrompt app restart
      }

      await addAutoSelectionFullPaths(client, manageSelectionToolName, desiredState, desiredState.fullPaths);
      await addAutoSelectionSlices(client, manageSelectionToolName, desiredState, desiredState.slicePaths);
      return;
    }

    if (currentState && !desiredState) {
      try {
        await removeAutoSelectionPaths(
          client,
          manageSelectionToolName,
          currentState,
          autoSelectionManagedPaths(currentState)
        );
      } catch {
        // Old binding/window may no longer exist after RepoPrompt app restart
      }
      return;
    }

    if (!currentState && desiredState) {
      await addAutoSelectionFullPaths(client, manageSelectionToolName, desiredState, desiredState.fullPaths);
      await addAutoSelectionSlices(client, manageSelectionToolName, desiredState, desiredState.slicePaths);
    }
  }

  async function ensureBindingTargetsLiveWindow(ctx: ExtensionContext): Promise<RpBinding | null> {
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
      windows = await fetchWindows(pi);
    } catch {
      return binding;
    }

    if (windows.length === 0) {
      return binding;
    }

    if (windows.some((w) => w.id === binding.windowId)) {
      return binding;
    }

    if (!binding.workspace) {
      clearBinding();
      return null;
    }

    const workspaceMatches = windows.filter((w) => w.workspace === binding.workspace);

    if (workspaceMatches.length === 1) {
      const match = workspaceMatches[0];

      try {
        const rebound = await bindToWindow(pi, match.id, binding.tab, config);
        return rebound;
      } catch {
        clearBinding();
        return null;
      }
    }

    clearBinding();

    if (ctx.hasUI) {
      if (workspaceMatches.length > 1) {
        ctx.ui.notify(
          `RepoPrompt: binding for workspace "${binding.workspace}" is ambiguous after restart. Re-bind with /rp bind.`,
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

  async function syncAutoSelectionToCurrentBranch(ctx: ExtensionContext): Promise<void> {
    if (config.autoSelectReadSlices !== true) {
      activeAutoSelectionState = null;
      return;
    }

    const binding = await ensureBindingTargetsLiveWindow(ctx);
    const desiredState = binding ? getAutoSelectionStateFromBranch(ctx, binding) : null;

    try {
      await reconcileAutoSelectionStates(activeAutoSelectionState, desiredState);
    } catch {
      // Fail-open
    }

    activeAutoSelectionState = desiredState;
  }

  function updateAutoSelectionStateAfterFullRead(binding: RpBinding, selectionPath: string): void {
    const normalizedPath = toPosixPath(selectionPath);

    const baseState = sameBindingForAutoSelection(binding, activeAutoSelectionState)
      ? (activeAutoSelectionState as AutoSelectionEntryData)
      : makeEmptyAutoSelectionState(binding);

    const nextState: AutoSelectionEntryData = {
      ...baseState,
      fullPaths: [...baseState.fullPaths, normalizedPath],
      slicePaths: baseState.slicePaths.filter((entry) => entry.path !== normalizedPath),
    };

    const normalizedNext = normalizeAutoSelectionState(nextState);
    if (autoSelectionStatesEqual(baseState, normalizedNext)) {
      activeAutoSelectionState = normalizedNext;
      return;
    }

    persistAutoSelectionState(normalizedNext);
  }

  function mergedRangesForSliceRead(
    binding: RpBinding,
    selectionPath: string,
    range: AutoSelectionEntryRangeData
  ): AutoSelectionEntryRangeData[] | null {
    const normalizedPath = toPosixPath(selectionPath);

    const baseState = sameBindingForAutoSelection(binding, activeAutoSelectionState)
      ? (activeAutoSelectionState as AutoSelectionEntryData)
      : makeEmptyAutoSelectionState(binding);

    if (baseState.fullPaths.includes(normalizedPath)) {
      return null;
    }

    const existing = baseState.slicePaths.find((entry) => entry.path === normalizedPath);
    return normalizeAutoSelectionRanges([...(existing?.ranges ?? []), range]);
  }

  function updateAutoSelectionStateAfterSliceRead(
    binding: RpBinding,
    selectionPath: string,
    range: AutoSelectionEntryRangeData
  ): void {
    const normalizedPath = toPosixPath(selectionPath);

    const baseState = sameBindingForAutoSelection(binding, activeAutoSelectionState)
      ? (activeAutoSelectionState as AutoSelectionEntryData)
      : makeEmptyAutoSelectionState(binding);

    if (baseState.fullPaths.includes(normalizedPath)) {
      return;
    }

    const existing = baseState.slicePaths.find((entry) => entry.path === normalizedPath);

    const nextSlicePaths = baseState.slicePaths.filter((entry) => entry.path !== normalizedPath);
    nextSlicePaths.push({
      path: normalizedPath,
      ranges: [...(existing?.ranges ?? []), range],
    });

    const nextState: AutoSelectionEntryData = {
      ...baseState,
      fullPaths: [...baseState.fullPaths],
      slicePaths: nextSlicePaths,
    };

    const normalizedNext = normalizeAutoSelectionState(nextState);
    if (autoSelectionStatesEqual(baseState, normalizedNext)) {
      activeAutoSelectionState = normalizedNext;
      return;
    }

    persistAutoSelectionState(normalizedNext);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Lifecycle Events
  // ───────────────────────────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) {
      // This extension used to set a status bar item; clear it to avoid persisting stale UI state
      ctx.ui.setStatus("rp", undefined);
    }

    const restoredBinding = restoreBinding(ctx, config);
    activeAutoSelectionState =
      config.autoSelectReadSlices === true && restoredBinding
        ? getAutoSelectionStateFromBranch(ctx, restoredBinding)
        : null;

    // Best-effort stale cache pruning (only when readcache is enabled)
    if (config.readcacheReadFile === true) {
      void pruneObjectsOlderThan(ctx.cwd).catch(() => {
        // Fail-open
      });
    }

    // Non-blocking initialization
    initPromise = initializeExtension(pi, ctx, config);

    initPromise.then(async () => {
      initPromise = null;
      await syncAutoSelectionToCurrentBranch(ctx);
    }).catch((err) => {
      console.error("RepoPrompt MCP initialization failed:", err);
      initPromise = null;
      if (ctx.hasUI) {
        ctx.ui.notify(`RepoPrompt: ${err.message}`, "error");
      }
    });
  });

  pi.on("session_compact", async () => {
    clearReadcacheCaches();
  });

  pi.on("session_shutdown", async () => {
    if (initPromise) {
      try {
        await initPromise;
      } catch {
        // Ignore
      }
    }

    clearReadcacheCaches();
    activeAutoSelectionState = null;
    await resetRpClient();
  });

  pi.on("session_switch", async (_event: unknown, ctx: ExtensionContext) => {
    clearReadcacheCaches();
    restoreBinding(ctx, config);
    await syncAutoSelectionToCurrentBranch(ctx);
    if (ctx.hasUI) {
      ctx.ui.setStatus("rp", undefined);
    }
  });

  // Restore binding from the current branch on /fork navigation
  pi.on("session_fork", async (_event: unknown, ctx: ExtensionContext) => {
    clearReadcacheCaches();
    restoreBinding(ctx, config);
    await syncAutoSelectionToCurrentBranch(ctx);
    if (ctx.hasUI) {
      ctx.ui.setStatus("rp", undefined);
    }
  });

  // Backwards compatibility (older pi versions)
  (pi as any).on("session_branch", async (_event: unknown, ctx: ExtensionContext) => {
    clearReadcacheCaches();
    restoreBinding(ctx, config);
    await syncAutoSelectionToCurrentBranch(ctx);
    if (ctx.hasUI) {
      ctx.ui.setStatus("rp", undefined);
    }
  });

  pi.on("session_tree", async (_event: unknown, ctx: ExtensionContext) => {
    clearReadcacheCaches();
    restoreBinding(ctx, config);
    await syncAutoSelectionToCurrentBranch(ctx);
    if (ctx.hasUI) {
      ctx.ui.setStatus("rp", undefined);
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Commands
  // ───────────────────────────────────────────────────────────────────────────

  pi.registerCommand("rp", {
    description: "RepoPrompt status and commands. Usage: /rp [status|windows|bind [id]|oracle|reconnect|readcache-status|readcache-refresh]",
    handler: async (args, ctx) => {
      const parts = args?.trim().split(/\s+/) ?? [];
      const subcommand = parts[0]?.toLowerCase() ?? "status";

      // Allow status/readcache-status/readcache-refresh/reconnect while disconnected
      if (
        subcommand !== "reconnect" &&
        subcommand !== "status" &&
        subcommand !== "readcache-status" &&
        subcommand !== "readcache_status" &&
        subcommand !== "readcache-refresh" &&
        subcommand !== "readcache_refresh"
      ) {
        await ensureConnected(ctx);
      }

      switch (subcommand) {
        case "status":
          await showStatus(ctx);
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
          const tab = windowIdArg ? parts[2] : undefined;

          let windowId: number | null = null;

          if (!windowIdArg) {
            if (!ctx.hasUI) {
              console.error("Usage: /rp bind <window_id> [tab]");
              return;
            }

            try {
              const windows = await fetchWindows(pi);
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
            const binding = await bindToWindow(pi, windowId, tab, config);
            await syncAutoSelectionToCurrentBranch(ctx);
            ctx.ui.notify(
              `Bound to window ${binding.windowId}` +
              (binding.workspace ? ` (${binding.workspace})` : "") +
              (binding.tab ? `, tab "${binding.tab}"` : ""),
              "info"
            );
          } catch (err) {
            ctx.ui.notify(`Failed to bind: ${err instanceof Error ? err.message : err}`, "error");
          }
          break;
        }

        case "oracle": {
          const rawArgs = args?.trim() ?? "";
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

            messageParts.push(token ?? "");
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
          const binding = getBinding();

          if (!binding) {
            ctx.ui.notify("RepoPrompt is not bound. Use /rp bind first.", "error");
            return;
          }

          try {
            const chatSendToolName = resolveToolName(client.tools, "chat_send");
            if (!chatSendToolName) {
              ctx.ui.notify("RepoPrompt tool 'chat_send' not available", "error");
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

            const result = await client.callTool(chatSendToolName, callArgs);

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

        case "reconnect":
          try {
            await resetRpClient();
            await initializeExtension(pi, ctx, config);
            await syncAutoSelectionToCurrentBranch(ctx);
            ctx.ui.notify("RepoPrompt reconnected", "info");
          } catch (err) {
            ctx.ui.notify(`Reconnection failed: ${err instanceof Error ? err.message : err}`, "error");
          }
          break;

        default:
          ctx.ui.notify(
            "RepoPrompt commands:\n" +
            "  /rp status                               - Show connection and binding status\n" +
            "  /rp windows                              - List available windows\n" +
            "  /rp bind                                 - Pick a window to bind (interactive)\n" +
            "  /rp bind <id> [tab]                      - Bind to a specific window\n" +
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
      return executeStatus();
    },

    renderCall(args: Record<string, unknown>, theme: Theme) {
      let text = theme.fg("toolTitle", theme.bold("rp"));

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
      const mode = details.mode as string | undefined;

      // Get text content
      const textContent = result.content
        .filter((c) => c.type === "text")
        .map((c) => c.text || "")
        .join("\n");

      // Handle partial/streaming state
      if (options.isPartial) {
        return new Text(theme.fg("warning", "Running…"), 0, 0);
      }

      // Handle errors (check both result.isError and details.isError)
      const isError = result.isError || details.isError;
      if (isError) {
        return new Text(theme.fg("error", "↳ " + textContent), 0, 0);
      }

      // Handle raw mode
      if (details.raw) {
        return new Text(textContent, 0, 0);
      }

      // Success case - apply rendering
      const successPrefix = theme.fg("success", "↳ ");

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

      const collapsedMaxLines = config.collapsedMaxLines;

      // Collapsed view
      if (!options.expanded) {
        const { content, truncated, totalLines } = prepareCollapsedView(
          textContent,
          theme,
          collapsedMaxLines
        );

        const maxLines = collapsedMaxLines ?? 15;

        if (maxLines === 0) {
          const remaining = totalLines;
          const hidden = theme.fg("muted", "(output hidden)");
          const moreText = remaining > 0 ? theme.fg("muted", `\n… (${remaining} more lines)`) : "";
          return new Text(`${successPrefix}${hidden}${moreText}`, 0, 0);
        }

        if (truncated) {
          const remaining = totalLines - maxLines;
          const moreText = theme.fg("muted", `\n… (${remaining} more lines)`);
          return new Text(`${prefixFirstLine(content, successPrefix)}${moreText}`, 0, 0);
        }

        return new Text(prefixFirstLine(content, successPrefix), 0, 0);
      }

      // Expanded view - full rendering
      const highlighted = renderRpOutput(textContent, theme);
      return new Text(`${successPrefix}\n${highlighted}`, 0, 0);
    },
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Helper Functions
  // ───────────────────────────────────────────────────────────────────────────

  async function ensureConnected(ctx?: ExtensionContext): Promise<void> {
    if (initPromise) {
      await initPromise;
    }

    const client = getRpClient();
    if (client.isConnected) {
      return;
    }

    // Lazy reconnect: allow the user to install/configure RepoPrompt after Pi starts
    // and have `rp(...)` work without requiring a restart.
    config = loadConfig();

    const server = getServerCommand(config);
    if (!server) {
      throw new Error(
        "RepoPrompt MCP server not found. Install RepoPrompt / rp-mcp-server, or configure ~/.pi/agent/extensions/repoprompt-mcp.json (or ~/.pi/agent/mcp.json)"
      );
    }

    await client.connect(server.command, server.args, config.env);

    if (ctx) {
      try {
        await syncAutoSelectionToCurrentBranch(ctx);
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

  function parseSelectionSummaryFromJson(
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

    for (const candidate of candidates) {
      const fileCount = parseNumber(candidate.fileCount ?? candidate.files ?? candidate.file_count);
      const tokens = parseNumber(candidate.tokens ?? candidate.totalTokens ?? candidate.total_tokens);

      if (fileCount !== undefined || tokens !== undefined) {
        return { fileCount, tokens };
      }
    }

    return null;
  }

  function parseSelectionSummaryFromText(text: string): { fileCount?: number; tokens?: number } | null {
    const fileMatch = text.match(/\bFiles:\s*([\d,]+)/i);
    const tokenMatch = text.match(/\b([\d,]+)\s+total\s+tokens\b/i);

    const fileCount = fileMatch ? parseNumber(fileMatch[1]) : undefined;
    const tokens = tokenMatch ? parseNumber(tokenMatch[1]) : undefined;

    if (fileCount === undefined && tokens === undefined) {
      return null;
    }

    return { fileCount, tokens };
  }

  async function getSelectionSummary(): Promise<{ fileCount?: number; tokens?: number } | null> {
    const binding = getBinding();
    const client = getRpClient();

    if (!binding || !client.isConnected) {
      return null;
    }

    try {
      const manageSelectionToolName = resolveToolName(client.tools, "manage_selection");
      if (!manageSelectionToolName) {
        return null;
      }

      const result = await client.callTool(manageSelectionToolName, {
        op: "get",
        view: "summary",
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
      return parseSelectionSummaryFromText(text);
    } catch {
      return null;
    }
  }

  async function getSelectionFilesText(): Promise<string | null> {
    const binding = getBinding();
    const client = getRpClient();

    if (!binding || !client.isConnected) {
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
        ...getBindingArgs(),
      });

      if (result.isError) {
        return null;
      }

      return extractTextContent(result.content);
    } catch {
      return null;
    }
  }

  function buildSelectionPathFromResolved(
    inputPath: string,
    resolved: { absolutePath: string | null; repoRoot: string | null }
  ): string {
    if (!resolved.absolutePath || !resolved.repoRoot) {
      return inputPath;
    }

    const rel = path.relative(resolved.repoRoot, resolved.absolutePath);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
      return inputPath;
    }

    const rootHint = path.basename(resolved.repoRoot);
    const relPosix = rel.split(path.sep).join("/");

    return `${rootHint}/${relPosix}`;
  }

  async function autoSelectReadFileInRepoPromptSelection(
    ctx: ExtensionContext,
    inputPath: string,
    startLine: number | undefined,
    limit: number | undefined
  ): Promise<void> {
    if (config.autoSelectReadSlices !== true) {
      return;
    }

    const client = getRpClient();
    if (!client.isConnected) {
      return;
    }

    const binding = getBinding();
    if (!binding) {
      return;
    }

    const manageSelectionToolName = resolveToolName(client.tools, "manage_selection");
    if (!manageSelectionToolName) {
      return;
    }

    const resolved = await resolveReadFilePath(inputPath, ctx.cwd, binding);
    const selectionPath = buildSelectionPathFromResolved(inputPath, resolved);

    const selectionText = await getSelectionFilesText();
    if (selectionText === null) {
      return;
    }

    const candidatePaths = new Set<string>();
    candidatePaths.add(toPosixPath(selectionPath));
    candidatePaths.add(toPosixPath(inputPath));

    if (resolved.absolutePath) {
      candidatePaths.add(toPosixPath(resolved.absolutePath));
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

      // Strongest signal: file is currently full
      if (status.mode === "full") {
        selectionStatus = status;
        break;
      }

      // Respect user manual codemap-only choices
      if (status.mode === "codemap_only" && status.codemapManual === true) {
        selectionStatus = status;
        break;
      }

      if (selectionStatus === null) {
        selectionStatus = status;
        continue;
      }

      // Prefer slices over codemap-only if we see both signals
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

    if (typeof startLine === "number" && startLine < 0) {
      if (resolved.absolutePath) {
        try {
          totalLines = await countFileLines(resolved.absolutePath);
        } catch {
          totalLines = undefined;
        }
      }
    }

    const sliceRange = computeSliceRangeFromReadArgs(startLine, limit, totalLines);

    if (sliceRange) {
      const mergedRanges = mergedRangesForSliceRead(binding, selectionPath, sliceRange);
      if (!mergedRanges || mergedRanges.length === 0) {
        return;
      }

      // Use set+mode=slices with merged ranges to avoid relying on server-specific
      // "add slices" merge semantics
      await client.callTool(manageSelectionToolName, {
        op: "set",
        mode: "slices",
        slices: [
          {
            path: toPosixPath(selectionPath),
            ranges: mergedRanges,
          },
        ],
        ...getBindingArgs(),
      });

      updateAutoSelectionStateAfterSliceRead(binding, selectionPath, sliceRange);
      return;
    }

    // For reads without a representable range, fall back to selecting the full file
    await client.callTool(manageSelectionToolName, {
      op: "add",
      mode: "full",
      paths: [toPosixPath(selectionPath)],
      ...getBindingArgs(),
    });

    updateAutoSelectionStateAfterFullRead(binding, selectionPath);
  }

  async function showStatus(ctx: ExtensionContext): Promise<void> {
    const client = getRpClient();
    const binding = getBinding();

    let msg = `RepoPrompt Status\n`;
    msg += `─────────────────\n`;
    msg += `Connection: ${client.isConnected ? "✓ connected" : "✗ disconnected"}\n`;
    msg += `Tools: ${client.tools.length}\n`;

    if (binding) {
      msg += `\nBound to:\n`;
      msg += `  Window: ${binding.windowId}\n`;
      if (binding.workspace) msg += `  Workspace: ${binding.workspace}\n`;
      if (binding.tab) msg += `  Tab: ${binding.tab}\n`;
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
      msg += `\nNot bound to any window. Use /rp bind <id> or rp({ windows: true })\n`;
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

      const start = parseInt(match[1] ?? "", 10);
      const end = parseInt(match[2] ?? "", 10);
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
    const windows = await fetchWindows(pi);

    if (windows.length === 0) {
      ctx.ui.notify("No RepoPrompt windows found", "warning");
      return;
    }

    let msg = `RepoPrompt Windows\n`;
    msg += `──────────────────\n`;

    const binding = getBinding();
    for (const w of windows) {
      const isBound = binding?.windowId === w.id;
      const marker = isBound ? " ← bound" : "";
      msg += `  ${w.id}: ${w.workspace}${marker}\n`;
    }

    msg += `\nUse /rp bind <id> to bind to a window`;

    ctx.ui.notify(msg, "info");
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Tool Execution Modes
  // ───────────────────────────────────────────────────────────────────────────

  async function executeStatus() {
    const client = getRpClient();
    const binding = getBinding();

    const server = getServerCommand(config);

    let text = `RepoPrompt: ${client.status}\n`;
    if (client.error) {
      text += `Error: ${client.error}\n`;
    }
    text += `Tools: ${client.tools.length}\n`;
    if (!server) {
      text += `Server: (not configured / not auto-detected)\n`;
      text += `Hint: configure ~/.pi/agent/extensions/repoprompt-mcp.json or ~/.pi/agent/mcp.json\n`;
    }

    if (binding) {
      text += `\nBound to window ${binding.windowId}`;
      if (binding.workspace) text += ` (${binding.workspace})`;
      if (binding.autoDetected) text += " [auto-detected]";
    } else {
      text += `\nNot bound. Use rp({ windows: true }) to list windows, then rp({ bind: { window: <id> } })`;
    }

    return {
      content: [{ type: "text" as const, text }],
      details: { mode: "status", status: client.status, error: client.error, binding },
    };
  }

  async function executeListWindows() {
    const windows = await fetchWindows(pi);

    if (windows.length === 0) {
      return {
        content: [{ type: "text" as const, text: "No RepoPrompt windows found. Is RepoPrompt running?" }],
        details: { mode: "windows", windows: [] },
      };
    }

    let text = `## RepoPrompt Windows\n\n`;

    const binding = getBinding();
    for (const w of windows) {
      const isBound = binding?.windowId === w.id;
      const marker = isBound ? " ✓" : "";
      text += `- Window \`${w.id}\` • ${w.workspace}${marker}\n`;
    }

    text += `\nUse rp({ bind: { window: <id> } }) to bind`;

    return {
      content: [{ type: "text" as const, text }],
      details: { mode: "windows", windows, count: windows.length },
    };
  }

  async function executeBinding(
    extensionApi: ExtensionAPI,
    windowId: number,
    tab?: string,
    ctx?: ExtensionContext
  ) {
    const binding = await bindToWindow(extensionApi, windowId, tab, config);

    if (ctx) {
      await syncAutoSelectionToCurrentBranch(ctx);
    }

    let text = `## Bound ✅\n`;
    text += `- **Window**: ${binding.windowId}\n`;
    if (binding.workspace) text += `- **Workspace**: ${binding.workspace}\n`;
    if (binding.tab) text += `- **Tab**: ${binding.tab}\n`;

    return {
      content: [{ type: "text" as const, text }],
      details: { mode: "bind", binding },
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

    // Merge binding args with user args (strip wrapper-only args before forwarding)
    const bindingArgs = getBindingArgs();

    const userArgs = (params.args ?? {}) as Record<string, unknown>;
    const normalizedTool = normalizeToolName(tool.name);

    const bypassCache = normalizedTool === "read_file" && userArgs.bypass_cache === true;

    const forwardedUserArgs: Record<string, unknown> = { ...userArgs };
    if (normalizedTool === "read_file") {
      delete forwardedUserArgs.bypass_cache;
    }

    const mergedArgs = { ...forwardedUserArgs, ...bindingArgs };

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
        params.raw !== true &&
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
        try {
          await autoSelectReadFileInRepoPromptSelection(ctx, pathArg, startLine, limit);
        } catch {
          // Fail-open
        }
      }

      // Transform content to text
      const textContent = result.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n");

      // Check for noop edits
      const editNoop = isEditOperation(tool.name) && isNoopEdit(textContent);

      // Build response
      const content = result.content.map((c) => {
        if (c.type === "text") {
          return { type: "text" as const, text: c.text };
        }
        if (c.type === "image") {
          return { type: "image" as const, data: c.data, mimeType: c.mimeType };
        }
        return { type: "text" as const, text: JSON.stringify(c) };
      });

      let responseContent = content.length > 0 ? content : [{ type: "text" as const, text: "(empty result)" }];

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
          raw: params.raw,
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

async function initializeExtension(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: RpConfig
): Promise<void> {
  // Try to restore binding from session
  restoreBinding(ctx, config);

  // Get server command
  const server = getServerCommand(config);
  if (!server) {
    if (ctx.hasUI) {
      ctx.ui.notify(
        "RepoPrompt MCP server not found. Install RepoPrompt / rp-mcp-server, or configure ~/.pi/agent/extensions/repoprompt-mcp.json (or ~/.pi/agent/mcp.json)",
        "warning"
      );
    }
    return;
  }

  // Connect to RepoPrompt
  const client = getRpClient();
  await client.connect(server.command, server.args, config.env);

  // Notify connection
  if (ctx.hasUI) {
    ctx.ui.notify(`RepoPrompt: connected (${client.tools.length} tools)`, "info");
  }

  // Validate restored binding (if any) still exists
  const restoredBinding = getBinding();
  if (restoredBinding) {
    try {
      const windows = await fetchWindows(pi);
      if (windows.length > 0) {
        const stillExists = windows.some((w) => w.id === restoredBinding.windowId);
        if (!stillExists) {
          clearBinding();
          if (ctx.hasUI) {
            ctx.ui.notify(
              `RepoPrompt: restored binding to window ${restoredBinding.windowId} no longer exists; staying unbound`,
              "warning"
            );
          }
        }
      }
    } catch {
      // Non-fatal; if window listing fails we keep the restored binding
    }
  }

  // Auto-detect and bind if enabled
  if (config.autoBindOnStart && !getBinding()) {
    try {
      const { binding, windows, ambiguity } = await autoDetectAndBind(pi, config);

      if (binding && ctx.hasUI) {
        ctx.ui.notify(
          `RepoPrompt: auto-bound to window ${binding.windowId} (${binding.workspace ?? "unknown"})`,
          "info"
        );
      } else if (ambiguity?.candidates?.length && ctx.hasUI) {
        const selected = await promptForWindowSelection(ctx, ambiguity.candidates);

        if (selected) {
          const chosenBinding = await bindToWindow(pi, selected.id, undefined, config);
          ctx.ui.notify(
            `RepoPrompt: bound to window ${chosenBinding.windowId} (${chosenBinding.workspace ?? "unknown"})`,
            "info"
          );
        } else {
          const candidatesText = ambiguity.candidates
            .map((w) => `${w.id}: ${w.workspace}`)
            .join(", ");

          ctx.ui.notify(
            `RepoPrompt: multiple matching windows for cwd (${candidatesText}). Use /rp bind <id> to choose.`,
            "warning"
          );
        }
      } else if (windows.length > 0 && ctx.hasUI) {
        ctx.ui.notify(
          `RepoPrompt: ${windows.length} window(s) available. Use /rp bind <id> or rp({ windows: true })`,
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
