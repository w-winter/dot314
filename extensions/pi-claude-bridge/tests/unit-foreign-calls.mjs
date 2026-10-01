// A provider call joins a running Claude query only when it is that query's
// own callback: its context carries a tool call the query handed to Pi. Any
// other call runs as its own query, however it reached the bridge:
//   - with the running query's session id (a reviewer or judge an extension
//     starts while the parent waits on a tool, passing the parent's id), or
//   - with no session id at all (ctx.modelRegistry callers that omit it: MCP
//     sampling, pruned-fork summaries, watchdog reviewers, interview, ...),
//     which all share the bridge's one default lane.
// Before this rule, any call that found a running query in its lane was taken
// as that query's callback: it replaced the parent's Pi stream, marked the
// parent's record for rebuild, and never got an answer of its own.
import "./lib/debug-env.mjs";

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Type } from "@earendil-works/pi-ai";
import { Agent } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/index.js";

import { __testGetBridgeIntegrityState, __testSetBridgeIntegrityState, __testSetSdkQueryFactory, onPiHistoryReplaced, streamClaudeAgentSdk } from "../src/index.ts";
import { __testSharedSessionLaneCount, setExtensionApi } from "../src/bridge-state.ts";
import { UNVERIFIED_HISTORY_DIGEST } from "../src/history-digest.ts";
import { __testQueryLaneCount, ctx, resetStack } from "../src/query-state.ts";
import * as queryState from "../src/query-state.ts";
import * as sessionPersistence from "../src/session-persistence.ts";

// Read through the namespace so this file still loads against a bridge
// without fork lanes (the fail-before proof runs it on the parent commit).
const forkLaneCount = () => queryState.__testForkLaneCount?.() ?? 0;
import { runInRequestLane } from "../src/request-lane.ts";

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

const SLOW = { name: "slow_tool", description: "A slow tool", parameters: Type.Object({ id: Type.String() }) };
// Every test has its own bound: on a bridge without the fix a foreign stream
// never settles, and the failure must be quick and clean rather than a hang.
const BOUNDED = { timeout: 10_000 };
const PARENT_PROMPT = "PARENT: run the slow tool";
const REVIEWER_PROMPT = "REVIEWER: return SAFE or UNSAFE";
const REVIEWER_ANSWER = "VERDICT-SAFE";

// --- A fake Claude Code serving every conversation ---

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

async function promptText(prompt) {
	if (typeof prompt === "string") return prompt;
	const parts = [];
	for await (const message of prompt) {
		const content = message.message.content;
		if (typeof content === "string") parts.push(content);
		else for (const block of content) if (block.type === "text") parts.push(block.text);
	}
	return parts.join("");
}

const streamEvent = (event) => ({ type: "stream_event", event });
const textMessage = (id, text) => [
	streamEvent({ type: "message_start", message: { id, model: model.id, usage: { input_tokens: 1 } } }),
	streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
	streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
	streamEvent({ type: "content_block_stop", index: 0 }),
	streamEvent({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }),
	streamEvent({ type: "message_stop" }),
];
const toolMessage = (id, calls) => [
	streamEvent({ type: "message_start", message: { id, model: model.id, usage: { input_tokens: 1 } } }),
	...calls.flatMap((call, index) => [
		streamEvent({ type: "content_block_start", index, content_block: { type: "tool_use", id: call.id, name: `mcp__custom-tools__${call.tool}`, input: {} } }),
		streamEvent({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.args) } }),
		streamEvent({ type: "content_block_stop", index }),
	]),
	streamEvent({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } }),
	streamEvent({ type: "message_stop" }),
];

/** Each SDK query picks its script by prompt text. A script is an async
 *  generator function receiving helpers: `tools(calls)` streams one tool-use
 *  message and awaits the results through the query's real MCP server, as
 *  Claude Code's own loop does; `text(t)` streams a text message. Every query
 *  is recorded in `observed.queries`. */
/** `construct(n)`, if given, runs synchronously as the n-th query (0-based)
 *  is created, like the SDK spawning Claude Code; a throw there is a
 *  synchronous SDK-construction failure. */
function installFakeClaudeCode(pick, { construct } = {}) {
	const observed = { queries: [] };
	__testSetSdkQueryFactory(({ prompt, options }) => {
		construct?.(observed.queries.length);
		const record = { prompt: undefined, resume: options.resume, closed: false, results: {}, live: [] };
		observed.queries.push(record);
		let client;
		let messageNo = 0;
		// Like Claude Code, a closed query ends its iterator promptly even while
		// it waits on a tool result or a gate.
		let markClosed;
		const closedSignal = new Promise((resolve) => { markClosed = resolve; });
		const close = () => { record.closed = true; markClosed(); };
		return {
			async *[Symbol.asyncIterator]() {
				record.prompt = await promptText(prompt);
				const script = pick(record.prompt, options, record);
				assert.ok(script, `no fake script for prompt ${JSON.stringify(record.prompt)}`);
				yield { type: "system", subtype: "init", session_id: `sdk-${observed.queries.indexOf(record) + 1}` };
				const helpers = {
					record,
					async *tools(calls) {
						if (!client) {
							const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
							await options.mcpServers["custom-tools"].instance.connect(serverTransport);
							client = new Client({ name: "fake-claude-code", version: "1.0.0" });
							await client.connect(clientTransport);
						}
						yield* toolMessage(`m${++messageNo}`, calls);
						const results = await Promise.all(calls.map((call) => client.callTool({ name: call.tool, arguments: call.args, _meta: { "claudecode/toolUseId": call.id } })));
						if (record.closed) return;
						calls.forEach((call, index) => { record.results[call.id] = results[index].content?.[0]?.text; });
						yield { type: "user", message: { content: calls.map((call, index) => ({ type: "tool_result", tool_use_id: call.id, content: results[index].content })) } };
					},
					*text(text) { yield* textMessage(`m${++messageNo}`, text); },
				};
				const steps = script(helpers)[Symbol.asyncIterator]();
				while (true) {
					const step = await Promise.race([steps.next(), closedSignal.then(() => ({ done: true }))]);
					if (step.done || record.closed) return;
					yield step.value;
				}
			},
			close,
			async interrupt() { close(); },
			// Steering the bridge writes to the running query.
			async streamInput(input) {
				for await (const message of input) {
					const content = message.message.content;
					record.live.push(typeof content === "string" ? content : content.filter((block) => block.type === "text").map((block) => block.text).join(""));
				}
			},
			// Account routing probes the child's identity and usage.
			async accountInfo() { return {}; },
			async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() { return {}; },
		};
	});
	return observed;
}

const reviewerScript = async function* ({ text }) {
	yield* text(REVIEWER_ANSWER);
	yield { type: "result", subtype: "success", result: REVIEWER_ANSWER };
};

const continuationScript = async function* ({ text }) {
	yield* text("continued");
	yield { type: "result", subtype: "success", result: "continued" };
};

/** Every event of `stream`; rejects if it does not end within `ms`, so a
 *  hijacked stream fails the test instead of hanging it. The timer is
 *  referenced: the suite must keep running on Node 22. */
async function collect(stream, ms = 1500) {
	const events = [];
	let timer;
	const expired = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`stream did not settle within ${ms}ms`)), ms); });
	try {
		await Promise.race([(async () => { for await (const event of stream) events.push(event); })(), expired]);
	} finally {
		clearTimeout(timer);
	}
	return events;
}

/** Collects `stream`, or reports that it did not settle within `ms`. */
function settleWithin(stream, ms = 400) {
	return collect(stream, ms).then((events) => ({ settled: true, events }), () => ({ settled: false }));
}

const textOf = (events) => events.filter((event) => event.type === "text_delta").map((event) => event.delta).join("");
const lastEvent = (events) => {
	const last = events.at(-1);
	return last ? [last.type, last.reason] : [];
};

let clock = Date.now();
const stamp = () => clock++;
const user = (text) => ({ role: "user", content: text, timestamp: stamp() });
const customAsUser = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: stamp() });
const toolResult = (id, text = `result ${id}`) => ({ role: "toolResult", toolCallId: id, toolName: SLOW.name, content: [{ type: "text", text }], isError: false, timestamp: stamp() });
const systemMessage = (content, tools = []) => ({ role: "system", content, ...(tools.length ? { toolsAdded: tools } : {}), timestamp: 0 });

let root;
let hold;
beforeEach(() => {
	hold = setInterval(() => {}, 1000);
	root = mkdtempSync(join(tmpdir(), "bridge-foreign-calls-"));
	process.env.CLAUDE_CONFIG_DIR = root;
	process.env.CLAUDE_CODE_OAUTH_TOKEN = "offline-test";
	process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT = "0";
	process.env.CLAUDE_BRIDGE_DIAG_PATH = join(root, "diag.log");
	resetStack();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: { notify: () => {} } });
	setExtensionApi({ events: { emit: () => {} }, appendEntry: () => {} });
});

