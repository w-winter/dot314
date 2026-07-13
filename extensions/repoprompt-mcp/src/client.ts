// client.ts - MCP client connection management for RepoPrompt

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { DEFAULT_TOOL_CALL_TIMEOUT_MS } from "./types.js";
import type {
  RpConnection,
  RpToolMeta,
  McpContent,
  McpToolResult,
  ConnectionStatus,
  ToolCatalogFreshness,
} from "./types.js";

const CLIENT_INFO = {
  name: "pi-repoprompt-mcp",
  version: "1.0.0",
};

const DEFAULT_CONNECT_TIMEOUT_MS = 6_000;
const DEFAULT_LIST_TOOLS_TIMEOUT_MS = 10_000;

export interface RpClientTransportOptions {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * Creates the SDK resources owned by one RpClient connection attempt
 *
 * Each factory must return a fresh, unconnected resource. RpClient assumes
 * exclusive ownership when the factory returns; a throwing factory owns any
 * resource it allocated but did not return
 */
export interface RpClientDependencies {
  createClient(): Client;
  createTransport(connection: RpClientTransportOptions): StdioClientTransport;
}

interface ToolCatalogRefreshFlight {
  epoch: number;
  token: symbol;
  promise: Promise<RpToolMeta[]>;
}

const DEFAULT_CLIENT_DEPENDENCIES: RpClientDependencies = {
  createClient: () => new Client(CLIENT_INFO, { capabilities: {} }),
  createTransport: (connection) => new StdioClientTransport(connection),
};

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(message));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
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
  private catalogRefreshError: string | undefined;
  private connectionEpoch = 0;
  private toolListInvalidationGeneration = 0;
  private publishedToolListGeneration: number | null = null;
  private toolCatalogRefreshFlight: ToolCatalogRefreshFlight | null = null;
  private toolCallTimeoutMs = DEFAULT_TOOL_CALL_TIMEOUT_MS;

  constructor(private readonly dependencies: RpClientDependencies = DEFAULT_CLIENT_DEPENDENCIES) {}

  get status(): ConnectionStatus {
    return this._status;
  }

  get tools(): RpToolMeta[] {
    return this._tools;
  }

  get toolCatalogFreshness(): ToolCatalogFreshness {
    if (this._status !== "connected" || this.publishedToolListGeneration === null) {
      return "unavailable";
    }

    return this.publishedToolListGeneration === this.toolListInvalidationGeneration ? "fresh" : "stale";
  }

  get error(): string | undefined {
    return this.catalogRefreshError ?? this._error;
  }

  get isConnected(): boolean {
    return this._status === "connected" && this.client !== null;
  }

  setToolCallTimeoutMs(timeoutMs: number): void {
    this.toolCallTimeoutMs = timeoutMs;
  }

  /**
   * Connect to the RepoPrompt MCP server
   */
  async connect(
    command: string,
    args: string[],
    env?: Record<string, string>,
    toolCallTimeoutMs = DEFAULT_TOOL_CALL_TIMEOUT_MS
  ): Promise<void> {
    if (this._status === "connecting") {
      throw new Error("Connection already in progress");
    }

    await this.close();

    const connectionEpoch = ++this.connectionEpoch;
    this._status = "connecting";
    this._error = undefined;
    this.catalogRefreshError = undefined;
    this.toolListInvalidationGeneration = 0;
    this.publishedToolListGeneration = null;
    this.toolCatalogRefreshFlight = null;
    this.toolCallTimeoutMs = toolCallTimeoutMs;

    let transport: StdioClientTransport | null = null;
    let client: Client | null = null;

    try {
      const mergedEnv: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) {
          mergedEnv[key] = value;
        }
      }
      if (env) {
        Object.assign(mergedEnv, env);
      }

      transport = this.dependencies.createTransport({
        command,
        args,
        env: Object.keys(mergedEnv).length > 0 ? mergedEnv : undefined,
      });
      this.transport = transport;

      const createdClient = this.dependencies.createClient();
      client = createdClient;
      this.client = createdClient;

      createdClient.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        this.handleToolListChanged(createdClient, connectionEpoch);
      });

      await withTimeout(
        client.connect(transport),
        DEFAULT_CONNECT_TIMEOUT_MS,
        `Timed out connecting to RepoPrompt MCP server after ${DEFAULT_CONNECT_TIMEOUT_MS}ms`
      );
      await this.refreshTools();

      for (;;) {
        this.assertCurrentConnection(client, connectionEpoch);
        if (this.publishedToolListGeneration === this.toolListInvalidationGeneration) {
          this._status = "connected";
          return;
        }
        await this.refreshTools();
      }
    } catch (error) {
      if (this.connectionEpoch === connectionEpoch) {
        await this.cleanupFailedConnection(client, transport, connectionEpoch, error);
      }
      throw error;
    }
  }

  /**
   * Refresh the list of available tools
   */
  refreshTools(timeoutMs = DEFAULT_LIST_TOOLS_TIMEOUT_MS): Promise<RpToolMeta[]> {
    const client = this.client;
    const connectionEpoch = this.connectionEpoch;
    if (!client) {
      return Promise.reject(new Error("Not connected"));
    }

    if (this.toolCatalogRefreshFlight) {
      return this.toolCatalogRefreshFlight.promise;
    }

    const token = Symbol("tool-catalog-refresh");
    let resolveFlight!: (tools: RpToolMeta[]) => void;
    let rejectFlight!: (error: unknown) => void;
    const promise = new Promise<RpToolMeta[]>((resolve, reject) => {
      resolveFlight = resolve;
      rejectFlight = reject;
    });

    this.toolCatalogRefreshFlight = { epoch: connectionEpoch, token, promise };
    void this.drainToolCatalog(client, connectionEpoch, token, timeoutMs).then(resolveFlight, rejectFlight);
    return promise;
  }

  private async drainToolCatalog(
    client: Client,
    connectionEpoch: number,
    token: symbol,
    timeoutMs: number
  ): Promise<RpToolMeta[]> {
    try {
      for (;;) {
        this.assertCurrentConnection(client, connectionEpoch);
        const requestGeneration = this.toolListInvalidationGeneration;

        let result;
        try {
          result = await client.listTools(undefined, { timeout: timeoutMs });
        } catch (error) {
          this.assertCurrentConnection(client, connectionEpoch);
          if (requestGeneration !== this.toolListInvalidationGeneration) {
            continue;
          }

          if (this._status === "connected") {
            const message = error instanceof Error ? error.message : String(error);
            this.catalogRefreshError = message;
            console.warn(
              `[repoprompt-mcp] Tool catalog refresh failed (epoch ${connectionEpoch}, ` +
              `generation ${requestGeneration}, observed ${this.toolListInvalidationGeneration}): ${message}`
            );
          }
          throw error;
        }

        this.assertCurrentConnection(client, connectionEpoch);
        if (requestGeneration !== this.toolListInvalidationGeneration) {
          continue;
        }

        const tools = result.tools.map((tool) => ({
          name: tool.name,
          description: tool.description ?? "",
          inputSchema: tool.inputSchema,
        }));
        this._tools = tools;
        this.publishedToolListGeneration = requestGeneration;
        this.catalogRefreshError = undefined;
        return tools;
      }
    } finally {
      const flight = this.toolCatalogRefreshFlight;
      if (flight?.epoch === connectionEpoch && flight.token === token) {
        this.toolCatalogRefreshFlight = null;
      }
    }
  }

  private handleToolListChanged(client: Client, connectionEpoch: number): void {
    if (!this.isCurrentConnection(client, connectionEpoch)) {
      return;
    }

    this.toolListInvalidationGeneration += 1;
    if (this._status === "connected") {
      void this.refreshTools().catch(() => {
        // The shared refresh records the diagnostic; contain notification callback rejection
      });
    }
  }

  private isCurrentConnection(client: Client, connectionEpoch: number): boolean {
    return this.client === client && this.connectionEpoch === connectionEpoch;
  }

  private assertCurrentConnection(client: Client, connectionEpoch: number): void {
    if (!this.isCurrentConnection(client, connectionEpoch)) {
      throw new Error("RepoPrompt MCP connection changed during tool catalog refresh");
    }
  }

  private async cleanupFailedConnection(
    client: Client | null,
    transport: StdioClientTransport | null,
    connectionEpoch: number,
    error: unknown
  ): Promise<void> {
    if (this.connectionEpoch !== connectionEpoch) {
      return;
    }

    this.connectionEpoch += 1;
    this.client = null;
    this.transport = null;
    this._status = "disconnected";
    this._tools = [];
    this.toolListInvalidationGeneration = 0;
    this.publishedToolListGeneration = null;
    this.toolCatalogRefreshFlight = null;
    this.catalogRefreshError = undefined;
    this._error = error instanceof Error ? error.message : String(error);

    if (client) {
      await Promise.resolve().then(() => client.close()).catch(() => undefined);
    }
    if (transport) {
      await Promise.resolve().then(() => transport.close()).catch(() => undefined);
    }
  }

  /**
   * Call a tool on the RepoPrompt MCP server
   */
  async callTool(
    name: string,
    args?: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<McpToolResult> {
    if (!this.client) {
      throw new Error("Not connected to RepoPrompt MCP server");
    }

    const resolvedTimeoutMs = timeoutMs ?? this.toolCallTimeoutMs;

    let result;
    try {
      result = await this.client.callTool(
        {
          name,
          arguments: args ?? {},
        },
        undefined,
        { timeout: resolvedTimeoutMs }
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // Do NOT tear down the whole MCP connection on tool-call failures. Tool errors
      // (including timeouts) are common and should not force users to /rp reconnect
      this._error = message;
      throw new Error(message);
    }

    // Transform content to our types
    const content: McpContent[] = (result.content as unknown[]).map((c) => {
      const item = c as Record<string, unknown>;

      if (item.type === "text") {
        return { type: "text" as const, text: typeof item.text === "string" ? item.text : "" };
      }
      if (item.type === "image") {
        return {
          type: "image" as const,
          data: typeof item.data === "string" ? item.data : "",
          mimeType: typeof item.mimeType === "string" ? item.mimeType : "image/png",
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
    const client = this.client;
    const transport = this.transport;
    const wasConnecting = this._status === "connecting";

    this.connectionEpoch += 1;
    this.client = null;
    this.transport = null;
    this._status = "disconnected";
    this._tools = [];
    this.toolListInvalidationGeneration = 0;
    this.publishedToolListGeneration = null;
    this.toolCatalogRefreshFlight = null;
    this.catalogRefreshError = undefined;

    // If connect() never completed, skip the graceful MCP close and tear down the transport directly
    if (client && !wasConnecting) {
      await Promise.resolve().then(() => client.close()).catch(() => undefined);
    }

    if (transport) {
      await Promise.resolve().then(() => transport.close()).catch(() => undefined);
    }
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
      toolCatalogFreshness: this.toolCatalogFreshness,
      error: this.error,
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
