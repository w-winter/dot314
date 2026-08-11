import assert from "node:assert/strict";
import test from "node:test";

import { getAnycopyRenderHeight } from "../viewport-layout.ts";

test("getAnycopyRenderHeight uses the terminal height as the overlay budget", () => {
	assert.equal(getAnycopyRenderHeight(40), 40);
});

test("getAnycopyRenderHeight floors fractional terminal heights", () => {
	assert.equal(getAnycopyRenderHeight(40.9), 40);
});

test("getAnycopyRenderHeight always leaves at least one component row", () => {
	assert.equal(getAnycopyRenderHeight(0), 1);
});
