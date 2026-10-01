// Every Pi tool must be callable by Claude whatever its name. Claude Code
// rewrites an MCP tool name's characters outside [A-Za-z0-9_-] to "_" and the
// Anthropic API rejects a request whose tool name exceeds 128 characters, so a
// Pi tool named `fake_name/with space` (pi-mcp-adapter direct tools) came back
// under a name no bridge map knew, and a long name failed the whole request.
// The bridge serves each tool under a deterministic alias and maps it back to
// the exact Pi name.
import "./lib/debug-env.mjs";

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Type } from "@earendil-works/pi-ai";

import { __testSetBridgeIntegrityState, __testSetSdkQueryFactory, resolveMcpTools, streamClaudeAgentSdk } from "../src/index.ts";
import { setExtensionApi } from "../src/bridge-state.ts";
import { mapPiToolNameToSdk } from "../src/convert.ts";
import { resetStack } from "../src/query-state.ts";
import { ServedToolServer } from "../src/served-tools.ts";
import { MCP_TOOL_PREFIX } from "../src/skills.ts";
import { mapToolName, mcpToolAliases } from "../src/tool-mapping.ts";

const CLAUDE_SAFE = /^[a-zA-Z0-9_-]+$/;
const MAX_QUALIFIED = 128; // "tools.N.custom.name: String should have at most 128 characters"
/** Claude Code 2.1.283's MCP name normalization (`En`). */
const claudeCodeNormalize = (name) => name.replace(/[^a-zA-Z0-9_-]/g, "_");

const SLASH_SPACE = "fake_name/with space";
const NAMES = [
	"read",
	"bash",
	SLASH_SPACE,
	"fake_name with/space", // sanitizes to the same spelling as SLASH_SPACE
	"dotted.tool.name",
	"werkzeug_größe_日本",
	"s".repeat(109), // longest safe name that fits: served unchanged
	"L".repeat(110), // safe characters, one over the limit
	"x".repeat(300),
];

const piTool = (name, parameters = Type.Object({ text: Type.String() })) => ({ name, description: `${name} tool`, parameters });
const contextWith = (names) => ({ messages: [{ role: "system", content: "", toolsAdded: names.map((name) => piTool(name)), timestamp: 0 }] });

function assertServable(qualified) {
	assert.match(qualified, CLAUDE_SAFE, `${qualified} must survive Claude Code's name normalization unchanged`);
	assert.ok(qualified.length <= MAX_QUALIFIED, `${qualified.length}-character name exceeds the API limit`);
}

