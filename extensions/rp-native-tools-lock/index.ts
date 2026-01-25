/**
 * RP Native Tools Lock
 *
 * Disables Pi's native repo-file tools (read/write/edit/ls/find/grep) when RepoPrompt tools are available.
 *
 * Why:
 * - Some models will "reach" for the native tools because they appear first / are more familiar
 * - If RepoPrompt is available, we want to force repo-scoped work through rp (MCP) or rp_exec (CLI)
 *
 * Modes (user-facing):
 * - off     : no enforcement
 * - auto    : enforce via rp if available; else rp_exec if available; else off
 *
 * Advanced modes (set via config file):
 * - rp-mcp  : enforce when the `rp` tool exists
 * - rp-cli  : enforce when the `rp_exec` tool exists
 *
 * Hotkeys:
 * - Alt+L: toggle lock mode (off ↔ auto)
 *
 * Configuration precedence:
 * 1) Session branch override (via /rp-tools-lock)
 * 2) Global config file: ~/.pi/agent/extensions/rp-native-tools-lock/rp-native-tools-lock.json
 * 3) Default: auto
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key, type KeyId } from "@mariozechner/pi-tui";

type Mode = "off" | "auto" | "rp-mcp" | "rp-cli";

interface LockState {
	mode: Mode;
}

const CUSTOM_TYPE = "rp-native-tools-lock";
const CONFIG_PATH = join(homedir(), ".pi", "agent", "extensions", "rp-native-tools-lock", "rp-native-tools-lock.json");

const REQUIRED_TOOL_BY_MODE: Record<Exclude<Mode, "off" | "auto">, string> = {
	"rp-mcp": "rp",
	"rp-cli": "rp_exec",
};

const NATIVE_FILE_TOOLS = ["read", "write", "edit", "ls", "find", "grep"];

const TOGGLE_MODE_HOTKEY: KeyId = Key.alt("l");

// Keep the interactive UX simple: users only toggle off/auto.
// Advanced modes remain supported via the config file.
const MODE_CYCLE_ORDER: Mode[] = ["off", "auto"];

function normalizeMode(raw: string | undefined): Mode | undefined {
	const value = (raw ?? "").trim().toLowerCase();
	if (!value) return undefined;

	if (value === "off" || value === "disabled" || value === "none") return "off";
	if (value === "auto" || value === "aut" || value === "automatic") return "auto";
	if (value === "rp-mcp" || value === "mcp" || value === "rp") return "rp-mcp";
	if (value === "rp-cli" || value === "cli" || value === "rp_exec" || value === "rp-exec") return "rp-cli";

	return undefined;
}

function loadGlobalConfig(): LockState | undefined {
	if (!existsSync(CONFIG_PATH)) return undefined;
	try {
		const content = readFileSync(CONFIG_PATH, "utf-8");
		const parsed = JSON.parse(content) as Partial<LockState> | undefined;
		const mode = normalizeMode(parsed?.mode);
		return mode ? { mode } : undefined;
	} catch {
		return undefined;
	}
}

function saveGlobalConfig(state: LockState): void {
	try {
		const configDir = dirname(CONFIG_PATH);
		if (!existsSync(configDir)) {
			mkdirSync(configDir, { recursive: true });
		}
		writeFileSync(CONFIG_PATH, JSON.stringify(state, null, 2));
	} catch (err) {
		console.error(`Failed to save ${CONFIG_PATH}: ${err}`);
	}
}

function restoreFromBranch(ctx: ExtensionContext, fallback: LockState): LockState {
	const branchEntries = ctx.sessionManager.getBranch();
	let restored: LockState | undefined;

	for (const entry of branchEntries) {
		if (entry.type === "custom" && entry.customType === CUSTOM_TYPE) {
			const data = entry.data as Partial<LockState> | undefined;
			const mode = normalizeMode(data?.mode);
			if (mode) restored = { mode };
		}
	}

	return restored ?? fallback;
}

function setStatus(ctx: ExtensionContext, text: string | undefined): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus("rp-tools-lock", text);
}

type EffectiveMode = Exclude<Mode, "auto">;

function computeEffectiveMode(
	allToolNames: Set<string>,
	activeToolNames: Set<string>,
	requestedMode: Mode,
): { effectiveMode: EffectiveMode; requiredTool: string | undefined } {
	if (requestedMode === "off") return { effectiveMode: "off", requiredTool: undefined };

	if (requestedMode === "auto") {
		// In auto mode, respect the user's tool configuration.
		// We only prefer a RepoPrompt entrypoint if the user has enabled it.
		if (activeToolNames.has("rp")) return { effectiveMode: "rp-mcp", requiredTool: "rp" };
		if (activeToolNames.has("rp_exec")) return { effectiveMode: "rp-cli", requiredTool: "rp_exec" };
		return { effectiveMode: "off", requiredTool: undefined };
	}

	// Advanced/maintainer modes: enforce based on tool availability (even if currently disabled)
	return {
		effectiveMode: requestedMode,
		requiredTool: REQUIRED_TOOL_BY_MODE[requestedMode],
	};
}

function buildStatusText(effectiveMode: EffectiveMode): string | undefined {
	if (effectiveMode === "rp-mcp" || effectiveMode === "rp-cli") {
		return "RP 🔒";
	}
	return undefined;
}

function enforceMode(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	requestedMode: Mode,
): { enforced: boolean; reason?: string; effectiveMode: EffectiveMode; requiredTool?: string } {
	const allToolNames = new Set(pi.getAllTools().map((t) => t.name));
	const activeToolNames = new Set(pi.getActiveTools());
	const { effectiveMode, requiredTool } = computeEffectiveMode(allToolNames, activeToolNames, requestedMode);

	if (effectiveMode === "off") {
		setStatus(ctx, undefined);
		return {
			enforced: false,
			reason: requestedMode === "auto" ? "auto:no-rp-tools" : "mode=off",
			effectiveMode,
		};
	}

	if (!requiredTool || !allToolNames.has(requiredTool)) {
		setStatus(ctx, undefined);
		return {
			enforced: false,
			reason: `missing:${requiredTool ?? "unknown"}`,
			effectiveMode,
		};
	}

	const active = pi.getActiveTools();
	const blocked = new Set(NATIVE_FILE_TOOLS.filter((t) => allToolNames.has(t)));
	const next = active.filter((t) => !blocked.has(t));

	// Ensure the required RepoPrompt tool stays available
	if (!next.includes(requiredTool)) next.push(requiredTool);


	// Only apply when changed
	const activeSet = new Set(active);
	const nextSet = new Set(next);
	const changed =
		active.length !== next.length ||
		active.some((t) => !nextSet.has(t)) ||
		next.some((t) => !activeSet.has(t));

	if (changed) {
		pi.setActiveTools(next);
	}

	setStatus(ctx, buildStatusText(effectiveMode));
	return { enforced: true, effectiveMode, requiredTool };
}

export default function rpNativeToolsLock(pi: ExtensionAPI): void {
	let state: LockState = { mode: "auto" };

	function resolveState(ctx: ExtensionContext): LockState {
		const globalConfig = loadGlobalConfig();
		const fallback = globalConfig ?? { mode: "auto" };
		return restoreFromBranch(ctx, fallback);
	}

	function apply(ctx: ExtensionContext): void {
		state = resolveState(ctx);
		enforceMode(pi, ctx, state.mode);
	}

	function persistState(nextState: LockState): void {
		// Persist globally + in-session branch
		saveGlobalConfig(nextState);
		pi.appendEntry<LockState>(CUSTOM_TYPE, nextState);
	}

	function setMode(
		ctx: ExtensionContext,
		mode: Mode,
	): { enforced: boolean; reason?: string; effectiveMode: EffectiveMode; requiredTool?: string } {
		state = { mode };
		persistState(state);
		return enforceMode(pi, ctx, state.mode);
	}

	function notifyEnforcement(
		ctx: ExtensionContext,
		requestedMode: Mode,
		enforced: { enforced: boolean; reason?: string; effectiveMode: EffectiveMode },
	): void {
		if (!ctx.hasUI) return;

		if (requestedMode === "off") {
			ctx.ui.notify("rp-tools-lock: off", "info");
			return;
		}

		if (enforced.enforced) {
			// Keep user-facing messaging simple. Advanced detail in config.
			if (requestedMode === "auto") {
				ctx.ui.notify("rp-tools-lock: auto (native file tools disabled)", "info");
				return;
			}

			ctx.ui.notify(`rp-tools-lock: ${requestedMode} (native file tools disabled)`, "info");
			return;
		}

		if (requestedMode === "auto" && enforced.effectiveMode === "off") {
			ctx.ui.notify("rp-tools-lock: auto (no rp/rp_exec tools available)", "info");
			return;
		}

		ctx.ui.notify(`rp-tools-lock: ${requestedMode} (not enforced: ${enforced.reason ?? "unknown"})`, "warning");
	}

	function getNextMode(currentMode: Mode): Mode {
		const index = MODE_CYCLE_ORDER.indexOf(currentMode);
		const safeIndex = index >= 0 ? index : 0;
		return MODE_CYCLE_ORDER[(safeIndex + 1) % MODE_CYCLE_ORDER.length];
	}

	pi.registerCommand("rp-tools-lock", {
		description:
			"RepoPrompt-first tooling: off | auto (disables read/write/edit/ls/find/grep). Advanced modes are available via config file.",
		handler: async (args, ctx) => {
			const raw = args?.trim();

			const ALLOWED_MODES: Mode[] = ["off", "auto"];

			// No args → interactive selector (if UI available)
			if (!raw) {
				if (!ctx.hasUI) {
					console.error("Usage: /rp-tools-lock <off|auto>");
					return;
				}

				const choice = await ctx.ui.select("RepoPrompt tool policy", ALLOWED_MODES);
				if (!choice) return;
				state = { mode: choice as Mode };
			} else {
				const mode = normalizeMode(raw);
				if (!mode || !ALLOWED_MODES.includes(mode)) {
					const message =
						`Usage: /rp-tools-lock <off|auto> (got: ${raw})\n` +
						"Advanced modes (rp-mcp/rp-cli) can be set via: " +
						"~/.pi/agent/extensions/rp-native-tools-lock/rp-native-tools-lock.json";

					if (ctx.hasUI) {
						ctx.ui.notify(message, "error");
					} else {
						console.error(message);
					}
					return;
				}

				state = { mode };
			}

			persistState(state);

			const enforced = enforceMode(pi, ctx, state.mode);
			notifyEnforcement(ctx, state.mode, enforced);
		},
	});

	pi.registerShortcut(TOGGLE_MODE_HOTKEY, {
		description: "Toggle rp-tools-lock mode (off ↔ auto)",
		handler: async (ctx) => {
			const current = resolveState(ctx).mode;
			const next = getNextMode(current);
			const enforced = setMode(ctx, next);
			notifyEnforcement(ctx, next, enforced);
		},
	});

	// Apply early and often (covers /tools toggles, session navigation, etc.)
	pi.on("session_start", async (_event, ctx) => apply(ctx));
	pi.on("session_switch", async (_event, ctx) => apply(ctx));
	pi.on("session_tree", async (_event, ctx) => apply(ctx));
	pi.on("session_fork", async (_event, ctx) => apply(ctx));

	// Enforce right when the user submits a prompt (before the agent starts)
	pi.on("input", async (_event, ctx) => apply(ctx));

	// Safety backstop: even if a tool somehow remains active, block the call with a clear reason
	pi.on("tool_call", async (event, ctx) => {
		state = resolveState(ctx);

		const allToolNames = new Set(pi.getAllTools().map((t) => t.name));
		const activeToolNames = new Set(pi.getActiveTools());
		const { effectiveMode, requiredTool } = computeEffectiveMode(allToolNames, activeToolNames, state.mode);
		if (effectiveMode === "off" || !requiredTool) return;
		if (!allToolNames.has(requiredTool)) return;

		if (!NATIVE_FILE_TOOLS.includes(event.toolName)) return;

		const suffix = state.mode === "auto" ? ` → ${effectiveMode}` : "";
		return {
			block: true,
			reason:
				`rp-tools-lock (${state.mode}${suffix}): native tool "${event.toolName}" is disabled. ` +
				`Use RepoPrompt instead (tool: ${requiredTool}). ` +
				`You can disable this lock with /rp-tools-lock off.`,
		};
	});
}
