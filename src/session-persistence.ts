import { type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import { createSession, deleteSession, openSession, repairToolPairing, serializeRecord, type JsonlRecord } from "cc-session-io";
import { createHash } from "crypto";
import { closeSync, mkdirSync, openSync, realpathSync, rmSync, statSync, writeFileSync } from "fs";
import { dirname, resolve as pathResolve } from "path";
import { REBUILD_MARKS, getExtensionApi, getSharedSession, reportSyntheticToolResultRepair, safeNotify, setSharedSession, type RebuildMark, type SessionState } from "./bridge-state.ts";
import { displayPath } from "./config.ts";
import { convertPiMessages } from "./convert.ts";
import { debug, diagDump, diagGuidance, parseErrorShape } from "./debug.ts";
import { noteAnomaly } from "./agent-notice.ts";
import { UNVERIFIED_HISTORY_DIGEST, historyDigest, sharedHistoryMatches } from "./history-digest.ts";
import { forkNativePrefix, planNativePrefix, type ForkedPrefix, type NativePrefix } from "./native-fork.ts";
import { stepEnd, stepStart, type SyncTiming } from "./request-timing.ts";
import { verifyWrittenSession as _verifyWrittenSession } from "./session-verify.ts";
import {
	findUnpairedToolUses,
	insertLostToolResultPlaceholders,
	recoverLaterToolResults,
} from "./tool-pairing-audit.ts";
import { claudeDirForProfile, resolveClaudeAccountRouter, type AccountSessionScope } from "./account-router.ts";

// --- Session persistence ---

const BRIDGE_SESSION_CUSTOM_TYPE = "claude-bridge-session";

// Persisted shape: SessionState MINUS claudeConfigDir. Config-dir paths are
// account-identifying and travel with shared session archives, so only the
// opaque accountProfileId is written; the dir is re-derived via the router on
// restore (no back-compat reader for older shapes — see CHANGELOG 3.0.0).
interface PersistedBridgeSessionState extends Omit<SessionState, "claudeConfigDir"> {
	fingerprint: string;
	piSessionId?: string;
	updatedAt: string;
}

function normalizedMessageText(message: unknown): string {
	const content = (message as { content?: unknown }).content;
	const text = typeof content === "string"
		? content
		: Array.isArray(content)
			? content
				.map((block) => (block as { type?: string; text?: string }).type === "text" ? (block as { text?: string }).text ?? "" : "")
				.join("\n")
			: "";
	return text.trim();
}

function shortHash(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

/** Identity anchor for a pi conversation, encoded component-wise as
 *  `u:<12hex>` (short sha256 of the FIRST user message's normalized text) or
 *  `u:<12hex>|a:<12hex>` (plus the FIRST assistant message's normalized text
 *  once the conversation has one with any text). The opening messages are the
 *  stable elements of a pi history — later messages get appended, compacted,
 *  or tree-navigated (all of which set needsRebuild), but the first user/
 *  assistant pair survives for the session's lifetime. The two-component form
 *  exists because a first USER message alone is a weak anchor: unrelated
 *  conversations routinely open with identical text ("continue"), and a
 *  same-opener foreign context shaped to align with the cursor would REUSE
 *  across genuinely different histories. Returns undefined when the context
 *  has no user message or its text normalizes to empty (image-only) —
 *  identity unknown, callers must fail open to the pre-fingerprint behavior,
 *  never treat it as a mismatch. Distinct from fingerprintMessages below,
 *  which hashes a cursor slice for restore integrity. */
export function conversationFingerprint(messages: Context["messages"]): string | undefined {
	const firstUser = messages.find((message) => (message as { role?: string }).role === "user");
	if (!firstUser) return undefined;
	const userText = normalizedMessageText(firstUser);
	if (!userText) return undefined;
	const firstAssistant = messages.find((message) => (message as { role?: string }).role === "assistant");
	const assistantText = firstAssistant ? normalizedMessageText(firstAssistant) : "";
	return assistantText ? `u:${shortHash(userText)}|a:${shortHash(assistantText)}` : `u:${shortHash(userText)}`;
}

function parseConversationFingerprint(fp: string): { user: string; assistant?: string } | undefined {
	const match = /^u:([0-9a-f]+)(?:\|a:([0-9a-f]+))?$/.exec(fp);
	if (!match) return undefined;
	return { user: match[1], ...(match[2] ? { assistant: match[2] } : {}) };
}

/** Component-wise anchor comparison. The user component must always match; the
 *  assistant component is compared only when BOTH sides carry one — a record
 *  stamped on turn 1 has no assistant yet, and its own conversation grown past
 *  turn 1 is an upgrade, not a mismatch (see conversationFingerprintUpgrade).
 *  An unparseable side means identity unknown: fail open (match), consistent
 *  with the guard's treatment of absent fingerprints. */
export function conversationFingerprintsMatch(recorded: string, incoming: string): boolean {
	const rec = parseConversationFingerprint(recorded);
	const inc = parseConversationFingerprint(incoming);
	if (!rec || !inc) return true;
	if (rec.user !== inc.user) return false;
	return !(rec.assistant && inc.assistant && rec.assistant !== inc.assistant);
}

/** Whether a REUSE-matched context's anchor should replace the recorded one:
 *  a legacy record with none adopts it outright (the planner accepting this
 *  context as the recorded conversation's continuation is the identity proof),
 *  and a turn-1 user-only record upgrades to the two-component form the
 *  moment its own conversation carries a first assistant message. A recorded
 *  two-component anchor is never rewritten. */
function conversationFingerprintUpgrade(recorded: string | undefined, incoming: string | undefined): string | undefined {
	if (!incoming) return undefined;
	if (!recorded) return incoming;
	const rec = parseConversationFingerprint(recorded);
	const inc = parseConversationFingerprint(incoming);
	return rec && inc && !rec.assistant && inc.assistant && rec.user === inc.user ? incoming : undefined;
}

/** Whether `messages` is provably another conversation than the one `record`
 *  holds: both identity anchors are known and differ, and the context is no
 *  longer than what the record covers. A record owed a rebuild never
 *  qualifies: Pi just rewrote its conversation, so its anchor may have moved.
 *  syncSharedSession's Case 6 explains both limits. */
export function isForeignConversation(record: SessionState | null, messages: Context["messages"]): boolean {
	if (!record || record.needsRebuild || !record.conversationFingerprint) return false;
	const incoming = conversationFingerprint(messages);
	return incoming !== undefined &&
		!conversationFingerprintsMatch(record.conversationFingerprint, incoming) &&
		messages.length - 1 <= record.cursor;
}

function fingerprintMessages(messages: Context["messages"]): string {
	const started = stepStart();
	const normalized = messages.map((message) => {
		if (message.role === "assistant") {
			return {
				role: message.role,
				provider: (message as AssistantMessage).provider,
				model: (message as AssistantMessage).model,
				content: (message as AssistantMessage).content,
			};
		}
		return message;
	});
	const fingerprint = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
	stepEnd("fingerprint", started);
	return fingerprint;
}

function readBuiltSessionContext(sessionManager: unknown): { messages: Context["messages"] } | undefined {
	const built = typeof (sessionManager as any)?.buildSessionContext === "function" ? (sessionManager as any).buildSessionContext() : undefined;
	return Array.isArray(built?.messages) ? built as { messages: Context["messages"] } : undefined;
}

function latestPersistedBridgeSession(sessionManager: unknown): PersistedBridgeSessionState | undefined {
	const entries = typeof (sessionManager as any)?.getEntries === "function" ? (sessionManager as any).getEntries() : [];
	if (!Array.isArray(entries)) return undefined;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type !== "custom" || entry.customType !== BRIDGE_SESSION_CUSTOM_TYPE) continue;
		const data = entry.data as Partial<PersistedBridgeSessionState> | undefined;
		if (!data || typeof data.sessionId !== "string" || typeof data.cursor !== "number" || typeof data.cwd !== "string" || typeof data.fingerprint !== "string") continue;
		return data as PersistedBridgeSessionState;
	}
	return undefined;
}

