// Agent notices. Whatever the configuration, the user-visible and silent
// incidents a Pi session's requests hit are told to that session once per
// signature, all together in one `claude-bridge-incident` message that its
// before_agent_start handler returns with the next prompt. External and
// expected incidents are never noticed. The bridge never sends a message or
// starts a turn of its own for them.
import "./lib/debug-env.mjs";

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Type } from "@earendil-works/pi-ai";
import { convertToLlm as bundledConvertToLlm } from "@earendil-works/pi-coding-agent";
import { tsImport } from "tsx/esm/api";

import claudeBridge, { __testSetBridgeIntegrityState, __testSetSdkQueryFactory, streamClaudeAgentSdk } from "../src/index.ts";
import { setExtensionApi } from "../src/bridge-state.ts";
import { NOTICE_SESSIONS_KEPT, __testResetNotices } from "../src/incident-notice.ts";
import { __testFlushIncidents, __testResetIncidents, listIncidents, recordIncident } from "../src/incidents.ts";
import { resetStack } from "../src/query-state.ts";
import { runInRequestLane } from "../src/request-lane.ts";

// Pi 0.87.1's own convertToLlm when installed: the function that turns the
// notice into what the provider receives.
const INSTALLED_PI_MESSAGES = "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/messages.js";
const convertToLlm = existsSync(INSTALLED_PI_MESSAGES) ? (await import(INSTALLED_PI_MESSAGES)).convertToLlm : bundledConvertToLlm;

const REPO = "nicobailon/bridge-incidents";
const TOOL = "claude_bridge_incident";
const FILE_LINE = `Use ${TOOL} show <id> to inspect one. If one looks like a bridge bug, file it with ${TOOL} file and tell the user.`;
const OFF_LINE = `Use ${TOOL} show <id> to inspect one. Filing is off: the user has not set incidents.repo in their claude-bridge.json, so do not try to file.`;

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
let clock = Date.now();
const stamp = () => clock++;

/** A fake Pi: the handlers, tools and messages the extension registers or
 *  sends through it. */
function fakePi() {
	const pi = {
		handlers: new Map(),
		tools: new Map(),
		sent: [],
		on: (event, handler) => pi.handlers.set(event, [...pi.handlers.get(event) ?? [], handler]),
		registerCommand: () => {},
		registerProvider: () => {},
		registerTool: (tool) => pi.tools.set(tool.name, tool),
		sendMessage: (message, options) => pi.sent.push({ message, options }),
		sendUserMessage: (message, options) => pi.sent.push({ message, options }),
		events: { emit: () => {} },
		appendEntry: () => {},
	};
	return pi;
}

function loadExtension({ repo = true, bridge = claudeBridge } = {}) {
	if (repo) writeFileSync(join(agentDir, "claude-bridge.json"), JSON.stringify({ incidents: { repo: REPO } }));
	else rmSync(join(agentDir, "claude-bridge.json"), { force: true });
	const pi = fakePi();
	bridge(pi);
	return pi;
}

/** A fresh copy of the extension, every module of it, as Pi loads one on
 *  /reload or for an in-process subagent. */
async function freshCopy() {
	return (await tsImport("../src/index.ts", import.meta.url)).default;
}

function sessionCtx(sessionId) {
	const sessionManager = { getSessionId: () => sessionId, getEntries: () => [], getBranch: () => [] };
	return { sessionManager, ui: { notify: () => {} }, cwd: process.cwd(), hasUI: false };
}

function emit(pi, event, sessionId, payload = {}) {
	return Promise.all((pi.handlers.get(event) ?? []).map((handler) => handler({ type: event, ...payload }, sessionCtx(sessionId))));
}

/** Pi 0.87.1's emitBeforeAgentStart (extensions/runner.js): runs every
 *  before_agent_start handler of this copy and collects the messages they
 *  return. */
async function beforeAgentStart(pi, sessionId, prompt = "next question") {
	const results = await emit(pi, "before_agent_start", sessionId, { prompt, images: undefined, systemPrompt: "", systemPromptOptions: {} });
	for (const result of results) assert.equal(result?.systemPrompt, undefined, "a notice never changes the system prompt");
	return results.filter((result) => result?.message).map((result) => result.message);
}

const find = (signature) => listIncidents().find((incident) => incident.signature === signature);
const record = (sessionId, signature, klass) => runInRequestLane(sessionId, () => recordIncident(signature, klass, {}));

async function collect(stream) {
	const events = [];
	for await (const event of stream) events.push(event);
	return events;
}

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "bridge-notice-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT = "0";
	process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token";
	process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(agentDir, "claude-"));
	resetStack();
	__testResetIncidents();
	__testResetNotices();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: { notify: () => {} } });
	setExtensionApi({ events: { emit: () => {} }, appendEntry: () => {} });
});

