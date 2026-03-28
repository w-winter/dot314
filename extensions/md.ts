import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";

/**
 * Processes Pi agent JSONL session logs into readable text format
 * Output directory: ~/.pi/agent/pi-sessions-extracted/
 */

interface SessionMeta {
  sessionId: string;
  startedAt: Date | null;
  cwd: string;
}

interface ToolCallInfo {
  name: string;
  cmd: string;
  include: boolean;
}

interface ToolFilter {
  mode: "all" | "includeOnly";
  includeNames: Set<string>;
  excludeNames: Set<string>;
}

interface ExportOptions {
  includeThinking: boolean;
  toolFilter: ToolFilter | null;
}

interface ConversationState {
  meta: SessionMeta;
  conversation: string[];
  pendingToolCalls: Map<string, ToolCallInfo>;
}

/**
 * Extract text from various content formats (string, array of content blocks)
 */
function extractTextFromContent(content: unknown): string {
  if (content === null || content === undefined) {
    return "";
  }
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (typeof item !== "object" || item === null) {
        continue;
      }
      const itemObj = item as Record<string, unknown>;
      if (itemObj.type !== "text") {
        continue;
      }
      const text = itemObj.text;
      if (typeof text === "string" && text.trim()) {
        parts.push(text.trim());
      }
    }
    return parts.join("\n").trim();
  }
  return "";
}

/**
 * Parse ISO-ish timestamp string to Date
 */
function parseIsoTimestamp(ts: unknown): Date | null {
  if (!ts || typeof ts !== "string") {
    return null;
  }
  try {
    let normalized = ts;
    if (ts.endsWith("Z")) {
      normalized = ts.slice(0, -1) + "+00:00";
    }
    const date = new Date(normalized);
    return isNaN(date.getTime()) ? null : date;
  } catch {
    return null;
  }
}

/**
 * Create a filesystem-safe slug from a string
 */
function slug(s: string): string {
  const out: string[] = [];
  let prevUnderscore = false;
  for (const ch of s) {
    const isAlphaNum = /[a-zA-Z0-9]/.test(ch);
    const isAllowed = isAlphaNum || ch === "-" || ch === "_";
    if (isAllowed) {
      out.push(ch);
      prevUnderscore = false;
    } else if (!prevUnderscore) {
      out.push("_");
      prevUnderscore = true;
    }
  }
  const result = out.join("").replace(/^_+|_+$/g, "");
  return result || "unknown";
}

/**
 * Iterate through JSONL file line by line, yielding parsed objects
 */
async function* iterJsonl(
  filePath: string
): AsyncGenerator<Record<string, unknown>> {
  const fileStream = fs.createReadStream(filePath, { encoding: "utf-8" });
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const obj = JSON.parse(trimmed);
      if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
        yield obj as Record<string, unknown>;
      }
    } catch {
      // Skip malformed JSON lines
      continue;
    }
  }
}

function normalizeToolName(name: string): string {
  return name.trim().toLowerCase();
}

function createConversationState(): ConversationState {
  return {
    meta: {
      sessionId: "",
      startedAt: null,
      cwd: "",
    },
    conversation: [],
    pendingToolCalls: new Map(),
  };
}

function formatThinkingBlock(thinking: string): string {
  return `[thinking]\n${thinking.trim()}\n[/thinking]`;
}

function extractToolCommand(args: unknown): string {
  if (typeof args === "object" && args !== null && !Array.isArray(args)) {
    const argsObj = args as Record<string, unknown>;
    const cmdVal = argsObj.command || argsObj.cmd;
    if (typeof cmdVal === "string") {
      return cmdVal;
    }
    try {
      return JSON.stringify(args, Object.keys(args).sort());
    } catch {
      return String(args);
    }
  }
  return String(args);
}

function shouldIncludeTool(toolName: string, toolFilter: ToolFilter | null): boolean {
  if (!toolFilter) {
    return false;
  }

  const normalized = normalizeToolName(toolName);
  if (toolFilter.excludeNames.has(normalized)) {
    return false;
  }
  if (toolFilter.mode === "includeOnly") {
    return toolFilter.includeNames.has(normalized);
  }
  return true;
}

function applyMessageRecord(
  rec: Record<string, unknown>,
  state: ConversationState,
  options: ExportOptions
): void {
  const rtype = rec.type;

  if (rtype === "session" && !state.meta.sessionId) {
    state.meta.sessionId = String(rec.id || "");
    state.meta.startedAt = parseIsoTimestamp(rec.timestamp);
    state.meta.cwd = String(rec.cwd || "");
    return;
  }

  if (rtype !== "message") {
    return;
  }

  const msg = rec.message;
  if (typeof msg !== "object" || msg === null || Array.isArray(msg)) {
    return;
  }

  const msgObj = msg as Record<string, unknown>;
  const role = msgObj.role;

  if (role === "user") {
    const text = extractTextFromContent(msgObj.content);
    if (text) {
      state.conversation.push(`USER: ${text}`);
    }
    return;
  }

  if (role === "assistant") {
    appendAssistantMessage(msgObj, state, options);
    return;
  }

  if (role === "toolResult") {
    appendToolResultMessage(msgObj, state, options.toolFilter);
  }
}

