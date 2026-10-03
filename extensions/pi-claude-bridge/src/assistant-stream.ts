import { calculateCost, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { appendIntegrityEntry, safeNotify } from "./bridge-state.ts";
import { connectorResultByteSize, recordConnectorCallResult } from "./connector-audit.ts";
import { isChildExecutedTool } from "./connectors.ts";
import { DEBUG, debug, diagDump } from "./debug.ts";
import { noteAnomaly } from "./agent-notice.ts";
import { deliveredAssistantDigest } from "./history-digest.ts";
import { ctx, failStrandedToolCall, type QueryContext } from "./query-state.ts";
import { DEFAULT_STREAM_IDLE_TIMEOUT_MS } from "./stream-idle-watchdog.ts";
import { thirdPartyAppHintFor, withThirdPartyAppHint, withoutThirdPartyAppHint } from "./third-party-rejection.ts";
import { isForeignMcpTool, isPiDispatchable, mapToolArgs, mapToolName } from "./tool-mapping.ts";

// --- Usage helpers ---

type SdkUsage = {
	input_tokens?: number | null;
	output_tokens?: number | null;
	cache_read_input_tokens?: number | null;
	cache_creation_input_tokens?: number | null;
	output_tokens_details?: { thinking_tokens?: number | null } | null;
};

function updateUsage(output: AssistantMessage, usage: SdkUsage, model: Model<any>, c: QueryContext): void {
	// Anthropic reports per-message counters and RE-reports them as the message
	// grows, so the in-flight message's figures replace, never accumulate. What
	// accumulates is every child message already finished in this Pi turn — see
	// `turnUsageCarry` in query-state.ts for why a turn can span several.
	const current = c.currentMessageUsage;
	const carry = c.turnUsageCarry;
	if (usage.input_tokens != null) current.input = usage.input_tokens;
	if (usage.output_tokens != null) current.output = usage.output_tokens;
	if (usage.cache_read_input_tokens != null) current.cacheRead = usage.cache_read_input_tokens;
	if (usage.cache_creation_input_tokens != null) current.cacheWrite = usage.cache_creation_input_tokens;
	// Thinking tokens are a subset of output: reported for Pi's display, never
	// added to the total or cost.
	const thinking = usage.output_tokens_details?.thinking_tokens;
	if (thinking != null) current.reasoning = thinking;
	output.usage.input = carry.input + current.input;
	output.usage.output = carry.output + current.output;
	output.usage.cacheRead = carry.cacheRead + current.cacheRead;
	output.usage.cacheWrite = carry.cacheWrite + current.cacheWrite;
	if (carry.reasoning !== undefined || current.reasoning !== undefined) {
		output.usage.reasoning = (carry.reasoning ?? 0) + (current.reasoning ?? 0);
	}
	output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
	calculateCost(model, output.usage);
	if (!DEBUG) return;
	const promptTokens = output.usage.input + output.usage.cacheRead + output.usage.cacheWrite;
	const cachePct = promptTokens > 0 ? Math.round(output.usage.cacheRead / promptTokens * 100) : 0;
	const line = `usage: in=${output.usage.input} out=${output.usage.output} reasoning=${output.usage.reasoning ?? "-"} cacheRead=${output.usage.cacheRead} cacheWrite=${output.usage.cacheWrite} total=${output.usage.totalTokens} cachePct=${cachePct}% model=${model.id}`;
	// Anthropic re-reports unchanged counters; a repeat of the request's last
	// line says nothing new (request-timing.ts counts it instead).
	const timing = c.timing;
	if (timing) {
		if (timing.lastUsageLine === line) {
			timing.usageRepeats += 1;
			return;
		}
		timing.lastUsageLine = line;
	}
	debug(line);
}

// --- Provider helpers: misc ---

function mapStopReason(reason: string | undefined): "stop" | "length" | "toolUse" {
	switch (reason) {
		case "tool_use": return "toolUse";
		case "max_tokens": return "length";
		case "end_turn": default: return "stop";
	}
}

export function parsePartialJson(input: string, fallback: Record<string, unknown>): Record<string, unknown> {
	if (!input) return fallback;
	try { return JSON.parse(input); } catch { return fallback; }
}

// Both take the query context explicitly (defaulting to the live one) so the
// completion/teardown closures in index.ts can finalize the stream of the query
// they were created for — after a quarantine the live ctx() is a new query's.
export function ensureTurnStarted(c: QueryContext = ctx()): void {
	if (!c.turnStarted && c.currentPiStream && c.turnOutput) {
		c.currentPiStream.push({ type: "start", partial: c.turnOutput });
		c.turnStarted = true;
	}
}

/** Note a reply as delivered into Claude's history, in delivery order, with
 *  the digest of the exact copy Pi receives (history-digest.ts). */
function recordDeliveredReply(c: QueryContext, message: AssistantMessage): void {
	const callIds = (message.content as Array<{ type?: string; id?: unknown }>)
		.flatMap((block) => block?.type === "toolCall" && typeof block.id === "string" ? [block.id] : []);
	c.deliveredAssistants.push({ digest: deliveredAssistantDigest(message), callIds });
}

export function finalizeCurrentStream(stopReason?: string, c: QueryContext = ctx()): void {
	if (!c.currentPiStream || !c.turnOutput) return;
	debug(`provider: finalizeCurrentStream called, stopReason=${stopReason}, turnOutput=${JSON.stringify({stopReason: c.turnOutput.stopReason, error: c.turnOutput.errorMessage})}`);
	if (!c.turnStarted) ensureTurnStarted(c);
	const reason = stopReason === "length" ? "length" : "stop";
	// Pi executes the tool calls of ANY terminal message, a stop included. A
	// call still streaming when the query ended (Claude Code finalized a
	// partial response) was never issued, and its arguments are truncated.
	// Nothing can deliver a result for it either, so no teardown report may
	// count it as missing one.
	const { message, prunedIds } = terminalMessage(c, { maxTokensStop: reason === "length" });
	c.forgetToolCalls(prunedIds);
	recordDeliveredReply(c, message);
	c.currentPiStream.push({ type: "done", reason, message });
	c.currentPiStream.end();
	c.currentPiStream = null;
}

// --- Failed deferred continuations ---
//
// A user message Pi delivers while a query runs (a steer) is replayed to
// Claude as a continuation query once that query succeeds, and the answer
// joins the same Pi message (QueryContext.prepareContinuation). Ending that
// message as an error when a continuation fails would take the replies that
// had already completed with it. Every consumer of Pi history drops error
// turns whole: pi-ai's provider transform, the bridge's rebuild
// (convertPiMessages), and Pi's auto-retry, which removes the error message
// from the agent's context before it retries. So the Pi message ends as a
// normal reply holding exactly the blocks that were complete when the
// failing continuation started, and the failure is reported beside it. The
// failing continuation's own output (partial text, any tool call) is never
// part of it.
//
// The same boundary scopes the duplicate-render guards (queryBlocks): a
// continuation may legitimately repeat an earlier reply's text or thinking.

/** Record where the next deferred continuation's output begins in this Pi
 *  message: every block already in it belongs to earlier queries. Called
 *  only after the previous query succeeded, so every live text and thinking
 *  block among them is finished. */
export function markContinuationStart(c: QueryContext): void {
	const output = c.turnOutput;
	c.continuationStart = output ? { output, priorBlocks: [...output.content], stopReason: output.stopReason } : null;
}

/** The blocks earlier SDK queries rendered into the current Pi message
 *  (empty outside a deferred continuation). */
function priorQueryBlocks(c: QueryContext): object[] {
	const start = c.continuationStart;
	return start && start.output === c.turnOutput ? start.priorBlocks : [];
}

/** The live blocks the CURRENT SDK query rendered into this Pi message: what
 *  a duplicate-render check may compare against. */
export function queryBlocks(c: QueryContext): Array<any> {
	const prior = priorQueryBlocks(c);
	return c.turnBlocks.filter((b: any) => isLiveBlock(b) && !prior.includes(b));
}

/** The reply to end with when the running continuation failed, or undefined
 *  when no completed reply text is in this Pi message (the failure is then
 *  an ordinary error). Tool calls are not replies: one still in the message
 *  could never get a result. A copy: the live partial is left intact. */
function completedReplyMessage(c: QueryContext): AssistantMessage | undefined {
	const output = c.turnOutput;
	const prior = priorQueryBlocks(c);
	if (!output || prior.length === 0) return undefined;
	const content = (output.content as Array<any>).filter((b) => prior.includes(b) && isLiveBlock(b) && (
		(b.type === "text" && typeof b.text === "string" && b.text.length > 0) || b.type === "thinking"
	));
	if (!content.some((b) => b.type === "text")) return undefined;
	const { errorMessage: _errorMessage, ...reply } = output;
	return { ...reply, content, stopReason: c.continuationStart!.stopReason === "length" ? "length" : "stop" };
}

/** End the current Pi stream for a failed query. Without a live stream (a
 *  tool-use turn already reached Pi), an error is held for the tool-result
 *  callback that follows (QueryContext.undeliveredFailure).
 *
 *  A failed deferred continuation ends the message as the reply that
 *  completed before it, when there is one (see the section note), and tells
 *  the user the mid-turn message went unanswered.
 *
 *  A cancelled request (QueryContext.requestAborted) always ends as aborted,
 *  whatever the caller saw: never as a kept reply, never held for a later
 *  callback. Deciding it here, not at each call site, is what keeps a caller
 *  from forgetting it.
 *
 *  Otherwise the message ends as an error. Pi persists every
 *  terminal message, errors included, so the error message is built like the
 *  done message (terminalMessage): no truncated tool call, no block of an
 *  abandoned stream attempt. It is always a copy: Pi may still be encoding
 *  queued events against the live partial, which must keep every block at
 *  its index. `fields` ride the error message only (rate-limit metadata).
 *
 *  `notice` is the failure as the user is told it (defaults to
 *  errorMessage): an error message may carry retry advice that only holds
 *  when the request ends as that error. Returns how the request ended, so a
 *  caller's own report can say what happened.
 *
 *  Anthropic's third-party-app rejection gets the bridge's hint here, so every
 *  way a failure reaches Pi, a held one included, carries it. */
export function endStreamForFailure(
	c: QueryContext,
	failure: { errorMessage: string; notice?: string; fields?: Record<string, unknown> },
): FailureEnding {
	const hint = thirdPartyAppHintFor(failure.errorMessage);
	failure = { ...failure, errorMessage: withThirdPartyAppHint(failure.errorMessage) };
	const aborted = c.requestAborted();
	const stream = c.currentPiStream;
	if (!stream) {
		// The last Pi turn (a tool call) was already delivered and must not
		// change: the tool-result callback that follows reports the failure.
		// Never for an abort, and only when this query handed Pi a call.
		if (!aborted && c.forwardedToolCallIds.size > 0) {
			debug(`provider: terminal failure after the Pi turn was delivered; holding it for the tool-result callback: ${failure.errorMessage}`);
			c.undeliveredFailure = { errorMessage: failure.errorMessage, fields: failure.fields, toolCallIds: new Set(c.forwardedToolCallIds), runSignals: c.runSignals() };
			return "held";
		}
		return aborted ? "aborted" : "unreported";
	}
	if (!c.turnOutput) return "unreported";
	// Reported on this stream: no later callback may report a failure this
	// query held while no stream was live (it would repeat it).
	c.undeliveredFailure = null;
	const reply = aborted ? undefined : completedReplyMessage(c);
	c.continuationStart = null;
	if (reply) {
		// A call the failed continuation was still writing never reaches Pi,
		// so no teardown report may count it as missing a result (as in
		// finalizeCurrentStream).
		c.forgetToolCalls(terminalMessage(c).prunedIds);
		const kept = reply.content.length;
		const dropped = (c.turnOutput.content as Array<any>).filter((b) => isLiveBlock(b)).length - kept;
		debug(`provider: deferred continuation failed after a completed reply; ending the Pi message with its ${kept} completed block(s), leaving out ${dropped} from the failed continuation: ${failure.errorMessage}`);
		diagDump("continuation_failed_after_reply", { keptBlocks: kept, droppedBlocks: dropped });
		noteAnomaly("continuation_failed_after_reply");
		appendIntegrityEntry("continuation_failed_after_reply", { keptBlocks: kept, droppedBlocks: dropped });
		// The excerpt quotes the failure alone; a hint follows it whole.
		const excerpt = (failure.notice ?? withoutThirdPartyAppHint(failure.errorMessage)).slice(0, 200);
		safeNotify(`Claude bridge: Claude failed while answering your mid-turn message (${excerpt}). Its reply before that message is kept; send the message again to get an answer.${hint ? `\n\n${hint}` : ""}`, "warning");
		ensureTurnStarted(c);
		stream.push({ type: "done", reason: reply.stopReason === "length" ? "length" : "stop", message: reply });
		stream.end();
		c.currentPiStream = null;
		return "kept-reply";
	}
	// As in finalizeCurrentStream: a pruned call never reaches Pi and is owed
	// no result.
	const { message, prunedIds } = terminalMessage(c);
	c.forgetToolCalls(prunedIds);
	if (aborted && failure.errorMessage !== ABORTED_MESSAGE) debug(`provider: request was cancelled; ending the Pi message as aborted instead of: ${failure.errorMessage}`);
	const error: AssistantMessage = {
		...message,
		...(aborted ? {} : failure.fields),
		content: [...message.content],
		stopReason: aborted ? "aborted" : "error",
		errorMessage: aborted ? ABORTED_MESSAGE : failure.errorMessage,
	};
	stream.push({ type: "error", reason: aborted ? "aborted" : "error", error });
	stream.end();
	c.currentPiStream = null;
	return aborted ? "aborted" : "error";
}

/** How endStreamForFailure ended a failed request: as an error message
 *  ("error"), as an error held for the tool-result callback ("held"), as the
 *  reply completed before a failed continuation ("kept-reply"), as aborted,
 *  or not at all ("unreported": no Pi message to end and nothing to hold). */
export type FailureEnding = "error" | "held" | "kept-reply" | "aborted" | "unreported";

/** The error text of a cancelled request. */
export const ABORTED_MESSAGE = "Operation aborted";

// --- Abandoned stream attempts ---
//
// When a streamed API response stalls, Claude Code abandons it and asks again:
// as a new stream (a second message_start) or without streaming (one completed
// assistant message under a new id, with no stream events and no message_stop).
// By then the abandoned attempt may have streamed partial thinking, text or
// tool-call JSON into the Pi message. None of it is part of the answer: the
// thinking is unsigned, the text stops mid-word, and Claude Code never
// dispatches the partial call. Claude Code retries even after a tool call
// completed, and discards that attempt's calls too: it never starts one that
// was still queued, aborts one that was executing, whose tools/call it then
// cancels (withdrawCancelledToolCall), and never uses the result of one it
// started. So the discard withdraws a waiting call without waiting for that
// cancel.
//
// Pi's stream contract is APPEND-ONLY. Its frame encoder (pi-ai
// AssistantMessageFrameEncoder, run by coding-agent on every event) rejects a
// second start for an index, its reducer requires every start at the current
// content length, and both it and coding-agent's toJsonEvent read the block at
// an event's index from the live partial WHEN THE EVENT IS CONSUMED, which
// lags the provider. So once Pi has seen a block, the live content array keeps
// it at its index with its type, forever. An abandoned attempt's blocks
// therefore stay in the live partial, receive no further events, and are
// marked discarded; the retry's blocks are appended after them; and the
// terminal message Pi persists (the done message, a separate object when
// anything is left out) omits them. See terminalMessage.

/** Blocks of an abandoned attempt: still in the live partial, never in the
 *  terminal message. A WeakSet so no per-turn reset is needed. */
const discardedBlocks = new WeakSet<object>();

/** Whether `block` belongs to the answer (not an abandoned attempt). */
export function isLiveBlock(block: unknown): boolean {
	return !(block && typeof block === "object" && discardedBlocks.has(block));
}

/** Append `block` to this Pi message and return its content index. */
export function addTurnBlock(c: QueryContext, block: any): number {
	c.turnBlocks.push(block);
	const idx = c.turnBlocks.length - 1;
	if (c.streamAttempt?.open) c.streamAttempt.slots.push(idx);
	return idx;
}

/** Mark the open attempt's blocks discarded and forget their tool calls.
 *  Nothing is emitted for them and the live content is not touched (see the
 *  section note). Claude Code aborts every tool of an attempt it discards and
 *  never uses their results, so a completed call whose handler is waiting is
 *  withdrawn here as its cancel would withdraw it (withdrawToolCall): the
 *  cancel travels apart from the stream and can come after the replacement
 *  ended the turn, or never. A call Pi has been given is left to Pi's result.
 *  A call whose handler ran with no block in the attempt is left alone: it
 *  may belong to the replacement, whose handlers can arrive before its
 *  message does.
 *  `replacementId` is the message that replaced it. */
function discardAbandonedAttempt(c: QueryContext, why: "restreamed" | "non-streaming-fallback", replacementId: string | undefined): void {
	const attempt = c.streamAttempt;
	if (!attempt?.open) return;
	attempt.open = false;
	// A turn that already ended holds a message Pi owns; leave it untouched.
	if (!c.currentPiStream || !c.turnOutput) return;
	const discarded: Array<{ index: number; type: string; id?: string; withdrawn?: true }> = [];
	const droppedCallIds: string[] = [];
	const withdrawnCallIds: string[] = [];
	for (const idx of attempt.slots) {
		const block = c.turnBlocks[idx];
		if (!block || !isLiveBlock(block)) continue;
		const completedCall = block.type === "toolCall" && !("partialJson" in block);
		if (completedCall && c.forwardedToolCallIds.has(block.id)) continue;
		const withdrawn = completedCall && c.pendingToolCalls.has(block.id);
		// A handler answered by other means is already answering its own call.
		if (completedCall && !withdrawn && c.answeringToolCalls.has(block.id)) continue;
		if (withdrawn) withdrawnCallIds.push(block.id);
		else if (block.type === "toolCall" && typeof block.id === "string") droppedCallIds.push(block.id);
		discarded.push({ index: idx, type: block.type, ...(block.type === "toolCall" ? { id: block.id } : {}), ...(withdrawn ? { withdrawn: true as const } : {}) });
		discardedBlocks.add(block);
		// The retry reuses the same Anthropic stream indexes: this block must no
		// longer match their deltas and stops.
		delete block.index;
	}
	c.forgetToolCalls(droppedCallIds);
	// Never forwardable later: should a lagging replay of one of these ids
	// arrive, every forward path skips dead ids.
	for (const id of droppedCallIds) c.deadToolCallIds.add(id);
	for (const id of withdrawnCallIds) withdrawToolCall(c, id);
	c.childExecutedStreamIndexes.clear();
	c.suppressedStreamIndexes.clear();
	c.turnSawToolCall = c.turnBlocks.some((b: any) => b?.type === "toolCall" && isLiveBlock(b));
	// An early call still waiting (the replacement's handler can run before its
	// message_start) armed the grace timer, and nothing re-arms it once its
	// block streams: disarmed, a stream with no terminal events never ends.
	if (!c.turnSawToolCall && !hasWaitingEarlyCall(c)) cancelScheduledToolUseEnd(c);
	debug(`discardAbandonedAttempt: ${why} as ${replacementId ?? "an unidentified message"}; discarded ${discarded.length} block(s) of ${attempt.id ?? "an unidentified message"}:`, discarded.map((entry) => `${entry.type}@${entry.index}${entry.id ? ` [${entry.id}]` : ""}${entry.withdrawn ? " (withdrawn)" : ""}`).join(", "));
	// Expected cleanup: Claude Code abandoned a stalled response and asked
	// again, and the retry is the answer. The attempt's blocks are dropped,
	// except a completed call whose handler waits (its cancel decides), and
	// Claude Code never starts a queued call of a discarded attempt.
	diagDump("stream_attempt_abandoned", { why, messageId: attempt.id, replacementMessageId: replacementId, discarded });
}

/** Whether a tagged call whose handler ran before the stream recorded it is
 *  still waiting for Pi: neither given to Pi nor dead. */
function hasWaitingEarlyCall(c: QueryContext): boolean {
	for (const id of c.earlyToolCallIds) {
		if (c.pendingToolCalls.has(id) && !c.forwardedToolCallIds.has(id) && !c.deadToolCallIds.has(id)) return true;
	}
	return false;
}

/** Claude Code cancelled the tagged tools/call for `id`: its bundled MCP
 *  client sends notifications/cancelled when the tool's abort signal fires,
 *  which is how a discarded attempt's executing tools are aborted. A call Pi
 *  has not been given is withdrawn (withdrawToolCall). A call Pi has been
 *  given is left alone: Pi's result answers its own handler, never another
 *  call's. A call already withdrawn, at its attempt's discard, has no waiting
 *  handler left and is not withdrawn again. Returns whether the call was
 *  withdrawn. */
export function withdrawCancelledToolCall(c: QueryContext, id: string): boolean {
	if (c.forwardedToolCallIds.has(id)) {
		debug(`mcp handler: [${id}] cancelled by Claude Code after Pi was given it; its result answers it`);
		return false;
	}
	const withdrawn = withdrawToolCall(c, id);
	if (!withdrawn) return false;
	const { toolName, droppedBlock } = withdrawn;
	debug(`mcp handler: ${toolName} [${id}] cancelled by Claude Code before Pi was given it; dropped${droppedBlock ? " its block and" : ""} the call`);
	// Expected cleanup: Claude Code cancelled a call Pi was never given, and
	// the bridge drops it (a call Pi has was left alone above).
	diagDump("tool_call_cancelled_by_claude_code", { toolCallId: id, toolName, droppedBlock });
	return true;
}

/** Withdraw the waiting call `id`, which Pi has not been given: Pi never gets
 *  it. The id is dead, its block leaves the live turn the way an abandoned
 *  attempt's blocks do, and its handler is answered with an error result
 *  (the MCP server sends no response for a cancelled request). Returns null
 *  when no handler waits for `id`. */
function withdrawToolCall(c: QueryContext, id: string): { toolName: string; droppedBlock: boolean } | null {
	const pending = c.pendingToolCalls.get(id);
	if (!pending) return null;
	c.pendingToolCalls.delete(id);
	c.earlyToolCallIds.delete(id);
	c.deadToolCallIds.add(id);
	c.forgetToolCalls([id]);
	let droppedBlock = false;
	if (c.currentPiStream && c.turnOutput) {
		for (const block of c.turnBlocks) {
			if (block?.type !== "toolCall" || block.id !== id || !isLiveBlock(block)) continue;
			discardedBlocks.add(block);
			// A block still streaming must not take its remaining deltas and stop.
			if (typeof block.index === "number") {
				c.suppressedStreamIndexes.add(block.index);
				delete block.index;
			}
			droppedBlock = true;
		}
		if (droppedBlock) c.turnSawToolCall = c.turnBlocks.some((b: any) => b?.type === "toolCall" && isLiveBlock(b));
	}
	pending.resolve({ content: [{ type: "text", text: "Claude bridge: Claude Code cancelled this tool call before Pi ran it; it did not execute." }], isError: true });
	return { toolName: pending.toolName, droppedBlock };
}

/** A message ended (message_stop) while a tool call of this turn never got its
 *  content_block_stop and no call of the turn closed: the stream was cut off
 *  mid-block. Claude Code drops a half-built block and issues the call again
 *  under a new id in a new message, so ending the Pi turn here would hand Pi a
 *  tool-use turn with no call, Pi's agent loop would stop the run, and the
 *  re-issued call's handler would find no Pi turn to join. Drop every block
 *  that never closed, as discardAbandonedAttempt does, and keep the turn open
 *  for the next message; the turn's other end paths (result, stream end, idle
 *  watchdog) still end it when no call comes. Returns whether it dropped any. */
function dropUnclosedBlocksAtMessageStop(c: QueryContext): boolean {
	const live = c.turnBlocks.filter((b: any) => isLiveBlock(b));
	const partialCalls = live.filter((b: any) => b.type === "toolCall" && "partialJson" in b);
	if (partialCalls.length === 0) return false;
	if (live.some((b: any) => b.type === "toolCall" && !("partialJson" in b))) return false;
	// A streamed block still carrying its stream index never got its
	// content_block_stop: an unfinished call, or text or unsigned thinking.
	const unclosed = live.filter((b: any) => "index" in b || (b.type === "toolCall" && "partialJson" in b));
	for (const block of unclosed) {
		discardedBlocks.add(block);
		// The next message reuses the same stream indexes.
		delete block.index;
	}
	const calls = partialCalls.map((b: any) => ({ id: b.id, name: b.name }));
	const ids = calls.map((call) => call.id).filter((id): id is string => typeof id === "string");
	c.forgetToolCalls(ids);
	// Never forwardable later, like an abandoned attempt's calls.
	for (const id of ids) c.deadToolCallIds.add(id);
	c.turnSawToolCall = false;
	// An armed grace timer stays: only a handler can have armed it here (a
	// closed call would have ended the turn), and that handler's call is the
	// re-issued one, which the timer ends the turn with if its stream stalls.
	// The cut message's message_delta set a tool-use stop reason.
	if (c.turnOutput!.stopReason === "toolUse") c.turnOutput!.stopReason = "stop";
	debug(`dropUnclosedBlocksAtMessageStop: every tool call of the turn was cut off; dropped ${unclosed.length} block(s) and kept the turn open:`, calls.map((entry) => `${entry.name} [${entry.id}]`).join(", "));
	// Not expected cleanup: every call of the turn was cut off, and Claude Code
	// may have dispatched one.
	diagDump("partial_tool_calls_pruned", { count: calls.length, calls });
	noteAnomaly("partial_tool_calls_pruned");
	appendIntegrityEntry("partial_tool_calls_pruned", { count: calls.length, calls });
	return true;
}

/** The message Pi keeps for this turn: the live content without discarded
 *  blocks and, unless `prunePartialCalls` is false, without tool calls whose
 *  arguments never completed (Pi executes the tool calls of any terminal
 *  message, and truncated arguments must never execute). The live partial is
 *  left intact, since Pi may still be encoding queued events against it; when
 *  anything is left out the terminal message is a copy. Returns the ids of the
 *  pruned still-partial calls. `maxTokensStop` is set when the message ends at
 *  a max-tokens stop. */
export function terminalMessage(c: QueryContext, { prunePartialCalls = true, maxTokensStop = false } = {}): { message: AssistantMessage; prunedIds: string[] } {
	const output = c.turnOutput!;
	const content = output.content as Array<any>;
	const isPartialCall = (b: any): boolean => prunePartialCalls && b?.type === "toolCall" && "partialJson" in b;
	const kept = content.filter((b) => isLiveBlock(b) && !isPartialCall(b));
	const partial = content.filter((b) => isLiveBlock(b) && isPartialCall(b));
	if (partial.length > 0) {
		const calls = partial.map((b) => ({ id: b.id, name: b.name }));
		debug(`terminalMessage: pruning ${partial.length} still-partial tool call(s) — truncated arguments never execute:`, calls.map((entry) => `${entry.name} [${entry.id}]`).join(", "));
		// Expected cleanup in a cancelled request and at a max-tokens stop: the
		// call's arguments never finished, so it was never issued. Anywhere else
		// a prune cut off a call Claude Code may have dispatched.
		diagDump("partial_tool_calls_pruned", { count: partial.length, calls });
		if (!maxTokensStop && !c.requestAborted()) noteAnomaly("partial_tool_calls_pruned");
		appendIntegrityEntry("partial_tool_calls_pruned", { count: partial.length, calls });
	}
	const prunedIds = partial.map((b) => b.id).filter((id): id is string => typeof id === "string");
	if (kept.length === content.length) return { message: output, prunedIds };
	return { message: { ...output, content: kept }, prunedIds };
}

/** True when a completed assistant message is Claude Code's non-streamed
 *  replacement for the open streamed attempt, or a re-yield of one already
 *  rendered in this turn. */
function isNonStreamingReplacement(message: SDKMessage, assistantMsg: any, c: QueryContext): boolean {
	const id = assistantMsg?.id;
	if (typeof id !== "string" || id.length === 0) return false;
	if (id === c.fallbackMessageId) return true;
	const attempt = c.streamAttempt;
	if (!attempt?.open || id === attempt.id) return false;
	// Claude Code's own error carriers are not a retried answer, and a
	// subagent's messages belong to another conversation.
	const raw = message as SDKMessage & { error?: unknown; parent_tool_use_id?: unknown };
	if (raw.error || assistantMsg.model === "<synthetic>" || typeof raw.parent_tool_use_id === "string") return false;
	return true;
}

// --- Tool-use turn end: deferred to the stream's terminal events ---
//
// The Claude Code CLI dispatches MCP tool calls (and the SDK yields the
// completed assistant message) BEFORE the stream's message_delta arrives — and
// message_delta is what carries the message's REAL output-token count (the
// handler fires tens of milliseconds ahead of it on every tool-use turn).
// Ending the pi stream at either of those early signals freezes usage at the
// message_start placeholder values: a handful of output tokens per tool-use
// turn while the final text turn records hundreds.
//
// So the turn ends at message_stop, exactly like the streamed-text case, and
// the early signals only ARM a grace timer. The timer is the deadlock backstop
// for a stream whose terminal events never arrive (pi's steer draining
// produces one): pi cannot execute tools before the stream ends, and the MCP
// handler cannot resolve before pi executes, so a stream that has gone silent
// must be ended by force — TOOL_USE_END_GRACE_MS later instead of immediately.
//
// "Gone silent" is measured from the stream's LAST event, not from the arming:
// the SDK yields a completed assistant copy per content block, just before that
// block's content_block_stop, so the first finished call of a parallel batch
// arms the timer while the model may still be writing a sibling's arguments.
// A timer counted from the arming cut such a sibling off mid-stream, pruned it
// as truncated, and split one Claude message into two Pi turns (P3). Every
// stream event therefore restarts the grace (noteToolUseStreamActivity).
//
// That alone is not enough: Claude Code 2.1.283 sends NO stream events while
// the model writes a tool call's arguments, and flushes them in one burst when
// the block completes. A real Haiku call with ~1,200 tokens of arguments was
// silent for about 5.5 s. So a still-partial call gets up to
// PARTIAL_CALL_MAX_SILENCE_MS of CONSECUTIVE silence (FINALIZE_MAX_REARMS
// re-arms, counted from the last stream event; activity resets the count). That is
// the same silence the bridge's stream idle watchdog treats as a stalled child
// (and a watchdog that is paused while a handler waits cannot cover this).
// Only after that is the call pruned as truncated. A stream that goes silent
// with every call complete still ends after one grace period.

const TOOL_USE_END_GRACE_MS = 1500;
const PARTIAL_CALL_MAX_SILENCE_MS = DEFAULT_STREAM_IDLE_TIMEOUT_MS;

/** End the current pi stream as a tool_use turn boundary. Safe to call when the
 *  turn already ended (no-op). Every end path funnels here, so this is where
 *  two invariants are enforced by construction: a block still
 *  carrying partialJson never ships — Pi executes the done message's content,
 *  and truncated arguments must never execute — and every call that DOES ship
 *  is stamped forwarded so no lagging replay can dispatch it again. */
export function endToolUseTurn(c: QueryContext): void {
	if (!c.currentPiStream || !c.turnOutput) return;
	cancelScheduledToolUseEnd(c);
	c.turnOutput.stopReason = "toolUse";
	const { message } = terminalMessage(c);
	recordDeliveredReply(c, message);
	// Every tool call Pi is about to execute from this turn is owed a result and
	// must never be dispatched again: a lagging stream replays the same tool_use
	// into the NEXT turn, whose per-message dedup cannot see it.
	for (const block of message.content as Array<{ type?: string; id?: unknown }>) {
		if (block?.type === "toolCall" && typeof block.id === "string") c.forwardedToolCallIds.add(block.id);
	}
	c.currentPiStream.push({ type: "done", reason: "toolUse", message });
	c.currentPiStream.end();
	c.currentPiStream = null;
}

export function cancelScheduledToolUseEnd(c: QueryContext): void {
	if (!c.scheduledToolUseEnd) return;
	clearTimeout(c.scheduledToolUseEnd.timer);
	c.scheduledToolUseEnd = null;
}

/**
 * Arm the grace timer that force-ends the current tool_use turn if the stream's
 * terminal events never arrive. First arming per stream wins; message_stop (or
 * resetTurnState) disarms it. `action` runs only if the SAME stream is still
 * current when the grace elapses — a turn that ended normally makes it a no-op.
 */
export function scheduleToolUseTurnEnd(c: QueryContext, action: () => void, source: string, fresh?: () => void): void {
	if (!c.currentPiStream || !c.turnOutput) return;
	if (c.scheduledToolUseEnd?.stream === c.currentPiStream) return;
	cancelScheduledToolUseEnd(c);
	const stream = c.currentPiStream;
	const fire = (): void => {
		if (c.currentPiStream !== stream) return;
		debug(`scheduleToolUseTurnEnd: no stream event for ${TOOL_USE_END_GRACE_MS}ms (${source}) — grace elapsed`);
		c.scheduledToolUseEnd = null;
		entry.action();
	};
	const timer = setTimeout(fire, TOOL_USE_END_GRACE_MS);
	timer.unref?.();
	const entry: NonNullable<QueryContext["scheduledToolUseEnd"]> = { stream, timer, fire, action, ...(fresh ? { fresh } : {}) };
	c.scheduledToolUseEnd = entry;
}

/** The stream is still delivering: restart the armed grace period, and reset
 *  a re-arming finalizer's silence count, so a partial call's allowance is
 *  measured from the LAST stream event rather than summed across every quiet
 *  gap of a long write. A timer armed for an earlier stream is left alone
 *  (its own identity check makes it a no-op anyway). */
export function noteToolUseStreamActivity(c: QueryContext): void {
	const scheduled = c.scheduledToolUseEnd;
	if (!scheduled || scheduled.stream !== c.currentPiStream) return;
	clearTimeout(scheduled.timer);
	if (scheduled.fresh) scheduled.action = scheduled.fresh;
	scheduled.timer = setTimeout(scheduled.fire, TOOL_USE_END_GRACE_MS);
	scheduled.timer.unref?.();
}

/**
 * Park queued tool results whose handler has not fired by a child message
 * boundary, and record it in the logs and the Pi session file (and, in debug
 * mode, tell the agent). The boundary is where stale
 * entries would start poisoning mismatch reports — but it does NOT prove the
 * handler gave up: the SDK staggers handler invocations, and handlers in a
 * parallel batch routinely fire after this point. Parked results stay
 * consumable through takeQueuedOrParkedResult; one that is never consumed
 * belongs to a call the SDK abandoned client-side (permission denial).
 */
export function reapStaleQueuedResults(c: QueryContext): void {
	const stale = c.takeStaleQueuedResults();
	if (stale.length === 0) return;
	const names = stale.map((entry) => entry.toolName);
	debug(`reapStaleQueuedResults: parked ${stale.length} early tool result(s) awaiting a late handler:`, names.join(", "));
	diagDump("stale_queued_tool_results_parked", { count: stale.length, stale });
	noteAnomaly("stale_queued_tool_results_parked");
	appendIntegrityEntry("stale_queued_tool_results_parked", { count: stale.length, stale });
}

/** Record the model Claude Code reports actually serving this turn (dated
 *  alias, refusal fallback, account-rotation or classifier fallback). Matches
 *  Pi's native Anthropic provider: `model` stays the Pi model id the request
 *  selected — pi-subagents and others verify it against the launch model — and
 *  the served model goes into `responseModel` only when it differs. */
export function updateTurnResponseModel(modelId: unknown, c: QueryContext = ctx()): void {
	if (typeof modelId !== "string" || !modelId || !c.turnOutput) return;
	const current = c.turnOutput.responseModel ?? c.turnOutput.model;
	if (current === modelId) return;
	debug(`provider: active Claude model changed ${current} -> ${modelId} (selected ${c.turnOutput.model})`);
	if (modelId === c.turnOutput.model) delete c.turnOutput.responseModel;
	else c.turnOutput.responseModel = modelId;
}

export const FINALIZE_MAX_REARMS = Math.ceil(PARTIAL_CALL_MAX_SILENCE_MS / TOOL_USE_END_GRACE_MS) - 1;

/** Force-finalizes the current pi turn as a tool_use boundary when its terminal
 *  stream events never arrived (the grace-timer action armed by an MCP handler
 *  invocation — see scheduleToolUseTurnEnd).
 *
 *  The producer is pi's steer draining (tool result and drained steer arrive
 *  in one provider call): the NEXT tool turn's tool_use streams in, the SDK
 *  invokes the MCP handler — and neither terminal event ever arrives. The
 *  invocation itself proves the assistant turn is committed, so end the pi
 *  stream like the `message_stop` path — with this handler's schema-validated
 *  arguments, never a partial parse — after settling every sibling whose
 *  handler has fired and giving a sibling that is still being written up to
 *  FINALIZE_MAX_REARMS extra grace periods of silence for the rest.
 *
 *  The dead-stream guard is a backstop: the grace timer's own stream-identity
 *  check means this normally never runs after the turn ended. The primary
 *  recovery for a handler whose call missed its turn is the generation-guarded
 *  drainStrandedToolCalls at the next provider callback. */
export function finalizeToolUseTurnFromMcpInvocation(
	queryCtx: QueryContext,
	toolCallId: string,
	toolName: string,
	mappedArgs: Record<string, unknown>,
	rearmCount = 0,
): void {
	if (!queryCtx.currentPiStream || !queryCtx.turnOutput) {
		// The turn ended without this call. An unforwarded handler here can never
		// be answered — the yield that could have replayed its call was consumed
		// against a null stream, and the dead-mark below suppresses any replay
		// that has not happened yet. Failing it here turns what would be a
		// session-long deadlock into one retryable error.
		if (failStrandedToolCall(queryCtx, toolCallId)) {
			debug(`mcp handler: ${toolName} [${toolCallId}] stranded — turn ended before its call reached Pi; resolved with error`);
			appendIntegrityEntry("tool_handler_stranded", { toolCallId, toolName, site: "finalize-no-stream" });
		}
		return;
	}
	let idx = queryCtx.turnBlocks.findIndex((b: any) => b.type === "toolCall" && b.id === toolCallId && isLiveBlock(b));
	if (idx >= 0) {
		const block = queryCtx.turnBlocks[idx] as any;
		if ("partialJson" in block) {
			// Stream ended before content_block_stop. The SDK invoked this handler
			// with the COMPLETE schema-validated input, so the handler's copy is
			// authoritative — the streamed partial JSON is by definition behind it.
			// Settling from the partial forwards `{}`-argument calls that Pi then
			// executes and errors on, a divergence the synthesize branch below
			// cannot have.
			block.arguments = mappedArgs;
			queryCtx.updateToolCallArgs(block.id, block.arguments);
			delete block.partialJson;
			delete block.index;
			queryCtx.currentPiStream.push({ type: "toolcall_end", contentIndex: idx, toolCall: block, partial: queryCtx.turnOutput });
		}
	} else if (queryCtx.forwardedToolCallIds.has(toolCallId) || queryCtx.deadToolCallIds.has(toolCallId)) {
		// Pi already executed this call in a turn that has ended (its result
		// arrives or sits parked), or the handler was already failed — either
		// way a second dispatch is the one outcome worse than waiting. Do NOT
		// return: this firing consumed the stream's only grace timer, so the
		// current turn's own blocks must still be settled and the turn still
		// ended below, or a turn that loses its terminal events afterwards has
		// no backstop left and Pi sits busy until manual abort.
		debug(`mcp handler: ${toolName} [${toolCallId}] already ${queryCtx.forwardedToolCallIds.has(toolCallId) ? "forwarded" : "dead"} — not re-emitting`);
	} else {
		// The invocation can arrive before the tool_use is streamed at all
		// (observed after a tool-result+steer provider call reset the turn):
		// synthesize the toolCall from the claim — the MCP call carries the
		// authoritative id, name, and arguments.
		idx = addTurnBlock(queryCtx, { type: "toolCall", id: toolCallId, name: toolName, arguments: mappedArgs });
		const block = queryCtx.turnBlocks[idx] as any;
		queryCtx.currentPiStream.push({ type: "toolcall_start", contentIndex: idx, partial: queryCtx.turnOutput });
		queryCtx.currentPiStream.push({ type: "toolcall_end", contentIndex: idx, toolCall: block, partial: queryCtx.turnOutput });
	}
	settlePartialCallsOrEndTurn(
		queryCtx,
		rearmCount,
		() => finalizeToolUseTurnFromMcpInvocation(queryCtx, toolCallId, toolName, mappedArgs, rearmCount + 1),
		() => finalizeToolUseTurnFromMcpInvocation(queryCtx, toolCallId, toolName, mappedArgs, 0),
		`mcp handler (${toolName} [${toolCallId}])`,
		`finalize-rearm:${toolName}`,
	);
}

/** Grace-timer action armed at the assistant boundary (a completed assistant
 *  copy carried a tool_use the stream had not finished). Same settle / re-arm /
 *  end policy as the MCP-invocation finalize: the boundary proves only that ONE
 *  block finished, not that its siblings did. */
export function finalizeToolUseTurnAtAssistantBoundary(c: QueryContext, rearmCount = 0): void {
	if (!c.currentPiStream || !c.turnOutput) return;
	settlePartialCallsOrEndTurn(
		c,
		rearmCount,
		() => finalizeToolUseTurnAtAssistantBoundary(c, rearmCount + 1),
		() => finalizeToolUseTurnAtAssistantBoundary(c, 0),
		"assistant boundary",
		"assistant-boundary-rearm",
	);
}

/** Shared tail of the grace-timer finalizers. The stream is live and has been
 *  silent for a full grace period. */
function settlePartialCallsOrEndTurn(
	queryCtx: QueryContext,
	rearmCount: number,
	rearm: () => void,
	fresh: () => void,
	label: string,
	rearmSource: string,
): void {
	if (!queryCtx.currentPiStream || !queryCtx.turnOutput) return;
	// A tagged handler can run before the stream records its tool_use: forward
	// every such call still waiting that Pi has not been given, with its
	// handler's arguments. The stream's later blocks for them dedup by id.
	for (const id of queryCtx.earlyToolCallIds) {
		const waiting = queryCtx.pendingToolCalls.get(id);
		if (!waiting || queryCtx.forwardedToolCallIds.has(id) || queryCtx.deadToolCallIds.has(id)) continue;
		if (queryCtx.turnBlocks.some((b: any) => b.type === "toolCall" && b.id === id && isLiveBlock(b))) continue;
		const idx = addTurnBlock(queryCtx, { type: "toolCall", id, name: waiting.toolName, arguments: waiting.args });
		const block = queryCtx.turnBlocks[idx] as any;
		queryCtx.currentPiStream.push({ type: "toolcall_start", contentIndex: idx, partial: queryCtx.turnOutput });
		queryCtx.currentPiStream.push({ type: "toolcall_end", contentIndex: idx, toolCall: block, partial: queryCtx.turnOutput });
	}
	// Settle every OTHER still-partial block whose handler has fired: each
	// waiting handler carries the authoritative args for its own call.
	for (let i = 0; i < queryCtx.turnBlocks.length; i++) {
		const sibling = queryCtx.turnBlocks[i] as any;
		if (sibling.type !== "toolCall" || !("partialJson" in sibling) || !isLiveBlock(sibling)) continue;
		const waiting = queryCtx.pendingToolCalls.get(sibling.id);
		if (!waiting) continue;
		sibling.arguments = waiting.args;
		queryCtx.updateToolCallArgs(sibling.id, sibling.arguments);
		delete sibling.partialJson;
		delete sibling.index;
		queryCtx.currentPiStream.push({ type: "toolcall_end", contentIndex: i, toolCall: sibling, partial: queryCtx.turnOutput });
	}
	// A block still partial here has NO fired handler: its complete arguments
	// exist nowhere on this side of the boundary yet. Ending the turn now would
	// hand Pi truncated arguments to execute — a truncated bash command is not a
	// hypothetical hazard — so give the lagging stream more grace first.
	const unsettled = queryCtx.turnBlocks.filter((b: any) => b.type === "toolCall" && "partialJson" in b && isLiveBlock(b));
	if (unsettled.length > 0 && rearmCount < FINALIZE_MAX_REARMS) {
		if (rearmCount % 10 === 0) debug(`${label}: ${unsettled.length} sibling tool call(s) still streaming — re-arming grace (${rearmCount + 1}/${FINALIZE_MAX_REARMS})`);
		scheduleToolUseTurnEnd(queryCtx, rearm, rearmSource, fresh);
		return;
	}
	// Grace exhausted with blocks still partial: endToolUseTurn prunes them —
	// truncated arguments never execute; each pruned call replays complete on
	// the SDK's assistant yield in a later turn, or its handler eventually
	// fires and the stranded drain fails it with a retryable error. When the
	// turn holds NOTHING executable (this call suppressed as forwarded/dead and
	// no settled siblings), leave the stream to its own terminal events — an
	// empty tool_use turn would make Pi execute nothing and record an empty
	// assistant message for it.
	const executable = queryCtx.turnBlocks.some((b: any) => b.type === "toolCall" && !("partialJson" in b) && isLiveBlock(b));
	if (!executable) {
		debug(`${label}: nothing executable in this turn after suppression — leaving the stream to its own terminal events`);
		return;
	}
	queryCtx.turnSawToolCall = true;
	debug(`${label}: finalizing tool_use turn — terminal stream events never arrived`);
	endToolUseTurn(queryCtx);
}

/** Maps Anthropic stream events to pi stream events (text, thinking, toolcall).
 *  On message_stop with tool_use: ends currentPiStream so pi can execute the tool. */
export function processStreamEvent(
	message: SDKMessage,
	customToolNameToPi: Map<string, string>,
	model: Model<any>,
	// The consuming query's CAPTURED context, never the live ctx() (see the C4
	// note in consumeQuery): a quarantine can hand the lane to a new context
	// while this iterator is suspended, and live-state reads would hit the
	// wrong query.
	c: QueryContext = ctx(),
): void {
	if (!c.currentPiStream || !c.turnOutput) return;
	const event = (message as SDKMessage & { event: any }).event;
	if (event?.type === "ping") return;
	noteToolUseStreamActivity(c);
	if (event?.type === "message_stop" && c.streamAttempt) c.streamAttempt.open = false;
	if (event?.type === "message_stop" && !c.turnSawToolCall) {
		debug("processStreamEvent: ignoring bare message_stop with no streamed content/tool call");
		return;
	}

	if (event?.type === "message_start") {
		// A message_start while the previous attempt never completed (no
		// message_delta or message_stop): Claude Code gave up on that stream and
		// is retrying the same request as a new one. Its blocks are not part of
		// the answer.
		const retry = Boolean(c.streamAttempt?.open);
		if (retry) discardAbandonedAttempt(c, "restreamed", event.message?.id);
		// The child moving on to another message is where a still-queued result
		// would start poisoning mismatch reports: park it, consumable by a late
		// handler (see reapStaleQueuedResults).
		reapStaleQueuedResults(c);
		c.resetToolTracking();
		// Another child message begins: bank what the previous one billed before
		// its counters are replaced. No-op on the turn's first, and no-op if this
		// same message was already declared (see beginChildMessage). A retry
		// replaces the abandoned attempt instead of following it.
		if (retry) c.replaceChildMessage(event.message?.id);
		else c.beginChildMessage(event.message?.id);
		c.streamAttempt = { id: typeof event.message?.id === "string" ? event.message.id : undefined, open: true, slots: [] };
		updateTurnResponseModel(event.message?.model, c);
		if (event.message?.usage) updateUsage(c.turnOutput, event.message.usage, model, c);
		return;
	}

	if (event?.type === "content_block_start") {
		c.turnSawStreamEvent = true;
		ensureTurnStarted(c);
		// This block owns its index from here on, so release any child-executed
		// or suppressed claim on it. Belt-and-braces against a missed
		// message_start: without this a stale index could silently swallow a later
		// text block's deltas.
		c.childExecutedStreamIndexes.delete(event.index);
		c.suppressedStreamIndexes.delete(event.index);
		if (event.content_block?.type === "tool_use" && isChildExecutedTool(event.content_block.name)) {
			// The child runs this one itself — mirroring it into the Pi stream would
			// make Pi's agent loop dispatch a tool it does not have. See
			// isChildExecutedTool.
			c.noteChildExecutedToolCall(event.content_block.id, event.content_block.name, event.index);
			debug(`processStreamEvent: child-executed tool ${event.content_block.name} [${event.content_block.id}] — not mirrored as a Pi tool call`);
			return;
		}
		if (event.content_block?.type === "tool_use" && !isPiDispatchable(event.content_block.name, customToolNameToPi)) {
			c.suppressedStreamIndexes.add(event.index);
			if (isForeignMcpTool(event.content_block.name)) c.noteForeignMcpToolCall(event.content_block.id, event.content_block.name);
			debug(`processStreamEvent: non-dispatchable tool ${event.content_block.name} [${event.content_block.id}] — not mirrored as a Pi tool call`);
			return;
		}
		if (event.content_block?.type === "text") {
			const idx = addTurnBlock(c, { type: "text", text: "", index: event.index });
			c.currentPiStream!.push({ type: "text_start", contentIndex: idx, partial: c.turnOutput });
		} else if (event.content_block?.type === "thinking") {
			const idx = addTurnBlock(c, { type: "thinking", thinking: "", thinkingSignature: "", index: event.index });
			c.currentPiStream!.push({ type: "thinking_start", contentIndex: idx, partial: c.turnOutput });
		} else if (event.content_block?.type === "tool_use") {
			const streamedId: unknown = event.content_block.id;
			if (typeof streamedId === "string" && (c.forwardedToolCallIds.has(streamedId) || c.deadToolCallIds.has(streamedId))) {
				// A lagging stream replaying a call Pi already executed — or one whose
				// handler was already failed as stranded — into a later turn. Mirroring
				// it would make Pi dispatch it a second time.
				c.suppressedStreamIndexes.add(event.index);
				debug(`processStreamEvent: tool_use ${streamedId} already ${c.forwardedToolCallIds.has(streamedId) ? "forwarded" : "dead"} — suppressing duplicate stream block`);
				return;
			}
			if (typeof streamedId === "string" && c.turnBlocks.some((b: any) => b.type === "toolCall" && b.id === streamedId && isLiveBlock(b))) {
				// Same turn, same id: the completed-message yield beat the stream (its
				// block is already recorded with complete arguments). A second
				// partialJson copy would ship the id twice in one done message — and
				// if its stop never arrives, ship it truncated.
				c.suppressedStreamIndexes.add(event.index);
				debug(`processStreamEvent: tool_use ${streamedId} already recorded in this turn — suppressing duplicate stream block`);
				return;
			}
			c.turnSawToolCall = true;
			const mappedName = mapToolName(event.content_block.name, customToolNameToPi);
			c.recordToolCall(event.content_block.id, mappedName, {});
			const idx = addTurnBlock(c, {
				type: "toolCall", id: event.content_block.id,
				name: mappedName,
				arguments: (event.content_block.input as Record<string, unknown>) ?? {},
				partialJson: "", index: event.index,
			});
			c.currentPiStream!.push({ type: "toolcall_start", contentIndex: idx, partial: c.turnOutput });
		} else {
			debug("processStreamEvent: unhandled content_block_start type", event.content_block?.type);
		}
		return;
	}

	if (event?.type === "content_block_delta") {
		// A child-executed tool's argument deltas have no Pi block to land in. Skip
		// them here rather than letting the lookup below miss, so the "unmatched"
		// warning keeps meaning "something is wrong". Unlike that stale-event case
		// this IS a live event for the current message, so it still counts as one.
		// Suppressed duplicate/dead blocks skip identically.
		if (c.childExecutedStreamIndexes.has(event.index) || c.suppressedStreamIndexes.has(event.index)) {
			c.turnSawStreamEvent = true;
			return;
		}
		const index = c.turnBlocks.findIndex((b: any) => b.index === event.index);
		const block = c.turnBlocks[index];
		if (!block) {
			debug("processStreamEvent: ignoring unmatched content_block_delta", event.index);
			return;
		}
		c.turnSawStreamEvent = true;
		if (event.delta?.type === "text_delta" && block.type === "text") {
			block.text += event.delta.text;
			c.currentPiStream!.push({ type: "text_delta", contentIndex: index, delta: event.delta.text, partial: c.turnOutput });
		} else if (event.delta?.type === "thinking_delta" && block.type === "thinking") {
			block.thinking += event.delta.thinking;
			c.currentPiStream!.push({ type: "thinking_delta", contentIndex: index, delta: event.delta.thinking, partial: c.turnOutput });
		} else if (event.delta?.type === "input_json_delta" && block.type === "toolCall") {
			block.partialJson += event.delta.partial_json;
			block.arguments = parsePartialJson(block.partialJson, block.arguments);
			c.currentPiStream!.push({ type: "toolcall_delta", contentIndex: index, delta: event.delta.partial_json, partial: c.turnOutput });
		} else if (event.delta?.type === "signature_delta" && block.type === "thinking") {
			block.thinkingSignature = (block.thinkingSignature ?? "") + event.delta.signature;
		} else {
			debug("processStreamEvent: unhandled content_block_delta type", event.delta?.type);
		}
		return;
	}

	if (event?.type === "content_block_stop") {
		// Same as the delta case: the block was never mirrored, so there is nothing
		// to seal and nothing unmatched about it.
		if (c.childExecutedStreamIndexes.has(event.index) || c.suppressedStreamIndexes.has(event.index)) {
			c.turnSawStreamEvent = true;
			return;
		}
		const index = c.turnBlocks.findIndex((b: any) => b.index === event.index);
		const block = c.turnBlocks[index];
		if (!block) {
			debug("processStreamEvent: ignoring unmatched content_block_stop", event.index);
			return;
		}
		c.turnSawStreamEvent = true;
		delete block.index;
		if (block.type === "text") {
			c.currentPiStream!.push({ type: "text_end", contentIndex: index, content: block.text, partial: c.turnOutput });
		} else if (block.type === "thinking") {
			c.currentPiStream!.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: c.turnOutput });
		} else if (block.type === "toolCall") {
			c.turnSawToolCall = true;
			block.arguments = mapToolArgs(
				block.name, parsePartialJson(block.partialJson, block.arguments),
			);
			c.updateToolCallArgs(block.id, block.arguments);
			delete block.partialJson;
			c.currentPiStream!.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: c.turnOutput });
		}
		return;
	}

	if (event?.type === "message_delta") {
		// message_delta arrives once, after the last content block: the response
		// is complete, and Claude Code never retries a completed response.
		if (c.streamAttempt) c.streamAttempt.open = false;
		c.turnOutput.stopReason = mapStopReason(event.delta?.stop_reason);
		if (event.usage) updateUsage(c.turnOutput, event.usage, model, c);
		return;
	}

	if (event?.type === "message_stop" && c.turnSawToolCall) {
		// Every call of the turn was cut off: Claude Code issues it again in the
		// next message, which belongs to this Pi turn.
		if (dropUnclosedBlocksAtMessageStop(c)) return;
		// Tool call complete — end this pi stream, disarming any grace timer the
		// MCP-invocation or assistant-boundary path armed. This is the NORMAL end
		// for a tool-use turn: message_delta already delivered the message's real
		// usage just above, so the done event carries correct output tokens. The
		// MCP handler blocks the generator until pi delivers the tool result via
		// the next streamSimple call.
		endToolUseTurn(c);

		// Cursor is updated by the next streamSimple call (tool result delivery path)
		// which sets cursor = context.messages.length with the post-tool-result context.
		return;
	}

	if (event?.type !== "message_stop" && event?.type !== "ping") {
		debug("processStreamEvent: unhandled event type", event?.type);
	}
}

