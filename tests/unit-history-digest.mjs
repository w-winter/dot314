// Provider level: warm reuse of Claude Code's session is allowed only while
// the history Claude already holds still matches Pi's. Claude Code resumes its
// own transcript, so a same-length rewrite of an earlier user or assistant
// message (or of a tool call) must rebuild the session from Pi's history. Tool
// result BODIES are the exception: context pruners (pi-prune, pi-jev-pruner)
// replace old tool-result content in every provider call, and a rebuild for
// that would cost a cold prompt cache on every turn.
import "./lib/debug-env.mjs";

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Type } from "@earendil-works/pi-ai";
import { ExtensionRunner, convertToLlm, createExtensionRuntime } from "@earendil-works/pi-coding-agent";

import { __testSetBridgeIntegrityState, __testGetBridgeIntegrityState, __testSetSdkQueryFactory, streamClaudeAgentSdk } from "../src/index.ts";
import { setExtensionApi } from "../src/bridge-state.ts";
import { resetStack } from "../src/query-state.ts";
import { runInRequestLane } from "../src/request-lane.ts";
import { restoreSharedSessionFromPi, schedulePersistSharedSession } from "../src/session-persistence.ts";
import { historyDigest } from "../src/history-digest.ts";
import { createSession } from "cc-session-io";

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

const READ = { name: "read_file", description: "Read a file", parameters: Type.Object({ path: Type.String() }) };
const SYSTEM = { role: "system", content: "test system prompt", toolsAdded: [READ], timestamp: 0 };

let clock = Date.now();
const stamp = () => clock++;
const user = (text) => ({ role: "user", content: text, timestamp: stamp() });
const LONG_BODY = (id) => `contents of ${id}\n${"line of file output\n".repeat(40)}`;
const toolResult = (call) => ({ role: "toolResult", toolCallId: call.id, toolName: READ.name, content: [{ type: "text", text: LONG_BODY(call.id) }], isError: false, timestamp: stamp() });

async function collect(stream) {
	const events = [];
	for await (const event of stream) events.push(event);
	return events;
}

/** Fake Claude Code. Each fresh query plays the next script: a list of
 *  assistant turns, each either `{ text }` or `{ read: [path, ...] }` (one
 *  read_file call per path, answered by Pi through the real MCP server). */
function installFakeClaudeCode(scripts, observed) {
	__testSetSdkQueryFactory(({ options }) => {
		const script = scripts.shift() ?? [{ text: "done" }];
		observed.resumes.push(options.resume ?? null);
		let closed = false;
		return {
			async *[Symbol.asyncIterator]() {
				let client;
				if (script.some((step) => step.read)) {
					const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
					await options.mcpServers["custom-tools"].instance.connect(serverTransport);
					client = new Client({ name: "fake-claude-code", version: "1.0.0" });
					await client.connect(clientTransport);
				}
				yield { type: "system", subtype: "init", session_id: "digest-session" };
				for (const [turn, step] of script.entries()) {
					observed.messageId += 1;
					yield { type: "stream_event", event: { type: "message_start", message: { id: `m${observed.messageId}`, model: model.id, usage: { input_tokens: 1 } } } };
					if (step.text) {
						yield { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } };
						yield { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: step.text } } };
						yield { type: "stream_event", event: { type: "content_block_stop", index: 0 } };
						yield { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } } };
						yield { type: "stream_event", event: { type: "message_stop" } };
						continue;
					}
					const ids = step.read.map((_, index) => `toolu_${observed.messageId}_${turn}_${index}`);
					for (const [index, path] of step.read.entries()) {
						yield { type: "stream_event", event: { type: "content_block_start", index, content_block: { type: "tool_use", id: ids[index], name: `mcp__custom-tools__${READ.name}`, input: {} } } };
						yield { type: "stream_event", event: { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify({ path }) } } };
						yield { type: "stream_event", event: { type: "content_block_stop", index } };
					}
					yield { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } } };
					yield { type: "stream_event", event: { type: "message_stop" } };
					const results = await Promise.all(step.read.map((path, index) => client.callTool({ name: READ.name, arguments: { path }, _meta: { "claudecode/toolUseId": ids[index] } })));
					if (closed) return;
					yield { type: "user", message: { content: ids.map((id, i) => ({ type: "tool_result", tool_use_id: id, content: results[i].content })) } };
				}
				if (!closed) yield { type: "result", subtype: "success", session_id: "digest-session" };
			},
			close() { closed = true; },
			async interrupt() { closed = true; },
		};
	});
}

/** Pi's own provider path: extension `context` handlers through
 *  ExtensionRunner.emitContext (Pi's transformContext), then convertToLlm. */
