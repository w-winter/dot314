import assert from "node:assert/strict";
import test from "node:test";
import { formatConfiguredKey, formatHelpRowKeys, getKeyHelpPreferredWidth } from "../key-help-data.ts";

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

test("preferred width includes key and action columns", () => {
	assert.equal(getKeyHelpPreferredWidth([{ keys: ["?"], label: "show help" }]), 56);
	assert.ok(
		getKeyHelpPreferredWidth([
			{ keys: ["shift+ctrl+pageup"], label: "a deliberately long action label that exceeds the minimum width" },
		]) > 56,
	);
});
