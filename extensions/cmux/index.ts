/**
 * cmux — Push pi agent state into the cmux sidebar.
 *
 * Hooks into pi lifecycle events and fires cmux CLI commands to update
 * sidebar status keys, progress, and notifications. Fire-and-forget —
 * errors are silently ignored so cmux issues never affect pi.
 *
 * No-op when CMUX_SOCKET_PATH is not set (i.e. not running inside cmux).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const CMUX_SOCKET = process.env.CMUX_SOCKET_PATH;
// Track the workspace that spawned this Pi process; `cmux current-workspace`
// follows the focused workspace and can point at a different one.
const CMUX_WORKSPACE_ID = process.env.CMUX_WORKSPACE_ID;

// Colors
const GREEN = "#22C55E";
const AMBER = "#F59E0B";
const PURPLE = "#8B5CF6";
const BLUE = "#3B82F6";
const GRAY = "#6B7280";

// Status keys we own — cleared on shutdown
const STATUS_KEYS = [
  "pi_state",
  "pi_model",
  "pi_thinking",
  "pi_tokens",
  "pi_cost",
  "pi_tool",
];

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatCost(n: number): string {
  return `$${n.toFixed(2)}`;
}

function shortModel(id: string): string {
  // Strip common prefixes: "claude-" etc., keep it readable
  return id
    .replace(/^claude-/, "")
    .replace(/-\d{8}$/, "");
}

function countMatches(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

export default function (pi: ExtensionAPI) {
  if (!CMUX_SOCKET) return;

  let sessionCost = 0;
  let hasUI = false;

  // Fire-and-forget cmux CLI call
  function run(...args: string[]) {
    if (!hasUI) return;
    pi.exec("cmux", args, { timeout: 2000 }).catch(() => {});
  }

  function setStatus(key: string, value: string, icon: string, color: string) {
    run("set-status", key, value, "--icon", icon, "--color", color);
  }

  function clearStatus(key: string) {
    run("clear-status", key);
  }

  async function syncWorkspaceName() {
    if (!hasUI || !CMUX_WORKSPACE_ID) return;

    const sessionName = pi.getSessionName()?.trim();
    if (!sessionName) return;

    const treeResult = await pi.exec(
      "cmux",
      ["tree", "--workspace", CMUX_WORKSPACE_ID],
      { timeout: 2000 }
    ).catch(() => undefined);
    const tree = treeResult?.stdout;
    if (!tree || treeResult?.code !== 0) return;

    const paneCount = countMatches(tree, /\bpane pane:/g);
    const surfaceCount = countMatches(tree, /\bsurface surface:/g);
    if (paneCount !== 1 || surfaceCount !== 1) return;

    const workspaceMatch = tree.match(/workspace\s+workspace:\S+\s+"([^"]*)"/);
    const currentTitle = workspaceMatch?.[1]?.trim();
    if (currentTitle === sessionName) return;

    await pi.exec(
      "cmux",
      ["rename-workspace", "--workspace", CMUX_WORKSPACE_ID, sessionName],
      { timeout: 2000 }
    ).catch(() => {});
  }

  // --- Session lifecycle ---

  pi.on("session_start", async (_event, ctx) => {
    hasUI = ctx.hasUI;
    if (!hasUI) return;

    await syncWorkspaceName();

    // Reconstruct session cost from existing entries
    sessionCost = 0;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (
        entry.type === "message" &&
        entry.message.role === "assistant" &&
        (entry.message as any).usage?.cost?.total
      ) {
        sessionCost += (entry.message as any).usage.cost.total;
      }
    }

    // Set initial sidebar state
    setStatus("pi_state", "Idle", "checkmark.circle", GREEN);

    if (ctx.model?.id) {
      setStatus("pi_model", shortModel(ctx.model.id), "brain", PURPLE);
    }

    const thinking = pi.getThinkingLevel();
    if (thinking && thinking !== "off") {
      setStatus("pi_thinking", thinking, "sparkles", AMBER);
    }

    if (sessionCost > 0) {
      setStatus("pi_cost", formatCost(sessionCost), "dollarsign.circle", GREEN);
    }

    const usage = ctx.getContextUsage();
    if (usage && usage.tokens != null && usage.tokens > 0) {
      setStatus("pi_tokens", formatTokens(usage.tokens), "number", BLUE);
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    for (const key of STATUS_KEYS) {
      clearStatus(key);
    }
  });

  // --- Agent working state ---

  pi.on("agent_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    setStatus("pi_state", "Working", "arrow.circlepath", AMBER);
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    setStatus("pi_state", "Idle", "checkmark.circle", GREEN);
    clearStatus("pi_tool");
    await syncWorkspaceName();

    // Update final token count
    const usage = ctx.getContextUsage();
    if (usage && usage.tokens != null && usage.tokens > 0) {
      setStatus("pi_tokens", formatTokens(usage.tokens), "number", BLUE);
    }

    // Update cost
    if (sessionCost > 0) {
      setStatus("pi_cost", formatCost(sessionCost), "dollarsign.circle", GREEN);
    }

    // Notify user that agent needs attention — use empty body so it
    // triggers the blue ring and tab highlight without leaving persistent
    // text in the sidebar.
    run("notify", "--title", "Needs attention");
  });

  // --- Turn tracking (tokens + cost) ---

  pi.on("turn_end", async (event, ctx) => {
    if (!ctx.hasUI) return;

    // Accumulate cost from the assistant message
    const msg = event.message;
    if (msg?.role === "assistant" && (msg as any).usage?.cost?.total) {
      sessionCost += (msg as any).usage.cost.total;
      setStatus("pi_cost", formatCost(sessionCost), "dollarsign.circle", GREEN);
    }

    // Update token count
    const usage = ctx.getContextUsage();
    if (usage && usage.tokens != null && usage.tokens > 0) {
      setStatus("pi_tokens", formatTokens(usage.tokens), "number", BLUE);
    }
  });

  // --- Model / thinking changes ---

  pi.on("model_select", async (event, ctx) => {
    if (!ctx.hasUI) return;
    setStatus("pi_model", shortModel(event.model.id), "brain", PURPLE);
    const thinking = pi.getThinkingLevel();
    setStatus(
      "pi_thinking",
      thinking === "off" ? "off" : thinking,
      "sparkles",
      thinking === "off" ? GRAY : AMBER
    );
  });

  // --- Tool execution tracking ---

  pi.on("tool_execution_start", async (event, ctx) => {
    if (!ctx.hasUI) return;
    setStatus("pi_tool", event.toolName, "wrench", GRAY);
  });

  pi.on("tool_execution_end", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    clearStatus("pi_tool");
  });
}