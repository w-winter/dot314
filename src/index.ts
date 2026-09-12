import { type AssistantMessage, type AssistantMessageEventStream, type Context, type Model, type SimpleStreamOptions, type Tool } from "@earendil-works/pi-ai";
import * as piAi from "@earendil-works/pi-ai";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createSdkMcpServer, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Base64ImageSource, ContentBlockParam, MessageParam } from "@anthropic-ai/sdk/resources";
import { PROVIDER_ID, messageContentToText } from "./convert.js";
import { buildModels, modelDisplayName } from "./models.js";
import { MCP_SERVER_NAME, MCP_TOOL_PREFIX } from "./skills.js";
import { extractAllToolResults as _extractAllToolResults, type McpResult } from "./extract-tool-results.js";
import { QueryContext, ctx, deleteQueryLane, drainPendingToolCalls, drainStrandedToolCalls, popContext, stackDepth, pushContext, summarizeDroppedUserMessages, takeQueuedOrParkedResult, toolCallDrainCause, type DeferredUserMessage } from "./query-state.js";
import { teardownQuery } from "./query-teardown.js";
import { loadConfig, recordProjectTrust } from "./config.js";
import { hasClaudeCredentials } from "./auth-presence.js";
import { NATIVE_PROVIDER_UNSUPPORTED_MESSAGE, buildNativeProvider, supportsNativeProvider } from "./native-provider.js";
import { jsonSchemaToZodShape } from "./typebox-to-zod.js";
import { resolveGetModels } from "./pi-ai-compat.js";
import { debug, diagDump, makeCliDebugOptions, moduleInstanceId } from "./debug.js";
import { preflightClaudeExecutable, resolveClaudeExecutable } from "./claude-executable.js";
import { appendIntegrityEntry, argKeys, deleteSharedSessionLane, extensionApi, getSharedSession, markSessionForRebuild, recordStartedLane, reportToolResultMismatch, safeNotify, safeToolCallSummary, setExtensionApi, setPiUI, setSharedSession, takeStartedLane, type SessionState } from "./bridge-state.js";
import { connectorsEnabledFor, isChildExecutedTool } from "./connectors.js";
import { primeConnectorServers } from "./connector-runtime.js";
import { cancelScheduledSessionPersistence, conversationFingerprint, restoreSharedSessionFromPi, schedulePersistSharedSession, syncSharedSession } from "./session-persistence.js";
import { STREAM_IDLE_BACKOFF_HINT_MS, activeStreamIdleWatchdogs, buildStreamIdleTimeoutErrorMessage, createStreamIdleWatchdog, formatDurationShort, streamIdleTimeoutMsFromEnv } from "./stream-idle-watchdog.js";
import { RATE_LIMIT_TOKEN, formatResetTimestamp } from "./rate-limit.js";
import { mapToolArgs } from "./tool-mapping.js";
import { finalizeCurrentStream, finalizeToolUseTurnFromMcpInvocation, scheduleToolUseTurnEnd, updateTurnOutputModel } from "./assistant-stream.js";
import {
	accountSessionScope,
	classifyClaudeFailure,
	CLAUDE_BRIDGE_ACCOUNT_HOST_SYMBOL,
	rateLimitResetFromInfo,
	rateLimitResetMs,
	rateLimitTypeFromInfo,
	resolveClaudeAccountRouter,
	RetryEventBuffer,
	safeRouterCall,
	type ClaudeAccountRoute,
} from "./account-router.js";
import { BRIDGE_ACCOUNT_HOST } from "./account-host.js";
import { registerBridgeCommands } from "./bridge-commands.js";
import { consumeQuery, emitRateLimitEvent, type ClaudeAttemptFailure } from "./consume-query.js";
import { buildClaudeQueryOptions } from "./query-options.js";
import { sdkQueryFactory } from "./sdk-query.js";
import { currentRequestLaneId, runInRequestLane } from "./request-lane.js";

// Re-exports: the module decomposition must not change the bundle entry's
// public surface — unit tests and downstream consumers import these from
// bundle/index.js.
export { probeClaudeAccountProfile } from "./account-host.js";
export { __testSetSdkQueryFactory } from "./sdk-query.js";
export { resolveConfiguredEffort } from "./query-options.js";
export { classifyClaudeExecutableBytes, preflightClaudeExecutable, resolveClaudeExecutable, spawnClaudeCodeWithDiagnostics, wrapClaudeSpawnErrorForSdk, type ClaudeExecutableFileType, type ClaudeExecutablePreflightResult } from "./claude-executable.js";
export { __testGetBridgeIntegrityState, __testSetBridgeIntegrityState, INTEGRITY_CUSTOM_TYPE, appendIntegrityEntry, reportToolResultMismatch } from "./bridge-state.js";
export { CONNECTOR_CALL_CUSTOM_TYPE, connectorResultByteSize, flushConnectorCallAudit, recordConnectorCallResult, setConnectorCallAuditSink, type ConnectorCallAuditData, type ConnectorCallAuditSink, type ConnectorCallOutcome } from "./connector-audit.js";
export { CLAUDE_AI_CONNECTOR_TOOL_PATTERNS, connectorMcpServers, connectorDeclarationsDisabled, CLAUDE_BRIDGE_TOOL_ISOLATION, CONNECTOR_DISCOVERY_TOOLS, CONNECTOR_WRITE_TOOLS, DISALLOWED_BUILTIN_TOOLS, connectorBuiltinAllowlistHook, connectorQueryOptions, connectorWriteDenyHook, connectorWriteModeFor, connectorWriteModeFromEnv, connectorsEnabledFor, connectorsEnabledFromEnv, denyAllToolsHook, isAllowlistedConnectorSessionTool, isChildExecutedTool, isChildInternalTool, isConnectorTool, isConnectorWriteTool, settingSourcesForQuery, toolIsolationForQuery } from "./connectors.js";
export { cancelScheduledSessionPersistence, conversationFingerprint, conversationFingerprintsMatch, planIncrementalPromptBatch, restoreSharedSessionFromPi, shouldRestorePersistedBridgeEntry } from "./session-persistence.js";
export { NATIVE_PROVIDER_UNSUPPORTED_MESSAGE, buildNativeProvider, claudeAuthSourceLabel, supportsNativeProvider } from "./native-provider.js";
export { DEFAULT_STREAM_IDLE_TIMEOUT_MS, STREAM_IDLE_BACKOFF_HINT_MS, STREAM_IDLE_TIMEOUT_ENV, buildStreamIdleTimeoutErrorMessage, createStreamIdleWatchdog, streamIdleTimeoutMsFromEnv, type StreamIdleTimeoutInfo, type StreamIdleWatchdog, type StreamIdleWatchdogState } from "./stream-idle-watchdog.js";
export { ALLOWED_RATE_LIMIT_WARNING_UTILIZATION_THRESHOLD, formatAllowedRateLimitWarning, formatResetTimestamp, isUsageLimitMessage, normalizeRateLimitUtilization, resetTimestampMs, uniqueNonEmptyLines } from "./rate-limit.js";
export { isPiDispatchable, mapToolName } from "./tool-mapping.js";
export { cancelScheduledToolUseEnd, endToolUseTurn, finalizeToolUseTurnFromMcpInvocation, noteChildExecutedToolResults, processAssistantMessage, processStreamEvent, reapStaleQueuedResults, scheduleToolUseTurnEnd } from "./assistant-stream.js";
export {
	accountSessionScope,
	claudeDirForProfile,
	classifyClaudeFailure,
	CLAUDE_ACCOUNT_ROUTER_SYMBOL,
	CLAUDE_BRIDGE_ACCOUNT_HOST_SYMBOL,
	commitsVisibleOutput,
	rateLimitResetFromInfo,
	rateLimitResetMs,
	rateLimitTypeFromInfo,
	RetryEventBuffer,
	subscriberProfileEnv,
	type ClaudeAccountFailureKind,
	type ClaudeAccountRoute,
	type ClaudeAccountRouterV1,
	type ClaudeBridgeAccountHostV1,
} from "./account-router.js";

// Compat (#2): use factory if available (pi-ai ≥0.66), else fall back to constructor (gsd-pi etc.)
const _piAi = piAi as any;
const getModels = await resolveGetModels(_piAi) as (provider: string) => Array<Model<any>>;
const newAssistantMessageEventStream: () => AssistantMessageEventStream =
	typeof _piAi.createAssistantMessageEventStream === "function"
		? _piAi.createAssistantMessageEventStream
		: () => new _piAi.AssistantMessageEventStream();

// --- Constants ---

// Two process-global tokens govern provider registration across module reloads.
// Extensions like pi-subagents spawn a subagent that loads THIS module again as
// a fresh (non-primary) instance. Two failure modes must be prevented:
//   (1) a subagent's registerProvider() overwriting the parent's `streamSimple`
//       in the shared ModelRegistry — the parent would then deliver tool results
//       through the subagent's empty-state streamSimple and break tool pairing;
//   (2) a subagent STEALING registration ownership: if the parent loaded
//       uncredentialed and the user logged in mid-session, a later subagent load
//       would see credentialed + no-owner and claim ownership + register ITS
//       streamSimple, split-braining the shared session/ctx.
//
// PRIMARY_INSTANCE_KEY — claimed UNCONDITIONALLY (regardless of credentials) by
// the first-loaded module instance. ONLY the primary instance may ever
// register, unregister, or claim the stream guard. Non-primary instances
// (subagents) always no-op. This is the authority token; it closes (2).
//
// ACTIVE_STREAM_SIMPLE_KEY — holds the registered instance's `streamSimple`.
// Only the primary claims it, and only while a registration is live. It doubles
// as the "already registered" flag (guard === our streamSimple) and the routing
// target for reentrant subagent calls; it closes (1).
//
// Both are released on session_shutdown (incl. /reload) by releaseProviderTokens
// so the next module load starts clean. See applyProviderRegistration for the
// native (pi >=0.81) upsert flow.
const PRIMARY_INSTANCE_KEY = Symbol.for("claude-bridge:primaryInstance");
const ACTIVE_STREAM_SIMPLE_KEY = Symbol.for("claude-bridge:activeStreamSimple");
// Deliberately NOT Symbol.for: rotation state rides options between the retry
// re-entry and the original call within ONE module instance only.
const ROTATION_STATE_KEY = Symbol("claude-bridge:rotationState");

