// binding.ts - Window auto-detection and binding management

import * as os from "node:os";
import * as path from "node:path";
import { realpathSync } from "node:fs";
import { access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import type { BindingEntryData, RpBinding, RpConfig, RpTab, RpWindow } from "./types.js";
import { AUTO_SELECTION_ENTRY_TYPE, BINDING_ENTRY_TYPE } from "./types.js";
import { getRpClient } from "./client.js";
import { extractJsonContent, extractTextContent } from "./mcp-json.js";
import { resolveToolName } from "./tool-names.js";

const execFileAsync = promisify(execFile);

// Current binding state
let currentBinding: RpBinding | null = null;

/**
 * Get the current binding
 */
export function getBinding(): RpBinding | null {
  return currentBinding;
}

export function clearBinding(): void {
  currentBinding = null;
}

function bindingFromEntryData(data: BindingEntryData, autoDetected = false): RpBinding {
  return {
    windowId: data.windowId,
    tab: data.tab,
    workspace: data.workspace,
    autoDetected,
  };
}

function bindingFromAutoSelectionEntryData(raw: unknown): RpBinding | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const data = raw as Record<string, unknown>;
  if (typeof data.windowId !== "number" || typeof data.tab !== "string" || !data.tab) {
    return null;
  }

  return {
    windowId: data.windowId,
    tab: data.tab,
    workspace: typeof data.workspace === "string" ? data.workspace : undefined,
  };
}

function findMostRecentAutoSelectionBindingWithTab(
  entries: Array<{ type: string; customType?: string; data?: unknown }>,
  windowId?: number,
  workspace?: string
): RpBinding | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "custom" || entry.customType !== AUTO_SELECTION_ENTRY_TYPE) {
      continue;
    }

    const binding = bindingFromAutoSelectionEntryData(entry.data);
    if (!binding) {
      continue;
    }

    if (windowId !== undefined && binding.windowId !== windowId) {
      continue;
    }

    if (workspace && binding.workspace && binding.workspace !== workspace) {
      continue;
    }

    return binding;
  }

  return null;
}

/**
 * Persist the binding to session storage (survives session reload)
 */
export function persistBinding(pi: ExtensionAPI, binding: RpBinding, config: RpConfig): void {
  currentBinding = binding;

  if (config.persistBinding === false) {
    return;
  }

  const data: BindingEntryData = {
    windowId: binding.windowId,
    tab: binding.tab,
    workspace: binding.workspace,
  };

  pi.appendEntry(BINDING_ENTRY_TYPE, data);
}

/**
 * Restore binding from session history
 */
export function restoreBinding(ctx: ExtensionContext, config: RpConfig): RpBinding | null {
  if (config.persistBinding === false) {
    return currentBinding;
  }

  const entries = ctx.sessionManager.getBranch();

  let restored: RpBinding | null = null;

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "custom" || entry.customType !== BINDING_ENTRY_TYPE) {
      continue;
    }

    const data = entry.data as BindingEntryData | undefined;
    if (data?.windowId === undefined) {
      continue;
    }

    restored = bindingFromEntryData(data);
    break;
  }

  const autoSelectionBinding = findMostRecentAutoSelectionBindingWithTab(
    entries,
    restored?.windowId,
    restored?.workspace
  );

  if (restored && !restored.tab && autoSelectionBinding) {
    restored = {
      ...restored,
      tab: autoSelectionBinding.tab,
    };
  } else if (!restored && autoSelectionBinding) {
    restored = autoSelectionBinding;
  }

  // Branch semantics: if the branch has no saved binding, stay unbound
  currentBinding = restored;

  return currentBinding;
}

/**
 * Parse window list response from RepoPrompt
 */
export function parseWindowList(text: string): RpWindow[] {
  const windows: RpWindow[] = [];

  // Parse lines like: "- Window `1` • WS: dot314 • Roots: 4 • instance=3"
  // Note: Use .+? (non-greedy) for workspace to handle names with trailing content like "(5)"
  const windowRegex =
    /Window\s+`?(\d+)`?\s*•\s*WS:\s*(.+?)\s*•\s*Roots:\s*(\d+)(?:\s*•\s*instance=(\d+))?/gi;

  let match;
  while ((match = windowRegex.exec(text)) !== null) {
    windows.push({
      id: parseInt(match[1], 10),
      workspace: match[2],
      roots: [], // Will be populated by detailed query
      instance: match[4] ? parseInt(match[4], 10) : undefined,
    });
  }

  return windows;
}

function parseWindowListFromJson(value: unknown): RpWindow[] | null {
  if (!value) {
    return null;
  }

  const windowsValue = Array.isArray(value) ? value : (value as Record<string, unknown>).windows;
  if (!Array.isArray(windowsValue)) {
    return null;
  }

  const parseIntMaybe = (raw: unknown): number | undefined => {
    if (typeof raw === "number" && Number.isFinite(raw)) {
      return raw;
    }

    if (typeof raw === "string") {
      const parsed = parseInt(raw, 10);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }

    return undefined;
  };

  const windows: RpWindow[] = [];

  for (const item of windowsValue) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const obj = item as Record<string, unknown>;

    const id = parseIntMaybe(obj.id ?? obj.windowId ?? obj.window_id);
    if (id === undefined) {
      continue;
    }

    const workspaceRaw = obj.workspace ?? obj.ws ?? obj.name;
    const workspace = typeof workspaceRaw === "string" ? workspaceRaw : "";

    const roots = Array.isArray(obj.roots)
      ? (obj.roots.filter((r): r is string => typeof r === "string") as string[])
      : [];

    const instance = parseIntMaybe(obj.instance);

    windows.push({ id, workspace, roots, instance });
  }

  return windows;
}

