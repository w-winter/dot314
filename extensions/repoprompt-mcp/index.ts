// index.ts - RepoPrompt MCP Extension for Pi
//
// First-class RepoPrompt integration with:
// - Auto-detection of matching windows based on cwd
// - Syntax highlighting for code blocks
// - Word-level diff highlighting
// - Safety guards for destructive operations
// - Persistent window binding across sessions

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolRenderResultOptions,
  Theme,
} from "@mariozechner/pi-coding-agent";
import { Text, matchesKey, visibleWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

import type {
  RpToolParams,
  RpConfig,
  RpBinding,
  RpWindow,
  RpToolMeta,
  McpContent,
} from "./types.js";
import { loadConfig, getServerCommand } from "./config.js";
import { getRpClient, resetRpClient } from "./client.js";
import {
  getBinding,
  clearBinding,
  restoreBinding,
  autoDetectAndBind,
  bindToWindow,
  fetchWindows,
  getBindingArgs,
} from "./binding.js";
import { renderRpOutput, prepareCollapsedView } from "./render.js";
import { checkGuards, normalizeToolName, isNoopEdit, isEditOperation } from "./guards.js";
import { extractJsonContent, extractTextContent } from "./mcp-json.js";
import { resolveToolName } from "./tool-names.js";

// ─────────────────────────────────────────────────────────────────────────────
// Tool Parameters Schema
// ─────────────────────────────────────────────────────────────────────────────

const RpToolSchema = Type.Object({
  // Mode selection (priority: call > describe > search > windows > bind > status)
  call: Type.Optional(Type.String({ description: "Tool name to call (e.g., 'read_file', 'apply_edits')" })),
  args: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Arguments for tool call" })),
  describe: Type.Optional(Type.String({ description: "Tool name to describe (shows parameters)" })),
  search: Type.Optional(Type.String({ description: "Search query for tools (space-separated words OR'd)" })),
  windows: Type.Optional(Type.Boolean({ description: "List all RepoPrompt windows" })),
  bind: Type.Optional(
    Type.Object({
      window: Type.Number({ description: "Window ID to bind to" }),
      tab: Type.Optional(Type.String({ description: "Tab name or ID to bind to" })),
    })
  ),
  
  // Safety overrides
  allowDelete: Type.Optional(Type.Boolean({ description: "Allow delete operations (default: false)" })),
  confirmEdits: Type.Optional(
    Type.Boolean({ description: "Confirm edit-like operations (required when confirmEdits is enabled)" })
  ),
  
  // Formatting
  raw: Type.Optional(Type.Boolean({ description: "Return raw output without formatting" })),
});

// ─────────────────────────────────────────────────────────────────────────────
// Extension Entry Point
// ─────────────────────────────────────────────────────────────────────────────

export default function repopromptMcp(pi: ExtensionAPI) {
  let config: RpConfig = loadConfig();
  let initPromise: Promise<void> | null = null;
  
  // ───────────────────────────────────────────────────────────────────────────
  // Lifecycle Events
  // ───────────────────────────────────────────────────────────────────────────
  
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) {
      // This extension used to set a status bar item; clear it to avoid persisting stale UI state
      ctx.ui.setStatus("rp", undefined);
    }

    // Non-blocking initialization
    initPromise = initializeExtension(pi, ctx, config);

    initPromise.then(() => {
      initPromise = null;
    }).catch((err) => {
      console.error("RepoPrompt MCP initialization failed:", err);
      initPromise = null;
      if (ctx.hasUI) {
        ctx.ui.notify(`RepoPrompt: ${err.message}`, "error");
      }
    });
  });
  
  pi.on("session_shutdown", async () => {
    if (initPromise) {
      try {
        await initPromise;
      } catch {
        // Ignore
      }
    }
    await resetRpClient();
  });
  
  pi.on("session_switch", async (_event: unknown, ctx: ExtensionContext) => {
    restoreBinding(ctx, config);
    if (ctx.hasUI) {
      ctx.ui.setStatus("rp", undefined);
    }
  });
  
  pi.on("session_tree", async (_event: unknown, ctx: ExtensionContext) => {
    restoreBinding(ctx, config);
    if (ctx.hasUI) {
      ctx.ui.setStatus("rp", undefined);
    }
  });
  
  // ───────────────────────────────────────────────────────────────────────────
  // Commands
  // ───────────────────────────────────────────────────────────────────────────
  
  pi.registerCommand("rp", {
    description: "RepoPrompt status and commands. Usage: /rp [status|windows|bind [id]]",
    handler: async (args, ctx) => {
      const parts = args?.trim().split(/\s+/) ?? [];
      const subcommand = parts[0]?.toLowerCase() ?? "status";

      // Allow status/reconnect while disconnected
      if (subcommand !== "reconnect" && subcommand !== "status") {
        await ensureConnected();
      }
      
      switch (subcommand) {
        case "status":
          await showStatus(ctx);
          break;
        
        case "windows":
          await showWindows(ctx);
          break;
        
        case "bind": {
          const windowIdArg = parts[1];
          const tab = windowIdArg ? parts[2] : undefined;

          let windowId: number | null = null;

          if (!windowIdArg) {
            if (!ctx.hasUI) {
              console.error("Usage: /rp bind <window_id> [tab]");
              return;
            }

            try {
              const windows = await fetchWindows();
              if (windows.length === 0) {
                ctx.ui.notify("No RepoPrompt windows found", "warning");
                return;
              }

              const selected = await promptForWindowSelection(ctx, windows);
              if (!selected) {
                ctx.ui.notify("Cancelled", "info");
                return;
              }

              windowId = selected.id;
            } catch (err) {
              ctx.ui.notify(`Failed to list windows: ${err instanceof Error ? err.message : err}`, "error");
              return;
            }
          } else {
            const parsed = parseInt(windowIdArg, 10);
            if (!Number.isFinite(parsed)) {
              ctx.ui.notify("Usage: /rp bind [window_id] [tab]", "error");
              return;
            }
            windowId = parsed;
          }

          try {
            const binding = await bindToWindow(pi, windowId, tab, config);
            ctx.ui.notify(
              `Bound to window ${binding.windowId}` +
              (binding.workspace ? ` (${binding.workspace})` : "") +
              (binding.tab ? `, tab "${binding.tab}"` : ""),
              "info"
            );
          } catch (err) {
            ctx.ui.notify(`Failed to bind: ${err instanceof Error ? err.message : err}`, "error");
          }
          break;
        }
        
        case "reconnect":
          try {
            await resetRpClient();
            await initializeExtension(pi, ctx, config);
            ctx.ui.notify("RepoPrompt reconnected", "info");
          } catch (err) {
            ctx.ui.notify(`Reconnection failed: ${err instanceof Error ? err.message : err}`, "error");
          }
          break;

        default:
          ctx.ui.notify(
            "RepoPrompt commands:\n" +
            "  /rp status       - Show connection and binding status\n" +
            "  /rp windows      - List available windows\n" +
            "  /rp bind         - Pick a window to bind (interactive)\n" +
            "  /rp bind <id>    - Bind to a specific window\n" +
            "  /rp reconnect    - Reconnect to RepoPrompt",
            "info"
          );
      }
    },
  });
  
  // ───────────────────────────────────────────────────────────────────────────
  // Main Tool Registration
  // ───────────────────────────────────────────────────────────────────────────
  
  pi.registerTool({
    name: "rp",
    label: "RepoPrompt",
    description: `RepoPrompt integration - file selection, code structure, edits, and more.

Usage:
  rp({ })                              → Status (bound window, connection)
  rp({ windows: true })                → List all RepoPrompt windows
  rp({ bind: { window: 1 } })          → Bind to a specific window
  rp({ search: "query" })              → Search for tools
  rp({ describe: "tool_name" })        → Show tool parameters
  rp({ call: "tool_name", args: {...}})→ Call a tool

Common tools: read_file, get_file_tree, get_code_structure, file_search, 
apply_edits, manage_selection, workspace_context

Mode priority: call > describe > search > windows > bind > status`,
    
    parameters: RpToolSchema,
    
    async execute(_toolCallId, params: RpToolParams, onUpdate, _ctx, _signal) {
      // Provide a no-op if onUpdate is undefined
      const safeOnUpdate = onUpdate ?? (() => {});

      // Only modes that need MCP require a connection
      if (params.call || params.describe || params.search || params.windows || params.bind) {
        await ensureConnected();
      }

      // Mode resolution: call > describe > search > windows > bind > status
      if (params.call) {
        return executeToolCall(params, safeOnUpdate);
      }
      if (params.describe) {
        return executeDescribe(params.describe);
      }
      if (params.search) {
        return executeSearch(params.search);
      }
      if (params.windows) {
        return executeListWindows();
      }
      if (params.bind) {
        return executeBinding(pi, params.bind.window, params.bind.tab);
      }
      return executeStatus();
    },
    
    renderCall(args: Record<string, unknown>, theme: Theme) {
      let text = theme.fg("toolTitle", theme.bold("rp"));
      
      if (args.call) {
        text += " " + theme.fg("accent", String(args.call));
        if (args.args && typeof args.args === "object") {
          const keys = Object.keys(args.args as object);
          if (keys.length > 0) {
            text += theme.fg("muted", ` (${keys.join(", ")})`);
          }
        }
      } else if (args.search) {
        text += " " + theme.fg("muted", `search: "${args.search}"`);
      } else if (args.describe) {
        text += " " + theme.fg("muted", `describe: ${args.describe}`);
      } else if (args.windows) {
        text += " " + theme.fg("muted", "windows");
      } else if (args.bind) {
        const bind = args.bind as { window: number; tab?: string };
        text += " " + theme.fg("muted", `bind: window ${bind.window}`);
      } else {
        text += " " + theme.fg("muted", "status");
      }
      
      // Show binding info
      const binding = getBinding();
      if (binding) {
        text += theme.fg("dim", ` → W${binding.windowId}`);
        if (binding.workspace) {
          text += theme.fg("dim", ` (${binding.workspace})`);
        }
      }
      
      return new Text(text, 0, 0);
    },
    
    renderResult(
      result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
      options: ToolRenderResultOptions,
      theme: Theme
    ) {
      const details = (result.details ?? {}) as Record<string, unknown>;
      const mode = details.mode as string | undefined;
      
      // Get text content
      const textContent = result.content
        .filter((c) => c.type === "text")
        .map((c) => c.text || "")
        .join("\n");
      
      // Handle partial/streaming state
      if (options.isPartial) {
        return new Text(theme.fg("warning", "Running…"), 0, 0);
      }
      
      // Handle errors (check both result.isError and details.isError)
      const isError = result.isError || details.isError;
      if (isError) {
        return new Text(theme.fg("error", "✗ " + textContent), 0, 0);
      }
      
      // Handle raw mode
      if (details.raw) {
        return new Text(textContent, 0, 0);
      }
      
      // Success case - apply rendering
      const successPrefix = theme.fg("success", "✓");
      
      // Collapsed view
      if (!options.expanded) {
        const { content, truncated, totalLines } = prepareCollapsedView(
          textContent,
          theme,
          config.collapsedMaxLines
        );
        
        if (truncated) {
          const remaining = totalLines - (config.collapsedMaxLines ?? 15);
          const moreText = theme.fg("muted", `\n… (${remaining} more lines)`);
          return new Text(`${successPrefix}\n${content}${moreText}`, 0, 0);
        }
        
        return new Text(`${successPrefix}\n${content}`, 0, 0);
      }
      
      // Expanded view - full rendering
      const highlighted = renderRpOutput(textContent, theme);
      return new Text(`${successPrefix}\n${highlighted}`, 0, 0);
    },
  });
  
  // ───────────────────────────────────────────────────────────────────────────
  // Helper Functions
  // ───────────────────────────────────────────────────────────────────────────
  
  async function ensureConnected(): Promise<void> {
    if (initPromise) {
      await initPromise;
    }
    
    const client = getRpClient();
    if (!client.isConnected) {
      throw new Error("Not connected to RepoPrompt. Run /rp reconnect");
    }
  }

  function parseNumber(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === "string") {
      const normalized = value.replace(/,/g, "").trim();
      const parsed = parseInt(normalized, 10);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }

    return undefined;
  }

  function parseSelectionSummaryFromJson(
    value: unknown
  ): { fileCount?: number; tokens?: number } | null {
    if (!value || typeof value !== "object") {
      return null;
    }

    const root = value as Record<string, unknown>;
    const selection =
      root.selection && typeof root.selection === "object"
        ? (root.selection as Record<string, unknown>)
        : null;
    const summary =
      root.summary && typeof root.summary === "object" ? (root.summary as Record<string, unknown>) : null;

    const candidates = [root, selection, summary].filter(Boolean) as Array<Record<string, unknown>>;

    for (const candidate of candidates) {
      const fileCount = parseNumber(candidate.fileCount ?? candidate.files ?? candidate.file_count);
      const tokens = parseNumber(candidate.tokens ?? candidate.totalTokens ?? candidate.total_tokens);

      if (fileCount !== undefined || tokens !== undefined) {
        return { fileCount, tokens };
      }
    }

    return null;
  }

  function parseSelectionSummaryFromText(text: string): { fileCount?: number; tokens?: number } | null {
    const fileMatch = text.match(/\bFiles:\s*([\d,]+)/i);
    const tokenMatch = text.match(/\b([\d,]+)\s+total\s+tokens\b/i);

    const fileCount = fileMatch ? parseNumber(fileMatch[1]) : undefined;
    const tokens = tokenMatch ? parseNumber(tokenMatch[1]) : undefined;

    if (fileCount === undefined && tokens === undefined) {
      return null;
    }

    return { fileCount, tokens };
  }

  async function getSelectionSummary(): Promise<{ fileCount?: number; tokens?: number } | null> {
    const binding = getBinding();
    const client = getRpClient();

    if (!binding || !client.isConnected) {
      return null;
    }

    try {
      const manageSelectionToolName = resolveToolName(client.tools, "manage_selection");
      if (!manageSelectionToolName) {
        return null;
      }

      const result = await client.callTool(manageSelectionToolName, {
        op: "get",
        view: "summary",
        ...getBindingArgs(),
      });

      if (result.isError) {
        return null;
      }

      const json = extractJsonContent(result.content);
      const fromJson = parseSelectionSummaryFromJson(json);
      if (fromJson) {
        return fromJson;
      }

      const text = extractTextContent(result.content);
      return parseSelectionSummaryFromText(text);
    } catch {
      return null;
    }
  }

  async function showStatus(ctx: ExtensionContext): Promise<void> {
    const client = getRpClient();
    const binding = getBinding();
    
    let msg = `RepoPrompt Status\n`;
    msg += `─────────────────\n`;
    msg += `Connection: ${client.isConnected ? "✓ connected" : "✗ disconnected"}\n`;
    msg += `Tools: ${client.tools.length}\n`;
    
    if (binding) {
      msg += `\nBound to:\n`;
      msg += `  Window: ${binding.windowId}\n`;
      if (binding.workspace) msg += `  Workspace: ${binding.workspace}\n`;
      if (binding.tab) msg += `  Tab: ${binding.tab}\n`;
      if (binding.autoDetected) msg += `  (auto-detected from cwd)\n`;

      const selectionSummary = await getSelectionSummary();
      if (selectionSummary) {
        msg += `\nSelection:\n`;
        if (typeof selectionSummary.fileCount === "number") {
          msg += `  Files: ${selectionSummary.fileCount}\n`;
        }
        if (typeof selectionSummary.tokens === "number") {
          msg += `  Tokens: ~${selectionSummary.tokens}\n`;
        }
      }
    } else {
      msg += `\nNot bound to any window. Use /rp bind <id> or rp({ windows: true })\n`;
    }
    
    ctx.ui.notify(msg, "info");
  }
  
  async function showWindows(ctx: ExtensionContext): Promise<void> {
    const windows = await fetchWindows();
    
    if (windows.length === 0) {
      ctx.ui.notify("No RepoPrompt windows found", "warning");
      return;
    }
    
    let msg = `RepoPrompt Windows\n`;
    msg += `──────────────────\n`;
    
    const binding = getBinding();
    for (const w of windows) {
      const isBound = binding?.windowId === w.id;
      const marker = isBound ? " ← bound" : "";
      msg += `  ${w.id}: ${w.workspace}${marker}\n`;
    }
    
    msg += `\nUse /rp bind <id> to bind to a window`;
    
    ctx.ui.notify(msg, "info");
  }
  
  // ───────────────────────────────────────────────────────────────────────────
  // Tool Execution Modes
  // ───────────────────────────────────────────────────────────────────────────
  
  async function executeStatus() {
    const client = getRpClient();
    const binding = getBinding();
    
    let text = `RepoPrompt: ${client.status}\n`;
    if (client.error) {
      text += `Error: ${client.error}\n`;
    }
    text += `Tools: ${client.tools.length}\n`;
    
    if (binding) {
      text += `\nBound to window ${binding.windowId}`;
      if (binding.workspace) text += ` (${binding.workspace})`;
      if (binding.autoDetected) text += " [auto-detected]";
    } else {
      text += `\nNot bound. Use rp({ windows: true }) to list windows, then rp({ bind: { window: <id> } })`;
    }
    
    return {
      content: [{ type: "text" as const, text }],
      details: { mode: "status", status: client.status, error: client.error, binding },
    };
  }
  
  async function executeListWindows() {
    const windows = await fetchWindows();
    
    if (windows.length === 0) {
      return {
        content: [{ type: "text" as const, text: "No RepoPrompt windows found. Is RepoPrompt running?" }],
        details: { mode: "windows", windows: [] },
      };
    }
    
    let text = `## RepoPrompt Windows\n\n`;
    
    const binding = getBinding();
    for (const w of windows) {
      const isBound = binding?.windowId === w.id;
      const marker = isBound ? " ✓" : "";
      text += `- Window \`${w.id}\` • ${w.workspace}${marker}\n`;
    }
    
    text += `\nUse rp({ bind: { window: <id> } }) to bind`;
    
    return {
      content: [{ type: "text" as const, text }],
      details: { mode: "windows", windows, count: windows.length },
    };
  }
  
  async function executeBinding(extensionApi: ExtensionAPI, windowId: number, tab?: string) {
    const binding = await bindToWindow(extensionApi, windowId, tab, config);
    
    let text = `## Bound ✅\n`;
    text += `- **Window**: ${binding.windowId}\n`;
    if (binding.workspace) text += `- **Workspace**: ${binding.workspace}\n`;
    if (binding.tab) text += `- **Tab**: ${binding.tab}\n`;
    
    return {
      content: [{ type: "text" as const, text }],
      details: { mode: "bind", binding },
    };
  }
  
  async function executeSearch(query: string) {
    const client = getRpClient();
    const tools = client.tools;
    
    // Split query into terms and match any
    const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
    
    const matches = tools.filter((tool) => {
      const searchText = `${tool.name} ${tool.description}`.toLowerCase();
      return terms.some((term) => searchText.includes(term));
    });
    
    if (matches.length === 0) {
      return {
        content: [{ type: "text" as const, text: `No tools matching "${query}"` }],
        details: { mode: "search", query, matches: [], count: 0 },
      };
    }
    
    let text = `## Found ${matches.length} tool(s) matching "${query}"\n\n`;
    
    for (const tool of matches) {
      text += `**${tool.name}**\n`;
      text += `  ${tool.description || "(no description)"}\n`;
      if (tool.inputSchema) {
        text += `  Parameters: ${formatSchemaCompact(tool.inputSchema)}\n`;
      }
      text += `\n`;
    }
    
    return {
      content: [{ type: "text" as const, text: text.trim() }],
      details: { mode: "search", query, matches: matches.map((m) => m.name), count: matches.length },
    };
  }
  
  async function executeDescribe(toolName: string) {
    const client = getRpClient();
    const normalized = normalizeToolName(toolName);
    
    const tool = client.tools.find(
      (t) => t.name === toolName || t.name === normalized || normalizeToolName(t.name) === normalized
    );
    
    if (!tool) {
      return {
        content: [{ type: "text" as const, text: `Tool "${toolName}" not found. Use rp({ search: "..." }) to search.` }],
        details: { mode: "describe", error: "not_found", requestedTool: toolName },
      };
    }
    
    let text = `## ${tool.name}\n\n`;
    text += `${tool.description || "(no description)"}\n\n`;
    
    if (tool.inputSchema) {
      text += `### Parameters\n\n`;
      text += formatSchema(tool.inputSchema);
    } else {
      text += `No parameters defined.\n`;
    }
    
    return {
      content: [{ type: "text" as const, text }],
      details: { mode: "describe", tool },
    };
  }
  
  async function executeToolCall(
    params: RpToolParams,
    onUpdate: (partialResult: { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }) => void
  ) {
    const client = getRpClient();
    const toolName = normalizeToolName(params.call!);
    
    // Validate tool exists
    const tool = client.tools.find(
      (t) => t.name === toolName || normalizeToolName(t.name) === toolName
    );
    
    if (!tool) {
      return {
        content: [{ type: "text" as const, text: `Tool "${params.call}" not found. Use rp({ search: "..." }) to search.` }],
        details: { mode: "call", error: "not_found", requestedTool: params.call },
      };
    }
    
    // Check safety guards
    const guardResult = checkGuards(tool.name, params.args, config, {
      allowDelete: params.allowDelete,
      confirmEdits: params.confirmEdits,
    });
    
    if (!guardResult.allowed) {
      return {
        content: [{ type: "text" as const, text: guardResult.reason! }],
        details: { mode: "call", error: "blocked", tool: tool.name },
      };
    }
    
    // Merge binding args with user args
    const bindingArgs = getBindingArgs();
    const mergedArgs = { ...(params.args ?? {}), ...bindingArgs };
    
    onUpdate({
      content: [{ type: "text", text: `Calling ${tool.name}…` }],
      details: { mode: "call", tool: tool.name, status: "running" },
    });
    
    try {
      const result = await client.callTool(tool.name, mergedArgs);
      
      // Transform content to text
      const textContent = result.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      
      // Check for noop edits
      const editNoop = isEditOperation(tool.name) && isNoopEdit(textContent);
      
      // Build response
      const content = result.content.map((c) => {
        if (c.type === "text") {
          return { type: "text" as const, text: c.text };
        }
        if (c.type === "image") {
          return { type: "image" as const, data: c.data, mimeType: c.mimeType };
        }
        return { type: "text" as const, text: JSON.stringify(c) };
      });
      
      let responseContent = content.length > 0 ? content : [{ type: "text" as const, text: "(empty result)" }];

      if (editNoop && !result.isError) {
        responseContent = [
          { type: "text" as const, text: "⚠ No changes applied (no-op edit)" },
          ...responseContent,
        ];
      }

      return {
        content: responseContent,
        details: {
          mode: "call",
          tool: tool.name,
          args: params.args,
          warning: guardResult.warning,
          editNoop,
          raw: params.raw,
        },
        isError: result.isError,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      
      // Include schema in error for self-correction
      let errorText = `Failed to call ${tool.name}: ${message}`;
      if (tool.inputSchema) {
        errorText += `\n\nExpected parameters:\n${formatSchema(tool.inputSchema)}`;
      }
      
      return {
        content: [{ type: "text" as const, text: errorText }],
        details: { mode: "call", error: "call_failed", tool: tool.name, message },
        isError: true,
      };
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Initialization
// ─────────────────────────────────────────────────────────────────────────────

async function promptForWindowSelection(
  ctx: ExtensionContext,
  candidates: RpWindow[]
): Promise<RpWindow | null> {
  if (!ctx.hasUI || candidates.length === 0) {
    return null;
  }

  return await ctx.ui.custom<RpWindow | null>(
    (tui, theme, _kb, done) => {
      let selectedIndex = 0;

      return {
        render(width: number) {
          const w = Math.max(40, width);
          const lines: string[] = [];

          const header =
            theme.fg("accent", theme.bold("RepoPrompt")) +
            theme.fg("dim", " — select window to bind");

          lines.push(theme.fg("dim", "┌" + "─".repeat(w - 2) + "┐"));
          const headerPad = Math.max(0, w - 4 - visibleWidth(header));
          lines.push(theme.fg("dim", "│ ") + header + " ".repeat(headerPad) + theme.fg("dim", " │"));
          lines.push(theme.fg("dim", "├" + "─".repeat(w - 2) + "┤"));

          for (let i = 0; i < candidates.length; i++) {
            const win = candidates[i];
            const pointer = i === selectedIndex ? theme.fg("success", "❯ ") : "  ";
            const label = `${win.id}: ${win.workspace || "(unnamed)"}`;
            const row = pointer + label;

            const rowPad = Math.max(0, w - 4 - visibleWidth(row));
            lines.push(theme.fg("dim", "│ ") + row + " ".repeat(rowPad) + theme.fg("dim", " │"));
          }

          lines.push(theme.fg("dim", "├" + "─".repeat(w - 2) + "┤"));

          const footer = theme.fg("dim", "↑↓/jk navigate • Enter select • Esc cancel");
          const footerPad = Math.max(0, w - 4 - visibleWidth(footer));
          lines.push(theme.fg("dim", "│ ") + footer + " ".repeat(footerPad) + theme.fg("dim", " │"));
          lines.push(theme.fg("dim", "└" + "─".repeat(w - 2) + "┘"));

          return lines;
        },
        handleInput(data: string) {
          if (matchesKey(data, "escape") || data === "q" || data === "Q") {
            done(null);
            return;
          }

          if (matchesKey(data, "return") || matchesKey(data, "enter")) {
            done(candidates[selectedIndex] ?? null);
            return;
          }

          if (matchesKey(data, "up") || data === "k") {
            selectedIndex = Math.max(0, selectedIndex - 1);
            tui.requestRender();
            return;
          }

          if (matchesKey(data, "down") || data === "j") {
            selectedIndex = Math.min(candidates.length - 1, selectedIndex + 1);
            tui.requestRender();
            return;
          }

          if (data.length === 1 && data >= "1" && data <= "9") {
            const idx = parseInt(data, 10) - 1;
            if (idx >= 0 && idx < candidates.length) {
              done(candidates[idx]);
            }
          }
        },
        invalidate() {},
      };
    },
    { overlay: true }
  );
}

async function initializeExtension(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: RpConfig
): Promise<void> {
  // Try to restore binding from session
  restoreBinding(ctx, config);
  
  // Get server command
  const server = getServerCommand(config);
  
  // Connect to RepoPrompt
  const client = getRpClient();
  await client.connect(server.command, server.args, config.env);
  
  // Notify connection
  if (ctx.hasUI) {
    ctx.ui.notify(`RepoPrompt: connected (${client.tools.length} tools)`, "info");
  }

  // Validate restored binding (if any) still exists
  const restoredBinding = getBinding();
  if (restoredBinding) {
    try {
      const windows = await fetchWindows();
      if (windows.length > 0) {
        const stillExists = windows.some((w) => w.id === restoredBinding.windowId);
        if (!stillExists) {
          clearBinding();
          if (ctx.hasUI) {
            ctx.ui.notify(
              `RepoPrompt: restored binding to window ${restoredBinding.windowId} no longer exists; staying unbound`,
              "warning"
            );
          }
        }
      }
    } catch {
      // Non-fatal; if window listing fails we keep the restored binding
    }
  }
  
  // Auto-detect and bind if enabled
  if (config.autoBindOnStart && !getBinding()) {
    try {
      const { binding, windows, ambiguity } = await autoDetectAndBind(pi, config);
      
      if (binding && ctx.hasUI) {
        ctx.ui.notify(
          `RepoPrompt: auto-bound to window ${binding.windowId} (${binding.workspace ?? "unknown"})`,
          "info"
        );
      } else if (ambiguity?.candidates?.length && ctx.hasUI) {
        const selected = await promptForWindowSelection(ctx, ambiguity.candidates);

        if (selected) {
          const chosenBinding = await bindToWindow(pi, selected.id, undefined, config);
          ctx.ui.notify(
            `RepoPrompt: bound to window ${chosenBinding.windowId} (${chosenBinding.workspace ?? "unknown"})`,
            "info"
          );
        } else {
          const candidatesText = ambiguity.candidates
            .map((w) => `${w.id}: ${w.workspace}`)
            .join(", ");

          ctx.ui.notify(
            `RepoPrompt: multiple matching windows for cwd (${candidatesText}). Use /rp bind <id> to choose.`,
            "warning"
          );
        }
      } else if (windows.length > 0 && ctx.hasUI) {
        ctx.ui.notify(
          `RepoPrompt: ${windows.length} window(s) available. Use /rp bind <id> or rp({ windows: true })`,
          "info"
        );
      }
    } catch (err) {
      // Auto-detect failed, not critical
      console.error("RepoPrompt auto-detect failed:", err);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema Formatting
// ─────────────────────────────────────────────────────────────────────────────

function formatSchema(schema: unknown, indent = ""): string {
  if (!schema || typeof schema !== "object") {
    return `${indent}(no schema)`;
  }
  
  const s = schema as Record<string, unknown>;
  
  if (s.type === "object" && s.properties && typeof s.properties === "object") {
    const props = s.properties as Record<string, unknown>;
    const required = Array.isArray(s.required) ? (s.required as string[]) : [];
    
    if (Object.keys(props).length === 0) {
      return `${indent}(no parameters)`;
    }
    
    const lines: string[] = [];
    for (const [name, propSchema] of Object.entries(props)) {
      const isRequired = required.includes(name);
      lines.push(formatProperty(name, propSchema, isRequired, indent));
    }
    return lines.join("\n");
  }
  
  if (s.type) {
    return `${indent}(${s.type})`;
  }
  
  return `${indent}(complex schema)`;
}

function formatProperty(name: string, schema: unknown, required: boolean, indent: string): string {
  if (!schema || typeof schema !== "object") {
    return `${indent}${name}${required ? " *" : ""}`;
  }
  
  const s = schema as Record<string, unknown>;
  const parts: string[] = [];
  
  let typeStr = "";
  if (s.type) {
    typeStr = Array.isArray(s.type) ? s.type.join(" | ") : String(s.type);
  } else if (s.enum) {
    typeStr = "enum";
  }
  
  if (Array.isArray(s.enum)) {
    const enumVals = s.enum.map((v) => JSON.stringify(v)).join(", ");
    typeStr = `enum: ${enumVals}`;
  }
  
  parts.push(`${indent}${name}`);
  if (typeStr) parts.push(`(${typeStr})`);
  if (required) parts.push("*required*");
  
  if (s.description && typeof s.description === "string") {
    parts.push(`- ${s.description}`);
  }
  
  return parts.join(" ");
}

function formatSchemaCompact(schema: unknown): string {
  if (!schema || typeof schema !== "object") {
    return "(no schema)";
  }
  
  const s = schema as Record<string, unknown>;
  
  if (s.type === "object" && s.properties && typeof s.properties === "object") {
    const props = Object.keys(s.properties as object);
    const required = Array.isArray(s.required) ? (s.required as string[]) : [];
    
    return props
      .map((p) => (required.includes(p) ? `${p}*` : p))
      .join(", ");
  }
  
  return "(complex)";
}
