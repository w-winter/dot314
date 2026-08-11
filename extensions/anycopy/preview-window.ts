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
		return { start, end: start + 1, above: start, below: lineCount - start - 1 };
	}

	// At the bottom, one row is reserved for the "above" indicator. Include
	// that row in the maximum offset so the final content line remains reachable.
	const maxOffset = Math.max(0, lineCount - (height - 1));
	const start = Math.max(0, Math.min(requestedOffset, maxOffset));
	const above = start;
	// Report remaining scroll steps rather than raw hidden content rows. The
	// bottom indicator disappears at maxOffset and releases its own row, so one
	// final keypress can reveal more than one content row.
	const below = maxOffset - start;
	const contentRows = Math.max(0, height - (above > 0 ? 1 : 0) - (below > 0 ? 1 : 0));
	const end = Math.min(lineCount, start + contentRows);

	return { start, end, above, below };
}
