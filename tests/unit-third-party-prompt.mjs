// Anthropic classifies a subscription request whose system prompt carries both
// docs/custom-provider.md and docs/packages.md (the two paths in Pi's docs
// section) as a third-party app: it bills Extra Usage, or fails with HTTP 400
// without Extra Usage credit. The bridge refuses such a request before any SDK
// query exists and ends it with one error Pi does not retry. Prompts come from
// Pi's own builder, summarizers and pi-ai's context helpers, and requests run
// through the provider against a fake SDK.
import "./lib/debug-env.mjs";

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { getCurrentSystemPrompt, isContextOverflow, isRetryableAssistantError, normalizeContext } from "@earendil-works/pi-ai";
import { generateBranchSummary, generateSummary } from "@earendil-works/pi-coding-agent";
// Not in the package's exports map: Pi's session prompt builder.
import { buildSystemPromptSections } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";

import { __testGetBridgeIntegrityState, __testSetBridgeIntegrityState, __testSetSdkQueryFactory, streamClaudeAgentSdk } from "../src/index.ts";
import { setExtensionApi } from "../src/bridge-state.ts";
import { resetStack } from "../src/query-state.ts";

// The retry matcher of the Pi the owner runs, when installed here.
const INSTALLED_PI_RETRY = "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/utils/retry.js";

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

const PATHS = ["docs/custom-provider.md", "docs/packages.md"];
const REPLACEMENT = "You are Claude Code, Anthropic's official CLI for Claude.\nYou are an interactive CLI tool that helps users with software engineering tasks. Use the instructions below and the tools available to you to assist the user.";
const CONFIGS = {
	default: {},
	owner: { systemPrompt: { replacement: REPLACEMENT, preservePiContext: true } },
};
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
function sessionMessages(options = {}) {
	const sections = buildSystemPromptSections({
		cwd: "/tmp/project",
		selectedTools: ["read", "bash", "edit", "write"],
		toolSnippets: { read: "Read file contents", bash: "Execute bash commands" },
		contextFiles: [{ path: "/tmp/project/AGENTS.md", content: "Use tabs." }],
		...options,
	});
	return [{ role: "system", content: "", sections, timestamp: 1 }, user("hello")];
}

// A one-shot call with its own system prompt, as an extension sends it.
const callerMessages = (systemPrompt) => normalizeContext({ systemPrompt, messages: [user("question")] }).messages;

// Capture the context and options Pi's own summarizers send to the provider.
function capturingStream(captured) {
	return async (_model, context, options) => {
		captured.push({ context, options });
		return {
			result: async () => ({
				role: "assistant",
				content: [{ type: "text", text: "summary" }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop",
				timestamp: 2,
			}),
		};
	};
}

async function summaryRequests() {
	const compaction = [];
	await generateSummary([user("please fix the bug")], model, 16384, undefined, undefined, undefined, undefined, undefined, undefined, capturingStream(compaction));
	const branch = [];
	const entries = [{ type: "message", id: "a", parentId: null, timestamp: new Date(1).toISOString(), message: user("explore option A") }];
	await generateBranchSummary(entries, { model, signal: new AbortController().signal, streamFn: capturingStream(branch) });
	return { "Pi's compaction summary": compaction[0], "Pi's branch summary": branch[0] };
}

// Streams one request through the provider under `config` and reports the
// SDK queries it built, the events Pi received and the final message.
async function request(config, messages, options = {}) {
	writeFileSync(join(root, "claude-bridge.json"), JSON.stringify(config));
	const queries = [];
	__testSetSdkQueryFactory(({ options: sdkOptions }) => {
		queries.push(sdkOptions.systemPrompt.prompt);
		return {
			async *[Symbol.asyncIterator]() {
				yield { type: "system", subtype: "init", session_id: `fake-${queries.length}` };
				yield streamEvent({ type: "message_start", message: { id: "m1", model: model.id, usage: { input_tokens: 1 } } });
				yield streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
				yield streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } });
				yield streamEvent({ type: "content_block_stop", index: 0 });
				yield streamEvent({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } });
				yield streamEvent({ type: "message_stop" });
				yield { type: "result", subtype: "success", result: "ok" };
			},
			close() {},
			async interrupt() {},
		};
	});
	__testSetBridgeIntegrityState({ sharedSession: null, ui: { notify: () => {} } });
	resetStack();
	const stream = streamClaudeAgentSdk(model, { messages }, { cwd: "/tmp/project", ...options });
	const events = [];
	for await (const event of stream) events.push(event);
	return { queries, events, message: await stream.result() };
}

