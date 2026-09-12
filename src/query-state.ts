// Query state: QueryContext class + context stack.
//
// All per-query and per-turn mutable state lives here. Reentrant queries
// (subagents) push the parent context onto a stack and get a fresh instance.
//
// Separate from index.ts so tests can import it without activating the extension.

import type { ContentBlockParam } from "@anthropic-ai/sdk/resources";
import type { AssistantMessage, AssistantMessageEventStream, Model } from "@earendil-works/pi-ai";
import { isConnectorTool } from "./connectors.js";
import type { McpResult } from "./extract-tool-results.js";
import { currentRequestLaneId } from "./request-lane.js";

/** A mid-query user run captured for replay after the active query ends.
 *  `text` is the joined text form (previews, and the replay prompt when no
 *  image blocks were captured). `blocks` is present when the run carried
 *  images — the replay must send the blocks or the images are silently lost. */
export interface DeferredUserMessage {
	text: string;
	blocks?: ContentBlockParam[];
}

/** Diag payload for a deferred-message drop: counts, sites, and lengths only.
 *  The messages are user-authored prompt text and the diag log sits outside
 *  any host app's retention boundary, so no content — not even a preview —
 *  may appear in the entry. */
export function summarizeDroppedUserMessages(site: string, dropped: DeferredUserMessage[]): Record<string, unknown> {
	return {
		site,
		count: dropped.length,
		textLengths: dropped.map((message) => message.text.length),
		imageOnlyCount: dropped.filter((message) => !message.text && message.blocks?.length).length,
	};
}

export interface PendingToolCall {
	toolName: string;
	/** The MCP invocation's schema-validated arguments. The SDK hands the handler
	 *  the COMPLETE input, so this is the authoritative copy — the grace-timer
	 *  finalize settles a still-partial streamed block from here instead of from
	 *  its truncated partial JSON (a `{}` settle would make Pi execute
	 *  empty-argument calls). */
	args: Record<string, unknown>;
	/** `QueryContext.callbackGeneration` at registration. A handler from an older
	 *  generation whose id was never forwarded to Pi can never be answered — see
	 *  drainStrandedToolCalls. */
	generation: number;
	resolve: (result: McpResult) => void;
}

// Why pending MCP handlers were drained without a real tool result. A drained
// handler is waiting on a result pi will now never deliver, so the drain must
// resolve as an error — never as a successful result whose text merely says the
// turn died, which a consumer cannot tell apart from a tool that genuinely
// returned that string. The cause is carried because an abort, an idle timeout,
// and a plain end-with-stragglers are different things to act on.
export type ToolCallDrainCause = "abort" | "stream-idle-timeout" | "query-end";

const DRAIN_CAUSE_TEXT: Record<ToolCallDrainCause, string> = {
	"abort": "the turn was aborted",
	"stream-idle-timeout": "the Claude Code stream went idle and the turn timed out",
	"query-end": "the query ended",
};

export function interruptedToolCallResult(cause: ToolCallDrainCause): McpResult {
	return {
		content: [{ type: "text", text: `Claude bridge: ${DRAIN_CAUSE_TEXT[cause]} before this tool call's result was delivered. The call did not complete and produced no output.` }],
		isError: true,
	};
}

// Precedence matches the forceRotate expression at the query-teardown site: an
// explicit abort (pi's signal or our own abort handler) outranks a stream-idle
// timeout, which outranks a plain end with stragglers.
export function toolCallDrainCause(flags: { wasAborted?: boolean; signalAborted?: boolean; streamIdleTimedOut?: boolean }): ToolCallDrainCause {
	if (flags.wasAborted || flags.signalAborted) return "abort";
	if (flags.streamIdleTimedOut) return "stream-idle-timeout";
	return "query-end";
}

/** Resolves every handler still waiting on `queryCtx` with an error result naming
 *  `cause`, clears the map, and returns how many were drained. Scoped to the one
 *  context it is given — never touches a sibling or parent query's handlers. */
export function drainPendingToolCalls(queryCtx: QueryContext, cause: ToolCallDrainCause): number {
	const drained = queryCtx.pendingToolCalls.size;
	if (drained === 0) return 0;
	const result = interruptedToolCallResult(cause);
	for (const pending of queryCtx.pendingToolCalls.values()) pending.resolve(result);
	queryCtx.pendingToolCalls.clear();
	return drained;
}

