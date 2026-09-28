#!/usr/bin/env node
// Real Pi + real Claude Code: Claude Code dies while Pi is still running the
// tool it asked for (a `claude` wrapper kills its first process once the test
// sees Pi start the tool). The failure ends the query after the tool-use turn reached Pi, so the
// tool-result callback that follows must report it as its own error message,
// once, instead of ending the turn as if Claude had finished.
//
// Run: node --import tsx --test tests/int-late-failure.mjs

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const TIMEOUT = 90_000;
const cleanPath = process.env.PATH.split(":").filter((p) => !p.includes("node_modules")).join(":");
const realClaude = realpathSync(execFileSync("/usr/bin/which", ["claude"], { env: { PATH: cleanPath }, encoding: "utf8" }).trim());

const wrapperDir = mkdtempSync(join(tmpdir(), "bridge-int-late-failure-"));
const killedOnce = join(wrapperDir, "killed-once");
const killNow = join(wrapperDir, "kill-now");
writeFileSync(join(wrapperDir, "claude"), `#!/bin/sh
if [ -e "${killedOnce}" ]; then exec "${realClaude}" "$@"; fi
: > "${killedOnce}"
# An async command gets /dev/null as stdin unless redirected explicitly.
"${realClaude}" "$@" 0<&0 &
child=$!
( while [ ! -e "${killNow}" ]; do sleep 0.2; done; kill -9 "$child" 2>/dev/null ) &
watcher=$!
wait "$child"
kill "$watcher" 2>/dev/null
exit 1
`);
chmodSync(join(wrapperDir, "claude"), 0o755);

const harness = createRpcHarness({
	name: "late-failure",
	args: ["-e", "./tests/fixtures/slow-tool-extension.ts", "--model", "pi-claude/claude-haiku-4-5"],
	env: { PATH: `${wrapperDir}:${cleanPath}` },
	defaultTimeout: TIMEOUT,
});

describe("terminal failure after the tool turn reached Pi (real Pi)", () => {
	before(async () => {
		harness.start();
		await new Promise((resolve) => setTimeout(resolve, 2000));
	});

	after(async () => {
		await harness.stop();
		rmSync(wrapperDir, { recursive: true, force: true });
		console.log(`  RPC log: ${harness.RPC_LOG}`);
		console.log(`  Debug log: ${harness.DEBUG_LOG}`);
	});

	it("reports the failure on the tool-result callback, once, leaving the tool turn intact", { timeout: TIMEOUT }, async () => {
		const { send, waitForEvent } = harness;
		const toolStarted = waitForEvent("tool_execution_start");
		await send({ type: "prompt", message: "Call SlowTool with seconds=6. After it returns, reply with exactly ORCHID-7." });
		await toolStarted;
		writeFileSync(killNow, "");
		await waitForEvent("agent_end");
		assert.ok(existsSync(killedOnce), "the wrapper ran");

		const { messages } = await send({ type: "get_messages" });
		const assistants = messages.filter((message) => message.role === "assistant");
		const toolTurn = assistants.find((message) => message.content.some((block) => block.type === "toolCall"));
		assert.ok(toolTurn, "the tool-use turn reached Pi");
		assert.equal(toolTurn.stopReason, "toolUse", "the delivered tool turn is not changed");
		assert.ok(messages.some((message) => message.role === "toolResult" && JSON.stringify(message.content).includes("SlowTool completed")), "Pi ran the tool");
		const last = messages.at(-1);
		assert.equal(last.role, "assistant");
		assert.equal(last.stopReason, "error", `the failure must reach Pi, not a silent stop: ${JSON.stringify({ stopReason: last.stopReason, errorMessage: last.errorMessage })}`);
		assert.match(last.errorMessage ?? "", /exited|code|signal|killed/i);
		assert.deepEqual(last.content, []);
		assert.equal(assistants.filter((message) => message.stopReason === "error").length, 1, "reported exactly once");
	});
});