afterEach(() => {
	clearInterval(hold);
	__testSetSdkQueryFactory();
	setExtensionApi(undefined);
	resetStack();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
	delete process.env.CLAUDE_CONFIG_DIR;
	delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
	delete process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT;
	delete process.env.CLAUDE_BRIDGE_DIAG_PATH;
	rmSync(root, { recursive: true, force: true });
});

/** What a foreign call could disturb in the parent's lane. */
function parentState(sessionId) {
	return runInRequestLane(sessionId, () => {
		const c = ctx();
		const record = __testGetBridgeIntegrityState().sharedSession;
		return {
			context: c,
			activeQuery: c.activeQuery,
			currentPiStream: c.currentPiStream,
			pendingToolCalls: [...c.pendingToolCalls.keys()],
			pendingResults: [...c.pendingResults.keys()],
			deferredUserMessages: c.deferredUserMessages.map((entry) => entry.text),
			userInputNeedsRebuild: c.userInputNeedsRebuild,
			priorHistoryRewritten: c.priorHistoryRewritten,
			piHistoryReplaced: c.piHistoryReplaced,
			restartRequest: c.restartRequest,
			callbackGeneration: c.callbackGeneration,
			latestCursor: c.latestCursor,
			latestCursorDigest: c.latestCursorDigest,
			undeliveredFailure: c.undeliveredFailure,
			record: record ? { ...record } : null,
		};
	});
}

// --- (c) the scout's collision: a reviewer carrying the parent's session id ---

describe("a foreign call carrying a running query's session id", () => {
	for (const [label, sessionId] of [["the parent's session id", "MAIN"], ["no session id, parent in the default lane", undefined]]) {
		it(`runs a reviewer as its own query and leaves the parked parent untouched (${label})`, BOUNDED, async () => {
			let releaseParent;
			const parentGate = new Promise((resolve) => { releaseParent = resolve; });
			const observed = installFakeClaudeCode((prompt) => {
				if (prompt === PARENT_PROMPT) return async function* ({ tools, text }) {
					yield* tools([{ id: "call-1", tool: SLOW.name, args: { id: "one" } }]);
					await parentGate;
					yield* text("parent done");
					yield { type: "result", subtype: "success", result: "parent done" };
				};
				if (prompt === REVIEWER_PROMPT) return reviewerScript;
			});
			const initial = [systemMessage("parent system", [SLOW]), user(PARENT_PROMPT)];
			const first = await collect(streamClaudeAgentSdk(model, { messages: initial }, { sessionId }));
			const toolTurn = first.at(-1);
			assert.deepEqual(lastEvent(first), ["done", "toolUse"]);
			await tick(10);
			const before = parentState(sessionId);
			assert.ok(before.activeQuery, "the parent waits on its tool");
			assert.deepEqual(before.pendingToolCalls, ["call-1"]);

			// The reviewer: its own system prompt, one user message, no tools.
			const reviewer = await settleWithin(streamClaudeAgentSdk(model, { messages: [systemMessage("You are a reviewer"), user(REVIEWER_PROMPT)] }, { sessionId }));
			assert.equal(reviewer.settled, true, "the reviewer settles with an answer of its own");
			assert.deepEqual(lastEvent(reviewer.events), ["done", "stop"]);
			assert.equal(textOf(reviewer.events), REVIEWER_ANSWER);
			assert.deepEqual(observed.queries.map((query) => query.prompt), [PARENT_PROMPT, REVIEWER_PROMPT], "the reviewer ran as a second SDK query");
			assert.equal(observed.queries[1].resume, undefined, "the reviewer never resumes the parent's Claude session");

			const after = parentState(sessionId);
			assert.equal(after.context, before.context, "the parent's lane still holds the parent's query");
			assert.deepEqual(after, before, "no parent state changed");

			releaseParent();
			const callback = await settleWithin(streamClaudeAgentSdk(model, { messages: [...initial, toolTurn.message, toolResult("call-1")] }, { sessionId }));
			assert.equal(callback.settled, true);
			assert.deepEqual(lastEvent(callback.events), ["done", "stop"]);
			assert.equal(textOf(callback.events), "parent done");
			assert.equal(observed.queries[0].results["call-1"], "result call-1", "the parent's tool call got its own result");
			await tick(20);
			const record = runInRequestLane(sessionId, () => __testGetBridgeIntegrityState().sharedSession);
			assert.equal(record?.needsRebuild, undefined, "the parent's record was never marked for rebuild");
			assert.equal(record?.sessionId, "sdk-1", "the parent's record is the parent's session");
			assert.equal(__testQueryLaneCount(), sessionId === undefined ? 0 : 1, "no lane of the reviewer is left behind");
			assert.equal(__testSharedSessionLaneCount(), sessionId === undefined ? 0 : 1);
			assert.equal(forkLaneCount(), 0, "no fork lane stays registered");
		});
	}

	it("routes a tool-using foreign Agent's own callbacks back to its own query", BOUNDED, async () => {
		let releaseParent;
		const parentGate = new Promise((resolve) => { releaseParent = resolve; });
		const observed = installFakeClaudeCode((prompt) => {
			if (prompt === PARENT_PROMPT) return async function* ({ tools, text }) {
				yield* tools([{ id: "call-parent", tool: SLOW.name, args: { id: "parent" } }]);
				await parentGate;
				yield* text("parent done");
				yield { type: "result", subtype: "success", result: "parent done" };
			};
			if (prompt === REVIEWER_PROMPT) return async function* ({ tools, text }) {
				yield* tools([{ id: "call-review-1", tool: "inspect", args: { id: "r1" } }]);
				yield* tools([{ id: "call-review-2", tool: "inspect", args: { id: "r2" } }]);
				yield* text(REVIEWER_ANSWER);
				yield { type: "result", subtype: "success", result: REVIEWER_ANSWER };
			};
		});
		const initial = [systemMessage("parent system", [SLOW]), user(PARENT_PROMPT)];
		const first = await collect(streamClaudeAgentSdk(model, { messages: initial }, { sessionId: "MAIN" }));
		assert.deepEqual(lastEvent(first), ["done", "toolUse"]);
		await tick(10);
		const before = parentState("MAIN");

		const inspected = [];
		const reviewer = new Agent({
			initialState: {
				systemPrompt: "You are a reviewer",
				model,
				tools: [{
					name: "inspect", label: "Inspect", description: "inspect", parameters: Type.Object({ id: Type.String() }),
					async execute(_id, params) {
						inspected.push(params.id);
						return { content: [{ type: "text", text: `inspected ${params.id}` }], details: {} };
					},
				}],
			},
			sessionId: "MAIN",
			streamFn: (m, context, options) => streamClaudeAgentSdk(m, context, options),
		});
		const run = reviewer.prompt(REVIEWER_PROMPT);
		const outcome = await Promise.race([run.then(() => "settled"), tick(800).then(() => "hung")]);
		if (outcome === "hung") reviewer.abort();
		assert.equal(outcome, "settled", "the reviewer completes its own tool round trips");
		const final = reviewer.state.messages.at(-1);
		assert.equal(final.role, "assistant");
		assert.equal(final.stopReason, "stop");
		assert.equal(final.content.find((block) => block.type === "text")?.text, REVIEWER_ANSWER);
		assert.deepEqual(inspected, ["r1", "r2"]);
		assert.deepEqual(observed.queries[1].results, { "call-review-1": "inspected r1", "call-review-2": "inspected r2" });
		assert.deepEqual(parentState("MAIN"), before, "the parent's state did not change");

		releaseParent();
		const callback = await settleWithin(streamClaudeAgentSdk(model, { messages: [...initial, first.at(-1).message, toolResult("call-parent")] }, { sessionId: "MAIN" }));
		assert.equal(textOf(callback.events), "parent done");
		await tick(20);
		assert.equal(__testQueryLaneCount(), 1, "only the parent's lane remains");
		assert.equal(__testSharedSessionLaneCount(), 1);
		assert.equal(forkLaneCount(), 0, "no fork lane stays registered");
	});
});

// --- (b) two foreign conversations without a session id, concurrently ---

