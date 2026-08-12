// The full-screen overlay leaves Pi's two-line footer visible. Its own final
// preview divider covers the underlying editor boundary.
const HOST_RESERVED_ROWS = 2;

export function getAnycopyRenderHeight(terminalRows: number): number {
	return Math.max(1, Math.floor(terminalRows) - HOST_RESERVED_ROWS);
}