/** The error a stranded handler resolves with: its call never reached Pi and
 *  the forward paths have marked it dead, so no result can ever arrive and the
 *  call is guaranteed not to have executed on the Pi side. */
export function strandedToolCallResult(): McpResult {
	return {
		content: [{ type: "text", text: "Claude bridge: this tool call was never forwarded to Pi before its turn ended, so it did not execute and no result can arrive. Re-run the tool." }],
		isError: true,
	};
}

/** Fail ONE waiting handler whose call never reached Pi. No-op when the id was
 *  forwarded (Pi owes it a result — steer-split deliveries arrive turns later)
 *  or nothing is waiting. Marks the id dead so a lagging stream replay can
 *  never forward it AFTER the model was told it failed — that late forward
 *  would execute the call a second time behind the model's back.
 *  Returns true when a handler was failed. */
export function failStrandedToolCall(queryCtx: QueryContext, id: string): boolean {
	if (queryCtx.forwardedToolCallIds.has(id)) return false;
	const pending = queryCtx.pendingToolCalls.get(id);
	if (!pending) return false;
	queryCtx.pendingToolCalls.delete(id);
	queryCtx.deadToolCallIds.add(id);
	pending.resolve(strandedToolCallResult());
	return true;
}

/** Fail every waiting handler that provably can never be answered: registered
 *  before the CURRENT provider callback (older `generation`) with an id Pi was
 *  never told about. Runs at the delivery site, where a fresh callback proves
 *  the previous turn is settled. Handlers whose id WAS forwarded stay waiting —
 *  Pi may deliver their result in a later callback (steer-split batches).
 *  Handlers from the current generation stay untouched: their turn is still
 *  streaming and the forward may simply not have happened yet. Failed ids are
 *  marked dead exactly like failStrandedToolCall. */
export function drainStrandedToolCalls(queryCtx: QueryContext): Array<{ id: string; toolName: string }> {
	const stranded: Array<{ id: string; toolName: string }> = [];
	for (const [id, pending] of queryCtx.pendingToolCalls) {
		if (pending.generation >= queryCtx.callbackGeneration) continue;
		if (queryCtx.forwardedToolCallIds.has(id)) continue;
		stranded.push({ id, toolName: pending.toolName });
	}
	for (const { id } of stranded) {
		const pending = queryCtx.pendingToolCalls.get(id)!;
		queryCtx.pendingToolCalls.delete(id);
		queryCtx.deadToolCallIds.add(id);
		pending.resolve(strandedToolCallResult());
	}
	return stranded;
}

/** Consume a result waiting for `id`, checking the live queue first and the
 *  reap-parked store second. Late handlers land here: Pi delivers every result
 *  of a turn in one callback, while the SDK staggers handler invocations, so a
 *  handler can fire after a message boundary already parked its result. */
export function takeQueuedOrParkedResult(queryCtx: QueryContext, id: string): McpResult | undefined {
	const queued = queryCtx.pendingResults.get(id);
	if (queued !== undefined) {
		queryCtx.pendingResults.delete(id);
		return queued;
	}
	const parked = queryCtx.reapedResults.get(id);
	if (parked !== undefined) {
		queryCtx.reapedResults.delete(id);
		return parked;
	}
	return undefined;
}

/** One connector call's audit state for the life of a query. `recorded` means an
 *  entry for it has already been appended (or attempted), so neither a re-yielded
 *  result nor the teardown flush can record it twice. */
export interface ConnectorCallAuditState {
	name: string;
	/** The child session that issued it, captured when the call was seen — a
	 *  continuation query gets its own, and a call is audited against the session
	 *  that actually made it. */
	childSessionId?: string;
	recorded: boolean;
}

export interface TurnToolCallRecord {
	id: string;
	toolName: string;
	arguments: Record<string, unknown>;
}

