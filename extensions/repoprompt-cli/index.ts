import { spawnSync } from "node:child_process";
import * as path from "node:path";

import type { ExtensionAPI, ExtensionContext, ToolRenderResultOptions } from "@mariozechner/pi-coding-agent";
import { highlightCode, Theme } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import * as Diff from "diff";

import { loadConfig } from "./config.js";
import {
  computeSliceRangeFromReadArgs,
  countFileLines,
  inferSelectionStatus,
  toPosixPath,
} from "./auto-select.js";
import { RP_READCACHE_CUSTOM_TYPE, SCOPE_FULL, scopeRange } from "./readcache/constants.js";
import { buildInvalidationV1 } from "./readcache/meta.js";
import { getStoreStats, pruneObjectsOlderThan } from "./readcache/object-store.js";
import { readFileWithCache } from "./readcache/read-file.js";
import { clearReplayRuntimeState, createReplayRuntimeState } from "./readcache/replay.js";
import { clearRootsCache, resolveReadFilePath } from "./readcache/resolve.js";
import type { RpReadcacheMetaV1, ScopeKey } from "./readcache/types.js";
import type {
  AutoSelectionEntryData,
  AutoSelectionEntryRangeData,
  AutoSelectionEntrySliceData,
  RpCliBindingEntryData,
} from "./types.js";

let parseBash: ((input: string) => any) | null = null;
let justBashLoadPromise: Promise<void> | null = null;
let justBashLoadDone = false;

async function ensureJustBashLoaded(): Promise<void> {
  if (justBashLoadDone) return;

  if (!justBashLoadPromise) {
    justBashLoadPromise = import("just-bash")
      .then((mod: any) => {
        parseBash = typeof mod?.parse === "function" ? mod.parse : null;
      })
      .catch(() => {
        parseBash = null;
      })
      .finally(() => {
        justBashLoadDone = true;
      });
  }

  await justBashLoadPromise;
}

let warnedAstUnavailable = false;
function maybeWarnAstUnavailable(ctx: any): void {
  if (warnedAstUnavailable) return;
  if (parseBash) return;
  if (!ctx?.hasUI) return;

  warnedAstUnavailable = true;
  ctx.ui.notify(
    "repoprompt-cli: just-bash >= 2 is not available; falling back to best-effort command parsing",
    "warning",
  );
}

type BashInvocation = {
  statementIndex: number;
  pipelineIndex: number;
  pipelineLength: number;
  commandNameRaw: string;
  commandName: string;
  args: string[];
};

function commandBaseName(value: string): string {
  const normalized = value.replace(/\\+/g, "/");
  const idx = normalized.lastIndexOf("/");
  const base = idx >= 0 ? normalized.slice(idx + 1) : normalized;
  return base.toLowerCase();
}

function partToText(part: any): string {
  if (!part || typeof part !== "object") return "";

  switch (part.type) {
    case "Literal":
    case "SingleQuoted":
    case "Escaped":
      return typeof part.value === "string" ? part.value : "";
    case "DoubleQuoted":
      return Array.isArray(part.parts) ? part.parts.map(partToText).join("") : "";
    case "Glob":
      return typeof part.pattern === "string" ? part.pattern : "";
    case "TildeExpansion":
      return typeof part.user === "string" && part.user.length > 0 ? `~${part.user}` : "~";
    case "ParameterExpansion":
      return typeof part.parameter === "string" && part.parameter.length > 0
        ? "${" + part.parameter + "}"
        : "${}";
    case "CommandSubstitution":
      return "$(...)";
    case "ProcessSubstitution":
      return part.direction === "output" ? ">(...)" : "<(...)";
    case "ArithmeticExpansion":
      return "$((...))";
    default:
      return "";
  }
}

function wordToText(word: any): string {
  if (!word || typeof word !== "object" || !Array.isArray(word.parts)) return "";
  return word.parts.map(partToText).join("");
}

function analyzeTopLevelBashScript(command: string): { parseError?: string; topLevelInvocations: BashInvocation[] } {
  try {
    if (!parseBash) {
      return { parseError: "just-bash parse unavailable", topLevelInvocations: [] };
    }

    const ast: any = parseBash(command);
    const topLevelInvocations: BashInvocation[] = [];

    if (!ast || typeof ast !== "object" || !Array.isArray(ast.statements)) {
      return { topLevelInvocations };
    }

    ast.statements.forEach((statement: any, statementIndex: number) => {
      if (!statement || typeof statement !== "object" || !Array.isArray(statement.pipelines)) return;

      statement.pipelines.forEach((pipeline: any, pipelineIndex: number) => {
        if (!pipeline || typeof pipeline !== "object" || !Array.isArray(pipeline.commands)) return;

        const pipelineLength = pipeline.commands.length;
        pipeline.commands.forEach((commandNode: any) => {
          if (!commandNode || commandNode.type !== "SimpleCommand") return;

          const commandNameRaw = wordToText(commandNode.name).trim();
          if (!commandNameRaw) return;

          const args = Array.isArray(commandNode.args)
            ? commandNode.args.map((arg: any) => wordToText(arg)).filter(Boolean)
            : [];

          topLevelInvocations.push({
            statementIndex,
            pipelineIndex,
            pipelineLength,
            commandNameRaw,
            commandName: commandBaseName(commandNameRaw),
            args,
          });
        });
      });
    });

    return { topLevelInvocations };
  } catch (error: any) {
    return {
      parseError: error?.message ?? String(error),
      topLevelInvocations: [],
    };
  }
}

