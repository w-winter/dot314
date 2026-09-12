// Pure assembly of the Claude Agent SDK query options for one bridge query.
// Extracted from index.ts (pure move): no closures — reads config, env, and
// the provided context only.

import { type Model } from "@earendil-works/pi-ai";
import { createSdkMcpServer, type query, type EffortLevel, type SettingSource } from "@anthropic-ai/claude-agent-sdk";
import { accountSessionScope, subscriberProfileEnv, type ClaudeAccountRoute } from "./account-router.js";
import { spawnClaudeCodeWithDiagnostics } from "./claude-executable.js";
import { normalizeEffortLevel, resolveSystemPrompt, type Config } from "./config.js";
import { connectorQueryOptions, connectorWriteModeFor, connectorsEnabledFor, settingSourcesForQuery } from "./connectors.js";
import { connectorServersSnapshot } from "./connector-runtime.js";
import { PROVIDER_ID } from "./convert.js";
import { makeCliDebugOptions } from "./debug.js";
import { FABLE_MODEL_ID, fallbackModelForPrimaryModel } from "./models.js";

// --- Effort level mapping ---
// Pi reasoning levels → CC SDK effort levels

const REASONING_TO_EFFORT: Record<string, EffortLevel> = {
	minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "max", max: "max",
};

function normalizeEffortOverrideModelKey(value: string): string {
	const key = value.trim().toLowerCase();
	return key.startsWith(`${PROVIDER_ID}/`) ? key.slice(PROVIDER_ID.length + 1) : key;
}

export function resolveConfiguredEffort(
	modelId: string,
	reasoningEffort: EffortLevel | undefined,
	providerConfig?: Config["provider"],
): EffortLevel | undefined {
	const target = normalizeEffortOverrideModelKey(modelId);
	for (const [key, rawEffort] of Object.entries(providerConfig?.modelEffortOverrides ?? {})) {
		const normalizedKey = normalizeEffortOverrideModelKey(key);
		if (normalizedKey !== "*" && normalizedKey !== target) continue;
		const effort = normalizeEffortLevel(rawEffort) as EffortLevel | undefined;
		if (effort) return effort;
	}
	return (normalizeEffortLevel(providerConfig?.forceEffort) as EffortLevel | undefined) ?? reasoningEffort;
}

export interface BuildClaudeQueryOptionsInput {
	cwd: string;
	/** The model Pi requested. */
	requestedModel: Model<any>;
	/** The model this attempt actually runs (router may substitute). */
	queryModel: Model<any>;
	account?: ClaudeAccountRoute;
	bridgeConfig: Config;
	systemPrompt?: string;
	/** Pi reasoning level from the stream options, if any. */
	reasoning?: string;
	resumeSessionId: string | null;
	mcpServers?: Record<string, ReturnType<typeof createSdkMcpServer>>;
	claudeExecutable?: string;
}

export interface BuiltClaudeQueryOptions {
	queryOptions: NonNullable<Parameters<typeof query>[0]["options"]>;
	// Diagnostics-ish bits the caller's debug line reports.
	enableCloudMcp: boolean;
	effort?: EffortLevel;
	fallbackModel?: string;
}