function appendAssistantMessage(
  msgObj: Record<string, unknown>,
  state: ConversationState,
  options: ExportOptions
): void {
  const content = msgObj.content;
  const textParts: string[] = [];
  const toolParts: string[] = [];

  if (typeof content === "string") {
    if (content.trim()) {
      textParts.push(content.trim());
    }
  } else if (Array.isArray(content)) {
    for (const item of content) {
      if (typeof item !== "object" || item === null) {
        continue;
      }
      const itemObj = item as Record<string, unknown>;
      const itemType = itemObj.type;

      if (itemType === "text") {
        const text = itemObj.text;
        if (typeof text === "string" && text.trim()) {
          textParts.push(text.trim());
        }
        continue;
      }

      if (itemType === "thinking") {
        const thinking = itemObj.thinking;
        if (
          options.includeThinking &&
          typeof thinking === "string" &&
          thinking.trim()
        ) {
          textParts.push(formatThinkingBlock(thinking));
        }
        continue;
      }

      if (itemType !== "toolCall") {
        continue;
      }

      const toolName = String(itemObj.name || "tool");
      const toolId = String(itemObj.id || "");
      const cmd = extractToolCommand(itemObj.arguments);
      const include = shouldIncludeTool(toolName, options.toolFilter);

      if (toolId) {
        state.pendingToolCalls.set(toolId, { name: toolName, cmd, include });
      }
      if (include) {
        toolParts.push(`[tool:${toolName}] ${cmd}`.trim());
      }
    }
  }

  let fullText = textParts.filter(Boolean).join("\n").trim();
  if (toolParts.length > 0) {
    fullText = (fullText ? `${fullText}\n` : "") + toolParts.join("\n");
  }

  if (fullText) {
    state.conversation.push(`ASSISTANT: ${fullText}`);
  }
}

function appendToolResultMessage(
  msgObj: Record<string, unknown>,
  state: ConversationState,
  toolFilter: ToolFilter | null
): void {
  const toolName = String(msgObj.toolName || msgObj.tool_name || "tool");
  const toolCallId = String(msgObj.toolCallId || msgObj.tool_call_id || "");

  let label = toolName;
  let include = shouldIncludeTool(toolName, toolFilter);

  if (toolCallId && state.pendingToolCalls.has(toolCallId)) {
    const pending = state.pendingToolCalls.get(toolCallId)!;
    state.pendingToolCalls.delete(toolCallId);
    label = pending.name || toolName;
    include = pending.include;
    if (pending.cmd) {
      label = `${label}: ${pending.cmd}`;
    }
  }

  if (!include) {
    return;
  }

  const isError = Boolean(msgObj.isError || msgObj.is_error);
  const out = extractTextFromContent(msgObj.content);
  if (out && out !== "(no content)") {
    state.conversation.push(
      `SYSTEM [${label} output${isError ? " ERROR" : ""}]:\n${out}`
    );
  }
}

/**
 * Extract conversation messages from a Pi session JSONL file
 */
async function extractConversation(
  jsonlFile: string,
  options: ExportOptions
): Promise<{ meta: SessionMeta; conversation: string[] }> {
  const state = createConversationState();

  for await (const rec of iterJsonl(jsonlFile)) {
    applyMessageRecord(rec, state, options);
  }

  return { meta: state.meta, conversation: state.conversation };
}

/**
 * Extract conversation messages from the *currently selected branch* (root → current leaf)
 * using the in-memory SessionManager tree state.
 *
 * This intentionally includes *all* turns on the branch, including turns that may no longer
 * be shown in the TUI after compaction.
 */
function extractConversationFromBranch(
  sessionManager: any,
  options: ExportOptions
): { meta: SessionMeta; conversation: string[]; leafId: string | null } {
  const state = createConversationState();
  const header =
    typeof sessionManager.getHeader === "function"
      ? sessionManager.getHeader()
      : null;

  if (header && typeof header === "object") {
    const headerObj = header as Record<string, unknown>;
    state.meta.sessionId = typeof headerObj.id === "string" ? headerObj.id : "";
    state.meta.startedAt = parseIsoTimestamp(headerObj.timestamp);
    if (typeof headerObj.cwd === "string") {
      state.meta.cwd = headerObj.cwd;
    }
  }

  if (!state.meta.cwd && typeof sessionManager.getCwd === "function") {
    state.meta.cwd = String(sessionManager.getCwd() || "");
  }

  const leafId =
    typeof sessionManager.getLeafId === "function"
      ? (sessionManager.getLeafId() as string | null)
      : null;

  const branchEntries: unknown[] =
    leafId && typeof sessionManager.getBranch === "function"
      ? (sessionManager.getBranch(leafId) as unknown[])
      : [];

  for (const entry of branchEntries) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    applyMessageRecord(entry as Record<string, unknown>, state, options);
  }

  return { meta: state.meta, conversation: state.conversation, leafId };
}