function claudeSessionExists(sessionId: string, cwd: string, claudeDir: string | undefined): boolean {
	try {
		const session = openSession({ sessionId, projectPath: cwd, claudeDir });
		statSync(session.jsonlPath);
		return true;
	} catch {
		return false;
	}
}

function canonicalize(p: string | undefined): string | undefined {
	if (!p) return undefined;
	try { return realpathSync.native(p); } catch { return pathResolve(p); }
}

// Decides whether a persisted bridge-session marker is safe to restore.
//
// The fork case is the load-bearing one: pi/core's createBranchedSession copies
// every non-label entry from root→leaf into the fork session file. That includes
// our claude-bridge-session markers from the parent. Restoring from them would
// --resume parent's Claude jsonl on the fork's first turn, leaking conversation
// past the fork point.
//
// Returns undefined when the entry is safe to use, or a short rejection reason
// for diagnostic logging. Old entries without piSessionId always reject, which
// degrades safely to the rebuild path.
export function shouldRestorePersistedBridgeEntry(
	persisted: { piSessionId?: string; cwd: string },
	currentPiSessionId: string | undefined,
	currentCwd: string | undefined,
): string | undefined {
	if (!persisted.piSessionId) return "missing piSessionId";
	if (currentPiSessionId && persisted.piSessionId !== currentPiSessionId) {
		return `piSessionId mismatch (persisted=${persisted.piSessionId} current=${currentPiSessionId})`;
	}
	if (currentCwd && canonicalize(persisted.cwd) !== canonicalize(currentCwd)) {
		return `cwd mismatch (persisted=${persisted.cwd} current=${currentCwd})`;
	}
	return undefined;
}

export function restoreSharedSessionFromPi(ctx: { sessionManager?: unknown; cwd?: string }): void {
	const persisted = latestPersistedBridgeSession(ctx.sessionManager);
	if (!persisted) return;
	const currentPiSessionId = typeof (ctx.sessionManager as any)?.getSessionId === "function" ? (ctx.sessionManager as any).getSessionId() : undefined;
	const currentCwd = typeof (ctx.sessionManager as any)?.getCwd === "function" ? (ctx.sessionManager as any).getCwd() : ctx.cwd;
	const rejection = shouldRestorePersistedBridgeEntry(persisted, currentPiSessionId, currentCwd);
	if (rejection) {
		debug(`restoreSharedSession: ${rejection} — forcing rebuild`);
		return;
	}
	const built = readBuiltSessionContext(ctx.sessionManager);
	if (!built) return;
	const cursor = Math.max(0, Math.min(persisted.cursor, built.messages.length));
	const fingerprint = fingerprintMessages(built.messages.slice(0, cursor));
	if (fingerprint !== persisted.fingerprint) {
		debug(`restoreSharedSession: fingerprint mismatch for ${persisted.sessionId.slice(0, 8)}`);
		return;
	}
	// Only the opaque profile id is persisted; a managed session re-derives its
	// claude dir through the live router (router absent or id unknown → the
	// default-profile rule, which may fail the existence check and rebuild).
	const accountProfileId = typeof persisted.accountProfileId === "string" ? persisted.accountProfileId : undefined;
	const claudeConfigDir = accountProfileId
		? claudeDirForProfile(resolveClaudeAccountRouter()?.resolveProfile?.(accountProfileId) ?? {})
		: undefined;
	if (!claudeSessionExists(persisted.sessionId, persisted.cwd, claudeConfigDir ?? process.env.CLAUDE_CONFIG_DIR)) {
		debug(`restoreSharedSession: Claude session missing for ${persisted.sessionId.slice(0, 8)}`);
		return;
	}
	setSharedSession({
		sessionId: persisted.sessionId,
		cursor,
		cwd: persisted.cwd,
		// Absent on pre-3.1.1 markers: restore as identity-unknown (the foreign
		// guard fails open) rather than rejecting the entry.
		...(typeof persisted.conversationFingerprint === "string" ? { conversationFingerprint: persisted.conversationFingerprint } : {}),
		// The digest of the history Claude holds travels with the marker; absent
		// on older markers, where the next REUSE adopts one (history-digest.ts).
		...(typeof persisted.historyDigest === "string" ? { historyDigest: persisted.historyDigest } : {}),
		...(typeof persisted.trailingAssistantDigest === "string" ? { trailingAssistantDigest: persisted.trailingAssistantDigest } : {}),
		// A rebuild the record still owed must survive the restart: without it
		// the next turn would resume a transcript known to differ from Pi's.
		...(persisted.needsRebuild === true ? {
			needsRebuild: true,
			...(REBUILD_MARKS.includes(persisted.rebuildReason as RebuildMark) ? { rebuildReason: persisted.rebuildReason } : {}),
		} : {}),
		...(persisted.forceRotate === true ? { forceRotate: true } : {}),
		...(accountProfileId ? { accountProfileId, claudeConfigDir } : {}),
	});
	debug(`restoreSharedSession: restored ${persisted.sessionId.slice(0, 8)}, cursor=${cursor}, account=${accountProfileId ?? "default"}`);
}

