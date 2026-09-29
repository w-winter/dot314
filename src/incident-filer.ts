// Incident filing (enabled by a user-scoped `incidents.repo` only).
//
// A new user-visible, silent or external incident becomes an issue in that
// repo, through `gh` with an explicit `--repo`. The issue body carries a
// marker with the signature; before creating, the filer searches the repo's
// open issues for it and comments on the one it finds instead, so other
// processes (this state is per process) file each signature once.
//
// Filing never runs in the stream loop: an occurrence only queues a task,
// which starts on a later turn of the event loop and spawns `gh`
// asynchronously. At most FILINGS_PER_HOUR creates and comments go out per
// process per hour, at most one comment per signature per hour; past that
// the incident is only counted. A failed `gh` (missing, logged out, erroring)
// is recorded on the incident and not tried again for an hour.
//
// Only signatures of the code's class and site tables are filed
// (isKnownSignature); any other is marked `skipped unknown-signature` and no
// `gh` runs for it. The body is built from evidence validated by kind where
// it was recorded (incidents.ts, projectDiagMetadata) and fixed bridge prose.
// Every title, body and comment passes sanitizeForIssue at the boundary.

import { spawn } from "node:child_process";
import { debug } from "./debug.js";
import { sanitizeForIssue } from "./incident-sanitizer.js";
import { isKnownSignature, type Incident, type IncidentLabel } from "./incidents.js";

const FILINGS_PER_HOUR = 5;
const HOUR_MS = 60 * 60 * 1000;
const GH_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 60 * 1024;
const MAX_GH_OUTPUT = 1024 * 1024;
const SEARCH_LIMIT = "30";

/** What happened, per label, in plain words. Opens every issue. */
const DESCRIPTIONS: Record<IncidentLabel, string> = {
	tool_handler_unmatched: "Claude Code called a Pi tool (tools/call) that the bridge could not match to any tool call in Claude's stream, so Claude got an error for it.",
	tool_handler_stranded: "A Pi tool call Claude was waiting on was left without a result when its query moved on, so Claude got an error for it.",
	tool_handlers_stranded: "Several Pi tool calls Claude was waiting on were left without results when the query ended, so Claude got errors for them.",
	tool_call_already_answered: "Claude Code asked for the result of a tool call the bridge had already answered.",
	tool_call_id_other_tool: "Claude Code sent a tool call id that the bridge recorded for a different tool.",
	steering_delivery_failed: "A message sent while Claude was working could not be written to the running query.",
	repair_tool_pairing_synthetic_results: "History given to Claude Code had tool calls without results; the bridge filled in placeholder results.",
	tool_result_delivery_mismatch: "Tool results Pi returned did not match the tool calls the query was waiting on.",
	steering_query_ended_during_write: "The query ended while a message sent mid-turn was being written to it.",
	persist_shared_session_failed: "The bridge could not save the Claude Code session record after a query.",
	session_verify_fail: "The session file the bridge wrote for Claude Code did not read back as written.",
	tool_call_abandoned_by_claude_code: "Claude Code gave up on a tool call before Pi returned its result.",
	continuation_failed_after_reply: "Claude failed while answering a mid-turn message, after its earlier reply had completed.",
	stale_queued_tool_results_parked: "Tool results from an earlier turn were still queued when a new turn started, and were set aside.",
	tool_claim_args_mismatch: "A tool call's arguments differed between Claude's stream and Claude Code's tools/call.",
	steering_write_in_flight: "A message sent mid-turn arrived while an earlier one was still being written, and was deferred.",
	deferred_user_replay_skipped: "A deferred mid-turn message was not replayed after the query ended.",
	user_message_identity_unresolved: "The bridge could not tell whether a user message was new or one Claude already had.",
	empty_prompt: "A query started without any prompt text; the bridge sent a placeholder prompt.",
	stream_attempt_abandoned: "Claude Code abandoned a stalled response attempt and retried it.",
	partial_tool_calls_pruned: "A response ended with tool calls whose arguments never finished; the bridge dropped them.",
	deferred_user_messages_dropped: "Mid-turn messages that were waiting for delivery were dropped.",
	tool_no_longer_active: "Claude Code called a Pi tool that is no longer active in Pi.",
	tool_call_dead: "Claude Code called a tool whose call had already ended.",
	tool_results_unmatched: "Pi returned tool results for calls this query did not make.",
	third_party_app_refused: "The bridge refused a request whose system prompt Anthropic treats as a third-party app.",
	claude_account_not_connected: "A request was made with no Claude account connected.",
	stream_idle_timeout: "Claude's response stream went silent past the idle timeout and the request was ended.",
	bridge_error: "The bridge ended a request with an error of its own.",
	tool_calls_interrupted: "Pi tool calls Claude was waiting on were interrupted.",
	api_error: "Claude Code reported an API error for a request.",
	claude_code_version_changed: "Claude Code's version changed since the last one the bridge saw.",
};

