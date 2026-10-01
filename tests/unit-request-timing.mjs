// With CLAUDE_BRIDGE_DEBUG=1 every provider request writes one `timing:` line
// when it settles, with its lane, kind, phases in the order they happened and
// why its session sync did not reuse; with debug off nothing is collected.
// A `usage:` line that repeats the request's previous counters is not logged.
import "./lib/debug-env.mjs";

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Type, createAssistantMessageEventStream } from "@earendil-works/pi-ai";

import { __testSetBridgeIntegrityState, __testSetSdkQueryFactory, streamClaudeAgentSdk } from "../src/index.ts";
import { setExtensionApi } from "../src/bridge-state.ts";
import { resetStack } from "../src/query-state.ts";
import { startRequestTiming } from "../src/request-timing.ts";

const model = { id: "claude-haiku-4-5", name: "Claude Haiku", api: "claude-bridge", provider: "pi-claude", baseUrl: "claude-bridge", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 8192 };
const LOOKUP = { name: "lookup", description: "Look something up", parameters: Type.Object({}) };
const LANE = "TIMING-LANE";
const pkgRoot = fileURLToPath(new URL("..", import.meta.url));

let clock = Date.now();
const user = (content) => ({ role: "user", content, timestamp: clock++ });
const system = { role: "system", content: "test system prompt", toolsAdded: [LOOKUP], timestamp: 0 };
async function collect(stream, onEvent) {
	const events = [];
	for await (const event of stream) {
		events.push(event);
		onEvent?.(event);
	}
	return events;
}
const textTurn = (text, usage = { input_tokens: 1 }) => [
	{ type: "stream_event", event: { type: "message_start", message: { id: `m-${clock++}`, model: model.id, usage } } },
	{ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
	{ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } },
	{ type: "stream_event", event: { type: "content_block_stop", index: 0 } },
	{ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } } },
	{ type: "stream_event", event: { type: "message_stop" } },
];

let root;
let logStart;
const logSince = () => readFileSync(process.env.CLAUDE_BRIDGE_DEBUG_PATH, "utf8").slice(logStart);
const timingLines = () => [...logSince().matchAll(/timing: (\{.*\})$/gm)].map((match) => JSON.parse(match[1]));

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "bridge-request-timing-"));
	process.env.CLAUDE_CONFIG_DIR = root;
	process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token";
	process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT = "0";
	resetStack();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: { notify: () => {} } });
	setExtensionApi({ events: { emit: () => {} }, appendEntry: () => {} });
	logStart = existsSync(process.env.CLAUDE_BRIDGE_DEBUG_PATH) ? statSync(process.env.CLAUDE_BRIDGE_DEBUG_PATH).size : 0;
});

afterEach(() => {
	__testSetSdkQueryFactory();
	setExtensionApi(undefined);
	resetStack();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
	for (const key of ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT"]) delete process.env[key];
	rmSync(root, { recursive: true, force: true });
});

/** The phase names of a timing line in the order they were recorded, after
 *  checking that their offsets never go backwards. */
function orderedPhases(line) {
	const entries = Object.entries(line.phases);
	for (let i = 1; i < entries.length; i++) {
		assert.ok(entries[i][1] >= entries[i - 1][1], `${entries[i][0]} is recorded before ${entries[i - 1][0]}`);
	}
	return entries.map(([name]) => name);
}

it("a fresh query and its tool-result round each write one timing line with the lane and ordered phases", async () => {
	__testSetSdkQueryFactory(({ options }) => ({
		async *[Symbol.asyncIterator]() {
			const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
			await options.mcpServers["custom-tools"].instance.connect(serverTransport);
			const client = new Client({ name: "fake-claude-code", version: "1.0.0" });
			await client.connect(clientTransport);
			yield { type: "system", subtype: "init", session_id: "timing-session" };
			yield { type: "stream_event", event: { type: "message_start", message: { id: "tool-turn", model: model.id, usage: { input_tokens: 1 } } } };
			yield { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: `mcp__custom-tools__${LOOKUP.name}`, input: {} } } };
			yield { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } } };
			yield { type: "stream_event", event: { type: "content_block_stop", index: 0 } };
			yield { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } } };
			yield { type: "stream_event", event: { type: "message_stop" } };
			await client.callTool({ name: LOOKUP.name, arguments: {}, _meta: { "claudecode/toolUseId": "t1" } });
			yield* textTurn("found it");
			yield { type: "result", subtype: "success", session_id: "timing-session" };
		},
		async streamInput() {},
		close() {},
		async interrupt() {},
	}));
	const start = [system, user("look it up")];
	const first = await collect(streamClaudeAgentSdk(model, { messages: start }, { sessionId: LANE }));
	const toolTurn = first.at(-1);
	assert.equal(toolTurn.reason, "toolUse");
	const messages = [...start, toolTurn.message, { role: "toolResult", toolCallId: "t1", toolName: LOOKUP.name, content: [{ type: "text", text: "the answer" }], isError: false, timestamp: clock++ }];
	const second = await collect(streamClaudeAgentSdk(model, { messages }, { sessionId: LANE }));
	assert.equal(second.at(-1).reason, "stop");

	const [fresh, toolResult, ...rest] = timingLines();
	assert.equal(rest.length, 0, "one timing line per request");
	assert.equal(fresh.lane, LANE);
	assert.equal(fresh.kind, "fresh");
	assert.equal(fresh.outcome, "toolUse");
	assert.deepEqual(fresh.sync, { path: "clean-start", cause: "clean-start" });
	assert.deepEqual(orderedPhases(fresh), ["sync", "query", "firstSdkMessage", "init", "firstStreamEvent", "firstDelta", "turnEnd", "settled"]);
	assert.equal(toolResult.lane, LANE);
	assert.equal(toolResult.kind, "tool-result");
	assert.equal(toolResult.outcome, "stop");
	assert.ok(toolResult.seq > fresh.seq);
	assert.deepEqual(orderedPhases(toolResult), ["resultReleased", "handlerAnswered", "firstSdkMessage", "firstStreamEvent", "firstDelta", "sdkResult", "turnEnd", "settled"]);
});

