/**
 * Shared subagent infrastructure.
 *
 * Contains the /btw runner, types, rendering helpers, and TUI rendering.
 */

import type { ProviderHeaders, SimpleStreamOptions } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	createBashToolDefinition,
	DefaultResourceLoader,
	getMarkdownTheme,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, MarkdownTheme } from "@earendil-works/pi-tui";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";

import * as os from "node:os";
import * as path from "node:path";

import { loadAmplikeSettings, resolveAgentDir, resolveBashAction } from "./permissions-core.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MINIBOX_LINES = 10;
export const TASK_DISPLAY_LINES = 10;
export const TASK_DISPLAY_LINES_EXPANDED = 60;

export function clampTaskForDisplay(task: string, maxLines = TASK_DISPLAY_LINES): string {
	const lines = task.replace(/\s+$/, "").split("\n");
	if (lines.length <= maxLines) return lines.join("\n");
	const kept = Math.max(1, maxLines - 1);
	return `${lines.slice(0, kept).join("\n")}\n… +${lines.length - kept} more lines`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface SingleResult {
	task: string;
	exitCode: number;
	displayItems: DisplayItem[];
	finalOutput: string;
	usage: UsageStats;
	model?: string;
	agentBadge?: string;
	stopReason?: string;
	errorMessage?: string;
	sessionId?: string;
	sessionFile?: string;
}

export interface SubagentDetails {
	results: SingleResult[];
}

export interface SubagentRequestAuth {
	apiKey?: string;
	headers?: ProviderHeaders;
	env?: Record<string, string>;
}

export function createSubagentRequestOptions(
	auth: SubagentRequestAuth,
	sessionId: string,
	options?: SimpleStreamOptions,
): SimpleStreamOptions {
	return {
		...options,
		apiKey: auth.apiKey,
		env: auth.env || options?.env ? { ...auth.env, ...options?.env } : undefined,
		headers: auth.headers || options?.headers ? { ...auth.headers, ...options?.headers } : undefined,
		sessionId: options?.sessionId ?? sessionId,
	};
}

export type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, any> };

// ---------------------------------------------------------------------------
// Usage helpers
// ---------------------------------------------------------------------------

const BADGE_PART_MAX = 40;

function sanitizeBadgePart(value: string): string {
	const flat = value.replace(/\s+/g, " ").trim();
	return flat.length > BADGE_PART_MAX ? `${flat.slice(0, BADGE_PART_MAX - 1)}…` : flat;
}

export function formatAgentBadge(options: {
	mode?: string;
	model?: string;
	unresolved?: string[];
}): string | undefined {
	const parts = [options.mode, options.model]
		.filter((value): value is string => !!value?.trim())
		.map(sanitizeBadgePart);
	const ignored = (options.unresolved ?? [])
		.filter((value) => !!value?.trim())
		.map(sanitizeBadgePart);
	if (ignored.length) parts.push(`⚠ ignored ${ignored.join(" ")}`);
	return parts.length ? parts.join(" ") : undefined;
}

export function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

