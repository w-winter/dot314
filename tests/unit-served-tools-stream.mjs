// Provider level: a Pi extension that activates tools from inside a tool call
// (subagents_enable, web_enable) changes the tool set Pi hands back with that
// call's result. The running query must serve the new set, and the result must
// be held until Claude Code has re-listed, or CC's next request still carries
// the old tools and the model reports the new tool as unavailable.
import "./lib/debug-env.mjs";

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { Type } from "@earendil-works/pi-ai";

import { __testSetBridgeIntegrityState, __testSetSdkQueryFactory, isPiDispatchable, streamClaudeAgentSdk } from "../src/index.ts";
import { setExtensionApi } from "../src/bridge-state.ts";
import { ctx, resetStack } from "../src/query-state.ts";
import { runInRequestLane } from "../src/request-lane.ts";
import { mcpToolAliases } from "../src/tool-mapping.ts";

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

const ENABLE = { name: "enable_extra", description: "Enables extra tools", parameters: Type.Object({}) };
const EXTRA = { name: "extra_echo", description: "Echoes text", parameters: Type.Object({ text: Type.String() }) };

async function collect(stream) {
	const events = [];
	for await (const event of stream) events.push(event);
	return events;
}

/** Fake SDK query that behaves like CC toward the bridge's MCP server: connects
 *  a real MCP client to the live instance, streams a tool_use for enable_extra,
 *  calls the tool, and only continues once the call has returned.
 *  `observed.callName` replaces enable_extra's MCP name when set. */
function installFakeClaudeCode(observed) {
	const callName = observed.callName ?? ENABLE.name;
	__testSetSdkQueryFactory(({ options }) => {
		let closed = false;
		return {
			async *[Symbol.asyncIterator]() {
				const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
				await options.mcpServers["custom-tools"].instance.connect(serverTransport);
				const client = new Client({ name: "fake-claude-code", version: "1.0.0" });
				client.setNotificationHandler(ToolListChangedNotificationSchema, () => { observed.listChanged += 1; });
				await client.connect(clientTransport);
				observed.client = client;
				observed.initialTools = (await client.listTools()).tools.map((tool) => tool.name);
				for (const message of [
					{ type: "system", subtype: "init", session_id: "served-tools-session" },
					{ type: "stream_event", event: { type: "message_start", message: { id: "m1", model: model.id, usage: { input_tokens: 1 } } } },
					{ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call-1", name: `mcp__custom-tools__${callName}`, input: {} } } },
					{ type: "stream_event", event: { type: "content_block_stop", index: 0 } },
					{ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } } },
					{ type: "stream_event", event: { type: "message_stop" } },
				]) {
					if (closed) return;
					yield message;
				}
				if (observed.callGate) await observed.callGate;
				const call = client.callTool({ name: callName, arguments: {} }).then((result) => {
					observed.callReturned = true;
					return result;
				});
				observed.call = call;
				const result = await call;
				if (closed) return;
				yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call-1", content: result.content }] } };
				yield { type: "stream_event", event: { type: "message_start", message: { id: "m2", model: model.id, usage: { input_tokens: 1 } } } };
				yield { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } };
				yield { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } } };
				yield { type: "stream_event", event: { type: "content_block_stop", index: 0 } };
				yield { type: "stream_event", event: { type: "message_stop" } };
				yield { type: "result", subtype: "success", session_id: "served-tools-session" };
			},
			close() { closed = true; },
			async interrupt() { closed = true; },
		};
	});
}

/** Runs the tool-use turn and returns the context Pi would send back with the
 *  enable_extra result. `change`, when given, is the tool loadout delta the
 *  extension caused during the call; `enable` replaces the enable_extra tool. */
async function runToolTurn(sessionId, change, enable = ENABLE) {
	const initial = {
		messages: [
			{ role: "system", content: "test system prompt", toolsAdded: [enable], timestamp: 0 },
			{ role: "user", content: "enable the extra tools, then use them", timestamp: Date.now() },
		],
	};
	const first = await collect(streamClaudeAgentSdk(model, initial, { sessionId }));
	const done = first.find((event) => event.type === "done");
	assert.equal(done?.reason, "toolUse");
	return {
		messages: [
			...initial.messages,
			done.message,
			{ role: "toolResult", toolCallId: "call-1", toolName: enable.name, content: [{ type: "text", text: "enabled" }], isError: false, timestamp: Date.now() },
			// pi-agent-core declares a tool loadout change as a system message after the results.
			...(change ? [{
				role: "system",
				content: "",
				...(change.toolsAdded?.length ? { toolsAdded: change.toolsAdded } : {}),
				...(change.toolsRemoved?.length ? { toolsRemoved: change.toolsRemoved } : {}),
				timestamp: Date.now(),
			}] : []),
		],
	};
}

