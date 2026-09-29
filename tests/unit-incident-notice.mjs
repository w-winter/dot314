// Agent notices and the incident note tool. With a user-scoped
// `incidents.repo`, the first occurrence of a non-expected signature in a Pi
// session sends that session one `claude-bridge-incident` message for its next
// turn, naming the incident and its issue, and the agent can add what it saw
// with `claude_bridge_incident_note`, which comments on that issue through
// `gh`. `gh` here is a fake on PATH that records its argv and stdin.
import "./lib/debug-env.mjs";

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Type } from "@earendil-works/pi-ai";
import { convertToLlm as bundledConvertToLlm } from "@earendil-works/pi-coding-agent";

import claudeBridge, { __testSetBridgeIntegrityState, __testSetSdkQueryFactory, streamClaudeAgentSdk } from "../src/index.ts";
import { setExtensionApi } from "../src/bridge-state.ts";
import { __testSetFilerClock } from "../src/incident-filer.ts";
import { NOTICE_SESSIONS_KEPT, __testFlushNotices, __testResetNotices } from "../src/incident-notice.ts";
import { __testFlushIncidents, __testResetIncidents, listIncidents, recordIncident } from "../src/incidents.ts";
import { resetStack } from "../src/query-state.ts";
import { runInRequestLane } from "../src/request-lane.ts";

// Pi 0.87.1's own convertToLlm when installed: the function that turns the
// notice into what the provider receives.
const INSTALLED_PI_MESSAGES = "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/messages.js";
const convertToLlm = existsSync(INSTALLED_PI_MESSAGES) ? (await import(INSTALLED_PI_MESSAGES)).convertToLlm : bundledConvertToLlm;

const REPO = "nicobailon/bridge-incidents";
const HOUR = 60 * 60 * 1000;
const NOTE_TOOL = "claude_bridge_incident_note";
// Built at run time: the sanitizer keeps these out of what is filed.
const mention = (name) => `@${name}`;
const otherLink = ["https://github.com", "someone-else", "their-repo", "issues", "3"].join("/");
// Synthetic: 30 bytes of a hash of fixed text, valid base64.
const SYNTHETIC_KEY = createHash("sha256").update("synthetic-note-token-5521").digest().subarray(0, 30).toString("base64");

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
const ECHO = { name: "echo", description: "Echo", parameters: Type.Object({ text: Type.String() }) };

let agentDir;
let ghDir;
let savedPath;
let clockFile;
let clock = Date.now();
const stamp = () => clock++;

const readClock = () => Number(readFileSync(clockFile, "utf8"));
const advance = (ms) => writeFileSync(clockFile, String(readClock() + ms));

/** A fake `gh`: logs {argv, stdin}, answers `issue list` from its state file
 *  and numbers the issues it creates. `mode: "auth"` fails like a logged-out
 *  gh. */
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
const comments = () => ghCalls().filter((call) => call.argv[1] === "comment");

/** A fake Pi: the handlers, tools and messages the extension registers or
 *  sends through it. */
function fakePi() {
	const pi = {
		handlers: new Map(),
		tools: new Map(),
		sent: [],
		on: (event, handler) => pi.handlers.set(event, handler),
		registerCommand: () => {},
		registerProvider: () => {},
		registerTool: (tool) => pi.tools.set(tool.name, tool),
		sendMessage: (message, options) => pi.sent.push({ message, options }),
		events: { emit: () => {} },
		appendEntry: () => {},
	};
	return pi;
}

function loadExtension({ enabled = true, bridge = claudeBridge } = {}) {
	if (enabled) writeFileSync(join(agentDir, "claude-bridge.json"), JSON.stringify({ incidents: { repo: REPO } }));
	const pi = fakePi();
	bridge(pi);
	return pi;
}

/** Pi starting session `sessionId`, as its session_start event reaches the
 *  extension. */
function startSession(pi, sessionId) {
	const sessionManager = { getSessionId: () => sessionId, getEntries: () => [], getBranch: () => [] };
	pi.handlers.get("session_start")({ type: "session_start", reason: "new" }, { sessionManager, ui: { notify: () => {} }, cwd: process.cwd(), hasUI: false });
}

async function settle() {
	await __testFlushIncidents();
	await __testFlushNotices();
}

