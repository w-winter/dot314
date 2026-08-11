export type PreviewWindow = {
	start: number;
	end: number;
	above: number;
	below: number;
};

export function getPreviewWindow(lineCount: number, height: number, requestedOffset: number): PreviewWindow {
	if (lineCount <= 0 || height <= 0) {
		return { start: 0, end: 0, above: 0, below: Math.max(0, lineCount) };
	}

	if (height === 1) {
		const start = Math.max(0, Math.min(requestedOffset, lineCount - 1));
		return { start, end: start, above: start, below: lineCount - start };
	}

	// The preview is framed by one top and one bottom divider. Overflow counts
	// are rendered inside those dividers instead of consuming additional rows.
	const contentRows = Math.max(0, height - 2);
	const maxOffset = Math.max(0, lineCount - contentRows);
	const start = Math.max(0, Math.min(requestedOffset, maxOffset));
	const end = Math.min(lineCount, start + contentRows);

	return {
		start,
		end,
		above: start,
		below: maxOffset - start,
	};
}