/** Hard cap on account-rotation attempts per request (CHANGELOG 3.0.0). */
const MAX_ROTATION_ATTEMPTS = 16;

interface RotationRequestState {
	excludedProfileIds: Set<string>;
	attempts: number;
	/** Model id already announced via toast for this request, so up to
	 *  MAX_ROTATION_ATTEMPTS don't repeat an identical switch notice. */
	announcedModelId?: string;
}

type BridgeStreamOptions = SimpleStreamOptions & {
	[ROTATION_STATE_KEY]?: RotationRequestState;
};

// MODELS is buildModels(getModels("anthropic")) — projection kept in models.js.
const MODELS = buildModels(getModels("anthropic"));



// Pi doesn't pass tool results directly — it appends them to the context and calls
// the provider again. Thin wrapper over extract-tool-results.js that adds per-turn
// debug logging at the extraction boundary.
function extractAllToolResults(context: Context): McpResult[] {
	const { results, stopIdx } = _extractAllToolResults(context.messages as unknown as Array<{ role: string; [key: string]: unknown }>);
	debug(`extractAllToolResults: ${results.length} results from ${context.messages.length} msgs, stopped at index ${stopIdx}`);
	debug(`extractAllToolResults: all msg roles:`, context.messages.map((m, i) => `[${i}]${m.role}`).join(" "));
	for (let r = 0; r < results.length; r++) {
		debug(`extractAllToolResults: result[${r}] id=${results[r].toolCallId}${results[r].isError ? " ERROR" : ""} preview:`, JSON.stringify(results[r].content).slice(0, 150));
	}
	return results;
}

/** Combine one or more consecutive user messages into a single SDK prompt.
 *
 *  Representation divergence, accepted on purpose: this MERGES N pi user
 *  messages into ONE Claude user record ("\n\n"-joined), while a REBUILD
 *  (convertPiMessages in convert.ts) imports the same pi history as N separate
 *  user records. Streaming N SDKUserMessages instead would collapse N pi turns
 *  into one Pi reply with double-counted usage, so the join stays. The merged
 *  form is only ever a query's live prompt — it is never re-imported, so the
 *  two representations never meet in one session file. */
function extractUserPrompt(messages: Context["messages"]): string | null {
	if (messages.length === 0 || messages.some((message) => message.role !== "user")) return null;
	return messages.map((message) =>
		typeof message.content === "string" ? message.content : messageContentToText(message.content) || "",
	).join("\n\n");
}

/** Combine consecutive user messages as ContentBlockParam[] while preserving images.
 *  Returns null if no images — caller should fall back to the string prompt.
 *  Same N-into-1 merge as extractUserPrompt (see its comment for why). */
function extractUserPromptBlocks(messages: Context["messages"]): ContentBlockParam[] | null {
	if (messages.length === 0 || messages.some((message) => message.role !== "user")) return null;

	let hasImage = false;
	const blocks: ContentBlockParam[] = [];
	for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
		const content = messages[messageIndex].content;
		if (messageIndex > 0) blocks.push({ type: "text", text: "\n\n" });
		if (typeof content === "string") {
			if (content) blocks.push({ type: "text", text: content });
			continue;
		}
		if (!Array.isArray(content)) {
			debug(`extractUserPromptBlocks: content is ${typeof content}`);
			continue;
		}
		debug(`extractUserPromptBlocks: ${content.length} blocks, types=${content.map((b: any) => b.type).join(",")}`);
		for (const block of content) {
			if (block.type === "text" && block.text) {
				blocks.push({ type: "text", text: block.text });
			} else if (block.type === "image") {
				debug(`image block: mimeType=${(block as any).mimeType}, data length=${((block as any).data ?? "").length}, keys=${Object.keys(block).join(",")}`);
				if (!(block as any).data || !(block as any).mimeType) {
					debug(`image block missing data or mimeType, skipping`);
					continue;
				}
				hasImage = true;
				blocks.push({
					type: "image",
					source: { type: "base64", media_type: block.mimeType as Base64ImageSource["media_type"], data: block.data },
				});
			}
		}
	}
	return hasImage ? blocks : null;
}

export interface DeferredUserReplayPlan {
	// Index where the trailing consecutive user run begins (=== messages.length
	// when the context doesn't end in a user message; never below the caller's
	// capturedThrough bound).
	runStart: number;
	userMessageCount: number;
	// All trailing user messages combined into one replay prompt, or null when
	// there is nothing usable to replay (no trailing users, or all-empty text
	// with no image blocks).
	prompt: string | null;
	// Present when the run carries image blocks — the replay must send these
	// (via wrapPromptStream) or the images are silently lost.
	blocks: ContentBlockParam[] | null;
}

/** Plan replay of user messages pi injected mid-query (steer drain, followUp).
 *  Captures the ENTIRE trailing consecutive user run, not just the last
 *  message, but never walks below `capturedThrough`, the position a prior callback
 *  of the SAME query already captured (or deliberately held at, for an
 *  all-empty run). Without that lower bound a second mid-query steer re-planned
 *  the whole run from scratch and the first steer was queued — and delivered to
 *  Claude — twice. */
export function planDeferredUserReplay(messages: Context["messages"], capturedThrough = 0): DeferredUserReplayPlan {
	let runStart = messages.length;
	while (runStart > capturedThrough && messages[runStart - 1]?.role === "user") runStart--;
	const trailingUsers = messages.slice(runStart);
	const prompt = trailingUsers.length > 0 ? extractUserPrompt(trailingUsers) : null;
	const blocks = trailingUsers.length > 0 ? extractUserPromptBlocks(trailingUsers) : null;
	return {
		runStart,
		userMessageCount: trailingUsers.length,
		prompt: prompt?.trim() ? prompt : null,
		blocks,
	};
}

async function* wrapPromptStream(blocks: ContentBlockParam[]): AsyncIterable<SDKUserMessage> {
	yield {
		type: "user",
		message: { role: "user", content: blocks } as MessageParam,
		parent_tool_use_id: null,
	};
}

// --- Provider helpers: tool resolution ---

// --- Provider helpers: tool bridge ---

// --- Query state ---
// QueryContext + context stack live in query-state.js so tests can import
// them without activating the extension. `ctx()`, `pushContext()`, `popContext()`
// are imported at the top of this file.

export function resolveMcpTools(context: Context, excludeToolName?: string): {
	mcpTools: Tool[];
	customToolNameToSdk: Map<string, string>;
	customToolNameToPi: Map<string, string>;
} {
	const mcpTools: Tool[] = [];
	const customToolNameToSdk = new Map<string, string>();
	const customToolNameToPi = new Map<string, string>();

	if (!context.tools) return { mcpTools, customToolNameToSdk, customToolNameToPi };

	for (const tool of context.tools) {
		if (tool.name === excludeToolName) continue;
		// Never re-offer a tool the child owns natively. The claude.ai connector
		// namespace belongs to the child's own MCP servers, so a Pi tool sitting
		// on it would be advertised a SECOND time under our prefix — two names
		// for one capability, and the model picking the wrong one gets a real
		// `Tool... not found` from the dispatcher. It would also
		// be uncallable in any case: a `tool_use` under that namespace is treated
		// as child-executed and never handed to Pi (isChildExecutedTool), so
		// filtering here is what makes the two halves agree end to end.
		if (isChildExecutedTool(tool.name)) {
			debug(`resolveMcpTools: not re-offering child-native tool ${tool.name}`);
			continue;
		}
		const sdkName = `${MCP_TOOL_PREFIX}${tool.name}`;
		mcpTools.push(tool);
		// Case-insensitive aliases mean two tools differing only by case would
		// silently overwrite each other's mapping — surface it if it ever happens.
		const lowerName = tool.name.toLowerCase();
		const collision = customToolNameToSdk.get(lowerName);
		if (collision !== undefined && collision !== sdkName) {
			debug(`WARNING: resolveMcpTools lowercase alias collision: ${tool.name} overwrites mapping previously held by ${collision}`);
		}
		customToolNameToSdk.set(tool.name, sdkName);
		customToolNameToSdk.set(lowerName, sdkName);
		customToolNameToPi.set(sdkName, tool.name);
		customToolNameToPi.set(sdkName.toLowerCase(), tool.name);
	}

	return { mcpTools, customToolNameToSdk, customToolNameToPi };
}

// finalizeToolUseTurnFromMcpInvocation moved to assistant-stream.ts: it is now
// the grace-timer ACTION armed by scheduleToolUseTurnEnd rather than an
// immediate end. The CLI invokes MCP handlers before message_delta arrives on
// every tool-use turn, and message_delta is what carries the real output-token
// count — ending the pi stream at handler invocation is what froze pi's
// per-turn output figures at the message_start placeholders (1–7 tokens).

