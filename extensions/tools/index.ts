/**
 * Tools Extension
 *
 * Provides a /tools command to enable/disable tools interactively.
 * Tool selection persists:
 * - Globally in $PI_CODING_AGENT_DIR/extensions/tools/tools.json or ~/.pi/agent/extensions/tools/tools.json
 * - Per-session via session entries (for branch-specific overrides)
 *
 * Usage:
 * 1. Copy this folder (`tools/`) to ~/.pi/agent/extensions/ or your project's .pi/extensions/
 * 2. Use /tools to open the tool selector
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@mariozechner/pi-coding-agent";
import { getSettingsListTheme } from "@mariozechner/pi-coding-agent";
import { Container, type SettingItem, SettingsList } from "@mariozechner/pi-tui";

type ToolOverride = "enabled" | "disabled";

type ToolsConfigV2 = {
	version: 2;
	overrides: Record<string, ToolOverride>;
};

type ToolsConfigEntryLike = {
	type?: unknown;
	customType?: unknown;
	data?: unknown;
};

const TOOLS_CONFIG_TYPE = "tools-config";
const EMPTY_TOOLS_CONFIG: ToolsConfigV2 = { version: 2, overrides: {} };

function getConfigPath(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	return join(agentDir, "extensions", "tools", "tools.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getToolNames(allTools: readonly ToolInfo[]): string[] {
	return allTools.map((tool) => tool.name);
}

function serializeOverrides(overrides: ReadonlyMap<string, ToolOverride>): Record<string, ToolOverride> {
	return Object.fromEntries([...overrides.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function toPersistedState(
	overrides: ReadonlyMap<string, ToolOverride>,
	availableTools: ReadonlySet<string>,
): ToolsConfigV2 {
	return {
		version: 2,
		overrides: serializeOverrides(
			new Map([...overrides.entries()].filter(([toolName]) => availableTools.has(toolName))),
		),
	};
}

function overridesToMap(config: ToolsConfigV2): Map<string, ToolOverride> {
	return new Map(Object.entries(config.overrides));
}

function updateToolOverride(
	toolName: string,
	desiredEnabled: boolean,
	baseActiveTools: ReadonlySet<string>,
	overrides: Map<string, ToolOverride>,
): void {
	const baseEnabled = baseActiveTools.has(toolName);
	if (desiredEnabled === baseEnabled) {
		overrides.delete(toolName);
		return;
	}

	overrides.set(toolName, desiredEnabled ? "enabled" : "disabled");
}

function normalizePersistedState(
	value: unknown,
	baseActiveTools: ReadonlySet<string>,
	availableTools: ReadonlySet<string>,
): ToolsConfigV2 | undefined {
	if (!isRecord(value)) return undefined;

	if (value.version === 2) {
		if (!isRecord(value.overrides)) return undefined;

		const overrides: Record<string, ToolOverride> = {};
		for (const [toolName, state] of Object.entries(value.overrides)) {
			if (state !== "enabled" && state !== "disabled") {
				return undefined;
			}
			if (availableTools.has(toolName)) {
				overrides[toolName] = state;
			}
		}

		return { version: 2, overrides };
	}

	if (!Array.isArray(value.enabledTools) || value.enabledTools.some((toolName) => typeof toolName !== "string")) {
		return undefined;
	}

	const overrides: Record<string, ToolOverride> = {};
	for (const toolName of value.enabledTools) {
		if (availableTools.has(toolName) && !baseActiveTools.has(toolName)) {
			overrides[toolName] = "enabled";
		}
	}

	return { version: 2, overrides };
}

function stripPreviouslyAppliedOverrides(
	currentActiveTools: ReadonlySet<string>,
	overrides: ReadonlyMap<string, ToolOverride>,
	availableTools: ReadonlySet<string>,
): Set<string> {
	const baseActiveTools = new Set([...currentActiveTools].filter((toolName) => availableTools.has(toolName)));

	for (const [toolName, state] of overrides.entries()) {
		if (!availableTools.has(toolName)) continue;
		if (state === "enabled") {
			baseActiveTools.delete(toolName);
			continue;
		}
		baseActiveTools.add(toolName);
	}

	return baseActiveTools;
}

function applyOverrides(
	baseActiveTools: ReadonlySet<string>,
	overrides: ReadonlyMap<string, ToolOverride>,
	allTools: readonly ToolInfo[],
): string[] {
	const toolNames = getToolNames(allTools);
	const availableTools = new Set(toolNames);
	const effectiveTools = new Set([...baseActiveTools].filter((toolName) => availableTools.has(toolName)));

	for (const [toolName, state] of overrides.entries()) {
		if (!availableTools.has(toolName)) continue;
		if (state === "enabled") {
			effectiveTools.add(toolName);
			continue;
		}
		effectiveTools.delete(toolName);
	}

	return toolNames.filter((toolName) => effectiveTools.has(toolName));
}

function sameToolMembership(left: readonly string[], right: Iterable<string>): boolean {
	const leftSet = new Set(left);
	const rightSet = new Set(right);

	if (leftSet.size !== rightSet.size) return false;
	for (const toolName of leftSet) {
		if (!rightSet.has(toolName)) return false;
	}
	return true;
}

function loadGlobalConfig(
	baseActiveTools: ReadonlySet<string>,
	availableTools: ReadonlySet<string>,
): ToolsConfigV2 | undefined {
	const configPath = getConfigPath();
	if (!existsSync(configPath)) return undefined;

	try {
		const content = readFileSync(configPath, "utf-8");
		return normalizePersistedState(JSON.parse(content), baseActiveTools, availableTools);
	} catch {
		return undefined;
	}
}

function readLatestBranchConfig(
	ctx: ExtensionContext,
	baseActiveTools: ReadonlySet<string>,
	availableTools: ReadonlySet<string>,
): ToolsConfigV2 | undefined {
	let latestValidConfig: ToolsConfigV2 | undefined;

	for (const entry of ctx.sessionManager.getBranch()) {
		const candidate = entry as ToolsConfigEntryLike;
		if (candidate.type !== "custom" || candidate.customType !== TOOLS_CONFIG_TYPE) continue;

		const normalized = normalizePersistedState(candidate.data, baseActiveTools, availableTools);
		if (normalized) {
			latestValidConfig = normalized;
		}
	}

	return latestValidConfig;
}

export default function toolsExtension(pi: ExtensionAPI) {
	let allTools: ToolInfo[] = [];
	let toolOverrides = new Map<string, ToolOverride>();

	function getAvailableToolSet(): Set<string> {
		return new Set(getToolNames(allTools));
	}

	function saveGlobalConfig() {
		const configPath = getConfigPath();
		const config = toPersistedState(toolOverrides, getAvailableToolSet());

		try {
			const configDir = dirname(configPath);
			if (!existsSync(configDir)) {
				mkdirSync(configDir, { recursive: true });
			}
			writeFileSync(configPath, JSON.stringify(config, null, 2));
		} catch (err) {
			console.error(`Failed to save tools config: ${err}`);
		}
	}

	function persistToSession() {
		pi.appendEntry<ToolsConfigV2>(TOOLS_CONFIG_TYPE, toPersistedState(toolOverrides, getAvailableToolSet()));
	}

	function persistState() {
		saveGlobalConfig();
		persistToSession();
	}

	function restoreFromBranch(ctx: ExtensionContext) {
		allTools = pi.getAllTools();
		const availableTools = getAvailableToolSet();
		const currentActiveTools = new Set(pi.getActiveTools());
		const baseActiveTools = stripPreviouslyAppliedOverrides(currentActiveTools, toolOverrides, availableTools);
		const persistedConfig =
			readLatestBranchConfig(ctx, baseActiveTools, availableTools) ??
			loadGlobalConfig(baseActiveTools, availableTools) ??
			EMPTY_TOOLS_CONFIG;

		toolOverrides = overridesToMap(persistedConfig);
		const desiredTools = applyOverrides(baseActiveTools, toolOverrides, allTools);

		if (!sameToolMembership(desiredTools, currentActiveTools)) {
			pi.setActiveTools(desiredTools);
		}
	}

	pi.registerCommand("tools", {
		description: "Enable/disable tools",
		handler: async (_args, ctx) => {
			allTools = pi.getAllTools();
			const availableTools = getAvailableToolSet();
			const baseActiveTools = stripPreviouslyAppliedOverrides(
				new Set(pi.getActiveTools()),
				toolOverrides,
				availableTools,
			);
			const initialEffectiveTools = new Set(applyOverrides(baseActiveTools, toolOverrides, allTools));

			await ctx.ui.custom((tui, theme, _kb, done) => {
				const items: SettingItem[] = allTools.map((tool) => ({
					id: tool.name,
					label: tool.name,
					currentValue: initialEffectiveTools.has(tool.name) ? "enabled" : "disabled",
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
						const desiredEnabled = newValue === "enabled";
						updateToolOverride(id, desiredEnabled, baseActiveTools, toolOverrides);

						const desiredTools = applyOverrides(baseActiveTools, toolOverrides, allTools);
						const currentActiveTools = new Set(pi.getActiveTools());
						if (!sameToolMembership(desiredTools, currentActiveTools)) {
							pi.setActiveTools(desiredTools);
						}
						persistState();
					},
					() => {
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

	pi.on("session_start", async (_event, ctx) => {
		restoreFromBranch(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreFromBranch(ctx);
	});
}

export const __test__ = {
	applyOverrides,
	getConfigPath,
	normalizePersistedState,
	serializeOverrides,
	stripPreviouslyAppliedOverrides,
	toPersistedState,
	updateToolOverride,
};
