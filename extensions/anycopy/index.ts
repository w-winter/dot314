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
 *   Shift+Ctrl+T - toggle entry-created timestamps for visible tree rows
 *   Shift+↑/↓ - scroll preview
 *   Shift+PageUp/PageDown - page preview
 *   Esc       - close
 */

import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	copyToClipboard,
	getLanguageFromPath,
	getMarkdownTheme,
	highlightCode,
	TreeSelectorComponent,
} from "@earendil-works/pi-coding-agent";

import {
	getKeybindings,
	Markdown,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { Focusable } from "@earendil-works/pi-tui";

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { createAnycopyEnterNavigationLauncher, runAnycopyEnterNavigation } from "./enter-navigation.ts";
import { getPreviewWindow } from "./preview-window.ts";
import { formatCompactTimestamp, getEntryTimestampMs } from "./timestamps.ts";
import { buildNodeOrder } from "./tree-order.ts";
import { getAnycopyRenderHeight } from "./viewport-layout.ts";
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
};

type anycopyTreeList = ReturnType<TreeSelectorComponent["getTreeList"]>;

type anycopyTreeListInternals = {
	filteredNodes: Array<{ node: SessionTreeNode }>;
	selectedIndex: number;
	maxVisibleLines: number;
	showLabelTimestamps: boolean;
};

type MatchesKeyId = Parameters<typeof matchesKey>[1];

type anycopyKeyConfig = {
	toggleSelect: string;
	copy: string;
	clear: string;
	toggleLabelTimestamps: string;
	toggleEntryTimestamps: string;
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
	toggleEntryTimestamps: "shift+ctrl+t",
	scrollDown: "shift+down",
	scrollUp: "shift+up",
	pageDown: "shift+pagedown",
	pageUp: "shift+pageup",
};

const DEFAULT_TREE_FILTER_MODE: TreeFilterMode = "default";
const DEFAULT_PERSIST_FOLD_STATE = true;

const getExtensionDir = (): string => {
	// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
	if (typeof __dirname !== "undefined") return __dirname;
	// @ts-ignore import.meta is available in Pi's ESM extension runtime; the standalone verifier also checks CJS output.
	return dirname(fileURLToPath(import.meta.url));
};

const getAgentDir = (): string => process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");

