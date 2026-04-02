/**
 * anycopy — browse session tree nodes with preview and copy any of them
 *
 * Layout: native TreeSelectorComponent at top, status bar, preview below
 *
 * Default keys (customizable via ./config.json):
 *   Shift+A   - select/unselect focused node for copy
 *   Shift+C   - copy selected nodes (or focused node if none selected)
 *   Shift+X   - clear selection
 *   Shift+L   - label node
 *   Shift+T   - toggle label timestamps for labeled nodes
 *   Shift+↑/↓ - scroll preview
 *   Shift+←/→ - page preview
 *   Esc       - close
 */

import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import {
	copyToClipboard,
	getLanguageFromPath,
	getMarkdownTheme,
	highlightCode,
	TreeSelectorComponent,
} from "@mariozechner/pi-coding-agent";

import { getKeybindings, Markdown, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import type { Focusable } from "@mariozechner/pi-tui";

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { runAnycopyEnterNavigation } from "./enter-navigation.ts";
import {
	ANYCOPY_FOLD_STATE_CUSTOM_TYPE,
	createFoldStateEntryData,
	foldStateNodeIdListsEqual,
	getSelectorFoldedNodeIds,
	loadLatestFoldStateFromEntries,
	mergeExplicitFoldMutation,
	normalizeFoldedNodeIds,
	setSelectorFoldedNodeIds,
} from "./fold-state.ts";

type SessionTreeNode = {
	entry: SessionEntry;
	children: SessionTreeNode[];
	label?: string;
	labelTimestamp?: string;
};

type anycopyKeyConfig = {
	toggleSelect: string;
	copy: string;
	clear: string;
	toggleLabelTimestamps: string;
	scrollDown: string;
	scrollUp: string;
	pageDown: string;
	pageUp: string;
};

type TreeFilterMode = "default" | "no-tools" | "user-only" | "labeled-only" | "all";

type anycopyConfig = {
	keys?: Partial<anycopyKeyConfig>;
	treeFilterMode?: TreeFilterMode;
	persistFoldState?: boolean;
};

type anycopyRuntimeConfig = {
	keys: anycopyKeyConfig;
	treeFilterMode: TreeFilterMode;
	persistFoldState: boolean;
};

type BranchSummarySettingsFile = {
	branchSummary?: {
		skipPrompt?: boolean;
	};
};

const DEFAULT_KEYS: anycopyKeyConfig = {
	toggleSelect: "shift+a",
	copy: "shift+c",
	clear: "shift+x",
	toggleLabelTimestamps: "shift+t",
	scrollDown: "shift+down",
	scrollUp: "shift+up",
	pageDown: "shift+right",
	pageUp: "shift+left",
};

const DEFAULT_TREE_FILTER_MODE: TreeFilterMode = "default";
const DEFAULT_PERSIST_FOLD_STATE = true;

const getExtensionDir = (): string => {
	// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
	if (typeof __dirname !== "undefined") return __dirname;
	return dirname(fileURLToPath(import.meta.url));
};

const getAgentDir = (): string => process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");

const readJsonFile = <T>(path: string): T | undefined => {
	if (!existsSync(path)) return undefined;

	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return undefined;
	}
};

const loadBranchSummarySkipPrompt = (cwd: string): boolean => {
	const globalSettings = readJsonFile<BranchSummarySettingsFile>(join(getAgentDir(), "settings.json"));
	const projectSettings = readJsonFile<BranchSummarySettingsFile>(join(cwd, ".pi", "settings.json"));
	const projectSkipPrompt = projectSettings?.branchSummary?.skipPrompt;
	if (typeof projectSkipPrompt === "boolean") return projectSkipPrompt;

	const globalSkipPrompt = globalSettings?.branchSummary?.skipPrompt;
	return typeof globalSkipPrompt === "boolean" ? globalSkipPrompt : false;
};

