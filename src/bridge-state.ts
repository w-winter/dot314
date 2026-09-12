import { type ExtensionAPI, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { debug, diagDump, diagGuidance } from "./debug.js";
import { type QueryContext } from "./query-state.js";
import { currentRequestLaneId } from "./request-lane.js";
import { summarizeMissingToolNames, type MissingToolResult } from "./tool-pairing-audit.js";

export interface SessionState {
	sessionId: string;
	cursor: number;
	cwd: string;
	// Claude Code session files and resume IDs are credential-profile scoped.
	// Missing values mean the legacy/default Claude profile (process env rules).
	// `claudeConfigDir` is the RESOLVED dir (see claudeDirForProfile) and is
	// in-memory only — persistence strips it and keeps just the opaque profile
	// id, re-deriving the dir through the router on restore.
	accountProfileId?: string;
	claudeConfigDir?: string;
	// Identity anchor of the pi conversation this record belongs to, encoded
	// component-wise as `u:<12hex>` or `u:<12hex>|a:<12hex>` (see
	// conversationFingerprint in session-persistence.ts): a short sha256 of the
	// FIRST user message's normalized text, plus — once the conversation has
	// one — of the FIRST assistant message's normalized text. Pi histories
	// never rewrite those opening messages — compact/tree-nav mutations set
	// needsRebuild instead — so a component mismatch marks a FOREIGN
	// conversation (a subagent-shaped query arriving while the parent is idle,
	//) that must run as a clean one-shot without touching this
	// record. The user component must always match; the assistant component is
	// compared only when BOTH sides carry one, so a record stamped on turn 1
	// (no assistant yet) still matches its own grown conversation and upgrades
	// to the two-component form on the next REUSE. Absent on records restored
	// from pre-3.1.1 markers → identity unknown, pre-fingerprint behavior.
	conversationFingerprint?: string;
	// Force the next syncSharedSession call down the REBUILD path. Set when
	// pi has mutated its messages array out from under us (compact, tree
	// navigation) or after an abort left the JSONL in an indeterminate state.
	// REBUILD wipes and rewrites the file to match pi's current history.
	needsRebuild?: boolean;
	// Set ONLY after an abort. The killed CC subprocess may still be flushing
	// a late "[Request interrupted by user]" record to the session JSONL.
	// Reusing the same sessionId/path would race that orphan write into our
	// fresh file and break CC's parent-uuid chain on the next resume. When
	// this flag is set, REBUILD takes a fresh UUID and skips deleteSession
	// so the orphan writes land on a dead inode. Compact/tree do NOT set
	// this — there's no concurrent CC writer during those events, so
	// in-place rebuild (preserve UUID, deleteSession + createSession) is safe.
	forceRotate?: boolean;
}

// Claude session state is scoped to Pi's provider `sessionId`. Parent and child
// agents can load separate copies of the extension module while sharing the
// primary provider closure, so the lane registry must live on globalThis rather
// than in one module instance. The versioned symbol prevents an incompatible
// future store shape from being mistaken for this one.
interface SharedSessionLaneStoreV1 {
	defaultSession: SessionState | null;
	sessions: Map<string, SessionState | null>;
}

const SHARED_SESSION_LANES_SYMBOL = Symbol.for("kendex.pi.claude-bridge.shared-session-lanes.v1");

function sharedSessionLaneStore(): SharedSessionLaneStoreV1 {
	const host = globalThis as Record<symbol, unknown>;
	let store = host[SHARED_SESSION_LANES_SYMBOL] as SharedSessionLaneStoreV1 | undefined;
	if (!store) {
		store = { defaultSession: null, sessions: new Map() };
		host[SHARED_SESSION_LANES_SYMBOL] = store;
	}
	return store;
}

export let extensionApi: ExtensionAPI | undefined;
export let piUI: ExtensionUIContext | undefined;

export function getSharedSession(): SessionState | null {
	const store = sharedSessionLaneStore();
	const sessionId = currentRequestLaneId();
	return sessionId === undefined
		? store.defaultSession
		: (store.sessions.get(sessionId) ?? null);
}

export function setSharedSession(next: SessionState | null): void {
	const store = sharedSessionLaneStore();
	const sessionId = currentRequestLaneId();
	if (sessionId === undefined) store.defaultSession = next;
	else store.sessions.set(sessionId, next);
}

export function deleteSharedSessionLane(sessionId: string | undefined): void {
	const store = sharedSessionLaneStore();
	if (sessionId === undefined) store.defaultSession = null;
	else store.sessions.delete(sessionId);
}

export function clearSharedSessionLanes(): void {
	const store = sharedSessionLaneStore();
	store.sessions.clear();
	store.defaultSession = null;
}

// The lane each pi session started in, keyed by its SessionManager. An in-memory
// session (`pi --no-session`) forks by mutating the SAME SessionManager's id
// before session_shutdown fires, so the live id there names the fork rather than
// the session being torn down, and the fallback to it would prune a live
// sibling. Keyed per manager (not one slot) so overlapping parent/child
// session_start events keep their own entries, and on globalThis like the
// registry above because session_start and session_shutdown can reach different
// module instances (`/reload` mid-session, a child agent's own copy) and both
// must see the same entry.
const STARTED_LANES_SYMBOL = Symbol.for("kendex.pi.claude-bridge.started-lanes.v1");

function startedLaneStore(): WeakMap<object, string> {
	const host = globalThis as Record<symbol, unknown>;
	let store = host[STARTED_LANES_SYMBOL] as WeakMap<object, string> | undefined;
	if (!store) {
		store = new WeakMap<object, string>();
		host[STARTED_LANES_SYMBOL] = store;
	}
	return store;
}

export function recordStartedLane(sessionManager: object, sessionId: string): void {
	startedLaneStore().set(sessionManager, sessionId);
}

/** The lane recorded at this manager's session_start, removed as it is read —
 *  one shutdown per start. Undefined when no start was recorded (the caller
 *  falls back to the manager's live id). */
export function takeStartedLane(sessionManager: object): string | undefined {
	const store = startedLaneStore();
	const sessionId = store.get(sessionManager);
	store.delete(sessionManager);
	return sessionId;
}

/** Force the next syncSharedSession down the REBUILD path (no-op without a
 *  session). `forceRotate` additionally rotates the session UUID — set it when
 *  a concurrent CC writer may still be flushing (abort, idle kill); see the
 *  field docs on SessionState. */
export function markSessionForRebuild(opts: { forceRotate?: boolean } = {}): void {
	const sharedSession = getSharedSession();
	if (!sharedSession) return;
	setSharedSession({ ...sharedSession, needsRebuild: true, ...(opts.forceRotate ? { forceRotate: true } : {}) });
}

export function setExtensionApi(next: ExtensionAPI | undefined): void {
	extensionApi = next;
}

export function setPiUI(next: ExtensionUIContext | undefined): void {
	piUI = next;
}

export function safeNotify(message: string, level: "info" | "warning" | "error" = "warning"): void {
	try { piUI?.notify(message, level); }
	catch (error) { debug("notify failed:", error); }
}

export function argKeys(args: Record<string, unknown> | undefined): string[] {
	return Object.keys(args ?? {}).sort();
}

export function safeToolCallSummary(calls: Array<{ id: string; toolName: string; arguments?: Record<string, unknown> }>): Array<{ id: string; toolName: string; argKeys: string[] }> {
	return calls.map((call) => ({ id: call.id, toolName: call.toolName, argKeys: argKeys(call.arguments) }));
}

export const INTEGRITY_CUSTOM_TYPE = "claude-bridge-integrity";

/**
 * Persist a bridge integrity event into the pi session transcript.
 *
 * The diag log and a piUI toast both die with the machine or render cycle, so
 * they cannot support analysis from the session alone. A `CustomEntry` persists
 * the record in the same way the
 * connector-call audit does — persisted, never part of built context, never
 * dispatchable by pi's agent loop. Payloads must stay compact metadata (ids,
 * counts, tool names), never tool output.
 *
 * Never throws; returns whether the entry was appended (false outside a pi
 * session — tests, embedded hosts without extensionApi).
 */
export function appendIntegrityEntry(label: string, data: Record<string, unknown>): boolean {
	try {
		if (!extensionApi) return false;
		extensionApi.appendEntry(INTEGRITY_CUSTOM_TYPE, { label, at: new Date().toISOString(), ...data });
		return true;
	} catch (error) {
		debug("appendIntegrityEntry failed:", error);
		return false;
	}
}

function compactToolNameSummary(names: Array<{ name: string; count: number }>, limit = 12): string[] {
	const shown = names.slice(0, limit).map(({ name, count }) => count > 1 ? `${name}×${count}` : name);
	if (names.length > limit) shown.push(`+${names.length - limit} more`);
	return shown;
}

export function reportSyntheticToolResultRepair(missing: MissingToolResult[], context: Record<string, unknown>): void {
	try {
		if (missing.length === 0) return;
		const toolNames = summarizeMissingToolNames(missing);
		const toolNameSummary = compactToolNameSummary(toolNames);
		const sampledToolCallIds = missing.slice(0, 50).map((item) => item.id);
		diagDump("repair_tool_pairing_synthetic_results", {
			count: missing.length,
			toolNames,
			sampledToolCallIds,
			missing: missing.slice(0, 50),
			...context,
		});
		appendIntegrityEntry("repair_tool_pairing_synthetic_results", {
			count: missing.length,
			toolNames,
			sampledToolCallIds: sampledToolCallIds.slice(0, 12),
		});
		safeNotify(
			`Claude bridge: ${missing.length} missing tool result(s) repaired with an explicit error placeholder` +
			`${toolNameSummary.length ? ` for ${toolNameSummary.join(", ")}` : ""}. ` +
			`Real tool output was lost before Claude session import; ${diagGuidance()}.`,
			"error",
		);
	} catch (error) {
		debug("reportSyntheticToolResultRepair failed:", error);
	}
}

export function reportToolResultMismatch(
	queryCtx: QueryContext,
	reason: string,
	cwd: string | undefined,
	opts: { expectedInterruption?: boolean; forceRotate?: boolean } = {},
): boolean {
	try {
		if (queryCtx.reportedToolResultMismatch) return false;
		const progress = queryCtx.toolResultProgress();
		const hasMismatch = progress.expectedCount > 0
			? progress.unresolvedIds.length > 0 || progress.waitingCount > 0 || progress.queuedCount > 0 || progress.unmatchedResultCount > 0
			: progress.waitingCount > 0 || progress.queuedCount > 0 || progress.unmatchedResultCount > 0;
		if (!hasMismatch) return false;
		queryCtx.reportedToolResultMismatch = true;
		// The single choke point every mismatch path funnels through (abort,
		// unmatched result, stream-idle, teardown). A context with no claim on
		// the shared record (reentrant subagent or foreign one-shot,)
		// still gets the full diagnostics below, but its unresolved tool state is
		// its own — marking the PARENT's record needsRebuild/forceRotate here
		// would flush the parent's prompt cache for a query that never touched
		// its session.
		if (!queryCtx.detachedFromSharedSession) markSessionForRebuild(opts);
		// A user abort interrupting in-flight tool calls is expected teardown, not
		// an integrity fault: mark the rebuild but skip the diag dump and toast.
		if (opts.expectedInterruption) {
			debug(
				`tool result delivery interrupted as expected during ${reason}; ` +
				`delivered=${progress.deliveredCount}/${progress.expectedCount} ` +
				`resolved=${progress.resolvedCount}/${progress.expectedCount} ` +
				`waiting=${progress.waitingCount} queued=${progress.queuedCount}`,
			);
			return true;
		}
		const toolNameSummary = compactToolNameSummary(progress.toolNames);
		const sharedSession = getSharedSession();
		diagDump("tool_result_delivery_mismatch", {
			reason,
			cwd,
			progress,
			activeQueryExists: queryCtx.activeQuery !== null,
			detachedFromSharedSession: queryCtx.detachedFromSharedSession,
			sharedSession: sharedSession ? {
				sessionId: sharedSession.sessionId.slice(0, 8),
				cursor: sharedSession.cursor,
				needsRebuild: sharedSession.needsRebuild === true,
				forceRotate: sharedSession.forceRotate === true,
			} : null,
		});
		appendIntegrityEntry("tool_result_delivery_mismatch", {
			reason,
			toolNames: progress.toolNames,
			expectedCount: progress.expectedCount,
			deliveredCount: progress.deliveredCount,
			resolvedCount: progress.resolvedCount,
			waitingIds: progress.waitingIds,
			queuedIds: progress.queuedIds,
			unmatchedResultIds: progress.unmatchedResultIds,
		});
		safeNotify(
			`Claude bridge: tool result delivery interrupted during ${reason}; ` +
			`delivered ${progress.deliveredCount}/${progress.expectedCount}, resolved ${progress.resolvedCount}/${progress.expectedCount}, ` +
			`waiting=${progress.waitingCount}, queued=${progress.queuedCount}, unmatched=${progress.unmatchedResultCount}` +
			`${toolNameSummary.length ? `, tools=${toolNameSummary.join(", ")}` : ""}. ` +
			(queryCtx.detachedFromSharedSession
				? `Detached one-shot query — shared Claude session record left untouched; ${diagGuidance()}.`
				: `Claude session will rebuild before the next turn; ${diagGuidance()}.`),
			"error",
		);
		return true;
	} catch (error) {
		debug("reportToolResultMismatch failed:", error);
		return false;
	}
}

export function __testSetBridgeIntegrityState(state: { ui?: Pick<ExtensionUIContext, "notify"> | null; sharedSession?: SessionState | null }): void {
	if ("ui" in state) piUI = state.ui as ExtensionUIContext | undefined;
	if ("sharedSession" in state) {
		if (currentRequestLaneId() !== undefined) setSharedSession(state.sharedSession ?? null);
		else {
			clearSharedSessionLanes();
			sharedSessionLaneStore().defaultSession = state.sharedSession ?? null;
		}
	}
}

export function __testGetBridgeIntegrityState(): { sharedSession: SessionState | null } {
	return { sharedSession: getSharedSession() };
}

export function __testSharedSessionLaneCount(): number {
	return sharedSessionLaneStore().sessions.size;
}
