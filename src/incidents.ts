// Bridge incidents: every anomaly the bridge detects, recorded while it runs.
//
// An incident is keyed by its signature (`label@site`) within this process: a
// repeat counts up and keeps the first and latest flight-recorder snapshots.
// Incidents carry metadata only (ids, names, counts, lengths, timings, labels,
// versions, site names), never prompt, tool-argument, tool-result or user text;
// diag payloads pass through projectDiagMetadata for that reason.
//
// Recording is always on and in memory. Disk writes need a USER-scoped
// `incidents.repo` (configureIncidents), and so does filing, which only the
// agent starts (incident-filer.ts, incident-tool.ts); without it nothing
// leaves the process.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { appendFile, chmod, mkdir, readFile, rename, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { piUserDir } from "./config.js";
import { DEBUG_LOG_MAX_BYTES, DEBUG_LOG_ROTATED_FILES, debug, diagDump } from "./debug.js";
import { __testResetFiler, configureFiler } from "./incident-filer.js";
import { CLAUDE_ACCOUNT_FAILURE_KINDS } from "./account-router.js";
import { RECORDER_KINDS, type FlightRecord, type FlightRecorder } from "./flight-recorder.js";
import { SDK_RESULT_SUBTYPES, SDK_SYSTEM_SUBTYPES, STREAM_ABANDON_REASONS, TURN_BLOCK_TYPES } from "./incident-labels.js";

/** user-visible: Claude or Pi got a bridge-authored error. silent: integrity
 *  mismatch, forced rebuild, dropped deferred message. expected: normal
 *  cleanup, counted only. external: Anthropic API errors, a Claude Code
 *  version change. */
export type IncidentClass = "user-visible" | "silent" | "expected" | "external";

type SiteClasses = { default: IncidentClass } & Record<string, IncidentClass>;

// The one class table. Every diag label and every other incident label is a
// key; a label whose class depends on where it fired maps sites to classes.
// An `expected` entry must be proven benign by the code at that site.
const INCIDENT_CLASSES = {
	// --- diag labels ---
	tool_handler_unmatched: "user-visible",
	tool_handler_stranded: "user-visible",
	tool_handlers_stranded: "user-visible",
	tool_call_already_answered: "user-visible",
	tool_call_id_other_tool: "user-visible",
	steering_delivery_failed: "user-visible",
	repair_tool_pairing_synthetic_results: "user-visible",
	tool_result_delivery_mismatch: "silent",
	steering_query_ended_during_write: "silent",
	persist_shared_session_failed: "silent",
	session_verify_fail: "silent",
	tool_call_abandoned_by_claude_code: "silent",
	continuation_failed_after_reply: "silent",
	stale_queued_tool_results_parked: "silent",
	tool_claim_args_mismatch: "silent",
	steering_write_in_flight: "silent",
	deferred_user_replay_skipped: "silent",
	user_message_identity_unresolved: "silent",
	empty_prompt: "silent",
	// Claude Code abandoned a stalled response and asked again; only the
	// abandoned attempt's partial blocks are dropped (completed tool calls are
	// kept), and the retry is the answer.
	stream_attempt_abandoned: "expected",
	// Claude Code cancelled a tools/call Pi had not been given; the bridge
	// drops it (withdrawCancelledToolCall returns first for a call Pi has).
	tool_call_cancelled_by_claude_code: "expected",
	// A cancelled request or a max-tokens stop leaves a call whose arguments
	// never finished; it was never issued. Anywhere else a prune cut off a call
	// Claude Code may have dispatched.
	partial_tool_calls_pruned: { default: "silent", abort: "expected", length: "expected" },
	// Steers of an aborted query: the abort marks the record for a rotated
	// rebuild, which re-imports them from Pi history.
	deferred_user_messages_dropped: { default: "silent", abort: "expected", "abort-completion": "expected" },
	// --- incidents without a diag entry ---
	tool_no_longer_active: "user-visible",
	tool_call_dead: "user-visible",
	tool_results_unmatched: "user-visible",
	third_party_app_refused: "user-visible",
	claude_account_not_connected: "user-visible",
	stream_idle_timeout: "user-visible",
	// A bridge-authored error reaching Pi that no site named: the exit it left
	// through is the site (nameBridgeErrorEvents, nameThrownBridgeError).
	bridge_error: "user-visible",
	// Handlers drained by an abort answer calls the user cancelled.
	tool_calls_interrupted: { default: "user-visible", abort: "expected" },
	api_error: "external",
	claude_code_version_changed: "external",
} as const satisfies Record<string, IncidentClass | SiteClasses>;