async function assertRefused(config, messages, fix, options) {
	const prompt = getCurrentSystemPrompt(messages);
	assert.ok(PATHS.every((path) => prompt.includes(path)), "the request carries both paths");
	const { queries, events, message } = await request(config, messages, options);
	assert.equal(queries.length, 0, "an SDK query was built");
	assert.deepEqual(events.map((event) => event.type), ["error"]);
	assert.equal(message.stopReason, "error");
	assert.match(message.errorMessage, /docs\/custom-provider\.md and docs\/packages\.md/);
	assert.match(message.errorMessage, /third-party app/);
	assert.match(message.errorMessage, /Extra Usage/);
	assert.match(message.errorMessage, /HTTP 400/);
	assert.match(message.errorMessage, fix);
	assert.equal(isRetryableAssistantError(message), false, "Pi retries the refusal");
	assert.equal(isContextOverflow(message, model.contextWindow), false, "Pi compacts on the refusal");
	assert.equal(__testGetBridgeIntegrityState().sharedSession, null, "the refusal touched the shared session");
	return message;
}

async function assertSent(config, messages, options) {
	const { queries, message } = await request(config, messages, options);
	assert.equal(queries.length, 1);
	assert.equal(message.stopReason, "stop", message.errorMessage);
	return queries[0];
}

const SET_REPLACEMENT = /set systemPrompt\.replacement in .*claude-bridge\.json/;
const EXTENSION_COPIED = /extension .*copied Pi's full system prompt into its own model call/;

describe("a system prompt Anthropic takes for a third-party app", () => {
	it("refuses Pi's default main prompt under the default config", { timeout: 10_000 }, async () => {
		await assertRefused(CONFIGS.default, sessionMessages(), SET_REPLACEMENT);
	});

	it("refuses a pi-subagents append-mode child under the default config", { timeout: 10_000 }, async () => {
		await assertRefused(CONFIGS.default, sessionMessages({ appendSystemPrompt: '<active_agent name="worker"/>\n\nWorker instructions.' }), SET_REPLACEMENT);
	});

	it("refuses a caller that copies Pi's full main prompt under the owner config", { timeout: 10_000 }, async () => {
		const copied = `${getCurrentSystemPrompt(sessionMessages())}\n---\n## Side Chat\n\nYou're in a SIDE CHAT parallel to the main agent.`;
		await assertRefused(CONFIGS.owner, callerMessages(copied), EXTENSION_COPIED, { sessionId: "side-chat-overlay" });
	});

	it("refuses a main prompt whose own base carries both paths under the owner config", { timeout: 10_000 }, async () => {
		const messages = sessionMessages({ customPrompt: `My SYSTEM.md. Read ${PATHS[0]} and ${PATHS[1]} first.` });
		await assertRefused(CONFIGS.owner, messages, /still carries both after the configured systemPrompt\.replacement/);
	});

	it("gives an error Pi's installed retry matcher does not retry", { timeout: 10_000, skip: !existsSync(INSTALLED_PI_RETRY) && "installed Pi not found" }, async () => {
		const installed = await import(INSTALLED_PI_RETRY);
		const message = await assertRefused(CONFIGS.default, sessionMessages(), SET_REPLACEMENT);
		assert.equal(installed.isRetryableAssistantError(message), false);
	});

	it("sends Pi's main prompt under the owner config", { timeout: 10_000 }, async () => {
		const sent = await assertSent(CONFIGS.owner, sessionMessages());
		assert.ok(sent.startsWith(REPLACEMENT));
		assert.ok(!PATHS.some((path) => sent.includes(path)));
	});

	it("sends a pi-subagents replace-mode child under either config", { timeout: 10_000 }, async () => {
		for (const config of Object.values(CONFIGS)) {
			await assertSent(config, sessionMessages({ customPrompt: '<active_agent name="worker"/>\n\nWorker instructions.' }));
		}
	});

	it("sends Pi's compaction and branch summaries under either config", { timeout: 10_000 }, async () => {
		for (const [name, { context, options }] of Object.entries(await summaryRequests())) {
			for (const config of Object.values(CONFIGS)) {
				const sent = await assertSent(config, context.messages, { sessionId: options.sessionId, cacheRetention: options.cacheRetention });
				assert.equal(sent, getCurrentSystemPrompt(context.messages), name);
			}
		}
	});

	it("sends a prompt carrying only one of the two paths", { timeout: 10_000 }, async () => {
		for (const path of PATHS) {
			const prompt = `You review Pi packages. See ${path} before answering.`;
			assert.equal(await assertSent(CONFIGS.default, callerMessages(prompt)), prompt);
		}
	});
});