function hasSemicolonOutsideQuotes(script: string): boolean {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  for (let i = 0; i < script.length; i += 1) {
    const ch = script[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      continue;
    }

    if (!inDoubleQuote && ch === "'") {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (!inSingleQuote && ch === '"') {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && ch === ";") {
      return true;
    }
  }

  return false;
}

function hasPipeOutsideQuotes(script: string): boolean {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  for (let i = 0; i < script.length; i += 1) {
    const ch = script[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      continue;
    }

    if (!inDoubleQuote && ch === "'") {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (!inSingleQuote && ch === '"') {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && ch === "|") {
      return true;
    }
  }

  return false;
}

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
 * - For best command parsing (AST-based), install `just-bash` >= 2; otherwise it falls back to a legacy splitter
 * - Syntax-highlight fenced code blocks in output (read, structure, etc.)
 * - Delta-powered diff highlighting (with graceful fallback when delta is unavailable)
 */

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_CHARS = 12000;
const BINDING_CUSTOM_TYPE = "repoprompt-binding";
const AUTO_SELECTION_CUSTOM_TYPE = "repoprompt-cli-auto-selection";
const WINDOWS_CACHE_TTL_MS = 5000;
const BINDING_VALIDATION_TTL_MS = 5000;

interface RpCliWindow {
  windowId: number;
  workspaceId?: string;
  workspaceName?: string;
  rootFolderPaths?: string[];
}

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

type ParsedCommandChain = {
  commands: string[];
  invocations: BashInvocation[];
  hasSemicolonOutsideQuotes: boolean;
};

function parseCommandChainLegacy(cmd: string): { commands: string[]; hasSemicolonOutsideQuotes: boolean } {
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

  for (let i = 0; i < cmd.length; i += 1) {
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

    if (!inSingleQuote && ch === '"') {
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

function renderInvocation(invocation: BashInvocation): string {
  return [invocation.commandNameRaw, ...invocation.args].filter(Boolean).join(" ").trim();
}

function parseCommandChain(cmd: string): ParsedCommandChain {
  const semicolonOutsideQuotes = hasSemicolonOutsideQuotes(cmd);
  const analysis = analyzeTopLevelBashScript(cmd);

  if (!analysis.parseError && analysis.topLevelInvocations.length > 0) {
    const commands = analysis.topLevelInvocations
      .map(renderInvocation)
      .filter((command) => command.length > 0);

    return {
      commands,
      invocations: analysis.topLevelInvocations,
      hasSemicolonOutsideQuotes: semicolonOutsideQuotes,
    };
  }

  const legacy = parseCommandChainLegacy(cmd);
  return {
    commands: legacy.commands,
    invocations: [],
    hasSemicolonOutsideQuotes: legacy.hasSemicolonOutsideQuotes || semicolonOutsideQuotes,
  };
}

function looksLikeDeleteCommand(cmd: string): boolean {
  const parsed = parseCommandChain(cmd);

  if (parsed.invocations.length > 0) {
    for (const invocation of parsed.invocations) {
      const commandName = invocation.commandName;
      const args = invocation.args.map((arg) => arg.toLowerCase());

      if (commandName === "file" && args[0] === "delete") return true;
      if (commandName === "workspace" && args[0] === "delete") return true;

      if (commandName === "call") {
        const normalized = args.join(" ");
        if (
          /\baction\s*=\s*delete\b/.test(normalized)
          || /"action"\s*:\s*"delete"/.test(normalized)
          || /'action'\s*:\s*'delete'/.test(normalized)
        ) {
          return true;
        }
      }
    }
    return false;
  }

  // Fallback when parsing fails
  for (const command of parsed.commands) {
    const normalized = command.trim().toLowerCase();
    if (normalized === "file delete" || normalized.startsWith("file delete ")) return true;
    if (normalized === "workspace delete" || normalized.startsWith("workspace delete ")) return true;

    if (
      normalized.startsWith("call ")
      && (
        /\baction\s*=\s*delete\b/.test(normalized)
        || /"action"\s*:\s*"delete"/.test(normalized)
        || /'action'\s*:\s*'delete'/.test(normalized)
      )
    ) {
      return true;
    }
  }

  return false;
}

function looksLikeWorkspaceSwitchInPlace(cmd: string): boolean {
  const parsed = parseCommandChain(cmd);

  if (parsed.invocations.length > 0) {
    for (const invocation of parsed.invocations) {
      if (invocation.commandName !== "workspace") continue;

      const args = invocation.args.map((arg) => arg.toLowerCase());
      const action = args[0] ?? "";
      const hasNewWindow = args.includes("--new-window");
      const hasSwitchFlag = args.includes("--switch");

      if (action === "switch" && !hasNewWindow) return true;
      if (action === "create" && hasSwitchFlag && !hasNewWindow) return true;
    }

    return false;
  }

  // Fallback when parsing fails
  for (const command of parsed.commands) {
    const normalized = command.toLowerCase();

    if (normalized.startsWith("workspace switch ") && !normalized.includes("--new-window")) return true;

    const isCreate = normalized.startsWith("workspace create ");
    const requestsSwitch = /\B--switch\b/.test(normalized);
    if (isCreate && requestsSwitch && !normalized.includes("--new-window")) return true;
  }

  return false;
}

function looksLikeEditCommand(cmd: string): boolean {
  const parsed = parseCommandChain(cmd);

  if (parsed.invocations.length > 0) {
    return parsed.invocations.some((invocation) => {
      if (invocation.commandName === "edit") return true;
      if (invocation.commandName !== "call") return false;

      return invocation.args.some((arg) => arg.toLowerCase().includes("apply_edits"));
    });
  }

  return parsed.commands.some((command) => {
    const normalized = command.trim().toLowerCase();
    if (normalized === "edit" || normalized.startsWith("edit ")) return true;
    return normalized.startsWith("call ") && normalized.includes("apply_edits");
  });
}

type ParsedReadFileRequest = {
  cmdToRun: string;
  path: string;
  startLine?: number;
  limit?: number;
  bypassCache: boolean;

  // Whether it is safe to apply readcache substitution (marker/diff) for this request
  // When false, we may still rewrite cmdToRun to strip wrapper-only args like bypass_cache=true
  cacheable: boolean;
};

function parseReadFileRequest(cmd: string): ParsedReadFileRequest | null {
  const parsed = parseCommandChain(cmd);

  // Only handle simple, single-invocation commands to avoid surprising behavior
  if (parsed.hasSemicolonOutsideQuotes) return null;

  let commandNameRaw: string;
  let commandName: string;
  let rawArgs: string[];

  if (parsed.invocations.length === 1) {
    const invocation = parsed.invocations[0];
    if (!invocation) return null;
    if (invocation.pipelineLength !== 1) return null;

    commandNameRaw = invocation.commandNameRaw;
    commandName = invocation.commandName;
    rawArgs = invocation.args;
  } else if (parsed.invocations.length === 0 && parsed.commands.length === 1) {
    const commandText = parsed.commands[0]?.trim() ?? "";
    if (!commandText) return null;

    // Legacy parsing fallback (just-bash unavailable): only attempt for trivially-tokenizable, single commands
    if (hasPipeOutsideQuotes(commandText)) return null;
    if (commandText.includes("\\")) return null;
    if (commandText.includes("\"") || commandText.includes("'") || commandText.includes("`")) return null;

    const parts = commandText.split(/\s+/).filter(Boolean);
    if (parts.length === 0) return null;

    commandNameRaw = parts[0] ?? "";
    commandName = commandBaseName(commandNameRaw);
    rawArgs = parts.slice(1);
  } else {
    return null;
  }

  if (commandName !== "read" && commandName !== "cat" && commandName !== "read_file") {
    return null;
  }

  let inputPath: string | undefined;
  let startLine: number | undefined;
  let limit: number | undefined;
  let bypassCache = false;
  let sawUnknownArg = false;

  const getNumber = (value: string): number | undefined => {
    if (!/^-?\d+$/.test(value.trim())) {
      return undefined;
    }

    const parsedInt = Number.parseInt(value, 10);
    return Number.isFinite(parsedInt) ? parsedInt : undefined;
  };

  const normalizeKey = (raw: string): string => {
    const trimmed = raw.trim().toLowerCase();
    const withoutDashes = trimmed.replace(/^--+/, "");
    return withoutDashes.replace(/-/g, "_");
  };

  const parseSliceSuffix = (value: string): { basePath: string; startLine: number; limit?: number } | null => {
    // Slice notation: path:start-end OR path:start
    // Example: file.swift:10-50
    const match = /^(.*?):(\d+)(?:-(\d+))?$/.exec(value);
    if (!match) return null;

    const basePath = match[1];
    const start = Number.parseInt(match[2] ?? "", 10);
    const end = match[3] ? Number.parseInt(match[3], 10) : undefined;

    if (!basePath || !Number.isFinite(start) || start <= 0) {
      return null;
    }

    if (end === undefined) {
      return { basePath, startLine: start };
    }

    if (!Number.isFinite(end) || end < start) {
      return null;
    }

    return { basePath, startLine: start, limit: end - start + 1 };
  };

  const filteredArgs: string[] = [];

  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i] ?? "";

    // Flags: --start-line 10, --limit 50, also support --start-line=10
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx > 0) {
        const rawKey = arg.slice(0, eqIdx);
        const key = normalizeKey(rawKey);
        const value = arg.slice(eqIdx + 1).trim();

        if (key === "start_line") {
          const parsedNumber = getNumber(value);
          if (parsedNumber === undefined) {
            sawUnknownArg = true;
          } else {
            startLine = parsedNumber;
          }
          filteredArgs.push(arg);
          continue;
        }

        if (key === "limit") {
          const parsedNumber = getNumber(value);
          if (parsedNumber === undefined) {
            sawUnknownArg = true;
          } else {
            limit = parsedNumber;
          }
          filteredArgs.push(arg);
          continue;
        }

        sawUnknownArg = true;
        filteredArgs.push(arg);
        continue;
      }

      const key = normalizeKey(arg);
      if (key === "start_line") {
        const value = rawArgs[i + 1];
        if (typeof value === "string") {
          const parsedNumber = getNumber(value);
          if (parsedNumber === undefined) {
            sawUnknownArg = true;
          } else {
            startLine = parsedNumber;
          }
          i += 1;
          filteredArgs.push(arg, value);
          continue;
        }
      }

      if (key === "limit") {
        const value = rawArgs[i + 1];
        if (typeof value === "string") {
          const parsedNumber = getNumber(value);
          if (parsedNumber === undefined) {
            sawUnknownArg = true;
          } else {
            limit = parsedNumber;
          }
          i += 1;
          filteredArgs.push(arg, value);
          continue;
        }
      }

      // Unknown flag: keep it
      sawUnknownArg = true;
      filteredArgs.push(arg);
      continue;
    }

    // key=value pairs (rp-cli supports key=value and also dash->underscore)
    const eqIdx = arg.indexOf("=");
    if (eqIdx > 0) {
      const key = normalizeKey(arg.slice(0, eqIdx));
      const value = arg.slice(eqIdx + 1).trim();

      // wrapper-only knob (do not forward)
      if (key === "bypass_cache") {
        bypassCache = value === "true" || value === "1";
        continue;
      }

      if (key === "path") {
        const slice = parseSliceSuffix(value);
        if (slice) {
          inputPath = slice.basePath;
          if (startLine === undefined) startLine = slice.startLine;
          if (limit === undefined && slice.limit !== undefined) limit = slice.limit;
        } else {
          inputPath = value;
        }

        filteredArgs.push(arg);
        continue;
      }

      if (key === "start_line") {
        const parsedNumber = getNumber(value);
        if (parsedNumber === undefined) {
          sawUnknownArg = true;
        } else {
          startLine = parsedNumber;
        }
        filteredArgs.push(arg);
        continue;
      }

      if (key === "limit") {
        const parsedNumber = getNumber(value);
        if (parsedNumber === undefined) {
          sawUnknownArg = true;
        } else {
          limit = parsedNumber;
        }
        filteredArgs.push(arg);
        continue;
      }

      sawUnknownArg = true;
      filteredArgs.push(arg);
      continue;
    }

    // positional path
    if (!inputPath && !arg.startsWith("-")) {
      const slice = parseSliceSuffix(arg);
      if (slice) {
        inputPath = slice.basePath;
        if (startLine === undefined) startLine = slice.startLine;
        if (limit === undefined && slice.limit !== undefined) limit = slice.limit;
      } else {
        inputPath = arg;
      }

      filteredArgs.push(arg);
      continue;
    }

    // positional start/limit (shorthand: read <path> [start] [limit])
    if (inputPath && startLine === undefined) {
      const startCandidate = getNumber(arg);
      if (typeof startCandidate === "number") {
        startLine = startCandidate;
        filteredArgs.push(arg);
        continue;
      }
    }

    if (inputPath && startLine !== undefined && limit === undefined) {
      const limitCandidate = getNumber(arg);
      if (typeof limitCandidate === "number") {
        limit = limitCandidate;
        filteredArgs.push(arg);
        continue;
      }
    }

    sawUnknownArg = true;
    filteredArgs.push(arg);
  }

  if (!inputPath) {
    return null;
  }

  let cmdToRun = [commandNameRaw, ...filteredArgs].filter(Boolean).join(" ");

  // Canonicalize into rp-cli's documented read shorthand syntax so that equivalent forms behave consistently
  // (especially for bypass_cache=true tests)
  const safePathForRewrite = /^\S+$/.test(inputPath);
  if (!sawUnknownArg && safePathForRewrite) {
    if (commandName === "read_file") {
      const parts: string[] = [commandNameRaw, `path=${inputPath}`];
      if (typeof startLine === "number") parts.push(`start_line=${startLine}`);
      if (typeof limit === "number") parts.push(`limit=${limit}`);
      cmdToRun = parts.join(" ");
    } else {
      const parts: string[] = [commandNameRaw, inputPath];
      if (typeof startLine === "number") parts.push(String(startLine));
      if (typeof limit === "number") parts.push(String(limit));
      cmdToRun = parts.join(" ");
    }
  }

  return {
    cmdToRun,
    path: inputPath,
    ...(typeof startLine === "number" ? { startLine } : {}),
    ...(typeof limit === "number" ? { limit } : {}),
    bypassCache,
    cacheable: !sawUnknownArg,
  };
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
  const parsed = parseCommandChain(cmd);

  if (parsed.invocations.length > 0) {
    if (parsed.invocations.length !== 1) return false;
    const invocation = parsed.invocations[0];
    const commandName = invocation.commandName;
    const args = invocation.args.map((arg) => arg.toLowerCase());

    if (commandName === "windows") return true;
    if (commandName === "help") return true;
    if (commandName === "refresh" && args.length === 0) return true;
    if (commandName === "tabs" && args.length === 0) return true;

    if (commandName === "workspace") {
      const action = args[0] ?? "";
      if (action === "list") return true;
      if (action === "tabs") return true;
      if (action === "switch" && args.includes("--new-window")) return true;
      if (action === "create" && args.includes("--new-window")) return true;
    }

    return false;
  }

  // Fallback when parsing fails
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

  if (parsed.invocations.length > 0) {
    return parsed.invocations.every((invocation) => {
      const commandText = renderInvocation(invocation);
      return isSafeSingleCommandToRunUnbound(commandText);
    });
  }

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

const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*m/g;
const DELTA_TIMEOUT_MS = 5000;
const DELTA_MAX_BUFFER = 8 * 1024 * 1024;
const DELTA_CACHE_MAX_ENTRIES = 200;

let deltaAvailable: boolean | null = null;
const deltaDiffCache = new Map<string, string | null>();

function isDeltaInstalled(): boolean {
  if (deltaAvailable !== null) {
    return deltaAvailable;
  }

  const check = spawnSync("delta", ["--version"], {
    stdio: "ignore",
    timeout: 1000,
  });

  deltaAvailable = !check.error && check.status === 0;
  return deltaAvailable;
}

function runDelta(diffText: string): string | null {
  const result = spawnSync("delta", ["--color-only", "--paging=never"], {
    encoding: "utf-8",
    input: diffText,
    timeout: DELTA_TIMEOUT_MS,
    maxBuffer: DELTA_MAX_BUFFER,
  });

  if (result.error || result.status !== 0) {
    return null;
  }

  return typeof result.stdout === "string" ? result.stdout : null;
}

function stripSyntheticHeader(deltaOutput: string): string {
  const outputLines = deltaOutput.split("\n");
  const bodyStart = outputLines.findIndex((line) => line.replace(ANSI_ESCAPE_RE, "").startsWith("@@"));

  if (bodyStart >= 0) {
    return outputLines.slice(bodyStart + 1).join("\n");
  }

  return deltaOutput;
}

function renderDiffBlockWithDelta(code: string): string | null {
  if (!isDeltaInstalled()) {
    return null;
  }

  const cached = deltaDiffCache.get(code);
  if (cached !== undefined) {
    return cached;
  }

  let rendered = runDelta(code);

  if (!rendered) {
    const syntheticDiff = [
      "--- a/file",
      "+++ b/file",
      "@@ -1,1 +1,1 @@",
      code,
    ].join("\n");

    const syntheticRendered = runDelta(syntheticDiff);
    if (syntheticRendered) {
      rendered = stripSyntheticHeader(syntheticRendered);
    }
  }

  if (deltaDiffCache.size >= DELTA_CACHE_MAX_ENTRIES) {
    deltaDiffCache.clear();
  }

  deltaDiffCache.set(code, rendered);
  return rendered;
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
  const deltaRendered = renderDiffBlockWithDelta(code);
  if (deltaRendered !== null) {
    return deltaRendered;
  }

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
 * - ```diff blocks use delta when available, with word-level fallback
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
  let config = loadConfig();

  // Replay-aware read_file caching state (optional; guarded by config.readcacheReadFile)
  const readcacheRuntimeState = createReplayRuntimeState();

  const clearReadcacheCaches = (): void => {
    clearReplayRuntimeState(readcacheRuntimeState);
  };

  let activeAutoSelectionState: AutoSelectionEntryData | null = null;

  let boundWindowId: number | undefined;
  let boundTab: string | undefined;
  let boundWorkspaceId: string | undefined;
  let boundWorkspaceName: string | undefined;
  let boundWorkspaceRoots: string[] | undefined;

  let windowsCache: { windows: RpCliWindow[]; fetchedAtMs: number } | null = null;
  let lastBindingValidationAtMs = 0;

  function sameOptionalText(a?: string, b?: string): boolean {
    return (a ?? undefined) === (b ?? undefined);
  }

  function clearWindowsCache(): void {
    windowsCache = null;
  }

  function markBindingValidationStale(): void {
    lastBindingValidationAtMs = 0;
  }

  function shouldRevalidateBinding(): boolean {
    const now = Date.now();
    return (now - lastBindingValidationAtMs) >= BINDING_VALIDATION_TTL_MS;
  }

  function markBindingValidatedNow(): void {
    lastBindingValidationAtMs = Date.now();
  }

  function normalizeWorkspaceRoots(roots: string[] | undefined): string[] {
    if (!Array.isArray(roots)) {
      return [];
    }

    return [...new Set(roots.map((root) => toPosixPath(String(root).trim())).filter(Boolean))].sort();
  }

  function workspaceRootsEqual(left: string[] | undefined, right: string[] | undefined): boolean {
    const leftNormalized = normalizeWorkspaceRoots(left);
    const rightNormalized = normalizeWorkspaceRoots(right);
    return JSON.stringify(leftNormalized) === JSON.stringify(rightNormalized);
  }

  function workspaceIdentityMatches(
    left: { workspaceId?: string; workspaceName?: string; workspaceRoots?: string[] },
    right: { workspaceId?: string; workspaceName?: string; workspaceRoots?: string[] }
  ): boolean {
    if (left.workspaceId && right.workspaceId) {
      return left.workspaceId === right.workspaceId;
    }

    const leftRoots = normalizeWorkspaceRoots(left.workspaceRoots);
    const rightRoots = normalizeWorkspaceRoots(right.workspaceRoots);

    if (leftRoots.length > 0 && rightRoots.length > 0) {
      return JSON.stringify(leftRoots) === JSON.stringify(rightRoots);
    }

    if (left.workspaceName && right.workspaceName) {
      return left.workspaceName === right.workspaceName;
    }

    return false;
  }

  function getCurrentBinding(): RpCliBindingEntryData | null {
    if (boundWindowId === undefined || !boundTab) {
      return null;
    }

    return {
      windowId: boundWindowId,
      tab: boundTab,
      workspaceId: boundWorkspaceId,
      workspaceName: boundWorkspaceName,
      workspaceRoots: boundWorkspaceRoots,
    };
  }

  function normalizeBindingEntry(binding: RpCliBindingEntryData): RpCliBindingEntryData {
    return {
      windowId: binding.windowId,
      tab: binding.tab,
      workspaceId: typeof binding.workspaceId === "string" ? binding.workspaceId : undefined,
      workspaceName: typeof binding.workspaceName === "string" ? binding.workspaceName : undefined,
      workspaceRoots: normalizeWorkspaceRoots(binding.workspaceRoots),
    };
  }

  function bindingEntriesEqual(a: RpCliBindingEntryData | null, b: RpCliBindingEntryData | null): boolean {
    if (!a && !b) {
      return true;
    }

    if (!a || !b) {
      return false;
    }

    const left = normalizeBindingEntry(a);
    const right = normalizeBindingEntry(b);

    return (
      left.windowId === right.windowId &&
      left.tab === right.tab &&
      sameOptionalText(left.workspaceId, right.workspaceId) &&
      sameOptionalText(left.workspaceName, right.workspaceName) &&
      workspaceRootsEqual(left.workspaceRoots, right.workspaceRoots)
    );
  }

  function setBinding(binding: RpCliBindingEntryData | null): void {
    const previousWindowId = boundWindowId;

    if (!binding) {
      boundWindowId = undefined;
      boundTab = undefined;
      boundWorkspaceId = undefined;
      boundWorkspaceName = undefined;
      boundWorkspaceRoots = undefined;
    } else {
      const normalized = normalizeBindingEntry(binding);
      boundWindowId = normalized.windowId;
      boundTab = normalized.tab;
      boundWorkspaceId = normalized.workspaceId;
      boundWorkspaceName = normalized.workspaceName;
      boundWorkspaceRoots = normalized.workspaceRoots;
    }

    if (previousWindowId !== boundWindowId) {
      if (previousWindowId !== undefined) {
        clearRootsCache(previousWindowId);
      }

      if (boundWindowId !== undefined) {
        clearRootsCache(boundWindowId);
      }

      clearWindowsCache();
    }

    markBindingValidationStale();
  }

  function parseBindingEntryData(value: unknown): RpCliBindingEntryData | null {
    if (!value || typeof value !== "object") {
      return null;
    }

    const obj = value as Record<string, unknown>;

    const windowId = typeof obj.windowId === "number" ? obj.windowId : undefined;
    const tab = typeof obj.tab === "string" ? obj.tab : undefined;

    if (windowId === undefined || !tab) {
      return null;
    }

    const workspaceId = typeof obj.workspaceId === "string"
      ? obj.workspaceId
      : (typeof obj.workspaceID === "string" ? obj.workspaceID : undefined);

    const workspaceName = typeof obj.workspaceName === "string"
      ? obj.workspaceName
      : (typeof obj.workspace === "string" ? obj.workspace : undefined);

    const workspaceRoots = Array.isArray(obj.workspaceRoots)
      ? obj.workspaceRoots.filter((root): root is string => typeof root === "string")
      : (Array.isArray(obj.rootFolderPaths)
        ? obj.rootFolderPaths.filter((root): root is string => typeof root === "string")
        : undefined);

    return normalizeBindingEntry({
      windowId,
      tab,
      workspaceId,
      workspaceName,
      workspaceRoots,
    });
  }

  function persistBinding(binding: RpCliBindingEntryData): void {
    const normalized = normalizeBindingEntry(binding);
    const current = getCurrentBinding();

    if (bindingEntriesEqual(current, normalized)) {
      return;
    }

    setBinding(normalized);
    pi.appendEntry(BINDING_CUSTOM_TYPE, normalized);
  }

  function reconstructBinding(ctx: ExtensionContext): void {
    // Prefer persisted binding (appendEntry) from the *current branch*, then fall back to prior rp_bind tool results
    // Branch semantics: if the current branch has no binding state, stay unbound
    setBinding(null);

    let reconstructed: RpCliBindingEntryData | null = null;

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== BINDING_CUSTOM_TYPE) {
        continue;
      }

      const parsed = parseBindingEntryData(entry.data);
      if (parsed) {
        reconstructed = parsed;
      }
    }

    if (reconstructed) {
      setBinding(reconstructed);
      return;
    }

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message") {
        continue;
      }

      const msg = entry.message;
      if (msg.role !== "toolResult" || msg.toolName !== "rp_bind") {
        continue;
      }

      const parsed = parseBindingEntryData(msg.details);
      if (parsed) {
        persistBinding(parsed);
      }
    }
  }

  function parseWindowsRawJson(raw: string): RpCliWindow[] {
    const trimmed = raw.trim();
    if (!trimmed) {
      return [];
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return [];
    }

    const pickRows = (value: unknown): unknown[] => {
      if (Array.isArray(value)) {
        return value;
      }

      if (!value || typeof value !== "object") {
        return [];
      }

      const obj = value as Record<string, unknown>;

      const directArrayKeys = ["windows", "items", "data", "result"];
      for (const key of directArrayKeys) {
        const candidate = obj[key];
        if (Array.isArray(candidate)) {
          return candidate;
        }
      }

      const nested = obj.data;
      if (nested && typeof nested === "object") {
        const nestedObj = nested as Record<string, unknown>;
        if (Array.isArray(nestedObj.windows)) {
          return nestedObj.windows;
        }
      }

      return [];
    };

    const rows = pickRows(parsed);

    return rows
      .map((row) => {
        if (!row || typeof row !== "object") {
          return null;
        }

        const obj = row as Record<string, unknown>;
        const windowId = typeof obj.windowID === "number"
          ? obj.windowID
          : (typeof obj.windowId === "number" ? obj.windowId : undefined);

        if (windowId === undefined) {
          return null;
        }

        const workspaceId = typeof obj.workspaceID === "string"
          ? obj.workspaceID
          : (typeof obj.workspaceId === "string" ? obj.workspaceId : undefined);

        const workspaceName = typeof obj.workspaceName === "string"
          ? obj.workspaceName
          : (typeof obj.workspace === "string" ? obj.workspace : undefined);

        const rootFolderPaths = Array.isArray(obj.rootFolderPaths)
          ? obj.rootFolderPaths.filter((root): root is string => typeof root === "string")
          : (Array.isArray(obj.roots)
            ? obj.roots.filter((root): root is string => typeof root === "string")
            : undefined);

        return {
          windowId,
          workspaceId,
          workspaceName,
          rootFolderPaths,
        } as RpCliWindow;
      })
      .filter((window): window is RpCliWindow => window !== null);
  }

  async function fetchWindowsFromCli(forceRefresh = false): Promise<RpCliWindow[]> {
    const now = Date.now();

    if (!forceRefresh && windowsCache && (now - windowsCache.fetchedAtMs) < WINDOWS_CACHE_TTL_MS) {
      return windowsCache.windows;
    }

    try {
      const result = await pi.exec("rp-cli", ["--raw-json", "-q", "-e", "windows"], { timeout: 10_000 });

      if ((result.code ?? 0) !== 0) {
        return windowsCache?.windows ?? [];
      }

      const stdout = result.stdout ?? "";
      const stderr = result.stderr ?? "";

      const fromStdout = parseWindowsRawJson(stdout);
      const parsed = fromStdout.length > 0 ? fromStdout : parseWindowsRawJson(stderr);

      windowsCache = {
        windows: parsed,
        fetchedAtMs: now,
      };

      return parsed;
    } catch {
      return windowsCache?.windows ?? [];
    }
  }

  function windowToBinding(window: RpCliWindow, tab: string): RpCliBindingEntryData {
    return normalizeBindingEntry({
      windowId: window.windowId,
      tab,
      workspaceId: window.workspaceId,
      workspaceName: window.workspaceName,
      workspaceRoots: window.rootFolderPaths,
    });
  }

  async function enrichBinding(windowId: number, tab: string): Promise<RpCliBindingEntryData> {
    const windows = await fetchWindowsFromCli();
    const match = windows.find((window) => window.windowId === windowId);

    if (!match) {
      return normalizeBindingEntry({ windowId, tab });
    }

    return windowToBinding(match, tab);
  }

  async function ensureBindingTargetsLiveWindow(
    ctx: ExtensionContext,
    forceRefresh = false
  ): Promise<RpCliBindingEntryData | null> {
    const binding = getCurrentBinding();
    if (!binding) {
      return null;
    }

    const windows = await fetchWindowsFromCli(forceRefresh);
    if (windows.length === 0) {
      return binding;
    }

    const sameWindow = windows.find((window) => window.windowId === binding.windowId);
    if (sameWindow) {
      const hydrated = windowToBinding(sameWindow, binding.tab);

      if (binding.workspaceId && hydrated.workspaceId && binding.workspaceId !== hydrated.workspaceId) {
        // Window IDs were recycled to a different workspace. Fall through to workspace-based remap
      } else {
        if (!bindingEntriesEqual(binding, hydrated)) {
          persistBinding(hydrated);
          return hydrated;
        }

        setBinding(hydrated);
        return hydrated;
      }
    }

    const workspaceCandidates = windows.filter((window) => workspaceIdentityMatches(
      {
        workspaceId: binding.workspaceId,
        workspaceName: binding.workspaceName,
        workspaceRoots: binding.workspaceRoots,
      },
      {
        workspaceId: window.workspaceId,
        workspaceName: window.workspaceName,
        workspaceRoots: window.rootFolderPaths,
      }
    ));

    if (workspaceCandidates.length === 1) {
      const rebound = windowToBinding(workspaceCandidates[0], binding.tab);
      persistBinding(rebound);
      return rebound;
    }

    setBinding(null);

    if (ctx.hasUI) {
      const workspaceLabel = binding.workspaceName ?? binding.workspaceId ?? `window ${binding.windowId}`;

      if (workspaceCandidates.length > 1) {
        ctx.ui.notify(
          `repoprompt-cli: binding for ${workspaceLabel} is ambiguous after restart. Re-bind with /rpbind`,
          "warning"
        );
      } else {
        ctx.ui.notify(
          `repoprompt-cli: ${workspaceLabel} not found after restart. Re-bind with /rpbind`,
          "warning"
        );
      }
    }

    return null;
  }

  async function maybeEnsureBindingTargetsLiveWindow(ctx: ExtensionContext): Promise<RpCliBindingEntryData | null> {
    const binding = getCurrentBinding();
    if (!binding) {
      return null;
    }

    if (!shouldRevalidateBinding()) {
      return binding;
    }

    const validated = await ensureBindingTargetsLiveWindow(ctx, true);

    if (validated) {
      markBindingValidatedNow();
    }

    return validated;
  }

  function sameBindingForAutoSelection(
    binding: RpCliBindingEntryData | null,
    state: AutoSelectionEntryData | null
  ): boolean {
    if (!binding || !state) {
      return false;
    }

    if (!sameOptionalText(binding.tab, state.tab)) {
      return false;
    }

    if (binding.windowId === state.windowId) {
      return true;
    }

    return workspaceIdentityMatches(
      {
        workspaceId: binding.workspaceId,
        workspaceName: binding.workspaceName,
        workspaceRoots: binding.workspaceRoots,
      },
      {
        workspaceId: state.workspaceId,
        workspaceName: state.workspaceName,
        workspaceRoots: state.workspaceRoots,
      }
    );
  }

  function makeEmptyAutoSelectionState(binding: RpCliBindingEntryData): AutoSelectionEntryData {
    return {
      windowId: binding.windowId,
      tab: binding.tab,
      workspaceId: binding.workspaceId,
      workspaceName: binding.workspaceName,
      workspaceRoots: normalizeWorkspaceRoots(binding.workspaceRoots),
      fullPaths: [],
      slicePaths: [],
    };
  }

  function normalizeAutoSelectionRanges(ranges: AutoSelectionEntryRangeData[]): AutoSelectionEntryRangeData[] {
    const normalized = ranges
      .map((range) => ({
        start_line: Number(range.start_line),
        end_line: Number(range.end_line),
      }))
      .filter((range) => Number.isFinite(range.start_line) && Number.isFinite(range.end_line))
      .filter((range) => range.start_line > 0 && range.end_line >= range.start_line)
      .sort((a, b) => {
        if (a.start_line !== b.start_line) {
          return a.start_line - b.start_line;
        }

        return a.end_line - b.end_line;
      });

    const merged: AutoSelectionEntryRangeData[] = [];
    for (const range of normalized) {
      const last = merged[merged.length - 1];
      if (!last) {
        merged.push(range);
        continue;
      }

      if (range.start_line <= last.end_line + 1) {
        last.end_line = Math.max(last.end_line, range.end_line);
        continue;
      }

      merged.push(range);
    }

    return merged;
  }

  function normalizeAutoSelectionState(state: AutoSelectionEntryData): AutoSelectionEntryData {
    const fullPaths = [...new Set(state.fullPaths.map((p) => toPosixPath(String(p).trim())).filter(Boolean))].sort();

    const fullSet = new Set(fullPaths);

    const sliceMap = new Map<string, AutoSelectionEntryRangeData[]>();
    for (const item of state.slicePaths) {
      const pathKey = toPosixPath(String(item.path ?? "").trim());
      if (!pathKey || fullSet.has(pathKey)) {
        continue;
      }

      const existing = sliceMap.get(pathKey) ?? [];
      existing.push(...normalizeAutoSelectionRanges(item.ranges ?? []));
      sliceMap.set(pathKey, existing);
    }

    const slicePaths: AutoSelectionEntrySliceData[] = [...sliceMap.entries()]
      .map(([pathKey, ranges]) => ({
        path: pathKey,
        ranges: normalizeAutoSelectionRanges(ranges),
      }))
      .filter((item) => item.ranges.length > 0)
      .sort((a, b) => a.path.localeCompare(b.path));

    return {
      windowId: state.windowId,
      tab: state.tab,
      workspaceId: typeof state.workspaceId === "string" ? state.workspaceId : undefined,
      workspaceName: typeof state.workspaceName === "string" ? state.workspaceName : undefined,
      workspaceRoots: normalizeWorkspaceRoots(state.workspaceRoots),
      fullPaths,
      slicePaths,
    };
  }

  function autoSelectionStatesEqual(a: AutoSelectionEntryData | null, b: AutoSelectionEntryData | null): boolean {
    if (!a && !b) {
      return true;
    }

    if (!a || !b) {
      return false;
    }

    const left = normalizeAutoSelectionState(a);
    const right = normalizeAutoSelectionState(b);

    return JSON.stringify(left) === JSON.stringify(right);
  }

  function parseAutoSelectionEntryData(
    value: unknown,
    binding: RpCliBindingEntryData
  ): AutoSelectionEntryData | null {
    if (!value || typeof value !== "object") {
      return null;
    }

    const obj = value as Record<string, unknown>;

    const windowId = typeof obj.windowId === "number" ? obj.windowId : undefined;
    const tab = typeof obj.tab === "string" ? obj.tab : undefined;

    const workspaceId = typeof obj.workspaceId === "string"
      ? obj.workspaceId
      : (typeof obj.workspaceID === "string" ? obj.workspaceID : undefined);

    const workspaceName = typeof obj.workspaceName === "string"
      ? obj.workspaceName
      : (typeof obj.workspace === "string" ? obj.workspace : undefined);

    const workspaceRoots = Array.isArray(obj.workspaceRoots)
      ? obj.workspaceRoots.filter((root): root is string => typeof root === "string")
      : (Array.isArray(obj.rootFolderPaths)
        ? obj.rootFolderPaths.filter((root): root is string => typeof root === "string")
        : undefined);

    const tabMatches = sameOptionalText(tab, binding.tab);
    const windowMatches = windowId === binding.windowId;
    const workspaceMatches = workspaceIdentityMatches(
      {
        workspaceId: binding.workspaceId,
        workspaceName: binding.workspaceName,
        workspaceRoots: binding.workspaceRoots,
      },
      {
        workspaceId,
        workspaceName,
        workspaceRoots,
      }
    );

    if (!tabMatches || (!windowMatches && !workspaceMatches)) {
      return null;
    }

    const fullPaths = Array.isArray(obj.fullPaths)
      ? obj.fullPaths.filter((item): item is string => typeof item === "string")
      : [];

    const slicePathsRaw = Array.isArray(obj.slicePaths) ? obj.slicePaths : [];
    const slicePaths: AutoSelectionEntrySliceData[] = slicePathsRaw
      .map((raw) => {
        if (!raw || typeof raw !== "object") {
          return null;
        }

        const row = raw as Record<string, unknown>;
        const pathValue = typeof row.path === "string" ? row.path : null;
        const rangesRaw = Array.isArray(row.ranges) ? row.ranges : [];

        if (!pathValue) {
          return null;
        }

        const ranges: AutoSelectionEntryRangeData[] = rangesRaw
          .map((rangeRaw) => {
            if (!rangeRaw || typeof rangeRaw !== "object") {
              return null;
            }

            const rangeObj = rangeRaw as Record<string, unknown>;
            const start = typeof rangeObj.start_line === "number" ? rangeObj.start_line : NaN;
            const end = typeof rangeObj.end_line === "number" ? rangeObj.end_line : NaN;

            if (!Number.isFinite(start) || !Number.isFinite(end)) {
              return null;
            }

            return {
              start_line: start,
              end_line: end,
            };
          })
          .filter((range): range is AutoSelectionEntryRangeData => range !== null);

        return {
          path: pathValue,
          ranges,
        };
      })
      .filter((item): item is AutoSelectionEntrySliceData => item !== null);

    return normalizeAutoSelectionState({
      windowId: binding.windowId,
      tab: binding.tab,
      workspaceId: binding.workspaceId ?? workspaceId,
      workspaceName: binding.workspaceName ?? workspaceName,
      workspaceRoots: binding.workspaceRoots ?? workspaceRoots,
      fullPaths,
      slicePaths,
    });
  }

  function getAutoSelectionStateFromBranch(
    ctx: ExtensionContext,
    binding: RpCliBindingEntryData
  ): AutoSelectionEntryData {
    const entries = ctx.sessionManager.getBranch();

    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i];
      if (entry.type !== "custom" || entry.customType !== AUTO_SELECTION_CUSTOM_TYPE) {
        continue;
      }

      const parsed = parseAutoSelectionEntryData(entry.data, binding);
      if (parsed) {
        return parsed;
      }
    }

    return makeEmptyAutoSelectionState(binding);
  }

  function persistAutoSelectionState(state: AutoSelectionEntryData): void {
    const normalized = normalizeAutoSelectionState(state);
    activeAutoSelectionState = normalized;
    pi.appendEntry(AUTO_SELECTION_CUSTOM_TYPE, normalized);
  }

  function autoSelectionManagedPaths(state: AutoSelectionEntryData): string[] {
    const fromSlices = state.slicePaths.map((item) => item.path);
    return [...new Set([...state.fullPaths, ...fromSlices])];
  }

  function autoSelectionSliceKey(item: AutoSelectionEntrySliceData): string {
    return JSON.stringify(normalizeAutoSelectionRanges(item.ranges));
  }

  function bindingForAutoSelectionState(state: AutoSelectionEntryData): RpCliBindingEntryData {
    return {
      windowId: state.windowId,
      tab: state.tab ?? "Compose",
      workspaceId: state.workspaceId,
      workspaceName: state.workspaceName,
      workspaceRoots: state.workspaceRoots,
    };
  }

  async function runRpCliForBinding(
    binding: RpCliBindingEntryData,
    cmd: string,
    rawJson = false,
    timeout = 10_000
  ): Promise<{ stdout: string; stderr: string; exitCode: number; output: string }> {
    const args: string[] = ["-w", String(binding.windowId)];

    if (binding.tab) {
      args.push("-t", binding.tab);
    }

    args.push("-q", "--fail-fast");

    if (rawJson) {
      args.push("--raw-json");
    }

    args.push("-e", cmd);

    const result = await pi.exec("rp-cli", args, { timeout });

    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    const exitCode = result.code ?? 0;
    const output = [stdout, stderr].filter(Boolean).join("\n").trim();

    if (exitCode !== 0) {
      throw new Error(output || `rp-cli exited with status ${exitCode}`);
    }

    return { stdout, stderr, exitCode, output };
  }

  async function callManageSelection(binding: RpCliBindingEntryData, args: Record<string, unknown>): Promise<string> {
    const cmd = `call manage_selection ${JSON.stringify(args)}`;
    const result = await runRpCliForBinding(binding, cmd, false);
    return result.output;
  }

  async function getSelectionFilesText(binding: RpCliBindingEntryData): Promise<string | null> {
    try {
      const text = await callManageSelection(binding, {
        op: "get",
        view: "files",
      });

      return text.length > 0 ? text : null;
    } catch {
      return null;
    }
  }

  function buildSelectionPathFromResolved(
    inputPath: string,
    resolved: { absolutePath: string | null; repoRoot: string | null }
  ): string {
    if (!resolved.absolutePath || !resolved.repoRoot) {
      return inputPath;
    }

    const rel = path.relative(resolved.repoRoot, resolved.absolutePath);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
      return inputPath;
    }

    const rootHint = path.basename(resolved.repoRoot);
    const relPosix = rel.split(path.sep).join("/");

    return `${rootHint}/${relPosix}`;
  }

  function updateAutoSelectionStateAfterFullRead(binding: RpCliBindingEntryData, selectionPath: string): void {
    const normalizedPath = toPosixPath(selectionPath);

    const baseState = sameBindingForAutoSelection(binding, activeAutoSelectionState)
      ? (activeAutoSelectionState as AutoSelectionEntryData)
      : makeEmptyAutoSelectionState(binding);

    const nextState: AutoSelectionEntryData = {
      ...baseState,
      fullPaths: [...baseState.fullPaths, normalizedPath],
      slicePaths: baseState.slicePaths.filter((entry) => entry.path !== normalizedPath),
    };

    const normalizedNext = normalizeAutoSelectionState(nextState);
    if (autoSelectionStatesEqual(baseState, normalizedNext)) {
      activeAutoSelectionState = normalizedNext;
      return;
    }

    persistAutoSelectionState(normalizedNext);
  }

  function existingSliceRangesForRead(
    binding: RpCliBindingEntryData,
    selectionPath: string
  ): AutoSelectionEntryRangeData[] | null {
    const normalizedPath = toPosixPath(selectionPath);

    const baseState = sameBindingForAutoSelection(binding, activeAutoSelectionState)
      ? (activeAutoSelectionState as AutoSelectionEntryData)
      : makeEmptyAutoSelectionState(binding);

    if (baseState.fullPaths.includes(normalizedPath)) {
      return null;
    }

    const existing = baseState.slicePaths.find((entry) => entry.path === normalizedPath);
    return normalizeAutoSelectionRanges(existing?.ranges ?? []);
  }

  function subtractCoveredRanges(
    incomingRange: AutoSelectionEntryRangeData,
    existingRanges: AutoSelectionEntryRangeData[]
  ): AutoSelectionEntryRangeData[] {
    let pending: AutoSelectionEntryRangeData[] = [incomingRange];

    for (const existing of normalizeAutoSelectionRanges(existingRanges)) {
      const nextPending: AutoSelectionEntryRangeData[] = [];

      for (const candidate of pending) {
        const overlapStart = Math.max(candidate.start_line, existing.start_line);
        const overlapEnd = Math.min(candidate.end_line, existing.end_line);

        if (overlapStart > overlapEnd) {
          nextPending.push(candidate);
          continue;
        }

        if (candidate.start_line < overlapStart) {
          nextPending.push({
            start_line: candidate.start_line,
            end_line: overlapStart - 1,
          });
        }

        if (candidate.end_line > overlapEnd) {
          nextPending.push({
            start_line: overlapEnd + 1,
            end_line: candidate.end_line,
          });
        }
      }

      pending = nextPending;
      if (pending.length === 0) {
        return [];
      }
    }

    return normalizeAutoSelectionRanges(pending);
  }

  function updateAutoSelectionStateAfterSliceRead(
    binding: RpCliBindingEntryData,
    selectionPath: string,
    range: AutoSelectionEntryRangeData
  ): void {
    const normalizedPath = toPosixPath(selectionPath);

    const baseState = sameBindingForAutoSelection(binding, activeAutoSelectionState)
      ? (activeAutoSelectionState as AutoSelectionEntryData)
      : makeEmptyAutoSelectionState(binding);

    if (baseState.fullPaths.includes(normalizedPath)) {
      return;
    }

    const existing = baseState.slicePaths.find((entry) => entry.path === normalizedPath);

    const nextSlicePaths = baseState.slicePaths.filter((entry) => entry.path !== normalizedPath);
    nextSlicePaths.push({
      path: normalizedPath,
      ranges: [...(existing?.ranges ?? []), range],
    });

    const nextState: AutoSelectionEntryData = {
      ...baseState,
      fullPaths: [...baseState.fullPaths],
      slicePaths: nextSlicePaths,
    };

    const normalizedNext = normalizeAutoSelectionState(nextState);
    if (autoSelectionStatesEqual(baseState, normalizedNext)) {
      activeAutoSelectionState = normalizedNext;
      return;
    }

    persistAutoSelectionState(normalizedNext);
  }

  async function removeAutoSelectionPaths(state: AutoSelectionEntryData, paths: string[]): Promise<void> {
    if (paths.length === 0) {
      return;
    }

    const binding = bindingForAutoSelectionState(state);
    await callManageSelection(binding, { op: "remove", paths });
  }

  async function addAutoSelectionFullPaths(state: AutoSelectionEntryData, paths: string[]): Promise<void> {
    if (paths.length === 0) {
      return;
    }

    const binding = bindingForAutoSelectionState(state);
    await callManageSelection(binding, {
      op: "add",
      mode: "full",
      paths,
    });
  }

  async function addAutoSelectionSlices(
    state: AutoSelectionEntryData,
    slices: AutoSelectionEntrySliceData[]
  ): Promise<void> {
    if (slices.length === 0) {
      return;
    }

    const binding = bindingForAutoSelectionState(state);
    await callManageSelection(binding, {
      op: "add",
      slices,
    });
  }

  async function reconcileAutoSelectionWithinBinding(
    currentState: AutoSelectionEntryData,
    desiredState: AutoSelectionEntryData
  ): Promise<void> {
    const currentModeByPath = new Map<string, "full" | "slices">();
    for (const p of currentState.fullPaths) {
      currentModeByPath.set(p, "full");
    }

    for (const s of currentState.slicePaths) {
      if (!currentModeByPath.has(s.path)) {
        currentModeByPath.set(s.path, "slices");
      }
    }

    const desiredModeByPath = new Map<string, "full" | "slices">();
    for (const p of desiredState.fullPaths) {
      desiredModeByPath.set(p, "full");
    }

    for (const s of desiredState.slicePaths) {
      if (!desiredModeByPath.has(s.path)) {
        desiredModeByPath.set(s.path, "slices");
      }
    }

    const desiredSliceByPath = new Map<string, AutoSelectionEntrySliceData>();
    for (const s of desiredState.slicePaths) {
      desiredSliceByPath.set(s.path, s);
    }

    const currentSliceByPath = new Map<string, AutoSelectionEntrySliceData>();
    for (const s of currentState.slicePaths) {
      currentSliceByPath.set(s.path, s);
    }

    const removePaths = new Set<string>();
    const addFullPaths: string[] = [];
    const addSlices: AutoSelectionEntrySliceData[] = [];

    for (const [pathKey] of currentModeByPath) {
      if (!desiredModeByPath.has(pathKey)) {
        removePaths.add(pathKey);
      }
    }

    for (const [pathKey, mode] of desiredModeByPath) {
      const currentMode = currentModeByPath.get(pathKey);

      if (mode === "full") {
        if (currentMode === "full") {
          continue;
        }

        if (currentMode === "slices") {
          removePaths.add(pathKey);
        }

        addFullPaths.push(pathKey);
        continue;
      }

      const desiredSlice = desiredSliceByPath.get(pathKey);
      if (!desiredSlice) {
        continue;
      }

      if (currentMode === "full") {
        removePaths.add(pathKey);
        addSlices.push(desiredSlice);
        continue;
      }

      if (currentMode === "slices") {
        const currentSlice = currentSliceByPath.get(pathKey);
        if (currentSlice && autoSelectionSliceKey(currentSlice) === autoSelectionSliceKey(desiredSlice)) {
          continue;
        }

        removePaths.add(pathKey);
        addSlices.push(desiredSlice);
        continue;
      }

      addSlices.push(desiredSlice);
    }

    await removeAutoSelectionPaths(currentState, [...removePaths]);
    await addAutoSelectionFullPaths(desiredState, addFullPaths);
    await addAutoSelectionSlices(desiredState, addSlices);
  }

  async function reconcileAutoSelectionStates(
    currentState: AutoSelectionEntryData | null,
    desiredState: AutoSelectionEntryData | null
  ): Promise<void> {
    if (autoSelectionStatesEqual(currentState, desiredState)) {
      return;
    }

    if (currentState && desiredState) {
      const sameBinding =
        currentState.windowId === desiredState.windowId &&
        sameOptionalText(currentState.tab, desiredState.tab);

      if (sameBinding) {
        await reconcileAutoSelectionWithinBinding(currentState, desiredState);
        return;
      }

      try {
        await removeAutoSelectionPaths(currentState, autoSelectionManagedPaths(currentState));
      } catch {
        // Old binding/window may no longer exist after RepoPrompt app restart
      }

      await addAutoSelectionFullPaths(desiredState, desiredState.fullPaths);
      await addAutoSelectionSlices(desiredState, desiredState.slicePaths);
      return;
    }

    if (currentState && !desiredState) {
      try {
        await removeAutoSelectionPaths(currentState, autoSelectionManagedPaths(currentState));
      } catch {
        // Old binding/window may no longer exist after RepoPrompt app restart
      }
      return;
    }

    if (!currentState && desiredState) {
      await addAutoSelectionFullPaths(desiredState, desiredState.fullPaths);
      await addAutoSelectionSlices(desiredState, desiredState.slicePaths);
    }
  }

  async function syncAutoSelectionToCurrentBranch(ctx: ExtensionContext): Promise<void> {
    if (config.autoSelectReadSlices !== true) {
      activeAutoSelectionState = null;
      return;
    }

    const binding = await ensureBindingTargetsLiveWindow(ctx);
    const desiredState = binding ? getAutoSelectionStateFromBranch(ctx, binding) : null;

    try {
      await reconcileAutoSelectionStates(activeAutoSelectionState, desiredState);
    } catch {
      // Fail-open
    }

    activeAutoSelectionState = desiredState;
  }

  function parseReadOutputHints(readOutputText: string | undefined): {
    selectionPath: string | null;
    totalLines: number | null;
  } {
    if (!readOutputText) {
      return { selectionPath: null, totalLines: null };
    }

    const pathMatch =
      /\*\*Path\*\*:\s*`([^`]+)`/i.exec(readOutputText) ??
      /\*\*Path\*\*:\s*([^\n]+)$/im.exec(readOutputText);

    const selectionPath = pathMatch?.[1]?.trim() ?? null;

    const linesRegexes = [
      /\*\*Lines\*\*:\s*(\d+)\s*[–—-]\s*(\d+)\s+of\s+(\d+)/i,
      /Lines(?:\s*:)?\s*(\d+)\s*[–—-]\s*(\d+)\s+of\s+(\d+)/i,
    ];

    let totalLines: number | null = null;

    for (const rx of linesRegexes) {
      const match = rx.exec(readOutputText);
      if (!match) {
        continue;
      }

      const parsed = Number.parseInt(match[3] ?? "", 10);
      if (Number.isFinite(parsed)) {
        totalLines = parsed;
        break;
      }
    }

    return { selectionPath, totalLines };
  }

  async function autoSelectReadFileInRepoPromptSelection(
    ctx: ExtensionContext,
    inputPath: string,
    startLine: number | undefined,
    limit: number | undefined,
    readOutputText: string | undefined
  ): Promise<void> {
    if (config.autoSelectReadSlices !== true) {
      return;
    }

    const outputHints = parseReadOutputHints(readOutputText);

    const binding = await maybeEnsureBindingTargetsLiveWindow(ctx);
    if (!binding) {
      return;
    }

    const selectionText = await getSelectionFilesText(binding);
    if (selectionText === null) {
      return;
    }

    const resolved = await resolveReadFilePath(pi, inputPath, ctx.cwd, binding.windowId, binding.tab);

    const resolvedSelectionPath = buildSelectionPathFromResolved(inputPath, resolved);
    const selectionPath =
      outputHints.selectionPath && outputHints.selectionPath.trim().length > 0
        ? outputHints.selectionPath
        : resolvedSelectionPath;

    const candidatePaths = new Set<string>();
    candidatePaths.add(toPosixPath(selectionPath));
    candidatePaths.add(toPosixPath(resolvedSelectionPath));
    candidatePaths.add(toPosixPath(inputPath));

    if (outputHints.selectionPath) {
      candidatePaths.add(toPosixPath(outputHints.selectionPath));
    }

    if (resolved.absolutePath) {
      candidatePaths.add(toPosixPath(resolved.absolutePath));
    }

    if (resolved.absolutePath && resolved.repoRoot) {
      const rel = path.relative(resolved.repoRoot, resolved.absolutePath);
      if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
        candidatePaths.add(toPosixPath(rel.split(path.sep).join("/")));
      }
    }

    let selectionStatus: ReturnType<typeof inferSelectionStatus> = null;

    for (const candidate of candidatePaths) {
      const status = inferSelectionStatus(selectionText, candidate);
      if (!status) {
        continue;
      }

      if (status.mode === "full") {
        selectionStatus = status;
        break;
      }

      if (status.mode === "codemap_only" && status.codemapManual === true) {
        selectionStatus = status;
        break;
      }

      if (selectionStatus === null) {
        selectionStatus = status;
        continue;
      }

      if (selectionStatus.mode === "codemap_only" && status.mode === "slices") {
        selectionStatus = status;
      }
    }

    if (selectionStatus?.mode === "full") {
      return;
    }

    if (selectionStatus?.mode === "codemap_only" && selectionStatus.codemapManual === true) {
      return;
    }

    let totalLines: number | undefined;

    if (typeof startLine === "number" && startLine < 0) {
      if (resolved.absolutePath) {
        try {
          totalLines = await countFileLines(resolved.absolutePath);
        } catch {
          totalLines = undefined;
        }
      }

      if (totalLines === undefined && typeof outputHints.totalLines === "number") {
        totalLines = outputHints.totalLines;
      }
    }

    const sliceRange = computeSliceRangeFromReadArgs(startLine, limit, totalLines);


    if (sliceRange) {
      const existingRanges = existingSliceRangesForRead(binding, selectionPath);
      if (!existingRanges) {
        return;
      }

      const uncoveredRanges = subtractCoveredRanges(sliceRange, existingRanges);

      if (uncoveredRanges.length === 0) {
        updateAutoSelectionStateAfterSliceRead(binding, selectionPath, sliceRange);
        return;
      }

      // Add only uncovered ranges to avoid touching unrelated selection state
      // (and to avoid global set semantics)
      const payload = {
        op: "add",
        slices: [
          {
            path: toPosixPath(selectionPath),
            ranges: uncoveredRanges,
          },
        ],
      };

      try {
        await callManageSelection(binding, payload);
      } catch {
        // Fail-open
        return;
      }

      updateAutoSelectionStateAfterSliceRead(binding, selectionPath, sliceRange);
      return;
    }

    const payload = {
      op: "add",
      mode: "full",
      paths: [toPosixPath(selectionPath)],
    };

    try {
      await callManageSelection(binding, payload);
    } catch {
      // Fail-open
      return;
    }

    updateAutoSelectionStateAfterFullRead(binding, selectionPath);
  }


  pi.on("session_start", async (_event, ctx) => {
    config = loadConfig();
    clearReadcacheCaches();
    clearWindowsCache();
    markBindingValidationStale();
    reconstructBinding(ctx);

    const binding = getCurrentBinding();
    activeAutoSelectionState =
      config.autoSelectReadSlices === true && binding
        ? getAutoSelectionStateFromBranch(ctx, binding)
        : null;

    if (config.readcacheReadFile === true) {
      void pruneObjectsOlderThan(ctx.cwd).catch(() => {
        // Fail-open
      });
    }

    try {
      await syncAutoSelectionToCurrentBranch(ctx);
    } catch {
      // Fail-open
    }
  });

  pi.on("session_switch", async (_event, ctx) => {
    config = loadConfig();
    clearReadcacheCaches();
    clearWindowsCache();
    markBindingValidationStale();
    reconstructBinding(ctx);
    await syncAutoSelectionToCurrentBranch(ctx);
  });

  // session_fork is the current event name; keep session_branch for backwards compatibility
  pi.on("session_fork", async (_event, ctx) => {
    config = loadConfig();
    clearReadcacheCaches();
    clearWindowsCache();
    markBindingValidationStale();
    reconstructBinding(ctx);
    await syncAutoSelectionToCurrentBranch(ctx);
  });

  pi.on("session_branch", async (_event, ctx) => {
    config = loadConfig();
    clearReadcacheCaches();
    clearWindowsCache();
    markBindingValidationStale();
    reconstructBinding(ctx);
    await syncAutoSelectionToCurrentBranch(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    config = loadConfig();
    clearReadcacheCaches();
    clearWindowsCache();
    markBindingValidationStale();
    reconstructBinding(ctx);
    await syncAutoSelectionToCurrentBranch(ctx);
  });

  pi.on("session_compact", async () => {
    clearReadcacheCaches();
  });

  pi.on("session_shutdown", async () => {
    clearReadcacheCaches();
    clearWindowsCache();
    activeAutoSelectionState = null;
    setBinding(null);
  });

  pi.registerCommand("rpbind", {
    description: "Bind rp_exec to RepoPrompt: /rpbind <window_id> <tab>",
    handler: async (args, ctx) => {
      const parsed = parseRpbindArgs(args);
      if ("error" in parsed) {
        ctx.ui.notify(parsed.error, "error");
        return;
      }

      const binding = await enrichBinding(parsed.windowId, parsed.tab);
      persistBinding(binding);

      try {
        await syncAutoSelectionToCurrentBranch(ctx);
      } catch {
        // Fail-open
      }

      ctx.ui.notify(
        `Bound rp_exec → window ${boundWindowId}, tab "${boundTab}"` +
          (boundWorkspaceName ? ` (${boundWorkspaceName})` : ""),
        "success"
      );
    },
  });


  pi.registerCommand("rpcli-readcache-status", {
    description: "Show repoprompt-cli read_file cache status",
    handler: async (_args, ctx) => {
      config = loadConfig();

      let msg = "repoprompt-cli read_file cache\n";
      msg += "──────────────────────────\n";
      msg += `Enabled: ${config.readcacheReadFile === true ? "✓" : "✗"}\n`;
      msg += `Auto-select reads: ${config.autoSelectReadSlices === true ? "✓" : "✗"}\n`;

      if (config.readcacheReadFile !== true) {
        msg += "\nEnable by creating ~/.pi/agent/extensions/repoprompt-cli/config.json\n";
        msg += "\nwith:\n  { \"readcacheReadFile\": true }\n";
        ctx.ui.notify(msg, "info");
        return;
      }

      try {
        const stats = await getStoreStats(ctx.cwd);
        msg += `\nObject store (under ${ctx.cwd}/.pi/readcache):\n`;
        msg += `  Objects: ${stats.objects}\n`;
        msg += `  Bytes: ${stats.bytes}\n`;
      } catch {
        msg += "\nObject store: unavailable\n";
      }

      msg += "\nNotes:\n";
      msg += "- Cache applies only to simple rp_exec reads (read/cat/read_file)\n";
      msg += "- Use bypass_cache=true in the read command to force baseline output\n";

      ctx.ui.notify(msg, "info");
    },
  });

  pi.registerCommand("rpcli-readcache-refresh", {
    description: "Invalidate repoprompt-cli read_file cache trust for a path and optional line range",
    handler: async (args, ctx) => {
      config = loadConfig();

      if (config.readcacheReadFile !== true) {
        ctx.ui.notify("readcacheReadFile is disabled in config", "error");
        return;
      }

      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify("Usage: /rpcli-readcache-refresh <path> [start-end]", "error");
        return;
      }

      const parts = trimmed.split(/\s+/);
      const pathInput = parts[0];
      const rangeInput = parts[1];

      if (!pathInput) {
        ctx.ui.notify("Usage: /rpcli-readcache-refresh <path> [start-end]", "error");
        return;
      }

      const binding = await ensureBindingTargetsLiveWindow(ctx);
      if (!binding) {
        ctx.ui.notify("rp_exec is not bound. Bind first via /rpbind or rp_bind", "error");
        return;
      }

      let scopeKey: ScopeKey = SCOPE_FULL;
      if (rangeInput) {
        const match = rangeInput.match(/^(\d+)-(\d+)$/);
        if (!match) {
          ctx.ui.notify("Invalid range. Use <start-end> like 1-120", "error");
          return;
        }

        const start = parseInt(match[1] ?? "", 10);
        const end = parseInt(match[2] ?? "", 10);
        if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end < start) {
          ctx.ui.notify("Invalid range. Use <start-end> like 1-120", "error");
          return;
        }

        scopeKey = scopeRange(start, end);
      }

      const resolved = await resolveReadFilePath(pi, pathInput, ctx.cwd, binding.windowId, binding.tab);
      if (!resolved.absolutePath) {
        ctx.ui.notify(`Could not resolve path: ${pathInput}`, "error");
        return;
      }

      pi.appendEntry(RP_READCACHE_CUSTOM_TYPE, buildInvalidationV1(resolved.absolutePath, scopeKey));
      clearReadcacheCaches();

      ctx.ui.notify(
        `Invalidated readcache for ${resolved.absolutePath}` + (scopeKey === SCOPE_FULL ? "" : ` (${scopeKey})`),
        "info"
      );
    },
  });

  pi.registerTool({
    name: "rp_bind",
    label: "RepoPrompt Bind",
    description: "Bind rp_exec to a specific RepoPrompt window and compose tab",
    parameters: BindParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      await ensureJustBashLoaded();
      maybeWarnAstUnavailable(ctx);

      const binding = await enrichBinding(params.windowId, params.tab);
      persistBinding(binding);

      try {
        await syncAutoSelectionToCurrentBranch(ctx);
      } catch {
        // Fail-open
      }

      return {
        content: [{ type: "text", text: `Bound rp_exec → window ${boundWindowId}, tab "${boundTab}"` }],
        details: {
          windowId: boundWindowId,
          tab: boundTab,
          workspaceId: boundWorkspaceId,
          workspaceName: boundWorkspaceName,
          workspaceRoots: boundWorkspaceRoots,
        },
      };
    },
  });

  pi.registerTool({
    name: "rp_exec",
    label: "RepoPrompt Exec",
    description: "Run rp-cli in the bound RepoPrompt window/tab, with quiet defaults and output truncation",
    parameters: ExecParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      // Routing: prefer call-time overrides, otherwise fall back to the last persisted binding
      await ensureJustBashLoaded();
      maybeWarnAstUnavailable(ctx);

      if (params.windowId === undefined && params.tab === undefined) {
        try {
          await maybeEnsureBindingTargetsLiveWindow(ctx);
        } catch {
          // Fail-open
        }
      }

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
          isError: true,
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
          isError: true,
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

      // Parse read-like commands to:
      // - detect cacheable reads (when enabled)
      // - strip wrapper-only args like bypass_cache=true even when caching is disabled
      //   (so agents can safely use bypass_cache in instructions regardless of config)
      const readRequest = parseReadFileRequest(params.cmd);

      const cmdToRun = readRequest ? readRequest.cmdToRun : params.cmd;

      const rpArgs: string[] = [];
      if (windowId !== undefined) rpArgs.push("-w", String(windowId));
      if (tab !== undefined) rpArgs.push("-t", tab);
      if (quiet) rpArgs.push("-q");
      if (rawJson) rpArgs.push("--raw-json");
      if (failFast) rpArgs.push("--fail-fast");
      rpArgs.push("-e", cmdToRun);

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

      let rawOutput = execError ? `rp-cli execution failed: ${execError}` : combinedOutput;

      let rpReadcache: RpReadcacheMetaV1 | null = null;

      if (
        config.readcacheReadFile === true &&
        readRequest !== null &&
        readRequest.cacheable === true &&
        !execError &&
        exitCode === 0 &&
        windowId !== undefined &&
        tab !== undefined
      ) {
        try {
          const cached = await readFileWithCache(
            pi,
            {
              path: readRequest.path,
              ...(typeof readRequest.startLine === "number" ? { start_line: readRequest.startLine } : {}),
              ...(typeof readRequest.limit === "number" ? { limit: readRequest.limit } : {}),
              ...(readRequest.bypassCache ? { bypass_cache: true } : {}),
            },
            ctx,
            readcacheRuntimeState,
            windowId,
            tab,
            signal
          );

          rpReadcache = cached.meta;

          if (typeof cached.outputText === "string" && cached.outputText.length > 0) {
            rawOutput = cached.outputText;
          }
        } catch {
          // Fail-open: caching must never break the baseline command output
        }
      }

      const shouldAutoSelectRead =
        config.autoSelectReadSlices === true &&
        readRequest !== null &&
        !execError &&
        exitCode === 0 &&
        windowId !== undefined &&
        tab !== undefined &&
        params.windowId === undefined &&
        params.tab === undefined;

      if (shouldAutoSelectRead) {
        try {
          await autoSelectReadFileInRepoPromptSelection(
            ctx,
            readRequest.path,
            readRequest.startLine,
            readRequest.limit,
            combinedOutput,
          );
        } catch {
          // Fail-open
        }
      }

      const editNoop =
        !execError &&
        exitCode === 0 &&
        looksLikeEditCommand(params.cmd) &&
        looksLikeNoopEditOutput(rawOutput);

      const shouldFailNoopEdit = editNoop && failOnNoopEdits;
      const commandFailed = Boolean(execError) || exitCode !== 0;
      const shouldError = commandFailed || shouldFailNoopEdit;

      let outputForUser = rawOutput;
      if (editNoop) {
        const rpCliOutput = rawOutput.length > 0 ? `\n--- rp-cli output ---\n${rawOutput}` : "";

        if (shouldFailNoopEdit) {
          outputForUser =
            "RepoPrompt edit made no changes (0 edits applied). This usually means the search string was not found.\n" +
            "If this was expected, rerun with failOnNoopEdits=false. Otherwise, verify the search text or rerun with rawJson=true / quiet=false.\n" +
            "Tip: for tricky edits with multiline content, use rp-cli directly: rp-cli -c apply_edits -j '{...}'" +
            rpCliOutput;
        } else {
          outputForUser =
            "RepoPrompt edit made no changes (0 edits applied).\n" +
            "RepoPrompt may report this as an error (e.g. 'search block not found'), but failOnNoopEdits=false is treating it as non-fatal.\n" +
            "Tip: for tricky edits with multiline content, use rp-cli directly: rp-cli -c apply_edits -j '{...}'" +
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
        isError: shouldError,
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
          rpReadcache: rpReadcache ?? undefined,
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
