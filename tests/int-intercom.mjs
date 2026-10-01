#!/usr/bin/env node
// Opt-in integration: this bridge and pi-intercom loaded together in two real
// Pi RPC sessions on Claude Haiku.
//
//   1. An idle ask from A to B returns B's threaded reply to A.
//   2. A message that arrives at A while A's `ask` tool is blocked reaches
//      Claude exactly once, after the ask result.
//   3. Aborting A while an ask is pending cancels it without hanging, and A's
//      next prompt works.
//
// Isolation: both sessions and the side CLI share one temp PI_CODING_AGENT_DIR
// that holds only a copy of claude-bridge.json and a settings.json listing this
// worktree and pi-intercom. pi-intercom roots its broker under
// $PI_CODING_AGENT_DIR/intercom, and a unique PI_INTERCOM_SCOPE_ID fences the
// routing scope, so the test can never see or message the owner's sessions.
//
// Skips when pi-intercom is absent (override its path with PI_INTERCOM_PATH).
// Uses real Haiku turns: run it by hand, it is not part of test:ci.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const INTERCOM_PATH = process.env.PI_INTERCOM_PATH ?? join(homedir(), ".pi/agent/extensions/pi-intercom");
const INTERCOM_PRESENT = existsSync(join(INTERCOM_PATH, "index.ts"));
const BRIDGE_CONFIG = join(homedir(), ".pi/agent/claude-bridge.json");
const MODEL = "pi-claude/claude-haiku-4-5";
const TURN_TIMEOUT = 75_000;

const scope = `d2-int-${randomUUID()}`;
// Created in before(), so a skipped run leaves nothing behind.
let agentDir;
let asker;
let worker;

function sessionEnv(stableId) {
	return {
		PI_CODING_AGENT_DIR: agentDir,
		PI_INTERCOM_SCOPE_ID: scope,
		PI_INTERCOM_STABLE_ID: stableId,
		PI_INTERCOM_NAME_POLL_MS: "200",
		// Never inherit the parent session's intercom identity or subagent role.
		PI_INTERCOM_SESSION_ID: undefined,
		PI_SUBAGENT_CHILD: undefined,
		PI_SUBAGENT_INTERCOM_SESSION_NAME: undefined,
	};
}

function createSession(name, stableId) {
	return createRpcHarness({
		name: `intercom-${name}`,
		baseArgs: ["--no-session", "--name", name],
		args: ["--model", MODEL],
		env: sessionEnv(stableId),
		defaultTimeout: TURN_TIMEOUT,
	});
}

/** Sends a message to `to` from the pi-intercom CLI, inside the test scope. */
function cliSend(to, text) {
	const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_INTERCOM_SCOPE_ID: scope };
	for (const key of ["PI_INTERCOM_SESSION_ID", "PI_INTERCOM_STABLE_ID", "PI_SUBAGENT_CHILD", "PI_SUBAGENT_INTERCOM_SESSION_NAME"]) delete env[key];
	return new Promise((resolve, reject) => {
		execFile(
			process.execPath,
			["--import", "tsx", join(INTERCOM_PATH, "cli.ts"), "send", "--to", to, "--text", text, "--name", "d2-side-cli", "--json"],
			{ env, cwd: INTERCOM_PATH, timeout: 20_000 },
			(error, stdout, stderr) => error ? reject(new Error(`cli send failed: ${error.message}\n${stderr}`)) : resolve(stdout),
		);
	});
}

/** Collects the tool calls and results the session emits until removed. */
function watchTools(session) {
	const starts = [];
	const ends = [];
	const remove = session.addListener((msg) => {
		if (msg.type === "tool_execution_start") starts.push({ at: Date.now(), name: msg.toolName, args: msg.args });
		if (msg.type === "tool_execution_end") ends.push({ at: Date.now(), name: msg.toolName, isError: msg.isError, text: JSON.stringify(msg.result ?? "") });
	});
	return { starts, ends, remove };
}

const debugLines = (session) => readFileSync(session.DEBUG_LOG, "utf8").split("\n");
const count = (lines, pattern) => lines.filter((line) => pattern.test(line)).length;
const firstIndex = (lines, pattern) => lines.findIndex((line) => pattern.test(line));

/** Claude's own transcript for the asker's session, found by the id prefix the
 *  bridge logs. Returns the user-authored prompt texts, in order. A message
 *  written to a running query (live steering) is persisted as a
 *  `queued_command` attachment instead of a user entry; both shapes are
 *  prompts here, marked by `shape`. */
