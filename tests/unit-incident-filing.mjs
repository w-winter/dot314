// Incident filing: with a user-scoped `incidents.repo`, a new non-expected
// incident becomes an issue in that repo through `gh`, or a comment on the
// open issue that already carries its marker. Filing is rate limited, never
// blocks the stream, and every string it publishes passes the sanitizer.
// `gh` here is a fake on PATH that records its argv and stdin.
import "./lib/debug-env.mjs";

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import claudeBridge, { __testSetBridgeIntegrityState, __testSetSdkQueryFactory, streamClaudeAgentSdk } from "../src/index.ts";
import { setExtensionApi } from "../src/bridge-state.ts";
import { REPRO_TEST_FILES, __testSetFilerClock } from "../src/incident-filer.ts";
import { __testFlushIncidents, __testResetIncidents, listIncidents, recordIncident } from "../src/incidents.ts";
import { resetStack } from "../src/query-state.ts";

const REPO = "nicobailon/bridge-incidents";
const HOUR = 60 * 60 * 1000;
const PROMPT_SENTINEL = "PROMPT-SENTINEL-do-not-file";
const API_SENTINEL = "API-SENTINEL-do-not-file";
// Built at run time: the sanitizer keeps these out of what is filed.
const mention = (name) => `@${name}`;
const otherRef = ["someone-else", "their-repo"].join("/") + "#12";
const otherLink = ["https://github.com", "someone-else", "their-repo", "issues", "3"].join("/");

const model = {
	id: "claude-haiku-4-5",
	name: "Claude Haiku",
	api: "claude-bridge",
	provider: "pi-claude",
	baseUrl: "claude-bridge",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8192,
};

let agentDir;
let ghDir;
let savedPath;
let clock;

/** A fake `gh`: logs {argv, stdin}, answers `issue list` from its state file,
 *  and numbers the issues it creates. `mode: "auth"` fails like a logged-out
 *  gh does. */
function installFakeGh(state = {}) {
	ghDir = mkdtempSync(join(agentDir, "gh-"));
	writeFileSync(join(ghDir, "state.json"), JSON.stringify({ mode: "ok", issues: [], next: 7, ...state }));
	writeFileSync(join(ghDir, "gh"), `#!${process.execPath}
const fs = require("fs");
const path = require("path");
const dir = ${JSON.stringify(ghDir)};
let stdin = "";
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
	const argv = process.argv.slice(2);
	fs.appendFileSync(path.join(dir, "log.jsonl"), JSON.stringify({ argv, stdin }) + "\\n");
	const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
	if (state.mode === "auth") {
		process.stderr.write("To get started with GitHub CLI, please run:  gh auth login\\n");
		process.exit(4);
	}
	const repo = argv[argv.indexOf("--repo") + 1];
	if (argv[0] === "issue" && argv[1] === "list") {
		process.stdout.write(JSON.stringify(state.issues));
	} else if (argv[0] === "issue" && argv[1] === "create") {
		const number = state.next++;
		state.issues.push({ number, body: stdin });
		fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state));
		process.stdout.write("https://github.com/" + repo + "/issues/" + number + "\\n");
	} else if (argv[0] === "issue" && argv[1] === "comment") {
		process.stdout.write("https://github.com/" + repo + "/issues/" + argv[2] + "#issuecomment-1\\n");
	} else {
		process.exit(1);
	}
});
`, { mode: 0o755 });
	process.env.PATH = `${ghDir}:${savedPath}`;
}

