// End-of-query teardown, extracted from streamClaudeAgentSdk's .finally so it
// operates on the ONE context captured at query start — never the live ctx().
// The two differ once a quarantine (abort, stream-idle timeout) handed the
// lane to a new context that the next prompt's query may already use. Using
// that context would skip this query's drain, audit flush, and activeQuery
// clear, which leaks handlers.

import type { query } from "@anthropic-ai/claude-agent-sdk";
import { reportToolResultMismatch } from "./bridge-state.ts";
import { flushConnectorCallAudit } from "./connector-audit.ts";
import { debug } from "./debug.ts";
import { drainPendingToolCalls, type QueryContext, type ToolCallDrainCause } from "./query-state.ts";

/** A child transport may throw during close; teardown must still reach its
 *  replacement query or report an error on the stream Pi is waiting for. */
export function closeSdkQuery(sdkQuery: ReturnType<typeof query>): void {
	try { sdkQuery.close(); }
	catch (error) { debug("provider: closing the sdk query threw:", error); }
}

// How long an interrupted and closed child gets to end its SDK iterator. The
// SDK escalates close() to SIGKILL after 5s; past that, only a wedged iterator
// is still pending, and nothing guarantees it ever settles.
const DEFAULT_SETTLE_GRACE_MS = 5_000;
let settleGraceMs = DEFAULT_SETTLE_GRACE_MS;

interface Abandonment {
	promise: Promise<void>;
	resolve: () => void;
	armed: boolean;
}

const abandonments = new WeakMap<object, Abandonment>();

function abandonment(sdkQuery: object): Abandonment {
	let entry = abandonments.get(sdkQuery);
	if (!entry) {
		let resolve!: () => void;
		const promise = new Promise<void>((done) => { resolve = done; });
		entry = { promise, resolve, armed: false };
		abandonments.set(sdkQuery, entry);
	}
	return entry;
}

/** Resolves once `sdkQuery` was aborted and its settle grace ran out; never
 *  resolves for a query nobody aborted. consumeQuery races the iterator
 *  against it so teardown cannot hang on a child that never lets go. */
export function sdkQueryAbandoned(sdkQuery: object): Promise<void> {
	return abandonment(sdkQuery).promise;
}

/** Test seam: shorten the settle grace. No argument restores the default. */
export function __testSetSdkSettleGraceMs(ms?: number): void {
	settleGraceMs = ms ?? DEFAULT_SETTLE_GRACE_MS;
}

export function abortSdkQuery(sdkQuery: ReturnType<typeof query>): void {
	void sdkQuery.interrupt().catch(() => {});
	closeSdkQuery(sdkQuery);
	const pending = abandonment(sdkQuery);
	if (pending.armed) return;
	pending.armed = true;
	setTimeout(pending.resolve, settleGraceMs).unref?.();
}

/** Tear down `queryCtx` after its SDK query settled. No-ops when the query is
 *  is not the context's active one (a continuation replaced it, or teardown
 *  already ran). Returns true when teardown actually ran. */
export function teardownQuery(
	queryCtx: QueryContext,
	sdkQuery: unknown,
	cause: ToolCallDrainCause,
	cwd: string,
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

	queryCtx.activeQuery = null;
	return true;
}
