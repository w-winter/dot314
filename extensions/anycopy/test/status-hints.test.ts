import assert from "node:assert/strict";
import test from "node:test";
import { buildStatusTextLines, renderStatusHints } from "../status-hints.ts";

const segments = [
	"Shift+Up/Shift+Down: scroll preview",
	"Shift+PageUp/Shift+PageDown: page preview",
	"Enter: navigate",
	"Shift+R: range",
	"Shift+A: select",
	"Shift+C: copy",
	"Shift+X: clear",
	"Tab: layout",
	"?: help",
];

test("compact hints keep one fixed status row", () => {
	assert.deepEqual(buildStatusTextLines("compact", "?: help · Enter: navigate", ["  Shift+C: copy"]), [
		"  ?: help · Enter: navigate",
	]);
});

test("full hints retain the status row and every wrapped hint row", () => {
	assert.deepEqual(buildStatusTextLines("full", "Ready", ["  Shift+C: copy", "  Shift+X: clear"]), [
		"  Ready",
		"  Shift+C: copy",
		"  Shift+X: clear",
	]);
});

test("status hints delegate the complete text to the native wrapper", () => {
	const wrapped = [
		"Shift+Up/Shift+Down: scroll preview · Shift+PageUp/Shift+PageDown: page",
		"preview · Enter: navigate · Shift+R: range · Shift+A: select · Shift+C: copy ·",
		"Shift+X: clear · Tab: layout · ?: help",
	];
	let receivedText = "";
	let receivedWidth = 0;
	const lines = renderStatusHints(segments, 80, (text, width) => {
		receivedText = text;
		receivedWidth = width;
		return wrapped;
	});

	assert.equal(receivedText, segments.join(" · "));
	assert.equal(receivedWidth, 78);
	assert.deepEqual(lines, wrapped.map((line) => `  ${line}`));
	assert.equal(lines.join(" ").includes("?: help"), true);
});