export type IncidentLabel = keyof typeof INCIDENT_CLASSES;

// The one site table: every site an incident is reported at. reportIncident
// takes only these, and only `label@site` signatures made of this table and
// INCIDENT_CLASSES are filed (incident-filer.ts).
export const INCIDENT_SITES = [
	// named call sites
	"answerUnclaimedToolUse", "consumeQuery", "convertAndImportMessages", "deliverSteerBeforeResults",
	"discardAbandonedAttempt", "endStreamForFailure", "failSteeringDelivery", "finalize-no-stream", "init",
	"mcpToolHandler", "noteAbandonedToolCalls", "reapStaleQueuedResults", "resolveToolResults",
	"schedulePersistSharedSession", "streamIdleWatchdog", "streamRequestInLane", "verifyWrittenSession",
	"withdrawCancelledToolCall",
	// the two exits a bridge-authored error reaches Pi through
	"error-event", "provider-throw",
	// where a terminal message pruned partial tool calls (terminalMessage)
	"abort", "length", "stream-end", "failure", "tool-use-end", "unknown",
	// a message ended with every tool call of the turn cut off (dropUnclosedBlocks)
	"message-stop",
	// why deferred user messages were dropped (dropDeferredUserMessages)
	"abort-completion", "continuation-error", "continuation-failure", "continuation-no-resume-id", "query-error",
	"stream-idle-timeout", "stream-idle-timeout-completion", "terminal-failure",
	// why waiting tool calls were drained (ToolCallDrainCause)
	"query-end",
	// why a tool-result delivery mismatch was reported (reportToolResultMismatch)
	"query-teardown", "unmatched-tool-result", "session_compact", "session_tree",
] as const;

export type IncidentSite = typeof INCIDENT_SITES[number];

const SITE_SET: ReadonlySet<string> = new Set(INCIDENT_SITES);

/** Whether `signature` is a `label@site` of the class and site tables. */
export function isKnownSignature(signature: string): boolean {
	const at = signature.indexOf("@");
	return at > 0 && Object.hasOwn(INCIDENT_CLASSES, signature.slice(0, at)) && SITE_SET.has(signature.slice(at + 1));
}

export function incidentClass(label: IncidentLabel, site: string): IncidentClass {
	const entry: IncidentClass | SiteClasses = INCIDENT_CLASSES[label];
	if (typeof entry === "string") return entry;
	return entry[site] ?? entry.default;
}

export interface IncidentVersions {
	bridge?: string;
	claudeCode?: string;
	pi?: string;
}

export interface Incident {
	id: string;
	signature: string;
	class: IncidentClass;
	count: number;
	firstSeen: string;
	lastSeen: string;
	versions: IncidentVersions;
	model?: string;
	/** Recorder snapshot at the first occurrence; latestSnapshot at the latest.
	 *  null when the incident happened before its request's query started:
	 *  there is no timeline of that request, and an earlier query's is not it. */
	snapshot?: FlightRecord[] | null;
	latestSnapshot?: FlightRecord[] | null;
	/** "before-query" when the first occurrence came before the SDK query. */
	phase?: "before-query";
	diag: Record<string, unknown>;
	latestDiag?: Record<string, unknown>;
	/** The issue in `incidents.repo` the agent filed this incident as, or
	 *  commented on. */
	issue?: number;
}

/** What an incident takes from the query it happened in (a QueryContext).
 *  preQueryModel is set while the request that owns the context has not
 *  started its SDK query (QueryContext.preQueryModel): its recorder and turn
 *  output then still belong to an earlier query, so an incident takes only
 *  that requested model and no snapshot. */
export interface IncidentSource {
	recorder?: Pick<FlightRecorder, "snapshot">;
	turnOutput?: { model?: string; responseModel?: string } | null;
	preQueryModel?: string | null;
}

// --- Versions ---

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readGitFile(path: string): string | undefined {
	try { return readFileSync(path, "utf8").trim(); } catch { return undefined; }
}

/** The commit the bridge was loaded from, read once from its clone's `.git`
 *  (a directory, or a worktree's `gitdir:` file). Undefined outside a clone. */
