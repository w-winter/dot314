// Pure assembly of the Claude Agent SDK query options for one bridge query.
// Extracted from index.ts (pure move): no closures — reads config, env, and
// the provided context only.

import { type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { createSdkMcpServer, type query, type EffortLevel, type SettingSource } from "@anthropic-ai/claude-agent-sdk";
import { accountSessionScope, claudeChildEnv, type ClaudeAccountRoute } from "./account-router.ts";
import { spawnClaudeCodeWithDiagnostics } from "./claude-executable.ts";
import { normalizeEffortLevel, resolveSystemPrompt, type Config } from "./config.ts";
import { connectorQueryOptions, connectorWriteModeFor, connectorsEnabledFor, settingSourcesForQuery } from "./connectors.ts";
import { connectorServersSnapshot } from "./connector-runtime.ts";
import { PROVIDER_ID } from "./convert.ts";
import { makeCliDebugOptions } from "./debug.ts";
import { FABLE_MODEL_ID, fallbackModelForPrimaryModel } from "./models.ts";
import { piMainPromptEvidence, type SystemPromptOrigin } from "./pi-sessions.ts";

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
	/** Where the system prompt came from; without it the prompt is treated as
	 * a caller's own and sent unchanged. */
	systemPromptOrigin?: SystemPromptOrigin;
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
	/** `pi-main:<evidence>` for Pi's main agent prompt, the only prompt a
	 * configured replacement changes; `caller` for any other prompt. */
	systemPromptSource: "pi-main:sections" | "pi-main:session" | "caller";
	effort?: EffortLevel;
	fallbackModel?: string;
}

interface OutboundSystemPrompt {
	prompt: string;
	source: BuiltClaudeQueryOptions["systemPromptSource"];
}

/** The system prompt a query sends Claude. Only Pi's main agent prompt takes
 * the configured replacement; a prompt from compaction or an extension's own
 * call keeps its instructions. The preamble tells resolveSystemPrompt whether
 * Pi built the base. */
function outboundSystemPrompt(
	input: Pick<BuildClaudeQueryOptionsInput, "queryModel" | "bridgeConfig" | "systemPromptOrigin"> & { systemPrompt: string },
): OutboundSystemPrompt {
	const { queryModel, bridgeConfig, systemPrompt, systemPromptOrigin } = input;
	const evidence = piMainPromptEvidence(systemPromptOrigin);
	if (!evidence) return { prompt: systemPrompt, source: "caller" };
	return {
		prompt: resolveSystemPrompt(systemPrompt, `${queryModel.provider}/${queryModel.id}`, bridgeConfig.systemPrompt, systemPromptOrigin?.preamble),
		source: `pi-main:${evidence}`,
	};
}