async function collect(stream) {
	const events = [];
	for await (const event of stream) events.push(event);
	return events;
}

async function runTool(pi, params) {
	const tool = pi.tools.get(NOTE_TOOL);
	assert.ok(tool, "the note tool is registered");
	const result = await tool.execute("call-1", params, undefined, undefined, {});
	return result.content.map((block) => block.text).join("");
}

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "bridge-notice-"));
	savedPath = process.env.PATH;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT = "0";
	process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token";
	process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(agentDir, "claude-"));
	clockFile = join(agentDir, "clock");
	writeFileSync(clockFile, String(Date.parse("2026-09-28T12:00:00Z")));
	resetStack();
	__testResetIncidents();
	__testResetNotices();
	__testSetFilerClock(readClock);
	__testSetBridgeIntegrityState({ sharedSession: null, ui: { notify: () => {} } });
	setExtensionApi({ events: { emit: () => {} }, appendEntry: () => {} });
});

afterEach(async () => {
	await settle();
	process.env.PATH = savedPath;
	delete process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT;
	delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
	delete process.env.CLAUDE_CONFIG_DIR;
	__testSetSdkQueryFactory();
	__testSetFilerClock();
	setExtensionApi(undefined);
	resetStack();
	__testResetIncidents();
	__testResetNotices();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
	rmSync(agentDir, { recursive: true, force: true });
});

