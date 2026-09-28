// Claude Code tags every tools/call with its tool_use id. The bridge's MCP
// handler must claim exactly that call, even when the handler runs before the
// stream consumer has recorded the tool_use: Claude Code runs control requests
// at once while SDK messages wait in the bridge's queue.
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
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function collect(stream) {
	const events = [];
	for await (const event of stream) events.push(event);
	return events;
}

const tagged = (id) => ({ _meta: { "claudecode/toolUseId": id } });

function toolUseMessage(messageId, ids) {
	return [
		{ type: "stream_event", event: { type: "message_start", message: { id: messageId, model: model.id, usage: { input_tokens: 1 } } } },
		...ids.flatMap((id, index) => [
			{ type: "stream_event", event: { type: "content_block_start", index, content_block: { type: "tool_use", id, name: "mcp__custom-tools__echo", input: {} } } },
			{ type: "stream_event", event: { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(ARGS) } } },
			{ type: "stream_event", event: { type: "content_block_stop", index } },
		]),
		{ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } } },
		{ type: "stream_event", event: { type: "message_stop" } },
	];
}

const FINAL_REPLY = [
	{ type: "stream_event", event: { type: "message_start", message: { id: "m-final", model: model.id, usage: { input_tokens: 1 } } } },
	{ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
	{ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } } },
	{ type: "stream_event", event: { type: "content_block_stop", index: 0 } },
	{ type: "stream_event", event: { type: "message_stop" } },
	{ type: "result", subtype: "success", session_id: "claim-by-id-session" },
];

/** Fake Claude Code with a real MCP client on the bridge's server. `script`
 *  drives the calls and yields the SDK messages; it gets the client and
 *  `observed`. */
function installFakeClaudeCode(observed, script) {
	__testSetSdkQueryFactory(({ options }) => {
		let closed = false;
		return {
			async *[Symbol.asyncIterator]() {
				const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
				await options.mcpServers["custom-tools"].instance.connect(serverTransport);
				const client = new Client({ name: "fake-claude-code", version: "1.0.0" });
				await client.connect(clientTransport);
				yield { type: "system", subtype: "init", session_id: "claim-by-id-session" };
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
			{ role: "user", content: "echo twice", timestamp: Date.now() },
		],
	};
}

function resultMessage(id, text) {
	return { role: "toolResult", toolCallId: id, toolName: ECHO.name, content: [{ type: "text", text }], isError: false, timestamp: Date.now() };
}

function toolCallIds(done) {
	return done.message.content.filter((block) => block.type === "toolCall").map((call) => call.id);
}

let diagDir;
beforeEach(() => {
	process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT = "0";
	process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token";
	diagDir = mkdtempSync(join(tmpdir(), "bridge-diag-"));
	process.env.CLAUDE_BRIDGE_DIAG_PATH = join(diagDir, "diag.log");
	resetStack();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: { notify: () => {} } });
	setExtensionApi({ events: { emit: () => {} }, appendEntry: () => {} });
});

afterEach(() => {
	delete process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT;
	delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
	delete process.env.CLAUDE_BRIDGE_DIAG_PATH;
	rmSync(diagDir, { recursive: true, force: true });
	__testSetSdkQueryFactory();
	setExtensionApi(undefined);
	resetStack();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
});

