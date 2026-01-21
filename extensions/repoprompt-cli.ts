import type { ExtensionAPI, ExtensionContext, ToolRenderResultOptions } from "@mariozechner/pi-coding-agent";
import { highlightCode, Theme } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import * as Diff from "diff";

/**
 * RepoPrompt CLI ↔ Pi integration extension
 *
 * Registers two Pi tools:
 * - `rp_bind`: binds a RepoPrompt window + compose tab (routing)
 * - `rp_exec`: runs `rp-cli -e <cmd>` against that binding (quiet defaults, output truncation)
 *
 * Safety goals:
 * - Prevent "unbound" rp_exec calls from operating on an unintended window/workspace
 * - Prevent in-place workspace switches by default (they can clobber selection/prompt/context)
 * - Block delete-like commands unless explicitly allowed
 *
 * UX goals:
 * - Persist binding across session reloads via `pi.appendEntry()` (does not enter LLM context)
 * - Provide actionable error messages when blocked
 * - Syntax-highlight fenced code blocks in output (read, structure, etc.)
 * - Word-level diff highlighting for edit output
 */

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_CHARS = 12000;
const BINDING_CUSTOM_TYPE = "repoprompt-binding";

const BindParams = Type.Object({
  windowId: Type.Number({ description: "RepoPrompt window id (from `rp-cli -e windows`)" }),
  tab: Type.String({ description: "RepoPrompt compose tab name or UUID" }),
});

const ExecParams = Type.Object({
  cmd: Type.String({ description: "rp-cli exec string (e.g. `tree`, `select set src/ && context`)" }),
  rawJson: Type.Optional(Type.Boolean({ description: "Pass --raw-json to rp-cli" })),
  quiet: Type.Optional(Type.Boolean({ description: "Pass -q/--quiet to rp-cli (default: true)" })),
  failFast: Type.Optional(Type.Boolean({ description: "Pass --fail-fast to rp-cli (default: true)" })),
  timeoutMs: Type.Optional(Type.Number({ description: "Timeout in ms (default: 15 minutes)" })),
  maxOutputChars: Type.Optional(Type.Number({ description: "Truncate output to this many chars (default: 12000)" })),
  windowId: Type.Optional(Type.Number({ description: "Override bound window id for this call" })),
  tab: Type.Optional(Type.String({ description: "Override bound tab for this call" })),
  allowDelete: Type.Optional(
    Type.Boolean({ description: "Allow delete commands like `file delete ...` or `workspace delete ...` (default: false)" }),
  ),
  allowWorkspaceSwitchInPlace: Type.Optional(
    Type.Boolean({
      description:
        "Allow in-place workspace changes (e.g. `workspace switch <name>` or `workspace create ... --switch`) without --new-window (default: false). In-place switching can disrupt other sessions",
    }),
  ),
  failOnNoopEdits: Type.Optional(
    Type.Boolean({
      description: "Treat edit commands that apply 0 changes (or produce empty output) as errors (default: true)",
    }),
  ),
});

function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (maxChars <= 0) return { text: "", truncated: text.length > 0 };
  if (text.length <= maxChars) return { text, truncated: false };
  return {
    text: `${text.slice(0, maxChars)}\n… [truncated; redirect output to a file if needed]`,
    truncated: true,
  };
}

function parseCommandChain(cmd: string): { commands: string[]; hasSemicolonOutsideQuotes: boolean } {
  // Lightweight parser to split on `&&` / `;` without breaking quoted JSON or quoted strings
  const commands: string[] = [];
  let current = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;
  let hasSemicolonOutsideQuotes = false;

  const pushCurrent = () => {
    const trimmed = current.trim();
    if (trimmed.length > 0) commands.push(trimmed);
    current = "";
  };

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      current += ch;
      escaped = true;
      continue;
    }

    if (!inDoubleQuote && ch === "'") {
      inSingleQuote = !inSingleQuote;
      current += ch;
      continue;
    }

    if (!inSingleQuote && ch === "\"") {
      inDoubleQuote = !inDoubleQuote;
      current += ch;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote) {
      if (ch === "&" && cmd[i + 1] === "&") {
        pushCurrent();
        i += 1;
        continue;
      }

      if (ch === ";") {
        hasSemicolonOutsideQuotes = true;
        pushCurrent();
        continue;
      }
    }

    current += ch;
  }

  pushCurrent();
  return { commands, hasSemicolonOutsideQuotes };
}

