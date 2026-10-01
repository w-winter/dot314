// A failed query ends the Pi message with an error event. Pi's frame encoder
// reads every queued event's block from the LIVE partial when it consumes the
// event, which lags the provider (lib/pi-frame-consumer.mjs). So the error
// path must never shrink the live partial: the error message is a copy that
// leaves out truncated tool calls and the blocks of an abandoned stream
// attempt, exactly as the done message does. Covers the four error paths:
// Claude Code's usage-limit result, a held failure surfaced at completion,
// a thrown process error, and the stream idle timeout. Each is encoded as
// consumed and at maximum lag.
//
// The truncated tool call left out of the error message never reached Pi, so
// no result is owed for it: the query's teardown must not report it as a
// tool result that went missing.
import "./lib/debug-env.mjs";

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";

import { __testGetBridgeIntegrityState, __testSetBridgeIntegrityState, __testSetSdkQueryFactory, streamClaudeAgentSdk } from "../src/index.ts";
import { setExtensionApi } from "../src/bridge-state.ts";
import { takeAgentNotice } from "../src/agent-notice.ts";
import { resetStack } from "../src/query-state.ts";
import { runInRequestLane } from "../src/request-lane.ts";
import { consumeLikePi } from "./lib/pi-frame-consumer.mjs";
import { withAgentNotices } from "./lib/agent-notices.mjs";

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
const BASH = { name: "bash", description: "Run a command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } };
const context = () => ({
	messages: [
		{ role: "system", content: "test system prompt", toolsAdded: [BASH], timestamp: 0 },
		{ role: "user", content: "read the log", timestamp: Date.now() },
	],
});
const se = (event) => ({ type: "stream_event", event });

let root;
let hold;
let notifications;
let integrityEntries;
beforeEach(() => {
	hold = setInterval(() => {}, 1000);
	root = mkdtempSync(join(tmpdir(), "bridge-failure-frames-"));
	process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT = "0";
	process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token";
	process.env.CLAUDE_CONFIG_DIR = root;
	process.env.CLAUDE_BRIDGE_DIAG_PATH = join(root, "diag.log");
	resetStack();
	notifications = [];
	integrityEntries = [];
	__testSetBridgeIntegrityState({ sharedSession: null, ui: { notify: (message, level) => notifications.push({ message, level }) } });
	setExtensionApi({ events: { emit: () => {} }, appendEntry: (customType, data) => integrityEntries.push({ customType, data }) });
});

afterEach(() => {
	clearInterval(hold);
	delete process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT;
	delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
	delete process.env.CLAUDE_CONFIG_DIR;
	delete process.env.CLAUDE_BRIDGE_DIAG_PATH;
	__testSetSdkQueryFactory();
	setExtensionApi(undefined);
	resetStack();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
	rmSync(root, { recursive: true, force: true });
});

/** An attempt Claude Code abandons mid-word, then the retry's complete text
 *  and a tool call whose arguments are still streaming. */
const beforeFailure = [
	se({ type: "message_start", message: { id: "msg_A", model: model.id, usage: { input_tokens: 100, output_tokens: 1 } } }),
	se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
	se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Readi" } }),
	se({ type: "message_start", message: { id: "msg_A2", model: model.id, usage: { input_tokens: 100, output_tokens: 1 } } }),
	se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
	se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Checking." } }),
	se({ type: "content_block_stop", index: 0 }),
	se({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_partial", name: "mcp__custom-tools__bash", input: {} } }),
	se({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"comm' } }),
];

function installFakeClaudeCode(tail, { stall = false } = {}) {
	__testSetSdkQueryFactory(() => {
		let closed = false;
		let wake;
		return {
			async *[Symbol.asyncIterator]() {
				yield { type: "system", subtype: "init", session_id: "failure-frames" };
				for (const message of [...beforeFailure, ...tail]) {
					if (closed) return;
					if (message instanceof Error) throw message;
					yield message;
				}
				if (stall && !closed) await new Promise((resolve) => { wake = resolve; });
			},
			close() { closed = true; wake?.(); },
			async interrupt() { closed = true; wake?.(); },
		};
	});
}

const summarize = (content) => content.map((block) => block.type === "text" ? ["text", block.text] : [block.type, block.id]);

async function assertErrorEndsCleanly(sessionId, errorPattern) {
	const run = await consumeLikePi(streamClaudeAgentSdk(model, context(), { sessionId }));
	const terminal = run.events.at(-1);
	assert.equal(terminal.type, "error");
	assert.match(terminal.error.errorMessage, errorPattern);
	assert.equal(run.final, terminal.error, "Pi persists the error message");
	// Encoding as consumed and at maximum lag both succeeded (consumeLikePi
	// throws where Pi would); the frames kept every block Pi saw.
	for (const snapshot of [run.eagerSnapshot, run.laggedSnapshot]) {
		assert.deepEqual(summarize(snapshot.content), [["text", "Readi"], ["text", "Checking."], ["toolCall", "toolu_partial"]]);
	}
	assert.deepEqual(summarize(terminal.error.content), [["text", "Checking."]], "no abandoned attempt text, no truncated tool call");
	const live = run.events[0].partial;
	assert.notEqual(terminal.error, live, "the error message is a copy");
	assert.deepEqual(summarize(live.content), [["text", "Readi"], ["text", "Checking."], ["toolCall", "toolu_partial"]], "the live partial keeps every block");
	assert.notEqual(live.stopReason, "error", "the live partial is not relabelled");
	return terminal.error;
}

describe("error paths end the Pi message without touching the live partial", () => {
	it("Claude Code's usage-limit result", async () => {
		installFakeClaudeCode([{ type: "result", subtype: "error_during_execution", errors: ["You've hit your weekly limit · resets Thursday 4am"] }]);
		await assertErrorEndsCleanly("frames-usage-limit", /weekly limit/);
	});

	it("a failure held until the query completes", async () => {
		installFakeClaudeCode([{ type: "result", subtype: "error_during_execution", errors: ["API Error: 500 internal server error"] }]);
		await assertErrorEndsCleanly("frames-held-failure", /internal server error/);
	});

	it("a thrown Claude Code process error", async () => {
		installFakeClaudeCode([new Error("Claude Code process exited with code 1")]);
		await assertErrorEndsCleanly("frames-throw", /exited with code 1/);
	});

	it("the stream idle timeout", async () => {
		process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT = "200ms";
		installFakeClaudeCode([], { stall: true });
		const error = await assertErrorEndsCleanly("frames-idle", /stream idle timeout/);
		assert.equal(error.rateLimitType, "stream_idle", "the idle metadata rides the error message");
		assert.equal(error.streamIdleTimeoutMs, 200);
		assert.ok(error.retryAfterMs > 0);
	});
});

describe("a truncated tool call left out of the error message is owed no result", () => {
	const PATHS = {
		"Claude Code's usage-limit result": () => installFakeClaudeCode([{ type: "result", subtype: "error_during_execution", errors: ["You've hit your weekly limit · resets Thursday 4am"] }]),
		"a failure held until the query completes": () => installFakeClaudeCode([{ type: "result", subtype: "error_during_execution", errors: ["API Error: 500 internal server error"] }]),
		"a thrown Claude Code process error": () => installFakeClaudeCode([new Error("Claude Code process exited with code 1")]),
		"the stream idle timeout": () => {
			process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT = "200ms";
			installFakeClaudeCode([], { stall: true });
		},
	};
	for (const [path, install] of Object.entries(PATHS)) {
		it(path, { timeout: 10_000 }, async () => {
			install();
			const sessionId = `frames-owed-${path.replace(/\W+/g, "-")}`;
			const run = await consumeLikePi(streamClaudeAgentSdk(model, context(), { sessionId }));
			assert.equal(run.events.at(-1).type, "error");
			// Let the completion chain (persist, teardown) settle.
			await new Promise((resolve) => setTimeout(resolve, 50));
			assert.deepEqual(notifications.filter((entry) => /tool result delivery interrupted/.test(entry.message)), [], "no missing-result report");
			assert.deepEqual(integrityEntries.filter((entry) => entry.data?.label === "tool_result_delivery_mismatch"), []);
		});
	}

	it("the session record a failed query keeps does not rebuild for it", { timeout: 10_000 }, async () => {
		PATHS["a failure held until the query completes"]();
		await consumeLikePi(streamClaudeAgentSdk(model, context(), { sessionId: "frames-owed-record" }));
		await new Promise((resolve) => setTimeout(resolve, 50));
		const record = runInRequestLane("frames-owed-record", () => __testGetBridgeIntegrityState().sharedSession);
		assert.equal(record?.sessionId, "failure-frames", "the failed query's session is kept");
		assert.equal(record.needsRebuild, undefined, "the next turn resumes it");
	});
});

describe("the user is told what follows a stream idle timeout", () => {
	it("an error: retryable by Pi's auto-retry, which announces its own retries", { timeout: 10_000 }, () => withAgentNotices(async () => {
		process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT = "200ms";
		installFakeClaudeCode([], { stall: true });
		const run = await consumeLikePi(streamClaudeAgentSdk(model, context(), { sessionId: "frames-idle-notice" }));
		const error = run.events.at(-1).error;
		assert.equal(error.stopReason, "error");
		assert.equal(isRetryableAssistantError(error), true, "Pi's auto-retry takes this error");
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.deepEqual(notifications, [], "no bridge warning: Pi shows the turn's error");
		assert.ok(takeAgentNotice("frames-idle-notice")?.message.details.kinds.includes("stream_idle_timeout"), "the agent notice tells the agent");
	}));
});
