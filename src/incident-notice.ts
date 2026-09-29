// Agent notices (enabled by a user-scoped `incidents.repo` only).
//
// The first time a non-expected signature occurs in a Pi session, that
// session gets one `claude-bridge-incident` message for its next turn
// (`deliverAs: "nextTurn"`): Pi appends it after the next user prompt, and
// convertToLlm turns it into a user message, so the bridge sees ordinary
// appended user input and keeps reusing Claude's session. At most one notice
// per signature and NOTICES_PER_SESSION per session. The notice points the
// agent at the claude_bridge_incident tool, to inspect the incident and file
// it if it looks like a bridge bug.
//
// A notice goes to the Pi session whose request hit the incident, through the
// sendMessage of the extension instance that session loaded: an in-process
// subagent loads its own copy of the bridge, while the primary copy serves
// every session's requests and records their incidents. The senders and what
// each session was told are therefore process-global.
//
// What a session was told (its signatures, and so its budget) is kept by Pi
// session id apart from its sender. Pi reloads a session in place
// (session_shutdown, then session_start, both with reason "reload", into a
// freshly loaded copy): the shutdown drops only the sender, since the
// unloaded copy's sendMessage must never be used again, and the next
// session_start attaches the new copy's sender to the state the session
// already has. The state of the NOTICE_SESSIONS_KEPT most recently started
// sessions is kept.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { debug } from "./debug.js";
import { filingRepo } from "./incident-filer.js";
import { INCIDENT_TOOL } from "./incident-tool.js";
import type { Incident } from "./incidents.js";
import { piSessionOfLane } from "./query-state.js";
import { currentRequestLaneId } from "./request-lane.js";

export const INCIDENT_NOTICE_TYPE = "claude-bridge-incident";
const NOTICES_PER_SESSION = 3;
export const NOTICE_SESSIONS_KEPT = 64;

type SendMessage = ExtensionAPI["sendMessage"];

interface IncidentNoticeStoreV2 {
	/** The live sendMessage of each started session's copy. */
	senders: Map<string, SendMessage>;
	/** Signatures each session was told about, oldest started session first. */
	noticed: Map<string, Set<string>>;
}

const NOTICE_STORE_SYMBOL = Symbol.for("kendex.pi.claude-bridge.incident-notices.v2");

function noticeStore(): IncidentNoticeStoreV2 {
	const host = globalThis as Record<symbol, unknown>;
	let store = host[NOTICE_STORE_SYMBOL] as IncidentNoticeStoreV2 | undefined;
	if (!store) {
		store = { senders: new Map(), noticed: new Map() };
		host[NOTICE_STORE_SYMBOL] = store;
	}
	return store;
}

const deliveries = new Set<Promise<void>>();

/** Pi session `sessionId` started in the extension instance whose
 *  sendMessage is `send`. A session started before (a reload) keeps what it
 *  was told. */
export function registerNoticeTarget(sessionId: string, send: SendMessage): void {
	const store = noticeStore();
	store.senders.set(sessionId, send);
	// Most recently started last, so the oldest state goes first.
	const noticed = store.noticed.get(sessionId) ?? new Set<string>();
	store.noticed.delete(sessionId);
	store.noticed.set(sessionId, noticed);
	for (const id of store.noticed.keys()) {
		if (store.noticed.size <= NOTICE_SESSIONS_KEPT) break;
		if (!store.senders.has(id)) store.noticed.delete(id);
	}
}

/** Session `sessionId` shut down (or reloads): its copy's sender is gone. What
 *  it was told stays for its next session_start. */
export function releaseNoticeTarget(sessionId: string): void {
	noticeStore().senders.delete(sessionId);
}

function label(signature: string): { label: string; site: string } {
	const at = signature.indexOf("@");
	return { label: signature.slice(0, at), site: signature.slice(at + 1) };
}

/** The notice for `incident`: bridge prose around validated metadata. */
export function noticeText(incident: Incident): string {
	const { label: name, site } = label(incident.signature);
	return `Pi Claude bridge incident ${incident.id} (${incident.class}: ${name} at ${site}). Use ${INCIDENT_TOOL} show ${incident.id} to inspect it. If it looks like a bridge bug, file it with ${INCIDENT_TOOL} file and tell the user.`;
}

/** The incident listener (setIncidentListener): tells the Pi session of the
 *  current request lane about a signature new to it, on a later microtask. */
export function noticeIncident(incident: Incident): void {
	if (incident.class === "expected") return;
	const sessionId = piSessionOfLane(currentRequestLaneId());
	if (sessionId === undefined) return;
	const store = noticeStore();
	const noticed = store.noticed.get(sessionId);
	if (!noticed || !store.senders.has(sessionId) || noticed.has(incident.signature) || noticed.size >= NOTICES_PER_SESSION) return;
	noticed.add(incident.signature);
	const delivery = Promise.resolve()
		.then(() => {
			// The sender now: a reload meanwhile replaced the copy that was live
			// when the incident happened.
			const send = noticeStore().senders.get(sessionId);
			if (!filingRepo() || !send) {
				// Not told after all (the session ended, or filing was switched off).
				noticed.delete(incident.signature);
				return;
			}
			send({ customType: INCIDENT_NOTICE_TYPE, content: noticeText(incident), display: true, details: { incident: incident.id } }, { deliverAs: "nextTurn" });
		})
		.catch((error) => debug("incidents: notice failed:", error))
		.finally(() => deliveries.delete(delivery));
	deliveries.add(delivery);
}

// --- Test seams ---

export async function __testFlushNotices(): Promise<void> {
	while (deliveries.size > 0) await Promise.all([...deliveries]);
}

export function __testResetNotices(): void {
	const store = noticeStore();
	store.senders.clear();
	store.noticed.clear();
	deliveries.clear();
}
