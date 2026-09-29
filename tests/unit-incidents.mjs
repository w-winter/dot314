// Bridge incidents: every anomaly the bridge detects becomes an incident with a
// short id, a class, versions and the flight-recorder snapshot of its query. A
// bridge-authored error names its incident, `/pi-claude incidents` lists them,
// and only a user-scoped `incidents.repo` lets the bridge write them to disk.
import "./lib/debug-env.mjs";

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { isContextOverflow, isRetryableAssistantError, Type } from "@earendil-works/pi-ai";

import claudeBridge, { __testSetBridgeIntegrityState, __testSetSdkQueryFactory, streamClaudeAgentSdk } from "../src/index.ts";
import { registerBridgeCommands } from "../src/bridge-commands.ts";
import { setExtensionApi } from "../src/bridge-state.ts";
import { loadConfig, recordProjectTrust } from "../src/config.ts";
import { __testFlushIncidents, __testResetIncidents, recordIncident, withIncident } from "../src/incidents.ts";
import { interruptedToolCallResult, resetStack, strandedToolCallResult } from "../src/query-state.ts";
import { thirdPartyAppRefusal } from "../src/query-options.ts";
import { buildStreamIdleTimeoutErrorMessage } from "../src/stream-idle-watchdog.ts";
import { STEERING_DELIVERY_FAILED_MESSAGE } from "../src/tool-result-delivery.ts";
import { LOST_TOOL_RESULT_TEXT } from "../src/tool-pairing-audit.ts";

// The classifiers of the Pi the owner runs, when installed here.
const INSTALLED_PI_AI = "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/utils";

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
const ARG_SENTINEL = "ARG-SENTINEL-do-not-record";
const PROMPT_SENTINEL = "PROMPT-SENTINEL-do-not-record";
const ARGS = { text: ARG_SENTINEL };
const INCIDENT_SUFFIX = / \(incident (bi-[0-9a-z]{4,6})\)$/;
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tagged = (id) => ({ _meta: { "claudecode/toolUseId": id } });

async function collect(stream) {
	const events = [];
	for await (const event of stream) events.push(event);
	return events;
}

function toolUseMessage(messageId, id) {
	return [
		{ type: "stream_event", event: { type: "message_start", message: { id: messageId, model: model.id, usage: { input_tokens: 1 } } } },
		{ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name: "mcp__custom-tools__echo", input: {} } } },
		{ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(ARGS) } } },
		{ type: "stream_event", event: { type: "content_block_stop", index: 0 } },
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
	{ type: "result", subtype: "success", session_id: "incidents-session" },
];

