// Debug-mode anomaly notices. With CLAUDE_BRIDGE_DEBUG=1, a told anomaly a
// session's request hits rides with that session's next prompt, as one
// displayed message its before_agent_start handler returns; a kind is told
// once per session, and expected cleanup is never told. The notice follows
// the user's prompt, so Claude's session is reused and the system prompt and
// tools stay as they were. Without the flag nothing is told.
import "./lib/debug-env.mjs";

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Type } from "@earendil-works/pi-ai";
import { convertToLlm as bundledConvertToLlm } from "@earendil-works/pi-coding-agent";
import { tsImport } from "tsx/esm/api";

import * as debugBridge from "../src/index.ts";
import { noteAnomaly } from "../src/debug-notice.ts";
import { resetStack } from "../src/query-state.ts";
import { runInRequestLane } from "../src/request-lane.ts";

// Pi's own convertToLlm when installed: the function that turns the notice
// into what the provider receives.
const INSTALLED_PI_MESSAGES = "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/messages.js";
const convertToLlm = existsSync(INSTALLED_PI_MESSAGES) ? (await import(INSTALLED_PI_MESSAGES)).convertToLlm : bundledConvertToLlm;

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

function fakePi() {
	const pi = {
		handlers: new Map(),
		sent: [],
		on: (event, handler) => pi.handlers.set(event, [...pi.handlers.get(event) ?? [], handler]),
		registerCommand: () => {},
		registerProvider: () => {},
		registerTool: () => {},
		sendMessage: (message, options) => pi.sent.push({ message, options }),
		sendUserMessage: (message, options) => pi.sent.push({ message, options }),
		events: { emit: () => {} },
		appendEntry: () => {},
	};
	return pi;
}

function sessionCtx(sessionId) {
	const sessionManager = { getSessionId: () => sessionId, getEntries: () => [], getBranch: () => [] };
	return { sessionManager, ui: { notify: () => {} }, cwd: process.cwd(), hasUI: false };
}

function emit(pi, event, sessionId, payload = {}) {
	return Promise.all((pi.handlers.get(event) ?? []).map((handler) => handler({ type: event, ...payload }, sessionCtx(sessionId))));
}

/** Pi 0.99.1's emitBeforeAgentStart (extensions/runner.js): runs every
 *  before_agent_start handler and collects the messages they return. */
async function beforeAgentStart(pi, sessionId, prompt) {
	const results = await emit(pi, "before_agent_start", sessionId, { prompt, images: undefined, systemPrompt: "", systemPromptOptions: {} });
	for (const result of results) assert.equal(result?.systemPrompt, undefined, "a notice never changes the system prompt");
	return results.filter((result) => result?.message).map((result) => result.message);
}

async function collect(stream) {
	const events = [];
	for await (const event of stream) events.push(event);
	return events;
}

/** A fresh copy of every bridge module, as Pi loads one on /reload or for an
 *  in-process subagent, evaluated with CLAUDE_BRIDGE_DEBUG on or off. */
async function freshCopy({ debug }) {
	if (!debug) delete process.env.CLAUDE_BRIDGE_DEBUG;
	try {
		return await tsImport("../src/index.ts", import.meta.url);
	} finally {
		process.env.CLAUDE_BRIDGE_DEBUG = "1";
	}
}

/** A Pi session's before_agent_start through its own loaded copy `bridge`. */
async function promptThrough(bridge, sessionId) {
	const pi = fakePi();
	bridge.default(pi);
	return beforeAgentStart(pi, sessionId, "next question");
}

/** Three prompts of one Pi session through `bridge`. Turns 1 and 2 each have
 *  Claude Code call a Pi tool the stream never named (a told anomaly). Turn 1
 *  also ends at a max-tokens stop with an unfinished tool call, which the
 *  bridge prunes as expected cleanup. */
async function threeTurns(bridge, sessionId) {
	const pi = fakePi();
	bridge.default(pi);
	await emit(pi, "session_start", sessionId, { reason: "new" });
	const system = { role: "system", content: "test system prompt", toolsAdded: [ECHO], timestamp: 0 };
	const observed = [];
	bridge.__testSetSdkQueryFactory(({ prompt, options }) => ({
		async *[Symbol.asyncIterator]() {
			const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
			await options.mcpServers["custom-tools"].instance.connect(serverTransport);
			const client = new Client({ name: "fake-claude-code", version: "1.0.0" });
			await client.connect(clientTransport);
			const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
			// A text-only prompt reaches the SDK as a string.
			const promptText = typeof prompt === "string" ? prompt : "[prompt stream]";
			observed.push({ resume: options.resume ?? null, systemPrompt: JSON.stringify(options.systemPrompt), tools, promptText });
			const turn = observed.length;
			yield { type: "system", subtype: "init", session_id: `${sessionId}-claude`, claude_code_version: "9.9.9" };
			if (turn <= 2) assert.equal((await client.callTool({ name: "echo", arguments: { text: "x" } })).isError, true);
			yield { type: "stream_event", event: { type: "message_start", message: { id: `m${turn}`, model: model.id, usage: { input_tokens: 1 } } } };
			yield { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } };
			yield { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `reply ${turn}` } } };
			yield { type: "stream_event", event: { type: "content_block_stop", index: 0 } };
			if (turn === 1) {
				yield { type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_cut", name: "mcp__custom-tools__echo", input: {} } } };
				yield { type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"text\":\"unfin" } } };
				yield { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 5 } } };
			} else {
				yield { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } } };
				yield { type: "stream_event", event: { type: "message_stop" } };
			}
			yield { type: "result", subtype: "success", session_id: `${sessionId}-claude` };
		},
		close() {},
		async interrupt() {},
	}));

	// Pi 0.99.1's prompt path (agent-session.js): before_agent_start runs,
	// then the user message, then each message a handler returned, as the
	// custom message Pi stores.
	let history = [system];
	const notices = [];
	for (const text of ["first question", "second question", "third question"]) {
		const returned = await beforeAgentStart(pi, sessionId, text);
		notices.push(returned);
		history = [...history, { role: "user", content: text, timestamp: stamp() }, ...returned.map((message) => ({ role: "custom", ...message, timestamp: stamp() }))];
		const events = await collect(bridge.streamClaudeAgentSdk(model, { messages: convertToLlm(history) }, { sessionId }));
		const done = events.find((event) => event.type === "done");
		assert.ok(done, "the turn finishes");
		history = [...history, done.message];
	}
	assert.deepEqual(pi.sent, [], "no message and no turn of the bridge's own");
	return { notices, observed };
}