// The SDK always yields `assistant` messages (completed content blocks) after streaming.
// When stream_events already delivered the content, this is a no-op. But after
// resetTurnState (e.g. tool result delivery), if the next turn's assistant message
// arrives before any stream_events, this is the primary content path. Must maintain
// the same stream lifecycle as processStreamEvent — including ending the stream on
// tool_use to prevent deadlock with the MCP handler.
function appendMissingToolUsesFromAssistant(
	assistantMsg: { content?: Array<any>; usage?: Record<string, number | undefined> },
	model: Model<any>,
	customToolNameToPi: Map<string, string>,
	c: QueryContext,
): boolean {
	if (!assistantMsg?.content) return false;
	// With a dead stream, ids are still RECORDED (claims and result matching
	// need them) but the content is never touched: turnBlocks IS the content
	// array of a turnOutput that endToolUseTurn already handed Pi BY REFERENCE
	// in its done event, so a push here appends calls into a delivered message
	// behind Pi's back — whether Pi's dispatch enumerates before or after the
	// push is a microtask race.
	const streamLive = Boolean(c.currentPiStream && c.turnOutput);
	let sawToolUse = false;
	for (const block of assistantMsg.content) {
		if (block.type !== "tool_use") continue;
		if (isChildExecutedTool(block.name)) {
			// Not a Pi tool call, so it is NOT a turn boundary either: `sawToolUse`
			// stays false for it and the caller keeps streaming this Pi message. The
			// child neither blocks on Pi nor needs a result from it.
			c.noteChildExecutedToolCall(block.id, block.name);
			debug(`assistant message: child-executed tool ${block.name} [${block.id}] — not mirrored as a Pi tool call`);
			continue;
		}
		if (!isPiDispatchable(block.name, customToolNameToPi)) {
			if (isForeignMcpTool(block.name)) c.noteForeignMcpToolCall(block.id, block.name);
			debug(`assistant message: non-dispatchable tool ${block.name} [${block.id}] — not mirrored as a Pi tool call`);
			continue;
		}
		const existingIdx = c.turnBlocks.findIndex((b: any) => b.type === "toolCall" && b.id === block.id && isLiveBlock(b));
		if (existingIdx < 0 && (c.forwardedToolCallIds.has(block.id) || c.deadToolCallIds.has(block.id))) {
			// Completed-message replay of a call Pi already executed in a turn that
			// has ended (or one already failed as stranded). Not a live Pi turn
			// boundary: sawToolUse stays false for it, and no block is emitted.
			debug(`assistant message: tool_use ${block.id} already ${c.forwardedToolCallIds.has(block.id) ? "forwarded" : "dead"} — skipping duplicate`);
			continue;
		}
		sawToolUse = true;
		const name = mapToolName(block.name, customToolNameToPi);
		const mappedArgs = mapToolArgs(name, block.input);
		c.recordToolCall(block.id, name, mappedArgs);
		if (!streamLive) continue;
		if (existingIdx >= 0) {
			const existing = c.turnBlocks[existingIdx] as any;
			existing.name = name;
			existing.arguments = mappedArgs;
			c.updateToolCallArgs(block.id, mappedArgs);
			if ("partialJson" in existing) {
				delete existing.partialJson;
				delete existing.index;
				c.currentPiStream?.push({ type: "toolcall_end", contentIndex: existingIdx, toolCall: existing, partial: c.turnOutput });
			}
			continue;
		}

		ensureTurnStarted(c);
		const idx = addTurnBlock(c, {
			type: "toolCall", id: block.id,
			name,
			arguments: mappedArgs,
		});
		const toolBlock = c.turnBlocks[idx];
		c.currentPiStream?.push({ type: "toolcall_start", contentIndex: idx, partial: c.turnOutput });
		c.currentPiStream?.push({ type: "toolcall_end", contentIndex: idx, toolCall: toolBlock as any, partial: c.turnOutput });
	}
	// Only while the stream is still live: the SDK's assistant yields carry the
	// message_start placeholder usage, and once the done event has delivered
	// turnOutput to pi, overwriting its usage with those placeholders would
	// corrupt the very figure message_delta got right.
	if (assistantMsg.usage && c.turnOutput && c.currentPiStream) updateUsage(c.turnOutput, assistantMsg.usage, model, c);
	return sawToolUse;
}

