// Tool-result release for the active query's provider callback, and live
// delivery of a steer Pi hands over together with those results.
//
// A steer sent while a Pi tool runs reaches the provider in the same callback
// as the tool results. Written to the running Claude Code child BEFORE the
// results are released, it is part of Claude's very next request; queued for
// a continuation, Claude would first finish the original instruction.

import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources";
import { endStreamForFailure } from "./assistant-stream.ts";
import { appendIntegrityEntry, getSharedSession, markSessionForRebuild, reportToolResultMismatch, safeNotify } from "./bridge-state.ts";
import { contentShape, debug, diagDump } from "./debug.ts";
import { currentPiSession, noteAnomaly } from "./agent-notice.ts";
import type { McpResult } from "./extract-tool-results.ts";
import { UNVERIFIED_HISTORY_DIGEST } from "./history-digest.ts";
import { slashLed } from "./user-prompt.ts";
import { drainStrandedToolCalls, type DeferredUserMessage, type QueryContext } from "./query-state.ts";
import { abortSdkQuery } from "./query-teardown.ts";

export const STEERING_DELIVERY_FAILED_MESSAGE = "Claude bridge could not deliver steering to Claude Code. Retry to rebuild from Pi history.";

/** Whether `id` answers a call this query registered or handed to Pi. A
 *  forwarded id is always legitimate even after the per-message records
 *  reset — Pi only answers calls it was handed (steer-split results land here
 *  after a boundary wiped the turn records). */
export function answersKnownCall(queryCtx: QueryContext, id: string | undefined): id is string {
	return Boolean(id) && (queryCtx.hasRecordedToolCall(id) || queryCtx.forwardedToolCallIds.has(id!));
}

/** Resolve waiting MCP handlers with `allResults` (or queue a result whose
 *  handler has not fired yet). A result for no registered call is refused and
 *  fails the remaining handlers; handlers whose call never reached Pi are
 *  drained as stranded. Results wait for `toolsSettling`, a served-tool
 *  re-list, when one is pending. */
export function resolveToolResults(queryCtx: QueryContext, allResults: McpResult[], toolsSettling: Promise<void> | null, cwd: string): void {
	const unmatchedResultIds: string[] = [];
	for (const result of allResults) {
		const id = result.toolCallId;
		if (id && !answersKnownCall(queryCtx, id)) {
			queryCtx.markToolResultUnmatched(id);
			unmatchedResultIds.push(id);
			debug(`ERROR: tool result [${id}] has no registered tool_call id; refusing to queue or deliver`);
			continue;
		}
		queryCtx.markToolResultDelivered(id);
		if (id && queryCtx.pendingToolCalls.has(id)) {
			const pending = queryCtx.pendingToolCalls.get(id)!;
			queryCtx.pendingToolCalls.delete(id);
			const abandoned = queryCtx.abandonedToolCalls.get(id);
			if (abandoned) {
				// Claude Code answered this call itself earlier (noteAbandonedToolCalls
				// told the user); the SDK discards this late answer.
				debug(`provider: late result for ${pending.toolName} [${id}] after Claude Code gave up on it (${abandoned.reason}); Claude does not receive it`);
				appendIntegrityEntry("late_tool_result_after_claude_gave_up", { id, toolName: pending.toolName });
			}
			debug(`provider: resolving ${pending.toolName} [${id}]${result.isError ? " (error)" : ""} content: ${contentShape(result.content)}`);
			if (toolsSettling) {
				void toolsSettling.then(() => {
					queryCtx.timing?.phase("resultReleased");
					pending.resolve(result);
				});
			} else {
				queryCtx.timing?.phase("resultReleased");
				pending.resolve(result);
			}
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
		noteAnomaly("tool_results_unmatched");
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
			appendIntegrityEntry("tool_handlers_stranded", { count: stranded.length, stranded });
		}
		if (queryCtx.pendingToolCalls.size > 0) {
			debug(`WARNING: ${queryCtx.pendingToolCalls.size} MCP handlers still waiting after delivering ${allResults.length} results`);
			safeNotify(`Claude bridge: ${queryCtx.pendingToolCalls.size} tool handler(s) still waiting — provider may be stuck`, "warning");
		}
	}
}

export interface LiveSteer {
	/** The fresh user input, already owned by the query's ledger. */
	steer: DeferredUserMessage;
	userMessageCount: number;
	resultCount: number;
	/** Releases this callback's tool results (resolveToolResults). */
	release: () => void;
	/** The Pi request's signal. */
	signal: AbortSignal | undefined;
	/** The callback's history-replaced restart; false when it was declined
	 *  and the query finishes on its own history. */
	restartOnReplacedHistory: () => boolean;
}

/** Write `live.steer` to the running child, then release the callback's tool
 *  results. `queryCtx` and `sdkQuery` are captured by the caller at callback
 *  time; nothing here reads the lane's live context. The lane is not kept in
 *  use while the write is pending: the query may end and the next prompt may
 *  claim the lane's record meanwhile, so the write's completion acts only on
 *  the record it wrote into (see the ended-query branch). */
