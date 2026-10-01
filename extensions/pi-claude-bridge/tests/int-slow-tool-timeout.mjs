#!/usr/bin/env node
// Integration: a Pi tool that outlasts a limit Claude Code puts on MCP calls.
// Claude Code (2.1.283) gives up on an in-process SDK server's call in two
// ways, each driven by the environment the bridge's child inherits:
//   - MCP_TOOL_TIMEOUT, a hard wall-clock limit per call (a user's shell may
//     export e.g. 300000 for other servers): CC answers the call with
//     `... timed out after Ns`;
//   - CLAUDE_AUTO_BACKGROUND_TASKS: CC moves a call still running after
//     CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS to a background task and answers it
//     with a placeholder.
// Either way the model ends its turn without the result, the SDK closes the
// query on that turn's result, and the real result Pi produces later is
// orphaned. Here the limits are shortened to a few seconds and SlowTool blocks
// for 15 s; Claude must still receive the real result.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const TEST_TIMEOUT = 120_000;

const CASES = [
	{ name: "slow-tool-timeout", label: "MCP_TOOL_TIMEOUT=5000", env: { MCP_TOOL_TIMEOUT: "5000" } },
	{
		name: "slow-tool-autobackground",
		label: "CLAUDE_AUTO_BACKGROUND_TASKS=1, CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=5000",
		env: { MCP_TOOL_TIMEOUT: "600000", CLAUDE_AUTO_BACKGROUND_TASKS: "1", CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: "5000" },
	},
];

for (const testCase of CASES) {
	const harness = createRpcHarness({
		name: testCase.name,
		args: ["-e", "./tests/fixtures/slow-tool-extension.ts", "--model", "pi-claude/claude-haiku-4-5"],
		env: testCase.env,
		defaultTimeout: TEST_TIMEOUT,
	});

	describe(`Pi tool slower than Claude Code's MCP call limit (${testCase.label})`, () => {
		before(async () => {
			harness.start();
			await new Promise((r) => setTimeout(r, 2000));
		});

		after(async () => {
			await harness.stop();
			console.log(`  RPC log: ${harness.RPC_LOG}`);
			console.log(`  Debug log: ${harness.DEBUG_LOG}`);
		});

		it("Claude receives the real result of a 15 s tool call", { timeout: TEST_TIMEOUT }, async () => {
			const executed = [];
			const removeListener = harness.addListener((msg) => {
				if (msg.type === "tool_execution_end") executed.push({ name: msg.toolName, isError: msg.isError });
			});
			const collector = harness.collectText();
			await harness.send({
				type: "prompt",
				message: "Call SlowTool with seconds set to 15. After it returns, reply with exactly the text it returned and nothing else. If it fails, times out, or is moved to the background, reply with the word FAILED followed by the text you received.",
			});
			await harness.waitForEvent("agent_end");
			removeListener();
			const text = collector.stop();
			const debugLog = readFileSync(harness.DEBUG_LOG, "utf8");
			assert.deepEqual(executed.map((entry) => entry.name), ["SlowTool"], `unexpected executions: ${JSON.stringify(executed)}`);
			assert.doesNotMatch(debugLog, /orphaned tool result/, "the Pi result was orphaned after the query ended");
			assert.match(debugLog, /provider: resolving SlowTool/, "the waiting MCP handler never received Pi's result");
			assert.doesNotMatch(text, /FAILED|timed out|background/i, `Claude did not get the result: ${text.slice(0, 300)}`);
			assert.match(text, /SlowTool completed after 15000ms/, `reply did not carry the real result: ${text.slice(0, 300)}`);
		});
	});
}
