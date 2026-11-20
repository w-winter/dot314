/**
 * tool-horizon boundary model
 *
 * Pure, TUI-free logic behind the boundary picker: which session-tree rows are legal pruning
 * boundaries, what each would reclaim, how rows are decorated, and how a focused entry is
 * previewed. Nothing here touches `ctx.ui`, so all of it is unit-testable without a terminal.
 *
 * The session tree is only a browsing surface. Boundary validity and reclaim estimates are always
 * derived from the raw (pre-pruning) payload, and a row is selectable only if it maps exactly into
 * that payload.
 */

import { getLanguageFromPath, getMarkdownTheme, highlightCode } from "@earendil-works/pi-coding-agent";
import { Markdown, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import {
	applyPruningAtBoundary,
	computeBoundarySafeRawIndices,
	computeBoundaryFingerprint,
	formatContextTokenSavings,
	resolveBoundaryIndex,
	type BoundaryMode,
	type EventMessage,
} from "./core.ts";
import { TOOL_HORIZON_CHECKPOINT_MESSAGE_CUSTOM_TYPE } from "./provenance.ts";

export const MAX_PREVIEW_CHARS = 7000;
export const MAX_PREVIEW_LINES = 200;

/** Minimum columns reserved for the native tree text before a reclaim estimate may be appended */
const MIN_TREE_TEXT_WIDTH = 10;

/** Structural mirror of Pi's SessionEntry; kept local so the module depends on shape, not on an export */
export type PickerSessionEntry = {
	id: string;
	type: string;
	parentId?: string;
	[key: string]: unknown;
};

/** Structural mirror of Pi's SessionTreeNode */
export type ToolHorizonTreeNode = {
	entry: PickerSessionEntry;
	children: ToolHorizonTreeNode[];
	label?: string;
	labelTimestamp?: string;
};

/** Minimal theme surface used by the pure renderers, so tests can supply a plain stub */
export type BoundaryPickerThemeLike = {
	fg: (color: string, text: string) => string;
};

export type BoundaryUnavailableReason =
	| "not-in-current-payload"
	| "boundary-not-stable"
	| "pruning-crosses-boundary"
	| "extension-owned-message";

export type BoundaryPickerRow =
	| {
			kind: "selectable";
			entryId: string;
			rawPayloadIndex: number;
			reclaimedTokens: number;
			isCurrentBoundary: boolean;
	  }
	| {
			kind: "unavailable";
			entryId: string;
			reason: BoundaryUnavailableReason;
			isCurrentBoundary: boolean;
	  };

export type BoundaryPickerSelection = {
	entryId: string;
	rawPayloadIndex: number;
	reclaimedTokens: number;
};

/** `pending` never reaches the picker: it carries a null fingerprint, so nothing reverse-maps */
export type ResolvedBoundaryMode = Exclude<BoundaryMode, "pending">;

export type BoundaryPickerModel = {
	displayedTree: ToolHorizonTreeNode[];
	rowsByEntryId: ReadonlyMap<string, BoundaryPickerRow>;
	initialSelectedId: string;
	currentBoundaryEntryId: string | null;
	currentBoundaryMode: ResolvedBoundaryMode | null;
};

export type BoundaryPickerModelFailure = {
	kind: "empty-tree" | "no-selectable-boundaries";
};

const UNAVAILABLE_REASON_TEXT: Record<BoundaryUnavailableReason, string> = {
	"not-in-current-payload": "Not part of the current model context",
	"boundary-not-stable": "This entry cannot be used as a stable tool horizon",
	"pruning-crosses-boundary": "Starting the horizon here would remove this entry or a later one",
	"extension-owned-message": "This is a Tool Horizon checkpoint message",
};

/**
 * Human-readable explanation for why a row cannot be chosen as a boundary
 *
 * Args:
 *     reason (BoundaryUnavailableReason): the classification assigned during model construction
 *
 * Returns:
 *     A short sentence suitable for the status line or a rejection flash
 */
export function describeUnavailableReason(reason: BoundaryUnavailableReason): string {
	return UNAVAILABLE_REASON_TEXT[reason];
}

export type BoundaryPickerFlash = {
	text: string;
	tone: "warning" | "error";
};

export function renderBoundaryPickerStatusLines(args: {
	row: BoundaryPickerRow | null;
	currentBoundaryMode: ResolvedBoundaryMode | null;
	currentBoundaryHidden: boolean;
	flash: BoundaryPickerFlash | null;
	width: number;
	theme: BoundaryPickerThemeLike;
}): string[] {
	if (args.flash) {
		return [truncateToWidth(args.theme.fg(args.flash.tone, `  ${args.flash.text}`), args.width)];
	}

	const lines: string[] = [];
	if (args.row?.kind === "selectable") {
		const amount = args.theme.fg("error", formatContextTokenSavings(args.row.reclaimedTokens));
		const prefix = args.theme.fg("muted", "  Tool horizon begins at this entry · ");
		const completeStatus = prefix + amount;
		if (visibleWidth(completeStatus) <= args.width) {
			lines.push(completeStatus);
		} else if (visibleWidth(amount) <= args.width) {
			const separator = args.width > visibleWidth(amount) ? " " : "";
			const prefixWidth = Math.max(0, args.width - visibleWidth(amount) - separator.length);
			lines.push(truncateToWidth(prefix, prefixWidth) + separator + amount);
		} else {
			lines.push(truncateToWidth(amount, args.width));
		}
		if (args.row.isCurrentBoundary) {
			const currentText = args.currentBoundaryMode === "after-entry"
				? "  Current horizon begins after this entry; Enter moves it to this entry"
				: "  Current horizon";
			lines.push(truncateToWidth(args.theme.fg("muted", currentText), args.width));
		}
	} else if (args.row?.kind === "unavailable") {
		lines.push(truncateToWidth(args.theme.fg("muted", `  ${describeUnavailableReason(args.row.reason)}`), args.width));
	} else {
		lines.push("");
	}

	if (args.currentBoundaryHidden) {
		lines.push(
			truncateToWidth(args.theme.fg("dim", "  Current horizon is on a row hidden by the active filter"), args.width),
		);
	}
	return lines;
}

/**
 * Filter a session tree down to the entries on the current branch
 *
 * Produces fresh node and children arrays while carrying each `entry` by reference. The entry
 * object must not be copied: the tree component reads `entry.parentId` when resolving a hidden
 * initial selection, reads `entry.message.stopReason` in its visibility prefilter, and preview
 * language inference walks parent links.
 *
 * Args:
 *     nodes (readonly ToolHorizonTreeNode[]): full session tree roots
 *     branchEntryIds (ReadonlySet<string>): entry IDs on the current branch
 *
 * Returns:
 *     Tree roots containing only current-branch entries
 */
export function filterTreeToBranch(
	nodes: readonly ToolHorizonTreeNode[],
	branchEntryIds: ReadonlySet<string>,
): ToolHorizonTreeNode[] {
	// Iterative rather than recursive: session trees grow without bound (compaction hides entries from
	// model context but never removes them from the tree), so a long-lived session would otherwise
	// overflow the call stack in exactly the case this extension exists to serve.
	const roots: ToolHorizonTreeNode[] = [];
	const stack: Array<{ source: ToolHorizonTreeNode; target: ToolHorizonTreeNode[] }> = [];

	for (let i = nodes.length - 1; i >= 0; i--) stack.push({ source: nodes[i], target: roots });
	while (stack.length > 0) {
		const { source, target } = stack.pop()!;
		// A branch is a root-to-leaf path, so an off-branch node cannot have on-branch descendants.
		if (!branchEntryIds.has(source.entry.id)) continue;
		const children: ToolHorizonTreeNode[] = [];
		target.push({
			entry: source.entry,
			children,
			label: source.label,
			labelTimestamp: source.labelTimestamp,
		});
		for (let i = source.children.length - 1; i >= 0; i--) stack.push({ source: source.children[i], target: children });
	}
	return roots;
}

/**
 * Walk every node of a tree in depth-first display order
 *
 * Args:
 *     nodes (readonly ToolHorizonTreeNode[]): tree roots
 *
 * Returns:
 *     Flat array of nodes in display order
 */
export function flattenTree(nodes: readonly ToolHorizonTreeNode[]): ToolHorizonTreeNode[] {
	// Iterative for the same unbounded-depth reason as filterTreeToBranch.
	const out: ToolHorizonTreeNode[] = [];
	const stack: ToolHorizonTreeNode[] = [];
	for (let i = nodes.length - 1; i >= 0; i--) stack.push(nodes[i]);
	while (stack.length > 0) {
		const node = stack.pop()!;
		out.push(node);
		for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
	}
	return out;
}

/**
 * Build a lookup of every node in a tree by entry ID
 *
 * Always build this from the FULL tree, even when the displayed tree is branch-filtered: preview
 * language inference for `read` tool results needs intact parent links.
 */
export function buildNodeMap(nodes: readonly ToolHorizonTreeNode[]): Map<string, ToolHorizonTreeNode> {
	const map = new Map<string, ToolHorizonTreeNode>();
	for (const node of flattenTree(nodes)) map.set(node.entry.id, node);
	return map;
}

function isCheckpointMessage(message: EventMessage): boolean {
	return (
		message.role === "custom" &&
		(message as { customType?: unknown }).customType === TOOL_HORIZON_CHECKPOINT_MESSAGE_CUSTOM_TYPE
	);
}

/**
 * Classify every displayed tree row and compute reclaim estimates for the selectable ones
 *
 * A row is selectable only when it satisfies all of:
 *   - it maps into the current raw payload (so a boundary can actually be expressed)
 *   - it is not a tool-horizon checkpoint message (anchoring on one destroys the boundary: a
 *     newer checkpoint replaces it in the payload and the fingerprint stops resolving)
 *   - it is a structurally safe boundary (pruning there leaves it and the whole suffix untouched)
 *   - its fingerprint immediately round-trips to the same raw index
 *
	* Reclaim is computed once per unique mapped raw index and cached for the lifetime of the model.
	* (Memoizing per-message token estimates across candidates was measured at only 1.1x — the pruning
	* filter pass dominates, not token estimation — so no such memo exists.)
 *
 * Args:
 *     args: full tree, current-branch IDs, the exact entryId -> raw index map, the raw payload,
 *           and the currently resolved boundary (raw index and mode), if any
 *
 * Returns:
 *     A complete picker model, or a failure describing why no picker can be shown
 */
export function buildBoundaryPickerModel(args: {
	fullTree: readonly ToolHorizonTreeNode[];
	currentBranchEntryIds: ReadonlySet<string>;
	entryIdToRawPayloadIndex: ReadonlyMap<string, number>;
	rawPayload: readonly EventMessage[];
	currentBoundaryRawPayloadIndex: number | null;
	currentBoundaryMode: ResolvedBoundaryMode | null;
}): BoundaryPickerModel | BoundaryPickerModelFailure {
	const displayedTree = filterTreeToBranch(args.fullTree, args.currentBranchEntryIds);
	const displayedNodes = flattenTree(displayedTree);
	if (displayedNodes.length === 0) return { kind: "empty-tree" };

	const boundarySafeRawIndices = computeBoundarySafeRawIndices(args.rawPayload);
	const reclaimByRawIndex = new Map<number, number>();

	// One projection per unique mapped raw index, computed at open and never during focus or render.
	const reclaimFor = (rawPayloadIndex: number): number => {
		const cached = reclaimByRawIndex.get(rawPayloadIndex);
		if (cached !== undefined) return cached;
		const reclaimed = applyPruningAtBoundary(args.rawPayload, rawPayloadIndex, "from-entry").reclaimedTokens;
		reclaimByRawIndex.set(rawPayloadIndex, reclaimed);
		return reclaimed;
	};

	const currentBoundaryEntryId = (() => {
		if (args.currentBoundaryRawPayloadIndex === null) return null;
		for (const [entryId, rawIndex] of args.entryIdToRawPayloadIndex) {
			if (rawIndex === args.currentBoundaryRawPayloadIndex) return entryId;
		}
		return null;
	})();

	const rowsByEntryId = new Map<string, BoundaryPickerRow>();
	let newestSelectable: { entryId: string; rawPayloadIndex: number } | null = null;

	for (const node of displayedNodes) {
		const entryId = node.entry.id;
		const isCurrentBoundary = entryId === currentBoundaryEntryId;
		const rawPayloadIndex = args.entryIdToRawPayloadIndex.get(entryId);

		const unavailable = (reason: BoundaryUnavailableReason): void => {
			rowsByEntryId.set(entryId, { kind: "unavailable", entryId, reason, isCurrentBoundary });
		};

		if (
			node.entry.type === "custom_message" &&
			node.entry.customType === TOOL_HORIZON_CHECKPOINT_MESSAGE_CUSTOM_TYPE
		) {
			unavailable("extension-owned-message");
			continue;
		}
		if (rawPayloadIndex === undefined) {
			unavailable("not-in-current-payload");
			continue;
		}
		if (rawPayloadIndex < 0 || rawPayloadIndex >= args.rawPayload.length) {
			unavailable("not-in-current-payload");
			continue;
		}
		const message = args.rawPayload[rawPayloadIndex];
		if (isCheckpointMessage(message)) {
			unavailable("extension-owned-message");
			continue;
		}
		if (!boundarySafeRawIndices.has(rawPayloadIndex)) {
			unavailable("pruning-crosses-boundary");
			continue;
		}
		if (resolveBoundaryIndex(args.rawPayload, computeBoundaryFingerprint(message, rawPayloadIndex)) !== rawPayloadIndex) {
			unavailable("boundary-not-stable");
			continue;
		}

		rowsByEntryId.set(entryId, {
			kind: "selectable",
			entryId,
			rawPayloadIndex,
			reclaimedTokens: reclaimFor(rawPayloadIndex),
			isCurrentBoundary,
		});
		if (newestSelectable === null || rawPayloadIndex > newestSelectable.rawPayloadIndex) {
			newestSelectable = { entryId, rawPayloadIndex };
		}
	}

	// Nothing selectable means every Enter would be rejected; refuse before opening a dead-end picker,
	// even when the current boundary still reverse-maps to a now-unavailable row.
	if (newestSelectable === null) return { kind: "no-selectable-boundaries" };
	const initialSelectedId =
		currentBoundaryEntryId !== null && rowsByEntryId.has(currentBoundaryEntryId)
			? currentBoundaryEntryId
			: newestSelectable.entryId;

	return {
		displayedTree,
		rowsByEntryId,
		initialSelectedId,
		currentBoundaryEntryId,
		currentBoundaryMode: currentBoundaryEntryId === null ? null : args.currentBoundaryMode,
	};
}

/**
 * Resolve a focused entry ID into a committable selection
 *
 * Args:
 *     model (BoundaryPickerModel): the model the overlay was opened with
 *     entryId (string): the entry the user pressed Enter on
 *
 * Returns:
 *     A selection when the row is selectable, otherwise the row (or null) so the caller can explain
 */
export function resolveBoundarySelection(
	model: BoundaryPickerModel,
	entryId: string,
):
	| { ok: true; selection: BoundaryPickerSelection }
	| { ok: false; row: Extract<BoundaryPickerRow, { kind: "unavailable" }> | null } {
	const row = model.rowsByEntryId.get(entryId) ?? null;
	if (row === null) return { ok: false, row: null };
	if (row.kind !== "selectable") return { ok: false, row };
	return {
		ok: true,
		selection: { entryId: row.entryId, rawPayloadIndex: row.rawPayloadIndex, reclaimedTokens: row.reclaimedTokens },
	};
}

/**
 * Reproduce TreeList's visible-window start index
 *
 * Must match the upstream expression exactly, or decorated rows attach to the wrong entries.
 */
export function computeVisibleWindowStart(args: {
	selectedIndex: number;
	maxVisibleLines: number;
	filteredNodeCount: number;
}): number {
	return Math.max(
		0,
		Math.min(args.selectedIndex - Math.floor(args.maxVisibleLines / 2), args.filteredNodeCount - args.maxVisibleLines),
	);
}

/**
	* Raised when the upstream tree component no longer matches the internals decoration depends on
	*
	* Decoration is what carries the availability and reclaim contract, so an undecorated or
	* mis-associated selector would silently invite the user to pick boundaries with no indication of
	* which are legal, or attribute one entry's reclaim estimate to another. Every mismatch fails
	* closed with this error instead.
	*/
export class BoundaryPickerCompatibilityError extends Error {
	constructor(detail: string) {
		super(`tool-horizon: session tree component is incompatible (${detail})`);
		this.name = "BoundaryPickerCompatibilityError";
	}
}

/**
	* Verify that a filtered-node list still has the shape decoration and visibility checks read
	*
	* Args:
	*     filteredNodes: the component's current filtered node list
	*     selectedIndex (number): the component's current cursor
	*
	* Raises:
	*     BoundaryPickerCompatibilityError: on any malformed element or out-of-range cursor
	*/
export function assertFilteredNodesShape(
	filteredNodes: ReadonlyArray<{ node: ToolHorizonTreeNode }>,
	selectedIndex: number,
): void {
	for (let index = 0; index < filteredNodes.length; index++) {
		if (typeof filteredNodes[index]?.node?.entry?.id !== "string") {
			throw new BoundaryPickerCompatibilityError(`filteredNodes[${index}] does not expose node.entry.id`);
		}
	}
	if (filteredNodes.length > 0 && (selectedIndex < 0 || selectedIndex >= filteredNodes.length)) {
		throw new BoundaryPickerCompatibilityError(`selectedIndex ${selectedIndex} is out of range`);
	}
}

/**
 * Decorate rendered tree rows with availability markers and right-aligned reclaim estimates
 *
 * The tree component renders its node rows followed by exactly one status line, and returns two
	* lines when a filter matches nothing. Both shapes are preserved here, and any departure from them
	* fails closed: a row count that no longer matches the visible window would silently attribute one
	* entry's reclaim estimate to a different entry.
 *
 * A zero-token estimate is still rendered: suppressing it would make a selectable row look
 * unavailable, and the default focus lands on exactly such a row.
 *
 * Args:
 *     args: rendered lines, the component's filtered nodes and cursor state, target width, the row
 *           classification map, and a theme surface
 *
 * Returns:
 *     Decorated lines, each truncated to `width`
	*
	* Raises:
	*     BoundaryPickerCompatibilityError: when the node shape or rendered row count no longer matches
 */
export function decorateTreeRows(args: {
	lines: readonly string[];
	filteredNodes: ReadonlyArray<{ node: ToolHorizonTreeNode }>;
	selectedIndex: number;
	maxVisibleLines: number;
	width: number;
	rowsByEntryId: ReadonlyMap<string, BoundaryPickerRow>;
	theme: BoundaryPickerThemeLike;
}): string[] {
	const { lines, filteredNodes, width, rowsByEntryId, theme } = args;
	assertFilteredNodesShape(filteredNodes, args.selectedIndex);
	if (filteredNodes.length === 0) return lines.map((line) => truncateToWidth(`  ${line}`, width));

	const maxVisibleLines = Math.max(1, args.maxVisibleLines);
	const startIndex = computeVisibleWindowStart({
		selectedIndex: args.selectedIndex,
		maxVisibleLines,
		filteredNodeCount: filteredNodes.length,
	});
	const treeRowCount = Math.max(0, lines.length - 1);
	const expectedRowCount = Math.min(startIndex + maxVisibleLines, filteredNodes.length) - startIndex;
	if (treeRowCount !== expectedRowCount) {
		throw new BoundaryPickerCompatibilityError(
			`rendered ${treeRowCount} tree row(s) where the visible window holds ${expectedRowCount}`,
		);
	}

	return lines.map((line, index) => {
		if (index >= treeRowCount) return truncateToWidth(`  ${line}`, width);
		const entry = filteredNodes[startIndex + index].node.entry;

		const row = rowsByEntryId.get(entry.id);
		const marker =
			row?.isCurrentBoundary === true
				? theme.fg("accent", "◆ ")
				: row?.kind === "selectable"
					? theme.fg("success", "○ ")
					: theme.fg("dim", "○ ");
		const markedLine = marker + line;

		if (row?.kind !== "selectable") return truncateToWidth(markedLine, width);

		const estimate = formatContextTokenSavings(row.reclaimedTokens);
		const estimateWidth = visibleWidth(estimate);
		const contentWidth = width - estimateWidth - 1;
		// On very narrow terminals the tree text wins; the focused status line still shows the estimate.
		if (contentWidth < MIN_TREE_TEXT_WIDTH) return truncateToWidth(markedLine, width);

		const truncatedContent = truncateToWidth(markedLine, contentWidth);
		const padding = Math.max(1, width - visibleWidth(truncatedContent) - estimateWidth);
		return truncateToWidth(truncatedContent + " ".repeat(padding) + theme.fg("error", estimate), width);
	});
}

function getTextContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block): block is { type: "text"; text: string } =>
				typeof block === "object" && block !== null && (block as { type?: string }).type === "text",
		)
		.map((block) => block.text)
		.join("");
}