function parseWindowListFromManageWorkspacesText(text: string): RpWindow[] | null {
  const windowsById = new Map<number, RpWindow>();

  for (const line of text.split("\n")) {
    if (!line.toLowerCase().includes("showing in windows")) {
      continue;
    }

    const idsMatch = line.match(/showing in windows:\s*([0-9,\s]+)/i);
    if (!idsMatch) {
      continue;
    }

    // Extract workspace name from "• <name> —" segment
    const workspaceMatch = line.match(/•\s*(.+?)\s+—/);
    const workspace = workspaceMatch?.[1]?.trim() ?? "";

    const ids = idsMatch[1]
      .split(/[^0-9]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => parseInt(s, 10))
      .filter((n) => Number.isFinite(n));

    for (const id of ids) {
      // Avoid overwriting a more specific/non-empty workspace name if we have one already
      const existing = windowsById.get(id);
      if (existing) {
        if (!existing.workspace && workspace) {
          existing.workspace = workspace;
        }
        continue;
      }

      windowsById.set(id, { id, workspace, roots: [] });
    }
  }

  const windows = [...windowsById.values()].sort((a, b) => a.id - b.id);
  return windows.length > 0 ? windows : null;
}

function parseWindowListFromManageWorkspacesJson(value: unknown): RpWindow[] | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const root = value as Record<string, unknown>;
  const workspacesValue =
    Array.isArray((root as { workspaces?: unknown }).workspaces)
      ? (root as { workspaces: unknown[] }).workspaces
      : Array.isArray(value)
        ? (value as unknown[])
        : null;

  if (!Array.isArray(workspacesValue)) {
    return null;
  }

  const parseIds = (raw: unknown): number[] => {
    if (typeof raw === "number" && Number.isFinite(raw)) return [raw];
    if (typeof raw === "string") {
      return raw
        .split(/[^0-9]+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => parseInt(s, 10))
        .filter((n) => Number.isFinite(n));
    }
    if (Array.isArray(raw)) {
      return raw
        .map((v) => {
          if (typeof v === "number" && Number.isFinite(v)) return v;
          if (typeof v === "string") {
            const parsed = parseInt(v, 10);
            return Number.isFinite(parsed) ? parsed : undefined;
          }
          return undefined;
        })
        .filter((n): n is number => typeof n === "number");
    }
    return [];
  };

  const windowsById = new Map<number, RpWindow>();

  for (const ws of workspacesValue) {
    if (!ws || typeof ws !== "object") {
      continue;
    }

    const obj = ws as Record<string, unknown>;
    const workspace = typeof obj.name === "string" ? obj.name : typeof obj.workspace === "string" ? obj.workspace : "";

    const ids = parseIds(
      obj.showingInWindows ?? obj.showing_in_windows ?? obj.windowIds ?? obj.window_ids ?? obj.windows
    );

    for (const id of ids) {
      const existing = windowsById.get(id);
      if (existing) {
        if (!existing.workspace && workspace) {
          existing.workspace = workspace;
        }
        continue;
      }
      windowsById.set(id, { id, workspace, roots: [] });
    }
  }

  const windows = [...windowsById.values()].sort((a, b) => a.id - b.id);
  return windows.length > 0 ? windows : null;
}

async function fetchWindowsViaManageWorkspaces(client: ReturnType<typeof getRpClient>): Promise<RpWindow[] | null> {
  const manageWorkspacesToolName = resolveToolName(client.tools, "manage_workspaces");
  if (!manageWorkspacesToolName) {
    return null;
  }

  const result = await client.callTool(manageWorkspacesToolName, { action: "list" });
  if (result.isError) {
    return null;
  }

  const json = extractJsonContent(result.content);
  const fromJson = parseWindowListFromManageWorkspacesJson(json);
  if (fromJson) {
    return fromJson;
  }

  const text = extractTextContent(result.content);
  return parseWindowListFromManageWorkspacesText(text);
}

async function fetchWindowsViaMcp(client: ReturnType<typeof getRpClient>): Promise<RpWindow[] | null> {
  const listWindowsToolName = resolveToolName(client.tools, "list_windows");
  if (listWindowsToolName) {
    const result = await client.callTool(listWindowsToolName, {});

    if (result.isError) {
      const text = extractTextContent(result.content);
      throw new Error(`Failed to list windows: ${text}`);
    }

    const json = extractJsonContent(result.content);
    const windowsFromJson = parseWindowListFromJson(json);
    if (windowsFromJson && windowsFromJson.length > 0) {
      return windowsFromJson;
    }

    const text = extractTextContent(result.content);
    return parseWindowList(text);
  }

  // Try to infer windows from manage_workspaces list output.
  return await fetchWindowsViaManageWorkspaces(client);
}