describe("Pi tool names Claude Code cannot use verbatim", () => {
	it("serves every tool under a unique, Claude-safe name that fits and maps back to the exact Pi name", () => {
		const { mcpTools, customToolNameToSdk, customToolNameToPi } = resolveMcpTools(contextWith(NAMES));
		assert.deepEqual(mcpTools.map((tool) => tool.name), NAMES, "tool order is unchanged");
		const qualified = NAMES.map((name) => customToolNameToSdk.get(name));
		for (const name of qualified) assertServable(name);
		assert.equal(new Set(qualified.map((name) => name.toLowerCase())).size, NAMES.length, "aliases are unique, even ignoring case");
		for (const [index, piName] of NAMES.entries()) {
			assert.equal(customToolNameToPi.get(qualified[index]), piName);
			assert.equal(mapToolName(qualified[index], customToolNameToPi), piName);
			// Claude Code may echo other spellings of our server prefix.
			assert.equal(mapToolName(qualified[index].replace("mcp__custom-tools__", "mcp__custom_tools__"), customToolNameToPi), piName);
			// History rebuilt into a Claude session names the same alias.
			assert.equal(mapPiToolNameToSdk(piName, customToolNameToSdk), qualified[index]);
		}
	});

	it("leaves already-safe names that fit unchanged", () => {
		const { customToolNameToSdk } = resolveMcpTools(contextWith(NAMES));
		for (const name of ["read", "bash", "s".repeat(109)]) {
			assert.equal(customToolNameToSdk.get(name), `${MCP_TOOL_PREFIX}${name}`);
		}
		for (const name of NAMES.filter((candidate) => !/^[A-Za-z0-9_-]{1,109}$/.test(candidate))) {
			const alias = customToolNameToSdk.get(name).slice(MCP_TOOL_PREFIX.length);
			assert.match(alias, /_[0-9a-f]{8}$/, `${name} carries a hash suffix`);
			assert.ok(alias.startsWith(claudeCodeNormalize(name).slice(0, 20)), "the alias keeps the readable spelling");
		}
	});

	it("gives every name the same alias whatever the order or the other tools", () => {
		const aliasOf = (names) => resolveMcpTools(contextWith(names)).customToolNameToSdk;
		const full = aliasOf(NAMES);
		const reversed = aliasOf([...NAMES].reverse());
		const alone = (name) => aliasOf([name]).get(name);
		for (const name of NAMES) {
			assert.equal(reversed.get(name), full.get(name));
			assert.equal(alone(name), full.get(name));
		}
	});

	it("never hands two tools one alias, even when a safe name equals another tool's derived alias", () => {
		const derived = resolveMcpTools(contextWith([SLASH_SPACE])).customToolNameToSdk.get(SLASH_SPACE).slice(MCP_TOOL_PREFIX.length);
		const { customToolNameToSdk } = resolveMcpTools(contextWith([SLASH_SPACE, derived]));
		assert.equal(customToolNameToSdk.get(derived), `${MCP_TOOL_PREFIX}${derived}`, "the safe name keeps its own name");
		assert.notEqual(customToolNameToSdk.get(SLASH_SPACE), customToolNameToSdk.get(derived));
		assertServable(customToolNameToSdk.get(SLASH_SPACE));
	});

	it("registers the aliases on the MCP server and keeps the same alias across a mid-turn update", async () => {
		const tools = NAMES.map((name) => piTool(name));
		const served = new ServedToolServer("custom-tools", tools, (tool) => async () => ({ content: [{ type: "text", text: `ran ${tool.name}` }] }));
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await served.config.instance.connect(serverTransport);
		const client = new Client({ name: "test-client", version: "1.0.0" });
		await client.connect(clientTransport);
		const expected = resolveMcpTools(contextWith(NAMES)).customToolNameToSdk;
		const listed = (await client.listTools()).tools.map((tool) => tool.name);
		for (const name of listed) assertServable(`${MCP_TOOL_PREFIX}${name}`);
		assert.deepEqual(listed.map((name) => `${MCP_TOOL_PREFIX}${name}`), NAMES.map((name) => expected.get(name)));
		const alias = expected.get(SLASH_SPACE).slice(MCP_TOOL_PREFIX.length);
		assert.equal((await client.callTool({ name: alias, arguments: { text: "x" } })).content[0].text, `ran ${SLASH_SPACE}`);
		assert.deepEqual(served.names, NAMES, "hooks and `names` speak Pi names");

		const update = served.update([...tools, piTool("added/later")]);
		assert.ok(update);
		const relisted = (await client.listTools()).tools.map((tool) => tool.name);
		assert.deepEqual(relisted.slice(0, NAMES.length), listed, "existing tools keep their aliases");
		assert.equal(await update, "relisted");
		assert.equal(served.update([...tools, piTool("added/later")]), null, "an unchanged set is not a change");
	});
});

