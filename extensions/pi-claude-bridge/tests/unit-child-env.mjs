// An exported gateway URL or API credential must not silently reroute a Claude
// Code child away from the subscription login.
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { afterEach, describe, it } from "node:test";

import { buildClaudeQueryOptions } from "../src/query-options.ts";
import { claudeChildEnv } from "../src/account-router.ts";
import { PARENT_SESSION_ENV } from "./fixtures/parent-session-env.mjs";

const ROUTING_KEYS = ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];
const SENTINEL_KEYS = [...ROUTING_KEYS, ...Object.keys(PARENT_SESSION_ENV), "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "ANTHROPIC_MODEL", "DISABLE_AUTO_COMPACT", "CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS", "CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING"];
const saved = new Map(SENTINEL_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
	for (const [key, value] of saved) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

const model = {
	id: "claude-sonnet-5",
	name: "Claude Sonnet",
	api: "claude-bridge",
	provider: "pi-claude",
	baseUrl: "claude-bridge",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8192,
};

function childEnv(bridgeConfig) {
	for (const key of ROUTING_KEYS) process.env[key] = `sentinel-${key}`;
	process.env.ANTHROPIC_MODEL = "sentinel-model";
	process.env.DISABLE_AUTO_COMPACT = "0";
	return buildClaudeQueryOptions({
		cwd: tmpdir(),
		requestedModel: model,
		queryModel: model,
		bridgeConfig,
		systemPrompt: "Pi prompt",
		resumeSessionId: null,
	}).queryOptions.env;
}

describe("Claude Code child environment", () => {
	for (const profile of [undefined, { configDir: "/offline/profile" }]) {
		for (const inheritAnthropicEnv of [false, true]) {
			it(`scrubs parent session state for ${profile ? "managed" : "unmanaged"} children with routing inheritance ${inheritAnthropicEnv}`, () => {
				const base = { ...PARENT_SESSION_ENV, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "0", CLAUDE_CODE_UNRELATED: "kept", CLAUDE_CODE_OAUTH_TOKEN: "offline-token", ANTHROPIC_API_KEY: "offline-key" };
				const original = { ...base };
				const env = claudeChildEnv(profile, inheritAnthropicEnv, base);
				for (const key of Object.keys(PARENT_SESSION_ENV)) assert.equal(env[key], key === "CLAUDE_CODE_ENTRYPOINT" ? "pi-claude-bridge" : undefined, key);
				assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
				assert.equal(env.CLAUDE_CODE_UNRELATED, "kept");
				assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, profile ? undefined : "offline-token");
				assert.equal(env.ANTHROPIC_API_KEY, !profile && inheritAnthropicEnv ? "offline-key" : undefined);
				assert.deepEqual(base, original);

				Object.assign(process.env, PARENT_SESSION_ENV, { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "0", CLAUDE_CONFIG_DIR: tmpdir() });
				const options = buildClaudeQueryOptions({ cwd: tmpdir(), requestedModel: model, queryModel: model, bridgeConfig: { provider: { inheritAnthropicEnv, enableConnectors: true } }, systemPrompt: "Pi prompt", account: profile, resumeSessionId: null }).queryOptions;
				for (const key of Object.keys(PARENT_SESSION_ENV)) assert.equal(options.env[key], key === "CLAUDE_CODE_ENTRYPOINT" ? "pi-claude-bridge" : undefined, key);
				assert.equal(options.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
				assert.equal(options.env.ENABLE_CLAUDEAI_MCP_SERVERS, "1");
				assert.equal(options.env.DISABLE_AUTO_COMPACT, "1");
				for (const [key, value] of Object.entries(PARENT_SESSION_ENV)) assert.equal(process.env[key], value);
				assert.equal(process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "0");
			});
		}
	}

	it("drops inherited Anthropic routing variables unless provider.inheritAnthropicEnv opts in", () => {
		delete process.env.CLAUDE_CODE_ENTRYPOINT;
		const env = childEnv({});
		assert.equal(env.CLAUDE_CODE_ENTRYPOINT, "pi-claude-bridge");
		for (const key of ROUTING_KEYS) assert.equal(env[key], undefined, key);
		assert.equal(env.ANTHROPIC_MODEL, "sentinel-model", "unrelated ANTHROPIC_* variables stay");
		assert.equal(env.DISABLE_AUTO_COMPACT, "1", "bridge-owned overrides apply last");

		const inherited = childEnv({ provider: { inheritAnthropicEnv: true } });
		for (const key of ROUTING_KEYS) assert.equal(inherited[key], `sentinel-${key}`, key);
		assert.equal(inherited.DISABLE_AUTO_COMPACT, "1");
	});

	it("makes every imported turn too old for Claude Code to resume as interrupted", () => {
		// Claude Code reads the value as a max age in ms; "0" or unset would let it
		// resume the turn and inject its own continuation prompt.
		process.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS = "3600000";
		assert.equal(childEnv({}).CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS, "1");
	});

	it("streams tool arguments as Claude writes them", () => {
		process.env.CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING = "0";
		assert.equal(childEnv({}).CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING, "1");
	});
});
