import assert from "node:assert/strict";
import test from "node:test";
import { getKeyHelpWindow, renderKeyHelpLines } from "../key-help.ts";
import { buildKeyHelpRows, formatConfiguredKey, formatHelpRowKeys } from "../key-help-data.ts";

test("help spells every modifier out", () => {
	assert.equal(formatConfiguredKey("shift+ctrl+t"), "Shift+Ctrl+T");
	assert.equal(formatConfiguredKey("shift+pageup"), "Shift+PageUp");
	assert.equal(formatConfiguredKey("escape"), "Esc");
	assert.equal(formatConfiguredKey("super+shift+p"), "Super+Shift+P");
});

test("help includes effective native and anycopy actions but omits native Ctrl+X copy", () => {
	const nativeKeys = new Map<string, string[]>([
		["tui.select.up", ["up"]],
		["app.message.copy", ["ctrl+x"]],
		["app.tree.editLabel", ["shift+l"]],
	]);
	const rows = buildKeyHelpRows(
		(id) => nativeKeys.get(id) ?? [],
		{
			toggleSelect: "shift+a",
			copy: "shift+c",
			clear: "shift+x",
			toggleLabelTimestamps: "shift+t",
			toggleEntryTimestamps: "shift+ctrl+t",
			scrollDown: "shift+down",
			scrollUp: "shift+up",
			pageDown: "shift+pagedown",
			pageUp: "shift+pageup",
			togglePaneFocus: "tab",
			toggleRangeSelection: "shift+r",
			help: "?",
		},
	);

	assert.deepEqual(rows.find((row) => row.label === "move up")?.keys, ["up"]);
	assert.deepEqual(rows.find((row) => row.label === "edit label")?.keys, ["shift+l"]);
	assert.deepEqual(rows.find((row) => row.label === "copy focused or selected nodes")?.keys, ["shift+c"]);
	assert.equal(rows.some((row) => row.keys.length === 0), false);
	assert.equal(rows.flatMap((row) => row.keys).includes("ctrl+x"), false);
});

test("shortcut-opened help explains that Enter cannot navigate", () => {
	const rows = buildKeyHelpRows(
		(id) => id === "tui.select.confirm" ? ["enter"] : [],
		{
			toggleSelect: "shift+a",
			copy: "shift+c",
			clear: "shift+x",
			toggleLabelTimestamps: "shift+t",
			toggleEntryTimestamps: "shift+ctrl+t",
			scrollDown: "shift+down",
			scrollUp: "shift+up",
			pageDown: "shift+pagedown",
			pageUp: "shift+pageup",
			togglePaneFocus: "tab",
			toggleRangeSelection: "shift+r",
			help: "?",
		},
		false,
	);

	assert.deepEqual(rows.find((row) => row.keys.includes("enter")), {
		keys: ["enter"],
		label: "navigation unavailable, open /anycopy as a command",
	});
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
