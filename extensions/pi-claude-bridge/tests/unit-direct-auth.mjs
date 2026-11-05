import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";

import { hasDirectClaudeLogin } from "../src/direct-auth.ts";
import { loadConfig } from "../src/config.ts";
import { buildNativeProvider } from "../src/native-provider.ts";
import { buildClaudeQueryOptions } from "../src/query-options.ts";

const ENV_KEYS = ["PI_CODING_AGENT_DIR", "CLAUDE_BRIDGE_ENABLE_CONNECTORS", "CLAUDE_BRIDGE_ISOLATED"];
let root;
let saved;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "bridge-direct-auth-"));
	saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	process.env.PI_CODING_AGENT_DIR = root;
	delete process.env.CLAUDE_BRIDGE_ENABLE_CONNECTORS;
	delete process.env.CLAUDE_BRIDGE_ISOLATED;
	writeFileSync(join(root, "settings.json"), JSON.stringify({ apiKeyHelper: "/fixture/never-execute-this-helper" }));
});

afterEach(() => {
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	execFileSync("trash", [root]);
});

it("uses the provider query's effective setting sources for helper-only login availability", () => {
	const cases = [
		{ provider: {}, sources: [], available: false },
		{ provider: { settingSources: ["user"] }, sources: ["user"], available: true },
		{ provider: { enableConnectors: true }, sources: ["user"], available: true },
		{ provider: { enableConnectors: true, settingSources: [] }, sources: [], available: false },
		{ provider: { settingSources: ["project", "local"] }, sources: ["project", "local"], available: false },
		{ provider: {}, connectorsEnv: "1", sources: ["user"], available: true },
		{ provider: { settingSources: [] }, connectorsEnv: "1", sources: [], available: false },
	];
	const env = { CLAUDE_CONFIG_DIR: root };
	const model = { id: "claude-sonnet-5", provider: "pi-claude" };
	for (const { provider, connectorsEnv, sources, available } of cases) {
		writeFileSync(join(root, "claude-bridge.json"), JSON.stringify({ provider }));
		if (connectorsEnv === undefined) delete process.env.CLAUDE_BRIDGE_ENABLE_CONNECTORS;
		else process.env.CLAUDE_BRIDGE_ENABLE_CONNECTORS = connectorsEnv;
		const { queryOptions } = buildClaudeQueryOptions({
			cwd: root, requestedModel: model, queryModel: model, bridgeConfig: loadConfig(root),
			systemPrompt: "Pi prompt", resumeSessionId: null,
		});
		assert.deepEqual(queryOptions.settingSources, sources);
		assert.equal(hasDirectClaudeLogin(root, env, "linux"), available, JSON.stringify({ provider, connectorsEnv }));
	}
});

it("rechecks helper configuration when the native provider checks and resolves auth", { skip: process.platform === "darwin" }, async () => {
	const provider = buildNativeProvider({ createProvider: input => input }, [], () => {}, { CLAUDE_CONFIG_DIR: root });
	assert.equal(await provider.auth.apiKey.check(), undefined);
	assert.equal(await provider.auth.apiKey.resolve(), undefined);
	writeFileSync(join(root, "claude-bridge.json"), JSON.stringify({ provider: { settingSources: ["user"] } }));
	assert.equal((await provider.auth.apiKey.check()).type, "api_key");
	assert.equal((await provider.auth.apiKey.resolve()).auth.apiKey, "not-used");
	writeFileSync(join(root, "claude-bridge.json"), JSON.stringify({ provider: { settingSources: [] } }));
	assert.equal(await provider.auth.apiKey.check(), undefined);
});
