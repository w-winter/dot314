// Which requests come from Pi's main agent. The systemPrompt replacement
// applies to that agent's prompt only; every other system prompt (Pi's own
// compaction and branch summaries, an extension's one-shot call, side chat,
// the subagent watchdog) reaches Claude unchanged, whatever its text says.

/** Where a request's system prompt came from, as the provider sees it. */
export interface SystemPromptOrigin {
	/** The request's replayed `preamble` section ("" if absent) when its system
	 * message carries sections, undefined when it carries none. Only Pi's
	 * session builds its prompt from sections; one-shot calls send plain
	 * content. The preamble tells Pi's default base from a session's own
	 * (config.ts::resolveSystemPrompt). */
	preamble?: string;
	/** The request's `options.sessionId`. */
	sessionId?: string;
	/** The request's `options.cacheRetention`. */
	cacheRetention?: string;
}

// Session ids of the Pi sessions started in this process, added at
// session_start and removed at its session_shutdown (bridge-state's started
// lanes). On globalThis because the two events can reach different module
// instances (`/reload` mid-session, a child agent's own copy of the bridge).
const LIVE_SESSIONS_SYMBOL = Symbol.for("kendex.pi.claude-bridge.live-pi-sessions.v1");

function liveSessions(): Set<string> {
	const host = globalThis as Record<symbol, unknown>;
	let sessions = host[LIVE_SESSIONS_SYMBOL] as Set<string> | undefined;
	if (!sessions) {
		sessions = new Set<string>();
		host[LIVE_SESSIONS_SYMBOL] = sessions;
	}
	return sessions;
}

export function notePiSessionStarted(sessionId: string): void {
	liveSessions().add(sessionId);
}

export function notePiSessionEnded(sessionId: string): void {
	liveSessions().delete(sessionId);
}

/**
 * How a request is known to come from Pi's main agent, or undefined when it
 * does not.
 *
 * - `sections`: Pi's session sends its prompt as a sections-only system
 *   message (AgentSession._preparePromptAndToolLoadout).
 * - `session`: a `before_agent_start` handler's prompt replaces those sections
 *   with plain content (_installAgentForcedPromptProjection), so provenance
 *   comes from the request. The main agent sends the live session's id
 *   (sdk.ts: `sessionId: sessionManager.getSessionId()`) and no
 *   cacheRetention. Pi's summaries go through completeSummarization, which
 *   always sets cacheRetention "none" and a fresh id unless the caller passes
 *   one (the bug-report summary passes the session's id); extension one-shots
 *   send no id or their own.
 */
export function piMainPromptEvidence(origin: SystemPromptOrigin | undefined): "sections" | "session" | undefined {
	if (!origin) return undefined;
	if (origin.preamble !== undefined) return "sections";
	if (origin.sessionId !== undefined && origin.cacheRetention !== "none" && liveSessions().has(origin.sessionId)) return "session";
	return undefined;
}