const SEEN: Record<Incident["class"], (incident: Incident) => string> = {
	"user-visible": (incident) => `Claude or Pi got a bridge-authored error naming incident ${incident.id}.`,
	silent: () => "Nothing was shown: the bridge detected this and carried on.",
	external: () => "Claude Code or the Anthropic API reported this, and the bridge passed it on.",
	expected: () => "This is normal cleanup, counted only.",
};

/** An existing test file that drives the same path, for "How to reproduce". */
const REPRO_TESTS: Partial<Record<IncidentLabel, string>> = {
	tool_handler_unmatched: "tests/unit-incidents.mjs",
	tool_handler_stranded: "tests/unit-tool-claim-by-id.mjs",
	tool_handlers_stranded: "tests/unit-tool-claim-by-id.mjs",
	tool_call_already_answered: "tests/unit-tool-claim-by-id.mjs",
	tool_call_dead: "tests/unit-tool-claim-by-id.mjs",
	tool_call_id_other_tool: "tests/unit-incidents.mjs",
	tool_no_longer_active: "tests/unit-served-tools-stream.mjs",
	steering_delivery_failed: "tests/unit-live-steering.mjs",
	steering_query_ended_during_write: "tests/unit-live-steering.mjs",
	repair_tool_pairing_synthetic_results: "tests/unit-session-integrity.mjs",
	session_verify_fail: "tests/unit-session-integrity.mjs",
	tool_result_delivery_mismatch: "tests/unit-integrity-reporting.mjs",
	stale_queued_tool_results_parked: "tests/unit-integrity-reporting.mjs",
	tool_results_unmatched: "tests/unit-integrity-reporting.mjs",
	continuation_failed_after_reply: "tests/unit-continuation-failure.mjs",
	user_message_identity_unresolved: "tests/unit-steer-ownership.mjs",
	partial_tool_calls_pruned: "tests/unit-grace-timer-streaming.mjs",
	deferred_user_messages_dropped: "tests/unit-account-rotation-stream.mjs",
	tool_claim_args_mismatch: "tests/unit-tool-forwarding.mjs",
	tool_calls_interrupted: "tests/unit-tool-drain.mjs",
	third_party_app_refused: "tests/unit-third-party-prompt.mjs",
	claude_account_not_connected: "tests/unit-incidents.mjs",
	stream_idle_timeout: "tests/unit-failure-frames.mjs",
	bridge_error: "tests/unit-incidents.mjs",
	api_error: "tests/unit-incidents.mjs",
	claude_code_version_changed: "tests/unit-incidents.mjs",
};

export const REPRO_TEST_FILES: readonly string[] = [...new Set(Object.values(REPRO_TESTS))];

let repo: string | undefined;
let persist: (incident: Incident) => void = () => {};
let now = (): number => Date.now();
const filedAt: number[] = [];
const lastWriteAt = new Map<string, number>();
const queued = new Set<string>();
let failedUntil = 0;
let failure = "";
let chain: Promise<void> = Promise.resolve();

/** Enables filing into `target` (a validated `owner/name`), or disables it.
 *  `onChange` persists an incident whose issue or filing state changed. */