// One pending persist per SessionManager: cancelling a shutting-down session's
// persist must not drop a concurrent session's unwritten marker. On globalThis
// under a versioned symbol for the same reason as the lane registries in
// bridge-state.ts and query-state.ts — the scheduling and the cancelling module
// instance can differ. Scheduling again for the same manager REPLACES the
// pending timer: each fire appends the record's state as of its schedule and
// restore reads the last marker, so the superseded entry is a stale duplicate.
const SCHEDULED_PERSISTENCE_SYMBOL = Symbol.for("kendex.pi.claude-bridge.scheduled-persistence.v1");

type PersistenceTimer = ReturnType<typeof setTimeout>;

function scheduledPersistenceTimers(): Map<object, PersistenceTimer> {
	const host = globalThis as Record<symbol, unknown>;
	let store = host[SCHEDULED_PERSISTENCE_SYMBOL] as Map<object, PersistenceTimer> | undefined;
	if (!store) {
		store = new Map<object, PersistenceTimer>();
		host[SCHEDULED_PERSISTENCE_SYMBOL] = store;
	}
	return store;
}

export function cancelScheduledSessionPersistence(sessionManager: object): void {
	const timers = scheduledPersistenceTimers();
	const timer = timers.get(sessionManager);
	if (timer === undefined) return;
	clearTimeout(timer);
	timers.delete(sessionManager);
}

/** Test-only: drop every pending persist so a test file starts clean. */
export function __testCancelAllScheduledSessionPersistence(): void {
	const timers = scheduledPersistenceTimers();
	for (const timer of timers.values()) clearTimeout(timer);
	timers.clear();
}

export function schedulePersistSharedSession(ctxLike?: { sessionManager?: unknown }): void {
	const sharedSession = getSharedSession();
	const extensionApi = getExtensionApi();
	if (!extensionApi || !sharedSession || !ctxLike?.sessionManager) return;
	// Extension contexts become guarded/stale as soon as shutdown or replacement
	// starts. Capture the plain SessionManager reference now and cancel the timer
	// on shutdown rather than dereferencing the ctx proxy from the next tick.
	const sessionManager = ctxLike.sessionManager as object;
	// Persist only the opaque profile id — the resolved config dir is an
	// account-identifying path and stays in memory (see PersistedBridgeSessionState).
	const { claudeConfigDir: _omitted, ...snapshot } = sharedSession;
	const timers = scheduledPersistenceTimers();
	const superseded = timers.get(sessionManager);
	if (superseded !== undefined) clearTimeout(superseded);
	const timer = setTimeout(() => {
		if (timers.get(sessionManager) === timer) timers.delete(sessionManager);
		const started = stepStart();
		try {
			const built = readBuiltSessionContext(sessionManager);
			if (!built) return;
			const cursor = Math.max(0, Math.min(snapshot.cursor, built.messages.length));
			const data: PersistedBridgeSessionState = {
				...snapshot,
				cursor,
				fingerprint: fingerprintMessages(built.messages.slice(0, cursor)),
				piSessionId: typeof (sessionManager as any)?.getSessionId === "function" ? (sessionManager as any).getSessionId() : undefined,
				updatedAt: new Date().toISOString(),
			};
			extensionApi?.appendEntry(BRIDGE_SESSION_CUSTOM_TYPE, data);
			debug(`persistSharedSession: saved ${data.sessionId.slice(0, 8)}, cursor=${data.cursor}`);
		} catch (error) {
			// A failed persist means the next startup restores a stale (or no)
			// bridge marker and silently rebuilds — worth a diagnostic entry.
			// Like all diagDump output this lands only under CLAUDE_BRIDGE_DEBUG=1
			// and the failure itself stays non-fatal either way.
			diagDump("persist_shared_session_failed", {
				sessionId: snapshot.sessionId.slice(0, 8),
				cursor: snapshot.cursor,
				error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
			});
			noteAnomaly("persist_shared_session_failed");
		} finally {
			stepEnd("persist", started);
		}
	}, 0);
	timers.set(sessionManager, timer);
	timer.unref?.();
}

