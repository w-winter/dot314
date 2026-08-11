import assert from "node:assert/strict";
import test from "node:test";

import { getAnycopyRenderHeight } from "../viewport-layout.ts";

test("getAnycopyRenderHeight preserves the component's final separator above Pi's footer", () => {
	assert.equal(getAnycopyRenderHeight(40), 37);
});

test("getAnycopyRenderHeight floors fractional terminal heights", () => {
	assert.equal(getAnycopyRenderHeight(40.9), 37);
});

test("getAnycopyRenderHeight always leaves at least one component row", () => {
	assert.equal(getAnycopyRenderHeight(1), 1);
});
