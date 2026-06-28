// types.ts - Core type definitions for RepoPrompt MCP extension

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// ─────────────────────────────────────────────────────────────────────────────
// RepoPrompt Window & Workspace Types
// ─────────────────────────────────────────────────────────────────────────────

export interface RpWindow {
  id: number;
  workspace: string;
  roots: string[];
  instance?: number;
}

export interface RpTab {
  id: string;
  name: string;
  isActive?: boolean;
  isBound?: boolean;
  selectedFileCount?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Binding State
// ─────────────────────────────────────────────────────────────────────────────

export interface RpBinding {
  app: RpAppId;
  windowId: number;
  tab?: string;
  workspace?: string;
  autoDetected?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool Metadata
// ─────────────────────────────────────────────────────────────────────────────

export interface RpToolMeta {
  name: string;           // Full tool name (e.g., "read_file")
  description: string;
  inputSchema?: unknown;  // JSON Schema
}

// ─────────────────────────────────────────────────────────────────────────────
// MCP Content Types
// ─────────────────────────────────────────────────────────────────────────────

export interface McpTextContent {
  type: "text";
  text: string;
}

export interface McpImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface McpResourceContent {
  type: "resource";
  resource: {
    uri: string;
    text?: string;
    blob?: string;
  };
}

export type McpContent = McpTextContent | McpImageContent | McpResourceContent;

export interface McpToolResult {
  content: McpContent[];
  isError?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Connection State
// ─────────────────────────────────────────────────────────────────────────────

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

export interface RpConnection {
  client: Client;
  transport: StdioClientTransport;
  status: ConnectionStatus;
  tools: RpToolMeta[];
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

export const DIFF_VIEW_MODES = ["auto", "split", "unified"] as const;
export type DiffViewMode = (typeof DIFF_VIEW_MODES)[number];

export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 90 * 60 * 1000;

export const RP_APP_IDS = ["ce", "classic"] as const;
export type RpAppId = (typeof RP_APP_IDS)[number];

export interface RpAppTargetConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  appPath?: string;
  autoLaunchApp?: boolean;
}

export interface RpConfig {
  // App target
  activeApp: RpAppId;
  apps: Record<RpAppId, RpAppTargetConfig>;

  // Server connection
  toolCallTimeoutMs?: number;      // MCP tool call timeout in ms (default: 5_400_000 / 90 minutes)

  // Logging
  suppressHostDisconnectedLog?: boolean;  // Filter known-noisy shutdown log line (default: true)

  // Behavior
  autoBindOnStart?: boolean;       // Auto-detect and bind to matching window (default: true)
  persistBinding?: boolean;        // Remember binding across session (default: true)

  // Safety
  confirmDeletes?: boolean;        // Require confirmation for deletes (default: true)
  confirmEdits?: boolean;          // Require confirmation for edit-like operations (default: false)

  // Display
  collapsedMaxLines?: number;      // Max lines in collapsed view (default: 3)
  diffViewMode?: DiffViewMode;     // Diff layout mode: auto, split, unified (default: auto)
  diffSplitMinWidth?: number;      // Minimum width before auto mode uses split diff layout (default: 120)

  // Optional read_file caching (pi-readcache-like behavior)
  readcacheReadFile?: boolean;     // When true, wrap read_file with hash/diff/unchanged caching (default: false)

  // Optional context UX: automatically update RepoPrompt selection based on read_file calls
  // (tracks read slices/full files so chat_send/"Oracle" has context without manual selection)
  autoSelectReadSlices?: boolean;  // When true, read_file calls add slices/full selection (default: true)

  // /rp oracle behavior
  oracleDefaultMode?: "chat" | "plan" | "edit" | "review"; // Default mode when /rp oracle omits --mode (default: "chat")
}


// ─────────────────────────────────────────────────────────────────────────────
// Tool Call Parameters
// ─────────────────────────────────────────────────────────────────────────────

export interface RpToolParams {
  // Mode selection (priority: call > describe > search > windows > bind > status)
  call?: string;                   // Tool name to call
  args?: Record<string, unknown>;  // Arguments for tool call
  describe?: string;               // Tool name to describe
  search?: string;                 // Search query for tools
  windows?: boolean;               // List all windows
  bind?: {                         // Bind to specific window/tab
    window: number;
    tab?: string;
  };
  
  // Safety overrides
  allowDelete?: boolean;           // Allow delete operations
  confirmEdits?: boolean;          // Confirm edit-like operations when confirmEdits is enabled
}

// ─────────────────────────────────────────────────────────────────────────────
// Extension State
// ─────────────────────────────────────────────────────────────────────────────

export interface RpExtensionState {
  connection: RpConnection | null;
  binding: RpBinding | null;
  config: RpConfig;
  tools: RpToolMeta[];
  windows: RpWindow[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Custom Entry Types (for persistence)
// ─────────────────────────────────────────────────────────────────────────────

export const BINDING_ENTRY_TYPE = "repoprompt-mcp-binding";
export const AUTO_SELECTION_ENTRY_TYPE = "repoprompt-mcp-auto-selection";
export const ACTIVE_APP_ENTRY_TYPE = "repoprompt-mcp-active-app";

export interface ActiveAppEntryData {
  app: RpAppId;
}

export interface BindingEntryData {
  app: RpAppId;
  windowId: number;
  tab?: string;
  workspace?: string;
}

export interface AutoSelectionEntryRangeData {
  start_line: number;
  end_line: number;
}

export interface AutoSelectionEntrySliceData {
  path: string;
  ranges: AutoSelectionEntryRangeData[];
}

export interface AutoSelectionEntryData {
  app: RpAppId;
  windowId: number;
  tab?: string;
  workspace?: string;
  fullPaths: string[];
  slicePaths: AutoSelectionEntrySliceData[];
}