describe("incident notices", () => {
	it("tells the session once per signature, at most three times, naming the filed issue", async () => {
		installFakeGh();
		const pi = loadExtension();
		startSession(pi, "notice-a");
		startSession(pi, "notice-b");
		runInRequestLane("notice-a", () => {
			recordIncident("tool_result_delivery_mismatch@query-teardown", "silent", {});
			recordIncident("tool_result_delivery_mismatch@query-teardown", "silent", {});
			recordIncident("partial_tool_calls_pruned@abort", "expected", {});
			recordIncident("session_verify_fail@verifyWrittenSession", "silent", {});
			recordIncident("empty_prompt@streamRequestInLane", "silent", {});
			recordIncident("steering_write_in_flight@streamRequestInLane", "silent", {});
		});
		await settle();
		assert.equal(pi.sent.length, 3, "at most three notices in a session, none for a repeat or an expected incident");
		for (const { message, options } of pi.sent) {
			assert.equal(message.customType, "claude-bridge-incident");
			assert.equal(message.display, true);
			assert.deepEqual(options, { deliverAs: "nextTurn" });
		}
		const [first] = pi.sent;
		const mismatch = listIncidents().find((incident) => incident.signature === "tool_result_delivery_mismatch@query-teardown");
		assert.equal(first.message.content, `Pi Claude bridge incident ${mismatch.id} (silent: tool_result_delivery_mismatch at query-teardown). Filed as ${REPO}#7. If you saw related behavior in this session, add it with ${NOTE_TOOL}.`);

		// Another session gets its own notice for the same signature.
		runInRequestLane("notice-b", () => recordIncident("tool_result_delivery_mismatch@query-teardown", "silent", {}));
		await settle();
		assert.equal(pi.sent.length, 4);
		assert.equal(pi.sent[3].message.content, first.message.content);
	});

	it("keeps what a session was told, and its budget, across a Pi reload of that session", async () => {
		installFakeGh();
		const pi = loadExtension();
		const signatures = ["session_verify_fail@verifyWrittenSession", "empty_prompt@streamRequestInLane", "steering_write_in_flight@streamRequestInLane"];
		const sessionManager = { getSessionId: () => "notice-reload", getEntries: () => [], getBranch: () => [] };
		const ctx = { sessionManager, ui: { notify: () => {} }, cwd: process.cwd(), hasUI: false };
		pi.handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
		for (const signature of signatures) runInRequestLane("notice-reload", () => recordIncident(signature, "silent", {}));
		await settle();
		assert.equal(pi.sent.length, 3);

		// Pi 0.87.1 reloads a session in place: session_shutdown and then
		// session_start, both with reason "reload", reach a freshly loaded copy.
		pi.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "reload" }, ctx);
		const reloaded = loadExtension();
		reloaded.handlers.get("session_start")({ type: "session_start", reason: "reload" }, ctx);
		for (const signature of signatures) runInRequestLane("notice-reload", () => recordIncident(signature, "silent", {}));
		runInRequestLane("notice-reload", () => recordIncident("tool_result_delivery_mismatch@query-teardown", "silent", {}));
		await settle();
		assert.equal(reloaded.sent.length, 0, "no repeat of a signature, and the three-notice budget is spent");
		assert.equal(pi.sent.length, 3, "the unloaded copy's sendMessage is never used again");

		// A different session id still gets its own notices, through the new copy.
		startSession(reloaded, "notice-other");
		runInRequestLane("notice-other", () => recordIncident(signatures[0], "silent", {}));
		await settle();
		assert.equal(reloaded.sent.length, 1);
		assert.match(reloaded.sent[0].message.content, /session_verify_fail at verifyWrittenSession/);
	});

	it("sends a notice through the session's current copy, never the unloaded one", async () => {
		installFakeGh({ mode: "auth" });
		const pi = loadExtension();
		const sessionManager = { getSessionId: () => "notice-swap", getEntries: () => [], getBranch: () => [] };
		const ctx = { sessionManager, ui: { notify: () => {} }, cwd: process.cwd(), hasUI: false };
		pi.handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
		// The occurrence is recorded; the reload lands while its filing runs.
		runInRequestLane("notice-swap", () => recordIncident("session_verify_fail@verifyWrittenSession", "silent", {}));
		pi.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "reload" }, ctx);
		const reloaded = loadExtension();
		reloaded.handlers.get("session_start")({ type: "session_start", reason: "reload" }, ctx);
		await settle();
		assert.equal(pi.sent.length, 0, "the unloaded copy is not used");
		assert.equal(reloaded.sent.length, 1, "the reloaded copy delivers it");
	});

	it("keeps what the most recently started sessions were told, and no more", async () => {
		installFakeGh();
		const pi = loadExtension();
		const shutdown = (sessionId) => pi.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, { sessionManager: { getSessionId: () => sessionId }, ui: { notify: () => {} }, cwd: process.cwd() });
		startSession(pi, "notice-kept-0");
		runInRequestLane("notice-kept-0", () => recordIncident("empty_prompt@streamRequestInLane", "silent", {}));
		await settle();
		assert.equal(pi.sent.length, 1);
		shutdown("notice-kept-0");
		// Restarted before NOTICE_SESSIONS_KEPT other sessions start: still known.
		startSession(pi, "notice-kept-0");
		runInRequestLane("notice-kept-0", () => recordIncident("empty_prompt@streamRequestInLane", "silent", {}));
		await settle();
		assert.equal(pi.sent.length, 1);
		shutdown("notice-kept-0");
		for (let i = 1; i <= NOTICE_SESSIONS_KEPT; i++) {
			startSession(pi, `notice-kept-${i}`);
			shutdown(`notice-kept-${i}`);
		}
		// The oldest state went: the session counts as new again.
		startSession(pi, "notice-kept-0");
		runInRequestLane("notice-kept-0", () => recordIncident("empty_prompt@streamRequestInLane", "silent", {}));
		await settle();
		assert.equal(pi.sent.length, 2);
	});

	it("says when the incident is not filed", async () => {
		installFakeGh({ mode: "auth" });
		const pi = loadExtension();
		startSession(pi, "notice-unfiled");
		const incident = runInRequestLane("notice-unfiled", () => recordIncident("session_verify_fail@verifyWrittenSession", "silent", {}));
		await settle();
		assert.equal(pi.sent.length, 1);
		assert.equal(pi.sent[0].message.content, `Pi Claude bridge incident ${incident.id} (silent: session_verify_fail at verifyWrittenSession). Not filed yet (failed gh-auth). If you saw related behavior in this session, add it with ${NOTE_TOOL}.`);
	});

	it("tells the Pi session whose request hit the incident, through that session's own extension instance", async () => {
		installFakeGh();
		const parent = loadExtension();
		// An in-process subagent loads its own copy of the extension; the
		// parent's copy serves its requests.
		const child = loadExtension({ bridge: (await import(`../src/index.ts?instance=${Date.now()}-${Math.random()}`)).default });
		startSession(parent, "notice-parent");
		startSession(child, "notice-child");
		runInRequestLane("notice-child", () => recordIncident("empty_prompt@streamRequestInLane", "silent", {}));
		await settle();
		assert.equal(parent.sent.length, 0, "the parent session is not told about the child's incident");
		assert.equal(child.sent.length, 1);
		assert.match(child.sent[0].message.content, /empty_prompt at streamRequestInLane/);
	});

	it("sends no notice and registers no note tool without incidents.repo", async () => {
		installFakeGh();
		const pi = loadExtension({ enabled: false });
		startSession(pi, "notice-off");
		runInRequestLane("notice-off", () => recordIncident("session_verify_fail@verifyWrittenSession", "silent", {}));
		await settle();
		assert.deepEqual(pi.sent, []);
		assert.equal(pi.tools.has(NOTE_TOOL), false);
		assert.deepEqual(ghCalls(), []);
	});
});

