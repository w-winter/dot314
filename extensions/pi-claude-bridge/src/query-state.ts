// Query state: QueryContext class + one current context per request lane.
//
// All per-query and per-turn mutable state lives here. A request that is not
// its lane's callback runs in a lane of its own (requestLaneFor), so a lane
// never holds two queries.
//
// Separate from index.ts so tests can import it without activating the extension.

import { randomUUID } from "node:crypto";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources";
import type { query } from "@anthropic-ai/claude-agent-sdk";
import type { AssistantMessage, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { isConnectorTool } from "./connectors.ts";
import type { McpResult } from "./extract-tool-results.ts";
import { currentRequestLaneId } from "./request-lane.ts";
import { debug, diagDump } from "./debug.ts";
import { noteAnomaly } from "./agent-notice.ts";
import type { RequestTiming, StepTotals } from "./request-timing.ts";
import type { ServedToolServer, ServedToolUpdate } from "./served-tools.ts";
import { UserMessageLedger } from "./user-message-ledger.ts";

/** A mid-query user run captured for replay after the active query ends.
 *  `text` is the joined text form (previews, and the replay prompt when no
 *  image blocks were captured). `blocks` is present when the run carried
 *  images — the replay must send the blocks or the images are silently lost. */
export interface DeferredUserMessage {
	text: string;
	blocks?: ContentBlockParam[];
}

export interface QueryRestartRequest {
	model: Model<any>;
	context: Context;
	options: SimpleStreamOptions | undefined;
	stream: AssistantMessageEventStream;
	/** The debug timing record of the callback whose stream the restart answers. */
	timing?: RequestTiming;
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
// a restart on Pi's replaced history and a plain end-with-stragglers are
// different things to act on.
export type ToolCallDrainCause = "abort" | "history-restart" | "stream-idle-timeout" | "query-end";

const DRAIN_CAUSE_TEXT: Record<ToolCallDrainCause, string> = {
	"abort": "the turn was aborted",
	"history-restart": "the bridge restarted the query on Pi's replaced history",
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
// explicit abort (pi's signal or our own abort handler) outranks a restart on
// Pi's replaced history (a pending restartRequest), which outranks a
// stream-idle timeout, which outranks a plain end with stragglers.
export function toolCallDrainCause(flags: { wasAborted?: boolean; signalAborted?: boolean; historyRestart?: boolean; streamIdleTimedOut?: boolean }): ToolCallDrainCause {
	if (flags.wasAborted || flags.signalAborted) return "abort";
	if (flags.historyRestart) return "history-restart";
	if (flags.streamIdleTimedOut) return "stream-idle-timeout";
	return "query-end";
}

/** Resolves every handler still waiting on `queryCtx` with an error result naming
 *  `cause`, clears the map, and returns how many were drained. Scoped to the one
 *  context it is given — never touches a sibling or parent query's handlers.
 *  A drain at "abort" or "history-restart" is expected cleanup: an abort answers
 *  calls the user cancelled, and a restart on Pi's replaced history
 *  (restartOnReplacedHistory) re-imports Pi's history, tool results included,
 *  into a rotated session, so the drained answer reaches only the discarded
 *  child. A drain at any other cause gives Claude an error for a call that
 *  did not complete. */
export function drainPendingToolCalls(queryCtx: QueryContext, cause: ToolCallDrainCause): number {
	const drained = queryCtx.pendingToolCalls.size;
	if (drained === 0) return 0;
	const result = interruptedToolCallResult(cause);
	if (cause !== "abort" && cause !== "history-restart") noteAnomaly("tool_calls_interrupted");
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
	diagDump("tool_handler_stranded", { toolCallId: id, toolName: pending.toolName, site: "finalize-no-stream" });
	noteAnomaly("tool_handler_stranded");
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
	if (stranded.length === 0) return stranded;
	diagDump("tool_handlers_stranded", { count: stranded.length, stranded });
	noteAnomaly("tool_handlers_stranded");
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
	match: "tool-use-id" | "tool-args" | "tool-name" | "none";
	ambiguous: boolean;
	available: number;
	/** True when the claim went through the sole-same-name fallback even though
	 *  the recorded call had (different) arguments. Recorded args come from the
	 *  raw streamed input while the handler receives the MCP server's
	 *  schema-validated copy, so a benign divergence (stripped unknown key,
	 *  applied default) must not strand the call — but it is worth a diagnostic. */
	argsMismatch?: boolean;
	/** Claimed by tool_use id before the stream recorded the call, so the claim
	 *  recorded it. */
	recordedAhead?: boolean;
}

/** How a tools/call tagged with a tool_use id relates to that id; see
 *  QueryContext.claimToolUseId. */
export type ToolUseIdClaim =
	| { outcome: "claimed"; claim: ClaimedToolCall }
	| { outcome: "waiting" | "dead" | "answered" | "withdrawn" }
	| { outcome: "other-tool"; recordedName: string };

/** Token counters of one or more child messages; see `QueryContext.turnUsageCarry`. */
interface UsageCounters {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning?: number;
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
	activeQuery: ReturnType<typeof query> | null = null;
	currentPiStream: AssistantMessageEventStream | null = null;
	/** Pi replaced the history while this query was active. Its next callback
	 *  must use the new context instead of resuming the stale Claude session. */
	piHistoryReplaced = false;
	reportedHistoryRestartDecline = false;
	restartRequest: QueryRestartRequest | null = null;
	latestCursor = 0;
	/** historyDigest of the callback context slice [0, latestCursor): the
	 *  digest a record persisted at that cursor must carry. */
	latestCursorDigest: string | undefined = undefined;
	/** A callback context no longer matched the history Claude holds (the
	 *  record's or this query's own digest) — an extension or Pi context edit
	 *  rewrote it mid-query. The record this query persists must rebuild. */
	priorHistoryRewritten = false;
	/** Every reply this query handed Pi (tool-use turns and the final reply),
	 *  in delivery order, with the digest of the exact copy Pi received: what
	 *  Claude's history gained. A callback's new suffix must be exactly these
	 *  (history-digest.ts deliveredSuffix). Query-scoped, cleared at
	 *  fresh-query setup. */
	deliveredAssistants: Array<{ digest: string; callIds: string[] }> = [];
	/** How many of deliveredAssistants, and which tool results, the verified
	 *  claim (latestCursor/latestCursorDigest) already covers. */
	claimedAssistants = 0;
	claimedResultIds = new Set<string>();
	/** User messages this query owns: its starting history, plus every one it
	 *  queued for replay or handed to a rebuild. Identity-based, because a
	 *  callback context's positions need not match the starting context's. */
	ownedUserMessages = new UserMessageLedger();
	/** Tool-result ids delivered by an EARLIER provider callback of this query.
	 *  One of them in a callback context is something the query already knew,
	 *  so it can anchor the old/new split of unknown user messages (see
	 *  UserMessageLedger.classify). Updated after a callback's user messages
	 *  are classified, so that callback's own results are never anchors.
	 *  Query-scoped, cleared at fresh-query setup. */
	acknowledgedToolResultIds = new Set<string>();
	/** A mid-query user message could not be identified (see
	 *  UserMessageLedger.classify), so a rebuild owns it: the record this query
	 *  persists must carry needsRebuild. */
	userInputNeedsRebuild = false;
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
	/** Ids whose MCP invocation has arrived or can no longer arrive: the handler
	 *  ran, the SDK answered the call without it (input validation), or Claude
	 *  Code reported a result for it. Query-scoped, unlike claimedToolCallIds: a
	 *  forwarded call missing here can still be invoked late, and the SDK
	 *  validates that invocation against the schema its tool is registered with
	 *  at that moment (see served-tools.ts). */
	settledInvocationIds = new Set<string>();
	/** Calls Claude Code answered on its own while their handler was still
	 *  waiting on Pi (a CC-side limit gave up on them), keyed by id. Pi is still
	 *  running the tool; its result can no longer reach Claude. Query-scoped and
	 *  kept past query end, so a result that arrives as an orphan is still
	 *  recognised; cleared at fresh-query setup. */
	abandonedToolCalls = new Map<string, { toolName: string; reason: string }>();

	/** Whether `toolName` has a forwarded call whose MCP invocation has not arrived. */
	awaitsInvocation(toolName: string): boolean {
		for (const id of this.forwardedToolCallIds) {
			if (this.settledInvocationIds.has(id) || this.deadToolCallIds.has(id)) continue;
			if (this.queryToolNames.get(id) === toolName) return true;
		}
		return false;
	}

	/** Records that `ids` can no longer be invoked late and applies any
	 *  served-tool redefinition that was waiting on them. Returns the re-list
	 *  hold when that changed the served tools, else null. */
	settleInvocations(ids: Iterable<string>): Promise<void> | null {
		for (const id of ids) this.settledInvocationIds.add(id);
		const redefined = this.servedTools?.retryDeferred();
		if (!redefined) return null;
		debug("served tools: applied a postponed redefinition; holding tool results for Claude Code's re-list");
		return this.holdResultsForRelist(redefined);
	}

	/** Sets `servedToolsSettling` until `update` settles, chained behind any
	 *  earlier change still settling so results wait for both. */
	holdResultsForRelist(update: Promise<ServedToolUpdate>): Promise<void> {
		const previous = this.servedToolsSettling;
		const settling: Promise<void> = Promise.all([previous, update]).then(([, outcome]) => {
			debug(`served tools: ${outcome === "relisted" ? "Claude Code re-listed" : outcome === "timeout" ? "no re-list within the cap; delivering anyway" : "no client connected"}`);
		}, (error) => debug("served tools: update failed; delivering anyway:", error)).finally(() => {
			if (this.servedToolsSettling === settling) this.servedToolsSettling = null;
		});
		this.servedToolsSettling = settling;
		return settling;
	}
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
	/** Ids claimed by a tools/call tagged with them. Query-scoped: the handler
	 *  can run before the stream records its tool_use, and message_start's
	 *  resetToolTracking must not drop that ownership (name/args claims skip
	 *  these ids). Cleared at fresh-query setup. */
	taggedToolCallIds = new Set<string>();
	/** Tagged ids whose handler recorded the call before the stream did, in
	 *  arrival order, plus waiting ones whose partial block a stream retry
	 *  discarded: the grace finalizer forwards those still waiting. */
	earlyToolCallIds = new Set<string>();
	/** id → the answer its invoked handler will return, from its claim until
	 *  it returns. A re-list can hold a result after its handler left
	 *  pendingToolCalls, so a duplicate tools/call joins this instead. */
	answeringToolCalls = new Map<string, Promise<McpResult>>();
	deliveredToolResultIds = new Set<string>();
	resolvedToolResultIds = new Set<string>();
	unmatchedToolResultIds = new Set<string>();
	reportedToolResultMismatch = false;
	deferredUserMessages: DeferredUserMessage[] = [];
	/** The query a live steering write is in flight on (tool-result-delivery.ts),
	 *  from the streamInput() call until Claude Code acknowledged the write or
	 *  it failed. A steer arriving meanwhile is deferred, never written
	 *  concurrently. Cleared at fresh-query setup. */
	steeringWriteQuery: ReturnType<typeof query> | null = null;
	/** Bumped only at fresh-query setup. An async continuation acts on the
	 *  record only while no newer query has claimed this context. */
	queryGeneration = 0;
	handledTerminalError = false;
	/** The bridge's own abort path ran for this query (onAbort). */
	abortRequested = false;
	/** The query's abort handling (stream setup's onAbort), run when any
	 *  signal it listens to aborts. */
	onRequestAbort: (() => void) | null = null;
	/** Every AbortSignal of a Pi provider call that joined this query, with
	 *  its listener. Pi creates one signal per agent run, and one query can
	 *  span runs (a run ended by a terminate:true tool batch, then
	 *  agent.continue()), so a later callback's signal must cancel it too. */
	private readonly abortSignals = new Map<AbortSignal, () => void>();

	/** Cancel this query when `signal` aborts, or now if it already has.
	 *  Called for the query's own request and for every callback that joins
	 *  it; removed together when the query ends (stopListeningForAbort). */
	listenForAbort(signal: AbortSignal | undefined): void {
		const onAbort = this.onRequestAbort;
		if (!signal || !onAbort || this.abortSignals.has(signal)) return;
		const listener = (): void => onAbort();
		this.abortSignals.set(signal, listener);
		if (signal.aborted) listener();
		else signal.addEventListener("abort", listener, { once: true });
	}

	/** Drop every abort subscription: no signal of this query may cancel a
	 *  later one. */
	stopListeningForAbort(): void {
		for (const [signal, listener] of this.abortSignals) signal.removeEventListener("abort", listener);
		this.abortSignals.clear();
	}

	/** Keep the failure this ended query holds for its tool-result callback
	 *  (undeliveredFailure) only while that callback can still come: a run
	 *  cancelled after the query ended delivers none, and a cancelled
	 *  callback never reports it. Watches every signal the query listened
	 *  to; call before stopListeningForAbort. `dropped` runs once the hold
	 *  goes this way. */
	dropHeldFailureOnAbort(dropped: () => void): void {
		const held = this.undeliveredFailure;
		if (!held) return;
		for (const signal of this.abortSignals.keys()) {
			const drop = (): void => {
				if (this.undeliveredFailure !== held) return;
				this.undeliveredFailure = null;
				dropped();
			};
			if (signal.aborted) drop();
			else signal.addEventListener("abort", drop, { once: true });
		}
	}

	/** Whether this query's request was cancelled. Every failure ender reads
	 *  this instead of trusting its call site (endStreamForFailure). */
	requestAborted(): boolean {
		if (this.abortRequested) return true;
		for (const signal of this.abortSignals.keys()) if (signal.aborted) return true;
		return false;
	}

	/** The signals of the Pi runs this query currently serves. */
	runSignals(): Set<AbortSignal> {
		return new Set(this.abortSignals.keys());
	}
	// Once visible text/thinking, a complete tool call, or a child-executed
	// connector/foreign-MCP dispatch reaches Pi, the request must never be
	// replayed on another account (duplicate side effects). Query-scoped, not per-turn:
	// resetTurnState must not clear it.
	committedOutput = false;
	/** True when this query holds NO claim on the module-level shared session
	 *  record: a foreign-conversation one-shot, or a query quarantined after
	 *  an abort or stream-idle timeout.
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
	scheduledToolUseEnd: {
		stream: unknown;
		timer: ReturnType<typeof setTimeout>;
		fire: () => void;
		/** What the grace runs when it elapses. */
		action: () => void;
		/** The same finalizer with its silence count back at zero: stream
		 *  activity swaps it in, so only CONSECUTIVE silence spends the budget. */
		fresh?: () => void;
	} | null = null;

	/** The query's live MCP tool server (null when it serves no tools) and the
	 *  SDK→Pi name map consumeQuery reads. The map is updated IN PLACE with the
	 *  served set: continuation queries reuse both. */
	servedTools: ServedToolServer | null = null;
	servedToolNameToPi: Map<string, string> | null = null;
	/** Set while a served-tool change waits for Claude Code to re-list. Tool
	 *  results are released only after it settles, or CC's next request would
	 *  still carry the old tool set. */
	servedToolsSettling: Promise<void> | null = null;

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
	/** Child-loaded MCP calls absent from Pi's transcript. A history restart
	 *  cannot reconstruct them, even if their results arrived in Claude Code. */
	foreignMcpCalls = new Map<string, string>();
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
	// `reasoning` stays undefined until the child reports thinking tokens, so Pi
	// can tell "no breakdown" from zero.
	turnUsageCarry: UsageCounters = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	currentMessageUsage: UsageCounters = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
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
		if (this.currentMessageUsage.reasoning !== undefined) {
			this.turnUsageCarry.reasoning = (this.turnUsageCarry.reasoning ?? 0) + this.currentMessageUsage.reasoning;
		}
		this.currentMessageUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		this.currentMessageId = id;
	}

	/**
	 * Declare that `messageId` REPLACES the in-flight child message instead of
	 * following it: Claude Code retried an abandoned attempt. The abandoned
	 * attempt's counters are dropped rather than banked. Pi reads the last
	 * assistant message's input and cache figures as the context size, and
	 * banking both attempts would double it.
	 */
	replaceChildMessage(messageId?: unknown): void {
		this.currentMessageUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		this.currentMessageId = typeof messageId === "string" && messageId.length > 0 ? messageId : undefined;
	}

	// Per-turn (reset together)
	turnOutput: AssistantMessage | null = null;
	turnStarted = false;
	turnSawStreamEvent = false;
	turnSawToolCall = false;
	/**
	 * The streamed API attempt the current child message is being rendered
	 * from: its message id, whether it has completed (message_delta or
	 * message_stop), and the content indexes its blocks occupy in turnBlocks.
	 *
	 * An attempt still OPEN when another one begins was abandoned by Claude
	 * Code: a stalled stream is retried as a new stream (a second
	 * message_start) or as one non-streamed request, whose completed assistant
	 * message arrives under a DIFFERENT id with no stream events of its own.
	 * The abandoned attempt's blocks were never completed, and Pi has already
	 * seen them (see discardAbandonedAttempt in assistant-stream.ts).
	 */
	streamAttempt: { id: string | undefined; open: boolean; slots: number[] } | null = null;
	/** Id of the non-streamed replacement message rendered in this Pi turn, so
	 *  its re-yields render only the blocks not rendered yet. */
	fallbackMessageId: string | undefined;
	/**
	 * This Pi message as the running deferred continuation found it
	 * (markContinuationStart in assistant-stream.ts): the blocks earlier SDK
	 * queries rendered and their stop reason. A failure of the continuation
	 * ends the Pi message with the completed replies among them; duplicate
	 * render checks compare only against the blocks outside them. Null outside
	 * a continuation, and cleared with the message it describes.
	 */
	continuationStart: { output: AssistantMessage; priorBlocks: object[]; stopReason: AssistantMessage["stopReason"] } | null = null;
	/**
	 * A terminal failure that ended this query after its last Pi turn (a tool
	 * call) was already delivered. That turn must not change, so the
	 * tool-result callback that directly follows reports the failure as its
	 * own error message. `toolCallIds` are the calls this query handed to Pi:
	 * only a callback answering one of them reports it. Survives
	 * resetTurnState and teardown; cleared at fresh-query setup and by the
	 * next orphaned tool-result callback.
	 * `runSignals` are the signals of the Pi runs the query served when it
	 * failed. Pi 0.87.1 hands one signal per agent run to every provider call
	 * of that run, so a callback carrying one belongs to the same run: its
	 * context may end in a steer Pi appended after the results and still be
	 * the callback that follows, while a later run's new prompt is not.
	 */
	undeliveredFailure: { errorMessage: string; fields?: Record<string, unknown>; toolCallIds: Set<string>; runSignals: Set<AbortSignal> } | null = null;
	/** A fresh request is waiting for its forked rebuild (session-persistence.ts
	 *  rebuildFromNativePrefix) before it starts its query. The lane is in use
	 *  meanwhile, though no query runs yet. */
	forkSyncPending = false;
	/** Debug only (request-timing.ts): the timing record of this context's
	 *  current or latest Pi request, and steps that ran while none was live. */
	timing: RequestTiming | undefined = undefined;
	timingCarry: StepTotals | undefined = undefined;

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
		this.streamAttempt = null;
		this.fallbackMessageId = undefined;
		this.continuationStart = null;
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

	/** Start another SDK query within the same live Pi request. Unlike
	 * resetTurnState, keeps the accumulated Pi message and usage: deferred replay
	 * can add several Claude replies before Pi's single terminal event. Per-query
	 * flags reset so a streamless continuation is not mistaken for the prior reply. */
	prepareContinuation(): void {
		this.turnSawStreamEvent = false;
		this.turnSawToolCall = false;
		this.handledTerminalError = false;
		// A new Claude Code query: its first message is not a retry of the last
		// query's.
		this.streamAttempt = null;
		this.fallbackMessageId = undefined;
		this.resetToolTracking();
		// The Claude Code process that was issued these calls has finished, so
		// none of them can be invoked late any more.
		this.settleInvocations(this.forwardedToolCallIds);
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

	/** Drop the per-message records of calls that will never be dispatched
	 *  (a discarded abandoned attempt's): nothing may claim them, and a
	 *  mismatch report must not expect a result for them. */
	forgetToolCalls(ids: Iterable<string>): void {
		const forget = new Set(ids);
		if (forget.size === 0) return;
		this.turnToolCallIds = this.turnToolCallIds.filter((id) => !forget.has(id));
		this.turnToolCalls = this.turnToolCalls.filter((call) => !forget.has(call.id));
	}

	markOutputCommitted(): void {
		this.committedOutput = true;
	}

	noteForeignMcpToolCall(id: string | undefined, name: string): void {
		this.markOutputCommitted();
		if (id) this.foreignMcpCalls.set(id, name);
	}

	/** Claims a tools/call that carries no tool_use id, by name and arguments.
	 *  Never takes an id a tagged call owns. */
	claimToolCall(toolName: string, args: Record<string, unknown> = {}): ClaimedToolCall {
		const unclaimed = this.turnToolCalls.filter((call) => this.claimableByMatch(call.id));
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
			.filter((id) => this.claimableByMatch(id) && this.queryToolNames.get(id) === toolName);
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

	private claimableByMatch(id: string): boolean {
		return !this.claimedToolCallIds.has(id) && !this.taggedToolCallIds.has(id);
	}

	/** Claims the id Claude Code tagged a tools/call with. A tagged call only
	 *  ever touches its own id; any outcome but "claimed" is answered without
	 *  claiming anything. The handler can run before the stream records its
	 *  tool_use, so an unknown id of a served tool is recorded here, and the
	 *  stream's record of it merges in. */
	claimToolUseId(id: string, toolName: string, args: Record<string, unknown>): ToolUseIdClaim {
		if (this.answeringToolCalls.has(id)) return { outcome: "waiting" };
		if (this.deadToolCallIds.has(id)) return { outcome: "dead" };
		// The handler settles its id as it claims it; Claude Code's own answer
		// and a finished Claude Code process settle it too.
		if (this.settledInvocationIds.has(id)) return { outcome: "answered" };
		const recordedName = this.queryToolNames.get(id);
		if (recordedName !== undefined && recordedName !== toolName) return { outcome: "other-tool", recordedName };
		const recordedAhead = recordedName === undefined;
		if (recordedAhead) {
			if (this.servedTools && !this.servedTools.serves(toolName)) return { outcome: "withdrawn" };
			this.recordToolCall(id, toolName, args);
			this.earlyToolCallIds.add(id);
		}
		const available = this.turnToolCalls.filter((call) => this.claimableByMatch(call.id)).length;
		this.claimedToolCallIds.add(id);
		this.taggedToolCallIds.add(id);
		return { outcome: "claimed", claim: { toolCallId: id, match: "tool-use-id", ambiguous: false, available, ...(recordedAhead ? { recordedAhead } : {}) } };
	}

	/** Records `answer` as what `id`'s handler returns until it settles. */
	trackAnswer(id: string, answer: Promise<McpResult>): Promise<McpResult> {
		this.answeringToolCalls.set(id, answer);
		const returned = (): void => {
			if (this.answeringToolCalls.get(id) === answer) this.answeringToolCalls.delete(id);
		};
		answer.then(returned, returned);
		return answer;
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
	// Always empty here. It stays in the shape because every loaded copy of
	// the bridge shares this store (QUERY_LANES_SYMBOL), and a copy from before
	// lanes forked foreign requests still reads it, for example one whose
	// query outlives a /reload.
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

/** The current lane's context, without creating the lane. */
export function peekCtx(): QueryContext | undefined { return peekQueryContext(currentRequestLaneId()); }

/** Take `target` out of its lane NOW instead of when its SDK iterator settles,
 *  so the next provider call starts a fresh query rather than being routed
 *  into a query that is shutting down as a tool-result/steer callback. No-op
 *  unless `target` is still the lane's current context. */
export function detachContext(target: QueryContext): void {
	const state = lane();
	if (state.current !== target) return;
	state.current = new QueryContext();
	// An orphaned tool result from a detached one-shot must stay attributed to it.
	state.current.detachedFromSharedSession = target.detachedFromSharedSession;
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
	forkLaneStore().clear();
}

export function __testQueryLaneCount(): number {
	return queryLaneStore().sessionLanes.size;
}

// --- Which query a provider request belongs to ---
//
// A lane is keyed by the request's sessionId, and nothing stops two
// conversations from sharing that key: every ctx.modelRegistry caller that
// omits sessionId lands in the one default lane, and an extension may pass its
// parent's id to a reviewer it runs while the parent waits on a tool. So the
// key alone never proves that a request continues the lane's running query.
// Only its own callbacks do that, and each one carries the proof: Pi calls
// back to deliver the results of tool calls the query handed it, and those
// call ids are unique to the query (forwardedToolCallIds). Pruners and
// context edits keep them, as does a compacted or fully replaced context,
// because Pi always ends a callback with the results it is delivering.
//
// A request without that proof, while its lane's query runs, gets a FORK lane
// of its own: a fresh query with its own QueryContext and session record,
// never touching the running one. Its callbacks find their way back by the
// same proof. A fork is released when its query settles (index.ts).
//
// While the lane is idle, a request runs in it unless the evidence shows it
// belongs to another conversation: a tool result for a call no query of the
// lane handed to Pi, or the lane's record naming another conversation (the
// caller's fingerprint check). Such a request gets a fork too, so it never
// resets the idle conversation's query state or marks its record.

/** Fork lane id -> the lane key it was opened from. Process-global like the
 *  lane store, for the same reason: parent and child agents can reach the
 *  bridge through different module instances. */
const FORK_LANES_SYMBOL = Symbol.for("kendex.pi.claude-bridge.fork-lanes.v1");
const FORK_LANE_PREFIX = "claude-bridge:fork:";

function forkLaneStore(): Map<string, { base: string | undefined }> {
	const host = globalThis as Record<symbol, unknown>;
	let store = host[FORK_LANES_SYMBOL] as Map<string, { base: string | undefined }> | undefined;
	if (!store) {
		store = new Map();
		host[FORK_LANES_SYMBOL] = store;
	}
	return store;
}

/** The current context of lane `laneId`, without creating the lane. */
function peekQueryContext(laneId: string | undefined): QueryContext | undefined {
	const store = queryLaneStore();
	return laneId === undefined ? store.defaultLane.current : store.sessionLanes.get(laneId)?.current;
}

/** Every tool-call id a provider context carries: assistant tool calls and
 *  tool results. */
function contextToolCallIds(messages: ReadonlyArray<unknown>): string[] {
	const ids: string[] = [];
	for (const message of messages as ReadonlyArray<{ role?: unknown; content?: unknown; toolCallId?: unknown } | null | undefined>) {
		if (message?.role === "toolResult" && typeof message.toolCallId === "string") ids.push(message.toolCallId);
		else if (message?.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content as Array<{ type?: unknown; id?: unknown } | null | undefined>) {
				if (block?.type === "toolCall" && typeof block.id === "string") ids.push(block.id);
			}
		}
	}
	return ids;
}

/** Whether `queryCtx`'s query handed Pi one of `ids`. */
function handedToPi(queryCtx: QueryContext, ids: readonly string[]): boolean {
	return ids.some((id) => queryCtx.forwardedToolCallIds.has(id));
}

/** The lane a provider request with `sessionId` and `messages` runs in:
 *  - the lane (or a fork of it) whose query handed Pi a tool call the context
 *    carries: the request is that query's callback, running or ended;
 *  - otherwise the `sessionId` lane itself while its conversation is idle,
 *    unless the request ends with a tool result (a callback no query of the
 *    lane owns) or `otherConversation(sessionId)` says the lane's record
 *    belongs to another conversation;
 *  - otherwise a new fork lane: another conversation's request (or one that
 *    cannot prove it is not), which must not join or disturb the lane's.
 *  A conversation is still mid-turn after its query ended with a failure held
 *  for the tool-result callback (E3): a fresh query in its lane would drop
 *  that failure. Its own next prompt still carries the call and joins. */
export function requestLaneFor(
	sessionId: string | undefined,
	messages: ReadonlyArray<unknown>,
	otherConversation: (laneId: string | undefined) => boolean = () => false,
): string | undefined {
	const own = peekQueryContext(sessionId);
	const ids = contextToolCallIds(messages);
	if (ids.length > 0) {
		if (own && handedToPi(own, ids)) return sessionId;
		for (const [forkId, fork] of forkLaneStore()) {
			if (fork.base !== sessionId) continue;
			const forkCtx = peekQueryContext(forkId);
			if (forkCtx && handedToPi(forkCtx, ids)) return forkId;
		}
	}
	const reason = contextInUse(own) ? "its lane is busy"
		: (messages.at(-1) as { role?: unknown } | undefined)?.role === "toolResult" ? "its tool result answers no call of its lane"
		: otherConversation(sessionId) ? "its lane holds another conversation"
		: undefined;
	if (reason === undefined) return sessionId;
	const forkId = `${FORK_LANE_PREFIX}${randomUUID()}`;
	forkLaneStore().set(forkId, { base: sessionId });
	debug(`provider: request (session ${sessionId === undefined ? "none" : sessionId.slice(0, 8)}) is not its lane's callback and ${reason}; running it as its own query in ${forkId}`);
	return forkId;
}

/** The Pi session request lane `laneId` serves: a fork lane's base, else
 *  the lane itself. */
export function piSessionOfLane(laneId: string | undefined): string | undefined {
	const fork = laneId === undefined ? undefined : forkLaneStore().get(laneId);
	return fork ? fork.base : laneId;
}

export function isForkLane(laneId: string | undefined): boolean {
	return laneId !== undefined && forkLaneStore().has(laneId);
}

export function releaseForkLane(laneId: string): void {
	forkLaneStore().delete(laneId);
}

/** Whether lane `laneId` is still in use: a query in it is running (the
 *  original one, or a restart or account retry that replaced it), a fresh
 *  request waits for its forked rebuild before starting one
 *  (QueryContext.forkSyncPending), or its ended query holds a terminal
 *  failure for a tool-result callback that has not arrived yet
 *  (QueryContext.undeliveredFailure). A lane's lifetime
 *  belongs to the query that owns it, never to whichever provider call's
 *  Pi stream happens to end first. */
export function laneInUse(laneId: string | undefined): boolean {
	return contextInUse(peekQueryContext(laneId));
}

/** laneInUse for a lane's context: routing (requestLaneFor) and lane release
 *  ask the same question. */
function contextInUse(queryCtx: QueryContext | undefined): boolean {
	return Boolean(queryCtx && (queryCtx.activeQuery !== null || queryCtx.forkSyncPending || queryCtx.undeliveredFailure));
}

export function __testForkLaneCount(): number {
	return forkLaneStore().size;
}