export function configureFiler(target: string | undefined, onChange: (incident: Incident) => void): void {
	repo = target;
	persist = onChange;
}

function labelOf(signature: string): string {
	const at = signature.indexOf("@");
	return at < 0 ? signature : signature.slice(0, at);
}

function siteOf(signature: string): string {
	const at = signature.indexOf("@");
	return at < 0 ? "" : signature.slice(at + 1);
}

export function incidentMarker(signature: string): string {
	return `<!-- claude-bridge-incident: ${signature} -->`;
}

export function issueTitle(incident: Incident): string {
	return `[incident] ${labelOf(incident.signature)} at ${siteOf(incident.signature) || "unknown site"} (${incident.class})`;
}

function evidenceTable(incident: Incident): string {
	const rows: Array<[string, unknown]> = [
		["Incident", incident.id],
		["Signature", `\`${incident.signature}\``],
		["Class", incident.class],
		["Count", incident.count],
		["First seen", incident.firstSeen],
		["Last seen", incident.lastSeen],
		["Bridge commit", incident.versions.bridge],
		["Claude Code", incident.versions.claudeCode],
		["Pi", incident.versions.pi],
		["Model", incident.model],
		["Phase", incident.phase],
	];
	return ["| Field | Value |", "|---|---|", ...rows.filter(([, value]) => value !== undefined).map(([name, value]) => `| ${name} | ${String(value).replace(/\|/g, "\\|")} |`)].join("\n");
}

function jsonBlock(value: unknown): string {
	// A snapshot reads best one record per line.
	const json = Array.isArray(value)
		? `[\n${value.map((item) => JSON.stringify(item)).join(",\n")}\n]`
		: JSON.stringify(value, null, 1);
	return ["```json", json, "```"].join("\n");
}

function snapshotSection(title: string, snapshot: Incident["snapshot"]): string[] {
	if (snapshot === undefined) return [];
	if (snapshot === null) return [`### ${title}`, "", "None: this happened before the request's query started."];
	return [`### ${title}`, "", jsonBlock(snapshot)];
}

function whatHappened(incident: Incident): string {
	const description = DESCRIPTIONS[labelOf(incident.signature) as IncidentLabel] ?? "The bridge recorded an anomaly.";
	return `${description} ${SEEN[incident.class](incident)}`;
}

function howToReproduce(incident: Incident): string {
	const test = REPRO_TESTS[labelOf(incident.signature) as IncidentLabel];
	const pointer = test
		? `\`${test}\` drives the same path with a fake SDK and is the place to add it.`
		: "No existing test drives this path yet; `tests/unit-incidents.mjs` shows how to script one.";
	return `The flight-recorder snapshot is the event order a fake-SDK unit test would script: each record is an SDK message or stream event, a tools/call, a claim, a result or a cursor move, in the order the bridge saw them. ${pointer}`;
}

/** The issue body: the problem, the evidence, the recorder snapshots, the
 *  diag metadata and how to reproduce. Metadata only, under 60 KB: the
 *  latest snapshot, then the oldest records, give way first. */
export function issueBody(incident: Incident): string {
	let first = incident.snapshot;
	let latest = incident.latestSnapshot;
	let diag: unknown = { first: incident.diag, ...(incident.latestDiag ? { latest: incident.latestDiag } : {}) };
	for (;;) {
		const body = [
			incidentMarker(incident.signature),
			"## What happened",
			"",
			whatHappened(incident),
			"",
			"## Evidence",
			"",
			evidenceTable(incident),
			"",
			"## Flight recorder",
			"",
			"Recent events of the query, oldest first; `t` is milliseconds since the query started.",
			"",
			...snapshotSection("First occurrence", first),
			"",
			...(latest !== undefined ? [...snapshotSection("Latest occurrence", latest), ""] : []),
			"## Diag metadata",
			"",
			jsonBlock(diag),
			"",
			"## How to reproduce",
			"",
			howToReproduce(incident),
			"",
		].join("\n");
		if (Buffer.byteLength(body) < MAX_BODY_BYTES) return body;
		if (latest) latest = undefined;
		else if (Array.isArray(first) && first.length > 1) first = first.slice(Math.floor(first.length / 2));
		else if (diag !== "(too large)") diag = "(too large)";
		else return body.slice(0, MAX_BODY_BYTES / 2);
	}
}