function claudeUserPrompts(session) {
	const lines = debugLines(session);
	const prefix = lines.map((line) => line.match(/query done, session=([0-9a-f]{8})/)?.[1]).filter(Boolean).at(-1);
	if (!prefix) return null;
	const claudeDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
	const projectDir = join(claudeDir, "projects", process.cwd().replace(/[^A-Za-z0-9]/g, "-"));
	if (!existsSync(projectDir)) return null;
	const file = readdirSync(projectDir).find((entry) => entry.startsWith(prefix) && entry.endsWith(".jsonl"));
	if (!file) return null;
	const records = readFileSync(join(projectDir, file), "utf8").split("\n").filter(Boolean).map((line) => {
		try { return JSON.parse(line); } catch { return null; }
	}).filter(Boolean);
	const entries = [];
	for (const record of records) {
		if (record.type === "attachment" && record.attachment?.type === "queued_command") {
			const prompt = record.attachment.prompt;
			const texts = typeof prompt === "string" ? [prompt] : Array.isArray(prompt) ? prompt.filter((block) => block.type === "text").map((block) => block.text) : [];
			for (const text of texts) entries.push({ kind: "prompt", shape: "queued_command", text });
			continue;
		}
		if (record.type !== "user" || record.isMeta) continue;
		const content = record.message?.content;
		if (typeof content === "string") entries.push({ kind: "prompt", shape: "user", text: content });
		else if (Array.isArray(content)) {
			for (const block of content) {
				if (block.type === "text") entries.push({ kind: "prompt", shape: "user", text: block.text });
				if (block.type === "tool_result") entries.push({ kind: "tool_result", text: JSON.stringify(block.content) });
			}
		}
	}
	return entries;
}