function looksLikeDeleteCommand(cmd: string): boolean {
  // Conservative detection: block obvious deletes and common `call ... {"action":"delete"}` patterns
  for (const command of parseCommandChain(cmd).commands) {
    const normalized = command.trim().toLowerCase();
    if (normalized === "file delete" || normalized.startsWith("file delete ")) return true;
    if (normalized === "workspace delete" || normalized.startsWith("workspace delete ")) return true;

    if (normalized.startsWith("call ")) {
      if (
        /\baction\s*=\s*delete\b/.test(normalized) ||
        /"action"\s*:\s*"delete"/.test(normalized) ||
        /'action'\s*:\s*'delete'/.test(normalized)
      ) {
        return true;
      }
    }
  }

  return false;
}

function looksLikeWorkspaceSwitchInPlace(cmd: string): boolean {
  // Prevent clobbering shared state: require `--new-window` for workspace switching/creation by default
  for (const command of parseCommandChain(cmd).commands) {
    const normalized = command.toLowerCase();

    if (normalized.startsWith("workspace switch ") && !normalized.includes("--new-window")) return true;

    const isCreate = normalized.startsWith("workspace create ");
    const requestsSwitch = /\B--switch\b/.test(normalized);
    if (isCreate && requestsSwitch && !normalized.includes("--new-window")) return true;
  }

  return false;
}

function looksLikeEditCommand(cmd: string): boolean {
  for (const command of parseCommandChain(cmd).commands) {
    const normalized = command.trim().toLowerCase();

    if (normalized === 'edit' || normalized.startsWith('edit ')) return true;

    if (normalized.startsWith('call ') && normalized.includes('apply_edits')) return true;
  }

  return false;
}

function parseLeadingInt(text: string): number | undefined {
  const trimmed = text.trimStart();
  let digits = '';

  for (const ch of trimmed) {
    if (ch >= '0' && ch <= '9') {
      digits += ch;
    } else {
      break;
    }
  }

  return digits.length > 0 ? Number.parseInt(digits, 10) : undefined;
}

function looksLikeNoopEditOutput(output: string): boolean {
  const trimmed = output.trim();
  if (trimmed.length === 0) return true;

  const lower = trimmed.toLowerCase();

  if (lower.includes('search block not found')) return true;

  const appliedIndex = lower.indexOf('applied');
  if (appliedIndex !== -1) {
    const afterLabel = trimmed.slice(appliedIndex + 'applied'.length);
    const colonIndex = afterLabel.indexOf(':');

    if (colonIndex !== -1 && colonIndex < 10) {
      const appliedCount = parseLeadingInt(afterLabel.slice(colonIndex + 1));
      if (appliedCount !== undefined) return appliedCount === 0;
    }
  }

  // Fallback heuristics when the output format doesn't include an explicit applied count
  if (lower.includes('lines changed: 0')) return true;
  if (lower.includes('lines_changed') && lower.includes(': 0')) return true;

  return false;
}

function isSafeSingleCommandToRunUnbound(cmd: string): boolean {
  // Allow only "bootstrap" commands before binding so agents don't operate on the wrong window/workspace
  const normalized = cmd.trim().toLowerCase();

  if (normalized === "windows" || normalized.startsWith("windows ")) return true;
  if (normalized === "help" || normalized.startsWith("help ")) return true;
  if (normalized === "refresh") return true;

  if (normalized === "workspace list") return true;
  if (normalized === "workspace tabs") return true;
  if (normalized === "tabs") return true;

  if (normalized.startsWith("workspace switch ") && normalized.includes("--new-window")) return true;
  if (normalized.startsWith("workspace create ") && normalized.includes("--new-window")) return true;

  return false;
}

