import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
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
                textParts.push(`[thinking]\n${t.trim()}`);
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

const OUTPUT_DIR = path.join(os.homedir(), ".pi", "agent", "pi-sessions-extracted");

export default function (pi: ExtensionAPI) {
  pi.registerCommand("md", {
    description: "Export current session to markdown. Use '/md thinking' to include thinking blocks.",
    handler: async (args, ctx) => {
      const sessionFile = ctx.sessionManager.getSessionFile();

      if (!sessionFile) {
        ctx.ui.notify("No session file (ephemeral session)", "error");
        return;
      }

      const includeThinking = args.toLowerCase().trim().startsWith("t");

      try {
        const outputFile = await processSession(sessionFile, OUTPUT_DIR, includeThinking);
        if (outputFile) {
          const suffix = includeThinking ? " (with thinking)" : "";
          ctx.ui.notify(`Processed${suffix}: ${outputFile}`, "success");
        } else {
          ctx.ui.notify("No meaningful conversation found in session", "error");
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Export failed: ${errMsg}`, "error");
      }
    },
  });
}
