// A stream cut off mid-block ends without that block's content_block_stop:
// message_start, the tool_use's start and part of its arguments, then
// message_delta and message_stop. Claude Code drops the half-built call and
// issues it again under a new id in a new message. Pi's turn must stay open for
// that call: ended at the cut message's message_stop it held no tool call, Pi's
// agent loop stopped the run, and the re-issued call's handler was then failed
// as stranded.
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
import { __testSetSdkSettleGraceMs } from "../src/query-teardown.ts";

const model = {
	id: "claude-haiku-4-5",
	name: "Claude Haiku",
	api: "claude-bridge",
	provider: "pi-claude",
	baseUrl: "claude-bridge",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8192,
};

const ECHO = { name: "echo", description: "Echoes text", parameters: Type.Object({ text: Type.String() }) };
const ARGS = { text: "same" };
const SESSION = "cut-tool-call-session";
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const forever = () => new Promise(() => {});

async function collect(stream) {
	const events = [];
	for await (const event of stream) events.push(event);
	return events;
}

const streamEvent = (event) => ({ type: "stream_event", event });
const messageStart = (id) => streamEvent({ type: "message_start", message: { id, model: model.id, usage: { input_tokens: 1 } } });
const toolStart = (index, id) => streamEvent({ type: "content_block_start", index, content_block: { type: "tool_use", id, name: "mcp__custom-tools__echo", input: {} } });
const jsonDelta = (index, partial_json) => streamEvent({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json } });
const blockStop = (index) => streamEvent({ type: "content_block_stop", index });
const messageEnd = () => [
	streamEvent({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } }),
	streamEvent({ type: "message_stop" }),
];
const assistantCopy = (messageId, id) => ({
	type: "assistant",
	message: { id: messageId, model: model.id, content: [{ type: "tool_use", id, name: "mcp__custom-tools__echo", input: ARGS }] },
});

/** A message whose only call is cut off: no content_block_stop. */
function cutMessage(messageId, id) {
	return [messageStart(messageId), toolStart(0, id), jsonDelta(0, '{"text":"sa'), ...messageEnd()];
}

const FINAL_REPLY = [
	messageStart("m-final"),
	streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
	streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } }),
	blockStop(0),
	streamEvent({ type: "message_stop" }),
	{ type: "result", subtype: "success", session_id: SESSION },
];

/** Fake Claude Code with a real MCP client on the bridge's server. */
function installFakeClaudeCode(observed, script) {
	__testSetSdkQueryFactory(({ options }) => {
		let closed = false;
		return {
			async *[Symbol.asyncIterator]() {
				const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
				await options.mcpServers["custom-tools"].instance.connect(serverTransport);
				const client = new Client({ name: "fake-claude-code", version: "1.0.0" });
				await client.connect(clientTransport);
				yield { type: "system", subtype: "init", session_id: SESSION };
				for await (const message of script(client, observed)) {
					if (closed) return;
					yield message;
				}
			},
			close() { closed = true; },
			async interrupt() { closed = true; },
		};
	});
}

function initialContext() {
	return {
		messages: [
			{ role: "system", content: "test system prompt", toolsAdded: [ECHO], timestamp: 0 },
			{ role: "user", content: "echo it", timestamp: Date.now() },
		],
	};
}

const toolCallIds = (message) => message.content.filter((block) => block.type === "toolCall").map((call) => call.id);
const tagged = (id) => ({ _meta: { "claudecode/toolUseId": id } });

let diagDir;
let integrity;
beforeEach(() => {
	process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT = "0";
	process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token";
	diagDir = mkdtempSync(join(tmpdir(), "bridge-diag-"));
	process.env.CLAUDE_BRIDGE_DIAG_PATH = join(diagDir, "diag.log");
	resetStack();
	integrity = [];
	__testSetBridgeIntegrityState({ sharedSession: null, ui: { notify: () => {} } });
	setExtensionApi({ events: { emit: () => {} }, appendEntry: (_type, data) => integrity.push(data) });
});

afterEach(() => {
	delete process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT;
	delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
	delete process.env.CLAUDE_BRIDGE_DIAG_PATH;
	rmSync(diagDir, { recursive: true, force: true });
	__testSetSdkQueryFactory();
	__testSetSdkSettleGraceMs();
	setExtensionApi(undefined);
	resetStack();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
});