// Convert pi messages to Anthropic API format for session import.
// Lossy: non-Anthropic thinking blocks are dropped (no valid signature). User and
// tool-result image blocks are preserved when possible. If assistant blocks are
// otherwise incompatible, convertPiMessages emits a text placeholder so the record
// sequence stays valid before repairToolPairing runs. A trailing Claude turn
// whose thinking cannot be replayed exactly is imported as a user-side note of
// what it said and did, with its tool results (convert.ts, unreplayedTurnNote).
function convertAndImportMessages(
	session: ReturnType<typeof createSession>,
	messages: Context["messages"],
	customToolNameToSdk?: Map<string, string>,
	cwd?: string,
): void {
	const { anthropicMessages, sanitizedIds, notedTurns } = convertPiMessages(messages, customToolNameToSdk, { noteUnreplayableTurns: true });
	if (notedTurns.length > 0) {
		const calls = notedTurns.flatMap((turn) => turn.calls);
		debug(`convertAndImportMessages: ${notedTurns.length} trailing Claude turn(s) with unsigned thinking imported as a note, carrying ${calls.length} tool call(s):`, calls.map((call) => `${call.name} [${call.id}]`).join(", "));
		diagDump("unreplayable_turn_imported_as_note", { count: notedTurns.length, calls: calls.slice(0, 50) });
		noteAnomaly("unreplayable_turn_imported_as_note");
	}

	debug(`convertAndImportMessages: ${messages.length} pi msgs → ${anthropicMessages.length} anthropic msgs`);
	debug(`convertAndImportMessages: imported roles:`, anthropicMessages.map((m, i) => {
		const c = m.content;
		if (typeof c === "string") return `[${i}]${m.role}:text`;
		if (Array.isArray(c)) return `[${i}]${m.role}:${(c).map((b) => b.type).join("+")}`;
		return `[${i}]${m.role}:?`;
	}).join(" "));
	if (sanitizedIds.size > 0) {
		debug(`convertAndImportMessages: sanitized ${sanitizedIds.size} tool IDs:`,
			[...sanitizedIds.entries()].map(([orig, clean]) => orig === clean ? orig : `${orig}→${clean}`).join(", "));
	}
	// A steer can make Pi split one parallel Claude batch across several visible
	// assistant/tool-result pairs. Recover those real later results before the
	// generic repair layer mistakes them for lost output.
	const recoveredToolResults = recoverLaterToolResults(anthropicMessages);
	if (recoveredToolResults.length > 0) {
		debug(
			`convertAndImportMessages: recovered ${recoveredToolResults.length} later tool result(s) for original parallel batch`,
			recoveredToolResults.map((item) => item.id).join(", "),
		);
	}
	// Pre-repair: pair every REMAINING orphaned tool_use with an EXPLICIT
	// bridge-authored error result before cc-session-io's repairToolPairing can
	// backfill its bare "[no tool result recorded]" placeholder — which the model
	// reads as tool output and silently reasons on. Ours is is_error and says
	// what to do. repairToolPairing still runs after (idempotent; finds nothing left).
	const missingToolResults = findUnpairedToolUses(anthropicMessages);
	if (missingToolResults.length > 0) {
		reportSyntheticToolResultRepair(missingToolResults, {
			cwd,
			messageCount: messages.length,
			anthropicMessageCount: anthropicMessages.length,
			sessionId: session.sessionId,
			jsonlPath: session.jsonlPath,
		});
		insertLostToolResultPlaceholders(anthropicMessages, missingToolResults);
	}
	const repaired = repairToolPairing(anthropicMessages);
	if (repaired.length !== anthropicMessages.length) {
		debug(`convertAndImportMessages: repairToolPairing ${anthropicMessages.length} → ${repaired.length} msgs`);
	}
	if (repaired.length) session.importMessages(repaired);
}

export interface SyncResult {
	sessionId: string | null;
	// Index into the caller's messages array where this query's prompt begins.
	// Everything from promptStart to the end is user input Claude has not seen;
	// the caller slices it out itself (single owner of the messages array).
	promptStart: number;
	// True when the incoming context's conversation fingerprint contradicts the
	// shared record's (Case 6): the query runs as a clean one-shot and its
	// completion must NOT persist over the module-level record — the caller
	// gates its persistSession/markRebuild on it.
	foreignContext?: boolean;
	// The request was cancelled while a forked rebuild awaited the SDK. Nothing
	// was written and the record is untouched; the caller must not start a
	// query.
	cancelled?: boolean;
	// The path taken and, when it is not REUSE, why (request-timing.ts).
	sync: SyncTiming;
}

export interface SyncOptions {
	// Asked once a forked rebuild's fork has settled: true when the request
	// was cancelled or its lane ended meanwhile. The rebuild then writes
	// nothing and returns `cancelled`.
	cancelled?: () => boolean;
	// false: never fork, import Pi's whole history (the re-plan after a fork
	// could not be used).
	fork?: boolean;
	// The query's map from served tool names to Pi's (index.ts
	// resolveMcpTools), the one its stream names Pi's tool calls with. A
	// forked rebuild compares Claude Code's tool calls to Pi's through it.
	customToolNameToPi?: Map<string, string>;
}

export interface IncrementalPromptBatchPlan {
	// Doubles as the cursor to store before the query runs: Claude owns
	// [0, promptStart) and the prompt delivers [promptStart, end).
	promptStart: number;
	userMessageCount: number;
}

/**
 * Recognize history that Claude already owns followed only by user messages
 * delivered together by Pi (for example, followUpMode="all"). Claude Code has
 * already persisted the optional leading assistant message; every user message
 * after it must be sent as this query's prompt rather than imported via rebuild.
 */
export function planIncrementalPromptBatch(
	messages: Context["messages"],
	cursor: number,
): IncrementalPromptBatchPlan | undefined {
	const lastIndex = messages.length - 1;
	if (lastIndex < 0 || (messages[lastIndex] as { role?: string }).role !== "user") return undefined;

	// A cursor past the end is PROOF this messages array is not the conversation
	// the cursor describes (e.g. another conversation's short context arriving
	// while the parent's cursor is large). Clamping it would fabricate a REUSE
	// plan against foreign history — reject so the caller takes the rebuild path.
	if (cursor > lastIndex) {
		debug(`planIncrementalPromptBatch: rejected — cursor=${cursor} beyond last index ${lastIndex}; messages are not the conversation this cursor describes`);
		return undefined;
	}
	const boundedCursor = Math.max(0, cursor);
	let promptStart = boundedCursor;
	if ((messages[promptStart] as { role?: string } | undefined)?.role === "assistant") promptStart++;

	const pendingPrompts = messages.slice(promptStart);
	if (pendingPrompts.length === 0 || pendingPrompts.some((message) => (message as { role?: string }).role !== "user")) {
		// Log the rejected tail so a diag log can tell apart "two assistants in
		// tail" vs "toolResult in tail" vs "stale cursor" without a repro.
		debug(`planIncrementalPromptBatch: rejected — cursor=${cursor} promptStart=${promptStart} tail roles=[${messages.slice(boundedCursor).map((m) => (m as { role?: string }).role).join(", ")}]`);
		return undefined;
	}

	return {
		promptStart,
		userMessageCount: pendingPrompts.length,
	};
}

