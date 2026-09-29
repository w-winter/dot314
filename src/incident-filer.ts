// Incident filing, which only the agent starts (the claude_bridge_incident
// tool) and only a user-scoped `incidents.repo` enables.
//
// An incident becomes an issue in that repo, through `gh` with an explicit
// `--repo`. The issue body carries a marker with the signature; before
// creating, the filer searches the repo's open issues for it and comments on
// the one it finds instead, so separate processes file each signature once.
// Within a process an incident is filed at most once: the filings are kept by
// incident id in process-global state, which every copy of the bridge shares.
// A failed `gh` (missing, logged out, erroring) is not a filing.
//
// Only signatures of the code's class and site tables are filed
// (isKnownSignature). The body is built from evidence validated by kind where
// it was recorded (incidents.ts, projectDiagMetadata) and fixed bridge prose.
// The agent's summary is free text: it passes sanitizeFreeText, the secret
// scan and the no-tagging rule, and is quoted line by line. Every title, body
// and comment passes sanitizeForIssue at the boundary.

import { spawn } from "node:child_process";
import { join } from "node:path";
import { displayPath, piUserDir } from "./config.js";
import { debug } from "./debug.js";
import { sanitizeForIssue, sanitizeFreeText } from "./incident-sanitizer.js";
import { isKnownSignature, type Incident, type IncidentLabel } from "./incidents.js";

const GH_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 60 * 1024;
const MAX_SHOW_BYTES = 24 * 1024;
const MAX_GH_OUTPUT = 1024 * 1024;
const SEARCH_LIMIT = "30";
export const MAX_SUMMARY_LENGTH = 4000;

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
	unreplayable_turn_imported_as_note: "A rebuild could not replay Claude's latest reply exactly because part of its thinking was unsigned, so it imported that reply and its tool results as a text note.",
	stream_attempt_abandoned: "Claude Code abandoned a stalled response attempt and retried it.",
	tool_call_cancelled_by_claude_code: "Claude Code cancelled a tool call before Pi was given it, and the bridge dropped the call.",
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
	tool_call_cancelled_by_claude_code: "tests/unit-tool-claim-by-id.mjs",
	unreplayable_turn_imported_as_note: "tests/unit-sync-shared-session.mjs",
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

/** Enables filing into `target` (a validated `owner/name`), or disables it.
 *  `onChange` persists an incident whose issue changed. */
export function configureFiler(target: string | undefined, onChange: (incident: Incident) => void): void {
	repo = target;
	persist = onChange;
}

/** The configured `incidents.repo`, or undefined when filing is off. */
export function filingRepo(): string | undefined {
	return repo;
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
	return `${describeIncident(incident)} ${SEEN[incident.class](incident)}`;
}

/** What happened, in plain words (the issue's "What happened"). */
export function describeIncident(incident: Incident): string {
	return DESCRIPTIONS[labelOf(incident.signature) as IncidentLabel] ?? "The bridge recorded an anomaly.";
}

/** The agent's summary, already sanitized, quoted line by line so it can
 *  never be markup of the issue or comment. */
function analysisSection(heading: string, analysis: string | undefined): string[] {
	if (analysis === undefined) return [];
	return [
		`${heading} Agent's analysis`,
		"",
		"The agent working in the session where this happened wrote:",
		"",
		...analysis.split(/\r?\n/).map((line) => `> ${line}`.trimEnd()),
		"",
	];
}

function howToReproduce(incident: Incident): string {
	const test = REPRO_TESTS[labelOf(incident.signature) as IncidentLabel];
	const pointer = test
		? `\`${test}\` drives the same path with a fake SDK and is the place to add it.`
		: "No existing test drives this path yet; `tests/unit-incidents.mjs` shows how to script one.";
	return `The flight-recorder snapshot is the event order a fake-SDK unit test would script: each record is an SDK message or stream event, a tools/call, a claim, a result or a cursor move, in the order the bridge saw them. ${pointer}`;
}

/** The issue body: the problem, the agent's analysis (sanitized), the
 *  evidence, the recorder snapshots, the diag metadata and how to reproduce.
 *  Metadata and the analysis only, under 60 KB: the latest snapshot, then the
 *  oldest records, give way first. */