const loadConfig = (): anycopyRuntimeConfig => {
	const configPath = join(getExtensionDir(), "config.json");
	if (!existsSync(configPath)) {
		return {
			keys: { ...DEFAULT_KEYS },
			treeFilterMode: DEFAULT_TREE_FILTER_MODE,
			persistFoldState: DEFAULT_PERSIST_FOLD_STATE,
		};
	}

	try {
		const raw = readFileSync(configPath, "utf8");
		const parsed = JSON.parse(raw) as anycopyConfig;
		const keys = parsed.keys ?? {};
		const treeFilterModeRaw = parsed.treeFilterMode;
		const validTreeFilterModes: TreeFilterMode[] = ["default", "no-tools", "user-only", "labeled-only", "all"];
		const treeFilterMode =
			typeof treeFilterModeRaw === "string" && validTreeFilterModes.includes(treeFilterModeRaw as TreeFilterMode)
				? (treeFilterModeRaw as TreeFilterMode)
				: DEFAULT_TREE_FILTER_MODE;
		const persistFoldState =
			typeof parsed.persistFoldState === "boolean" ? parsed.persistFoldState : DEFAULT_PERSIST_FOLD_STATE;

		return {
			keys: {
				toggleSelect: typeof keys.toggleSelect === "string" ? keys.toggleSelect : DEFAULT_KEYS.toggleSelect,
				copy: typeof keys.copy === "string" ? keys.copy : DEFAULT_KEYS.copy,
				clear: typeof keys.clear === "string" ? keys.clear : DEFAULT_KEYS.clear,
				toggleLabelTimestamps:
					typeof keys.toggleLabelTimestamps === "string"
						? keys.toggleLabelTimestamps
						: DEFAULT_KEYS.toggleLabelTimestamps,
				scrollDown: typeof keys.scrollDown === "string" ? keys.scrollDown : DEFAULT_KEYS.scrollDown,
				scrollUp: typeof keys.scrollUp === "string" ? keys.scrollUp : DEFAULT_KEYS.scrollUp,
				pageDown: typeof keys.pageDown === "string" ? keys.pageDown : DEFAULT_KEYS.pageDown,
				pageUp: typeof keys.pageUp === "string" ? keys.pageUp : DEFAULT_KEYS.pageUp,
			},
			treeFilterMode,
			persistFoldState,
		};
	} catch {
		return {
			keys: { ...DEFAULT_KEYS },
			treeFilterMode: DEFAULT_TREE_FILTER_MODE,
			persistFoldState: DEFAULT_PERSIST_FOLD_STATE,
		};
	}
};

const formatKeyHint = (key: string): string => {
	const normalized = key.trim().toLowerCase();
	if (normalized === "space") return "Space";
	const parts = normalized.split("+");
	return parts
		.map((part) => {
			if (part === "shift") return "Shift";
			if (part === "ctrl") return "Ctrl";
			if (part === "alt") return "Alt";
			if (part.length === 1) return part.toUpperCase();
			return part;
		})
		.join("+");
};

const pluralizeNode = (count: number): string => (count === 1 ? "node" : "nodes");

const MAX_PREVIEW_CHARS = 7000;
const MAX_PREVIEW_LINES = 200;
const FLASH_DURATION_MS = 2000;

const getTextContent = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(b): b is { type: "text"; text: string } =>
				typeof b === "object" && b !== null && (b as { type?: string }).type === "text",
		)
		.map((b) => b.text)
		.join("");
};

const clipTextForPreview = (text: string): string => {
	if (text.length <= MAX_PREVIEW_CHARS) return text;
	return `${text.slice(0, MAX_PREVIEW_CHARS)}\n… [truncated]`;
};

/** Role/type label for clipboard display */
const getEntryRoleLabel = (entry: SessionEntry): string => {
	if (entry.type === "message") {
		return (entry.message as { role?: string }).role ?? "message";
	}
	if (entry.type === "custom_message") return entry.customType;
	return entry.type;
};

/** Plain text content for clipboard and preview (no metadata) */
const getEntryContent = (entry: SessionEntry): string => {
	switch (entry.type) {
		case "message": {
			const msg = entry.message as {
				role?: string;
				content?: unknown;
				command?: string;
				errorMessage?: string;
			};
			if (msg.role === "bashExecution" && msg.command) return msg.command;
			if (msg.errorMessage) return `(error) ${msg.errorMessage}`;
			return getTextContent(msg.content).trim() || "(no text content)";
		}
		case "custom_message": {
			if (typeof entry.content === "string") {
				return entry.content || "(no text content)";
			}
			if (!Array.isArray(entry.content)) {
				return "(no text content)";
			}

			const content = entry.content
				.filter(
					(b): b is { type: "text"; text: string } =>
						typeof b === "object" &&
						b !== null &&
						(b as { type?: string }).type === "text" &&
						typeof (b as { text?: unknown }).text === "string",
				)
				.map((b) => b.text)
				.join("");
			return content || "(no text content)";
		}
		case "compaction":
			return entry.summary;
		case "branch_summary":
			return entry.summary;
		case "custom":
			return `[custom: ${entry.customType}]`;
		case "label":
			return `label: ${entry.label ?? "(cleared)"}`;
		case "model_change":
			return `${entry.provider}/${entry.modelId}`;
		case "thinking_level_change":
			return entry.thinkingLevel;
		case "session_info":
			return entry.name ?? "(unnamed)";
		default:
			return "";
	}
};

