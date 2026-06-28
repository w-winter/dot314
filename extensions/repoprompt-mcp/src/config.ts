// config.ts - Configuration loading for RepoPrompt MCP extension

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import {
  DEFAULT_TOOL_CALL_TIMEOUT_MS,
  DIFF_VIEW_MODES,
  RP_APP_IDS,
  type DiffViewMode,
  type RpAppId,
  type RpAppTargetConfig,
  type RpConfig,
} from "./types.js";

const CE_APP_PATH = "/Applications/RepoPrompt CE.app";
const CLASSIC_APP_PATH = "/Applications/Repo Prompt.app";

const APP_TARGETS: Record<RpAppId, { label: string; cliCommand: string; appPath: string; mcpConfigNames: string[] }> = {
  ce: {
    label: "RepoPrompt CE",
    cliCommand: "rpce-cli",
    appPath: CE_APP_PATH,
    mcpConfigNames: ["repoprompt-ce", "rpce"],
  },
  classic: {
    label: "RepoPrompt Classic",
    cliCommand: "rp-cli",
    appPath: CLASSIC_APP_PATH,
    mcpConfigNames: ["repoprompt-classic", "rpclassic"],
  },
};

const DEFAULT_APPS: Record<RpAppId, RpAppTargetConfig> = {
  ce: {
    args: [],
    appPath: CE_APP_PATH,
    autoLaunchApp: true,
  },
  classic: {
    args: [],
    appPath: CLASSIC_APP_PATH,
    autoLaunchApp: true,
  },
};

// Default configuration
const DEFAULT_CONFIG: RpConfig = {
  activeApp: "ce",
  apps: DEFAULT_APPS,
  autoBindOnStart: true,
  persistBinding: true,
  confirmDeletes: true,
  confirmEdits: false,
  toolCallTimeoutMs: DEFAULT_TOOL_CALL_TIMEOUT_MS,
  collapsedMaxLines: 3,
  diffViewMode: "auto",
  diffSplitMinWidth: 120,
  suppressHostDisconnectedLog: true,

  // Off by default: preserves RepoPrompt's default read_file behavior unless explicitly enabled
  readcacheReadFile: false,

  // On by default: mirrors RepoPrompt Agent Mode behavior (reads automatically curate selection)
  autoSelectReadSlices: true,

  // /rp oracle uses this mode when --mode is not provided
  oracleDefaultMode: "chat",
};

// Common locations for MCP config files
const CONFIG_LOCATIONS = [
  // Pi-specific (preferred)
  () => path.join(os.homedir(), ".pi", "agent", "extensions", "repoprompt-mcp.json"),
  // Also supported (folder-style config next to extension)
  () => path.join(os.homedir(), ".pi", "agent", "extensions", "repoprompt-mcp", "repoprompt-mcp.json"),
  // Legacy location (pre-extensions/ layout)
  () => path.join(os.homedir(), ".pi", "agent", "repoprompt-mcp.json"),
  () => path.join(os.homedir(), ".pi", "agent", "mcp.json"),
  // Project-local
  () => path.join(process.cwd(), ".pi", "mcp.json"),
  // Generic MCP configs
  () => path.join(os.homedir(), ".config", "mcp", "mcp.json"),
];

interface McpServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

interface McpConfigFile {
  mcpServers?: Record<string, McpServerEntry>;
}

/**
 * Try to read and parse a JSON file, return null if it fails
 */
function tryReadJson<T>(filePath: string): T | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

function normalizeAppId(value: unknown): RpAppId {
  if (RP_APP_IDS.includes(value as RpAppId)) {
    return value as RpAppId;
  }

  throw new Error(`Invalid RepoPrompt app target: ${String(value)}`);
}

function normalizeArgs(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.filter((item): item is string => typeof item === "string");
}

function normalizeStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string");

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeTargetConfig(
  app: RpAppId,
  raw: Partial<RpAppTargetConfig> | undefined
): RpAppTargetConfig {
  const base = DEFAULT_APPS[app];
  const source = raw ?? {};
  const normalized: RpAppTargetConfig = {
    ...base,
    ...source,
  };

  normalized.args = normalizeArgs(source.args) ?? base.args ?? [];
  normalized.env = normalizeStringRecord(source.env) ?? base.env;

  return normalized;
}

