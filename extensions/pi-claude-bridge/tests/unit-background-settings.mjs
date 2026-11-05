import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";

import { probeClaudeAccountProfile } from "../src/account-host.ts";
import { discoverClaudeModels } from "../src/model-discovery.ts";
import { buildClaudeQueryOptions } from "../src/query-options.ts";
import { __testSetSdkQueryFactory } from "../src/sdk-query.ts";

let root;
let previousEnv;
const ENV_KEYS = ["PI_CODING_AGENT_DIR", "CLAUDE_CONFIG_DIR", "CLAUDE_BRIDGE_ISOLATED"];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "bridge-background-settings-"));
	previousEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	Object.assign(process.env, { PI_CODING_AGENT_DIR: root, CLAUDE_CONFIG_DIR: root });
	delete process.env.CLAUDE_BRIDGE_ISOLATED;
	writeFileSync(join(root, "claude-bridge.json"), JSON.stringify({ provider: { fastMode: true } }));
});

afterEach(() => {
	__testSetSdkQueryFactory();
	for (const [key, value] of Object.entries(previousEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	execFileSync("trash", [root]);
});

it("disables background memory consolidation for provider turns while keeping query settings", () => {
	const model = { id: "claude-sonnet-5", provider: "pi-claude" };
	const { queryOptions } = buildClaudeQueryOptions({
		cwd: root,
		requestedModel: model,
		queryModel: model,
		bridgeConfig: { provider: { fastMode: true, settingSources: ["user"] } },
		systemPrompt: "Pi prompt",
		resumeSessionId: null,
	});
	assert.equal(queryOptions.settings.autoDreamEnabled, false);
	assert.equal(queryOptions.settings.fastMode, true);
	assert.ok(queryOptions.settings.claudeMdExcludes.includes("**/CLAUDE.md"));
});

it("disables background memory consolidation during model discovery", async () => {
	let options;
	let closed = false;
	__testSetSdkQueryFactory(input => {
		options = input.options;
		return { async supportedModels() { return []; }, close() { closed = true; } };
	});
	assert.deepEqual(await discoverClaudeModels(root, undefined, undefined), []);
	assert.equal(options.settings.autoDreamEnabled, false);
	assert.deepEqual(options.settingSources, []);
	assert.equal(options.persistSession, false);
	assert.equal(options.env.CLAUDE_CODE_ENTRYPOINT, "pi-claude-bridge");
	assert.equal(closed, true);
});

it("disables background memory consolidation for the external account-host usage probe", async () => {
	let options;
	__testSetSdkQueryFactory(input => {
		assert.equal(input.prompt, "/usage");
		options = input.options;
		return {
			async *[Symbol.asyncIterator]() {
				yield { type: "system", subtype: "init", session_id: "offline-probe" };
			},
			async accountInfo() { return { email: "fixture@example.invalid" }; },
			async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() { return { fixture: true }; },
			close() {},
		};
	});
	const result = await probeClaudeAccountProfile({ profile: { profileId: "fixture", label: "Fixture", configDir: root }, cwd: root });
	assert.equal(options.settings.autoDreamEnabled, false);
	assert.equal(options.env.CLAUDE_CONFIG_DIR, root);
	assert.equal(options.env.CLAUDE_CODE_ENTRYPOINT, "pi-claude-bridge");
	assert.equal(result.identity.email, "fixture@example.invalid");
	assert.deepEqual(result.usage, { fixture: true });
});
