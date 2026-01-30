import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as readline from "readline";
import { execSync } from "child_process";

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
      const itemType = itemObj.type;
      if (itemType === "text") {
        const text = itemObj.text;
        if (typeof text === "string" && text.trim()) {
          parts.push(text.trim());
        }
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
    } else {
      if (!prevUnderscore) {
        out.push("_");
        prevUnderscore = true;
      }
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

/**
 * Extract conversation messages from a Pi session JSONL file
 */
async function extractConversation(
  jsonlFile: string,
  includeThinking: boolean = false
): Promise<{ meta: SessionMeta; conversation: string[] }> {
  const conversation: string[] = [];
  const meta: SessionMeta = {
    sessionId: "",
    startedAt: null,
    cwd: "",
  };

  const pendingToolCalls: Map<string, ToolCallInfo> = new Map();

  for await (const rec of iterJsonl(jsonlFile)) {
    const rtype = rec.type;

    // Handle session metadata
    if (rtype === "session" && !meta.sessionId) {
      meta.sessionId = String(rec.id || "");
      meta.startedAt = parseIsoTimestamp(rec.timestamp);
      meta.cwd = String(rec.cwd || "");
      continue;
    }

    if (rtype !== "message") {
      continue;
    }

    const msg = rec.message;
    if (typeof msg !== "object" || msg === null || Array.isArray(msg)) {
      continue;
    }
    const msgObj = msg as Record<string, unknown>;
    const role = msgObj.role;

    // Handle user messages
    if (role === "user") {
      const text = extractTextFromContent(msgObj.content);
      if (text) {
        conversation.push(`USER: ${text}`);
      }
      continue;
    }

    // Handle assistant messages
    if (role === "assistant") {
      const content = msgObj.content;
      const textParts: string[] = [];
      const toolParts: string[] = [];

      if (Array.isArray(content)) {
        for (const item of content) {
          if (typeof item !== "object" || item === null) {
            continue;
          }
          const itemObj = item as Record<string, unknown>;
          const itype = itemObj.type;

          if (itype === "text") {
            const t = itemObj.text;
            if (typeof t === "string" && t.trim()) {
              textParts.push(t.trim());
            }
          } else if (itype === "thinking") {
            if (includeThinking) {
              const t = itemObj.thinking;
              if (typeof t === "string" && t.trim()) {
                textParts.push(`[thinking]\n${t.trim()}\n[/thinking]`);
              }
            }
          } else if (itype === "toolCall") {
            const toolName = String(itemObj.name || "tool");
            const toolId = String(itemObj.id || "");
            const args = itemObj.arguments;
            let cmd = "";

            if (typeof args === "object" && args !== null && !Array.isArray(args)) {
              const argsObj = args as Record<string, unknown>;
              const cmdVal = argsObj.command || argsObj.cmd;
              if (typeof cmdVal === "string") {
                cmd = cmdVal;
              }
              if (!cmd) {
                // Fall back to JSON for unknown tool argument shapes
                try {
                  cmd = JSON.stringify(args, Object.keys(args).sort());
                } catch {
                  cmd = String(args);
                }
              }
            } else {
              cmd = String(args);
            }

            if (toolId) {
              pendingToolCalls.set(toolId, { name: toolName, cmd });
            }
            toolParts.push(`[tool:${toolName}] ${cmd}`.trim());
          }
        }
      }

      let fullText = textParts.filter((p) => p).join("\n").trim();
      if (toolParts.length > 0) {
        fullText = (fullText ? fullText + "\n" : "") + toolParts.join("\n");
      }

      if (fullText) {
        conversation.push(`ASSISTANT: ${fullText}`);
      }
      continue;
    }

    // Handle tool results
    if (role === "toolResult") {
      const toolName = String(
        msgObj.toolName || msgObj.tool_name || "tool"
      );
      const toolCallId = String(
        msgObj.toolCallId || msgObj.tool_call_id || ""
      );
      const isError = Boolean(msgObj.isError || msgObj.is_error);
      const out = extractTextFromContent(msgObj.content);

      let label = toolName;
      if (toolCallId && pendingToolCalls.has(toolCallId)) {
        const pending = pendingToolCalls.get(toolCallId)!;
        pendingToolCalls.delete(toolCallId);
        label = pending.name || toolName;
        if (pending.cmd) {
          label = `${label}: ${pending.cmd}`;
        }
      }

      if (out && out !== "(no content)") {
        conversation.push(
          `SYSTEM [${label} output${isError ? " ERROR" : ""}]:\n${out}`
        );
      }
      continue;
    }
    // Ignore any other message roles
  }

  return { meta, conversation };
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
  includeThinking: boolean = false
): { meta: SessionMeta; conversation: string[]; leafId: string | null } {
  const conversation: string[] = [];
  const meta: SessionMeta = {
    sessionId: "",
    startedAt: null,
    cwd: "",
  };

  const header = typeof sessionManager.getHeader === "function" ? sessionManager.getHeader() : null;
  if (header && typeof header === "object") {
    const headerObj = header as Record<string, unknown>;
    meta.sessionId = typeof headerObj.id === "string" ? headerObj.id : "";
    meta.startedAt = parseIsoTimestamp(headerObj.timestamp);
    if (typeof headerObj.cwd === "string") {
      meta.cwd = headerObj.cwd;
    }
  }

  if (!meta.cwd && typeof sessionManager.getCwd === "function") {
    meta.cwd = String(sessionManager.getCwd() || "");
  }

  const leafId = typeof sessionManager.getLeafId === "function" ? (sessionManager.getLeafId() as string | null) : null;

  const branchEntries: unknown[] =
    leafId && typeof sessionManager.getBranch === "function" ? (sessionManager.getBranch(leafId) as unknown[]) : [];

  const pendingToolCalls: Map<string, ToolCallInfo> = new Map();

  for (const entry of branchEntries) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }

    const entryObj = entry as Record<string, unknown>;
    if (entryObj.type !== "message") {
      continue;
    }

    const msg = entryObj.message;
    if (typeof msg !== "object" || msg === null || Array.isArray(msg)) {
      continue;
    }

    const msgObj = msg as Record<string, unknown>;
    const role = msgObj.role;

    // Handle user messages
    if (role === "user") {
      const text = extractTextFromContent(msgObj.content);
      if (text) {
        conversation.push(`USER: ${text}`);
      }
      continue;
    }

    // Handle assistant messages
    if (role === "assistant") {
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
          const itype = itemObj.type;

          if (itype === "text") {
            const t = itemObj.text;
            if (typeof t === "string" && t.trim()) {
              textParts.push(t.trim());
            }
          } else if (itype === "thinking") {
            if (includeThinking) {
              const t = itemObj.thinking;
              if (typeof t === "string" && t.trim()) {
                textParts.push(`\n\n**[thinking]**\n\n${t.trim()}\n\n**[/thinking]**\n\n`);
              }
            }
          } else if (itype === "toolCall") {
            const toolName = String(itemObj.name || "tool");
            const toolId = String(itemObj.id || "");
            const args = itemObj.arguments;
            let cmd = "";

            if (typeof args === "object" && args !== null && !Array.isArray(args)) {
              const argsObj = args as Record<string, unknown>;
              const cmdVal = argsObj.command || argsObj.cmd;
              if (typeof cmdVal === "string") {
                cmd = cmdVal;
              }
              if (!cmd) {
                // Fall back to JSON for unknown tool argument shapes
                try {
                  cmd = JSON.stringify(args, Object.keys(args).sort());
                } catch {
                  cmd = String(args);
                }
              }
            } else {
              cmd = String(args);
            }

            if (toolId) {
              pendingToolCalls.set(toolId, { name: toolName, cmd });
            }
            toolParts.push(`[tool:${toolName}] ${cmd}`.trim());
          }
        }
      }

      let fullText = textParts.filter((p) => p).join("\n").trim();
      if (toolParts.length > 0) {
        fullText = (fullText ? fullText + "\n" : "") + toolParts.join("\n");
      }

      if (fullText) {
        conversation.push(`ASSISTANT: ${fullText}`);
      }
      continue;
    }

    // Handle tool results
    if (role === "toolResult") {
      const toolName = String(msgObj.toolName || msgObj.tool_name || "tool");
      const toolCallId = String(msgObj.toolCallId || msgObj.tool_call_id || "");
      const isError = Boolean(msgObj.isError || msgObj.is_error);
      const out = extractTextFromContent(msgObj.content);

      let label = toolName;
      if (toolCallId && pendingToolCalls.has(toolCallId)) {
        const pending = pendingToolCalls.get(toolCallId)!;
        pendingToolCalls.delete(toolCallId);
        label = pending.name || toolName;
        if (pending.cmd) {
          label = `${label}: ${pending.cmd}`;
        }
      }

      if (out && out !== "(no content)") {
        conversation.push(`SYSTEM [${label} output${isError ? " ERROR" : ""}]:\n${out}`);
      }
      continue;
    }
  }

  return { meta, conversation, leafId };
}