// Read the session file we just wrote and sanity-check it. Warns instead of
// throwing — CC may be more tolerant than our checks, so a false positive
// shouldn't block the user. Pure logic is in session-verify.js; this wrapper
// fans each warning out to debug log + piUI notify + diagDump.
function verifyWrittenSession(
	jsonlPath: string,
	expectedSessionId: string,
	expectedRecordCount: number,
	cwd: string,
	claudeDir: string | undefined,
): void {
	const warnings = _verifyWrittenSession(jsonlPath, expectedSessionId, expectedRecordCount);
	for (const msg of warnings) {
		debug(`WARNING session verify: ${msg}`);
		// No CLAUDE_CONFIG_DIR value here: a user may paste this text anywhere
		// and config-dir paths are account-identifying (see the
		// persisted-shape note at the top of this file). The diagDump below
		// records it locally instead. Paths are home-relativized for the same
		// reason — an absolute cwd carries the username; the diagDump keeps the
		// absolute forms.
		safeNotify(
			`Session file issue: ${msg}\n` +
			`cwd=${displayPath(cwd)} realpath=${displayPath(safeRealpath(cwd))}\n` +
			`For details, ${diagGuidance()}.`,
			"warning",
		);
		diagDump("session_verify_fail", { msg, jsonlPath, cwd, realpath: safeRealpath(cwd), claudeConfigDir: claudeDir ?? null });
		noteAnomaly("session_verify_fail");
	}
}

function safeRealpath(p: string): string {
	try { return realpathSync(p); } catch (e) { return `<failed: ${(e as Error).message}>`; }
}

// Diagnostic snapshot of where a session file was just written. Catches the
// class of bugs where pi writes to ~/.claude/projects/<X> but CC SDK reads
// from ~/.claude/projects/<Y> (symlinks, CLAUDE_CONFIG_DIR, hash mismatch).
function debugSessionPaths(label: string, cwd: string, jsonlPath: string, claudeDir: string | undefined): void {
	const realCwd = safeRealpath(cwd);
	let fileSize: number | null = null;
	let fileExists = false;
	try {
		const st = statSync(jsonlPath);
		fileExists = true;
		fileSize = st.size;
	} catch { /* file may not exist yet */ }
	debug(`${label}: cwd=${cwd}`);
	if (realCwd !== cwd) debug(`${label}: realpath(cwd)=${realCwd} (DIFFERS — symlink-resolved path is what CC SDK uses)`);
	debug(`${label}: jsonlPath=${jsonlPath}`);
	debug(`${label}: fileExists=${fileExists}${fileSize != null ? ` size=${fileSize}` : ""}`);
	debug(`${label}: selected.CLAUDE_CONFIG_DIR=${claudeDir ?? "(unset)"} HOME=${process.env.HOME ?? "(unset)"}`);
}