async function fetchWindowsViaCli(pi?: ExtensionAPI): Promise<RpWindow[]> {
  try {
    let stdout = "";
    let stderr = "";

    // Prefer pi.exec when available, since Pi often runs with a richer PATH than this Node process
    if (pi) {
      const result = await pi.exec("rp-cli", ["-e", "windows"], { timeout: 5000 });
      stdout = result.stdout ?? "";
      stderr = result.stderr ?? "";
    } else {
      const result = await execFileAsync(
        "rp-cli",
        ["-e", "windows"],
        { timeout: 5000, maxBuffer: 1024 * 1024 }
      );
      stdout = result.stdout;
      stderr = result.stderr;
    }

    const output = `${stdout}\n${stderr}`.trim();
    const windows = parseWindowList(output);

    if (windows.length > 0) {
      return windows;
    }

    // RepoPrompt CLI reports single-window mode when multiple windows aren't available
    if (output.toLowerCase().includes("single-window mode")) {
      return [{ id: 1, workspace: "single-window", roots: [] }];
    }

    return [];
  } catch (err) {
    const error = err as { code?: string; message?: string };
    const message = error?.message ?? String(err);

    // Node's execFile throws { code: "ENOENT" }, while pi.exec may throw an Error with an ENOENT-ish message
    if (error.code === "ENOENT" || message.includes("ENOENT") || message.toLowerCase().includes("not found")) {
      throw new Error(
        "rp-cli not found in PATH (required for window listing/binding). " +
          "Install rp-cli or ensure Pi inherits your shell PATH."
      );
    }

    throw err;
  }
}

/**
 * Fetch list of RepoPrompt windows (without roots)
 */
export async function fetchWindows(pi?: ExtensionAPI): Promise<RpWindow[]> {
  const client = getRpClient();
  if (!client.isConnected) {
    throw new Error("Not connected to RepoPrompt");
  }

  const windowsFromMcp = await fetchWindowsViaMcp(client);
  if (windowsFromMcp) {
    return windowsFromMcp;
  }

  return await fetchWindowsViaCli(pi);
}

async function fetchWindowsForBinding(
  pi: ExtensionAPI,
  client: ReturnType<typeof getRpClient>
): Promise<RpWindow[]> {
  const windowsFromMcp = await fetchWindowsViaMcp(client);
  if (windowsFromMcp) {
    return windowsFromMcp;
  }

  return await fetchWindowsViaCli(pi);
}

function normalizeRootLine(line: string): string | null {
  let trimmed = line.trim();

  if (!trimmed) {
    return null;
  }

  // Handle bullet lists like "- /path" or "• /path"
  trimmed = trimmed.replace(/^[-*•]\s+/, "");

  // file:// URIs
  if (trimmed.startsWith("file://")) {
    try {
      return fileURLToPath(new URL(trimmed));
    } catch {
      return null;
    }
  }

  // Expand home
  if (trimmed.startsWith("~")) {
    trimmed = path.join(os.homedir(), trimmed.slice(1));
  }

  if (path.isAbsolute(trimmed)) {
    return trimmed;
  }

  return null;
}

export function parseRootList(text: string): string[] {
  const roots = new Set<string>();

  for (const line of text.split("\n")) {
    const root = normalizeRootLine(line);
    if (root) {
      roots.add(root);
    }
  }

  return [...roots];
}

function canonicalizePathForMatching(inputPath: string): string {
  const resolvedPath = path.resolve(inputPath);

  try {
    return realpathSync.native(resolvedPath);
  } catch {
    return resolvedPath;
  }
}

