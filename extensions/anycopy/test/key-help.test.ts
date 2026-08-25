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

test("help groups tree, preview, selection, search, and layout actions", () => {
	const nativeKeys = new Map<string, string[]>([
		["tui.select.up", ["up"]],
		["tui.select.down", ["down"]],
		["tui.editor.cursorLeft", ["left"]],
		["tui.editor.cursorRight", ["right"]],
		["app.tree.foldOrUp", ["ctrl+left"]],
		["app.tree.unfoldOrDown", ["ctrl+right"]],
		["tui.select.confirm", ["enter"]],
		["tui.editor.deleteCharBackward", ["backspace"]],
		["tui.select.cancel", ["escape"]],
		["app.tree.filter.default", ["ctrl+1"]],
		["app.tree.filter.noTools", ["ctrl+2"]],
		["app.tree.filter.userOnly", ["ctrl+3"]],
		["app.tree.filter.labeledOnly", ["ctrl+4"]],
		["app.tree.filter.all", ["ctrl+5"]],
		["app.tree.filter.cycleForward", ["]"]],
		["app.tree.filter.cycleBackward", ["["]],
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

	assert.deepEqual(rows.map((row) => row.label), [
		"move up",
		"move down",
		"page tree up",
		"page tree down",
		"fold branch or jump up",
		"unfold branch or jump down",
		"navigate to focused node",
		"scroll preview",
		"page preview",
		"select range",
		"(de)select node",
		"copy focused or selected nodes",
		"clear selection",
		"search visible nodes",
		"delete search character",
		"clear search or close",
		"use default filter",
		"toggle no-tools filter",
		"toggle user-only filter",
		"toggle labeled-only filter",
		"toggle all-entries filter",
		"cycle filter forward",
		"cycle filter backward",
		"toggle tree or preview focus",
		"edit label",
		"toggle label timestamps",
		"toggle entry timestamps",
		"show or close this help",
	]);
	assert.equal(rows[13] ? formatHelpRowKeys(rows[13]) : undefined, "Type text");
});

test("help formats all effective keys for an action", () => {
	assert.equal(
		formatHelpRowKeys({ keys: ["ctrl+left", "alt+left"], label: "fold" }),
		"Ctrl+Left / Alt+Left",
	);
});

test("embedded help renders native-style padded lines without modal chrome", () => {
	const lines = renderKeyHelpLines(
		[{ keys: ["shift+r"], label: "select range" }],
		80,
		(text) => [text],
	);
	assert.deepEqual(lines, ["  Shift+R: select range"]);
	assert.equal(lines.some((line) => /[┌┐└┘│]/.test(line)), false);
});

test("embedded help window reserves heading and footer rows", () => {
	assert.deepEqual(getKeyHelpWindow(20, 10, 99), {
		offset: 12,
		end: 20,
		pageSize: 8,
	});
});
