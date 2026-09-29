/**
 * When a streamed API response stalls, Claude Code abandons it and asks again:
 * without streaming ("Error streaming, falling back to non-streaming mode"),
 * whose answer arrives as ONE completed assistant message under a new message
 * id with no stream events and no message_stop, or as a new stream (a second
 * message_start). The abandoned attempt may already have streamed partial
 * thinking, text or tool-call JSON into the Pi message.
 *
 * Before the fix the bridge kept the abandoned attempt and ignored the
 * replacement's text and thinking: Pi's answer was the truncated partial text
 * with unsigned thinking, a partial tool call shipped in a stop message
 * (Pi executes it with truncated arguments), and a retried stream's deltas
 * landed in the abandoned attempt's blocks.
 *
 * Adapted from elidickinson/pi-claude-bridge PR 120
 * (5919fffa05f7dc5a2574ac44c7861c3f8938f827) to this fork's provider path.
 */
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
import { resetStack } from "../src/query-state.ts";
import { consumeLikePi, encodeLikePi } from "./lib/pi-frame-consumer.mjs";

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
const BASH = { name: "bash", description: "Runs a command", parameters: Type.Object({ command: Type.String() }) };
const se = (event) => ({ type: "stream_event", event });

/** Streamed attempt A got as far as partial thinking and text (and, with
 *  `toolJson`, the start of a tool call's arguments), then stalled: no
 *  content_block_stop, no message_stop. */
