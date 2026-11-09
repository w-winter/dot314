import "./lib/debug-env.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { completeSummarization } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js";
import { streamClaudeAgentSdk } from "../src/index.ts";
import { __testSetSdkQueryFactory } from "../src/sdk-query.ts";
import { resetStack } from "../src/query-state.ts";

const CACHE_KEYS = ["DISABLE_PROMPT_CACHING", "FORCE_PROMPT_CACHING_5M", "ENABLE_PROMPT_CACHING_1H"];
const ENV_KEYS = [...CACHE_KEYS, "PI_CODING_AGENT_DIR", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_BRIDGE_ISOLATED"];
const model = {
	id: "claude-haiku-4-5", name: "Claude Haiku", api: "claude-bridge", provider: "pi-claude", baseUrl: "claude-bridge",
	reasoning: true, input: ["text"], contextWindow: 200000, maxTokens: 8192,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const context = { messages: [
	{ role: "system", content: "Offline test instructions", timestamp: 0 },
	{ role: "user", content: "Summarize the fixture", timestamp: 1 },
] };
const cacheEnv = env => Object.fromEntries(CACHE_KEYS.filter(key => env[key] !== undefined).map(key => [key, env[key]]));
let root;
let saved;
let children;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "bridge-cache-retention-"));
	saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	for (const key of CACHE_KEYS) delete process.env[key];
	Object.assign(process.env, { PI_CODING_AGENT_DIR: root, CLAUDE_CONFIG_DIR: root, CLAUDE_CODE_OAUTH_TOKEN: "offline-test", CLAUDE_BRIDGE_ISOLATED: "1" });
	resetStack();
	children = [];
	__testSetSdkQueryFactory(({ options }) => {
		children.push(cacheEnv(options.env));
		return {
			async *[Symbol.asyncIterator]() {
				yield { type: "assistant", message: { id: randomUUID(), model: model.id, role: "assistant", content: [{ type: "text", text: "SUMMARY" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } } };
				yield { type: "result", subtype: "success", result: "SUMMARY" };
			},
			close() {}, async interrupt() {},
		};
	});
});

afterEach(() => {
	__testSetSdkQueryFactory();
	resetStack();
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	execFileSync("trash", [root]);
});

async function request(cacheRetention) {
	const options = { cwd: root, sessionId: randomUUID() };
	if (cacheRetention !== undefined) options.cacheRetention = cacheRetention;
	const stream = streamClaudeAgentSdk(model, context, options);
	for await (const event of stream) {}
	assert.equal((await stream.result()).stopReason, "stop");
}

it("honors Pi's real summary request without disabling caching for the next ordinary turn", async () => {
	const summary = await completeSummarization(model, context, { cwd: root }, streamClaudeAgentSdk);
	assert.equal(summary.stopReason, "stop");
	await request(undefined);
	assert.deepEqual(children, [{ DISABLE_PROMPT_CACHING: "1" }, {}]);
	assert.deepEqual(cacheEnv(process.env), {});
});

for (const [retention, key] of [["short", "FORCE_PROMPT_CACHING_5M"], ["long", "ENABLE_PROMPT_CACHING_1H"]]) {
	it(`forwards ${retention} retention to the child without changing the parent environment`, async () => {
		await request(retention);
		assert.deepEqual(children, [{ [key]: "1" }]);
		assert.deepEqual(cacheEnv(process.env), {});
	});
}

it("retains inherited cache restrictions when a request asks for a longer cache", async () => {
	process.env.DISABLE_PROMPT_CACHING = "1";
	process.env.FORCE_PROMPT_CACHING_5M = "1";
	await request("long");
	assert.deepEqual(children, [{ DISABLE_PROMPT_CACHING: "1", FORCE_PROMPT_CACHING_5M: "1", ENABLE_PROMPT_CACHING_1H: "1" }]);
	assert.deepEqual(cacheEnv(process.env), { DISABLE_PROMPT_CACHING: "1", FORCE_PROMPT_CACHING_5M: "1" });
});