const replaceTabs = (text: string): string => text.replace(/\t/g, "   ");

const MAX_PARENT_TRAVERSAL_DEPTH = 30;

const getToolCallId = (entry: SessionEntry): string | null => {
	if (entry.type !== "message") return null;
	const msg = entry.message as { role?: string; toolCallId?: unknown };
	if (msg.role !== "toolResult") return null;
	return typeof msg.toolCallId === "string" ? msg.toolCallId : null;
};

const getToolName = (entry: SessionEntry): string | null => {
	if (entry.type !== "message") return null;
	const msg = entry.message as { role?: string; toolName?: unknown };
	if (msg.role !== "toolResult") return null;
	return typeof msg.toolName === "string" ? msg.toolName : null;
};

const resolveToolCallArgsFromParents = (
	entry: SessionEntry,
	nodeById: Map<string, SessionTreeNode>,
): Record<string, unknown> | null => {
	const toolCallId = getToolCallId(entry);
	if (!toolCallId) return null;

	let parentId = entry.parentId;
	for (let depth = 0; depth < MAX_PARENT_TRAVERSAL_DEPTH && parentId; depth += 1) {
		const parentNode = nodeById.get(parentId);
		if (!parentNode) return null;

		const parentEntry = parentNode.entry;
		if (parentEntry.type === "message") {
			const parentMsg = parentEntry.message as { role?: string; content?: unknown };
			if (parentMsg.role === "assistant" && Array.isArray(parentMsg.content)) {
				const toolCall = parentMsg.content.find(
					(c: any) => c && c.type === "toolCall" && c.id === toolCallId,
				) as { arguments?: unknown } | undefined;

				if (toolCall && typeof toolCall.arguments === "object" && toolCall.arguments !== null) {
					return toolCall.arguments as Record<string, unknown>;
				}
			}
		}

		parentId = parentEntry.parentId;
	}

	return null;
};

const resolveReadToolLanguageFromParents = (
	entry: SessionEntry,
	nodeById: Map<string, SessionTreeNode>,
): string | undefined => {
	if (getToolName(entry) !== "read") return undefined;

	const args = resolveToolCallArgsFromParents(entry, nodeById);
	if (!args) return undefined;

	const rawPath = args["file_path"] ?? args["path"];
	if (typeof rawPath !== "string" || !rawPath.trim()) return undefined;
	return getLanguageFromPath(rawPath);
};

const renderPreviewBodyLines = (
	text: string,
	entry: SessionEntry,
	width: number,
	theme: any,
	nodeById: Map<string, SessionTreeNode>,
): string[] => {
	if (entry.type === "message") {
		const msg = entry.message as { role?: string; command?: string };

		// Bash execution nodes: highlight the command itself
		if (msg.role === "bashExecution" && typeof msg.command === "string") {
			return highlightCode(replaceTabs(text), "bash").map((line) => truncateToWidth(line, width));
		}

		// Read tool results: use parent toolCall args to infer language from path, matching pi's own renderer
		if (getToolName(entry) === "read") {
			const normalized = replaceTabs(text);
			const lang = resolveReadToolLanguageFromParents(entry, nodeById);

			const lines = lang
				? highlightCode(normalized, lang)
				: normalized.split("\n").map((line) => theme.fg("toolOutput", line));

			return lines.map((line) => truncateToWidth(line, width));
		}
	}

	// Everything else: render with pi's markdown renderer/theme (matches main UI)
	const markdown = new Markdown(text, 0, 0, getMarkdownTheme());
	return markdown.render(width);
};

const buildNodeMap = (roots: SessionTreeNode[]): Map<string, SessionTreeNode> => {
	const map = new Map<string, SessionTreeNode>();
	const stack = [...roots];
	while (stack.length > 0) {
		const node = stack.pop()!;
		map.set(node.entry.id, node);
		for (const child of node.children) stack.push(child);
	}
	return map;
};

