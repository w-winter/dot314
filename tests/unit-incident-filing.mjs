// Incident filing: with a user-scoped `incidents.repo`, a new non-expected
// incident becomes an issue in that repo through `gh`, or a comment on the
// open issue that already carries its marker. Filing is rate limited, never
// blocks the stream, and every string it publishes passes the sanitizer.
// `gh` here is a fake on PATH that records its argv and stdin.
import "./lib/debug-env.mjs";

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Type } from "@earendil-works/pi-ai";

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
// Signatures the bridge's code reports: only those are filed.
const SILENT = [
	"tool_result_delivery_mismatch@query-teardown",
	"session_verify_fail@verifyWrittenSession",
	"persist_shared_session_failed@schedulePersistSharedSession",
	"stale_queued_tool_results_parked@reapStaleQueuedResults",
	"tool_call_abandoned_by_claude_code@noteAbandonedToolCalls",
	"empty_prompt@streamRequestInLane",
	"steering_write_in_flight@streamRequestInLane",
];
// Synthetic: 30 bytes of a hash of fixed text, valid base64 and base64url.
const SYNTHETIC_KEY = createHash("sha256").update("synthetic-review-token-34135").digest().subarray(0, 30).toString("base64");
const LONG_MCP_TOOL = "mcp__git__get_pr_by_id_from_repo_with_org_name";

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
let clockFile;

// The filer's clock lives in a file, so the fake gh can move it while it
// "searches": that is how GitHub's latency looks to the filer.
const readClock = () => Number(readFileSync(clockFile, "utf8"));
const advance = (ms) => writeFileSync(clockFile, String(readClock() + ms));
const setClock = (ms) => writeFileSync(clockFile, String(ms));

/** The most gh writes (creates and comments) in any rolling hour. */
function mostWritesInAnHour() {
	const at = ghCalls().filter((call) => call.argv[1] !== "list").map((call) => call.at);
	return Math.max(0, ...at.map((end) => at.filter((t) => t > end - HOUR && t <= end).length));
}

/** A fake `gh`: logs {argv, stdin, at}, answers `issue list` from its state
 *  file, and numbers the issues it creates. `mode: "auth"` fails like a
 *  logged-out gh does; `searchDelayMs` is how long the first `issue list`
 *  takes on the filer's clock. */
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
	const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
	const clockFile = ${JSON.stringify(clockFile)};
	if (argv[1] === "list" && state.searchDelayMs) {
		fs.writeFileSync(clockFile, String(Number(fs.readFileSync(clockFile, "utf8")) + state.searchDelayMs));
		state.searchDelayMs = 0;
		fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state));
	}
	fs.appendFileSync(path.join(dir, "log.jsonl"), JSON.stringify({ argv, stdin, at: Number(fs.readFileSync(clockFile, "utf8")) }) + "\\n");
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

/** Runs one request whose Pi context offers `names` as tools: how Pi's tool
 *  list reaches the bridge. */
async function offerPiTools(names) {
	__testSetSdkQueryFactory(() => ({
		async *[Symbol.asyncIterator]() {
			yield { type: "system", subtype: "init", session_id: "filing-session", claude_code_version: "9.9.9" };
			yield { type: "result", subtype: "success", result: "ok", session_id: "filing-session" };
		},
		close() {},
		async interrupt() {},
	}));
	const tools = names.map((name) => ({ name, description: "A Pi tool", parameters: Type.Object({}) }));
	await collect(streamClaudeAgentSdk(model, { messages: [{ role: "system", content: "test system prompt", toolsAdded: tools, timestamp: 0 }, { role: "user", content: "hello", timestamp: 1 }] }, { sessionId: "filing-tools" }));
}

/** Files `data` (and a recorder id) twice, an hour apart: an issue, then a
 *  comment. Returns both writes. */