const stalledAttempt = ({ toolJson }) => [
	se({ type: "message_start", message: { id: "msg_A", model: model.id, usage: { input_tokens: 100, output_tokens: 1 } } }),
	se({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
	se({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me look" } }),
	se({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
	se({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Readi" } }),
	...(toolJson ? [
		se({ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_dead", name: "mcp__custom-tools__bash", input: {} } }),
		se({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"comm' } }),
	] : []),
];

/** Claude Code's non-streamed retry B: complete blocks under a new id. */
const replacement = ({ tool }) => ({
	type: "assistant",
	message: {
		id: "msg_B",
		model: model.id,
		usage: { input_tokens: 100, output_tokens: 50 },
		content: [
			{ type: "thinking", thinking: "Let me look at both.", signature: "sig" },
			{ type: "text", text: "Reading the log." },
			...(tool ? [{ type: "tool_use", id: "toolu_b", name: "mcp__custom-tools__bash", input: { command: "ls" } }] : []),
		],
	},
});

/** A retried STREAM A' that completes with one tool call. */
const restreamedAttempt = [
	se({ type: "message_start", message: { id: "msg_A2", model: model.id, usage: { input_tokens: 100, output_tokens: 1 } } }),
	se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
	se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Checking." } }),
	se({ type: "content_block_stop", index: 0 }),
	se({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_b", name: "mcp__custom-tools__bash", input: {} } }),
	se({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' } }),
	{ type: "assistant", message: { id: "msg_A2", model: model.id, usage: { input_tokens: 100, output_tokens: 1 }, content: [{ type: "tool_use", id: "toolu_b", name: "mcp__custom-tools__bash", input: { command: "ls" } }] } },
	se({ type: "content_block_stop", index: 1 }),
	se({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 40 } }),
	se({ type: "message_stop" }),
];

/** Fake Claude Code: yields `first`, then — when `callsTool` — calls bash
 *  through the bridge's MCP server as CC would, and closes with a short
 *  streamed answer. */
function installFakeClaudeCode(observed, first, { callsTool, finalResult }) {
	__testSetSdkQueryFactory(({ options }) => {
		let closed = false;
		return {
			async *[Symbol.asyncIterator]() {
				const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
				await options.mcpServers["custom-tools"].instance.connect(serverTransport);
				const client = new Client({ name: "fake-claude-code", version: "1.0.0" });
				await client.connect(clientTransport);
				yield { type: "system", subtype: "init", session_id: "fallback-session" };
				for (const message of first) {
					if (closed) return;
					yield message;
				}
				if (!callsTool) {
					yield { type: "result", subtype: "success", session_id: "fallback-session", result: finalResult };
					return;
				}
				const result = await client.callTool({ name: "bash", arguments: { command: "ls" }, _meta: { "claudecode/toolUseId": "toolu_b" } });
				observed.calls.push(result);
				if (closed) return;
				yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_b", content: result.content }] } };
				yield se({ type: "message_start", message: { id: "msg_C", model: model.id, usage: { input_tokens: 1 } } });
				yield se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
				yield se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } });
				yield se({ type: "content_block_stop", index: 0 });
				yield se({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } });
				yield se({ type: "message_stop" });
				yield { type: "result", subtype: "success", session_id: "fallback-session", result: "done" };
			},
			close() { closed = true; },
			async interrupt() { closed = true; },
		};
	});
}

/** Whether `items` appear in `within` in order (JSON equality). */
function isSubsequence(items, within) {
	let at = 0;
	for (const item of within) if (at < items.length && JSON.stringify(item) === JSON.stringify(items[at])) at++;
	return at === items.length;
}

/** Runs one provider call through Pi's real consumers (see
 *  lib/pi-frame-consumer.mjs): encoding every event both as consumed and at
 *  maximum lag must succeed, and the reduced snapshot must contain the blocks
 *  Pi persists, in order (abandoned or pruned blocks may sit between them). */
async function runLikePi(context, sessionId) {
	const run = await consumeLikePi(streamClaudeAgentSdk(model, context, { sessionId }));
	const done = run.events.at(-1);
	assert.equal(run.final, done.message, "Pi persists the done message");
	for (const snapshot of [run.eagerSnapshot, run.laggedSnapshot]) {
		assert.ok(isSubsequence(summarize(done.message.content), summarize(snapshot.content)), "Pi's frames carry every persisted block, in order");
	}
	return { ...run, done };
}

const summarize = (content) => content.map((block) => block.type === "text" ? ["text", block.text]
	: block.type === "thinking" ? ["thinking", block.thinking]
		: ["toolCall", block.id, block.arguments]);

const initial = () => ({
	messages: [
		{ role: "system", content: "test system prompt", toolsAdded: [BASH], timestamp: 0 },
		{ role: "user", content: "read the log", timestamp: Date.now() },
	],
});

let integrity;
let diagDir;
let hold;
beforeEach(() => {
	// The bridge unrefs its timers; keep the loop alive across the grace end.
	hold = setInterval(() => {}, 1000);
	process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT = "0";
	process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token";
	diagDir = mkdtempSync(join(tmpdir(), "bridge-diag-"));
	process.env.CLAUDE_BRIDGE_DIAG_PATH = join(diagDir, "diag.log");
	integrity = [];
	resetStack();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: { notify: () => {} } });
	setExtensionApi({ events: { emit: () => {} }, appendEntry: (_type, data) => integrity.push(data) });
});

afterEach(() => {
	clearInterval(hold);
	delete process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT;
	delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
	delete process.env.CLAUDE_BRIDGE_DIAG_PATH;
	rmSync(diagDir, { recursive: true, force: true });
	__testSetSdkQueryFactory();
	setExtensionApi(undefined);
	resetStack();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
});

describe("Claude Code's retry after a stalled stream", () => {
	it("renders the non-streamed replacement and dispatches its tool call once, complete", async () => {
		const observed = { calls: [] };
		installFakeClaudeCode(observed, [...stalledAttempt({ toolJson: true }), replacement({ tool: true })], { callsTool: true });
		const context = initial();
		const { done, eagerSnapshot } = await runLikePi(context, "fallback-tool");
		assert.equal(done.type, "done");
		assert.equal(done.reason, "toolUse");
		const expected = [
			["thinking", "Let me look at both."],
			["text", "Reading the log."],
			["toolCall", "toolu_b", { command: "ls", timeout: 120 }],
		];
		assert.deepEqual(summarize(done.message.content), expected, "only the replacement's complete blocks");
		assert.equal(done.message.content[0].thinkingSignature, "sig");
		assert.ok(done.message.content.every((block) => !("partialJson" in block) && !("index" in block)), "no stream bookkeeping leaks into Pi's message");
		assert.deepEqual(summarize(eagerSnapshot.content.slice(0, 2)), [["thinking", "Let me look"], ["text", "Readi"]], "the abandoned attempt's frames stay where Pi saw them");
		assert.equal(done.message.usage.input, 100, "the abandoned attempt's input is not counted twice");
		assert.equal(done.message.usage.output, 50);

		const second = await runLikePi({
			messages: [
				...context.messages,
				done.message,
				{ role: "toolResult", toolCallId: "toolu_b", toolName: "bash", content: [{ type: "text", text: "OUT" }], isError: false, timestamp: Date.now() },
			],
		}, "fallback-tool");
		assert.equal(second.done.type, "done");
		assert.deepEqual(summarize(second.done.message.content), [["text", "done"]]);
		assert.equal(observed.calls.length, 1, "the replacement's call is dispatched exactly once");
		assert.deepEqual(observed.calls[0].content, [{ type: "text", text: "OUT" }], "Claude Code receives Pi's real result");
		assert.deepEqual(integrity, [], "a recovered retry records no integrity entry");
	});

	it("answers with the replacement's text, not the abandoned partial text", async () => {
		installFakeClaudeCode({ calls: [] }, [...stalledAttempt({ toolJson: false }), replacement({ tool: false })], { callsTool: false, finalResult: "Reading the log." });
		const { done } = await runLikePi(initial(), "fallback-text");
		assert.equal(done.type, "done");
		assert.equal(done.reason, "stop");
		assert.deepEqual(summarize(done.message.content), [["thinking", "Let me look at both."], ["text", "Reading the log."]]);
		assert.equal(done.message.content[0].thinkingSignature, "sig");
	});

	it("never ships the abandoned attempt's partial tool call when the replacement has none", async () => {
		installFakeClaudeCode({ calls: [] }, [...stalledAttempt({ toolJson: true }), replacement({ tool: false })], { callsTool: false, finalResult: "Reading the log." });
		const { done } = await runLikePi(initial(), "fallback-no-tool");
		assert.equal(done.type, "done");
		assert.ok(!done.message.content.some((block) => block.type === "toolCall"), "Pi must have no call to execute");
		assert.deepEqual(summarize(done.message.content), [["thinking", "Let me look at both."], ["text", "Reading the log."]]);
		assert.deepEqual(integrity, [], "an abandoned attempt is not a pruned truncation");
	});

	it("renders only the retried stream when Claude Code restreams", async () => {
		const observed = { calls: [] };
		installFakeClaudeCode(observed, [...stalledAttempt({ toolJson: true }), ...restreamedAttempt], { callsTool: true });
		const context = initial();
		const { done } = await runLikePi(context, "fallback-restream");
		assert.equal(done.type, "done");
		assert.equal(done.reason, "toolUse");
		assert.deepEqual(summarize(done.message.content), [["text", "Checking."], ["toolCall", "toolu_b", { command: "ls", timeout: 120 }]], "only the retried stream's blocks");
		assert.equal(done.message.usage.input, 100, "the abandoned attempt's input is not counted twice");
		assert.equal(done.message.usage.output, 40, "message_delta usage of the retry");

		await runLikePi({
			messages: [
				...context.messages,
				done.message,
				{ role: "toolResult", toolCallId: "toolu_b", toolName: "bash", content: [{ type: "text", text: "OUT" }], isError: false, timestamp: Date.now() },
			],
		}, "fallback-restream");
		assert.equal(observed.calls.length, 1);
		assert.deepEqual(integrity, []);
	});

	it("still ignores the completed copy of a message that streamed normally", async () => {
		installFakeClaudeCode({ calls: [] }, [
			se({ type: "message_start", message: { id: "msg_1", model: model.id, usage: { input_tokens: 5 } } }),
			se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
			se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }),
			{ type: "assistant", message: { id: "msg_1", model: model.id, content: [{ type: "text", text: "hi" }] } },
			se({ type: "content_block_stop", index: 0 }),
			se({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }),
			se({ type: "message_stop" }),
		], { callsTool: false, finalResult: "hi" });
		const { done } = await runLikePi(initial(), "fallback-normal");
		assert.deepEqual(summarize(done.message.content), [["text", "hi"]]);
	});
});

describe("Claude Code finalizing a partial response", () => {
	it("never ends a turn with a truncated tool call", async () => {
		// Once a block has completed, Claude Code does not retry a stalled
		// stream: it keeps what completed and ends the response ("The response
		// above may be incomplete"). A tool call still streaming at that point
		// never gets its stop, and Pi executes every tool call in a stop message.
		installFakeClaudeCode({ calls: [] }, [
			se({ type: "message_start", message: { id: "msg_A", model: model.id, usage: { input_tokens: 100 } } }),
			se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
			se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Checking." } }),
			{ type: "assistant", message: { id: "msg_A", model: model.id, content: [{ type: "text", text: "Checking." }] } },
			se({ type: "content_block_stop", index: 0 }),
			se({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_cut", name: "mcp__custom-tools__bash", input: {} } }),
			se({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"command":"rm -rf /tmp/scratch/' } }),
		], { callsTool: false, finalResult: "Checking." });
		const { done } = await runLikePi(initial(), "finalize-partial");
		assert.equal(done.type, "done");
		assert.deepEqual(summarize(done.message.content), [["text", "Checking."]], "the truncated call must not reach Pi");
		assert.deepEqual(integrity.map((entry) => entry.label), ["partial_tool_calls_pruned"], "and no delivery mismatch for a call that was never issued");
		assert.deepEqual(integrity[0].calls, [{ id: "toolu_cut", name: "bash" }]);
	});
});

describe("discarding an abandoned attempt", () => {
	it("drops a tool call the abandoned attempt completed when its handler never ran", async () => {
		// Claude Code retries after a tool call completed too, and never starts
		// a queued call of the attempt it discards.
		const { processAssistantMessage, processStreamEvent } = await import("../src/index.ts");
		const { ctx } = await import("../src/query-state.ts");
		const toolMap = new Map([["mcp__custom-tools__bash", "bash"]]);
		const c = ctx();
		c.resetTurnState(model);
		const events = [];
		c.currentPiStream = { push: (event) => events.push(event), end: () => events.push({ type: "stream_end" }) };
		for (const message of [
			se({ type: "message_start", message: { id: "msg_A", usage: { input_tokens: 100 } } }),
			se({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_done", name: "mcp__custom-tools__bash", input: {} } }),
			se({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command":"pwd"}' } }),
			se({ type: "content_block_stop", index: 0 }),
			se({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_cut", name: "mcp__custom-tools__bash", input: {} } }),
			se({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"comm' } }),
		]) processStreamEvent(message, toolMap, model, c);
		processAssistantMessage(replacement({ tool: true }), model, toolMap, c);

		const { endToolUseTurn } = await import("../src/assistant-stream.ts");
		endToolUseTurn(c);
		const done = events.find((event) => event.type === "done");
		assert.deepEqual(summarize(done.message.content), [
			["thinking", "Let me look at both."],
			["text", "Reading the log."],
			["toolCall", "toolu_b", { command: "ls", timeout: 120 }],
		]);
		assert.ok(c.deadToolCallIds.has("toolu_cut"), "the partial call can never be forwarded later");
		assert.ok(c.deadToolCallIds.has("toolu_done"), "nor the completed one");
		assert.ok(!c.forwardedToolCallIds.has("toolu_cut"), "and is never forwarded");
		assert.ok(!c.forwardedToolCallIds.has("toolu_done") && c.forwardedToolCallIds.has("toolu_b"));
		assert.deepEqual(c.turnToolCallIds, ["toolu_b"], "no dropped call is expected to produce a result");
		assert.deepEqual(integrity, []);
		const { snapshot } = encodeLikePi(events.filter((event) => event.type !== "stream_end"));
		assert.deepEqual(snapshot.content.map((block) => block.id ?? block.type), ["toolu_done", "toolu_cut", "thinking", "text", "toolu_b"], "Pi's frames stay append-only");
		c.currentPiStream = null;
	});
});
