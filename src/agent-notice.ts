// Agent notices. With `agentNotices: true` in the user claude-bridge.json, a
// bridge anomaly the agent would otherwise never see (an error the bridge
// wrote, or a problem it recovered from) is told to the Pi session whose
// request hit it, once per kind per session. Everything pending for a session
// goes out as one `claude-bridge-notice` message that the session's
// before_agent_start handler returns with its next prompt. Pi puts that
// message after the user's prompt
// and convertToLlm makes it a user message, so the bridge sees ordinary
// appended user input and keeps reusing Claude's session. The bridge never
// sends a message or starts a turn of its own for an anomaly. Without the
// switch nothing is queued or told, whatever CLAUDE_BRIDGE_DEBUG says; that
// variable only decides whether the details are also in the bridge logs.
//
// Anomalies are noted by the copy of the bridge that serves the requests,
// while each session (an in-process subagent too, and every session after a
// /reload) runs the before_agent_start handler of the copy it loaded. The
// pending kinds and what each session was told are therefore kept
// process-global, by Pi session id, for the AGENT_NOTICE_SESSIONS_KEPT
// sessions most recently noted or prompted, and every copy reads the switch
// from the file when it notes or tells.

import type { BeforeAgentStartEventResult } from "@earendil-works/pi-coding-agent";
import { agentNoticesEnabled, displayPath } from "./config.ts";
import { DEBUG, DEBUG_LOG_PATH, debug, diagLogPath } from "./debug.ts";
import { piSessionOfLane } from "./query-state.ts";
import { currentRequestLaneId } from "./request-lane.ts";

export const AGENT_NOTICE_TYPE = "claude-bridge-notice";
export const AGENT_NOTICE_SESSIONS_KEPT = 64;
// Header and closing line included.
const MESSAGE_LINES = 20;

// The one table of told kinds, keyed by diag label (or, for an anomaly with no
// diag entry, the name its call site notes it under). Expected cleanup and
// reports from the API or Claude Code are not here and are never told.
const TOLD = {
	// --- an error was shown to Claude or Pi ---
	tool_handler_unmatched: { sentence: "Claude Code called a Pi tool (tools/call) that the bridge could not match to any tool call in Claude's stream, so Claude got an error for it.", errorShown: true },
	tool_handler_stranded: { sentence: "A Pi tool call Claude was waiting on was left without a result when its query moved on, so Claude got an error for it.", errorShown: true },
	tool_handlers_stranded: { sentence: "Several Pi tool calls Claude was waiting on were left without results when the query ended, so Claude got errors for them.", errorShown: true },
	tool_call_already_answered: { sentence: "Claude Code asked for the result of a tool call the bridge had already answered.", errorShown: true },
	tool_call_id_other_tool: { sentence: "Claude Code sent a tool call id that the bridge recorded for a different tool.", errorShown: true },
	tool_call_dead: { sentence: "Claude Code called a tool whose call had already ended.", errorShown: true },
	steering_delivery_failed: { sentence: "A message sent while Claude was working could not be written to the running query.", errorShown: true },
	repair_tool_pairing_synthetic_results: { sentence: "History given to Claude Code had tool calls without results; the bridge filled in placeholder results.", errorShown: true },
	tool_no_longer_active: { sentence: "Claude Code called a Pi tool that is no longer active in Pi.", errorShown: true },
	tool_results_unmatched: { sentence: "Pi returned tool results for calls this query did not make.", errorShown: true },
	claude_account_not_connected: { sentence: "A request was made with no Claude account connected.", errorShown: true },
	stream_idle_timeout: { sentence: "Claude's response stream went silent past the idle timeout and the request was ended.", errorShown: true },
	tool_calls_interrupted: { sentence: "Pi tool calls Claude was waiting on were interrupted.", errorShown: true },
	// --- the bridge recovered ---
	tool_result_delivery_mismatch: { sentence: "Tool results Pi returned did not match the tool calls the query was waiting on.", errorShown: false },
	steering_query_ended_during_write: { sentence: "The query ended while a message sent mid-turn was being written to it.", errorShown: false },
	persist_shared_session_failed: { sentence: "The bridge could not save the Claude Code session record after a query.", errorShown: false },
	session_verify_fail: { sentence: "The session file the bridge wrote for Claude Code did not read back as written.", errorShown: false },
	tool_call_abandoned_by_claude_code: { sentence: "Claude Code gave up on a tool call before Pi returned its result.", errorShown: false },
	continuation_failed_after_reply: { sentence: "Claude failed while answering a mid-turn message, after its earlier reply had completed.", errorShown: false },
	stale_queued_tool_results_parked: { sentence: "Tool results from an earlier turn were still queued when a new turn started, and were set aside.", errorShown: false },
	tool_claim_args_mismatch: { sentence: "A tool call's arguments differed between Claude's stream and Claude Code's tools/call.", errorShown: false },
	steering_write_in_flight: { sentence: "A message sent mid-turn arrived while an earlier one was still being written, and was deferred.", errorShown: false },
	deferred_user_replay_skipped: { sentence: "A deferred mid-turn message was not replayed after the query ended.", errorShown: false },
	user_message_identity_unresolved: { sentence: "The bridge could not tell whether a user message was new or one Claude already had.", errorShown: false },
	empty_prompt: { sentence: "A query started without any prompt text; the bridge sent a placeholder prompt.", errorShown: false },
	unreplayable_turn_imported_as_note: { sentence: "A rebuild could not replay Claude's latest reply exactly because part of its thinking was unsigned, so it imported that reply and its tool results as a text note.", errorShown: false },
	partial_tool_calls_pruned: { sentence: "A response ended with tool calls whose arguments never finished; the bridge dropped them.", errorShown: false },
	deferred_user_messages_dropped: { sentence: "Mid-turn messages that were waiting for delivery were dropped.", errorShown: false },
} as const satisfies Record<string, { sentence: string; errorShown: boolean }>;