// Creates an MCP server that bridges pi tools to the SDK. Each tool handler
// blocks on a Promise until pi delivers the tool result via streamSimple.
// Handlers claim their tool_call id by matching the actual MCP call
// (tool name + arguments) against the recorded tool_use blocks, then results
// are matched by ID. Handlers close over the captured `queryCtx`, ensuring they
// operate on the correct query's state even across pushContext/popContext calls.
function buildMcpServers(tools: Tool[], queryCtx: QueryContext): Record<string, ReturnType<typeof createSdkMcpServer>> | undefined {
	if (!tools.length) return undefined;
	const mcpTools = tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		inputSchema: jsonSchemaToZodShape(tool.parameters),
		handler: async (args?: Record<string, unknown>) => {
			const mappedArgs = mapToolArgs(tool.name, args);
			const claim = queryCtx.claimToolCall(tool.name, mappedArgs);
			const toolCallId = claim.toolCallId;
			if (!toolCallId) {
				debug(`WARNING: mcp handler ${tool.name} has no toolCallId (available=${claim.available})`);
				diagDump("tool_handler_unmatched", {
					toolName: tool.name,
					argKeys: argKeys(mappedArgs),
					available: claim.available,
					turnToolCallIds: queryCtx.turnToolCallIds,
					turnToolCalls: safeToolCallSummary(queryCtx.turnToolCalls),
				});
				appendIntegrityEntry("tool_handler_unmatched", {
					toolName: tool.name,
					argKeys: argKeys(mappedArgs),
					available: claim.available,
					turnToolCallIds: queryCtx.turnToolCallIds,
				});
				return { content: [{ type: "text", text: `Claude bridge internal error: no matching tool_call id for ${tool.name}` }], isError: true } satisfies McpResult;
			}
			if (claim.argsMismatch) {
				// Claimed anyway (sole same-name candidate) — record the divergence so
				// a schema/validator drift stays visible without stranding the call.
				debug(`mcp handler: ${tool.name} [${toolCallId}] claimed sole same-name call despite args mismatch`);
				diagDump("tool_claim_args_mismatch", {
					toolName: tool.name,
					toolCallId,
					handlerArgKeys: argKeys(mappedArgs),
					recordedArgKeys: argKeys(queryCtx.turnToolCalls.find((call) => call.id === toolCallId)?.arguments),
				});
			} else if (claim.match !== "tool-args" || claim.ambiguous) {
				debug(`mcp handler: ${tool.name} [${toolCallId}] claimed by ${claim.match}${claim.ambiguous ? " (ambiguous)" : ""}`);
			}
			const earlyResult = toolCallId ? takeQueuedOrParkedResult(queryCtx, toolCallId) : undefined;
			if (earlyResult !== undefined) {
				queryCtx.markToolResultResolved(toolCallId);
				debug(`mcp handler: ${tool.name} [${toolCallId}] → resolved from queue/parked (${queryCtx.pendingResults.size} queued, ${queryCtx.reapedResults.size} parked remaining)`);
				return earlyResult;
			}
			debug(`mcp handler: ${tool.name} [${toolCallId}] → waiting`);
			// Don't end the pi turn here — message_delta (real output tokens) and
			// message_stop are normally milliseconds behind this invocation. Arm the
			// grace timer instead; it force-finalizes only if they never arrive.
			scheduleToolUseTurnEnd(
				queryCtx,
				() => finalizeToolUseTurnFromMcpInvocation(queryCtx, toolCallId, tool.name, mappedArgs),
				`mcp-invocation:${tool.name}`,
			);
			return new Promise<McpResult>((resolve) => {
				queryCtx.pendingToolCalls.set(toolCallId, {
					toolName: tool.name,
					args: mappedArgs,
					generation: queryCtx.callbackGeneration,
					resolve: (result) => {
						queryCtx.markToolResultResolved(toolCallId);
						resolve(result);
					},
				});
			});
		},
	}));
	const server = createSdkMcpServer({ name: MCP_SERVER_NAME, version: "1.0.0", tools: mcpTools });
	return { [MCP_SERVER_NAME]: server };
}


// --- Provider: streaming function ---
//
// Push-based streaming with MCP tool bridge:
// 1. streamSimple starts a query() and kicks off consumeQuery() in background
// 2. consumeQuery() iterates the SDK generator, pushing events to currentPiStream
// 3. On tool_use: ends the current pi stream, nulls it out. The MCP handler
//    blocks the generator naturally — no events arrive until resolved.
// 4. Pi executes the tool and calls streamSimple again. We swap in the replacement
//    stream, resolve the MCP handler, and the generator unblocks into that stream.
//
// Note: resetTurnState clears turnSawStreamEvent while the generator may still
// have queued messages from the previous turn. This is safe because step 3 nulls
// currentPiStream, so any leftover messages hit the `!ctx().currentPiStream` guard
// in consumeQuery and are skipped before resetTurnState runs.


// Claim the primary-instance token for this module instance if unclaimed, and
// report whether this instance is the primary. First-loaded instance wins,
// UNCONDITIONALLY (before any credential check), so a later subagent load can
// never become primary and steal registration ownership.
function claimPrimaryInstance(): boolean {
	const g = globalThis as Record<symbol, any>;
	if (!g[PRIMARY_INSTANCE_KEY]) g[PRIMARY_INSTANCE_KEY] = streamClaudeAgentSdk;
	return g[PRIMARY_INSTANCE_KEY] === streamClaudeAgentSdk;
}

// Release both process-global tokens this instance owns. Called on
// session_shutdown (incl. /reload) so the freshly loaded instance starts clean.
// NOTE: this does NOT unregister the provider — pi's provider registry is
// process-lifetime state that survives module reload; the next loaded instance
// simply upserts its own provider object over ours (registerNativeProvider is
// replace-by-id), and logout-hiding is the provider's own auth check.
function releaseProviderTokens(event: string): void {
	const g = globalThis as Record<symbol, any>;
	if (g[CLAUDE_BRIDGE_ACCOUNT_HOST_SYMBOL] === BRIDGE_ACCOUNT_HOST) {
		g[CLAUDE_BRIDGE_ACCOUNT_HOST_SYMBOL] = undefined;
	}
	if (g[ACTIVE_STREAM_SIMPLE_KEY] === streamClaudeAgentSdk) {
		debug(`${event}: clearing ACTIVE_STREAM_SIMPLE_KEY`);
		g[ACTIVE_STREAM_SIMPLE_KEY] = undefined;
	}
	if (g[PRIMARY_INSTANCE_KEY] === streamClaudeAgentSdk) {
		debug(`${event}: clearing PRIMARY_INSTANCE_KEY`);
		g[PRIMARY_INSTANCE_KEY] = undefined;
	}
}

// Native (pi >=0.81) provider registration. Run at extension load, on every
// session_start, and at pre-spawn.
//
// 2.x registers UNCONDITIONALLY (once primary): credential-driven availability
// is the provider's own auth.check/resolve reporting configured-ness, so pi
// hides/shows claude-bridge models itself — the 1.x register/unregister state
// machine (decideRegistration) is gone. What each trigger does now:
//   - load: build + register the provider (queued by the loader until bindCore).
//   - session_start: re-upsert the SAME provider object. registerNativeProvider
//     is upsert-by-id and kicks pi's model-snapshot/availability refresh, so a
//     `claude login`/logout since the last session boundary is reflected
//     deterministically — the same guarantee the 1.x re-check gave — without
//     depending on pi's own refresh cadence.
//   - pre-spawn: same re-upsert, from the fail-fast path, so a mid-session
//     logout also flips availability at first use.
// Non-primary instances (subagents) never touch registration: pi's native
// registry REPLACES by id, so an unguarded subagent re-register would swap in
// its own streamSimple — the exact split-brain the tokens exist to prevent.
// On a pre-0.81 host the extension declines loudly (once) instead of
// registering wrongly through the legacy overload.
let nativeProviderInstance: unknown;
let notifiedNativeUnsupported = false;

function applyProviderRegistration(trigger: string): void {
	const pi = extensionApi;
	if (!pi) { debug(`${trigger}: applyProviderRegistration skipped — no extensionApi`); return; }
	const g = globalThis as Record<symbol, any>;
	const isPrimary = claimPrimaryInstance();
	if (!isPrimary) {
		debug(`${trigger}: registration noop — non-primary instance (module=${moduleInstanceId})`);
		return;
	}
	if (!supportsNativeProvider(_piAi)) {
		debug(`${trigger}: host pi-ai lacks createProvider; refusing to register (module=${moduleInstanceId})`);
		if (!notifiedNativeUnsupported) {
			notifiedNativeUnsupported = true;
			safeNotify(NATIVE_PROVIDER_UNSUPPORTED_MESSAGE, "error");
		}
		return;
	}
	const credentialed = hasClaudeCredentials() || Boolean(resolveClaudeAccountRouter());
	debug(`${trigger}: native registration upsert, credentialed=${credentialed} (module=${moduleInstanceId})`);
	// Start the connector inventory now, not on the first turn: the query path
	// can only read a synchronous snapshot, so priming here is what gets the
	// declarations in place before turn 1. Fire and forget —
	// registration must not wait on the network. Primes the DEFAULT credential
	// scope only; managed profiles are primed per request in their own scope.
	if (hasClaudeCredentials() && connectorsEnabledFor(loadConfig(process.cwd()))) primeConnectorServers();
	// Claim ordering: stream guard BEFORE registerProvider so a concurrent
	// subagent can never observe a registered provider without an owner.
	g[ACTIVE_STREAM_SIMPLE_KEY] = streamClaudeAgentSdk;
	try {
		nativeProviderInstance ??= buildNativeProvider(
			_piAi,
			MODELS,
			streamClaudeAgentSdk as (...args: unknown[]) => unknown,
			process.env,
			// Availability includes a companion account pool: the router owns
			// credentials the direct existence probes cannot see.
			() => hasClaudeCredentials() || Boolean(resolveClaudeAccountRouter()),
		);
		(pi.registerProvider as (provider: unknown) => void)(nativeProviderInstance);
	} catch (err) {
		// Self-heal: release ONLY the stream guard we just claimed so a later
		// re-check retries cleanly. Keep PRIMARY_INSTANCE_KEY: releasing it would
		// reopen the subagent ownership-steal window.
		if (g[ACTIVE_STREAM_SIMPLE_KEY] === streamClaudeAgentSdk) g[ACTIVE_STREAM_SIMPLE_KEY] = undefined;
		debug(`${trigger}: registerProvider threw; released stream guard for retry (kept primary):`, err);
	}
}