/**
 * Generate markdown content from the current branch without writing to file
 */
function generateMarkdownFromBranch(
  sessionManager: any,
  sessionFile: string,
  includeThinking: boolean = false,
  lastTurns: number | null = null
): { content: string; filename: string } | null {
  const { meta, conversation, leafId } = extractConversationFromBranch(sessionManager, includeThinking);
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

  // Build output content
  const lines: string[] = [];
  lines.push("PI SESSION (processed)");
  lines.push("mode: branch");
  lines.push(`leaf: ${leafId === null ? "null" : leafId}`);
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
 * Generate markdown content from full session file without writing to file
 */
async function generateMarkdownFromSession(
  jsonlFile: string,
  includeThinking: boolean = false,
  lastTurns: number | null = null
): Promise<{ content: string; filename: string } | null> {
  const { meta, conversation } = await extractConversation(jsonlFile, includeThinking);
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

  // Build output content
  const lines: string[] = [];
  lines.push("PI SESSION (processed)");
  if (meta.sessionId) {
    lines.push(`id: ${meta.sessionId}`);
  }
  if (meta.startedAt) {
    lines.push(`started: ${meta.startedAt.toISOString()}`);
  }
  if (meta.cwd) {
    lines.push(`cwd: ${meta.cwd}`);
  }
  lines.push(`source: ${jsonlFile}`);
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
 * Copy text to clipboard (macOS)
 */
function copyToClipboard(text: string): void {
  execSync("pbcopy", { input: text });
}

/**
 * Process the currently selected branch and write readable output
 */
async function processSessionFromBranch(
  sessionManager: any,
  sessionFile: string,
  outputDir: string,
  includeThinking: boolean = false
): Promise<string | null> {
  const { meta, conversation, leafId } = extractConversationFromBranch(sessionManager, includeThinking);

  if (conversation.length === 0) {
    return null;
  }

  const project = meta.cwd ? path.basename(meta.cwd) : "unknown";
  const projectSlug = slug(project);

  const started = meta.startedAt || new Date();
  const stamp = formatTimestamp(started);
  const sid = (meta.sessionId || "unknown").slice(0, 8);
  const outputFile = path.join(outputDir, `${projectSlug}_pi_${stamp}_${sid}.md`);

  // Ensure output directory exists
  fs.mkdirSync(outputDir, { recursive: true });

  // Build output content
  const lines: string[] = [];
  lines.push("PI SESSION (processed)");
  lines.push("mode: branch");
  lines.push(`leaf: ${leafId === null ? "null" : leafId}`);
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
  lines.push("");

  for (const msg of conversation) {
    lines.push(msg.trimEnd());
    lines.push("");
  }

  fs.writeFileSync(outputFile, lines.join("\n"), "utf-8");
  return outputFile;
}

/**
 * Process a session JSONL file and write readable output
 */
async function processSession(
  jsonlFile: string,
  outputDir: string,
  includeThinking: boolean = false
): Promise<string | null> {
  const { meta, conversation } = await extractConversation(
    jsonlFile,
    includeThinking
  );

  if (conversation.length === 0) {
    return null;
  }

  const project = meta.cwd ? path.basename(meta.cwd) : "unknown";
  const projectSlug = slug(project);

  const started = meta.startedAt || new Date();
  const stamp = formatTimestamp(started);
  const sid = (meta.sessionId || "unknown").slice(0, 8);
  const outputFile = path.join(outputDir, `${projectSlug}_pi_${stamp}_${sid}.md`);

  // Ensure output directory exists
  fs.mkdirSync(outputDir, { recursive: true });

  // Build output content
  const lines: string[] = [];
  lines.push("PI SESSION (processed)");
  if (meta.sessionId) {
    lines.push(`id: ${meta.sessionId}`);
  }
  if (meta.startedAt) {
    lines.push(`started: ${meta.startedAt.toISOString()}`);
  }
  if (meta.cwd) {
    lines.push(`cwd: ${meta.cwd}`);
  }
  lines.push(`source: ${jsonlFile}`);
  lines.push("");

  for (const msg of conversation) {
    lines.push(msg.trimEnd());
    lines.push("");
  }

  fs.writeFileSync(outputFile, lines.join("\n"), "utf-8");
  return outputFile;
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

const OUTPUT_DIR = path.join(os.homedir(), ".pi", "agent", "pi-sessions-extracted");

export default function (pi: ExtensionAPI) {
  pi.registerCommand("md", {
    description: "Export current session as markdown (current /tree branch) on clipboard or to file. Use '/md thinking' (or '/md t') to include thinking blocks. Use '/md all' for full file. Pass a number (e.g. '/md 2' or '/md t 2') to export only the last N turns.",
    handler: async (args, ctx) => {
      const sessionFile = ctx.sessionManager.getSessionFile();

      if (!sessionFile) {
        ctx.ui.notify("No session file (ephemeral session)", "error");
        return;
      }

      const argsTrimmed = args.trim();
      const argsLower = argsTrimmed.toLowerCase();
      const tokens = argsTrimmed ? argsTrimmed.split(/\s+/).filter(Boolean) : [];
      const tokensLower = tokens.map((t) => t.toLowerCase());

      const includeThinking =
        argsLower.startsWith("t") ||
        tokensLower.includes("t") ||
        tokensLower.includes("think") ||
        tokensLower.includes("thinking") ||
        /\bthinking\b/.test(argsLower);

      const exportAll =
        tokensLower.includes("all") ||
        tokensLower.includes("file") ||
        /\ball\b/.test(argsLower) ||
        /\bfile\b/.test(argsLower);

      const turnsToken = tokens.find((t) => /^\d+$/.test(t)) || null;
      const lastTurns = turnsToken ? parseInt(turnsToken, 10) : null;
      if (turnsToken && (!Number.isFinite(lastTurns) || lastTurns < 1)) {
        ctx.ui.notify("Turn limit must be >= 1 (e.g. /md 2)", "error");
        return;
      }

      // Show export method selection menu
      const turnSuffix = lastTurns ? ` (last ${lastTurns} turns)` : "";
      const title = includeThinking
        ? `Export session${turnSuffix} (with thinking blocks) as Markdown`
        : `Export session${turnSuffix} as Markdown`;
      const choice = await ctx.ui.select(`${title}\n\nSelect export method:`, [
        "Copy to clipboard",
        `Save to .md file in ${OUTPUT_DIR}/`,
      ]);

      if (!choice) {
        return; // User cancelled
      }

      try {
        const result = exportAll
          ? await generateMarkdownFromSession(sessionFile, includeThinking, lastTurns)
          : generateMarkdownFromBranch(ctx.sessionManager, sessionFile, includeThinking, lastTurns);

        if (!result) {
          const mode = exportAll ? "session file" : "current branch";
          ctx.ui.notify(`No meaningful conversation found in ${mode}`, "error");
          return;
        }

        const suffix = includeThinking ? " (with thinking)" : "";
        const mode = exportAll ? " (full file)" : " (branch)";

        if (choice === "Copy to clipboard") {
          copyToClipboard(result.content);
          ctx.ui.notify(`Copied to clipboard${suffix}${mode}`, "success");
        } else {
          // Save to file
          const outputFile = path.join(OUTPUT_DIR, result.filename);
          fs.mkdirSync(OUTPUT_DIR, { recursive: true });
          fs.writeFileSync(outputFile, result.content, "utf-8");
          ctx.ui.notify(`Saved${suffix}${mode}: ${outputFile}`, "success");
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Export failed: ${errMsg}`, "error");
      }
    },
  });
}
