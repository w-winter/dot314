// Claude Code must never give up on a Pi tool call before Pi answers it.
// CC 2.1.283 applies two limits to calls on the bridge's in-process MCP
// server, both taken from the child's environment unless the bridge overrides
// them:
//   - a hard wall-clock limit per call: server `timeout` (>= 1000 ms), else
//     MCP_TOOL_TIMEOUT, else 1e8 ms; on expiry CC answers the call with
//     `MCP server "…" tool "…" timed out after Ns`;
//   - with CLAUDE_AUTO_BACKGROUND_TASKS set, a call still running after
//     CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS (default 120000) is moved to a
//     background task and answered with a placeholder.
// Either way the model ends its turn without the result and the query closes;
// Pi's real result, arriving later, is orphaned and the user sees an empty
// reply. The fake Claude Code below applies those rules to the options the
// bridge hands the SDK, so the test fails exactly when the real CLI would.
import "./lib/debug-env.mjs";

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Type } from "@earendil-works/pi-ai";

import { __testSetBridgeIntegrityState, __testSetSdkQueryFactory, streamClaudeAgentSdk } from "../src/index.ts";
import { setExtensionApi } from "../src/bridge-state.ts";
import { takeAgentNotice } from "../src/agent-notice.ts";
import { resetStack } from "../src/query-state.ts";
import { withAgentNotices } from "./lib/agent-notices.mjs";

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

const SLOW = { name: "slow_tool", description: "Takes a while", parameters: Type.Object({}) };
const PI_RESULT = "slow_tool finished: MARIGOLD";
// Pi takes longer than the shortest limit CC accepts (1000 ms).
const PI_TOOL_MS = 1_500;
const CC_TIMER_CEILING_MS = 2_147_483_647;

/** CC 2.1.283's per-call wall-clock limit for a server config. */
function ccCallLimitMs(serverConfig, env) {
	const configured = serverConfig.timeout !== undefined && serverConfig.timeout >= 1000 ? serverConfig.timeout : undefined;
	const limit = configured ?? (env.MCP_TOOL_TIMEOUT !== undefined ? Number(env.MCP_TOOL_TIMEOUT) : 1e8);
	return Math.min(Math.max(limit, 1000), CC_TIMER_CEILING_MS);
}

/** CC 2.1.283's auto-background delay for a non-interactive (SDK) session; 0 = off. */
function ccAutoBackgroundMs(env) {
	if (!env.CLAUDE_AUTO_BACKGROUND_TASKS) return 0;
	if (env.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS !== undefined) return Math.min(Math.max(0, Number(env.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS)), CC_TIMER_CEILING_MS);
	return 120_000;
}

function textTurn(id, text) {
	return [
		{ type: "stream_event", event: { type: "message_start", message: { id, model: model.id, usage: { input_tokens: 1 } } } },
		{ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
		{ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } },
		{ type: "stream_event", event: { type: "content_block_stop", index: 0 } },
		{ type: "stream_event", event: { type: "message_stop" } },
	];
}

function installFakeClaudeCode(observed) {
	__testSetSdkQueryFactory(({ options }) => {
		let closed = false;
		return {
			async *[Symbol.asyncIterator]() {
				const serverConfig = options.mcpServers["custom-tools"];
				const env = options.env ?? {};
				const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
				await serverConfig.instance.connect(serverTransport);
				const client = new Client({ name: "fake-claude-code", version: "1.0.0" });
				await client.connect(clientTransport);
				yield { type: "system", subtype: "init", session_id: "slow-tool-session" };
				for (const message of [
					{ type: "stream_event", event: { type: "message_start", message: { id: "m1", model: model.id, usage: { input_tokens: 1 } } } },
					{ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call-1", name: "mcp__custom-tools__slow_tool", input: {} } } },
					{ type: "stream_event", event: { type: "content_block_stop", index: 0 } },
					{ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } } },
					{ type: "stream_event", event: { type: "message_stop" } },
				]) {
					if (closed) return;
					yield message;
				}
				const limits = [
					{ ms: ccCallLimitMs(serverConfig, env), text: `MCP server "custom-tools" tool "slow_tool" timed out` },
					{ ms: ccAutoBackgroundMs(env), text: `MCP tool "custom-tools/slow_tool" was moved to the background` },
				].filter((limit) => limit.ms > 0).sort((a, b) => a.ms - b.ms);
				let timer;
				const gaveUp = new Promise((resolve) => { timer = setTimeout(() => resolve({ gaveUp: limits[0].text }), limits[0].ms); });
				const call = client.callTool({ name: "slow_tool", arguments: {} });
				const outcome = await Promise.race([call.then((result) => ({ result })), gaveUp]);
				clearTimeout(timer);
				if (closed) return;
				if (outcome.gaveUp) {
					// CC answers the call itself; the model ends the turn and the SDK
					// closes the query on its result (string prompt: first result ends input).
					observed.ccGaveUp = outcome.gaveUp;
					yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call-1", content: outcome.gaveUp, is_error: true }] } };
					for (const message of textTurn("m2", `FAILED ${outcome.gaveUp}`)) yield message;
					yield { type: "result", subtype: "success", session_id: "slow-tool-session" };
					return;
				}
				const text = outcome.result.content.map((block) => block.text).join("");
				yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call-1", content: outcome.result.content }] } };
				for (const message of textTurn("m2", text)) yield message;
				yield { type: "result", subtype: "success", session_id: "slow-tool-session" };
			},
			close() { closed = true; },
			async interrupt() { closed = true; },
		};
	});
}

