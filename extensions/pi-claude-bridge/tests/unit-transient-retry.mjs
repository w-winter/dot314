// A transient failure before Claude's first output in a request (an
// overloaded API, a dropped connection, a stalled stream) must reach Pi as an
// error its auto-retry takes (pi-ai isRetryableAssistantError). Pi's retry is
// a new run that drops the failed reply and sends the same history again
// (pi-coding-agent AgentSession._prepareRetry, then agent.continue()), so the
// retry must carry the conversation on exactly once: a prompt reaches Claude
// once, and a turn that ended at tool results goes on from those results.
import "./lib/debug-env.mjs";

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createSession, getSessionPath, openSession } from "cc-session-io";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { runAgentLoop } from "@earendil-works/pi-agent-core";

import { streamClaudeAgentSdk } from "../src/index.ts";
import { __testSetBridgeIntegrityState, getSharedSession, markSessionForRebuild, setExtensionApi } from "../src/bridge-state.ts";
import { runInRequestLane } from "../src/request-lane.ts";
import { __testSetSdkQueryFactory } from "../src/sdk-query.ts";
import { resetStack } from "../src/query-state.ts";

const model = { id: "claude-haiku-4-5", api: "claude-bridge", provider: "pi-claude", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const FAILED_REPLY_RETRY_PROMPT = "[Claude bridge: your previous reply failed before it finished, and Pi is retrying it. The tool results above are complete. Continue from them, and do not repeat a tool call whose result is already above.]";
const env = { dir: undefined };
let previousEnv;
let hold;
beforeEach(() => {
	env.dir = mkdtempSync(join(tmpdir(), "bridge-transient-retry-"));
	const values = { CLAUDE_CONFIG_DIR: env.dir, CLAUDE_CODE_OAUTH_TOKEN: "offline-test", CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT: "0", CLAUDE_BRIDGE_DIAG_PATH: join(env.dir, "diag.log") };
	previousEnv = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
	Object.assign(process.env, values);
	hold = setInterval(() => {}, 1000);
	resetStack();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: { notify() {} } });
	setExtensionApi({ events: { emit() {} }, appendEntry() {} });
});
afterEach(() => {
	clearInterval(hold);
	__testSetSdkQueryFactory();
	resetStack();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
	setExtensionApi(undefined);
	for (const [key, value] of Object.entries(previousEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	execFileSync("trash", [env.dir]);
});
async function collect(stream) {
	const events = [];
	for await (const event of stream) events.push(event);
	return events;
}
function fakeQuery(run, stop = () => {}) {
	return { [Symbol.asyncIterator]: run, close: stop, async interrupt() { stop(); } };
}

const se = (event) => ({ type: "stream_event", event });
const reply = (text) => [
	se({ type: "message_start", message: { id: `m-${text}`, model: model.id, usage: { input_tokens: 1, output_tokens: 1 } } }),
	se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
	se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
	se({ type: "content_block_stop", index: 0 }),
	se({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }),
	se({ type: "message_stop" }),
	{ type: "result", subtype: "success", result: text },
];
const toolTurn = (id) => [
	se({ type: "message_start", message: { id: `m-${id}`, model: model.id, usage: { input_tokens: 1 } } }),
	se({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name: "mcp__custom-tools__mytool", input: {} } }),
	se({ type: "content_block_stop", index: 0 }),
	se({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } }),
	se({ type: "message_stop" }),
];
// Claude Code reports an API failure as a synthetic assistant message, then a
// success-labelled error result.
const OVERLOADED = "API Error: 529 Overloaded";
const apiFailure = [
	{ type: "assistant", error: "overloaded", parent_tool_use_id: null, message: { id: "api-error", model: "<synthetic>", role: "assistant", content: [{ type: "text", text: OVERLOADED }], stop_reason: "stop_sequence", usage: { input_tokens: 0, output_tokens: 0 } } },
	{ type: "result", subtype: "success", is_error: true, result: OVERLOADED },
];

const sessionOf = (options) => options.resume ?? "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const transcriptText = (sessionId) => {
	const path = getSessionPath(sessionId, process.cwd(), env.dir);
	return existsSync(path) ? readFileSync(path, "utf8") : "";
};