/** Fake Claude Code with a real MCP client on the bridge's server. */
function installFakeClaudeCode(script) {
	__testSetSdkQueryFactory(({ options }) => {
		let closed = false;
		return {
			async *[Symbol.asyncIterator]() {
				const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
				await options.mcpServers["custom-tools"].instance.connect(serverTransport);
				const client = new Client({ name: "fake-claude-code", version: "1.0.0" });
				await client.connect(clientTransport);
				yield { type: "system", subtype: "init", session_id: "incidents-session", claude_code_version: "9.9.9" };
				for await (const message of script(client)) {
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
			{ role: "user", content: PROMPT_SENTINEL, timestamp: Date.now() },
		],
	};
}

/** Runs one query whose only tools/call reaches the bridge before the stream
 *  records its tool_use and carries no tool_use id: the bridge cannot match it.
 *  Returns what Claude got for that call. */
async function runUnmatchedHandlerRace(sessionId) {
	let call;
	installFakeClaudeCode(async function* (client) {
		call = client.callTool({ name: "echo", arguments: ARGS });
		await call;
		yield* FINAL_REPLY;
	});
	await collect(streamClaudeAgentSdk(model, initialContext(), { sessionId }));
	return call;
}

/** The `/pi-claude` command as Pi runs it; returns what it notified. */
async function piClaude(args) {
	let handler;
	registerBridgeCommands({ registerCommand: (name, command) => { if (name === "pi-claude") handler = command.handler; } });
	const notices = [];
	await handler(args, { ui: { notify: (message, level) => notices.push({ message, level }) }, cwd: process.cwd() });
	assert.equal(notices.length, 1);
	return notices[0].message;
}

async function incidentDetail(id) {
	const text = await piClaude(`incidents ${id}`);
	return JSON.parse(text.slice(text.indexOf("{")));
}

function loadExtension() {
	claudeBridge({
		on: () => {},
		registerCommand: () => {},
		registerProvider: () => {},
		events: { emit: () => {} },
		appendEntry: () => {},
	});
}

let agentDir;
let startDir;
beforeEach(() => {
	startDir = process.cwd();
	agentDir = mkdtempSync(join(tmpdir(), "bridge-incidents-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT = "0";
	process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token";
	process.env.CLAUDE_BRIDGE_DIAG_PATH = join(agentDir, "diag.log");
	resetStack();
	__testResetIncidents();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: { notify: () => {} } });
	setExtensionApi({ events: { emit: () => {} }, appendEntry: () => {} });
});

afterEach(() => {
	process.chdir(startDir);
	delete process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT;
	delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
	delete process.env.CLAUDE_BRIDGE_DIAG_PATH;
	__testSetSdkQueryFactory();
	setExtensionApi(undefined);
	resetStack();
	__testResetIncidents();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
	rmSync(agentDir, { recursive: true, force: true });
});

describe("bridge incidents", () => {
	it("names the incident in Claude's error for an unmatched tools/call, with a snapshot of the race", async () => {
		const result = await runUnmatchedHandlerRace("incident-unmatched");
		assert.equal(result.isError, true);
		const text = result.content[0].text;
		assert.match(text, /^Claude bridge internal error: no matching tool_call id for echo \(incident bi-[0-9a-z]{4,6}\)$/);
		const id = text.match(INCIDENT_SUFFIX)[1];

		const incident = await incidentDetail(id);
		assert.equal(incident.id, id);
		assert.equal(incident.signature, "tool_handler_unmatched@mcpToolHandler");
		assert.equal(incident.class, "user-visible");
		assert.equal(incident.count, 1);
		assert.equal(incident.versions.claudeCode, "9.9.9");
		assert.equal(incident.model, model.id);
		const kinds = incident.snapshot.map((record) => record.kind);
		const arrival = kinds.indexOf("tools_call");
		assert.ok(arrival > kinds.indexOf("query_start"), `the query started first: ${kinds.join(",")}`);
		assert.ok(kinds.indexOf("claim_unmatched") > arrival, `the claim failed after the call arrived: ${kinds.join(",")}`);
		assert.ok(!kinds.slice(0, arrival).includes("content_block_start"), `no tool_use was streamed before the call: ${kinds.join(",")}`);
		assert.deepEqual(incident.diag.argKeys, ["text"]);
	});

	it("counts an expected interruption without naming it to Claude", async () => {
		let call;
		const controller = new AbortController();
		installFakeClaudeCode(async function* (client) {
			yield* toolUseMessage("m1", "toolu_abort");
			call = client.callTool({ name: "echo", arguments: ARGS, ...tagged("toolu_abort") });
			await call;
		});
		const events = await collect(streamClaudeAgentSdk(model, initialContext(), { sessionId: "incident-abort", signal: controller.signal }));
		assert.equal(events.find((event) => event.type === "done")?.reason, "toolUse");
		await settle(20);
		controller.abort();
		const result = await call;
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /the turn was aborted/);
		assert.doesNotMatch(result.content[0].text, /incident/);

		const list = await piClaude("incidents");
		const line = list.split("\n").find((entry) => entry.includes("tool_calls_interrupted@abort"));
		assert.ok(line, list);
		assert.match(line, /\bexpected\b/);
		assert.match(line, /×1\b/);
	});

	it("writes nothing to disk without incidents.repo", async () => {
		loadExtension();
		const text = (await runUnmatchedHandlerRace("incident-disabled")).content[0].text;
		const id = text.match(INCIDENT_SUFFIX)[1];
		await __testFlushIncidents();
		assert.equal(existsSync(join(agentDir, "claude-bridge-incidents.jsonl")), false);
		assert.match(await piClaude("incidents"), new RegExp(id));
	});

	it("does not let a trusted project's config enable the store", async () => {
		const project = join(agentDir, "project");
		mkdirSync(join(project, ".pi"), { recursive: true });
		writeFileSync(join(project, ".pi", "claude-bridge.json"), JSON.stringify({ incidents: { repo: "someone/elsewhere" } }));
		recordProjectTrust({ cwd: project, isProjectTrusted: () => true });
		process.chdir(project);
		assert.equal(loadConfig(project).incidents, undefined);
		loadExtension();
		const text = (await runUnmatchedHandlerRace("incident-project")).content[0].text;
		assert.match(text, INCIDENT_SUFFIX);
		await __testFlushIncidents();
		assert.equal(existsSync(join(agentDir, "claude-bridge-incidents.jsonl")), false);
		assert.equal(existsSync(join(project, ".pi", "claude-bridge-incidents.jsonl")), false);
	});

	it("stores metadata only, mode 0600, when the user config names a repo", async () => {
		writeFileSync(join(agentDir, "claude-bridge.json"), JSON.stringify({ incidents: { repo: "owner/bridge-incidents" } }));
		assert.deepEqual(loadConfig(process.cwd()).incidents, { repo: "owner/bridge-incidents" });
		loadExtension();
		const text = (await runUnmatchedHandlerRace("incident-enabled")).content[0].text;
		const id = text.match(INCIDENT_SUFFIX)[1];
		await __testFlushIncidents();
		const path = join(agentDir, "claude-bridge-incidents.jsonl");
		assert.equal(statSync(path).mode & 0o777, 0o600);
		const raw = readFileSync(path, "utf8");
		assert.ok(!raw.includes(ARG_SENTINEL), "no tool-argument text");
		assert.ok(!raw.includes(PROMPT_SENTINEL), "no prompt text");
		const lines = raw.trim().split("\n").map((line) => JSON.parse(line));
		const stored = lines.find((line) => line.id === id);
		assert.equal(stored.signature, "tool_handler_unmatched@mcpToolHandler");
		assert.equal(stored.class, "user-visible");
		assert.equal(stored.count, 1);
		assert.ok(Array.isArray(stored.snapshot) && stored.snapshot.length > 0);
	});

	it("records a Claude Code version other than the stored one as an external incident", async () => {
		writeFileSync(join(agentDir, "claude-bridge.json"), JSON.stringify({ incidents: { repo: "owner/bridge-incidents" } }));
		writeFileSync(join(agentDir, "claude-bridge-incidents.jsonl"), `${JSON.stringify({ type: "claude_code_version", version: "9.9.8" })}\n`, { mode: 0o600 });
		loadExtension();
		installFakeClaudeCode(async function* () { yield* FINAL_REPLY; });
		await collect(streamClaudeAgentSdk(model, initialContext(), { sessionId: "incident-version" }));
		await __testFlushIncidents();
		const line = (await piClaude("incidents")).split("\n").find((entry) => entry.includes("claude_code_version_changed@init"));
		assert.ok(line, "the version change is an incident");
		assert.match(line, /\bexternal\b/);
		const incident = await incidentDetail(line.split(/\s+/)[0]);
		assert.deepEqual(incident.diag, { previousVersion: "9.9.8", version: "9.9.9" });
		const stored = readFileSync(join(agentDir, "claude-bridge-incidents.jsonl"), "utf8").trim().split("\n").map((entry) => JSON.parse(entry));
		assert.equal(stored.at(-1).type, "claude_code_version");
		assert.equal(stored.at(-1).version, "9.9.9");
	});

	it("records a Claude Code API error as an external incident without its text", async () => {
		const apiText = "API Error: 400 private-detail-from-the-api";
		installFakeClaudeCode(async function* () {
			yield { type: "result", subtype: "error_during_execution", is_error: true, errors: [apiText], session_id: "incidents-session" };
		});
		const events = await collect(streamClaudeAgentSdk(model, initialContext(), { sessionId: "incident-api-error" }));
		assert.equal(events.at(-1).type, "error");
		const line = (await piClaude("incidents")).split("\n").find((entry) => entry.includes("api_error@consumeQuery"));
		assert.ok(line, "the API error is an incident");
		assert.match(line, /\bexternal\b/);
		const incident = await incidentDetail(line.split(/\s+/)[0]);
		assert.equal(incident.diag.subtype, "error_during_execution");
		assert.ok(!JSON.stringify(incident).includes("private-detail"), "no API error text");
	});

	it("keeps Pi's retry and overflow classification of every error text it changes", async () => {
		const classifiers = [{ isRetryableAssistantError, isContextOverflow }];
		if (existsSync(join(INSTALLED_PI_AI, "retry.js"))) {
			const { isRetryableAssistantError: retry } = await import(join(INSTALLED_PI_AI, "retry.js"));
			const { isContextOverflow: overflow } = await import(join(INSTALLED_PI_AI, "overflow.js"));
			classifiers.push({ isRetryableAssistantError: retry, isContextOverflow: overflow });
		}
		const docsPrompt = "see docs/custom-provider.md and docs/packages.md";
		const texts = [
			"Claude bridge internal error: no matching tool_call id for echo",
			"Tool echo is no longer active in Pi.",
			"Claude bridge: tool call toolu_1 (echo) was already answered and its result already returned. This repeated invocation did not run the tool.",
			"Claude bridge internal error: tool call toolu_1 was issued for read, not echo",
			"Claude bridge internal error: 1 tool result(s) did not match any registered tool_call id. The turn was stopped to avoid delivering tool output to the wrong call. Unmatched ids: toolu_1",
			strandedToolCallResult().content[0].text,
			interruptedToolCallResult("query-end").content[0].text,
			interruptedToolCallResult("stream-idle-timeout").content[0].text,
			STEERING_DELIVERY_FAILED_MESSAGE,
			LOST_TOOL_RESULT_TEXT,
			buildStreamIdleTimeoutErrorMessage(90_000),
			thirdPartyAppRefusal({ prompt: docsPrompt, source: "caller" }, {}),
			thirdPartyAppRefusal({ prompt: docsPrompt, source: "pi" }, {}),
			thirdPartyAppRefusal({ prompt: docsPrompt, source: "pi" }, { systemPrompt: { replacement: "x" } }),
		];
		const message = (errorMessage) => ({
			role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "error", timestamp: 0, errorMessage,
		});
		// Real incident ids, enough of them that an id able to spell a status
		// code Pi retries on (429, 500, 503, ...) would show up.
		const incidents = Array.from({ length: 20_000 }, (_, i) => recordIncident(`classification_probe_${i}@test`, "user-visible", {}));
		for (const text of texts) {
			for (const { isRetryableAssistantError: retry, isContextOverflow: overflow } of classifiers) {
				const before = [retry(message(text)), overflow(message(text), model.contextWindow)];
				for (const incident of incidents) {
					const changed = withIncident(text, incident);
					assert.match(changed, INCIDENT_SUFFIX);
					const after = [retry(message(changed)), overflow(message(changed), model.contextWindow)];
					if (after[0] !== before[0] || after[1] !== before[1]) assert.fail(`${incident.id} changes the classification of: ${text}`);
				}
			}
		}
	});
});
