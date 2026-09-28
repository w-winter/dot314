// A mid-turn steer is replayed to Claude as a continuation query after the
// original query ends; its answer joins the same Pi message. When that
// continuation fails, the Claude reply that was already complete must survive:
// in what Pi shows and persists and in what a later rebuild imports into
// Claude, exactly once and where a successful continuation would have put it.
// The failing continuation's own output, partial text or tool calls, must
// never come back.
//
// Driven through Pi's real agent loop (runAgentLoop, real steering) with every
// provider stream encoded by Pi's real frame consumer, persisted through Pi's
// real SessionManager and read back from disk, then imported into Claude by a
// forced bridge rebuild whose JSONL is inspected.
import "./lib/debug-env.mjs";

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { openSession } from "cc-session-io";

import { AssistantMessageFrameEncoder, Type } from "@earendil-works/pi-ai";
import { SessionManager, convertToLlm } from "@earendil-works/pi-coding-agent";
import { runAgentLoop, runAgentLoopContinue } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/index.js";
import {
	__testGetBridgeIntegrityState,
	__testSetBridgeIntegrityState,
	__testSetSdkQueryFactory,
	streamClaudeAgentSdk,
} from "../src/index.ts";
import { setExtensionApi } from "../src/bridge-state.ts";
import { resetStack } from "../src/query-state.ts";
import { runInRequestLane } from "../src/request-lane.ts";
import { encodeLikePi } from "./lib/pi-frame-consumer.mjs";

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
const CHILD_SESSION = "22222222-2222-4222-8222-222222222222";

let root;
let notifications;
let integrityEntries;
let keepAlive;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "bridge-continuation-failure-"));
	process.env.CLAUDE_CONFIG_DIR = root;
	process.env.CLAUDE_CODE_OAUTH_TOKEN = "offline-test";
	process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT = "0";
	process.env.CLAUDE_BRIDGE_DIAG_PATH = join(root, "diag.log");
	resetStack();
	notifications = [];
	integrityEntries = [];
	__testSetBridgeIntegrityState({ sharedSession: null, ui: { notify: (message, level) => notifications.push({ message, level }) } });
	setExtensionApi({
		events: { emit: () => {} },
		appendEntry: (customType, data) => integrityEntries.push({ customType, data }),
	});
	// Node 22 exits a test whose only pending work is the fake SDK's promises.
	keepAlive = setInterval(() => {}, 1000);
});

afterEach(() => {
	clearInterval(keepAlive);
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

// --- Fake Claude Code messages ---

let messageSeq = 0;
const messageStart = () => ({ type: "stream_event", event: { type: "message_start", message: { id: `m${++messageSeq}`, model: model.id, usage: { input_tokens: 1 } } } });
const toolUseMessage = (id) => [
	messageStart(),
	{ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name: "mcp__custom-tools__mytool", input: {} } } },
	{ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } } },
	{ type: "stream_event", event: { type: "content_block_stop", index: 0 } },
	{ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } } },
	{ type: "stream_event", event: { type: "message_stop" } },
];
const textMessage = (text) => [
	messageStart(),
	{ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
	{ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } },
	{ type: "stream_event", event: { type: "content_block_stop", index: 0 } },
	{ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } } },
	{ type: "stream_event", event: { type: "message_stop" } },
];
/** Output a failing continuation streams before it dies: never complete. */
const PARTIAL_OUTPUT = {
	text: () => [
		messageStart(),
		{ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
		{ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "PARTIAL-CONTINUATION-TEXT" } } },
	],
	tool: () => [
		messageStart(),
		{ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
		{ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "PARTIAL-BEFORE-TOOL" } } },
		{ type: "stream_event", event: { type: "content_block_stop", index: 0 } },
		{ type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "failed-call", name: "mcp__custom-tools__mytool", input: {} } } },
		{ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"x\":" } } },
	],
};

const STALL = Symbol("stall until closed");
const FAILURES = {
	error_during_execution: () => [{ type: "result", subtype: "error_during_execution", errors: ["API Error: 500 internal server error"] }],
	// Claude Code's own usage-limit copy: surfaced from inside consumeQuery.
	"usage limit": () => [{ type: "result", subtype: "error_during_execution", errors: ["You've hit your weekly limit · resets Thursday 4am"] }],
	"process throw": () => [new Error("Claude Code process exited with code 1")],
	"stream idle timeout": () => [STALL],
};