describe("an MCP tool call is claimed by its tool_use id", () => {
	it("gets Pi's real result when its handler runs before the stream records the tool_use", async () => {
		const observed = {};
		installFakeClaudeCode(observed, async function* (client) {
			observed.call = client.callTool({ name: "echo", arguments: ARGS, ...tagged("toolu_early") });
			await settle(20); // the handler runs while the tool_use still waits in the SDK message queue
			yield* toolUseMessage("m1", ["toolu_early"]);
			const result = await observed.call;
			yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_early", content: result.content }] } };
			yield* FINAL_REPLY;
		});
		const initial = initialContext();
		const first = await collect(streamClaudeAgentSdk(model, initial, { sessionId: "claim-early" }));
		const done = first.find((event) => event.type === "done");
		assert.equal(done?.reason, "toolUse");
		const calls = done.message.content.filter((block) => block.type === "toolCall");
		assert.deepEqual(calls.map((call) => [call.id, call.arguments]), [["toolu_early", ARGS]], "Pi gets exactly one tool call");

		const second = collect(streamClaudeAgentSdk(model, {
			messages: [...initial.messages, done.message, resultMessage("toolu_early", "REAL OUTPUT")],
		}, { sessionId: "claim-early" }));
		const result = await observed.call;
		assert.deepEqual(result.content, [{ type: "text", text: "REAL OUTPUT" }], "Claude gets Pi's real result");
		assert.notEqual(result.isError, true);
		await second;
	});

	it("keeps same-name, same-argument siblings on their own ids when their handlers arrive in reverse order", async () => {
		let handlersIssued;
		const observed = { issued: new Promise((resolve) => { handlersIssued = resolve; }) };
		installFakeClaudeCode(observed, async function* (client) {
			yield* toolUseMessage("m1", ["toolu_a", "toolu_b"]);
			observed.callB = client.callTool({ name: "echo", arguments: ARGS, ...tagged("toolu_b") });
			await settle(10);
			observed.callA = client.callTool({ name: "echo", arguments: ARGS, ...tagged("toolu_a") });
			await settle(10);
			handlersIssued();
			const [a, b] = await Promise.all([observed.callA, observed.callB]);
			yield {
				type: "user",
				message: { content: [
					{ type: "tool_result", tool_use_id: "toolu_a", content: a.content },
					{ type: "tool_result", tool_use_id: "toolu_b", content: b.content },
				] },
			};
			yield* FINAL_REPLY;
		});
		const initial = initialContext();
		const first = await collect(streamClaudeAgentSdk(model, initial, { sessionId: "claim-siblings" }));
		const done = first.find((event) => event.type === "done");
		assert.equal(done?.reason, "toolUse");
		assert.deepEqual(done.message.content.filter((block) => block.type === "toolCall").map((call) => call.id), ["toolu_a", "toolu_b"]);
		await observed.issued;

		const second = collect(streamClaudeAgentSdk(model, {
			messages: [...initial.messages, done.message, resultMessage("toolu_a", "RESULT A"), resultMessage("toolu_b", "RESULT B")],
		}, { sessionId: "claim-siblings" }));
		assert.deepEqual((await observed.callA).content, [{ type: "text", text: "RESULT A" }]);
		assert.deepEqual((await observed.callB).content, [{ type: "text", text: "RESULT B" }]);
		await second;
	});

	it("keeps an early call's id from an untagged same-name sibling after message_start", async () => {
		let handlersIssued;
		const observed = { issued: new Promise((resolve) => { handlersIssued = resolve; }) };
		installFakeClaudeCode(observed, async function* (client) {
			observed.callA = client.callTool({ name: "echo", arguments: ARGS, ...tagged("toolu_a") });
			await settle(20);
			yield* toolUseMessage("m1", ["toolu_a", "toolu_b"]);
			observed.callB = client.callTool({ name: "echo", arguments: ARGS });
			await settle(10);
			handlersIssued();
			await Promise.all([observed.callA, observed.callB]);
			yield* FINAL_REPLY;
		});
		const initial = initialContext();
		const first = await collect(streamClaudeAgentSdk(model, initial, { sessionId: "claim-untagged-sibling" }));
		const done = first.find((event) => event.type === "done");
		assert.deepEqual(toolCallIds(done), ["toolu_a", "toolu_b"]);
		await observed.issued;

		const second = collect(streamClaudeAgentSdk(model, {
			messages: [...initial.messages, done.message, resultMessage("toolu_a", "RESULT A"), resultMessage("toolu_b", "RESULT B")],
		}, { sessionId: "claim-untagged-sibling" }));
		assert.deepEqual((await observed.callB).content, [{ type: "text", text: "RESULT B" }], "the untagged sibling gets its own result");
		assert.deepEqual((await observed.callA).content, [{ type: "text", text: "RESULT A" }], "the early call keeps its waiter");
		await second;
	});

	it("resolves an early call and its duplicate tools/call with the same result", async () => {
		let handlersIssued;
		const observed = { issued: new Promise((resolve) => { handlersIssued = resolve; }) };
		installFakeClaudeCode(observed, async function* (client) {
			observed.callA = client.callTool({ name: "echo", arguments: ARGS, ...tagged("toolu_a") });
			await settle(20);
			yield* toolUseMessage("m1", ["toolu_a", "toolu_b"]);
			observed.duplicateA = client.callTool({ name: "echo", arguments: ARGS, ...tagged("toolu_a") });
			await settle(10);
			observed.callB = client.callTool({ name: "echo", arguments: ARGS, ...tagged("toolu_b") });
			await settle(10);
			handlersIssued();
			await Promise.all([observed.callA, observed.duplicateA, observed.callB]);
			yield* FINAL_REPLY;
		});
		const initial = initialContext();
		const first = await collect(streamClaudeAgentSdk(model, initial, { sessionId: "claim-duplicate-waiting" }));
		const done = first.find((event) => event.type === "done");
		assert.deepEqual(toolCallIds(done), ["toolu_a", "toolu_b"]);
		await observed.issued;

		const second = collect(streamClaudeAgentSdk(model, {
			messages: [...initial.messages, done.message, resultMessage("toolu_a", "RESULT A"), resultMessage("toolu_b", "RESULT B")],
		}, { sessionId: "claim-duplicate-waiting" }));
		const settled = await Promise.race([
			Promise.all([observed.callA, observed.duplicateA, observed.callB]),
			settle(500).then(() => "timed out"),
		]);
		assert.notEqual(settled, "timed out", "every waiter must be answered");
		const [a, duplicateA, b] = settled;
		assert.deepEqual(a.content, [{ type: "text", text: "RESULT A" }]);
		assert.deepEqual(duplicateA.content, [{ type: "text", text: "RESULT A" }]);
		assert.deepEqual(b.content, [{ type: "text", text: "RESULT B" }]);
		await second;
	});

	it("answers a duplicate tools/call for an already answered id with an explicit error", async () => {
		const observed = {};
		installFakeClaudeCode(observed, async function* (client) {
			yield* toolUseMessage("m1", ["toolu_a"]);
			observed.callA = client.callTool({ name: "echo", arguments: ARGS, ...tagged("toolu_a") });
			await observed.callA;
			observed.duplicateA = client.callTool({ name: "echo", arguments: ARGS, ...tagged("toolu_a") });
			await observed.duplicateA;
			yield* FINAL_REPLY;
		});
		const initial = initialContext();
		const first = await collect(streamClaudeAgentSdk(model, initial, { sessionId: "claim-duplicate-answered" }));
		const done = first.find((event) => event.type === "done");
		assert.deepEqual(toolCallIds(done), ["toolu_a"]);

		const second = collect(streamClaudeAgentSdk(model, {
			messages: [...initial.messages, done.message, resultMessage("toolu_a", "RESULT A")],
		}, { sessionId: "claim-duplicate-answered" }));
		assert.deepEqual((await observed.callA).content, [{ type: "text", text: "RESULT A" }]);
		const duplicate = await observed.duplicateA;
		assert.equal(duplicate.isError, true);
		assert.match(duplicate.content[0].text, /toolu_a/);
		assert.match(duplicate.content[0].text, /already returned/);
		await second;
	});

	it("rejects a new tagged call under a withdrawn tool without taking another call's result", async () => {
		let openGate, freshIssued;
		const observed = {
			gate: new Promise((resolve) => { openGate = resolve; }),
			issued: new Promise((resolve) => { freshIssued = resolve; }),
		};
		installFakeClaudeCode(observed, async function* (client) {
			yield* toolUseMessage("m1", ["toolu_old"]);
			await observed.gate;
			observed.fresh = client.callTool({ name: "echo", arguments: ARGS, ...tagged("toolu_new") });
			freshIssued();
			await observed.fresh;
			observed.old = client.callTool({ name: "echo", arguments: ARGS, ...tagged("toolu_old") });
			await observed.old;
			yield* FINAL_REPLY;
		});
		const initial = initialContext();
		const first = await collect(streamClaudeAgentSdk(model, initial, { sessionId: "claim-withdrawn" }));
		const done = first.find((event) => event.type === "done");
		assert.deepEqual(toolCallIds(done), ["toolu_old"]);

		const second = collect(streamClaudeAgentSdk(model, {
			messages: [
				...initial.messages, done.message, resultMessage("toolu_old", "RESULT OLD"),
				{ role: "system", content: "", toolsRemoved: [{ name: ECHO.name }], timestamp: Date.now() },
			],
		}, { sessionId: "claim-withdrawn" }));
		await settle(20);
		openGate();
		await observed.issued;
		const fresh = await observed.fresh;
		assert.deepEqual(fresh.content, [{ type: "text", text: "Tool echo is no longer active in Pi." }]);
		assert.equal(fresh.isError, true);
		assert.deepEqual((await observed.old).content, [{ type: "text", text: "RESULT OLD" }], "the executed call's late invocation still gets its result");
		await second;
	});

	it("forwards every early call to Pi when the stream stalls past the grace timer", async () => {
		const observed = {};
		installFakeClaudeCode(observed, async function* (client) {
			observed.callA = client.callTool({ name: "echo", arguments: ARGS, ...tagged("toolu_a") });
			observed.callB = client.callTool({ name: "echo", arguments: ARGS, ...tagged("toolu_b") });
			await settle(1700); // past the 1.5 s grace
			yield* toolUseMessage("m1", ["toolu_a", "toolu_b"]);
			await Promise.all([observed.callA, observed.callB]);
			yield* FINAL_REPLY;
		});
		const initial = initialContext();
		const first = await collect(streamClaudeAgentSdk(model, initial, { sessionId: "claim-early-batch" }));
		const done = first.find((event) => event.type === "done");
		assert.deepEqual(toolCallIds(done), ["toolu_a", "toolu_b"], "Pi gets each early call exactly once");
		assert.deepEqual(done.message.content.filter((block) => block.type === "toolCall").map((call) => call.arguments), [ARGS, ARGS]);

		const second = collect(streamClaudeAgentSdk(model, {
			messages: [...initial.messages, done.message, resultMessage("toolu_a", "RESULT A"), resultMessage("toolu_b", "RESULT B")],
		}, { sessionId: "claim-early-batch" }));
		assert.deepEqual((await observed.callA).content, [{ type: "text", text: "RESULT A" }]);
		assert.deepEqual((await observed.callB).content, [{ type: "text", text: "RESULT B" }], "the second early call is not failed as stranded");
		const rest = await second;
		assert.equal(rest.filter((event) => event.type === "toolcall_start").length, 0, "the stream's own blocks for the forwarded calls are not re-emitted");
	});
});
