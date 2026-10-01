// After deferred replay, a continuation query's reply joins the Pi message
// the earlier query already wrote into. The duplicate-render guards (a
// completed assistant message rendered without stream events, and the
// result text) exist for re-yields WITHIN one SDK query. They must compare
// only against what the current query rendered: a continuation that repeats
// an earlier reply's text or thinking is a real reply, not a duplicate.
// Every provider stream is encoded by Pi's real frame consumer.
import "./lib/debug-env.mjs";

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { __testSetBridgeIntegrityState, __testSetSdkQueryFactory, streamClaudeAgentSdk } from "../src/index.ts";
import { setExtensionApi } from "../src/bridge-state.ts";
import { ctx, resetStack } from "../src/query-state.ts";
import { consumeLikePi } from "./lib/pi-frame-consumer.mjs";

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
const MYTOOL = { name: "mytool", description: "test tool", parameters: { type: "object", properties: {} } };
const context = () => ({
	messages: [
		{ role: "system", content: "test system prompt", toolsAdded: [MYTOOL], timestamp: 0 },
		{ role: "user", content: "hello", timestamp: Date.now() },
	],
});

let root;
let hold;
beforeEach(() => {
	hold = setInterval(() => {}, 1000);
	root = mkdtempSync(join(tmpdir(), "bridge-continuation-dedup-"));
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

const init = { type: "system", subtype: "init", session_id: "44444444-4444-4444-8444-444444444444" };
const assistant = (id, content) => ({ type: "assistant", message: { ...(id ? { id } : {}), model: model.id, content } });
const text = (value) => ({ type: "text", text: value });
const thinking = (value) => ({ type: "thinking", thinking: value, signature: "sig" });
const success = (result) => ({ type: "result", subtype: "success", result });

/** The original query (which also defers one steer, as a mid-query callback
 *  would), then one continuation query per further entry. */
function installQueries(...queries) {
	let calls = 0;
	__testSetSdkQueryFactory(() => {
		const messages = queries[calls] ?? [];
		if (calls++ === 0) {
			for (let i = 1; i < queries.length; i++) ctx().deferredUserMessages.push({ text: `steer ${i}` });
		}
		return {
			async *[Symbol.asyncIterator]() { for (const message of messages) yield message; },
			close() {},
			async interrupt() {},
		};
	});
}

async function runLikePi(sessionId) {
	const run = await consumeLikePi(streamClaudeAgentSdk(model, context(), { sessionId }));
	const done = run.events.at(-1);
	assert.equal(done.type, "done");
	assert.equal(run.final, done.message, "Pi persists the done message");
	return done;
}

const summarize = (content) => content.map((block) => block.type === "text" ? block.text : block.type === "thinking" ? `thinking:${block.thinking}` : `${block.type}:${block.id}`);

describe("a continuation may repeat an earlier reply", () => {
	it("renders a streamless continuation reply that repeats the first, before its tool call", async () => {
		installQueries(
			[init, assistant("m1", [text("OK")]), success("OK")],
			[init, assistant("m2", [text("OK"), { type: "tool_use", id: "call-1", name: "mcp__custom-tools__mytool", input: {} }])],
		);
		const done = await runLikePi("dedup-before-tool");
		assert.equal(done.reason, "toolUse");
		assert.deepEqual(summarize(done.message.content), ["OK", "OK", "toolCall:call-1"]);
	});

	it("renders a continuation's result text that repeats the first reply", async () => {
		installQueries([init, success("OK")], [init, success("OK")]);
		const done = await runLikePi("dedup-result");
		assert.deepEqual(summarize(done.message.content), ["OK", "OK"]);
	});

	it("renders a continuation's thinking that repeats the first reply's", async () => {
		installQueries(
			[init, assistant("m1", [thinking("Plan."), text("A")]), success("A")],
			[init, assistant("m2", [thinking("Plan."), text("B")]), success("B")],
		);
		const done = await runLikePi("dedup-thinking");
		assert.deepEqual(summarize(done.message.content), ["thinking:Plan.", "A", "thinking:Plan.", "B"]);
	});
});

describe("duplicates within one query are still rendered once", () => {
	it("a re-yield and the result text of the continuation's own reply", async () => {
		installQueries(
			[init, assistant("m1", [text("OK")]), success("OK")],
			[init, assistant("m2", [text("OK")]), assistant("m2", [text("OK")]), success("OK")],
		);
		const done = await runLikePi("dedup-own-reyield");
		assert.deepEqual(summarize(done.message.content), ["OK", "OK"], "once for each query");
	});

	it("a synthesized limit message yielded twice under different ids", async () => {
		const limit = "You've hit your weekly limit · resets Thursday 4am";
		installQueries([init, assistant(undefined, [text(limit)]), assistant("x2", [text(limit)]), success(limit)]);
		const done = await runLikePi("dedup-limit");
		assert.deepEqual(summarize(done.message.content), [limit]);
	});
});