async function pathExists(absolutePath: string): Promise<boolean> {
  try {
    await access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

function parseSelectionRootPath(rawPath: string): { rootHint: string; relPath: string } | null {
  const colonIdx = rawPath.indexOf(":");
  if (colonIdx > 0) {
    const rootHint = rawPath.slice(0, colonIdx).trim();
    const relPath = rawPath.slice(colonIdx + 1).replace(/^\/+/, "");
    if (rootHint && relPath) {
      return { rootHint, relPath };
    }
  }

  const parts = rawPath.split(/[\\/]+/).filter(Boolean);
  if (parts.length >= 2) {
    return {
      rootHint: parts[0],
      relPath: parts.slice(1).join("/"),
    };
  }

  return null;
}

async function windowContainsSelectionPath(window: RpWindow, selectionPath: string, cwd: string): Promise<boolean> {
  const normalizedPath = selectionPath.trim();
  if (!normalizedPath) {
    return false;
  }

  if (path.isAbsolute(normalizedPath)) {
    return window.roots.some((root) => isPathWithinRoot(normalizedPath, root));
  }

  const rootScoped = parseSelectionRootPath(normalizedPath);
  if (rootScoped) {
    const matchingRoots = window.roots.filter((root) => path.basename(root) === rootScoped.rootHint);
    for (const root of matchingRoots) {
      if (await pathExists(path.join(root, rootScoped.relPath))) {
        return true;
      }
    }
  }

  const cwdRelativePath = path.resolve(cwd, normalizedPath);
  if (await pathExists(cwdRelativePath)) {
    return window.roots.some((root) => isPathWithinRoot(cwdRelativePath, root));
  }

  for (const root of window.roots) {
    if (await pathExists(path.join(root, normalizedPath))) {
      return true;
    }
  }

  return false;
}

export interface FindRecoveryWindowBySelectionPathsResult {
  window: RpWindow | null;
  ambiguous: boolean;
  matches: RpWindow[];
}

export async function findRecoveryWindowBySelectionPaths(
  windows: RpWindow[],
  selectionPaths: string[],
  cwd: string
): Promise<FindRecoveryWindowBySelectionPathsResult> {
  const requiredPaths = [...new Set(selectionPaths.map((item) => item.trim()).filter(Boolean))];
  if (requiredPaths.length === 0) {
    return {
      window: null,
      ambiguous: false,
      matches: [],
    };
  }

  await Promise.all(
    windows.map(async (window) => {
      if (window.roots.length === 0) {
        window.roots = await fetchWindowRoots(window.id);
      }
    })
  );

  const matches: RpWindow[] = [];
  for (const window of windows) {
    const compatibility = await Promise.all(
      requiredPaths.map((selectionPath) => windowContainsSelectionPath(window, selectionPath, cwd))
    );

    if (compatibility.every(Boolean)) {
      matches.push(window);
    }
  }

  if (matches.length === 0) {
    return {
      window: null,
      ambiguous: false,
      matches: [],
    };
  }

  if (matches.length === 1) {
    return {
      window: matches[0],
      ambiguous: false,
      matches,
    };
  }

  const cwdMatch = findMatchingWindow(matches, cwd);
  if (cwdMatch.window && !cwdMatch.ambiguous) {
    return {
      window: cwdMatch.window,
      ambiguous: false,
      matches,
    };
  }

  return {
    window: null,
    ambiguous: true,
    matches,
  };
}

/**
 * Get workspace roots for a specific window
 */
export async function fetchWindowRoots(windowId: number): Promise<string[]> {
  const client = getRpClient();
  if (!client.isConnected) {
    throw new Error("Not connected to RepoPrompt");
  }

  const getFileTreeToolName = resolveToolName(client.tools, "get_file_tree");
  if (!getFileTreeToolName) {
    return [];
  }

  // Call get_file_tree with type="roots" to get workspace roots
  const result = await client.callTool(getFileTreeToolName, {
    type: "roots",
    _windowID: windowId,
  });

  if (result.isError) {
    return [];
  }

  const text = extractTextContent(result.content);
  return parseRootList(text);
}

function parseBooleanMaybe(raw: unknown): boolean | undefined {
  if (typeof raw === "boolean") {
    return raw;
  }

  if (typeof raw === "number") {
    if (raw === 1) return true;
    if (raw === 0) return false;
  }

  if (typeof raw === "string") {
    const normalized = raw.trim().toLowerCase();
    if (["true", "yes", "1", "active", "bound", "in-focus", "focused"].includes(normalized)) {
      return true;
    }
    if (["false", "no", "0", "out-of-focus", "inactive"].includes(normalized)) {
      return false;
    }
  }

  return undefined;
}

const TAB_STATE_TOKENS = new Set(["active", "bound", "in-focus", "out-of-focus"]);

function stripTrailingTabStateAnnotations(name: string): string {
  let stripped = name.trim();

  while (true) {
    const match = stripped.match(/\s*\[([^\]]+)\]\s*$/);
    if (!match) {
      return stripped;
    }

    const tokens = match[1]
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean);

    if (tokens.length === 0 || tokens.some((token) => !TAB_STATE_TOKENS.has(token))) {
      return stripped;
    }

    stripped = stripped.slice(0, stripped.length - match[0].length).trimEnd();
  }
}

function parseCountMaybe(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.replace(/,/g, "").trim();
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function parseTabFromJson(raw: unknown): RpTab | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const obj = raw as Record<string, unknown>;
  const idRaw = obj.id ?? obj.tabId ?? obj.tab_id ?? obj.uuid ?? obj.context_id ?? obj.contextId;
  if (typeof idRaw !== "string" || !idRaw.trim()) {
    return null;
  }

  const nameRaw = obj.name ?? obj.title ?? obj.tab ?? obj.label;
  const name =
    typeof nameRaw === "string" && nameRaw.trim()
      ? stripTrailingTabStateAnnotations(nameRaw)
      : idRaw.trim();

  return {
    id: idRaw.trim(),
    name: name || idRaw.trim(),
    isActive: parseBooleanMaybe(obj.isActive ?? obj.active ?? obj.selected ?? obj.is_active ?? obj.inFocus ?? obj.in_focus),
    isBound: parseBooleanMaybe(obj.isBound ?? obj.bound ?? obj.pinned ?? obj.is_bound),
    selectedFileCount: parseCountMaybe(
      obj.selectedFileCount ?? obj.selected_file_count ?? obj.fileCount ?? obj.file_count
    ),
  };
}

function collectTabsFromJson(raw: unknown): RpTab[] {
  if (Array.isArray(raw)) {
    return raw.map(parseTabFromJson).filter((tab): tab is RpTab => tab !== null);
  }

  if (!raw || typeof raw !== "object") {
    return [];
  }

  const obj = raw as Record<string, unknown>;
  const containers = [obj.tabs, obj.tab, obj.createdTab, obj.created_tab, obj.selectedTab, obj.selected_tab];

  for (const candidate of containers) {
    const parsed = collectTabsFromJson(candidate);
    if (parsed.length > 0) {
      return parsed;
    }
  }

  const tab = parseTabFromJson(obj);
  return tab ? [tab] : [];
}

function mergeTabFlag(left?: boolean, right?: boolean): boolean | undefined {
  if (left === true || right === true) {
    return true;
  }

  if (left === false || right === false) {
    return false;
  }

  return undefined;
}

