/**
 * anycopy — browse session tree nodes with preview and copy any of them
 *
 * Layout: native TreeSelectorComponent at top, status bar, preview below
 *
 * Default keys (customizable via ./config.json):
 *   Shift+A   - select/unselect focused node for copy
 *   Shift+C   - copy selected nodes (or focused node if none selected)
 *   Shift+X   - clear selection
 *   Shift+R   - start/finish inclusive range selection
 *   Tab       - toggle tree-focused and preview-focused layouts
 *   Shift+L   - label node
 *   Shift+T   - toggle label timestamps for labeled nodes
 *   Shift+Ctrl+T - toggle entry-created timestamps for visible tree rows
 *   Shift+↑/↓ - scroll preview
 *   Shift+PageUp/PageDown - page preview
 *   ?         - show effective native tree and anycopy actions
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
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { Focusable } from "@earendil-works/pi-tui";

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { createAnycopyEnterNavigationLauncher, runAnycopyEnterNavigation } from "./enter-navigation.ts";
import { AnycopyKeyHelp } from "./key-help.ts";
import { formatConfiguredKey, getKeyHelpPreferredWidth, type KeyHelpRow } from "./key-help-data.ts";
import { applyInclusiveRangeSelection, togglePaneFocus, type PaneFocus } from "./interaction-state.ts";
import { getPreviewPageStep, getPreviewWindow } from "./preview-window.ts";
import { renderStatusHints } from "./status-hints.ts";
import { formatCompactTimestamp, getEntryTimestampMs } from "./timestamps.ts";
import { formatToolCallResultForClipboard, getToolName, resolveToolCallFromParents } from "./tool-call-copy.ts";
import { buildNodeOrder } from "./tree-order.ts";
import {
	getAnycopyRenderHeight,
	getAnycopyTreeHeight,
	getAnycopyTreeVisibleLines,
	type PaneLayoutRatios,
} from "./viewport-layout.ts";
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
	togglePaneFocus: string;
	toggleRangeSelection: string;
	help: string;
};

type TreeFilterMode = "default" | "no-tools" | "user-only" | "labeled-only" | "all";

type anycopyConfig = {
	keys?: Partial<anycopyKeyConfig>;
	layout?: {
		treeFocusTreeRatio?: number;
		previewFocusTreeRatio?: number;
	};
	treeFilterMode?: TreeFilterMode;
	persistFoldState?: boolean;
};

type anycopyRuntimeConfig = {
	keys: anycopyKeyConfig;
	layoutRatios: PaneLayoutRatios;
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
	togglePaneFocus: "tab",
	toggleRangeSelection: "shift+r",
	help: "?",
};

const DEFAULT_LAYOUT_RATIOS: PaneLayoutRatios = { tree: 0.85, preview: 0.15 };
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
			layoutRatios: { ...DEFAULT_LAYOUT_RATIOS },
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
	const normalizeRatio = (value: unknown, fallback: number): number =>
		typeof value === "number" && Number.isFinite(value) && value > 0 && value < 1 ? value : fallback;
	const layoutRatios: PaneLayoutRatios = {
		tree: normalizeRatio(parsed.layout?.treeFocusTreeRatio, DEFAULT_LAYOUT_RATIOS.tree),
		preview: normalizeRatio(parsed.layout?.previewFocusTreeRatio, DEFAULT_LAYOUT_RATIOS.preview),
	};

	return { keys, layoutRatios, treeFilterMode, persistFoldState };
};

const pluralizeNode = (count: number): string => (count === 1 ? "node" : "nodes");

const MAX_PREVIEW_CHARS = 7000;
const MAX_PREVIEW_LINES = 200;
const FLASH_DURATION_MS = 2000;
const TREE_SELECTOR_PROBE_ROWS = 1;

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

const resolveReadToolLanguageFromParents = (
	entry: SessionEntry,
	nodeById: Map<string, SessionTreeNode>,
): string | undefined => {
	if (getToolName(entry) !== "read") return undefined;

	const args = resolveToolCallFromParents(entry, nodeById)?.arguments;
	if (!args) return undefined;

	const rawPath = args.file_path ?? args.path;
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

type EffectiveKeybindings = ReturnType<typeof getKeybindings>;
type EffectiveKeybindingId = Parameters<EffectiveKeybindings["getKeys"]>[0];

const getEffectiveKeys = (keybindings: EffectiveKeybindings, ...ids: string[]): string[] =>
	[...new Set(ids.flatMap((id) => keybindings.getKeys(id as EffectiveKeybindingId).map(String)))];

const buildKeyHelpRows = (
	keybindings: EffectiveKeybindings,
	keys: anycopyKeyConfig,
): KeyHelpRow[] => [
	{ keys: getEffectiveKeys(keybindings, "tui.select.up"), label: "move up" },
	{ keys: getEffectiveKeys(keybindings, "tui.select.down"), label: "move down" },
	{ keys: getEffectiveKeys(keybindings, "tui.editor.cursorLeft", "tui.select.pageUp"), label: "page tree up" },
	{ keys: getEffectiveKeys(keybindings, "tui.editor.cursorRight", "tui.select.pageDown"), label: "page tree down" },
	{ keys: getEffectiveKeys(keybindings, "app.tree.foldOrUp"), label: "fold branch or jump up" },
	{ keys: getEffectiveKeys(keybindings, "app.tree.unfoldOrDown"), label: "unfold branch or jump down" },
	{ keys: getEffectiveKeys(keybindings, "tui.select.confirm"), label: "navigate to focused node" },
	{ keys: getEffectiveKeys(keybindings, "tui.select.cancel"), label: "clear search or close" },
	{ keys: getEffectiveKeys(keybindings, "tui.editor.deleteCharBackward"), label: "delete search character" },
	{ keys: getEffectiveKeys(keybindings, "app.tree.editLabel"), label: "edit label" },
	{ keys: getEffectiveKeys(keybindings, "app.tree.filter.default"), label: "use default filter" },
	{ keys: getEffectiveKeys(keybindings, "app.tree.filter.noTools"), label: "toggle no-tools filter" },
	{ keys: getEffectiveKeys(keybindings, "app.tree.filter.userOnly"), label: "toggle user-only filter" },
	{ keys: getEffectiveKeys(keybindings, "app.tree.filter.labeledOnly"), label: "toggle labeled-only filter" },
	{ keys: getEffectiveKeys(keybindings, "app.tree.filter.all"), label: "toggle all-entries filter" },
	{ keys: getEffectiveKeys(keybindings, "app.tree.filter.cycleForward"), label: "cycle filter forward" },
	{ keys: getEffectiveKeys(keybindings, "app.tree.filter.cycleBackward"), label: "cycle filter backward" },
	{ keys: ["printable text"], label: "search visible nodes" },
	{ keys: [keys.toggleSelect], label: "toggle focused node selection" },
	{ keys: [keys.toggleRangeSelection], label: "start or finish range selection" },
	{ keys: [keys.copy], label: "copy focused or selected nodes" },
	{ keys: [keys.clear], label: "clear selection" },
	{ keys: [keys.togglePaneFocus], label: "toggle tree or preview focus" },
	{ keys: [keys.scrollUp, keys.scrollDown], label: "scroll preview" },
	{ keys: [keys.pageUp, keys.pageDown], label: "page preview" },
	{ keys: [keys.toggleLabelTimestamps], label: "toggle label timestamps" },
	{ keys: [keys.toggleEntryTimestamps], label: "toggle entry timestamps" },
	{ keys: [keys.help], label: "show or close this help" },
];

/** Clipboard text omits role prefix for a single node and includes it for multi-node copies
 * The preview pane is truncated for performance, while the clipboard copy is not
 */