export interface ClaimedToolCall {
	toolCallId?: string;
	match: "tool-args" | "tool-name" | "none";
	ambiguous: boolean;
	available: number;
	/** True when the claim went through the sole-same-name fallback even though
	 *  the recorded call had (different) arguments. Recorded args come from the
	 *  raw streamed input while the handler receives the MCP server's
	 *  schema-validated copy, so a benign divergence (stripped unknown key,
	 *  applied default) must not strand the call — but it is worth a diagnostic. */
	argsMismatch?: boolean;
}

export interface ToolResultProgress {
	expectedIds: string[];
	deliveredIds: string[];
	resolvedIds: string[];
	waitingIds: string[];
	queuedIds: string[];
	unmatchedResultIds: string[];
	missingDeliveredIds: string[];
	unresolvedIds: string[];
	toolNames: Array<{ name: string; count: number }>;
	expectedCount: number;
	deliveredCount: number;
	resolvedCount: number;
	waitingCount: number;
	queuedCount: number;
	unmatchedResultCount: number;
}

function normalizeForCompare(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(normalizeForCompare);
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			const child = (value as Record<string, unknown>)[key];
			if (child !== undefined) out[key] = normalizeForCompare(child);
		}
		return out;
	}
	return value;
}

function argsKey(value: unknown): string {
	return JSON.stringify(normalizeForCompare(value ?? {}));
}

function sameArgs(left: unknown, right: unknown): boolean {
	return argsKey(left) === argsKey(right);
}

function hasRecordedArgs(args: Record<string, unknown> | undefined): boolean {
	return Object.keys(args ?? {}).length > 0;
}

function unique(values: Iterable<string | undefined>): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		if (!value || seen.has(value)) continue;
		seen.add(value);
		out.push(value);
	}
	return out;
}

export class QueryContext {
	// Query-scoped (fully isolated per query)
	activeQuery: unknown | null = null;
	currentPiStream: AssistantMessageEventStream | null = null;
	latestCursor = 0;
	pendingToolCalls = new Map<string, PendingToolCall>();
	pendingResults = new Map<string, McpResult>();
	/** Results a message-boundary reap moved OUT of pendingResults so they stop
	 *  poisoning mismatch reports, kept CONSUMABLE for a handler that fires later:
	 *  Pi delivers a turn's results in one callback while the SDK staggers handler
	 *  invocations past the next message boundary, so a boundary never proves that
	 *  no consumer will come. Query-scoped, bounded by the query's tool-call count. */
	reapedResults = new Map<string, McpResult>();
	/** Every tool-call id this query has handed to Pi inside an ENDED turn — the
	 *  set endToolUseTurn stamps from the turn's content. A forwarded id is one Pi
	 *  will execute and answer; it must never be emitted again (a lagging stream
	 *  replays the same tool_use into the NEXT turn, and per-message turnBlocks
	 *  dedup cannot see across turns), and a handler waiting on it must be left
	 *  waiting at the stranded-handler drains. Query-scoped, never reset per
	 *  message. */
	forwardedToolCallIds = new Set<string>();
	/** Ids whose waiting handler was resolved with strandedToolCallResult. The
	 *  model has been told these calls failed; forwarding one later would execute
	 *  it behind the model's back, so every forward path skips them. */
	deadToolCallIds = new Set<string>();
	/** Streamed block indexes suppressed as duplicate or dead tool_use blocks —
	 *  their deltas and stops must be ignored the same way child-executed indexes
	 *  are. Per message; reset by resetToolTracking. */
	suppressedStreamIndexes = new Set<number>();
	/** Bumped at every provider callback for this query. Stamped onto handlers at
	 *  registration so the stranded-handler drain can tell "registered before this
	 *  callback, provably settled" from "racing this callback's own stream". */
	callbackGeneration = 0;
	turnToolCallIds: string[] = [];
	turnToolCalls: TurnToolCallRecord[] = [];
	/**
	 * id → Pi tool name for every tool call this QUERY recorded, across all child
	 * messages. Deliberately NOT cleared by resetToolTracking: per-message tracking
	 * resets at every message boundary, but `pendingResults` is query-scoped, so a
	 * result stranded there outlives the message that named it. Without this map a
	 * teardown report can only say "1 queued" with empty toolNames and 0/0
	 * counters — an unactionable record. Bounded by the number of tool calls in
	 * one query.
	 */
	queryToolNames = new Map<string, string>();
	/** id → last-known arguments, query-scoped like queryToolNames and for the
	 *  same reason: a late handler firing after resetToolTracking wiped the
	 *  per-message records must still be able to exact-match the parked/queued
	 *  result of ITS OWN call — without stored args the only fallback is
	 *  sole-same-name, which can hand it a LIVE sibling's id. */
	queryToolArgs = new Map<string, Record<string, unknown>>();
	claimedToolCallIds = new Set<string>();
	deliveredToolResultIds = new Set<string>();
	resolvedToolResultIds = new Set<string>();
	unmatchedToolResultIds = new Set<string>();
	reportedToolResultMismatch = false;
	deferredUserMessages: DeferredUserMessage[] = [];
	handledTerminalError = false;
	// Once visible text/thinking, a complete tool call, or a child-executed
	// connector/foreign-MCP dispatch reaches Pi, the request must never be
	// replayed on another account (duplicate side effects). Query-scoped, not per-turn:
	// resetTurnState must not clear it.
	committedOutput = false;
	/** True when this query holds NO claim on the module-level shared session
	 *  record: a reentrant (subagent) query, or a foreign-conversation one-shot.
	 *  Every shared-record mutation reachable from this context —
	 *  reportToolResultMismatch's needsRebuild/forceRotate mark, the cursor
	 *  advances on the tool-result-delivery and orphaned-result paths — must
	 *  no-op so the PARENT's record stays untouched. Assigned at fresh-query
	 *  setup; deliberately NOT cleared at query end, so a late orphaned tool
	 *  result arriving after this query settled is still attributed to it. */
	detachedFromSharedSession = false;
	/** Armed grace timer for ending a tool_use turn whose terminal stream events
	 *  (message_delta/message_stop) never arrive. The normal path ends the turn at
	 *  message_stop, AFTER message_delta delivered the real output-token count;
	 *  this is the deadlock backstop for streams that go silent instead. Managed
	 *  by schedule/cancelToolUseTurnEnd in assistant-stream.ts. */
	scheduledToolUseEnd: { stream: unknown; timer: ReturnType<typeof setTimeout> } | null = null;