function dedupeTabs(tabs: RpTab[]): RpTab[] {
  const deduped = new Map<string, RpTab>();

  for (const tab of tabs) {
    const existing = deduped.get(tab.id);
    if (!existing) {
      deduped.set(tab.id, { ...tab });
      continue;
    }

    deduped.set(tab.id, {
      id: tab.id,
      name: existing.name || tab.name,
      isActive: mergeTabFlag(existing.isActive, tab.isActive),
      isBound: mergeTabFlag(existing.isBound, tab.isBound),
      selectedFileCount: tab.selectedFileCount ?? existing.selectedFileCount,
    });
  }

  return [...deduped.values()];
}

function parseTabLine(line: string): RpTab | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.includes("`")) {
    return null;
  }

  if (/^[-•]\s*window\s+`\d+`/i.test(trimmed)) {
    return null;
  }

  if (!trimmed.includes("•") && !trimmed.toLowerCase().includes("tab")) {
    return null;
  }

  const contextIdLineMatch = trimmed.match(/^[-•]\s*(.+?)\s+[—-]\s*context_id:\s*`([^`]+)`\s*$/i);
  if (contextIdLineMatch?.[1] && contextIdLineMatch[2]) {
    const id = contextIdLineMatch[2].trim();
    const name = stripTrailingTabStateAnnotations(contextIdLineMatch[1].trim()) || id;
    const isActive = /\[(?:[^\]]*\bactive\b[^\]]*|[^\]]*\bin-focus\b[^\]]*)\]/i.test(trimmed)
      ? true
      : /\[[^\]]*\bout-of-focus\b[^\]]*\]/i.test(trimmed)
        ? false
        : undefined;
    const isBound = /\[[^\]]*\bbound\b[^\]]*\]/i.test(trimmed) ? true : undefined;

    return {
      id,
      name,
      isActive,
      isBound,
    };
  }

  const idMatch = trimmed.match(/`([^`]+)`/);
  if (!idMatch?.[1]) {
    return null;
  }

  const id = idMatch[1].trim();
  const afterId = trimmed.slice((idMatch.index ?? 0) + idMatch[0].length);
  const bulletIndex = afterId.indexOf("•");
  const rawName = bulletIndex >= 0 ? afterId.slice(bulletIndex + 1) : afterId;
  const name = stripTrailingTabStateAnnotations(rawName.replace(/^[:\-\s]+/, "").trim()) || id;

  const isActive = /\[(?:[^\]]*\bactive\b[^\]]*|[^\]]*\bin-focus\b[^\]]*)\]/i.test(trimmed)
    ? true
    : /\[[^\]]*\bout-of-focus\b[^\]]*\]/i.test(trimmed)
      ? false
      : undefined;
  const isBound = /\[[^\]]*\bbound\b[^\]]*\]/i.test(trimmed) ? true : undefined;

  return {
    id,
    name,
    isActive,
    isBound,
  };
}

export function parseTabList(text: string): RpTab[] {
  const tabs: RpTab[] = [];
  let lastTab: RpTab | null = null;

  for (const line of text.split("\n")) {
    const parsedTab = parseTabLine(line);
    if (parsedTab) {
      tabs.push(parsedTab);
      lastTab = parsedTab;
      continue;
    }

    if (!lastTab) {
      continue;
    }

    const fileCountMatch = line.match(/•\s*([\d,]+)\s+files\b/i);
    if (fileCountMatch?.[1]) {
      lastTab.selectedFileCount = parseCountMaybe(fileCountMatch[1]);
    }
  }

  return dedupeTabs(tabs);
}

function parseTabsFromJson(value: unknown): RpTab[] | null {
  const tabs = collectTabsFromJson(value);
  return tabs.length > 0 ? dedupeTabs(tabs) : null;
}

function parseChatCountFromJson(value: unknown): number | undefined {
  if (!value) {
    return undefined;
  }

  if (Array.isArray(value)) {
    return value.length;
  }

  if (typeof value !== "object") {
    return undefined;
  }

  const obj = value as Record<string, unknown>;
  const directCount = parseCountMaybe(
    obj.count ?? obj.chatCount ?? obj.chat_count ?? obj.total ?? obj.totalCount ?? obj.total_count
  );
  if (directCount !== undefined) {
    return directCount;
  }

  for (const key of ["chats", "sessions", "items", "results"]) {
    const candidate = obj[key];
    if (Array.isArray(candidate)) {
      return candidate.length;
    }
  }

  return undefined;
}

function parseChatCountFromText(text: string): number | undefined {
  const countMatch = text.match(/\bCount\b[^\d]*([\d,]+)/i);
  if (countMatch?.[1]) {
    return parseCountMaybe(countMatch[1]);
  }

  if (/\bNo chats\b/i.test(text)) {
    return 0;
  }

  const sessionCount = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^•\s*\[[^\]]+\]/.test(line)).length;

  return sessionCount > 0 ? sessionCount : undefined;
}

async function fetchTabChatCount(
  tabId: string,
  client: ReturnType<typeof getRpClient> = getRpClient()
): Promise<number | undefined> {
  if (!client.isConnected) {
    return undefined;
  }

  const chatsToolName = resolveToolName(client.tools, "chats");
  if (!chatsToolName) {
    return undefined;
  }

  const result = await client.callTool(chatsToolName, {
    action: "list",
    scope: "tab",
    tab_id: tabId,
    limit: 1,
  });

  if (result.isError) {
    return undefined;
  }

  const countFromJson = parseChatCountFromJson(extractJsonContent(result.content));
  if (countFromJson !== undefined) {
    return countFromJson;
  }

  return parseChatCountFromText(extractTextContent(result.content));
}