async function piContext(agentMessages, handler) {
	if (!handler) return convertToLlm(agentMessages);
	const extension = {
		path: "<history-digest-test>",
		resolvedPath: "<history-digest-test>",
		handlers: new Map([["context", [handler]]]),
		tools: new Map(),
		messageRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
	const runner = new ExtensionRunner([extension], createExtensionRuntime(), process.cwd(), undefined, undefined);
	const errors = [];
	runner.onError?.((error) => errors.push(error));
	const transformed = await runner.emitContext(agentMessages);
	assert.deepEqual(errors, [], "the context handler must run cleanly");
	return convertToLlm(transformed);
}

// pi-prune's `context` handler (~/.pi/agent/extensions/pi-prune/index.ts):
// every pruned result becomes a fixed placeholder and loses its error flag.
const PRUNE_PLACEHOLDER = "Output pruned by pi-prune. See the pi-prune summary and use context_prune_query with this toolCallId to retrieve the exact original output.";
const piPruneHandler = (prunedIds) => async (event) => {
	let replaced = false;
	const messages = event.messages.map((message) => {
		if (message.role !== "toolResult" || typeof message.toolCallId !== "string" || !prunedIds.has(message.toolCallId)) return message;
		replaced = true;
		return {
			role: "toolResult",
			toolCallId: message.toolCallId,
			toolName: typeof message.toolName === "string" ? message.toolName : "unknown",
			content: [{ type: "text", text: PRUNE_PLACEHOLDER }],
			isError: false,
			timestamp: message.timestamp,
		};
	});
	return replaced ? { messages } : undefined;
};
// pi-jev-pruner's `context` handler (~/.pi/agent/extensions/pi-jev-pruner/index.ts):
// every pruned result becomes its stored replacement text; the error flag stays.
const jevPrunerHandler = (replacements) => async (event) => {
	let changed = false;
	const messages = event.messages.map((message) => {
		if (message.role !== "toolResult" || typeof message.toolCallId !== "string") return message;
		const replacementText = replacements.get(message.toolCallId);
		if (!replacementText) return message;
		changed = true;
		return {
			role: "toolResult",
			toolCallId: message.toolCallId,
			toolName: typeof message.toolName === "string" ? message.toolName : READ.name,
			content: [{ type: "text", text: replacementText }],
			isError: message.isError,
			timestamp: message.timestamp,
		};
	});
	return changed ? { messages } : undefined;
};

/** One Pi prompt: send `prompt`, answer every tool call with a result, and
 *  return Pi's grown (untransformed) history. `transform` stands in for the
 *  extensions' `context` handlers and applies to every provider call, like
 *  Pi's transformContext. `beforeCallback` may rewrite the history Pi hands a
 *  tool-result callback (a Pi turn_end context edit mid-query). */
async function prompt(sessionId, history, text, { transform, beforeCallback } = {}) {
	let messages = [...history, user(text)];
	for (;;) {
		const context = { messages: await piContext(messages, transform) };
		const events = await collect(streamClaudeAgentSdk(model, context, { sessionId }));
		const done = events.find((event) => event.type === "done");
		assert.ok(done, `the provider stream must finish: ${JSON.stringify(events.filter((event) => event.type === "error").map((event) => event.error?.errorMessage))}`);
		messages = [...messages, done.message];
		if (done.reason !== "toolUse") return messages;
		const calls = done.message.content.filter((block) => block.type === "toolCall");
		messages = [...messages, ...calls.map(toolResult)];
		if (beforeCallback) messages = beforeCallback(messages);
	}
}

const debugLogPath = () => process.env.CLAUDE_BRIDGE_DEBUG_PATH;
const logSize = () => { try { return statSync(debugLogPath()).size; } catch { return 0; } };
let logStart = 0;
/** Sync decisions ("clean-start", "reuse", "rebuild", ...) logged since the test began. */
const syncPaths = () => [...readFileSync(debugLogPath(), "utf8").slice(logStart).matchAll(/syncResult: path=([a-z-]+)/g)].map((match) => match[1]);
const record = (sessionId) => runInRequestLane(sessionId, () => __testGetBridgeIntegrityState().sharedSession);
const setRecord = (sessionId, next) => runInRequestLane(sessionId, () => __testSetBridgeIntegrityState({ sharedSession: next }));

/** The Claude Code session file the last rebuild wrote, as text. */
function sessionFileText(claudeDir) {
	const files = [];
	const walk = (dir) => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			if (statSync(path).isDirectory()) walk(path);
			else if (name.endsWith(".jsonl")) files.push(path);
		}
	};
	walk(claudeDir);
	return files.map((path) => readFileSync(path, "utf8")).join("\n");
}