const readJsonFile = <T>(path: string): T | undefined => {
	if (!existsSync(path)) return undefined;
	return JSON.parse(readFileSync(path, "utf8")) as T;
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
	const parsed = readJsonFile<anycopyConfig>(configPath);
	if (!parsed) {
		return {
			keys: { ...DEFAULT_KEYS },
			treeFilterMode: DEFAULT_TREE_FILTER_MODE,
			persistFoldState: DEFAULT_PERSIST_FOLD_STATE,
		};
	}

	const keys: anycopyKeyConfig = { ...DEFAULT_KEYS };
	if (parsed.keys) {
		for (const key of Object.keys(DEFAULT_KEYS) as Array<keyof anycopyKeyConfig>) {
			const value = parsed.keys[key];
			if (typeof value === "string") keys[key] = value;
		}
	}

	const validTreeFilterModes: TreeFilterMode[] = ["default", "no-tools", "user-only", "labeled-only", "all"];
	const treeFilterMode =
		typeof parsed.treeFilterMode === "string" && validTreeFilterModes.includes(parsed.treeFilterMode as TreeFilterMode)
			? (parsed.treeFilterMode as TreeFilterMode)
			: DEFAULT_TREE_FILTER_MODE;
	const persistFoldState =
		typeof parsed.persistFoldState === "boolean" ? parsed.persistFoldState : DEFAULT_PERSIST_FOLD_STATE;

	return { keys, treeFilterMode, persistFoldState };
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

const getTreeListInternals = (treeList: anycopyTreeList): anycopyTreeListInternals => {
	return treeList as unknown as anycopyTreeListInternals;
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
	private showEntryTimestamps = false;
	private flashMessage: string | null = null;
	private flashTimer: ReturnType<typeof setTimeout> | null = null;
	private _focused = false;
	private previewScrollOffset = 0;
	private lastPreviewHeight = 0;
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
		private getRenderHeight: () => number,
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

	private getTreeListInternals(): anycopyTreeListInternals {
		return getTreeListInternals(this.selector.getTreeList());
	}

	handleInput(data: string): void {
		if (this.isEditingNodeLabel()) {
			this.selector.handleInput(data);
			this.requestRender();
			return;
		}

		if (matchesKey(data, this.keys.toggleSelect as MatchesKeyId)) {
			this.toggleSelectedFocusedNode();
			return;
		}
		if (matchesKey(data, this.keys.copy as MatchesKeyId)) {
			this.copySelectedOrFocusedNode();
			return;
		}
		if (matchesKey(data, this.keys.clear as MatchesKeyId)) {
			this.clearSelection();
			return;
		}
		if (matchesKey(data, this.keys.toggleLabelTimestamps as MatchesKeyId)) {
			const treeList = this.getTreeListInternals();
			treeList.showLabelTimestamps = !treeList.showLabelTimestamps;
			this.requestRender();
			return;
		}
		if (matchesKey(data, this.keys.toggleEntryTimestamps as MatchesKeyId)) {
			this.showEntryTimestamps = !this.showEntryTimestamps;
			this.requestRender();
			return;
		}

		const keybindings = getKeybindings();
		if (keybindings.matches(data, "app.tree.toggleLabelTimestamp")) {
			return;
		}

		if (matchesKey(data, this.keys.scrollDown as MatchesKeyId)) {
			this.previewScrollOffset += 1;
			this.requestRender();
			return;
		}
		if (matchesKey(data, this.keys.scrollUp as MatchesKeyId)) {
			this.previewScrollOffset -= 1;
			this.requestRender();
			return;
		}
		if (matchesKey(data, this.keys.pageDown as MatchesKeyId)) {
			const step = Math.max(1, (this.lastPreviewHeight > 0 ? this.lastPreviewHeight : 10) - 1);
			this.previewScrollOffset += step;
			this.requestRender();
			return;
		}
		if (matchesKey(data, this.keys.pageUp as MatchesKeyId)) {
			const step = Math.max(1, (this.lastPreviewHeight > 0 ? this.lastPreviewHeight : 10) - 1);
			this.previewScrollOffset -= step;
			this.requestRender();
			return;
		}

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
		return Boolean((this.selector as unknown as { labelInput?: unknown }).labelInput);
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

	shouldShowEntryTimestamps(): boolean {
		return this.showEntryTimestamps;
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

		// Keep transient/selection status compact; omit the row entirely when idle.
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
		}

		const compactKey = (key: string): string =>
			formatKeyHint(key)
				.replace(/^Shift(?=\+)/i, "S")
				.replace(/\+Ctrl(?=\+|$)/gi, "+C")
				.replace(/\+Alt(?=\+|$)/gi, "+A");
		const hint =
			`  ${compactKey(this.keys.scrollUp)}/${compactKey(this.keys.scrollDown)}: scroll` +
			` · ${compactKey(this.keys.pageUp)}/${compactKey(this.keys.pageDown)}: page` +
			` · Enter: navigate` +
			` · ${compactKey(this.keys.toggleSelect)}: select` +
			` · ${compactKey(this.keys.copy)}: copy` +
			` · ${compactKey(this.keys.clear)}: clear` +
			` · ${compactKey(this.keys.toggleEntryTimestamps)}: entry time`;
		lines.push(truncateToWidth(this.theme.fg("dim", hint), width));

		return lines;
	}

	private renderPreviewDivider(width: number, message?: string): string {
		const label = message ? ` ${message} ` : "";
		const ruleWidth = Math.max(0, width - visibleWidth(label) - 1);
		return truncateToWidth(this.theme.fg("dim", `─${label}${"─".repeat(ruleWidth)}`), width);
	}

	private getPreviewBody(width: number): { bodyLines: string[]; truncatedToMaxLines: boolean } | null {
		const focused = this.getFocusedNode();
		if (!focused) return null;

		const entryId = focused.entry.id;
		if (this.previewCache && this.previewCache.entryId === entryId && this.previewCache.width === width) {
			return this.previewCache;
		}

		const content = getEntryContent(focused.entry);
		const clipped = clipTextForPreview(content);
		const rendered = renderPreviewBodyLines(clipped, focused.entry, width, this.theme, this.nodeById);
		const preview = {
			entryId,
			width,
			bodyLines: rendered.slice(0, MAX_PREVIEW_LINES),
			truncatedToMaxLines: rendered.length > MAX_PREVIEW_LINES,
		};

		this.previewCache = preview;
		this.previewScrollOffset = 0;
		return preview;
	}

	private renderPreview(width: number, height: number): string[] {
		if (height <= 0) return [];

		this.lastPreviewHeight = height;

		const preview = this.getPreviewBody(width);
		const lines: string[] = [];
		if (!preview) {
			lines.push(truncateToWidth(this.theme.fg("dim", "  (no node selected)"), width));
			while (lines.length < height) lines.push("");
			return lines;
		}

		const bodyLines = [...preview.bodyLines];
		if (preview.truncatedToMaxLines) {
			bodyLines.push(
				truncateToWidth(this.theme.fg("muted", `… [truncated to ${MAX_PREVIEW_LINES} lines]`), width),
			);
		}

		const window = getPreviewWindow(bodyLines.length, height, this.previewScrollOffset);
		this.previewScrollOffset = window.start;

		if (height === 1) {
			const hidden = Math.max(window.above, window.below);
			return [this.renderPreviewDivider(width, hidden > 0 ? `… ${hidden} line(s)` : undefined)];
		}

		lines.push(
			this.renderPreviewDivider(
				width,
				window.above > 0 ? `… ${window.above} line(s) above` : undefined,
			),
		);
		lines.push(...bodyLines.slice(window.start, window.end));
		lines.push(
			this.renderPreviewDivider(
				width,
				window.below > 0 ? `… ${window.below} line(s) below` : undefined,
			),
		);

		while (lines.length < height) lines.splice(lines.length - 1, 0, "");
		if (lines.length > height) lines.length = height;
		return lines;
	}

	render(width: number): string[] {
		const height = this.getRenderHeight();
		const output: string[] = [];

		const selectorLines = this.selector.render(width);
		const searchLineIndex = selectorLines.findIndex((line) => line.includes("Type to search"));
		const listStartIndex = searchLineIndex >= 0 ? searchLineIndex + 2 : -1;
		if (listStartIndex >= 0 && visibleWidth(selectorLines[listStartIndex] ?? "") === 0) {
			selectorLines.splice(listStartIndex, 1);
		}
		while (selectorLines.length > 1 && visibleWidth(selectorLines.at(-2) ?? "") === 0) {
			selectorLines.splice(selectorLines.length - 2, 1);
		}
		while (selectorLines.length > 0 && visibleWidth(selectorLines.at(-1) ?? "") === 0) {
			selectorLines.pop();
		}

		output.push(...selectorLines);
		output.push(...this.renderStatusBar(width));

		const contentHeight = height;
		const previewHeight = Math.max(0, contentHeight - output.length);
		if (previewHeight > 0) {
			output.push(...this.renderPreview(width, previewHeight));
		}

		while (output.length < contentHeight) output.push("");
		if (output.length > contentHeight) output.length = contentHeight;
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

		const initialTree = ctx.sessionManager.getTree() as SessionTreeNode[];
		if (initialTree.length === 0) {
			ctx.ui.notify("No entries in session", "warning");
			return;
		}

		const getTree = () => ctx.sessionManager.getTree() as SessionTreeNode[];
		const currentLeafId = ctx.sessionManager.getLeafId();
		const skipSummaryPrompt = loadBranchSummarySkipPrompt(ctx.cwd);
		let overlayHandle: { focus(): void; unfocus(): void } | undefined;

		await ctx.ui.custom<void>((tui, theme, _kb, done) => {
			let closed = false;
			const closeOverlay = (): void => {
				if (closed) return;
				closed = true;
				overlayHandle?.unfocus();
				done();
			};
			const getRenderHeight = (): number => getAnycopyRenderHeight(tui.terminal?.rows ?? 40);
			const treeTermHeight = Math.floor(getRenderHeight() * 0.65);
			const nodeById = buildNodeMap(initialTree);
			const validNodeIds = new Set(nodeById.keys());
			const restoredFoldState = persistFoldState
				? loadLatestFoldStateFromEntries(ctx.sessionManager.getEntries() as SessionEntry[], validNodeIds)
				: null;
			let durableFoldedNodeIds = restoredFoldState?.foldedNodeIds ?? [];
			let lastPersistedFoldedNodeIds = durableFoldedNodeIds;
			const currentLeafIdForNoop = currentLeafId;

			const startEnterNavigation = createAnycopyEnterNavigationLauncher(async (entryId) =>
				runAnycopyEnterNavigation({
					entryId,
					currentLeafIdForNoop,
					skipSummaryPrompt,
					close: closeOverlay,
					reopen: (reopenOpts) => {
						void openAnycopy(ctx, reopenOpts);
					},
					navigateTree: async (targetId, options) => ctx.navigateTree(targetId, options),
					ui: {
						select: async (title, options) =>
							(await ctx.ui.select(title, options)) as (typeof options)[number] | undefined,
						editor: (title) => ctx.ui.editor(title),
						setStatus: (source, message) => ctx.ui.setStatus(source, message),
						setWorkingMessage: (message) => ctx.ui.setWorkingMessage(message),
						notify: (message, level) => ctx.ui.notify(message, level),
					},
				}),
			);

			const selector = new TreeSelectorComponent(
				initialTree,
				currentLeafId,
				treeTermHeight,
				startEnterNavigation,
				closeOverlay,
				(entryId, label) => {
					pi.setLabel(entryId, label);
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

			const overlay = new anycopyOverlay(
				selector,
				getTree,
				nodeById,
				keys,
				persistFoldState ? handleExplicitFoldMutation : null,
				getRenderHeight,
				() => tui.requestRender(),
				theme,
			);

			const treeList = selector.getTreeList();
			const treeListInternals = getTreeListInternals(treeList);
			const originalRender = treeList.render.bind(treeList);
			treeList.render = (width: number) => {
				const innerWidth = Math.max(10, width - 2);
				const lines = originalRender(innerWidth);
				const filtered = treeListInternals.filteredNodes;

				if (!Array.isArray(filtered) || filtered.length === 0) {
					return lines.map((line: string) => truncateToWidth(`  ${line}`, width));
				}

				const maxVisible = Math.max(1, treeListInternals.maxVisibleLines);
				const startIdx = Math.max(
					0,
					Math.min(treeListInternals.selectedIndex - Math.floor(maxVisible / 2), filtered.length - maxVisible),
				);
				const treeRowCount = Math.max(0, lines.length - 1);
				const nowMs = Date.now();
				const appendEntryTimestamp = (lineWithMarker: string, entry: SessionEntry): string => {
					if (!overlay.shouldShowEntryTimestamps()) return truncateToWidth(lineWithMarker, width);

					const timestampMs = getEntryTimestampMs(entry);
					if (timestampMs === null) return truncateToWidth(lineWithMarker, width);

					const timestamp = formatCompactTimestamp(timestampMs, nowMs);
					const timestampWidth = visibleWidth(timestamp);
					const contentWidth = Math.max(0, width - timestampWidth - 1);
					const truncatedContent = truncateToWidth(lineWithMarker, contentWidth);
					const padding = Math.max(1, width - visibleWidth(truncatedContent) - timestampWidth);

					return truncateToWidth(
						truncatedContent + " ".repeat(padding) + theme.fg("muted", timestamp),
						width,
					);
				};

				return lines.map((line: string, i: number) => {
					if (i >= treeRowCount) return truncateToWidth(`  ${line}`, width);

					const entry = filtered[startIdx + i]?.node.entry;
					if (typeof entry?.id !== "string") return truncateToWidth(`  ${line}`, width);

					const marker = overlay.isSelectedNode(entry.id)
						? theme.fg("success", "✓ ")
						: theme.fg("dim", "○ ");
					return appendEntryTimestamp(marker + line, entry);
				});
			};

			return overlay;
		}, {
			overlay: true,
			overlayOptions: {
				anchor: "top-left",
				width: "100%",
				maxHeight: "100%",
				margin: 0,
			},
			onHandle: (handle) => {
				overlayHandle = handle;
				handle.focus();
			},
		});
	};

	pi.registerCommand("anycopy", {
		description: "Browse session tree with preview and copy any node(s) to clipboard",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			await openAnycopy(ctx);
		},
	});
}