	// Tool calls the CHILD executes itself (see isChildExecutedTool).
	// Deliberately NOT in turnToolCalls/turnToolCallIds: those track calls Pi
	// owes a result for, and Pi owes nothing here. CONNECTORS ONLY — kept so the
	// child's real result can be recognized when it comes back on the SDK's
	// `user` message and audited. A child-internal built-in (ToolSearch et al.)
	// never enters this map: its result needs no recognition and no audit, only
	// its streamed deltas need skipping (childExecutedStreamIndexes below).
	/** tool_use id → raw SDK tool name. */
	childExecutedToolCalls = new Map<string, string>();
	/**
	 * The same calls, for the connector-call audit trail (see connector-audit.ts).
	 *
	 * Query-scoped and deliberately NOT cleared by resetToolTracking: that runs at
	 * every child message boundary, and a call issued in one child message is only
	 * reconciled after that message ends. Clearing it there would make an abandoned
	 * call unrecordable at teardown — which is the one case the trail exists for.
	 */
	connectorCallAudit = new Map<string, ConnectorCallAuditState>();
	/** Claude Code session id for this query, from the SDK's `system` init message.
	 *  Undefined until it arrives; the audit trail omits the field rather than
	 *  guessing. */
	childSessionId: string | undefined;
	/** Anthropic content-block indexes of the current assistant message that carry
	 *  a child-executed tool_use. Scoped to one message: cleared at message_start,
	 *  and an index is released as soon as another block starts there. */
	childExecutedStreamIndexes = new Set<number>();

	// Usage accounting for a Pi turn that spans SEVERAL child assistant messages.
	//
	// Every child message is a separate billed API call, and each reports its own
	// counters — `message_start`/`message_delta` REPLACE rather than accumulate. A
	// Pi turn that ends at its first tool call spans one child message, where
	// replacing is right. A turn containing a child-executed connector call keeps
	// running across the child's follow-up messages, so replacing would silently
	// drop everything the earlier ones billed.
	//
	// So: `turnUsageCarry` holds the totals of the child messages already COMPLETE
	// in this Pi turn, `currentMessageUsage` holds the one in flight, and the Pi
	// message reports their sum. Summing is the correct model for input and cache
	// too — each call bills its own.
	turnUsageCarry = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	currentMessageUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	/** Anthropic id of the child message `currentMessageUsage` describes. */
	currentMessageId: string | undefined;