// Pi cancels the request (the user presses Escape) while a continuation runs.
let cancelTurn = () => { throw new Error("no cancellable turn"); };
const CANCELLATIONS = {
	// Claude Code's child is torn down and the SDK iterator throws.
	"then the continuation throws": () => [() => { cancelTurn(); throw new Error("Operation aborted"); }],
	// The continuation reports a failure after the cancellation.
	"then the continuation reports an error": () => [() => cancelTurn(), { type: "result", subtype: "error_during_execution", errors: ["API Error: 500 internal server error"] }],
	// The continuation just ends.
	"then the continuation ends quietly": () => [() => cancelTurn()],
};

/** One fake SDK query. A function step is awaited; STALL waits for close(). */
function fakeQuery(steps) {
	let closed = false;
	let wake = () => {};
	const closedSignal = new Promise((resolve) => { wake = resolve; });
	return {
		async *[Symbol.asyncIterator]() {
			yield { type: "system", subtype: "init", session_id: CHILD_SESSION };
			for (const step of steps) {
				if (closed) return;
				if (step === STALL) { await closedSignal; return; }
				if (typeof step === "function") { await step(); continue; }
				if (step instanceof Error) throw step;
				yield step;
			}
		},
		close() { closed = true; wake(); },
		async interrupt() { closed = true; wake(); },
	};
}

/**
 * Real Pi turn: the original query calls `mytool` once per steer; while each
 * call runs, the user sends one steer, so each reaches the bridge in its own
 * tool-result callback and is deferred. The original query then answers
 * `original` and succeeds; continuation i answers `continuations[i]` (a
 * string: success) or fails (an object: { partial, failure }).
 */
async function runSteeredTurn(sessionId, { steers, continuations, original = "ORIGINAL-REPLY" }) {
	const callbackSeen = [];
	for (let i = 0; i <= steers.length; i++) callbackSeen.push(Promise.withResolvers());
	let queries = 0;
	__testSetSdkQueryFactory(() => {
		queries += 1;
		if (queries === 1) {
			const steps = [];
			for (let i = 0; i < steers.length; i++) {
				steps.push(...toolUseMessage(`call-${i}`));
				// Wait for Pi's callback that carries this call's result and steer.
				steps.push(() => callbackSeen[i + 1].promise);
			}
			if (original) steps.push(...textMessage(original));
			steps.push({ type: "result", subtype: "success", result: original });
			return fakeQuery(steps);
		}
		const next = continuations[queries - 2];
		if (typeof next === "string") return fakeQuery([...textMessage(next), { type: "result", subtype: "success", result: next }]);
		return fakeQuery([...PARTIAL_OUTPUT[next.partial](), ...(FAILURES[next.failure] ?? CANCELLATIONS[next.failure])()]);
	});
	const controller = new AbortController();
	cancelTurn = () => controller.abort();

	const pending = [...steers];
	let executed = 0;
	let delivered = 0;
	const persisted = [];
	const streams = [];
	await runAgentLoop(
		[{ role: "user", content: "start the task", timestamp: Date.now() }],
		{ messages: [], tools: [{
			name: "mytool", label: "My tool", description: "test tool", parameters: Type.Object({}),
			async execute() { executed += 1; return { content: [{ type: "text", text: "TOOL-RESULT" }], details: {} }; },
		}] },
		{
			model,
			convertToLlm: (messages) => messages,
			sessionId,
			getSteeringMessages: async () => {
				// The user types each steer while a tool call runs.
				if (delivered >= executed) return [];
				delivered += 1;
				const steer = pending.shift();
				return steer ? [{ role: "user", content: steer, timestamp: Date.now() }] : [];
			},
		},
		// Pi persists every message at message_end.
		async (event) => { if (event.type === "message_end") persisted.push(event.message); },
		controller.signal,
		(m, context, options) => {
			const inner = streamClaudeAgentSdk(m, context, options);
			callbackSeen[Math.min(streams.length, steers.length)].resolve();
			// Pi's frame encoder runs on every event as Pi consumes it.
			const events = [];
			const encoder = new AssistantMessageFrameEncoder();
			streams.push(events);
			return {
				async *[Symbol.asyncIterator]() {
					for await (const event of inner) {
						events.push(event);
						await Promise.resolve();
						encoder.encode(event);
						yield event;
					}
				},
				result: () => inner.result(),
			};
		},
	);
	// Let the bridge's completion chain (persist, teardown) settle.
	await new Promise((resolve) => setTimeout(resolve, 30));
	// ...and at maximum lag, every event encoded after the stream ended.
	for (const events of streams) encodeLikePi(events);
	return { persisted, streams };
}