export function formatTokens(n: number): string {
	if (n < 1000) return n.toString();
	if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatUsage(u: UsageStats, model?: string): string {
	const parts: string[] = [];
	if (u.turns) parts.push(`${u.turns} turn${u.turns > 1 ? "s" : ""}`);
	if (u.input) parts.push(`↑${formatTokens(u.input)}`);
	if (u.output) parts.push(`↓${formatTokens(u.output)}`);
	if (u.cacheRead) parts.push(`R${formatTokens(u.cacheRead)}`);
	if (u.cacheWrite) parts.push(`W${formatTokens(u.cacheWrite)}`);
	if (u.cost) parts.push(`$${u.cost.toFixed(4)}`);
	if (u.contextTokens > 0) parts.push(`ctx:${formatTokens(u.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

export function aggregateUsage(results: SingleResult[]): UsageStats {
	const total = emptyUsage();
	for (const r of results) {
		total.input += r.usage.input;
		total.output += r.usage.output;
		total.cacheRead += r.usage.cacheRead;
		total.cacheWrite += r.usage.cacheWrite;
		total.cost += r.usage.cost;
		total.turns += r.usage.turns;
	}
	return total;
}

// ---------------------------------------------------------------------------
// Path / tool-call formatting
// ---------------------------------------------------------------------------

export function shortenPath(p: string): string {
	const home = os.homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

export function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	fg: (color: any, text: string) => string,
): string {
	switch (toolName) {
		case "bash": {
			let cmd = (args.command as string) || "...";
			const home = os.homedir();
			cmd = cmd.replaceAll(home, "~");
			const firstLine = cmd.split("\n")[0];
			return fg("muted", "$ ") + fg("toolOutput", firstLine);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = fg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return fg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = fg("muted", "write ") + fg("accent", shortenPath(rawPath));
			if (lines > 1) text += fg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return fg("muted", "edit ") + fg("accent", shortenPath(rawPath));
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return fg("accent", toolName) + fg("dim", ` ${preview}`);
		}
	}
}

// ---------------------------------------------------------------------------
// TUI rendering: shared building blocks
// ---------------------------------------------------------------------------

/**
 * Render a single result as a collapsed "minibox" string.
 * Shows icon, optional task preview, error, last N tool calls/text, and usage.
 * Used by both subagent tool (collapsed view) and btw (collapsed view).
 */
export function renderMinibox(
	r: SingleResult,
	options: { showTask: boolean; expanded: boolean },
	theme: Theme,
): string {
	const isRunning = r.exitCode === -1;
	const isError = r.exitCode > 0;
	const icon = isRunning
		? theme.fg("warning", "⏳")
		: isError
			? theme.fg("error", "✗")
			: theme.fg("success", "✓");

	const lines: string[] = [];
	const badge = r.agentBadge ? `${theme.fg("accent", `[${r.agentBadge}]`)} ` : "";

	if (options.showTask) {
		lines.push(`${icon} ${badge}${theme.fg("dim", clampTaskForDisplay(r.task))}`);
	} else {
		lines.push(badge ? `${icon} ${badge.trimEnd()}` : icon);
	}

	if (isError && r.errorMessage) {
		lines.push(theme.fg("error", `Error: ${r.errorMessage}`));
	}

	const items = r.displayItems;
	const itemsToShow = options.expanded ? items : items.slice(-MINIBOX_LINES);
	const skipped = items.length - itemsToShow.length;

	if (skipped > 0) {
		lines.push(theme.fg("muted", `... ${skipped} earlier items`));
	}

	for (const item of itemsToShow) {
		if (item.type === "text") {
			if (options.expanded) {
				continue;
			}
			const textLines = item.text.split("\n").filter((l) => l.trim());
			const preview = textLines.slice(0, 5).join("\n");
			lines.push(theme.fg("toolOutput", preview));
			if (textLines.length > 5) lines.push(theme.fg("muted", `... +${textLines.length - 5} lines`));
		} else {
			lines.push(
				theme.fg("muted", "→ ") +
					formatToolCall(item.name, item.args, theme.fg.bind(theme)),
			);
		}
	}

	if (!isRunning) {
		const usageStr = formatUsage(r.usage, r.model);
		if (usageStr) lines.push(theme.fg("dim", usageStr));
	}

	return lines.join("\n");
}

/**
 * Render a single result in expanded form as TUI components added to a container.
 * Shows separator + icon + task + all tool calls + markdown output + usage.
 * Used by both subagent tool (expanded view) and btw (expanded view).
 */
export function renderResultExpanded(
	r: SingleResult,
	container: Container,
	theme: Theme,
	mdTheme: MarkdownTheme,
): void {
	const rIcon = r.exitCode === 0
		? theme.fg("success", "✓")
		: r.exitCode === -1
			? theme.fg("warning", "⏳")
			: theme.fg("error", "✗");

	container.addChild(new Spacer(1));
	const badge = r.agentBadge ? `${theme.fg("accent", `[${r.agentBadge}]`)} ` : "";
	container.addChild(
		new Text(
			`${theme.fg("muted", "─── ")}${rIcon} ${badge}` +
				theme.fg("dim", clampTaskForDisplay(r.task, TASK_DISPLAY_LINES_EXPANDED)),
			0,
			0,
		),
	);

	if (r.exitCode > 0 && r.errorMessage) {
		container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
	}

	for (const item of r.displayItems) {
		if (item.type === "toolCall") {
			container.addChild(new Text(
				theme.fg("muted", "→ ") +
					formatToolCall(item.name, item.args, theme.fg.bind(theme)),
				0, 0,
			));
		}
	}

	if (r.finalOutput) {
		container.addChild(new Spacer(1));
		container.addChild(new Markdown(r.finalOutput.trim(), 0, 0, mdTheme));
	}

	const taskUsage = formatUsage(r.usage, r.model);
	if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
}

/**
 * Render a list of results as a complete TUI component.
 * Handles both collapsed and expanded views, single and multi-task.
 * Used by both subagent tool renderResult and btw message renderer.
 *
 * @param label - The label to show in the header (e.g. "subagent" or "btw")
 */
export function renderResults(
	results: SingleResult[],
	options: { expanded: boolean; label: string },
	theme: Theme,
): Component {
	const mdTheme = getMarkdownTheme();

	const running = results.filter((r) => r.exitCode === -1).length;
	const successCount = results.filter((r) => r.exitCode === 0).length;
	const failCount = results.filter((r) => r.exitCode > 0).length;
	const isRunning = running > 0;
	const icon = isRunning
		? theme.fg("warning", "⏳")
		: failCount > 0
			? theme.fg("warning", "◐")
			: theme.fg("success", "✓");
	const status = isRunning
		? `${successCount + failCount}/${results.length} done, ${running} running`
		: results.length === 1
			? ""
			: `${successCount}/${results.length} tasks`;

	// --- Expanded view (only when finished) ---
	if (options.expanded && !isRunning) {
		const container = new Container();
		container.addChild(
			new Text(
				`${icon} ${theme.fg("toolTitle", theme.bold(`${options.label} `))}${status ? theme.fg("accent", status) : ""}`,
				0, 0,
			),
		);

		for (const r of results) {
			renderResultExpanded(r, container, theme, mdTheme);
		}

		if (results.length > 1) {
			const totalUsage = aggregateUsage(results);
			const totalStr = formatUsage(totalUsage);
			if (totalStr) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("dim", `Total: ${totalStr}`), 0, 0));
			}
		}

		return container;
	}

	// --- Collapsed / running view ---
	let text = `${icon} ${theme.fg("toolTitle", theme.bold(`${options.label} `))}` +
		(status ? theme.fg("accent", status) : "");
	for (const r of results) {
		text += `\n\n${renderMinibox(r, { showTask: true, expanded: options.expanded }, theme)}`;
	}
	if (!isRunning && results.length > 1) {
		const totalUsage = aggregateUsage(results);
		const totalStr = formatUsage(totalUsage);
		if (totalStr) text += `\n\n${theme.fg("dim", `Total: ${totalStr}`)}`;
	}
	if (!options.expanded && !isRunning) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
	return new Text(text, 0, 0);
}

/**
 * Render a result as plain-text lines (no theme colors).
 * Used for setWidget() which only supports string[].
 */
export function btwTaskPreview(task: string): string {
	const taskFirstLine = task.split("\n")[0];
	const taskMultiline = taskFirstLine.length < task.length;
	const maxLen = (process.stdout.columns ?? 120) - "⏳ btw: ".length - 3 - 5;
	const taskTrimmed = taskFirstLine.length > maxLen ? `${taskFirstLine.slice(0, maxLen)}...` : taskFirstLine;
	return taskMultiline && !taskTrimmed.endsWith("...") ? `${taskTrimmed}...` : taskTrimmed;
}

export function renderProgressPlainLines(task: string, result: SingleResult): string[] {
	const taskPreview = btwTaskPreview(task);
	const lines: string[] = [];

	lines.push(`⏳ btw: ${result.agentBadge ? `[${result.agentBadge}] ` : ""}${taskPreview}`);

	const items = result.displayItems;
	const itemsToShow = items.slice(-MINIBOX_LINES);
	const skipped = items.length - itemsToShow.length;

	if (skipped > 0) {
		lines.push(`  ... ${skipped} earlier items`);
	}

	for (const item of itemsToShow) {
		if (item.type === "text") {
			const textLines = item.text.split("\n").filter((l) => l.trim());
			const preview = textLines.slice(0, 3).join("\n  ");
			lines.push(`  ${preview}`);
			if (textLines.length > 3) lines.push(`  ... +${textLines.length - 3} lines`);
		} else {
			switch (item.name) {
				case "bash": {
					const cmd = (item.args.command as string) || "...";
					lines.push(`  $ ${cmd.split("\n")[0]}`);
					break;
				}
				case "read":
					lines.push(`  read ${item.args.file_path || item.args.path || "..."}`);
					break;
				case "write":
					lines.push(`  write ${item.args.file_path || item.args.path || "..."}`);
					break;
				case "edit":
					lines.push(`  edit ${item.args.file_path || item.args.path || "..."}`);
					break;
				default:
					lines.push(`  → ${item.name}`);
			}
		}
	}

	return lines;
}

// ---------------------------------------------------------------------------
// Core: run a single subagent session
// ---------------------------------------------------------------------------

const SETTLE_MS = 150;
const CONTINUE_GRACE_MS = 700;
const MAX_RESUME_NUDGES = 3;
const RESUME_NUDGE_TEXT = "Context was compacted mid-turn. Continue from where you left off.";
const FALLBACK_SUMMARY_PREFIX =
	"⚠ Subagent ran out of context before writing a final answer; its latest compaction summary follows.";

export function createGatedBashDefinition(
	cwd: string,
	shellOptions?: { shellPath?: string; commandPrefix?: string },
): any {
	const base = createBashToolDefinition(cwd, shellOptions);
	return {
		...base,
		async execute(toolCallId: string, params: any, signal: any, onUpdate: any, context: any) {
			const command = String(params?.command ?? "");
			const yolo = loadAmplikeSettings().permissions?.mode === "yolo";
			if (!yolo) {
				const action = resolveBashAction(command, cwd);
				if (action !== "allow") {
					throw new Error(
						`Blocked by amp permissions (action: ${action}). Subagents run non-interactively, ` +
							"so only auto-allowed commands execute. Run this in the main session or adjust amp.permissions.",
					);
				}
			}
			return base.execute(toolCallId, params, signal, onUpdate, context);
		},
	};
}

export function subagentExtensionPaths(
	settings: { subagent?: { extensions?: string[] } } | undefined,
	agentDir: string,
): string[] {
	const configured = settings?.subagent?.extensions;
	if (!Array.isArray(configured)) return [];
	return configured
		.filter((extensionPath): extensionPath is string => (
			typeof extensionPath === "string" && extensionPath.trim().length > 0
		))
		.map((extensionPath) => {
			const normalizedPath = extensionPath.trim();
			if (normalizedPath === "~") return os.homedir();
			if (normalizedPath.startsWith("~/")) return path.join(os.homedir(), normalizedPath.slice(2));
			return path.resolve(agentDir, normalizedPath);
		});
}

export interface SettleController {
	onEvent(event: { type?: string; willRetry?: boolean }): void;
	kick(): void;
	done: Promise<void>;
	dispose(): void;
}

export function createSettleController(options: {
	isBusy: () => boolean;
	settleMs?: number;
	graceMs?: number;
}): SettleController {
	const settleMs = options.settleMs ?? SETTLE_MS;
	const graceMs = options.graceMs ?? CONTINUE_GRACE_MS;
	let resolveDone!: () => void;
	const done = new Promise<void>((resolve) => {
		resolveDone = resolve;
	});
	let settleTimer: ReturnType<typeof setTimeout> | undefined;
	let graceTimer: ReturnType<typeof setTimeout> | undefined;
	let pendingContinue = false;
	let disposed = false;

	const clearPending = () => {
		pendingContinue = false;
		if (graceTimer) clearTimeout(graceTimer);
		graceTimer = undefined;
	};
	const arm = () => {
		if (disposed) return;
		if (settleTimer) clearTimeout(settleTimer);
		settleTimer = setTimeout(() => {
			if (disposed) return;
			if (pendingContinue || options.isBusy()) arm();
			else resolveDone();
		}, settleMs);
	};
	const markPendingContinue = () => {
		pendingContinue = true;
		if (graceTimer) clearTimeout(graceTimer);
		graceTimer = setTimeout(() => {
			pendingContinue = false;
			graceTimer = undefined;
			arm();
		}, graceMs);
	};

	return {
		onEvent(event) {
			switch (event.type) {
				case "agent_start":
				case "message_start":
					clearPending();
					break;
				case "compaction_end":
					if (event.willRetry) markPendingContinue();
					break;
				case "auto_retry_start":
					markPendingContinue();
					break;
			}
			arm();
		},
		kick: arm,
		done,
		dispose() {
			disposed = true;
			if (settleTimer) clearTimeout(settleTimer);
			clearPending();
		},
	};
}

export interface CompactionInfo {
	willRetry: boolean;
	reason?: string;
	aborted: boolean;
	summary?: string;
}

export function lastAssistantText(messages: any[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index]?.role === "assistant") {
			return (messages[index].content ?? [])
				.filter((part: any) => part.type === "text")
				.map((part: any) => part.text)
				.join("");
		}
	}
	return "";
}

export function isTerminalThresholdCompaction(compaction: CompactionInfo | undefined): boolean {
	return !!compaction
		&& !compaction.willRetry
		&& compaction.reason === "threshold"
		&& !compaction.aborted
		&& !!compaction.summary;
}

export type ResumeDecision =
	| { action: "done"; output: string }
	| { action: "nudge" }
	| { action: "fallback"; output: string }
	| { action: "empty" };

export function decideResume(options: {
	finalText: string;
	lastCompaction: CompactionInfo | undefined;
	nudges: number;
	maxNudges: number;
	stopReason?: string;
	aborted?: boolean;
}): ResumeDecision {
	if (options.finalText) return { action: "done", output: options.finalText };
	if (!isTerminalThresholdCompaction(options.lastCompaction)) return { action: "empty" };
	if (options.stopReason === "error" || options.stopReason === "aborted" || options.aborted) {
		return { action: "empty" };
	}
	if (options.nudges < options.maxNudges) return { action: "nudge" };
	return { action: "fallback", output: options.lastCompaction!.summary! };
}

export interface RunSubagentOptions {
	cwd: string;
	modelRegistry: any;
	model: any;
	thinkingLevel: string;
	task: string;
	auth: SubagentRequestAuth;
	agentBadge?: string;
	parentSessionFile?: string;
	signal?: AbortSignal;
	onProgress: (result: SingleResult) => void;
}

function createAuthenticatedModelRuntime(
	modelRegistry: any,
	targetModel: any,
	auth: SubagentRequestAuth,
	sessionId: string,
): any {
	const runtime = modelRegistry.runtime;
	if (!runtime) throw new Error("The active model registry does not expose its request runtime");
	const isTarget = (providerOrModel: any) => (
		typeof providerOrModel === "string"
			? providerOrModel === targetModel.provider
			: providerOrModel?.provider === targetModel.provider && providerOrModel?.id === targetModel.id
	);
	return new Proxy(runtime, {
		get(target, property) {
			if (property === "hasConfiguredAuth") {
				return (providerOrModel: any) => (
					isTarget(providerOrModel) || target.hasConfiguredAuth(providerOrModel)
				);
			}
			if (property === "getAuth") {
				return async (providerOrModel: any, overrides?: any) => (
					isTarget(providerOrModel)
						? {
							auth: { apiKey: auth.apiKey, headers: auth.headers },
							env: auth.env,
							source: "parent session request auth",
						}
						: target.getAuth(providerOrModel, overrides)
				);
			}
			if (property === "streamSimple") {
				return (model: any, context: any, options?: SimpleStreamOptions) => target.streamSimple(
					model,
					context,
					isTarget(model) ? createSubagentRequestOptions(auth, sessionId, options) : options,
				);
			}
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

export async function runSubagent(options: RunSubagentOptions): Promise<SingleResult> {
	const {
		cwd,
		modelRegistry,
		model,
		thinkingLevel,
		task,
		auth,
		agentBadge,
		parentSessionFile,
		signal,
		onProgress,
	} = options;
	const result: SingleResult = {
		task,
		exitCode: -1,
		displayItems: [],
		finalOutput: "",
		usage: emptyUsage(),
		model: `${model.provider}/${model.id}`,
		agentBadge,
	};
	if (signal?.aborted) {
		result.exitCode = 1;
		result.stopReason = "aborted";
		result.errorMessage = "aborted before start";
		return result;
	}

	const subagentTask = [
		"You are operating as a subagent within a larger agent session.",
		"Complete the following task thoroughly, then provide your final response as text.",
		"Be concise and focused.",
		"",
		task,
	].join("\n");
	const agentDir = resolveAgentDir();
	const extensionProblems: string[] = [];
	const noteExtensionProblem = (message: string) => {
		const line = `⚠ subagent extension: ${message}`;
		if (extensionProblems.includes(line)) return;
		extensionProblems.push(line);
		result.displayItems.push({ type: "text", text: line });
	};
	let session: any;
	let unsubscribe: (() => void) | undefined;
	let onAbort: (() => void) | undefined;
	let settle: SettleController | undefined;
	let lastCompaction: CompactionInfo | undefined;

	try {
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			noExtensions: true,
			additionalExtensionPaths: subagentExtensionPaths(loadAmplikeSettings(), agentDir),
		});
		await resourceLoader.reload();

		const sessionManager = SessionManager.create(cwd);
		if (parentSessionFile) sessionManager.newSession({ parentSession: parentSessionFile });
		const childSessionId = sessionManager.getSessionId();
		const modelRuntime = createAuthenticatedModelRuntime(modelRegistry, model, auth, childSessionId);
		const created = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime,
			model,
			thinkingLevel: thinkingLevel as any,
			sessionManager,
			customTools: [createGatedBashDefinition(cwd, {
				shellPath: settingsManager.getShellPath?.(),
				commandPrefix: settingsManager.getShellCommandPrefix?.(),
			})],
			resourceLoader,
			settingsManager,
		});
		session = created.session;
		await session.bindExtensions({
			onError: (error: any) => noteExtensionProblem(
				`${error?.extensionPath ?? "extension"} (${error?.event ?? "?"}): ${error?.error ?? error}`,
			),
		});
		for (const error of created.extensionsResult?.errors ?? []) {
			noteExtensionProblem(`not loaded: ${error.path}: ${error.error}`);
		}
		result.sessionId = session.sessionManager.getSessionId();
		result.sessionFile = session.sessionManager.getSessionFile();

		const syncUsage = () => {
			try {
				let input = 0;
				let output = 0;
				let cacheRead = 0;
				let cacheWrite = 0;
				let cost = 0;
				let turns = 0;
				for (const entry of session.sessionManager.getEntries()) {
					const usage = entry.type === "usage"
						? entry.usage
						: entry.type === "message" && entry.message.role === "assistant"
							? entry.message.usage
							: undefined;
					if (!usage) continue;
					input += usage.input || 0;
					output += usage.output || 0;
					cacheRead += usage.cacheRead || 0;
					cacheWrite += usage.cacheWrite || 0;
					cost += usage.cost?.total || 0;
					if (entry.type === "message") turns++;
				}
				Object.assign(result.usage, { input, output, cacheRead, cacheWrite, cost, turns });
				const contextUsage = session.getContextUsage();
				if (contextUsage?.tokens != null) result.usage.contextTokens = contextUsage.tokens;
			} catch {
				// Usage reporting is best-effort
			}
		};
		const report = () => {
			try {
				syncUsage();
				onProgress(result);
			} catch {
				// Progress reporting must not interrupt the child session
			}
		};
		const isBusy = () => (
			session.isStreaming
			|| session.isCompacting
			|| session.isRetrying
			|| session.pendingMessageCount > 0
			|| session.isBashRunning
			|| session.hasPendingBashMessages
		);
		const armSettle = () => {
			settle?.dispose();
			settle = createSettleController({ isBusy });
			return settle;
		};
		armSettle();

		unsubscribe = session.subscribe((event: any) => {
			if (event.type === "message_end" && event.message?.role === "assistant") {
				const message = event.message;
				if (message.model) result.model = message.model;
				if (message.stopReason) result.stopReason = message.stopReason;
				if (message.errorMessage) result.errorMessage = message.errorMessage;
				for (const part of message.content) {
					if (part.type === "text") {
						result.displayItems.push({ type: "text", text: part.text });
						result.finalOutput = part.text;
					} else if (part.type === "toolCall") {
						result.displayItems.push({ type: "toolCall", name: part.name, args: part.arguments });
					}
				}
			} else if (event.type === "compaction_start") {
				result.displayItems.push({ type: "text", text: `↯ compacting context (${event.reason})…` });
			} else if (event.type === "compaction_end") {
				lastCompaction = {
					willRetry: !!event.willRetry,
					reason: event.reason,
					aborted: !!event.aborted,
					summary: event.result?.summary,
				};
			} else if (event.type === "agent_start" || event.type === "message_start") {
				lastCompaction = undefined;
			}
			report();
			settle?.onEvent(event);
		});

		onAbort = () => {
			try {
				session.abortCompaction();
			} catch {
				// Best-effort abort of compaction
			}
			void session.abort();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) {
			onAbort();
			throw new Error("aborted during setup");
		}

		const readFinalState = () => {
			try {
				const messages: any[] = session.state?.messages ?? [];
				for (let index = messages.length - 1; index >= 0; index--) {
					const message = messages[index];
					if (message?.role !== "assistant") continue;
					if (message.model) result.model = message.model;
					if (message.stopReason) result.stopReason = message.stopReason;
					result.errorMessage = message.errorMessage || result.errorMessage;
					break;
				}
				result.finalOutput = lastAssistantText(messages);
			} catch {
				// Subscriber-captured values remain available
			}
		};

		await session.prompt(subagentTask, { source: "extension" });
		settle!.kick();
		await settle!.done;
		readFinalState();

		let nudges = 0;
		for (;;) {
			const decision = decideResume({
				finalText: result.finalOutput,
				lastCompaction,
				nudges,
				maxNudges: MAX_RESUME_NUDGES,
				stopReason: result.stopReason,
				aborted: signal?.aborted,
			});
			if (decision.action === "done" || decision.action === "empty") break;
			if (decision.action === "fallback") {
				const output = `${FALLBACK_SUMMARY_PREFIX}\n\n${decision.output}`;
				result.finalOutput = output;
				result.displayItems.push({ type: "text", text: output });
				break;
			}
			if (signal?.aborted) break;
			nudges++;
			result.displayItems.push({
				type: "text",
				text: `↻ resuming after compaction (nudge ${nudges}/${MAX_RESUME_NUDGES})…`,
			});
			lastCompaction = undefined;
			result.finalOutput = "";
			armSettle();
			await session.prompt(RESUME_NUDGE_TEXT, { source: "extension" });
			settle!.kick();
			await settle!.done;
			readFinalState();
		}
		syncUsage();

		if (signal?.aborted) result.stopReason = "aborted";
		result.exitCode = result.stopReason === "error" || result.stopReason === "aborted" ? 1 : 0;
		if (extensionProblems.length) {
			const notice = extensionProblems.join("\n");
			result.errorMessage = result.errorMessage ? `${result.errorMessage}\n${notice}` : notice;
			result.finalOutput = result.finalOutput ? `${result.finalOutput}\n\n${notice}` : notice;
		}
	} catch (error) {
		result.exitCode = 1;
		result.errorMessage = error instanceof Error ? error.message : String(error);
		if (signal?.aborted) result.stopReason = "aborted";
	} finally {
		settle?.dispose();
		if (signal && onAbort) signal.removeEventListener("abort", onAbort);
		unsubscribe?.();
		try {
			if (session?.extensionRunner?.hasHandlers("session_shutdown")) {
				await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			}
		} catch {
			// Best-effort extension shutdown
		}
		try {
			session?.dispose();
		} catch {
			// Best-effort session cleanup
		}
	}
	return result;
}

// ---------------------------------------------------------------------------
// Parallel execution helper
// ---------------------------------------------------------------------------

export async function mapWithConcurrency<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}