describe("the turn after a notice", () => {
	it("reuses Claude's session with the notice as appended history, keeping the system prompt and tools", async () => {
		// The stored version differs from the one the fake Claude Code reports:
		// turn 1 records an external incident, and its notice goes to turn 2.
		writeFileSync(join(agentDir, "claude-bridge-incidents.jsonl"), `${JSON.stringify({ type: "claude_code_version", version: "9.9.8" })}\n`, { mode: 0o600 });
		installFakeGh();
		const pi = loadExtension();
		startSession(pi, "notice-reuse");
		const noteTool = pi.tools.get(NOTE_TOOL);
		const system = { role: "system", content: "test system prompt", toolsAdded: [ECHO, { name: noteTool.name, description: noteTool.description, parameters: noteTool.parameters }], timestamp: 0 };

		const observed = [];
		__testSetSdkQueryFactory(({ prompt, options }) => ({
			async *[Symbol.asyncIterator]() {
				const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
				await options.mcpServers["custom-tools"].instance.connect(serverTransport);
				const client = new Client({ name: "fake-claude-code", version: "1.0.0" });
				await client.connect(clientTransport);
				const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
				// A text-only prompt reaches the SDK as a string.
				const promptText = typeof prompt === "string" ? prompt : "[prompt stream]";
				observed.push({ resume: options.resume ?? null, systemPrompt: JSON.stringify(options.systemPrompt), tools, promptText });
				const reply = `reply ${observed.length}`;
				yield { type: "system", subtype: "init", session_id: "notice-claude-session", claude_code_version: "9.9.9" };
				yield { type: "stream_event", event: { type: "message_start", message: { id: `m${observed.length}`, model: model.id, usage: { input_tokens: 1 } } } };
				yield { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } };
				yield { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply } } };
				yield { type: "stream_event", event: { type: "content_block_stop", index: 0 } };
				yield { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } } };
				yield { type: "stream_event", event: { type: "message_stop" } };
				yield { type: "result", subtype: "success", session_id: "notice-claude-session" };
			},
			close() {},
			async interrupt() {},
		}));

		// Pi's prompt path (agent-session.js): the user message, then every
		// pending nextTurn message, each as the custom message Pi stores.
		const pending = [];
		const takeNotices = () => pi.sent.splice(0).map(({ message }) => ({ role: "custom", customType: message.customType, content: message.content, display: message.display, details: message.details, timestamp: stamp() }));
		let history = [system];
		const turn = async (text) => {
			history = [...history, { role: "user", content: text, timestamp: stamp() }, ...pending.splice(0)];
			const events = await collect(streamClaudeAgentSdk(model, { messages: convertToLlm(history) }, { sessionId: "notice-reuse" }));
			const done = events.find((event) => event.type === "done");
			assert.ok(done, "the turn finishes");
			history = [...history, done.message];
			await settle();
			pending.push(...takeNotices());
		};

		const logPath = process.env.CLAUDE_BRIDGE_DEBUG_PATH;
		const logStart = existsSync(logPath) ? statSync(logPath).size : 0;
		await turn("first question");
		assert.equal(pending.length, 1, "turn 1's incident queued one notice");
		assert.match(pending[0].content, /claude_code_version_changed at init/);
		await turn("second question");
		await turn("third question");

		const paths = [...readFileSync(logPath, "utf8").slice(logStart).matchAll(/syncResult: path=([a-z-]+)/g)].map((match) => match[1]);
		assert.deepEqual(paths, ["clean-start", "reuse", "reuse"], "no rebuild on or after the turn that carries the notice");
		assert.deepEqual(observed.map((entry) => entry.resume), [null, "notice-claude-session", "notice-claude-session"]);
		assert.ok(observed[1].promptText.includes("second question") && observed[1].promptText.includes("Pi Claude bridge incident"), "turn 2's prompt carries the notice after the user's text");
		assert.ok(!observed[2].promptText.includes("Pi Claude bridge incident"), "turn 3 does not resend it");
		assert.equal(new Set(observed.map((entry) => entry.systemPrompt)).size, 1, "the system prompt is unchanged");
		assert.equal(new Set(observed.map((entry) => entry.tools.join(","))).size, 1, "the tool list is unchanged");
		assert.ok(observed[0].tools.some((name) => name.endsWith(NOTE_TOOL)), "the note tool is served from the first turn");
	});
});

