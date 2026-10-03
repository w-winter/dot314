// An exported gateway URL or API credential must not silently reroute a Claude
// Code child away from the subscription login.
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { afterEach, describe, it } from "node:test";

import { buildClaudeQueryOptions } from "../src/query-options.ts";

const ROUTING_KEYS = ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];
const SENTINEL_KEYS = [...ROUTING_KEYS, "ANTHROPIC_MODEL", "DISABLE_AUTO_COMPACT", "CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS", "CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING"];
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
	it("drops inherited Anthropic routing variables unless provider.inheritAnthropicEnv opts in", () => {
		const env = childEnv({});
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
