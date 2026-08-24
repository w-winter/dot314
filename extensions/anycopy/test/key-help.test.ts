import assert from "node:assert/strict";
import test from "node:test";
import { getKeyHelpWindow, renderKeyHelpLines } from "../key-help.ts";
import { formatConfiguredKey, formatHelpRowKeys } from "../key-help-data.ts";

test("help spells every modifier out", () => {
	assert.equal(formatConfiguredKey("shift+ctrl+t"), "Shift+Ctrl+T");
	assert.equal(formatConfiguredKey("shift+pageup"), "Shift+PageUp");
	assert.equal(formatConfiguredKey("escape"), "Esc");
});

test("help formats all effective keys for an action", () => {
	assert.equal(
		formatHelpRowKeys({ keys: ["ctrl+left", "alt+left"], label: "fold" }),
		"Ctrl+Left / Alt+Left",
	);
});

test("embedded help renders native-style padded lines without modal chrome", () => {
	const lines = renderKeyHelpLines(
		[{ keys: ["shift+r"], label: "start or finish range selection" }],
		80,
		(text) => [text],
	);
	assert.deepEqual(lines, ["  Shift+R: start or finish range selection"]);
	assert.equal(lines.some((line) => /[┌┐└┘│]/.test(line)), false);
});

test("embedded help window reserves heading and footer rows", () => {
	assert.deepEqual(getKeyHelpWindow(20, 10, 99), {
		offset: 12,
		end: 20,
		pageSize: 8,
	});
});
