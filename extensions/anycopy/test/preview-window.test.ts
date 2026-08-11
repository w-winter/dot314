import assert from "node:assert/strict";
import test from "node:test";

import { getPreviewWindow } from "../preview-window.ts";

test("getPreviewWindow reserves fixed top and bottom divider rows", () => {
	assert.deepEqual(getPreviewWindow(20, 10, 0), {
		start: 0,
		end: 8,
		above: 0,
		below: 12,
	});
});

test("getPreviewWindow reports remaining scroll steps inside framed dividers", () => {
	assert.deepEqual(getPreviewWindow(20, 10, 1), {
		start: 1,
		end: 9,
		above: 1,
		below: 11,
	});
});

test("getPreviewWindow reports one line below exactly one step before the end", () => {
	assert.deepEqual(getPreviewWindow(20, 10, 11), {
		start: 11,
		end: 19,
		above: 11,
		below: 1,
	});
});

test("getPreviewWindow reaches the final line while retaining both dividers", () => {
	assert.deepEqual(getPreviewWindow(20, 10, Number.POSITIVE_INFINITY), {
		start: 12,
		end: 20,
		above: 12,
		below: 0,
	});
});
