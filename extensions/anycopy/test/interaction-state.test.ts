import assert from "node:assert/strict";
import test from "node:test";
import { applyInclusiveRangeSelection, togglePaneFocus } from "../interaction-state.ts";

test("togglePaneFocus switches between the two fixed layouts", () => {
	assert.equal(togglePaneFocus("tree"), "preview");
	assert.equal(togglePaneFocus("preview"), "tree");
});

test("applyInclusiveRangeSelection toggles a forward range against its baseline", () => {
	assert.deepEqual(
		[...applyInclusiveRangeSelection(new Set(["outside", "b"]), ["a", "b", "c", "d"], "b", "d")],
		["outside", "c", "d"],
	);
});

test("applyInclusiveRangeSelection shrinks and reverses around the anchor", () => {
	const baseline = new Set(["outside"]);
	assert.deepEqual(
		[...applyInclusiveRangeSelection(baseline, ["a", "b", "c", "d"], "c", "a")],
		["outside", "a", "b", "c"],
	);
	assert.deepEqual(
		[...applyInclusiveRangeSelection(baseline, ["a", "b", "c", "d"], "c", "b")],
		["outside", "b", "c"],
	);
});

test("applyInclusiveRangeSelection preserves the baseline when an endpoint is hidden", () => {
	assert.deepEqual(
		[...applyInclusiveRangeSelection(new Set(["saved"]), ["a", "b"], "hidden", "b")],
		["saved"],
	);
});
