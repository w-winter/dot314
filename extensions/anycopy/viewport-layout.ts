// Reserve the bottom two terminal rows below the bounded overlay. In fullscreen
// mode, those rows contain Pi's final two footer rows.
const HOST_RESERVED_ROWS = 2;
const TREE_HEIGHT_RATIO = 0.65;

export function getAnycopyRenderHeight(terminalRows: number): number {
	return Math.max(1, Math.floor(terminalRows) - HOST_RESERVED_ROWS);
}

export function getAnycopyTreeHeight(renderHeight: number): number {
	return Math.floor(renderHeight * TREE_HEIGHT_RATIO);
}

export function getAnycopyTreeVisibleLines(renderHeight: number): number {
	return Math.max(5, Math.floor(getAnycopyTreeHeight(renderHeight) / 2));
}