describe("foreign conversations without a session id", () => {
	it("two concurrent Pi Agents, one parked on a tool, each finish their own tool round trips", BOUNDED, async () => {
		const observed = installFakeClaudeCode((prompt) => {
			const tag = prompt.startsWith("CONVERSATION-A") ? "A" : prompt.startsWith("CONVERSATION-B") ? "B" : undefined;
			if (!tag) return undefined;
			return async function* ({ tools, text }) {
				yield* tools([{ id: `call-${tag}-1`, tool: "lookup", args: { id: `${tag}1` } }]);
				yield* tools([{ id: `call-${tag}-2`, tool: "lookup", args: { id: `${tag}2` } }]);
				yield* text(`ANSWER-${tag}`);
				yield { type: "result", subtype: "success", result: `ANSWER-${tag}` };
			};
		});
		const laneBaseline = { query: __testQueryLaneCount(), shared: __testSharedSessionLaneCount() };
		let releaseA;
		const aGate = new Promise((resolve) => { releaseA = resolve; });
		let aParked;
		const aIsParked = new Promise((resolve) => { aParked = resolve; });
		const executed = { A: [], B: [] };
		const makeAgent = (tag, execute) => new Agent({
			initialState: {
				systemPrompt: `You are helper ${tag}`,
				model,
				tools: [{ name: "lookup", label: "Lookup", description: "lookup", parameters: Type.Object({ id: Type.String() }), execute }],
			},
			// No sessionId: like ctx.modelRegistry callers that omit it.
			streamFn: (m, context, options) => streamClaudeAgentSdk(m, context, options),
		});
		const agentA = makeAgent("A", async (_id, params) => {
			executed.A.push(params.id);
			if (params.id === "A1") { aParked(); await aGate; }
			return { content: [{ type: "text", text: `A saw ${params.id}` }], details: {} };
		});
		const agentB = makeAgent("B", async (_id, params) => {
			executed.B.push(params.id);
			return { content: [{ type: "text", text: `B saw ${params.id}` }], details: {} };
		});
		const runA = agentA.prompt("CONVERSATION-A: look things up");
		await aIsParked;
		const runB = agentB.prompt("CONVERSATION-B: look things up");
		const bOutcome = await Promise.race([runB.then(() => "settled"), tick(800).then(() => "hung")]);
		if (bOutcome === "hung") { agentB.abort(); agentA.abort(); releaseA(); }
		assert.equal(bOutcome, "settled", "B completes while A is parked on its tool");
		releaseA();
		const aOutcome = await Promise.race([runA.then(() => "settled"), tick(800).then(() => "hung")]);
		if (aOutcome === "hung") agentA.abort();
		assert.equal(aOutcome, "settled", "A completes after its tool returns");

		for (const [tag, agent] of [["A", agentA], ["B", agentB]]) {
			const final = agent.state.messages.at(-1);
			assert.equal(final.stopReason, "stop", `${tag} ends normally: ${final.errorMessage ?? ""}`);
			assert.equal(final.content.find((block) => block.type === "text")?.text, `ANSWER-${tag}`);
			const calls = agent.state.messages.filter((message) => message.role === "assistant").flatMap((message) => message.content.filter((block) => block.type === "toolCall").map((block) => block.id));
			assert.deepEqual(calls, [`call-${tag}-1`, `call-${tag}-2`], `${tag} saw only its own tool calls`);
		}
		assert.deepEqual(executed, { A: ["A1", "A2"], B: ["B1", "B2"] });
		assert.equal(observed.queries.length, 2, "one SDK query per conversation");
		for (const query of observed.queries) {
			const tag = query.prompt.startsWith("CONVERSATION-A") ? "A" : "B";
			assert.deepEqual(query.results, { [`call-${tag}-1`]: `${tag} saw ${tag}1`, [`call-${tag}-2`]: `${tag} saw ${tag}2` }, `${tag}'s Claude query got its own results`);
		}
		await tick(20);
		assert.equal(__testQueryLaneCount(), laneBaseline.query, "no lane is left behind");
		assert.equal(__testSharedSessionLaneCount(), laneBaseline.shared, "no session record is left behind");
		assert.equal(forkLaneCount(), 0, "no fork lane stays registered");
	});
});

// --- (a) genuine callbacks join their own query, even with a foreign call between ---

/** A parent flow in lane `sessionId`. `intrude()` is called at each point
 *  where a foreign call could arrive (the parent parked on a tool); in the
 *  control run it does nothing. Returns a summary that must not depend on
 *  whether foreign calls arrived. */