/**
 * Record that a child-executed tool call came back, from the SDK's `user` message
 * carrying the child's own `tool_result` blocks.
 *
 * This is the only place the bridge ever OBSERVES one of these results, and it is
 * deliberately observation-only: the result already reached the model inside the
 * child, which is the conversation of record for a bridge turn, so re-delivering
 * it would double it. What the bridge could not do before this existed was say
 * anything true about these calls at all — the Pi transcript claimed they failed
 * and nothing anywhere claimed otherwise.
 *
 * The payload is NEVER logged or recorded, only its shape: a connector result is
 * live account data (mail, messages, documents) and the bridge's debug log sits
 * outside a host app's redaction boundary.
 *
 * Observing it is also what makes the call auditable: each one appends a session
 * `CustomEntry` (connector-audit.ts) so the Pi session records that the call
 * happened, without a content block Pi's agent loop could try to dispatch.
 */
export function noteChildExecutedToolResults(message: SDKMessage, c: QueryContext = ctx()): void {
	if (c.childExecutedToolCalls.size === 0) return;
	const content = (message as SDKMessage & { message?: { content?: unknown } }).message?.content;
	if (!Array.isArray(content)) return;
	for (const block of content) {
		if (block?.type !== "tool_result") continue;
		const name = c.childExecutedToolCalls.get(block.tool_use_id);
		if (!name) continue;
		const isError = block.is_error === true;
		const byteSize = connectorResultByteSize(block.content);
		const audited = recordConnectorCallResult(c, block.tool_use_id, name, isError, byteSize);
		debug(`child-executed tool result: ${name} [${block.tool_use_id}] isError=${isError} byteSize=${byteSize ?? "unknown"} audited=${audited}`);
	}
}