describe("a tool call cut off before its content_block_stop", () => {
	it("keeps Pi's turn open for the call Claude Code issues again, and answers that call", async () => {
		const observed = {};
		installFakeClaudeCode(observed, async function* (client) {
			yield* cutMessage("m1", "toolu_cut");
			yield messageStart("m2");
			yield toolStart(0, "toolu_again");
			yield jsonDelta(0, JSON.stringify(ARGS));
			yield assistantCopy("m2", "toolu_again");
			yield blockStop(0);
			observed.call = client.callTool({ name: "echo", arguments: ARGS, ...tagged("toolu_again") });
			await settle(20);
			yield* messageEnd();
			const result = await observed.call;
			yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_again", content: result.content }] } };
			yield* FINAL_REPLY;
		});
		const initial = initialContext();
		const first = await collect(streamClaudeAgentSdk(model, initial, { sessionId: "cut-reissued" }));
		const done = first.filter((event) => event.type === "done");
		assert.equal(done.length, 1, "one Pi turn for the cut message and the re-issued one");
		assert.equal(done[0].reason, "toolUse");
		assert.deepEqual(toolCallIds(done[0].message), ["toolu_again"], "Pi gets only the re-issued call");

		const second = collect(streamClaudeAgentSdk(model, {
			messages: [...initial.messages, done[0].message, {
				role: "toolResult", toolCallId: "toolu_again", toolName: ECHO.name, content: [{ type: "text", text: "REAL OUTPUT" }], isError: false, timestamp: Date.now(),
			}],
		}, { sessionId: "cut-reissued" }));
		const result = await observed.call;
		assert.notEqual(result.isError, true, "the re-issued call's handler is not failed as stranded");
		assert.deepEqual(result.content, [{ type: "text", text: "REAL OUTPUT" }]);
		await second;
		assert.deepEqual(integrity.map((entry) => entry.label), ["partial_tool_calls_pruned"]);
		assert.deepEqual(integrity[0].calls, [{ id: "toolu_cut", name: "echo" }]);
	});

	it("keeps the grace timer the re-issued call's early handler armed, for a stream that never shows that call", { timeout: 5000 }, async () => {
		const observed = {};
		const keepAlive = setInterval(() => {}, 1000);
		try {
			installFakeClaudeCode(observed, async function* (client) {
				// Claude Code runs a tools/call at once while stream events wait in
				// the bridge's queue, so the handler can run before the cut is seen.
				observed.call = client.callTool({ name: "echo", arguments: ARGS, ...tagged("toolu_again") });
				await settle(20);
				yield* cutMessage("m1", "toolu_cut");
				const result = await observed.call;
				yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_again", content: result.content }] } };
				yield* FINAL_REPLY;
			});
			const initial = initialContext();
			const first = await collect(streamClaudeAgentSdk(model, initial, { sessionId: "cut-early-handler" }));
			const done = first.filter((event) => event.type === "done");
			assert.equal(done.length, 1);
			assert.deepEqual(toolCallIds(done[0].message), ["toolu_again"]);

			const second = collect(streamClaudeAgentSdk(model, {
				messages: [...initial.messages, done[0].message, {
					role: "toolResult", toolCallId: "toolu_again", toolName: ECHO.name, content: [{ type: "text", text: "REAL OUTPUT" }], isError: false, timestamp: Date.now(),
				}],
			}, { sessionId: "cut-early-handler" }));
			assert.deepEqual((await observed.call).content, [{ type: "text", text: "REAL OUTPUT" }]);
			await second;
		} finally {
			clearInterval(keepAlive);
		}
	});

	it("still ends the turn when Claude Code ends the query without issuing the call again", async () => {
		installFakeClaudeCode({}, async function* () {
			yield* cutMessage("m1", "toolu_cut");
			yield { type: "result", subtype: "success", session_id: SESSION };
		});
		const events = await collect(streamClaudeAgentSdk(model, initialContext(), { sessionId: "cut-result" }));
		const done = events.filter((event) => event.type === "done");
		assert.equal(done.length, 1);
		assert.equal(done[0].reason, "stop");
		assert.deepEqual(toolCallIds(done[0].message), [], "the cut call never ships");
		assert.equal(done[0].message.stopReason, "stop");
	});

	it("still ends the turn through the idle watchdog when Claude Code goes silent after the cut", { timeout: 3000 }, async () => {
		process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT = "40ms";
		__testSetSdkSettleGraceMs(20);
		const keepAlive = setInterval(() => {}, 1000);
		try {
			installFakeClaudeCode({}, async function* () {
				yield* cutMessage("m1", "toolu_cut");
				await forever();
			});
			const events = await collect(streamClaudeAgentSdk(model, initialContext(), { sessionId: "cut-silent" }));
			assert.equal(events.filter((event) => event.type === "done").length, 0);
			assert.equal(events.at(-1)?.type, "error");
			assert.match(events.at(-1).error.errorMessage, /stream idle timeout/i);
			assert.deepEqual(toolCallIds(events.at(-1).error), [], "the cut call never ships");
		} finally {
			clearInterval(keepAlive);
		}
	});

	it("still ends the turn at message_stop with the closed call when only a sibling was cut", async () => {
		const observed = {};
		installFakeClaudeCode(observed, async function* (client) {
			yield messageStart("m1");
			yield toolStart(0, "toolu_closed");
			yield jsonDelta(0, JSON.stringify(ARGS));
			yield assistantCopy("m1", "toolu_closed");
			yield blockStop(0);
			observed.call = client.callTool({ name: "echo", arguments: ARGS, ...tagged("toolu_closed") });
			await settle(20);
			yield toolStart(1, "toolu_cut");
			yield jsonDelta(1, '{"text":"sa');
			yield* messageEnd();
			const result = await observed.call;
			yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_closed", content: result.content }] } };
			yield* FINAL_REPLY;
		});
		const initial = initialContext();
		const first = await collect(streamClaudeAgentSdk(model, initial, { sessionId: "cut-sibling" }));
		const done = first.filter((event) => event.type === "done");
		assert.equal(done.length, 1);
		assert.equal(done[0].reason, "toolUse");
		assert.deepEqual(toolCallIds(done[0].message), ["toolu_closed"], "only the closed call ships");
		assert.deepEqual(integrity.map((entry) => entry.label), ["partial_tool_calls_pruned"]);
		assert.deepEqual(integrity[0].calls, [{ id: "toolu_cut", name: "echo" }]);

		const second = collect(streamClaudeAgentSdk(model, {
			messages: [...initial.messages, done[0].message, {
				role: "toolResult", toolCallId: "toolu_closed", toolName: ECHO.name, content: [{ type: "text", text: "REAL OUTPUT" }], isError: false, timestamp: Date.now(),
			}],
		}, { sessionId: "cut-sibling" }));
		assert.deepEqual((await observed.call).content, [{ type: "text", text: "REAL OUTPUT" }]);
		await second;
	});
});
