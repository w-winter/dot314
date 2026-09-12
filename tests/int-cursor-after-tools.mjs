#!/usr/bin/env node
// Cursor state after a tool-using first turn.
//
// When the first provider turn triggers tool calls (Case 1 clean start),
// sharedSession is null throughout, so tool-result cursor tracking never
// fires. Without the latestCursor fix, the .then handler falls back to the
// stale closure's context.messages.length (=1), causing a spurious rebuild
// on the next turn.
//
// See: https://github.com/elidickinson/pi-claude-bridge/issues/4

import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const BRIDGE_MODEL = "pi-claude/claude-haiku-4-5";

test("turn 2 reuses session after tool-using turn 1 (no spurious rebuild)", { timeout: 120_000 }, async () => {
	const harness = createRpcHarness({
		name: "cursor-after-tools",
		args: ["--model", BRIDGE_MODEL],
		defaultTimeout: 60_000,
	});

	harness.start();
	await new Promise((r) => setTimeout(r, 2000));

	try {
		// Turn 1: force a tool call
		const text1 = await harness.promptAndWait(
			"Use the Read tool to read package.json and tell me the top-level name field. Just the name, nothing else."
		);
		assert.ok(text1, "Turn 1 should produce text");

		// Turn 2: text-only, should reuse session
		const text2 = await harness.promptAndWait(
			"What was the name you just read? Repeat it."
		);
		assert.ok(text2, "Turn 2 should produce text");

		// Check sync decisions
		const debugLog = readFileSync(harness.DEBUG_LOG, "utf8");
		const paths = [];
		for (const match of debugLog.matchAll(/syncResult: path=([a-z-]+)/g)) {
			paths.push(match[1]);
		}

		const rebuilds = paths.filter((p) => p === "rebuild").length;
		const reuses = paths.filter((p) => p === "reuse").length;

		assert.strictEqual(rebuilds, 0,
			`spurious rebuild(s) — cursor likely stuck at 1 after tool-using first turn (issue #4). sync paths: ${paths.join(", ")}`);
		assert.ok(reuses >= 1,
			`expected at least 1 reuse for turn 2, got ${reuses}. sync paths: ${paths.join(", ")}`);
	} finally {
		await harness.stop();
	}
});