/** Render a COMPLETED assistant message's blocks into the live Pi message:
 *  the content path for a message that produced no stream events of its own.
 *  Text and thinking are deduped against what the current SDK query rendered
 *  and tool calls by id, so a re-yield of the same message renders only what
 *  is new. */
function renderCompletedBlocks(c: QueryContext, content: Array<any>, customToolNameToPi: Map<string, string>, label: string): void {
	// Deduped against everything the current SDK query rendered, not just
	// same-id re-yields: a rejected turn's synthesized error message ("You've
	// hit your weekly limit") arrives as multiple assistant yields whose ids
	// DIFFER or are absent (one pi message, two byte-identical text blocks), so
	// an id-keyed guard alone still renders it twice. A model legitimately
	// producing two byte-identical full blocks in one query is vanishingly
	// rare; rendering such a duplicate once is the better failure mode.
	// Replies of earlier queries in this Pi message (deferred replay) are not
	// compared: a continuation repeating one is legitimate.
	const alreadyRendered = (type: string, value: string): boolean =>
		queryBlocks(c).some((b: any) => b.type === type && (type === "text" ? b.text : b.thinking) === value);
	for (const block of content) {
		if (block.type === "text" && block.text) {
			if (alreadyRendered("text", block.text)) continue;
			ensureTurnStarted(c);
			const idx = addTurnBlock(c, { type: "text", text: block.text });
			c.currentPiStream?.push({ type: "text_start", contentIndex: idx, partial: c.turnOutput });
			c.currentPiStream?.push({ type: "text_delta", contentIndex: idx, delta: block.text, partial: c.turnOutput });
			c.currentPiStream?.push({ type: "text_end", contentIndex: idx, content: block.text, partial: c.turnOutput });
		} else if (block.type === "thinking") {
			if (alreadyRendered("thinking", block.thinking ?? "")) continue;
			ensureTurnStarted(c);
			const idx = addTurnBlock(c, { type: "thinking", thinking: block.thinking ?? "", thinkingSignature: block.signature ?? "" });
			c.currentPiStream?.push({ type: "thinking_start", contentIndex: idx, partial: c.turnOutput });
			if (block.thinking) c.currentPiStream?.push({ type: "thinking_delta", contentIndex: idx, delta: block.thinking, partial: c.turnOutput });
			c.currentPiStream?.push({ type: "thinking_end", contentIndex: idx, content: block.thinking ?? "", partial: c.turnOutput });
		} else if (block.type === "tool_use") {
			if (isChildExecutedTool(block.name)) {
				// Same as the streamed path: the child owns this call, so it never
				// becomes a Pi tool call and never ends the turn.
				c.noteChildExecutedToolCall(block.id, block.name);
				debug(`${label}: child-executed tool ${block.name} [${block.id}] — not mirrored as a Pi tool call`);
				continue;
			}
			if (!isPiDispatchable(block.name, customToolNameToPi)) {
				if (isForeignMcpTool(block.name)) c.noteForeignMcpToolCall(block.id, block.name);
				debug(`${label}: non-dispatchable tool ${block.name} [${block.id}] — not mirrored as a Pi tool call`);
				continue;
			}
			if (!c.turnBlocks.some((b: any) => b.type === "toolCall" && b.id === block.id && isLiveBlock(b))
				&& (c.forwardedToolCallIds.has(block.id) || c.deadToolCallIds.has(block.id))) {
				// A cross-turn replay of a call Pi already executed (or one whose
				// handler was already failed as stranded). This is the path a
				// duplicate dispatch takes: the completed-message yield lands in the
				// callback AFTER a grace finalize already ended the call's turn, and
				// per-message dedup cannot see across turns. Not recorded either — a
				// forwarded call must not be claimable again.
				debug(`${label}: tool_use ${block.id} already ${c.forwardedToolCallIds.has(block.id) ? "forwarded" : "dead"} — skipping duplicate`);
				continue;
			}
			ensureTurnStarted(c);
			c.turnSawToolCall = true;
			const mappedName = mapToolName(block.name, customToolNameToPi);
			const mappedArgs = mapToolArgs(mappedName, block.input);
			c.recordToolCall(block.id, mappedName, mappedArgs);
			// A same-message re-yield of an already-mirrored call refreshes its
			// arguments in place — a second toolCall block would make pi dispatch
			// the tool twice.
			const existingIdx = c.turnBlocks.findIndex((b: any) => b.type === "toolCall" && b.id === block.id && isLiveBlock(b));
			if (existingIdx >= 0) {
				const existing = c.turnBlocks[existingIdx] as any;
				existing.name = mappedName;
				existing.arguments = mappedArgs;
				c.updateToolCallArgs(block.id, mappedArgs);
				continue;
			}
			const idx = addTurnBlock(c, {
				type: "toolCall", id: block.id,
				name: mappedName,
				arguments: mappedArgs,
			});
			const toolBlock = c.turnBlocks[idx];
			c.currentPiStream?.push({ type: "toolcall_start", contentIndex: idx, partial: c.turnOutput });
			c.currentPiStream?.push({ type: "toolcall_end", contentIndex: idx, toolCall: toolBlock as any, partial: c.turnOutput });
		} else if (block.type === "fallback") {
			updateTurnResponseModel(block.to?.model, c);
		} else {
			debug(`${label}: unhandled block type`, block.type);
		}
	}
}

