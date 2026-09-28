import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { appendIntegrityEntry, markSessionForRebuild, reportToolResultMismatch, safeNotify } from "./bridge-state.js";
import { debug, diagDump } from "./debug.js";
import type { McpResult } from "./extract-tool-results.js";
import { drainStrandedToolCalls, type DeferredUserMessage, type QueryContext } from "./query-state.js";
import { abortSdkQuery } from "./query-teardown.js";

function resolveToolResults(queryCtx: QueryContext, allResults: McpResult[], cwd: string): void {
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
}

export function deliverToolResults(
	queryCtx: QueryContext,
	allResults: McpResult[],
	steer: DeferredUserMessage | null,
	cwd: string,
	signal: AbortSignal | undefined,
): void {
	if (!Boolean(steer)) {
		resolveToolResults(queryCtx, allResults, cwd);
		return;
	}
	const sdkQuery = queryCtx.activeQuery!;
	async function* input(): AsyncIterable<SDKUserMessage> {
		yield {
			type: "user",
			message: { role: "user", content: steer.blocks ?? steer.text },
			parent_tool_use_id: null,
			priority: "now",
		};
		// streamInput requests the next item after awaiting the transport write.
		// Release MCP handlers only then, so their results cannot overtake steering.
		if ((Boolean(signal) && signal.aborted) || queryCtx.activeQuery !== sdkQuery) return;
		resolveToolResults(queryCtx, allResults, cwd);
	}
	// streamInput finishes at the SDK's result boundary, not at the write.
	void sdkQuery.streamInput(input()).catch((error: unknown) => {
		if ((Boolean(signal) && signal.aborted) || queryCtx.activeQuery !== sdkQuery) return;
		queryCtx.piHistoryReplaced = true;
		if (!queryCtx.detachedFromSharedSession) markSessionForRebuild({ forceRotate: true });
		appendIntegrityEntry("steering_delivery_failed", { resultCount: allResults.length });
		debug("provider: steering delivery failed", error);
		queryCtx.handledTerminalError = true;
		const stream = queryCtx.currentPiStream;
		if (Boolean(stream)) {
			queryCtx.turnOutput.stopReason = "error";
			queryCtx.turnOutput.errorMessage = "Claude bridge could not deliver steering to Claude Code. Retry to rebuild from Pi history.";
			stream.push({ type: "error", reason: "error", error: queryCtx.turnOutput });
			stream.end();
			queryCtx.currentPiStream = null;
		}
		abortSdkQuery(sdkQuery);
	});
}