it("a rebuild after an abort records its cause and the rebuild mark", async () => {
	const calls = [];
	__testSetSdkQueryFactory(({ options }) => {
		calls.push(options);
		const call = calls.length;
		const closing = Promise.withResolvers();
		return {
			async *[Symbol.asyncIterator]() {
				yield { type: "system", subtype: "init", session_id: options.resume ?? `session-${call}` };
				if (call === 2) {
					yield* textTurn("partial").slice(0, 3);
					await closing.promise;
					return;
				}
				yield* textTurn(`reply ${call}`);
				yield { type: "result", subtype: "success" };
			},
			async streamInput() {},
			close() { closing.resolve(); },
			async interrupt() { closing.resolve(); },
		};
	});
	const opening = [system, user("first")];
	const first = await collect(streamClaudeAgentSdk(model, { messages: opening }, { sessionId: LANE, cwd: root }));
	const abort = new AbortController();
	const second = [...opening, first.at(-1).message, user("second")];
	const aborted = await collect(
		streamClaudeAgentSdk(model, { messages: second }, { sessionId: LANE, cwd: root, signal: abort.signal }),
		(event) => { if (event.type === "text_delta") abort.abort(); },
	);
	assert.equal(aborted.at(-1).reason, "aborted");
	const third = await collect(streamClaudeAgentSdk(model, { messages: [...second, aborted.at(-1).error, user("third")] }, { sessionId: LANE, cwd: root }));
	assert.equal(third.at(-1).reason, "stop");

	assert.equal(calls.length, 3);
	assert.notEqual(calls[2].resume, calls[1].resume, "the aborted session is rotated");
	assert.match(logSince(), /syncResult: path=rebuild .* cause=post-abort-rotation mark=abort /);
	const rebuilt = timingLines().at(-1);
	assert.equal(rebuilt.kind, "fresh");
	assert.equal(rebuilt.sync.path, "rebuild");
	assert.equal(rebuilt.sync.cause, "post-abort-rotation");
	assert.equal(rebuilt.sync.mark, "abort");
	assert.ok(rebuilt.steps.rebuildWrite.n === 1, "the rebuild's write is timed");
});

it("a usage line repeating the request's previous counters is logged once", async () => {
	__testSetSdkQueryFactory(() => ({
		async *[Symbol.asyncIterator]() {
			yield { type: "system", subtype: "init", session_id: "usage-session" };
			yield { type: "stream_event", event: { type: "message_start", message: { id: "m-usage", model: model.id, usage: { input_tokens: 3, output_tokens: 7 } } } };
			yield { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } };
			yield { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } } };
			yield { type: "stream_event", event: { type: "content_block_stop", index: 0 } };
			yield { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } } };
			yield { type: "stream_event", event: { type: "message_delta", delta: {}, usage: { output_tokens: 9 } } };
			yield { type: "stream_event", event: { type: "message_stop" } };
			yield { type: "result", subtype: "success" };
		},
		async streamInput() {},
		close() {},
		async interrupt() {},
	}));
	const events = await collect(streamClaudeAgentSdk(model, { messages: [system, user("count")] }, { sessionId: LANE }));
	assert.equal(events.at(-1).reason, "stop");
	assert.equal(events.at(-1).message.usage.output, 9, "usage processing is unchanged");
	const usage = [...logSince().matchAll(/usage: in=(\d+) out=(\d+) /g)].map((match) => `${match[1]}/${match[2]}`);
	assert.deepEqual(usage, ["3/7", "3/9"]);
});