export function deliverSteerBeforeResults(queryCtx: QueryContext, sdkQuery: NonNullable<QueryContext["activeQuery"]>, live: LiveSteer): void {
	const historyReplacedBefore = queryCtx.piHistoryReplaced;
	const aborted = (): boolean => live.signal?.aborted === true || queryCtx.requestAborted();
	let written = false;
	// The Pi session to tell about an anomaly of this write, resolved while
	// the callback runs: the write can finish after the query ended and its
	// fork lane, which alone maps to that session, was released.
	const piSession = currentPiSession();
	queryCtx.steeringWriteQuery = sdkQuery;
	// The record this write belongs to: this query's generation of the
	// context and the Claude session it resumed. None for a detached query.
	const writtenInto = queryCtx.detachedFromSharedSession
		? null
		: { generation: queryCtx.queryGeneration, sessionId: getSharedSession()?.sessionId };
	const writeSettled = (): void => {
		if (queryCtx.steeringWriteQuery === sdkQuery) queryCtx.steeringWriteQuery = null;
	};
	const content = live.steer.blocks ?? live.steer.text;
	const message: SDKUserMessage = {
		type: "user",
		message: { role: "user", content } as MessageParam,
		parent_tool_use_id: null,
		// "now" makes Claude Code 2.1.283 interrupt the pending MCP call and discard its result; "next" keeps it.
		priority: "next",
		...(slashLed(content) ? { client_composed: true as const } : {}),
	};
	async function* input(): AsyncGenerator<SDKUserMessage> {
		yield message;
		// Query.streamInput() asks for the next item only after transport.write
		// resolved, so Claude Code holds the steer: the results may follow it.
		written = true;
		writeSettled();
		if (aborted()) {
			// The query's abort path drained the handlers and owns the request.
			debug("provider: request cancelled while steering was written; releasing no tool results");
			return;
		}
		if (queryCtx.activeQuery !== sdkQuery) {
			debug("provider: query ended while steering was written; releasing no tool results");
			diagDump("steering_query_ended_during_write", { resultCount: live.resultCount, detached: queryCtx.detachedFromSharedSession });
			noteAnomaly("steering_query_ended_during_write", piSession);
			// Only the record this write belongs to, never a replacement's: a
			// newer query in this context (a rebuild may keep the session id),
			// a rotated session, a quarantined context or a released lane is
			// left alone. Teardown's mismatch report usually marked it already.
			const record = getSharedSession();
			if (
				writtenInto !== null && !queryCtx.detachedFromSharedSession &&
				queryCtx.queryGeneration === writtenInto.generation &&
				record !== null && writtenInto.sessionId !== undefined && record.sessionId === writtenInto.sessionId &&
				!record.needsRebuild
			) markSessionForRebuild({ reason: "steering-write", forceRotate: true });
			return;
		}
		if (queryCtx.restartRequest) {
			debug("provider: a history restart is pending; releasing no tool results");
			return;
		}
		if (!historyReplacedBefore && queryCtx.piHistoryReplaced && live.restartOnReplacedHistory()) {
			// The restart re-imports this callback's history, results and steer
			// included, into a rotated session.
			debug("provider: Pi replaced the history while steering was written; releasing no tool results");
			return;
		}
		live.release();
	}
	let writing: Promise<void>;
	try {
		writing = sdkQuery.streamInput(input());
	} catch (error) {
		writing = Promise.reject(error);
	}
	// streamInput() settles at the query's result boundary, not at the write:
	// never await it here.
	writing.then(writeSettled, (error: unknown) => {
		writeSettled();
		if (written) {
			debug("provider: steering input ended with an error after the write:", error);
			return;
		}
		if (aborted() || queryCtx.activeQuery !== sdkQuery) {
			debug("provider: steering write ended by the query's own cancellation or end:", error);
			return;
		}
		failSteeringDelivery(queryCtx, sdkQuery, error, live, piSession);
	});
}

/** A steering write failed: whether Claude Code has the steer is unknown, so
 *  neither the results nor a continuation may follow it. The request ends
 *  with an error and the next one rebuilds from Pi history, which carries the
 *  steer. */
function failSteeringDelivery(queryCtx: QueryContext, sdkQuery: NonNullable<QueryContext["activeQuery"]>, error: unknown, live: LiveSteer, piSession: string | undefined): void {
	debug("provider: steering delivery to Claude Code failed; ending the request and rebuilding from Pi history:", error);
	queryCtx.handledTerminalError = true;
	queryCtx.priorHistoryRewritten = true;
	queryCtx.latestCursorDigest = UNVERIFIED_HISTORY_DIGEST;
	if (!queryCtx.detachedFromSharedSession) markSessionForRebuild({ reason: "steering-failed", forceRotate: true });
	const detail = { resultCount: live.resultCount, userMessageCount: live.userMessageCount, detached: queryCtx.detachedFromSharedSession };
	diagDump("steering_delivery_failed", { ...detail, error: error instanceof Error ? error.message : String(error) });
	noteAnomaly("steering_delivery_failed", piSession);
	appendIntegrityEntry("steering_delivery_failed", detail);
	endStreamForFailure(queryCtx, { errorMessage: STEERING_DELIVERY_FAILED_MESSAGE });
	// The query's own abort path drains the held handlers, drops deferred
	// input, kills the child and takes this context out of its lane. It runs
	// after the stream ended, so the request is not reported as cancelled.
	if (queryCtx.onRequestAbort) queryCtx.onRequestAbort();
	else abortSdkQuery(sdkQuery);
}
