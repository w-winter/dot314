// This is an upper-bound render budget for the full-screen overlay. Pi owns
// final overlay clipping and terminal composition.
export function getAnycopyRenderHeight(terminalRows: number): number {
	return Math.max(1, Math.floor(terminalRows));
}