afterEach(async () => {
	await __testFlushIncidents();
	delete process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT;
	delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
	delete process.env.CLAUDE_CONFIG_DIR;
	__testSetSdkQueryFactory();
	setExtensionApi(undefined);
	resetStack();
	__testResetIncidents();
	__testResetNotices();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
	rmSync(agentDir, { recursive: true, force: true });
});

describe("incident notices", () => {
	it("tells a session about all its new incidents in one message with its next prompt, and never on its own", async () => {
		const pi = loadExtension();
		await emit(pi, "session_start", "notice-group", { reason: "new" });
		record("notice-group", "tool_call_dead@answerUnclaimedToolUse", "user-visible");
		record("notice-group", "session_verify_fail@verifyWrittenSession", "silent");
		record("notice-group", "tool_call_dead@answerUnclaimedToolUse", "user-visible");
		await __testFlushIncidents();
		assert.deepEqual(pi.sent, [], "no message and no turn of the bridge's own");

		const dead = find("tool_call_dead@answerUnclaimedToolUse");
		const verify = find("session_verify_fail@verifyWrittenSession");
		const messages = await beforeAgentStart(pi, "notice-group");
		assert.deepEqual(messages, [{
			customType: "claude-bridge-incident",
			content: [
				"Claude bridge: 2 incidents since your last message.",
				`- ${dead.id}: Claude Code called a tool whose call had already ended (tool_call_dead at answerUnclaimedToolUse; an error was shown)`,
				`- ${verify.id}: The session file the bridge wrote for Claude Code did not read back as written (session_verify_fail at verifyWrittenSession; the bridge recovered)`,
				FILE_LINE,
			].join("\n"),
			display: true,
			details: { incidents: [dead.id, verify.id] },
		}]);
		assert.deepEqual(await beforeAgentStart(pi, "notice-group"), [], "told once");
		assert.deepEqual(pi.sent, []);
	});

	it("notices no external or expected incident, which the tool still lists", async () => {
		const pi = loadExtension();
		await emit(pi, "session_start", "notice-quiet", { reason: "new" });
		record("notice-quiet", "api_error@consumeQuery", "external");
		record("notice-quiet", "claude_code_version_changed@init", "external");
		record("notice-quiet", "partial_tool_calls_pruned@abort", "expected");
		assert.deepEqual(await beforeAgentStart(pi, "notice-quiet"), []);
		assert.deepEqual(pi.sent, []);
		const list = (await pi.tools.get(TOOL).execute("call-1", { action: "list" }, undefined, undefined, {})).content[0].text;
		assert.match(list, /api_error at consumeQuery/);
		assert.match(list, /claude_code_version_changed at init/);
	});

	it("notices a silent workaround for Claude Code misbehavior", async () => {
		const pi = loadExtension();
		record("notice-workaround", "tool_call_abandoned_by_claude_code@noteAbandonedToolCalls", "silent");
		const incident = find("tool_call_abandoned_by_claude_code@noteAbandonedToolCalls");
		const [message] = await beforeAgentStart(pi, "notice-workaround");
		assert.equal(message.content, [
			"Claude bridge: 1 incident since your last message.",
			`- ${incident.id}: Claude Code gave up on a tool call before Pi returned its result (tool_call_abandoned_by_claude_code at noteAbandonedToolCalls; the bridge recovered)`,
			FILE_LINE,
		].join("\n"));
	});

	it("notices without incidents.repo, saying that filing is off", async () => {
		const pi = loadExtension({ repo: false });
		record("notice-off", "session_verify_fail@verifyWrittenSession", "silent");
		const [message] = await beforeAgentStart(pi, "notice-off");
		assert.equal(message.content.split("\n").at(-1), OFF_LINE);
		assert.ok(!message.content.includes(`${TOOL} file`));
	});

	it("tells a session about a signature once, and keeps what it was told and has pending across a Pi reload", async () => {
		const pi = loadExtension();
		await emit(pi, "session_start", "notice-reload", { reason: "startup" });
		record("notice-reload", "session_verify_fail@verifyWrittenSession", "silent");
		assert.equal((await beforeAgentStart(pi, "notice-reload")).length, 1);
		record("notice-reload", "empty_prompt@streamRequestInLane", "silent");

		// Pi 0.87.1 reloads a session in place: session_shutdown and then
		// session_start, both with reason "reload", reach a freshly loaded copy.
		await emit(pi, "session_shutdown", "notice-reload", { reason: "reload" });
		const reloaded = loadExtension({ bridge: await freshCopy() });
		await emit(reloaded, "session_start", "notice-reload", { reason: "reload" });
		record("notice-reload", "session_verify_fail@verifyWrittenSession", "silent");
		const messages = await beforeAgentStart(reloaded, "notice-reload");
		assert.equal(messages.length, 1);
		assert.match(messages[0].content, /^Claude bridge: 1 incident since your last message\.\n- bi-[0-9a-z]+: A query started without any prompt text/, "the pending one, not the one already told");
		assert.deepEqual(pi.sent.concat(reloaded.sent), []);

		// Another session is told about the same signature itself.
		record("notice-other", "session_verify_fail@verifyWrittenSession", "silent");
		assert.equal((await beforeAgentStart(reloaded, "notice-other")).length, 1);
	});

	it("tells the Pi session whose request hit the incident, through that session's own extension copy", async () => {
		const parent = loadExtension();
		// An in-process subagent loads its own copy of the extension; the
		// parent's copy serves its requests and records its incidents.
		const child = loadExtension({ bridge: await freshCopy() });
		record("notice-child", "empty_prompt@streamRequestInLane", "silent");
		assert.deepEqual(await beforeAgentStart(parent, "notice-parent"), [], "the parent session is not told about the child's incident");
		const messages = await beforeAgentStart(child, "notice-child");
		assert.equal(messages.length, 1);
		assert.match(messages[0].content, /empty_prompt at streamRequestInLane/);
	});

	it("keeps what the most recent sessions were told, and no more", async () => {
		const pi = loadExtension();
		record("notice-kept-0", "empty_prompt@streamRequestInLane", "silent");
		assert.equal((await beforeAgentStart(pi, "notice-kept-0")).length, 1);
		record("notice-kept-0", "empty_prompt@streamRequestInLane", "silent");
		assert.deepEqual(await beforeAgentStart(pi, "notice-kept-0"), []);
		for (let i = 1; i <= NOTICE_SESSIONS_KEPT; i++) record(`notice-kept-${i}`, "empty_prompt@streamRequestInLane", "silent");
		// The oldest session's state went: it counts as new again.
		record("notice-kept-0", "empty_prompt@streamRequestInLane", "silent");
		assert.equal((await beforeAgentStart(pi, "notice-kept-0")).length, 1);
	});
});