function readBridgeCommit(root: string): string | undefined {
	try {
		let gitDir = join(root, ".git");
		const pointer = readGitFile(gitDir);
		if (pointer?.startsWith("gitdir:")) gitDir = resolve(root, pointer.slice("gitdir:".length).trim());
		else if (!existsSync(join(gitDir, "HEAD"))) return undefined;
		const commonDirRef = readGitFile(join(gitDir, "commondir"));
		const commonDir = commonDirRef ? resolve(gitDir, commonDirRef) : gitDir;
		const head = readGitFile(join(gitDir, "HEAD"));
		if (!head) return undefined;
		if (!head.startsWith("ref:")) return /^[0-9a-f]{40}$/.test(head) ? head.slice(0, 12) : undefined;
		const ref = head.slice("ref:".length).trim();
		const loose = readGitFile(join(gitDir, ref)) ?? readGitFile(join(commonDir, ref));
		if (loose && /^[0-9a-f]{40}$/.test(loose)) return loose.slice(0, 12);
		const packed = readGitFile(join(commonDir, "packed-refs"));
		const line = packed?.split("\n").find((entry) => entry.endsWith(` ${ref}`));
		const sha = line?.split(" ")[0];
		return sha && /^[0-9a-f]{40}$/.test(sha) ? sha.slice(0, 12) : undefined;
	} catch {
		return undefined;
	}
}

/** The host Pi's version, from the package its CLI entry belongs to. Read
 *  from disk: importing the host package from here would evaluate it again. */
function readPiVersion(): string | undefined {
	try {
		const entry = process.argv[1];
		if (!entry) return undefined;
		let dir = dirname(realpathSync(entry));
		for (let i = 0; i < 6; i++) {
			const pkg = readGitFile(join(dir, "package.json"));
			if (pkg) {
				const parsed = JSON.parse(pkg) as { name?: unknown; version?: unknown };
				if ((parsed.name === "@earendil-works/pi-coding-agent" || parsed.name === "@mariozechner/pi-coding-agent") && typeof parsed.version === "string") return parsed.version;
			}
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	} catch { /* not a Pi process */ }
	return undefined;
}

const BRIDGE_COMMIT = readBridgeCommit(PACKAGE_ROOT);
const PI_VERSION = readPiVersion();
let claudeCodeVersion: string | undefined;

// --- Evidence projection ---
//
// Every string an incident keeps is evidence of one kind, validated where it
// is recorded: it has the exact shape of its kind, or it is replaced by a
// placeholder naming the field. A label (a diag `kind`, `subtype`, `type` or
// `why`, a recorder kind) must be a member of its finite code-owned set
// (incident-labels.ts, RECORDER_KINDS), not merely label-shaped: an unknown
// one becomes `[unknown <field>]`. Nothing is scanned for secrets, because no
// text rule tells a long identifier from a key; a kind's shape leaves no room
// for one. A tool name is kept only when Pi registered that tool in this
// process (noteRegisteredToolNames): configuration, not a secret, however
// long. Strings of no known kind (error text, a reason Claude Code wrote,
// paths) are left out and listed in `droppedFields`. Argument property names
// (`argKeys`, `handlerArgKeys`, ...) come from the caller's tool arguments, and
// a tool may take free text as property names: only their count is kept.

type LabelField = "kind" | "subtype" | "type" | "why";
type EvidenceKind = "toolName" | "toolUseId" | "messageId" | "sessionId" | "site" | LabelField | "role" | "roles" | "version" | "errorName" | "errorCode" | "syscall";

// The set each label field is checked against: the failure kinds the
// classifier gives an api_error (or "unclassified"), the SDK subtypes the
// bridge handles, the block types of a discarded attempt, and why an attempt
// was discarded. No code writes a diag `source`: it is not kept.
const LABEL_SETS: Record<LabelField, ReadonlySet<string>> = {
	kind: new Set([...CLAUDE_ACCOUNT_FAILURE_KINDS, "unclassified"]),
	subtype: new Set([...SDK_RESULT_SUBTYPES, ...SDK_SYSTEM_SUBTYPES]),
	type: new Set(TURN_BLOCK_TYPES),
	why: new Set(STREAM_ABANDON_REASONS),
};
const RECORDER_KIND_SET: ReadonlySet<string> = new Set(RECORDER_KINDS);

const FIELD_KINDS: Record<string, EvidenceKind> = {
	toolName: "toolName", name: "toolName", recordedName: "toolName",
	id: "toolUseId", toolCallId: "toolUseId",
	messageId: "messageId", replacementMessageId: "messageId",
	sessionId: "sessionId",
	site: "site", cause: "site",
	why: "why", kind: "kind", subtype: "subtype", type: "type",
	lastMsgRole: "role", promptRoles: "roles", messageRoles: "roles",
	version: "version", previousVersion: "version",
	errorName: "errorName", code: "errorCode", syscall: "syscall",
};

function kindOf(key: string): EvidenceKind | undefined {
	return Object.hasOwn(FIELD_KINDS, key) ? FIELD_KINDS[key] : key.endsWith("Id") || key.endsWith("Ids") ? "toolUseId" : undefined;
}

// Claude's tool_use ids: `toolu_01` and 22 base62 characters (all 2,094
// distinct ids in the bridge's own logs, and the ids in this repo's tests);
// server tools use `srvtoolu_` with the same body. Message ids likewise.
const TOOL_USE_ID = /^(?:srv)?toolu_01[A-Za-z0-9]{22}$/;
const MESSAGE_ID = /^msg_01[A-Za-z0-9]{22}$/;
// A Claude Code session UUID, or the 8-character prefix the bridge logs.
const SESSION_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{8})$/;
const SEMVER = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z]{1,20}(?:\.[0-9A-Za-z]{1,20}){0,3})?$/;
const ERROR_NAME = /^(?:[A-Z][A-Za-z]{0,47})?Error$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,31}$/;
const SYSCALL = /^[a-z][a-z_]{0,15}$/;
const MODEL = /^claude-[a-z0-9-]{1,48}$/;
const COMMIT = /^[0-9a-f]{12}$/;
// Pi's message roles, and the bridge's own system message.
const ROLES: ReadonlySet<string> = new Set(["user", "assistant", "toolResult", "system", "custom", "bashExecution", "branchSummary", "compactionSummary"]);
const ROLE_TOKEN = /^(?:\[\d{1,6}\])?([A-Za-z]{1,24})$/;
// A key the bridge's code wrote into a diag object.
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9]{0,29}$/;
const MAX_ROLES_LENGTH = 200;
const MAX_ARRAY_LENGTH = 50;
const MAX_DEPTH = 5;
const REGISTERED_TOOL_NAMES_MAX = 4096;