/** Write Pi's messages through the real SessionManager and read them back from disk. */
function roundTripThroughPiSession(messages) {
	const sessionDir = join(root, "pi-sessions");
	const manager = SessionManager.create(process.cwd(), sessionDir);
	for (const message of messages) manager.appendMessage(message);
	const reopened = SessionManager.open(manager.getSessionFile(), sessionDir);
	return convertToLlm(reopened.buildSessionContext().messages);
}

/** Force the next prompt through a rebuild and return the Claude transcript it imported. */
async function rebuildImport(sessionId, piMessages) {
	runInRequestLane(sessionId, () => __testSetBridgeIntegrityState({
		sharedSession: { sessionId: CHILD_SESSION, cursor: piMessages.length, cwd: process.cwd(), needsRebuild: true },
	}));
	let resumed;
	__testSetSdkQueryFactory((input) => {
		resumed = input.options.resume;
		return fakeQuery([{ type: "result", subtype: "success", result: "ok" }]);
	});
	const stream = streamClaudeAgentSdk(model, { messages: [...piMessages, { role: "user", content: "next prompt", timestamp: Date.now() }] }, { sessionId });
	for await (const _event of stream) { /* drain */ }
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.ok(resumed, "the next prompt resumes a rebuilt Claude session");
	const jsonl = readFileSync(openSession({ sessionId: resumed, projectPath: process.cwd(), claudeDir: root }).jsonlPath, "utf8");
	const records = jsonl.trim().split("\n").map((line) => JSON.parse(line)).filter((entry) => entry.message).map((entry) => entry.message);
	// "role:text", tool traffic reduced to markers.
	return records.map((record) => {
		const content = typeof record.content === "string" ? [{ type: "text", text: record.content }] : record.content;
		return `${record.role}:${content.map((block) => block.type === "text" ? block.text : `[${block.type} ${block.id ?? block.tool_use_id}]`).join("|")}`;
	});
}

const count = (lines, needle) => lines.filter((line) => line.includes(needle)).length;

/** What Pi keeps and what a rebuild gives Claude, checked the same way for
 *  a successful and a failed last continuation. */
async function assertRepliesKept(sessionId, turn, expectedReplies, { failed = true } = {}) {
	const { persisted, streams } = await runSteeredTurn(sessionId, turn);
	const recordAfterTurn = runInRequestLane(sessionId, () => __testGetBridgeIntegrityState().sharedSession);
	const final = persisted.at(-1);
	const terminal = streams.at(-1).at(-1);
	assert.equal(terminal.type, "done", "the Pi message ends as a reply");
	assert.equal(final, terminal.message, "Pi persists the done message");
	// Kept by every consumer of Pi history (they all skip error/aborted turns).
	assert.equal(final.stopReason, "stop");
	assert.deepEqual(final.content.map((block) => [block.type, block.text]), expectedReplies.map((reply) => ["text", reply]), "exactly the completed replies, in order");
	assert.equal(final.errorMessage, undefined);
	const persistedText = JSON.stringify(persisted);
	assert.doesNotMatch(persistedText, /PARTIAL-/, "the failing continuation's partial output is never persisted");
	assert.doesNotMatch(persistedText, /failed-call/, "the failing continuation's tool call is never persisted");

	const fromDisk = roundTripThroughPiSession(persisted);
	assert.deepEqual(fromDisk.at(-1).content.map((block) => block.text), expectedReplies, "the replies survive Pi's disk round trip");

	const lines = await rebuildImport(sessionId, fromDisk);
	for (const reply of expectedReplies) assert.equal(count(lines, reply), 1, `${reply} imported exactly once:\n${lines.join("\n")}`);
	assert.equal(count(lines, "PARTIAL-"), 0, "no partial continuation output imported");
	assert.equal(count(lines, "failed-call"), 0, "no tool call from the failed continuation imported");
	// Where a successful continuation puts them: one assistant record right
	// after the last steer, in the order Claude wrote them, closing the
	// imported history (the next prompt is the resumed query's own prompt).
	const lastSteer = Math.max(...turn.steers.map((steer) => lines.indexOf(`user:${steer}`)));
	const replyLine = lines.indexOf(`assistant:${expectedReplies.join("|")}`);
	assert.ok(lastSteer >= 0 && replyLine === lastSteer + 1, `replies right after the last steer:\n${lines.join("\n")}`);
	assert.equal(replyLine, lines.length - 1, `nothing imported after the replies:\n${lines.join("\n")}`);
	if (failed) assertFailureReported(recordAfterTurn);
	return { lines };
}

