#!/usr/bin/env node
// Integration: a tool an extension activates from inside a tool call
// (pi.setActiveTools, like subagents_enable / web_enable) must be callable in
// the SAME turn. The bridge's Claude Code query is started once per prompt, so
// it has to serve the new tool mid-query and hold the enabling result until
// Claude Code has re-listed.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const TEST_TIMEOUT = 90_000;

const harness = createRpcHarness({
	name: "mid-turn-tools",
	args: ["-e", "./tests/fixtures/enable-tools-extension.ts", "--model", "pi-claude/claude-haiku-4-5"],
	defaultTimeout: TEST_TIMEOUT,
});

describe("mid-turn tool activation", () => {
	before(async () => {
		harness.start();
		await new Promise((r) => setTimeout(r, 2000));
	});

	after(async () => {
		await harness.stop();
		console.log(`  RPC log: ${harness.RPC_LOG}`);
		console.log(`  Debug log: ${harness.DEBUG_LOG}`);
	});

	it("a tool enabled by a tool call runs before the turn ends", { timeout: TEST_TIMEOUT }, async () => {
		const executed = [];
		const removeListener = harness.addListener((msg) => {
			if (msg.type === "tool_execution_end") executed.push({ name: msg.toolName, isError: msg.isError });
		});
		const collector = harness.collectText();
		await harness.send({
			type: "prompt",
			message: "Call the enable_extra tool. Then, in this same turn, call the extra_echo tool with text \"PERSIMMON\" and reply with exactly what it returned. If no extra_echo tool is available after enabling, reply exactly MISSING and stop.",
		});
		await harness.waitForEvent("agent_end");
		removeListener();
		const text = collector.stop();
		const names = executed.map((entry) => entry.name);
		assert.ok(names.includes("enable_extra"), `enable_extra never ran: ${JSON.stringify(executed)}`);
		assert.ok(names.includes("extra_echo"), `extra_echo did not run before agent_end (executed ${JSON.stringify(executed)}; reply: ${text.slice(0, 200)})`);
		assert.match(text, /ECHO: PERSIMMON/);
	});
});
