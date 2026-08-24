export type KeyHelpRow = {
	keys: string[];
	label: string;
};

export const formatConfiguredKey = (key: string): string => {
	const normalized = key.trim().toLowerCase();
	if (normalized === "space") return "Space";
	if (normalized === "escape") return "Esc";
	if (/^f\d+$/.test(normalized)) return normalized.toUpperCase();
	const names: Record<string, string> = {
		shift: "Shift",
		ctrl: "Ctrl",
		alt: "Alt",
		enter: "Enter",
		tab: "Tab",
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
