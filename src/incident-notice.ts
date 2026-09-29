// Agent notices and the incident note tool (enabled by a user-scoped
// `incidents.repo` only).
//
// The first time a non-expected signature occurs in a Pi session, that
// session gets one `claude-bridge-incident` message for its next turn
// (`deliverAs: "nextTurn"`): Pi appends it after the next user prompt, and
// convertToLlm turns it into a user message, so the bridge sees ordinary
// appended user input and keeps reusing Claude's session. At most one notice
// per signature and NOTICES_PER_SESSION per session. The notice waits for the
// filing queued with the occurrence, so it can name the issue.
//
// A notice goes to the Pi session whose request hit the incident, through the
// sendMessage of the extension instance that session loaded: an in-process
// subagent loads its own copy of the bridge, while the primary copy serves
// every session's requests and records their incidents. The senders, what
// each session was told, and the primary copy's note handler are therefore
// process-global.
//
// What a session was told (its signatures, and so its budget) is kept by Pi
// session id apart from its sender. Pi reloads a session in place
// (session_shutdown, then session_start, both with reason "reload", into a
// freshly loaded copy): the shutdown drops only the sender, since the
// unloaded copy's sendMessage must never be used again, and the next
// session_start attaches the new copy's sender to the state the session
// already has. The state of the NOTICE_SESSIONS_KEPT most recently started
// sessions is kept.

import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { debug } from "./debug.js";
import { MAX_NOTE_LENGTH, NoteRefused, fileIncidentNote, filingRepo, whenFilingSettles } from "./incident-filer.js";
import { findIncident, type Incident } from "./incidents.js";
import { piSessionOfLane } from "./query-state.js";
import { currentRequestLaneId } from "./request-lane.js";

export const INCIDENT_NOTICE_TYPE = "claude-bridge-incident";
export const INCIDENT_NOTE_TOOL = "claude_bridge_incident_note";
const NOTICES_PER_SESSION = 3;
export const NOTICE_SESSIONS_KEPT = 64;

type SendMessage = ExtensionAPI["sendMessage"];
type NoteHandler = (incidentId: string, note: string) => Promise<string>;

interface IncidentNoticeStoreV2 {
	/** The live sendMessage of each started session's copy. */
	senders: Map<string, SendMessage>;
	/** Signatures each session was told about, oldest started session first. */
	noticed: Map<string, Set<string>>;
	/** The note handler of the copy that records incidents (the primary). */
	note: NoteHandler | undefined;
}

const NOTICE_STORE_SYMBOL = Symbol.for("kendex.pi.claude-bridge.incident-notices.v2");

function noticeStore(): IncidentNoticeStoreV2 {
	const host = globalThis as Record<symbol, unknown>;
	let store = host[NOTICE_STORE_SYMBOL] as IncidentNoticeStoreV2 | undefined;
	if (!store) {
		store = { senders: new Map(), noticed: new Map(), note: undefined };
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
export function noticeText(incident: Incident, repo: string): string {
	const { label: name, site } = label(incident.signature);
	const filed = incident.issue !== undefined ? `Filed as ${repo}#${incident.issue}.` : `Not filed yet${incident.filing ? ` (${incident.filing})` : ""}.`;
	return `Pi Claude bridge incident ${incident.id} (${incident.class}: ${name} at ${site}). ${filed} If you saw related behavior in this session, add it with ${INCIDENT_NOTE_TOOL}.`;
}

/** The incident listener (setIncidentListener): tells the Pi session of the
 *  current request lane about a signature new to it, once its filing
 *  settles. */
export function noticeIncident(incident: Incident): void {
	if (incident.class === "expected") return;
	const sessionId = piSessionOfLane(currentRequestLaneId());
	if (sessionId === undefined) return;
	const store = noticeStore();
	const noticed = store.noticed.get(sessionId);
	if (!noticed || !store.senders.has(sessionId) || noticed.has(incident.signature) || noticed.size >= NOTICES_PER_SESSION) return;
	noticed.add(incident.signature);
	const delivery = whenFilingSettles()
		.then(() => {
			const repo = filingRepo();
			// The sender now: a reload meanwhile replaced the copy that was live
			// when the incident happened.
			const send = noticeStore().senders.get(sessionId);
			if (!repo || !send) {
				// Not told after all (the session ended, or filing was switched off).
				noticed.delete(incident.signature);
				return;
			}
			send({ customType: INCIDENT_NOTICE_TYPE, content: noticeText(incident, repo), display: true, details: { incident: incident.id } }, { deliverAs: "nextTurn" });
		})
		.catch((error) => debug("incidents: notice failed:", error))
		.finally(() => deliveries.delete(delivery));
	deliveries.add(delivery);
}

/** The note tool's work in this copy: adds `note` to the issue of the
 *  incident with id `incidentId`, or keeps it until there is one. */
export async function addIncidentNote(incidentId: string, note: string): Promise<string> {
	const incident = findIncident(incidentId);
	if (!incident) throw new Error(`Unknown incident ${incidentId}: no incident with that id in this Pi process.`);
	try {
		const outcome = await fileIncidentNote(incident, note);
		return outcome.status === "added"
			? `Added your note to ${outcome.repo}#${outcome.issue} (incident ${incident.id}).`
			: `Kept your note on incident ${incident.id}: it is not filed yet (${outcome.reason}). The note is added to its issue when it is filed.`;
	} catch (error) {
		if (error instanceof NoteRefused) throw new Error(error.message);
		throw error;
	}
}

/** Makes this copy's note handler the one every copy's tool uses. */
export function claimIncidentNotes(): void {
	const store = noticeStore();
	if (!store.note) store.note = addIncidentNote;
}

export function releaseIncidentNotes(): void {
	const store = noticeStore();
	if (store.note === addIncidentNote) store.note = undefined;
}

const NOTE_PARAMETERS = Type.Object({
	incident: Type.String({ description: "The incident id from the bridge's notice or error text, such as bi-7f3a." }),
	note: Type.String({ description: `What you observed, at most ${MAX_NOTE_LENGTH} characters.` }),
});

/** The note tool, registered once at extension load when incidents are
 *  enabled, so the tool list stays the same for the whole process. */
export function incidentNoteTool(): ToolDefinition<typeof NOTE_PARAMETERS> {
	return {
		name: INCIDENT_NOTE_TOOL,
		label: "Claude bridge incident note",
		description: "Add what you observed to the GitHub issue of a Claude bridge incident (an id such as bi-7f3a, from a bridge notice or error message). " +
			"Describe the observed behavior only: what you were doing, what happened, and what you expected. " +
			`Do not include secrets, credentials, prompt text, file contents or other user data. At most ${MAX_NOTE_LENGTH} characters.`,
		parameters: NOTE_PARAMETERS,
		async execute(_toolCallId, params) {
			const handler = noticeStore().note ?? addIncidentNote;
			const text = await handler(params.incident, params.note);
			return { content: [{ type: "text", text }], details: undefined };
		},
	};
}

// --- Test seams ---

export async function __testFlushNotices(): Promise<void> {
	while (deliveries.size > 0) await Promise.all([...deliveries]);
}

export function __testResetNotices(): void {
	const store = noticeStore();
	store.senders.clear();
	store.noticed.clear();
	store.note = undefined;
	deliveries.clear();
}