it("with debug off nothing is collected or written, while the same request with debug on writes one timing line", () => {
	const dir = mkdtempSync(join(tmpdir(), "bridge-request-timing-child-"));
	try {
		const script = join(dir, "probe.mjs");
		const src = (file) => JSON.stringify(pathToFileURL(join(pkgRoot, "src", file)).href);
		writeFileSync(script, [
			`import { __testSetSdkQueryFactory, streamClaudeAgentSdk } from ${src("index.ts")};`,
			`import { setExtensionApi } from ${src("bridge-state.ts")};`,
			`import { ctx } from ${src("query-state.ts")};`,
			`import { runInRequestLane } from ${src("request-lane.ts")};`,
			`setExtensionApi({ events: { emit: () => {} }, appendEntry: () => {} });`,
			`__testSetSdkQueryFactory(() => ({`,
			`	async *[Symbol.asyncIterator]() {`,
			`		yield { type: "system", subtype: "init", session_id: "child-session" };`,
			`		yield { type: "stream_event", event: { type: "message_start", message: { id: "m", model: "claude-haiku-4-5", usage: { input_tokens: 1 } } } };`,
			`		yield { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } };`,
			`		yield { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } } };`,
			`		yield { type: "stream_event", event: { type: "content_block_stop", index: 0 } };`,
			`		yield { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } } };`,
			`		yield { type: "stream_event", event: { type: "message_stop" } };`,
			`		yield { type: "result", subtype: "success" };`,
			`	},`,
			`	async streamInput() {}, close() {}, async interrupt() {},`,
			`}));`,
			`const model = ${JSON.stringify(model)};`,
			`const stream = streamClaudeAgentSdk(model, { messages: [{ role: "system", content: "s", timestamp: 0 }, { role: "user", content: "hi", timestamp: 1 }] }, { sessionId: "CHILD" });`,
			`const events = [];`,
			`for await (const event of stream) events.push(event.type);`,
			`console.log(JSON.stringify({ last: events.at(-1), wrapped: Object.hasOwn(stream, "push"), timing: runInRequestLane("CHILD", () => ctx().timing !== undefined) }));`,
		].join("\n"));
		const run = (debugOn) => {
			const env = { ...process.env, PI_CODING_AGENT_DIR: join(dir, "agent"), CLAUDE_CONFIG_DIR: join(dir, "claude"), CLAUDE_CODE_OAUTH_TOKEN: "test-token", CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT: "0" };
			env.CLAUDE_BRIDGE_DEBUG_PATH = join(dir, `debug-${debugOn ? "on" : "off"}.log`);
			env.CLAUDE_BRIDGE_DIAG_PATH = join(dir, "diag.log");
			if (debugOn) env.CLAUDE_BRIDGE_DEBUG = "1";
			else delete env.CLAUDE_BRIDGE_DEBUG;
			const output = execFileSync(process.execPath, ["--import", "tsx", script], { cwd: pkgRoot, env, encoding: "utf8", timeout: 60000 });
			return { result: JSON.parse(output.trim().split("\n").at(-1)), logPath: env.CLAUDE_BRIDGE_DEBUG_PATH };
		};

		const off = run(false);
		assert.deepEqual(off.result, { last: "done", wrapped: false, timing: false });
		assert.equal(existsSync(off.logPath), false, "no debug log without the debug flag");

		const on = run(true);
		assert.deepEqual(on.result, { last: "done", wrapped: true, timing: true });
		const lines = readFileSync(on.logPath, "utf8").split("\n").filter((line) => line.includes("timing: "));
		assert.equal(lines.length, 1);
		assert.equal(JSON.parse(lines[0].slice(lines[0].indexOf("timing: ") + 8)).lane, "CHILD");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

it("two loaded copies of the bridge share one event-loop monitor and the debug-write totals", async () => {
	// A subagent can load its own copy of the modules in the same process.
	const suffix = `instance=${Date.now()}-${Math.random()}`;
	const sibling = await import(`../src/request-timing.ts?${suffix}`);
	const siblingDebug = await import(`../src/debug.ts?${suffix}`);
	const parentStream = createAssistantMessageEventStream();
	const childStream = createAssistantMessageEventStream();
	startRequestTiming(parentStream, "copy-parent", model.id, 1);
	sibling.startRequestTiming(childStream, "copy-child", model.id, 1);

	const store = globalThis[Symbol.for("kendex.pi.claude-bridge.request-timing-loop.v1")];
	assert.equal(store?.live, 2, "both requests count toward one live total");
	assert.equal(store.monitor.enable(), false, "the one shared monitor is already enabled");
	siblingDebug.debug("written by the child copy");

	const done = { type: "done", reason: "stop", message: {} };
	parentStream.push(done);
	childStream.push(done);
	const lines = timingLines();
	const parent = lines.find((line) => line.lane === "copy-parent");
	const child = lines.find((line) => line.lane === "copy-child");
	assert.equal(parent.loop.shared, true);
	assert.equal(child.loop.shared, true);
	assert.ok(parent.steps.debugWrite.n >= 1, "the parent's debug-write delta counts the child copy's write");
	assert.equal(store.live, 0);
});