describe("the turn that carries a notice", () => {
	it("reuses Claude's session with the notice after the user's prompt, keeping the system prompt and tools, and on the turn after", async () => {
		const pi = loadExtension();
		await emit(pi, "session_start", "notice-reuse", { reason: "new" });
		const incidentTool = pi.tools.get(TOOL);
		const system = { role: "system", content: "test system prompt", toolsAdded: [ECHO, { name: incidentTool.name, description: incidentTool.description, parameters: incidentTool.parameters }], timestamp: 0 };

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
				// Turn 1: Claude Code calls a Pi tool the stream never named, a
				// user-visible incident; Claude gets an error for it.
				if (observed.length === 1) assert.equal((await client.callTool({ name: "echo", arguments: { text: "x" } })).isError, true);
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

		// Pi 0.87.1's prompt path (agent-session.js): before_agent_start runs,
		// then the user message, then each message a handler returned, as the
		// custom message Pi stores.
		let history = [system];
		const carried = [];
		const turn = async (text) => {
			const notices = (await beforeAgentStart(pi, "notice-reuse", text)).map((message) => ({ role: "custom", ...message, timestamp: stamp() }));
			carried.push(notices.length);
			history = [...history, { role: "user", content: text, timestamp: stamp() }, ...notices];
			const events = await collect(streamClaudeAgentSdk(model, { messages: convertToLlm(history) }, { sessionId: "notice-reuse" }));
			const done = events.find((event) => event.type === "done");
			assert.ok(done, "the turn finishes");
			history = [...history, done.message];
			await __testFlushIncidents();
		};

		const logPath = process.env.CLAUDE_BRIDGE_DEBUG_PATH;
		const logStart = existsSync(logPath) ? statSync(logPath).size : 0;
		await turn("first question");
		await turn("second question");
		await turn("third question");

		assert.deepEqual(carried, [0, 1, 0], "turn 1's incident rides with turn 2's prompt only");
		const paths = [...readFileSync(logPath, "utf8").slice(logStart).matchAll(/syncResult: path=([a-z-]+)/g)].map((match) => match[1]);
		assert.deepEqual(paths, ["clean-start", "reuse", "reuse"], "no rebuild on or after the turn that carries the notice");
		assert.deepEqual(observed.map((entry) => entry.resume), [null, "notice-claude-session", "notice-claude-session"]);
		const second = observed[1].promptText;
		assert.ok(second.includes("Claude bridge: 1 incident since your last message.") && second.includes("tool_handler_unmatched at mcpToolHandler"), "turn 2's prompt carries the notice");
		assert.ok(second.indexOf("second question") < second.indexOf("Claude bridge:"), "after the user's text");
		assert.ok(!observed[2].promptText.includes("Claude bridge:"), "turn 3 does not resend it");
		assert.equal(new Set(observed.map((entry) => entry.systemPrompt)).size, 1, "the system prompt is unchanged");
		assert.equal(new Set(observed.map((entry) => entry.tools.join(","))).size, 1, "the tool list is unchanged");
		assert.deepEqual(pi.sent, []);
	});
});
