import assert from "node:assert/strict";
import { afterEach, beforeEach, it } from "node:test";
import { __testGetBridgeIntegrityState, __testSetBridgeIntegrityState, streamClaudeAgentSdk } from "../src/index.ts";
import { ctx, resetStack } from "../src/query-state.ts";

const model = { id: "claude-haiku-4-5", api: "claude-bridge", provider: "pi-claude", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const user = (content) => ({ role: "user", content, timestamp: 0 });
const result = (toolCallId) => ({ role: "toolResult", toolCallId, content: [{ type: "text", text: toolCallId }], timestamp: 0 });
const history = [user("original"), { role: "assistant", content: [], timestamp: 0 }];
let sent;
let delivered;
let closed;

beforeEach(() => {
	resetStack();
	sent = [];
	delivered = [];
	closed = false;
	__testSetBridgeIntegrityState({ sharedSession: { sessionId: "test-session", cursor: 2, cwd: process.cwd() }, ui: { notify() {} } });
	ctx().latestCursor = 2;
	ctx().activeQuery = {
		async streamInput(input) {
			for await (const message of input) {
				assert.deepEqual(delivered, [], "steering must precede the tool results");
				sent.push(message);
			}
		},
		close() { closed = true; },
		async interrupt() {},
	};
	for (const id of ["t1", "t2"]) {
		ctx().recordToolCall(id, "echo", {});
		ctx().forwardedToolCallIds.add(id);
		ctx().pendingToolCalls.set(id, {
			toolName: "echo", args: {}, generation: 0,
			resolve(value) { ctx().markToolResultResolved(id); delivered.push(value); },
		});
	}
});

afterEach(() => {
	__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
	resetStack();
});

it("sends steering before releasing tool results, without waiting for query completion", async () => {
	const messages = [...history, result("t1"), result("t2"), user("change direction"), user("also this")];
	streamClaudeAgentSdk(model, { messages });
	await new Promise(setImmediate);
	assert.equal(sent.length, 1);
	assert.equal(sent[0].message.role, "user");
	assert.equal(sent[0].message.content, "change direction\n\nalso this");
	assert.equal(sent[0].priority, "now");
	assert.deepEqual(delivered.map((value) => value.toolCallId), ["t1", "t2"]);
	assert.equal(closed, false);
	assert.deepEqual(ctx().deferredUserMessages, []);
	streamClaudeAgentSdk(model, { messages });
	await new Promise(setImmediate);
	assert.equal(sent.length, 1, "a repeated callback must not resend steering");
});

it("sends an image steer between parallel tool results", async () => {
	streamClaudeAgentSdk(model, { messages: [...history, result("t1"), user([{ type: "image", data: "aGk=", mimeType: "image/png" }]), result("t2")] });
	await new Promise(setImmediate);
	assert.equal(sent.length, 1);
	assert.deepEqual(sent[0].message.content, [{ type: "image", source: { type: "base64", data: "aGk=", media_type: "image/png" } }]);
	assert.equal(delivered.length, 2);
});

it("reports a failed steering write and requires a history rebuild", async () => {
	ctx().activeQuery.streamInput = async (input) => {
		for await (const _message of input) throw new Error("transport write failed");
	};
	const stream = streamClaudeAgentSdk(model, { messages: [...history, result("t1"), result("t2"), user("do not continue")] });
	await new Promise(setImmediate);
	assert.equal(closed, true);
	const events = [];
	for await (const event of stream) events.push(event);
	assert.equal(events.at(-1).type, "error");
	assert.match(events.at(-1).error.errorMessage, /steering/i);
	assert.deepEqual(delivered, []);
	assert.equal(__testGetBridgeIntegrityState().sharedSession.needsRebuild, true);
});

it("does not release tool results if the request is aborted during a steering write", async () => {
	const abort = new AbortController();
	ctx().activeQuery.streamInput = async (input) => {
		for await (const message of input) {
			sent.push(message);
			abort.abort();
		}
	};
	streamClaudeAgentSdk(model, { messages: [...history, result("t1"), result("t2"), user("steer")] }, { signal: abort.signal });
	await new Promise(setImmediate);
	assert.equal(sent.length, 1);
	assert.deepEqual(delivered, []);
});