// Two semantic paths:
//   REUSE — pi's history is in sync with the existing sharedSession, drifted
//     only by an optional trailing assistant message (the final-assistant pi
//     appends after streamSimple returns, which CC's own persisted session
//     already has) plus an unbounded trailing run of user messages delivered
//     together by pi (steer-queue drain, followUpMode="all"). The whole user
//     run becomes this query's prompt. The unbounded run is safe because
//     promptStart can never land on a user message Claude already persisted:
//     Claude owns [0, cursor), promptStart starts at the cursor and only ever
//     advances (past the one optional assistant), so everything from
//     promptStart on is uncaptured input. Returns the existing sessionId. Keeps CC's
//     prompt cache warm.
//     The count check alone cannot see a same-length rewrite of the history
//     Claude holds, so REUSE also requires the record's history digest to
//     match Pi's messages before the cursor (Case 7 otherwise; see
//     history-digest.ts for what the digest covers and ignores).
//   REBUILD — no session yet, or pi's history has diverged (non-trailing
//     missed messages, e.g. another provider took a turn). Wipes the existing
//     session file (if any) and writes a fresh one containing all prior
//     messages, reusing the same sessionId across rebuilds so UUIDs stay
//     stable for the lifetime of pi's session.
//   FORKED REBUILD — a same-account rebuild (Case 4) whose old transcript
//     still holds a prefix of Pi's history with equal content. The new
//     session starts as Claude Code's own records for that prefix (forked
//     with the SDK under a new id, native-fork.ts) and only Pi's messages
//     after it are imported, so the next request repeats the bytes Claude
//     Code sent before and reads them from the prompt cache. A full import
//     cannot: Claude Code's requests carry attachments and result forms that
//     never reach Pi. Forking awaits the SDK, so this path alone returns a
//     promise; every other path stays synchronous.
//
// Why a full rebuild rather than patching:
//   Injecting deltas into an existing session creates a branch that CC's
//   --resume doesn't follow (documented attempt prior to this). A complete
//   overwrite at the same path is simpler and correct.
//
// Why reuse the sessionId across full rebuilds:
//   CC re-reads the JSONL on every --resume call — no in-process UUID
//   caching. Validated in tests/exp-session-clear.mjs, including the case
//   where CC had appended its own tool_use/tool_result records between
//   rebuilds. Preserving the UUID means stable log correlation across
//   provider switches and no orphaned session files.
//   A forked rebuild takes the fork's new id instead; on the preserved-id
//   path it deletes the old file once the new one is written and verified.
//
// Log strings still say "Case 1/2/3/4" so existing diagnostics (int-cache.sh,
// int-session-resume.mjs) keep grepping the same anchors.
export function syncSharedSession(
	messages: Context["messages"],
	cwd: string,
	customToolNameToSdk?: Map<string, string>,
	modelId?: string,
	account?: AccountSessionScope,
	options: SyncOptions = {},
): SyncResult | Promise<SyncResult> {
	const sharedSession = getSharedSession();
	const priorMessages = messages.slice(0, -1); // everything before the current user prompt
	const accountProfileId = account?.accountProfileId;
	const scopeConfigDir = account?.claudeConfigDir; // resolved dir for managed, undefined for legacy
	// What cc-session-io reads/writes. Managed requests always carry a resolved
	// dir (accountSessionScope) so this never falls back to the process env the
	// child does not see; legacy keeps the env rule unchanged.
	const claudeDir = scopeConfigDir ?? process.env.CLAUDE_CONFIG_DIR;
	const sameAccount = Boolean(
		sharedSession &&
		sharedSession.accountProfileId === accountProfileId &&
		sharedSession.claudeConfigDir === scopeConfigDir,
	);
	const incomingFingerprint = conversationFingerprint(messages);
	// The reason the record was marked for rebuild, if it was (bridge-state.ts).
	const mark = sharedSession?.needsRebuild ? sharedSession.rebuildReason ?? "unrecorded" : undefined;

	// FOREIGN-CONVERSATION guard. A subagent-shaped query
	// arriving while the parent is IDLE finds no running query to join, so it
	// can land here. Without an identity check its short foreign context takes
	// the REBUILD path — rewriting the PARENT's session file from foreign
	// history — and its completion swaps the parent's record for the child's.
	// A conversation-fingerprint mismatch is that identity signal: run the query
	// as a clean one-shot (no resume, prompt is the trailing message) and leave
	// the record completely alone. Two deliberate limits keep misclassification
	// self-healing instead of sticky:
	//   - needsRebuild is a carve-out: pi just mutated its history out from
	//     under us (compact, tree-nav, abort recovery), so the next outermost
	//     context is authoritative for THIS conversation even if its anchor
	//     moved — it must reach REBUILD, not be shunted into a one-shot.
	//   - Length monotonicity (the issue's second signal): a real conversation
	//     only grows, so a context LONGER than what the record's cursor covers
	//     can be the recorded conversation while a mismatching shorter one
	//     cannot. Should a foreign fingerprint ever capture the record (legacy
	//     no-fingerprint records still rebuild, below), the parent's longer
	//     context falls through to REBUILD and reclaims it in one turn — a
	//     mismatch-always-one-shot rule would instead degrade every subsequent
	//     parent turn to a historyless one-shot with no recovery.
	// Either fingerprint being unknown (no user message, image-only opener,
	// pre-3.1.1 record) fails open to the pre-fingerprint behavior.
	// The provider routes such a request to a fork lane before it gets here
	// (requestLaneFor); this guard still covers the re-entries that skip
	// routing (restart, account retry).
	if (sharedSession && incomingFingerprint && isForeignConversation(sharedSession, messages)) {
		debug(
			`Case 6 foreign-conversation: fingerprint ${incomingFingerprint.slice(0, 8)} != record ${sharedSession.conversationFingerprint?.slice(0, 8)} ` +
			`(cursor=${sharedSession.cursor}, priors=${priorMessages.length}) — clean one-shot, record untouched`,
		);
		debug(`syncResult: path=foreign-one-shot cause=foreign-conversation`);
		return { sessionId: null, promptStart: messages.length - 1, foreignContext: true, sync: { path: "foreign-one-shot", cause: "foreign-conversation" } };
	}

	// Why the REUSE check below failed, when it ran.
	let digestCause: "digest-mismatch" | "unverified-digest" | undefined;
	// REUSE path. A Claude session can only be resumed under the credential
	// profile that created its JSONL and prompt cache.
	if (sharedSession && sameAccount && !sharedSession.needsRebuild) {
		const batch = planIncrementalPromptBatch(messages, sharedSession.cursor);
		// The count-based plan only says the tail is new user input. The history
		// Claude already holds (before the cursor, plus the reply Pi appended at
		// it) must also still be Pi's: a same-length rewrite of it (a Pi context
		// edit, an extension's context transform) would otherwise leave Claude on
		// its stale transcript for good. See history-digest.ts.
		const prior = batch ? sharedHistoryMatches(sharedSession, messages, batch.promptStart) : undefined;
		if (batch && prior && !prior.matches) {
			debug(`Case 7 history-rewritten: Pi's history through prompt start ${batch.promptStart} no longer matches what session ${sharedSession.sessionId.slice(0, 8)} holds (cursor=${sharedSession.cursor}) — rebuilding`);
			digestCause = sharedSession.historyDigest === UNVERIFIED_HISTORY_DIGEST || sharedSession.trailingAssistantDigest === UNVERIFIED_HISTORY_DIGEST ? "unverified-digest" : "digest-mismatch";
		}
		if (batch && prior?.matches) {
			if (!prior.checked) debug(`Case 3: record had no history digest — accepting it once and stamping one`);
			// Read the pre-update cursor first: setSharedSession reassigns the live
			// binding, so comparing against sharedSession.cursor afterwards would
			// always be equal and the "advanced past trailing assistant" debug
			// branch could never print.
			const cursorBeforeUpdate = sharedSession.cursor;
			// A REUSE match proves identity, so the anchor may only strengthen here:
			// a pre-3.1.1 record adopts it outright, and a turn-1 user-only anchor
			// upgrades to the two-component form once the conversation has its
			// first assistant message (see conversationFingerprintUpgrade).
			const upgradedFingerprint = conversationFingerprintUpgrade(sharedSession.conversationFingerprint, incomingFingerprint);
			// The reply the trailing-assistant digest described is now inside the
			// digested history.
			const { trailingAssistantDigest: _covered, ...reused } = sharedSession;
			setSharedSession({
				...reused,
				cursor: batch.promptStart,
				historyDigest: historyDigest(messages.slice(0, batch.promptStart)),
				cwd,
				...(upgradedFingerprint ? { conversationFingerprint: upgradedFingerprint } : {}),
			});
			const batching = batch.userMessageCount > 1
				? `batched ${batch.userMessageCount} consecutive user messages, `
				: batch.promptStart > cursorBeforeUpdate ? "advanced cursor past trailing assistant, " : "";
			debug(`Case 3: ${batching}resuming session ${sharedSession.sessionId.slice(0, 8)}, cursor=${batch.promptStart}, account=${accountProfileId ?? "default"}`);
			debug(`syncResult: path=reuse sessionId=${sharedSession.sessionId} cursor=${batch.promptStart} promptUsers=${batch.userMessageCount}`);
			return {
				sessionId: sharedSession.sessionId,
				promptStart: batch.promptStart,
				sync: { path: "reuse" },
			};
		}
	}

	// REBUILD path. Pi 0.86 carries prompt/tool state as leading system messages;
	// those messages do not represent prior Claude conversation history.
	if (priorMessages.every((message) => message.role === "system")) {
		debug(`Case 1: clean start, ${messages.length} total messages, account=${accountProfileId ?? "default"}`);
		debug(`syncResult: path=clean-start cause=clean-start${mark ? ` mark=${mark}` : ""}`);
		return { sessionId: null, promptStart: messages.length - 1, sync: { path: "clean-start", cause: "clean-start", ...(mark ? { mark } : {}) } };
	}
	const replacedSessionId = sharedSession?.sessionId;
	// Preserve a UUID only within the same credential profile: reusing account
	// A's session id under B could resume the wrong transcript, and deleting A's
	// JSONL from B's rebuild would destroy A's still-valid history.
	const previousSessionId = sameAccount ? sharedSession?.sessionId : undefined;
	const previousCursor = sameAccount ? sharedSession?.cursor ?? 0 : 0;
	// preserveId: rebuild in place (deleteSession + createSession with the
	// existing UUID), so prompt-cache UUIDs stay stable for log correlation
	// and for any tools that key off them. Skipped only when there's a
	// concurrent writer we shouldn't race — see forceRotate docs above.
	const preserveId = previousSessionId !== undefined && !sharedSession?.forceRotate;
	// The branch the debug lines below name, plus why REUSE did not apply.
	const cause = replacedSessionId === undefined ? "first-turn-history"
		: !sameAccount ? "account-rotation"
		: !preserveId ? "post-abort-rotation"
		: sharedSession?.needsRebuild ? "needs-rebuild"
		: digestCause ?? "missed-messages";
	if (previousSessionId !== undefined && options.fork !== false) {
		const plan = planNativePrefix(priorMessages, previousSessionId, cwd, claudeDir, customToolNameToSdk, options.customToolNameToPi);
		if ("prefix" in plan) {
			return rebuildFromNativePrefix(plan.prefix, {
				messages, cwd, customToolNameToSdk, modelId, account, options,
				sharedSession: sharedSession!, claudeDir, preserveId, cause, mark, previousCursor, incomingFingerprint,
			});
		}
		debug(`Case 4: no native prefix to fork from ${previousSessionId.slice(0, 8)} (${plan.reason}) — importing all ${priorMessages.length} pi msgs`);
	}
	const writeStarted = stepStart();
	if (preserveId) {
		// Wipe prior jsonl + companion dir (no-op if nothing to wipe).
		deleteSession(previousSessionId!, cwd, claudeDir);
	}
	const session = createSession({
		projectPath: cwd,
		claudeDir,
		...(preserveId ? { sessionId: previousSessionId } : {}),
		...(modelId ? { model: modelId } : {}),
	});
	convertAndImportMessages(session, priorMessages, customToolNameToSdk, cwd);
	session.save();
	verifyWrittenSession(session.jsonlPath, session.sessionId, session.messages.length, cwd, claudeDir);
	stepEnd("rebuildWrite", writeStarted);
	setSharedSession({
		sessionId: session.sessionId,
		cursor: priorMessages.length,
		historyDigest: historyDigest(priorMessages),
		cwd,
		// The rebuilt file's content IS this context, so its anchor is the
		// record's identity — including after a compact/tree-nav that moved it.
		...(incomingFingerprint ? { conversationFingerprint: incomingFingerprint } : {}),
		...(accountProfileId ? { accountProfileId } : {}),
		...(scopeConfigDir ? { claudeConfigDir: scopeConfigDir } : {}),
	});
	if (replacedSessionId === undefined) {
		debug(`Case 2: first turn with ${priorMessages.length} prior messages → session ${session.sessionId.slice(0, 8)}, ${session.messages.length} records`);
	} else if (!sameAccount) {
		debug(`Case 5 account-rotation: ${priorMessages.length} prior messages → new session ${session.sessionId.slice(0, 8)} for account ${accountProfileId ?? "default"} (replaced ${replacedSessionId.slice(0, 8)})`);
	} else if (preserveId) {
		const missedCount = priorMessages.length - previousCursor;
		debug(`Case 4: ${missedCount} missed messages, ${priorMessages.length} total → rewrote session ${session.sessionId.slice(0, 8)} (same id), ${session.messages.length} records`);
	} else {
		debug(`Case 4 post-abort: ${priorMessages.length} total → new session ${session.sessionId.slice(0, 8)} (was ${previousSessionId!.slice(0, 8)}, rotated to avoid race with orphan writer), ${session.messages.length} records`);
	}
	debugSessionPaths(`${session.sessionId.slice(0, 8)}`, cwd, session.jsonlPath, claudeDir);
	const missed = priorMessages.length - previousCursor;
	debug(`syncResult: path=rebuild sessionId=${session.sessionId} priors=${priorMessages.length} ${replacedSessionId === undefined ? "first" : !sameAccount ? "account-rotated" : preserveId ? "preserved" : "rotated-post-abort"} cause=${cause}${mark ? ` mark=${mark}` : ""} missed=${missed}`);
	return {
		sessionId: session.sessionId,
		promptStart: messages.length - 1,
		sync: { path: "rebuild", cause, ...(mark ? { mark } : {}), priors: priorMessages.length, missed },
	};
}

