// Claude must see each Pi tool's real JSON Schema, and Pi (which validates
// every call against that schema) must decide what is valid. The bridge used
// to convert the schema to Zod, which lost $ref/$defs, unions, nullable types,
// integer and most constraints, and the SDK then validated calls against that
// lossy Zod before Pi saw them. Now tools/list advertises the schema the way
// Pi's native Anthropic provider declares it (plus the root keywords its
// properties depend on), and the registered input passes every argument
// through unchanged.
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
import { isDraft2020Schema } from "../src/json-schema-2020.ts";
import { advertisedInputSchema, ServedToolServer } from "../src/served-tools.ts";

/** An MCP-style schema (pi-mcp-adapter hands these to Pi verbatim). */
const RICH_SCHEMA = {
	type: "object",
	description: "root description (Pi's native declaration drops it)",
	$defs: {
		Point: {
			type: "object",
			properties: { x: { type: "integer" }, y: { type: "integer" } },
			required: ["x", "y"],
			additionalProperties: false,
		},
	},
	properties: {
		at: { $ref: "#/$defs/Point" },
		shape: {
			oneOf: [
				{ type: "object", properties: { kind: { const: "circle" }, r: { type: "number", minimum: 0 } }, required: ["kind", "r"] },
				{ type: "object", properties: { kind: { const: "square" }, side: { type: "number", exclusiveMinimum: 0 } }, required: ["kind", "side"] },
			],
		},
		label: { type: ["string", "null"], format: "email", maxLength: 64 },
		count: { type: "integer", minimum: 1, maximum: 10 },
		tags: { type: "object", additionalProperties: { type: "string", maxLength: 5 } },
		mode: { enum: ["fast", 2, null] },
	},
	required: ["at", "shape", "count"],
	additionalProperties: false,
};

/** Pi's native Anthropic declaration (pi-ai convertTools: type, properties,
 *  required) plus the root keywords the properties depend on. */
const RICH_ADVERTISED = {
	type: "object",
	properties: RICH_SCHEMA.properties,
	required: RICH_SCHEMA.required,
	$defs: RICH_SCHEMA.$defs,
	additionalProperties: false,
};

const TYPEBOX_PARAMETERS = Type.Object({
	path: Type.String({ description: "File to read" }),
	limit: Type.Optional(Type.Integer({ minimum: 1 })),
	mode: Type.Union([Type.Literal("a"), Type.Literal("b")]),
	note: Type.Union([Type.String(), Type.Null()]),
	meta: Type.Record(Type.String(), Type.Number()),
});

const VALID_ARGS = {
	at: { x: 1, y: 2 },
	shape: { kind: "square", side: 3 },
	label: null,
	count: 4,
	tags: { a: "b", c: "d" },
	mode: 2,
};
const INVALID_ARGS = {
	at: "{\"x\": 1, \"y\": 2}",
	shape: { kind: "hexagon", nested: { deep: [1, { deeper: true }] } },
	label: "null",
	count: "many", // the old Zod conversion rejected this before Pi saw it
	tags: { a: 7 },
	unexpected: { extra: ["kept"] },
};

const richTool = { name: "draw", description: "Draws a shape", parameters: RICH_SCHEMA };

async function connect(instance) {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await instance.connect(serverTransport);
	const client = new Client({ name: "test-client", version: "1.0.0" });
	await client.connect(clientTransport);
	return client;
}