/**
 * Extract plain preview text for a session entry
 *
 * Args:
 *     entry (PickerSessionEntry): the focused entry
 *
 * Returns:
 *     Display text, or a placeholder when the entry carries none
 */
export function extractPreviewText(entry: PickerSessionEntry): string {
	const placeholder = "(no text content)";
	switch (entry.type) {
		case "message": {
			const message = entry.message as
				| { role?: string; content?: unknown; command?: string; errorMessage?: string }
				| undefined;
			if (!message) return placeholder;
			if (message.role === "bashExecution" && message.command) return message.command;
			if (message.errorMessage) return `(error) ${message.errorMessage}`;
			return getTextContent(message.content).trim() || placeholder;
		}
		case "custom_message":
			return getTextContent(entry.content).trim() || placeholder;
		case "compaction":
		case "branch_summary":
			return typeof entry.summary === "string" && entry.summary.length > 0 ? entry.summary : placeholder;
		default:
			return placeholder;
	}
}

/** Clip overlong preview text before rendering, so a huge tool result cannot stall the overlay */
export function clipPreviewText(text: string): string {
	if (text.length <= MAX_PREVIEW_CHARS) return text;
	return `${text.slice(0, MAX_PREVIEW_CHARS)}\n… [truncated]`;
}

const MAX_PARENT_TRAVERSAL_DEPTH = 30;