export function issueBody(incident: Incident, analysis?: string): string {
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
			...analysisSection("##", analysis),
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

/** A comment on the issue another process filed for the signature: the
 *  agent's analysis (sanitized), the evidence, the latest snapshot and the
 *  latest diag metadata. Under 60 KB like the body: the oldest records, then
 *  the diag, give way first. */
export function occurrenceComment(incident: Incident, analysis?: string): string {
	let snapshot = incident.latestSnapshot ?? incident.snapshot;
	let diag: unknown = incident.latestDiag ?? incident.diag;
	for (;;) {
		const text = [
			"## New occurrence",
			"",
			SEEN[incident.class](incident),
			"",
			...analysisSection("###", analysis),
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

// --- What the agent is shown ---

const USER_SAW: Record<Incident["class"], string> = {
	"user-visible": "an error was shown, naming this incident.",
	silent: "nothing; the bridge recovered silently.",
	external: "Claude Code or the Anthropic API reported this, and the bridge passed it on.",
	expected: "nothing; this is normal cleanup, counted only.",
};

/** One line for `list`: the id, what happened, and where and how often. */
export function incidentListLine(incident: Incident): string {
	const times = incident.count === 1 ? "1 time" : `${incident.count} times`;
	const filed = incident.issue !== undefined && repo ? `, filed as ${repo}#${incident.issue}` : "";
	return `- ${incident.id}: ${describeIncident(incident)} (${labelOf(incident.signature)} at ${siteOf(incident.signature)}, ${incident.class}, seen ${times}, first ${incident.firstSeen}, last ${incident.lastSeen}${filed})`;
}

/** What `show` returns: the description, what the user saw, and the same
 *  validated evidence an issue carries, with the latest recorder snapshot.
 *  Under 24 KB: the oldest records, then the diag, give way first. */
export function incidentDetails(incident: Incident): string {
	let snapshot = incident.latestSnapshot !== undefined ? incident.latestSnapshot : incident.snapshot;
	let diag: unknown = { first: incident.diag, ...(incident.latestDiag ? { latest: incident.latestDiag } : {}) };
	for (;;) {
		const text = [
			`Incident ${incident.id}: ${labelOf(incident.signature)} at ${siteOf(incident.signature)} (${incident.class})`,
			"",
			describeIncident(incident),
			`What the user saw: ${USER_SAW[incident.class]}`,
			...(incident.issue !== undefined && repo ? [`Filed as ${repo}#${incident.issue} (${issueUrl(repo, incident.issue)}).`] : []),
			"",
			"## Evidence",
			"",
			evidenceTable(incident),
			"",
			"## Diag metadata",
			"",
			jsonBlock(diag),
			"",
			...(snapshot !== undefined ? ["## Latest recorder snapshot", "", "Recent events of the query, oldest first; `t` is milliseconds since the query started.", "", snapshot === null ? "None: this happened before the request's query started." : jsonBlock(snapshot)] : []),
		].join("\n");
		if (Buffer.byteLength(text) < MAX_SHOW_BYTES) return text;
		if (Array.isArray(snapshot) && snapshot.length > 1) snapshot = snapshot.slice(Math.floor(snapshot.length / 2));
		else if (diag !== "(too large)") diag = "(too large)";
		else return text.slice(0, MAX_SHOW_BYTES / 2);
	}
}

function issueUrl(target: string, issue: number): string {
	return `https://github.com/${target}/issues/${issue}`;
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

async function createIssue(target: string, incident: Incident, analysis: string): Promise<number> {
	const out = await runGh(["issue", "create", "--repo", target, "--title", sanitizeForIssue(issueTitle(incident), target), "--body-file", "-"], sanitizeForIssue(issueBody(incident, analysis), target));
	const number = Number(out.match(/\/issues\/(\d+)/)?.[1]);
	if (!Number.isInteger(number)) throw new GhFailure("gh-output");
	return number;
}

async function comment(target: string, issue: number, text: string): Promise<void> {
	await runGh(["issue", "comment", String(issue), "--repo", target, "--body-file", "-"], sanitizeForIssue(text, target));
}

// --- Filing ---

/** Why an incident was not filed; its message is the tool's error text. */
class FilingRefused extends Error {}

interface Filing {
	action: "filed" | "commented";
	repo: string;
	issue: number;
}

const FILINGS_SYMBOL = Symbol.for("kendex.pi.claude-bridge.incident-filings.v1");

/** Every filing of this process by incident id, finished or running. */
function filings(): Map<string, Promise<Filing>> {
	const host = globalThis as Record<symbol, unknown>;
	let store = host[FILINGS_SYMBOL] as Map<string, Promise<Filing>> | undefined;
	if (!store) {
		store = new Map();
		host[FILINGS_SYMBOL] = store;
	}
	return store;
}

function filingOffText(): string {
	return `Incident filing is off. The user can turn it on by adding "incidents": { "repo": "<owner>/<name>" } to ${displayPath(join(piUserDir(), "claude-bridge.json"))}, the user config; a project's config cannot set it. Filing uses the gh CLI, installed and logged in.`;
}

/** Files `incident` with the agent's `summary` (free text, at most
 *  MAX_SUMMARY_LENGTH characters): a comment on the open issue carrying its
 *  marker, or a new issue. Resolves the tool's reply; a filing already made
 *  in this process (or running) is returned without `gh`. Throws
 *  FilingRefused, or an Error naming gh's short failure reason. */
export async function fileIncident(incident: Incident, summary: string | undefined): Promise<string> {
	const target = repo;
	if (!target) throw new FilingRefused(filingOffText());
	if (incident.class === "expected") throw new FilingRefused(`Incident ${incident.id} is expected cleanup, which is never filed.`);
	if (!isKnownSignature(incident.signature)) throw new FilingRefused(`Incident ${incident.id} is not one the bridge files.`);
	const text = summary ?? "";
	if (text.trim().length === 0) throw new FilingRefused("A summary is required to file an incident: describe what the bridge did and your analysis of it.");
	if (text.length > MAX_SUMMARY_LENGTH) throw new FilingRefused(`The summary is ${text.length} characters; the limit is ${MAX_SUMMARY_LENGTH}. Shorten it and file again.`);
	const store = filings();
	const earlier = store.get(incident.id);
	if (earlier) {
		const filed = await earlier;
		return `Incident ${incident.id} was already filed in this Pi process as ${filed.repo}#${filed.issue} (${issueUrl(filed.repo, filed.issue)}). Tell the user it is filed there.`;
	}
	const filing: Promise<Filing> = fileWithGh(target, incident, sanitizeFreeText(text, target)).catch((error: unknown) => {
		// A failed gh is not a filing: the agent may file it again.
		if (store.get(incident.id) === filing) store.delete(incident.id);
		const reason = error instanceof GhFailure ? error.reason : "error";
		debug(`incidents: gh failed filing ${incident.signature}: ${reason}`);
		throw new Error(`Could not file incident ${incident.id}: ${reason}.`);
	});
	store.set(incident.id, filing);
	const filed = await filing;
	const where = `${filed.repo}#${filed.issue} (${issueUrl(filed.repo, filed.issue)})`;
	return filed.action === "filed"
		? `Filed ${where}. Tell the user you filed it.`
		: `Commented on ${where}, the open issue already filed for this incident's signature. Tell the user you commented on it.`;
}

async function fileWithGh(target: string, incident: Incident, analysis: string): Promise<Filing> {
	const existing = await searchIssue(target, incident.signature);
	let filed: Filing;
	if (existing !== undefined) {
		await comment(target, existing, occurrenceComment(incident, analysis));
		filed = { action: "commented", repo: target, issue: existing };
	} else {
		filed = { action: "filed", repo: target, issue: await createIssue(target, incident, analysis) };
	}
	incident.issue = filed.issue;
	persist(incident);
	return filed;
}

// --- Test seams ---

export function __testResetFiler(): void {
	repo = undefined;
	persist = () => {};
	filings().clear();
}