function buildMarkdownContent(
  meta: SessionMeta,
  sessionFile: string,
  conversation: string[],
  lastTurns: number | null,
  branchInfo?: { leafId: string | null }
): { content: string; filename: string } | null {
  const finalConversation =
    lastTurns && lastTurns > 0 ? sliceLastNTurns(conversation, lastTurns) : conversation;

  if (finalConversation.length === 0) {
    return null;
  }

  const project = meta.cwd ? path.basename(meta.cwd) : "unknown";
  const projectSlug = slug(project);

  const started = meta.startedAt || new Date();
  const stamp = formatTimestamp(started);
  const sid = (meta.sessionId || "unknown").slice(0, 8);
  const filename = `${projectSlug}_pi_${stamp}_${sid}.md`;

  const lines: string[] = [];
  lines.push("PI SESSION (processed)");
  if (branchInfo) {
    lines.push("mode: branch");
    lines.push(`leaf: ${branchInfo.leafId === null ? "null" : branchInfo.leafId}`);
  }
  if (meta.sessionId) {
    lines.push(`id: ${meta.sessionId}`);
  }
  if (meta.startedAt) {
    lines.push(`started: ${meta.startedAt.toISOString()}`);
  }
  if (meta.cwd) {
    lines.push(`cwd: ${meta.cwd}`);
  }
  lines.push(`source: ${sessionFile}`);
  if (lastTurns && lastTurns > 0) {
    lines.push(`turns: last ${lastTurns}`);
  }
  lines.push("");

  for (const msg of finalConversation) {
    lines.push(msg.trimEnd());
    lines.push("");
  }

  return { content: lines.join("\n"), filename };
}

/**
 * Generate markdown content from the current branch without writing to file
 */
function generateMarkdownFromBranch(
  sessionManager: any,
  sessionFile: string,
  options: ExportOptions,
  lastTurns: number | null = null
): { content: string; filename: string } | null {
  const { meta, conversation, leafId } = extractConversationFromBranch(
    sessionManager,
    options
  );
  return buildMarkdownContent(meta, sessionFile, conversation, lastTurns, {
    leafId,
  });
}

/**
 * Generate markdown content from full session file without writing to file
 */
async function generateMarkdownFromSession(
  jsonlFile: string,
  options: ExportOptions,
  lastTurns: number | null = null
): Promise<{ content: string; filename: string } | null> {
  const { meta, conversation } = await extractConversation(jsonlFile, options);
  return buildMarkdownContent(meta, jsonlFile, conversation, lastTurns);
}

/**
 * Copy text to clipboard (macOS)
 */
function copyToClipboard(text: string): void {
  execSync("pbcopy", { input: text });
}

/**
 * Format date as YYYYMMDD_HHMMSS
 */
function formatTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/**
 * Slice a flattened conversation array to the last N turns
 *
 * A turn is defined as a unit of [USER message -> ASSISTANT message], including any
 * SYSTEM tool outputs that occur in between, until the next USER message begins.
 */
function sliceLastNTurns(conversation: string[], turns: number): string[] {
  if (!Number.isFinite(turns) || turns <= 0) {
    return conversation;
  }

  const userMessageIndices: number[] = [];
  for (let i = 0; i < conversation.length; i++) {
    if (conversation[i].startsWith("USER:")) {
      userMessageIndices.push(i);
    }
  }

  if (userMessageIndices.length === 0) {
    return conversation;
  }

  const startIndex =
    userMessageIndices.length <= turns
      ? 0
      : userMessageIndices[userMessageIndices.length - turns];

  return conversation.slice(startIndex);
}

function parseToolFilter(tokensLower: string[]): ToolFilter {
  const includeNames = new Set<string>();
  const excludeNames = new Set<string>();

  for (const token of tokensLower) {
    if (!["+", "-"].includes(token[0]) || token.length < 2) {
      continue;
    }

    const name = normalizeToolName(token.slice(1));
    if (!name) {
      continue;
    }

    if (token.startsWith("+")) {
      includeNames.add(name);
    } else {
      excludeNames.add(name);
    }
  }

  return {
    mode: includeNames.size > 0 ? "includeOnly" : "all",
    includeNames,
    excludeNames,
  };
}