function getToolName(entry: PickerSessionEntry): string | null {
	if (entry.type !== "message") return null;
	const message = entry.message as { role?: string; toolName?: unknown } | undefined;
	if (message?.role !== "toolResult") return null;
	return typeof message.toolName === "string" ? message.toolName : null;
}

/**
 * Infer a syntax-highlighting language for a `read` tool result from its originating tool call
 *
 * Walks parent links to find the assistant message that issued the call, then derives the language
 * from the requested path. Requires a node map built over the full tree.
 */
export function resolveReadResultLanguage(
	entry: PickerSessionEntry,
	nodeById: ReadonlyMap<string, ToolHorizonTreeNode>,
): string | undefined {
	if (getToolName(entry) !== "read") return undefined;
	const message = entry.message as { toolCallId?: unknown } | undefined;
	const toolCallId = typeof message?.toolCallId === "string" ? message.toolCallId : null;
	if (toolCallId === null) return undefined;

	let parentId = entry.parentId;
	for (let depth = 0; depth < MAX_PARENT_TRAVERSAL_DEPTH && parentId; depth += 1) {
		const parentNode = nodeById.get(parentId);
		if (!parentNode) return undefined;
		const parentEntry = parentNode.entry;
		if (parentEntry.type === "message") {
			const parentMessage = parentEntry.message as { role?: string; content?: unknown } | undefined;
			if (parentMessage?.role === "assistant" && Array.isArray(parentMessage.content)) {
				const toolCall = parentMessage.content.find(
					(block: unknown) =>
						typeof block === "object" &&
						block !== null &&
						(block as { type?: string }).type === "toolCall" &&
						(block as { id?: string }).id === toolCallId,
				) as { arguments?: Record<string, unknown> } | undefined;
				const rawPath = toolCall?.arguments?.["file_path"] ?? toolCall?.arguments?.["path"];
				if (typeof rawPath === "string" && rawPath.trim().length > 0) return getLanguageFromPath(rawPath);
				return undefined;
			}
		}
		parentId = parentEntry.parentId;
	}
	return undefined;
}