/** Render Claude Code's non-streamed replacement for an abandoned streamed
 *  attempt (or a re-yield of it). It arrives complete, with no stream events,
 *  so none of message_delta/message_stop will follow: a tool-use turn ends by
 *  the grace timer, which every yield of the replacement restarts, so calls
 *  a later re-yield adds still ship in the same turn. */
function renderNonStreamingReplacement(assistantMsg: any, model: Model<any>, customToolNameToPi: Map<string, string>, c: QueryContext): void {
	const id: string = assistantMsg.id;
	const reyield = id === c.fallbackMessageId;
	if (!reyield) {
		discardAbandonedAttempt(c, "non-streaming-fallback", id);
		c.replaceChildMessage(id);
		c.fallbackMessageId = id;
		c.streamAttempt = null;
	}
	debug(`processAssistantMessage: non-streaming replacement ${id}: ${assistantMsg.content.length} blocks, types=${assistantMsg.content.map((b: any) => b.type).join(",")}${reyield ? " (re-yield)" : ""}`);
	renderCompletedBlocks(c, assistantMsg.content, customToolNameToPi, "non-streaming replacement");
	if (assistantMsg.usage && c.turnOutput) updateUsage(c.turnOutput, assistantMsg.usage, model, c);
	if (c.turnSawToolCall) {
		scheduleToolUseTurnEnd(c, () => finalizeToolUseTurnAtAssistantBoundary(c), "non-streaming-replacement");
		noteToolUseStreamActivity(c);
	}
}

