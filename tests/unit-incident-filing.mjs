// Incident filing: nothing is filed when an incident happens. The agent files
// one with `claude_bridge_incident` (action "file"), which needs a
// user-scoped `incidents.repo`: it becomes an issue in that repo through
// `gh`, or a comment on the open issue that already carries its marker, with
// only the evidence the bridge recorded in it; no text of the agent's is
// published. Every string it publishes passes the sanitizer. `gh` here is a
// fake on PATH that records its argv and stdin.
import "./lib/debug-env.mjs";

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Type } from "@earendil-works/pi-ai";

import claudeBridge, { __testSetBridgeIntegrityState, __testSetSdkQueryFactory, streamClaudeAgentSdk } from "../src/index.ts";
import { setExtensionApi } from "../src/bridge-state.ts";
import { REPRO_TEST_FILES } from "../src/incident-filer.ts";
import { __testFlushIncidents, __testResetIncidents, listIncidents, nameThrownBridgeError, noteClaudeCodeVersion, recordIncident } from "../src/incidents.ts";
import { resetStack } from "../src/query-state.ts";

const REPO = "nicobailon/bridge-incidents";
const TOOL = "claude_bridge_incident";
const PROMPT_SENTINEL = "PROMPT-SENTINEL-do-not-file";
const API_SENTINEL = "API-SENTINEL-do-not-file";
const AGENT_SENTINEL = "AGENT-SENTINEL-never-published";
const TELL_USER = "The issue carries only the evidence the bridge recorded: tell the user its number and give them your own analysis here in chat.";
// Built at run time: the sanitizer keeps these out of what is filed.
const mention = (name) => `@${name}`;
const otherRef = ["someone-else", "their-repo"].join("/") + "#12";
const otherLink = ["https://github.com", "someone-else", "their-repo", "issues", "3"].join("/");
// Synthetic: 30 bytes of a hash of fixed text, valid base64 and base64url.
const SYNTHETIC_KEY = createHash("sha256").update("synthetic-review-token-34135").digest().subarray(0, 30).toString("base64");
const LONG_MCP_TOOL = "mcp__git__get_pr_by_id_from_repo_with_org_name";
// Synthetic, lowercase and label-shaped: a valid base64 encoding of 30 bytes.
const LABEL_TOKEN = "abcdefghijklmnopqrstuvwxyzabcdefghijklmn";

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
	const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
	fs.appendFileSync(path.join(dir, "log.jsonl"), JSON.stringify({ argv, stdin }) + "\\n");
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
const writes = () => ghCalls().filter((call) => call.argv[1] === "create" || call.argv[1] === "comment");

/** Loads the extension into a fake Pi, with `incidents.repo` in the user
 *  config unless `repo` is false; returns the incident tool it registered. */
function loadExtension({ repo = true } = {}) {
	if (repo) writeFileSync(join(agentDir, "claude-bridge.json"), JSON.stringify({ incidents: { repo: REPO } }));
	const tools = new Map();
	claudeBridge({
		on: () => {},
		registerCommand: () => {},
		registerProvider: () => {},
		registerTool: (tool) => tools.set(tool.name, tool),
		events: { emit: () => {} },
		appendEntry: () => {},
	});
	return tools.get(TOOL);
}

/** Runs the tool as Pi's agent loop does; resolves its text, rejects with the
 *  error Pi turns into the tool's error result. */
async function runTool(tool, params) {
	assert.ok(tool, "the incident tool is registered");
	const result = await tool.execute("call-1", params, undefined, undefined, {});
	return result.content.map((block) => block.text).join("");
}

const file = (tool, incident) => runTool(tool, { action: "file", incident: incident.id });

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

/** Files incident `record()` returns in this process (an issue), then, as
 *  another Pi process would, files it again (a comment on that issue).
 *  `setup` runs in each process before its incident is recorded. Returns
 *  both writes. */
