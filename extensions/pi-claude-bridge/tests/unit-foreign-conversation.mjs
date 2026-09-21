/**
 * Completion-path tests for the foreign-conversation guard.
 *
 * The sync-level tests pin that a fingerprint mismatch never REUSEs or
 * REBUILDs. These drive streamClaudeAgentSdk end to end with a fake SDK
 * factory to pin the other half of the hole: a foreign one-shot's COMPLETION
 * (success or terminal failure) must not replace the module-level parent
 * record with the child's captured session id — and, inversely, a normal
 * outermost query's completion stamps the identity anchor onto the record it
 * persists so a Case-1 clean start is protected from the very next
 * idle-window foreign query.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
	__testSetBridgeIntegrityState,
	__testGetBridgeIntegrityState,
	__testSetSdkQueryFactory,
	streamClaudeAgentSdk,
} from "../src/index.ts";
import { conversationFingerprint } from "../src/session-persistence.ts";
import { setExtensionApi } from "../src/bridge-state.ts";
import { ctx, resetStack } from "../src/query-state.ts";
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

const userMessage = (text) => ({ role: "user", content: text, timestamp: Date.now() });
const contextWithPrompt = (messages) => ({
	messages: [
		{ role: "system", content: "test system prompt", timestamp: 0 },
		...messages,
	],
});

function fakeSdkQuery(messages) {
	let closed = false;
	return {
		async *[Symbol.asyncIterator]() {
			for (const message of messages) {
				if (closed) break;
				if (message instanceof Error) throw message;
				yield message;
			}
		},
		close() { closed = true; },
		async interrupt() { closed = true; },
	};
}

const STREAMED_TEXT = (text) => [
	{ type: "stream_event", event: { type: "message_start", message: { model: model.id, usage: { input_tokens: 1 } } } },
	{ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
	{ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } },
];

async function collect(stream) {
	const events = [];
	for await (const event of stream) events.push(event);
	return events;
}

const parentFp = conversationFingerprint([userMessage("parent opener")]);
const parentRecord = () => ({ sessionId: "parent-session", cursor: 40, cwd: "/repo", conversationFingerprint: parentFp });

let diagDir;

beforeEach(() => {
	process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT = "0";
	// Legacy (no-router) paths gate on credential presence; an env token is an
	// existence-only signal that never gets read.
	process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token";
	diagDir = mkdtempSync(join(tmpdir(), "bridge-diag-"));
	process.env.CLAUDE_BRIDGE_DIAG_PATH = join(diagDir, "diag.log");
	resetStack();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: { notify: () => {} } });
	setExtensionApi({ events: { emit: () => {} }, appendEntry: () => {} });
});

afterEach(() => {
	delete process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT;
	delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
	delete process.env.CLAUDE_BRIDGE_DIAG_PATH;
	rmSync(diagDir, { recursive: true, force: true });
	__testSetSdkQueryFactory();
	setExtensionApi(undefined);
	resetStack();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
});

describe("foreign-conversation completion (#1001)", () => {
	it("does not replace the parent record with the child session id on success", async () => {
		const record = parentRecord();
		runInRequestLane("foreign-success", () => __testSetBridgeIntegrityState({ sharedSession: { ...record } }));
		__testSetSdkQueryFactory(() => fakeSdkQuery([
			{ type: "system", subtype: "init", session_id: "child-session" },
			...STREAMED_TEXT("subagent answer"),
			{ type: "result", subtype: "success", result: "subagent answer" },
		]));

		const events = await collect(streamClaudeAgentSdk(
			model,
			contextWithPrompt([userMessage("subagent task")]),
			{ sessionId: "foreign-success" },
		));

		assert.equal(events.filter((event) => event.type === "done").length, 1);
		assert.equal(events.filter((event) => event.type === "error").length, 0);
		assert.deepEqual(
			runInRequestLane("foreign-success", () => __testGetBridgeIntegrityState().sharedSession),
			record,
			"a foreign one-shot's completion must leave the parent record untouched",
		);
	});

	it("does not replace the parent record on a terminal failure either", async () => {
		const record = parentRecord();
		runInRequestLane("foreign-failure", () => __testSetBridgeIntegrityState({ sharedSession: { ...record } }));
		__testSetSdkQueryFactory(() => fakeSdkQuery([
			{ type: "system", subtype: "init", session_id: "child-session" },
			...STREAMED_TEXT("partial"),
			{ type: "result", subtype: "error_max_turns", errors: ["max turns exceeded"] },
		]));

		const events = await collect(streamClaudeAgentSdk(
			model,
			contextWithPrompt([userMessage("subagent task")]),
			{ sessionId: "foreign-failure" },
		));

		assert.equal(events.filter((event) => event.type === "error").length, 1);
		assert.deepEqual(
			runInRequestLane("foreign-failure", () => __testGetBridgeIntegrityState().sharedSession),
			record,
			"the terminal-failure persist site must be gated for foreign queries too",
		);
	});

	it("a foreign one-shot dying with an unresolved tool call never marks the parent record for rebuild", async () => {
		const record = parentRecord();
		runInRequestLane("foreign-unresolved-tool", () => __testSetBridgeIntegrityState({ sharedSession: { ...record } }));
		__testSetSdkQueryFactory(() => fakeSdkQuery([
			{ type: "system", subtype: "init", session_id: "child-session" },
			{ type: "stream_event", event: { type: "message_start", message: { id: "m1", model: model.id, usage: { input_tokens: 1 } } } },
			{ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call-1", name: "mytool", input: {} } } },
			{ type: "stream_event", event: { type: "content_block_stop", index: 0 } },
			{ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } } },
			{ type: "stream_event", event: { type: "message_stop" } },
			// Iterator ends here: the recorded pi-owed call never gets a result,
			// so teardown reports a tool-result mismatch. This path must not mark
			// the PARENT's record needsRebuild/forceRotate from a foreign
			// query's abort/teardown.
		]));

		const events = await collect(streamClaudeAgentSdk(
			model,
			contextWithPrompt([userMessage("subagent task")]),
			{ sessionId: "foreign-unresolved-tool" },
		));
		// The pi stream ends at the toolUse boundary; teardown runs after.
		await new Promise((resolve) => setTimeout(resolve, 25));

		assert.ok(events.some((event) => event.type === "done" && event.reason === "toolUse"));
		assert.equal(
			runInRequestLane("foreign-unresolved-tool", () => ctx().detachedFromSharedSession),
			true,
			"the foreign non-claim must ride the query context",
		);
		assert.deepEqual(
			runInRequestLane("foreign-unresolved-tool", () => __testGetBridgeIntegrityState().sharedSession),
			record,
			"an unresolved tool call at foreign teardown must leave the parent record untouched",
		);
	});

	it("stamps the conversation anchor onto the record a clean start persists", async () => {
		__testSetSdkQueryFactory(() => fakeSdkQuery([
			{ type: "system", subtype: "init", session_id: "session-new" },
			...STREAMED_TEXT("hi"),
			{ type: "result", subtype: "success", result: "hi" },
		]));

		const messages = [userMessage("hello")];
		await collect(streamClaudeAgentSdk(model, contextWithPrompt(messages), { sessionId: "clean-start" }));

		const { sharedSession } = runInRequestLane("clean-start", () => __testGetBridgeIntegrityState());
		assert.equal(sharedSession?.sessionId, "session-new");
		assert.equal(
			sharedSession?.conversationFingerprint,
			conversationFingerprint(messages),
			"records created by completion must carry the identity anchor",
		);
	});
});
