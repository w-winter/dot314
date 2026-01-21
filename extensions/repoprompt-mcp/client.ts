// client.ts - MCP client connection management for RepoPrompt

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type {
  RpConnection,
  RpToolMeta,
  McpContent,
  McpToolResult,
  ConnectionStatus,
} from "./types.js";

const CLIENT_INFO = {
  name: "pi-repoprompt-mcp",
  version: "1.0.0",
};

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

/**
 * Manages the MCP connection to RepoPrompt server
 */
export class RpClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private _status: ConnectionStatus = "disconnected";
  private _tools: RpToolMeta[] = [];
  private _error: string | undefined;
  
  get status(): ConnectionStatus {
    return this._status;
  }
  
  get tools(): RpToolMeta[] {
    return this._tools;
  }
  
  get error(): string | undefined {
    return this._error;
  }
  
  get isConnected(): boolean {
    return this._status === "connected" && this.client !== null;
  }
  
  /**
   * Connect to the RepoPrompt MCP server
   */
  async connect(
    command: string,
    args: string[],
    env?: Record<string, string>
  ): Promise<void> {
    if (this._status === "connecting") {
      throw new Error("Connection already in progress");
    }
    
    // Close existing connection if any
    await this.close();
    
    this._status = "connecting";
    this._error = undefined;
    
    try {
      // Create transport
      const mergedEnv: Record<string, string> = {};
      if (process.env) {
        for (const [k, v] of Object.entries(process.env)) {
          if (v !== undefined) mergedEnv[k] = v;
        }
      }
      if (env) {
        Object.assign(mergedEnv, env);
      }
      
      this.transport = new StdioClientTransport({
        command,
        args,
        env: Object.keys(mergedEnv).length > 0 ? mergedEnv : undefined,
      });
      
      // Create client
      this.client = new Client(CLIENT_INFO, {
        capabilities: {},
      });
      
      // Connect
      await this.client.connect(this.transport);
      
      // Fetch available tools
      await this.refreshTools();
      
      this._status = "connected";
    } catch (error) {
      this._status = "error";
      this._error = error instanceof Error ? error.message : String(error);
      
      // Clean up on error
      await this.close();
      
      throw error;
    }
  }
  
  /**
   * Refresh the list of available tools
   */
  async refreshTools(timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<RpToolMeta[]> {
    if (!this.client) {
      throw new Error("Not connected");
    }

    const result = await withTimeout(this.client.listTools(), timeoutMs, "RepoPrompt listTools");

    this._tools = (result.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema,
    }));

    return this._tools;
  }
  
  /**
   * Call a tool on the RepoPrompt MCP server
   */
  async callTool(
    name: string,
    args?: Record<string, unknown>,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
  ): Promise<McpToolResult> {
    if (!this.client) {
      throw new Error("Not connected to RepoPrompt MCP server");
    }

    let result;
    try {
      result = await withTimeout(
        this.client.callTool({
          name,
          arguments: args ?? {},
        }),
        timeoutMs,
        `RepoPrompt callTool(${name})`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this._status = "error";
      this._error = message;
      await this.close();
      throw new Error(message);
    }

    // Transform content to our types
    const content: McpContent[] = ((result.content as unknown[]) ?? []).map((c) => {
      const item = c as Record<string, unknown>;

      if (item.type === "text") {
        return { type: "text" as const, text: (item.text as string) ?? "" };
      }
      if (item.type === "image") {
        return {
          type: "image" as const,
          data: (item.data as string) ?? "",
          mimeType: (item.mimeType as string) ?? "image/png",
        };
      }
      if (item.type === "resource") {
        return {
          type: "resource" as const,
          resource: item.resource as { uri: string; text?: string; blob?: string },
        };
      }

      // Fallback: stringify unknown content
      return { type: "text" as const, text: JSON.stringify(c) };
    });

    return {
      content,
      isError: Boolean(result.isError),
    };
  }
  
  /**
   * Close the connection
   */
  async close(): Promise<void> {
    if (this.client) {
      try {
        await this.client.close();
      } catch {
        // Ignore close errors
      }
      this.client = null;
    }

    if (this.transport) {
      try {
        await this.transport.close();
      } catch {
        // Ignore close errors
      }
      this.transport = null;
    }

    this._status = "disconnected";
    this._tools = [];
  }
  
  /**
   * Get connection info for debugging
   */
  getConnectionInfo(): RpConnection | null {
    if (!this.client || !this.transport) {
      return null;
    }
    
    return {
      client: this.client,
      transport: this.transport,
      status: this._status,
      tools: this._tools,
      error: this._error,
    };
  }
}

// Singleton instance
let clientInstance: RpClient | null = null;

/**
 * Get the shared RpClient instance
 */
export function getRpClient(): RpClient {
  if (!clientInstance) {
    clientInstance = new RpClient();
  }
  return clientInstance;
}

/**
 * Reset the client (for testing or reconnection)
 */
export async function resetRpClient(): Promise<void> {
  if (clientInstance) {
    await clientInstance.close();
    clientInstance = null;
  }
}