async function fileInTwoProcesses(record, setup = async () => {}) {
	let tool = loadExtension();
	await setup();
	await file(tool, record(undefined));
	__testResetIncidents();
	tool = loadExtension();
	await setup();
	await file(tool, record({ recorder: { snapshot: () => [{ t: 0, kind: "tools_call", id: RECORD_ID.current }] } }));
	assert.deepEqual(writes().map((call) => call.argv[1]), ["create", "comment"]);
	return writes();
}
const RECORD_ID = { current: undefined };

/** One query whose Claude Code yields `messages`, from a fresh session. */
async function runQuery(messages) {
	resetStack();
	__testSetSdkQueryFactory(() => ({
		async *[Symbol.asyncIterator]() {
			yield* messages;
		},
		close() {},
		async interrupt() {},
	}));
	return collect(streamClaudeAgentSdk(model, { messages: [{ role: "user", content: "hello", timestamp: 1 }] }, { sessionId: "filing-labels" }));
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
const find = (signature) => listIncidents().find((entry) => entry.signature === signature);

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "bridge-filing-"));
	savedPath = process.env.PATH;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT = "0";
	process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token";
	process.env.CLAUDE_BRIDGE_DIAG_PATH = join(agentDir, "diag.log");
	RECORD_ID.current = undefined;
	resetStack();
	__testResetIncidents();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: { notify: () => {} } });
	setExtensionApi({ events: { emit: () => {} }, appendEntry: () => {} });
});

afterEach(() => {
	process.env.PATH = savedPath;
	delete process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT;
	delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
	delete process.env.CLAUDE_BRIDGE_DIAG_PATH;
	__testSetSdkQueryFactory();
	setExtensionApi(undefined);
	resetStack();
	__testResetIncidents();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
	rmSync(agentDir, { recursive: true, force: true });
});