const registeredToolNames = new Set<string>();

/** Records the tools Pi offers in a request (Pi's names and the names they
 *  are served to Claude under): the tool names an incident may keep. */
export function noteRegisteredToolNames(names: Iterable<string>): void {
	for (const name of names) {
		if (registeredToolNames.size >= REGISTERED_TOOL_NAMES_MAX) return;
		if (typeof name === "string" && name.length > 0) registeredToolNames.add(name);
	}
}

/** A role list (`user user`, `[0]system [1]user`) of Pi's roles only, cut to
 *  whole entries. */
function roleList(value: string): string | undefined {
	const tokens = value.split(" ");
	if (!tokens.every((token) => ROLES.has(ROLE_TOKEN.exec(token)?.[1] ?? ""))) return undefined;
	if (value.length <= MAX_ROLES_LENGTH) return value;
	let kept = "";
	let count = 0;
	for (const token of tokens) {
		if (kept.length + token.length + 1 > MAX_ROLES_LENGTH - 12) break;
		kept += (count++ ? " " : "") + token;
	}
	return `${kept} +${tokens.length - count} more`;
}

/** `value` if it has the shape of `kind`, else a placeholder naming `key`. */
function evidence(kind: EvidenceKind, key: string, value: string): string {
	const invalid = `[invalid ${key}]`;
	switch (kind) {
		case "toolName": return registeredToolNames.has(value) ? value : "[unregistered tool name]";
		case "toolUseId": return TOOL_USE_ID.test(value) ? value : invalid;
		case "messageId": return MESSAGE_ID.test(value) ? value : invalid;
		case "sessionId": return SESSION_ID.test(value) ? value : invalid;
		case "site": return SITE_SET.has(value) ? value : invalid;
		case "kind": case "subtype": case "type": case "why": return LABEL_SETS[kind].has(value) ? value : `[unknown ${key}]`;
		case "role": return ROLES.has(value) ? value : invalid;
		case "roles": return roleList(value) ?? invalid;
		case "version": return SEMVER.test(value) ? value : invalid;
		case "errorName": return ERROR_NAME.test(value) ? value : invalid;
		case "errorCode": return ERROR_CODE.test(value) ? value : invalid;
		case "syscall": return SYSCALL.test(value) ? value : invalid;
	}
}

/** `data` reduced to validated metadata: numbers, booleans and null, strings
 *  of a known kind (validated, see above), and a `<name>KeyCount` for each
 *  `<name>Keys` list. */
