export type PaneFocus = "tree" | "preview";

export const togglePaneFocus = (focus: PaneFocus): PaneFocus =>
	focus === "tree" ? "preview" : "tree";

export const applyInclusiveRangeSelection = (
	baselineIds: ReadonlySet<string>,
	orderedVisibleIds: readonly string[],
	anchorId: string,
	focusedId: string,
): Set<string> => {
	const selected = new Set(baselineIds);
	const anchorIndex = orderedVisibleIds.indexOf(anchorId);
	const focusedIndex = orderedVisibleIds.indexOf(focusedId);
	if (anchorIndex < 0 || focusedIndex < 0) return selected;

	const start = Math.min(anchorIndex, focusedIndex);
	const end = Math.max(anchorIndex, focusedIndex);
	for (let index = start; index <= end; index += 1) {
		const id = orderedVisibleIds[index];
		if (id) selected.add(id);
	}
	return selected;
};