	/**
	 * Declare which child message the following usage belongs to, banking the
	 * previous one's counters into the turn total.
	 *
	 * Keyed on the MESSAGE ID rather than on the call site, because both paths
	 * that see a message boundary can fire for the SAME message: `message_start`
	 * arrives on the stream, and the SDK then yields that message again in
	 * completed form. Banking per call site double-counted whenever the completed
	 * copy took the no-stream-events branch — which it does whenever a message
	 * produced no content blocks, since `turnSawStreamEvent` only tracks those.
	 *
	 * With no id on either side (older/streamless shapes) this degrades to
	 * banking on every call, which is what each caller means when it cannot
	 * prove otherwise.
	 */
	beginChildMessage(messageId?: unknown): void {
		const id = typeof messageId === "string" && messageId.length > 0 ? messageId : undefined;
		if (id !== undefined && id === this.currentMessageId) return; // same message
		this.turnUsageCarry.input += this.currentMessageUsage.input;
		this.turnUsageCarry.output += this.currentMessageUsage.output;
		this.turnUsageCarry.cacheRead += this.currentMessageUsage.cacheRead;
		this.turnUsageCarry.cacheWrite += this.currentMessageUsage.cacheWrite;
		this.currentMessageUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		this.currentMessageId = id;
	}

	// Per-turn (reset together)
	turnOutput: AssistantMessage | null = null;
	turnStarted = false;
	turnSawStreamEvent = false;
	turnSawToolCall = false;

	get turnBlocks(): Array<any> {
		if (!this.turnOutput) throw new Error("turnBlocks accessed before resetTurnState");
		return this.turnOutput.content;
	}

	resetTurnState(model: Model<any>): void {
		this.turnOutput = {
			role: "assistant", content: [],
			api: model.api, provider: model.provider, model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop", timestamp: Date.now(),
		};
		this.turnStarted = false;
		this.turnSawStreamEvent = false;
		this.turnSawToolCall = false;
		this.handledTerminalError = false;
		// A fresh pi message means the previous turn's stream is done with; an
		// armed end-timer for it must not fire into this turn's state.
		if (this.scheduledToolUseEnd) {
			clearTimeout(this.scheduledToolUseEnd.timer);
			this.scheduledToolUseEnd = null;
		}
		// Usage accounting IS per-Pi-message, so it resets with the message it
		// describes — unlike tool-call tracking below.
		this.turnUsageCarry = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		this.currentMessageUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		this.currentMessageId = undefined;
		// Tool-call tracking is NOT reset here — it persists across the
		// tool-result delivery callback for the same assistant message. Each
		// assistant message boundary calls resetToolTracking() explicitly.
	}

	resetToolTracking(): void {
		this.turnToolCallIds = [];
		this.turnToolCalls = [];
		this.claimedToolCallIds.clear();
		this.deliveredToolResultIds.clear();
		this.resolvedToolResultIds.clear();
		this.unmatchedToolResultIds.clear();
		this.reportedToolResultMismatch = false;
		this.childExecutedToolCalls.clear();
		this.childExecutedStreamIndexes.clear();
		this.suppressedStreamIndexes.clear();
	}