describe("the schema Claude sees", () => {
	it("advertises the tool's own schema in tools/list, as Pi's native Anthropic provider declares it", async () => {
		const received = [];
		const served = new ServedToolServer("custom-tools", [richTool, { name: "read", description: "Read", parameters: TYPEBOX_PARAMETERS }], () => async (args) => {
			received.push(args);
			return { content: [{ type: "text", text: "ok" }] };
		});
		const client = await connect(served.config.instance);
		const listed = (await client.listTools()).tools;
		assert.deepEqual(listed.find((tool) => tool.name === "draw").inputSchema, RICH_ADVERTISED);
		const typebox = JSON.parse(JSON.stringify(TYPEBOX_PARAMETERS));
		assert.deepEqual(listed.find((tool) => tool.name === "read").inputSchema, { type: "object", properties: typebox.properties, required: typebox.required });
	});

	it("keeps the advertised schema when a tool is added mid-query", async () => {
		const served = new ServedToolServer("custom-tools", [{ name: "read", description: "Read", parameters: TYPEBOX_PARAMETERS }], () => async () => ({ content: [] }));
		const client = await connect(served.config.instance);
		const update = served.update([{ name: "read", description: "Read", parameters: TYPEBOX_PARAMETERS }, richTool]);
		assert.deepEqual((await client.listTools()).tools.find((tool) => tool.name === "draw").inputSchema, RICH_ADVERTISED);
		assert.equal(await update, "relisted");
	});

	it("drops root combinators, which make Claude Code skip the tool", async () => {
		const parameters = { ...RICH_SCHEMA, anyOf: [{ required: ["label"] }, { required: ["tags"] }], allOf: [{ required: ["at"] }] };
		const served = new ServedToolServer("custom-tools", [{ ...richTool, parameters }], () => async () => ({ content: [] }));
		const client = await connect(served.config.instance);
		assert.deepEqual((await client.listTools()).tools[0].inputSchema, RICH_ADVERTISED);
	});

	it("advertises a part the API would reject without its schema, so the session keeps working, and Pi still gets the arguments", async () => {
		// Real Pi + Claude Code 2.1.283 + Haiku 4.5, each schema verbatim:
		// "API Error: 400 tools.N.custom.input_schema: JSON schema is invalid. It
		// must match JSON Schema draft 2020-12", on every request of the session.
		const received = [];
		const parameters = {
			type: "object",
			$defs: { Bad: { type: "object", required: true }, Good: { type: "string" } },
			properties: {
				n: { type: "number", minimum: 0, exclusiveMinimum: true, description: "A positive number" }, // draft-04
				pair: { type: "array", items: [{ type: "string" }, { type: "number" }], description: "[name, value]" }, // draft-07 tuple
				bad: { $ref: "#/$defs/Bad" },
				name: { $ref: "#/$defs/Good", description: "kept as it is" },
			},
			required: ["n", "pair"],
			additionalProperties: { type: "any" },
		};
		const served = new ServedToolServer("custom-tools", [{ name: "legacy", description: "Legacy MCP tool", parameters }], () => async (args) => {
			received.push(args);
			return { content: [{ type: "text", text: "ok" }] };
		});
		const client = await connect(served.config.instance);
		const [listed] = (await client.listTools()).tools;
		assert.equal(listed.description, "Legacy MCP tool");
		assert.deepEqual(listed.inputSchema, {
			type: "object",
			properties: {
				n: { description: "A positive number" },
				pair: { description: "[name, value]" },
				bad: { $ref: "#/$defs/Bad" },
				name: { $ref: "#/$defs/Good", description: "kept as it is" },
			},
			required: ["n", "pair"],
			$defs: { Bad: {}, Good: { type: "string" } },
		});
		assert.ok(isDraft2020Schema(listed.inputSchema));
		const args = { n: 5, pair: ["a", 1], bad: { any: "thing" } };
		assert.equal((await client.callTool({ name: "legacy", arguments: args })).content[0].text, "ok");
		assert.deepEqual(received, [args]);
		assert.deepEqual(advertisedInputSchema(RICH_SCHEMA), RICH_ADVERTISED, "a valid schema is advertised unchanged");
	});
});

describe("the JSON Schema 2020-12 check", () => {
	it("accepts what the 2020-12 meta-schema accepts, including earlier drafts' compatible keywords", () => {
		for (const schema of [
			RICH_SCHEMA,
			JSON.parse(JSON.stringify(TYPEBOX_PARAMETERS)),
			true,
			false,
			{},
			{ $schema: "http://json-schema.org/draft-07/schema#", definitions: { A: { type: "string" } }, properties: { a: { $ref: "#/definitions/A" } } },
			{ dependencies: { a: ["b"], c: { required: ["d"] } }, id: "legacy-id", nullable: true, "x-vendor": { items: [1] } },
			{ type: "array", prefixItems: [{ type: "string" }], items: false, minItems: 0, uniqueItems: true },
			{ type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1.5, multipleOf: 0.5 },
			{ enum: [], const: { items: [] }, examples: [{ items: [] }], default: { minimum: true } },
			{ patternProperties: { "^x-": {} }, dependentRequired: { a: [] }, if: { required: ["a"] }, then: true, else: false },
		]) {
			assert.equal(isDraft2020Schema(schema), true, JSON.stringify(schema));
		}
	});

	it("rejects what the 2020-12 meta-schema rejects, at any depth", () => {
		for (const schema of [
			{ type: "number", minimum: 0, exclusiveMinimum: true },
			{ type: "number", maximum: 9, exclusiveMaximum: false },
			{ type: "array", items: [{ type: "string" }] },
			{ type: "any" },
			{ type: [] },
			{ type: ["string", "string"] },
			{ properties: { a: { type: "string", required: true } } },
			{ required: ["a", "a"] },
			{ enum: "a" },
			{ minLength: -1 },
			{ minItems: 1.5 },
			{ multipleOf: 0 },
			{ anyOf: [] },
			{ properties: [] },
			{ $id: "schema#fragment" },
			{ $anchor: "1bad" },
			{ oneOf: [{ type: "object", properties: { deep: { items: [true] } } }] },
			{ $defs: { A: { not: "string" } } },
			null,
			"string",
			[],
		]) {
			assert.equal(isDraft2020Schema(schema), false, JSON.stringify(schema));
		}
	});
});

