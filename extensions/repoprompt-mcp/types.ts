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
}

// ─────────────────────────────────────────────────────────────────────────────
// Binding State
// ─────────────────────────────────────────────────────────────────────────────

export interface RpBinding {
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

export interface RpConfig {
  // Server connection
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  
  // Logging
  suppressHostDisconnectedLog?: boolean;  // Filter known-noisy shutdown log line (default: true)
  
  // Behavior
  autoBindOnStart?: boolean;       // Auto-detect and bind to matching window (default: true)
  persistBinding?: boolean;        // Remember binding across session (default: true)
  
  // Safety
  confirmDeletes?: boolean;        // Require confirmation for deletes (default: true)
  confirmEdits?: boolean;          // Require confirmation for edit-like operations (default: false)
  
  // Display
  collapsedMaxLines?: number;      // Max lines in collapsed view (default: 15)
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
  
  // Formatting
  raw?: boolean;                   // Return raw output without formatting
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

export interface BindingEntryData {
  windowId: number;
  tab?: string;
  workspace?: string;
}