const SHAPES = {
	"parallel tool results in one callback": async ({ sessionId, intrude, installParent }) => {
		const observed = installParent(async function* ({ tools, text }) {
			yield* tools([{ id: "p1", tool: SLOW.name, args: { id: "p1" } }, { id: "p2", tool: SLOW.name, args: { id: "p2" } }]);
			yield* text("parallel done");
			yield { type: "result", subtype: "success" };
		});
		const initial = [systemMessage("sys", [SLOW]), user(PARENT_PROMPT)];
		const first = await collect(streamClaudeAgentSdk(model, { messages: initial }, { sessionId }));
		await intrude();
		const events = await collect(streamClaudeAgentSdk(model, { messages: [...initial, first.at(-1).message, toolResult("p1"), toolResult("p2")] }, { sessionId }));
		return { first: lastEvent(first), last: lastEvent(events), text: textOf(events), results: observed.parent().results };
	},
	"sequential tool turns": async ({ sessionId, intrude, installParent }) => {
		const observed = installParent(async function* ({ tools, text }) {
			yield* tools([{ id: "s1", tool: SLOW.name, args: { id: "s1" } }]);
			yield* tools([{ id: "s2", tool: SLOW.name, args: { id: "s2" } }]);
			yield* text("sequential done");
			yield { type: "result", subtype: "success" };
		});
		const initial = [systemMessage("sys", [SLOW]), user(PARENT_PROMPT)];
		const first = await collect(streamClaudeAgentSdk(model, { messages: initial }, { sessionId }));
		await intrude();
		const second = [...initial, first.at(-1).message, toolResult("s1")];
		const middle = await collect(streamClaudeAgentSdk(model, { messages: second }, { sessionId }));
		await intrude();
		const events = await collect(streamClaudeAgentSdk(model, { messages: [...second, middle.at(-1).message, toolResult("s2")] }, { sessionId }));
		return { middle: lastEvent(middle), last: lastEvent(events), text: textOf(events), results: observed.parent().results };
	},
	"a steer-split batch (toolResult, user, toolResult, user)": async ({ sessionId, intrude, installParent }) => {
		const observed = installParent(async function* ({ tools, text }) {
			yield* tools([{ id: "c1", tool: SLOW.name, args: { id: "c1" } }, { id: "c2", tool: SLOW.name, args: { id: "c2" } }]);
			yield* text("tools done");
			yield { type: "result", subtype: "success" };
		});
		const initial = [systemMessage("sys", [SLOW]), user(PARENT_PROMPT)];
		const first = await collect(streamClaudeAgentSdk(model, { messages: initial }, { sessionId }));
		await intrude();
		const events = await collect(streamClaudeAgentSdk(model, { messages: [...initial, first.at(-1).message, toolResult("c1"), user("STEER-FIRST"), toolResult("c2"), user("STEER-SECOND")] }, { sessionId }));
		return { last: lastEvent(events), text: textOf(events), live: observed.parent().live, continuations: observed.continuations(), results: observed.parent().results };
	},
	"a D2 steer and an intercom follow-up": async ({ sessionId, intrude, installParent }) => {
		const observed = installParent(async function* ({ tools, text }) {
			yield* tools([{ id: "c1", tool: SLOW.name, args: { id: "c1" } }]);
			yield* text("tools done");
			yield { type: "result", subtype: "success" };
		});
		const initial = [systemMessage("sys", [SLOW]), user(PARENT_PROMPT)];
		const first = await collect(streamClaudeAgentSdk(model, { messages: initial }, { sessionId }));
		await intrude();
		const events = await collect(streamClaudeAgentSdk(model, { messages: [...initial, first.at(-1).message, toolResult("c1"), user("STEER"), customAsUser("INTERCOM")] }, { sessionId }));
		await tick(10);
		return { last: lastEvent(events), text: textOf(events), live: observed.parent().live, continuations: observed.continuations(), record: recordFlags(sessionId) };
	},
	"E3: a failure held for the orphaned tool-result callback": async ({ sessionId, intrude, installParent }) => {
		let fail;
		const failGate = new Promise((resolve) => { fail = resolve; });
		// The tool turn reaches Pi, then Claude Code fails while Pi runs the tool.
		installParent(async function* () {
			yield* toolMessage("m1", [{ id: "c1", tool: SLOW.name, args: { id: "c1" } }]);
			await failGate;
			yield { type: "result", subtype: "error_during_execution", errors: ["API Error: 500 internal server error"] };
		});
		const initial = [systemMessage("sys", [SLOW]), user(PARENT_PROMPT)];
		const first = await collect(streamClaudeAgentSdk(model, { messages: initial }, { sessionId }));
		await intrude();
		fail();
		await tick(20);
		await intrude();
		const events = await collect(streamClaudeAgentSdk(model, { messages: [...initial, first.at(-1).message, toolResult("c1")] }, { sessionId }));
		return { last: lastEvent(events), error: events.at(-1).error?.errorMessage };
	},
	"E3: a usage limit reported while the query winds down": async ({ sessionId, intrude, installParent }) => {
		let windDown;
		const windDownGate = new Promise((resolve) => { windDown = resolve; });
		installParent(async function* () {
			yield* toolMessage("m1", [{ id: "c1", tool: SLOW.name, args: { id: "c1" } }]);
			yield { type: "result", subtype: "error_during_execution", errors: ["You've hit your weekly limit · resets Thursday 4am"] };
			await windDownGate;
		});
		const initial = [systemMessage("sys", [SLOW]), user(PARENT_PROMPT)];
		const first = await collect(streamClaudeAgentSdk(model, { messages: initial }, { sessionId }));
		await tick(10);
		await intrude();
		const pending = collect(streamClaudeAgentSdk(model, { messages: [...initial, first.at(-1).message, toolResult("c1")] }, { sessionId }));
		windDown();
		const events = await pending;
		return { last: lastEvent(events), error: events.at(-1).error?.errorMessage };
	},
	"an abort, then the next prompt (stage B quarantine)": async ({ sessionId, intrude, installParent }) => {
		const observed = installParent(async function* ({ tools, text }) {
			yield* tools([{ id: "c1", tool: SLOW.name, args: { id: "c1" } }]);
			yield* text("never");
			yield { type: "result", subtype: "success" };
		}, (prompt) => prompt === "say recovered" ? async function* ({ text }) {
			yield* text("recovered");
			yield { type: "result", subtype: "success" };
		} : undefined);
		const abort = new AbortController();
		const initial = [systemMessage("sys", [SLOW]), user(PARENT_PROMPT)];
		const first = await collect(streamClaudeAgentSdk(model, { messages: initial }, { sessionId, signal: abort.signal }));
		await tick(10);
		await intrude();
		abort.abort();
		const next = await collect(streamClaudeAgentSdk(model, { messages: [...initial, first.at(-1).message, { ...toolResult("c1", "aborted"), isError: true }, user("say recovered")] }, { sessionId }));
		await tick(20);
		return { last: lastEvent(next), text: textOf(next), parentQueries: observed.parentPrompts(), resumedAborted: observed.parentQueries()[1]?.resume === "sdk-1" };
	},
	"a callback from a later Pi run, then Esc in that run": async ({ sessionId, intrude, installParent }) => {
		const observed = installParent(async function* ({ tools, text }) {
			yield* tools([{ id: "c1", tool: SLOW.name, args: { id: "c1" } }]);
			yield* tools([{ id: "c2", tool: SLOW.name, args: { id: "c2" } }]);
			yield* text("never");
			yield { type: "result", subtype: "success" };
		});
		const run1 = new AbortController();
		const run2 = new AbortController();
		const initial = [systemMessage("sys", [SLOW]), user(PARENT_PROMPT)];
		const first = await collect(streamClaudeAgentSdk(model, { messages: initial }, { sessionId, signal: run1.signal }));
		await intrude();
		const second = collect(streamClaudeAgentSdk(model, { messages: [...initial, first.at(-1).message, toolResult("c1")] }, { sessionId, signal: run2.signal }));
		const middle = await second;
		await tick(10);
		await intrude();
		run2.abort();
		await tick(20);
		const queryEnded = runInRequestLane(sessionId, () => ctx().activeQuery === null);
		return { middle: lastEvent(middle), queryEnded, interrupted: observed.parent().closed };
	},
	"compaction restarts the query on Pi's new history": async ({ sessionId, intrude, installParent }) => {
		const observed = installParent(async function* ({ tools, text }) {
			yield* tools([{ id: "c1", tool: SLOW.name, args: { id: "c1" } }]);
			yield* text("never");
			yield { type: "result", subtype: "success" };
		}, (prompt) => prompt.includes("rewritten by Pi") ? async function* ({ text }) {
			yield* text("restarted");
			yield { type: "result", subtype: "success" };
		} : undefined);
		const initial = [systemMessage("sys", [SLOW]), user(PARENT_PROMPT)];
		const first = await collect(streamClaudeAgentSdk(model, { messages: initial }, { sessionId }));
		await tick(10);
		await intrude();
		runInRequestLane(sessionId, () => onPiHistoryReplaced("session_compact"));
		await intrude();
		const events = await collect(streamClaudeAgentSdk(model, { messages: [systemMessage("sys", [SLOW]), user("Summary of the conversation"), first.at(-1).message, toolResult("c1")] }, { sessionId }));
		return { last: lastEvent(events), text: textOf(events), parentQueries: observed.parentQueries().length, firstClosed: observed.parentQueries()[0].closed };
	},
	"a pruned history with rewritten tool-result bodies": async ({ sessionId, intrude, installParent }) => {
		const observed = installParent(async function* ({ tools, text }) {
			yield* tools([{ id: "c1", tool: SLOW.name, args: { id: "c1" } }]);
			yield* text("pruned done");
			yield { type: "result", subtype: "success" };
		});
		const earlier = [user("earlier-one"), user("earlier-two")];
		const initial = [systemMessage("sys", [SLOW]), ...earlier, user(PARENT_PROMPT)];
		const first = await collect(streamClaudeAgentSdk(model, { messages: initial }, { sessionId }));
		await intrude();
		// A pruner drops older messages and replaces the tool-result body; the
		// tool-call id survives.
		const events = await collect(streamClaudeAgentSdk(model, { messages: [initial[0], initial.at(-1), first.at(-1).message, toolResult("c1", "Output pruned by pi-prune.")] }, { sessionId }));
		await tick(10);
		return { last: lastEvent(events), text: textOf(events), results: observed.parent().results, record: recordFlags(sessionId) };
	},
	"a fully replaced context that keeps only the tool result": async ({ sessionId, intrude, installParent }) => {
		const observed = installParent(async function* ({ tools, text }) {
			yield* tools([{ id: "c1", tool: SLOW.name, args: { id: "c1" } }]);
			yield* text("replaced done");
			yield { type: "result", subtype: "success" };
		});
		const initial = [systemMessage("sys", [SLOW]), user("earlier"), user(PARENT_PROMPT)];
		await collect(streamClaudeAgentSdk(model, { messages: initial }, { sessionId }));
		await intrude();
		const events = await collect(streamClaudeAgentSdk(model, { messages: [initial[0], user("Summary so far"), toolResult("c1"), user("STEER-REPLACED")] }, { sessionId }));
		await tick(10);
		return { last: lastEvent(events), text: textOf(events), live: observed.parent().live, continuations: observed.continuations(), results: observed.parent().results, record: recordFlags(sessionId) };
	},
};

function recordFlags(sessionId) {
	const record = runInRequestLane(sessionId, () => __testGetBridgeIntegrityState().sharedSession);
	return record ? { needsRebuild: record.needsRebuild === true, forceRotate: record.forceRotate === true, unverified: record.historyDigest === UNVERIFIED_HISTORY_DIGEST } : null;
}

/** Runs `shape` in lane `sessionId`; with `foreign`, a reviewer call on the
 *  same lane key arrives at every intrusion point and must settle on its own. */
async function runShape(shape, sessionId, foreign) {
	resetStack();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: { notify: () => {} } });
	const reviewers = [];
	const intrude = async () => {
		if (!foreign) return;
		const outcome = await settleWithin(streamClaudeAgentSdk(model, { messages: [systemMessage("You are a reviewer"), user(REVIEWER_PROMPT)] }, { sessionId }));
		reviewers.push(outcome.settled ? textOf(outcome.events) : "NEVER SETTLED");
	};
	let observed;
	const installParent = (script, extra = () => undefined) => {
		observed = installFakeClaudeCode((prompt) => {
			if (prompt === REVIEWER_PROMPT) return reviewerScript;
			if (prompt === PARENT_PROMPT) return script;
			// Anything else is a deferred-steer continuation unless the shape says otherwise.
			return extra(prompt) ?? continuationScript;
		});
		const parentQueries = () => observed.queries.filter((query) => query.prompt !== REVIEWER_PROMPT);
		return {
			parent: () => parentQueries()[0],
			parentQueries,
			parentPrompts: () => parentQueries().map((query) => query.prompt),
			continuations: () => parentQueries().slice(1).map((query) => query.prompt),
		};
	};
	const summary = await shape({ sessionId, intrude, installParent });
	await tick(20);
	return { summary, reviewers, reviewerQueries: observed.queries.filter((query) => query.prompt === REVIEWER_PROMPT).length };
}

