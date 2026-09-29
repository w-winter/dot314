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

import claudeBridge, { __testSetBridgeIntegrityState, __testSetSdkQueryFactory, streamClaudeAgentSdk, wrapClaudeSpawnErrorForSdk } from "../src/index.ts";
import { CLAUDE_ACCOUNT_ROUTER_SYMBOL } from "../src/account-router.ts";
import { registerBridgeCommands } from "../src/bridge-commands.ts";
import { setExtensionApi } from "../src/bridge-state.ts";
import { loadConfig, recordProjectTrust } from "../src/config.ts";
import { DEBUG_LOG_MAX_BYTES } from "../src/debug.ts";
import { __testFlushIncidents, __testResetIncidents, nameBridgeErrorEvents, nameThrownBridgeError, recordIncident, withIncident } from "../src/incidents.ts";
import { interruptedToolCallResult, resetStack, strandedToolCallResult } from "../src/query-state.ts";
import { thirdPartyAppRefusal } from "../src/query-options.ts";
import { buildStreamIdleTimeoutErrorMessage } from "../src/stream-idle-watchdog.ts";
import { STEERING_DELIVERY_FAILED_MESSAGE } from "../src/tool-result-delivery.ts";
import { LOST_TOOL_RESULT_TEXT } from "../src/tool-pairing-audit.ts";

// The classifiers of the Pi the owner runs, when installed here.
const INSTALLED_PI_AI = "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/utils";
// The agent loop of the Pi the owner runs, when installed here.
const INSTALLED_PI_AGENT = "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/agent.js";
const CREDENTIAL_KEYS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_USE_ANTHROPIC_AWS", "CLAUDE_CODE_USE_MANTLE", "CLAUDE_CONFIG_DIR"];

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
// A tool whose argument property names are free text supplied by the caller.
const DICTIONARY = { name: "dictionary", description: "Stores entries", parameters: Type.Record(Type.String(), Type.String()) };
const ARG_SENTINEL = "ARG-SENTINEL-do-not-record";
const KEY_SENTINEL = "KEY SENTINEL private text used as a property name";
const PROMPT_SENTINEL = "PROMPT-SENTINEL-do-not-record";
const ARGS = { text: ARG_SENTINEL };
const INCIDENT_SUFFIX = / \(incident (bi-[0-9a-z]{4,6})\)$/;
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tagged = (id) => ({ _meta: { "claudecode/toolUseId": id } });

/** Pi's retry and overflow classifiers: this worktree's pi-ai, and the
 *  installed Pi 0.87.1's when present. */
async function piClassifiers() {
	const classifiers = [{ isRetryableAssistantError, isContextOverflow }];
	if (existsSync(join(INSTALLED_PI_AI, "retry.js"))) {
		classifiers.push({
			isRetryableAssistantError: (await import(join(INSTALLED_PI_AI, "retry.js"))).isRetryableAssistantError,
			isContextOverflow: (await import(join(INSTALLED_PI_AI, "overflow.js"))).isContextOverflow,
		});
	}
	return classifiers;
}

/** Asserts `error` (a Pi error message) is classified exactly as it is
 *  without its incident suffix. */
async function assertClassificationKept(error) {
	const unnamed = { ...error, errorMessage: error.errorMessage.replace(INCIDENT_SUFFIX, "") };
	assert.notEqual(unnamed.errorMessage, error.errorMessage);
	for (const { isRetryableAssistantError: retry, isContextOverflow: overflow } of await piClassifiers()) {
		assert.equal(retry(error), retry(unnamed));
		assert.equal(overflow(error, model.contextWindow), overflow(unnamed, model.contextWindow));
	}
}

/** Runs `run` logged out: no credential variables, an empty Claude config
 *  dir, and a non-darwin platform (the Keychain is not assumed to hold a
 *  login). */