export function buildClaudeQueryOptions(input: BuildClaudeQueryOptionsInput): BuiltClaudeQueryOptions {
	const { cwd, requestedModel, queryModel, account, bridgeConfig, systemPrompt, reasoning, resumeSessionId, mcpServers, claudeExecutable } = input;
	const providerSettings = bridgeConfig.provider ?? {};
	const accountScope = accountSessionScope(account);
	// Whether to expose the Claude account's claude.ai cloud MCP connectors
	// (Gmail/Calendar/Drive). Enabled via env or config; drives setting-sources,
	// tool isolation, and the ENABLE_CLAUDEAI_MCP_SERVERS child-env gate below.
	const enableCloudMcp = connectorsEnabledFor(bridgeConfig);
	// Connector WRITE control: read-only by default (writes denied); the one-shot
	// approved-write executor sets CLAUDE_BRIDGE_CONNECTOR_WRITE=allow / config.
	const connectorWriteMode = connectorWriteModeFor(bridgeConfig);
	// Declare the account's connected connectors explicitly so `alwaysLoad` can
	// hold startup until they attach — otherwise the turn-1 manifest is built
	// before the CLI has fetched them.
	const connectorServers = enableCloudMcp ? connectorServersSnapshot(accountScope.claudeConfigDir) : {};
	if (systemPrompt === undefined) throw new Error("pi-claude-bridge: missing Pi system prompt");
	const resolvedSystemPrompt = resolveSystemPrompt(
		systemPrompt,
		`${queryModel.provider}/${queryModel.id}`,
		bridgeConfig.systemPrompt,
	);

	// Non-connector queries load no Claude Code filesystem settings by default.
	// Connector mode needs user settings for account connector discovery.
	const settingSources: SettingSource[] = settingSourcesForQuery(
		enableCloudMcp,
		providerSettings.settingSources,
	);
	// Prefer the model's own thinkingLevelMap when present (pi-ai 0.72+ ships
	// per-model overrides — e.g. opus-4-7 wants xhigh→xhigh, not xhigh→max).
	// Fall back to our generic table for older pi-ai or unmapped levels.
	const requestedEffort = reasoning
		? ((queryModel as any).thinkingLevelMap?.[reasoning] as EffortLevel | undefined)
			?? REASONING_TO_EFFORT[reasoning]
		: undefined;
	const effort = resolveConfiguredEffort(queryModel.id, requestedEffort, providerSettings);

	const extraArgs: Record<string, string | null> = {};
	// Opus 4.7 defaults thinking.display to "omitted" (empty thinking text in stream).
	// Force summarized so thinking_delta events arrive.
	// Deliberately the raw flag, NOT the typed `thinking` option: every non-disabled
	// ThinkingConfig also emits `--thinking adaptive` or `--max-thinking-tokens`
	// (verified in sdk.mjs flag mapping), so the typed form cannot set display
	// without overriding the model's thinking mode alongside our `--effort`.
	if (effort) extraArgs["thinking-display"] = "summarized";
	// With a managed Fable pool, let every account's model-scoped allowance run
	// out (rotation) before changing models — the CLI's own Opus fallback would
	// silently skip accounts whose Fable quota is still available. Once the
	// router explicitly selects Opus, its normal Opus→4.8 safety fallback is
	// back on.
	const fallbackModel = account && requestedModel.id === FABLE_MODEL_ID && queryModel.id === requestedModel.id
		? undefined
		: fallbackModelForPrimaryModel(queryModel.id);

	// Suppress claude.ai cloud MCP servers (Figma/Canva/etc. auto-discovered via OAuth
	// when the user is logged into Anthropic). These are a separate code path from
	// filesystem MCP and are NOT blocked by --strict-mcp-config or settingSources=undefined.
	// The native CC binary gates them on env var ENABLE_CLAUDEAI_MCP_SERVERS: setting it
	// to "0"/"false"/"no"/"off" makes the loader return early before any cloud fetch.
	// DISABLE_AUTO_COMPACT=1: pi owns context-management and propagates its own
	// /compact via session_compact (see handler in the extension entry). Letting CC
	// also autocompact would double-flush the prompt cache and races pi's
		// threshold with CC's, including CC's anti-thrashing guard.
	// Manual /compact in CC still works (we never invoke it).
	// When connectors are enabled, allow claude.ai cloud MCP servers so the
	// authenticated account's Gmail/Calendar/Drive tools load. Default stays "0".
	const childEnv = {
		...(account ? subscriberProfileEnv(account) : process.env),
		ENABLE_CLAUDEAI_MCP_SERVERS: enableCloudMcp ? "1" : "0",
		DISABLE_AUTO_COMPACT: "1",
	};
	const queryOptions: NonNullable<Parameters<typeof query>[0]["options"]> = {
		cwd,
		model: queryModel.id,
		env: childEnv,
		...connectorQueryOptions(enableCloudMcp, connectorWriteMode),
		permissionMode: "bypassPermissions",
		includePartialMessages: true,
		...(fallbackModel ? { fallbackModel } : {}),
		...(providerSettings.fastMode ? { settings: { fastMode: true } } : {}),
		systemPrompt: resolvedSystemPrompt,
		extraArgs,
		strictMcpConfig: true,
		...(effort ? { effort } : {}),
		settingSources,
		...(mcpServers || Object.keys(connectorServers).length > 0
			? { mcpServers: { ...(mcpServers ?? {}), ...connectorServers } as NonNullable<Parameters<typeof query>[0]["options"]>["mcpServers"] }
			: {}),
		...(resumeSessionId ? { resume: resumeSessionId } : {}),
		...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
		spawnClaudeCodeProcess: spawnClaudeCodeWithDiagnostics,
		...makeCliDebugOptions("provider"),
	};

	return {
		queryOptions,
		enableCloudMcp,
		...(effort ? { effort } : {}),
		...(fallbackModel ? { fallbackModel } : {}),
	};
}