	/** Note a tool_use the child runs itself. `streamIndex` is present only on the
	 *  streamed path, where later deltas/stops for that block must be skipped —
	 *  that skip applies to every child-executed call. Result recognition and the
	 *  connector-call audit apply to CONNECTORS only: a child-internal built-in
	 *  (ToolSearch et al.) is tool plumbing, not account-data access, so nothing
	 *  about it belongs in the audit trail and no result needs matching. */
	noteChildExecutedToolCall(id: string | undefined, rawName: string, streamIndex?: number): void {
		if (isConnectorTool(rawName)) {
			// A connector call is an account-visible side effect the child may run
			// before any Pi-visible event; crossing it permanently forbids account
			// replay even when the result or a later text delta never arrives.
			// Child-internal built-ins (ToolSearch et al.) are pure plumbing and
			// deliberately do NOT commit — an early ToolSearch must not make the
			// whole turn non-rotatable.
			this.markOutputCommitted();
		}
		if (id && isConnectorTool(rawName)) {
			this.childExecutedToolCalls.set(id, rawName);
			// Both emission paths can see the same call (streamed block, then the
			// SDK's completed copy), so never overwrite an existing audit state —
			// that would resurrect one already recorded.
			if (!this.connectorCallAudit.has(id)) {
				this.connectorCallAudit.set(id, {
					name: rawName,
					...(this.childSessionId ? { childSessionId: this.childSessionId } : {}),
					recorded: false,
				});
			}
		}
		if (typeof streamIndex === "number") this.childExecutedStreamIndexes.add(streamIndex);
	}

	recordToolCall(id: string | undefined, toolName: string, args: Record<string, unknown> = {}): void {
		if (!id) return;
		this.queryToolNames.set(id, toolName);
		this.queryToolArgs.set(id, args);
		if (!this.turnToolCallIds.includes(id)) this.turnToolCallIds.push(id);
		const existing = this.turnToolCalls.find((call) => call.id === id);
		if (existing) {
			existing.toolName = toolName;
			existing.arguments = args;
			return;
		}
		this.turnToolCalls.push({ id, toolName, arguments: args });
	}

	updateToolCallArgs(id: string | undefined, args: Record<string, unknown>): void {
		if (!id) return;
		this.queryToolArgs.set(id, args);
		const existing = this.turnToolCalls.find((call) => call.id === id);
		if (existing) existing.arguments = args;
	}

	hasRecordedToolCall(id: string | undefined): boolean {
		return Boolean(id && (this.turnToolCallIds.includes(id) || this.turnToolCalls.some((call) => call.id === id)));
	}

	markOutputCommitted(): void {
		this.committedOutput = true;
	}

	claimToolCall(toolName: string, args: Record<string, unknown> = {}): ClaimedToolCall {
		const unclaimed = this.turnToolCalls.filter((call) => !this.claimedToolCallIds.has(call.id));
		const byName = unclaimed.filter((call) => call.toolName === toolName);
		const exact = byName.filter((call) => sameArgs(call.arguments, args));
		// Ids whose RESULT already sits queued or parked. A handler can fire after
		// the message boundary wiped the per-message records — by then Pi has
		// executed its call and only these query-scoped stores still know it
		// (dropping them at the boundary would make such a handler error out
		// and the model re-run an already-executed side-effectful call). An
		// exact-args match here outranks the live sole-same-name fallback below,
		// so a late handler can never steal a live sibling's id while its own
		// result waits; without an exact match it is only a last resort.
		const resultBacked = [...new Set([...this.pendingResults.keys(), ...this.reapedResults.keys()])]
			.filter((id) => !this.claimedToolCallIds.has(id) && this.queryToolNames.get(id) === toolName);
		const backedExact = resultBacked.filter((id) => sameArgs(this.queryToolArgs.get(id), args));
		const claimBacked = (id: string, viaExact: boolean): ClaimedToolCall => {
			this.claimedToolCallIds.add(id);
			return {
				toolCallId: id,
				match: viaExact ? "tool-args" : "tool-name",
				ambiguous: viaExact && backedExact.length > 1,
				available: unclaimed.length,
				...(!viaExact && hasRecordedArgs(this.queryToolArgs.get(id)) ? { argsMismatch: true } : {}),
			};
		};
		let chosen: TurnToolCallRecord | undefined;
		let match: ClaimedToolCall["match"] = "none";
		let ambiguous = false;

		let argsMismatch = false;
		if (exact.length > 0) {
			chosen = exact[0];
			match = "tool-args";
			ambiguous = exact.length > 1;
		} else if (backedExact.length > 0) {
			return claimBacked(backedExact[0], true);
		} else if (byName.length === 1) {
			// A single unclaimed call of this tool type is the only call this
			// handler can possibly belong to, so claim it even when the recorded
			// arguments differ. Two known benign sources of divergence:
			//   - the SDK can invoke the handler after content_block_start but
			//     before input_json_delta/content_block_stop finalizes arguments,
			//     so the record still holds a partial parse;
			//   - the handler receives the MCP server's schema-VALIDATED copy of
			//     the input (zod may strip unknown keys or apply defaults) while
			//     the record holds the raw streamed input.
			// Refusing here strands the call outright: the handler errors into
			// the child while pi's real result sits queued forever. A same-type
			// sole-candidate claim is strictly safer than that. With
			// SEVERAL same-name candidates and no exact match we still refuse —
			// cross-pairing two live calls is the one outcome worse than failing.
			chosen = byName[0];
			match = "tool-name";
			argsMismatch = hasRecordedArgs(byName[0].arguments);
		}

		// Last resort: nothing live matched and no exact result-backed pairing —
		// a sole result-backed same-name id is still this handler's only possible
		// owner, same reasoning as the live sole-candidate fallback above.
		if (!chosen && resultBacked.length === 1) return claimBacked(resultBacked[0], false);

		if (!chosen) return { match: "none", ambiguous: false, available: unclaimed.length };
		this.claimedToolCallIds.add(chosen.id);
		return { toolCallId: chosen.id, match, ambiguous, available: unclaimed.length, ...(argsMismatch ? { argsMismatch } : {}) };
	}

