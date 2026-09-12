// Background SDK-stream consumer + the failure/metadata capture that rides it.
// Extracted from index.ts (pure move): consumeQuery iterates one SDK query's
// generator and pushes events into the query's captured Pi stream.

import { type Model } from "@earendil-works/pi-ai";
import { type query } from "@anthropic-ai/claude-agent-sdk";
import {
	classifyClaudeFailure,
	rateLimitResetFromInfo,
	rateLimitResetMs,
	rateLimitTypeFromInfo,
	safeRouterCall,
	type ClaudeAccountFailureKind,
	type ClaudeAccountRoute,
	type ClaudeAccountRouterV1,
} from "./account-router.js";
import { ensureTurnStarted, noteChildExecutedToolResults, processAssistantMessage, processStreamEvent, updateTurnOutputModel } from "./assistant-stream.js";
import { extensionApi, safeNotify } from "./bridge-state.js";
import { type Config } from "./config.js";
import { debug } from "./debug.js";
import { fallbackModelForPrimaryModel, modelDisplayName } from "./models.js";
import { type QueryContext } from "./query-state.js";
import { RATE_LIMIT_AUTO_RESUME_EVENT, RATE_LIMIT_TOKEN, formatAllowedRateLimitWarning, formatResetTimestamp, isUsageLimitMessage, uniqueNonEmptyLines } from "./rate-limit.js";
import { activeStreamIdleWatchdogs } from "./stream-idle-watchdog.js";

export function emitRateLimitEvent(payload: Record<string, unknown>): void {
	try {
		extensionApi?.events?.emit?.(RATE_LIMIT_AUTO_RESUME_EVENT, payload);
	} catch {
		// Cross-extension broker is best-effort only.
	}
}

// The fastMode setting silently no-ops when Claude Code declines fast mode.
// Surface the typed fast_mode_disabled_reason (SDK 0.3.219+) once per distinct
// reason so an enabled-but-inert setting explains itself instead of looking
// broken. Module-level dedup: the same reason repeats on every init message.
let lastFastModeDisabledNoticeReason: string | null = null;

const FAST_MODE_DISABLED_REASON_TEXT: Record<string, string> = {
	disabled_by_env: "disabled by an environment variable",
	extra_usage_disabled: "extra usage is disabled for this account",
	free: "not available on the free plan",
	model_not_allowed: "not available for this model",
	network_error: "the eligibility check hit a network error",
	not_first_party: "not available for this account type",
	preference: "disabled by a Claude Code preference",
	sdk_opt_in_required: "the SDK opt-in is missing",
	unknown: "unavailable for an unknown reason",
};

function noteFastModeDisabledReason(message: unknown, bridgeConfig: Config): void {
	if (bridgeConfig.provider?.fastMode !== true) return;
	const reason = (message as { fast_mode_disabled_reason?: unknown }).fast_mode_disabled_reason;
	// "pending" means the CLI is still deciding — not a verdict worth announcing.
	if (typeof reason !== "string" || reason === "pending") return;
	if (reason === lastFastModeDisabledNoticeReason) return;
	lastFastModeDisabledNoticeReason = reason;
	const text = FAST_MODE_DISABLED_REASON_TEXT[reason] ?? `unavailable (${reason})`;
	safeNotify(`Pi Claude: fast mode is enabled in settings but Claude Code declined it — ${text}.`, "warning");
}

/** Background consumer: iterates the SDK generator, pushing events to currentPiStream.
 *  Runs until the query ends. Per turn, the SDK yields stream_events (deltas), then
 *  an assistant message (completed blocks). On tool_use, the stream is ended by
 *  whichever path handles it first (processStreamEvent or processAssistantMessage),
 *  and the MCP handler blocks the generator until pi delivers the tool result. */
export interface ClaudeAttemptFailure {
	kind?: ClaudeAccountFailureKind;
	message: string;
	rateLimitInfo?: Record<string, unknown>;
}

export interface ConsumeQueryResult {
	capturedSessionId?: string;
	failure?: ClaudeAttemptFailure;
}