const replaceUserText = (messages, from, to) => messages.map((message) =>
	message.role === "user" && message.content === from ? { ...message, content: to } : message);

let claudeDir;
let observed;
let keepAlive;
beforeEach(() => {
	// Node 22 exits a test whose only pending work is an unref'd timer.
	keepAlive = setInterval(() => {}, 1000);
	process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT = "0";
	process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token";
	claudeDir = mkdtempSync(join(tmpdir(), "bridge-digest-claude-"));
	process.env.CLAUDE_CONFIG_DIR = claudeDir;
	observed = { resumes: [], messageId: 0 };
	logStart = logSize();
	resetStack();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: { notify: () => {} } });
	setExtensionApi({ events: { emit: () => {} }, appendEntry: () => {} });
});

afterEach(() => {
	clearInterval(keepAlive);
	delete process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT;
	delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
	delete process.env.CLAUDE_CONFIG_DIR;
	rmSync(claudeDir, { recursive: true, force: true });
	__testSetSdkQueryFactory();
	setExtensionApi(undefined);
	resetStack();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
});

describe("warm reuse follows the content Claude already holds", () => {
	it("keeps reusing the session across ordinary multi-turn traffic with tool calls", async () => {
		installFakeClaudeCode([
			[{ read: ["a.txt"] }, { text: "read a" }],
			[{ text: "plain answer" }],
			[{ read: ["b.txt", "c.txt"] }, { read: ["d.txt"] }, { text: "read b c d" }],
			[{ text: "last answer" }],
		], observed);
		let history = [SYSTEM];
		history = await prompt("digest-ordinary", history, "read a");
		history = await prompt("digest-ordinary", history, "just talk");
		history = await prompt("digest-ordinary", history, "read b, c, then d");
		history = await prompt("digest-ordinary", history, "one more");
		assert.deepEqual(syncPaths(), ["clean-start", "reuse", "reuse", "reuse"]);
		assert.deepEqual(observed.resumes, [null, "digest-session", "digest-session", "digest-session"]);
	});

	it("keeps reusing the session after a mid-query steer is replayed as a continuation", async () => {
		installFakeClaudeCode([
			[{ read: ["a.txt"] }, { text: "read a" }],
			[{ text: "steer answered" }],
			[{ text: "next answer" }],
		], observed);
		let history = [SYSTEM];
		history = await prompt("digest-steer", history, "read a", {
			beforeCallback: (messages) => [...messages, user("also mention b")],
		});
		assert.equal(observed.resumes.length, 2, "the steer replays as a continuation query");
		history = await prompt("digest-steer", history, "and next");
		assert.deepEqual(syncPaths(), ["clean-start", "reuse"]);
	});

	it("does not rebuild when pi-prune replaces old tool-result bodies", async () => {
		installFakeClaudeCode([
			[{ read: ["a.txt", "b.txt"] }, { text: "read a b" }],
			[{ text: "after prune" }],
			[{ read: ["c.txt"] }, { text: "read c" }],
		], observed);
		let history = [SYSTEM];
		history = await prompt("digest-pi-prune", history, "read a and b");
		const pruned = new Set(history.filter((message) => message.role === "toolResult").map((message) => message.toolCallId));
		assert.equal(pruned.size, 2);
		// Prune an errored result too: pi-prune clears the error flag.
		history = history.map((message) => message.role === "toolResult" && message.toolCallId === [...pruned][0] ? { ...message, isError: true } : message);
		const transform = piPruneHandler(pruned);
		history = await prompt("digest-pi-prune", history, "continue after prune", { transform });
		history = await prompt("digest-pi-prune", history, "read c", { transform });
		assert.deepEqual(syncPaths(), ["clean-start", "reuse", "reuse"]);
	});

	it("does not rebuild when pi-jev-pruner replaces old tool-result bodies", async () => {
		installFakeClaudeCode([
			[{ read: ["a.txt"] }, { text: "read a" }],
			[{ read: ["b.txt"] }, { text: "read b" }],
			[{ text: "after jev" }],
		], observed);
		let history = [SYSTEM];
		history = await prompt("digest-jev", history, "read a");
		history = await prompt("digest-jev", history, "read b");
		const replacements = new Map(history.filter((message) => message.role === "toolResult")
			.map((message) => [message.toolCallId, `[pi-jev-pruner omitted chars 0-900 of ${message.toolCallId}; use jev_prune_query]\nline of file output`]));
		history = await prompt("digest-jev", history, "continue after jev prune", { transform: jevPrunerHandler(replacements) });
		assert.deepEqual(syncPaths(), ["clean-start", "reuse", "reuse"]);
	});

	it("rebuilds when an earlier user message is rewritten without changing the length", async () => {
		installFakeClaudeCode([[{ text: "ok" }], [{ text: "noted" }], [{ text: "answer" }]], observed);
		let history = [SYSTEM];
		history = await prompt("digest-user-rewrite", history, "hello");
		history = await prompt("digest-user-rewrite", history, "my cat is named APPLE");
		history = replaceUserText(history, "my cat is named APPLE", "my cat is named ZEBRA");
		await prompt("digest-user-rewrite", history, "what is my cat named?");
		assert.deepEqual(syncPaths(), ["clean-start", "reuse", "rebuild"]);
		const imported = sessionFileText(claudeDir);
		assert.match(imported, /my cat is named ZEBRA/, "the rebuild imports Pi's rewritten message");
		assert.doesNotMatch(imported, /APPLE/);
	});

	it("rebuilds when an earlier assistant message is rewritten without changing the length", async () => {
		installFakeClaudeCode([[{ text: "first" }], [{ text: "the answer is 41" }], [{ text: "later" }]], observed);
		let history = [SYSTEM];
		history = await prompt("digest-assistant-rewrite", history, "hello");
		history = await prompt("digest-assistant-rewrite", history, "compute");
		history = history.map((message) => message.role === "assistant" && message.content.some((block) => block.text === "the answer is 41")
			? { ...message, content: [{ type: "text", text: "the answer is 42" }] }
			: message);
		await prompt("digest-assistant-rewrite", history, "and then?");
		assert.deepEqual(syncPaths(), ["clean-start", "reuse", "rebuild"]);
		assert.match(sessionFileText(claudeDir), /the answer is 42/);
	});

	it("rebuilds when an earlier tool call's arguments are rewritten", async () => {
		installFakeClaudeCode([[{ read: ["a.txt"] }, { text: "read a" }], [{ text: "next" }]], observed);
		let history = [SYSTEM];
		history = await prompt("digest-args-rewrite", history, "read a");
		history = history.map((message) => message.role === "assistant"
			? { ...message, content: message.content.map((block) => block.type === "toolCall" ? { ...block, arguments: { path: "other.txt" } } : block) }
			: message);
		await prompt("digest-args-rewrite", history, "next");
		assert.deepEqual(syncPaths(), ["clean-start", "rebuild"]);
		assert.match(sessionFileText(claudeDir), /other\.txt/);
	});

	it("rebuilds when an extension rewrites an earlier assistant message during the query", async () => {
		installFakeClaudeCode([[{ text: "the answer is 41" }], [{ read: ["a.txt"] }, { text: "read a" }], [{ text: "later" }]], observed);
		let history = [SYSTEM];
		history = await prompt("digest-mid-query", history, "compute");
		// A Pi turn_end context edit lands between the tool call and its callback.
		history = await prompt("digest-mid-query", history, "read a", {
			beforeCallback: (messages) => messages.map((message) => message.role === "assistant" && message.content.some((block) => block.text === "the answer is 41")
				? { ...message, content: [{ type: "text", text: "the answer is 42" }] }
				: message),
		});
		assert.equal(record("digest-mid-query")?.needsRebuild, true, "the completed query must not erase the rebuild mark");
		await prompt("digest-mid-query", history, "and then?");
		assert.deepEqual(syncPaths(), ["clean-start", "reuse", "rebuild"]);
		assert.match(sessionFileText(claudeDir), /the answer is 42/);
	});

	it("accepts a record without a digest once, stamps it, then guards it", async () => {
		installFakeClaudeCode([[{ text: "ok" }], [{ text: "noted" }], [{ text: "answer" }]], observed);
		let history = [SYSTEM];
		history = await prompt("digest-legacy", history, "my cat is named APPLE");
		// A record from before digests (restored from an old marker, or still in
		// memory across /reload).
		const { historyDigest: _dropped, ...legacy } = record("digest-legacy");
		setRecord("digest-legacy", legacy);
		history = await prompt("digest-legacy", history, "hello again");
		assert.match(record("digest-legacy").historyDigest ?? "", /^h1:[0-9a-f]{64}$/, "the reuse stamps a digest");
		history = replaceUserText(history, "my cat is named APPLE", "my cat is named ZEBRA");
		await prompt("digest-legacy", history, "what is my cat named?");
		assert.deepEqual(syncPaths(), ["clean-start", "reuse", "rebuild"]);
	});

	it("carries both digests through the persisted session marker", async () => {
		installFakeClaudeCode([[{ read: ["a.txt"] }, { text: "read a" }]], observed);
		const entries = [];
		setExtensionApi({ events: { emit: () => {} }, appendEntry: (type, data) => entries.push({ type, data }) });
		const history = await prompt("digest-marker", [SYSTEM], "read a");
		const live = record("digest-marker");
		assert.match(live.historyDigest ?? "", /^h1:/);
		assert.match(live.trailingAssistantDigest ?? "", /^h1:/);
		const sessionManager = {
			buildSessionContext: () => ({ messages: history }),
			getSessionId: () => "digest-marker",
			getCwd: () => process.cwd(),
			getEntries: () => entries.map(({ type, data }) => ({ type: "custom", customType: type, data })),
		};
		runInRequestLane("digest-marker", () => schedulePersistSharedSession({ sessionManager }));
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(entries.length, 1);
		// The restore checks that the Claude session file exists.
		const session = createSession({ projectPath: process.cwd(), claudeDir, sessionId: live.sessionId });
		session.addUserMessage("read a");
		session.save();
		setRecord("digest-marker", null);
		runInRequestLane("digest-marker", () => restoreSharedSessionFromPi({ cwd: process.cwd(), sessionManager }));
		const restored = record("digest-marker");
		assert.equal(restored?.historyDigest, live.historyDigest);
		assert.equal(restored?.trailingAssistantDigest, live.trailingAssistantDigest);
	});
});