async function collect(stream) {
	const events = [];
	for await (const event of stream) events.push(event);
	return events;
}

function replyText(events) {
	return events.filter((event) => event.type === "text_delta").map((event) => event.delta).join("");
}

/** One Pi tool turn: Claude calls slow_tool, Pi runs it for PI_TOOL_MS, then
 *  hands the result back. Returns the text Pi shows for the follow-up turn. */
async function runSlowToolTurn(sessionId) {
	const initial = {
		messages: [
			{ role: "system", content: "test system prompt", toolsAdded: [SLOW], timestamp: 0 },
			{ role: "user", content: "call slow_tool and report its output", timestamp: Date.now() },
		],
	};
	const first = await collect(streamClaudeAgentSdk(model, initial, { sessionId }));
	const done = first.find((event) => event.type === "done");
	assert.equal(done?.reason, "toolUse");
	await new Promise((resolve) => setTimeout(resolve, PI_TOOL_MS));
	const withResult = {
		messages: [
			...initial.messages,
			done.message,
			{ role: "toolResult", toolCallId: "call-1", toolName: SLOW.name, content: [{ type: "text", text: PI_RESULT }], isError: false, timestamp: Date.now() },
		],
	};
	return replyText(await collect(streamClaudeAgentSdk(model, withResult, { sessionId })));
}

const ENV_KEYS = ["MCP_TOOL_TIMEOUT", "CLAUDE_AUTO_BACKGROUND_TASKS", "CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS"];
const savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
let diagDir;

beforeEach(() => {
	for (const key of ENV_KEYS) delete process.env[key];
	process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT = "0";
	process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token";
	diagDir = mkdtempSync(join(tmpdir(), "bridge-diag-"));
	process.env.CLAUDE_BRIDGE_DIAG_PATH = join(diagDir, "diag.log");
	resetStack();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: { notify: () => {} } });
	setExtensionApi({ events: { emit: () => {} }, appendEntry: () => {} });
});

afterEach(() => {
	for (const [key, value] of savedEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	delete process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT;
	delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
	delete process.env.CLAUDE_BRIDGE_DIAG_PATH;
	rmSync(diagDir, { recursive: true, force: true });
	__testSetSdkQueryFactory();
	setExtensionApi(undefined);
	resetStack();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
});

describe("Claude Code waits for a Pi tool call however long Pi takes", () => {
	it("an inherited MCP_TOOL_TIMEOUT does not cut the call short", async () => {
		process.env.MCP_TOOL_TIMEOUT = "1000";
		const observed = {};
		installFakeClaudeCode(observed);
		const text = await runSlowToolTurn("pi-tool-limit-timeout");
		assert.equal(observed.ccGaveUp, undefined, `Claude Code gave up on the call: ${observed.ccGaveUp}`);
		assert.equal(text, PI_RESULT);
	});

	it("inherited MCP auto-backgrounding does not answer the call with a placeholder", async () => {
		process.env.CLAUDE_AUTO_BACKGROUND_TASKS = "1";
		process.env.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS = "1000";
		const observed = {};
		installFakeClaudeCode(observed);
		const text = await runSlowToolTurn("pi-tool-limit-autobackground");
		assert.equal(observed.ccGaveUp, undefined, `Claude Code gave up on the call: ${observed.ccGaveUp}`);
		assert.equal(text, PI_RESULT);
	});
});

const QUICK = { name: "quick_tool", description: "Returns at once", parameters: Type.Object({}) };

/** Fake CC that gives up on call-1 regardless of limits (a give-up path the
 *  bridge cannot configure away), then — like the live 23:32Z session — issues
 *  a follow-up call-2 while Pi is still running call-1. */
function installGiveUpAnywayClaudeCode(observed) {
	__testSetSdkQueryFactory(({ options }) => {
		let closed = false;
		return {
			async *[Symbol.asyncIterator]() {
				const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
				await options.mcpServers["custom-tools"].instance.connect(serverTransport);
				const client = new Client({ name: "fake-claude-code", version: "1.0.0" });
				await client.connect(clientTransport);
				const toolUse = (messageId, id, name) => [
					{ type: "stream_event", event: { type: "message_start", message: { id: messageId, model: model.id, usage: { input_tokens: 1 } } } },
					{ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name: `mcp__custom-tools__${name}`, input: {} } } },
					{ type: "stream_event", event: { type: "content_block_stop", index: 0 } },
					{ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } } },
					{ type: "stream_event", event: { type: "message_stop" } },
				];
				yield { type: "system", subtype: "init", session_id: "give-up-session" };
				for (const message of toolUse("m1", "call-1", SLOW.name)) {
					if (closed) return;
					yield message;
				}
				// The abandoned call's MCP answer arrives later and is discarded, as CC does.
				// Short request timeouts: a failing run must end, not wait out the MCP
				// client's 60 s default with these calls still pending.
				observed.firstCall = client.callTool({ name: SLOW.name, arguments: {} }, undefined, { timeout: 5_000 }).catch(() => undefined);
				await observed.giveUpGate;
				if (closed) return;
				const gaveUp = `MCP server "custom-tools" tool "${SLOW.name}" timed out after 1s`;
				yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call-1", content: gaveUp, is_error: true }] } };
				// Real CC yields the completed assistant message alongside the partials.
				yield { type: "assistant", message: { id: "m2", model: model.id, role: "assistant", content: [{ type: "tool_use", id: "call-2", name: `mcp__custom-tools__${QUICK.name}`, input: {} }] } };
				for (const message of toolUse("m2", "call-2", QUICK.name)) {
					if (closed) return;
					yield message;
				}
				const second = await client.callTool({ name: QUICK.name, arguments: {} }, undefined, { timeout: 5_000 });
				observed.secondResult = second;
				if (closed) return;
				yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call-2", content: second.content, is_error: second.isError === true }] } };
				for (const message of textTurn("m3", "follow-up failed")) yield message;
				yield { type: "result", subtype: "success", session_id: "give-up-session" };
			},
			close() { closed = true; },
			async interrupt() { closed = true; },
		};
	});
}

