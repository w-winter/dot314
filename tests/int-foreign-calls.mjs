#!/usr/bin/env node
// Real Pi + real Claude Code: while the main turn waits on an extension tool,
// that tool asks the model three side questions through ctx.modelRegistry,
// all at once, the way extensions do (watchdog reviewers, MCP sampling,
// summaries): two without a session id, which share the bridge's default
// lane, and one carrying the main session's own id. Each side call must get
// its own answer from its own Claude query, and the main turn must finish
// normally. Before the fix the second default-lane call and the same-id call
// were taken as callbacks of the running queries and never answered.
//
// The probe extension and an isolated agent dir (settings packages: this
// bridge and the probe; a copy of claude-bridge.json) live in a temp dir.
//
// Run: node --import tsx --test tests/int-foreign-calls.mjs

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const TIMEOUT = 180_000;
const SIDE_CALL_TIMEOUT_MS = 90_000;
const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const root = mkdtempSync(join(tmpdir(), "bridge-int-foreign-calls-"));
const agentDir = join(root, "agent");
const probeDir = join(root, "probe-extension");
const probeOut = join(root, "side-calls.json");
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

writeFileSync(join(probeDir, "package.json"), JSON.stringify({ name: "bridge-foreign-calls-probe", private: true, type: "module", pi: { extensions: ["./index.ts"] } }, null, 2));
writeFileSync(join(probeDir, "index.ts"), `
import { writeFileSync } from "node:fs";

const OUT = ${JSON.stringify(probeOut)};
const TIMEOUT_MS = ${SIDE_CALL_TIMEOUT_MS};

export default function (pi: any) {
	pi.registerTool({
		name: "probe_side_calls",
		label: "Probe side calls",
		description: "Runs the side-call probe. Use it when asked to call probe_side_calls.",
		parameters: { type: "object", properties: {} },
		async execute(_id: string, _params: unknown, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: any) {
			const ask = async (token: string, sessionId?: string) => {
				const started = Date.now();
				const context = {
					messages: [
						{ role: "system", content: "You are a probe. Answer with the single word you are asked for and nothing else.", timestamp: Date.now() },
						{ role: "user", content: "Reply with exactly " + token + ".", timestamp: Date.now() },
					],
				};
				const timeout = new Promise((resolve) => setTimeout(() => resolve({ token, timedOut: true, ms: Date.now() - started }), TIMEOUT_MS));
				const call = ctx.modelRegistry.complete(ctx.model, context, { ...(sessionId ? { sessionId } : {}), maxTokens: 64, signal })
					.then((message: any) => ({
						token,
						stopReason: message.stopReason,
						errorMessage: message.errorMessage,
						text: message.content.filter((block: any) => block.type === "text").map((block: any) => block.text).join(""),
						ms: Date.now() - started,
					}), (error: unknown) => ({ token, error: String(error), ms: Date.now() - started }));
				return Promise.race([call, timeout]);
			};
			const results = await Promise.all([
				ask("PROBE_ALPHA"),
				ask("PROBE_BRAVO"),
				ask("PROBE_CHARLIE", ctx.sessionManager.getSessionId()),
			]);
			writeFileSync(OUT, JSON.stringify(results, null, 2));
			return { content: [{ type: "text", text: "probe finished" }], details: {} };
		},
	});
}
`);

const harness = createRpcHarness({
	name: "foreign-calls",
	baseArgs: ["--no-session"],
	env: { PI_CODING_AGENT_DIR: agentDir },
	defaultTimeout: TIMEOUT,
});

describe("side calls through ctx.modelRegistry while the main turn waits on a tool (real Pi)", () => {
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

	it("answers every side call from its own query and finishes the main turn", { timeout: TIMEOUT }, async () => {
		const text = await harness.promptAndWait("Call the probe_side_calls tool once. After it returns, reply with exactly MAIN_OK.");
		assert.ok(existsSync(probeOut), "the probe tool ran");
		const results = JSON.parse(readFileSync(probeOut, "utf8"));
		for (const result of results) {
			assert.equal(result.timedOut, undefined, `${result.token} never settled: ${JSON.stringify(result)}`);
			assert.equal(result.error, undefined, `${result.token} threw: ${JSON.stringify(result)}`);
			assert.equal(result.stopReason, "stop", `${result.token} ended ${result.stopReason}: ${result.errorMessage ?? ""}`);
			assert.match(result.text, new RegExp(result.token), `${result.token} got its own answer: ${JSON.stringify(result.text)}`);
		}

		const { messages } = await harness.send({ type: "get_messages" });
		const last = messages.at(-1);
		assert.equal(last.role, "assistant");
		assert.equal(last.stopReason, "stop", `the main turn ends normally: ${last.errorMessage ?? ""}`);
		assert.match(text, /MAIN_OK/, "the main turn's own reply");
		assert.ok(messages.some((message) => message.role === "toolResult" && JSON.stringify(message.content).includes("probe finished")), "Pi ran the probe tool");
		for (const token of ["PROBE_ALPHA", "PROBE_BRAVO", "PROBE_CHARLIE"]) {
			assert.ok(!JSON.stringify(messages).includes(token), `${token} never leaked into the main conversation`);
		}

		const log = readFileSync(harness.DEBUG_LOG, "utf8");
		const forks = log.split("\n").filter((line) => line.includes("running it as its own query in claude-bridge:fork:"));
		assert.equal(forks.length, 2, `the busy default lane and the busy main lane each forked once:\n${forks.join("\n")}`);
		assert.doesNotMatch(log, /could not be identified|is not the history Claude holds/, "the main query never took a side call as its own");
	});
});
