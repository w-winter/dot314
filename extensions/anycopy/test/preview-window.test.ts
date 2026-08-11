import assert from "node:assert/strict";
import test from "node:test";

import { getPreviewWindow } from "../preview-window.ts";

test("getPreviewWindow reserves the bottom indicator row at the start", () => {
	assert.deepEqual(getPreviewWindow(20, 10, 0), {
		start: 0,
		end: 9,
		above: 0,
		below: 11,
	});
});

test("getPreviewWindow reports remaining scroll steps with both indicators", () => {
	assert.deepEqual(getPreviewWindow(20, 10, 1), {
		start: 1,
		end: 9,
		above: 1,
		below: 10,
	});
});

test("getPreviewWindow reports one line below exactly one step before the end", () => {
	assert.deepEqual(getPreviewWindow(20, 10, 10), {
		start: 10,
		end: 18,
		above: 10,
		below: 1,
	});
});

test("getPreviewWindow reaches the final line while reserving the above indicator", () => {
	assert.deepEqual(getPreviewWindow(20, 10, Number.POSITIVE_INFINITY), {
		start: 11,
		end: 20,
		above: 11,
		below: 0,
	});
});