export function processAssistantMessage(message: SDKMessage, model: Model<any>, customToolNameToPi: Map<string, string>, c: QueryContext = ctx()): void {
	const assistantMsg = (message as any).message;
	if (!assistantMsg?.content) return;
	// A completed SDK message can lag behind the tool-use turn that Pi already
	// consumed. In particular, repeated no-stream assistant yields can expand as
	// later siblings in a parallel batch become available. Keep their ids for
	// handler matching, but never append to the delivered turnOutput object.
	if (!c.currentPiStream || !c.turnOutput) {
		appendMissingToolUsesFromAssistant(assistantMsg, model, customToolNameToPi, c);
		return;
	}
	updateTurnResponseModel(assistantMsg.model, c);
	if (isNonStreamingReplacement(message, assistantMsg, c)) {
		renderNonStreamingReplacement(assistantMsg, model, customToolNameToPi, c);
		return;
	}
	if (c.turnSawStreamEvent) {
		// The SDK yields a completed assistant copy per content block, just
		// before that block's content_block_stop and well before the stream's
		// message_delta/message_stop (the norm, not a fallback). Record any
		// tool_use blocks the stream hasn't delivered yet, but do NOT end the pi
		// stream here: later sibling blocks may still be streaming, message_delta
		// carries the message's real output-token count, and message_stop is the
		// normal turn end. Ending here freezes usage at the message_start
		// placeholders. The grace timer force-ends the turn if the stream goes
		// silent, so pi still gets to execute the tools and unblock the MCP
		// handlers.
		if (appendMissingToolUsesFromAssistant(assistantMsg, model, customToolNameToPi, c)) {
			c.turnSawToolCall = true;
			scheduleToolUseTurnEnd(c, () => finalizeToolUseTurnAtAssistantBoundary(c), "assistant-boundary");
		}
		return;
	}
	// The SDK yields the SAME assistant message more than once (per-block
	// partial copies and the completed message share one id). With stream
	// events, the streamed path already renders content and the duplicates are
	// naturally ignored; on this no-stream-events path, re-rendering each
	// yield wholesale prints a rate-limited turn's "You've hit your weekly
	// limit" twice. Same-message yields keep the turn's tracking (a reset
	// mid-message would wipe live tool-claim state) and render only blocks not
	// already rendered.
	const sameMessage = typeof assistantMsg.id === "string" && assistantMsg.id.length > 0 && assistantMsg.id === c.currentMessageId;
	if (!sameMessage) {
		reapStaleQueuedResults(c);
		c.resetToolTracking();
	}
	// The no-stream-events path also sees a message boundary. It is keyed on the
	// message ID rather than trusted blindly, because this branch is ALSO reached
	// for a message whose `message_start` already streamed — any message that
	// produced no content blocks, since `turnSawStreamEvent` only tracks those.
	c.beginChildMessage(assistantMsg.id);
	debug(`processAssistantMessage fallback: ${assistantMsg.content.length} blocks, types=${assistantMsg.content.map((b: any) => b.type).join(",")}${sameMessage ? " (same message re-yield)" : ""}`);
	renderCompletedBlocks(c, assistantMsg.content, customToolNameToPi, "processAssistantMessage fallback");
	if (assistantMsg.usage && c.turnOutput) updateUsage(c.turnOutput, assistantMsg.usage, model, c);

	// End the stream on tool_use. Immediate (no grace deferral) ON PURPOSE: this
	// branch only runs when NO content blocks streamed for the message, so there
	// is no reason to expect terminal stream events either, and the completed
	// message's own usage — applied just above — is the best figure available.
	if (c.turnSawToolCall && c.currentPiStream && c.turnOutput) {
		endToolUseTurn(c);
	}
}
