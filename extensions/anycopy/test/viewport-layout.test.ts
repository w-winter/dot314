import assert from "node:assert/strict";
import test from "node:test";

import { getAnycopyRenderHeight } from "../viewport-layout.ts";

test("getAnycopyRenderHeight leaves Pi's two-line footer below the overlay", () => {
	assert.equal(getAnycopyRenderHeight(40), 38);
});

test("getAnycopyRenderHeight floors fractional terminal heights", () => {
	assert.equal(getAnycopyRenderHeight(40.9), 38);
});

test("getAnycopyRenderHeight always leaves at least one component row", () => {
	assert.equal(getAnycopyRenderHeight(1), 1);
});
