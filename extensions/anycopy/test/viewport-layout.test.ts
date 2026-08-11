import assert from "node:assert/strict";
import test from "node:test";

import { getAnycopyRenderHeight } from "../viewport-layout.ts";

test("getAnycopyRenderHeight preserves the full terminal height in regular mode", () => {
	assert.equal(getAnycopyRenderHeight(40, false), 40);
});

test("getAnycopyRenderHeight reserves fullscreen transcript, spacer, and footer rows", () => {
	assert.equal(getAnycopyRenderHeight(40, true), 36);
});

test("getAnycopyRenderHeight always leaves at least one component row", () => {
	assert.equal(getAnycopyRenderHeight(2, true), 1);
});
