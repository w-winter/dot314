// Audit trail for connector calls the `claude` child executes itself.
//
// A claude.ai connector tool runs INSIDE the child, on the child's own MCP
// servers, and is deliberately never mirrored into the Pi stream (see
// isChildExecutedTool). Mirroring would write `Tool <name> not found` into the
// transcript for a successful call. Not mirroring leaves the Pi session with no
// record that the call happened, so the audit entry records it without dispatch.
//
// A pi `CustomEntry` closes that gap without reintroducing the bug: it is
// persisted in the session file, is NOT a content block, and is documented as
// "ignored by buildSessionContext", so Pi's agent loop can never dispatch it and
// `convertPiMessages` (which reads messages, not entries) can never project it
// back into the child's session. `CustomMessageEntry` is the sibling type that
// DOES enter context — using it here would recreate the whole problem.
//
// The payload is never recorded. A connector result is live account data (mail,
// messages, documents); the audit answers whether a call happened and what came
// back, not what it said.

import { extensionApi } from "./bridge-state.js";
import { debug } from "./debug.js";
import type { QueryContext, ToolCallDrainCause } from "./query-state.js";

export const CONNECTOR_CALL_CUSTOM_TYPE = "claude-bridge-connector-call";

/**
 * What the bridge observed of a connector call.
 *
 * `unobserved` is the load-bearing one: the call was issued and the query ended
 * before its result came back. Recording nothing for it would leave an answer in
 * the transcript with no trace of the call behind it — indistinguishable from a
 * turn where no call was ever made. Same reasoning as `interruptedToolCallResult`
 * for Pi-side tools: a call that did not complete says so.
 */
export type ConnectorCallOutcome = "ok" | "error" | "unobserved";

export interface ConnectorCallAuditData {
	/** Raw connector tool name as the child invoked it (`mcp__claude_ai_<Server>__<tool>`). */
	name: string;
	/** The child's own `tool_use` id — the join key to its transcript. */
	toolUseId: string;
	outcome: ConnectorCallOutcome;
	/** UTF-8 byte size of the observed result payload. Absent when the result was
	 *  never observed, or could not be measured — never a confident 0 for
	 *  something that was not sized. */
	byteSize?: number;
	/** Claude Code session that executed the call. Absent when the SDK never
	 *  reported one for this query. */
	childSessionId?: string;
	/** Why an `unobserved` call ended. Absent for observed ones. */
	reason?: ToolCallDrainCause;
}

/**
 * Approximate UTF-8 byte size of a child tool result's payload.
 *
 * A string payload is measured directly; any other shape is measured as its JSON
 * serialization, so a structured or image result reports the size it really
 * carried. (The debug line this replaces reported `content.length` for an array
 * payload — a BLOCK count wearing a byte size's name.)
 *
 * Returns undefined when there is nothing to measure or the payload cannot be
 * serialized, so the caller omits the field rather than recording a 0 it did not
 * measure. The payload itself is never returned or logged.
 */
export function connectorResultByteSize(content: unknown): number | undefined {
	if (content === undefined || content === null) return undefined;
	if (typeof content === "string") return Buffer.byteLength(content, "utf8");
	try {
		const json = JSON.stringify(content);
		return typeof json === "string" ? Buffer.byteLength(json, "utf8") : undefined;
	} catch {
		return undefined;
	}
}

/**
 * An ADDITIONAL destination for connector-call records, for a host that embeds
 * the bridge with no pi session to append to.
 *
 * Never throws is the contract on OUR side; a sink that throws anyway is caught
 * and dropped, because an audit record must not be able to fail a turn.
 */
export type ConnectorCallAuditSink = (data: ConnectorCallAuditData) => void;

let auditSink: ConnectorCallAuditSink | undefined;