function ghCalls() {
	const log = join(ghDir, "log.jsonl");
	if (!existsSync(log)) return [];
	return readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

const creates = () => ghCalls().filter((call) => call.argv[1] === "create");
const comments = () => ghCalls().filter((call) => call.argv[1] === "comment");

function enableFiling() {
	writeFileSync(join(agentDir, "claude-bridge.json"), JSON.stringify({ incidents: { repo: REPO } }));
	loadExtension();
}

function loadExtension() {
	claudeBridge({
		on: () => {},
		registerCommand: () => {},
		registerProvider: () => {},
		registerTool: () => {},
		events: { emit: () => {} },
		appendEntry: () => {},
	});
}

async function collect(stream) {
	const events = [];
	for await (const event of stream) events.push(event);
	return events;
}

/** One query whose Claude Code reports an API error: an external incident. */
async function runApiError() {
	__testSetSdkQueryFactory(() => ({
		async *[Symbol.asyncIterator]() {
			yield { type: "system", subtype: "init", session_id: "filing-session", claude_code_version: "9.9.9" };
			yield { type: "result", subtype: "error_during_execution", is_error: true, errors: [`API Error: 400 ${API_SENTINEL}`], session_id: "filing-session" };
		},
		close() {},
		async interrupt() {},
	}));
	const context = { messages: [{ role: "system", content: "test system prompt", timestamp: 0 }, { role: "user", content: PROMPT_SENTINEL, timestamp: Date.now() }] };
	return collect(streamClaudeAgentSdk(model, context, { sessionId: "filing" }));
}

const marker = (signature) => `<!-- claude-bridge-incident: ${signature} -->`;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "bridge-filing-"));
	savedPath = process.env.PATH;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT = "0";
	process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token";
	process.env.CLAUDE_BRIDGE_DIAG_PATH = join(agentDir, "diag.log");
	clock = Date.parse("2026-09-28T12:00:00Z");
	resetStack();
	__testResetIncidents();
	__testSetFilerClock(() => clock);
	__testSetBridgeIntegrityState({ sharedSession: null, ui: { notify: () => {} } });
	setExtensionApi({ events: { emit: () => {} }, appendEntry: () => {} });
});

afterEach(() => {
	process.env.PATH = savedPath;
	delete process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT;
	delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
	delete process.env.CLAUDE_BRIDGE_DIAG_PATH;
	__testSetSdkQueryFactory();
	__testSetFilerClock();
	setExtensionApi(undefined);
	resetStack();
	__testResetIncidents();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
	rmSync(agentDir, { recursive: true, force: true });
});