export function projectDiagMetadata(data: Record<string, unknown>): Record<string, unknown> {
	const dropped: string[] = [];
	const project = (value: unknown, key: string, path: string, depth: number): unknown => {
		if (value === null || typeof value === "number" || typeof value === "boolean") return value;
		if (typeof value === "string") {
			const kind = kindOf(key);
			if (kind) return evidence(kind, key, value);
			dropped.push(path);
			return undefined;
		}
		if (depth >= MAX_DEPTH) {
			dropped.push(path);
			return undefined;
		}
		if (Array.isArray(value)) {
			return value.slice(0, MAX_ARRAY_LENGTH).map((item) => project(item, key, `${path}[]`, depth + 1)).filter((item) => item !== undefined);
		}
		if (typeof value === "object") {
			const out: Record<string, unknown> = {};
			for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
				if (!FIELD_NAME.test(childKey)) {
					// A key that is data (an id or a name), not a field the code wrote.
					dropped.push(path ? `${path}.[invalid key]` : "[invalid key]");
					continue;
				}
				if (childKey.endsWith("Keys")) {
					if (Array.isArray(child)) out[`${childKey.slice(0, -"Keys".length)}KeyCount`] = child.length;
					else dropped.push(path ? `${path}.${childKey}` : childKey);
					continue;
				}
				const projected = project(child, childKey, path ? `${path}.${childKey}` : childKey, depth + 1);
				if (projected !== undefined) out[childKey] = projected;
			}
			return out;
		}
		return undefined;
	};
	const out = project(data, "", "", 0) as Record<string, unknown>;
	if (dropped.length > 0) out.droppedFields = [...new Set(dropped)];
	return out;
}

/** A recorder snapshot with every id and kind validated. */
function projectSnapshot(snapshot: FlightRecord[]): FlightRecord[] {
	return snapshot.map((record) => {
		const out: FlightRecord = { t: record.t, kind: RECORDER_KIND_SET.has(record.kind) ? record.kind : "[unknown kind]" };
		if (record.id !== undefined) out.id = TOOL_USE_ID.test(record.id) ? record.id : "[invalid tool_use id]";
		if (record.index !== undefined) out.index = record.index;
		if (record.n !== undefined) out.n = record.n;
		return out;
	});
}

function projectModel(model: string | undefined): string | undefined {
	if (model === undefined) return undefined;
	return MODEL.test(model) ? model : "[invalid model]";
}

// --- Registry ---

// Process-global: Pi loads a fresh copy of every module of the bridge for
// each session it starts with its own loader (an in-process subagent) and on
// /reload, while the copy serving the requests records their incidents. Every
// copy reads the same registry.
interface IncidentRegistryV1 {
	bySignature: Map<string, Incident>;
	byId: Map<string, Incident>;
}

const REGISTRY_SYMBOL = Symbol.for("kendex.pi.claude-bridge.incidents.v1");

function incidentRegistry(): IncidentRegistryV1 {
	const host = globalThis as Record<symbol, unknown>;
	let registry = host[REGISTRY_SYMBOL] as IncidentRegistryV1 | undefined;
	if (!registry) {
		registry = { bySignature: new Map(), byId: new Map() };
		host[REGISTRY_SYMBOL] = registry;
	}
	return registry;
}

const { bySignature: incidents, byId: incidentsById } = incidentRegistry();

/** `bi-` plus 4 to 6 base36 characters, never with three digits in a row: Pi's
 *  retry matcher looks for status codes such as 429 or 503 anywhere in an
 *  error text, and the id is appended to error texts. */
function newIncidentId(): string {
	for (let attempt = 0; ; attempt++) {
		const length = attempt < 20 ? 4 : attempt < 40 ? 5 : 6;
		const id = `bi-${Math.floor(Math.random() * 36 ** length).toString(36).padStart(length, "0")}`;
		if (/\d{3}/.test(id) || incidentsById.has(id)) continue;
		return id;
	}
}

let occurrenceListener: ((incident: Incident) => void) | undefined;

/** Calls `listener` (the agent notice, incident-notice.ts) for every
 *  non-expected occurrence, right after it is recorded, in the request lane
 *  it happened in. */
export function setIncidentListener(listener: ((incident: Incident) => void) | undefined): void {
	occurrenceListener = listener;
}

function notifyListener(incident: Incident): void {
	if (!occurrenceListener || incident.class === "expected") return;
	try {
		occurrenceListener(incident);
	} catch (error) {
		debug("incidents: occurrence listener failed:", error);
	}
}

