// Anthropic treats a subscription request whose system prompt carries both
// "custom providers (docs/custom-provider.md)" and "pi packages
// (docs/packages.md)" (two clauses of Pi's documentation line) as a
// third-party app, and with Extra Usage off rejects it with HTTP 400. The
// bridge sends such a request like any other, and when Claude Code reports
// Anthropic's rejection it adds a hint to the error Pi ends the turn with.
// Prompts come from Pi's own builder and pi-ai's context helpers, and requests
// run through the provider against a fake SDK.
import "./lib/debug-env.mjs";

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { getCurrentSystemPrompt, isContextOverflow, isRetryableAssistantError, normalizeContext } from "@earendil-works/pi-ai";
// Not in the package's exports map: Pi's session prompt builder.
import { buildSystemPromptSections } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";

import { __testSetBridgeIntegrityState, __testSetSdkQueryFactory, streamClaudeAgentSdk } from "../src/index.ts";
import { setExtensionApi } from "../src/bridge-state.ts";
import { resetStack } from "../src/query-state.ts";

// The retry and overflow matchers of the Pi the owner runs, when installed here.
const INSTALLED_PI_AI = "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/utils";

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

const CLAUSES = ["custom providers (docs/custom-provider.md)", "pi packages (docs/packages.md)"];
// Anthropic's rejection as Claude Code 2.1.285 reports it.
const REJECTION = "API Error: 400 Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and keep going.";
const ENV_KEYS = ["PI_CODING_AGENT_DIR", "CLAUDE_BRIDGE_ISOLATED", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT"];

let root;
before(() => {
	root = mkdtempSync(join(tmpdir(), "bridge-third-party-prompt-"));
	process.env.PI_CODING_AGENT_DIR = root;
	process.env.CLAUDE_BRIDGE_ISOLATED = "1";
	process.env.CLAUDE_CONFIG_DIR = root;
	process.env.CLAUDE_CODE_OAUTH_TOKEN = "offline-test";
	process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT = "0";
	setExtensionApi({ events: { emit: () => {} }, appendEntry: () => {} });
});
after(() => {
	__testSetSdkQueryFactory();
	setExtensionApi(undefined);
	resetStack();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
	for (const key of ENV_KEYS) delete process.env[key];
	rmSync(root, { recursive: true, force: true });
});

const user = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const streamEvent = (event) => ({ type: "stream_event", event });

// Pi's session prompt as AgentSession sends it: a sections-only system message.
function sessionMessages() {
	const sections = buildSystemPromptSections({
		cwd: "/tmp/project",
		selectedTools: ["read", "bash", "edit", "write"],
		toolSnippets: { read: "Read file contents", bash: "Execute bash commands" },
		contextFiles: [{ path: "/tmp/project/AGENTS.md", content: "Use tabs." }],
	});
	return [{ role: "system", content: "", sections, timestamp: 1 }, user("hello")];
}

// A one-shot call with its own system prompt, as an extension sends it.
const callerMessages = (systemPrompt) => normalizeContext({ systemPrompt, messages: [user("question")] }).messages;

const REPLY = [
	streamEvent({ type: "message_start", message: { id: "m1", model: model.id, usage: { input_tokens: 1 } } }),
	streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
	streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }),
	streamEvent({ type: "content_block_stop", index: 0 }),
	streamEvent({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }),
	streamEvent({ type: "message_stop" }),
	{ type: "result", subtype: "success", result: "ok" },
];

// What SDK 0.3.284 yields for the rejection: Claude Code's synthetic error
// message, a success-labelled error result, then, once Claude Code exits
// with code 1, the iterator throws with the result text.
const REJECTED = [
	{
		type: "assistant",
		error: "unknown",
		parent_tool_use_id: null,
		message: { id: "synthetic-1", model: "<synthetic>", role: "assistant", content: [{ type: "text", text: REJECTION }], stop_reason: "stop_sequence", usage: { input_tokens: 0, output_tokens: 0 } },
	},
	{ type: "result", subtype: "success", is_error: true, api_error_status: 400, result: REJECTION },
	new Error(`Claude Code returned an error result: ${REJECTION}`),
];

// Streams one request through the provider under `config` and reports the
// system prompts of the SDK queries it built and the final message.
async function request(config, messages, sdkMessages, options = {}) {
	writeFileSync(join(root, "claude-bridge.json"), JSON.stringify(config));
	const queries = [];
	__testSetSdkQueryFactory(({ options: sdkOptions }) => {
		queries.push(sdkOptions.systemPrompt.prompt);
		return {
			async *[Symbol.asyncIterator]() {
				yield { type: "system", subtype: "init", session_id: `fake-${queries.length}` };
				for (const message of sdkMessages) {
					if (message instanceof Error) throw message;
					yield message;
				}
			},
			close() {},
			async interrupt() {},
		};
	});
	__testSetBridgeIntegrityState({ sharedSession: null, ui: { notify: () => {} } });
	resetStack();
	const stream = streamClaudeAgentSdk(model, { messages }, { cwd: "/tmp/project", ...options });
	for await (const _event of stream);
	return { queries, message: await stream.result() };
}

describe("a system prompt Anthropic takes for a third-party app", () => {
	it("sends it unchanged, from Pi's main prompt or a caller's copy", { timeout: 10_000 }, async () => {
		const main = sessionMessages();
		const copied = callerMessages(`${getCurrentSystemPrompt(main)}\n---\n## Side Chat\n\nYou're in a side chat.`);
		for (const [messages, options] of [[main, {}], [copied, { sessionId: "side-chat" }]]) {
			const prompt = getCurrentSystemPrompt(messages);
			assert.ok(CLAUSES.every((clause) => prompt.includes(clause)), "the request carries both clauses");
			const { queries, message } = await request({}, messages, REPLY, options);
			assert.deepEqual(queries, [prompt]);
			assert.equal(message.stopReason, "stop", message.errorMessage);
		}
	});

	it("ends the turn with Anthropic's rejection and the bridge's hint, which Pi neither retries nor compacts on", { timeout: 10_000 }, async () => {
		const { queries, message } = await request({}, sessionMessages(), REJECTED);
		assert.equal(queries.length, 1);
		assert.equal(message.stopReason, "error");
		assert.ok(message.errorMessage.includes(REJECTION), message.errorMessage);
		for (const clause of CLAUSES) assert.ok(message.errorMessage.includes(clause), `the hint names ${clause}`);
		assert.match(message.errorMessage, /Set systemPrompt\.replacement in .*claude-bridge\.json/);
		assert.match(message.errorMessage, /extension that copies Pi's full system prompt into its own model call has to send its own prompt/);
		assert.equal(isRetryableAssistantError(message), false);
		assert.equal(isContextOverflow(message, model.contextWindow), false);
		if (existsSync(INSTALLED_PI_AI)) {
			const retry = await import(join(INSTALLED_PI_AI, "retry.js"));
			const overflow = await import(join(INSTALLED_PI_AI, "overflow.js"));
			assert.equal(retry.isRetryableAssistantError(message), false, "the installed Pi retries it");
			assert.equal(overflow.isContextOverflow(message, model.contextWindow), false, "the installed Pi compacts on it");
		}
	});
});
