export type KeyHelpRow = {
	keys: string[];
	label: string;
};

export type AnycopyHelpKeys = {
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

export const formatConfiguredKey = (key: string): string => {
	const normalized = key.trim().toLowerCase();
	if (normalized === "space") return "Space";
	if (normalized === "escape") return "Esc";
	if (normalized === "type text") return "Type text";
	if (/^f\d+$/.test(normalized)) return normalized.toUpperCase();
	const names: Record<string, string> = {
		shift: "Shift",
		ctrl: "Ctrl",
		alt: "Alt",
		super: "Super",
		enter: "Enter",
		return: "Enter",
		tab: "Tab",
		esc: "Esc",
		up: "Up",
		down: "Down",
		left: "Left",
		right: "Right",
		pageup: "PageUp",
		pagedown: "PageDown",
		backspace: "Backspace",
	};
	return normalized
		.split("+")
		.map((part) => names[part] ?? (part.length === 1 ? part.toUpperCase() : part))
		.join("+");
};

export const formatHelpRowKeys = (row: KeyHelpRow): string =>
	row.keys.map(formatConfiguredKey).join(" / ");

export const buildKeyHelpRows = (
	getKeys: (id: string) => readonly string[],
	keys: AnycopyHelpKeys,
	navigationAvailable = true,
): KeyHelpRow[] => {
	const effectiveKeys = (...ids: string[]): string[] =>
		[...new Set(ids.flatMap((id) => getKeys(id)).filter((key) => key.trim().length > 0))];

	return [
		{ keys: effectiveKeys("tui.select.up"), label: "move up" },
		{ keys: effectiveKeys("tui.select.down"), label: "move down" },
		{ keys: effectiveKeys("tui.editor.cursorLeft", "tui.select.pageUp"), label: "page tree up" },
		{ keys: effectiveKeys("tui.editor.cursorRight", "tui.select.pageDown"), label: "page tree down" },
		{ keys: effectiveKeys("app.tree.foldOrUp"), label: "fold branch or jump up" },
		{ keys: effectiveKeys("app.tree.unfoldOrDown"), label: "unfold branch or jump down" },
		{
			keys: effectiveKeys("tui.select.confirm"),
			label: navigationAvailable
				? "navigate to focused node"
				: "navigation unavailable, open /anycopy as a command",
		},
		{ keys: [keys.scrollUp, keys.scrollDown], label: "scroll preview" },
		{ keys: [keys.pageUp, keys.pageDown], label: "page preview" },
		{ keys: [keys.toggleRangeSelection], label: "select range" },
		{ keys: [keys.toggleSelect], label: "(de)select node" },
		{ keys: [keys.copy], label: "copy focused or selected nodes" },
		{ keys: [keys.clear], label: "clear selection" },
		{ keys: ["Type text"], label: "search visible nodes" },
		{ keys: effectiveKeys("tui.editor.deleteCharBackward"), label: "delete search character" },
		{ keys: effectiveKeys("tui.select.cancel"), label: "clear search or close" },
		{ keys: effectiveKeys("app.tree.filter.default"), label: "use default filter" },
		{ keys: effectiveKeys("app.tree.filter.noTools"), label: "toggle no-tools filter" },
		{ keys: effectiveKeys("app.tree.filter.userOnly"), label: "toggle user-only filter" },
		{ keys: effectiveKeys("app.tree.filter.labeledOnly"), label: "toggle labeled-only filter" },
		{ keys: effectiveKeys("app.tree.filter.all"), label: "toggle all-entries filter" },
		{ keys: effectiveKeys("app.tree.filter.cycleForward"), label: "cycle filter forward" },
		{ keys: effectiveKeys("app.tree.filter.cycleBackward"), label: "cycle filter backward" },
		{ keys: [keys.togglePaneFocus], label: "toggle tree or preview focus" },
		{ keys: effectiveKeys("app.tree.editLabel"), label: "edit label" },
		{ keys: [keys.toggleLabelTimestamps], label: "toggle label timestamps" },
		{ keys: [keys.toggleEntryTimestamps], label: "toggle entry timestamps" },
		{ keys: [keys.help], label: "show or close this help" },
	].filter((row) => row.keys.some((key) => key.trim().length > 0));
};