/**
 * Render preview body lines for a focused entry, matching Pi's own renderers where possible
 *
 * Bash commands and `read` results are syntax-highlighted; everything else goes through Pi's
 * markdown renderer so the preview matches the main UI.
 */
export function renderPreviewBody(args: {
	entry: PickerSessionEntry;
	nodeById: ReadonlyMap<string, ToolHorizonTreeNode>;
	width: number;
	theme: BoundaryPickerThemeLike;
}): readonly string[] {
	const text = clipPreviewText(extractPreviewText(args.entry));
	const normalized = text.replace(/\t/g, "   ");

	if (args.entry.type === "message") {
		const message = args.entry.message as { role?: string; command?: string } | undefined;
		if (message?.role === "bashExecution" && typeof message.command === "string") {
			return highlightCode(normalized, "bash").map((line) => truncateToWidth(line, args.width));
		}
		if (getToolName(args.entry) === "read") {
			const language = resolveReadResultLanguage(args.entry, args.nodeById);
			const lines = language
				? highlightCode(normalized, language)
				: normalized.split("\n").map((line) => args.theme.fg("toolOutput", line));
			return lines.map((line) => truncateToWidth(line, args.width));
		}
	}

	return new Markdown(text, 0, 0, getMarkdownTheme()).render(args.width);
}

