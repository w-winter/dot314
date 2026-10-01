// Children drop ANTHROPIC_BASE_URL / _API_KEY / _AUTH_TOKEN unless
// provider.inheritAnthropicEnv opts in, so availability, the pre-spawn check
// and the auth source label must not count those variables either.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import * as piAi from "@earendil-works/pi-ai";
import { __testSetSdkQueryFactory, streamClaudeAgentSdk } from "../src/index.ts";
import { buildNativeProvider } from "../src/native-provider.ts";
import { resetStack } from "../src/query-state.ts";

const MODELS = [
	{ id: "claude-haiku-4-5", name: "Claude Haiku 4.5", reasoning: false, input: ["text"], contextWindow: 200000, maxTokens: 64000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
];
const model = { ...MODELS[0], api: "claude-bridge", provider: "pi-claude", baseUrl: "claude-bridge" };
const context = {
	systemPrompt: "test system prompt",
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

const ENV_KEYS = [
	"PI_CODING_AGENT_DIR", "CLAUDE_CONFIG_DIR", "CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT",
	"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN",
	"CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
	"CLAUDE_CODE_USE_ANTHROPIC_AWS", "CLAUDE_CODE_USE_MANTLE",
];
const savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
const platform = Object.getOwnPropertyDescriptor(process, "platform");
let root;
let loggedOut;
let loggedIn;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "bridge-auth-env-"));
	loggedOut = join(root, "claude-logged-out");
	loggedIn = join(root, "claude-logged-in");
	mkdirSync(loggedOut);
	mkdirSync(loggedIn);
	writeFileSync(join(loggedIn, ".credentials.json"), "{}");
	mkdirSync(join(root, "agent"));
	for (const key of ENV_KEYS) delete process.env[key];
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT = "0";
	// The macOS Keychain fallback treats every darwin host as logged in; pin
	// linux so a missing login is observable.
	Object.defineProperty(process, "platform", { ...platform, value: "linux" });
	resetStack();
});

afterEach(() => {
	Object.defineProperty(process, "platform", platform);
	for (const [key, value] of savedEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	__testSetSdkQueryFactory();
	resetStack();
	rmSync(root, { recursive: true, force: true });
});

function optIn() {
	writeFileSync(join(root, "agent", "claude-bridge.json"), JSON.stringify({ provider: { inheritAnthropicEnv: true } }));
}

async function collect(stream) {
	const events = [];
	for await (const event of stream) events.push(event);
	return events;
}

describe("Anthropic credentials in the parent environment", () => {
	it("count for availability and the source label only with inheritAnthropicEnv", async () => {
		const keyOnly = buildNativeProvider(piAi, MODELS, () => {}, { CLAUDE_CONFIG_DIR: loggedOut, ANTHROPIC_API_KEY: "sentinel" });
		const keyAndLogin = buildNativeProvider(piAi, MODELS, () => {}, { CLAUDE_CONFIG_DIR: loggedIn, ANTHROPIC_API_KEY: "sentinel" });

		assert.equal(await keyOnly.auth.apiKey.check({ ctx: {} }), undefined, "a stripped key is not a credential");
		assert.equal(await keyOnly.auth.apiKey.resolve({ ctx: {} }), undefined);
		assert.deepEqual(await keyAndLogin.auth.apiKey.check({ ctx: {} }), { type: "api_key", source: "Claude Code login" });

		optIn();
		assert.deepEqual(await keyOnly.auth.apiKey.check({ ctx: {} }), { type: "api_key", source: "ANTHROPIC_API_KEY" });
		assert.deepEqual(await keyAndLogin.auth.apiKey.check({ ctx: {} }), { type: "api_key", source: "ANTHROPIC_API_KEY" });
	});

	it("pass the pre-spawn credential check only with inheritAnthropicEnv", async () => {
		process.env.CLAUDE_CONFIG_DIR = loggedOut;
		process.env.ANTHROPIC_API_KEY = "sentinel";
		const spawned = [];
		__testSetSdkQueryFactory((input) => {
			spawned.push(input.options);
			return {
				async *[Symbol.asyncIterator]() {
					yield { type: "system", subtype: "init", session_id: "auth-env-session" };
					yield { type: "result", subtype: "success", result: "ok" };
				},
				close() {},
				async interrupt() {},
			};
		});

		const refused = await collect(streamClaudeAgentSdk(model, context, { sessionId: "auth-env-default" }));
		assert.equal(spawned.length, 0, "no child without a usable credential");
		assert.equal(refused.at(-1)?.error?.errorMessage, "Claude account not connected — connect an account (or run `claude login`) and retry.");
		assert.equal(piAi.isRetryableAssistantError(refused.at(-1).error), false, "Pi does not retry a disconnected account");

		optIn();
		await collect(streamClaudeAgentSdk(model, context, { sessionId: "auth-env-opt-in" }));
		assert.equal(spawned.length, 1);
		assert.equal(spawned[0].env.ANTHROPIC_API_KEY, "sentinel");
	});
});