const ACTIVATE_EXTRA = { toolsAdded: [EXTRA] };
const SWAP_ENABLE_FOR_EXTRA = { toolsAdded: [EXTRA], toolsRemoved: [{ name: ENABLE.name }] };
const REMOVE_ALL = { toolsRemoved: [{ name: ENABLE.name }] };
const REDEFINE_ENABLE = {
	toolsRemoved: [{ name: ENABLE.name }],
	toolsAdded: [{ ...ENABLE, parameters: Type.Object({ requiredNew: Type.String() }) }],
};

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const OLD_ENABLE = { ...ENABLE, parameters: Type.Object({ requiredOld: Type.String() }) };
const NEW_ENABLE = { ...ENABLE, parameters: Type.Object({ requiredNew: Type.String() }) };
const NEW_ARGS = { requiredNew: "valid-new" };

/** Fake CC for two model messages: call-1 (args {}) and, after its result,
 *  call-2 (NEW_ARGS). Re-lists on tools/list_changed like CC. `tagCalls` sends
 *  CC's tool_use id in each tools/call's _meta, as CC 2.1.283 does. */
function installTwoCallClaudeCode(observed, { tagCalls }) {
	const meta = (id) => (tagCalls ? { _meta: { "claudecode/toolUseId": id } } : {});
	const toolUse = (messageId, id, args) => [
		{ type: "stream_event", event: { type: "message_start", message: { id: messageId, model: model.id, usage: { input_tokens: 1 } } } },
		{ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name: "mcp__custom-tools__enable_extra", input: {} } } },
		{ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(args) } } },
		{ type: "stream_event", event: { type: "content_block_stop", index: 0 } },
		{ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } } },
		{ type: "stream_event", event: { type: "message_stop" } },
	];
	__testSetSdkQueryFactory(({ options }) => {
		let closed = false;
		return {
			async *[Symbol.asyncIterator]() {
				const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
				await options.mcpServers["custom-tools"].instance.connect(serverTransport);
				const client = new Client({ name: "fake-claude-code", version: "1.0.0" });
				client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
					observed.latestTools = (await client.listTools()).tools;
				});
				await client.connect(clientTransport);
				observed.client = client;
				observed.latestTools = (await client.listTools()).tools;
				yield { type: "system", subtype: "init", session_id: "served-tools-session" };
				for (const message of toolUse("m1", "call-1", {})) {
					if (closed) return;
					yield message;
				}
				await observed.callGate;
				const first = await client.callTool({ name: "enable_extra", arguments: {}, ...meta("call-1") });
				observed.firstResult = first;
				observed.toolsWhenFirstAnswered = observed.latestTools;
				if (closed) return;
				yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call-1", content: first.content, is_error: first.isError === true }] } };
				for (const message of toolUse("m2", "call-2", NEW_ARGS)) {
					if (closed) return;
					yield message;
				}
				observed.second = client.callTool({ name: "enable_extra", arguments: NEW_ARGS, ...meta("call-2") });
				const second = await observed.second;
				if (closed) return;
				yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call-2", content: second.content }] } };
				yield { type: "stream_event", event: { type: "message_start", message: { id: "m3", model: model.id, usage: { input_tokens: 1 } } } };
				yield { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } };
				yield { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } } };
				yield { type: "stream_event", event: { type: "content_block_stop", index: 0 } };
				yield { type: "stream_event", event: { type: "message_stop" } };
				yield { type: "result", subtype: "success", session_id: "served-tools-session" };
			},
			close() { closed = true; },
			async interrupt() { closed = true; },
		};
	});
}

/** A call with arguments Pi rejects still reaches Pi (MCP arguments are
 *  pass-through; Pi validates) and Claude gets Pi's validation error. It must
 *  not keep the redefinition Pi made meanwhile postponed: a later call valid
 *  under Pi's new definition must get Pi's real result. */
