/**
 * Pi's thinking level "off" reaches the provider as no `reasoning`. Claude
 * Code thinks by default when no thinking mode is given, so "off" must send
 * the explicit disabled mode; every other level keeps its options as before.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import * as piAi from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { resolveGetModels } from "../src/pi-ai-compat.ts";
import { buildModels } from "../src/models.ts";
import { buildClaudeQueryOptions } from "../src/query-options.ts";

const getModels = await resolveGetModels(piAi);
const MODELS = buildModels(getModels("anthropic")).map((m) => ({ ...m, api: "claude-bridge", provider: "pi-claude" }));
const modelById = (id) => {
	const model = MODELS.find((m) => m.id === id);
	assert.ok(model, `model ${id} is registered`);
	return model;
};

function optionsFor(model, reasoning, provider = {}) {
	return buildClaudeQueryOptions({
		cwd: tmpdir(),
		requestedModel: model,
		queryModel: model,
		bridgeConfig: { provider },
		systemPrompt: "Pi prompt",
		reasoning,
		resumeSessionId: null,
	}).queryOptions;
}

describe("Pi thinking off", () => {
	it("sends Claude Code the disabled thinking mode on an adaptive model", () => {
		const options = optionsFor(modelById("claude-opus-4-8"), undefined);
		assert.deepEqual(options.thinking, { type: "disabled" });
		assert.equal(options.effort, undefined);
		assert.deepEqual(options.extraArgs, {});
	});

	it("keeps a configured effort but sends no thinking display with it", () => {
		const options = optionsFor(modelById("claude-opus-4-8"), undefined, { forceEffort: "max" });
		assert.deepEqual(options.thinking, { type: "disabled" });
		assert.equal(options.effort, "max");
		assert.deepEqual(options.extraArgs, {});
	});

	it("sends no thinking mode for a model whose map marks off unsupported", () => {
		const model = { ...modelById("claude-opus-4-8"), thinkingLevelMap: { off: null, xhigh: "xhigh" } };
		const options = optionsFor(model, undefined);
		assert.equal("thinking" in options, false);
		assert.deepEqual(options.extraArgs, {});
	});

	it("hides off for bridge-listed models that cannot turn thinking off", () => {
		const offShown = Object.fromEntries(buildModels([]).map((m) => [m.id, getSupportedThinkingLevels(m).includes("off")]));
		assert.deepEqual(offShown, {
			"claude-fable-5-1": false,
			"claude-opus-5-5": false,
			"claude-opus-5": true,
			"claude-opus-4-8": true,
			"claude-sonnet-5-5": false,
			"claude-sonnet-5": true,
		});
	});

	it("leaves every other level's options without a thinking mode", () => {
		for (const model of MODELS) {
			for (const level of getSupportedThinkingLevels(model).filter((l) => l !== "off")) {
				const options = optionsFor(model, level);
				assert.equal("thinking" in options, false, `${model.id} ${level}`);
				assert.deepEqual(
					options.extraArgs,
					options.effort ? { "thinking-display": "summarized" } : {},
					`${model.id} ${level}`,
				);
			}
		}
	});
});
