import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
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
export interface RpBinding {
    windowId: number;
    tab?: string;
    workspace?: string;
    autoDetected?: boolean;
}
export interface RpToolMeta {
    name: string;
    description: string;
    inputSchema?: unknown;
}
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
export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";
export interface RpConnection {
    client: Client;
    transport: StdioClientTransport;
    status: ConnectionStatus;
    tools: RpToolMeta[];
    error?: string;
}
export interface RpConfig {
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    suppressHostDisconnectedLog?: boolean;
    autoBindOnStart?: boolean;
    persistBinding?: boolean;
    confirmDeletes?: boolean;
    confirmEdits?: boolean;
    collapsedMaxLines?: number;
}
export interface RpToolParams {
    call?: string;
    args?: Record<string, unknown>;
    describe?: string;
    search?: string;
    windows?: boolean;
    bind?: {
        window: number;
        tab?: string;
    };
    allowDelete?: boolean;
    confirmEdits?: boolean;
    raw?: boolean;
}
export interface RpExtensionState {
    connection: RpConnection | null;
    binding: RpBinding | null;
    config: RpConfig;
    tools: RpToolMeta[];
    windows: RpWindow[];
}
export declare const BINDING_ENTRY_TYPE = "repoprompt-mcp-binding";
export interface BindingEntryData {
    windowId: number;
    tab?: string;
    workspace?: string;
}
