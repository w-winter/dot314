// With CLAUDE_BRIDGE_DEBUG=1 the bridge log records the shape of what passes
// through it, never a tool payload or text the user wrote: a Pi tool result's
// content, the prompt and a steer replayed as a continuation leave only ids,
// counts and lengths behind. The flow below crosses every site that handles
// those: the tool-result callback, the handler that receives the result, the
// steer deferred for replay and the continuation that replays it.
import "./lib/debug-env.mjs";

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Type } from "@earendil-works/pi-ai";

import claudeBridge, { __testSetBridgeIntegrityState, __testSetSdkQueryFactory, streamClaudeAgentSdk } from "../src/index.ts";
import { setExtensionApi } from "../src/bridge-state.ts";
import { loadConfig } from "../src/config.ts";
import { ctx, resetStack } from "../src/query-state.ts";
import { runInRequestLane } from "../src/request-lane.ts";
import { verifyWrittenSession } from "../src/session-verify.ts";

const model = { id: "claude-haiku-4-5", name: "Claude Haiku", api: "claude-bridge", provider: "pi-claude", baseUrl: "claude-bridge", reasoning: true, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 8192 };
const SLOW = { name: "slow_tool", description: "A slow tool", parameters: Type.Object({}) };
const SESSION = "debug-payload-session";
const LANE = "DEBUG-PAYLOAD";
const PROMPT_MARKER = "prompt-marker-5c1e";
const RESULT_MARKER = "result-marker-9f3a";
const STEER_MARKER = "steer-marker-27bd";

let clock = Date.now();
const user = (content) => ({ role: "user", content, timestamp: clock++ });
const system = { role: "system", content: "test system prompt", toolsAdded: [SLOW], timestamp: 0 };
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
async function collect(stream) {
	const events = [];
	for await (const event of stream) events.push(event);
	return events;
}
async function waitFor(check, what) {
	const deadline = Date.now() + 1000;
	while (!check() && Date.now() < deadline) await tick(5);
	assert.ok(check(), `timed out waiting for ${what}`);
}
const textTurn = (text) => [
	{ type: "stream_event", event: { type: "message_start", message: { id: `m-${clock++}`, model: model.id, usage: { input_tokens: 1 } } } },
	{ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
	{ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } },
	{ type: "stream_event", event: { type: "content_block_stop", index: 0 } },
	{ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } } },
	{ type: "stream_event", event: { type: "message_stop" } },
];

/** Fake Claude Code: the first query calls `slow_tool` [t1] through the real
 *  MCP server and gives up on it while Pi runs it, so a steer arriving with
 *  its result is deferred to a continuation. Later queries answer. */
function installFakeClaudeCode() {
	const observed = { queries: 0, abandoned: Promise.withResolvers() };
	__testSetSdkQueryFactory(({ options }) => {
		observed.queries += 1;
		const first = observed.queries === 1;
		const closing = Promise.withResolvers();
		return {
			async *[Symbol.asyncIterator]() {
				if (!first) {
					yield { type: "system", subtype: "init", session_id: options.resume ?? SESSION };
					yield* textTurn("continuation");
					yield { type: "result", subtype: "success" };
					return;
				}
				const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
				await options.mcpServers["custom-tools"].instance.connect(serverTransport);
				const client = new Client({ name: "fake-claude-code", version: "1.0.0" });
				await client.connect(clientTransport);
				yield { type: "system", subtype: "init", session_id: SESSION };
				yield { type: "stream_event", event: { type: "message_start", message: { id: "tool-turn", model: model.id, usage: { input_tokens: 1 } } } };
				yield { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: `mcp__custom-tools__${SLOW.name}`, input: {} } } };
				yield { type: "stream_event", event: { type: "content_block_stop", index: 0 } };
				yield { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } } };
				yield { type: "stream_event", event: { type: "message_stop" } };
				const late = client.callTool({ name: SLOW.name, arguments: {}, _meta: { "claudecode/toolUseId": "t1" } });
				await waitFor(() => runInRequestLane(LANE, () => ctx().pendingToolCalls.has("t1")), "the t1 handler");
				yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "Claude Code stopped waiting for this call", is_error: true }] } };
				observed.abandoned.resolve();
				await Promise.race([late, closing.promise]);
				yield* textTurn("done");
				yield { type: "result", subtype: "success", session_id: SESSION };
			},
			async streamInput() {},
			close() { closing.resolve(); },
			async interrupt() { closing.resolve(); },
		};
	});
	return observed;
}

let root;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "bridge-debug-payload-"));
	process.env.CLAUDE_CONFIG_DIR = root;
	process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token";
	process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT = "0";
	process.env.CLAUDE_BRIDGE_DIAG_PATH = join(root, "diag.log");
	resetStack();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: { notify: () => {} } });
	setExtensionApi({ events: { emit: () => {} }, appendEntry: () => {} });
});

