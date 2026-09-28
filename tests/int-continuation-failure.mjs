#!/usr/bin/env node
// Real Pi + real Claude Code: a steer sent while a tool runs is replayed as a
// continuation query after Claude's reply completes. Here the continuation's
// Claude Code process fails (a `claude` wrapper exits 1 on its first
// --resume=<id>, which only a continuation uses in a fresh session). The reply
// Claude completed before the steer must stay a normal Pi reply, and the next
// prompt's rebuild must import it into Claude's session exactly once.
//
// Run: node --import tsx --test tests/int-continuation-failure.mjs

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { openSession } from "cc-session-io";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const TIMEOUT = 90_000;
const cleanPath = process.env.PATH.split(":").filter((p) => !p.includes("node_modules")).join(":");
const realClaude = realpathSync(execFileSync("/usr/bin/which", ["claude"], { env: { PATH: cleanPath }, encoding: "utf8" }).trim());

const wrapperDir = mkdtempSync(join(tmpdir(), "bridge-int-continuation-"));
const failedOnce = join(wrapperDir, "failed-once");
writeFileSync(join(wrapperDir, "claude"), `#!/bin/sh
for arg in "$@"; do
	case "$arg" in --resume=*) resume=1 ;; esac
	if [ -n "$resume" ] && [ ! -e "${failedOnce}" ]; then
		: > "${failedOnce}"
		echo "simulated continuation failure" >&2
		exit 1
	fi
done
exec "${realClaude}" "$@"
`);
chmodSync(join(wrapperDir, "claude"), 0o755);

const harness = createRpcHarness({
	name: "continuation-failure",
	args: ["-e", "./tests/fixtures/slow-tool-extension.ts", "--model", "pi-claude/claude-haiku-4-5"],
	env: { PATH: `${wrapperDir}:${cleanPath}` },
	defaultTimeout: TIMEOUT,
});

describe("continuation failure after a completed reply (real Pi)", () => {
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

	it("keeps the completed reply in Pi and in the rebuilt Claude session", { timeout: TIMEOUT * 2 }, async () => {
		const { send, waitForEvent } = harness;
		await send({
			type: "prompt",
			message: "Call SlowTool with seconds=4. After it returns, reply with exactly ORCHID-7 and nothing else.",
		});
		await waitForEvent("tool_execution_start");
		await send({ type: "prompt", message: "Also reply with exactly KIWI-3.", streamingBehavior: "steer" });
		await waitForEvent("agent_end");
		assert.ok(existsSync(failedOnce), "the continuation's Claude Code process was the one that failed");

		const { messages } = await send({ type: "get_messages" });
		const last = messages.at(-1);
		const lastText = last.content.filter((block) => block.type === "text").map((block) => block.text).join("");
		assert.equal(last.role, "assistant");
		assert.equal(last.stopReason, "stop", `completed reply must not become an error turn: ${JSON.stringify({ stopReason: last.stopReason, errorMessage: last.errorMessage })}`);
		assert.match(lastText, /ORCHID-7/);
		const debugLog = readFileSync(harness.DEBUG_LOG, "utf8");
		assert.match(debugLog, /deferred continuation failed after a completed reply/);

		// The next prompt rebuilds from Pi history (the failed steer may never
		// have reached Claude); the rebuilt session must hold the reply once.
		await send({ type: "prompt", message: "Reply with exactly DONE." });
		await waitForEvent("agent_end");
		const rebuilt = [...readFileSync(harness.DEBUG_LOG, "utf8").matchAll(/syncResult: path=rebuild sessionId=([0-9a-f-]+)/g)].at(-1)?.[1];
		assert.ok(rebuilt, "the prompt after the failure rebuilt the Claude session");
		const records = readFileSync(openSession({ sessionId: rebuilt, projectPath: harness.DIR }).jsonlPath, "utf8")
			.trim().split("\n").map((line) => JSON.parse(line)).filter((entry) => entry.message?.role === "assistant");
		const withReply = records.filter((entry) => Array.isArray(entry.message.content) &&
			entry.message.content.some((block) => block.type === "text" && block.text.includes("ORCHID-7")));
		assert.equal(withReply.length, 1, "the completed reply is imported into Claude exactly once");
	});
});
