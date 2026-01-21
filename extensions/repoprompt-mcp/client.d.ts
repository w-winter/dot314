import type { RpConnection, RpToolMeta, McpToolResult, ConnectionStatus } from "./types.js";
/**
 * Manages the MCP connection to RepoPrompt server
 */
export declare class RpClient {
    private client;
    private transport;
    private _status;
    private _tools;
    private _error;
    get status(): ConnectionStatus;
    get tools(): RpToolMeta[];
    get error(): string | undefined;
    get isConnected(): boolean;
    /**
     * Connect to the RepoPrompt MCP server
     */
    connect(command: string, args: string[], env?: Record<string, string>): Promise<void>;
    /**
     * Refresh the list of available tools
     */
    refreshTools(timeoutMs?: number): Promise<RpToolMeta[]>;
    /**
     * Call a tool on the RepoPrompt MCP server
     */
    callTool(name: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<McpToolResult>;
    /**
     * Close the connection
     */
    close(): Promise<void>;
    /**
     * Get connection info for debugging
     */
    getConnectionInfo(): RpConnection | null;
}
/**
 * Get the shared RpClient instance
 */
export declare function getRpClient(): RpClient;
/**
 * Reset the client (for testing or reconnection)
 */
export declare function resetRpClient(): Promise<void>;
