// Pi's fullscreen dock keeps a transcript row, an above-editor spacer, and a
// two-line footer outside the custom editor component in the standard layout.
const FULLSCREEN_RESERVED_ROWS = 4;

export function getAnycopyRenderHeight(terminalRows: number, isViewport: boolean): number {
	const reservedRows = isViewport ? FULLSCREEN_RESERVED_ROWS : 0;
	return Math.max(1, terminalRows - reservedRows);
}