const KEY_SYMBOLS: ReadonlyArray<readonly [RegExp, string]> = [
	[/\bpageUp\b/g, "pgup"],
	[/\bpageDown\b/g, "pgdn"],
	[/\bup\b/g, "↑"],
	[/\bdown\b/g, "↓"],
	[/\bleft\b/g, "←"],
	[/\bright\b/g, "→"],
];

/**
	* Render a set of keys as one compact hint, matching how the native tree help reads
	*
	* Keys sharing a modifier are collapsed onto it (`ctrl+d/t/u/l/a`) and arrow names become arrows.
	*
	* Args:
	*     keys (readonly string[]): resolved key text for each binding, in display order
	*
	* Returns:
	*     A single hint string, empty when no keys are bound
	*/
export function formatHintKeys(keys: readonly string[]): string {
	const present = keys.filter((key) => key.length > 0);
	if (present.length === 0) return "";

	const parts = present.map((key) => {
		const separator = key.lastIndexOf("+");
		return separator === -1 ? { prefix: "", suffix: key } : { prefix: key.slice(0, separator + 1), suffix: key.slice(separator + 1) };
	});
	const prefix = parts[0].prefix;
	const compacted =
		present.length > 1 && prefix.length > 0 && parts.every((part) => part.prefix === prefix)
			? `${prefix}${parts.map((part) => part.suffix).join("/")}`
			: present.join("/");

	return KEY_SYMBOLS.reduce((text, [pattern, symbol]) => text.replace(pattern, symbol), compacted);
}

