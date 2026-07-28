/**
 * Protect Paths Extension
 *
 * Standalone directory protection hooks that complement @aliou/pi-guardrails
 * (which handles .env files and dangerous command confirmation)
 *
 * This extension protects:
 * - .git/ directory contents (prevents repository corruption)
 * - node_modules/ directory contents (use package manager instead)
 * - Homebrew install/upgrade commands (remind to use project package manager)
 * - Broad delete commands (rm/rmdir/unlink)
 * - Piped shell execution (e.g. `curl ... | sh`)
 *
 * Bash command checks are AST-backed via just-bash parsing so nested
 * substitutions/functions/conditionals are inspected instead of regex-only matching
 *
 * Dependency note:
 * - For best results, install `just-bash` >= 2 (provides the bash AST parser export)
 * - If unavailable, this extension falls back to best-effort regex checks
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
        "protect-paths: just-bash >= 2 is not available; falling back to best-effort regex command checks",
        "warning",
    );
}

type BashInvocation = {
    pipelineIndex: number;
    pipelineLength: number;
    commandNameRaw: string;
    commandName: string;
    args: string[];
    effectiveCommandNameRaw: string;
    effectiveCommandName: string;
    effectiveArgs: string[];
    redirections: Array<{ operator: string; target: string }>;
};

type BashAnalysis = {
    parseError?: string;
    invocations: BashInvocation[];
};

type BashPathReference = {
    path: string;
    allowTrustedRead: boolean;
};

const WRAPPER_COMMANDS = new Set(["command", "builtin", "exec", "nohup"]);

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
        case "BraceExpansion":
            return "{...}";
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

function resolveEffectiveCommand(commandNameRaw: string, args: string[]): {
    effectiveCommandNameRaw: string;
    effectiveCommandName: string;
    effectiveArgs: string[];
} {
    const primary = commandNameRaw.trim();
    const primaryBase = commandBaseName(primary);

    if (WRAPPER_COMMANDS.has(primaryBase)) {
        const next = args[0] ?? "";
        return {
            effectiveCommandNameRaw: next,
            effectiveCommandName: commandBaseName(next),
            effectiveArgs: args.slice(1),
        };
    }

    if (primaryBase === "env") {
        let idx = 0;
        while (idx < args.length) {
            const token = args[idx] ?? "";
            if (token === "--") {
                idx += 1;
                break;
            }
            if (token.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token)) {
                idx += 1;
                continue;
            }
            break;
        }

        const next = args[idx] ?? "";
        return {
            effectiveCommandNameRaw: next,
            effectiveCommandName: commandBaseName(next),
            effectiveArgs: args.slice(idx + 1),
        };
    }

    if (primaryBase === "sudo") {
        let idx = 0;
        while (idx < args.length) {
            const token = args[idx] ?? "";
            if (token === "--") {
                idx += 1;
                break;
            }
            if (token.startsWith("-")) {
                idx += 1;
                continue;
            }
            break;
        }

        const next = args[idx] ?? "";
        return {
            effectiveCommandNameRaw: next,
            effectiveCommandName: commandBaseName(next),
            effectiveArgs: args.slice(idx + 1),
        };
    }

    return {
        effectiveCommandNameRaw: primary,
        effectiveCommandName: primaryBase,
        effectiveArgs: args,
    };
}

function collectNestedScriptsFromWord(word: any, collect: (script: any) => void): void {
    if (!word || typeof word !== "object" || !Array.isArray(word.parts)) return;

    for (const part of word.parts) {
        if (!part || typeof part !== "object") continue;

        if (part.type === "DoubleQuoted") {
            collectNestedScriptsFromWord(part, collect);
            continue;
        }

        if ((part.type === "CommandSubstitution" || part.type === "ProcessSubstitution") && part.body) {
            collect(part.body);
        }
    }
}

function analyzeBashScript(command: string): BashAnalysis {
    try {
        if (!parseBash) {
            return { parseError: "just-bash parse unavailable", invocations: [] };
        }

        const ast: any = parseBash(command);
        const invocations: BashInvocation[] = [];

        const visitScript = (script: any) => {
            if (!script || typeof script !== "object" || !Array.isArray(script.statements)) return;

            for (const statement of script.statements) {
                if (!statement || typeof statement !== "object" || !Array.isArray(statement.pipelines)) continue;

                for (const [, pipeline] of statement.pipelines.entries()) {
                    if (!pipeline || typeof pipeline !== "object" || !Array.isArray(pipeline.commands)) continue;

                    const pipelineLength = pipeline.commands.length;

                    for (const [pipelineIndex, commandNode] of pipeline.commands.entries()) {
                        if (!commandNode || typeof commandNode !== "object") continue;

                        if (commandNode.type === "SimpleCommand") {
                            const commandNameRaw = wordToText(commandNode.name).trim();
                            const commandName = commandBaseName(commandNameRaw);
                            const args = Array.isArray(commandNode.args)
                                ? commandNode.args.map((arg: any) => wordToText(arg)).filter(Boolean)
                                : [];
                            const redirections = Array.isArray(commandNode.redirections)
                                ? commandNode.redirections.map((r: any) => ({
                                    operator: typeof r?.operator === "string" ? r.operator : "",
                                    target: r?.target?.type === "HereDoc" ? "heredoc" : wordToText(r?.target),
                                }))
                                : [];

                            const effective = resolveEffectiveCommand(commandNameRaw, args);
                            invocations.push({
                                pipelineIndex,
                                pipelineLength,
                                commandNameRaw,
                                commandName,
                                args,
                                effectiveCommandNameRaw: effective.effectiveCommandNameRaw,
                                effectiveCommandName: effective.effectiveCommandName,
                                effectiveArgs: effective.effectiveArgs,
                                redirections,
                            });

                            if (commandNode.name) {
                                collectNestedScriptsFromWord(commandNode.name, visitScript);
                            }
                            if (Array.isArray(commandNode.args)) {
                                for (const arg of commandNode.args) {
                                    collectNestedScriptsFromWord(arg, visitScript);
                                }
                            }
                            continue;
                        }

                        if (Array.isArray(commandNode.body)) visitScript({ statements: commandNode.body });
                        if (Array.isArray(commandNode.condition)) visitScript({ statements: commandNode.condition });
                        if (Array.isArray(commandNode.clauses)) {
                            for (const clause of commandNode.clauses) {
                                if (Array.isArray(clause?.condition)) visitScript({ statements: clause.condition });
                                if (Array.isArray(clause?.body)) visitScript({ statements: clause.body });
                            }
                        }
                        if (Array.isArray(commandNode.elseBody)) visitScript({ statements: commandNode.elseBody });
                        if (Array.isArray(commandNode.items)) {
                            for (const item of commandNode.items) {
                                if (Array.isArray(item?.body)) visitScript({ statements: item.body });
                            }
                        }
                        if (commandNode.word) collectNestedScriptsFromWord(commandNode.word, visitScript);
                        if (Array.isArray(commandNode.words)) {
                            for (const word of commandNode.words) {
                                collectNestedScriptsFromWord(word, visitScript);
                            }
                        }
                    }
                }
            }
        };

        visitScript(ast);
        return { invocations };
    } catch (error: any) {
        return { parseError: error?.message ?? String(error), invocations: [] };
    }
}

// ============================================================================
// Configuration
// ============================================================================

export interface ProtectPathsConfig {
    trustedReadPaths: string[];
}

interface ProtectPathsOptions {
    configPath?: string;
}

const DEFAULT_CONFIG: ProtectPathsConfig = {
    trustedReadPaths: [],
};

const DEFAULT_CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), "config.json");

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function loadProtectPathsConfig(configPath = DEFAULT_CONFIG_PATH): ProtectPathsConfig {
    if (!existsSync(configPath)) return DEFAULT_CONFIG;

    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(configPath, "utf8"));
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid protect-paths config at ${configPath}: ${message}`);
    }

    if (!isRecord(parsed)) {
        throw new Error(`Invalid protect-paths config at ${configPath}: expected an object`);
    }

    const unsupportedKeys = Object.keys(parsed).filter((key) => key !== "trustedReadPaths");
    if (unsupportedKeys.length > 0) {
        throw new Error(
            `Invalid protect-paths config at ${configPath}: unsupported keys ${unsupportedKeys.join(", ")}`,
        );
    }

    if (!Array.isArray(parsed.trustedReadPaths) || parsed.trustedReadPaths.length === 0) {
        throw new Error(`Invalid protect-paths config at ${configPath}: trustedReadPaths must be a non-empty array`);
    }

    const invalidPath = parsed.trustedReadPaths.find(
        (path) => typeof path !== "string" || path.length === 0 || !isAbsolute(path),
    );
    if (invalidPath !== undefined) {
        throw new Error(`Invalid protect-paths config at ${configPath}: trustedReadPaths must contain absolute paths`);
    }

    return {
        trustedReadPaths: parsed.trustedReadPaths.map((path) => resolve(path as string)),
    };
}

const SHELL_EXECUTABLES = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const DELETE_EXECUTABLES = new Set(["rm", "rmdir", "unlink"]);
const BREW_ACTIONS = new Set(["install", "bundle", "upgrade", "reinstall"]);
const READ_ONLY_BASH_COMMANDS = new Set(["find", "grep", "ls", "rg"]);
const MUTATING_FIND_ACTIONS = new Set([
    "-delete",
    "-exec",
    "-execdir",
    "-fprint",
    "-fprint0",
    "-fprintf",
    "-ok",
    "-okdir",
]);

// Regex fallback for parse failures
const BREW_INSTALL_PATTERNS = [
    /\bbrew\s+install\b/,
    /\bbrew\s+cask\s+install\b/,
    /\bbrew\s+bundle\b/,
    /\bbrew\s+upgrade\b/,
    /\bbrew\s+reinstall\b/,
];

// Tools that can read files from configured trusted paths
const READ_TOOLS = ["read", "grep", "find", "ls"];

// Tools that can write or modify files never receive trusted-path access
const WRITE_TOOLS = ["write", "edit"];

// ============================================================================
// Path checking
// ============================================================================

const GIT_DIR_PATTERN = /(?:^|[/\\])\.git(?:[/\\]|$)/;
const NODE_MODULES_PATTERN = /(?:^|[/\\])node_modules(?:[/\\]|$)/;

function isTrustedReadPath(filePath: string, trustedReadPaths: string[]): boolean {
    const resolved = resolve(filePath);
    return trustedReadPaths.some(
        (trustedPath) => resolved === trustedPath || resolved.startsWith(`${trustedPath}${sep}`),
    );
}

function isProtectedDirectory(
    filePath: string,
    allowTrustedRead: boolean,
    trustedReadPaths: string[],
): boolean {
    const resolved = resolve(filePath);

    if (GIT_DIR_PATTERN.test(resolved)) {
        return true;
    }

    if (NODE_MODULES_PATTERN.test(resolved)) {
        if (allowTrustedRead && isTrustedReadPath(resolved, trustedReadPaths)) {
            return false;
        }
        return true;
    }

    return false;
}

function getProtectionReason(filePath: string): string {
    if (GIT_DIR_PATTERN.test(filePath)) {
        return `Accessing ${filePath} is not allowed. The .git directory is protected to prevent repository corruption.`;
    }
    if (NODE_MODULES_PATTERN.test(filePath)) {
        return `Accessing ${filePath} is not allowed. The node_modules directory is protected. Use package manager commands to manage dependencies.`;
    }
    return `Path "${filePath}" is protected.`;
}

function extractPathFromInput(input: Record<string, unknown>): string {
    const p = String(input.file_path ?? input.path ?? "");
    return p || "";
}

function invocationReadsPathsOnly(invocation: BashInvocation): boolean {
    if (!READ_ONLY_BASH_COMMANDS.has(invocation.effectiveCommandName)) return false;
    if (invocation.effectiveCommandName !== "find") return true;

    return !invocation.effectiveArgs.some((arg) => MUTATING_FIND_ACTIONS.has(arg.toLowerCase()));
}

function appendProtectedPathReference(
    refs: BashPathReference[],
    seen: Set<string>,
    path: string,
    allowTrustedRead: boolean,
): void {
    if (!GIT_DIR_PATTERN.test(path) && !NODE_MODULES_PATTERN.test(path)) return;

    const key = `${allowTrustedRead ? "read" : "protected"}:${path}`;
    if (seen.has(key)) return;

    seen.add(key);
    refs.push({ path, allowTrustedRead });
}

function extractProtectedDirRefsFromCommand(command: string): BashPathReference[] {
    const refs: BashPathReference[] = [];
    const seen = new Set<string>();

    const analysis = analyzeBashScript(command);
    if (!analysis.parseError) {
        for (const invocation of analysis.invocations) {
            const allowTrustedRead = invocationReadsPathsOnly(invocation);

            appendProtectedPathReference(refs, seen, invocation.commandNameRaw, false);
            appendProtectedPathReference(refs, seen, invocation.effectiveCommandNameRaw, false);
            for (const arg of invocation.effectiveArgs) {
                appendProtectedPathReference(refs, seen, arg, allowTrustedRead);
            }
            for (const redirection of invocation.redirections) {
                appendProtectedPathReference(refs, seen, redirection.target, false);
            }
        }
    } else {
        // Parser failures stay fail-closed because command context is unavailable
        const gitDirRegex =
            /(?:^|\s|[<>|;&"'`])([^\s<>|;&"'`]*\.git[/\\][^\s<>|;&"'`]*)((?:\s|$|[<>|;&"'`]))/gi;
        for (const match of command.matchAll(gitDirRegex)) {
            if (match[1]) appendProtectedPathReference(refs, seen, match[1], false);
        }

        const nodeModulesRegex =
            /(?:^|\s|[<>|;&"'`])([^\s<>|;&"'`]*node_modules[/\\][^\s<>|;&"'`]*)((?:\s|$|[<>|;&"'`]))/gi;
        for (const match of command.matchAll(nodeModulesRegex)) {
            if (match[1]) appendProtectedPathReference(refs, seen, match[1], false);
        }
    }

    return refs;
}

function isBrewInstallOrUpgrade(command: string): boolean {
    const analysis = analyzeBashScript(command);

    if (!analysis.parseError) {
        for (const invocation of analysis.invocations) {
            if (invocation.effectiveCommandName !== "brew") continue;

            const args = invocation.effectiveArgs;
            const first = (args[0] ?? "").toLowerCase();
            const second = (args[1] ?? "").toLowerCase();

            if (BREW_ACTIONS.has(first)) {
                return true;
            }

            if (first === "cask" && second === "install") {
                return true;
            }
        }

        return false;
    }

    return BREW_INSTALL_PATTERNS.some((pattern) => pattern.test(command));
}

function detectDangerousCommand(command: string): { kind: "delete" | "piped shell"; commandName?: string } | null {
    const analysis = analyzeBashScript(command);

    if (!analysis.parseError) {
        const deleteMatch = analysis.invocations.find((invocation) => DELETE_EXECUTABLES.has(invocation.effectiveCommandName));
        if (deleteMatch) {
            return {
                kind: "delete",
                commandName: deleteMatch.effectiveCommandNameRaw || deleteMatch.commandNameRaw,
            };
        }

        const pipedShellMatch = analysis.invocations.find(
            (invocation) =>
                invocation.pipelineLength > 1
                && invocation.pipelineIndex > 0
                && SHELL_EXECUTABLES.has(invocation.effectiveCommandName),
        );
        if (pipedShellMatch) {
            return {
                kind: "piped shell",
                commandName: pipedShellMatch.effectiveCommandNameRaw || pipedShellMatch.commandNameRaw,
            };
        }

        return null;
    }

    // Fallback for parser failures
    if (/\brm\s+/.test(command)) {
        return { kind: "delete", commandName: "rm" };
    }

    if (/\|\s*(?:sh|bash|zsh|dash|ksh|fish)\b/.test(command)) {
        return { kind: "piped shell" };
    }

    return null;
}

// ============================================================================
// Extension
// ============================================================================

export default function (pi: ExtensionAPI, options: ProtectPathsOptions = {}) {
    const { trustedReadPaths } = loadProtectPathsConfig(options.configPath);

    // --- Directory protection for file-oriented tools ---
    pi.on("tool_call", async (event, ctx) => {
        const isReadTool = READ_TOOLS.includes(event.toolName);
        const isWriteTool = WRITE_TOOLS.includes(event.toolName);
        if (!isReadTool && !isWriteTool) return;

        const filePath = extractPathFromInput(event.input);
        if (!filePath) return;

        const allowTrustedRead = isReadTool;
        if (isProtectedDirectory(filePath, allowTrustedRead, trustedReadPaths)) {
            ctx.ui.notify(`Blocked access to protected path: ${filePath}`, "warning");
            return {
                block: true,
                reason: getProtectionReason(filePath),
            };
        }
        return;
    });

    // --- Directory protection for bash commands ---
    pi.on("tool_call", async (event, ctx) => {
        if (event.toolName !== "bash") return;

        await ensureJustBashLoaded();
        maybeWarnAstUnavailable(ctx);

        const command = String(event.input.command ?? "");
        const refs = extractProtectedDirRefsFromCommand(command);

        for (const ref of refs) {
            if (isProtectedDirectory(ref.path, ref.allowTrustedRead, trustedReadPaths)) {
                ctx.ui.notify(`Blocked access to protected path: ${ref.path}`, "warning");
                return {
                    block: true,
                    reason: `Command references protected path ${ref.path}. ${getProtectionReason(ref.path)}`,
                };
            }
        }
        return;
    });

    // --- Prevent Homebrew install/upgrade ---
    pi.on("tool_call", async (event, ctx) => {
        if (event.toolName !== "bash") return;

        await ensureJustBashLoaded();
        maybeWarnAstUnavailable(ctx);

        const command = String(event.input.command ?? "");

        if (isBrewInstallOrUpgrade(command)) {
            ctx.ui.notify("Blocked brew command. Use the project's package manager instead.", "warning");
            return {
                block: true,
                reason: "Homebrew install/upgrade commands are blocked. Please use the project's package manager (npm, pnpm, bun, nix, etc.) instead.",
            };
        }

        return;
    });

    // --- Extra permission gates (confirm, not hard block) ---
    // These complement upstream @aliou/pi-guardrails which covers rm -rf, sudo,
    // dd, mkfs, chmod -R 777, chown -R via AST structural matching.
    pi.on("tool_call", async (event, ctx) => {
        if (event.toolName !== "bash") return;

        await ensureJustBashLoaded();
        maybeWarnAstUnavailable(ctx);

        const command = String(event.input.command ?? "");
        const danger = detectDangerousCommand(command);
        if (!danger) return;

        const truncatedCmd = command.length > 80
            ? `${command.substring(0, 80)}...`
            : command;

        const proceed = await ctx.ui.confirm(
            "Dangerous Command Detected",
            `This command contains ${danger.kind}${danger.commandName ? ` (${danger.commandName})` : ""}:\n\n${truncatedCmd}\n\nAllow execution?`,
        );

        if (!proceed) {
            return { block: true, reason: "User denied dangerous command" };
        }

        return;
    });
}