function assertFailureReported(recordAfterTurn) {
	assert.ok(
		notifications.some((entry) => entry.level === "warning" && /mid-turn message/.test(entry.message)),
		`failure reported to the user: ${JSON.stringify(notifications)}`,
	);
	assert.ok(integrityEntries.some((entry) => entry.data?.label === "continuation_failed_after_reply"), "failure recorded in the session");
	// The failed steer may never have reached Claude: the next turn rebuilds.
	assert.equal(recordAfterTurn?.needsRebuild, true, "the next turn rebuilds from Pi history");
}

describe("a failed continuation keeps the replies that completed before it (G3)", () => {
	it("control: every continuation succeeds", async () => {
		const { lines } = await assertRepliesKept("g3-control", {
			steers: ["STEER-ONE", "STEER-TWO"],
			continuations: ["SECOND-REPLY", "THIRD-REPLY"],
		}, ["ORIGINAL-REPLY", "SECOND-REPLY", "THIRD-REPLY"], { failed: false });
		assert.ok(lines.length > 0);
		assert.deepEqual(notifications.filter((entry) => /mid-turn message/.test(entry.message)), []);
	});

	for (const failure of Object.keys(FAILURES)) {
		it(`original success, continuation fails (${failure})`, async () => {
			if (failure === "stream idle timeout") process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT = "300ms";
			const sessionId = `g3-one-${failure.replace(/\W+/g, "-")}`;
			await assertRepliesKept(sessionId, {
				steers: ["STEER-ONE"],
				continuations: [{ partial: "text", failure }],
			}, ["ORIGINAL-REPLY"]);
		});
	}

	it("original success, continuation fails after streaming text and a partial tool call", async () => {
		await assertRepliesKept("g3-one-partial-tool", {
			steers: ["STEER-ONE"],
			continuations: [{ partial: "tool", failure: "error_during_execution" }],
		}, ["ORIGINAL-REPLY"]);
		// The call never reached Pi: nothing was owed a result.
		assert.deepEqual(notifications.filter((entry) => entry.level === "error"), []);
	});

	it("original success, continuation 1 success, continuation 2 fails", async () => {
		await assertRepliesKept("g3-three-segments", {
			steers: ["STEER-ONE", "STEER-TWO"],
			continuations: ["SECOND-REPLY", { partial: "text", failure: "error_during_execution" }],
		}, ["ORIGINAL-REPLY", "SECOND-REPLY"]);
	});

	it("still ends as an error when no reply had completed before the continuation", async () => {
		const { persisted, streams } = await runSteeredTurn("g3-nothing-completed", {
			steers: ["STEER-ONE"],
			continuations: [{ partial: "text", failure: "error_during_execution" }],
			original: "",
		});
		const terminal = streams.at(-1).at(-1);
		assert.equal(terminal.type, "error");
		assert.equal(persisted.at(-1).stopReason, "error");
		assert.match(persisted.at(-1).errorMessage, /internal server error/);
		assert.deepEqual(notifications.filter((entry) => /mid-turn message/.test(entry.message)), []);
	});
});

