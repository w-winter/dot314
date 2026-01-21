// binding.ts - Window auto-detection and binding management

import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import type { BindingEntryData, RpBinding, RpConfig, RpWindow } from "./types.js";
import { BINDING_ENTRY_TYPE } from "./types.js";
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

  const entries = ctx.sessionManager.getEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "custom" || entry.customType !== BINDING_ENTRY_TYPE) {
      continue;
    }

    const data = entry.data as BindingEntryData | undefined;
    if (data?.windowId === undefined) {
      continue;
    }

    currentBinding = {
      windowId: data.windowId,
      tab: data.tab,
      workspace: data.workspace,
    };
    break;
  }

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

async function fetchWindowsViaMcp(client: ReturnType<typeof getRpClient>): Promise<RpWindow[] | null> {
  const listWindowsToolName = resolveToolName(client.tools, "list_windows");
  if (!listWindowsToolName) {
    return null;
  }

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

async function fetchWindowsViaCli(): Promise<RpWindow[]> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "rp-cli",
      ["-e", "windows"],
      { timeout: 5000, maxBuffer: 1024 * 1024 }
    );

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
    if (error.code === "ENOENT") {
      throw new Error("rp-cli not found in PATH (required for window listing/binding)");
    }

    throw err;
  }
}

/**
 * Fetch list of RepoPrompt windows (without roots)
 */
export async function fetchWindows(): Promise<RpWindow[]> {
  const client = getRpClient();
  if (!client.isConnected) {
    throw new Error("Not connected to RepoPrompt");
  }

  const windowsFromMcp = await fetchWindowsViaMcp(client);
  if (windowsFromMcp) {
    return windowsFromMcp;
  }

  return await fetchWindowsViaCli();
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

/**
 * Check if a directory is within or equal to a root path
 */
function isPathWithinRoot(dir: string, root: string): boolean {
  const normalizedDir = path.resolve(dir);
  const normalizedRoot = path.resolve(root);

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
  const cwdDepth = path.resolve(cwd).split(path.sep).filter(Boolean).length;

  const matches: WindowMatch[] = [];

  for (const window of windows) {
    let bestRoot: string | null = null;
    let bestRootDepth = -1;

    for (const root of window.roots) {
      if (!isPathWithinRoot(cwd, root)) {
        continue;
      }

      const resolvedRoot = path.resolve(root);
      const rootDepth = resolvedRoot.split(path.sep).filter(Boolean).length;

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

  const windows = await fetchWindows();

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
  const windows = await fetchWindows();
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