/** Provider entry point. Pi calls this for each prompt and each tool result.
 *  Two cases: tool result delivery (active query) or fresh query. Exported for
 *  the rotation-stream unit tests, which drive it with a fake SDK factory. */
export function streamClaudeAgentSdk(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	return runInRequestLane(options?.sessionId, () => streamClaudeAgentSdkInLane(model, context, options));
}

function streamClaudeAgentSdkInLane(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = newAssistantMessageEventStream();
	// The lane this request runs in, for callbacks that fire OUTSIDE it: an
	// AbortSignal listener runs in the aborter's async context, not ours.
	const laneId = currentRequestLaneId();
	// Pi marks its compaction and branch-summary one-shots with cacheRetention
	// "none" and a fresh sessionId per call; no session_shutdown ever prunes
	// those lanes. Map the hint onto lane lifetime: nothing about this request
	// is retained once it settles.
	const ephemeralLane = laneId !== undefined && options?.cacheRetention === "none";
	const releaseEphemeralLane = (): void => {
		if (!ephemeralLane) return;
		deleteSharedSessionLane(laneId);
		deleteQueryLane(laneId);
	};

	// DEBUG: trace followUp message triggering
	const lastMsgRole = context.messages[context.messages.length - 1]?.role;
	const cwd = (options as { cwd?: string } | undefined)?.cwd ?? process.cwd();
	debug(`provider: streamClaudeAgentSdk called, activeQuery=${!!ctx().activeQuery}, lastMsgRole=${lastMsgRole}, isReentrant=${ctx().activeQuery !== null}`);

	// --- Tool result delivery ---
	// Pi appends tool results to context and calls back. Extract this turn's results
	// (everything after the last assistant message) and match against waiting MCP
	// handlers. Results that arrive before their handler get queued in pendingResults.
	if (ctx().activeQuery) {
		const queryCtx = ctx();
		queryCtx.currentPiStream = stream;
		queryCtx.resetTurnState(model);
		// A fresh callback separates handlers registered for settled turns from
		// ones racing this callback's own stream — the stranded drain below only
		// ever touches the former.
		queryCtx.callbackGeneration += 1;
		activeStreamIdleWatchdogs.get(queryCtx)?.refresh();
		const allResults = extractAllToolResults(context);
		debug(`provider: tool results, ${allResults.length} results, ${queryCtx.pendingToolCalls.size} waiting handlers, ctx.msgs=${context.messages.length}`);
		const unmatchedResultIds: string[] = [];
		for (const result of allResults) {
			const id = result.toolCallId;
			if (id && !queryCtx.hasRecordedToolCall(id) && !queryCtx.forwardedToolCallIds.has(id)) {
				// A forwarded id is always legitimate even after the per-message
				// records reset — Pi only answers calls it was handed (steer-split
				// results land here after a boundary wiped the turn records).
				queryCtx.markToolResultUnmatched(id);
				unmatchedResultIds.push(id);
				debug(`ERROR: tool result [${id}] has no registered tool_call id; refusing to queue or deliver`);
				continue;
			}
			queryCtx.markToolResultDelivered(id);
			if (id && queryCtx.pendingToolCalls.has(id)) {
				const pending = queryCtx.pendingToolCalls.get(id)!;
				queryCtx.pendingToolCalls.delete(id);
				debug(`provider: resolving ${pending.toolName} [${id}]${result.isError ? " (error)" : ""}`, JSON.stringify(result.content).slice(0, 200));
				pending.resolve(result);
			} else if (id) {
				queryCtx.pendingResults.set(id, result);
				debug(`provider: queued result [${id}] (${queryCtx.pendingResults.size} pending)`);
			} else {
				debug(`WARNING: tool result without toolCallId, cannot match`);
			}
			if (queryCtx.pendingToolCalls.size > 0 && queryCtx.pendingResults.size > 0) {
				// Legitimate under staggered SDK invocation (a waiting steer-split
				// handler while a sibling's result queues) — informational only.
				debug(`note: handlers and queued results coexist: handlers=${queryCtx.pendingToolCalls.size} results=${queryCtx.pendingResults.size}`);
			}
		}
		if (unmatchedResultIds.length > 0) {
			const errorResult: McpResult = {
				content: [{ type: "text", text: `Claude bridge internal error: ${unmatchedResultIds.length} tool result(s) did not match any registered tool_call id. The turn was stopped to avoid delivering tool output to the wrong call. Unmatched ids: ${unmatchedResultIds.slice(0, 8).join(", ")}${unmatchedResultIds.length > 8 ? ", ..." : ""}` }],
				isError: true,
			};
			for (const [pendingId, pending] of queryCtx.pendingToolCalls) {
				// The model is told these calls were stopped; an unforwarded one must
				// never be dispatched by a later replay behind that message’s back.
				if (!queryCtx.forwardedToolCallIds.has(pendingId)) queryCtx.deadToolCallIds.add(pendingId);
				pending.resolve(errorResult);
			}
			queryCtx.pendingToolCalls.clear();
			reportToolResultMismatch(queryCtx, "unmatched tool result", cwd);
		}
		if (queryCtx.pendingToolCalls.size > 0) {
			// A waiting handler whose call never reached Pi can never be answered —
			// fail it now with a retryable error instead of letting the SDK await it
			// indefinitely.
			// Forwarded-but-unanswered handlers stay: steer-split batches legitimately
			// deliver their results in a later callback.
			const stranded = drainStrandedToolCalls(queryCtx);
			if (stranded.length > 0) {
				const names = stranded.map((entry) => entry.toolName).join(", ");
				debug(`provider: failed ${stranded.length} stranded MCP handler(s) never forwarded to Pi: ${names}`);
				diagDump("tool_handlers_stranded", { count: stranded.length, stranded });
				appendIntegrityEntry("tool_handlers_stranded", { count: stranded.length, stranded });
				safeNotify(`Claude bridge: failed ${stranded.length} tool call(s) that never reached Pi before their turn ended (${names}). The model saw a retryable error.`, "warning");
			}
			if (queryCtx.pendingToolCalls.size > 0) {
				debug(`WARNING: ${queryCtx.pendingToolCalls.size} MCP handlers still waiting after delivering ${allResults.length} results`);
				safeNotify(`Claude bridge: ${queryCtx.pendingToolCalls.size} tool handler(s) still waiting — provider may be stuck`, "warning");
			}
		}

		// Detect user messages (steer/followUp) that pi injected into context
		// during the active query. This happens when:
		//   - User sends a steer while a tool is executing; pi drains the steer
		//     queue at the turn boundary and appends it to context alongside the
		//     tool result, then calls the provider again.
		//   - A followUp is delivered between tool-result turns.
		// The bridge can't forward these mid-query (the SDK query is in progress),
		// so we save them for replay as continuation queries after consumeQuery ends.
		// The cursor may only advance over messages actually captured for replay:
		// claiming Claude owns a user message that was never deferred is permanent
		// silent input loss ( — only the LAST of several trailing user
		// messages was captured while the cursor skipped them all).
		let capturedThrough = context.messages.length;
		if (lastMsgRole === "user") {
			// Bound the plan at this query's own captured position (latestCursor
			// Math.max-advances with every callback's capturedThrough below), so a
			// second steer callback only queues messages BEYOND what the first one
			// already owns — re-planning the whole trailing run queued the earlier
			// steer twice. latestCursor, not the shared record's
			// cursor, deliberately: it lives on this QueryContext, so it is correct
			// for reentrant and detached foreign queries too, whose contexts the
			// shared cursor does not index.
			const replay = planDeferredUserReplay(context.messages, queryCtx.latestCursor);
			// Image-only runs have no usable text but must still replay — capture
			// whenever EITHER form has content.
			if (replay.prompt || replay.blocks) {
				ctx().deferredUserMessages.push({ text: replay.prompt ?? "", blocks: replay.blocks ?? undefined });
				debug(`provider: deferred ${replay.userMessageCount} user message(s) for replay after query${replay.blocks ? ` (${replay.blocks.length} blocks incl. images)` : ""}: ${(replay.prompt ?? "[image-only]").slice(0, 60)}`);
			} else {
				capturedThrough = replay.runStart;
				diagDump("deferred_user_replay_skipped", {
					contextLength: context.messages.length,
					runStart: replay.runStart,
					userMessageCount: replay.userMessageCount,
					messageRoles: context.messages.map((m, i) => `[${i}]${m.role}`).join(" "),
				});
			}
		}

		// Cursor may only ADVANCE, and only for a query that holds the record's
		// claim. A reentrant subagent call routed through this instance arrives
		// here with a SHORT foreign context (its own [user…] conversation, not
		// the one the cursor indexes). Writing its length would shrink the
		// parent cursor and make the next REUSE replay already-owned history.
		// The stackDepth guard covers a pushed subagent context; the detached
		// flag covers a foreign one-shot on the top-level ctx, whose GROWN
		// mid-query context could otherwise out-length the parent's cursor and
		// advance it past history Claude never saw; Math.max
		// remains the backstop for a legacy-record foreign context the
		// fingerprint guard could not classify.
		const activeSession = getSharedSession();
		if (activeSession && stackDepth() === 0 && !queryCtx.detachedFromSharedSession) {
			setSharedSession({ ...activeSession, cursor: Math.max(activeSession.cursor, capturedThrough) });
		}
		queryCtx.latestCursor = Math.max(queryCtx.latestCursor, capturedThrough);
		return stream;
	}

	// --- Orphaned tool result (e.g. user aborted a tool call) ---
	// The query is gone but pi still delivered the result. Nothing to do — just
	// emit end_turn so pi waits for the next real user message.
	const lastMsg = context.messages[context.messages.length - 1];
	if (lastMsg?.role === "toolResult") {
		debug(`provider: orphaned tool result after abort, emitting end_turn`);
		// The detached flag deliberately survives query end: an orphaned result
		// from a foreign one-shot indexes ITS conversation, and writing that
		// length here would move (even shrink) the parent's cursor.
		const activeSession = getSharedSession();
		if (activeSession && stackDepth() === 0 && !ctx().detachedFromSharedSession) setSharedSession({ ...activeSession, cursor: context.messages.length });
		const c = ctx();  // capture current context for the microtask
		queueMicrotask(() => {
			c.resetTurnState(model);
			stream.push({ type: "done", reason: "stop", message: c.turnOutput });
			stream.end();
			releaseEphemeralLane();
		});
		return stream;
	}

	// --- Fresh query ---

	// Fail-fast credential re-check (only for a fresh query — NEVER for
	// tool-result delivery of an in-flight query, handled above, where creds were
	// valid at start and failing mid-turn would break tool pairing). This bounds
	// the logout-visibility window from "next session boundary" to "first use":
	// if neither a direct Claude login nor a companion account pool exists,
	// (a) re-upsert the provider (primary-only) so pi's availability recompute
	// hides the models, and (b) fail this request with a clear, actionable
	// message instead of letting the SDK spawn die with a generic error. The
	// check is cheap (existsSync + env reads only, no credential contents).
	if (!hasClaudeCredentials() && !resolveClaudeAccountRouter()) {
		try { applyProviderRegistration("pre-spawn"); } catch { /* best effort */ }
		const message = "Claude account not connected — connect an account (or run `claude login`) and retry.";
		debug(`provider: pre-spawn credential check failed; failing fast: ${message}`);
		const errorOutput: AssistantMessage = {
			role: "assistant", content: [],
			api: model.api, provider: model.provider, model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "error", timestamp: Date.now(),
			errorMessage: message,
		};
		queueMicrotask(() => {
			stream.push({ type: "error", reason: "error", error: errorOutput });
			stream.end();
			releaseEphemeralLane();
		});
		return stream;
	}

	// 1. Determine reentrancy and push parent context if needed.
	const isReentrant = ctx().activeQuery !== null;
	if (isReentrant) pushContext();
	debug(`provider: fresh query setup, isReentrant=${isReentrant}, stackDepth=${stackDepth()}`);

	// 2. Fresh child context — constructor already gave us clean Maps and empty
	//    arrays. For a reused top-level context, clear explicitly.
	ctx().currentPiStream = stream;
	ctx().pendingToolCalls.clear();
	ctx().pendingResults.clear();
	ctx().reapedResults.clear();
	ctx().forwardedToolCallIds.clear();
	ctx().deadToolCallIds.clear();
	ctx().callbackGeneration = 0;
	ctx().deferredUserMessages = [];
	ctx().resetTurnState(model);
	ctx().resetToolTracking();
	ctx().latestCursor = 0;
	ctx().committedOutput = false;
	// A reentrant query never claims the shared record; a foreign-conversation
	// one-shot joins it below once syncSharedSession has ruled.
	ctx().detachedFromSharedSession = isReentrant;

	// --- Account routing (optional) ---
	// A companion router selects the subscription profile for this attempt.
	// Rotation state rides the options object so a retry re-entry excludes the
	// profiles that already failed this request.
	const router = resolveClaudeAccountRouter();
	const rotationOptions = options as BridgeStreamOptions | undefined;
	const rotationState: RotationRequestState = rotationOptions?.[ROTATION_STATE_KEY] ?? {
		excludedProfileIds: new Set<string>(),
		attempts: 0,
	};
	let account: ClaudeAccountRoute | undefined;
	if (router) {
		try {
			account = router.acquire({
				modelId: model.id,
				sessionId: options?.sessionId,
				excludedProfileIds: [...rotationState.excludedProfileIds],
				forceRerank: rotationState.attempts > 0,
				reason: rotationState.attempts > 0 ? "automatic-failover" : undefined,
			});
			rotationState.attempts += 1;
		} catch (error) {
			// No profile is available (all cooling down / none configured). Fail
			// the request before spawning anything, carrying the router's reset
			// hint so pi-qol can schedule an auto-resume.
			const message = error instanceof Error ? error.message : String(error);
			const resetAtMs = Number((error as { resetAtMs?: unknown })?.resetAtMs);
			const rateLimitType = (error as { rateLimitType?: unknown })?.rateLimitType;
			if (ctx().turnOutput) {
				ctx().turnOutput.stopReason = "error";
				ctx().turnOutput.errorMessage = message;
				if (Number.isFinite(resetAtMs)) {
					Object.assign(ctx().turnOutput as AssistantMessage & Record<string, unknown>, { resetAtMs, rateLimitType });
				}
			}
			if (Number.isFinite(resetAtMs)) {
				emitRateLimitEvent({
					model: model.id,
					provider: model.provider,
					rateLimitType: rateLimitType ?? "all_accounts",
					reason: message,
					resetAt: new Date(resetAtMs).toISOString(),
					resetAtMs,
					source: "claude-bridge",
					status: "rejected",
				});
			}
			const errorOutput = ctx().turnOutput!;
			if (isReentrant) popContext();
			queueMicrotask(() => {
				stream.push({ type: "error", reason: "error", error: errorOutput });
				stream.end();
				releaseEphemeralLane();
			});
			return stream;
		}
	}
	const queryModel = account?.modelId && account.modelId !== model.id
		? { ...model, id: account.modelId, name: modelDisplayName(account.modelId) }
		: model;
	if (queryModel.id !== model.id) {
		// Stamp the output model on EVERY attempt (each retry resets turn state),
		// but toast each distinct model at most once per request: with up to 16
		// rotation attempts, every retry re-enters this block and would otherwise
		// repeat an identical switch notice. A DIFFERENT model first selected
		// mid-rotation still announces itself.
		updateTurnOutputModel(queryModel.id);
		if (rotationState.announcedModelId !== queryModel.id) {
			rotationState.announcedModelId = queryModel.id;
			safeNotify(
				account?.fallbackReason === "fable-quota"
					? `Every ready account rejected Claude Fable; using ${modelDisplayName(queryModel.id)}.`
					: `Pi Claude switched to ${modelDisplayName(queryModel.id)}.`,
				"info",
			);
		}
	}
	// Buffer protocol setup events until the first visible output so a failed
	// pre-output attempt can be retried on another profile without leaking a
	// duplicate `start` frame into Pi. The query context is captured ONCE here:
	// commit can fire while a reentrant subagent context is pushed, and stamping
	// the live ctx() then would mark the WRONG query as committed and leave this
	// one replayable after visible output.
	const attemptCtx = ctx();
	const attemptBuffer = account
		? new RetryEventBuffer(stream, () => attemptCtx.markOutputCommitted())
		: undefined;
	if (attemptBuffer) attemptCtx.currentPiStream = attemptBuffer as unknown as AssistantMessageEventStream;

	const { mcpTools, customToolNameToSdk, customToolNameToPi } = resolveMcpTools(context);

	// Config + executable preflight run BEFORE syncSharedSession on purpose: the
	// sync's REBUILD path is destructive (deleteSession + createSession + save),
	// so a misconfigured executable must fail this query while the previous
	// session file is still intact.
	const bridgeConfig = loadConfig(cwd);
	const providerSettings = bridgeConfig.provider ?? {};
	const claudeExecutable = resolveClaudeExecutable(providerSettings.pathToClaudeCodeExecutable);
	const claudeExecutablePreflight = claudeExecutable ? preflightClaudeExecutable(claudeExecutable, cwd) : undefined;

	const accountScope = accountSessionScope(account);
	const cursorBeforeSync = getSharedSession()?.cursor ?? null;
	// A REENTRANT (subagent) query never touches the module-level shared
	// session: syncSharedSession's REBUILD path is destructive to the PARENT's
	// session file, and any resume id borrowed from the parent would splice the
	// subagent's turn into the parent's conversation of record. It runs as a
	// clean one-shot instead (Case-1 semantics — no resume, prompt is the
	// trailing message; the child session id lives in the QueryContext only).
	const syncResult = isReentrant
		? { sessionId: null, promptStart: context.messages.length - 1 }
		: syncSharedSession(context.messages, cwd, customToolNameToSdk, queryModel.id, accountScope);
	const { sessionId: resumeSessionId, promptStart } = syncResult;
	// A FOREIGN-conversation query (conversation-fingerprint mismatch against
	// the shared record — a subagent-shaped request arriving while the parent
	// is IDLE,) also runs as a clean one-shot and gets the same
	// hands-off treatment as a reentrant one below: never persist over the
	// module-level record, never mark it for rebuild. The flag also rides the
	// QueryContext so the mismatch/abort/teardown paths that mutate the record
	// OUTSIDE this closure (reportToolResultMismatch, the cursor advances in
	// the delivery paths above) observe the same non-claim.
	const foreignContext = syncResult.foreignContext === true;
	if (foreignContext) ctx().detachedFromSharedSession = true;
	// Identity anchor stamped onto every record this outermost query persists,
	// so the record created by a Case-1 clean start is protected from the very
	// next idle-window foreign query.
	const conversationFp = isReentrant || foreignContext ? undefined : conversationFingerprint(context.messages);
	const promptMessages = context.messages.slice(promptStart);
	const promptBlocks = extractUserPromptBlocks(promptMessages);
	let promptText = extractUserPrompt(promptMessages) ?? "";

	// Guard: a prompt with no usable content means the last context message
	// isn't a user message (or the batch was all-empty — joined batches turn ""
	// into "\n\n", so test the trimmed text, not truthiness). Should never
	// happen with the state stack fix — dump diagnostics if it does.
	if (!promptText.trim() && !promptBlocks) {
		diagDump("empty_prompt", {
			contextLength: context.messages.length,
			lastMsgRole: lastMsg?.role,
			isReentrant,
			stackDepth: stackDepth(),
			activeQueryExists: ctx().activeQuery !== null,
			cursorBeforeSync,
			promptStart,
			promptRoles: promptMessages.map((m) => m.role).join(" "),
			sharedSession: (() => {
				const activeSession = getSharedSession();
				return activeSession ? { sessionId: activeSession.sessionId.slice(0, 8), cursor: activeSession.cursor } : null;
			})(),
			messageRoles: context.messages.map((m, i) => `[${i}]${m.role}`).join(" "),
		});
		// Recover: use a continuation prompt so the SDK doesn't send an empty text block
		promptText = "[continue]";
	}

	const prompt: string | AsyncIterable<SDKUserMessage> = promptBlocks
		? wrapPromptStream(promptBlocks)
		: promptText;
	const mcpServers = buildMcpServers(mcpTools, ctx());
	// Pure SDK query-option assembly — see buildClaudeQueryOptions for the
	// connector, system-prompt, setting-source, effort, and env rationale.
	const built = buildClaudeQueryOptions({
		cwd,
		requestedModel: model,
		queryModel,
		account,
		bridgeConfig,
		systemPrompt: context.systemPrompt,
		reasoning: options?.reasoning,
		resumeSessionId,
		mcpServers,
		claudeExecutable,
	});
	const { queryOptions } = built;

	debug("provider: fresh query",
		`model=${queryModel.id} requested=${model.id} msgs=${context.messages.length} tools=${mcpTools.length}`,
		`resume=${resumeSessionId?.slice(0, 8) ?? "none"} effort=${built.effort ?? "default"} account=${account?.label ?? "legacy"}`,
		`fallback=${built.fallbackModel ?? "none"}`,
		`systemPrompt=pi strictMcp=true fastMode=${providerSettings.fastMode === true} connectors=${built.enableCloudMcp}`,
		`claudeExec=${claudeExecutablePreflight ? `${claudeExecutablePreflight.fileType}:${claudeExecutablePreflight.path}` : "sdk-default"}`,
		`prompt=${promptText.slice(0, 60)}${promptBlocks ? " [+images]" : ""}`);

	// 3. Start SDK query and claim it for this context
	let wasAborted = false;
	let streamIdleTimedOut = false;
	let retryRequested = false;
	let retryFailure: ClaudeAttemptFailure | undefined;
	const sdkQuery = sdkQueryFactory({ prompt, options: queryOptions });
	ctx().activeQuery = sdkQuery;

	// 4. Capture context for abort handling (must be AFTER pushContext)
	const abortCtx = ctx();
	// Failure metadata from consumeQuery survives an iterator throw. The catch
	// below reuses it instead of re-classifying it; see the C5 note.
	const attemptFailure: { failure?: ClaudeAttemptFailure } = {};
	// A reentrant (subagent) query must never write the module-level shared
	// session: its completion/failure handlers would overwrite the PARENT's
	// record with the child's session id and cursor. A foreign-conversation
	// one-shot has exactly the same non-claim on the record.
	const persistSession = (next: SessionState | null): void => {
		if (isReentrant || foreignContext) return;
		setSharedSession(next && conversationFp ? { conversationFingerprint: conversationFp, ...next } : next);
	};
	const markRebuildForThisQuery = (opts: { forceRotate?: boolean } = {}): void => {
		if (isReentrant || foreignContext) return;
		markSessionForRebuild(opts);
	};
	//  invariant: a deferred (mid-query) user message may be dropped only
	// LOUDLY — the cursor already advanced over it on the promise of replay.
	// Callers that keep a session record after a non-empty drop must persist it
	// with needsRebuild so the next turn re-imports the steers from Pi history.
	const dropDeferredUserMessages = (site: string, undelivered?: DeferredUserMessage): DeferredUserMessage[] => {
		const dropped = [...(undelivered !== undefined ? [undelivered] : []), ...abortCtx.deferredUserMessages];
		abortCtx.deferredUserMessages = [];
		if (dropped.length > 0) {
			diagDump("deferred_user_messages_dropped", summarizeDroppedUserMessages(site, dropped));
		}
		return dropped;
	};
	let accountFailureRecorded = false;
	const recordAttemptFailure = (failure: ClaudeAttemptFailure): void => {
		// Rate-limit failures carry rateLimitInfo and were already recorded via
		// router.recordRateLimit in consumeQuery.
		if (
			accountFailureRecorded || !account || !router || !failure.kind ||
			failure.rateLimitInfo || wasAborted || options?.signal?.aborted
		) return;
		safeRouterCall("recordFailure", () => router.recordFailure(account.profileId, failure.kind!, queryModel.id));
		accountFailureRecorded = true;
	};

	const requestAbort = () => {
		// interrupt() asks the CLI to stop gracefully; close() kills it immediately.
		// Both are needed — interrupt alone lets the current API call finish.
		void sdkQuery.interrupt().catch(() => {});
		try { sdkQuery.close(); } catch {}
	};

	// Decide whether a classified failure may be replayed on the next profile.
	// Records the failure with the router either way (a post-output failure is
	// not replayable but the next prompt's routing should still avoid the
	// unhealthy account). The buffer's own committed flag backs up the context
	// flag in case the two ever disagree. Shared by the stream-idle watchdog and
	// the completion/error handlers below.
	const requestRotation = (failure: ClaudeAttemptFailure): boolean => {
		recordAttemptFailure(failure);
		const committed = abortCtx.committedOutput || attemptBuffer?.hasCommittedOutput === true;
		// Rotation retries re-enter streamClaudeAgentSdk from the outer promise
		// chain — an outermost-only path. A reentrant (subagent) query that fails
		// just fails; it must never queue a retry or burn a profile exclusion.
		const eligible = Boolean(!isReentrant && account && router && failure.kind && !committed && !wasAborted && !options?.signal?.aborted && rotationState.attempts < MAX_ROTATION_ATTEMPTS);
		debug("provider: account rotation decision", JSON.stringify({
			eligible,
			account: account?.label,
			kind: failure.kind,
			committedOutput: committed,
			wasAborted,
			signalAborted: options?.signal?.aborted === true,
			attempts: rotationState.attempts,
		}));
		if (!eligible || !account || !router || !failure.kind) return false;
		rotationState.excludedProfileIds.add(account.profileId);
		retryRequested = true;
		retryFailure = failure;
		attemptBuffer?.discard();
		abortCtx.currentPiStream = null;
		debug(`provider: rotating account after ${failure.kind}, from=${account.label}, attempt=${rotationState.attempts}`);
		return true;
	};

	const streamIdleTimeoutMs = streamIdleTimeoutMsFromEnv();
	const streamIdleWatchdog = streamIdleTimeoutMs > 0
		? createStreamIdleWatchdog({
			getState: () => ({
				activeQuery: abortCtx.activeQuery,
				currentPiStream: abortCtx.currentPiStream,
				turnOutput: abortCtx.turnOutput,
				turnSawStreamEvent: abortCtx.turnSawStreamEvent,
				turnStarted: abortCtx.turnStarted,
			}),
			onTimeout: ({ idleMs, timeoutMs }) => {
				if (streamIdleTimedOut || wasAborted || options?.signal?.aborted || abortCtx.activeQuery !== sdkQuery) return;
				streamIdleTimedOut = true;
				dropDeferredUserMessages("stream-idle-timeout");
				markRebuildForThisQuery({ forceRotate: true });
				const errorMessage = buildStreamIdleTimeoutErrorMessage(timeoutMs);
				debug("provider: stream idle timeout", `model=${queryModel.id}`, `timeout=${timeoutMs}`, `idle=${idleMs}`);
				const idleFailure: ClaudeAttemptFailure = { kind: "network", message: errorMessage };
				// A managed attempt that went idle before ANY visible output can move
				// to the next profile instead of surfacing the timeout. The idle
				// specifics (needsRebuild/forceRotate, killing the child) stay here;
				// eligibility and retry bookkeeping are requestRotation's.
				if (requestRotation(idleFailure)) {
					requestAbort();
					return;
				}
				abortCtx.handledTerminalError = true;
				emitRateLimitEvent({
					idleMs,
					model: queryModel.id,
					provider: queryModel.provider,
					rateLimitType: "stream_idle",
					reason: "Claude Code stream idle timeout",
					retryAfterMs: STREAM_IDLE_BACKOFF_HINT_MS,
					source: "claude-bridge",
					status: "rejected",
					timeoutMs,
				});
				safeNotify(`${RATE_LIMIT_TOKEN} Claude stream idle timeout after ${formatDurationShort(timeoutMs)} — retrying via rate-limit backoff`, "warning");
				if (abortCtx.turnOutput) {
					abortCtx.turnOutput.stopReason = "error";
					abortCtx.turnOutput.errorMessage = errorMessage;
					Object.assign(abortCtx.turnOutput as AssistantMessage & Record<string, unknown>, {
						rateLimitType: "stream_idle",
						retryAfterMs: STREAM_IDLE_BACKOFF_HINT_MS,
						streamIdleTimeoutMs: timeoutMs,
					});
				}
				abortCtx.currentPiStream?.push({ type: "error", reason: "error", error: abortCtx.turnOutput! });
				abortCtx.currentPiStream?.end();
				abortCtx.currentPiStream = null;
				requestAbort();
			},
			timeoutMs: streamIdleTimeoutMs,
		})
		: null;
	if (streamIdleWatchdog) {
		activeStreamIdleWatchdogs.set(abortCtx, streamIdleWatchdog);
		streamIdleWatchdog.refresh();
	}
	// Runs in the ABORTER's async context (AbortSignal listeners do not inherit
	// AsyncLocalStorage), so re-enter this request's lane explicitly: the
	// mismatch report marks the shared record of whatever lane is current.
	const onAbort = () => runInRequestLane(laneId, () => {
		wasAborted = true;
		// Prevent stale deferred messages from being replayed by parent on pop
		dropDeferredUserMessages("abort");
		reportToolResultMismatch(abortCtx, "abort", cwd, {
			expectedInterruption: true,
			forceRotate: true,
		});
		const drained = drainPendingToolCalls(abortCtx, "abort");
		if (drained > 0) debug(`provider: abort drained ${drained} waiting MCP handler(s) as errors`);
		abortCtx.pendingResults.clear();
		requestAbort();
	});
	if (options?.signal) {
		if (options.signal.aborted) onAbort();
		else options.signal.addEventListener("abort", onAbort, { once: true });
	}

	const surfaceFailure = (failure: ClaudeAttemptFailure, aborted = false): void => {
		attemptBuffer?.commit();
		if (failure.rateLimitInfo) {
			// Managed rate-limit that will NOT rotate — this is the single place its
			// event + toast are emitted (the legacy path emitted inline instead).
			const info = failure.rateLimitInfo;
			const resetAt = rateLimitResetFromInfo(info);
			const resetAtMs = rateLimitResetMs(info);
			emitRateLimitEvent({
				model: queryModel.id, provider: queryModel.provider, rateLimitType: rateLimitTypeFromInfo(info),
				reason: failure.message, resetAt,
				...(Number.isFinite(resetAtMs) ? { resetAtMs } : {}),
				source: "claude-bridge", status: "rejected",
			});
			safeNotify(`${RATE_LIMIT_TOKEN} Claude ${failure.message} — resets ${formatResetTimestamp(resetAtMs ?? resetAt)}`, "warning");
		}
		if (abortCtx.turnOutput) {
			abortCtx.turnOutput.stopReason = aborted ? "aborted" : "error";
			abortCtx.turnOutput.errorMessage = failure.message;
		}
		abortCtx.currentPiStream?.push({ type: "error", reason: aborted ? "aborted" : "error", error: abortCtx.turnOutput! });
		abortCtx.currentPiStream?.end();
		abortCtx.currentPiStream = null;
	};

	// Background consumer — runs until this attempt's query ends. Before any
	// visible output, a classified failure on a managed attempt is replayed once
	// on each remaining profile; after output/connector dispatch, replay is
	// forbidden and the failure surfaces.
	// The handlers below use the CAPTURED abortCtx, never the live ctx(): the two
	// only differ while a reentrant (subagent) context is pushed, and a parent
	// query CAN end in that window (abort, child process death throwing out of
	// the generator). Live-ctx handlers there mutated the subagent's turn state
	// and stream and skipped the parent's own teardown entirely.
	consumeQuery(sdkQuery, abortCtx, customToolNameToPi, queryModel, bridgeConfig, () => wasAborted, account, router, attemptFailure)
		.then(async ({ capturedSessionId, failure }) => {
			debug(`provider: consumeQuery completed, stopReason=${abortCtx.turnOutput?.stopReason}, failure=${failure?.kind ?? "none"}, aborted=${wasAborted}`);
			if (streamIdleTimedOut) {
				dropDeferredUserMessages("stream-idle-timeout-completion");
				debug(`provider: stream idle timeout ${retryRequested ? "queued account rotation" : "already surfaced"}; skipping normal completion`);
				return;
			}

			// --- Abort detection in normal completion path ---
			if (wasAborted || options?.signal?.aborted) {
				markRebuildForThisQuery({ forceRotate: true });
				dropDeferredUserMessages("abort-completion");
				debug(`provider: abort detected, marked sharedSession needsRebuild + forceRotate`);
				surfaceFailure({ message: "Operation aborted" }, true);
				return;
			}

			// --- Failure held by consumeQuery ---
			if (failure) {
				if (requestRotation(failure)) return;
				// Not replayable (legacy, post-output, unclassified, or attempts
				// exhausted): surface an explicit error — unless the usage-limit path
				// already did — and persist the session record: the child session
				// advanced through this query, so dropping it would force a full
				// rebuild next turn. But NEVER run the deferred-replay loop from
				// here — surfacing ended the Pi stream, so a continuation query's
				// output would be invisible while its tool side effects still
				// execute. Deferred user input is dropped LOUDLY, and when steers
				// were dropped the record is marked needsRebuild: the cursor already
				// advanced over them on the promise of replay, so a plain REUSE next
					// turn would silently lose them forever.
				if (!abortCtx.handledTerminalError) surfaceFailure(failure);
				const droppedSteers = dropDeferredUserMessages("terminal-failure");
				const activeSession = getSharedSession();
				const failedSessionId = capturedSessionId ?? activeSession?.sessionId;
				if (failedSessionId) {
					const cursor = Math.max(context.messages.length, abortCtx.latestCursor, activeSession?.cursor ?? 0);
					debug(`provider: terminal failure, persisting session=${failedSessionId.slice(0, 8)}, cursor=${cursor}, account=${account?.label ?? "legacy"}, droppedSteers=${droppedSteers.length}`);
					persistSession({ sessionId: failedSessionId, cursor, cwd, ...accountScope, ...(droppedSteers.length > 0 ? { needsRebuild: true } : {}) });
				}
				return;
			}

			// --- Capture session ID ---
			const activeSession = getSharedSession();
			const sessionId = capturedSessionId ?? activeSession?.sessionId;
			if (sessionId) {
				const cursor = Math.max(context.messages.length, abortCtx.latestCursor, activeSession?.cursor ?? 0);
				debug(`provider: query done, session=${sessionId.slice(0, 8)}, cursor=${cursor}, account=${account?.label ?? "legacy"}`);
				// Fresh record on purpose: a transient mid-turn needsRebuild/forceRotate
				// must not survive a completed query and force a rebuild next turn.
				persistSession({ sessionId, cursor, cwd, ...accountScope });
			}
			// The failure branch above returned, so reaching here means success.
			if (account && router) safeRouterCall("recordSuccess", () => router.recordSuccess(account.profileId, options?.sessionId));

			// --- Replay deferred user messages as continuation queries ---
			// Only for outermost queries — reentrant (subagent) queries leave
			// deferred messages for the parent to handle after it finishes.
			try {
				while (abortCtx.deferredUserMessages.length > 0 && !isReentrant && !wasAborted) {
					const steer = abortCtx.deferredUserMessages.shift()!;
					const steerPreview = (steer.text || "[image-only]").slice(0, 60);
					debug(`provider: replaying deferred user message: ${steerPreview}`);
					abortCtx.resetTurnState(queryModel);
					abortCtx.resetToolTracking();

					// A foreign one-shot has no claim on the shared record: its steers
					// continue ITS OWN child session, never --resume the parent's.
					const resumeId = foreignContext ? capturedSessionId : getSharedSession()?.sessionId;
					if (!resumeId) {
						debug(`WARNING: no session to resume for deferred message, dropping`);
						// No record survives here (no session id), so the next turn
						// rebuilds from Pi history anyway — but the drop is still diagnosed.
						dropDeferredUserMessages("continuation-no-resume-id", steer);
						break;
					}

					const contOptions = { ...queryOptions, resume: resumeId, ...makeCliDebugOptions("continuation") };
					// Runs carrying image blocks replay as blocks (wrapPromptStream) so
					// the images survive; text-only runs stay plain strings.
					const contQuery = sdkQueryFactory({ prompt: steer.blocks ? wrapPromptStream(steer.blocks) : steer.text, options: contOptions });
					abortCtx.activeQuery = contQuery;

					debug(`provider: continuation query, model=${queryModel.id}, resume=${resumeId.slice(0, 8)}, account=${account?.label ?? "legacy"}, prompt=${steerPreview}`);

					try {
						const continuation = await consumeQuery(contQuery, abortCtx, customToolNameToPi, queryModel, bridgeConfig, () => wasAborted, account, router);
						if (continuation.failure) {
							// Continuations never rotate: the original prompt already
							// committed on this account.
							recordAttemptFailure(continuation.failure);
							if (!abortCtx.handledTerminalError) surfaceFailure(continuation.failure);
							// The shifted steer may never have reached the child, and any
							// remaining ones certainly did not — the record must rebuild so
							// they re-import from Pi history.
							if (dropDeferredUserMessages("continuation-failure", steer).length > 0) {
								markRebuildForThisQuery();
							}
							break;
						}
						const activeSession = getSharedSession();
						const sid = continuation.capturedSessionId ?? activeSession?.sessionId;
						if (sid) {
							persistSession({ sessionId: sid, cursor: activeSession?.cursor ?? 0, cwd, ...accountScope });
						}
					} catch (contError) {
						debug(`provider: continuation query error:`, contError);
						const continuationFailure: ClaudeAttemptFailure = {
							kind: classifyClaudeFailure(contError),
							message: contError instanceof Error ? contError.message : String(contError),
						};
						recordAttemptFailure(continuationFailure);
						if (!abortCtx.handledTerminalError) surfaceFailure(continuationFailure);
						// Apply the same rebuild rule as the failure branch above.
						if (dropDeferredUserMessages("continuation-error", steer).length > 0) {
							markRebuildForThisQuery();
						}
						break;
					} finally {
						contQuery.close();
					}
				}
			} finally {
				// Guarantees restoration even if contQuery() throws synchronously
				abortCtx.activeQuery = sdkQuery;
			}

			finalizeCurrentStream(abortCtx.turnOutput?.stopReason, abortCtx);
		})
		.catch((error) => {
			debug(`provider: query error, model=${queryModel.id}, aborted=${Boolean(options?.signal?.aborted)}, error=`, error);
			const suppressDuplicateError = abortCtx.handledTerminalError || (streamIdleTimedOut && !retryRequested);
			if (wasAborted || options?.signal?.aborted) {
				markRebuildForThisQuery({ forceRotate: true });
			}
			// a record kept past this error with steers behind its cursor
			// must rebuild so they re-import from Pi history. (The non-abort
			// surface path below replaces the record with null, which rebuilds too.)
			if (dropDeferredUserMessages("query-error").length > 0) {
				markRebuildForThisQuery();
			}
			if (suppressDuplicateError || retryRequested) {
				debug("provider: suppressing duplicate query error after terminal handling");
				return;
			}
			// Prefer the failure metadata consumeQuery held before the throw: a
			// rejected rate_limit_event followed by the iterator throwing was
			// re-classified here WITHOUT its rateLimitInfo, so recordAttemptFailure
			// recorded a second failure on top of the recordRateLimit the event
			// already taught the router — a double-counted cooldown.
			const failure: ClaudeAttemptFailure = attemptFailure.failure?.rateLimitInfo
				? attemptFailure.failure
				: {
					kind: classifyClaudeFailure(error),
					message: error instanceof Error ? error.message : String(error),
				};
			if (requestRotation(failure)) return;
			if (!wasAborted && !options?.signal?.aborted) persistSession(null);
			surfaceFailure(failure, Boolean(options?.signal?.aborted));
		})
		.finally(() => {
			streamIdleWatchdog?.dispose();
			activeStreamIdleWatchdogs.delete(abortCtx);
			if (options?.signal) options.signal.removeEventListener("abort", onAbort);
			const cause = toolCallDrainCause({ wasAborted, signalAborted: options?.signal?.aborted, streamIdleTimedOut });
			teardownQuery(abortCtx, sdkQuery, cause, cwd, isReentrant);
			sdkQuery.close();
		})
		.then(async () => {
			// --- Account retry re-entry ---
			// Runs AFTER teardown so the failed attempt's query state is fully
			// released. The recursive call re-enters the fresh-query path with the
			// rotation state carrying the excluded profiles; its events forward
			// into this attempt's still-unstarted Pi stream.
			if (!retryRequested) return;
			if (wasAborted || options?.signal?.aborted) {
				// An abort landed AFTER rotation was queued: requestRotation already
				// discarded the attempt buffer and nulled currentPiStream, and only
				// the retry loop below would have ended the outer stream. Skipping
				// the retry without terminating here left the consumer hanging on a
				// stream that never ends.
				debug("provider: abort after queued account retry — terminating stream without retrying");
				if (abortCtx.turnOutput) {
					abortCtx.turnOutput.stopReason = "aborted";
					abortCtx.turnOutput.errorMessage = "Operation aborted";
				}
				stream.push({ type: "error", reason: "aborted", error: abortCtx.turnOutput! });
				stream.end();
				return;
			}
			debug(`provider: starting account retry after ${retryFailure?.kind ?? "failure"}; excluded=${[...rotationState.excludedProfileIds].join(",")}`);
			const retryStream = streamClaudeAgentSdk(model, context, {
				...(options ?? {}),
				[ROTATION_STATE_KEY]: rotationState,
			} as BridgeStreamOptions);
			// End exactly once per outcome. Ending in a `finally` ran on
			// the throw path too, BEFORE the .catch below could push its error
			// event — and EventStream.push is a silent no-op after end, so a failed
			// rotation ended the turn with no error event at all. Success ends
			// here; every throw ends in the .catch, after the error is pushed.
			for await (const event of retryStream) stream.push(event);
			stream.end();
		})
		.catch((error) => {
			debug("provider: account retry pipeline failed:", error);
			if (abortCtx.turnOutput) {
				abortCtx.turnOutput.stopReason = "error";
				abortCtx.turnOutput.errorMessage = error instanceof Error ? error.message : String(error);
			}
			stream.push({ type: "error", reason: "error", error: abortCtx.turnOutput! });
			stream.end();
		})
		// After teardown and any retry pipeline: nothing else reads this lane.
		.finally(releaseEphemeralLane);

	return stream;
}

