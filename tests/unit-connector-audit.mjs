// A connector call runs inside the `claude` child and is never mirrored into the
// Pi stream, which left the Pi session with no record
// that it happened. These tests pin the record that closes that gap: a session
// CustomEntry per call, never a content block, never the payload.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { noteChildExecutedToolResults } from "../src/index.ts";
import {
	CONNECTOR_CALL_CUSTOM_TYPE,
	connectorResultByteSize,
	flushConnectorCallAudit,
	setConnectorCallAuditSink,
} from "../src/connector-audit.ts";
import { setExtensionApi } from "../src/bridge-state.ts";
import { ctx, resetStack } from "../src/query-state.ts";

const model = {
	api: "claude-bridge",
	provider: "pi-claude",
	id: "claude-haiku-4-5",
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const CONNECTOR_TOOL = "mcp__claude_ai_Slack__slack_read_user_profile";

/** Records what the bridge appended, and nothing else: `appendEntry` is the only
 *  surface a CustomEntry may go through — `sendMessage`/`appendCustomMessageEntry`
 *  would put it in LLM context, which is the bug this feature must not recreate. */
function installFakeExtensionApi() {
	const entries = [];
	setExtensionApi({
		appendEntry(customType, data) { entries.push({ customType, data }); },
	});
	return entries;
}

/** Records what reached the host sink — the destination a session-less embedding
 *  (drovr's per-chat sidecar) has instead of `appendEntry`. */
function installSink() {
	const records = [];
	setConnectorCallAuditSink((data) => records.push(data));
	return records;
}

function userMessageWithResult(toolUseId, content, isError) {
	return {
		type: "user",
		message: {
			content: [{
				type: "tool_result",
				tool_use_id: toolUseId,
				content,
				...(isError !== undefined ? { is_error: isError } : {}),
			}],
		},
	};
}

describe("connector result byte size", () => {
	it("measures a string payload in UTF-8 bytes", () => {
		assert.equal(connectorResultByteSize("abc"), 3);
		// Multibyte: a character count would say 2 here.
		assert.equal(connectorResultByteSize("é☃"), 5);
	});

	it("measures a block array as its payload, not as a block count", () => {
		// The debug line this replaced reported `content.length` for an array — a
		// block count wearing a byte size's name. A one-block array carrying 300
		// bytes must not report 1.
		const payload = "x".repeat(300);
		const size = connectorResultByteSize([{ type: "text", text: payload }]);
		assert.ok(size > 300, `expected the payload to be measured, got ${size}`);
	});

	it("reports nothing it did not measure", () => {
		assert.equal(connectorResultByteSize(undefined), undefined);
		assert.equal(connectorResultByteSize(null), undefined);
		const circular = {};
		circular.self = circular;
		assert.equal(connectorResultByteSize(circular), undefined, "unserializable must not read as 0 bytes");
	});
});

describe("connector call audit entries", () => {
	beforeEach(() => resetStack());
	afterEach(() => {
		setExtensionApi(undefined);
		// Both host handles are module-globals; a leaked sink would silently
		// double-count every later test.
		setConnectorCallAuditSink(undefined);
	});

	it("records one entry for an observed result, with no payload in it", () => {
		const entries = installFakeExtensionApi();
		const c = ctx();
		c.resetTurnState(model);
		c.childSessionId = "child-sess-1";
		c.noteChildExecutedToolCall("toolu_conn", CONNECTOR_TOOL, 0);

		noteChildExecutedToolResults(userMessageWithResult("toolu_conn", "User ID: US9TAA048"));

		assert.equal(entries.length, 1);
		assert.equal(entries[0].customType, CONNECTOR_CALL_CUSTOM_TYPE);
		assert.deepEqual(entries[0].data, {
			name: CONNECTOR_TOOL,
			toolUseId: "toolu_conn",
			outcome: "ok",
			byteSize: 18,
			childSessionId: "child-sess-1",
		});
		assert.equal(
			JSON.stringify(entries[0].data).includes("US9TAA048"), false,
			"a connector result is live account data and must never reach the record",
		);
	});

	it("records a child-side failure as an error, not as a success", () => {
		const entries = installFakeExtensionApi();
		const c = ctx();
		c.resetTurnState(model);
		c.noteChildExecutedToolCall("toolu_conn", CONNECTOR_TOOL, 0);

		noteChildExecutedToolResults(userMessageWithResult("toolu_conn", "not_authed", true));

		assert.equal(entries.length, 1);
		assert.equal(entries[0].data.outcome, "error");
	});

	it("records one entry per call even if the SDK re-yields the result", () => {
		const entries = installFakeExtensionApi();
		const c = ctx();
		c.resetTurnState(model);
		c.noteChildExecutedToolCall("toolu_conn", CONNECTOR_TOOL, 0);

		noteChildExecutedToolResults(userMessageWithResult("toolu_conn", "payload"));
		noteChildExecutedToolResults(userMessageWithResult("toolu_conn", "payload"));

		assert.equal(entries.length, 1, "an audit trail that counts one call twice is worse than none");
	});

	it("omits a session id it was never given", () => {
		const entries = installFakeExtensionApi();
		const c = ctx();
		c.resetTurnState(model);
		c.noteChildExecutedToolCall("toolu_conn", CONNECTOR_TOOL, 0);

		noteChildExecutedToolResults(userMessageWithResult("toolu_conn", "payload"));

		assert.equal("childSessionId" in entries[0].data, false);
	});

	it("audits a call against the child session that made it", () => {
		// A continuation query reuses this context with a different child session id. A
		// call issued before that must not be attributed to the later session.
		const entries = installFakeExtensionApi();
		const c = ctx();
		c.resetTurnState(model);
		c.childSessionId = "child-sess-1";
		c.noteChildExecutedToolCall("toolu_conn", CONNECTOR_TOOL, 0);
		c.childSessionId = "child-sess-2";

		noteChildExecutedToolResults(userMessageWithResult("toolu_conn", "payload"));

		assert.equal(entries[0].data.childSessionId, "child-sess-1");
	});

	it("does not throw when there is no session to record into", () => {
		setExtensionApi(undefined);
		const c = ctx();
		c.resetTurnState(model);
		c.noteChildExecutedToolCall("toolu_conn", CONNECTOR_TOOL, 0);

		noteChildExecutedToolResults(userMessageWithResult("toolu_conn", "payload"));
	});

	it("survives an appendEntry that throws", () => {
		setExtensionApi({ appendEntry() { throw new Error("session write failed"); } });
		const c = ctx();
		c.resetTurnState(model);
		c.noteChildExecutedToolCall("toolu_conn", CONNECTOR_TOOL, 0);

		noteChildExecutedToolResults(userMessageWithResult("toolu_conn", "payload"));
	});
});

describe("connector calls whose result never came back", () => {
	beforeEach(() => resetStack());
	afterEach(() => {
		setExtensionApi(undefined);
		// Both host handles are module-globals; a leaked sink would silently
		// double-count every later test.
		setConnectorCallAuditSink(undefined);
	});

	it("records an issued call the query never saw finish, naming the cause", () => {
		const entries = installFakeExtensionApi();
		const c = ctx();
		c.resetTurnState(model);
		c.childSessionId = "child-sess-1";
		c.noteChildExecutedToolCall("toolu_conn", CONNECTOR_TOOL, 0);

		const appended = flushConnectorCallAudit(c, "abort");

		assert.equal(appended, 1);
		assert.deepEqual(entries[0].data, {
			name: CONNECTOR_TOOL,
			toolUseId: "toolu_conn",
			outcome: "unobserved",
			reason: "abort",
			childSessionId: "child-sess-1",
		});
	});

	it("leaves an already-observed call alone", () => {
		const entries = installFakeExtensionApi();
		const c = ctx();
		c.resetTurnState(model);
		c.noteChildExecutedToolCall("toolu_conn", CONNECTOR_TOOL, 0);
		noteChildExecutedToolResults(userMessageWithResult("toolu_conn", "payload"));

		assert.equal(flushConnectorCallAudit(c, "query-end"), 0);
		assert.equal(entries.length, 1);
		assert.equal(entries[0].data.outcome, "ok");
	});

	it("records an abandoned call once, however often teardown runs", () => {
		const entries = installFakeExtensionApi();
		const c = ctx();
		c.resetTurnState(model);
		c.noteChildExecutedToolCall("toolu_conn", CONNECTOR_TOOL, 0);

		flushConnectorCallAudit(c, "query-end");
		flushConnectorCallAudit(c, "query-end");

		assert.equal(entries.length, 1);
	});

	it("cannot be un-recorded by a result arriving after teardown", () => {
		const entries = installFakeExtensionApi();
		const c = ctx();
		c.resetTurnState(model);
		c.noteChildExecutedToolCall("toolu_conn", CONNECTOR_TOOL, 0);

		flushConnectorCallAudit(c, "stream-idle-timeout");
		noteChildExecutedToolResults(userMessageWithResult("toolu_conn", "payload"));

		assert.equal(entries.length, 1, "one call is one record, whichever path got there first");
		assert.equal(entries[0].data.outcome, "unobserved");
	});

	it("records an unobserved call into a sink-only host", () => {
		// The teardown path has to reach a session-less host too — that is the one
		// whose only other evidence of the call is the model's answer.
		const sink = installSink();
		const c = ctx();
		c.resetTurnState(model);
		c.noteChildExecutedToolCall("toolu_conn", CONNECTOR_TOOL, 0);

		assert.equal(flushConnectorCallAudit(c, "abort"), 1, "a sink-only delivery still counts");
		assert.equal(sink.length, 1);
		assert.equal(sink[0].outcome, "unobserved");
		assert.equal(sink[0].reason, "abort");
	});

	it("still knows about a call whose child message boundary has passed", () => {
		// resetToolTracking runs at every child message_start. The audit map is
		// query-scoped precisely so a call abandoned in a prior child message is
		// still recordable at teardown.
		const entries = installFakeExtensionApi();
		const c = ctx();
		c.resetTurnState(model);
		c.noteChildExecutedToolCall("toolu_conn", CONNECTOR_TOOL, 0);
		c.resetToolTracking();

		assert.equal(flushConnectorCallAudit(c, "query-end"), 1);
		assert.equal(entries[0].data.name, CONNECTOR_TOOL);
	});
});

// The host sink exists for an embedding that has NO pi session — drovr loads the
// bundle through a throwaway resource loader with none, so every entry it
// appended went nowhere. What these pin is that adding that seam takes nothing
// away from a session-backed host: the sink is an ADDITIONAL destination.
describe("the host audit sink", () => {
	beforeEach(() => resetStack());
	afterEach(() => {
		setExtensionApi(undefined);
		setConnectorCallAuditSink(undefined);
	});

	function auditOneCall() {
		const c = ctx();
		c.resetTurnState(model);
		c.childSessionId = "child-sess-1";
		c.noteChildExecutedToolCall("toolu_conn", CONNECTOR_TOOL, 0);
		noteChildExecutedToolResults(userMessageWithResult("toolu_conn", "User ID: US9TAA048"));
	}

	it("delivers to a session-less host that installed one", () => {
		const sink = installSink();

		auditOneCall();

		assert.equal(sink.length, 1);
		assert.deepEqual(sink[0], {
			name: CONNECTOR_TOOL,
			toolUseId: "toolu_conn",
			outcome: "ok",
			byteSize: 18,
			childSessionId: "child-sess-1",
		});
		assert.equal(
			JSON.stringify(sink[0]).includes("US9TAA048"), false,
			"the sink is a host boundary — the payload must not cross it either",
		);
	});

	it("ADDS a destination rather than replacing appendEntry", () => {
		// The whole contract. A host that is session-backed AND installs a sink has
		// asked for both; a replacing sink would silently take away the
		// transcript-local record produced by a session-backed host.
		const entries = installFakeExtensionApi();
		const sink = installSink();

		auditOneCall();

		assert.equal(entries.length, 1, "the session entry must survive an installed sink");
		assert.equal(sink.length, 1);
		assert.deepEqual(sink[0], entries[0].data);
	});

	it("keeps the session entry when the sink throws", () => {
		const entries = installFakeExtensionApi();
		setConnectorCallAuditSink(() => { throw new Error("host is gone"); });

		auditOneCall();

		assert.equal(entries.length, 1, "a broken host must not cost the session its record");
	});

	it("keeps the sink record when appendEntry throws", () => {
		setExtensionApi({ appendEntry() { throw new Error("session write failed"); } });
		const sink = installSink();

		auditOneCall();

		assert.equal(sink.length, 1, "the two destinations are independent in both directions");
	});

	it("hands the sink a copy it cannot corrupt the session entry with", () => {
		const entries = installFakeExtensionApi();
		setConnectorCallAuditSink((data) => { data.name = "rewritten"; });

		auditOneCall();

		assert.equal(entries[0].data.name, CONNECTOR_TOOL);
	});

	it("stops delivering once cleared", () => {
		const sink = installSink();
		setConnectorCallAuditSink(undefined);

		auditOneCall();

		assert.equal(sink.length, 0);
	});

	it("records one call once, however many destinations are installed", () => {
		// The dedupe is keyed on the tool_use id, not the destination count: an SDK
		// re-yield must not write a second record to either place.
		const entries = installFakeExtensionApi();
		const sink = installSink();
		const c = ctx();
		c.resetTurnState(model);
		c.noteChildExecutedToolCall("toolu_conn", CONNECTOR_TOOL, 0);

		noteChildExecutedToolResults(userMessageWithResult("toolu_conn", "payload"));
		noteChildExecutedToolResults(userMessageWithResult("toolu_conn", "payload"));

		assert.equal(entries.length, 1);
		assert.equal(sink.length, 1);
	});
});