	/**
	 * Move results still queued in `pendingResults` into the parked store and
	 * report what moved.
	 *
	 * Called at a child MESSAGE boundary (message_start / the no-stream-events
	 * assistant fallback). Left in pendingResults, each entry poisons every later
	 * mismatch report for the whole query (queued>0 with 0/0 counters and no tool
	 * names) and forces a session rebuild per turn. But the boundary does NOT
	 * prove the handler gave up — the SDK staggers handler invocations, and
	 * handlers in a parallel batch routinely fire after it. So the reap parks
	 * instead of dropping: reports stay clean, and a late handler still gets its
	 * real result through takeQueuedOrParkedResult.
	 */
	takeStaleQueuedResults(): Array<{ id: string; toolName: string }> {
		if (this.pendingResults.size === 0) return [];
		const stale = [...this.pendingResults.entries()].map(([id, result]) => {
			this.reapedResults.set(id, result);
			return { id, toolName: this.queryToolNames.get(id) ?? "unknown" };
		});
		this.pendingResults.clear();
		return stale;
	}

	markToolResultDelivered(id: string | undefined): void {
		if (id) this.deliveredToolResultIds.add(id);
	}

	markToolResultResolved(id: string | undefined): void {
		if (id) this.resolvedToolResultIds.add(id);
	}

	markToolResultUnmatched(id: string | undefined): void {
		if (id) this.unmatchedToolResultIds.add(id);
	}

	toolResultProgress(): ToolResultProgress {
		const expectedIds = unique([
			...this.turnToolCalls.map((call) => call.id),
			...this.turnToolCallIds,
		]);
		const deliveredIds = unique(this.deliveredToolResultIds);
		const resolvedIds = unique(this.resolvedToolResultIds);
		const waitingIds = unique(this.pendingToolCalls.keys());
		const queuedIds = unique(this.pendingResults.keys());
		const unmatchedResultIds = unique(this.unmatchedToolResultIds);
		const missingDeliveredIds = expectedIds.filter((id) => !this.deliveredToolResultIds.has(id));
		const unresolvedIds = expectedIds.filter((id) => !this.resolvedToolResultIds.has(id));
		const affectedIds = new Set([...missingDeliveredIds, ...unresolvedIds, ...waitingIds, ...queuedIds, ...unmatchedResultIds]);
		const counts = new Map<string, number>();
		if (affectedIds.size > 0) {
			// Name the affected ids from the query-scoped map, not just this
		// message's records: a queued straggler from a prior child message is
			// exactly the case a mismatch report exists for, and this message's
			// turnToolCalls does not know it.
			for (const id of affectedIds) {
				const name = this.queryToolNames.get(id)
					?? this.turnToolCalls.find((call) => call.id === id)?.toolName
					?? "unknown";
				counts.set(name, (counts.get(name) ?? 0) + 1);
			}
		} else {
			for (const call of this.turnToolCalls) {
				counts.set(call.toolName, (counts.get(call.toolName) ?? 0) + 1);
			}
		}
		return {
			expectedIds,
			deliveredIds,
			resolvedIds,
			waitingIds,
			queuedIds,
			unmatchedResultIds,
			missingDeliveredIds,
			unresolvedIds,
			toolNames: [...counts.entries()]
				.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
				.map(([name, count]) => ({ name, count })),
			expectedCount: expectedIds.length,
			deliveredCount: deliveredIds.length,
			resolvedCount: resolvedIds.length,
			waitingCount: waitingIds.length,
			queuedCount: queuedIds.length,
			unmatchedResultCount: unmatchedResultIds.length,
		};
	}
}