describe("a transient failure before Claude answers a prompt", () => {
	it("is an error Pi retries, and the retry sends the prompt to Claude once", { timeout: 10_000 }, async () => {
		const sessionId = "transient-prompt";
		const queries = [];
		__testSetSdkQueryFactory(({ prompt, options }) => {
			const session = sessionOf(options);
			// What Claude would hold: the session's transcript as the query starts, then its prompt.
			queries.push({ options, prompt, transcript: transcriptText(session) });
			const n = queries.length;
			return fakeQuery(async function* () {
				yield { type: "system", subtype: "init", session_id: session };
				// Claude Code writes the prompt, and then the failure or the reply, to the transcript.
				const transcript = n === 1 ? createSession({ sessionId: session, projectPath: process.cwd(), claudeDir: env.dir }) : openSession({ sessionId: session, projectPath: process.cwd(), claudeDir: env.dir });
				transcript.addUserMessage(prompt);
				if (n === 2) {
					transcript.addAssistantMessage([{ type: "text", text: OVERLOADED }], { model: "<synthetic>" });
					transcript.save();
					yield* apiFailure;
					return;
				}
				transcript.addAssistantMessage([{ type: "text", text: n === 1 ? "first answer" : "second answer" }]);
				transcript.save();
				yield* reply(n === 1 ? "first answer" : "second answer");
			});
		});
		const system = { role: "system", content: "test system prompt", timestamp: 0 };
		const first = { role: "user", content: "FIRST-QUESTION", timestamp: 1 };
		const opening = await collect(streamClaudeAgentSdk(model, { messages: [system, first] }, { sessionId }));
		assert.equal(opening.at(-1).type, "done");
		const history = [system, first, opening.at(-1).message, { role: "user", content: "SECOND-QUESTION", timestamp: 3 }];

		const failed = await collect(streamClaudeAgentSdk(model, { messages: history }, { sessionId }));
		const error = failed.at(-1).error;
		assert.equal(failed.at(-1).type, "error");
		assert.equal(error.errorMessage, OVERLOADED);
		assert.equal(isRetryableAssistantError(error), true, "Pi's auto-retry takes it");
		await new Promise((resolve) => setTimeout(resolve, 50));

		// Pi's retry: a new run, the failed reply dropped, the same history.
		const retry = await collect(streamClaudeAgentSdk(model, { messages: history }, { sessionId, signal: new AbortController().signal }));
		assert.equal(retry.at(-1).type, "done");
		assert.deepEqual(retry.at(-1).message.content.map((block) => block.text), ["second answer"]);
		assert.equal(queries.length, 3);
		const delivered = `${queries[2].transcript}\n${String(queries[2].prompt)}`;
		assert.equal(delivered.split("SECOND-QUESTION").length - 1, 1, "the retried prompt reaches Claude once");
		assert.equal(delivered.split("FIRST-QUESTION").length - 1, 1, "the earlier turn is still there, once");
		assert.match(delivered, /first answer/);
	});
});