/** Records one occurrence of `signature` and returns its incident. */
export function recordIncident(signature: string, klass: IncidentClass, data: Record<string, unknown> = {}, source?: IncidentSource): Incident {
	const now = new Date().toISOString();
	const existing = incidents.get(signature);
	const counted = klass === "expected";
	const preQueryModel = source?.preQueryModel;
	const preQuery = typeof preQueryModel === "string";
	const snapshot = (): FlightRecord[] | null | undefined => {
		if (preQuery) return null;
		const records = source?.recorder?.snapshot();
		return records ? projectSnapshot(records) : records;
	};
	if (existing) {
		existing.count += 1;
		existing.lastSeen = now;
		existing.versions = currentVersions();
		if (!counted) {
			existing.latestSnapshot = snapshot();
			existing.latestDiag = projectDiagMetadata(data);
		}
		queueStoreWrite(existing, false);
		notifyListener(existing);
		return existing;
	}
	const model = projectModel(preQuery ? preQueryModel : source?.turnOutput?.responseModel ?? source?.turnOutput?.model);
	const firstSnapshot = counted ? undefined : snapshot();
	const incident: Incident = {
		id: newIncidentId(),
		signature,
		class: klass,
		count: 1,
		firstSeen: now,
		lastSeen: now,
		versions: currentVersions(),
		...(model ? { model } : {}),
		...(preQuery ? { phase: "before-query" as const } : {}),
		...(firstSnapshot !== undefined ? { snapshot: firstSnapshot } : {}),
		diag: counted ? {} : projectDiagMetadata(data),
	};
	incidents.set(signature, incident);
	incidentsById.set(incident.id, incident);
	queueStoreWrite(incident, true);
	notifyListener(incident);
	return incident;
}

/** Records an incident whose class comes from the class table. */
export function reportIncident(label: IncidentLabel, site: IncidentSite, data: Record<string, unknown> = {}, source?: IncidentSource): Incident {
	return recordIncident(`${label}@${site}`, incidentClass(label, site), data, source);
}

/** Writes the diag entry exactly as diagDump always has, and records the
 *  incident for it. */
export function reportDiag(label: IncidentLabel, site: IncidentSite, data: Record<string, unknown>, source?: IncidentSource): Incident {
	diagDump(label, data);
	return reportIncident(label, site, data, source);
}

/** `text` naming `incident`, for a bridge-authored error Claude or Pi gets.
 *  An expected incident is counted only and never named. */
export function withIncident(text: string, incident: Incident | undefined): string {
	if (!incident || incident.class === "expected") return text;
	return `${text} (incident ${incident.id})`;
}

// --- Exits: every bridge-authored error reaching Pi names an incident ---
//
// A bridge-authored error reaches Pi one of two ways: as the error event the
// provider pushes on its Pi stream, or thrown out of the provider call (Pi's
// agent loop turns the thrown message into an error message). Both exits name
// an incident for an error that carries none, with the exit as its site.
// Errors Claude Code or the API wrote are registered with markExternalError
// where the bridge receives them, and reach Pi unchanged.

const NAMED = / \(incident bi-[0-9a-z]{4,6}\)$/;
// Recent external texts. A held failure reaches Pi a turn later with the same
// text, so the set is by text; bounded, since it only needs recent ones.
const EXTERNAL_TEXTS_MAX = 64;
const externalErrorTexts = new Set<string>();

/** Registers `text` as written by Claude Code or the API, so the exits leave
 *  it unchanged. Returns `text`. */
export function markExternalError(text: string): string {
	externalErrorTexts.delete(text);
	externalErrorTexts.add(text);
	if (externalErrorTexts.size > EXTERNAL_TEXTS_MAX) externalErrorTexts.delete(externalErrorTexts.values().next().value!);
	return text;
}

function needsIncident(text: string): boolean {
	return !NAMED.test(text) && !externalErrorTexts.has(text);
}

/** Makes every `error` event pushed on `stream` with stopReason "error" name
 *  an incident (see the section note). The message object keeps every other
 *  field; its text is not incident metadata. */
export function nameBridgeErrorEvents<S extends { push(event: any): void }>(stream: S, source: () => IncidentSource | undefined): S {
	const push = stream.push.bind(stream);
	stream.push = (event: any): void => {
		// Naming never stands between Pi and the event that ends its request:
		// a failure here delivers the error as it was.
		try {
			const error = event?.type === "error" ? event.error : undefined;
			if (error?.stopReason === "error" && typeof error.errorMessage === "string" && needsIncident(error.errorMessage)) {
				error.errorMessage = withIncident(error.errorMessage, reportIncident("bridge_error", "error-event", {}, source()));
			}
		} catch (failure) {
			debug("incidents: could not name an error event:", failure);
		}
		push(event);
	};
	return stream;
}