const buildClipboardText = (
	nodes: SessionTreeNode[],
	nodeById: ReadonlyMap<string, SessionTreeNode>,
): string => {
	const formatNode = (node: SessionTreeNode, includeRole: boolean): string => {
		const toolPair = formatToolCallResultForClipboard(node.entry, nodeById);
		if (toolPair) return toolPair;
		const content = getEntryContent(node.entry);
		return includeRole ? `${getEntryRoleLabel(node.entry)}:\n\n${content}` : content;
	};
	if (nodes.length === 1) return formatNode(nodes[0]!, false);
	return nodes.map((node) => formatNode(node, true)).join("\n\n---\n\n");
};

class anycopyOverlay implements Focusable {
	private selectedNodeIds = new Set<string>();
	private paneFocus: PaneFocus = "tree";
	private rangeSelection: { anchorId: string; baselineIds: Set<string> } | null = null;
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
		private layoutRatios: PaneLayoutRatios,
		private openHelp: () => void,
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

		if (matchesKey(data, this.keys.help as MatchesKeyId)) {
			this.openHelp();
			return;
		}
		if (matchesKey(data, this.keys.togglePaneFocus as MatchesKeyId)) {
			this.paneFocus = togglePaneFocus(this.paneFocus);
			this.lastPreviewHeight = 0;
			this.flash(this.paneFocus === "tree" ? "Tree-focused layout" : "Preview-focused layout");
			return;
		}
		if (matchesKey(data, this.keys.toggleRangeSelection as MatchesKeyId)) {
			this.toggleRangeSelection();
			return;
		}
		if (matchesKey(data, this.keys.toggleSelect as MatchesKeyId)) {
			this.rangeSelection = null;
			this.toggleSelectedFocusedNode();
			return;
		}
		if (matchesKey(data, this.keys.copy as MatchesKeyId)) {
			this.rangeSelection = null;
			this.copySelectedOrFocusedNode();
			return;
		}
		if (matchesKey(data, this.keys.clear as MatchesKeyId)) {
			this.rangeSelection = null;
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
			const step = getPreviewPageStep(this.lastPreviewHeight > 0 ? this.lastPreviewHeight : 10);
			this.previewScrollOffset += step;
			this.requestRender();
			return;
		}
		if (matchesKey(data, this.keys.pageUp as MatchesKeyId)) {
			const step = getPreviewPageStep(this.lastPreviewHeight > 0 ? this.lastPreviewHeight : 10);
			this.previewScrollOffset -= step;
			this.requestRender();
			return;
		}