// --- Extension registration ---

export default function (pi: ExtensionAPI) {
	setExtensionApi(pi);
	// Disable non-essential Claude Code traffic (update checks, MCP registry, telemetry)
	process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";

	const config = loadConfig(process.cwd());
	debug("loadConfig:", JSON.stringify(config));
	// Registered before the disabled early return: a bridge switched off by
	// claude-bridge.json is exactly when the settings editor has to show where
	// that value came from.
	registerBridgeCommands(pi);
	if (config.enabled === false) {
		debug("provider: disabled by configuration");
		return;
	}
	// Publish the reciprocal account-host service (a local /usage probe) for the
	// companion account manager. Primary instance only — a subagent reload must
	// not swap the owner from under an in-flight probe.
	if (claimPrimaryInstance()) {
		const host = globalThis as Record<symbol, any>;
		host[CLAUDE_BRIDGE_ACCOUNT_HOST_SYMBOL] = BRIDGE_ACCOUNT_HOST;
	}

	// Reset shared (Claude) conversation state on pi session lifecycle events.
	// Registration tokens are managed separately by applyProviderRegistration
	// (load / session_start / pre-spawn) and releaseProviderTokens (shutdown), so
	// a mid-session credential flip is handled while token ownership is intact.
	const clearSession = (event: string) => {
		const activeSession = getSharedSession();
		debug(`${event}: clearing session ${activeSession?.sessionId?.slice(0, 8) ?? "none"}`);
		setSharedSession(null);
	};

	pi.on("session_start", (event, ctx) => runInRequestLane(ctx.sessionManager.getSessionId(), () => {
		recordStartedLane(ctx.sessionManager, ctx.sessionManager.getSessionId());
		recordProjectTrust(ctx);
		setPiUI(ctx.ui);
		if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") {
			clearSession(`session_start:${event.reason}`);
		}
		// Note: "fork" intentionally omitted from restoration. createBranchedSession
		// copies the parent's persisted bridge entries into the fork; restoring from
		// them would --resume the parent's Claude jsonl and leak conversation past the
		// fork point. Letting the first fork turn rebuild is the correct path.
		if (event.reason === "startup" || event.reason === "resume") restoreSharedSessionFromPi(ctx);
		// Live availability flip: re-evaluate credential presence every
		// session_start so login/logout since load is reflected without /reload.
		applyProviderRegistration(`session_start:${event.reason}`);
	}));
	pi.on("session_shutdown", (_event, ctx) => {
		const sessionId = takeStartedLane(ctx.sessionManager) ?? ctx.sessionManager.getSessionId();
		runInRequestLane(sessionId, () => {
			cancelScheduledSessionPersistence(ctx.sessionManager);
			clearSession("session_shutdown");
			releaseProviderTokens("session_shutdown");
		});
		deleteSharedSessionLane(sessionId);
		deleteQueryLane(sessionId);
	});
	pi.on("message_end", (event, ctx) => runInRequestLane(ctx.sessionManager.getSessionId(), () => {
		const message = (event as { message?: AssistantMessage }).message;
		if (message?.role === "assistant" && message.provider === PROVIDER_ID) schedulePersistSharedSession(ctx);
	}));

	// pi /compact and session-tree navigation (rewind / fork-at-point /
	// branch switch) both mutate pi's messages array out from under the
	// bridge. syncSharedSession's REUSE check would otherwise see
	// slice(cursor) === [] (or skip entries) and keep --resume'ing a CC
	// session that does not match pi's history. /compact in particular
		// triggers CC's autocompact-thrashing guard. Force the next
	// call down the REBUILD path so CC sees the current history.
	const markRebuild = (event: string) => {
		const activeSession = getSharedSession();
		if (ctx().activeQuery) {
			reportToolResultMismatch(ctx(), event, activeSession?.cwd ?? process.cwd());
		}
		if (activeSession) {
			debug(`${event}: marking needsRebuild on session ${activeSession.sessionId.slice(0, 8)}`);
			markSessionForRebuild();
		}
	};
	pi.on("session_compact", (_event, ctx) => runInRequestLane(ctx.sessionManager.getSessionId(), () => markRebuild("session_compact")));
	pi.on("session_tree", (_event, ctx) => runInRequestLane(ctx.sessionManager.getSessionId(), () => markRebuild("session_tree")));

	// --- Provider ---
	//
	// Native registration (pi >=0.81): register unconditionally; the provider's
	// own auth check/resolve report whether Claude credentials exist, so pi
	// hides claude-bridge models while no account is connected and shows them
	// when one appears. session_start and pre-spawn re-upsert the provider to
	// force pi's availability recompute at those boundaries.
	//
	// applyProviderRegistration also claims the primary-instance token (first
	// load wins) and enforces the multi-instance guard: a non-primary subagent
	// reload always no-ops, so it never overwrites the parent's streamSimple nor
	// steals ownership. See PRIMARY_INSTANCE_KEY / ACTIVE_STREAM_SIMPLE_KEY.
	applyProviderRegistration("load");
}
