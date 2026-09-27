import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createSession } from "cc-session-io";

import { __testGetBridgeIntegrityState, __testSetBridgeIntegrityState, __testSetSdkQueryFactory, streamClaudeAgentSdk } from "../src/index.ts";
import { cancelScheduledToolUseEnd } from "../src/assistant-stream.ts";
import { ctx, resetStack } from "../src/query-state.ts";

const model = { id: "claude-haiku-4-5", api: "claude-bridge", provider: "pi-claude", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const tool = { name: "echo", description: "Return a value", parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } };
const sessionId = "22222222-2222-4222-8222-222222222222";
const system = { role: "system", content: "Pi instructions", toolsAdded: [tool], timestamp: 0 };
const user = (content) => ({ role: "user", content, timestamp: Date.now() });
const toolCall = { role: "assistant", content: [{ type: "toolCall", id: "t0", name: "echo", arguments: { id: "t0" } }], timestamp: Date.now() };
const abortedResult = { role: "toolResult", toolCallId: "t0", content: [{ type: "text", text: "Operation aborted" }], isError: true, timestamp: Date.now() };
const collect = async (stream) => { const events = []; for await (const event of stream) events.push(event); return events; };
const textOf = (events) => events.filter((event) => event.type === "text_delta").map((event) => event.delta).join("");

async function waitFor(check, what = "condition") {
	const deadline = Date.now() + 2000;
	while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(check(), true, `timed out waiting for ${what}`);
}

/** A query that asks Pi to run echo and then blocks in the MCP handler, the
 *  way Claude Code does while Pi executes a tool. `record.settle` ends the
 *  iterator; close()/interrupt() deliberately do NOT, so the test controls
 *  when the aborted query finishes settling. */
function toolWaitingQuery(record, options) {
	let settle;
	const settled = new Promise((resolve) => { settle = resolve; });
	record.settle = () => settle();
	record.closed = false;
	return {
		async *[Symbol.asyncIterator]() {
			yield { type: "system", subtype: "init", session_id: sessionId };
			yield { type: "assistant", message: { content: [{ type: "tool_use", id: "t0", name: "mcp__custom-tools__echo", input: { id: "t0" } }] } };
			record.handlerResult = options.mcpServers["custom-tools"].instance._registeredTools.echo.handler({ id: "t0" }, {});
			await settled;
		},
		close() { record.closed = true; },
		async interrupt() {},
	};
}

function answeringQuery(session, text) {
	return {
		async *[Symbol.asyncIterator]() {
			yield { type: "system", subtype: "init", session_id: session };
			yield { type: "result", subtype: "success", result: text };
		},
		close() {},
		async interrupt() {},
	};
}

let root;
let previousEnv;
let record;
let calls;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "bridge-lifecycle-"));
	const env = { CLAUDE_CONFIG_DIR: root, PI_CODING_AGENT_DIR: root, CLAUDE_CODE_OAUTH_TOKEN: "offline-test", CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT: "0" };
	previousEnv = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
	Object.assign(process.env, env);
	resetStack();
	const session = createSession({ sessionId, projectPath: root, claudeDir: root });
	session.importMessages([{ role: "user", content: "run echo" }]);
	session.save();
	__testSetBridgeIntegrityState({ sharedSession: { sessionId, cursor: 2, cwd: root }, ui: { notify() {} } });
	record = {};
	calls = [];
});

afterEach(() => {
	record.settle?.();
	cancelScheduledToolUseEnd(ctx());
	__testSetSdkQueryFactory();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
	resetStack();
	for (const [key, value] of Object.entries(previousEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(root, { recursive: true, force: true });
});

describe("a prompt sent right after an abort", () => {
	it("starts a fresh query on a rotated session instead of joining the aborting one", async () => {
		__testSetSdkQueryFactory(({ prompt, options }) => {
			calls.push({ prompt, options });
			return calls.length === 1 ? toolWaitingQuery(record, options) : answeringQuery(options.resume, "recovered");
		});
		const abort = new AbortController();
		const opening = await collect(streamClaudeAgentSdk(model, { messages: [system, user("run echo")] }, { cwd: root, signal: abort.signal }));
		assert.equal(opening.at(-1)?.type, "done");
		await waitFor(() => ctx().pendingToolCalls.size === 1, "the MCP handler to wait on Pi");
		const abortedCtx = ctx();

		abort.abort();
		// The aborted query's iterator has not settled yet — exactly when Pi
		// delivers the user's next prompt.
		assert.notEqual(abortedCtx.activeQuery, null);
		const next = streamClaudeAgentSdk(model, { messages: [system, user("run echo"), toolCall, abortedResult, user("say recovered")] }, { cwd: root });
		assert.equal(calls.length, 2, "the prompt after abort must start its own SDK query");
		const events = await collect(next);

		assert.equal(events.at(-1)?.type, "done");
		assert.equal(textOf(events), "recovered");
		assert.equal(calls[1].prompt, "say recovered");
		assert.notEqual(calls[1].options.resume, sessionId, "the aborted Claude session must not be resumed");
		assert.equal((await record.handlerResult).isError, true, "the waiting handler drains as an error");

		record.settle();
		await waitFor(() => abortedCtx.activeQuery === null, "the aborted query to tear down");
		const shared = __testGetBridgeIntegrityState().sharedSession;
		assert.equal(shared?.sessionId, calls[1].options.resume);
		assert.equal(shared?.needsRebuild, undefined, "the aborted query's late teardown must not mark the new record");
	});
});
