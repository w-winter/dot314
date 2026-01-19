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
 * - Blocks RepoPrompt write commands (edit/file/file_actions/apply-edits), even via bash rp-cli -e or rp_exec
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

// Read-only tools for plan mode
const PLAN_MODE_TOOLS = ["rp_bind", "rp_exec", "rp-cli", "read", "bash", "grep", "find", "ls"];

// Full set of tools for normal mode
const NORMAL_MODE_TOOLS = ["rp_bind", "rp_exec", "rp-cli", "read", "bash", "grep", "find", "ls", "edit", "write"];

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

function isSafeCommand(command: string): boolean {
	if (DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command))) {
		return false;
	}

	// Prevent using rp-cli via bash to enter interactive REPL while in plan mode
	if (RP_CLI_INTERACTIVE_PATTERN.test(command)) {
		return false;
	}

	// Prevent using rp-cli via bash to perform edits/file actions while in plan mode
	if (RP_CLI_EXEC_WRITE_PATTERN.test(command)) {
		return false;
	}

	// Strict allowlist: only allow commands we explicitly recognize as read-only
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

	// Block write operations in plan mode (bash + RepoPrompt)
	pi.on("tool_call", async (event) => {
		if (!planModeEnabled) return;

		if (event.toolName === "bash") {
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
	- Use \`rp-cli -e 'windows'\` to list windows
	- Bind with \`rp_bind\`, then use \`rp_exec\` for tree/search/read/structure
	- In plan mode, write commands are blocked: \`edit\`, \`file\`, \`file_actions\`, \`call apply-edits\`, \`call file_actions\`

	Do NOT attempt to make changes - just describe what you would do.`,
				display: false,
			},
		};
	});

	// Initialize state on session start
	pi.on("session_start", async (_event, ctx) => {
		const startInPlanMode = pi.getFlag("plan") === true;
		if (startInPlanMode) {
			planModeEnabled = true;
		} else {
			const entries = ctx.sessionManager.getEntries();
			const planModeEntry = entries
				.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "plan-mode")
				.pop() as { data?: { enabled?: boolean } } | undefined;

			if (planModeEntry?.data?.enabled !== undefined) {
				planModeEnabled = planModeEntry.data.enabled;
			}
		}

		applyToolMode();
		updateStatus(ctx);
	});

	// Persist state at start of each turn
	pi.on("turn_start", async () => {
		pi.appendEntry("plan-mode", {
			enabled: planModeEnabled,
		});
	});
}
