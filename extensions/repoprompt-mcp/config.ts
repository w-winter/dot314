// config.ts - Configuration loading for RepoPrompt MCP extension

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import type { RpConfig } from "./types.js";

// Default configuration
const DEFAULT_CONFIG: RpConfig = {
  autoBindOnStart: true,
  persistBinding: true,
  confirmDeletes: true,
  confirmEdits: false,
  collapsedMaxLines: 15,
  suppressHostDisconnectedLog: true,
};

// Common locations for MCP config files
const CONFIG_LOCATIONS = [
  // Pi-specific
  () => path.join(os.homedir(), ".pi", "agent", "repoprompt-mcp.json"),
  () => path.join(os.homedir(), ".pi", "agent", "mcp.json"),
  // Project-local
  () => path.join(process.cwd(), ".pi", "mcp.json"),
  // Generic MCP configs
  () => path.join(os.homedir(), ".config", "mcp", "mcp.json"),
];

// Common RepoPrompt MCP server commands
const REPOPROMPT_SERVER_CANDIDATES = [
  // Direct command
  { command: "rp-mcp-server", args: [] },
  // Via npx
  { command: "npx", args: ["rp-mcp-server"] },
  // Via RepoPrompt CLI
  { command: "rp-cli", args: ["mcp-server"] },
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

/**
 * Find RepoPrompt server config in MCP config files
 */
function findRepoPromptInMcpConfig(): McpServerEntry | null {
  for (const getPath of CONFIG_LOCATIONS) {
    const configPath = getPath();
    const config = tryReadJson<McpConfigFile>(configPath);

    if (!config?.mcpServers) continue;

    // Look for RepoPrompt server (case-insensitive)
    for (const [name, entry] of Object.entries(config.mcpServers)) {
      if (name.toLowerCase().includes("repoprompt") || name.toLowerCase() === "rp") {
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
    // Validate command is a simple identifier (no shell metacharacters)
    if (!/^[\w./-]+$/.test(command)) {
      return false;
    }
    execSync(`which ${command}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Find a working RepoPrompt MCP server command
 */
function findRepoPromptServer(): { command: string; args: string[] } | null {
  // First, check MCP config files
  const configEntry = findRepoPromptInMcpConfig();
  if (configEntry?.command) {
    return {
      command: configEntry.command,
      args: configEntry.args ?? [],
    };
  }

  // Fall back to known candidates
  for (const candidate of REPOPROMPT_SERVER_CANDIDATES) {
    if (commandExists(candidate.command)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Load extension configuration
 */
export function loadConfig(overrides?: Partial<RpConfig>): RpConfig {
  // Start with defaults
  let config: RpConfig = { ...DEFAULT_CONFIG };

  // Try to load from dedicated config file
  const configPath = path.join(os.homedir(), ".pi", "agent", "repoprompt-mcp.json");
  const fileConfig = tryReadJson<Partial<RpConfig>>(configPath);
  if (fileConfig) {
    config = { ...config, ...fileConfig };

    const fileConfigAny = fileConfig as Record<string, unknown>;
    if (fileConfigAny.previewEdits !== undefined && fileConfigAny.confirmEdits === undefined) {
      config.confirmEdits = Boolean(fileConfigAny.previewEdits);
    }
  }

  // Find server command if not specified
  if (!config.command) {
    const server = findRepoPromptServer();
    if (server) {
      config.command = server.command;
      config.args = server.args;
    }
  }

  // Apply overrides
  if (overrides) {
    config = { ...config, ...overrides };
  }

  return config;
}

const FILTERED_STDERR_SUBSTRINGS = [
  // Clean disconnect / shutdown
  "BootstrapSocketProxy: Bridge task failed: hostDisconnected",
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

/**
 * Get the server command and args, or throw if not found
 */
export function getServerCommand(config: RpConfig): { command: string; args: string[] } {
  if (config.command) {
    return maybeWrapServerCommand(config, {
      command: config.command,
      args: config.args ?? [],
    });
  }

  throw new Error(
    "RepoPrompt MCP server not found. Please ensure rp-mcp-server is installed, " +
    "or add RepoPrompt to your ~/.pi/agent/mcp.json"
  );
}
