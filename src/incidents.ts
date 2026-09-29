// Bridge incidents: every anomaly the bridge detects, recorded while it runs.
//
// An incident is keyed by its signature (`label@site`) within this process: a
// repeat counts up and keeps the first and latest flight-recorder snapshots.
// Incidents carry metadata only (ids, names, counts, lengths, timings, labels,
// versions, site names), never prompt, tool-argument, tool-result or user text;
// diag payloads pass through projectDiagMetadata for that reason.
//
// Recording is always on and in memory. Disk writes need a USER-scoped
// `incidents.repo` (configureIncidents); without it nothing leaves the process.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { appendFile, chmod, mkdir, readFile, rename, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { piUserDir } from "./config.js";
import { DEBUG_LOG_MAX_BYTES, DEBUG_LOG_ROTATED_FILES, debug, diagDump } from "./debug.js";
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
	stream_idle_timeout: "user-visible",
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
	/** Recorder snapshot at the first occurrence; latestSnapshot at the latest. */
	snapshot?: FlightRecord[];
	latestSnapshot?: FlightRecord[];
	diag: Record<string, unknown>;
	latestDiag?: Record<string, unknown>;
	issue?: number;
}

/** What an incident takes from the query it happened in (a QueryContext). */
export interface IncidentSource {
	recorder?: FlightRecorder;
	turnOutput?: { model?: string; responseModel?: string } | null;
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

// String values kept verbatim: ids, names, labels, sites and role lists.
// Everything else that is a string (error text, a reason Claude Code wrote,
// paths) is left out and listed in `droppedFields`.
const STRING_FIELDS = new Set([
	"id", "toolCallId", "toolName", "name", "recordedName", "site", "why", "messageId", "type",
	"sessionId", "lastMsgRole", "promptRoles", "messageRoles", "kind", "subtype", "cause",
	"version", "previousVersion", "source",
]);
const MAX_STRING_LENGTH = 200;
const MAX_ARRAY_LENGTH = 50;
const MAX_DEPTH = 5;

function keepsStrings(key: string): boolean {
	return STRING_FIELDS.has(key) || key.endsWith("Id") || key.endsWith("Ids") || key.endsWith("Keys");
}

/** `data` reduced to metadata: numbers, booleans and null, and strings only
 *  under id/name/label fields. */
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
	if (existing) {
		existing.count += 1;
		existing.lastSeen = now;
		existing.versions = currentVersions();
		if (!counted) {
			existing.latestSnapshot = source?.recorder?.snapshot();
			existing.latestDiag = projectDiagMetadata(data);
		}
		queueStoreWrite(existing, false);
		return existing;
	}
	const model = source?.turnOutput?.responseModel ?? source?.turnOutput?.model;
	const incident: Incident = {
		id: newIncidentId(),
		signature,
		class: klass,
		count: 1,
		firstSeen: now,
		lastSeen: now,
		versions: currentVersions(),
		...(model ? { model } : {}),
		...(!counted && source?.recorder ? { snapshot: source.recorder.snapshot() } : {}),
		diag: counted ? {} : projectDiagMetadata(data),
	};
	incidents.set(signature, incident);
	incidentsById.set(incident.id, incident);
	queueStoreWrite(incident, true);
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
		return;
	}
	storePath = join(piUserDir(), INCIDENTS_FILE_NAME);
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
 *  version other than the last one stored is an external incident. */
export function noteClaudeCodeVersion(version: unknown): void {
	if (typeof version !== "string" || version.length === 0 || version.length > 64 || version === claudeCodeVersion) return;
	claudeCodeVersion = version;
	if (storePath) versionCheck = checkClaudeCodeVersion(version);
}

async function checkClaudeCodeVersion(version: string): Promise<void> {
	const previous = storedClaudeCodeVersion;
	storedClaudeCodeVersion = Promise.resolve(version);
	const stored = await previous;
	if (stored === version || !storePath) return;
	if (stored !== undefined) reportIncident("claude_code_version_changed", "init", { previousVersion: stored, version });
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
	if (!full) return { type: "count", id: incident.id, signature: incident.signature, class: incident.class, count: incident.count, lastSeen: incident.lastSeen };
	return { type: "incident", ...incident };
}

/** Rotates like the debug log (rotateDebugLog), without blocking. */
async function rotateStore(path: string): Promise<void> {
	try {
		if ((await stat(path)).size < DEBUG_LOG_MAX_BYTES) return;
		for (let i = DEBUG_LOG_ROTATED_FILES - 1; i >= 1; i--) {
			try { await rename(`${path}.${i}`, `${path}.${i + 1}`); } catch { /* gap in the sequence */ }
		}
		await rename(path, `${path}.1`);
	} catch { /* missing store, or another process rotated it first */ }
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
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
		await rotateStore(path);
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
}
