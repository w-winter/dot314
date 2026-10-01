/**
 * Tests for MODELS construction + fallback pairing.
 * Pins: opus shortcut resolves to whichever opus is first in MODEL_IDS_IN_ORDER,
 * projection strips pi-ai's baseUrl/api/provider/headers, and ordering is preserved.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FABLE_FALLBACK_MODEL_ID, FABLE_MODEL_ID, MODEL_IDS_IN_ORDER, OPUS_5_5_MODEL_ID, OPUS_5_MODEL_ID, SONNET_5_MODEL_ID, buildModels, fallbackModelForPrimaryModel, modelDisplayName } from "../src/models.js";
import { buildClaudeQueryOptions } from "../src/query-options.js";

// Simulated pi-ai registry entry — extra fields mimic the ones pi-ai exposes
// that must not leak into the provider-registered MODELS array.
const mockPiAiModel = (id) => ({
	id, name: id, reasoning: true, input: ["text"], cost: { input: 1, output: 1 },
	contextWindow: 200000, maxTokens: 8000,
	thinkingLevelMap: { xhigh: id === "claude-opus-4-8" ? "xhigh" : "max" },
	// Leaky fields that should be stripped by the projection:
	baseUrl: "https://api.anthropic.com", api: "anthropic", provider: "anthropic",
	headers: { "x-api-key": "LEAK" },
});

describe("MODELS projection", () => {
	it("strips baseUrl/api/provider/headers", () => {
		const models = buildModels(MODEL_IDS_IN_ORDER.map(mockPiAiModel));
		for (const m of models) {
			assert.equal(m.baseUrl, undefined);
			assert.equal(m.api, undefined);
			assert.equal(m.provider, undefined);
			assert.equal(m.headers, undefined);
		}
	});

	it("preserves MODEL_IDS_IN_ORDER ordering", () => {
		const models = buildModels(MODEL_IDS_IN_ORDER.map(mockPiAiModel));
		assert.deepEqual(models.map((m) => m.id), MODEL_IDS_IN_ORDER);
	});

	it("lists Fable 5.1 first, then Opus 5.5 ahead of older Opus models", () => {
		const models = buildModels(MODEL_IDS_IN_ORDER.map(mockPiAiModel));
		assert.equal(models[0]?.id, FABLE_MODEL_ID);
		assert.equal(models[1]?.id, OPUS_5_5_MODEL_ID);
		assert.equal(models[2]?.id, OPUS_5_MODEL_ID);
		assert.equal(models[3]?.id, FABLE_FALLBACK_MODEL_ID);
	});

	it("fills supported model metadata missing from pi-ai and drops unknown missing IDs", () => {
		const models = buildModels([mockPiAiModel("claude-haiku-4-5")]);
		assert.deepEqual(models.map((m) => m.id), ["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-opus-4-8", "claude-sonnet-5-5", "claude-sonnet-5", "claude-haiku-4-5"]);
		assert.equal(models.find((m) => m.id === "claude-fable-5-1")?.name, "Claude Fable 5.1");
		assert.equal(models.find((m) => m.id === "claude-fable-5-1")?.contextWindow, 1000000);
		assert.equal(models.find((m) => m.id === "claude-opus-4-8")?.maxTokens, 128000);
		assert.equal(models.find((m) => m.id === "claude-sonnet-5")?.name, "Claude Sonnet 5");
		assert.equal(models.find((m) => m.id === "claude-sonnet-5")?.contextWindow, 1000000);
		assert.equal(models.find((m) => m.id === "claude-sonnet-5-5")?.name, "Claude Sonnet 5.5");
		assert.equal(models.find((m) => m.id === "claude-sonnet-5-5")?.contextWindow, 1000000);
		assert.equal(models.find((m) => m.id === "claude-sonnet-5-5")?.maxTokens, 128000);
		assert.deepEqual(models.find((m) => m.id === "claude-sonnet-5-5")?.input, ["text", "image"]);
		assert.deepEqual(models.find((m) => m.id === "claude-sonnet-5-5")?.thinkingLevelMap, { off: null, xhigh: "xhigh", max: "max" });
		assert.equal(models.find((m) => m.id === "claude-opus-5")?.name, "Claude Opus 5");
		assert.equal(models.find((m) => m.id === "claude-opus-5")?.contextWindow, 1000000);
		assert.equal(models.find((m) => m.id === "claude-opus-5")?.maxTokens, 128000);
		assert.equal(models.find((m) => m.id === "claude-opus-5-5")?.name, "Claude Opus 5.5");
		assert.equal(models.find((m) => m.id === "claude-opus-5-5")?.contextWindow, 1000000);
		assert.equal(models.find((m) => m.id === "claude-opus-5-5")?.maxTokens, 128000);
		assert.deepEqual(models.find((m) => m.id === "claude-opus-5-5")?.thinkingLevelMap, { off: null, xhigh: "xhigh", max: "max" });
		assert.deepEqual(models.find((m) => m.id === "claude-opus-5")?.thinkingLevelMap, { xhigh: "xhigh", max: "max" });
		assert.deepEqual(models.find((m) => m.id === "claude-fable-5-1")?.thinkingLevelMap, { off: null, xhigh: "xhigh", max: "max" });
		assert.deepEqual(models.find((m) => m.id === "claude-sonnet-5")?.thinkingLevelMap, { xhigh: "xhigh", max: "max" });
		const sonnet = models.find((m) => m.id === "claude-sonnet-5-5");
		assert.ok(sonnet);
		assert.equal(sonnet.name, "Claude Sonnet 5.5");
		assert.equal(sonnet.contextWindow, 1000000);
		assert.equal(sonnet.maxTokens, 128000);
		assert.equal(sonnet.reasoning, true);
		assert.deepEqual(sonnet.input, ["text", "image"]);
	});

	it("forwards Sonnet 5.5 effort levels without overriding Claude Code's thinking mode", () => {
		const registeredModel = buildModels([]).find((m) => m.id === "claude-sonnet-5-5");
		assert.ok(registeredModel);
		const model = { ...registeredModel, provider: "pi-claude", api: "claude-bridge", baseUrl: "claude-bridge" };
		for (const reasoning of ["low", "medium", "high", "xhigh", "max"]) {
			const { queryOptions } = buildClaudeQueryOptions({
				cwd: process.cwd(),
				requestedModel: model,
				queryModel: model,
				bridgeConfig: {},
				systemPrompt: "Pi system prompt",
				reasoning,
				resumeSessionId: null,
			});
			assert.equal(queryOptions.model, "claude-sonnet-5-5");
			assert.equal(queryOptions.effort, reasoning);
			assert.equal(queryOptions.thinking, undefined);
		}
	});

	it("prefers pi-ai metadata over bridge fallback metadata", () => {
		const models = buildModels([{
			...mockPiAiModel("claude-fable-5-1"),
			name: "Registry Fable",
			contextWindow: 123,
			maxTokens: 456,
			thinkingLevelMap: { xhigh: "max" },
		}]);
		const fable = models.find((m) => m.id === "claude-fable-5-1");
		assert.equal(fable?.name, "Registry Fable");
		assert.equal(fable?.contextWindow, 123);
		assert.equal(fable?.maxTokens, 456);
		assert.deepEqual(fable?.thinkingLevelMap, { xhigh: "max" });
	});

	it("zeros out cost regardless of pi-ai pricing", () => {
		const models = buildModels(MODEL_IDS_IN_ORDER.map(mockPiAiModel));
		for (const m of models) {
			assert.deepEqual(m.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		}
	});

	it("preserves pi-ai thinkingLevelMap for per-model effort mapping", () => {
		const models = buildModels(MODEL_IDS_IN_ORDER.map(mockPiAiModel));
		assert.deepEqual(models.find((m) => m.id === "claude-opus-4-8")?.thinkingLevelMap, { xhigh: "xhigh" });
	});
});

describe("model fallback pairing", () => {
	it("configures Opus 4.8 safety fallback for the models whose classifiers decline", () => {
		assert.equal(fallbackModelForPrimaryModel(FABLE_MODEL_ID), FABLE_FALLBACK_MODEL_ID);
		assert.equal(fallbackModelForPrimaryModel(OPUS_5_MODEL_ID), FABLE_FALLBACK_MODEL_ID);
		assert.equal(fallbackModelForPrimaryModel(OPUS_5_5_MODEL_ID), FABLE_FALLBACK_MODEL_ID);
		assert.equal(fallbackModelForPrimaryModel(FABLE_FALLBACK_MODEL_ID), undefined);
		assert.equal(fallbackModelForPrimaryModel(SONNET_5_MODEL_ID), undefined);
		assert.equal(fallbackModelForPrimaryModel("claude-sonnet-5-5"), undefined);
		assert.equal(fallbackModelForPrimaryModel("claude-sonnet-4-6"), undefined);
	});

	it("labels every model in a configured fallback pairing", () => {
		for (const id of [FABLE_MODEL_ID, OPUS_5_5_MODEL_ID, OPUS_5_MODEL_ID, FABLE_FALLBACK_MODEL_ID]) {
			assert.notEqual(modelDisplayName(id), id);
		}
		assert.equal(modelDisplayName("claude-opus-5"), "Claude Opus 5");
		assert.equal(modelDisplayName("gpt-9"), "gpt-9");
	});
});