/** A comment for a later occurrence (or a first one in this process, on an
 *  issue another process filed): the evidence, the latest snapshot and the
 *  latest diag metadata. Under 60 KB like the body: the oldest records, then
 *  the diag, give way first. */
export function occurrenceComment(incident: Incident): string {
	let snapshot = incident.latestSnapshot ?? incident.snapshot;
	let diag: unknown = incident.latestDiag ?? incident.diag;
	for (;;) {
		const text = [
			"## New occurrence",
			"",
			SEEN[incident.class](incident),
			"",
			evidenceTable(incident),
			"",
			...snapshotSection("Latest occurrence", snapshot),
			"",
			"### Diag metadata",
			"",
			jsonBlock(diag),
			"",
		].join("\n");
		if (Buffer.byteLength(text) < MAX_BODY_BYTES) return text;
		if (Array.isArray(snapshot) && snapshot.length > 1) snapshot = snapshot.slice(Math.floor(snapshot.length / 2));
		else if (diag !== "(too large)") diag = "(too large)";
		else return text.slice(0, MAX_BODY_BYTES / 2);
	}
}

// --- gh ---

class GhFailure extends Error {
	constructor(readonly reason: string) {
		super(reason);
	}
}

/** Runs `gh args` with `input` on stdin; resolves its stdout. Rejects with a
 *  short reason label, never with gh's own text. */
function runGh(args: string[], input: string): Promise<string> {
	return new Promise((resolve, reject) => {
		let child;
		try {
			child = spawn("gh", args, {
				stdio: ["pipe", "pipe", "pipe"],
				env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" },
				windowsHide: true,
			});
		} catch {
			reject(new GhFailure("gh-spawn"));
			return;
		}
		let stdout = "";
		let stderr = "";
		let settled = false;
		const settle = (error: GhFailure | undefined): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (error) reject(error);
			else resolve(stdout);
		};
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			settle(new GhFailure("timeout"));
		}, GH_TIMEOUT_MS);
		timer.unref?.();
		child.stdout.on("data", (chunk: Buffer) => { if (stdout.length < MAX_GH_OUTPUT) stdout += chunk.toString(); });
		child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < MAX_GH_OUTPUT) stderr += chunk.toString(); });
		child.stdin.on("error", () => { /* gh exited before reading; its exit reports why */ });
		child.on("error", (error: NodeJS.ErrnoException) => settle(new GhFailure(error.code === "ENOENT" ? "gh-missing" : "gh-spawn")));
		child.on("close", (code: number | null) => {
			if (code === 0) settle(undefined);
			else if (/auth login|not logged in|authentication|bad credentials|HTTP 401/i.test(stderr)) settle(new GhFailure("gh-auth"));
			else settle(new GhFailure(`gh-exit-${code ?? "signal"}`));
		});
		child.stdin.end(input);
	});
}

async function searchIssue(target: string, signature: string): Promise<number | undefined> {
	const out = await runGh(["issue", "list", "--repo", target, "--state", "open", "--search", `"${signature}" in:body`, "--json", "number,body", "--limit", SEARCH_LIMIT], "");
	let issues: unknown;
	try { issues = JSON.parse(out); } catch { throw new GhFailure("gh-output"); }
	if (!Array.isArray(issues)) throw new GhFailure("gh-output");
	const marker = incidentMarker(signature);
	const found = issues.find((issue) => typeof issue?.body === "string" && issue.body.includes(marker) && Number.isInteger(issue.number));
	return found?.number;
}

