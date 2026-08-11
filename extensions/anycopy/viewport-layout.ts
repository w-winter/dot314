// Pi keeps its layout boundary and terminal footer below selector-style custom
// content in both renderers. Budget those host-owned rows instead of branching
// on TUI mode, leaving the component's final separator visible.
const HOST_RESERVED_ROWS = 3;

export function getAnycopyRenderHeight(terminalRows: number): number {
	return Math.max(1, Math.floor(terminalRows) - HOST_RESERVED_ROWS);
}