describe("genuine callbacks join their own query, even with a foreign call between", () => {
	for (const [lane, sessionId] of [["named lane", "MAIN"], ["default lane", undefined]]) {
		for (const [name, shape] of Object.entries(SHAPES)) {
			it(`${name} (${lane})`, BOUNDED, async () => {
				const control = await runShape(shape, sessionId, false);
				const withForeign = await runShape(shape, sessionId, true);
				assert.ok(withForeign.reviewers.length > 0);
				assert.deepEqual(withForeign.reviewers, withForeign.reviewers.map(() => REVIEWER_ANSWER), "every foreign call settled with its own answer");
				assert.equal(withForeign.reviewerQueries, withForeign.reviewers.length, "each foreign call ran its own SDK query");
				assert.deepEqual(withForeign.summary, control.summary, "the genuine callbacks behave exactly as without foreign calls");
			});
		}
	}

	it("the control runs describe the expected genuine behavior", BOUNDED, async () => {
		// Pins the control outcomes, so an equal-but-broken pair cannot pass.
		const expectations = {
			"parallel tool results in one callback": { last: ["done", "stop"], text: "parallel done" },
			"sequential tool turns": { middle: ["done", "toolUse"], last: ["done", "stop"], text: "sequential done" },
			"a steer-split batch (toolResult, user, toolResult, user)": { last: ["done", "stop"], live: ["STEER-FIRST\n\nSTEER-SECOND"], continuations: [] },
			"a D2 steer and an intercom follow-up": { last: ["done", "stop"], live: ["STEER\n\nINTERCOM"], continuations: [] },
			"E3: a failure held for the orphaned tool-result callback": { last: ["error", "error"], error: "API Error: 500 internal server error" },
			"E3: a usage limit reported while the query winds down": { last: ["error", "error"], error: "You've hit your weekly limit · resets Thursday 4am" },
			"an abort, then the next prompt (stage B quarantine)": { last: ["done", "stop"], text: "recovered", resumedAborted: false },
			"a callback from a later Pi run, then Esc in that run": { middle: ["done", "toolUse"], queryEnded: true, interrupted: true },
			"compaction restarts the query on Pi's new history": { last: ["done", "stop"], text: "restarted", parentQueries: 2, firstClosed: true },
			"a pruned history with rewritten tool-result bodies": { last: ["done", "stop"], text: "pruned done", results: { c1: "Output pruned by pi-prune." } },
			"a fully replaced context that keeps only the tool result": { last: ["done", "stop"], live: [], continuations: [], results: { c1: "result c1" } },
		};
		for (const [name, expected] of Object.entries(expectations)) {
			const { summary } = await runShape(SHAPES[name], "MAIN", false);
			for (const [key, value] of Object.entries(expected)) assert.deepEqual(summary[key], value, `${name}: ${key}`);
		}
	});
});

// --- A failure held for a tool-result callback (E3) keeps the lane mid-turn ---

async function waitFor(check, what, ms = 1000) {
	const deadline = Date.now() + ms;
	while (!check() && Date.now() < deadline) await tick(5);
	assert.ok(check(), `timed out waiting for ${what}`);
}

/** A parent in lane `sessionId` whose query fails after its tool turn reached
 *  Pi; resolves once the query is torn down and holds the failure. */
async function parentFailedAfterToolTurn(sessionId, signal) {
	let fail;
	const failGate = new Promise((resolve) => { fail = resolve; });
	installFakeClaudeCode((prompt) => {
		if (prompt === REVIEWER_PROMPT) return reviewerScript;
		if (prompt === PARENT_PROMPT) return async function* () {
			yield* toolMessage("m1", [{ id: "c1", tool: SLOW.name, args: { id: "c1" } }]);
			await failGate;
			yield { type: "result", subtype: "error_during_execution", errors: ["API Error: 500 internal server error"] };
		};
		return continuationScript;
	});
	const initial = [systemMessage("sys", [SLOW]), user(PARENT_PROMPT)];
	const first = await collect(streamClaudeAgentSdk(model, { messages: initial }, { sessionId, signal }));
	fail();
	await waitFor(() => runInRequestLane(sessionId, () => ctx().activeQuery === null && ctx().undeliveredFailure !== null), "the failed query to hold its failure");
	return [...initial, first.at(-1).message];
}

describe("a lane holding a failure for its tool-result callback", () => {
	it("drops the hold when the run is cancelled after the query ended, so the lane is idle again", BOUNDED, async () => {
		const run = new AbortController();
		await parentFailedAfterToolTurn("MAIN", run.signal);
		run.abort();
		assert.equal(runInRequestLane("MAIN", () => ctx().undeliveredFailure), null, "a cancelled run delivers no callback to report it");
		// The lane is idle: a request without the call is no longer sent to a
		// fork because the lane is busy.
		assert.equal(queryState.requestLaneFor("MAIN", [systemMessage("sys"), user("next prompt")]), "MAIN");
		assert.equal(forkLaneCount(), 0, "no fork lane was opened");
	});

	it("drops the hold when Pi replaces the history the callback would answer", BOUNDED, async () => {
		await parentFailedAfterToolTurn("MAIN");
		runInRequestLane("MAIN", () => onPiHistoryReplaced("session_tree"));
		assert.equal(runInRequestLane("MAIN", () => ctx().undeliveredFailure), null);
	});

	it("still lets the conversation's own next prompt, which carries the call, start fresh in the lane", BOUNDED, async () => {
		const history = await parentFailedAfterToolTurn("MAIN");
		const events = await collect(streamClaudeAgentSdk(model, { messages: [...history, toolResult("c1"), user("next prompt")] }, { sessionId: "MAIN" }));
		assert.deepEqual(lastEvent(events), ["done", "stop"]);
		await tick(10);
		assert.equal(__testQueryLaneCount(), 1, "the prompt ran in the conversation's own lane");
		assert.equal(runInRequestLane("MAIN", () => ctx().undeliveredFailure), null, "the fresh query dropped the hold");
	});
});

describe("a foreign query of its own that fails after its tool turn", () => {
	for (const [label, sessionId] of [["the parent's session id", "MAIN"], ["no session id", undefined]]) {
		for (const outcome of ["reports it on its own callback", "is cancelled while its tool runs"]) {
			it(`${outcome}, then releases its lane (${label})`, BOUNDED, async () => {
				let releaseParent;
				const parentGate = new Promise((resolve) => { releaseParent = resolve; });
				let failForeign;
				const foreignGate = new Promise((resolve) => { failForeign = resolve; });
				const observed = installFakeClaudeCode((prompt) => {
					if (prompt === PARENT_PROMPT) return async function* ({ tools, text }) {
						yield* tools([{ id: "call-parent", tool: SLOW.name, args: { id: "parent" } }]);
						await parentGate;
						yield* text("parent done");
						yield { type: "result", subtype: "success" };
					};
					if (prompt === REVIEWER_PROMPT) return async function* () {
						yield* toolMessage("r1", [{ id: "call-review", tool: "inspect", args: { id: "r" } }]);
						await foreignGate;
						yield { type: "result", subtype: "error_during_execution", errors: ["API Error: 529 overloaded"] };
					};
				});
				const initial = [systemMessage("parent system", [SLOW]), user(PARENT_PROMPT)];
				const first = await collect(streamClaudeAgentSdk(model, { messages: initial }, { sessionId }));
				await tick(10);
				const baseline = { query: __testQueryLaneCount(), shared: __testSharedSessionLaneCount() };

				let reviewer;
				const cancel = outcome === "is cancelled while its tool runs";
				reviewer = new Agent({
					initialState: {
						systemPrompt: "You are a reviewer",
						model,
						tools: [{
							name: "inspect", label: "Inspect", description: "inspect", parameters: Type.Object({ id: Type.String() }),
							async execute() {
								failForeign();
								// Pi still runs the tool when the foreign query has ended.
								await waitFor(() => observed.queries[1]?.closed === true, "the foreign query to end");
								await tick(10);
								if (cancel) reviewer.abort();
								return { content: [{ type: "text", text: "inspected" }], details: {} };
							},
						}],
					},
					...(sessionId === undefined ? {} : { sessionId }),
					streamFn: (m, context, options) => streamClaudeAgentSdk(m, context, options),
				});
				const run = reviewer.prompt(REVIEWER_PROMPT);
				const settled = await Promise.race([run.then(() => "settled"), tick(1500).then(() => "hung")]);
				if (settled === "hung") reviewer.abort();
				assert.equal(settled, "settled");
				const final = reviewer.state.messages.at(-1);
				if (cancel) {
					// Pi's loop still delivers the result, on a cancelled signal,
					// which never reports a held failure (E3).
					assert.equal(final.stopReason, "stop");
					assert.equal(final.errorMessage, undefined);
				} else {
					assert.equal(final.stopReason, "error", "the foreign conversation's own callback reports its failure");
					assert.equal(final.errorMessage, "API Error: 529 overloaded");
				}
				await tick(20);
				assert.equal(__testQueryLaneCount(), baseline.query, "the foreign lane is released");
				assert.equal(__testSharedSessionLaneCount(), baseline.shared);
				assert.equal(forkLaneCount(), 0, "no fork lane stays registered");

				releaseParent();
				const callback = await collect(streamClaudeAgentSdk(model, { messages: [...initial, first.at(-1).message, toolResult("call-parent")] }, { sessionId }));
				assert.equal(textOf(callback), "parent done", "the parent completes untouched");
			});
		}
	}
});