describe("pi-intercom with the Claude bridge (real Pi, isolated broker)", { skip: INTERCOM_PRESENT ? false : `pi-intercom not found at ${INTERCOM_PATH}` }, () => {
	before(async () => {
		agentDir = mkdtempSync(join(tmpdir(), "bridge-int-intercom-"));
		if (existsSync(BRIDGE_CONFIG)) copyFileSync(BRIDGE_CONFIG, join(agentDir, "claude-bridge.json"));
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
			quietStartup: true,
			packages: [process.cwd(), INTERCOM_PATH],
		}, null, 2));
		asker = createSession("d2-asker", `d2-asker-${randomUUID().slice(0, 8)}`);
		worker = createSession("d2-worker", `d2-worker-${randomUUID().slice(0, 8)}`);
		asker.start();
		worker.start();
		await new Promise((resolve) => setTimeout(resolve, 4000));
	});

	after(async () => {
		await asker?.stop();
		await worker?.stop();
		// Leave time for the broker to notice the last client and exit before its dir goes.
		await new Promise((resolve) => setTimeout(resolve, 500));
		if (agentDir) rmSync(agentDir, { recursive: true, force: true });
		console.log(`  asker debug log: ${asker?.DEBUG_LOG}`);
		console.log(`  worker debug log: ${worker?.DEBUG_LOG}`);
	});

	it("an idle ask gets the other session's threaded reply", { timeout: 2 * TURN_TIMEOUT }, async () => {
		const tools = watchTools(asker);
		const workerTools = watchTools(worker);
		const text = await asker.promptAndWait(
			"Call the intercom tool once with action \"ask\", to \"d2-worker\", message \"Reply to this ask with exactly ORCHID-731 using the intercom tool's reply action.\". When it returns, reply with exactly the text the other session sent back.",
		);
		tools.remove();
		workerTools.remove();
		const ask = tools.ends.find((end) => end.name === "intercom");
		assert.ok(ask, `the asker never ran intercom: ${JSON.stringify(tools.starts)}`);
		assert.equal(ask.isError, false, `ask failed: ${ask.text.slice(0, 300)}`);
		assert.match(ask.text, /ORCHID-731/, "the ask result must carry the worker's reply");
		assert.ok(workerTools.ends.some((end) => end.name === "intercom" && !end.isError), "the worker must answer through intercom");
		assert.match(text, /ORCHID-731/);
		assert.ok(existsSync(join(agentDir, "intercom")), "the broker must run from the isolated agent dir");
	});

	it("a message arriving while ask blocks reaches Claude once, after the ask result", { timeout: 2 * TURN_TIMEOUT }, async () => {
		const tools = watchTools(asker);
		const collector = asker.collectText();
		const startLine = debugLines(asker).length;
		await asker.send({
			type: "prompt",
			message: "Call the intercom tool once with action \"ask\", to \"d2-worker\", message \"First run the bash command `sleep 6`, then reply to this ask with exactly DELAY-DONE using the intercom tool's reply action.\". When it returns, say what it returned. If you later receive any other message containing a token like SIDE-..., repeat that token.",
		});
		await asker.waitForMatch((msg) => msg.type === "tool_execution_start" && msg.toolName === "intercom", "asker intercom call");
		await new Promise((resolve) => setTimeout(resolve, 1500));
		const sent = await cliSend("d2-asker", "SIDE-TOKEN-993: unrelated note, please acknowledge it.");
		const sentAt = Date.now();
		assert.match(sent, /"delivered":\s*true/, `side message was not delivered: ${sent}`);
		await asker.waitForEvent("agent_end", TURN_TIMEOUT);
		collector.stop();
		tools.remove();

		const ask = tools.ends.find((end) => end.name === "intercom");
		assert.ok(ask && !ask.isError, `ask failed: ${ask?.text.slice(0, 300)}`);
		assert.match(ask.text, /DELAY-DONE/);
		assert.ok(sentAt <= ask.at, "the side message must arrive while the ask is still blocked");

		const lines = debugLines(asker).slice(startLine);
		// The log carries no tool output or user text, only shapes: the ask is
		// this window's only intercom call and the side message its only
		// mid-query user message. Claude's transcript below checks the content.
		const resolved = firstIndex(lines, /provider: resolving intercom \[/);
		assert.notEqual(resolved, -1, "the ask result must reach the waiting MCP handler");
		// Live steering: the side message goes to the running query, written
		// before the ask result is released; Claude's transcript (below) shows
		// what Claude saw, in order.
		assert.equal(count(lines, /provider: sending \d+ user message\(s\) to the running query before its tool results: /), 1, "sent to the running query exactly once");
		assert.equal(count(lines, /provider: deferred \d+ user message\(s\) /), 0, "never also queued for a continuation");
		assert.equal(count(lines, /provider: replaying deferred user message: /), 0, "never replayed");
		assert.equal(count(lines, /deferred_user_messages_dropped|orphaned tool result/), 0);

		const prompts = claudeUserPrompts(asker);
		if (prompts) {
			const sideAt = prompts.map((entry, index) => entry.kind === "prompt" && entry.text.includes("SIDE-TOKEN-993") ? index : -1).filter((index) => index >= 0);
			// Counted across both shapes: a user prompt entry and a queued_command attachment.
			assert.equal(sideAt.length, 1, `Claude's transcript must hold the side message exactly once: ${JSON.stringify(prompts.map((entry) => `${entry.shape ?? entry.kind}:${entry.text.slice(0, 60)}`))}`);
			const askResultAt = prompts.findIndex((entry) => entry.kind === "tool_result" && entry.text.includes("DELAY-DONE"));
			assert.ok(askResultAt !== -1 && askResultAt < sideAt[0], "Claude must see the ask result before the side message");
		} else {
			console.log("  (Claude transcript not found; checked the bridge log only)");
		}
	});

	it("aborting a pending ask cancels it and the next prompt works", { timeout: 2 * TURN_TIMEOUT }, async () => {
		const tools = watchTools(asker);
		await asker.send({
			type: "prompt",
			message: "Call the intercom tool once with action \"ask\", to \"d2-worker\", message \"First run the bash command `sleep 40`, then reply to this ask with exactly LATE-REPLY using the intercom tool's reply action.\". Wait for its reply.",
		});
		await asker.waitForMatch((msg) => msg.type === "tool_execution_start" && msg.toolName === "intercom", "asker intercom call");
		await new Promise((resolve) => setTimeout(resolve, 2000));
		const abortedAt = Date.now();
		const agentEnd = asker.waitForEvent("agent_end", 20_000);
		await asker.send({ type: "abort" }, 20_000);
		await agentEnd;
		const settleMs = Date.now() - abortedAt;
		tools.remove();
		assert.ok(settleMs < 15_000, `abort took ${settleMs}ms to settle`);
		const ask = tools.ends.find((end) => end.name === "intercom");
		assert.ok(!ask || (ask.isError && /Cancelled/.test(ask.text)), `the pending ask must end cancelled: ${ask?.text.slice(0, 200)}`);
		// Stop the worker's sleep so it cannot reply into the next turn.
		await worker.send({ type: "abort" }, 20_000).catch(() => {});

		// "Works" means the bridge delivered the prompt and Claude answered it in a
		// normal turn. Whether Haiku repeats the token or talks about the cancelled
		// ask instead is the model's choice, so the reply text is not asserted.
		const collector = asker.collectText();
		await asker.send({ type: "prompt", message: "Reply with exactly PONG-58 and nothing else. Do not call any tools." });
		const end = await asker.waitForEvent("agent_end", TURN_TIMEOUT);
		const text = collector.stop();
		const reply = end.messages.filter((message) => message.role === "assistant").at(-1);
		assert.equal(reply?.stopReason, "stop", `the prompt after abort must end normally: ${reply?.stopReason} ${reply?.errorMessage ?? ""}`);
		assert.ok(text.trim().length > 0, "the prompt after abort must get a reply");
		const prompts = claudeUserPrompts(asker);
		if (prompts) {
			assert.ok(prompts.some((entry) => entry.kind === "prompt" && entry.text.includes("PONG-58")), "Claude's transcript must hold the prompt sent after the abort");
		} else {
			console.log("  (Claude transcript not found; checked the turn only)");
		}
	});
});