function findLiveTab(tabs: RpTab[], reference: string | undefined): RpTab | null {
  if (!reference) {
    return null;
  }

  return tabs.find((tab) => tab.id === reference || tab.name === reference) ?? null;
}

function isExplicitlyEmptyTab(tab: RpTab): boolean {
  return tab.selectedFileCount === 0;
}

async function isSafeReusableTab(
  tab: RpTab,
  client: ReturnType<typeof getRpClient> = getRpClient()
): Promise<boolean> {
  if (!isExplicitlyEmptyTab(tab)) {
    return false;
  }

  const chatCount = await fetchTabChatCount(tab.id, client);
  return chatCount === 0;
}

function orderReusableEmptyTabs(tabs: RpTab[]): RpTab[] {
  const emptyTabs = tabs.filter(isExplicitlyEmptyTab);
  if (emptyTabs.length === 0) {
    return [];
  }

  const ordered = [
    ...emptyTabs.filter((tab) => tab.isBound === true),
    ...emptyTabs.filter((tab) => tab.isBound !== true && tab.isActive === true),
    ...emptyTabs.filter((tab) => tab.isBound !== true && tab.isActive !== true),
  ];

  return ordered.filter((tab, index) => ordered.findIndex((candidate) => candidate.id === tab.id) === index);
}

async function findReusableSafeTab(
  tabs: RpTab[],
  client: ReturnType<typeof getRpClient> = getRpClient()
): Promise<RpTab | null> {
  for (const tab of orderReusableEmptyTabs(tabs)) {
    if (await isSafeReusableTab(tab, client)) {
      return tab;
    }
  }

  return null;
}

function bindingWindowArgs(windowId: number): Record<string, unknown> {
  return {
    _windowID: windowId,
  };
}

function findMostRecentBindingWithTabForWindow(ctx: ExtensionContext, windowId: number): RpBinding | null {
  const entries = ctx.sessionManager.getBranch();

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "custom" || entry.customType !== BINDING_ENTRY_TYPE) {
      continue;
    }

    const data = entry.data as BindingEntryData | undefined;
    if (data?.windowId !== windowId || typeof data.tab !== "string" || !data.tab) {
      continue;
    }

    return bindingFromEntryData(data);
  }

  return null;
}

export async function fetchWindowTabs(
  windowId: number,
  client: ReturnType<typeof getRpClient> = getRpClient()
): Promise<RpTab[]> {
  if (!client.isConnected) {
    throw new Error("Not connected to RepoPrompt");
  }

  const bindContextToolName = resolveToolName(client.tools, "bind_context");
  if (bindContextToolName) {
    const bindContextResult = await client.callTool(bindContextToolName, {
      op: "list",
      ...bindingWindowArgs(windowId),
    });

    if (!bindContextResult.isError) {
      const tabsFromBindContextJson = parseTabsFromJson(extractJsonContent(bindContextResult.content));
      if (tabsFromBindContextJson && tabsFromBindContextJson.length > 0) {
        return tabsFromBindContextJson;
      }

      const tabsFromBindContextText = parseTabList(extractTextContent(bindContextResult.content));
      if (tabsFromBindContextText.length > 0) {
        return tabsFromBindContextText;
      }
    }
  }

  const manageWorkspacesToolName = resolveToolName(client.tools, "manage_workspaces");
  if (!manageWorkspacesToolName) {
    return [];
  }

  const result = await client.callTool(manageWorkspacesToolName, {
    action: "list_tabs",
    ...bindingWindowArgs(windowId),
  });

  if (result.isError) {
    return [];
  }

  const json = extractJsonContent(result.content);
  const tabsFromJson = parseTabsFromJson(json);
  if (tabsFromJson) {
    return tabsFromJson;
  }

  return parseTabList(extractTextContent(result.content));
}

async function selectTab(
  windowId: number,
  tabId: string,
  client: ReturnType<typeof getRpClient> = getRpClient()
): Promise<void> {
  const bindContextToolName = resolveToolName(client.tools, "bind_context");
  let bindContextError: string | null = null;

  if (bindContextToolName) {
    const bindResult = await client.callTool(bindContextToolName, {
      op: "bind",
      context_id: tabId,
      ...bindingWindowArgs(windowId),
    });

    if (!bindResult.isError) {
      return;
    }

    bindContextError = extractTextContent(bindResult.content) || `Failed to bind RepoPrompt tab ${tabId}`;
  }

  const manageWorkspacesToolName = resolveToolName(client.tools, "manage_workspaces");
  if (!manageWorkspacesToolName) {
    if (bindContextError) {
      throw new Error(bindContextError);
    }

    throw new Error("RepoPrompt tab binding is unavailable: neither bind_context nor manage_workspaces tool is available");
  }

  const result = await client.callTool(manageWorkspacesToolName, {
    action: "select_tab",
    tab: tabId,
    focus: false,
    ...bindingWindowArgs(windowId),
  });

  if (result.isError) {
    const text = extractTextContent(result.content);
    throw new Error(text || bindContextError || `Failed to bind RepoPrompt tab ${tabId}`);
  }
}