const ERROR_LABEL = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** Names an incident in an error thrown out of the provider call, in place:
 *  the same object keeps its name, code, path and other fields. Only its
 *  labels (name, code, syscall) and errno go into the incident, never its
 *  message, which can carry paths. */
export function nameThrownBridgeError(error: unknown, source: IncidentSource | undefined): void {
	// Runs in the provider's catch: a failure here must not replace `error`.
	try {
		nameThrown(error, source);
	} catch (failure) {
		debug("incidents: could not name a thrown error:", failure);
	}
}

function nameThrown(error: unknown, source: IncidentSource | undefined): void {
	if (!(error instanceof Error) || typeof error.message !== "string" || !needsIncident(error.message)) return;
	const fields = error as Error & { code?: unknown; syscall?: unknown; errno?: unknown };
	const label = (value: unknown): string | undefined => typeof value === "string" && ERROR_LABEL.test(value) ? value : undefined;
	const data: Record<string, unknown> = {
		...(label(error.name) ? { errorName: error.name } : {}),
		...(label(fields.code) ? { code: fields.code } : {}),
		...(label(fields.syscall) ? { syscall: fields.syscall } : {}),
		...(typeof fields.errno === "number" ? { errno: fields.errno } : {}),
	};
	const named = withIncident(error.message, reportIncident("bridge_error", "provider-throw", data, source));
	try { error.message = named; } catch { /* a frozen error keeps its text */ }
}

function currentVersions(): IncidentVersions {
	return {
		...(BRIDGE_COMMIT ? { bridge: COMMIT.test(BRIDGE_COMMIT) ? BRIDGE_COMMIT : "[invalid commit]" } : {}),
		...(claudeCodeVersion ? { claudeCode: SEMVER.test(claudeCodeVersion) ? claudeCodeVersion : "[invalid version]" } : {}),
		...(PI_VERSION ? { pi: SEMVER.test(PI_VERSION) ? PI_VERSION : "[invalid version]" } : {}),
	};
}

export function listIncidents(): Incident[] {
	return [...incidents.values()];
}

export function findIncident(id: string): Incident | undefined {
	return incidentsById.get(id);
}

// --- Store (enabled only) ---

export const INCIDENTS_FILE_NAME = "claude-bridge-incidents.jsonl";
// Writes are batched: a burst of occurrences becomes one line per signature.
const STORE_FLUSH_MS = 2_000;

let storePath: string | undefined;
let storedClaudeCodeVersion: Promise<string | undefined> = Promise.resolve(undefined);
let versionCheck: Promise<void> = Promise.resolve();
const pendingSignatures = new Map<string, boolean>();
const pendingLines: Array<Record<string, unknown>> = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let flushChain: Promise<void> = Promise.resolve();

/** Enables the store for a USER-scoped `incidents.repo`, disables it without
 *  one. The caller passes loadConfig's value, which only user config sets. */
export function configureIncidents(config: { repo: string } | undefined): void {
	if (!config?.repo) {
		storePath = undefined;
		pendingSignatures.clear();
		pendingLines.length = 0;
		configureFiler(undefined, () => {});
		return;
	}
	storePath = join(piUserDir(), INCIDENTS_FILE_NAME);
	configureFiler(config.repo, (incident) => queueStoreWrite(incident, false));
	storedClaudeCodeVersion = readStoredClaudeCodeVersion(storePath);
}

async function readStoredClaudeCodeVersion(path: string): Promise<string | undefined> {
	try {
		const lines = (await readFile(path, "utf8")).split("\n");
		for (let i = lines.length - 1; i >= 0; i--) {
			if (!lines[i].includes("\"claude_code_version\"")) continue;
			try {
				const entry = JSON.parse(lines[i]) as { type?: unknown; version?: unknown };
				if (entry.type === "claude_code_version" && typeof entry.version === "string") return entry.version;
			} catch { /* a torn line */ }
		}
	} catch { /* no store yet */ }
	return undefined;
}

/** The Claude Code version of the SDK's init message. With the store on, a
 *  version other than the last one stored is an external incident, with the
 *  model and timeline of the query that reported it (`source`), taken now:
 *  the check against the store finishes later. */
export function noteClaudeCodeVersion(version: unknown, source?: IncidentSource): void {
	if (typeof version !== "string" || version.length === 0 || version.length > 64 || version === claudeCodeVersion) return;
	claudeCodeVersion = version;
	if (storePath) versionCheck = checkClaudeCodeVersion(version, frozenSource(source));
}