// Within a query an alias belongs to the registration that holds it: a
// withdrawn tool keeps it for a late invocation of a call Pi already executed,
// and a tool whose redefinition is postponed keeps serving under it. A tool
// added mid-query whose name equals such an alias gets another alias.
describe("an alias a running query has registered", () => {
	const derived = mcpToolAliases([SLASH_SPACE]).get(SLASH_SPACE);
	const echo = (tool) => async () => ({ content: [{ type: "text", text: `ran ${tool.name}` }] });
	const listNames = async (client) => (await client.listTools()).tools.map((tool) => tool.name);
	// Valid under both declarations the tests serve.
	const call = async (client, name) => (await client.callTool({ name, arguments: { text: "x", other: "y" } })).content[0].text;
	async function connect(served) {
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await served.config.instance.connect(serverTransport);
		const client = new Client({ name: "test-client", version: "1.0.0" });
		await client.connect(clientTransport);
		return client;
	}

	it("stays with its tool and is never handed to another name", () => {
		const owned = new Map([[SLASH_SPACE, derived]]);
		assert.deepEqual(mcpToolAliases(NAMES, new Map()), mcpToolAliases(NAMES), "no owned aliases: the pure function of the name set");
		assert.equal(mcpToolAliases([derived]).get(derived), derived, "across queries a safe name is its own alias");
		for (const newcomer of [derived, derived.toUpperCase()]) {
			const alias = mcpToolAliases([SLASH_SPACE, newcomer], owned).get(newcomer);
			assert.notEqual(alias.toLowerCase(), derived.toLowerCase(), `${newcomer} must not take the owned alias`);
			assert.match(alias, /_[0-9a-f]{8}$/);
			assertServable(`${MCP_TOOL_PREFIX}${alias}`);
		}
		assert.equal(mcpToolAliases([SLASH_SPACE, derived], owned).get(SLASH_SPACE), derived, "the owner keeps its alias");
		assert.notEqual(mcpToolAliases([derived], owned).get(derived), derived, "even when its owner is no longer active");
	});

	it("keeps serving an active tool whose redefinition is postponed when a newcomer is named like its alias", async () => {
		const original = piTool(SLASH_SPACE);
		const newcomer = piTool(derived);
		let blocked = true;
		const served = new ServedToolServer("custom-tools", [original], echo, { redefinitionBlocked: () => blocked });
		const client = await connect(served);
		assert.deepEqual(await listNames(client), [derived]);

		const update = served.update([original, newcomer]);
		assert.ok(update);
		const listed = await listNames(client);
		assert.equal(await update, "relisted");
		assert.equal(listed.length, 2, "the active original must stay listed next to the newcomer");
		assert.equal(listed[0], derived, "the original keeps its alias");
		const newcomerAlias = listed[1];
		assert.notEqual(newcomerAlias, derived);
		assertServable(`${MCP_TOOL_PREFIX}${newcomerAlias}`);
		assert.deepEqual(served.names, [SLASH_SPACE, derived]);
		assert.ok(served.serves(SLASH_SPACE), "the active original is still served");
		assert.deepEqual([...served.aliases], [[SLASH_SPACE, derived], [derived, newcomerAlias]]);
		assert.equal(await call(client, derived), `ran ${SLASH_SPACE}`, "the original's alias reaches the original");
		assert.equal(await call(client, newcomerAlias), `ran ${derived}`);
		assert.equal(served.retryDeferred(), null, "nothing was postponed: neither tool changed");

		// A postponed redefinition of the original applies under the same alias.
		const redefined = piTool(SLASH_SPACE, Type.Object({ other: Type.String() }));
		assert.equal(served.update([redefined, newcomer]), null, "postponed while blocked");
		assert.equal(await call(client, derived), `ran ${SLASH_SPACE}`);
		blocked = false;
		const retried = served.retryDeferred();
		assert.ok(retried, "the postponed redefinition applies once allowed");
		const relisted = (await client.listTools()).tools;
		assert.equal(await retried, "relisted");
		assert.deepEqual(relisted.map((tool) => tool.name).sort(), [derived, newcomerAlias].sort());
		assert.deepEqual(Object.keys(relisted.find((tool) => tool.name === derived).inputSchema.properties), ["other"]);
		assert.deepEqual([...served.aliases].sort(), [[SLASH_SPACE, derived], [derived, newcomerAlias]].sort());
		assert.equal(await call(client, derived), `ran ${SLASH_SPACE}`);
	});

	it("keeps a withdrawn tool's alias for its late invocation when a newcomer is named like it", async () => {
		const original = piTool(SLASH_SPACE);
		const newcomer = piTool(derived);
		const served = new ServedToolServer("custom-tools", [original], echo);
		const client = await connect(served);
		const update = served.update([newcomer]);
		assert.ok(update);
		const listed = await listNames(client);
		assert.equal(await update, "relisted");
		assert.equal(listed.length, 1);
		assert.notEqual(listed[0], derived, "the newcomer must not take the withdrawn tool's alias");
		assert.deepEqual([...served.aliases], [[derived, listed[0]]], "the manifest names what is listed");
		assert.equal(await call(client, derived), `ran ${SLASH_SPACE}`, "a late invocation reaches the withdrawn original");
		assert.equal(await call(client, listed[0]), `ran ${derived}`);

		const restored = served.update([original, newcomer]);
		assert.ok(restored, "reactivating the original is a change");
		assert.deepEqual((await listNames(client)).sort(), [derived, listed[0]].sort());
		assert.equal(await restored, "relisted");
		assert.deepEqual([...served.aliases].sort(), [[SLASH_SPACE, derived], [derived, listed[0]]].sort(), "each tool keeps its alias");
	});
});