describe("incident filing", () => {
	it("files nothing when incidents happen, even with incidents.repo set", async () => {
		installFakeGh();
		loadExtension();
		await runApiError();
		recordIncident("tool_result_delivery_mismatch@query-teardown", "silent", {});
		recordIncident("tool_call_id_other_tool@answerUnclaimedToolUse", "user-visible", {});
		recordIncident("tool_call_id_other_tool@answerUnclaimedToolUse", "user-visible", {});
		await __testFlushIncidents();
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(listIncidents().length, 3);
		assert.deepEqual(ghCalls(), []);
	});

	it("files an incident the agent names by id alone as an issue in the configured repo, with the bridge's evidence only", async () => {
		installFakeGh();
		const tool = loadExtension();
		await runApiError();
		await runApiError();
		const incident = find("api_error@consumeQuery");
		const reply = await file(tool, incident);
		assert.equal(reply, `Filed ${REPO}#7 (https://github.com/${REPO}/issues/7). ${TELL_USER}`);

		const calls = ghCalls();
		assert.deepEqual(calls.map((call) => call.argv.slice(0, 2).join(" ")), ["issue list", "issue create"], "one search, one issue");
		const [search, create] = calls;
		assert.deepEqual(search.argv.slice(2, 6), ["--repo", REPO, "--state", "open"]);
		assert.ok(search.argv.includes("--json"));
		assert.deepEqual(create.argv, ["issue", "create", "--repo", REPO, "--title", "[incident] api_error at consumeQuery (external)", "--body-file", "-"]);

		const body = create.stdin;
		assert.ok(body.startsWith(marker("api_error@consumeQuery")), "the dedupe marker opens the body");
		assert.equal(incident.issue, 7);
		for (const expected of ["## What happened", incident.id, "| Class | external |", "| Count | 2 |", "| Model | claude-haiku-4-5 |", "## Flight recorder", "## Diag metadata", "```json", "## How to reproduce", "tests/"]) {
			assert.ok(body.includes(expected), `body has ${expected}`);
		}
		assert.ok(!body.includes("analysis"), "no analysis section");
		for (const secret of [PROMPT_SENTINEL, API_SENTINEL, "test system prompt"]) assert.ok(!body.includes(secret), `no content in the issue: ${secret}`);
		assert.ok(Buffer.byteLength(body) < 64 * 1024);
		await __testFlushIncidents();
		const stored = readFileSync(join(agentDir, "claude-bridge-incidents.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
		assert.ok(stored.some((line) => line.signature === "api_error@consumeQuery" && line.issue === 7), "the store records the issue");
	});

	it("files an incident once per process: filing it again returns its issue without gh", async () => {
		installFakeGh();
		const tool = loadExtension();
		const incident = recordIncident("session_verify_fail@verifyWrittenSession", "silent", {});
		const [first, second] = await Promise.all([file(tool, incident), file(tool, incident)]);
		assert.match(first, /^Filed nicobailon\/bridge-incidents#7 /);
		const again = `Incident ${incident.id} was already filed in this Pi process as ${REPO}#7 (https://github.com/${REPO}/issues/7). ${TELL_USER}`;
		assert.equal(second, again, "a call while the first is running waits for it");
		const spawned = ghCalls().length;
		assert.equal(await file(tool, incident), again);
		assert.equal(ghCalls().length, spawned, "no gh for a filed incident");
		assert.equal(creates().length, 1);
	});

	it("points every issue at a test file that exists", () => {
		assert.ok(REPRO_TEST_FILES.length >= 10);
		for (const file of REPRO_TEST_FILES) assert.ok(existsSync(file), file);
	});

	it("comments on the open issue that carries the marker instead of creating one", async () => {
		installFakeGh({ issues: [{ number: 12, body: `${marker("api_error@consumeQuery")}\nearlier` }, { number: 3, body: marker("api_error@elsewhere") }] });
		const tool = loadExtension();
		await runApiError();
		// Text the agent sends beyond the schema is never published.
		const reply = await runTool(tool, { action: "file", incident: find("api_error@consumeQuery").id, summary: AGENT_SENTINEL });
		assert.equal(reply, `Commented on ${REPO}#12 (https://github.com/${REPO}/issues/12), the open issue already filed for this incident's signature. ${TELL_USER}`);

		assert.equal(creates().length, 0);
		assert.equal(comments().length, 1);
		assert.deepEqual(comments()[0].argv, ["issue", "comment", "12", "--repo", REPO, "--body-file", "-"]);
		const text = comments()[0].stdin;
		for (const expected of ["## New occurrence", "| Class | external |", "### Diag metadata"]) assert.ok(text.includes(expected), `comment has ${expected}`);
		for (const absent of [API_SENTINEL, AGENT_SENTINEL, "analysis"]) assert.ok(!text.includes(absent), `comment has no ${absent}`);
		assert.equal(find("api_error@consumeQuery").issue, 12);
	});

	it("refuses to file without incidents.repo, saying how to enable it, and runs no gh", async () => {
		installFakeGh();
		const tool = loadExtension({ repo: false });
		const incident = recordIncident("tool_result_delivery_mismatch@query-teardown", "silent", {});
		await assert.rejects(file(tool, incident), (error) => {
			assert.match(error.message, /^Incident filing is off\./);
			assert.ok(error.message.includes(join(agentDir, "claude-bridge.json")), error.message);
			assert.match(error.message, /"incidents": \{ "repo": "<owner>\/<name>" \}/);
			return true;
		});
		assert.deepEqual(ghCalls(), []);
		assert.equal(incident.issue, undefined);
	});

	it("refuses an incident the bridge does not file, without gh", async () => {
		installFakeGh();
		const tool = loadExtension();
		const expected = recordIncident("partial_tool_calls_pruned@abort", "expected", {});
		const unknown = recordIncident("made_up_label@streamRequestInLane", "silent", {});
		await assert.rejects(file(tool, expected), new RegExp(`Unknown incident ${expected.id}`));
		await assert.rejects(file(tool, unknown), new RegExp(`Incident ${unknown.id} is not one the bridge files`));
		await assert.rejects(runTool(tool, { action: "file", incident: "bi-zzzz" }), /Unknown incident bi-zzzz/);
		assert.deepEqual(ghCalls(), []);
	});

	it("returns a tool error with gh's short failure reason", async () => {
		installFakeGh({ mode: "auth" });
		const tool = loadExtension();
		const incident = recordIncident("tool_result_delivery_mismatch@query-teardown", "silent", {});
		await assert.rejects(file(tool, incident), new RegExp(`^Error: Could not file incident ${incident.id}: gh-auth\\.$`));
		assert.equal(incident.issue, undefined);

		// Not a filing: once gh works, the agent can file it.
		writeFileSync(join(ghDir, "state.json"), JSON.stringify({ mode: "ok", issues: [], next: 20 }));
		assert.match(await file(tool, incident), /#20 /);

		process.env.PATH = mkdtempSync(join(agentDir, "no-gh-"));
		const other = recordIncident("session_verify_fail@verifyWrittenSession", "silent", {});
		await assert.rejects(file(tool, other), new RegExp(`Could not file incident ${other.id}: gh-missing\\.`));
	});

	it("keeps what the sanitizer removes out of the evidence it files", async () => {
		installFakeGh();
		const tool = loadExtension();
		const incident = recordIncident("tool_call_id_other_tool@answerUnclaimedToolUse", "user-visible", { toolName: `${mention("someone")} ${otherRef} ${otherLink}` });
		await file(tool, incident);
		const body = creates()[0].stdin;
		for (const removed of [mention("someone"), otherRef, otherLink]) assert.ok(!body.includes(removed), removed);
	});
});

describe("the evidence an issue and a comment carry", () => {
	const recordOtherTool = (data) => (source) => recordIncident("tool_call_id_other_tool@answerUnclaimedToolUse", "user-visible", data, source);

	it("keeps long base64 tokens out of the issue and the comment", async () => {
		// Synthetic: valid standard base64 of fixed text, never a credential.
		const token = "T0k/".repeat(16);
		RECORD_ID.current = token;
		installFakeGh();
		const filed = await fileInTwoProcesses(recordOtherTool({ toolName: token }));
		for (const write of filed) {
			assert.ok(!write.stdin.includes(token), `no token in the ${write.argv[1]}`);
			assert.ok(write.stdin.includes("[unregistered tool name]"), `placeholder in the ${write.argv[1]}`);
		}
		assert.ok(filed[1].stdin.includes("[invalid tool_use id]"));
	});

	it("keeps a synthetic key out of the issue and the comment, as a tool name and as a recorder id", async () => {
		assert.equal(SYNTHETIC_KEY.length, 40);
		RECORD_ID.current = SYNTHETIC_KEY;
		installFakeGh();
		const filed = await fileInTwoProcesses(recordOtherTool({ toolName: SYNTHETIC_KEY }));
		for (const write of filed) assert.ok(!write.stdin.includes(SYNTHETIC_KEY), `no key in the ${write.argv[1]}`);
		for (const write of filed) assert.ok(write.stdin.includes("[unregistered tool name]"), `placeholder in the ${write.argv[1]}`);
		assert.ok(filed[1].stdin.includes("[invalid tool_use id]"));
	});

	it("publishes an extension's tool name as its stable hash in the issue and the comment, while show keeps it", async () => {
		RECORD_ID.current = "toolu_01D7FLrfh4GYq7yT1ULFeyMV";
		installFakeGh();
		const hashed = `tool-${createHash("sha256").update(LONG_MCP_TOOL).digest("hex").slice(0, 8)}`;
		const data = { toolName: LONG_MCP_TOOL, recordedName: "read", name: "mcp__custom-tools__bash" };
		const filed = await fileInTwoProcesses(recordOtherTool(data), () => offerPiTools([LONG_MCP_TOOL, "read", "bash"]));
		for (const write of filed) {
			assert.ok(!write.stdin.includes(LONG_MCP_TOOL), `no extension tool name in the ${write.argv[1]}`);
			assert.ok(write.stdin.includes(`"toolName": "${hashed}"`), `its hash in the ${write.argv[1]}`);
			assert.ok(write.stdin.includes(`"recordedName": "read"`), `a Pi built-in keeps its name in the ${write.argv[1]}`);
			assert.ok(write.stdin.includes(`"name": "mcp__custom-tools__bash"`), `a built-in's served name stays in the ${write.argv[1]}`);
		}
		assert.ok(filed[1].stdin.includes("toolu_01D7FLrfh4GYq7yT1ULFeyMV"), "a tool_use id of Claude's shape stays");
		const shown = await runTool(loadExtension(), { action: "show", incident: find("tool_call_id_other_tool@answerUnclaimedToolUse").id });
		assert.ok(shown.includes(LONG_MCP_TOOL) && !shown.includes(hashed), "show gives the agent the real name");
	});

	it("does not keep a registered tool name where a tool_use id belongs", async () => {
		RECORD_ID.current = LONG_MCP_TOOL;
		installFakeGh();
		const filed = await fileInTwoProcesses(recordOtherTool({}), () => offerPiTools([LONG_MCP_TOOL]));
		assert.ok(!filed[1].stdin.includes(LONG_MCP_TOOL));
		assert.ok(filed[1].stdin.includes("[invalid tool_use id]"));
	});

	it("keeps label fields and recorder kinds outside the code's own sets out of the issue and the comment", async () => {
		assert.equal(Buffer.from(LABEL_TOKEN, "base64").toString("base64"), LABEL_TOKEN);
		installFakeGh();
		const data = { kind: LABEL_TOKEN, subtype: LABEL_TOKEN, type: LABEL_TOKEN, source: LABEL_TOKEN, why: LABEL_TOKEN };
		const source = { recorder: { snapshot: () => [{ t: 0, kind: LABEL_TOKEN }] } };
		const filed = await fileInTwoProcesses(() => recordIncident("api_error@consumeQuery", "external", data, source));
		for (const write of filed) {
			assert.ok(!write.stdin.includes(LABEL_TOKEN), `no unknown label in the ${write.argv[1]}`);
			assert.ok(write.stdin.includes("[unknown subtype]"), `placeholder in the ${write.argv[1]}`);
			assert.ok(write.stdin.includes("[unknown kind]"), `recorder placeholder in the ${write.argv[1]}`);
		}
	});

	it("files an SDK message type or subtype the bridge does not handle only as a placeholder", async () => {
		installFakeGh();
		const session = "8b2c4d6e-1f3a-4b5c-9d7e-0a1b2c3d4e5f";
		const messages = [
			{ type: "system", subtype: "init", session_id: session, claude_code_version: "9.9.9" },
			{ type: "stream_event", event: { type: LABEL_TOKEN } },
			{ type: "result", subtype: LABEL_TOKEN, is_error: true, errors: ["synthetic failure"], session_id: session },
		];
		let tool = loadExtension();
		assert.ok((await runQuery(messages)).some((event) => event.type === "error"));
		const [incident] = listIncidents();
		await file(tool, incident);
		__testResetIncidents();
		tool = loadExtension();
		await runQuery(messages);
		await file(tool, find(incident.signature));
		assert.deepEqual(writes().map((call) => call.argv[1]), ["create", "comment"]);
		for (const write of writes()) {
			assert.ok(!write.stdin.includes(LABEL_TOKEN), `no SDK string in the ${write.argv[1]}`);
			assert.ok(write.stdin.includes("[unknown subtype]"), `diag placeholder in the ${write.argv[1]}`);
			assert.ok(write.stdin.includes("result_[unknown]"), `recorder placeholder in the ${write.argv[1]}`);
			assert.ok(write.stdin.includes("stream_event_[unknown]"), `stream event placeholder in the ${write.argv[1]}`);
		}
	});
});

// The incidents repo may be public: an issue and a comment publish a label,
// version or model only from a set the code or the runtime owns. A value
// that merely has the right shape can still name a user or a project.
// Synthetic names throughout. `show` keeps what was recorded.
describe("the labels, versions and model an issue and a comment publish", () => {
	const PROVIDER_THROW = "bridge_error@provider-throw";
	const shownFor = async (signature) => runTool(loadExtension(), { action: "show", incident: find(signature).id });

	it("publishes a thrown error's name, code and syscall only from the code's own sets, while show keeps them", async () => {
		installFakeGh();
		const filed = await fileInTwoProcesses(() => {
			nameThrownBridgeError(Object.assign(new Error("synthetic provider throw"), { name: "ProjectPayrollError", code: "PRIVATEALICE", syscall: "alice_laptop" }), undefined);
			return find(PROVIDER_THROW);
		});
		for (const write of filed) {
			for (const leaked of ["ProjectPayrollError", "PRIVATEALICE", "alice_laptop"]) assert.ok(!write.stdin.includes(leaked), `${leaked} in the ${write.argv[1]}`);
			for (const placeholder of ['"errorName": "[unknown error name]"', '"code": "[unknown code]"', '"syscall": "[unknown syscall]"']) {
				assert.ok(write.stdin.includes(placeholder), `${placeholder} in the ${write.argv[1]}`);
			}
		}
		assert.ok((await shownFor(PROVIDER_THROW)).includes("ProjectPayrollError"), "show keeps the recorded name");
	});

	it("keeps built-in error names, errno names, Node ERR_ codes, the bridge's own labels and Node's syscalls", async () => {
		installFakeGh();
		const data = {
			errorName: "TypeError", code: "ENOENT", syscall: "open",
			causes: [
				{ errorName: "ClaudeSpawnDiagnosticError", code: "CLAUDE_BRIDGE_SPAWN_FAILED", syscall: "uv_os_homedir" },
				{ errorName: "AbortError", code: "ERR_INVALID_ARG_TYPE", syscall: "scandir" },
			],
		};
		const filed = await fileInTwoProcesses(() => recordIncident(PROVIDER_THROW, "user-visible", data));
		for (const write of filed) {
			for (const kept of ["TypeError", "ENOENT", '"open"', "ClaudeSpawnDiagnosticError", "CLAUDE_BRIDGE_SPAWN_FAILED", "uv_os_homedir", "AbortError", "ERR_INVALID_ARG_TYPE", "scandir"]) {
				assert.ok(write.stdin.includes(kept), `${kept} in the ${write.argv[1]}`);
			}
			assert.ok(!write.stdin.includes("[unknown"), `no placeholder in the ${write.argv[1]}`);
		}
	});

	it("publishes a version's numeric core only, its suffix as a placeholder, while show keeps it", async () => {
		installFakeGh();
		const filed = await fileInTwoProcesses(() => {
			noteClaudeCodeVersion("2.1.3-PrivateAlice");
			return recordIncident(PROVIDER_THROW, "user-visible", { version: "2.1.3-PrivateAlice", previousVersion: "2.1.2" });
		});
		for (const write of filed) {
			assert.ok(!write.stdin.includes("PrivateAlice"), `no suffix in the ${write.argv[1]}`);
			assert.ok(write.stdin.includes("| Claude Code | 2.1.3-[suffix] |"), `evidence table in the ${write.argv[1]}`);
			assert.ok(write.stdin.includes('"version": "2.1.3-[suffix]"'), `diag in the ${write.argv[1]}`);
			assert.ok(write.stdin.includes('"previousVersion": "2.1.2"'), `a plain version stays in the ${write.argv[1]}`);
		}
		assert.ok((await shownFor(PROVIDER_THROW)).includes("2.1.3-PrivateAlice"), "show keeps the recorded version");
	});

	it("publishes only a model the bridge registers, while show keeps the recorded one", async () => {
		installFakeGh();
		const filed = await fileInTwoProcesses(() => recordIncident(PROVIDER_THROW, "user-visible", {}, { preQueryModel: "claude-project-payroll" }));
		for (const write of filed) {
			assert.ok(!write.stdin.includes("project-payroll"), `no model name in the ${write.argv[1]}`);
			assert.ok(write.stdin.includes("| Model | [unregistered model] |"), `placeholder in the ${write.argv[1]}`);
		}
		assert.ok((await shownFor(PROVIDER_THROW)).includes("claude-project-payroll"), "show keeps the recorded model");
	});
});
