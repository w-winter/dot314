#!/usr/bin/env node
// Integration: a Pi tool whose name Claude Code cannot use verbatim (slash and
// space) and whose schema uses $ref/$defs and oneOf must be callable by Claude
// with correctly shaped arguments, and Pi must execute it with them. The
// bridge serves it under a Claude-safe alias, advertises the real schema, and
// leaves argument validation to Pi.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const TEST_TIMEOUT = 90_000;
const TOOL = "plot/point tool";

const harness = createRpcHarness({
	name: "tool-surface",
	args: ["-e", "./tests/fixtures/tool-surface-extension.ts", "--model", "pi-claude/claude-haiku-4-5"],
	defaultTimeout: TEST_TIMEOUT,
});

describe("tool names and schemas Claude Code cannot take verbatim", () => {
	before(async () => {
		harness.start();
		await new Promise((r) => setTimeout(r, 2000));
	});

	after(async () => {
		await harness.stop();
		console.log(`  RPC log: ${harness.RPC_LOG}`);
		console.log(`  Debug log: ${harness.DEBUG_LOG}`);
	});

	it("Claude calls the aliased tool with $ref/oneOf-shaped arguments and Pi executes it", { timeout: TEST_TIMEOUT }, async () => {
		const started = [];
		const ended = [];
		const removeListener = harness.addListener((msg) => {
			if (msg.type === "tool_execution_start") started.push({ name: msg.toolName, args: msg.args });
			if (msg.type === "tool_execution_end") ended.push({ name: msg.toolName, isError: msg.isError });
		});
		const collector = harness.collectText();
		await harness.send({
			type: "prompt",
			message: "Use the plot tool exactly once: plot a circle of radius 2 at x=3, y=4, with no label. Then reply with exactly the text the tool returned.",
		});
		await harness.waitForEvent("agent_end");
		removeListener();
		const text = collector.stop();
		const calls = started.filter((entry) => entry.name === TOOL);
		assert.equal(calls.length, 1, `Pi must execute ${TOOL} once (started ${JSON.stringify(started)}; reply: ${text.slice(0, 200)})`);
		assert.deepEqual(calls[0].args.at, { x: 3, y: 4 }, "the $ref'd object arrives as an object");
		assert.deepEqual(calls[0].args.shape, { kind: "circle", r: 2 }, "the oneOf branch arrives as an object");
		assert.ok(calls[0].args.label === undefined || calls[0].args.label === null, `label: ${JSON.stringify(calls[0].args.label)}`);
		assert.deepEqual(ended.filter((entry) => entry.name === TOOL).map((entry) => entry.isError), [false], "Pi's validation accepted the arguments");
		assert.match(text, /PLOTTED circle r=2 at 3,4/);
	});
});