/** Writes a session file that must not exist yet: the fork's id is new, and
 *  an existing file is never appended to or replaced. A write that fails after
 *  creating the file removes it, so no partial session is left behind; a
 *  failed create (EEXIST) leaves the existing file alone. */
function writeNewSessionFile(path: string, data: string): void {
	const fd = openSync(path, "wx");
	try {
		try {
			writeFileSync(fd, data, "utf8");
		} finally {
			closeSync(fd);
		}
	} catch (error) {
		rmSync(path, { force: true });
		throw error;
	}
}

/** What a forked rebuild needs from the syncSharedSession call that planned it. */
interface ForkRebuildContext {
	messages: Context["messages"];
	cwd: string;
	customToolNameToSdk?: Map<string, string>;
	modelId?: string;
	account?: AccountSessionScope;
	options: SyncOptions;
	// The record the rebuild was planned against.
	sharedSession: SessionState;
	claudeDir: string | undefined;
	preserveId: boolean;
	cause: string;
	mark?: string;
	previousCursor: number;
	incomingFingerprint?: string;
}

/**
 * Case 4 from Claude Code's own records: fork the verified prefix of the old
 * transcript into a new session and import only Pi's messages after it.
 *
 * Nothing reaches the disk until the fork has settled and the shared record
 * is still the one this rebuild was planned against. While the SDK runs, the
 * request may be cancelled (nothing is written; the caller ends the request),
 * or the record may change: a session shutdown cleared it, a reload restored
 * another, a late mark replaced it. Then the plan is stale and the sync runs
 * again, synchronously and without a fork, against the record as it is now.
 * A fork that fails falls back the same way: the old transcript is written
 * by another program, and a full import is today's correct result.
 */
