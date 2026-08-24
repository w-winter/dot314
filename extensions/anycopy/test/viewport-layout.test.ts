import assert from "node:assert/strict";
import test from "node:test";
import {
	getAnycopyRenderHeight,
	getAnycopyTreeHeight,
	getAnycopyTreeVisibleLines,
} from "../viewport-layout.ts";

test("getAnycopyRenderHeight reserves two terminal rows", () => {
	assert.equal(getAnycopyRenderHeight(40), 38);
	assert.equal(getAnycopyRenderHeight(1), 1);
});

test("getAnycopyTreeHeight keeps the initial selector allocation", () => {
	assert.equal(getAnycopyTreeHeight(38), 24);
});

test("tree-focused and preview-focused layouts use their configured ratios", () => {
	const ratios = { tree: 0.8, preview: 0.2 };
	assert.equal(getAnycopyTreeVisibleLines(20, "tree", ratios), 16);
	assert.equal(getAnycopyTreeVisibleLines(20, "preview", ratios), 4);
});

test("both layouts retain at least one row for each pane", () => {
	const ratios = { tree: 0.99, preview: 0.01 };
	assert.equal(getAnycopyTreeVisibleLines(2, "tree", ratios), 1);
	assert.equal(getAnycopyTreeVisibleLines(2, "preview", ratios), 1);
});