function hasToolFilterTokens(tokensLower: string[]): boolean {
  return tokensLower.some((token) => /^[+-].+/.test(token));
}

function describeToolFilter(toolFilter: ToolFilter | null): string | null {
  if (!toolFilter) {
    return null;
  }

  const includes = [...toolFilter.includeNames].sort().map((name) => `+${name}`);
  const excludes = [...toolFilter.excludeNames].sort().map((name) => `-${name}`);

  if (toolFilter.mode === "includeOnly") {
    return ["tool calls", ...includes, ...excludes].join(" ");
  }
  if (excludes.length > 0) {
    return ["tool calls", ...excludes].join(" ");
  }
  return "tool calls";
}

const OUTPUT_DIR = path.join(os.homedir(), ".pi", "agent", "pi-sessions-extracted");

export default function (pi: ExtensionAPI) {
  pi.registerCommand("md", {
    description:
      "Export current session as markdown (current /tree branch) on clipboard or to file. Tool calls and thinking blocks are excluded by default. Use '/md tc' to include tool calls, optionally filtered with exact tool names like '/md tc -bash -read' or '/md tc +ask'. Use '/md t' to include thinking blocks. Use '/md all' for full file. Pass a number (e.g. '/md 2' or '/md tc t 2') to export only the last N turns.",
    handler: async (args, ctx) => {
      const sessionFile = ctx.sessionManager.getSessionFile();

      if (!sessionFile) {
        ctx.ui.notify("No session file (ephemeral session)", "error");
        return;
      }

      const argsTrimmed = args.trim();
      const tokens = argsTrimmed ? argsTrimmed.split(/\s+/).filter(Boolean) : [];
      const tokensLower = tokens.map((t) => t.toLowerCase());

      const includeThinking =
        tokensLower.includes("t") ||
        tokensLower.includes("think") ||
        tokensLower.includes("thinking");

      const includeToolCalls = tokensLower.includes("tc");
      const exportAll = tokensLower.includes("all") || tokensLower.includes("file");
      const toolFilterTokensPresent = hasToolFilterTokens(tokensLower);

      if (toolFilterTokensPresent && !includeToolCalls) {
        ctx.ui.notify("Tool filters require 'tc' (e.g. /md tc -bash or /md tc +ask)", "error");
        return;
      }

      if (tokensLower.includes("+all") || tokensLower.includes("-all")) {
        ctx.ui.notify("'+all' and '-all' are not supported; use '/md tc' or '/md tc +tool'", "error");
        return;
      }

      const toolFilter = includeToolCalls ? parseToolFilter(tokensLower) : null;
      const options: ExportOptions = {
        includeThinking,
        toolFilter,
      };

      const turnsToken = tokens.find((t) => /^\d+$/.test(t)) || null;
      const lastTurns = turnsToken ? parseInt(turnsToken, 10) : null;
      if (turnsToken && (!Number.isFinite(lastTurns) || lastTurns < 1)) {
        ctx.ui.notify("Turn limit must be >= 1 (e.g. /md 2)", "error");
        return;
      }

      const turnSuffix = lastTurns ? ` (last ${lastTurns} turns)` : "";
      const extras: string[] = [];
      if (includeThinking) {
        extras.push("thinking");
      }
      const toolFilterDescription = describeToolFilter(toolFilter);
      if (toolFilterDescription) {
        extras.push(toolFilterDescription);
      }
      const extrasSuffix = extras.length > 0 ? ` (with ${extras.join(" + ")})` : "";
      const title = `Export session${turnSuffix}${extrasSuffix} as Markdown`;
      const choice = await ctx.ui.select(`${title}\n\nSelect export method:`, [
        "Copy to clipboard",
        `Save to .md file in ${OUTPUT_DIR}/`,
      ]);

      if (!choice) {
        return;
      }

      try {
        const result = exportAll
          ? await generateMarkdownFromSession(sessionFile, options, lastTurns)
          : generateMarkdownFromBranch(ctx.sessionManager, sessionFile, options, lastTurns);

        if (!result) {
          const mode = exportAll ? "session file" : "current branch";
          ctx.ui.notify(`No meaningful conversation found in ${mode}`, "error");
          return;
        }

        const suffix = extrasSuffix;
        const mode = exportAll ? " (full file)" : " (branch)";

        if (choice === "Copy to clipboard") {
          copyToClipboard(result.content);
          ctx.ui.notify(`Copied to clipboard${suffix}${mode}`, "success");
          return;
        }

        const outputFile = path.join(OUTPUT_DIR, result.filename);
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
        fs.writeFileSync(outputFile, result.content, "utf-8");
        ctx.ui.notify(`Saved${suffix}${mode}: ${outputFile}`, "success");
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Export failed: ${errMsg}`, "error");
      }
    },
  });
}