/** Pre-order DFS index for chronological sorting of selected nodes */
const buildNodeOrder = (roots: SessionTreeNode[]): Map<string, number> => {
	const order = new Map<string, number>();
	let idx = 0;
	const visit = (nodes: SessionTreeNode[]) => {
		for (const node of nodes) {
			order.set(node.entry.id, idx++);
			visit(node.children);
		}
	};
	visit(roots);
	return order;
};

const buildLatestLabelTimestamps = (entries: SessionEntry[]): Map<string, string> => {
	const timestampsById = new Map<string, string>();
	for (const entry of entries) {
		if (entry.type !== "label") continue;
		if (entry.label) {
			timestampsById.set(entry.targetId, entry.timestamp);
		} else {
			timestampsById.delete(entry.targetId);
		}
	}
	return timestampsById;
};

const applyLabelTimestampsToTree = (roots: SessionTreeNode[], timestampsById: Map<string, string>): void => {
	const stack = [...roots];
	while (stack.length > 0) {
		const node = stack.pop()!;
		node.labelTimestamp = timestampsById.get(node.entry.id);
		for (const child of node.children) stack.push(child);
	}
};

const formatLabelTimestamp = (timestamp: string): string => {
	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) return timestamp;

	const now = new Date();
	const hours = date.getHours().toString().padStart(2, "0");
	const minutes = date.getMinutes().toString().padStart(2, "0");
	const time = `${hours}:${minutes}`;

	if (
		date.getFullYear() === now.getFullYear() &&
		date.getMonth() === now.getMonth() &&
		date.getDate() === now.getDate()
	) {
		return time;
	}

	const month = date.getMonth() + 1;
	const day = date.getDate();
	if (date.getFullYear() === now.getFullYear()) {
		return `${month}/${day} ${time}`;
	}

	const year = date.getFullYear().toString().slice(-2);
	return `${year}/${month}/${day} ${time}`;
};

const insertLabelTimestampIntoLine = (line: string, node: SessionTreeNode, theme: any): string => {
	if (!node.label || !node.labelTimestamp) return line;

	const labelToken = `[${node.label}] `;
	const labelIndex = line.indexOf(labelToken);
	if (labelIndex === -1) return line;

	const insertAt = labelIndex + labelToken.length;
	return `${line.slice(0, insertAt)}${theme.fg("muted", `${formatLabelTimestamp(node.labelTimestamp)} `)}${line.slice(insertAt)}`;
};

/** Clipboard text omits role prefix for a single node and includes it for multi-node copies
 * The preview pane is truncated for performance, while the clipboard copy is not
 */
const buildClipboardText = (nodes: SessionTreeNode[]): string => {
	if (nodes.length === 1) {
		return getEntryContent(nodes[0]!.entry);
	}

	return nodes
		.map((node) => {
			const label = getEntryRoleLabel(node.entry);
			const content = getEntryContent(node.entry);
			return `${label}:\n\n${content}`;
		})
		.join("\n\n---\n\n");
};

class anycopyOverlay implements Focusable {
	private selectedNodeIds = new Set<string>();
	private flashMessage: string | null = null;
	private flashTimer: ReturnType<typeof setTimeout> | null = null;
	private _focused = false;
	private previewScrollOffset = 0;
	private lastPreviewHeight = 0;
	private showLabelTimestamps = false;
	private previewCache: {
		entryId: string;
		width: number;
		bodyLines: string[];
		truncatedToMaxLines: boolean;
	} | null = null;