describe("if Claude Code gives up on a Pi tool call anyway", () => {
	it("tells the user, and a follow-up call issued while Pi is busy fails explicitly", () => withAgentNotices(async () => {
		const notices = [];
		const entries = [];
		__testSetBridgeIntegrityState({ ui: { notify: (message) => notices.push(message) } });
		setExtensionApi({ events: { emit: () => {} }, appendEntry: (_type, data) => entries.push(data) });
		let giveUp;
		const observed = { giveUpGate: new Promise((resolve) => { giveUp = resolve; }) };
		installGiveUpAnywayClaudeCode(observed);
		const sessionId = "pi-tool-limit-give-up";
		const initial = {
			messages: [
				{ role: "system", content: "test system prompt", toolsAdded: [SLOW, QUICK], timestamp: 0 },
				{ role: "user", content: "call slow_tool", timestamp: Date.now() },
			],
		};
		const first = await collect(streamClaudeAgentSdk(model, initial, { sessionId }));
		const done = first.find((event) => event.type === "done");
		assert.equal(done?.reason, "toolUse");
		// Pi is running slow_tool; Claude Code gives up and moves on to call-2.
		giveUp();
		const deadline = Date.now() + 2_000;
		while (!notices.some((notice) => notice.includes("stopped waiting")) && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		const giveUpNotice = notices.find((notice) => notice.includes("stopped waiting"));
		assert.ok(giveUpNotice, `no notice that Claude Code gave up: ${JSON.stringify(notices)}`);
		assert.match(giveUpNotice, /slow_tool/);
		assert.match(giveUpNotice, /timed out after 1s/);
		assert.match(giveUpNotice, /Claude will not see that call's result/);

		// Pi finishes slow_tool and hands the (now late) result back.
		const withResult = {
			messages: [
				...initial.messages,
				done.message,
				{ role: "toolResult", toolCallId: "call-1", toolName: SLOW.name, content: [{ type: "text", text: PI_RESULT }], isError: false, timestamp: Date.now() },
			],
		};
		const second = await collect(streamClaudeAgentSdk(model, withResult, { sessionId }));
		assert.equal(second.at(-1)?.type, "done", "the follow-up turn ends");
		assert.ok(entries.some((entry) => entry.label === "late_tool_result_after_claude_gave_up" && entry.id === "call-1"), `late result not recorded: ${JSON.stringify(entries)}`);
		// The follow-up call never reached Pi: the model gets an explicit, retryable error.
		assert.equal(observed.secondResult?.isError, true);
		assert.match(observed.secondResult.content[0].text, /never forwarded to Pi/);
		assert.ok(!notices.some((notice) => /never reached Pi/.test(notice)), `no TUI warning for the stranded call: ${JSON.stringify(notices)}`);
		assert.ok(takeAgentNotice(sessionId)?.message.details.kinds.includes("tool_handlers_stranded"), "the agent notice tells the agent");
	}));
});