async function createIssue(target: string, incident: Incident): Promise<number> {
	const out = await runGh(["issue", "create", "--repo", target, "--title", sanitizeForIssue(issueTitle(incident), target), "--body-file", "-"], sanitizeForIssue(issueBody(incident), target));
	const number = Number(out.match(/\/issues\/(\d+)/)?.[1]);
	if (!Number.isInteger(number)) throw new GhFailure("gh-output");
	return number;
}

async function comment(target: string, issue: number, text: string): Promise<void> {
	await runGh(["issue", "comment", String(issue), "--repo", target, "--body-file", "-"], sanitizeForIssue(text, target));
}

// --- Scheduling ---

function slotFree(at: number): boolean {
	while (filedAt.length > 0 && at - filedAt[0] >= HOUR_MS) filedAt.shift();
	return filedAt.length < FILINGS_PER_HOUR;
}

function recentlyWritten(signature: string, at: number): boolean {
	const last = lastWriteAt.get(signature);
	return last !== undefined && at - last < HOUR_MS;
}

const UNKNOWN_SIGNATURE = "skipped unknown-signature";

/** Called for every occurrence. Cheap: at most a queued task, which runs on
 *  a later turn of the event loop. */
export function noteIncidentForFiling(incident: Incident): void {
	if (!repo || incident.class === "expected" || queued.has(incident.signature)) return;
	if (!isKnownSignature(incident.signature)) {
		if (incident.filing !== UNKNOWN_SIGNATURE) {
			incident.filing = UNKNOWN_SIGNATURE;
			persist(incident);
		}
		return;
	}
	const at = now();
	if (incident.issue !== undefined && recentlyWritten(incident.signature, at)) return;
	queued.add(incident.signature);
	const target = repo;
	chain = chain
		.then(() => new Promise<void>((resolve) => setImmediate(resolve)))
		.then(() => {
			queued.delete(incident.signature);
			return fileOccurrence(incident, target);
		})
		.catch((error) => debug("incidents: filing failed:", error));
}

async function fileOccurrence(incident: Incident, target: string): Promise<void> {
	if (repo !== target) return;
	const at = now();
	if (at < failedUntil) {
		if (incident.issue === undefined && incident.filing !== `failed ${failure}`) {
			incident.filing = `failed ${failure}`;
			persist(incident);
		}
		return;
	}
	if (recentlyWritten(incident.signature, at)) return;
	if (!slotFree(at)) {
		if (incident.issue === undefined && incident.filing !== "deferred rate-limit") {
			incident.filing = "deferred rate-limit";
			persist(incident);
		}
		return;
	}
	try {
		if (incident.issue !== undefined) {
			await comment(target, incident.issue, occurrenceComment(incident));
		} else {
			const existing = await searchIssue(target, incident.signature);
			if (existing !== undefined) {
				incident.issue = existing;
				await comment(target, existing, occurrenceComment(incident));
				incident.filing = "commented";
			} else {
				incident.issue = await createIssue(target, incident);
				incident.filing = "filed";
			}
		}
		// Both limits count from when GitHub took the write: the search before
		// it can take seconds, and `at` would expire the hour that much early.
		const wroteAt = now();
		filedAt.push(wroteAt);
		lastWriteAt.set(incident.signature, wroteAt);
	} catch (error) {
		const reason = error instanceof GhFailure ? error.reason : "error";
		failure = reason;
		failedUntil = now() + HOUR_MS;
		incident.filing = `failed ${reason}`;
		debug(`incidents: gh failed for ${incident.signature}: ${reason}`);
	}
	persist(incident);
}

// --- Test seams ---

export function __testSetFilerClock(clock?: () => number): void {
	now = clock ?? (() => Date.now());
}

export async function __testFlushFilings(): Promise<void> {
	let seen: Promise<void> | undefined;
	while (seen !== chain) {
		seen = chain;
		await chain;
	}
}

export function __testResetFiler(): void {
	repo = undefined;
	persist = () => {};
	filedAt.length = 0;
	lastWriteAt.clear();
	queued.clear();
	failedUntil = 0;
	failure = "";
	chain = Promise.resolve();
}