describe("a foreign query's held failure when no callback ever comes", () => {
	it("releases the foreign lane once the foreign run is cancelled", BOUNDED, async () => {
		// The parent waits on its tool in MAIN; a same-id foreign query fails
		// after its own tool turn, and its run is then cancelled without
		// delivering the tool result.
		let fail;
		const failGate = new Promise((resolve) => { fail = resolve; });
		installFakeClaudeCode((prompt) => {
			if (prompt === PARENT_PROMPT) return async function* ({ tools }) {
				yield* tools([{ id: "call-parent", tool: SLOW.name, args: { id: "parent" } }]);
			};
			if (prompt === REVIEWER_PROMPT) return async function* () {
				yield* toolMessage("r1", [{ id: "call-review", tool: "inspect", args: { id: "r" } }]);
				await failGate;
				yield { type: "result", subtype: "error_during_execution", errors: ["API Error: 529 overloaded"] };
			};
		});
		await collect(streamClaudeAgentSdk(model, { messages: [systemMessage("parent system", [SLOW]), user(PARENT_PROMPT)] }, { sessionId: "MAIN" }));
		await tick(10);
		const baseline = __testQueryLaneCount();
		const sharedBaseline = __testSharedSessionLaneCount();
		const run = new AbortController();
		const foreign = await collect(streamClaudeAgentSdk(model, { messages: [systemMessage("You are a reviewer"), user(REVIEWER_PROMPT)] }, { sessionId: "MAIN", signal: run.signal }));
		assert.deepEqual(lastEvent(foreign), ["done", "toolUse"]);
		fail();
		await tick(20);
		assert.equal(__testQueryLaneCount(), baseline + 1, "the foreign lane waits for its tool-result callback");
		run.abort();
		assert.equal(__testQueryLaneCount(), baseline, "the cancelled run releases it");
		assert.equal(__testSharedSessionLaneCount(), sharedBaseline, "no foreign session record remains");
		assert.equal(forkLaneCount(), 0, "no fork lane stays registered");
	});
});

// --- A lane lives as long as the query that owns it ---
//
// An account retry or a restart replaces a query inside its lane, and the
// failed attempt forwards the replacement's Pi stream. That stream ends at a
// tool-use turn while the replacement query keeps waiting for the result, so
// the forwarding attempt finishing must not release the lane: the genuine
// tool-result callback has to find the replacement query there.

const ACCOUNT_ROUTER_KEY = Symbol.for("kendex.pi.claude-account-router.v1");

/** A companion account router with profiles `a` and `b`: an attempt that
 *  excluded `a` gets `b`. */
function installTwoAccountRouter() {
	globalThis[ACCOUNT_ROUTER_KEY] = {
		version: 1,
		acquire({ excludedProfileIds = [] }) {
			const id = excludedProfileIds.includes("a") ? "b" : "a";
			return { profileId: id, label: id };
		},
		recordIdentity() {}, recordUsage() {},
		recordRateLimit() { return Date.now() + 60_000; },
		recordFailure() {}, recordSuccess() {}, current() {},
	};
	return () => { delete globalThis[ACCOUNT_ROUTER_KEY]; };
}

describe("a replacement query keeps its lane until it ends", () => {
	it("a foreign request's account retry that hands Pi a tool call still gets that call's result", BOUNDED, async () => {
		let attempts = 0;
		const observed = installFakeClaudeCode((prompt) => {
			if (prompt === PARENT_PROMPT) return async function* ({ tools, text }) {
				yield* tools([{ id: "parent-call", tool: SLOW.name, args: { id: "parent" } }]);
				yield* text("parent done");
				yield { type: "result", subtype: "success" };
			};
			if (prompt === "FOREIGN") {
				attempts += 1;
				// Account a: rate-limited before any output, so the request rotates.
				if (attempts === 1) return async function* () {
					yield { type: "result", subtype: "error_during_execution", errors: ["API Error: 429 rate limit exceeded"] };
				};
				return async function* ({ tools, text }) {
					yield* tools([{ id: "foreign-call", tool: SLOW.name, args: { id: "foreign" } }]);
					yield* text("foreign done");
					yield { type: "result", subtype: "success" };
				};
			}
		});
		const run = new AbortController();
		const parent = [systemMessage("parent", [SLOW]), user(PARENT_PROMPT)];
		const parentFirst = await collect(streamClaudeAgentSdk(model, { messages: parent }, { sessionId: "MAIN", signal: run.signal }));
		await tick(10);
		const baseline = { query: __testQueryLaneCount(), shared: __testSharedSessionLaneCount() };
		const removeRouter = installTwoAccountRouter();
		try {
			const foreign = [systemMessage("foreign", [SLOW]), user("FOREIGN")];
			const first = await collect(streamClaudeAgentSdk(model, { messages: foreign }, { sessionId: "MAIN", signal: run.signal }));
			assert.deepEqual(lastEvent(first), ["done", "toolUse"], "the retry on account b handed Pi its tool call");
			assert.equal(attempts, 2);
			// Let the failed attempt's pipeline finish forwarding and clean up.
			await tick(30);
			const laneHeld = forkLaneCount() === 1;
			const done = await collect(streamClaudeAgentSdk(model, { messages: [...foreign, first.at(-1).message, toolResult("foreign-call")] }, { sessionId: "MAIN", signal: run.signal }));
			assert.deepEqual(lastEvent(done), ["done", "stop"]);
			assert.equal(textOf(done), "foreign done", "the retried query received the result and answered");
			assert.deepEqual(observed.queries.at(-1).results, { "foreign-call": "result foreign-call" });
			assert.ok(laneHeld, "the retry's lane was still there while its query waited on the tool");
		} finally {
			removeRouter();
		}
		await tick(30);
		assert.equal(__testQueryLaneCount(), baseline.query, "the retry's lane is released once its query ends");
		assert.equal(__testSharedSessionLaneCount(), baseline.shared);
		assert.equal(forkLaneCount(), 0);
		const parentDone = await collect(streamClaudeAgentSdk(model, { messages: [...parent, parentFirst.at(-1).message, toolResult("parent-call")] }, { sessionId: "MAIN", signal: run.signal }));
		assert.equal(textOf(parentDone), "parent done", "the parent completes untouched");
	});

	it("a cacheRetention:none lane's restart that hands Pi a tool call still gets that call's result", BOUNDED, async () => {
		// Pi replaces the history while the query waits on a tool; the callback
		// restarts the query on the new history, and the restarted query asks
		// for another tool before it answers.
		const observed = installFakeClaudeCode((prompt) => {
			if (prompt === PARENT_PROMPT) return async function* ({ tools, text }) {
				yield* tools([{ id: "c1", tool: SLOW.name, args: { id: "c1" } }]);
				yield* text("never");
				yield { type: "result", subtype: "success" };
			};
			if (prompt.includes("rewritten by Pi")) return async function* ({ tools, text }) {
				yield* tools([{ id: "restart-call", tool: SLOW.name, args: { id: "restart" } }]);
				yield* text("restart done");
				yield { type: "result", subtype: "success" };
			};
		});
		const baseline = { query: __testQueryLaneCount(), shared: __testSharedSessionLaneCount() };
		const options = { sessionId: "ONE-SHOT", cacheRetention: "none" };
		const initial = [systemMessage("sys", [SLOW]), user(PARENT_PROMPT)];
		const first = await collect(streamClaudeAgentSdk(model, { messages: initial }, options));
		await tick(10);
		runInRequestLane("ONE-SHOT", () => onPiHistoryReplaced("session_compact"));
		const compacted = [systemMessage("sys", [SLOW]), user("Summary of the conversation"), first.at(-1).message, toolResult("c1")];
		const restarted = await collect(streamClaudeAgentSdk(model, { messages: compacted }, options));
		assert.deepEqual(lastEvent(restarted), ["done", "toolUse"], "the restarted query handed Pi its tool call");
		assert.equal(observed.queries[0].closed, true, "the original query was stopped");
		// Let the original query's pipeline finish forwarding and clean up.
		await tick(30);
		const laneHeld = runInRequestLane("ONE-SHOT", () => ctx().activeQuery !== null);
		const done = await collect(streamClaudeAgentSdk(model, { messages: [...compacted, restarted.at(-1).message, toolResult("restart-call")] }, options));
		assert.deepEqual(lastEvent(done), ["done", "stop"]);
		assert.equal(textOf(done), "restart done", "the restarted query received the result and answered");
		assert.deepEqual(observed.queries.at(-1).results, { "restart-call": "result restart-call" });
		assert.ok(laneHeld, "the restarted query still owned the lane while it waited on the tool");
		await tick(30);
		assert.equal(__testQueryLaneCount(), baseline.query, "the one-shot lane is released once its last query ends");
		assert.equal(__testSharedSessionLaneCount(), baseline.shared);
	});

	it("guard: Pi's own cacheRetention:none one-shot still releases its lane as soon as it settles", BOUNDED, async () => {
		installFakeClaudeCode((prompt) => prompt === "Summarize the branch" ? continuationScript : undefined);
		const baseline = { query: __testQueryLaneCount(), shared: __testSharedSessionLaneCount() };
		const events = await collect(streamClaudeAgentSdk(model, { messages: [systemMessage("Summarizer"), user("Summarize the branch")] }, { sessionId: "summary-one-shot", cacheRetention: "none" }));
		assert.deepEqual(lastEvent(events), ["done", "stop"]);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(__testQueryLaneCount(), baseline.query, "released within one macrotask of the answer");
		assert.equal(__testSharedSessionLaneCount(), baseline.shared);
	});
});