/**
	* Wrap hint items onto as many lines as the width requires
	*
	* Args:
	*     items (readonly string[]): already-formatted hints, in display order
	*     width (number): available terminal width
	*
	* Returns:
	*     Indented lines, each within `width`
	*/
export function layoutHintItems(items: readonly string[], width: number): string[] {
	const available = Math.max(1, width);
	const indent = "  ";
	const lines: string[] = [];
	let current = "";

	for (const item of items) {
		if (current === "") {
			current = `${indent}${item}`;
			continue;
		}
		const candidate = `${current} · ${item}`;
		if (visibleWidth(candidate) <= available) {
			current = candidate;
			continue;
		}
		lines.push(current);
		current = `${indent}${item}`;
	}
	if (current !== "") lines.push(current);

	return lines.map((line) => truncateToWidth(line, available));
}

/**
	* Compose the overlay's final line list within the terminal height
	*
	* Two things must survive a short terminal. Status lines carry the focused row's reclaim figure and
	* the rejection reason after a blocked Enter, so they are budgeted first rather than appended and
	* then truncated away. Tree rows carry the identity of the boundary about to be committed, and the
	* native selector puts its title, help, and search chrome *before* them — so when space is tight
	* that leading chrome is dropped first, rather than every entry row.
	*
	* The reported `focusedRowVisible` is what lets the caller refuse selection outright: the row about
	* to be committed must be on screen, and a nonzero row count does not establish that, since the
	* cursor can sit on precisely the row that was cropped.
	*
	* Args:
	*     args: rendered selector lines, where the selector's tree rows begin, how many there are, which
	*           one holds the cursor, status lines, a preview renderer, and the terminal height
	*
	* Returns:
	*     Exactly `height` lines, how many tree rows remained visible, and whether the focused row is
	*     among them
	*/
