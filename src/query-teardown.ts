// End-of-query teardown, extracted from streamClaudeAgentSdk's .finally so it
// operates on the ONE context captured at query start — never the live ctx().
// The two only differ while a reentrant (subagent) context is pushed, which is
// exactly when a parent query ending abnormally (abort, child process death)
// teardown must run against the parent state. Using the subagent state skips
// the parent's drain, audit flush, and activeQuery clear, which leaks handlers.

import type { query } from "@anthropic-ai/claude-agent-sdk";
import { reportToolResultMismatch } from "./bridge-state.js";
import { flushConnectorCallAudit } from "./connector-audit.js";
import { debug } from "./debug.js";
import { drainPendingToolCalls, popContextFor, type QueryContext, type ToolCallDrainCause } from "./query-state.js";

/** A child transport may throw during close; teardown must still reach its
 *  replacement query or report an error on the stream Pi is waiting for. */
export function closeSdkQuery(sdkQuery: ReturnType<typeof query>): void {
	try { sdkQuery.close(); }
	catch (error) { debug("provider: closing the sdk query threw:", error); }
}

export function abortSdkQuery(sdkQuery: ReturnType<typeof query>): void {
	void sdkQuery.interrupt().catch(() => {});
	closeSdkQuery(sdkQuery);
}

/** Tear down `queryCtx` after its SDK query settled. No-ops when the query is
 *  is not the context's active one (a continuation replaced it, or teardown
 *  already ran). Returns true when teardown actually ran. */
export function teardownQuery(
	queryCtx: QueryContext,
	sdkQuery: unknown,
	cause: ToolCallDrainCause,
	cwd: string,
	isReentrant: boolean,
): boolean {
	if (queryCtx.activeQuery !== sdkQuery) return false;
	reportToolResultMismatch(queryCtx, "query teardown", cwd, { forceRotate: cause !== "query-end" });
	// Drain pending handlers for this query as errors naming the cause —
	// their results are never coming.
	const drained = drainPendingToolCalls(queryCtx, cause);
	if (drained > 0) debug(`provider: query teardown drained ${drained} waiting MCP handler(s) as errors (cause=${cause})`);
	queryCtx.pendingResults.clear();

	// Same idea for calls the CHILD owned: one whose result never came back
	// is recorded as unobserved rather than left silent, so an answer in the
	// transcript is never the only evidence a connector call was made.
	const unobserved = flushConnectorCallAudit(queryCtx, cause);
	if (unobserved > 0) debug(`provider: query teardown recorded ${unobserved} connector call(s) with no observed result (cause=${cause})`);

	if (isReentrant) {
		// Merges deferred messages and restores/repairs the stack. popContextFor
		// (not popContext): a live subagent context may sit above this one.
		if (!popContextFor(queryCtx)) debug("provider: query teardown found context already popped; skipping pop");
	} else {
		queryCtx.activeQuery = null;
	}
	return true;
}