/** `source` as it is now: its snapshot and model, not whatever its query
 *  records by the time an asynchronous check reports. */
function frozenSource(source: IncidentSource | undefined): IncidentSource | undefined {
	if (!source) return undefined;
	const snapshot = source.recorder?.snapshot();
	return {
		...(snapshot ? { recorder: { snapshot: () => snapshot } } : {}),
		turnOutput: source.turnOutput ? { model: source.turnOutput.model, responseModel: source.turnOutput.responseModel } : null,
		preQueryModel: source.preQueryModel ?? null,
	};
}

async function checkClaudeCodeVersion(version: string, source: IncidentSource | undefined): Promise<void> {
	const previous = storedClaudeCodeVersion;
	storedClaudeCodeVersion = Promise.resolve(version);
	const stored = await previous;
	if (stored === version || !storePath) return;
	if (stored !== undefined) reportIncident("claude_code_version_changed", "init", { previousVersion: stored, version }, source);
	pendingLines.push({ type: "claude_code_version", version, at: new Date().toISOString() });
	scheduleFlush();
}

function queueStoreWrite(incident: Incident, full: boolean): void {
	if (!storePath) return;
	pendingSignatures.set(incident.signature, full || pendingSignatures.get(incident.signature) === true);
	scheduleFlush();
}

function scheduleFlush(): void {
	if (flushTimer || !storePath) return;
	flushTimer = setTimeout(() => {
		flushTimer = undefined;
		flushChain = flushChain.then(flushStore);
	}, STORE_FLUSH_MS);
	flushTimer.unref?.();
}

function storeLine(incident: Incident, full: boolean): Record<string, unknown> {
	if (!full) {
		return {
			type: "count", id: incident.id, signature: incident.signature, class: incident.class, count: incident.count, lastSeen: incident.lastSeen,
			...(incident.issue !== undefined ? { issue: incident.issue } : {}),
		};
	}
	return { type: "incident", ...incident };
}

/** Rotates like the debug log (rotateDebugLog), without blocking. Returns
 *  whether `path` was moved away. */
async function rotateStore(path: string): Promise<boolean> {
	try {
		if ((await stat(path)).size < DEBUG_LOG_MAX_BYTES) return false;
		for (let i = DEBUG_LOG_ROTATED_FILES - 1; i >= 1; i--) {
			try { await rename(`${path}.${i}`, `${path}.${i + 1}`); } catch { /* gap in the sequence */ }
		}
		await rename(path, `${path}.1`);
		return true;
	} catch {
		return false; // missing store, or another process rotated it first
	}
}

async function flushStore(): Promise<void> {
	const path = storePath;
	if (!path || (pendingSignatures.size === 0 && pendingLines.length === 0)) return;
	const lines: Array<Record<string, unknown>> = [];
	for (const [signature, full] of pendingSignatures) {
		const incident = incidents.get(signature);
		if (incident) lines.push(storeLine(incident, full));
	}
	pendingSignatures.clear();
	lines.push(...pendingLines.splice(0));
	try {
		// The version check reads only the live file: a fresh one starts with
		// the version baseline the rotated file held.
		const baseline = await storedClaudeCodeVersion;
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
		if (await rotateStore(path) && baseline !== undefined && !lines.some((line) => line.type === "claude_code_version")) {
			lines.unshift({ type: "claude_code_version", version: baseline, at: new Date().toISOString() });
		}
		await appendFile(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", { mode: 0o600 });
		await chmod(path, 0o600);
	} catch (error) {
		debug("incidents: store write failed:", error);
	}
}

// --- Test seams ---

/** Writes everything pending now. */
export async function __testFlushIncidents(): Promise<void> {
	if (flushTimer) {
		clearTimeout(flushTimer);
		flushTimer = undefined;
	}
	await versionCheck;
	flushChain = flushChain.then(flushStore);
	await flushChain;
}

export function __testResetIncidents(): void {
	if (flushTimer) clearTimeout(flushTimer);
	flushTimer = undefined;
	incidents.clear();
	incidentsById.clear();
	pendingSignatures.clear();
	pendingLines.length = 0;
	storePath = undefined;
	storedClaudeCodeVersion = Promise.resolve(undefined);
	versionCheck = Promise.resolve();
	claudeCodeVersion = undefined;
	registeredToolNames.clear();
	occurrenceListener = undefined;
	__testResetFiler();
}