async function createBoundTab(
  windowId: number,
  client: ReturnType<typeof getRpClient> = getRpClient()
): Promise<RpTab> {
  const manageWorkspacesToolName = resolveToolName(client.tools, "manage_workspaces");
  if (!manageWorkspacesToolName) {
    throw new Error("RepoPrompt manage_workspaces tool not available");
  }

  const tabsBeforeCreate = await fetchWindowTabs(windowId, client);

  const result = await client.callTool(manageWorkspacesToolName, {
    action: "create_tab",
    bind: true,
    focus: false,
    ...bindingWindowArgs(windowId),
  });

  if (result.isError) {
    const text = extractTextContent(result.content);
    throw new Error(text || "Failed to create RepoPrompt tab");
  }

  const createdTabs = parseTabsFromJson(extractJsonContent(result.content)) ?? parseTabList(extractTextContent(result.content));
  let createdTab = createdTabs[0] ?? null;

  if (!createdTab) {
    const tabsAfterCreate = await fetchWindowTabs(windowId, client);
    const previousIds = new Set(tabsBeforeCreate.map((tab) => tab.id));
    const newTabs = tabsAfterCreate.filter((tab) => !previousIds.has(tab.id));

    if (newTabs.length !== 1) {
      throw new Error("RepoPrompt did not report the created tab unambiguously");
    }

    createdTab = newTabs[0];
  }

  await selectTab(windowId, createdTab.id, client);
  const tabs = await fetchWindowTabs(windowId, client);
  return findLiveTab(tabs, createdTab.id) ?? { ...createdTab, isBound: true };
}

export async function bindToTab(
  pi: ExtensionAPI,
  windowId: number,
  tabReference: string,
  config: RpConfig,
  client: ReturnType<typeof getRpClient> = getRpClient()
): Promise<RpBinding> {
  const windows = await fetchWindowsForBinding(pi, client);
  const window = windows.find((w) => w.id === windowId);

  if (!window && windows.length > 0) {
    throw new Error(`RepoPrompt window ${windowId} not found`);
  }

  const tabs = await fetchWindowTabs(windowId, client);
  const liveTab = findLiveTab(tabs, tabReference);
  if (!liveTab) {
    throw new Error(`RepoPrompt tab ${JSON.stringify(tabReference)} not found in window ${windowId}`);
  }

  if (liveTab.isBound !== true) {
    await selectTab(windowId, liveTab.id, client);
  }

  const binding: RpBinding = {
    windowId,
    tab: liveTab.id,
    workspace: window?.workspace || undefined,
    autoDetected: false,
  };

  persistBinding(pi, binding, config);
  return binding;
}

export async function createAndBindTab(
  pi: ExtensionAPI,
  windowId: number,
  config: RpConfig,
  client: ReturnType<typeof getRpClient> = getRpClient()
): Promise<RpBinding> {
  const windows = await fetchWindowsForBinding(pi, client);
  const window = windows.find((w) => w.id === windowId);

  if (!window && windows.length > 0) {
    throw new Error(`RepoPrompt window ${windowId} not found`);
  }

  const createdTab = await createBoundTab(windowId, client);
  const binding: RpBinding = {
    windowId,
    tab: createdTab.id,
    workspace: window?.workspace || undefined,
    autoDetected: false,
  };

  persistBinding(pi, binding, config);
  return binding;
}

export async function ensureBindingHasTab(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: RpConfig,
  client: ReturnType<typeof getRpClient> = getRpClient(),
  options: { createIfMissing?: boolean; recoverIfMissing?: boolean; reuseSoleEmptyTab?: boolean } = {}
): Promise<RpBinding | null> {
  const binding = currentBinding;
  if (!binding || !client.isConnected) {
    return binding;
  }

  const createIfMissing = options.createIfMissing !== false;
  const recoverIfMissing = options.recoverIfMissing === true;
  const reuseSoleEmptyTab = options.reuseSoleEmptyTab === true;

  const manageWorkspacesToolName = resolveToolName(client.tools, "manage_workspaces");
  if (!manageWorkspacesToolName) {
    return binding;
  }

  const liveTabs = await fetchWindowTabs(binding.windowId, client);

  const adoptTab = async (tab: RpTab, persist: boolean): Promise<RpBinding> => {
    if (tab.isBound !== true) {
      await selectTab(binding.windowId, tab.id, client);
    }

    const nextBinding: RpBinding = {
      ...binding,
      tab: tab.id,
    };

    currentBinding = nextBinding;
    if (persist) {
      persistBinding(pi, nextBinding, config);
    }

    return nextBinding;
  };

  const currentTab = findLiveTab(liveTabs, binding.tab);
  if (currentTab) {
    const shouldPersist = binding.tab !== currentTab.id;
    return await adoptTab(currentTab, shouldPersist);
  }

  if (liveTabs.length === 0 && binding.tab) {
    const unknownCurrentTab: RpTab = {
      id: binding.tab,
      name: binding.tab,
    };
    return await adoptTab(unknownCurrentTab, false);
  }

  const allowHistoricalTabReuse = recoverIfMissing || Boolean(binding.tab);
  if (allowHistoricalTabReuse) {
    const branchTabBinding =
      findMostRecentBindingWithTabForWindow(ctx, binding.windowId) ??
      findMostRecentAutoSelectionBindingWithTab(ctx.sessionManager.getBranch(), binding.windowId, binding.workspace);
    const branchTab = findLiveTab(liveTabs, branchTabBinding?.tab);
    if (branchTab) {
      return await adoptTab(branchTab, true);
    }

    if (liveTabs.length === 0 && branchTabBinding?.tab) {
      const unknownBranchTab: RpTab = {
        id: branchTabBinding.tab,
        name: branchTabBinding.tab,
      };
      return await adoptTab(unknownBranchTab, true);
    }
  }

  if (!binding.tab || reuseSoleEmptyTab || recoverIfMissing) {
    const reusableSafeTab = await findReusableSafeTab(liveTabs, client);
    if (reusableSafeTab) {
      return await adoptTab(reusableSafeTab, true);
    }
  }

  if (!createIfMissing && !(recoverIfMissing && binding.tab)) {
    return binding;
  }

  const createdTab = await createBoundTab(binding.windowId, client);
  return await adoptTab(createdTab, true);
}