	constructor(
		private selector: TreeSelectorComponent,
		private getTree: () => SessionTreeNode[],
		private nodeById: Map<string, SessionTreeNode>,
		private keys: anycopyKeyConfig,
		private onExplicitFoldMutation: ((
			beforeTransientFoldedNodeIds: string[],
			afterTransientFoldedNodeIds: string[],
		) => void) | null,
		private onClose: () => void,
		private getTermHeight: () => number,
		private requestRender: () => void,
		private theme: any,
	) {}

	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.selector.focused = value;
	}

	getTreeList() {
		return this.selector.getTreeList();
	}

	handleInput(data: string): void {
		if (this.isEditingNodeLabel()) {
			this.selector.handleInput(data);
			this.requestRender();
			return;
		}

		if (matchesKey(data, this.keys.toggleSelect)) {
			this.toggleSelectedFocusedNode();
			return;
		}
		if (matchesKey(data, this.keys.copy)) {
			this.copySelectedOrFocusedNode();
			return;
		}
		if (matchesKey(data, this.keys.clear)) {
			this.clearSelection();
			return;
		}
		if (matchesKey(data, this.keys.toggleLabelTimestamps)) {
			this.showLabelTimestamps = !this.showLabelTimestamps;
			this.requestRender();
			return;
		}

		if (matchesKey(data, this.keys.scrollDown)) {
			this.previewScrollOffset += 1;
			this.requestRender();
			return;
		}
		if (matchesKey(data, this.keys.scrollUp)) {
			this.previewScrollOffset -= 1;
			this.requestRender();
			return;
		}
		if (matchesKey(data, this.keys.pageDown)) {
			const step = Math.max(1, (this.lastPreviewHeight > 0 ? this.lastPreviewHeight : 10) - 1);
			this.previewScrollOffset += step;
			this.requestRender();
			return;
		}
		if (matchesKey(data, this.keys.pageUp)) {
			const step = Math.max(1, (this.lastPreviewHeight > 0 ? this.lastPreviewHeight : 10) - 1);
			this.previewScrollOffset -= step;
			this.requestRender();
			return;
		}

		const keybindings = getKeybindings();
		const shouldTrackExplicitFoldMutation =
			this.onExplicitFoldMutation !== null &&
			(keybindings.matches(data, "app.tree.foldOrUp") || keybindings.matches(data, "app.tree.unfoldOrDown"));
		const beforeTransientFoldedNodeIds = shouldTrackExplicitFoldMutation ? getSelectorFoldedNodeIds(this.selector) : null;

		this.selector.handleInput(data);

		if (beforeTransientFoldedNodeIds) {
			this.onExplicitFoldMutation?.(beforeTransientFoldedNodeIds, getSelectorFoldedNodeIds(this.selector));
		}

		this.requestRender();
	}

	private isEditingNodeLabel(): boolean {
		return Boolean((this.selector as { labelInput?: unknown }).labelInput);
	}

	invalidate(): void {
		// Preview is derived from focused entry + width; invalidate forces recompute
		this.previewCache = null;
		this.previewScrollOffset = 0;
		this.lastPreviewHeight = 0;
		this.selector.invalidate();
	}

	private getFocusedNode(): SessionTreeNode | undefined {
		return this.selector.getTreeList().getSelectedNode();
	}

	private flash(message: string): void {
		this.flashMessage = message;
		if (this.flashTimer) clearTimeout(this.flashTimer);
		this.flashTimer = setTimeout(() => {
			this.flashMessage = null;
			this.flashTimer = null;
			this.requestRender();
		}, FLASH_DURATION_MS);
		this.requestRender();
	}

	toggleSelectedFocusedNode(): void {
		const focused = this.getFocusedNode();
		if (!focused) return;
		const id = focused.entry.id;
		if (this.selectedNodeIds.has(id)) {
			this.selectedNodeIds.delete(id);
			this.flash("Unselected node");
		} else {
			this.selectedNodeIds.add(id);
			this.flash(`Selected (${this.selectedNodeIds.size} ${pluralizeNode(this.selectedNodeIds.size)})`);
		}
	}

	clearSelection(): void {
		if (this.selectedNodeIds.size === 0) {
			this.flash("Selection already empty");
			return;
		}
		this.selectedNodeIds.clear();
		this.flash("Cleared selection");
	}

	isSelectedNode(id: string): boolean {
		return this.selectedNodeIds.has(id);
	}

	isShowingLabelTimestamps(): boolean {
		return this.showLabelTimestamps;
	}

	copySelectedOrFocusedNode(): void {
		const focused = this.getFocusedNode();
		const ids =
			this.selectedNodeIds.size > 0
				? [...this.selectedNodeIds]
				: focused
					? [focused.entry.id]
					: [];

		if (ids.length === 0) {
			this.flash("Nothing selected");
			return;
		}

		const tree = this.getTree();
		const nodeById = buildNodeMap(tree);
		const nodeOrder = buildNodeOrder(tree);
		const nodes = ids
			.map((id) => nodeById.get(id))
			.filter((n): n is SessionTreeNode => Boolean(n))
			.sort((a, b) => {
				const oa = nodeOrder.get(a.entry.id) ?? Infinity;
				const ob = nodeOrder.get(b.entry.id) ?? Infinity;
				return oa - ob;
			});

		copyToClipboard(buildClipboardText(nodes));
		this.flash(`Copied ${nodes.length} ${pluralizeNode(nodes.length)} to clipboard`);
	}

	private renderStatusBar(width: number): string[] {
		const lines: string[] = [];
		lines.push(truncateToWidth(this.theme.fg("dim", "─".repeat(width)), width));

		// Status only (selection count / flash)
		if (this.flashMessage) {
			lines.push(truncateToWidth(this.theme.fg("success", `  ${this.flashMessage}`), width));
		} else if (this.selectedNodeIds.size > 0) {
			lines.push(
				truncateToWidth(
					this.theme.fg(
						"accent",
						`  ${this.selectedNodeIds.size} selected ${pluralizeNode(this.selectedNodeIds.size)}`,
					),
					width,
				),
			);
		} else {
			lines.push("");
		}

		// Preview-scrolling hints belong above the preview pane
		const previewHint =
			`  ${formatKeyHint(this.keys.scrollUp)}/${formatKeyHint(this.keys.scrollDown)}: scroll` +
			` • ${formatKeyHint(this.keys.pageUp)}/${formatKeyHint(this.keys.pageDown)}: page`;
		lines.push(truncateToWidth(this.theme.fg("dim", previewHint), width));

		return lines;
	}

	private renderTreeHeaderHint(width: number): string {
		const hint =
			`   │ Enter: navigate` +
			` • ${formatKeyHint(this.keys.toggleSelect)}: select` +
			` • ${formatKeyHint(this.keys.copy)}: copy` +
			` • ${formatKeyHint(this.keys.clear)}: clear` +
			` • ${formatKeyHint(this.keys.toggleLabelTimestamps)}: label time` +
			` • Esc: close`;
		return truncateToWidth(this.theme.fg("dim", hint), width);
	}

	private renderPreview(width: number, height: number): string[] {
		if (height <= 0) return [];

		this.lastPreviewHeight = height;

		const focused = this.getFocusedNode();
		const lines: string[] = [];
		if (!focused) {
			lines.push(truncateToWidth(this.theme.fg("dim", "  (no node selected)"), width));
			while (lines.length < height) lines.push("");
			return lines;
		}

		const entryId = focused.entry.id;

		let bodyLines: string[];
		let truncatedToMaxLines: boolean;

		if (this.previewCache && this.previewCache.entryId === entryId && this.previewCache.width === width) {
			({ bodyLines, truncatedToMaxLines } = this.previewCache);
		} else {
			const content = getEntryContent(focused.entry);
			const clipped = clipTextForPreview(content);
			const rendered = renderPreviewBodyLines(clipped, focused.entry, width, this.theme, this.nodeById);

			truncatedToMaxLines = rendered.length > MAX_PREVIEW_LINES;
			bodyLines = rendered.slice(0, MAX_PREVIEW_LINES);

			this.previewCache = { entryId, width, bodyLines, truncatedToMaxLines };
			this.previewScrollOffset = 0;
		}

		// Clamp scroll offset based on available rendered lines
		const maxOffset = Math.max(0, bodyLines.length - height);
		this.previewScrollOffset = Math.max(0, Math.min(this.previewScrollOffset, maxOffset));

		const start = this.previewScrollOffset;
		const end = Math.min(bodyLines.length, start + height);
		let visible = bodyLines.slice(start, end);

		const above = start;
		const below = bodyLines.length - end;

		if (height > 0) {
			if (above > 0) {
				const indicator = truncateToWidth(this.theme.fg("muted", `… ${above} line(s) above`), width);
				visible = height === 1 ? [indicator] : [indicator, ...visible.slice(0, height - 1)];
			}

			if (below > 0) {
				const indicator = truncateToWidth(this.theme.fg("muted", `… ${below} more line(s)`), width);
				visible = height === 1 ? [indicator] : [...visible.slice(0, height - 1), indicator];
			} else if (truncatedToMaxLines) {
				const indicator = truncateToWidth(
					this.theme.fg("muted", `… [truncated to ${MAX_PREVIEW_LINES} lines]`),
					width,
				);
				visible = height === 1 ? [indicator] : [...visible.slice(0, height - 1), indicator];
			}
		}

		for (let i = 0; i < Math.min(height, visible.length); i += 1) {
			lines.push(visible[i] ?? "");
		}

		while (lines.length < height) lines.push("");
		return lines;
	}

	render(width: number): string[] {
		const height = this.getTermHeight();
		const output: string[] = [];

		const selectorLines = this.selector.render(width);
		const headerHint = this.renderTreeHeaderHint(width);

		// Inject action hints near the tree header (above the list)
		const insertAfter = Math.max(0, selectorLines.findIndex((l) => l.includes("Type to search")));
		if (selectorLines.length > 0) {
			const idx = insertAfter >= 0 ? insertAfter + 1 : 1;
			selectorLines.splice(Math.min(idx, selectorLines.length), 0, headerHint);
		}

		output.push(...selectorLines);
		output.push(...this.renderStatusBar(width));

		const previewHeight = Math.max(0, height - output.length);
		if (previewHeight > 0) {
			output.push(...this.renderPreview(width, previewHeight));
		}

		while (output.length < height) output.push("");
		if (output.length > height) output.length = height;
		return output;
	}

	dispose(): void {
		if (this.flashTimer) {
			clearTimeout(this.flashTimer);
			this.flashTimer = null;
		}
		this.previewCache = null;
		this.previewScrollOffset = 0;
		this.lastPreviewHeight = 0;
		this.nodeById.clear();
	}
}

