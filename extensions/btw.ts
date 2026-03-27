/**
 * /btw command — run a subagent in the background while continuing to work.
 *
 * Usage:
 *   /btw check if there are any TODO comments in src/
 *   /btw --mode rush summarize the README
 *   /btw --model anthropic/claude-haiku-4-5 count lines of code
 *
 * Fires off an in-process subagent (same infra as the subagent tool) and
 * shows live progress in a widget above the editor. When finished, the
 * widget is replaced by a fully rendered custom message in the chat
 * (identical to the subagent tool's result rendering).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { AgentTool } from "@mariozechner/pi-agent-core";

import type { ExtensionAPI, SessionEntry } from "@mariozechner/pi-coding-agent";
import {
	convertToLlm,
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	getMarkdownTheme,
	serializeConversation,
} from "@mariozechner/pi-coding-agent";
import { Box, Markdown, Spacer, Text } from "@mariozechner/pi-tui";

import { resolveModelAndThinking } from "./lib/mode-utils.js";
import {
	type SingleResult,
	formatToolCall,
	formatUsage,
	btwTaskPreview,
	renderProgressPlainLines,
	runSubagent,
} from "./lib/subagent-core.js";

// ---------------------------------------------------------------------------
// Custom message type
// ---------------------------------------------------------------------------

const BTW_MESSAGE_TYPE = "btw-result";

interface BtwMessageDetails {
	task: string;
	result: SingleResult;
}

type ScopedModelCandidate = {
	model: any;
	thinkingLevel?: string;
};

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

function parseBtwArgs(rawArgs: string): { modeOpt?: string; modelOpt?: string; task: string } {
	let remaining = rawArgs.trim();
	let modeOpt: string | undefined;
	let modelOpt: string | undefined;

	while (remaining.startsWith("--")) {
		const modeMatch = remaining.match(/^--mode\s+(\S+)(?:\s+|$)/);
		if (modeMatch) {
			modeOpt = modeMatch[1];
			remaining = remaining.slice(modeMatch[0].length).trimStart();
			continue;
		}

		const modelMatch = remaining.match(/^--model\s+(\S+)(?:\s+|$)/);
		if (modelMatch) {
			modelOpt = modelMatch[1];
			remaining = remaining.slice(modelMatch[0].length).trimStart();
			continue;
		}

		break;
	}

	return { modeOpt, modelOpt, task: remaining.trim() };
}

function normalizeModelText(value: string): string {
	return value.trim().toLowerCase();
}

function collapseModelText(value: string): string {
	return normalizeModelText(value).replace(/[^a-z0-9]+/g, "");
}

function expandUserPath(p: string): string {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	return p;
}

function loadEnabledModelPatterns(cwd: string): string[] | undefined {
	const agentDir = process.env.PI_CODING_AGENT_DIR
		? expandUserPath(process.env.PI_CODING_AGENT_DIR)
		: path.join(os.homedir(), ".pi", "agent");
	const globalSettingsPath = path.join(agentDir, "settings.json");
	const projectSettingsPath = path.join(cwd, ".pi", "settings.json");

	const readEnabledModels = (settingsPath: string): string[] | undefined => {
		try {
			const raw = fs.readFileSync(settingsPath, "utf8");
			const parsed = JSON.parse(raw);
			return Array.isArray(parsed?.enabledModels)
				? parsed.enabledModels.filter((value: unknown): value is string => typeof value === "string")
				: undefined;
		} catch {
			return undefined;
		}
	};

	const globalModels = readEnabledModels(globalSettingsPath);
	const projectModels = readEnabledModels(projectSettingsPath);
	return projectModels ?? globalModels;
}

function splitPatternThinkingLevel(pattern: string): { pattern: string; thinkingLevel?: string } {
	const lastColonIndex = pattern.lastIndexOf(":");
	if (lastColonIndex === -1) {
		return { pattern };
	}

	const suffix = pattern.slice(lastColonIndex + 1).trim().toLowerCase();
	if (!THINKING_LEVELS.has(suffix)) {
		return { pattern };
	}

	return {
		pattern: pattern.slice(0, lastColonIndex),
		thinkingLevel: suffix,
	};
}

function matchesGlob(pattern: string, value: string): boolean {
	const escaped = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".");
	return new RegExp(`^${escaped}$`, "i").test(value);
}

function scoreModelCandidate(
	query: string,
	candidate: ScopedModelCandidate,
	options?: { preferredProvider?: string },
): number {
	const normalizedQuery = normalizeModelText(query);
	if (!normalizedQuery) return 0;

	const fullId = normalizeModelText(`${candidate.model.provider}/${candidate.model.id}`);
	const id = normalizeModelText(candidate.model.id);
	const name = normalizeModelText(candidate.model.name ?? "");
	const providerBonus = options?.preferredProvider
		&& normalizeModelText(candidate.model.provider) === normalizeModelText(options.preferredProvider)
		? 750
		: 0;

	if (fullId === normalizedQuery) return 12_000 + providerBonus;
	if (id === normalizedQuery) return 11_500 + providerBonus;
	if (fullId.endsWith(`/${normalizedQuery}`)) return 11_000 + providerBonus;
	if (id.startsWith(normalizedQuery)) return 10_000 - (id.length - normalizedQuery.length) + providerBonus;
	if (fullId.startsWith(normalizedQuery)) return 9_500 - (fullId.length - normalizedQuery.length) + providerBonus;

	const idIndex = id.indexOf(normalizedQuery);
	if (idIndex !== -1) return 9_000 - idIndex * 10 - (id.length - normalizedQuery.length) + providerBonus;

	const fullIdIndex = fullId.indexOf(normalizedQuery);
	if (fullIdIndex !== -1) {
		return 8_000 - fullIdIndex * 10 - (fullId.length - normalizedQuery.length) + providerBonus;
	}

	const nameIndex = name.indexOf(normalizedQuery);
	if (nameIndex !== -1) return 7_000 - nameIndex * 10 - (name.length - normalizedQuery.length) + providerBonus;

	const collapsedQuery = collapseModelText(query);
	if (!collapsedQuery) return 0;

	const collapsedId = collapseModelText(candidate.model.id);
	const collapsedFullId = collapseModelText(`${candidate.model.provider}/${candidate.model.id}`);
	const collapsedName = collapseModelText(candidate.model.name ?? "");

	if (collapsedId === collapsedQuery) return 6_500 + providerBonus;
	if (collapsedFullId === collapsedQuery) return 6_250 + providerBonus;
	if (collapsedId.startsWith(collapsedQuery)) return 6_000 - (collapsedId.length - collapsedQuery.length) + providerBonus;
	if (collapsedFullId.startsWith(collapsedQuery)) {
		return 5_500 - (collapsedFullId.length - collapsedQuery.length) + providerBonus;
	}

	const collapsedIdIndex = collapsedId.indexOf(collapsedQuery);
	if (collapsedIdIndex !== -1) {
		return 5_000 - collapsedIdIndex * 10 - (collapsedId.length - collapsedQuery.length) + providerBonus;
	}

	const collapsedFullIdIndex = collapsedFullId.indexOf(collapsedQuery);
	if (collapsedFullIdIndex !== -1) {
		return 4_500 - collapsedFullIdIndex * 10 - (collapsedFullId.length - collapsedQuery.length) + providerBonus;
	}

	const collapsedNameIndex = collapsedName.indexOf(collapsedQuery);
	if (collapsedNameIndex !== -1) {
		return 4_000 - collapsedNameIndex * 10 - (collapsedName.length - collapsedQuery.length) + providerBonus;
	}

	return 0;
}

function resolveScopedCandidatesFromSettings(ctx: any): ScopedModelCandidate[] {
	const patterns = loadEnabledModelPatterns(ctx.cwd);
	if (!patterns || patterns.length === 0) {
		return [];
	}

	const availableModels = ctx.modelRegistry.getAvailable();
	const preferredProvider = ctx.model?.provider;
	const resolved: ScopedModelCandidate[] = [];
	const seen = new Set<string>();
	const addCandidate = (candidate: ScopedModelCandidate) => {
		const key = `${candidate.model.provider}/${candidate.model.id}`;
		if (seen.has(key)) return;
		seen.add(key);
		resolved.push(candidate);
	};

	for (const rawPattern of patterns) {
		const { pattern, thinkingLevel } = splitPatternThinkingLevel(rawPattern.trim());
		if (!pattern) continue;

		if (pattern.includes("*") || pattern.includes("?")) {
			for (const model of availableModels) {
				const fullId = `${model.provider}/${model.id}`;
				if (matchesGlob(pattern, fullId) || matchesGlob(pattern, model.id)) {
					addCandidate({ model, thinkingLevel });
				}
			}
			continue;
		}

		// Exact match: add every model whose id or provider/id matches the pattern.
		// Multiple providers may share the same model id; keep all of them in scope
		// so the --model resolver can pick the right one with provider bias.
		const normalizedPattern = normalizeModelText(pattern);
		let anyMatch = false;
		for (const model of availableModels) {
			const fullId = normalizeModelText(`${model.provider}/${model.id}`);
			const id = normalizeModelText(model.id);
			if (fullId === normalizedPattern || id === normalizedPattern) {
				addCandidate({ model, thinkingLevel });
				anyMatch = true;
			}
		}
		if (!anyMatch) {
			// Fall back to closest-match if there is no exact hit (handles minor
			// typos or id aliases in settings).
			const match = resolveClosestModelCandidate(
				pattern,
				availableModels.map((model: any) => ({ model })),
				{ preferredProvider },
			);
			if (match) addCandidate({ model: match.model, thinkingLevel });
		}
	}

	return resolved;
}

function getModelCandidates(ctx: any): ScopedModelCandidate[] {
	const scopedModels = ctx.scopedModels;
	if (Array.isArray(scopedModels) && scopedModels.length > 0) {
		return scopedModels as ScopedModelCandidate[];
	}

	const settingsScopedModels = resolveScopedCandidatesFromSettings(ctx);
	if (settingsScopedModels.length > 0) {
		return settingsScopedModels;
	}

	if (ctx.model) {
		return ctx.modelRegistry.getAvailable()
			.filter((model: any) => model.provider === ctx.model.provider)
			.map((model: any) => ({ model }));
	}

	return [];
}

function rankModelCandidates(
	modelQuery: string,
	candidates: ScopedModelCandidate[],
	options?: { preferredProvider?: string },
): ScopedModelCandidate[] {
	const normalizedQuery = normalizeModelText(modelQuery);
	if (!normalizedQuery) return [];

	const slashIndex = normalizedQuery.indexOf("/");
	const providerQuery = slashIndex > 0 ? normalizedQuery.slice(0, slashIndex) : undefined;
	const idQuery = slashIndex > 0 ? normalizedQuery.slice(slashIndex + 1) : normalizedQuery;

	const searchSpace = providerQuery
		? candidates.filter((candidate) => normalizeModelText(candidate.model.provider) === providerQuery)
		: candidates;
	if (searchSpace.length === 0) return [];

	return searchSpace
		.map((candidate) => ({
			candidate,
			score: Math.max(
				scoreModelCandidate(normalizedQuery, candidate, options),
				providerQuery ? scoreModelCandidate(idQuery, candidate, options) + 50 : 0,
			),
		}))
		.filter((entry) => entry.score > 0)
		.sort((a, b) => (
			b.score - a.score
			|| a.candidate.model.id.length - b.candidate.model.id.length
			|| `${a.candidate.model.provider}/${a.candidate.model.id}`.localeCompare(
				`${b.candidate.model.provider}/${b.candidate.model.id}`,
			)
		))
		.map((entry) => entry.candidate);
}

function resolveClosestModelCandidate(
	modelQuery: string,
	candidates: ScopedModelCandidate[],
	options?: { preferredProvider?: string },
): ScopedModelCandidate | undefined {
	return rankModelCandidates(modelQuery, candidates, options)[0];
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

let btwCounter = 0;

export default function (pi: ExtensionAPI) {
	// Track btw widgets waiting for turn_end to remove themselves
	const pendingWidgetRemovals = new Map<string, () => void>();

	pi.on("turn_end", () => {
		// Resolve all pending widget removal promises — the steered custom
		// messages render at turn boundary, so widgets can now be removed.
		for (const [, resolve] of pendingWidgetRemovals) resolve();
		pendingWidgetRemovals.clear();
	});

	// --- Filter btw messages out of LLM context (user-facing only) ---
	pi.on("context", (event) => {
		const filtered = event.messages.filter(
			(m: any) => !(m.role === "custom" && m.customType === BTW_MESSAGE_TYPE),
		);
		if (filtered.length !== event.messages.length) {
			return { messages: filtered };
		}
	});

	// --- Shared rendering logic for btw results ---
	function renderBtwResult(r: SingleResult, theme: any): InstanceType<typeof Box> {
		const icon = r.exitCode === 0
			? theme.fg("success", "✓")
			: theme.fg("error", "✗");

		const box = new Box(1, 1, (t: string) => theme.bg("customMessageBg", t));

		// Single merged header: ✓ btw: <task>
		box.addChild(
			new Text(`${icon} ${theme.fg("toolTitle", theme.bold("btw: "))}${theme.fg("dim", r.task)}`, 0, 0),
		);

		if (r.exitCode > 0 && r.errorMessage) {
			box.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
		}

		// Tool calls
		for (const item of r.displayItems) {
			if (item.type === "toolCall") {
				box.addChild(new Text(
					theme.fg("muted", "→ ") +
						formatToolCall(item.name, item.args, theme.fg.bind(theme)),
					0, 0,
				));
			}
		}

		// Markdown output
		if (r.finalOutput) {
			const mdTheme = getMarkdownTheme();
			box.addChild(new Spacer(1));
			box.addChild(new Markdown(r.finalOutput.trim(), 0, 0, mdTheme));
		}

		// Usage
		const usageStr = formatUsage(r.usage, r.model);
		if (usageStr) box.addChild(new Text(theme.fg("dim", usageStr), 0, 0));

		return box;
	}

	// --- Custom message renderer: always shows full markdown output ---
	pi.registerMessageRenderer<BtwMessageDetails>(BTW_MESSAGE_TYPE, (message, _opts, theme) => {
		const details = message.details;
		if (!details?.result) return undefined;
		return renderBtwResult(details.result, theme);
	});

	// --- /btw command ---
	pi.registerCommand("btw", {
		description: "Run a single-shot subagent in the background (--mode <name>, --model <provider/id|partial>)",
		handler: async (args, ctx) => {
			const { modeOpt, modelOpt, task } = parseBtwArgs(args);
			if (!task) {
				ctx.ui.notify("Usage: /btw [--mode <name>] [--model <provider/id|partial>] <prompt>", "error");
				return;
			}

			const resolved = await resolveModelAndThinking(
				ctx.cwd,
				ctx.modelRegistry,
				ctx.model,
				pi.getThinkingLevel(),
				{ mode: modeOpt },
			);

			let targetModel = resolved.model;
			let thinkingLevel = resolved.thinkingLevel;

			if (modelOpt) {
				const rankedModels = rankModelCandidates(
					modelOpt,
					getModelCandidates(ctx),
					{ preferredProvider: ctx.model?.provider },
				);

				let matchedModel: ScopedModelCandidate | undefined;
				for (const candidate of rankedModels) {
					const auth = await ctx.modelRegistry.getApiKeyAndHeaders(candidate.model);
					if (auth.ok) {
						matchedModel = candidate;
						break;
					}
				}

				if (!matchedModel) {
					ctx.ui.notify(`No matching model with request auth found for "${modelOpt}".`, "error");
					return;
				}

				targetModel = matchedModel.model as any;
				if (!modeOpt && matchedModel.thinkingLevel) {
					thinkingLevel = matchedModel.thinkingLevel;
				}
			}

			if (!targetModel) {
				ctx.ui.notify("No model available.", "error");
				return;
			}

			// Build tools
			const tools: AgentTool<any>[] = [
				createReadTool(ctx.cwd),
				createBashTool(ctx.cwd),
				createEditTool(ctx.cwd),
				createWriteTool(ctx.cwd),
			];

			const systemPrompt = ctx.getSystemPrompt();
			const authResolver = async (_provider: string) => {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(targetModel!);
				if (!auth.ok) {
					throw new Error(auth.error);
				}
				return { apiKey: auth.apiKey, headers: auth.headers };
			};

			// Serialize current conversation context for the subagent
			const branch = ctx.sessionManager.getBranch();
			const messages = branch
				.filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message")
				.map((entry) => entry.message);
			const conversationContext = messages.length > 0
				? serializeConversation(convertToLlm(messages))
				: "";

			// Build enriched task with conversation context
			const taskWithContext = conversationContext
				? `## Conversation Context\n\n${conversationContext}\n\n## Task or question (FOCUS SOLELY ON THIS)\n\n${task}`
				: task;

			// Unique widget key per invocation so multiple /btw's don't clobber each other
			const widgetKey = `btw-${++btwCounter}`;

			// Show initial status widget
			const taskPreview = btwTaskPreview(task);
			ctx.ui.setWidget(widgetKey, [`⏳ btw: ${taskPreview}`], { placement: "aboveEditor" });

			// Fire and forget — run in background, update widget on progress
			runSubagent(
				systemPrompt,
				taskWithContext,
				tools,
				targetModel,
				thinkingLevel,
				authResolver,
				undefined, // no abort signal — runs to completion
				(progressResult) => {
					// Update widget with live tool call feed
					ctx.ui.setWidget(widgetKey, renderProgressPlainLines(task, progressResult), { placement: "aboveEditor" });
				},
			).then(async (result) => {
				// Override result.task with the short user prompt (not the context-enriched one)
				result.task = task;

				// Send fully rendered result as a custom message in the chat.
				// Filtered out of LLM context by the context event handler above.
				// triggerTurn: false is critical — without it, sendMessage mid-stream
				// tries to start a new turn which corrupts conversation state.
				const icon = result.exitCode === 0 ? "✓" : "✗";
				pi.sendMessage({
					customType: BTW_MESSAGE_TYPE,
					content: [{ type: "text", text: `[btw ${icon}] ${task}` }],
					display: true,
					details: { task, result } satisfies BtwMessageDetails,
				}, { triggerTurn: false });

				// If the agent is busy (tool call running), the custom message won't
				// render in chat until the turn ends.  Show the full rendered result
				// as a component widget so it appears immediately; remove once idle.
				if (!ctx.isIdle()) {
					ctx.ui.setWidget(widgetKey, (_tui, theme) => renderBtwResult(result, theme), { placement: "aboveEditor" });
					// Wait for current turn to end — the steered custom message
					// renders at that point, so we can remove the widget.
					await new Promise<void>((resolve) => {
						pendingWidgetRemovals.set(widgetKey, resolve);
					});
				}
				ctx.ui.setWidget(widgetKey, undefined);
			}).catch((err) => {
				ctx.ui.setWidget(widgetKey, undefined);
				ctx.ui.notify(`btw failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			});

			// Command returns immediately — subagent runs in background
		},
	});
}
