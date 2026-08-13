import assert from "node:assert/strict";
import test from "node:test";

import {
	getAnycopyRenderHeight,
	getAnycopyTreeHeight,
	getAnycopyTreeVisibleLines,
} from "../viewport-layout.ts";

test("getAnycopyRenderHeight reserves two terminal rows below the overlay", () => {
	assert.equal(getAnycopyRenderHeight(40), 38);
});

test("getAnycopyRenderHeight floors fractional terminal heights", () => {
	assert.equal(getAnycopyRenderHeight(40.9), 38);
});

test("getAnycopyRenderHeight always leaves at least one component row", () => {
	assert.equal(getAnycopyRenderHeight(1), 1);
});

test("getAnycopyTreeHeight applies the selector height ratio", () => {
	assert.equal(getAnycopyTreeHeight(38), 24);
});

test("getAnycopyTreeVisibleLines follows the live render height", () => {
	assert.equal(getAnycopyTreeVisibleLines(38), 12);
	assert.equal(getAnycopyTreeVisibleLines(18), 5);
});