export function buildClaudeQueryOptions(input: BuildClaudeQueryOptionsInput): BuiltClaudeQueryOptions {
	const { cwd, requestedModel, queryModel, account, bridgeConfig, systemPrompt, systemPromptOrigin, reasoning, resumeSessionId, mcpServers, claudeExecutable } = input;
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
	const outbound = outboundSystemPrompt({ queryModel, bridgeConfig, systemPrompt, systemPromptOrigin });

	// Non-connector queries load no Claude Code filesystem settings by default.
	// Connector mode needs user settings for account connector discovery.
	const settingSources: SettingSource[] = settingSourcesForQuery(
		enableCloudMcp,
		providerSettings.settingSources,
	);
	// The same source gate loads Claude Code's own instruction files: with
	// "user" (connector mode) ~/.claude/CLAUDE.md, with "project" the checkout's
	// CLAUDE.md and AGENTS.md. Pi's system prompt already carries Pi's context
	// files, so these would repeat them or add a persona written for another
	// harness. Managed/policy memory cannot be excluded.
	const claudeMdExcludes = ["**/CLAUDE.md", "**/CLAUDE.local.md", "**/AGENTS.md", "**/.claude/rules/**"];
	// Prefer the model's own thinkingLevelMap when present (pi-ai 0.72+ ships
	// per-model overrides — e.g. opus-4-7 wants xhigh→xhigh, not xhigh→max).
	// Fall back to our generic table only for an absent key. A null entry marks
	// the level unsupported on that model, and a value Claude Code does not
	// accept is untrusted; both send no effort so Claude Code's default applies.
	const mapped = reasoning ? queryModel.thinkingLevelMap?.[reasoning as ModelThinkingLevel] : undefined;
	const requestedEffort = reasoning
		? mapped === undefined
			? REASONING_TO_EFFORT[reasoning]
			: normalizeEffortLevel(mapped) as EffortLevel | undefined
		: undefined;
	const effort = resolveConfiguredEffort(queryModel.id, requestedEffort, providerSettings);
	// Pi sends no reasoning for its "off" level. Without a thinking mode Claude
	// Code thinks by default (adaptive, or a token budget on models without
	// adaptive thinking), so off sends the disabled mode (`--thinking disabled`).
	// A null `off` entry marks a model that cannot turn thinking off; Pi hides the
	// level there, and a caller's missing reasoning leaves Claude Code's default.
	const thinkingOff = !reasoning && queryModel.thinkingLevelMap?.off !== null;

	const extraArgs: Record<string, string | null> = {};
	// Opus 4.7 defaults thinking.display to "omitted" (empty thinking text in stream).
	// Force summarized so thinking_delta events arrive.
	// Deliberately the raw flag, NOT the typed `thinking` option: every non-disabled
	// ThinkingConfig also emits `--thinking adaptive` or `--max-thinking-tokens`
	// (verified in sdk.mjs flag mapping), so the typed form cannot set display
	// without overriding the model's thinking mode alongside our `--effort`.
	// A configured effort still applies with thinking off; the display does not.
	if (effort && !thinkingOff) extraArgs["thinking-display"] = "summarized";
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
	// CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0: with CLAUDE_AUTO_BACKGROUND_TASKS set,
	// CC moves an MCP call still running after 120 s (this knob) to a background
	// task and answers it with a placeholder. The model then ends its turn, the
	// SDK closes the query on that result, and the call is interrupted; a Pi
	// tool's real result is orphaned. A bridge query cannot carry a background
	// task past its turn, so every MCP call stays in the foreground.
	// CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS=1: Claude Code resumes a
	// session whose last turn ended mid-turn (at a tool_result, say) as an
	// interrupted turn, with its own "Continue from where you left off." prompt
	// and a filler reply before the real one. Pi supplies every prompt, so the
	// bridge never wants that; a 1 ms max age makes every stored turn too old.
	// "0" would not do: Claude Code then falls back to its own limit (hours).
	// CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING=1: without it the API
	// holds each tool argument value until the model finishes writing it, so a
	// large write shows only its path for minutes and then arrives in one burst.
	// With it, the argument streams as it is written and Pi sees it grow.
	const childEnv = {
		...claudeChildEnv(account, providerSettings.inheritAnthropicEnv),
		ENABLE_CLAUDEAI_MCP_SERVERS: enableCloudMcp ? "1" : "0",
		DISABLE_AUTO_COMPACT: "1",
		CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: "0",
		CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS: "1",
		CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING: "1",
	};
	const queryOptions: NonNullable<Parameters<typeof query>[0]["options"]> = {
		cwd,
		model: queryModel.id,
		env: childEnv,
		...connectorQueryOptions(enableCloudMcp, connectorWriteMode),
		permissionMode: "bypassPermissions",
		includePartialMessages: true,
		...(fallbackModel ? { fallbackModel } : {}),
		settings: { claudeMdExcludes, ...(providerSettings.fastMode ? { fastMode: true } : {}) },
		systemPrompt: { type: "custom", prompt: outbound.prompt, snapshot: false },
		extraArgs,
		strictMcpConfig: true,
		...(thinkingOff ? { thinking: { type: "disabled" as const } } : {}),
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
		systemPromptSource: outbound.source,
		...(effort ? { effort } : {}),
		...(fallbackModel ? { fallbackModel } : {}),
	};
}