export function composeOverlayLines(args: {
	selectorLines: readonly string[];
	treeRegion: { start: number; count: number; focusedOffset: number };
	statusLines: readonly string[];
	renderPreview: (height: number) => string[];
	height: number;
}): { lines: string[]; treeRowsVisible: number; focusedRowVisible: boolean } {
	if (args.height <= 0) return { lines: [], treeRowsVisible: 0, focusedRowVisible: false };

	const statusLines = args.statusLines.slice(0, args.height);
	const selectorBudget = Math.max(0, args.height - statusLines.length);

	const hasFocusedRow = args.treeRegion.focusedOffset >= 0 && args.treeRegion.focusedOffset < args.treeRegion.count;
	const focusedLineIndex = hasFocusedRow ? args.treeRegion.start + args.treeRegion.focusedOffset : -1;

	let selectorLines = args.selectorLines;
	let treeStart = args.treeRegion.start;
	let focusedIndex = focusedLineIndex;
	if (selectorLines.length > selectorBudget) {
		let windowStart = Math.min(Math.max(0, treeStart), selectorLines.length - selectorBudget);
		// Native chrome goes first; if the cursor still falls past the window, slide it down so the row
		// being committed is the one the user is looking at.
		if (focusedIndex >= 0 && focusedIndex >= windowStart + selectorBudget) {
			windowStart = Math.min(focusedIndex - selectorBudget + 1, selectorLines.length - selectorBudget);
		}
		selectorLines = selectorLines.slice(windowStart, windowStart + selectorBudget);
		treeStart -= windowStart;
		focusedIndex -= windowStart;
	}

	const treeRowsVisible = Math.max(
		0,
		Math.min(selectorLines.length, treeStart + args.treeRegion.count) - Math.max(0, treeStart),
	);
	const focusedRowVisible = hasFocusedRow && focusedIndex >= 0 && focusedIndex < selectorLines.length;
	const previewHeight = Math.max(0, args.height - selectorLines.length - statusLines.length);
	const previewLines = previewHeight > 0 ? args.renderPreview(previewHeight).slice(0, previewHeight) : [];

	const lines = [...selectorLines, ...statusLines, ...previewLines];
	while (lines.length < args.height) lines.push("");
	return { lines: lines.slice(0, args.height), treeRowsVisible, focusedRowVisible };
}