function isSafeToRunUnbound(cmd: string): boolean {
  // Allow `&&` chains, but only if *every* sub-command is safe before binding
  const parsed = parseCommandChain(cmd);
  if (parsed.hasSemicolonOutsideQuotes) return false;
  if (parsed.commands.length === 0) return false;

  return parsed.commands.every((command) => isSafeSingleCommandToRunUnbound(command));
}

function parseRpbindArgs(args: unknown): { windowId: number; tab: string } | { error: string } {
  const parts = Array.isArray(args) ? args : [];
  if (parts.length < 2) return { error: "Usage: /rpbind <window_id> <tab_name_or_uuid>" };

  const rawWindowId = String(parts[0]).trim();
  const windowId = Number.parseInt(rawWindowId, 10);
  if (!Number.isFinite(windowId)) return { error: `Invalid window_id: ${rawWindowId}` };

  const tab = parts.slice(1).join(" ").trim();
  if (!tab) return { error: "Tab cannot be empty" };

  return { windowId, tab };
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering utilities for rp_exec output
// ─────────────────────────────────────────────────────────────────────────────

interface FencedBlock {
  lang: string | undefined;
  code: string;
  startIndex: number;
  endIndex: number;
}

/**
 * Parse fenced code blocks from text. Handles:
 * - Multiple blocks
 * - Various language identifiers (typescript, diff, shell, etc.)
 * - Empty/missing language
 * - Unclosed fences (treated as extending to end of text)
 */
function parseFencedBlocks(text: string): FencedBlock[] {
  const blocks: FencedBlock[] = [];
  const lines = text.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const fenceMatch = line.match(/^\s*```(\S*)\s*$/);

    if (fenceMatch) {
      const lang = fenceMatch[1] || undefined;
      const startLine = i;
      const codeLines: string[] = [];
      i++;

      // Find closing fence (```)
      while (i < lines.length) {
        const closingMatch = lines[i].match(/^\s*```\s*$/);
        if (closingMatch) {
          i++;
          break;
        }
        codeLines.push(lines[i]);
        i++;
      }

      // Calculate character indices
      const startIndex = lines.slice(0, startLine).join("\n").length + (startLine > 0 ? 1 : 0);
      const endIndex = lines.slice(0, i).join("\n").length;

      blocks.push({
        lang,
        code: codeLines.join("\n"),
        startIndex,
        endIndex,
      });
    } else {
      i++;
    }
  }

  return blocks;
}

/**
 * Compute word-level diff with inverse highlighting on changed parts
 */
function renderIntraLineDiff(
  oldContent: string,
  newContent: string,
  theme: Theme
): { removedLine: string; addedLine: string } {
  const wordDiff = Diff.diffWords(oldContent, newContent);

  let removedLine = "";
  let addedLine = "";
  let isFirstRemoved = true;
  let isFirstAdded = true;

  for (const part of wordDiff) {
    if (part.removed) {
      let value = part.value;
      if (isFirstRemoved) {
        const leadingWs = value.match(/^(\s*)/)?.[1] || "";
        value = value.slice(leadingWs.length);
        removedLine += leadingWs;
        isFirstRemoved = false;
      }
      if (value) {
        removedLine += theme.inverse(value);
      }
    } else if (part.added) {
      let value = part.value;
      if (isFirstAdded) {
        const leadingWs = value.match(/^(\s*)/)?.[1] || "";
        value = value.slice(leadingWs.length);
        addedLine += leadingWs;
        isFirstAdded = false;
      }
      if (value) {
        addedLine += theme.inverse(value);
      }
    } else {
      removedLine += part.value;
      addedLine += part.value;
    }
  }

  return { removedLine, addedLine };
}

/**
 * Render diff lines with syntax highlighting (red/green, word-level inverse)
 */
function renderDiffBlock(code: string, theme: Theme): string {
  const lines = code.split("\n");
  const result: string[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trimStart();
    const indent = line.slice(0, line.length - trimmed.length);

    // File headers: --- a/file or +++ b/file
    if (trimmed.match(/^---\s+\S/) || trimmed.match(/^\+\+\+\s+\S/)) {
      result.push(indent + theme.fg("accent", trimmed));
      i++;
    }
    // Hunk headers: @@ -1,5 +1,6 @@
    else if (trimmed.match(/^@@\s+-\d+/)) {
      result.push(indent + theme.fg("muted", trimmed));
      i++;
    }
    // Removed lines (not file headers)
    else if (trimmed.startsWith("-") && !trimmed.match(/^---\s/)) {
      // Collect consecutive removed lines
      const removedLines: Array<{ indent: string; content: string }> = [];
      while (i < lines.length) {
        const l = lines[i];
        const t = l.trimStart();
        const ind = l.slice(0, l.length - t.length);
        if (t.startsWith("-") && !t.match(/^---\s/)) {
          removedLines.push({ indent: ind, content: t.slice(1) });
          i++;
        } else {
          break;
        }
      }

      // Collect consecutive added lines
      const addedLines: Array<{ indent: string; content: string }> = [];
      while (i < lines.length) {
        const l = lines[i];
        const t = l.trimStart();
        const ind = l.slice(0, l.length - t.length);
        if (t.startsWith("+") && !t.match(/^\+\+\+\s/)) {
          addedLines.push({ indent: ind, content: t.slice(1) });
          i++;
        } else {
          break;
        }
      }

      // Word-level highlighting for 1:1 line changes
      if (removedLines.length === 1 && addedLines.length === 1) {
        const { removedLine, addedLine } = renderIntraLineDiff(
          removedLines[0].content,
          addedLines[0].content,
          theme
        );
        result.push(removedLines[0].indent + theme.fg("toolDiffRemoved", "-" + removedLine));
        result.push(addedLines[0].indent + theme.fg("toolDiffAdded", "+" + addedLine));
      } else {
        for (const r of removedLines) {
          result.push(r.indent + theme.fg("toolDiffRemoved", "-" + r.content));
        }
        for (const a of addedLines) {
          result.push(a.indent + theme.fg("toolDiffAdded", "+" + a.content));
        }
      }
    }
    // Added lines (not file headers)
    else if (trimmed.startsWith("+") && !trimmed.match(/^\+\+\+\s/)) {
      result.push(indent + theme.fg("toolDiffAdded", trimmed));
      i++;
    }
    // Context lines (start with space in unified diff)
    else if (line.startsWith(" ")) {
      result.push(theme.fg("toolDiffContext", line));
      i++;
    }
    // Empty or other lines
    else {
      result.push(indent + theme.fg("dim", trimmed));
      i++;
    }
  }

  return result.join("\n");
}

/**
 * Render rp_exec output with syntax highlighting for fenced code blocks.
 * - ```diff blocks get word-level diff highlighting
 * - Other fenced blocks get syntax highlighting via Pi's highlightCode
 * - Non-fenced content is rendered dim (no markdown parsing)
 */
function renderRpExecOutput(text: string, theme: Theme): string {
  const blocks = parseFencedBlocks(text);

  if (blocks.length === 0) {
    // No code fences - render everything dim
    return text.split("\n").map(line => theme.fg("dim", line)).join("\n");
  }

  const result: string[] = [];
  let lastEnd = 0;

  for (const block of blocks) {
    // Render text before this block (dim)
    if (block.startIndex > lastEnd) {
      const before = text.slice(lastEnd, block.startIndex);
      result.push(before.split("\n").map(line => theme.fg("dim", line)).join("\n"));
    }

    // Render the fenced block
    if (block.lang?.toLowerCase() === "diff") {
      // Diff block: use word-level diff highlighting
      result.push(theme.fg("muted", "```diff"));
      result.push(renderDiffBlock(block.code, theme));
      result.push(theme.fg("muted", "```"));
    } else if (block.lang) {
      // Other language: use Pi's syntax highlighting
      result.push(theme.fg("muted", "```" + block.lang));
      const highlighted = highlightCode(block.code, block.lang);
      result.push(highlighted.join("\n"));
      result.push(theme.fg("muted", "```"));
    } else {
      // No language specified: render as dim
      result.push(theme.fg("muted", "```"));
      result.push(theme.fg("dim", block.code));
      result.push(theme.fg("muted", "```"));
    }

    lastEnd = block.endIndex;
  }

  // Render text after last block (dim)
  if (lastEnd < text.length) {
    const after = text.slice(lastEnd);
    result.push(after.split("\n").map(line => theme.fg("dim", line)).join("\n"));
  }

  return result.join("\n");
}

// Collapsed output settings
const COLLAPSED_MAX_LINES = 15;
const COLLAPSED_MAX_CHARS = 2000;

export default function (pi: ExtensionAPI) {
  let boundWindowId: number | undefined;
  let boundTab: string | undefined;

  const setBinding = (windowId: number, tab: string) => {
    boundWindowId = windowId;
    boundTab = tab;
  };

  const persistBinding = (windowId: number, tab: string) => {
    // Persist binding across session reloads without injecting extra text into the model context
    if (boundWindowId === windowId && boundTab === tab) return;

    setBinding(windowId, tab);
    pi.appendEntry(BINDING_CUSTOM_TYPE, { windowId, tab });
  };

  const reconstructBinding = (ctx: ExtensionContext) => {
    // Prefer persisted binding (appendEntry), then fall back to prior rp_bind tool results
    let reconstructedWindowId: number | undefined;
    let reconstructedTab: string | undefined;

    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "custom" || entry.customType !== BINDING_CUSTOM_TYPE) continue;

      const data = entry.data as { windowId?: unknown; tab?: unknown } | undefined;
      const windowId = typeof data?.windowId === "number" ? data.windowId : undefined;
      const tab = typeof data?.tab === "string" ? data.tab : undefined;
      if (windowId !== undefined && tab) {
        reconstructedWindowId = windowId;
        reconstructedTab = tab;
      }
    }

    if (reconstructedWindowId !== undefined && reconstructedTab !== undefined) {
      setBinding(reconstructedWindowId, reconstructedTab);
      return;
    }

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      const msg = entry.message;
      if (msg.role !== "toolResult" || msg.toolName !== "rp_bind") continue;

      const details = msg.details as { windowId?: number; tab?: string } | undefined;
      if (details?.windowId !== undefined && details?.tab) {
        persistBinding(details.windowId, details.tab);
      }
    }
  };

  pi.on("session_start", async (_event, ctx) => reconstructBinding(ctx));
  pi.on("session_switch", async (_event, ctx) => reconstructBinding(ctx));
  pi.on("session_branch", async (_event, ctx) => reconstructBinding(ctx));
  pi.on("session_tree", async (_event, ctx) => reconstructBinding(ctx));

  pi.registerCommand("rpbind", {
    description: "Bind rp_exec to RepoPrompt: /rpbind <window_id> <tab>",
    handler: async (args, ctx) => {
      const parsed = parseRpbindArgs(args);
      if ("error" in parsed) {
        ctx.ui.notify(parsed.error, "error");
        return;
      }

      persistBinding(parsed.windowId, parsed.tab);
      ctx.ui.notify(`Bound rp_exec → window ${boundWindowId}, tab "${boundTab}"`, "success");
    },
  });

  pi.registerTool({
    name: "rp_bind",
    label: "RepoPrompt Bind",
    description: "Bind rp_exec to a specific RepoPrompt window and compose tab",
    parameters: BindParams,

    async execute(_toolCallId, params, _onUpdate, _ctx, _signal) {
      persistBinding(params.windowId, params.tab);

      return {
        content: [{ type: "text", text: `Bound rp_exec → window ${boundWindowId}, tab "${boundTab}"` }],
        details: { windowId: boundWindowId, tab: boundTab },
      };
    },
  });

  pi.registerTool({
    name: "rp_exec",
    label: "RepoPrompt Exec",
    description: "Run rp-cli in the bound RepoPrompt window/tab, with quiet defaults and output truncation",
    parameters: ExecParams,

    async execute(_toolCallId, params, onUpdate, _ctx, signal) {
      // Routing: prefer call-time overrides, otherwise fall back to the last persisted binding
      const windowId = params.windowId ?? boundWindowId;
      const tab = params.tab ?? boundTab;
      const rawJson = params.rawJson ?? false;
      const quiet = params.quiet ?? true;
      const failFast = params.failFast ?? true;
      const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const maxOutputChars = params.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
      const allowDelete = params.allowDelete ?? false;
      const allowWorkspaceSwitchInPlace = params.allowWorkspaceSwitchInPlace ?? false;
      const failOnNoopEdits = params.failOnNoopEdits ?? true;

      if (!allowDelete && looksLikeDeleteCommand(params.cmd)) {
        return {
          content: [
            {
              type: "text",
              text: "Blocked potential delete command. If deletion is explicitly requested, rerun with allowDelete=true",
            },
          ],
          details: { blocked: true, reason: "delete", cmd: params.cmd, windowId, tab },
        };
      }

      if (!allowWorkspaceSwitchInPlace && looksLikeWorkspaceSwitchInPlace(params.cmd)) {
        return {
          content: [
            {
              type: "text",
              text:
                "Blocked in-place workspace change (it can clobber selection/prompt/context and disrupt other sessions). " +
                "Add `--new-window`, or rerun with allowWorkspaceSwitchInPlace=true if explicitly safe",
            },
          ],
          details: { blocked: true, reason: "workspace_switch_in_place", cmd: params.cmd, windowId, tab },
        };
      }

      const isBound = windowId !== undefined && tab !== undefined;
      if (!isBound && !isSafeToRunUnbound(params.cmd)) {
        return {
          content: [
            {
              type: "text",
              text:
                "Blocked rp_exec because it is not bound to a window+tab. " +
                "Do not fall back to native Pi tools—bind first. " +
                "Run `windows` and `workspace tabs`, then bind with rp_bind(windowId, tab). " +
                "If RepoPrompt is in single-window mode, windowId is usually 1",
            },
          ],
          details: { blocked: true, reason: "unbound", cmd: params.cmd, windowId, tab },
        };
      }

      const rpArgs: string[] = [];
      if (windowId !== undefined) rpArgs.push("-w", String(windowId));
      if (tab !== undefined) rpArgs.push("-t", tab);
      if (quiet) rpArgs.push("-q");
      if (rawJson) rpArgs.push("--raw-json");
      if (failFast) rpArgs.push("--fail-fast");
      rpArgs.push("-e", params.cmd);

      if (windowId === undefined || tab === undefined) {
        onUpdate({
          status:
            "Running rp-cli without a bound window/tab (non-deterministic). Bind first with rp_bind(windowId, tab)",
        });
      } else {
        onUpdate({ status: `Running rp-cli in window ${windowId}, tab "${tab}"…` });
      }

      let stdout = "";
      let stderr = "";
      let exitCode = -1;
      let execError: string | undefined;

      try {
        const result = await pi.exec("rp-cli", rpArgs, { signal, timeout: timeoutMs });
        stdout = result.stdout ?? "";
        stderr = result.stderr ?? "";
        exitCode = result.code ?? 0;
      } catch (error) {
        execError = error instanceof Error ? error.message : String(error);
      }

      const combinedOutput = [stdout, stderr].filter(Boolean).join("\n").trim();

      const rawOutput = execError ? `rp-cli execution failed: ${execError}` : combinedOutput;

      const editNoop =
        !execError &&
        exitCode === 0 &&
        looksLikeEditCommand(params.cmd) &&
        looksLikeNoopEditOutput(rawOutput);

      const shouldFailNoopEdit = editNoop && failOnNoopEdits;

      let outputForUser = rawOutput;
      if (editNoop) {
        const rpCliOutput = rawOutput.length > 0 ? `\n--- rp-cli output ---\n${rawOutput}` : "";

        if (shouldFailNoopEdit) {
          outputForUser =
            "RepoPrompt edit made no changes (0 edits applied). This usually means the search string was not found.\n" +
            "If this was expected, rerun with failOnNoopEdits=false. Otherwise, verify the search text or rerun with rawJson=true / quiet=false.\n" +
            "Tip: for tricky edits, prefer: call apply_edits {..., verbose:true}" +
            rpCliOutput;
        } else {
          outputForUser =
            "RepoPrompt edit made no changes (0 edits applied).\n" +
            "RepoPrompt may report this as an error (e.g. 'search block not found'), but failOnNoopEdits=false is treating it as non-fatal.\n" +
            "Tip: for tricky edits, prefer: call apply_edits {..., verbose:true}" +
            rpCliOutput;
        }
      }

      const outputWithBindingWarning =
        windowId === undefined || tab === undefined
          ? `WARNING: rp_exec is not bound to a RepoPrompt window/tab. Bind with rp_bind(windowId, tab).\n\n${outputForUser}`
          : outputForUser;

      const { text: truncatedOutput, truncated } = truncateText(outputWithBindingWarning.trim(), maxOutputChars);
      const finalText = truncatedOutput.length > 0 ? truncatedOutput : "(no output)";

      return {
        isError: shouldFailNoopEdit,
        content: [{ type: "text", text: finalText }],
        details: {
          cmd: params.cmd,
          windowId,
          tab,
          rawJson,
          quiet,
          failOnNoopEdits,
          failFast,
          timeoutMs,
          maxOutputChars,
          exitCode,
          truncated,
          stderrIncluded: stderr.trim().length > 0,
          execError,
          editNoop,
          shouldFailNoopEdit,
        },
      };
    },

    renderCall(args: Record<string, unknown>, theme: Theme) {
      const cmd = (args.cmd as string) || "...";
      const windowId = args.windowId ?? boundWindowId;
      const tab = args.tab ?? boundTab;

      let text = theme.fg("toolTitle", theme.bold("rp_exec"));
      text += " " + theme.fg("accent", cmd);

      if (windowId !== undefined && tab !== undefined) {
        text += theme.fg("muted", ` (window ${windowId}, tab "${tab}")`);
      } else {
        text += theme.fg("warning", " (unbound)");
      }

      return new Text(text, 0, 0);
    },

    renderResult(
      result: { content: Array<{ type: string; text?: string }>; details?: Record<string, unknown>; isError?: boolean },
      options: ToolRenderResultOptions,
      theme: Theme
    ) {
      const details = result.details || {};
      const exitCode = details.exitCode as number | undefined;
      const truncated = details.truncated as boolean | undefined;
      const blocked = details.blocked as boolean | undefined;

      // Get text content
      const textContent = result.content
        .filter((c) => c.type === "text")
        .map((c) => c.text || "")
        .join("\n");

      // Handle partial/streaming state
      if (options.isPartial) {
        return new Text(theme.fg("warning", "Running…"), 0, 0);
      }

      // Handle blocked commands
      if (blocked) {
        return new Text(theme.fg("error", "✗ " + textContent), 0, 0);
      }

      // Handle errors
      if (result.isError || (exitCode !== undefined && exitCode !== 0)) {
        const exitInfo = exitCode !== undefined ? ` (exit ${exitCode})` : "";
        return new Text(theme.fg("error", `✗${exitInfo}\n${textContent}`), 0, 0);
      }

      // Success case
      const truncatedNote = truncated ? theme.fg("warning", " (truncated)") : "";
      const successPrefix = theme.fg("success", "✓");

      // Collapsed view: show line count
      if (!options.expanded) {
        const lines = textContent.split("\n");
        if (lines.length > COLLAPSED_MAX_LINES || textContent.length > COLLAPSED_MAX_CHARS) {
          const preview = renderRpExecOutput(
            lines.slice(0, COLLAPSED_MAX_LINES).join("\n"),
            theme
          );
          const remaining = lines.length - COLLAPSED_MAX_LINES;
          const moreText = remaining > 0 ? theme.fg("muted", `\n… (${remaining} more lines)`) : "";
          return new Text(`${successPrefix}${truncatedNote}\n${preview}${moreText}`, 0, 0);
        }
      }

      // Expanded view or short output: render with syntax highlighting
      const highlighted = renderRpExecOutput(textContent, theme);
      return new Text(`${successPrefix}${truncatedNote}\n${highlighted}`, 0, 0);
    },
  });
}
