import type { RetainedMcpJobWaitPolicy } from "./mcp-tool-jobs.js";

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const OPENAI_CODEX_GPT_56_ASSUMED_CACHE_TTL_MS = 20 * 60 * 1000;
const THIRTY_MINUTES_MS = 30 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

export interface BackgroundWaitModelSnapshot {
  readonly provider: string;
  readonly api: string;
  readonly id: string;
  readonly baseUrl: string;
  readonly compat?: unknown;
}

export interface ResolveBackgroundWaitPolicyInput {
  readonly heartbeatEnabled: boolean;
  readonly cacheTtlMsByModel: Readonly<Record<string, number | null>>;
  readonly model?: BackgroundWaitModelSnapshot;
  readonly processCacheRetention?: string;
}

export type BackgroundWaitPolicyResolver = (
  input: ResolveBackgroundWaitPolicyInput,
) => RetainedMcpJobWaitPolicy;

interface GptVersion {
  readonly major: number;
  readonly minor: number;
}

function untilSettled(): RetainedMcpJobWaitPolicy {
  return { kind: "until_settled" };
}

function boundedForCacheTtl(cacheTtlMs: number): RetainedMcpJobWaitPolicy {
  const marginMs = Math.max(60_000, Math.ceil(cacheTtlMs * 0.1));
  const timeoutMs = Math.floor((cacheTtlMs - marginMs) / 1000) * 1000;
  return { kind: "bounded", timeoutMs };
}

function overridePolicy(cacheTtlMs: number | null | undefined): RetainedMcpJobWaitPolicy | undefined {
  if (cacheTtlMs === undefined) {
    return undefined;
  }
  return cacheTtlMs === null ? untilSettled() : boundedForCacheTtl(cacheTtlMs);
}

function readBooleanProperty(value: unknown, property: string): boolean | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const propertyValue = (value as Record<string, unknown>)[property];
  return typeof propertyValue === "boolean" ? propertyValue : undefined;
}

function hostname(baseUrl: string): string | undefined {
  if (!URL.canParse(baseUrl)) {
    return undefined;
  }
  return new URL(baseUrl).hostname.toLowerCase();
}

function isHostOrSubdomain(host: string | undefined, domain: string): boolean {
  return host === domain || host?.endsWith(`.${domain}`) === true;
}

function parseGptVersion(modelId: string): GptVersion | undefined {
  const match = /(?:^|[/.:_-])gpt-(\d+)(?:\.(\d+))?(?=$|[/:_-])/iu.exec(modelId);
  if (!match) {
    return undefined;
  }
  const minorText = match.at(2);
  return {
    major: Number.parseInt(match[1], 10),
    minor: minorText === undefined ? 0 : Number.parseInt(minorText, 10),
  };
}

function isGptAtLeast(version: GptVersion | undefined, major: number, minor: number): boolean {
  return version !== undefined && (version.major > major || (version.major === major && version.minor >= minor));
}

function isGpt55(version: GptVersion | undefined): boolean {
  return version?.major === 5 && version.minor === 5;
}

function isGpt56(version: GptVersion | undefined): boolean {
  return version?.major === 5 && version.minor === 6;
}

function usesLongRetention(input: ResolveBackgroundWaitPolicyInput): boolean {
  return input.processCacheRetention?.trim().toLowerCase() === "long";
}

function resolveAnthropicPolicy(
  input: ResolveBackgroundWaitPolicyInput,
  supportsLongCacheRetention: boolean | undefined,
): RetainedMcpJobWaitPolicy {
  const cacheTtlMs = usesLongRetention(input) && supportsLongCacheRetention !== false
    ? ONE_HOUR_MS
    : FIVE_MINUTES_MS;
  return boundedForCacheTtl(cacheTtlMs);
}