export async function consumeQuery(
	sdkQuery: ReturnType<typeof query>,
	// The CAPTURED context of the query being consumed, never the live ctx():
	// an MCP tool can push a reentrant subagent context while this iterator is
	// suspended, and reading live state then would consult the WRONG query — a
	// recovered success could retain its failure and surface an error, or a
	// child session id could stamp the subagent's context.
	queryCtx: QueryContext,
	customToolNameToPi: Map<string, string>,
	model: Model<any>,
	bridgeConfig: Config,
	wasAborted: () => boolean,
	account?: ClaudeAccountRoute,
	router?: ClaudeAccountRouterV1,
	// Mirror of the held failure for the caller's .catch: the SDK iterator can
	// THROW after the failure-signal message (a rejected rate_limit_event is the
	// known case), and the rejection loses this function's return value. Without
	// the mirror the catch re-classifies from the thrown error, misses
	// rateLimitInfo, and double-counts the router cooldown.
	attemptFailureBox?: { failure?: ClaudeAttemptFailure },
): Promise<ConsumeQueryResult> {
	let capturedSessionId: string | undefined;
	let failure: ClaudeAttemptFailure | undefined;
	let accountProbe: Promise<void> | undefined;
	const holdFailure = (next: ClaudeAttemptFailure | undefined): void => {
		failure = next;
		if (attemptFailureBox) attemptFailureBox.failure = next;
	};

	for await (const message of sdkQuery) {
		if (wasAborted()) break;
		activeStreamIdleWatchdogs.get(queryCtx)?.noteChunk();
		if (account) {
			// Thunk, not a value: this runs once per SDK message — including one
			// stream_event per streamed token — and debug() only evaluates function
			// args after its DEBUG early return.
			debug("consumeQuery: managed message", () => JSON.stringify({
				type: message.type,
				subtype: (message as any).subtype,
				error: (message as any).error,
				eventType: (message as any).event?.type,
				deltaType: (message as any).event?.delta?.type,
				contentType: (message as any).event?.content_block?.type,
			}));
		}
		if (!queryCtx.turnOutput) continue;
		// Only RENDERING needs a live Pi stream. Failure metadata and
		// child-executed tool results must be captured even when a tool-use turn
		// boundary has nulled the stream — skipping them there dropped terminal
		// failure classification and audited late connector results "unobserved".
		const streamLive = Boolean(queryCtx.currentPiStream);

		switch (message.type) {
			case "stream_event":
				if (!streamLive) break;
				processStreamEvent(message, customToolNameToPi, model, queryCtx);
				break;
			case "assistant": {
				// Claude Code emits a synthetic assistant text block carrying friendly
				// rate/auth error copy before the SDK throws. On a managed attempt it
				// is not model output: forwarding it would commit the stream and make
				// safe pre-output account failover impossible, so hold it as failure
				// metadata (with or without a live stream). A legacy attempt renders
				// it exactly as before.
				const sdkError = (message as any).error;
				if (sdkError && account) {
					if (!failure) holdFailure({ kind: classifyClaudeFailure(sdkError), message: String(sdkError) });
					break;
				}
				if (!streamLive && !queryCtx.turnSawToolCall) break;
				processAssistantMessage(message, model, customToolNameToPi, queryCtx);
				break;
			}
			case "result":
				// A failure signal followed by a result whose visible output already
				// committed (e.g. the SDK's fallback-model reroute recovering after a
				// rejected rate limit) means the query ultimately SUCCEEDED: the
				// failure was informational and must neither surface an error after
				// the answer nor skip session persistence.
				if (failure && message.subtype === "success" && queryCtx.committedOutput) {
					debug(`consumeQuery: clearing informational ${failure.kind ?? "unclassified"} failure — query recovered with committed output`);
					holdFailure(undefined);
				}
				// The SDK can label the synthetic friendly error carrier as a
				// successful result immediately before its iterator throws. Once a
				// managed attempt holds a terminal failure signal, that text is still
				// error metadata, not assistant output.
				if (account && failure) break;
				if (!queryCtx.turnSawStreamEvent && message.subtype === "success") {
					if (!streamLive) break;
					const text = message.result || "";
					// The no-stream-events assistant fallback may have already rendered
					// this exact text (it does not set turnSawStreamEvent) — re-pushing
					// it here is the other half of the duplicated-output bug.
					if (queryCtx.turnBlocks.some((b: any) => b.type === "text" && b.text === text)) {
						debug("consumeQuery: result text already rendered by assistant fallback; skipping duplicate");
						break;
					}
					ensureTurnStarted(queryCtx);
					queryCtx.turnBlocks.push({ type: "text", text });
					const idx = queryCtx.turnBlocks.length - 1;
					queryCtx.currentPiStream?.push({ type: "text_start", contentIndex: idx, partial: queryCtx.turnOutput });
					queryCtx.currentPiStream?.push({ type: "text_delta", contentIndex: idx, delta: text, partial: queryCtx.turnOutput });
					queryCtx.currentPiStream?.push({ type: "text_end", contentIndex: idx, content: text, partial: queryCtx.turnOutput });
				} else if (message.subtype !== "success") {
					const errorLines = Array.isArray((message as any).errors) ? uniqueNonEmptyLines((message as any).errors) : [];
					const errors = errorLines.length > 0 ? errorLines.join("\n") : String((message as any).result || message.subtype || "Claude Code request failed");
					const usageLimit = isUsageLimitMessage(message);
					if (!failure || !failure.rateLimitInfo) {
						holdFailure({ kind: usageLimit ? "rate-limit" : classifyClaudeFailure(errors), message: errors });
					}
					// Managed attempts keep terminal error copy buffered as metadata so
					// a pre-output failure can move to another subscription profile.
					if (account) break;
					if (usageLimit) {
						// isUsageLimitMessage matches the CLI's own usage-limit copy (SDK
						// USAGE_LIMIT_ERROR_PREFIXES). Surface it immediately, exactly as
						// before, and suppress the SDK's raw follow-up throw.
						queryCtx.handledTerminalError = true;
						queryCtx.turnOutput.stopReason = "error";
						queryCtx.turnOutput.errorMessage = errors;
						queryCtx.currentPiStream?.push({ type: "error", reason: "error", error: queryCtx.turnOutput });
						queryCtx.currentPiStream?.end();
						queryCtx.currentPiStream = null;
					}
					// Other non-success subtypes (error_max_turns,
					// error_during_execution) surface at completion via the held
					// failure. These turns require an explicit error event instead of
					// silent completion. Session persistence and deferred replay still run.
				}
				break;
			case "system":
				if (!streamLive) break;
				if ((message as any).subtype === "init" && (message as any).session_id) {
					capturedSessionId = (message as any).session_id;
					// Also on this message's query context, so the connector-call audit
					// trail can name the child session that executed a call — including
					// from the teardown flush, which runs outside this function's scope.
					queryCtx.childSessionId = capturedSessionId;
					noteFastModeDisabledReason(message, bridgeConfig);
					if (account && router && !accountProbe) {
						accountProbe = Promise.allSettled([
							sdkQuery.accountInfo().then((info) => router.recordIdentity(account.profileId, {
								email: info.email,
								organization: info.organization,
								subscriptionType: info.subscriptionType,
							})),
							sdkQuery.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()
								.then((usage) => router.recordUsage(account.profileId, usage)),
						]).then((results) => {
							const labels = ["recordIdentity", "recordUsage"];
							results.forEach((result, i) => {
								if (result.status === "rejected") debug(`consumeQuery: account probe ${labels[i]} rejected:`, result.reason);
							});
						});
					}
				} else if ((message as any).subtype === "model_refusal_fallback") {
					const originalModel = (message as any).original_model;
					const fallbackModel = (message as any).fallback_model;
					updateTurnOutputModel(fallbackModel, queryCtx);
					debug("consumeQuery: model_refusal_fallback", JSON.stringify({ originalModel, fallbackModel }));
					// Notify only for reroutes we configured, so an unexpected pairing from
					// Claude Code is still logged above but not announced as one of ours.
					if (typeof fallbackModel === "string" && typeof originalModel === "string" && fallbackModelForPrimaryModel(originalModel) === fallbackModel) {
						safeNotify(
							`Pi Claude switched ${modelDisplayName(originalModel)} to ${modelDisplayName(fallbackModel)} after Claude Code safety fallback.`,
							"info",
						);
					}
				}
				break;
			case "user":
				// Mostly the SDK echoing the prompt back — nothing to render. The one
				// thing worth reading is a child-executed tool's real result, which
				// arrives here and nowhere else — including AFTER a tool-use turn
				// boundary nulled the stream (noteChildExecutedToolResults is
				// side-effect-free on the Pi stream).
				noteChildExecutedToolResults(message, queryCtx);
				break;
			case "rate_limit_event": {
				if (!streamLive) break;
				const info = (message as any).rate_limit_info as Record<string, unknown> | undefined;
				debug("consumeQuery: rate_limit_event", JSON.stringify(info).slice(0, 300));
				if (info?.status === "rejected") {
					const rateLimitType = rateLimitTypeFromInfo(info);
					const resetAt = rateLimitResetFromInfo(info);
					const resetAtMs = rateLimitResetMs(info);
					const reason = `${rateLimitType ?? "unknown"} rate limit`;
					if (account && router) {
						// Rotation may still recover this request, so hold the rejection
						// as failure metadata and teach the router the reset time now.
						// Surfacing (event + toast) happens once in surfaceFailure — only
						// if the attempt is not replayed on another profile.
						holdFailure({ kind: "rate-limit", message: reason, rateLimitInfo: info });
						safeRouterCall("recordRateLimit", () => router.recordRateLimit(account.profileId, info, model.id));
					} else {
						// Legacy: notify once and set NO failure state. The SDK's own
						// fallback-model path may still stream a successful recovery, and
						// that turn must complete exactly like any other success.
						const resetsAt = formatResetTimestamp(resetAtMs ?? resetAt);
						emitRateLimitEvent({
							model: model.id,
							provider: model.provider,
							rateLimitType,
							reason,
							resetAt,
							...(Number.isFinite(resetAtMs) ? { resetAtMs } : {}),
							source: "claude-bridge",
							status: "rejected",
						});
						safeNotify(`${RATE_LIMIT_TOKEN} Claude ${reason} hit — resets ${resetsAt}`, "warning");
					}
				} else if (info?.status === "allowed_warning") {
					const warning = formatAllowedRateLimitWarning(info);
					if (warning) safeNotify(warning, "warning");
					else debug("consumeQuery: suppressed low/ambiguous allowed_warning rate_limit_event", JSON.stringify(info).slice(0, 300));
				}
				break;
			}
			default:
				debug("consumeQuery: unhandled SDK message type", message.type);
				break;
		}
	}

	if (accountProbe) {
		await Promise.race([
			accountProbe,
			new Promise<void>((resolve) => setTimeout(resolve, 1_500)),
		]);
	}
	debug(`consumeQuery: for-await loop exited, wasAborted=${wasAborted()}, capturedSessionId=${capturedSessionId?.slice(0, 8) ?? "none"}, failure=${failure?.kind ?? "none"}`);
	return { capturedSessionId, failure };
}
