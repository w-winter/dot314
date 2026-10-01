// Must load before any bridge module: diag assertions need the debug flag
// set when src/debug.ts is evaluated.
import "./lib/debug-env.mjs";

// Pi assistant messages produced by the bridge keep the Pi model id the request
// selected in `model` (pi-subagents verifies it against the launch model) and
// carry Claude Code's reported model in `responseModel` only when it differs —
// the same contract as Pi's native Anthropic provider.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { calculateCost } from "@earendil-works/pi-ai";
import { __testSetBridgeIntegrityState, __testSetSdkQueryFactory, streamClaudeAgentSdk } from "../src/index.ts";
import { setExtensionApi } from "../src/bridge-state.ts";
import { resetStack } from "../src/query-state.ts";

const baseModel = {
	api: "claude-bridge",
	provider: "pi-claude",
	baseUrl: "claude-bridge",
	reasoning: true,
	input: ["text", "image"],
	contextWindow: 200000,
	maxTokens: 8192,
};
const haiku = { ...baseModel, id: "claude-haiku-4-5", name: "Claude Haiku 4.5", cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } };
const opus55 = { ...baseModel, id: "claude-opus-5-5", name: "Claude Opus 5.5", cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } };

const context = {
	messages: [
		{ role: "system", content: "test system prompt", timestamp: 0 },
		{ role: "user", content: "hello", timestamp: Date.now() },
	],
};

function fakeSdkQuery(messages) {
	let closed = false;
	return {
		async *[Symbol.asyncIterator]() {
			for (const message of messages) {
				if (closed) break;
				yield message;
			}
		},
		close() { closed = true; },
		async interrupt() { closed = true; },
	};
}

async function collect(stream) {
	const events = [];
	for await (const event of stream) events.push(event);
	return events;
}

function finalMessage(events) {
	const terminal = events.filter((event) => event.type === "done" || event.type === "error");
	assert.equal(terminal.length, 1, `exactly one terminal event, got ${events.map((e) => e.type).join(",")}`);
	assert.equal(terminal[0].type, "done", terminal[0].error?.errorMessage);
	return terminal[0].message;
}

const streamedReply = (reportedModel, text, usage) => [
	{ type: "stream_event", event: { type: "message_start", message: { id: "msg-1", model: reportedModel, usage: { input_tokens: usage.input, output_tokens: 1 } } } },
	{ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
	{ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } },
	{
		type: "assistant",
		message: { id: "msg-1", model: reportedModel, content: [{ type: "text", text }], usage: { input_tokens: usage.input, output_tokens: 1 } },
	},
	{ type: "stream_event", event: { type: "content_block_stop", index: 0 } },
	{ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: usage.output } } },
	{ type: "stream_event", event: { type: "message_stop" } },
	{ type: "result", subtype: "success", result: text },
];

let notifications;
let diagDir;

beforeEach(() => {
	process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT = "0";
	process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token";
	diagDir = mkdtempSync(join(tmpdir(), "bridge-diag-"));
	process.env.CLAUDE_BRIDGE_DIAG_PATH = join(diagDir, "diag.log");
	resetStack();
	notifications = [];
	__testSetBridgeIntegrityState({
		sharedSession: null,
		ui: { notify: (message, level) => notifications.push({ message, level }) },
	});
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

describe("Pi model identity on bridge replies", () => {
	it("keeps Pi's selected model id when Claude Code reports a dated alias", async () => {
		__testSetSdkQueryFactory(() => fakeSdkQuery([
			{ type: "system", subtype: "init", session_id: "haiku-session" },
			...streamedReply("claude-haiku-4-5-20251001", "haiku says hi", { input: 100, output: 20 }),
		]));

		const message = finalMessage(await collect(streamClaudeAgentSdk(haiku, context, { sessionId: "model-identity-dated" })));
		assert.equal(message.model, "claude-haiku-4-5");
		assert.equal(message.responseModel, "claude-haiku-4-5-20251001");
		assert.equal(message.provider, "pi-claude");
	});

	it("omits responseModel when Claude Code reports the selected model id", async () => {
		__testSetSdkQueryFactory(() => fakeSdkQuery([
			{ type: "system", subtype: "init", session_id: "haiku-session" },
			...streamedReply("claude-haiku-4-5", "same model", { input: 10, output: 2 }),
		]));

		const message = finalMessage(await collect(streamClaudeAgentSdk(haiku, context, { sessionId: "model-identity-same" })));
		assert.equal(message.model, "claude-haiku-4-5");
		assert.equal("responseModel" in message, false);
	});

	it("keeps the selected id through model_refusal_fallback and records the fallback as responseModel", async () => {
		__testSetSdkQueryFactory(() => fakeSdkQuery([
			{ type: "system", subtype: "init", session_id: "opus-session" },
			{ type: "system", subtype: "model_refusal_fallback", original_model: "claude-opus-5-5", fallback_model: "claude-opus-4-8" },
			...streamedReply("claude-opus-4-8", "fallback answer", { input: 1000, output: 500 }),
		]));

		const message = finalMessage(await collect(streamClaudeAgentSdk(opus55, context, { sessionId: "model-identity-refusal" })));
		assert.equal(message.model, "claude-opus-5-5");
		assert.equal(message.responseModel, "claude-opus-4-8");
		// Pricing is unchanged by this fix: the bridge has always priced a turn
		// with the Model object the query ran under (the selected model here),
		// never by reading turnOutput.model.
		const expected = { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, totalTokens: 1500, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
		calculateCost(opus55, expected);
		assert.ok(expected.cost.total > 0);
		assert.equal(message.usage.input, 1000);
		assert.equal(message.usage.output, 500);
		assert.deepEqual(message.usage.cost, expected.cost);
		// The fallback toast still fires for a configured pairing.
		assert.ok(
			notifications.some((n) => /safety fallback/.test(n.message)),
			`fallback notice missing: ${JSON.stringify(notifications)}`,
		);
	});

	// Claude Code picks the fallback target per refusal category, so a reroute
	// the bridge did not configure must still be announced.
	for (const [original, fallback, notice] of [
		["claude-opus-5-5", "claude-opus-5", "Pi Claude switched Claude Opus 5.5 to Claude Opus 5 after Claude Code safety fallback."],
		["claude-sonnet-5-5", "claude-sonnet-5", "Pi Claude switched Claude Sonnet 5.5 to Claude Sonnet 5 after Claude Code safety fallback."],
	]) {
		it(`announces Claude Code's own ${original} to ${fallback} safety fallback`, async () => {
			const selected = { ...opus55, id: original };
			__testSetSdkQueryFactory(() => fakeSdkQuery([
				{ type: "system", subtype: "init", session_id: `refusal-${original}` },
				{ type: "system", subtype: "model_refusal_fallback", original_model: original, fallback_model: fallback },
				...streamedReply(fallback, "fallback answer", { input: 10, output: 5 }),
			]));

			const message = finalMessage(await collect(streamClaudeAgentSdk(selected, context, { sessionId: `model-identity-${original}` })));
			assert.equal(message.responseModel, fallback);
			assert.deepEqual(notifications.filter((n) => /safety fallback/.test(n.message)), [{ message: notice, level: "info" }]);
		});
	}
});
