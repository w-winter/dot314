// Bridge incidents: every anomaly the bridge detects, recorded while it runs.
//
// An incident is keyed by its signature (`label@site`) within this process: a
// repeat counts up and keeps the first and latest flight-recorder snapshots.
// Incidents carry metadata only (ids, names, counts, lengths, timings, labels,
// versions, site names), never prompt, tool-argument, tool-result or user text;
// diag payloads pass through projectDiagMetadata for that reason.
//
// Recording is always on and in memory. Disk writes and filing (incident-
// filer.ts) need a USER-scoped `incidents.repo` (configureIncidents); without
// it nothing leaves the process.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { appendFile, chmod, mkdir, readFile, rename, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { piUserDir } from "./config.js";
import { DEBUG_LOG_MAX_BYTES, DEBUG_LOG_ROTATED_FILES, debug, diagDump } from "./debug.js";
import { __testFlushFilings, __testResetFiler, configureFiler, noteIncidentForFiling } from "./incident-filer.js";
import type { FlightRecord, FlightRecorder } from "./flight-recorder.js";

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
	/** The issue in `incidents.repo` this signature is filed as. */
	issue?: number;
	/** How filing went: "filed", "commented", "deferred rate-limit" or
	 *  "failed <reason>" (incident-filer.ts). */
	filing?: string;
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

// --- Metadata projection ---

// String values kept verbatim: ids, tool names, labels, sites and role lists.
// Everything else that is a string (error text, a reason Claude Code wrote,
// paths) is left out and listed in `droppedFields`. Argument property names
// (`argKeys`, `handlerArgKeys`, ...) come from the caller's tool arguments, and
// a tool may take free text as property names: only their count is kept.
const STRING_FIELDS = new Set([
	"id", "toolCallId", "toolName", "name", "recordedName", "site", "why", "messageId", "type",
	"sessionId", "lastMsgRole", "promptRoles", "messageRoles", "kind", "subtype", "cause",
	"version", "previousVersion", "source",
	"errorName", "code", "syscall",
]);
const MAX_STRING_LENGTH = 200;
const MAX_ARRAY_LENGTH = 50;
const MAX_DEPTH = 5;

function keepsStrings(key: string): boolean {
	return STRING_FIELDS.has(key) || key.endsWith("Id") || key.endsWith("Ids");
}

/** `data` reduced to metadata: numbers, booleans and null, strings only under
 *  id/name/label fields, and a `<name>KeyCount` for each `<name>Keys` list. */
export function projectDiagMetadata(data: Record<string, unknown>): Record<string, unknown> {
	const dropped: string[] = [];
	const project = (value: unknown, key: string, path: string, depth: number): unknown => {
		if (value === null || typeof value === "number" || typeof value === "boolean") return value;
		if (typeof value === "string") {
			if (keepsStrings(key)) return value.length > MAX_STRING_LENGTH ? value.slice(0, MAX_STRING_LENGTH) : value;
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

// --- Registry ---

const incidents = new Map<string, Incident>();
const incidentsById = new Map<string, Incident>();

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

/** Records one occurrence of `signature` and returns its incident. */
export function recordIncident(signature: string, klass: IncidentClass, data: Record<string, unknown> = {}, source?: IncidentSource): Incident {
	const now = new Date().toISOString();
	const existing = incidents.get(signature);
	const counted = klass === "expected";
	const preQueryModel = source?.preQueryModel;
	const preQuery = typeof preQueryModel === "string";
	const snapshot = (): FlightRecord[] | null | undefined => preQuery ? null : source?.recorder?.snapshot();
	if (existing) {
		existing.count += 1;
		existing.lastSeen = now;
		existing.versions = currentVersions();
		if (!counted) {
			existing.latestSnapshot = snapshot();
			existing.latestDiag = projectDiagMetadata(data);
		}
		queueStoreWrite(existing, false);
		noteIncidentForFiling(existing);
		return existing;
	}
	const model = preQuery ? preQueryModel : source?.turnOutput?.responseModel ?? source?.turnOutput?.model;
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
	noteIncidentForFiling(incident);
	return incident;
}

/** Records an incident whose class comes from the class table. */
export function reportIncident(label: IncidentLabel, site: string, data: Record<string, unknown> = {}, source?: IncidentSource): Incident {
	return recordIncident(`${label}@${site}`, incidentClass(label, site), data, source);
}

/** Writes the diag entry exactly as diagDump always has, and records the
 *  incident for it. */
export function reportDiag(label: IncidentLabel, site: string, data: Record<string, unknown>, source?: IncidentSource): Incident {
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
		...(BRIDGE_COMMIT ? { bridge: BRIDGE_COMMIT } : {}),
		...(claudeCodeVersion ? { claudeCode: claudeCodeVersion } : {}),
		...(PI_VERSION ? { pi: PI_VERSION } : {}),
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
			...(incident.filing !== undefined ? { filing: incident.filing } : {}),
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
	await __testFlushFilings();
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
	__testResetFiler();
}