		const beforeVisibleIds = this.getVisibleFilteredNodeIds();
		const beforeFocusedId = this.getFocusedNode()?.entry.id;
		const shouldTrackExplicitFoldMutation =
			this.onExplicitFoldMutation !== null &&
			(keybindings.matches(data, "app.tree.foldOrUp") || keybindings.matches(data, "app.tree.unfoldOrDown"));
		const beforeTransientFoldedNodeIds = shouldTrackExplicitFoldMutation ? getSelectorFoldedNodeIds(this.selector) : null;

		this.selector.handleInput(data);

		const afterVisibleIds = this.getVisibleFilteredNodeIds();
		const visibleRowsChanged = beforeVisibleIds.length !== afterVisibleIds.length ||
			beforeVisibleIds.some((id, index) => id !== afterVisibleIds[index]);
		if (visibleRowsChanged) {
			this.rangeSelection = null;
		} else if (this.rangeSelection) {
			const focusedId = this.getFocusedNode()?.entry.id;
			if (focusedId && focusedId !== beforeFocusedId) {
				this.selectedNodeIds = applyInclusiveRangeSelection(
					this.rangeSelection.baselineIds,
					afterVisibleIds,
					this.rangeSelection.anchorId,
					focusedId,
				);
			}
		}

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

	private getVisibleFilteredNodeIds(): string[] {
		return this.getTreeListInternals().filteredNodes
			.map(({ node }) => node.entry.id)
			.filter((id): id is string => typeof id === "string");
	}