export default function anycopyExtension(pi: ExtensionAPI) {
	const config = loadConfig();
	const keys = config.keys;
	const treeFilterMode = config.treeFilterMode;
	const persistFoldState = config.persistFoldState;

	const openAnycopy = async (
		ctx: ExtensionCommandContext,
		opts?: { initialSelectedId?: string },
	) => {
		if (!ctx.hasUI) return;

		const buildAnnotatedTree = (): SessionTreeNode[] => {
			const tree = ctx.sessionManager.getTree() as SessionTreeNode[];
			applyLabelTimestampsToTree(tree, buildLatestLabelTimestamps(ctx.sessionManager.getEntries() as SessionEntry[]));
			return tree;
		};

		const initialTree = buildAnnotatedTree();
		if (initialTree.length === 0) {
			ctx.ui.notify("No entries in session", "warning");
			return;
		}

		const getTree = () => buildAnnotatedTree();
		const refreshInitialTreeLabelTimestamps = () => {
			applyLabelTimestampsToTree(initialTree, buildLatestLabelTimestamps(ctx.sessionManager.getEntries() as SessionEntry[]));
		};
		const currentLeafId = ctx.sessionManager.getLeafId();
		const skipSummaryPrompt = loadBranchSummarySkipPrompt(ctx.cwd);

		await ctx.ui.custom<void>((tui, theme, _kb, done) => {
			const termRows = tui.terminal?.rows ?? 40;
			const treeTermHeight = Math.floor(termRows * 0.65);
			const nodeById = buildNodeMap(initialTree);
			const validNodeIds = new Set(nodeById.keys());
			const restoredFoldState = persistFoldState
				? loadLatestFoldStateFromEntries(ctx.sessionManager.getEntries() as SessionEntry[], validNodeIds)
				: null;
			let durableFoldedNodeIds = restoredFoldState?.foldedNodeIds ?? [];
			let lastPersistedFoldedNodeIds = durableFoldedNodeIds;

			const selector = new TreeSelectorComponent(
				initialTree,
				currentLeafId,
				treeTermHeight,
				(entryId) => {
					void runAnycopyEnterNavigation({
						entryId,
						effectiveLeafIdForNoop,
						skipSummaryPrompt,
						close: done,
						reopen: (reopenOpts) => {
							void openAnycopy(ctx, reopenOpts);
						},
						navigateTree: async (targetId, options) => ctx.navigateTree(targetId, options),
						ui: {
							select: (title, options) => ctx.ui.select(title, options),
							editor: (title) => ctx.ui.editor(title),
							setStatus: (source, message) => ctx.ui.setStatus(source, message),
							setWorkingMessage: (message) => ctx.ui.setWorkingMessage(message),
							notify: (message, level) => ctx.ui.notify(message, level),
						},
					});
				},
				() => done(),
				(entryId, label) => {
					pi.setLabel(entryId, label);
					refreshInitialTreeLabelTimestamps();
				},
				opts?.initialSelectedId,
				treeFilterMode,
			);

			if (persistFoldState) {
				const restoredFoldedNodeIds = normalizeFoldedNodeIds(
					setSelectorFoldedNodeIds(selector, durableFoldedNodeIds),
					validNodeIds,
				);
				durableFoldedNodeIds = restoredFoldedNodeIds;
				lastPersistedFoldedNodeIds = restoredFoldedNodeIds;
			}

			const persistDurableFoldState = (nextDurableFoldedNodeIds: string[]): void => {
				if (!persistFoldState || foldStateNodeIdListsEqual(nextDurableFoldedNodeIds, lastPersistedFoldedNodeIds)) {
					return;
				}

				try {
					pi.appendEntry(
						ANYCOPY_FOLD_STATE_CUSTOM_TYPE,
						createFoldStateEntryData(nextDurableFoldedNodeIds, validNodeIds),
					);
					lastPersistedFoldedNodeIds = nextDurableFoldedNodeIds;
				} catch (error) {
					ctx.ui.notify(
						error instanceof Error ? error.message : "Failed to persist /anycopy fold state",
						"error",
					);
				}
			};

			const handleExplicitFoldMutation = (
				beforeTransientFoldedNodeIds: string[],
				afterTransientFoldedNodeIds: string[],
			): void => {
				const nextDurableFoldedNodeIds = mergeExplicitFoldMutation({
					durableFoldedNodeIds,
					beforeTransientFoldedNodeIds,
					afterTransientFoldedNodeIds,
					validNodeIds,
				});
				if (foldStateNodeIdListsEqual(nextDurableFoldedNodeIds, durableFoldedNodeIds)) {
					return;
				}

				durableFoldedNodeIds = nextDurableFoldedNodeIds;
				persistDurableFoldState(nextDurableFoldedNodeIds);
			};

			const effectiveLeafIdForNoop = selector.getTreeList().getSelectedNode()?.entry.id ?? currentLeafId;
			const overlay = new anycopyOverlay(
				selector,
				getTree,
				nodeById,
				keys,
				persistFoldState ? handleExplicitFoldMutation : null,
				() => done(),
				() => tui.terminal?.rows ?? 40,
				() => tui.requestRender(),
				theme,
			);

			const treeList = selector.getTreeList();
			const originalRender = treeList.render.bind(treeList);
			treeList.render = (width: number) => {
				const innerWidth = Math.max(10, width - 2);
				const lines = originalRender(innerWidth);

				const tl = treeList as any;
				const filteredRaw = tl.filteredNodes;
				const decorateStatusLine = (line: string): string => {
					const status = overlay.isShowingLabelTimestamps() ? `${line}${theme.fg("muted", " [+label time]")}` : line;
					return truncateToWidth(`  ${status}`, width);
				};

				if (!Array.isArray(filteredRaw) || filteredRaw.length === 0) {
					return lines.map((line: string, i: number) =>
						i === lines.length - 1 ? decorateStatusLine(line) : truncateToWidth(`  ${line}`, width),
					);
				}
				const filtered = filteredRaw as { node: SessionTreeNode }[];

				const selectedIdxRaw = tl.selectedIndex;
				const maxVisibleRaw = tl.maxVisibleLines;
				const selectedIdx =
					typeof selectedIdxRaw === "number" && Number.isFinite(selectedIdxRaw) ? selectedIdxRaw : 0;
				const maxVisible =
					typeof maxVisibleRaw === "number" && Number.isFinite(maxVisibleRaw) && maxVisibleRaw > 0
						? maxVisibleRaw
						: filtered.length;

				const startIdx = Math.max(
					0,
					Math.min(selectedIdx - Math.floor(maxVisible / 2), filtered.length - maxVisible),
				);
				const treeRowCount = Math.max(0, lines.length - 1);

				return lines.map((line: string, i: number) => {
					if (i >= treeRowCount) return decorateStatusLine(line);

					const nodeIdx = startIdx + i;
					const node = filtered[nodeIdx]?.node as SessionTreeNode | undefined;
					const nodeId = node?.entry?.id;
					if (typeof nodeId !== "string") return truncateToWidth(`  ${line}`, width);

					const selected = overlay.isSelectedNode(nodeId);
					const marker = selected ? theme.fg("success", "✓ ") : theme.fg("dim", "○ ");
					const lineWithTimestamp =
						overlay.isShowingLabelTimestamps() && node ? insertLabelTimestampIntoLine(line, node, theme) : line;
					return truncateToWidth(marker + lineWithTimestamp, width);
				});
			};

			tui.setFocus?.(overlay);
			return overlay;
		});
	};

	pi.registerCommand("anycopy", {
		description: "Browse session tree with preview and copy any node(s) to clipboard",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			await openAnycopy(ctx);
		},
	});
}
