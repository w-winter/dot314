/**
 * Tools Extension
 *
 * Provides a /tools command to enable/disable tools interactively.
 * Tool selection persists:
 * - Globally in ~/.pi/agent/extensions/tools-config.json (across all sessions)
 * - Per-session via session entries (for branch-specific overrides)
 *
 * Usage:
 * 1. Copy this file to ~/.pi/agent/extensions/ or your project's .pi/extensions/
 * 2. Use /tools to open the tool selector
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@mariozechner/pi-coding-agent";
import { getSettingsListTheme } from "@mariozechner/pi-coding-agent";
import { Container, type SettingItem, SettingsList } from "@mariozechner/pi-tui";

// Global config file path
const CONFIG_PATH = join(homedir(), ".pi", "agent", "extensions", "tools-config.json");

// State persisted to session (for branch-specific overrides)
interface ToolsState {
	enabledTools: string[];
}

// Global config structure
interface GlobalToolsConfig {
	enabledTools: string[];
}

export default function toolsExtension(pi: ExtensionAPI) {
	// Track enabled tools
	let enabledTools: Set<string> = new Set();
	let allTools: ToolInfo[] = [];

	// Load global config
	function loadGlobalConfig(): string[] | undefined {
		if (!existsSync(CONFIG_PATH)) return undefined;
		try {
			const content = readFileSync(CONFIG_PATH, "utf-8");
			const config: GlobalToolsConfig = JSON.parse(content);
			return config.enabledTools;
		} catch {
			return undefined;
		}
	}

	// Save global config
	function saveGlobalConfig() {
		const config: GlobalToolsConfig = {
			enabledTools: Array.from(enabledTools),
		};
		try {
			writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
		} catch (err) {
			console.error(`Failed to save tools config: ${err}`);
		}
	}

	// Persist to session (for branch-specific state)
	function persistToSession() {
		pi.appendEntry<ToolsState>("tools-config", {
			enabledTools: Array.from(enabledTools),
		});
	}

	// Persist to both global config and session
	function persistState() {
		saveGlobalConfig();
		persistToSession();
	}

	// Apply current tool selection
	function applyTools() {
		pi.setActiveTools(Array.from(enabledTools));
	}

	// Restore from session branch, falling back to global config
	function restoreFromBranch(ctx: ExtensionContext) {
		allTools = pi.getAllTools();
		const allToolNames = allTools.map((t) => t.name);

		// First, check session branch for saved state
		const branchEntries = ctx.sessionManager.getBranch();
		let savedTools: string[] | undefined;

		for (const entry of branchEntries) {
			if (entry.type === "custom" && entry.customType === "tools-config") {
				const data = entry.data as ToolsState | undefined;
				if (data?.enabledTools) {
					savedTools = data.enabledTools;
				}
			}
		}

		if (savedTools) {
			// Restore from session (filter to only tools that still exist)
			enabledTools = new Set(savedTools.filter((t: string) => allToolNames.includes(t)));
			applyTools();
			return;
		}

		// Fall back to global config
		const globalTools = loadGlobalConfig();
		if (globalTools) {
			enabledTools = new Set(globalTools.filter((t: string) => allToolNames.includes(t)));
			applyTools();
			return;
		}

		// No saved state anywhere - sync with currently active tools
		enabledTools = new Set(pi.getActiveTools());
	}

	// Register /tools command
	pi.registerCommand("tools", {
		description: "Enable/disable tools",
		handler: async (_args, ctx) => {
			// Refresh tool list
			allTools = pi.getAllTools();

			await ctx.ui.custom((tui, theme, _kb, done) => {
				// Build settings items for each tool
				const items: SettingItem[] = allTools.map((tool) => ({
					id: tool.name,
					label: tool.name,
					currentValue: enabledTools.has(tool.name) ? "enabled" : "disabled",
					values: ["enabled", "disabled"],
				}));

				const container = new Container();
				container.addChild(
					new (class {
						render(_width: number) {
							return [theme.fg("accent", theme.bold("Tool Configuration")), ""];
						}
						invalidate() {}
					})(),
				);

				const settingsList = new SettingsList(
					items,
					Math.min(items.length + 2, 15),
					getSettingsListTheme(),
					(id, newValue) => {
						// Update enabled state and apply immediately
						if (newValue === "enabled") {
							enabledTools.add(id);
						} else {
							enabledTools.delete(id);
						}
						applyTools();
						persistState();
					},
					() => {
						// Close dialog
						done(undefined);
					},
				);

				container.addChild(settingsList);

				const component = {
					render(width: number) {
						return container.render(width);
					},
					invalidate() {
						container.invalidate();
					},
					handleInput(data: string) {
						settingsList.handleInput?.(data);
						tui.requestRender();
					},
				};

				return component;
			});
		},
	});

	// Restore state on session start
	pi.on("session_start", async (_event, ctx) => {
		restoreFromBranch(ctx);
	});

	// Restore state when switching sessions (new or resume)
	pi.on("session_switch", async (_event, ctx) => {
		restoreFromBranch(ctx);
	});

	// Restore state when navigating the session tree
	pi.on("session_tree", async (_event, ctx) => {
		restoreFromBranch(ctx);
	});

	// Restore state after forking
	pi.on("session_fork", async (_event, ctx) => {
		restoreFromBranch(ctx);
	});
}