describe("incident filing", () => {
	it("files a new incident once, as an issue in the configured repo, with metadata only", async () => {
		installFakeGh();
		enableFiling();
		await runApiError();
		await runApiError();
		await __testFlushIncidents();

		const calls = ghCalls();
		assert.deepEqual(calls.map((call) => call.argv.slice(0, 2).join(" ")), ["issue list", "issue create"], "one search, one issue, none for the repeat");
		const [search, create] = calls;
		assert.deepEqual(search.argv.slice(2, 6), ["--repo", REPO, "--state", "open"]);
		assert.ok(search.argv.includes("--json"));
		assert.deepEqual(create.argv, ["issue", "create", "--repo", REPO, "--title", "[incident] api_error at consumeQuery (external)", "--body-file", "-"]);

		const body = create.stdin;
		assert.ok(body.startsWith(marker("api_error@consumeQuery")), "the dedupe marker opens the body");
		const incident = listIncidents().find((entry) => entry.signature === "api_error@consumeQuery");
		assert.equal(incident.issue, 7);
		for (const expected of ["## What happened", incident.id, "| Class | external |", "| Count |", "| Model | claude-haiku-4-5 |", "```json", "## How to reproduce", "tests/"]) {
			assert.ok(body.includes(expected), `body has ${expected}`);
		}
		for (const secret of [PROMPT_SENTINEL, API_SENTINEL, "test system prompt"]) assert.ok(!body.includes(secret), `no content in the issue: ${secret}`);
		assert.ok(Buffer.byteLength(body) < 60 * 1024);
		const stored = readFileSync(join(agentDir, "claude-bridge-incidents.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
		assert.ok(stored.some((line) => line.signature === "api_error@consumeQuery" && line.issue === 7 && line.filing === "filed"), "the store records the issue");
	});

	it("points every issue at a test file that exists", () => {
		assert.ok(REPRO_TEST_FILES.length >= 10);
		for (const file of REPRO_TEST_FILES) assert.ok(existsSync(file), file);
	});

	it("comments on the open issue that carries the marker instead of creating one", async () => {
		installFakeGh({ issues: [{ number: 12, body: `${marker("api_error@consumeQuery")}\nearlier` }, { number: 3, body: marker("api_error@elsewhere") }] });
		enableFiling();
		await runApiError();
		await __testFlushIncidents();

		assert.equal(creates().length, 0);
		assert.equal(comments().length, 1);
		assert.deepEqual(comments()[0].argv, ["issue", "comment", "12", "--repo", REPO, "--body-file", "-"]);
		assert.ok(!comments()[0].stdin.includes(API_SENTINEL));
		assert.equal(listIncidents().find((entry) => entry.signature === "api_error@consumeQuery").issue, 12);
	});

	it("never files an expected incident", async () => {
		installFakeGh();
		enableFiling();
		recordIncident("partial_tool_calls_pruned@abort", "expected", {});
		recordIncident("partial_tool_calls_pruned@finalizeCurrentStream", "silent", {});
		await __testFlushIncidents();
		assert.deepEqual(creates().map((call) => call.argv[5]), ["[incident] partial_tool_calls_pruned at finalizeCurrentStream (silent)"]);
		assert.equal(listIncidents()[0].issue, undefined);
	});

	it("files nothing without incidents.repo", async () => {
		installFakeGh();
		loadExtension();
		recordIncident("tool_result_delivery_mismatch@teardownQuery", "silent", {});
		await __testFlushIncidents();
		assert.deepEqual(ghCalls(), []);
		assert.equal(listIncidents()[0].issue, undefined);

		// The same process files once the user config names a repo.
		enableFiling();
		recordIncident("session_verify_fail@verifyWrittenSession", "silent", {});
		await __testFlushIncidents();
		assert.equal(creates().length, 1);
	});

	it("files at most 5 times an hour, and comments at most once an hour per signature", async () => {
		installFakeGh();
		enableFiling();
		for (let i = 0; i < 7; i++) recordIncident(["label_" + i, "site"].join("@"), "silent", {});
		await __testFlushIncidents();
		assert.equal(creates().length, 5, "the hourly limit holds");
		assert.deepEqual(listIncidents().map((entry) => entry.issue ?? null), [7, 8, 9, 10, 11, null, null]);

		clock += 10 * 60 * 1000;
		recordIncident("label_0@site", "silent", {});
		await __testFlushIncidents();
		assert.equal(comments().length, 0, "no comment within the hour of filing");
		assert.equal(listIncidents()[0].count, 2, "counted locally");

		clock += HOUR;
		recordIncident("label_0@site", "silent", {});
		recordIncident("label_0@site", "silent", {});
		recordIncident("label_5@site", "silent", {});
		await __testFlushIncidents();
		assert.equal(comments().length, 1, "one comment for the signature in the new hour");
		assert.equal(comments()[0].argv[2], "7");
		assert.match(comments()[0].stdin, /\| Count \| 4 \|/, "the comment carries the count when it is filed");
		assert.equal(creates().length, 6, "the limit frees up after an hour");
		assert.equal(listIncidents()[5].issue, 12);
	});

	it("records a failed gh on the incident and does not retry it hot", async () => {
		installFakeGh({ mode: "auth" });
		enableFiling();
		recordIncident("tool_result_delivery_mismatch@teardownQuery", "silent", {});
		await __testFlushIncidents();
		const spawned = ghCalls().length;
		assert.equal(spawned, 1);
		assert.equal(listIncidents()[0].filing, "failed gh-auth");

		recordIncident("tool_result_delivery_mismatch@teardownQuery", "silent", {});
		recordIncident("session_verify_fail@verifyWrittenSession", "silent", {});
		await __testFlushIncidents();
		assert.equal(ghCalls().length, spawned, "no gh while the failure is recent");

		clock += HOUR + 1;
		writeFileSync(join(ghDir, "state.json"), JSON.stringify({ mode: "ok", issues: [], next: 20 }));
		recordIncident("session_verify_fail@verifyWrittenSession", "silent", {});
		await __testFlushIncidents();
		assert.equal(listIncidents()[1].issue, 20, "filed once the hour passed");
	});

	it("records a missing gh on the incident", async () => {
		const empty = mkdtempSync(join(agentDir, "no-gh-"));
		mkdirSync(empty, { recursive: true });
		process.env.PATH = empty;
		enableFiling();
		recordIncident("tool_result_delivery_mismatch@teardownQuery", "silent", {});
		await __testFlushIncidents();
		assert.equal(listIncidents()[0].filing, "failed gh-missing");
	});

	it("keeps what the sanitizer removes out of the issue it files", async () => {
		installFakeGh();
		enableFiling();
		recordIncident("tool_call_id_other_tool@answerUnclaimedToolUse", "user-visible", { toolName: `${mention("someone")} ${otherRef} ${otherLink}` });
		await __testFlushIncidents();
		const body = creates()[0].stdin;
		for (const removed of [mention("someone"), otherRef, otherLink]) assert.ok(!body.includes(removed), removed);
	});
});