describe("historyDigest coverage", () => {
	const call = { type: "toolCall", id: "toolu_1", name: READ.name, arguments: { path: "a.txt" } };
	const base = () => [
		SYSTEM,
		{ role: "user", content: "read a", timestamp: 1 },
		{ role: "assistant", provider: "pi-claude", api: "claude-bridge", model: "claude-haiku-4-5", stopReason: "toolUse", usage: { input: 1 }, timestamp: 2,
			content: [{ type: "thinking", thinking: "hmm", thinkingSignature: "sig" }, { type: "text", text: "reading" }, { ...call }] },
		{ role: "toolResult", toolCallId: "toolu_1", toolName: READ.name, content: [{ type: "text", text: "body" }], isError: false, timestamp: 3 },
		{ role: "assistant", provider: "pi-claude", api: "claude-bridge", model: "claude-haiku-4-5", stopReason: "stop", usage: { input: 1 }, timestamp: 4, content: [{ type: "text", text: "done" }] },
	];
	const edit = (index, change) => base().map((message, i) => i === index ? change(message) : message);
	const digest = (messages) => historyDigest(messages);

	it("ignores tool-result bodies, error flags and names, thinking, system messages and metadata", () => {
		const reference = digest(base());
		assert.match(reference, /^h1:[0-9a-f]{64}$/);
		for (const [label, messages] of [
			["pruned body", edit(3, (m) => ({ ...m, content: [{ type: "text", text: "Output pruned by pi-prune." }] }))],
			["image body", edit(3, (m) => ({ ...m, content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] }))],
			["error flag", edit(3, (m) => ({ ...m, isError: true }))],
			["result tool name", edit(3, (m) => ({ ...m, toolName: "unknown" }))],
			["timestamps", base().map((m) => ({ ...m, timestamp: 99 }))],
			["thinking", edit(2, (m) => ({ ...m, content: m.content.filter((b) => b.type !== "thinking") }))],
			["usage and model", edit(4, (m) => ({ ...m, usage: { input: 7 }, model: "claude-opus-4-8" }))],
			["system prompt", edit(0, (m) => ({ ...m, content: "another system prompt" }))],
		]) assert.equal(digest(messages), reference, label);
	});

	it("changes with user and assistant text, tool calls, order and roles", () => {
		const reference = digest(base());
		for (const [label, messages] of [
			["user text", edit(1, (m) => ({ ...m, content: "read b" }))],
			["assistant text", edit(4, (m) => ({ ...m, content: [{ type: "text", text: "not done" }] }))],
			["tool arguments", edit(2, (m) => ({ ...m, content: m.content.map((b) => b.type === "toolCall" ? { ...b, arguments: { path: "b.txt" } } : b) }))],
			["tool name", edit(2, (m) => ({ ...m, content: m.content.map((b) => b.type === "toolCall" ? { ...b, name: "write_file" } : b) }))],
			["tool call id", edit(3, (m) => ({ ...m, toolCallId: "toolu_2" }))],
			["order", [base()[0], base()[1], base()[4], base()[2], base()[3]]],
			["role", edit(1, (m) => ({ ...m, role: "assistant", content: [{ type: "text", text: "read a" }] }))],
			["message removed", base().slice(0, 4)],
		]) assert.notEqual(digest(messages), reference, label);
	});
});