async function rebuildFromNativePrefix(prefix: NativePrefix, c: ForkRebuildContext): Promise<SyncResult> {
	const priorMessages = c.messages.slice(0, -1);
	const oldId = prefix.oldSessionId.slice(0, 8);
	const replan = (why: string): SyncResult => {
		debug(`Case 4: ${why} — syncing again without a fork`);
		return syncSharedSession(c.messages, c.cwd, c.customToolNameToSdk, c.modelId, c.account, { ...c.options, fork: false }) as SyncResult;
	};
	let forked: ForkedPrefix | undefined;
	let failure: string | undefined;
	try {
		forked = await forkNativePrefix(prefix, c.cwd);
	} catch (error) {
		failure = parseErrorShape(error);
	}
	if (c.options.cancelled?.()) {
		debug(`Case 4: request cancelled while forking ${oldId}; nothing written, record untouched`);
		debug(`syncResult: path=rebuild cancelled cause=${c.cause}${c.mark ? ` mark=${c.mark}` : ""}`);
		return {
			sessionId: null,
			promptStart: c.messages.length - 1,
			cancelled: true,
			sync: { path: "rebuild", cause: c.cause, ...(c.mark ? { mark: c.mark } : {}), priors: priorMessages.length },
		};
	}
	if (getSharedSession() !== c.sharedSession) return replan(`the shared record changed while forking ${oldId}`);
	if (!forked) return replan(`forking ${oldId} failed (${failure})`);

	const writeStarted = stepStart();
	const tail = priorMessages.slice(prefix.piCount);
	// planNativePrefix advances over whole groups only.
	if (tail[0]?.role === "toolResult") throw new Error(`native fork: the tail after ${prefix.piCount} pi msgs starts with a tool result`);
	const session = createSession({
		projectPath: c.cwd,
		claudeDir: c.claudeDir,
		sessionId: forked.sessionId,
		...(c.modelId ? { model: c.modelId } : {}),
	});
	if (tail.length > 0) convertAndImportMessages(session, tail, c.customToolNameToSdk, c.cwd);
	// The import starts a chain of its own. It must hang off the fork's leaf,
	// which is often an attachment: chained from the last message instead, the
	// attachments after it would fall off the chain and out of the request.
	const tailRecords = session.records.map((record, n) => n === 0 ? { ...record, parentUuid: forked.leafUuid } : record);
	const lines = [...forked.entries, ...tailRecords].map((record) => `${serializeRecord(record as JsonlRecord)}\n`).join("");
	mkdirSync(dirname(session.jsonlPath), { recursive: true });
	writeNewSessionFile(session.jsonlPath, lines);
	const recordCount = forked.entries.length + tailRecords.length;
	const warnings = _verifyWrittenSession(session.jsonlPath, forked.sessionId, recordCount);
	if (warnings.length > 0) {
		rmSync(session.jsonlPath, { force: true });
		stepEnd("rebuildWrite", writeStarted);
		return replan(`the forked session ${forked.sessionId.slice(0, 8)} failed verification (${warnings.length} warning(s))`);
	}
	stepEnd("rebuildWrite", writeStarted);
	// The old file goes only now that its replacement is written and verified.
	// After an abort it stays: the killed child may still be writing to it.
	if (c.preserveId) deleteSession(prefix.oldSessionId, c.cwd, c.claudeDir);
	const accountProfileId = c.account?.accountProfileId;
	const scopeConfigDir = c.account?.claudeConfigDir;
	setSharedSession({
		sessionId: forked.sessionId,
		cursor: priorMessages.length,
		historyDigest: historyDigest(priorMessages),
		cwd: c.cwd,
		...(c.incomingFingerprint ? { conversationFingerprint: c.incomingFingerprint } : {}),
		...(accountProfileId ? { accountProfileId } : {}),
		...(scopeConfigDir ? { claudeConfigDir: scopeConfigDir } : {}),
	});
	const newId = forked.sessionId.slice(0, 8);
	const appended = priorMessages.length - prefix.piCount;
	const missed = priorMessages.length - c.previousCursor;
	const forkedLine = `forked ${oldId} up to ${prefix.cutUuid.slice(0, 8)}: ${prefix.piCount}/${priorMessages.length} pi msgs native, appended ${appended}`;
	const records = `${forked.entries.length} forked + ${tailRecords.length} imported records`;
	if (c.preserveId) {
		debug(`Case 4: ${missed} missed messages, ${forkedLine} → new session ${newId} (deleted ${oldId}), ${records}`);
	} else {
		debug(`Case 4 post-abort: ${forkedLine} → new session ${newId} (old file left to its orphan writer), ${records}`);
	}
	debugSessionPaths(newId, c.cwd, session.jsonlPath, c.claudeDir);
	debug(`syncResult: path=rebuild sessionId=${forked.sessionId} priors=${priorMessages.length} ${c.preserveId ? "preserved" : "rotated-post-abort"} cause=${c.cause}${c.mark ? ` mark=${c.mark}` : ""} missed=${missed} forked=${prefix.piCount} from=${oldId} forkedRecords=${forked.entries.length} appended=${appended}`);
	return {
		sessionId: forked.sessionId,
		promptStart: c.messages.length - 1,
		sync: { path: "rebuild", cause: c.cause, ...(c.mark ? { mark: c.mark } : {}), priors: priorMessages.length, missed, forked: prefix.piCount },
	};
}