const logFrom = (path, start) => existsSync(path) ? readFileSync(path, "utf8").slice(start) : "";
const sizeOf = (path) => existsSync(path) ? statSync(path).size : 0;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "bridge-debug-notice-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT = "0";
	process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token";
	process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(agentDir, "claude-"));
	resetStack();
});

afterEach(() => {
	delete process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT;
	delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
	delete process.env.CLAUDE_CONFIG_DIR;
	debugBridge.__testSetSdkQueryFactory();
	resetStack();
	rmSync(agentDir, { recursive: true, force: true });
});

describe("debug-mode anomaly notices", () => {
	it("tells a told anomaly once with the next prompt, never expected cleanup, and keeps Claude's session, system prompt and tools", { timeout: 20_000 }, async () => {
		const logPath = process.env.CLAUDE_BRIDGE_DEBUG_PATH;
		const diagPath = process.env.CLAUDE_BRIDGE_DIAG_PATH;
		const logStart = sizeOf(logPath);
		const diagStart = sizeOf(diagPath);
		const { notices, observed } = await threeTurns(debugBridge, "notice-debug");

		assert.deepEqual(notices.map((returned) => returned.length), [0, 1, 0], "turn 1's anomaly rides with turn 2's prompt only; turn 2's repeat is not told");
		const [message] = notices[1];
		assert.equal(message.customType, "claude-bridge-debug");
		assert.equal(message.display, true, "the TUI shows it");
		assert.deepEqual(message.details, { kinds: ["tool_handler_unmatched"] });
		const lines = message.content.split("\n");
		assert.equal(lines[0], "Claude bridge (debug mode): 1 anomaly since your last message.");
		assert.equal(lines[1], "- Claude Code called a Pi tool (tools/call) that the bridge could not match to any tool call in Claude's stream, so Claude got an error for it (tool_handler_unmatched; an error was shown)");
		assert.match(lines[2], /^Details are in the bridge debug log \(.+\) and diag log \(.+\)\. If one looks like a bridge bug, tell the user\.$/);
		assert.equal(lines.length, 3);

		const diag = logFrom(diagPath, diagStart);
		assert.ok(diag.includes("partial_tool_calls_pruned"), "turn 1 did prune its unfinished call");
		assert.ok(!message.content.includes("partial_tool_calls_pruned"), "a prune at a max-tokens stop is not told");
		const log = logFrom(logPath, logStart);
		assert.match(log, /debug notice: tool_handler_unmatched again for session notice-d; already told/);

		const paths = [...log.matchAll(/syncResult: path=([a-z-]+)/g)].map((match) => match[1]);
		assert.deepEqual(paths, ["clean-start", "reuse", "reuse"], "no rebuild on or after the turn that carries the notice");
		assert.deepEqual(observed.map((entry) => entry.resume), [null, "notice-debug-claude", "notice-debug-claude"]);
		const second = observed[1].promptText;
		assert.ok(second.indexOf("second question") < second.indexOf("Claude bridge (debug mode):"), "the notice follows the user's text");
		assert.ok(!observed[2].promptText.includes("Claude bridge (debug mode):"), "turn 3 does not resend it");
		assert.equal(new Set(observed.map((entry) => entry.systemPrompt)).size, 1, "the system prompt is unchanged");
		assert.equal(new Set(observed.map((entry) => entry.tools.join(","))).size, 1, "the tool list is unchanged");
	});

	it("tells nothing without CLAUDE_BRIDGE_DEBUG=1", { timeout: 20_000 }, async () => {
		const quietBridge = await freshCopy({ debug: false });
		try {
			const { notices } = await threeTurns(quietBridge, "notice-quiet");
			assert.deepEqual(notices.map((returned) => returned.length), [0, 0, 0]);
		} finally {
			quietBridge.__testSetSdkQueryFactory();
		}
	});

	it("reaches a session through any DEBUG copy it loads, and never through a copy loaded without DEBUG", { timeout: 20_000 }, async () => {
		runInRequestLane("notice-copies", () => noteAnomaly("empty_prompt"));
		assert.deepEqual(await promptThrough(await freshCopy({ debug: false }), "notice-copies"), [], "a copy without DEBUG tells nothing");
		const told = await promptThrough(await freshCopy({ debug: true }), "notice-copies");
		assert.deepEqual(told.map((message) => message.details), [{ kinds: ["empty_prompt"] }], "another DEBUG copy (a /reload, a subagent) tells it");
	});
});