/**
 * Clamp a preview scroll window and annotate it with above/below indicators
 *
 * Args:
 *     args: rendered body lines, available height, requested offset, and whether the body was
 *           itself truncated at MAX_PREVIEW_LINES
 *
 * Returns:
 *     The visible lines and the clamped offset
 */
export function clampPreviewWindow(args: {
	bodyLines: readonly string[];
	height: number;
	offset: number;
	truncatedToMaxLines: boolean;
	theme: BoundaryPickerThemeLike;
	width: number;
}): { lines: string[]; offset: number } {
	if (args.height <= 0) return { lines: [], offset: 0 };

	// Indicators occupy body slots, so the scroll bound has to be derived from the rows that remain
	// after reserving them; the naive bound (length - height) leaves the final body line unreachable.
	// The truncation notice is dropped rather than allowed to crowd out the body on a tiny pane, which
	// keeps every retained line reachable at every height.
	const truncationFitsAtRest = args.truncatedToMaxLines && args.height >= 2 ? 1 : 0;
	const truncationFitsScrolled = args.truncatedToMaxLines && args.height >= 3 ? 1 : 0;
	const overflows = args.bodyLines.length > args.height - truncationFitsAtRest;
	const scrolledCapacity = Math.max(1, args.height - 1 - truncationFitsScrolled);
	const maxOffset = overflows ? Math.max(0, args.bodyLines.length - scrolledCapacity) : 0;
	const offset = Math.max(0, Math.min(args.offset, maxOffset));

	// Indicators never take the last body row: a pane that shows only "lines above" and "lines below"
	// tells the reader where they are while hiding what is there, and at small heights that would make
	// whole stretches of a preview unreachable at every scroll position.
	const aboveIndicator =
		offset > 0 && args.height >= 2
			? truncateToWidth(args.theme.fg("muted", `… ${offset} line(s) above`), args.width)
			: null;
	const bodyCapacity = Math.max(1, args.height - (aboveIndicator === null ? 0 : 1));

	const describeBottom = (bodyCount: number): string | null => {
		const remaining = args.bodyLines.length - Math.min(args.bodyLines.length, offset + bodyCount);
		if (remaining > 0) return truncateToWidth(args.theme.fg("muted", `… ${remaining} more line(s)`), args.width);
		if (args.truncatedToMaxLines) {
			return truncateToWidth(args.theme.fg("muted", `… [truncated to ${MAX_PREVIEW_LINES} lines]`), args.width);
		}
		return null;
	};

	// Give the body the whole pane first, then buy back one row for the bottom indicator only if a row
	// of body content remains.
	let bodyCount = bodyCapacity;
	let bottomIndicator = describeBottom(bodyCount);
	if (bottomIndicator !== null && bodyCapacity >= 2) {
		bodyCount = bodyCapacity - 1;
		bottomIndicator = describeBottom(bodyCount);
	} else if (bottomIndicator !== null) {
		bottomIndicator = null;
	}

	const body = args.bodyLines.slice(offset, Math.min(args.bodyLines.length, offset + bodyCount));
	const lines = [...(aboveIndicator === null ? [] : [aboveIndicator]), ...body, ...(bottomIndicator === null ? [] : [bottomIndicator])].slice(
		0,
		args.height,
	);
	while (lines.length < args.height) lines.push("");
	return { lines, offset };
}