// --- Provider level: a Claude call on the alias reaches Pi as the original tool ---

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

async function collect(stream) {
	const events = [];
	for await (const event of stream) events.push(event);
	return events;
}

/** Fake Claude Code: lists the bridge's tools over a real MCP transport, names
 *  the target the way CC does (`mcp__<server>__<En(tool)>`), streams a tool_use
 *  under that name and invokes the listed tool with `args`. */
function installFakeClaudeCode(observed, targetPrefix, args) {
	__testSetSdkQueryFactory(({ options }) => {
		let closed = false;
		return {
			async *[Symbol.asyncIterator]() {
				const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
				await options.mcpServers["custom-tools"].instance.connect(serverTransport);
				const client = new Client({ name: "fake-claude-code", version: "1.0.0" });
				await client.connect(clientTransport);
				const listed = (await client.listTools()).tools.map((tool) => tool.name);
				observed.qualified = listed.map((name) => `mcp__custom-tools__${claudeCodeNormalize(name)}`);
				const target = listed.find((name) => claudeCodeNormalize(name).startsWith(targetPrefix));
				const toolUseName = `mcp__custom-tools__${claudeCodeNormalize(target)}`;
				for (const message of [
					{ type: "system", subtype: "init", session_id: "tool-names-session" },
					{ type: "stream_event", event: { type: "message_start", message: { id: "m1", model: model.id, usage: { input_tokens: 1 } } } },
					{ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call-1", name: toolUseName, input: {} } } },
					{ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(args) } } },
					{ type: "stream_event", event: { type: "content_block_stop", index: 0 } },
					{ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } } },
					{ type: "stream_event", event: { type: "message_stop" } },
				]) {
					if (closed) return;
					yield message;
				}
				observed.call = client.callTool({ name: target, arguments: args, _meta: { "claudecode/toolUseId": "call-1" } });
				const result = await observed.call;
				if (closed) return;
				yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call-1", content: result.content }] } };
				yield { type: "stream_event", event: { type: "message_start", message: { id: "m2", model: model.id, usage: { input_tokens: 1 } } } };
				yield { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } };
				yield { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } } };
				yield { type: "stream_event", event: { type: "content_block_stop", index: 0 } };
				yield { type: "stream_event", event: { type: "message_stop" } };
				yield { type: "result", subtype: "success", session_id: "tool-names-session" };
			},
			close() { closed = true; },
			async interrupt() { closed = true; },
		};
	});
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

describe("a Claude call under an alias", () => {
	it("reaches Pi as the original tool with its arguments, and Pi's result goes back to Claude", async () => {
		const observed = {};
		const args = { text: "hello" };
		installFakeClaudeCode(observed, "fake_name_with_space", args);
		const tools = NAMES.map((name) => piTool(name));
		const initial = {
			messages: [
				{ role: "system", content: "test system prompt", toolsAdded: tools, timestamp: 0 },
				{ role: "user", content: "use the tool", timestamp: Date.now() },
			],
		};
		const first = await collect(streamClaudeAgentSdk(model, initial, { sessionId: "tool-names" }));
		for (const name of observed.qualified) assertServable(name);
		const done = first.find((event) => event.type === "done");
		assert.equal(done?.reason, "toolUse", "the call must be handed to Pi");
		const call = done.message.content.find((block) => block.type === "toolCall");
		assert.equal(call?.name, SLASH_SPACE, "Pi receives the original tool name");
		assert.deepEqual(call.arguments, args);

		const second = collect(streamClaudeAgentSdk(model, {
			messages: [
				...initial.messages,
				done.message,
				{ role: "toolResult", toolCallId: "call-1", toolName: SLASH_SPACE, content: [{ type: "text", text: "PI RESULT" }], isError: false, timestamp: Date.now() },
			],
		}, { sessionId: "tool-names" }));
		const result = await observed.call;
		assert.deepEqual(result.content, [{ type: "text", text: "PI RESULT" }]);
		assert.ok((await second).some((event) => event.type === "done"));
	});
});