describe("a cancelled continuation ends as aborted, never as a kept reply", () => {
	for (const cancellation of Object.keys(CANCELLATIONS)) {
		it(`Pi cancels the request, ${cancellation}`, async () => {
			const sessionId = `g3-cancel-${cancellation.replace(/\W+/g, "-")}`;
			const { persisted, streams } = await runSteeredTurn(sessionId, {
				steers: ["STEER-ONE"],
				continuations: [{ partial: "text", failure: cancellation }],
			});
			const terminal = streams.at(-1).at(-1);
			assert.equal(terminal.type, "error", `a cancelled request never completes successfully: ${terminal.type}/${terminal.reason}`);
			assert.equal(terminal.reason, "aborted");
			assert.equal(persisted.at(-1).stopReason, "aborted");
			assert.deepEqual(notifications.filter((entry) => /mid-turn message/.test(entry.message)), [], "no resend warning for a cancellation");
			assert.ok(!integrityEntries.some((entry) => entry.data?.label === "continuation_failed_after_reply"));
			// Pi's abort semantics: an aborted turn is not history (as with a
			// cancelled single query), so the rebuild ends at the steer.
			const lines = await rebuildImport(sessionId, roundTripThroughPiSession(persisted));
			assert.equal(lines.at(-1), "user:STEER-ONE", lines.join("\n"));
			assert.equal(count(lines, "PARTIAL-"), 0);
		});
	}
});

// Pi 0.87.1 creates one AbortController per agent run and hands its signal to
// every provider call of that run. One bridge query can span two runs: a tool
// batch whose tools all return terminate:true ends run 1 while Claude still
// waits for the result, and agent.continue() (post-run compaction, queued
// messages, an extension continuing at agent_before_settle) starts run 2,
// whose first provider call delivers that result under a NEW signal. Esc in
// run 2 aborts only run 2's signal.

/** Wrap the bridge like Pi does: every stream is encoded as consumed. */
function piStreamFn(streams) {
	return (m, context, options) => {
		const inner = streamClaudeAgentSdk(m, context, options);
		const events = [];
		const encoder = new AssistantMessageFrameEncoder();
		streams.push(events);
		return {
			async *[Symbol.asyncIterator]() {
				for await (const event of inner) {
					events.push(event);
					await Promise.resolve();
					encoder.encode(event);
					yield event;
				}
			},
			result: () => inner.result(),
		};
	};
}

/** Run 1 ends after a terminate:true tool batch; run 2 continues with the
 *  tool result and a steer; the original query answers and a continuation
 *  replays the steer, during which run 2 is cancelled (`cancellation`). */
async function runTwoPiRuns(sessionId, cancellation) {
	const run2Callback = Promise.withResolvers();
	const continuation = { interrupted: false };
	let queries = 0;
	__testSetSdkQueryFactory(() => {
		queries += 1;
		if (queries === 1) {
			return fakeQuery([
				...toolUseMessage("call-0"),
				() => run2Callback.promise,
				...textMessage("ORIGINAL-REPLY"),
				{ type: "result", subtype: "success", result: "ORIGINAL-REPLY" },
			]);
		}
		let wake = () => {};
		const interruptedSignal = new Promise((resolve) => { wake = resolve; });
		const steps = cancellation === "none"
			? [...textMessage("SECOND-REPLY"), { type: "result", subtype: "success", result: "SECOND-REPLY" }]
			: cancellation === "then waits to be interrupted"
			? [async () => {
				cancelTurn();
				await Promise.race([interruptedSignal, new Promise((resolve) => setTimeout(resolve, 500))]);
				// The query closes it anyway once it ends; only an interrupt
				// caused by the cancellation counts.
				continuation.interruptedByCancel = continuation.interrupted;
			}]
			: CANCELLATIONS[cancellation]();
		const query = fakeQuery(cancellation === "none" ? steps : [...PARTIAL_OUTPUT.text(), ...steps]);
		const close = query.close;
		query.close = () => { continuation.interrupted = true; wake(); close(); };
		query.interrupt = async () => { continuation.interrupted = true; wake(); close(); };
		return query;
	});

	const tools = [{
		name: "mytool", label: "My tool", description: "test tool", parameters: Type.Object({}),
		// Every tool of the batch says terminate: Pi ends run 1 after it.
		async execute() { return { content: [{ type: "text", text: "TOOL-RESULT" }], details: {}, terminate: true }; },
	}];
	const run1 = new AbortController();
	const run2 = new AbortController();
	const persisted = [];
	const streams = [];
	const emit = async (event) => { if (event.type === "message_end") persisted.push(event.message); };
	const firstRun = await runAgentLoop(
		[{ role: "user", content: "start the task", timestamp: Date.now() }],
		{ messages: [], tools },
		{ model, convertToLlm: (messages) => messages, sessionId },
		emit,
		run1.signal,
		piStreamFn(streams),
	);
	assert.equal(firstRun.at(-1).role, "toolResult", "run 1 ended on the terminating tool batch");
	assert.equal(streams.length, 1, "run 1 made one provider call");

	cancelTurn = () => run2.abort();
	let steered = false;
	const run2StreamFn = piStreamFn(streams);
	await runAgentLoopContinue(
		{ messages: firstRun, tools },
		{
			model,
			convertToLlm: (messages) => messages,
			sessionId,
			getSteeringMessages: async () => {
				if (steered) return [];
				steered = true;
				return [{ role: "user", content: "STEER-ONE", timestamp: Date.now() }];
			},
		},
		emit,
		run2.signal,
		(m, context, options) => {
			assert.equal(options.signal, run2.signal, "run 2's provider calls carry run 2's signal");
			const stream = run2StreamFn(m, context, options);
			run2Callback.resolve();
			return stream;
		},
	);
	await new Promise((resolve) => setTimeout(resolve, 30));
	for (const events of streams) encodeLikePi(events);
	return { persisted, streams, continuation, run1, run2 };
}

