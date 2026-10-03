// `/reload` re-runs the extension in a new module copy: Pi emits
// session_shutdown and then session_start, both with reason "reload", for the
// same SessionManager. The next prompt must resume the warm Claude session
// from Pi's persisted marker, exactly as after a Pi restart, instead of
// rebuilding it into a new session id with a cold prompt cache.
import "./lib/debug-env.mjs";

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createSession } from "cc-session-io";

import claudeBridge, {
	__testSetBridgeIntegrityState,
	__testSetSdkQueryFactory,
	streamClaudeAgentSdk,
} from "../src/index.ts";
import { setExtensionApi } from "../src/bridge-state.ts";
import { ctx, resetStack } from "../src/query-state.ts";
import { runInRequestLane } from "../src/request-lane.ts";
import { __testCancelAllScheduledSessionPersistence } from "../src/session-persistence.ts";

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

const CLAUDE_SESSION = "warm-claude-session";
const ECHO = { name: "echo", description: "Return a value", parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } };
const PI_SESSION = "pi-reload-session";

let clock = Date.now();
const user = (text) => ({ role: "user", content: text, timestamp: clock++ });

async function collect(stream) {
	const events = [];
	for await (const event of stream) events.push(event);
	return events;
}

/** Fake Claude Code: every query records the session it was asked to resume
 *  and answers with one text message, except a prompt of "run echo". That one
 *  calls Pi's echo tool through the bridge's MCP server and then waits, like a
 *  child blocked in the handler; its interrupt() and close() leave it waiting,
 *  like a child that is slow to die. `waiting` is set to that query's gate
 *  (`started` resolves once the handler was called, `release` ends it). */
function installFakeClaudeCode(resumes, waiting = {}) {
	__testSetSdkQueryFactory(({ prompt, options }) => {
		resumes.push(options.resume ?? null);
		if (String(prompt) === "run echo") return toolWaitingQuery(options, waiting);
		return {
			async *[Symbol.asyncIterator]() {
				yield { type: "system", subtype: "init", session_id: CLAUDE_SESSION };
				yield { type: "stream_event", event: { type: "message_start", message: { id: `m${resumes.length}`, model: model.id, usage: { input_tokens: 1 } } } };
				yield { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } };
				yield { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `answer ${resumes.length}` } } };
				yield { type: "stream_event", event: { type: "content_block_stop", index: 0 } };
				yield { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } } };
				yield { type: "stream_event", event: { type: "message_stop" } };
				yield { type: "result", subtype: "success", session_id: CLAUDE_SESSION };
			},
			close() {},
			async interrupt() {},
		};
	});
}

function toolWaitingQuery(options, waiting) {
	let started;
	waiting.started = new Promise((resolve) => { started = resolve; });
	const released = new Promise((resolve) => { waiting.release = resolve; });
	return {
		async *[Symbol.asyncIterator]() {
			yield { type: "system", subtype: "init", session_id: CLAUDE_SESSION };
			yield { type: "stream_event", event: { type: "message_start", message: { id: "m-echo", model: model.id, usage: { input_tokens: 1 } } } };
			yield { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t0", name: "mcp__custom-tools__echo", input: {} } } };
			yield { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ id: "t0" }) } } };
			yield { type: "stream_event", event: { type: "content_block_stop", index: 0 } };
			yield { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } } };
			yield { type: "stream_event", event: { type: "message_stop" } };
			waiting.handlerResult = options.mcpServers["custom-tools"].instance._registeredTools.echo.handler({ id: "t0" }, { _meta: { "claudecode/toolUseId": "t0" } });
			started();
			await released;
		},
		close() {},
		async interrupt() {},
	};
}

/** The parts of Pi a loaded module copy talks to; `entries` is the session
 *  file's custom entries, shared by every copy as Pi's SessionManager is. */
function makeFakePi(handlers, entries) {
	return {
		on: (event, handler) => { handlers.set(event, handler); },
		registerCommand: () => {},
		registerProvider: () => {},
		registerTool: () => {},
		events: { emit: () => {} },
		appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
	};
}

/** One Pi prompt through the provider; returns Pi's grown history. */
async function prompt(history, text) {
	const messages = [...history, user(text)];
	const events = await collect(streamClaudeAgentSdk(model, { messages }, { sessionId: PI_SESSION }));
	const done = events.find((event) => event.type === "done");
	assert.ok(done, `the provider stream must finish: ${JSON.stringify(events.filter((event) => event.type === "error").map((event) => event.error?.errorMessage))}`);
	return [...messages, done.message];
}

const logSize = () => { try { return statSync(process.env.CLAUDE_BRIDGE_DEBUG_PATH).size; } catch { return 0; } };
let logStart = 0;
const logSince = () => readFileSync(process.env.CLAUDE_BRIDGE_DEBUG_PATH, "utf8").slice(logStart);
const syncPaths = () => [...logSince().matchAll(/syncResult: path=([a-z-]+)/g)].map((match) => match[1]);

let claudeDir;
let agentDir;
let previousAgentDir;
beforeEach(() => {
	process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT = "0";
	process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token";
	claudeDir = mkdtempSync(join(tmpdir(), "bridge-reload-claude-"));
	process.env.CLAUDE_CONFIG_DIR = claudeDir;
	// Extension registration writes under PI_CODING_AGENT_DIR; keep it disposable.
	agentDir = mkdtempSync(join(tmpdir(), "bridge-reload-agent-"));
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	logStart = logSize();
	resetStack();
	__testCancelAllScheduledSessionPersistence();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: { notify: () => {} } });
});