async function rejectedCallThenRedefinition(sessionId, { tagCalls }) {
	let openGate;
	const observed = { callGate: new Promise((resolve) => { openGate = resolve; }) };
	installTwoCallClaudeCode(observed, { tagCalls });
	const initial = {
		messages: [
			{ role: "system", content: "test system prompt", toolsAdded: [OLD_ENABLE], timestamp: 0 },
			{ role: "user", content: "enable the extra tools", timestamp: Date.now() },
		],
	};
	const firstTurn = await collect(streamClaudeAgentSdk(model, initial, { sessionId }));
	const done1 = firstTurn.find((event) => event.type === "done");
	assert.equal(done1?.reason, "toolUse");
	// Pi rejects call-1's arguments, and the extension redefines the tool.
	const afterFirst = {
		messages: [
			...initial.messages,
			done1.message,
			{ role: "toolResult", toolCallId: "call-1", toolName: "enable_extra", content: [{ type: "text", text: "Validation failed: requiredOld is required" }], isError: true, timestamp: Date.now() },
			{ role: "system", content: "", toolsRemoved: [{ name: ENABLE.name }], toolsAdded: [NEW_ENABLE], timestamp: Date.now() },
		],
	};
	const secondTurn = collect(streamClaudeAgentSdk(model, afterFirst, { sessionId }));
	await settle(20); // Pi's callback lands before CC invokes call-1, so the redefinition is postponed.
	openGate();
	const done2 = (await secondTurn).find((event) => event.type === "done");
	assert.equal(done2?.reason, "toolUse");
	assert.equal(observed.firstResult.isError, true, "call-1 is rejected at input validation (that part is correct)");
	assert.deepEqual(observed.firstResult.content, [{ type: "text", text: "Validation failed: requiredOld is required" }], "Pi's validation error is the result");
	const call2 = done2.message.content.find((block) => block.type === "toolCall");
	assert.equal(call2?.id, "call-2");
	assert.deepEqual(call2.arguments, NEW_ARGS, "Pi receives call-2 with its new-schema arguments");

	const thirdTurn = collect(streamClaudeAgentSdk(model, {
		messages: [
			...afterFirst.messages,
			done2.message,
			{ role: "toolResult", toolCallId: "call-2", toolName: "enable_extra", content: [{ type: "text", text: "NEW REAL RESULT" }], isError: false, timestamp: Date.now() },
		],
	}, { sessionId }));
	const result = await observed.second;
	assert.deepEqual(result.content, [{ type: "text", text: "NEW REAL RESULT" }], "a new call valid under Pi's new definition gets Pi's real result");
	assert.notEqual(result.isError, true);
	const listed = (await observed.client.listTools()).tools.find((tool) => tool.name === "enable_extra");
	assert.deepEqual(listed.inputSchema.required, ["requiredNew"]);
	await thirdTurn;
	return observed;
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

describe("tools activated by a tool call reach the running query", () => {
	it("serves the new tool and holds the result until Claude Code re-lists", async () => {
		const observed = { listChanged: 0, callReturned: false };
		installFakeClaudeCode(observed);
		const next = await runToolTurn("served-tools-changed", ACTIVATE_EXTRA);
		assert.deepEqual(observed.initialTools, ["enable_extra"]);

		const second = collect(streamClaudeAgentSdk(model, next, { sessionId: "served-tools-changed" }));
		await settle(30);
		assert.equal(observed.callReturned, false, "the result must wait for Claude Code's re-list");
		assert.ok(observed.listChanged > 0, "Claude Code must be told the tool list changed");

		const relisted = (await observed.client.listTools()).tools.map((tool) => tool.name);
		assert.deepEqual(relisted, ["enable_extra", "extra_echo"]);
		const result = await observed.call;
		assert.equal(result.content[0].text, "enabled");
		const events = await second;
		assert.ok(events.some((event) => event.type === "done"), "the turn must complete after the held result is delivered");
	});

	it("also holds a result Pi delivered before Claude Code invoked the handler", async () => {
		// The SDK can invoke a handler after Pi's callback queued its result; the
		// handler then takes the queued result, and must still wait for the re-list.
		let openGate;
		const observed = { listChanged: 0, callReturned: false, callGate: new Promise((resolve) => { openGate = resolve; }) };
		installFakeClaudeCode(observed);
		const next = await runToolTurn("served-tools-queued", ACTIVATE_EXTRA);

		const second = collect(streamClaudeAgentSdk(model, next, { sessionId: "served-tools-queued" }));
		openGate();
		await settle(30);
		assert.ok(observed.call, "the fake must have issued the call");
		assert.equal(observed.callReturned, false, "a queued result must also wait for Claude Code's re-list");

		assert.deepEqual((await observed.client.listTools()).tools.map((tool) => tool.name), ["enable_extra", "extra_echo"]);
		assert.equal((await observed.call).content[0].text, "enabled");
		await second;
	});

	it("stops serving and routing a tool Pi deactivated", async () => {
		const observed = { listChanged: 0, callReturned: false };
		installFakeClaudeCode(observed);
		const next = await runToolTurn("served-tools-removed", SWAP_ENABLE_FOR_EXTRA);

		const second = collect(streamClaudeAgentSdk(model, next, { sessionId: "served-tools-removed" }));
		const routed = runInRequestLane("served-tools-removed", () => [...ctx().servedToolNameToPi?.keys() ?? []]);
		assert.deepEqual(routed.sort(), ["mcp__custom-tools__extra_echo"], "a deactivated tool must stop routing to Pi");
		assert.deepEqual((await observed.client.listTools()).tools.map((tool) => tool.name), ["extra_echo"]);
		const gone = await observed.client.callTool({ name: "enable_extra", arguments: {} });
		assert.equal(gone.isError, true, "a deactivated tool must no longer be callable");
		assert.equal((await observed.call).content[0].text, "enabled", "the in-flight call still gets its result");
		await second;
	});

	it("delivers an executed call's real result after its own tool was removed, to a late invocation", async () => {
		// A self-deactivating tool whose MCP invocation lands after Pi's callback:
		// Pi already executed it, so the model must get the real output, while a
		// genuinely new call under the removed name is rejected.
		let openGate;
		const observed = { listChanged: 0, callReturned: false, callGate: new Promise((resolve) => { openGate = resolve; }) };
		installFakeClaudeCode(observed);
		const next = await runToolTurn("served-tools-self-removed", SWAP_ENABLE_FOR_EXTRA);

		const second = collect(streamClaudeAgentSdk(model, next, { sessionId: "served-tools-self-removed" }));
		openGate();
		assert.deepEqual((await observed.client.listTools()).tools.map((tool) => tool.name), ["extra_echo"]);
		const result = await observed.call;
		assert.deepEqual(result.content, [{ type: "text", text: "enabled" }], "the executed call must receive its real result");
		assert.notEqual(result.isError, true);
		const fresh = await observed.client.callTool({ name: "enable_extra", arguments: {} });
		assert.equal(fresh.isError, true, "a new call to the removed tool must be rejected");
		assert.match(fresh.content[0].text, /no longer active/);
		await second;
	});

	it("delivers the late result to the removed tool even when the tool added in its place is named like its alias", async () => {
		// `fake_name/with space` is served as `fake_name_with_space_<hash>`; the
		// tool Pi activates in its place is named exactly that. The alias still
		// belongs to the executed call's tool, so the newcomer is served under
		// another alias and the late invocation reaches the original handler.
		const original = { ...ENABLE, name: "fake_name/with space" };
		const alias = mcpToolAliases([original.name]).get(original.name);
		const newcomer = { ...EXTRA, name: alias };
		let openGate;
		const observed = { listChanged: 0, callReturned: false, callName: alias, callGate: new Promise((resolve) => { openGate = resolve; }) };
		installFakeClaudeCode(observed);
		const next = await runToolTurn("served-tools-alias-reclaimed", { toolsAdded: [newcomer], toolsRemoved: [{ name: original.name }] }, original);

		const second = collect(streamClaudeAgentSdk(model, next, { sessionId: "served-tools-alias-reclaimed" }));
		const routed = runInRequestLane("served-tools-alias-reclaimed", () => new Map(ctx().servedToolNameToPi));
		openGate();
		const listed = (await observed.client.listTools()).tools.map((tool) => tool.name);
		const result = await observed.call;
		assert.deepEqual(result.content, [{ type: "text", text: "enabled" }], "the executed call must receive its real result");
		assert.notEqual(result.isError, true);
		assert.equal(listed.length, 1);
		assert.notEqual(listed[0], alias, "the newcomer must not take the alias a late invocation still needs");
		assert.match(listed[0], /^[A-Za-z0-9_-]+$/);
		assert.deepEqual([...routed], [[`mcp__custom-tools__${listed[0]}`, alias]],
			"routing to Pi matches what is served: only the newcomer, under the alias it is listed by");
		const fresh = await observed.client.callTool({ name: alias, arguments: {} });
		assert.equal(fresh.isError, true, "a new call under the removed tool's alias must be rejected");
		assert.match(fresh.content[0].text, /fake_name\/with space is no longer active/);
		await second;
	});

	it("keeps an emptied served manifest authoritative", async () => {
		const observed = { listChanged: 0, callReturned: false };
		installFakeClaudeCode(observed);
		const next = await runToolTurn("served-tools-empty", REMOVE_ALL);

		const second = collect(streamClaudeAgentSdk(model, next, { sessionId: "served-tools-empty" }));
		const nameMap = runInRequestLane("served-tools-empty", () => ctx().servedToolNameToPi);
		assert.equal(nameMap.size, 0);
		assert.deepEqual((await observed.client.listTools()).tools, []);
		assert.equal(isPiDispatchable("mcp__custom-tools__enable_extra", nameMap), false, "a removed bridged name must not route to Pi");
		assert.equal(isPiDispatchable("enable_extra", nameMap), false, "bare-name fallback must stay off");
		assert.equal((await observed.call).content[0].text, "enabled");
		await second;
	});

	it("delivers an executed call's real result when its tool's schema changed before the late invocation", async () => {
		// The call was issued (args {}) and executed under the old schema; the new
		// schema would reject those args at the MCP layer, replacing the real
		// output. The model's next request must still carry the new schema.
		let openGate;
		const observed = { listChanged: 0, callReturned: false, callGate: new Promise((resolve) => { openGate = resolve; }) };
		installFakeClaudeCode(observed);
		const next = await runToolTurn("served-tools-redefined", REDEFINE_ENABLE);

		const second = collect(streamClaudeAgentSdk(model, next, { sessionId: "served-tools-redefined" }));
		openGate();
		await settle(30);
		if (observed.callReturned) {
			assert.deepEqual((await observed.call).content, [{ type: "text", text: "enabled" }], "the executed call must receive its real result");
		}
		assert.equal(observed.callReturned, false, "the late result must wait for the re-list that carries the new schema");
		const listed = (await observed.client.listTools()).tools;
		assert.deepEqual(listed.find((tool) => tool.name === "enable_extra").inputSchema.required, ["requiredNew"], "the next request must see the new schema");
		const result = await observed.call;
		assert.deepEqual(result.content, [{ type: "text", text: "enabled" }], "the executed call must receive its real result");
		assert.notEqual(result.isError, true);
		await second;
	});

	it("applies a redefinition postponed by a call Pi rejected, so a new valid call gets Pi's real result", async () => {
		// CC tags the call with its tool_use id: the redefinition applies before
		// call-1's rejection goes back, so CC's next request already has the new schema.
		const observed = await rejectedCallThenRedefinition("served-tools-rejected-tagged", { tagCalls: true });
		assert.deepEqual(observed.toolsWhenFirstAnswered.find((tool) => tool.name === "enable_extra").inputSchema.required, ["requiredNew"],
			"CC must have re-listed the new schema before call-1's rejection reached it");
	});

	it("applies it too when the rejected call carries no tool_use id", async () => {
		await rejectedCallThenRedefinition("served-tools-rejected-untagged", { tagCalls: false });
	});

	it("delivers at once when the tool set is unchanged", async () => {
		// No-regression guard: behaves the same before and after the fix.
		const observed = { listChanged: 0, callReturned: false };
		installFakeClaudeCode(observed);
		const next = await runToolTurn("served-tools-unchanged");

		const second = collect(streamClaudeAgentSdk(model, next, { sessionId: "served-tools-unchanged" }));
		await settle(30);
		assert.equal(observed.callReturned, true, "an unchanged tool set must not hold the result");
		assert.equal((await observed.call).content[0].text, "enabled");
		assert.equal(observed.listChanged, 0, "an unchanged tool set must not notify");
		await second;
	});
});
