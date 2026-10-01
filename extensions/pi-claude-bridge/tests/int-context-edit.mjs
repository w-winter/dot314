#!/usr/bin/env node
// Integration: Pi rewrites an earlier user message in place (a `context_edit`
// session entry, Pi 0.87+). The history keeps its length and Pi fires no
// session_tree/session_compact event, so a message count alone cannot show
// that Claude's copy is stale. The next turn must rebuild Claude's session
// from Pi's history, and Claude must answer from the rewritten message.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const TEST_TIMEOUT = 90_000;
const diagDir = mkdtempSync(join(tmpdir(), "int-context-edit-"));

const harness = createRpcHarness({
	name: "context-edit",
	args: ["-e", "./tests/fixtures/context-edit-extension.ts", "--model", "pi-claude/claude-haiku-4-5"],
	env: {
		CONTEXT_EDIT_FROM: "My cat is named APPLE",
		CONTEXT_EDIT_TO: "My cat is named ZEBRA",
		CLAUDE_BRIDGE_DIAG_PATH: join(diagDir, "diag.log"),
	},
	defaultTimeout: TEST_TIMEOUT,
});

const syncPaths = () => [...readFileSync(harness.DEBUG_LOG, "utf8").matchAll(/syncResult: path=([a-z-]+)/g)].map((match) => match[1]);

describe("same-length history rewrite through a Pi context edit", () => {
	before(async () => {
		harness.start();
		await new Promise((r) => setTimeout(r, 2000));
	});

	after(async () => {
		await harness.stop();
		console.log(`  RPC log: ${harness.RPC_LOG}`);
		console.log(`  Debug log: ${harness.DEBUG_LOG}`);
	});

	it("rebuilds Claude's session and answers from the rewritten message", { timeout: TEST_TIMEOUT * 3 }, async () => {
		await harness.promptAndWait("Reply with just OK.");
		await harness.promptAndWait("Remember this. My cat is named APPLE. Reply with just OK.");
		// The fixture rewrote APPLE to ZEBRA when the second run settled.
		const { messages } = await harness.send({ type: "get_messages" });
		const userTexts = messages.filter((message) => message.role === "user")
			.map((message) => typeof message.content === "string" ? message.content : message.content.map((block) => block.text ?? "").join(""));
		assert.equal(userTexts.length, 2, "the edit keeps the history length");
		assert.match(userTexts[1], /My cat is named ZEBRA/, "Pi's history carries the rewritten message");
		assert.deepEqual(syncPaths(), ["clean-start", "reuse"], "turn 2 reuses the session");
		const answer = await harness.promptAndWait("What is my cat named? Reply with only the name.");
		const paths = syncPaths();
		assert.equal(paths.length, 3, `three syncs: ${paths.join(", ")}`);
		assert.equal(paths[2], "rebuild", `the rewritten history must rebuild Claude's session (sync paths: ${paths.join(", ")}; answer: ${answer})`);
		assert.match(answer, /ZEBRA/i, `Claude must see the rewritten message (answer: ${answer})`);
		assert.doesNotMatch(answer, /APPLE/i, `Claude must not answer from the stale message (answer: ${answer})`);
	});
});