// --- A request that throws before its query pipeline exists ---
//
// requestLaneFor registers a fork before the request runs. The executable
// and cwd preflight, or the SDK spawning Claude Code, can throw synchronously
// before the pipeline whose teardown releases the lane exists. That exit must
// release a lane nothing uses and leave the error exactly as it was.

/** Pins the Claude Code executable (to this node binary, a real executable)
 *  through a test-owned Pi agent dir, so the real preflight runs on every
 *  machine whether or not `claude` is on PATH. */
function pinClaudeExecutable() {
	const previous = process.env.PI_CODING_AGENT_DIR;
	writeFileSync(join(root, "claude-bridge.json"), JSON.stringify({ provider: { pathToClaudeCodeExecutable: process.execPath } }));
	process.env.PI_CODING_AGENT_DIR = root;
	return () => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	};
}

const laneCounts = () => ({ forks: forkLaneCount(), query: __testQueryLaneCount(), shared: __testSharedSessionLaneCount() });

const parkedParentScript = async function* ({ tools, text }) {
	yield* tools([{ id: "parent-call", tool: SLOW.name, args: { id: "parent" } }]);
	yield* text("parent done");
	yield { type: "result", subtype: "success" };
};

describe("a request that throws before its query exists releases its lane", () => {
	for (const [name, sessionId] of [["with the parent's session id", "MAIN"], ["with no session id (the busy default lane)", undefined]]) {
		it(`three foreign calls ${name} that fail the cwd preflight leave no lane behind`, BOUNDED, async () => {
			const observed = installFakeClaudeCode((prompt) => prompt === PARENT_PROMPT ? parkedParentScript : undefined);
			const restore = pinClaudeExecutable();
			try {
				const parent = [systemMessage("parent", [SLOW]), user(PARENT_PROMPT)];
				const first = await collect(streamClaudeAgentSdk(model, { messages: parent }, { sessionId }));
				assert.deepEqual(lastEvent(first), ["done", "toolUse"]);
				await tick(10);
				const before = parentState(sessionId);
				const baseline = laneCounts();
				for (let attempt = 0; attempt < 3; attempt++) {
					assert.throws(
						() => streamClaudeAgentSdk(model, { messages: [systemMessage("foreign"), user("foreign")] }, { sessionId, cwd: join(root, "missing-cwd") }),
						(error) => error.name === "ClaudeExecutablePreflightError" && /cwd preflight failed/.test(error.message),
						"the preflight error reaches the caller unchanged",
					);
					assert.deepEqual(laneCounts(), baseline, `failed call ${attempt + 1} left no fork, query lane or session record`);
				}
				assert.equal(observed.queries.length, 1, "no Claude Code was started for the failed calls");
				assert.deepEqual(parentState(sessionId), before, "the parent is untouched");
				const done = await collect(streamClaudeAgentSdk(model, { messages: [...parent, first.at(-1).message, toolResult("parent-call")] }, { sessionId }));
				assert.equal(textOf(done), "parent done", "the parent completes");
				await tick(20);
				assert.equal(forkLaneCount(), 0);
			} finally {
				restore();
			}
		});
	}

	it("Pi's cacheRetention:none one-shot that fails the cwd preflight releases its lane", BOUNDED, async () => {
		const observed = installFakeClaudeCode(() => undefined);
		const restore = pinClaudeExecutable();
		try {
			const baseline = laneCounts();
			assert.throws(
				() => streamClaudeAgentSdk(model, { messages: [systemMessage("Summarizer"), user("Summarize the branch")] }, { sessionId: "summary-one-shot", cacheRetention: "none", cwd: join(root, "missing-cwd") }),
				(error) => error.name === "ClaudeExecutablePreflightError",
			);
			assert.deepEqual(laneCounts(), baseline, "the one-shot's lane is gone");
			assert.equal(observed.queries.length, 0);
		} finally {
			restore();
		}
	});

	it("a foreign call whose SDK construction throws leaves no lane behind and rethrows that error", BOUNDED, async () => {
		const boom = new Error("spawn claude ENOENT");
		const observed = installFakeClaudeCode(
			(prompt) => prompt === PARENT_PROMPT ? parkedParentScript : undefined,
			{ construct: (index) => { if (index > 0) throw boom; } },
		);
		const parent = [systemMessage("parent", [SLOW]), user(PARENT_PROMPT)];
		const first = await collect(streamClaudeAgentSdk(model, { messages: parent }, { sessionId: "MAIN" }));
		await tick(10);
		const before = parentState("MAIN");
		const baseline = laneCounts();
		assert.throws(
			() => streamClaudeAgentSdk(model, { messages: [systemMessage("foreign"), user("foreign")] }, { sessionId: "MAIN" }),
			(error) => error === boom,
			"the very same error reaches the caller",
		);
		assert.deepEqual(laneCounts(), baseline, "no fork, query lane or session record is left");
		assert.equal(observed.queries.length, 1);
		assert.deepEqual(parentState("MAIN"), before, "the parent is untouched");
		const done = await collect(streamClaudeAgentSdk(model, { messages: [...parent, first.at(-1).message, toolResult("parent-call")] }, { sessionId: "MAIN" }));
		assert.equal(textOf(done), "parent done", "the parent completes");
	});

	it("guard: a foreign account retry whose SDK construction throws surfaces the error and releases its fork", BOUNDED, async () => {
		// The retry re-enters inside the failed attempt's pipeline, so its
		// throw ends in that pipeline's error path and final release.
		let foreignAttempts = 0;
		const boom = new Error("spawn claude ENOENT on account b");
		installFakeClaudeCode(
			(prompt) => {
				if (prompt === PARENT_PROMPT) return parkedParentScript;
				if (prompt === "FOREIGN") return async function* () {
					yield { type: "result", subtype: "error_during_execution", errors: ["API Error: 429 rate limit exceeded"] };
				};
			},
			{ construct: (index) => { if (index > 0 && ++foreignAttempts === 2) throw boom; } },
		);
		const parent = [systemMessage("parent", [SLOW]), user(PARENT_PROMPT)];
		const first = await collect(streamClaudeAgentSdk(model, { messages: parent }, { sessionId: "MAIN" }));
		await tick(10);
		const baseline = laneCounts();
		const removeRouter = installTwoAccountRouter();
		try {
			const events = await collect(streamClaudeAgentSdk(model, { messages: [systemMessage("foreign"), user("FOREIGN")] }, { sessionId: "MAIN" }));
			assert.deepEqual(lastEvent(events), ["error", "error"]);
			assert.equal(events.at(-1).error.errorMessage, boom.message);
			assert.equal(foreignAttempts, 2);
		} finally {
			removeRouter();
		}
		await tick(30);
		assert.deepEqual(laneCounts(), baseline, "the retried fork is released");
		const done = await collect(streamClaudeAgentSdk(model, { messages: [...parent, first.at(-1).message, toolResult("parent-call")] }, { sessionId: "MAIN" }));
		assert.equal(textOf(done), "parent done");
	});
});

// --- An idle lane: a foreign call must leave the conversation's state alone ---
//
// While the lane's conversation is idle there is no running query to join,
// and its next request can arrive at any moment. A request the existing
// evidence identifies as another conversation (the conversation-fingerprint
// guard, or a tool result for a call no query of the lane handed to Pi) runs
// in a fork lane of its own, exactly like one that finds the lane busy.

const MAIN_TURN = (n) => `MAIN turn ${n}`;
const FOREIGN_TOOL_PROMPT = "FOREIGN: inspect something";
const IDLE_LANES = [["the conversation's session id", "MAIN"], ["no session id, conversation in the default lane", undefined]];

const debugLogText = () => { try { return readFileSync(process.env.CLAUDE_BRIDGE_DEBUG_PATH, "utf8"); } catch { return ""; } };
/** Runs the provider call `call` and returns its result with the session-sync
 *  decisions ("reuse", "rebuild", "clean-start", ...) it logged. The sync is
 *  synchronous inside the call, so only this call's lines are read. */
function withSyncPaths(call) {
	const start = debugLogText().length;
	const result = call();
	const log = debugLogText();
	const since = log.length >= start ? log.slice(start) : log;
	return { result, paths: [...since.matchAll(/syncResult: path=([a-z-]+)/g)].map((match) => match[1]) };
}

const mainTurnScript = (prompt) => {
	const turn = /^MAIN turn (\d+)$/.exec(prompt);
	if (!turn) return undefined;
	return async function* ({ text }) {
		yield* text(`answer ${turn[1]}`);
		yield { type: "result", subtype: "success" };
	};
};