describe("the incident note tool", () => {
	it("comments the sanitized note on the incident's issue", async () => {
		installFakeGh();
		const pi = loadExtension();
		startSession(pi, "note-filed");
		const incident = runInRequestLane("note-filed", () => recordIncident("tool_result_delivery_mismatch@query-teardown", "silent", {}));
		await settle();
		const note = `The read tool returned twice for one call.\n## heading ${mention("someone")} ${otherLink} ${SYNTHETIC_KEY} ${"a".repeat(40)}`;
		const reply = await runTool(pi, { incident: incident.id, note });
		assert.equal(reply, `Added your note to ${REPO}#7 (incident ${incident.id}).`);
		assert.equal(comments().length, 1);
		const [call] = comments();
		assert.deepEqual(call.argv.slice(0, 5), ["issue", "comment", "7", "--repo", REPO]);
		assert.ok(call.stdin.includes("The read tool returned twice for one call."));
		assert.ok(call.stdin.includes("> ## heading"), "the note is quoted, never markup of the comment");
		for (const removed of [mention("someone"), otherLink, SYNTHETIC_KEY, "a".repeat(40)]) assert.ok(!call.stdin.includes(removed), removed.slice(0, 16));
	});

	it("keeps a note on an incident that is not filed yet and adds it once it is", async () => {
		installFakeGh({ mode: "auth" });
		const pi = loadExtension();
		startSession(pi, "note-queued");
		const incident = runInRequestLane("note-queued", () => recordIncident("session_verify_fail@verifyWrittenSession", "silent", {}));
		await settle();
		const reply = await runTool(pi, { incident: incident.id, note: "Saw the session reload right after." });
		assert.equal(reply, `Kept your note on incident ${incident.id}: it is not filed yet (failed gh-auth). The note is added to its issue when it is filed.`);
		assert.deepEqual(comments(), []);

		advance(HOUR + 1);
		writeFileSync(join(ghDir, "state.json"), JSON.stringify({ mode: "ok", issues: [], next: 20 }));
		runInRequestLane("note-queued", () => recordIncident("session_verify_fail@verifyWrittenSession", "silent", {}));
		await settle();
		assert.deepEqual(ghCalls().filter((call) => call.argv[1] !== "list").map((call) => call.argv[1]).slice(-2), ["create", "comment"]);
		assert.equal(comments()[0].argv[2], "20");
		assert.ok(comments()[0].stdin.includes("Saw the session reload right after."));
	});

	it("refuses an unknown or expected incident and a note over 2,000 characters", async () => {
		installFakeGh();
		const pi = loadExtension();
		startSession(pi, "note-refused");
		const filed = runInRequestLane("note-refused", () => recordIncident("empty_prompt@streamRequestInLane", "silent", {}));
		const expected = runInRequestLane("note-refused", () => recordIncident("partial_tool_calls_pruned@abort", "expected", {}));
		await settle();
		const before = ghCalls().length;
		await assert.rejects(runTool(pi, { incident: "bi-zzzz", note: "x" }), /Unknown incident bi-zzzz/);
		await assert.rejects(runTool(pi, { incident: expected.id, note: "x" }), /expected cleanup, which is never filed/);
		await assert.rejects(runTool(pi, { incident: filed.id, note: "x".repeat(2001) }), /2001 characters; the limit is 2000/);
		await assert.rejects(runTool(pi, { incident: filed.id, note: "   " }), /empty/);
		assert.equal(ghCalls().length, before, "no gh for a refused note");
	});
});