describe("cancelling a later Pi run reaches the query it joined", () => {
	for (const cancellation of [...Object.keys(CANCELLATIONS), "then waits to be interrupted"]) {
		it(`run 2 is cancelled during the continuation, ${cancellation}`, async () => {
			const sessionId = `g3-run2-cancel-${cancellation.replace(/\W+/g, "-")}`;
			const { persisted, streams, continuation } = await runTwoPiRuns(sessionId, cancellation);
			if (cancellation === "then waits to be interrupted") {
				assert.equal(continuation.interruptedByCancel, true, "Esc in run 2 interrupts Claude Code");
			}
			const terminal = streams.at(-1).at(-1);
			assert.equal(terminal.type, "error", `a cancelled request never completes successfully: ${terminal.type}/${terminal.reason}`);
			assert.equal(terminal.reason, "aborted");
			assert.equal(persisted.at(-1).stopReason, "aborted");
			assert.deepEqual(notifications.filter((entry) => /mid-turn message/.test(entry.message)), [], "no resend warning for a cancellation");
			const lines = await rebuildImport(sessionId, roundTripThroughPiSession(persisted));
			assert.equal(lines.at(-1), "user:STEER-ONE", lines.join("\n"));
			assert.equal(count(lines, "ORIGINAL-REPLY"), 0, "nothing of the cancelled turn is kept");
			assert.equal(count(lines, "PARTIAL-"), 0);
		});
	}

	it("an old run's signal aborted after the query ended does not touch the next query", async () => {
		const sessionId = "g3-run2-stale-signal";
		// Nothing is cancelled: both runs' signals were live while the query ran.
		const { streams, run1, run2 } = await runTwoPiRuns(sessionId, "none");
		assert.equal(streams.at(-1).at(-1).type, "done", "the two-run query completes");
		assert.deepEqual(streams.at(-1).at(-1).message.content.map((block) => block.text), ["ORIGINAL-REPLY", "SECOND-REPLY"]);
		let interrupted = false;
		__testSetSdkQueryFactory(() => {
			const query = fakeQuery([...textMessage("FRESH-REPLY"), () => new Promise((resolve) => setTimeout(resolve, 20)), { type: "result", subtype: "success", result: "FRESH-REPLY" }]);
			const close = query.close;
			query.interrupt = async () => { interrupted = true; close(); };
			return query;
		});
		const fresh = new AbortController();
		const events = [];
		const stream = streamClaudeAgentSdk(model, { messages: [{ role: "user", content: "a new prompt", timestamp: Date.now() }] }, { sessionId, signal: fresh.signal });
		// Both earlier runs' signals abort while the new query streams.
		run1.abort();
		run2.abort();
		for await (const event of stream) events.push(event);
		assert.equal(events.at(-1).type, "done", `the new query completes: ${events.at(-1).type}/${events.at(-1).reason}`);
		assert.deepEqual(events.at(-1).message.content.map((block) => block.text), ["FRESH-REPLY"]);
		assert.equal(interrupted, false, "an old signal never interrupts the new query");
	});
});
