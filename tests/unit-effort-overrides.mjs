import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveConfiguredEffort } from "../src/index.ts";

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