/**
 * Install (or clear, with `undefined`) a host sink for connector-call records.
 *
 * **The sink ADDS a destination, it never replaces `appendEntry`.** A host that
 * drives real `AgentSession`s gets transcript-local entries automatically. A
 * replacing sink would remove those entries and make the session record
 * incomplete. A host with both a session and a sink has
 * asked for both and gets both.
 *
 * It exists because the OTHER embedding shape gets nothing at all: drovr loads
 * the bundle through a throwaway resource loader over
 * `createAgentSessionServices` with no session, so `extensionApi` is undefined
 * and every record it appended went nowhere (measured live). The
 * sink is the seam such a host can reach without one.
 *
 * A callback rather than another `Symbol.for` global on purpose: the bundle
 * already has one (`claude-bridge:activeStreamSimple`) and hosts document that
 * coupling as a re-vendor hazard, so a second would be the wrong direction.
 *
 * Process-global, matching `setExtensionApi`: one bundle instance serves one
 * host. A host that runs several conversations in ONE process must therefore
 * route by `childSessionId` itself, or embed per conversation as drovr does.
 */
export function setConnectorCallAuditSink(sink: ConnectorCallAuditSink | undefined): void {
	auditSink = sink;
}

/**
 * Append one audit entry to every destination the host installed. Returns
 * whether it reached AT LEAST ONE of them, so a caller can log the truth rather
 * than assume — both are absent whenever the bridge runs outside a pi session
 * and outside a sink-installing host (tests, the connector-inventory entry
 * point).
 *
 * The two destinations are independent: one throwing must not cost the other
 * its record. Never throws — an audit record must not be able to fail a turn.
 */
export function appendConnectorCallAudit(data: ConnectorCallAuditData): boolean {
	let delivered = false;
	if (extensionApi) {
		try {
			extensionApi.appendEntry(CONNECTOR_CALL_CUSTOM_TYPE, data);
			delivered = true;
		} catch (error) {
			debug("appendConnectorCallAudit failed:", error);
		}
	}
	if (auditSink) {
		try {
			// A COPY, because the sink is host code and `appendEntry` above holds a
			// reference to the same object: a sink that mutated the record would be
			// editing what the session already recorded.
			auditSink({ ...data });
			delivered = true;
		} catch (error) {
			debug("connector call audit sink failed:", error);
		}
	}
	return delivered;
}

/**
 * Record the observed result of a child-executed connector call, once.
 *
 * Keyed on the tool_use id rather than on the call site: the SDK can re-yield a
 * `user` message, and an audit trail that counts one call twice is worse than
 * one that counts it not at all. Returns whether an entry was appended.
 */
export function recordConnectorCallResult(
	queryCtx: QueryContext,
	toolUseId: string,
	name: string,
	isError: boolean,
	byteSize: number | undefined,
): boolean {
	const pending = queryCtx.connectorCallAudit.get(toolUseId);
	if (pending?.recorded) return false;
	const childSessionId = pending?.childSessionId ?? queryCtx.childSessionId;
	queryCtx.connectorCallAudit.set(toolUseId, { ...pending, name, childSessionId, recorded: true });
	return appendConnectorCallAudit({
		name,
		toolUseId,
		outcome: isError ? "error" : "ok",
		...(byteSize !== undefined ? { byteSize } : {}),
		...(childSessionId ? { childSessionId } : {}),
	});
}

/**
 * Record every connector call this query issued whose result never came back,
 * naming the cause. Runs at query teardown, beside the Pi-side tool drain, and is
 * idempotent — a call already recorded is skipped, and one recorded here is
 * marked so a late arrival cannot record it again.
 *
 * Returns how many entries were appended.
 */
export function flushConnectorCallAudit(queryCtx: QueryContext, reason: ToolCallDrainCause): number {
	let appended = 0;
	for (const [toolUseId, state] of queryCtx.connectorCallAudit) {
		if (state.recorded) continue;
		queryCtx.connectorCallAudit.set(toolUseId, { ...state, recorded: true });
		const childSessionId = state.childSessionId ?? queryCtx.childSessionId;
		if (appendConnectorCallAudit({
			name: state.name,
			toolUseId,
			outcome: "unobserved",
			reason,
			...(childSessionId ? { childSessionId } : {}),
		})) appended++;
	}
	return appended;
}
