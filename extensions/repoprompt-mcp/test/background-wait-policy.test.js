import assert from "node:assert/strict";
import test from "node:test";

import { resolveBackgroundWaitPolicy } from "../dist/background-wait-policy.js";

const UNTIL_SETTLED = { kind: "until_settled" };
const FIVE_MINUTE_POLICY = { kind: "bounded", timeoutMs: 240_000 };
const THIRTY_MINUTE_POLICY = { kind: "bounded", timeoutMs: 1_620_000 };
const ONE_HOUR_POLICY = { kind: "bounded", timeoutMs: 3_240_000 };

function model(overrides = {}) {
  return {
    provider: "anthropic",
    api: "anthropic-messages",
    id: "claude-sonnet-4-5",
    baseUrl: "https://api.anthropic.com",
    ...overrides,
  };
}

function resolve(overrides = {}) {
  return resolveBackgroundWaitPolicy({
    heartbeatEnabled: true,
    cacheTtlMsByModel: {},
    model: model(),
    ...overrides,
  });
}

test("resolveBackgroundWaitPolicy disables heartbeats before all overrides", () => {
  assert.deepEqual(resolve({
    heartbeatEnabled: false,
    cacheTtlMsByModel: { "anthropic/claude-sonnet-4-5": 300_000, "*": 300_000 },
    processCacheRetention: "long",
  }), UNTIL_SETTLED);
});

test("resolveBackgroundWaitPolicy applies exact provider and global overrides in order", () => {
  const cacheTtlMsByModel = {
    "anthropic/claude-sonnet-4-5": 1_800_000,
    "anthropic/*": 3_600_000,
    "*": 300_000,
  };
  assert.deepEqual(resolve({ cacheTtlMsByModel }), THIRTY_MINUTE_POLICY);
  assert.deepEqual(resolve({
    cacheTtlMsByModel,
    model: model({ id: "claude-opus-4-1" }),
  }), ONE_HOUR_POLICY);
  assert.deepEqual(resolve({
    cacheTtlMsByModel,
    model: model({ provider: "custom", api: "custom", id: "model", baseUrl: "not a url" }),
  }), FIVE_MINUTE_POLICY);
});

test("resolveBackgroundWaitPolicy applies global overrides without a model snapshot", () => {
  assert.deepEqual(resolve({ model: undefined, cacheTtlMsByModel: { "*": 300_000 } }), FIVE_MINUTE_POLICY);
  assert.deepEqual(resolve({ model: undefined, cacheTtlMsByModel: { "*": null } }), UNTIL_SETTLED);
});

test("resolveBackgroundWaitPolicy treats null overrides as explicit no-heartbeat policies", () => {
  assert.deepEqual(resolve({ cacheTtlMsByModel: { "anthropic/claude-sonnet-4-5": null } }), UNTIL_SETTLED);
  assert.deepEqual(resolve({ cacheTtlMsByModel: { "anthropic/*": null } }), UNTIL_SETTLED);
});

test("resolveBackgroundWaitPolicy applies minimum and proportional safety margins", () => {
  assert.deepEqual(resolve({ cacheTtlMsByModel: { "*": 120_000 } }), { kind: "bounded", timeoutMs: 60_000 });
  assert.deepEqual(resolve({ cacheTtlMsByModel: { "*": 300_000 } }), FIVE_MINUTE_POLICY);
  assert.deepEqual(resolve({ cacheTtlMsByModel: { "*": 1_800_000 } }), THIRTY_MINUTE_POLICY);
  assert.deepEqual(resolve({ cacheTtlMsByModel: { "*": 3_600_000 } }), ONE_HOUR_POLICY);
});

test("resolveBackgroundWaitPolicy resolves direct Anthropic short and long retention", () => {
  assert.deepEqual(resolve(), FIVE_MINUTE_POLICY);
  assert.deepEqual(resolve({ processCacheRetention: "  LONG " }), ONE_HOUR_POLICY);
  assert.deepEqual(resolve({
    processCacheRetention: "long",
    model: model({ compat: { supportsLongCacheRetention: false } }),
  }), FIVE_MINUTE_POLICY);
});

test("resolveBackgroundWaitPolicy resolves direct OpenAI model families", () => {
  const directOpenAi = (id, compat) => model({
    provider: "openai",
    api: "openai-responses",
    id,
    baseUrl: "https://api.openai.com/v1",
    compat,
  });

  for (const id of ["gpt-5.6", "gpt-5.6-codex", "gpt-5.10", "gpt-6"]) {
    assert.deepEqual(resolve({ model: directOpenAi(id) }), THIRTY_MINUTE_POLICY);
  }
  assert.deepEqual(resolve({ model: directOpenAi("future-name", { supportsExplicitPromptCacheMode: true }) }),
    THIRTY_MINUTE_POLICY);
  assert.deepEqual(resolve({ model: directOpenAi("future-name") }), UNTIL_SETTLED);
  assert.deepEqual(resolve({ model: directOpenAi("gpt-5.5-pro") }), UNTIL_SETTLED);
  assert.deepEqual(resolve({
    model: directOpenAi("gpt-5.5-pro", { supportsExplicitPromptCacheMode: true }),
  }), UNTIL_SETTLED);
  assert.deepEqual(resolve({ model: directOpenAi("gpt-5.6preview") }), UNTIL_SETTLED);
  assert.deepEqual(resolve({ model: directOpenAi("gpt-5") }), FIVE_MINUTE_POLICY);
  assert.deepEqual(resolve({ model: directOpenAi("gpt-5"), processCacheRetention: "long" }), UNTIL_SETTLED);
  assert.deepEqual(resolve({
    model: directOpenAi("gpt-5", { supportsLongCacheRetention: false }),
    processCacheRetention: "long",
  }), FIVE_MINUTE_POLICY);
});