function resolveOpenAiPolicy(
  input: ResolveBackgroundWaitPolicyInput,
  modelId: string,
  supportsLongCacheRetention: boolean | undefined,
  explicitPromptCacheMode: boolean,
): RetainedMcpJobWaitPolicy {
  const version = parseGptVersion(modelId);
  if (isGpt55(version)) {
    return untilSettled();
  }
  if (explicitPromptCacheMode || isGptAtLeast(version, 5, 6)) {
    return boundedForCacheTtl(THIRTY_MINUTES_MS);
  }
  if (!version) {
    return untilSettled();
  }
  if (usesLongRetention(input) && supportsLongCacheRetention !== false) {
    return untilSettled();
  }
  return boundedForCacheTtl(FIVE_MINUTES_MS);
}

function resolveAutomaticPolicy(
  input: ResolveBackgroundWaitPolicyInput,
  model: BackgroundWaitModelSnapshot,
): RetainedMcpJobWaitPolicy {
  const modelHostname = hostname(model.baseUrl);
  const supportsLongCacheRetention = readBooleanProperty(model.compat, "supportsLongCacheRetention");

  if (
    model.provider === "anthropic" &&
    model.api === "anthropic-messages" &&
    modelHostname === "api.anthropic.com"
  ) {
    return resolveAnthropicPolicy(input, supportsLongCacheRetention);
  }

  if (
    model.provider === "openai" &&
    model.api === "openai-responses" &&
    modelHostname === "api.openai.com"
  ) {
    const explicitPromptCacheMode = readBooleanProperty(model.compat, "supportsExplicitPromptCacheMode") === true;
    return resolveOpenAiPolicy(input, model.id, supportsLongCacheRetention, explicitPromptCacheMode);
  }

  if (
    model.provider === "openai-codex" &&
    model.api === "openai-codex-responses" &&
    model.baseUrl === "https://chatgpt.com/backend-api"
  ) {
    return isGpt56(parseGptVersion(model.id))
      ? boundedForCacheTtl(OPENAI_CODEX_GPT_56_ASSUMED_CACHE_TTL_MS)
      : untilSettled();
  }

  if (
    model.provider === "azure-openai-responses" &&
    model.api === "azure-openai-responses" &&
    (modelHostname?.endsWith(".openai.azure.com") === true ||
      modelHostname?.endsWith(".services.ai.azure.com") === true)
  ) {
    return boundedForCacheTtl(FIVE_MINUTES_MS);
  }

  if (model.provider === "amazon-bedrock" && model.api === "bedrock-converse-stream") {
    if (isGptAtLeast(parseGptVersion(model.id), 5, 6)) {
      return boundedForCacheTtl(THIRTY_MINUTES_MS);
    }
    if (model.id.toLowerCase().startsWith("anthropic.claude-")) {
      return boundedForCacheTtl(FIVE_MINUTES_MS);
    }
    return untilSettled();
  }

  if (
    model.provider === "openrouter" &&
    model.api === "openai-completions" &&
    isHostOrSubdomain(modelHostname, "openrouter.ai")
  ) {
    const routedModelId = model.id.startsWith("~") ? model.id.slice(1) : model.id;
    if (routedModelId.toLowerCase().startsWith("anthropic/claude")) {
      return resolveAnthropicPolicy(input, supportsLongCacheRetention);
    }
    if (routedModelId.toLowerCase().startsWith("openai/")) {
      return resolveOpenAiPolicy(input, routedModelId, supportsLongCacheRetention, false);
    }
  }

  return untilSettled();
}

export function resolveBackgroundWaitPolicy(
  input: ResolveBackgroundWaitPolicyInput,
): RetainedMcpJobWaitPolicy {
  if (!input.heartbeatEnabled) {
    return untilSettled();
  }

  if (input.model) {
    const exactOverride = overridePolicy(input.cacheTtlMsByModel[`${input.model.provider}/${input.model.id}`]);
    if (exactOverride) {
      return exactOverride;
    }
    const providerOverride = overridePolicy(input.cacheTtlMsByModel[`${input.model.provider}/*`]);
    if (providerOverride) {
      return providerOverride;
    }
  }

  const globalOverride = overridePolicy(input.cacheTtlMsByModel["*"]);
  if (globalOverride) {
    return globalOverride;
  }
  if (!input.model) {
    return untilSettled();
  }

  return resolveAutomaticPolicy(input, input.model);
}