	private toggleRangeSelection(): void {
		if (this.rangeSelection) {
			this.rangeSelection = null;
			this.flash(`Range selected (${this.selectedNodeIds.size} ${pluralizeNode(this.selectedNodeIds.size)})`);
			return;
		}
		const focused = this.getFocusedNode();
		if (!focused) return;
		const anchorId = focused.entry.id;
		const baselineIds = new Set(this.selectedNodeIds);
		this.rangeSelection = { anchorId, baselineIds };
		this.selectedNodeIds = applyInclusiveRangeSelection(
			baselineIds,
			this.getVisibleFilteredNodeIds(),
			anchorId,
			anchorId,
		);
		this.flash("Range toggle active, move to extend");
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

		copyToClipboard(buildClipboardText(nodes, nodeById));
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

		const key = formatConfiguredKey;
		lines.push(
			...renderStatusHints(
				[
					`${key(this.keys.scrollUp)}/${key(this.keys.scrollDown)}: scroll preview`,
					`${key(this.keys.pageUp)}/${key(this.keys.pageDown)}: page preview`,
					"Enter: navigate",
					`${key(this.keys.toggleRangeSelection)}: range`,
					`${key(this.keys.toggleSelect)}: select`,
					`${key(this.keys.copy)}: copy`,
					`${key(this.keys.clear)}: clear`,
					`${key(this.keys.togglePaneFocus)}: layout`,
					`${key(this.keys.help)}: help`,
				],
				width,
				wrapTextWithAnsi,
				(text) => this.theme.fg("dim", text),
			),
		);

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
		const resultLines = renderPreviewBodyLines(clipped, focused.entry, width, this.theme, this.nodeById);
		const invocation = resolveToolCallFromParents(focused.entry, this.nodeById);
		const rendered = invocation
			? [
				truncateToWidth(`${this.theme.fg("muted", "Tool")}  ${this.theme.fg("accent", invocation.name)}`, width),
				truncateToWidth(this.theme.fg("muted", "Arguments"), width),
				...highlightCode(JSON.stringify(invocation.arguments, null, 2), "json").map((line) => truncateToWidth(line, width)),
				this.theme.fg("dim", "─".repeat(Math.max(1, width))),
				...resultLines,
			]
			: resultLines;
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

	private renderSelector(width: number, visibleRows: number): string[] {
		this.getTreeListInternals().maxVisibleLines = Math.max(1, visibleRows);
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
		return selectorLines;
	}

	render(width: number): string[] {
		const height = this.getRenderHeight();
		const output: string[] = [];
		const statusLines = this.renderStatusBar(width);
		const probeLines = this.renderSelector(width, TREE_SELECTOR_PROBE_ROWS);
		const selectorChromeRows = Math.max(0, probeLines.length - TREE_SELECTOR_PROBE_ROWS);
		const availablePaneRows = Math.max(1, height - selectorChromeRows - statusLines.length);
		const treeVisibleRows = getAnycopyTreeVisibleLines(availablePaneRows, this.paneFocus, this.layoutRatios);
		const selectorLines = treeVisibleRows === TREE_SELECTOR_PROBE_ROWS
			? probeLines
			: this.renderSelector(width, treeVisibleRows);

		output.push(...selectorLines, ...statusLines);
		const previewHeight = Math.max(0, height - output.length);
		if (previewHeight > 0) output.push(...this.renderPreview(width, previewHeight));
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
	const layoutRatios = config.layoutRatios;
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

		await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
			let closed = false;
			const closeOverlay = (): void => {
				if (closed) return;
				closed = true;
				overlayHandle?.unfocus();
				done();
			};
			const getRenderHeight = (): number => getAnycopyRenderHeight(tui.terminal?.rows ?? 40);
			const helpRows = buildKeyHelpRows(keybindings, keys);
			const openKeyHelp = (): void => {
				const terminalWidth = tui.terminal?.columns ?? 120;
				const preferredWidth = getKeyHelpPreferredWidth(helpRows, visibleWidth);
				const helpWidth = Math.min(preferredWidth, Math.max(32, terminalWidth - 4));
				void ctx.ui.custom<void>(
					(helpTui, helpTheme, _helpKeybindings, closeHelp) => new AnycopyKeyHelp(
						helpTheme,
						helpRows,
						keys.help,
						() => Math.max(8, Math.floor((helpTui.terminal?.rows ?? 40) * 0.8)),
						() => helpTui.requestRender(),
						closeHelp,
					),
					{
						overlay: true,
						overlayOptions: { anchor: "center", width: helpWidth, maxHeight: "80%", margin: 1 },
						onHandle: (handle) => handle.focus(),
					},
				).catch((error: unknown) => {
					ctx.ui.notify(error instanceof Error ? error.message : "Failed to open anycopy key help", "error");
				});
			};
			const treeTermHeight = getAnycopyTreeHeight(getRenderHeight());
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
				layoutRatios,
				openKeyHelp,
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
