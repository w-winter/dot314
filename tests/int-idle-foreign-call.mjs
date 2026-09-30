#!/usr/bin/env node
// Real Pi + real Claude Code: when the main turn ends, an extension asks the
// model a side question through ctx.modelRegistry with the main session's own
// id (the way title generators and reviewers do), and the user's next prompt
// arrives while that side call is still running. The side call must get its
// own answer, and the next prompt must resume the main Claude session. Before
// the fix the side call ran in the idle main lane, so the next prompt found
// the lane busy and was sent to a fork that rebuilt the history cold.
//
// The probe extension and an isolated agent dir (settings packages: this
// bridge and the probe; a copy of claude-bridge.json) live in a temp dir.
//
// Run: node --import tsx --test tests/int-idle-foreign-call.mjs

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const TIMEOUT = 150_000;
const SIDE_CALL_WAIT_MS = 60_000;
const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const root = mkdtempSync(join(tmpdir(), "bridge-int-idle-foreign-"));
const agentDir = join(root, "agent");
const probeDir = join(root, "probe-extension");
const probeOut = join(root, "side-call.json");
mkdirSync(agentDir, { recursive: true });
mkdirSync(probeDir, { recursive: true });

const sourceConfig = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "claude-bridge.json");
if (existsSync(sourceConfig)) copyFileSync(sourceConfig, join(agentDir, "claude-bridge.json"));
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
	defaultProvider: "pi-claude",
	defaultModel: "claude-haiku-4-5",
	defaultThinkingLevel: "off",
	quietStartup: true,
	packages: [DIR, probeDir],
	enabledModels: ["pi-claude/claude-haiku-4-5"],
}, null, 2));

writeFileSync(join(probeDir, "package.json"), JSON.stringify({ name: "bridge-idle-foreign-probe", private: true, type: "module", pi: { extensions: ["./index.ts"] } }, null, 2));
writeFileSync(join(probeDir, "index.ts"), `
import { writeFileSync } from "node:fs";

const OUT = ${JSON.stringify(probeOut)};
let asked = false;

export default function (pi: any) {
	pi.on("agent_end", (_event: unknown, ctx: any) => {
		if (asked) return;
		asked = true;
		const started = Date.now();
		const context = {
			messages: [
				{ role: "system", content: "You are a probe. Answer with the single word you are asked for and nothing else.", timestamp: Date.now() },
				{ role: "user", content: "Reply with exactly PROBE_IDLE.", timestamp: Date.now() },
			],
		};
		void ctx.modelRegistry.complete(ctx.model, context, { sessionId: ctx.sessionManager.getSessionId(), maxTokens: 64 })
			.then((message: any) => writeFileSync(OUT, JSON.stringify({
				stopReason: message.stopReason,
				errorMessage: message.errorMessage,
				text: message.content.filter((block: any) => block.type === "text").map((block: any) => block.text).join(""),
				ms: Date.now() - started,
			})), (error: unknown) => writeFileSync(OUT, JSON.stringify({ error: String(error) })));
	});
}
`);

const harness = createRpcHarness({
	name: "idle-foreign-call",
	baseArgs: ["--no-session"],
	env: { PI_CODING_AGENT_DIR: agentDir },
	defaultTimeout: TIMEOUT,
});

describe("a side call with the main session id while the main session is idle (real Pi)", () => {
	before(async () => {
		harness.start();
		await new Promise((resolve) => setTimeout(resolve, 2000));
	});

	after(async () => {
		await harness.stop();
		rmSync(root, { recursive: true, force: true });
		console.log(`  RPC log: ${harness.RPC_LOG}`);
		console.log(`  Debug log: ${harness.DEBUG_LOG}`);
	});

	it("answers the side call and lets the next prompt resume the main session", { timeout: TIMEOUT }, async () => {
		assert.match(await harness.promptAndWait("Reply with exactly FIRST_OK."), /FIRST_OK/);
		// Sent as soon as the first turn ends, while the side call runs.
		assert.match(await harness.promptAndWait("Reply with exactly SECOND_OK."), /SECOND_OK/);

		const deadline = Date.now() + SIDE_CALL_WAIT_MS;
		while (!existsSync(probeOut) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200));
		assert.ok(existsSync(probeOut), "the side call settled");
		const side = JSON.parse(readFileSync(probeOut, "utf8"));
		assert.equal(side.error, undefined, `the side call threw: ${JSON.stringify(side)}`);
		assert.equal(side.stopReason, "stop", `the side call ended ${side.stopReason}: ${side.errorMessage ?? ""}`);
		assert.match(side.text, /PROBE_IDLE/, "the side call got its own answer");

		const { messages } = await harness.send({ type: "get_messages" });
		assert.ok(!JSON.stringify(messages).includes("PROBE_IDLE"), "the side answer never leaked into the main conversation");

		const log = readFileSync(harness.DEBUG_LOG, "utf8").split("\n");
		// The log names no prompt text: the second prompt's query is the first
		// one carrying the main conversation's history (the first prompt and the
		// side call each start from at most a system and a user message).
		const second = log.findIndex((line) => Number(/provider: fresh query model=\S+ requested=\S+ msgs=(\d+)/.exec(line)?.[1] ?? 0) >= 3);
		assert.ok(second > 0, "the second prompt started a query");
		const sync = log.slice(0, second).reverse().find((line) => line.includes("syncResult: path="));
		assert.match(sync ?? "", /path=reuse/, "the second prompt resumes the main Claude session");
		assert.ok(log.some((line) => line.includes("its lane holds another conversation; running it as its own query in claude-bridge:fork:")), "the side call ran in a fork lane");
	});
});
