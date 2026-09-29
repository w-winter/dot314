// Agent notices, always on.
//
// A user-visible or silent incident is told to the Pi session whose request
// hit it, once per signature per session; external incidents (the API or
// Claude Code reported it) and expected cleanup never are. Everything pending
// for a session goes out as one `claude-bridge-incident` message that the
// session's before_agent_start handler returns with its next prompt. Pi puts
// that message after the user's prompt (agent-session.js), and convertToLlm
// makes it a user message, so the bridge sees ordinary appended user input
// and keeps reusing Claude's session. The bridge never sends a message or
// starts a turn of its own for an incident.
//
// Incidents are recorded by the copy of the bridge that serves the requests,
// while each session (an in-process subagent too, and every session after a
// /reload) runs the before_agent_start handler of the copy it loaded. The
// pending incidents and what each session was told are therefore kept
// process-global, by Pi session id, for the NOTICE_SESSIONS_KEPT sessions
// most recently noticed or prompted.

import type { BeforeAgentStartEventResult } from "@earendil-works/pi-coding-agent";
import { describeIncident, filingRepo } from "./incident-filer.js";
import { INCIDENT_TOOL } from "./incident-tool.js";
import type { Incident } from "./incidents.js";
import { piSessionOfLane } from "./query-state.js";
import { currentRequestLaneId } from "./request-lane.js";

export const INCIDENT_NOTICE_TYPE = "claude-bridge-incident";
export const NOTICE_SESSIONS_KEPT = 64;
const NOTICE_LINES = 20;

interface SessionNotices {
	/** Signatures this session was told about, or will be with its next prompt. */
	told: Set<string>;
	/** Incidents for its next prompt, oldest first. */
	pending: Incident[];
}

interface IncidentNoticeStoreV3 {
	/** Least recently used session first. */
	sessions: Map<string, SessionNotices>;
}

const NOTICE_STORE_SYMBOL = Symbol.for("kendex.pi.claude-bridge.incident-notices.v3");

function noticeStore(): IncidentNoticeStoreV3 {
	const host = globalThis as Record<symbol, unknown>;
	let store = host[NOTICE_STORE_SYMBOL] as IncidentNoticeStoreV3 | undefined;
	if (!store) {
		store = { sessions: new Map() };
		host[NOTICE_STORE_SYMBOL] = store;
	}
	return store;
}

/** The notices of `sessionId`, now its most recently used. */
function sessionNotices(sessionId: string): SessionNotices {
	const { sessions } = noticeStore();
	const notices = sessions.get(sessionId) ?? { told: new Set<string>(), pending: [] };
	sessions.delete(sessionId);
	sessions.set(sessionId, notices);
	for (const id of sessions.keys()) {
		if (sessions.size <= NOTICE_SESSIONS_KEPT) break;
		sessions.delete(id);
	}
	return notices;
}

/** The incident listener (setIncidentListener): queues a user-visible or
 *  silent incident for the next prompt of the Pi session of the current
 *  request lane, unless that session was told about its signature. */
export function noticeIncident(incident: Incident): void {
	if (incident.class !== "user-visible" && incident.class !== "silent") return;
	const sessionId = piSessionOfLane(currentRequestLaneId());
	if (sessionId === undefined) return;
	const notices = sessionNotices(sessionId);
	if (notices.told.has(incident.signature)) return;
	notices.told.add(incident.signature);
	notices.pending.push(incident);
}

function incidentLine(incident: Incident): string {
	const at = incident.signature.indexOf("@");
	const seen = incident.class === "user-visible" ? "an error was shown" : "the bridge recovered";
	return `- ${incident.id}: ${describeIncident(incident).replace(/\.$/, "")} (${incident.signature.slice(0, at)} at ${incident.signature.slice(at + 1)}; ${seen})`;
}

/** The notice for `incidents`: bridge prose around validated labels. */
function noticeText(incidents: Incident[], filing: boolean): string {
	const shown = incidents.slice(0, NOTICE_LINES);
	return [
		`Claude bridge: ${incidents.length === 1 ? "1 incident" : `${incidents.length} incidents`} since your last message.`,
		...shown.map(incidentLine),
		...(incidents.length > shown.length ? [`- … and ${incidents.length - shown.length} more; ${INCIDENT_TOOL} list shows them.`] : []),
		filing
			? `Use ${INCIDENT_TOOL} show <id> to inspect one. If one looks like a bridge bug, file it with ${INCIDENT_TOOL} file and tell the user.`
			: `Use ${INCIDENT_TOOL} show <id> to inspect one. Filing is off: the user has not set incidents.repo in their claude-bridge.json, so do not try to file.`,
	].join("\n");
}

/** The before_agent_start result for session `sessionId`: one message with
 *  every incident pending for it, or nothing. Takes them: each is told once. */
export function takeIncidentNotice(sessionId: string): BeforeAgentStartEventResult | undefined {
	const notices = noticeStore().sessions.get(sessionId);
	if (!notices || notices.pending.length === 0) return undefined;
	const incidents = sessionNotices(sessionId).pending.splice(0);
	return {
		message: {
			customType: INCIDENT_NOTICE_TYPE,
			content: noticeText(incidents, filingRepo() !== undefined),
			display: true,
			details: { incidents: incidents.map((incident) => incident.id) },
		},
	};
}

// --- Test seams ---

export function __testResetNotices(): void {
	noticeStore().sessions.clear();
}
