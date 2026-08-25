import type { PaneFocus } from "./interaction-state.ts";

const HOST_RESERVED_ROWS = 2;
const INITIAL_TREE_RATIO = 0.65;

export type PaneLayoutRatios = Record<PaneFocus, number>;

export function getAnycopyRenderHeight(terminalRows: number): number {
	return Math.max(1, Math.floor(terminalRows) - HOST_RESERVED_ROWS);
}

export function getAnycopyTreeHeight(renderHeight: number): number {
	return Math.max(1, Math.floor(renderHeight * INITIAL_TREE_RATIO));
}

export function getAnycopyTreeVisibleLines(
	availableRows: number,
	paneFocus: PaneFocus = "tree",
	ratios: PaneLayoutRatios = { tree: 0.85, preview: 0.15 },
): number {
	const rows = Math.max(1, Math.floor(availableRows));
	if (rows === 1) return 1;
	return Math.max(1, Math.min(rows - 1, Math.round(rows * ratios[paneFocus])));
}