/** The per-query state an idle conversation keeps for its next request. */
function idleState(sessionId) {
	return runInRequestLane(sessionId, () => {
		const c = ctx();
		const record = __testGetBridgeIntegrityState().sharedSession;
		return {
			context: c,
			activeQuery: c.activeQuery,
			detachedFromSharedSession: c.detachedFromSharedSession,
			latestCursor: c.latestCursor,
			latestCursorDigest: c.latestCursorDigest,
			forwardedToolCallIds: [...c.forwardedToolCallIds],
			undeliveredFailure: c.undeliveredFailure,
			record: record ? { ...record } : null,
		};
	});
}

describe("a foreign call while the conversation's lane is idle", () => {
	for (const [label, sessionId] of IDLE_LANES) {
		it(`still running when the next prompt arrives, it does not cost that prompt its warm Claude session (${label})`, BOUNDED, async () => {
			let releaseReviewer;
			const reviewerGate = new Promise((resolve) => { releaseReviewer = resolve; });
			const observed = installFakeClaudeCode((prompt) => {
				if (prompt === REVIEWER_PROMPT) return async function* (helpers) {
					await reviewerGate;
					yield* reviewerScript(helpers);
				};
				return mainTurnScript(prompt);
			});
			let history = [systemMessage("main system"), user(MAIN_TURN(1))];
			const turn1 = await collect(streamClaudeAgentSdk(model, { messages: history }, { sessionId }));
			assert.equal(textOf(turn1), "answer 1");
			history = [...history, turn1.at(-1).message];
			await tick(10);
			const idle = laneCounts();
			const before = idleState(sessionId);

			// A reviewer with the same lane key, still thinking when the user
			// sends the next prompt.
			const reviewer = collect(streamClaudeAgentSdk(model, { messages: [systemMessage("You are a reviewer"), user(REVIEWER_PROMPT)] }, { sessionId }), 3000);
			reviewer.catch(() => {});
			let turn2;
			try {
				await tick(10);
				history = [...history, user(MAIN_TURN(2))];
				const second = withSyncPaths(() => streamClaudeAgentSdk(model, { messages: history }, { sessionId }));
				assert.deepEqual(second.paths, ["reuse"], "the next prompt resumes the conversation's own Claude session");
				turn2 = await collect(second.result);
				assert.equal(textOf(turn2), "answer 2");
				assert.equal(observed.queries.find((query) => query.prompt === MAIN_TURN(2))?.resume, "sdk-1", "turn 2 resumes turn 1's Claude session");
			} finally {
				releaseReviewer();
			}
			const reviewed = await reviewer;
			assert.deepEqual(lastEvent(reviewed), ["done", "stop"]);
			assert.equal(textOf(reviewed), REVIEWER_ANSWER, "the reviewer gets its own answer");
			assert.equal(observed.queries.find((query) => query.prompt === REVIEWER_PROMPT)?.resume, undefined, "the reviewer never resumes the conversation's session");

			history = [...history, turn2.at(-1).message, user(MAIN_TURN(3))];
			const third = withSyncPaths(() => streamClaudeAgentSdk(model, { messages: history }, { sessionId }));
			assert.deepEqual(third.paths, ["reuse"], "the turn after resumes it too: the record followed turn 2");
			assert.equal(textOf(await collect(third.result)), "answer 3");
			const record = runInRequestLane(sessionId, () => __testGetBridgeIntegrityState().sharedSession);
			assert.equal(record?.cursor, history.length, "the record covers the conversation through turn 3's prompt");
			assert.equal(record?.needsRebuild, undefined);
			assert.equal(before.record?.sessionId, "sdk-1");
			await tick(20);
			assert.deepEqual(laneCounts(), idle, "no fork, query lane or session record is left behind");
		});

		it(`finished before the next prompt, it leaves the idle conversation's query state alone (${label})`, BOUNDED, async () => {
			installFakeClaudeCode((prompt) => prompt === REVIEWER_PROMPT ? reviewerScript : mainTurnScript(prompt));
			let history = [systemMessage("main system"), user(MAIN_TURN(1))];
			const turn1 = await collect(streamClaudeAgentSdk(model, { messages: history }, { sessionId }));
			history = [...history, turn1.at(-1).message];
			await tick(10);
			const idle = laneCounts();
			const before = idleState(sessionId);
			// Longer than the conversation's own context, so no cursor or digest
			// could coincide.
			const reviewer = await collect(streamClaudeAgentSdk(model, { messages: [systemMessage("You are a reviewer"), user("REVIEW CONTEXT"), user(REVIEWER_PROMPT)] }, { sessionId }));
			assert.equal(textOf(reviewer), REVIEWER_ANSWER);
			await tick(10);
			const after = idleState(sessionId);
			const lanesAfter = laneCounts();
			// The next prompt reuses the session either way: the one-shot never
			// touched the record, and a fresh query resets the context.
			history = [...history, user(MAIN_TURN(2))];
			const second = withSyncPaths(() => streamClaudeAgentSdk(model, { messages: history }, { sessionId }));
			assert.deepEqual(second.paths, ["reuse"]);
			assert.equal(textOf(await collect(second.result)), "answer 2");
			assert.deepEqual(after, before, "the conversation's query context and record are unchanged");
			assert.deepEqual(lanesAfter, idle, "the reviewer's lane is gone");
		});

		it(`an orphaned tool result of another conversation does not mark the idle conversation's record for rebuild (${label})`, BOUNDED, async () => {
			let releaseParent;
			const parentGate = new Promise((resolve) => { releaseParent = resolve; });
			const observed = installFakeClaudeCode((prompt) => {
				if (prompt === PARENT_PROMPT) return async function* ({ tools, text }) {
					yield* tools([{ id: "parent-call", tool: SLOW.name, args: { id: "parent" } }]);
					await parentGate;
					yield* text("parent done");
					yield { type: "result", subtype: "success" };
				};
				// Claude Code hands Pi a call, then stops waiting for it and ends.
				if (prompt === FOREIGN_TOOL_PROMPT) return async function* () {
					yield* toolMessage("f1", [{ id: "foreign-call", tool: "inspect", args: { id: "f" } }]);
					yield { type: "result", subtype: "success" };
				};
				return mainTurnScript(prompt);
			});
			const parent = [systemMessage("parent", [SLOW]), user(PARENT_PROMPT)];
			const first = await collect(streamClaudeAgentSdk(model, { messages: parent }, { sessionId }));
			assert.deepEqual(lastEvent(first), ["done", "toolUse"]);
			await tick(10);

			// While the parent waits on its tool, the other conversation's query
			// hands Pi a call and ends. Its history is longer than what the
			// parent's record covers, so the fingerprint guard cannot place it;
			// only its unclaimed tool result can.
			const foreign = [systemMessage("You are a reviewer"), user("REVIEW CONTEXT 1"), user("REVIEW CONTEXT 2"), user("REVIEW CONTEXT 3"), user(FOREIGN_TOOL_PROMPT)];
			const foreignTurn = await collect(streamClaudeAgentSdk(model, { messages: foreign }, { sessionId }));
			assert.deepEqual(lastEvent(foreignTurn), ["done", "toolUse"]);

			releaseParent();
			const done = await collect(streamClaudeAgentSdk(model, { messages: [...parent, first.at(-1).message, toolResult("parent-call")] }, { sessionId }));
			assert.equal(textOf(done), "parent done");
			let history = [...parent, first.at(-1).message, toolResult("parent-call"), done.at(-1).message];
			await tick(20);
			const idle = laneCounts();
			const before = idleState(sessionId);
			assert.equal(before.activeQuery, null, "the parent is idle");
			assert.equal(before.record?.needsRebuild, undefined);

			// Pi finishes the other conversation's tool and hands its result back.
			const orphanContext = [...foreign, foreignTurn.at(-1).message, toolResult("foreign-call")];
			assert.notEqual(sessionPersistence.isForeignConversation?.(before.record, orphanContext), true, "the fingerprint guard does not place this request");
			const orphan = await collect(streamClaudeAgentSdk(model, { messages: orphanContext }, { sessionId }));
			assert.deepEqual(lastEvent(orphan), ["done", "stop"], "the orphaned result ends its turn");
			await tick(10);
			const recordAfter = idleState(sessionId).record;
			const lanesAfter = laneCounts();
			history = [...history, user(MAIN_TURN(2))];
			const next = withSyncPaths(() => streamClaudeAgentSdk(model, { messages: history }, { sessionId }));
			assert.deepEqual(next.paths, ["reuse"], "the conversation's next prompt resumes its warm session");
			assert.equal(textOf(await collect(next.result)), "answer 2");
			assert.equal(observed.queries.find((query) => query.prompt === MAIN_TURN(2))?.resume, "sdk-1");
			assert.deepEqual(recordAfter, before.record, "the idle conversation's record is unchanged");
			assert.deepEqual(lanesAfter, idle, "no fork, query lane or session record is left behind");
		});
	}
});
