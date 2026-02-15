/**
 * Plan Mode Extension
 *
 * Provides a Claude Code-style "plan mode" read-only sandbox for safe code exploration.
 * When enabled, the agent can only use read-only tools and cannot modify files.
 *
 * Features:
 * - /plan command (and Ctrl+Alt/Option+P shortcut) to toggle plan mode
 * - --plan flag to start in plan mode
 * - Restricts available tools to a read-only allowlist (no edit/write tools)
 * - Blocks destructive bash commands while plan mode is enabled (including redirects)
 * - Blocks RepoPrompt write commands (edit/file/file_actions/apply-edits), even via bash rp-cli -e, rp_exec, or rp (repoprompt-mcp)
 * - Blocks rp-cli interactive REPL (-i/--interactive) to prevent bypassing the sandbox
 * - Injects a [PLAN MODE ACTIVE] context message when enabled, and a [PLAN MODE DISABLED] message after exiting
 * - Shows a "plan" indicator in the status line when active
 * - Persists plan mode state across turns via a session entry
 *
 * Usage:
 * 1. Copy this file to ~/.pi/agent/extensions/ or your project's .pi/extensions/
 * 2. Use /plan (or the ctrl+opt+P / ctrl+alt+P hotkey) to toggle plan mode on/off
 * 3. Or start in plan mode with --plan
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";

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
function maybeWarnAstUnavailable(ctx: ExtensionContext): void {
	if (warnedAstUnavailable) return;
	if (parseBash) return;
	if (!ctx.hasUI) return;

	warnedAstUnavailable = true;
	ctx.ui.notify(
		"plan-mode: bash AST parser unavailable; falling back to best-effort regex command checks",
		"warning",
	);
}

type BashInvocation = {
	commandNameRaw: string;
	commandName: string;
	effectiveCommandName: string;
	effectiveArgs: string[];
	hasWriteRedirection: boolean;
};

const WRAPPER_COMMANDS = new Set(["command", "builtin", "exec", "nohup"]);
const WRITE_REDIRECTION_OPERATORS = new Set([">", ">>", ">|", "<>", "&>", "&>>", ">&"]);

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

function resolveEffectiveCommand(commandNameRaw: string, args: string[]): {
	effectiveCommandName: string;
	effectiveArgs: string[];
} {
	const primary = commandNameRaw.trim();
	const primaryBase = commandBaseName(primary);

	if (WRAPPER_COMMANDS.has(primaryBase)) {
		const next = args[0] ?? "";
		return {
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
			effectiveCommandName: commandBaseName(next),
			effectiveArgs: args.slice(idx + 1),
		};
	}

	return {
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

function analyzeBashScript(command: string): { parseError?: string; invocations: BashInvocation[] } {
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

				for (const pipeline of statement.pipelines) {
					if (!pipeline || typeof pipeline !== "object" || !Array.isArray(pipeline.commands)) continue;

					for (const commandNode of pipeline.commands) {
						if (!commandNode || typeof commandNode !== "object") continue;

						if (commandNode.type === "SimpleCommand") {
							const commandNameRaw = wordToText(commandNode.name).trim();
							const commandName = commandBaseName(commandNameRaw);
							const args = Array.isArray(commandNode.args)
								? commandNode.args.map((arg: any) => wordToText(arg)).filter(Boolean)
								: [];
							const redirections = Array.isArray(commandNode.redirections)
								? commandNode.redirections.map((r: any) => typeof r?.operator === "string" ? r.operator : "")
								: [];
							const effective = resolveEffectiveCommand(commandNameRaw, args);

							invocations.push({
								commandNameRaw,
								commandName,
								effectiveCommandName: effective.effectiveCommandName,
								effectiveArgs: effective.effectiveArgs,
								hasWriteRedirection: redirections.some((op) => WRITE_REDIRECTION_OPERATORS.has(op)),
							});

							if (commandNode.name) collectNestedScriptsFromWord(commandNode.name, visitScript);
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

// Read-only tools for plan mode
//
// Note: `rp` is provided by the repoprompt-mcp extension and can proxy many RepoPrompt tools.
// In plan mode, we still allow the `rp` tool but block write-capable calls (apply_edits/file_actions)
const PLAN_MODE_TOOLS = ["rp", "rp_bind", "rp_exec", "rp-cli", "read", "bash", "grep", "find", "ls"];

// Full set of tools for normal mode
const NORMAL_MODE_TOOLS = ["rp", "rp_bind", "rp_exec", "rp-cli", "read", "bash", "grep", "find", "ls", "edit", "write"];

// Patterns for destructive bash commands that should be blocked in plan mode
const DESTRUCTIVE_PATTERNS = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	/[^<]>(?![>&])/, // redirect stdout to a file
	/>>/, // append redirect
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
	/\bbrew\s+(install|uninstall|upgrade)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout\s+-b|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)/i,
	/\bservice\s+\S+\s+(start|stop|restart)/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
];

// Read-only commands that are always safe
const SAFE_COMMANDS = [
	/^\s*cat\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*less\b/,
	/^\s*more\b/,
	/^\s*grep\b/,
	/^\s*find\b/,
	/^\s*ls\b/,
	/^\s*pwd\b/,
	/^\s*echo\b/,
	/^\s*printf\b/,
	/^\s*wc\b/,
	/^\s*sort\b/,
	/^\s*uniq\b/,
	/^\s*diff\b/,
	/^\s*file\b/,
	/^\s*stat\b/,
	/^\s*du\b/,
	/^\s*df\b/,
	/^\s*tree\b/,
	/^\s*which\b/,
	/^\s*whereis\b/,
	/^\s*type\b/,
	/^\s*env\b/,
	/^\s*printenv\b/,
	/^\s*uname\b/,
	/^\s*whoami\b/,
	/^\s*id\b/,
	/^\s*date\b/,
	/^\s*cal\b/,
	/^\s*uptime\b/,
	/^\s*ps\b/,
	/^\s*top\b/,
	/^\s*htop\b/,
	/^\s*free\b/,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
	/^\s*git\s+ls-/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
	/^\s*yarn\s+(list|info|why|audit)/i,
	/^\s*node\s+--version/i,
	/^\s*python\s+--version/i,
	/^\s*curl\s/i,
	/^\s*wget\s+-O\s*-/i,
	/^\s*jq\b/,
	/^\s*sed\s+-n/i,
	/^\s*awk\b/,
	/^\s*rg\b/,
	/^\s*fd\b/,
	/^\s*bat\b/,
	/^\s*exa\b/,
	/^\s*rp-cli\b/,
	/^\s*rp_exec\b/,
	/^\s*rp_bind\b/,
];

const REPROMPT_WRITE_PATTERNS = [
	/(^|&&\s*)\s*edit\b/i,
	/(^|&&\s*)\s*file\s+(create|delete|move)\b/i,
	/(^|&&\s*)\s*file_actions\b/i,
	/(^|&&\s*)\s*call\s+(apply-edits|file_actions)\b/i,
];

const RP_CLI_INTERACTIVE_PATTERN =
	/(^|\s)rp-cli\b.*(?:\s)(?:-i|--interactive)(?:\s|$)/i;

const RP_CLI_EXEC_WRITE_PATTERN =
	/(^|\s)rp-cli\b.*(?:\s)(?:-e|--exec)(?:\s*)[\s\S]*\b(edit|file_actions|file\s+(create|delete|move)|call\s+(apply-edits|file_actions))\b/i;

function isRepoPromptWriteCommand(command: string): boolean {
	return REPROMPT_WRITE_PATTERNS.some((pattern) => pattern.test(command));
}

function isRepoPromptMcpWriteRequest(input: unknown): boolean {
	if (input === null || typeof input !== "object") {
		return false;
	}

	const request = input as { call?: unknown };
	const call = request.call;
	if (typeof call !== "string") {
		return false;
	}

	// `rp` (repoprompt-mcp) proxies RepoPrompt MCP tools. Treat these as write-capable.
	// Be tolerant of tool name prefixing, e.g. RepoPrompt_apply_edits
	const normalizedCall = call.trim();
	return /(^|_)(apply[-_]edits)$/.test(normalizedCall) || /(^|_)(file_actions)$/.test(normalizedCall);
}

const AST_READ_ONLY_COMMANDS = new Set([
	"cat", "head", "tail", "less", "more", "grep", "find", "ls", "pwd", "echo", "printf", "wc", "sort", "uniq",
	"diff", "file", "stat", "du", "df", "tree", "which", "whereis", "type", "env", "printenv", "uname", "whoami",
	"id", "date", "cal", "uptime", "ps", "top", "htop", "free", "jq", "awk", "rg", "fd", "bat", "exa", "rp-cli",
	"rp_exec", "rp_bind", "curl",
]);

const AST_BLOCKED_COMMANDS = new Set([
	"rm", "rmdir", "mv", "cp", "mkdir", "touch", "chmod", "chown", "chgrp", "ln", "tee", "truncate", "dd", "shred",
	"sudo", "su", "kill", "pkill", "killall", "reboot", "shutdown", "systemctl", "service", "vim", "vi", "nano", "emacs",
	"code", "subl", "apt", "apt-get", "brew", "pip",
]);

const ALLOWED_GIT_SUBCOMMANDS = new Set(["status", "log", "diff", "show", "branch", "remote", "config", "ls-files", "ls-tree", "ls-remote"]);
const ALLOWED_NPM_SUBCOMMANDS = new Set(["list", "ls", "view", "info", "search", "outdated", "audit"]);
const ALLOWED_YARN_SUBCOMMANDS = new Set(["list", "info", "why", "audit"]);
const ALLOWED_PNPM_SUBCOMMANDS = new Set(["list", "ls", "view", "info", "search", "outdated", "audit"]);

function isInvocationReadOnly(invocation: { effectiveCommandName: string; effectiveArgs: string[]; commandName: string; commandNameRaw: string }): boolean {
	const commandName = invocation.effectiveCommandName || invocation.commandName;
	const args = invocation.effectiveArgs;

	if (!commandName) {
		return true;
	}

	if (AST_BLOCKED_COMMANDS.has(commandName)) {
		return false;
	}

	if (commandName === "git") {
		const sub = (args[0] ?? "").toLowerCase();
		if (!sub) return true;
		if (sub === "config") {
			return args[1] === "--get";
		}
		return ALLOWED_GIT_SUBCOMMANDS.has(sub) || sub.startsWith("ls-");
	}

	if (commandName === "npm") {
		const sub = (args[0] ?? "").toLowerCase();
		return !sub || ALLOWED_NPM_SUBCOMMANDS.has(sub);
	}

	if (commandName === "yarn") {
		const sub = (args[0] ?? "").toLowerCase();
		return !sub || ALLOWED_YARN_SUBCOMMANDS.has(sub);
	}

	if (commandName === "pnpm") {
		const sub = (args[0] ?? "").toLowerCase();
		return !sub || ALLOWED_PNPM_SUBCOMMANDS.has(sub);
	}

	if (commandName === "node" || commandName === "python" || commandName === "python3") {
		return args.length > 0 && args.every((arg) => arg === "--version");
	}

	if (commandName === "wget") {
		for (let i = 0; i < args.length; i += 1) {
			if (args[i] === "-O") {
				return args[i + 1] === "-";
			}
		}
		return false;
	}

	if (commandName === "sed") {
		return args.includes("-n");
	}

	return AST_READ_ONLY_COMMANDS.has(commandName);
}

function isSafeCommand(command: string): boolean {
	// Prevent using rp-cli via bash to enter interactive REPL while in plan mode
	if (RP_CLI_INTERACTIVE_PATTERN.test(command)) {
		return false;
	}

	// Prevent using rp-cli via bash to perform edits/file actions while in plan mode
	if (RP_CLI_EXEC_WRITE_PATTERN.test(command)) {
		return false;
	}

	const analysis = analyzeBashScript(command);
	if (!analysis.parseError) {
		if (analysis.invocations.some((invocation) => invocation.hasWriteRedirection)) {
			return false;
		}

		return analysis.invocations.every((invocation) => isInvocationReadOnly(invocation));
	}

	// Fallback: original regex policy if parsing fails
	if (DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command))) {
		return false;
	}

	return SAFE_COMMANDS.some((pattern) => pattern.test(command));
}

export default function planModeExtension(pi: ExtensionAPI) {
	let planModeEnabled = false;
	let justExitedPlanMode = false;

	// Register --plan CLI flag
	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only exploration)",
		type: "boolean",
		default: false,
	});

	function applyToolMode(): void {
		pi.setActiveTools(planModeEnabled ? PLAN_MODE_TOOLS : NORMAL_MODE_TOOLS);
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;

		if (planModeEnabled) {
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "⏸ plan"));
		} else {
			ctx.ui.setStatus("plan-mode", undefined);
		}

		// Backward-compat cleanup: older versions used a widget for todo display
		ctx.ui.setWidget("plan-todos", undefined);
	}

	function togglePlanMode(ctx: ExtensionContext): void {
		const wasEnabled = planModeEnabled;
		planModeEnabled = !planModeEnabled;
		applyToolMode();

		// Persist immediately so /tree navigation restores the correct branch-specific state even before the next turn
		persistPlanModeState();

		if (ctx.hasUI) {
			if (planModeEnabled) {
				ctx.ui.notify(`Plan mode enabled. Tools: ${PLAN_MODE_TOOLS.join(", ")}`);
			} else {
				ctx.ui.notify("Plan mode disabled. Full access restored.");
			}
		}

		// Track that we just exited plan mode so the next turn can inject an exit message
		if (wasEnabled && !planModeEnabled) {
			justExitedPlanMode = true;
		}

		updateStatus(ctx);
	}

	// Register /plan command
	pi.registerCommand("plan", {
		description: "Toggle plan mode (read-only exploration)",
		handler: async (_args, ctx) => {
			togglePlanMode(ctx);
		},
	});

	// Register Ctrl+Option+P shortcut
	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: async (ctx) => {
			togglePlanMode(ctx);
		},
	});

	// Block write operations in plan mode (bash + RepoPrompt + native file tools as a backstop)
	pi.on("tool_call", async (event, ctx) => {
		if (!planModeEnabled) return;

		// Backstop: even if another extension (e.g. /tools) re-enables these, plan mode must remain read-only
		if (event.toolName === "edit" || event.toolName === "write") {
			return {
				block: true,
				reason: `Plan mode: native tool "${event.toolName}" is blocked. Use /plan to disable plan mode first.`,
			};
		}

		if (event.toolName === "bash") {
			await ensureJustBashLoaded();
			maybeWarnAstUnavailable(ctx);
			const command = event.input.command as string;
			if (!isSafeCommand(command)) {
				return {
					block: true,
					reason: `Plan mode: command blocked. Use /plan to disable plan mode first.\nCommand: ${command}`,
				};
			}
			return;
		}

		if (event.toolName === "rp_exec" || event.toolName === "rp-cli") {
			const input = event.input as { cmd?: unknown; command?: unknown };
			const command = (input.cmd ?? input.command) as string | undefined;
			if (typeof command !== "string") return;

			if (isRepoPromptWriteCommand(command)) {
				return {
					block: true,
					reason: `Plan mode: RepoPrompt write command blocked. Use /plan to disable plan mode first.\nCommand: ${command}`,
				};
			}
		}

		if (event.toolName === "rp") {
			if (isRepoPromptMcpWriteRequest(event.input)) {
				const call = (event.input as { call?: unknown } | undefined)?.call;
				return {
					block: true,
					reason: `Plan mode: RepoPrompt write tool blocked. Use /plan to disable plan mode first.\nTool: rp(call=${String(call)})`,
				};
			}
		}
	});

	// Re-apply tool restrictions right before the agent starts, in case other extensions mutate tool state
	pi.on("input", async (_event, ctx) => {
		if (!planModeEnabled) return;
		applyToolMode();
		updateStatus(ctx);
	});

	// Filter out stale plan mode context messages from LLM context
	// This ensures the agent only sees the CURRENT state (plan mode on/off)
	pi.on("context", async (event) => {
		const filtered = event.messages.filter((m) => {
			if (m.role === "user" && Array.isArray(m.content)) {
				// When plan mode is OFF, filter out old "ACTIVE" messages
				if (!planModeEnabled) {
					const hasActiveMsg = m.content.some((c) => c.type === "text" && c.text.includes("[PLAN MODE ACTIVE]"));
					if (hasActiveMsg) {
						return false;
					}
				}
				// When plan mode is ON, filter out old "DISABLED" messages
				if (planModeEnabled) {
					const hasExitMsg = m.content.some((c) => c.type === "text" && c.text.includes("[PLAN MODE DISABLED]"));
					if (hasExitMsg) {
						return false;
					}
				}
			}
			return true;
		});

		return { messages: filtered };
	});

	// Inject plan mode context (or exit message if just exited)
	pi.on("before_agent_start", async () => {
		// If we just exited plan mode, inject an exit message so the agent knows restrictions are lifted
		if (justExitedPlanMode) {
			justExitedPlanMode = false;
			return {
				message: {
					customType: "plan-mode-exit",
					content: `[PLAN MODE DISABLED]
You have exited plan mode. Full tool access is now restored.
You now have write access again. Previous plan mode restrictions no longer apply.`,
					display: false,
				},
			};
		}

		if (!planModeEnabled) {
			return;
		}

		return {
			message: {
				customType: "plan-mode-context",
				content: `[PLAN MODE ACTIVE]
	You are in plan mode - a read-only exploration mode for safe code analysis.

	Restrictions:
	- Do not attempt to modify files
	- Only use the allowed read-only tools (as provided by the environment)
	- Bash is restricted to read-only commands (unsafe commands will be blocked)
	- rp-cli interactive REPL (-i) is blocked

	Prefer RepoPrompt tools when available:
	- If repoprompt-mcp is available, use the \`rp\` tool for RepoPrompt MCP calls (e.g. \`rp({ windows: true })\`, \`rp({ bind: { window: 1 } })\`, \`rp({ call: "read_file", args: { ... } })\`)
	- Otherwise: use \`rp-cli -e 'windows'\` to list windows; bind with \`rp_bind\`; use \`rp_exec\` for tree/search/read/structure
	- In plan mode, RepoPrompt write operations are blocked (including via \`rp\`): \`apply_edits\` and \`file_actions\` (and rp-cli/rp_exec equivalents)

	Do NOT attempt to make changes - just describe what you would do.`,
				display: false,
			},
		};
	});

	function persistPlanModeState(): void {
		pi.appendEntry("plan-mode", {
			enabled: planModeEnabled,
		});
	}

	function restorePlanModeFromBranch(
		ctx: ExtensionContext,
		options?: { preferStartFlag?: boolean },
	): void {
		justExitedPlanMode = false;

		// Optionally force plan mode on at startup
		if (options?.preferStartFlag && pi.getFlag("plan") === true) {
			planModeEnabled = true;
			// Persist once so /tree navigation remains branch-consistent even before the first turn starts
			persistPlanModeState();
			return;
		}

		planModeEnabled = false;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== "plan-mode") {
				continue;
			}

			const data = entry.data as { enabled?: unknown } | undefined;
			if (typeof data?.enabled === "boolean") {
				planModeEnabled = data.enabled;
			}
		}
	}

	function applyRestoredState(ctx: ExtensionContext): void {
		applyToolMode();
		updateStatus(ctx);
	}

	// Initialize state on session start
	pi.on("session_start", async (_event, ctx) => {
		restorePlanModeFromBranch(ctx, { preferStartFlag: true });
		applyRestoredState(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		restorePlanModeFromBranch(ctx);
		applyRestoredState(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		restorePlanModeFromBranch(ctx);
		applyRestoredState(ctx);
	});

	pi.on("session_fork", async (_event, ctx) => {
		restorePlanModeFromBranch(ctx);
		applyRestoredState(ctx);
	});

	// Persist state at start of each turn
	pi.on("turn_start", async () => {
		persistPlanModeState();
	});
}
