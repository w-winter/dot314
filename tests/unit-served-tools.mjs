// The query's MCP tool server follows Pi's active tools mid-query: an extension
// can enable tools from inside a tool call (subagents_enable, web_enable), and
// Claude Code only sees them after it re-lists. ServedToolServer registers and
// removes tools on the live McpServer and resolves an update only once the
// client has fetched tools/list (or the cap expires).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { Type } from "@earendil-works/pi-ai";

import { advertisedInputSchema, ServedToolServer } from "../src/served-tools.ts";
import { QueryContext } from "../src/query-state.ts";

const piTool = (name, description = `${name} tool`, parameters = Type.Object({})) => ({ name, description, parameters });
const echoHandler = (tool) => async () => ({ content: [{ type: "text", text: `ran ${tool.name}` }] });

async function connect(instance) {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await instance.connect(serverTransport);
	const client = new Client({ name: "test-client", version: "1.0.0" });
	const notifications = [];
	client.setNotificationHandler(ToolListChangedNotificationSchema, (notification) => { notifications.push(notification.method); });
	await client.connect(clientTransport);
	const listNames = async () => (await client.listTools()).tools.map((tool) => tool.name);
	return { client, notifications, listNames };
}

const macrotask = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("ServedToolServer", () => {
	it("adds a tool on the live server and holds the update until the client re-lists", async () => {
		const served = new ServedToolServer("custom-tools", [piTool("alpha")], echoHandler);
		const { client, notifications, listNames } = await connect(served.config.instance);
		assert.deepEqual(await listNames(), ["alpha"]);

		let outcome;
		const update = served.update([piTool("alpha"), piTool("beta")]);
		assert.ok(update, "a changed tool set must return a pending update");
		void update.then((value) => { outcome = value; });
		await macrotask();
		assert.ok(notifications.includes("notifications/tools/list_changed"), "the client must be told the list changed");
		assert.equal(outcome, undefined, "must hold until the client has fetched the new list");

		assert.deepEqual(await listNames(), ["alpha", "beta"]);
		assert.equal(await update, "relisted");
		const called = await client.callTool({ name: "beta", arguments: {} });
		assert.equal(called.content[0].text, "ran beta");
	});

	it("withdraws a deactivated tool from the list but keeps it invocable for calls already issued", async () => {
		const served = new ServedToolServer("custom-tools", [piTool("alpha"), piTool("beta")], echoHandler);
		const { client, listNames } = await connect(served.config.instance);
		const update = served.update([piTool("beta")]);
		assert.deepEqual(await listNames(), ["beta"]);
		assert.equal(await update, "relisted");
		assert.deepEqual(served.names, ["beta"]);
		assert.equal(served.serves("alpha"), false);
		// The SDK rejects unregistered names before the bridge handler runs, which
		// would replace the real result of a call Pi already executed. Rejecting
		// new calls is the bridge handler's job (unit-served-tools-stream.mjs).
		const late = await client.callTool({ name: "alpha", arguments: {} });
		assert.equal(late.content[0].text, "ran alpha");

		const restored = served.update([piTool("alpha"), piTool("beta")]);
		assert.ok(restored, "reactivating a withdrawn tool is a change");
		assert.deepEqual(await listNames(), ["alpha", "beta"]);
		assert.equal(await restored, "relisted");
	});

	it("withdraws every tool when Pi deactivates them all", async () => {
		const served = new ServedToolServer("custom-tools", [piTool("alpha")], echoHandler);
		const { notifications, listNames } = await connect(served.config.instance);
		const update = served.update([]);
		assert.ok(update);
		await macrotask();
		assert.ok(notifications.includes("notifications/tools/list_changed"), "a withdrawal alone must notify");
		assert.deepEqual(await listNames(), []);
		assert.equal(await update, "relisted");
		assert.equal(served.update([]), null);
	});

	it("resolves after the cap when the client never re-lists", async () => {
		const served = new ServedToolServer("custom-tools", [piTool("alpha")], echoHandler);
		await connect(served.config.instance);
		const started = Date.now();
		assert.equal(await served.update([piTool("alpha"), piTool("beta")], 50), "timeout");
		assert.ok(Date.now() - started >= 45, "must wait for the cap before giving up");
	});

	it("returns null when nothing changed and does not notify", async () => {
		const served = new ServedToolServer("custom-tools", [piTool("alpha")], echoHandler);
		const { notifications } = await connect(served.config.instance);
		assert.equal(served.update([piTool("alpha")]), null);
		await macrotask();
		assert.deepEqual(notifications, []);
	});

	it("re-registers a same-name tool whose declaration changed", async () => {
		const served = new ServedToolServer("custom-tools", [piTool("alpha", "old")], echoHandler);
		const { client } = await connect(served.config.instance);
		const update = served.update([piTool("alpha", "new")]);
		assert.ok(update);
		const listed = (await client.listTools()).tools;
		assert.equal(listed.find((tool) => tool.name === "alpha").description, "new");
		assert.equal(await update, "relisted");
	});

	it("postpones a redefinition while an issued call has not been invoked, then applies it", async () => {
		let blocked = true;
		const oldTool = piTool("alpha", "old", Type.Object({}));
		const newTool = piTool("alpha", "new", Type.Object({ requiredNew: Type.String() }));
		const served = new ServedToolServer("custom-tools", [oldTool], echoHandler, { redefinitionBlocked: (name) => blocked && name === "alpha" });
		const { client } = await connect(served.config.instance);
		assert.equal(served.update([newTool]), null, "a postponed redefinition changes nothing yet");
		assert.equal(served.retryDeferred(), null, "still blocked");
		// The late invocation of the old call is still validated against the old schema.
		const late = await client.callTool({ name: "alpha", arguments: {} });
		assert.equal(late.content[0].text, "ran alpha");

		blocked = false;
		const applied = served.retryDeferred();
		assert.ok(applied, "the postponed redefinition applies once unblocked");
		const listed = (await client.listTools()).tools.find((tool) => tool.name === "alpha");
		assert.equal(listed.description, "new");
		assert.deepEqual(listed.inputSchema.required, ["requiredNew"]);
		assert.equal(await applied, "relisted");
		assert.equal(served.retryDeferred(), null, "nothing left to apply");
	});

	it("reports a finished call by Claude Code's tool_use id, even one the SDK rejected before the handler, and answers after the hook", async () => {
		const finished = [];
		let releaseHook;
		let handlerRan = false;
		const served = new ServedToolServer("custom-tools", [piTool("alpha", "old", Type.Object({ requiredOld: Type.String() }))], () => async () => {
			handlerRan = true;
			return { content: [{ type: "text", text: "ran" }] };
		}, {
			callFinished: (toolUseId) => {
				finished.push(toolUseId);
				return new Promise((resolve) => { releaseHook = resolve; });
			},
		});
		const { client } = await connect(served.config.instance);
		let answered = false;
		// Arguments are pass-through (Pi validates them), so only a malformed
		// request is still rejected by the SDK before the handler.
		const rejected = client.callTool({ name: "alpha", arguments: "not an object", _meta: { "claudecode/toolUseId": "toolu_1" } }).then(
			(result) => { answered = true; return result; },
			(error) => { answered = true; return error; },
		);
		await macrotask();
		assert.deepEqual(finished, ["toolu_1"], "the rejected call must be reported");
		assert.equal(handlerRan, false, "the SDK rejected it before the handler");
		assert.equal(answered, false, "the answer waits for the hook");
		releaseHook();
		assert.match((await rejected).message, /expected record/);

		const untagged = await client.callTool({ name: "alpha", arguments: {} });
		assert.equal(untagged.content[0].text, "ran");
		assert.deepEqual(finished, ["toolu_1"], "a call without Claude Code's tag reports nothing");
	});

	it("releases a postponed redefinition when a continuation starts (the issuing Claude Code process has finished)", async () => {
		const queryCtx = new QueryContext();
		const served = new ServedToolServer("custom-tools", [piTool("alpha", "old")], echoHandler, {
			redefinitionBlocked: (name) => queryCtx.awaitsInvocation(name),
		});
		queryCtx.servedTools = served;
		queryCtx.forwardedToolCallIds.add("toolu_1");
		queryCtx.queryToolNames.set("toolu_1", "alpha");
		const { client } = await connect(served.config.instance);
		assert.equal(served.update([piTool("alpha", "new")]), null, "postponed while toolu_1 may still be invoked");
		queryCtx.prepareContinuation();
		assert.ok(queryCtx.servedToolsSettling, "the applied redefinition holds results for the re-list");
		assert.equal((await client.listTools()).tools[0].description, "new");
		await queryCtx.servedToolsSettling;
	});

	it("does not wait when no client is connected", async () => {
		const served = new ServedToolServer("custom-tools", [piTool("alpha")], echoHandler);
		assert.equal(await served.update([piTool("beta")]), "not-connected");
		const { listNames } = await connect(served.config.instance);
		assert.deepEqual(await listNames(), ["beta"]);
	});

	it("lists a tool added mid-query exactly like a tool served from the start", async () => {
		const parameters = Type.Object({
			path: Type.String({ description: "File to read" }),
			limit: Type.Optional(Type.Number({ description: "Max lines" })),
			mode: Type.Union([Type.Literal("a"), Type.Literal("b")]),
		});
		const tool = piTool("read", "Read a file", parameters);
		const reference = new ServedToolServer("custom-tools", [tool], echoHandler);
		const expected = (await (await connect(reference.config.instance)).client.listTools()).tools;
		assert.deepEqual(expected[0].inputSchema, advertisedInputSchema(parameters));

		const served = new ServedToolServer("custom-tools", [piTool("alpha")], echoHandler);
		const { client } = await connect(served.config.instance);
		const update = served.update([piTool("alpha"), tool]);
		const listed = (await client.listTools()).tools.filter((entry) => entry.name === "read");
		await update;
		assert.deepEqual(listed, expected);
	});
});