/**
 * Check if a directory is within or equal to a root path
 */
function isPathWithinRoot(dir: string, root: string): boolean {
  const normalizedDir = canonicalizePathForMatching(dir);
  const normalizedRoot = canonicalizePathForMatching(root);

  // Exact match
  if (normalizedDir === normalizedRoot) {
    return true;
  }

  // Dir is within root
  const relative = path.relative(normalizedRoot, normalizedDir);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

export interface WindowMatch {
  window: RpWindow;
  root: string;
  rootDepth: number;
}

export interface FindMatchingWindowResult {
  window: RpWindow | null;
  root: string | null;
  ambiguous: boolean;
  matches: WindowMatch[];
}

/**
 * Find the best matching window for the current working directory
 */
export function findMatchingWindow(windows: RpWindow[], cwd: string): FindMatchingWindowResult {
  const canonicalCwd = canonicalizePathForMatching(cwd);
  const cwdDepth = canonicalCwd.split(path.sep).filter(Boolean).length;

  const matches: WindowMatch[] = [];

  for (const window of windows) {
    let bestRoot: string | null = null;
    let bestRootDepth = -1;

    for (const root of window.roots) {
      if (!isPathWithinRoot(cwd, root)) {
        continue;
      }

      const canonicalRoot = canonicalizePathForMatching(root);
      const rootDepth = canonicalRoot.split(path.sep).filter(Boolean).length;

      // Prefer more specific roots (closer to cwd)
      if (rootDepth > bestRootDepth && rootDepth <= cwdDepth) {
        bestRoot = root;
        bestRootDepth = rootDepth;
      }
    }

    if (bestRoot) {
      matches.push({ window, root: bestRoot, rootDepth: bestRootDepth });
    }
  }

  if (matches.length === 0) {
    return {
      window: null,
      root: null,
      ambiguous: false,
      matches: [],
    };
  }

  // Sort by most specific root first
  matches.sort((a, b) => b.rootDepth - a.rootDepth);

  const best = matches[0];
  const tied = matches.filter((m) => m.rootDepth === best.rootDepth);

  if (tied.length > 1) {
    return {
      window: null,
      root: null,
      ambiguous: true,
      matches,
    };
  }

  return {
    window: best.window,
    root: best.root,
    ambiguous: false,
    matches,
  };
}

export interface AutoDetectAndBindResult {
  binding: RpBinding | null;
  windows: RpWindow[];
  ambiguity?: {
    candidates: RpWindow[];
  };
}

/**
 * Auto-detect and bind to the best matching window
 * Returns the binding if successful, null if no match or multiple ambiguous matches
 */
export async function autoDetectAndBind(pi: ExtensionAPI, config: RpConfig): Promise<AutoDetectAndBindResult> {
  const cwd = process.cwd();

  const windows = await fetchWindows(pi);

  if (windows.length === 0) {
    return { binding: null, windows: [] };
  }

  // Populate roots exactly once
  await Promise.all(
    windows.map(async (window) => {
      window.roots = await fetchWindowRoots(window.id);
    })
  );

  const match = findMatchingWindow(windows, cwd);

  if (match.ambiguous) {
    const bestRootDepth = match.matches[0]?.rootDepth;
    const candidates = match.matches
      .filter((m) => m.rootDepth === bestRootDepth)
      .map((m) => m.window);

    return {
      binding: null,
      windows,
      ambiguity: { candidates },
    };
  }

  if (!match.window) {
    return { binding: null, windows };
  }

  const binding: RpBinding = {
    windowId: match.window.id,
    workspace: match.window.workspace,
    autoDetected: true,
  };

  persistBinding(pi, binding, config);

  return { binding, windows };
}

/**
 * Manually bind to a specific window and optionally tab
 */
export async function bindToWindow(
  pi: ExtensionAPI,
  windowId: number,
  tab: string | undefined,
  config: RpConfig
): Promise<RpBinding> {
  const windows = await fetchWindows(pi);
  const window = windows.find((w) => w.id === windowId);

  if (!window && windows.length > 0) {
    throw new Error(`RepoPrompt window ${windowId} not found`);
  }

  const binding: RpBinding = {
    windowId,
    tab,
    workspace: window?.workspace || undefined,
    autoDetected: false,
  };

  persistBinding(pi, binding, config);

  return binding;
}

/**
 * Get binding args to include in tool calls
 */
export function getBindingArgs(): Record<string, unknown> {
  if (!currentBinding) {
    return {};
  }

  const args: Record<string, unknown> = {
    _windowID: currentBinding.windowId,
  };

  if (currentBinding.tab) {
    args._tabID = currentBinding.tab;
  }

  return args;
}