describe("a transient failure before Claude answers tool results", () => {
	const MYTOOL = { name: "mytool", label: "My tool", description: "test tool", parameters: Type.Object({}) };

	/** Claude Code's transcript of `session`, as it writes it: `write` adds
	 *  this query's records. */
	function writeTranscript(session, write) {
		const opts = { sessionId: session, projectPath: process.cwd(), claudeDir: env.dir };
		const transcript = existsSync(getSessionPath(session, process.cwd(), env.dir)) ? openSession(opts) : createSession(opts);
		write(transcript);
		transcript.save();
	}

	/** Pi's real loop runs the opening prompt: Claude Code calls mytool, Pi
	 *  runs it and answers, and `afterResult` is what Claude Code does then.
	 *  Each later query fails before output while `laterFailures` lasts, then
	 *  answers "continued". Every query records the transcript it starts on. */
	async function failAfterToolResult(sessionId, afterResult, { signal = new AbortController().signal, laterFailures = 0 } = {}) {
		const queries = [];
		__testSetSdkQueryFactory(({ prompt, options }) => {
			const session = sessionOf(options);
			queries.push({ options, prompt, transcript: transcriptText(session) });
			const n = queries.length;
			if (n > 1) {
				return fakeQuery(async function* () {
					yield { type: "system", subtype: "init", session_id: session };
					const fails = n - 1 <= laterFailures;
					writeTranscript(session, (transcript) => {
						transcript.addUserMessage(prompt);
						transcript.addAssistantMessage([{ type: "text", text: fails ? OVERLOADED : "continued" }], fails ? { model: "<synthetic>" } : {});
					});
					if (fails) yield* apiFailure;
					else yield* reply("continued");
				});
			}
			let wake;
			return fakeQuery(async function* () {
				yield { type: "system", subtype: "init", session_id: session };
				writeTranscript(session, (transcript) => {
					transcript.addUserMessage(String(prompt));
					transcript.addAssistantMessage([{ type: "tool_use", id: "call-1", name: "mcp__custom-tools__mytool", input: {} }]);
				});
				yield* toolTurn("call-1");
				await options.mcpServers["custom-tools"].instance._registeredTools.mytool.handler({}, { _meta: { "claudecode/toolUseId": "call-1" } });
				writeTranscript(session, (transcript) => transcript.addToolResults([{ toolUseId: "call-1", content: "REAL RESULT" }]));
				yield* await afterResult(new Promise((resolve) => { wake = resolve; }), session);
			}, () => wake?.([]));
		});
		const history = await runAgentLoop(
			[{ role: "user", content: "run it", timestamp: Date.now() }],
			{ messages: [], tools: [{ ...MYTOOL, async execute() { return { content: [{ type: "text", text: "REAL RESULT" }], details: {} }; } }] },
			{ model, convertToLlm: (messages) => messages, sessionId },
			async () => {},
			signal,
			(m, context, options) => streamClaudeAgentSdk(m, context, options),
		);
		return { history, queries };
	}

	/** Claude Code reports the API failure and writes it to the transcript. */
	const failsAfterResult = async (_closed, session) => {
		writeTranscript(session, (transcript) => transcript.addAssistantMessage([{ type: "text", text: OVERLOADED }], { model: "<synthetic>" }));
		return apiFailure;
	};

	// Pi's retry: a new run, the failed reply dropped, the tool result last.
	const piRetry = (sessionId, messages, signal = new AbortController().signal) => collect(streamClaudeAgentSdk(model, { messages }, { sessionId, signal }));

	for (const rebuild of [false, true]) {
		it(`isolates a full-history one-shot after a tool turn (rebuild=${rebuild})`, async () => {
			const sessionId = `one-shot-history-${rebuild}`;
			const run = await failAfterToolResult(sessionId, async () => reply("done"));
			await new Promise(resolve => setImmediate(resolve));
			if (rebuild) runInRequestLane(sessionId, () => markSessionForRebuild({ reason: "history-replaced" }));
			const before = runInRequestLane(sessionId, () => getSharedSession());
			const bytes = transcriptText(before.sessionId);
			const summary = await collect(streamClaudeAgentSdk(model, { messages: [...run.history, { role: "user", content: "Summarize this", timestamp: 10 }] }, { sessionId, cacheRetention: "none" }));
			await new Promise(resolve => setImmediate(resolve));
			assert.equal(summary.at(-1).type, "done");
			assert.deepEqual(runInRequestLane(sessionId, () => getSharedSession()), before);
			assert.equal(transcriptText(before.sessionId), bytes);
		});
	}

	function assertFailedRetryably(history, errorPattern) {
		assert.deepEqual(history.filter((message) => message.role !== "system").map((message) => message.role), ["user", "assistant", "toolResult", "assistant"]);
		const failed = history.at(-1);
		assert.equal(failed.stopReason, "error");
		assert.match(failed.errorMessage, errorPattern);
		assert.equal(isRetryableAssistantError(failed), true, "Pi's auto-retry takes it");
	}

	async function assertRetryContinues(sessionId, { history, queries }, errorPattern) {
		assertFailedRetryably(history, errorPattern);
		await new Promise((resolve) => setTimeout(resolve, 50));
		const retry = await piRetry(sessionId, history.slice(0, -1));
		const final = retry.at(-1).message ?? retry.at(-1).error;
		assert.equal(queries.length, 2, `the retry asks Claude to go on from the tool result (Pi got ${retry.at(-1).type}/${final.stopReason}, content ${JSON.stringify(final.content)})`);
		assert.equal(retry.at(-1).type, "done");
		assert.deepEqual(final.content.map((block) => block.text), ["continued"]);
		assert.equal(queries[1].prompt, FAILED_REPLY_RETRY_PROMPT, "the retry's prompt tells Claude what happened");
		return retry.at(-1).message;
	}

	it("an API error: Pi's retry goes on from the tool result instead of ending the turn empty", { timeout: 10_000 }, async () => {
		const sessionId = "transient-after-result";
		const run = await failAfterToolResult(sessionId, failsAfterResult);
		await assertRetryContinues(sessionId, run, /529 Overloaded/);
	});

	it("a stalled stream: Pi's retry goes on from the tool result instead of ending the turn empty", { timeout: 10_000 }, async () => {
		process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT = "200ms";
		const sessionId = "stall-after-result";
		// Claude Code took the result, then the API never answers.
		const run = await failAfterToolResult(sessionId, (closed) => closed);
		await assertRetryContinues(sessionId, run, /stream idle timeout/);
	});

	it("a retry that fails again is retried with its prompt in Claude's history once", { timeout: 10_000 }, async () => {
		const sessionId = "retry-fails-again";
		const run = await failAfterToolResult(sessionId, failsAfterResult, { laterFailures: 1 });
		assertFailedRetryably(run.history, /529 Overloaded/);
		await new Promise((resolve) => setTimeout(resolve, 50));
		const first = await piRetry(sessionId, run.history.slice(0, -1));
		assert.equal(first.at(-1).type, "error");
		assert.equal(isRetryableAssistantError(first.at(-1).error), true);
		await new Promise((resolve) => setTimeout(resolve, 50));
		const second = await piRetry(sessionId, run.history.slice(0, -1));
		assert.equal(second.at(-1).type, "done");
		assert.deepEqual(second.at(-1).message.content.map((block) => block.text), ["continued"]);
		assert.equal(run.queries.length, 3);
		const delivered = `${run.queries[2].transcript}\n${String(run.queries[2].prompt)}`;
		assert.equal(delivered.split(FAILED_REPLY_RETRY_PROMPT).length - 1, 1, "the retry prompt reaches Claude once");
		assert.equal(delivered.split("REAL RESULT").length - 1, 1, "the tool result is there, once");
	});

	it("a successful retry leaves the record the next turn resumes warm", { timeout: 10_000 }, async () => {
		const sessionId = "retry-then-next-turn";
		const run = await failAfterToolResult(sessionId, failsAfterResult);
		const reply = await assertRetryContinues(sessionId, run, /529 Overloaded/);
		await new Promise((resolve) => setTimeout(resolve, 50));
		const piHistory = run.history.slice(0, -1);
		const record = runInRequestLane(sessionId, () => getSharedSession());
		assert.equal(record.cursor, piHistory.length, "the cursor counts Pi's messages, not the bridge's prompt");
		assert.equal(record.needsRebuild, undefined);
		const next = await collect(streamClaudeAgentSdk(model, { messages: [...piHistory, reply, { role: "user", content: "NEXT-PROMPT", timestamp: Date.now() }] }, { sessionId }));
		assert.equal(next.at(-1).type, "done");
		assert.equal(run.queries.length, 3);
		assert.equal(run.queries[2].options.resume, sessionOf(run.queries[1].options), "it resumes the retry's session");
		assert.equal(run.queries[2].prompt, "NEXT-PROMPT");
		assert.ok(run.queries[2].transcript.includes(FAILED_REPLY_RETRY_PROMPT), "the transcript was resumed, not rebuilt");
	});

	it("a cancelled reply to a tool result still ends the turn, and starts no query", { timeout: 10_000 }, async () => {
		const sessionId = "cancelled-after-result";
		const run = new AbortController();
		const { history, queries } = await failAfterToolResult(sessionId, (closed) => {
			// Esc while Claude answers the tool result.
			run.abort();
			return closed;
		}, { signal: run.signal });
		assert.equal(history.at(-1).stopReason, "aborted");
		await new Promise((resolve) => setTimeout(resolve, 50));
		const after = await piRetry(sessionId, history.slice(0, -1));
		assert.deepEqual([after.at(-1).type, after.at(-1).reason], ["done", "stop"]);
		assert.deepEqual(after.at(-1).message.content, []);
		assert.equal(queries.length, 1, "no query continues a cancelled turn");
	});

	it("a retry whose run is already cancelled starts no query", { timeout: 10_000 }, async () => {
		const sessionId = "retry-cancelled";
		const run = await failAfterToolResult(sessionId, failsAfterResult);
		assertFailedRetryably(run.history, /529 Overloaded/);
		await new Promise((resolve) => setTimeout(resolve, 50));
		const cancelled = new AbortController();
		cancelled.abort();
		await piRetry(sessionId, run.history.slice(0, -1), cancelled.signal);
		assert.equal(run.queries.length, 1);
	});
});