export type AnomalyKind = keyof typeof TOLD;

interface SessionNotices {
	/** Kinds this session was told about, or will be with its next prompt. */
	told: Set<AnomalyKind>;
	/** Kinds for its next prompt, oldest first. */
	pending: AnomalyKind[];
}

const STORE_SYMBOL = Symbol.for("pi-claude-bridge.agent-notices.v1");

/** Least recently used session first. */
function store(): Map<string, SessionNotices> {
	const host = globalThis as Record<symbol, unknown>;
	let sessions = host[STORE_SYMBOL] as Map<string, SessionNotices> | undefined;
	if (!sessions) {
		sessions = new Map();
		host[STORE_SYMBOL] = sessions;
	}
	return sessions;
}

/** The notices of `sessionId`, now its most recently used. */
function sessionNotices(sessionId: string): SessionNotices {
	const sessions = store();
	const notices = sessions.get(sessionId) ?? { told: new Set<AnomalyKind>(), pending: [] };
	sessions.delete(sessionId);
	sessions.set(sessionId, notices);
	for (const id of sessions.keys()) {
		if (sessions.size <= AGENT_NOTICE_SESSIONS_KEPT) break;
		sessions.delete(id);
	}
	return notices;
}

/** The Pi session the current request lane serves, resolved now. A fork
 *  lane maps to its Pi session only until the fork is released, so an
 *  operation whose anomaly can be noted after its query ended captures this
 *  when it starts and passes it to noteAnomaly. */
export function currentPiSession(): string | undefined {
	return piSessionOfLane(currentRequestLaneId());
}

/** With agent notices on, queues `kind` for the next prompt of Pi session
 *  `owner` (by default the current lane's), unless that session was told
 *  about it; a repeat goes to the debug log only. */
export function noteAnomaly(kind: AnomalyKind, owner?: string): void {
	if (!agentNoticesEnabled()) return;
	const sessionId = owner ?? currentPiSession();
	if (sessionId === undefined) {
		debug(`agent notice: ${kind} outside any Pi session; not told`);
		return;
	}
	const notices = sessionNotices(sessionId);
	if (notices.told.has(kind)) {
		debug(`agent notice: ${kind} again for session ${sessionId.slice(0, 8)}; already told`);
		return;
	}
	notices.told.add(kind);
	notices.pending.push(kind);
	debug(`agent notice: ${kind} queued for session ${sessionId.slice(0, 8)}`);
}

function noticeText(kinds: AnomalyKind[]): string {
	const room = MESSAGE_LINES - 2;
	const shown = kinds.length > room ? kinds.slice(0, room - 1) : kinds;
	return [
		`Claude bridge: ${kinds.length === 1 ? "1 anomaly" : `${kinds.length} anomalies`} since your last message.`,
		...shown.map((kind) => `- ${TOLD[kind].sentence.replace(/\.$/, "")} (${kind}; ${TOLD[kind].errorShown ? "an error was shown" : "the bridge recovered"})`),
		...(kinds.length > shown.length ? [`- … and ${kinds.length - shown.length} more`] : []),
		DEBUG
			? `Details are in the bridge debug log (${displayPath(DEBUG_LOG_PATH)}) and diag log (${displayPath(diagLogPath())}). If one looks like a bridge bug, tell the user.`
			: "The bridge did not record details; the user can set CLAUDE_BRIDGE_DEBUG=1 to record them in the bridge logs. If one looks like a bridge bug, tell the user.",
	].join("\n");
}

/** The before_agent_start result for session `sessionId`: one message with
 *  every kind pending for it, or nothing. Takes them: each is told once.
 *  With agent notices off it tells nothing, even what was queued while they
 *  were on. */
export function takeAgentNotice(sessionId: string): BeforeAgentStartEventResult | undefined {
	const notices = store().get(sessionId);
	if (!notices || notices.pending.length === 0) return undefined;
	if (!agentNoticesEnabled()) return undefined;
	const kinds = sessionNotices(sessionId).pending.splice(0);
	return {
		message: {
			customType: AGENT_NOTICE_TYPE,
			content: noticeText(kinds),
			display: true,
			details: { kinds },
		},
	};
}
