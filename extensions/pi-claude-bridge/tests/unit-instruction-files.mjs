// Pi's system prompt carries Pi's context files, so Claude Code must not load
// its own instruction files on top, whatever settings sources a query loads.
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { it } from "node:test";

import { buildClaudeQueryOptions } from "../src/query-options.ts";

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

const settingsFor = (provider) => buildClaudeQueryOptions({
	cwd: tmpdir(),
	requestedModel: model,
	queryModel: model,
	bridgeConfig: { provider },
	systemPrompt: "Pi prompt",
	resumeSessionId: null,
}).queryOptions.settings;

it("excludes Claude Code's instruction files for every settings-source choice, and keeps fast mode", () => {
	for (const provider of [{}, { settingSources: ["user"] }, { settingSources: ["user", "project", "local"] }]) {
		assert.deepEqual(settingsFor(provider).claudeMdExcludes, ["**/CLAUDE.md", "**/CLAUDE.local.md", "**/AGENTS.md", "**/.claude/rules/**"]);
	}
	assert.equal(settingsFor({ fastMode: true }).fastMode, true);
	assert.equal(settingsFor({}).fastMode, undefined);
});