describe("the arguments Pi receives", () => {
	for (const [label, args] of [["valid nested and union-shaped", VALID_ARGS], ["invalid and extra", INVALID_ARGS]]) {
		it(`passes ${label} arguments to the handler unchanged`, async () => {
			const received = [];
			const served = new ServedToolServer("custom-tools", [richTool], () => async (input) => {
				received.push(input);
				return { content: [{ type: "text", text: "ok" }] };
			});
			const client = await connect(served.config.instance);
			const result = await client.callTool({ name: "draw", arguments: args });
			assert.notEqual(result.isError, true, "the MCP layer must not reject arguments; Pi decides");
			assert.deepEqual(received, [args]);
		});
	}
});

// --- Provider level: Claude's arguments reach Pi and Pi's verdict reaches Claude ---

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

/** Fake Claude Code: lists tools over a real MCP transport, streams a tool_use
 *  for `draw` with `args`, and invokes it with the same arguments. */
function installFakeClaudeCode(observed, args) {
	__testSetSdkQueryFactory(({ options }) => {
		let closed = false;
		return {
			async *[Symbol.asyncIterator]() {
				const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
				await options.mcpServers["custom-tools"].instance.connect(serverTransport);
				const client = new Client({ name: "fake-claude-code", version: "1.0.0" });
				await client.connect(clientTransport);
				observed.listed = (await client.listTools()).tools;
				for (const message of [
					{ type: "system", subtype: "init", session_id: "tool-schemas-session" },
					{ type: "stream_event", event: { type: "message_start", message: { id: "m1", model: model.id, usage: { input_tokens: 1 } } } },
					{ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call-1", name: "mcp__custom-tools__draw", input: {} } } },
					{ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(args) } } },
					{ type: "stream_event", event: { type: "content_block_stop", index: 0 } },
					{ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } } },
					{ type: "stream_event", event: { type: "message_stop" } },
				]) {
					if (closed) return;
					yield message;
				}
				observed.call = client.callTool({ name: "draw", arguments: args, _meta: { "claudecode/toolUseId": "call-1" } });
				const result = await observed.call;
				if (closed) return;
				yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call-1", content: result.content, is_error: result.isError === true }] } };
				yield { type: "stream_event", event: { type: "message_start", message: { id: "m2", model: model.id, usage: { input_tokens: 1 } } } };
				yield { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } };
				yield { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } } };
				yield { type: "stream_event", event: { type: "content_block_stop", index: 0 } };
				yield { type: "stream_event", event: { type: "message_stop" } };
				yield { type: "result", subtype: "success", session_id: "tool-schemas-session" };
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

async function callThroughProvider(sessionId, args, piResult) {
	const observed = {};
	installFakeClaudeCode(observed, args);
	const initial = {
		messages: [
			{ role: "system", content: "test system prompt", toolsAdded: [richTool], timestamp: 0 },
			{ role: "user", content: "draw", timestamp: Date.now() },
		],
	};
	const first = await collect(streamClaudeAgentSdk(model, initial, { sessionId }));
	const done = first.find((event) => event.type === "done");
	assert.equal(done?.reason, "toolUse", "the call must be handed to Pi");
	const call = done.message.content.find((block) => block.type === "toolCall");
	const second = collect(streamClaudeAgentSdk(model, {
		messages: [
			...initial.messages,
			done.message,
			{ role: "toolResult", toolCallId: "call-1", toolName: "draw", timestamp: Date.now(), ...piResult },
		],
	}, { sessionId }));
	const result = await observed.call;
	assert.ok((await second).some((event) => event.type === "done"));
	return { observed, call, result };
}

describe("a call through the provider", () => {
	it("hands Pi valid nested arguments unchanged and returns Pi's result", async () => {
		const { observed, call, result } = await callThroughProvider("tool-schemas-valid", VALID_ARGS, { content: [{ type: "text", text: "drawn" }], isError: false });
		assert.deepEqual(observed.listed[0].inputSchema, RICH_ADVERTISED);
		assert.equal(call.name, "draw");
		assert.deepEqual(call.arguments, VALID_ARGS);
		assert.deepEqual(result.content, [{ type: "text", text: "drawn" }]);
	});

	it("hands Pi invalid arguments too, and Pi's validation error is what Claude gets", async () => {
		const piError = "Validation failed for tool \"draw\":\n  - at: must be object";
		const { call, result } = await callThroughProvider("tool-schemas-invalid", INVALID_ARGS, { content: [{ type: "text", text: piError }], isError: true });
		assert.deepEqual(call.arguments, INVALID_ARGS, "Pi validates the arguments exactly as Claude sent them");
		assert.equal(result.isError, true);
		assert.deepEqual(result.content, [{ type: "text", text: piError }]);
	});
});
