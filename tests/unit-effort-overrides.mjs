import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { resolveConfiguredEffort } from "../src/index.ts";
import { buildClaudeQueryOptions } from "../src/query-options.ts";

describe("Claude bridge effort overrides", () => {
	it("keeps mapped Pi effort when no override is configured", () => {
		assert.equal(resolveConfiguredEffort("claude-opus-4-8", "xhigh", {}), "xhigh");
	});

	it("uses a global forceEffort override", () => {
		assert.equal(resolveConfiguredEffort("claude-opus-4-8", "xhigh", { forceEffort: "max" }), "max");
	});

	it("uses a model-specific override before global forceEffort", () => {
		assert.equal(resolveConfiguredEffort("claude-opus-4-8", "xhigh", {
			forceEffort: "high",
			modelEffortOverrides: { "claude-opus-4-8": "max" },
		}), "max");
	});

	it("accepts pi-claude/<id> model override keys and wildcard keys", () => {
		assert.equal(resolveConfiguredEffort("claude-opus-4-8", "xhigh", {
			modelEffortOverrides: { "pi-claude/claude-opus-4-8": "max" },
		}), "max");
		// P2 / no-legacy: pre-rename claude-bridge/<id> keys are ignored.
		assert.equal(resolveConfiguredEffort("claude-opus-4-8", "xhigh", {
			modelEffortOverrides: { "claude-bridge/claude-opus-4-8": "max" },
		}), "xhigh");
		assert.equal(resolveConfiguredEffort("claude-haiku-4-5", "medium", {
			modelEffortOverrides: { "*": "low" },
		}), "low");
	});

	it("ignores invalid override values defensively", () => {
		assert.equal(resolveConfiguredEffort("claude-opus-4-8", "xhigh", {
			forceEffort: "ultracode",
			modelEffortOverrides: { "claude-opus-4-8": "turbo" },
		}), "xhigh");
	});
});

describe("model thinkingLevelMap effort", () => {
	function effortFor(thinkingLevelMap, reasoning) {
		const model = {
			id: "claude-opus-4-8",
			name: "Claude Opus 4.8",
			api: "claude-bridge",
			provider: "pi-claude",
			baseUrl: "claude-bridge",
			reasoning: true,
			thinkingLevelMap,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 8192,
		};
		return buildClaudeQueryOptions({
			cwd: tmpdir(),
			requestedModel: model,
			queryModel: model,
			bridgeConfig: {},
			systemPrompt: "Pi prompt",
			reasoning,
			resumeSessionId: null,
		}).queryOptions.effort;
	}

	it("uses the generic mapping for a level the map does not name", () => {
		assert.equal(effortFor(undefined, "xhigh"), "max");
		assert.equal(effortFor({ max: "max" }, "xhigh"), "max");
	});

	it("uses a valid mapped level", () => {
		assert.equal(effortFor({ xhigh: "xhigh" }, "xhigh"), "xhigh");
	});

	it("sends no effort for a level the map marks null", () => {
		assert.equal(effortFor({ xhigh: null, max: null }, "max"), undefined);
	});

	it("sends no effort for a mapped value Claude Code does not accept", () => {
		assert.equal(effortFor({ high: "turbo" }, "high"), undefined);
	});
});