async function loggedOut(run) {
	const saved = new Map(CREDENTIAL_KEYS.map((key) => [key, process.env[key]]));
	const platform = Object.getOwnPropertyDescriptor(process, "platform");
	const claudeDir = mkdtempSync(join(agentDir, "claude-logged-out-"));
	try {
		for (const key of CREDENTIAL_KEYS) delete process.env[key];
		process.env.CLAUDE_CONFIG_DIR = claudeDir;
		Object.defineProperty(process, "platform", { ...platform, value: "linux" });
		return await run();
	} finally {
		Object.defineProperty(process, "platform", platform);
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

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
function installFakeClaudeCode(script, claudeCodeVersion = "9.9.9") {
	__testSetSdkQueryFactory(({ options }) => {
		let closed = false;
		return {
			async *[Symbol.asyncIterator]() {
				const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
				await options.mcpServers["custom-tools"].instance.connect(serverTransport);
				const client = new Client({ name: "fake-claude-code", version: "1.0.0" });
				await client.connect(clientTransport);
				yield { type: "system", subtype: "init", session_id: "incidents-session", claude_code_version: claudeCodeVersion };
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

function initialContext(tool = ECHO) {
	return {
		messages: [
			{ role: "system", content: "test system prompt", toolsAdded: [tool], timestamp: 0 },
			{ role: "user", content: PROMPT_SENTINEL, timestamp: Date.now() },
		],
	};
}

/** Runs one query whose only tools/call reaches the bridge before the stream
 *  records its tool_use and carries no tool_use id: the bridge cannot match it.
 *  Returns what Claude got for that call. */
async function runUnmatchedHandlerRace(sessionId, { tool = ECHO, args = ARGS, claudeCodeVersion } = {}) {
	let call;
	installFakeClaudeCode(async function* (client) {
		call = client.callTool({ name: tool.name, arguments: args });
		await call;
		yield* FINAL_REPLY;
	}, claudeCodeVersion);
	await collect(streamClaudeAgentSdk(model, initialContext(tool), { sessionId }));
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
		registerTool: () => {},
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
		assert.equal(incident.diag.argKeyCount, 1);
	});

	it("keeps tool-argument property names and values out of the incident and the store", async () => {
		writeFileSync(join(agentDir, "claude-bridge.json"), JSON.stringify({ incidents: { repo: "owner/bridge-incidents" } }));
		loadExtension();
		const text = (await runUnmatchedHandlerRace("incident-dictionary", { tool: DICTIONARY, args: { [KEY_SENTINEL]: ARG_SENTINEL } })).content[0].text;
		const incident = await incidentDetail(text.match(INCIDENT_SUFFIX)[1]);
		assert.equal(incident.signature, "tool_handler_unmatched@mcpToolHandler");
		assert.equal(incident.diag.toolName, "dictionary");
		await __testFlushIncidents();
		const stored = readFileSync(join(agentDir, "claude-bridge-incidents.jsonl"), "utf8");
		for (const [where, raw] of [["incident", JSON.stringify(incident)], ["store", stored]]) {
			assert.ok(!raw.includes("KEY SENTINEL"), `no tool-argument property name in the ${where}`);
			assert.ok(!raw.includes(ARG_SENTINEL), `no tool-argument value in the ${where}`);
		}
		assert.equal(incident.diag.argKeyCount, 1, "the argument shape survives as a count");
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

	it("still sees a Claude Code version change after the store rotated", async () => {
		const path = join(agentDir, "claude-bridge-incidents.jsonl");
		const filler = `${JSON.stringify({ type: "count", id: "bi-abcd", signature: "stream_idle_timeout@streamIdleWatchdog", class: "user-visible", count: 1 })}\n`;
		writeFileSync(path, JSON.stringify({ type: "claude_code_version", version: "9.9.8" }) + "\n" + filler.repeat(Math.ceil(DEBUG_LOG_MAX_BYTES / filler.length)), { mode: 0o600 });
		writeFileSync(join(agentDir, "claude-bridge.json"), JSON.stringify({ incidents: { repo: "owner/bridge-incidents" } }));
		loadExtension();
		await runUnmatchedHandlerRace("incident-rotate-1", { claudeCodeVersion: "9.9.8" });
		await __testFlushIncidents();
		assert.ok(existsSync(`${path}.1`), "the store rotated");

		// A later process on the same store sees Claude Code 9.9.9.
		__testResetIncidents();
		loadExtension();
		installFakeClaudeCode(async function* () { yield* FINAL_REPLY; }, "9.9.9");
		await collect(streamClaudeAgentSdk(model, initialContext(), { sessionId: "incident-rotate-2" }));
		await __testFlushIncidents();
		const line = (await piClaude("incidents")).split("\n").find((entry) => entry.includes("claude_code_version_changed@init"));
		assert.ok(line, "the version change is an incident after rotation");
		assert.deepEqual((await incidentDetail(line.split(/\s+/)[0])).diag, { previousVersion: "9.9.8", version: "9.9.9" });
	});

	it("names an incident in the disconnected-account error without changing how Pi classifies it", async () => {
		const credentialKeys = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_USE_ANTHROPIC_AWS", "CLAUDE_CODE_USE_MANTLE", "CLAUDE_CONFIG_DIR"];
		const saved = new Map(credentialKeys.map((key) => [key, process.env[key]]));
		const platform = Object.getOwnPropertyDescriptor(process, "platform");
		const claudeDir = join(agentDir, "claude-logged-out");
		mkdirSync(claudeDir);
		try {
			for (const key of credentialKeys) delete process.env[key];
			process.env.CLAUDE_CONFIG_DIR = claudeDir;
			// Off darwin the Keychain is not assumed to hold a login.
			Object.defineProperty(process, "platform", { ...platform, value: "linux" });
			__testSetSdkQueryFactory(() => { throw new Error("a disconnected account must not start Claude Code"); });
			const events = await collect(streamClaudeAgentSdk(model, initialContext(), { sessionId: "incident-disconnected" }));
			const error = events.at(-1).error;
			assert.match(error.errorMessage, /^Claude account not connected .* and retry\. \(incident bi-[0-9a-z]{4,6}\)$/);
			const incident = await incidentDetail(error.errorMessage.match(INCIDENT_SUFFIX)[1]);
			assert.equal(incident.signature, "claude_account_not_connected@streamRequestInLane");
			assert.equal(incident.class, "user-visible");
			const classifiers = [{ isRetryableAssistantError, isContextOverflow }];
			if (existsSync(join(INSTALLED_PI_AI, "retry.js"))) {
				classifiers.push({
					isRetryableAssistantError: (await import(join(INSTALLED_PI_AI, "retry.js"))).isRetryableAssistantError,
					isContextOverflow: (await import(join(INSTALLED_PI_AI, "overflow.js"))).isContextOverflow,
				});
			}
			const unnamed = { ...error, errorMessage: error.errorMessage.replace(INCIDENT_SUFFIX, "") };
			for (const { isRetryableAssistantError: retry, isContextOverflow: overflow } of classifiers) {
				assert.equal(retry(error), retry(unnamed));
				assert.equal(retry(error), false, "a disconnected account is not retried");
				assert.equal(overflow(error, model.contextWindow), overflow(unnamed, model.contextWindow));
			}
		} finally {
			Object.defineProperty(process, "platform", platform);
			for (const [key, value] of saved) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	it("records a Claude Code API error as an external incident without its text", async () => {
		const apiText = "API Error: 400 private-detail-from-the-api";
		installFakeClaudeCode(async function* () {
			yield { type: "result", subtype: "error_during_execution", is_error: true, errors: [apiText], session_id: "incidents-session" };
		});
		const events = await collect(streamClaudeAgentSdk(model, initialContext(), { sessionId: "incident-api-error" }));
		assert.equal(events.at(-1).type, "error");
		assert.equal(events.at(-1).error.errorMessage, apiText, "an error Claude Code or the API wrote reaches Pi unchanged");
		const line = (await piClaude("incidents")).split("\n").find((entry) => entry.includes("api_error@consumeQuery"));
		assert.ok(line, "the API error is an incident");
		assert.match(line, /\bexternal\b/);
		const incident = await incidentDetail(line.split(/\s+/)[0]);
		assert.equal(incident.diag.subtype, "error_during_execution");
		assert.ok(!JSON.stringify(incident).includes("private-detail"), "no API error text");
	});

	it("names an incident in a bridge-authored error thrown before the query, keeping its fields", async () => {
		const missing = join(agentDir, "PATH-SENTINEL-missing-claude");
		writeFileSync(join(agentDir, "claude-bridge.json"), JSON.stringify({ provider: { pathToClaudeCodeExecutable: missing } }));
		__testSetSdkQueryFactory(() => { throw new Error("a failed preflight must not start Claude Code"); });
		let thrown;
		try {
			streamClaudeAgentSdk(model, initialContext(), { sessionId: "incident-preflight" });
		} catch (error) {
			thrown = error;
		}
		assert.ok(thrown, "the preflight throws");
		assert.match(thrown.message, /^Claude Code executable preflight failed: .* \(incident bi-[0-9a-z]{4,6}\)$/);
		assert.equal(thrown.name, "ClaudeExecutablePreflightError");
		assert.equal(thrown.code, "ENOENT");
		assert.equal(thrown.path, missing);
		assert.equal(thrown.message.match(/ \(incident /g).length, 1);

		const incident = await incidentDetail(thrown.message.match(INCIDENT_SUFFIX)[1]);
		assert.equal(incident.signature, "bridge_error@provider-throw");
		assert.equal(incident.class, "user-visible");
		assert.equal(incident.model, model.id);
		assert.equal(incident.phase, "before-query");
		assert.equal(incident.snapshot, null);
		assert.equal(incident.diag.code, "ENOENT");
		assert.ok(!JSON.stringify(incident).includes("PATH-SENTINEL"), "no error text or path in the incident");

		// What Pi's own agent loop makes of it: an error message carrying the id.
		const failure = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "error", timestamp: 0, errorMessage: thrown.message };
		if (existsSync(INSTALLED_PI_AGENT)) {
			const { Agent } = await import(INSTALLED_PI_AGENT);
			const agent = new Agent({ initialState: { model, systemPrompt: "test system prompt" }, streamFn: streamClaudeAgentSdk, sessionId: "incident-preflight-agent" });
			await agent.prompt("hello");
			const last = agent.state.messages.at(-1);
			assert.equal(last.stopReason, "error");
			assert.match(last.errorMessage, /^Claude Code executable preflight failed: .* \(incident bi-[0-9a-z]{4,6}\)$/);
			failure.errorMessage = last.errorMessage;
		}
		await assertClassificationKept(failure);
	});

	it("names an incident in a pre-query error event the bridge ends the request with, keeping its fields", async () => {
		const resetAtMs = Date.now() + 60_000;
		globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL] = {
			version: 1,
			acquire() { throw Object.assign(new Error("All Claude accounts are cooling down"), { resetAtMs, rateLimitType: "all_accounts" }); },
			current: () => undefined,
			recordIdentity() {}, recordUsage() {}, recordRateLimit: () => 0, recordFailure() {}, recordSuccess() {},
		};
		try {
			__testSetSdkQueryFactory(() => { throw new Error("no account, no Claude Code"); });
			const events = await collect(streamClaudeAgentSdk(model, initialContext(), { sessionId: "incident-router" }));
			const error = events.at(-1).error;
			assert.equal(events.at(-1).type, "error");
			assert.match(error.errorMessage, /^All Claude accounts are cooling down \(incident bi-[0-9a-z]{4,6}\)$/);
			assert.equal(error.resetAtMs, resetAtMs, "structured fields stay");
			assert.equal(error.rateLimitType, "all_accounts");
			const incident = await incidentDetail(error.errorMessage.match(INCIDENT_SUFFIX)[1]);
			assert.equal(incident.signature, "bridge_error@error-event");
			assert.equal(incident.model, model.id);
			assert.equal(incident.phase, "before-query");
			assert.equal(incident.snapshot, null);
			assert.ok(!JSON.stringify(incident).includes("cooling"), "no error text in the incident");
			await assertClassificationKept(error);
		} finally {
			delete globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL];
		}
	});

	it("gives a first-request account fast-fail the requested model and no query timeline", async () => {
		await loggedOut(async () => {
			__testSetSdkQueryFactory(() => { throw new Error("a disconnected account must not start Claude Code"); });
			const events = await collect(streamClaudeAgentSdk(model, initialContext(), { sessionId: "incident-first-disconnected" }));
			const incident = await incidentDetail(events.at(-1).error.errorMessage.match(INCIDENT_SUFFIX)[1]);
			assert.equal(incident.signature, "claude_account_not_connected@streamRequestInLane");
			assert.equal(incident.model, model.id);
			assert.equal(incident.phase, "before-query");
			assert.equal(incident.snapshot, null);
		});
	});

	it("does not give an account fast-fail the previous query's model or timeline", async () => {
		installFakeClaudeCode(async function* () { yield* FINAL_REPLY; });
		const context = initialContext();
		const first = await collect(streamClaudeAgentSdk(model, context, { sessionId: "incident-stale" }));
		assert.equal(first.at(-1).type, "done");
		await settle(20);
		const sonnet = { ...model, id: "claude-sonnet-4-6" };
		await loggedOut(async () => {
			__testSetSdkQueryFactory(() => { throw new Error("a disconnected account must not start Claude Code"); });
			const next = { messages: [...context.messages, first.at(-1).message, { role: "user", content: "second prompt", timestamp: Date.now() }] };
			const events = await collect(streamClaudeAgentSdk(sonnet, next, { sessionId: "incident-stale" }));
			const incident = await incidentDetail(events.at(-1).error.errorMessage.match(INCIDENT_SUFFIX)[1]);
			assert.equal(incident.model, sonnet.id, "the requested model, not the previous query's");
			assert.equal(incident.phase, "before-query");
			assert.equal(incident.snapshot, null, "no earlier query's timeline");
		});
	});

	// A bridge-authored spawn diagnostic: an executable whose interpreter does
	// not exist. The executable preflight passes, Node's spawn fails with
	// ENOENT and the bridge's spawn callback rewrites the error. Nothing can run.
	function unlaunchableClaude() {
		const executable = join(agentDir, "PATH-SENTINEL-claude");
		writeFileSync(executable, `#!${join(agentDir, "missing-interpreter")}\n`, { mode: 0o755 });
		writeFileSync(join(agentDir, "claude-bridge.json"), JSON.stringify({ provider: { pathToClaudeCodeExecutable: executable } }));
		return executable;
	}

	/** Asserts the Pi error event names exactly one bridge incident whose
	 *  metadata holds none of the error's text. */
	async function assertNamedSpawnFailure(events, expectedPrefix) {
		const last = events.at(-1);
		assert.equal(last.type, "error");
		assert.equal(last.error.stopReason, "error");
		assert.equal(last.error.model, model.id, "the message keeps its fields");
		const text = last.error.errorMessage;
		assert.ok(text.startsWith(expectedPrefix), text);
		assert.match(text, INCIDENT_SUFFIX);
		assert.equal(text.match(/ \(incident /g).length, 1, "one incident suffix");
		const incident = await incidentDetail(text.match(INCIDENT_SUFFIX)[1]);
		assert.equal(incident.signature, "bridge_error@error-event");
		assert.equal(incident.class, "user-visible");
		const metadata = JSON.stringify(incident);
		for (const fragment of ["PATH-SENTINEL", "spawn failed", "ENOENT", agentDir]) assert.ok(!metadata.includes(fragment), `no error text in the incident: ${fragment}`);
		await assertClassificationKept(last.error);
	}

	it("names an incident in a bridge spawn diagnostic the SDK iterator throws as is", async () => {
		const executable = unlaunchableClaude();
		let diagnostic;
		__testSetSdkQueryFactory(({ options }) => ({
			async *[Symbol.asyncIterator]() {
				const child = options.spawnClaudeCodeProcess({ command: executable, args: [], cwd: agentDir, env: {}, signal: new AbortController().signal });
				diagnostic = await new Promise((resolve) => child.once("error", resolve));
				throw diagnostic;
			},
			close() {},
			async interrupt() {},
		}));
		const events = await collect(streamClaudeAgentSdk(model, initialContext(), { sessionId: "incident-spawn-direct" }));
		assert.equal(diagnostic.name, "ClaudeSpawnDiagnosticError");
		await assertNamedSpawnFailure(events, "Claude Code spawn failed: ");
		assert.equal(diagnostic.originalCode, "ENOENT", "the thrown error keeps its fields");
		assert.equal(diagnostic.path, executable);
		assert.ok(!diagnostic.message.includes("(incident "), "the error object itself is not rewritten");
	});

	it("names an incident in a bridge spawn diagnostic the real SDK rewraps as its spawn failure", async () => {
		unlaunchableClaude();
		const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
		process.env.CLAUDE_CONFIG_DIR = agentDir;
		try {
			__testSetSdkQueryFactory(); // the installed Claude Agent SDK; its spawn fails before anything runs
			const events = await collect(streamClaudeAgentSdk(model, initialContext(), { sessionId: "incident-spawn-sdk" }));
			await assertNamedSpawnFailure(events, "Failed to spawn Claude Code process: Claude Code spawn failed: ");
		} finally {
			if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
			else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
		}
	});

	it("names an incident in a bridge spawn diagnostic the SDK rewraps for a write after exit", async () => {
		const executable = unlaunchableClaude();
		const spawnError = Object.assign(new Error(`spawn ${executable} ENOENT`), { code: "ENOENT", errno: -2, syscall: `spawn ${executable}`, path: executable });
		const diagnostic = wrapClaudeSpawnErrorForSdk(spawnError, { command: executable, args: [], cwd: agentDir, env: {}, signal: new AbortController().signal });
		// The SDK's form (sdk.mjs ProcessTransport.write): its token redaction
		// leaves this text as it is, since it holds no credential.
		const rewrapped = new Error(`Cannot write to process that exited with error: Failed to spawn Claude Code process: ${diagnostic.message}`);
		__testSetSdkQueryFactory(() => ({
			async *[Symbol.asyncIterator]() { throw rewrapped; },
			close() {},
			async interrupt() {},
		}));
		const events = await collect(streamClaudeAgentSdk(model, initialContext(), { sessionId: "incident-spawn-write" }));
		await assertNamedSpawnFailure(events, "Cannot write to process that exited with error: Failed to spawn Claude Code process: Claude Code spawn failed: ");
	});

	it("gives an init version-change incident its query's model and timeline", async () => {
		writeFileSync(join(agentDir, "claude-bridge.json"), JSON.stringify({ incidents: { repo: "owner/bridge-incidents" } }));
		writeFileSync(join(agentDir, "claude-bridge-incidents.jsonl"), `${JSON.stringify({ type: "claude_code_version", version: "9.9.8" })}\n`, { mode: 0o600 });
		loadExtension();
		installFakeClaudeCode(async function* () { yield* FINAL_REPLY; });
		await collect(streamClaudeAgentSdk(model, initialContext(), { sessionId: "incident-version-evidence" }));
		await __testFlushIncidents();
		const line = (await piClaude("incidents")).split("\n").find((entry) => entry.includes("claude_code_version_changed@init"));
		assert.ok(line, "the version change is an incident");
		const incident = await incidentDetail(line.split(/\s+/)[0]);
		assert.equal(incident.model, model.id);
		assert.ok(Array.isArray(incident.snapshot), "the init query's timeline");
		assert.ok(incident.snapshot.some((record) => record.kind === "system_init"), "the timeline reaches the init message");
		assert.equal(incident.phase, undefined);
	});

	it("still delivers an error, unnamed, when naming its incident fails", () => {
		const delivered = [];
		const stream = nameBridgeErrorEvents({ push: (event) => delivered.push(event) }, () => undefined);
		const frozen = Object.freeze({ role: "assistant", stopReason: "error", errorMessage: "bridge text" });
		assert.doesNotThrow(() => stream.push({ type: "error", reason: "error", error: frozen }));
		assert.equal(delivered.length, 1, "the error event still ends the request");
		assert.equal(delivered[0].error.errorMessage, "bridge text");

		const thrown = new Error("bridge throw");
		Object.defineProperty(thrown, "name", { get() { throw new Error("hostile name"); } });
		assert.doesNotThrow(() => nameThrownBridgeError(thrown, undefined));
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
			"Claude account not connected — connect an account (or run `claude login`) and retry.",
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
		const incidents = Array.from({ length: 20_000 }, (_, i) => recordIncident(`classification_probe@site_${i}`, "user-visible", {}));
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