async function fileTwice(data, recordId) {
	recordIncident("tool_call_id_other_tool@answerUnclaimedToolUse", "user-visible", data);
	await __testFlushIncidents();
	advance(HOUR + 1);
	recordIncident("tool_call_id_other_tool@answerUnclaimedToolUse", "user-visible", data, { recorder: { snapshot: () => [{ t: 0, kind: "tools_call", id: recordId }] } });
	await __testFlushIncidents();
	const writes = ghCalls().filter((call) => call.argv[1] === "create" || call.argv[1] === "comment");
	assert.deepEqual(writes.map((call) => call.argv[1]), ["create", "comment"]);
	return writes;
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
	clockFile = join(agentDir, "clock");
	writeFileSync(clockFile, String(Date.parse("2026-09-28T12:00:00Z")));
	resetStack();
	__testResetIncidents();
	__testSetFilerClock(readClock);
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
		recordIncident("partial_tool_calls_pruned@stream-end", "silent", {});
		await __testFlushIncidents();
		assert.deepEqual(creates().map((call) => call.argv[5]), ["[incident] partial_tool_calls_pruned at stream-end (silent)"]);
		assert.equal(listIncidents()[0].issue, undefined);
	});

	it("files nothing without incidents.repo", async () => {
		installFakeGh();
		loadExtension();
		recordIncident("tool_result_delivery_mismatch@query-teardown", "silent", {});
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
		for (const signature of SILENT) recordIncident(signature, "silent", {});
		await __testFlushIncidents();
		assert.equal(creates().length, 5, "the hourly limit holds");
		assert.deepEqual(listIncidents().map((entry) => entry.issue ?? null), [7, 8, 9, 10, 11, null, null]);

		advance(10 * 60 * 1000);
		recordIncident(SILENT[0], "silent", {});
		await __testFlushIncidents();
		assert.equal(comments().length, 0, "no comment within the hour of filing");
		assert.equal(listIncidents()[0].count, 2, "counted locally");

		advance(HOUR);
		recordIncident(SILENT[0], "silent", {});
		recordIncident(SILENT[0], "silent", {});
		recordIncident(SILENT[5], "silent", {});
		await __testFlushIncidents();
		assert.equal(comments().length, 1, "one comment for the signature in the new hour");
		assert.equal(comments()[0].argv[2], "7");
		assert.match(comments()[0].stdin, /\| Count \| 4 \|/, "the comment carries the count when it is filed");
		assert.equal(creates().length, 6, "the limit frees up after an hour");
		assert.equal(listIncidents()[5].issue, 12);
	});

	it("holds the hourly limit when GitHub is slow to search", async () => {
		installFakeGh({ searchDelayMs: 20_000 });
		enableFiling();
		const start = readClock();
		recordIncident(SILENT[0], "silent", {});
		await __testFlushIncidents();
		for (const signature of SILENT.slice(1, 5)) recordIncident(signature, "silent", {});
		await __testFlushIncidents();
		assert.deepEqual(creates().map((call) => call.at - start), [20_000, 20_000, 20_000, 20_000, 20_000], "the writes happen after the slow search");

		setClock(start + HOUR + 1);
		recordIncident(SILENT[5], "silent", {});
		await __testFlushIncidents();
		assert.equal(creates().length, 5, "an hour from the check before the search is not an hour from the writes");
		assert.equal(mostWritesInAnHour(), 5);

		setClock(start + 20_000 + HOUR);
		recordIncident(SILENT[5], "silent", {});
		await __testFlushIncidents();
		assert.equal(creates().length, 6, "free an hour after the writes");
		assert.equal(mostWritesInAnHour(), 5);
	});

	it("comments on a signature at most once an hour when GitHub is slow to search", async () => {
		installFakeGh({ searchDelayMs: 20_000, issues: [{ number: 12, body: marker("api_error@consumeQuery") }] });
		enableFiling();
		const start = readClock();
		recordIncident("api_error@consumeQuery", "external", {});
		await __testFlushIncidents();
		assert.deepEqual(comments().map((call) => call.at - start), [20_000]);

		setClock(start + HOUR + 1);
		recordIncident("api_error@consumeQuery", "external", {});
		await __testFlushIncidents();
		assert.equal(comments().length, 1, "not within an hour of the comment");

		setClock(start + 20_000 + HOUR);
		recordIncident("api_error@consumeQuery", "external", {});
		await __testFlushIncidents();
		assert.deepEqual(comments().map((call) => call.at - start), [20_000, 20_000 + HOUR]);
	});

	it("keeps long base64 tokens out of the issue and the comment it files", async () => {
		// Synthetic: valid standard base64 of fixed text, never a credential.
		const token = "T0k/".repeat(16);
		installFakeGh();
		enableFiling();
		const writes = await fileTwice({ toolName: token }, token);
		for (const write of writes) {
			assert.ok(!write.stdin.includes(token), `no token in the ${write.argv[1]}`);
			assert.ok(write.stdin.includes("[unregistered tool name]"), `placeholder in the ${write.argv[1]}`);
		}
		assert.ok(writes[1].stdin.includes("[invalid tool_use id]"));
	});

	it("keeps a synthetic key out of the issue and the comment, as a tool name and as a recorder id", async () => {
		assert.equal(SYNTHETIC_KEY.length, 40);
		installFakeGh();
		enableFiling();
		const writes = await fileTwice({ toolName: SYNTHETIC_KEY }, SYNTHETIC_KEY);
		for (const write of writes) assert.ok(!write.stdin.includes(SYNTHETIC_KEY), `no key in the ${write.argv[1]}`);
		for (const write of writes) assert.ok(write.stdin.includes("[unregistered tool name]"), `placeholder in the ${write.argv[1]}`);
		assert.ok(writes[1].stdin.includes("[invalid tool_use id]"));
	});

	it("files a long tool name Pi registered, in the issue and the comment", async () => {
		installFakeGh();
		enableFiling();
		await offerPiTools([LONG_MCP_TOOL]);
		const writes = await fileTwice({ toolName: LONG_MCP_TOOL }, "toolu_01D7FLrfh4GYq7yT1ULFeyMV");
		for (const write of writes) assert.ok(write.stdin.includes(LONG_MCP_TOOL), `tool name in the ${write.argv[1]}`);
		assert.ok(writes[1].stdin.includes("toolu_01D7FLrfh4GYq7yT1ULFeyMV"), "a tool_use id of Claude's shape stays");
	});

	it("does not keep a registered tool name where a tool_use id belongs", async () => {
		installFakeGh();
		enableFiling();
		await offerPiTools([LONG_MCP_TOOL]);
		const writes = await fileTwice({}, LONG_MCP_TOOL);
		assert.ok(!writes[1].stdin.includes(LONG_MCP_TOOL));
		assert.ok(writes[1].stdin.includes("[invalid tool_use id]"));
	});

	it("files only signatures the bridge's code reports", async () => {
		installFakeGh();
		enableFiling();
		recordIncident("made_up_label@streamRequestInLane", "silent", {});
		recordIncident("tool_call_dead@someFunctionNobodyWrote", "user-visible", {});
		recordIncident(`tool_call_dead@${SYNTHETIC_KEY}`, "user-visible", {});
		await __testFlushIncidents();
		assert.deepEqual(ghCalls(), []);
		for (const incident of listIncidents()) assert.equal(incident.filing, "skipped unknown-signature");
	});

	it("records a failed gh on the incident and does not retry it hot", async () => {
		installFakeGh({ mode: "auth" });
		enableFiling();
		recordIncident("tool_result_delivery_mismatch@query-teardown", "silent", {});
		await __testFlushIncidents();
		const spawned = ghCalls().length;
		assert.equal(spawned, 1);
		assert.equal(listIncidents()[0].filing, "failed gh-auth");

		recordIncident("tool_result_delivery_mismatch@query-teardown", "silent", {});
		recordIncident("session_verify_fail@verifyWrittenSession", "silent", {});
		await __testFlushIncidents();
		assert.equal(ghCalls().length, spawned, "no gh while the failure is recent");

		advance(HOUR + 1);
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
		recordIncident("tool_result_delivery_mismatch@query-teardown", "silent", {});
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