test("resolveBackgroundWaitPolicy uses the conservative Azure policy", () => {
  const azure = model({
    provider: "azure-openai-responses",
    api: "azure-openai-responses",
    id: "deployment-name",
    baseUrl: "https://example.openai.azure.com/openai/v1",
  });
  assert.deepEqual(resolve({ model: azure }), FIVE_MINUTE_POLICY);
  assert.deepEqual(resolve({ model: azure, processCacheRetention: "long" }), FIVE_MINUTE_POLICY);
  assert.deepEqual(resolve({ model: { ...azure, baseUrl: "https://example.services.ai.azure.com" } }),
    FIVE_MINUTE_POLICY);
});

test("resolveBackgroundWaitPolicy distinguishes Bedrock model families", () => {
  const bedrock = (id) => model({
    provider: "amazon-bedrock",
    api: "bedrock-converse-stream",
    id,
    baseUrl: "",
  });
  assert.deepEqual(resolve({ model: bedrock("openai.gpt-5.6-terra") }), THIRTY_MINUTE_POLICY);
  assert.deepEqual(resolve({ model: bedrock("anthropic.claude-sonnet-4-5-v1:0") }), FIVE_MINUTE_POLICY);
  assert.deepEqual(resolve({
    model: bedrock("anthropic.claude-sonnet-4-5-v1:0"),
    processCacheRetention: "long",
  }), FIVE_MINUTE_POLICY);
  assert.deepEqual(resolve({ model: bedrock("amazon.nova-pro-v1:0") }), UNTIL_SETTLED);
});

test("resolveBackgroundWaitPolicy resolves supported OpenRouter namespaces", () => {
  const openRouter = (id, compat) => model({
    provider: "openrouter",
    api: "openai-completions",
    id,
    baseUrl: "https://openrouter.ai/api/v1",
    compat,
  });
  assert.deepEqual(resolve({ model: openRouter("anthropic/claude-sonnet-4.5") }), FIVE_MINUTE_POLICY);
  assert.deepEqual(resolve({
    model: openRouter("~anthropic/claude-sonnet-4.5"),
    processCacheRetention: "long",
  }), ONE_HOUR_POLICY);
  assert.deepEqual(resolve({ model: openRouter("openai/gpt-5.6-sol") }), THIRTY_MINUTE_POLICY);
  assert.deepEqual(resolve({ model: openRouter("openai/gpt-5") }), FIVE_MINUTE_POLICY);
  assert.deepEqual(resolve({ model: openRouter("openai/gpt-5"), processCacheRetention: "long" }),
    UNTIL_SETTLED);
  assert.deepEqual(resolve({ model: openRouter("openrouter/auto") }), UNTIL_SETTLED);
  assert.deepEqual(resolve({ model: openRouter("mistralai/mistral-large") }), UNTIL_SETTLED);
});

test("resolveBackgroundWaitPolicy rejects conflicting custom and malformed routes", () => {
  assert.deepEqual(resolve({ model: model({ baseUrl: "https://proxy.example.com" }) }), UNTIL_SETTLED);
  assert.deepEqual(resolve({ model: model({ baseUrl: "not a url" }) }), UNTIL_SETTLED);
  assert.deepEqual(resolve({
    model: model({ provider: "openai", api: "openai-responses", id: "gpt-5.6", baseUrl: "https://openrouter.ai" }),
  }), UNTIL_SETTLED);
  assert.deepEqual(resolve({
    model: model({
      provider: "custom",
      api: "openai-responses",
      id: "gpt-5.6",
      baseUrl: "https://api.openai.com",
      compat: { supportsExplicitPromptCacheMode: true },
    }),
  }), UNTIL_SETTLED);
  assert.deepEqual(resolve({
    model: model({
      provider: "openrouter",
      api: "openai-responses",
      id: "openai/gpt-5.6",
      baseUrl: "https://openrouter.ai/api/v1",
    }),
  }), UNTIL_SETTLED);
});

test("resolveBackgroundWaitPolicy leaves providers without a verified TTL indefinite", () => {
  assert.deepEqual(resolve({ model: undefined }), UNTIL_SETTLED);
  assert.deepEqual(resolve({
    model: model({ provider: "mistral", api: "mistral-conversations", id: "mistral-large", baseUrl: "https://api.mistral.ai" }),
  }), UNTIL_SETTLED);
  assert.deepEqual(resolve({
    model: model({ provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.6", baseUrl: "https://chatgpt.com" }),
  }), UNTIL_SETTLED);
});

test("resolveBackgroundWaitPolicy reads only the long process retention convention", () => {
  for (const value of [undefined, "short", "none", "", "unexpected"]) {
    assert.deepEqual(resolve({ processCacheRetention: value }), FIVE_MINUTE_POLICY);
  }
});