function normalizeApps(raw: unknown): Record<RpAppId, RpAppTargetConfig> {
  const source = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Partial<Record<RpAppId, Partial<RpAppTargetConfig>>>
    : {};

  return {
    ce: normalizeTargetConfig("ce", source.ce),
    classic: normalizeTargetConfig("classic", source.classic),
  };
}

/**
 * Find RepoPrompt server config in MCP config files
 */
function findRepoPromptInMcpConfig(app: RpAppId): McpServerEntry | null {
  const names = new Set(APP_TARGETS[app].mcpConfigNames.map((name) => name.toLowerCase()));

  for (const getPath of CONFIG_LOCATIONS) {
    const configPath = getPath();
    const config = tryReadJson<McpConfigFile>(configPath);

    if (!config?.mcpServers) continue;

    for (const [name, entry] of Object.entries(config.mcpServers)) {
      if (names.has(name.toLowerCase())) {
        return entry;
      }
    }
  }

  return null;
}

/**
 * Check if a command exists in PATH
 */
function commandExists(command: string): boolean {
  try {
    if (command.includes("/")) {
      return fs.existsSync(command);
    }

    // Validate command is a simple identifier/path (no shell metacharacters)
    if (!/^[\w./-]+$/.test(command)) {
      return false;
    }

    const whichCommand = process.platform === "win32" ? "where" : "which";
    execFileSync(whichCommand, [command], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function getAppBundleCommand(config: RpConfig, app: RpAppId): string {
  return path.join(inferAppPath(config, app), "Contents", "MacOS", "repoprompt-mcp");
}

function findRepoPromptServer(config: RpConfig, app: RpAppId): { command: string; args: string[] } | null {
  const configEntry = findRepoPromptInMcpConfig(app);
  if (configEntry?.command) {
    return {
      command: configEntry.command,
      args: configEntry.args ?? [],
    };
  }

  const appBundleCommand = getAppBundleCommand(config, app);
  if (commandExists(appBundleCommand)) {
    return {
      command: appBundleCommand,
      args: [],
    };
  }

  const cliCommand = getAppCliCommand(app);
  if (commandExists(cliCommand)) {
    return {
      command: cliCommand,
      args: [],
    };
  }

  return null;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.floor(value)));
}

function toDiffViewMode(value: unknown): DiffViewMode {
  return DIFF_VIEW_MODES.includes(value as DiffViewMode)
    ? (value as DiffViewMode)
    : (DEFAULT_CONFIG.diffViewMode as DiffViewMode);
}

/**
 * Load extension configuration
 */
export function loadConfig(overrides?: Partial<RpConfig>): RpConfig {
  let config: RpConfig = {
    ...DEFAULT_CONFIG,
    apps: {
      ce: { ...DEFAULT_APPS.ce },
      classic: { ...DEFAULT_APPS.classic },
    },
  };

  const preferredConfigPath = path.join(os.homedir(), ".pi", "agent", "extensions", "repoprompt-mcp.json");
  const folderStyleConfigPath = path.join(
    os.homedir(),
    ".pi",
    "agent",
    "extensions",
    "repoprompt-mcp",
    "repoprompt-mcp.json"
  );
  const legacyConfigPath = path.join(os.homedir(), ".pi", "agent", "repoprompt-mcp.json");

  const configPath =
    (fs.existsSync(preferredConfigPath) && preferredConfigPath) ||
    (fs.existsSync(folderStyleConfigPath) && folderStyleConfigPath) ||
    legacyConfigPath;

  const fileConfig = tryReadJson<Partial<RpConfig>>(configPath);
  if (fileConfig) {
    config = {
      ...config,
      ...fileConfig,
      activeApp: fileConfig.activeApp === undefined ? config.activeApp : normalizeAppId(fileConfig.activeApp),
      apps: normalizeApps(fileConfig.apps),
    };

    const fileConfigAny = fileConfig as Record<string, unknown>;
    if (fileConfigAny.previewEdits !== undefined && fileConfigAny.confirmEdits === undefined) {
      config.confirmEdits = Boolean(fileConfigAny.previewEdits);
    }
  }

  if (overrides) {
    config = {
      ...config,
      ...overrides,
      activeApp: overrides.activeApp === undefined ? config.activeApp : normalizeAppId(overrides.activeApp),
      apps: overrides.apps ? normalizeApps(overrides.apps) : config.apps,
    };
  }

  config.toolCallTimeoutMs = clampNumber(
    config.toolCallTimeoutMs,
    1_000,
    24 * 60 * 60 * 1000,
    DEFAULT_TOOL_CALL_TIMEOUT_MS
  );
  config.diffViewMode = toDiffViewMode(config.diffViewMode);
  config.diffSplitMinWidth = clampNumber(config.diffSplitMinWidth, 70, 240, DEFAULT_CONFIG.diffSplitMinWidth ?? 120);

  return config;
}

const FILTERED_STDERR_SUBSTRINGS = [
  // Clean disconnect / shutdown
  "BootstrapSocketProxy: Bridge task failed: hostDisconnected",
  "terminal_reason=stdin_closed",
  // RepoPrompt app closed while Pi stays running
  "BootstrapSocketProxy: Bridge task failed: connectionReset",
  "Bootstrap connection lost",
  "Retrying in",
];

function quoteForBash(value: string): string {
  // Safely single-quote a string for /bin/bash -lc
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function maybeWrapServerCommand(
  config: RpConfig,
  server: { command: string; args: string[] }
): { command: string; args: string[] } {
  if (config.suppressHostDisconnectedLog === false) {
    return server;
  }

  // This noisy line is emitted by the macOS RepoPrompt MCP binary on clean disconnect
  // It is written to stderr, not MCP stdout, so it's safe to filter
  if (process.platform !== "darwin") {
    return server;
  }

  if (!server.command.endsWith("repoprompt-mcp")) {
    return server;
  }

  // Wrap with bash to filter stderr only. Preserve stdout exactly for MCP JSON-RPC
  const fullCommand = [server.command, ...server.args].map(quoteForBash).join(" ");

  const filterArgs = FILTERED_STDERR_SUBSTRINGS
    .map((pattern) => `-e ${quoteForBash(pattern)}`)
    .join(" ");

  const script = `${fullCommand} 2> >(grep -vF ${filterArgs} >&2)`;

  return {
    command: "/bin/bash",
    args: ["-lc", script],
  };
}

export function getActiveApp(config: RpConfig): RpAppId {
  return config.activeApp;
}

export function getAppTargetConfig(config: RpConfig, app: RpAppId = getActiveApp(config)): RpAppTargetConfig {
  return config.apps[app];
}

export function getAppLabel(config: RpConfig, app: RpAppId = getActiveApp(config)): string {
  return APP_TARGETS[app].label;
}

export function getAppCliCommand(app: RpAppId): string {
  return APP_TARGETS[app].cliCommand;
}

/**
 * Infer the .app bundle path from an MCP server command that lives inside a .app bundle.
 * e.g. "/Applications/Repo Prompt.app/Contents/MacOS/repoprompt-mcp" → "/Applications/Repo Prompt.app"
 */
export function inferAppPath(config: RpConfig, app: RpAppId = getActiveApp(config)): string {
  const appConfig = getAppTargetConfig(config, app);
  if (appConfig.appPath) {
    return appConfig.appPath;
  }

  const appMatch = appConfig.command?.match(/^(.+\.app)\//i);
  if (appMatch) {
    return appMatch[1];
  }

  return APP_TARGETS[app].appPath;
}

/**
 * Get the server command and args, or return null if not found
 *
 * We avoid throwing on startup because a missing server is a common first-run condition
 * (users may not have installed the selected RepoPrompt app or CLI yet). Instead we surface this
 * as a non-fatal warning and only error when a user actually tries to use rp features
 */
export function getServerCommand(
  config: RpConfig,
  app: RpAppId = getActiveApp(config)
): { command: string; args: string[] } | null {
  const appConfig = getAppTargetConfig(config, app);

  if (appConfig.command) {
    return maybeWrapServerCommand(config, {
      command: appConfig.command,
      args: appConfig.args ?? [],
    });
  }

  const discovered = findRepoPromptServer(config, app);
  return discovered ? maybeWrapServerCommand(config, discovered) : null;
}