interface QueryLaneState {
	current: QueryContext;
	stack: QueryContext[];
}

interface QueryLaneStoreV1 {
	defaultLane: QueryLaneState;
	sessionLanes: Map<string, QueryLaneState>;
}

const QUERY_LANES_SYMBOL = Symbol.for("kendex.pi.claude-bridge.query-lanes.v1");

function queryLaneStore(): QueryLaneStoreV1 {
	const host = globalThis as Record<symbol, unknown>;
	let store = host[QUERY_LANES_SYMBOL] as QueryLaneStoreV1 | undefined;
	if (!store) {
		store = {
			defaultLane: { current: new QueryContext(), stack: [] },
			sessionLanes: new Map(),
		};
		host[QUERY_LANES_SYMBOL] = store;
	}
	return store;
}

function lane(): QueryLaneState {
	const store = queryLaneStore();
	const sessionId = currentRequestLaneId();
	if (sessionId === undefined) return store.defaultLane;
	let state = store.sessionLanes.get(sessionId);
	if (!state) {
		state = { current: new QueryContext(), stack: [] };
		store.sessionLanes.set(sessionId, state);
	}
	return state;
}

export function ctx(): QueryContext { return lane().current; }

export function stackDepth(): number { return lane().stack.length; }

export function pushContext(): void {
	const state = lane();
	if (!state.current.activeQuery) throw new Error("pushContext() called with no active query");
	state.stack.push(state.current);
	state.current = new QueryContext();
}

export function popContext(): void {
	const state = lane();
	if (state.stack.length === 0) throw new Error("popContext() called with empty stack");
	const parent = state.stack[state.stack.length - 1];
	parent.deferredUserMessages.push(...state.current.deferredUserMessages);
	state.current = state.stack.pop()!;
}

/** Pop the context that belongs to ONE specific query, wherever it sits.
 *
 *  The common case is `target === ctx()` and this is exactly popContext(). The
 *  reason this exists: a reentrant parent query can end ABNORMALLY (abort, child
 *  process death) while its own subagent's context is still pushed above it. A
 *  bare popContext() there would discard the live grandchild's context and
 *  merge the wrong deferred messages. Instead, splice `target` out of the stack
 *  and hand its deferred messages to its own parent (the element below it), so
 *  the still-live contexts above keep their positions and later pops restore
 *  the correct lineage. Returns false when `target` is nowhere in the state —
 *  already popped — so callers can treat that as "someone else tore this down". */
export function popContextFor(target: QueryContext): boolean {
	const state = lane();
	if (state.current === target) {
		popContext();
		return true;
	}
	const idx = state.stack.indexOf(target);
	if (idx < 0) return false;
	const parent = idx > 0 ? state.stack[idx - 1] : undefined;
	parent?.deferredUserMessages.push(...target.deferredUserMessages);
	state.stack.splice(idx, 1);
	return true;
}

// Test-only: drop every lane so test files can start clean.
export function resetStack(): void {
	clearQueryLanes();
}

export function deleteQueryLane(sessionId: string | undefined): void {
	const store = queryLaneStore();
	if (sessionId === undefined) {
		store.defaultLane.current = new QueryContext();
		store.defaultLane.stack.length = 0;
	} else store.sessionLanes.delete(sessionId);
}

export function clearQueryLanes(): void {
	const store = queryLaneStore();
	store.sessionLanes.clear();
	store.defaultLane.current = new QueryContext();
	store.defaultLane.stack.length = 0;
}

export function __testQueryLaneCount(): number {
	return queryLaneStore().sessionLanes.size;
}