afterEach(() => {
	delete process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT;
	delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
	delete process.env.CLAUDE_CONFIG_DIR;
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(claudeDir, { recursive: true, force: true });
	rmSync(agentDir, { recursive: true, force: true });
	__testCancelAllScheduledSessionPersistence();
	__testSetSdkQueryFactory();
	setExtensionApi(undefined);
	resetStack();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
});

describe("/reload keeps the warm Claude session", () => {
	/** One completed turn with its marker persisted, then Pi 0.99.2's
	 *  AgentSession.reload: shutdown to the old copy, then start to a freshly
	 *  loaded copy, for the same SessionManager. `between` runs after the
	 *  persisted turn and returns Pi's history; the reload follows it with no
	 *  timer turn in between. `beforeShutdown` runs in the session's lane just
	 *  before the shutdown. Returns the next prompt's resumed session ids and
	 *  sync paths. */
	async function turnReloadTurn({ between, beforeShutdown } = {}) {
		const resumes = [];
		const waiting = {};
		installFakeClaudeCode(resumes, waiting);
		const entries = [];
		let history = [{ role: "system", content: "test system prompt", toolsAdded: [ECHO], timestamp: 0 }];
		const sessionManager = {
			getSessionId: () => PI_SESSION,
			getCwd: () => process.cwd(),
			getEntries: () => entries,
			buildSessionContext: () => ({ messages: history }),
		};
		const ctxLike = { sessionManager, ui: { notify: () => {} }, cwd: process.cwd() };

		const handlers = new Map();
		claudeBridge(makeFakePi(handlers, entries));
		handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctxLike);

		history = await prompt(history, "first");
		// Claude Code writes its transcript as it answers; the fake does not.
		const transcript = createSession({ projectPath: process.cwd(), claudeDir, sessionId: CLAUDE_SESSION });
		transcript.addUserMessage("first");
		transcript.save();
		// Pi's message_end for the reply. The bridge persists its marker on a
		// 0 ms timer; a later 0 ms timer fires after it.
		handlers.get("message_end")({ type: "message_end", message: history.at(-1) }, ctxLike);
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(entries.filter((entry) => entry.customType === "claude-bridge-session").at(-1)?.data.sessionId, CLAUDE_SESSION, "the turn persisted its marker");

		if (between) history = await between({ handlers, ctxLike, history, waiting });
		if (beforeShutdown) runInRequestLane(PI_SESSION, beforeShutdown);
		handlers.get("session_shutdown")({ type: "session_shutdown", reason: "reload" }, ctxLike);
		const reloaded = await import(`../src/index.ts?reload=${Date.now()}-${Math.random()}`);
		const reloadedHandlers = new Map();
		reloaded.default(makeFakePi(reloadedHandlers, entries));
		reloadedHandlers.get("session_start")({ type: "session_start", reason: "reload" }, ctxLike);

		await prompt(history, "second");
		waiting.release?.();
		return { resumes, paths: syncPaths() };
	}

	it("resumes the same Claude session with REUSE on the first prompt after a reload", async () => {
		const { resumes, paths } = await turnReloadTurn();
		assert.deepEqual(resumes, [null, CLAUDE_SESSION], "the prompt after the reload resumes the warm session");
		assert.deepEqual(paths, ["clean-start", "reuse"]);
	});

	it("rebuilds into a new session when a query was still live in the lane at the reload", async () => {
		// RPC and print mode reload without waiting for the response, and
		// session_shutdown does not stop the query: its child may still be
		// writing the transcript the marker names.
		const { resumes, paths } = await turnReloadTurn({ beforeShutdown: () => { ctx().activeQuery = { id: "still-running" }; } });
		assert.equal(resumes.length, 2);
		assert.notEqual(resumes[1], CLAUDE_SESSION, "never resumes a transcript a live child may still write");
		assert.deepEqual(paths, ["clean-start", "rebuild"]);
	});

	it("rebuilds into a new session after a reload that follows an abort whose child may still be writing", async () => {
		const { resumes, paths } = await turnReloadTurn({
			between: async ({ handlers, ctxLike, history, waiting }) => {
				// A query waits in the bridge's MCP handler for Pi's echo result.
				const abort = new AbortController();
				const asked = [...history, user("run echo")];
				const opening = await collect(streamClaudeAgentSdk(model, { messages: asked }, { sessionId: PI_SESSION, signal: abort.signal }));
				const toolUse = opening.find((event) => event.type === "done")?.message;
				assert.equal(toolUse?.stopReason, "toolUse");
				handlers.get("message_end")({ type: "message_end", message: toolUse }, ctxLike);
				await waiting.started;
				// Esc: the handler drains, but the child has not exited yet.
				abort.abort();
				assert.equal((await waiting.handlerResult).isError, true);
				// Pi records the interrupted result and calls the provider with it.
				const interrupted = { role: "toolResult", toolCallId: "t0", toolName: "echo", content: [{ type: "text", text: "Operation aborted" }], isError: true, timestamp: clock++ };
				const answered = [...asked, toolUse, interrupted];
				const after = await collect(streamClaudeAgentSdk(model, { messages: answered }, { sessionId: PI_SESSION }));
				const reply = after.find((event) => event.type === "done")?.message;
				assert.ok(reply, "the callback's stream finishes");
				// Its message_end schedules the marker that would carry the
				// rotation; the reload comes before that timer fires.
				handlers.get("message_end")({ type: "message_end", message: reply }, ctxLike);
				return [...answered, reply];
			},
		});
		assert.equal(resumes.length, 3);
		assert.equal(resumes[1], CLAUDE_SESSION, "the tool query resumed the warm session");
		assert.notEqual(resumes[2], CLAUDE_SESSION, `never resumes the session the aborted child may still write (sync paths ${paths.join(", ")})`);
		assert.equal(paths.at(-1), "rebuild");
	});
});