afterEach(() => {
	__testSetSdkQueryFactory();
	setExtensionApi(undefined);
	resetStack();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
	for (const key of ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT", "CLAUDE_BRIDGE_DIAG_PATH"]) delete process.env[key];
	rmSync(root, { recursive: true, force: true });
});

it("logs no tool result content, prompt or steer text, only their shape", async () => {
	const observed = installFakeClaudeCode();
	const start = [system, user(`start ${PROMPT_MARKER}`)];
	const first = await collect(streamClaudeAgentSdk(model, { messages: start }, { sessionId: LANE }));
	const toolTurn = first.find((event) => event.type === "done");
	assert.equal(toolTurn?.reason, "toolUse");
	await observed.abandoned.promise;
	const messages = [
		...start,
		toolTurn.message,
		{ role: "toolResult", toolCallId: "t1", toolName: SLOW.name, content: [{ type: "text", text: `output ${RESULT_MARKER}` }], isError: false, timestamp: clock++ },
		user(`please also ${STEER_MARKER}`),
	];
	const events = await collect(streamClaudeAgentSdk(model, { messages }, { sessionId: LANE }));
	assert.equal(events.at(-1).type, "done");
	assert.equal(observed.queries, 2, "the steer was replayed as a continuation");

	const log = readFileSync(process.env.CLAUDE_BRIDGE_DEBUG_PATH, "utf8");
	// Every site that handles the markers ran and logged.
	assert.match(log, /provider: fresh query/);
	assert.match(log, /extractAllToolResults: result\[0\] id=t1/);
	assert.match(log, /provider: resolving slow_tool \[t1\]/);
	assert.match(log, /provider: deferred 1 user message\(s\)/);
	assert.match(log, /provider: replaying deferred user message/);
	assert.match(log, /provider: continuation query/);
	for (const marker of [PROMPT_MARKER, RESULT_MARKER, STEER_MARKER]) {
		assert.ok(!log.includes(marker), `the debug log carries ${marker}`);
	}
});

/** The debug log lines `run` writes, with `claude-bridge.json` in a scratch
 *  agent dir holding `configText`. */
function logWithConfig(configText, run) {
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "claude-bridge.json"), configText);
	const saved = process.env.PI_CODING_AGENT_DIR;
	const offset = existsSync(process.env.CLAUDE_BRIDGE_DEBUG_PATH) ? readFileSync(process.env.CLAUDE_BRIDGE_DEBUG_PATH, "utf8").length : 0;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		run();
	} finally {
		process.env.PI_CODING_AGENT_DIR = saved;
	}
	return readFileSync(process.env.CLAUDE_BRIDGE_DEBUG_PATH, "utf8").slice(offset);
}

it("logs the configured replacement prompt as its length", () => {
	const marker = "replacement-marker-61d0";
	const log = logWithConfig(JSON.stringify({ enabled: false, systemPrompt: { replacement: `Be brief. ${marker}` } }), () => {
		claudeBridge({ on: () => {}, registerCommand: () => {}, registerProvider: () => {}, registerTool: () => {}, events: { emit: () => {} }, appendEntry: () => {} });
	});
	assert.match(log, /loadConfig: \{"enabled":false,"systemPrompt":\{"replacement":"<33 chars>"\}/);
	assert.ok(!log.includes(marker), "the debug log carries the replacement prompt");
});

// JSON.parse's message quotes the input around the error, so a parse failure
// is logged by name and position only. The markers are short enough to fit
// the parser's excerpt whole.
it("logs a malformed config without the parser's excerpt of it", () => {
	const marker = "mk_b7e2";
	const log = logWithConfig(`{"systemPrompt":{"replacement": ${marker}}}`, () => loadConfig(root));
	assert.match(log, /config: ignoring malformed \S+claude-bridge\.json: SyntaxError/);
	assert.ok(!log.includes(marker), "the debug log carries the config's text");
});

it("reports a malformed session record by line, without the parser's excerpt of it", () => {
	// The warning is what the debug line, the session_verify_fail diag entry and
	// the user notice carry.
	const marker = "mk_0d4c";
	const path = join(root, "session.jsonl");
	writeFileSync(path, `{"sessionId":"s1","message":{"role":"user","content":"hi"}}\n{"sessionId":"s1","message":{"role":"user","content":${marker}}}\n`);
	const warnings = verifyWrittenSession(path, "s1", 2);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /^malformed JSONL — path=\S+ line=2 err=SyntaxError/);
	assert.ok(!warnings[0].includes(marker), "the warning carries the record's content");
});

// A log read later has to name what produced it: the bridge commit, Pi and
// Node when the extension loads, and Claude Code's version when a query first
// reports it or reports a different one.
it("stamps the log with the bridge, Pi, Node and Claude Code versions", async () => {
	const log = logWithConfig(JSON.stringify({ enabled: false }), () => {
		claudeBridge({ on: () => {}, registerCommand: () => {}, registerProvider: () => {}, registerTool: () => {}, events: { emit: () => {} }, appendEntry: () => {} });
	});
	assert.equal(log.match(/versions: bridge=([0-9a-f]{12}|unknown) pi=\S+ node=v\d+\.\d+\.\d+\n/g)?.length, 1, log);

	const offset = readFileSync(process.env.CLAUDE_BRIDGE_DEBUG_PATH, "utf8").length;
	let version = "0.0.1";
	__testSetSdkQueryFactory(() => ({
		async *[Symbol.asyncIterator]() {
			yield { type: "system", subtype: "init", session_id: `versions-${clock++}`, claude_code_version: version };
			yield* textTurn("hi");
			yield { type: "result", subtype: "success" };
		},
		async streamInput() {},
		close() {},
		async interrupt() {},
	}));
	for (const next of ["0.0.1", "0.0.1", "0.0.2"]) {
		version = next;
		const events = await collect(streamClaudeAgentSdk(model, { messages: [system, user("hello")] }, { sessionId: `VERSIONS-${clock++}` }));
		assert.equal(events.at(-1).type, "done");
	}
	const lines = readFileSync(process.env.CLAUDE_BRIDGE_DEBUG_PATH, "utf8").slice(offset).match(/versions: claude-code=\S+/g);
	assert.deepEqual(lines, ["versions: claude-code=0.0.1", "versions: claude-code=0.0.2"]);
});
