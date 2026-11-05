import assert from "node:assert/strict";
import { afterEach, beforeEach, it } from "node:test";
import { cancelScheduledToolUseEnd, finalizeToolUseTurnAtAssistantBoundary, finalizeToolUseTurnFromMcpInvocation, processAssistantMessage, processStreamEvent, withdrawCancelledToolCall } from "../src/assistant-stream.ts";
import { ctx, resetStack } from "../src/query-state.ts";

const model = { api: "claude-bridge", provider: "pi-claude", id: "claude-haiku-4-5", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const original = { file_path: "a.txt", old_string: "\\u200b", new_string: "\\u200c" };
const normalized = { file_path: "a.txt", old_string: "\u200b", new_string: "\u200c" };
const piOriginal = { path: "a.txt", oldText: "\\u200b", newText: "\\u200c" };
const piNormalized = { path: "a.txt", oldText: "\u200b", newText: "\u200c" };
const names = new Map([["mcp__custom-tools__edit_alias", "edit"]]);
let c;
let events;
const event = value => processStreamEvent({ type: "stream_event", event: value }, names, model, c);
const start = (id = "a", json = JSON.stringify(original), index = 0) => {
	event({ type: "content_block_start", index, content_block: { type: "tool_use", id, name: "mcp__custom-tools__edit_alias", input: {} } });
	event({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json } });
};
const complete = (wire, ids = ["a"]) => {
	const message = { type: "assistant", message: { id: "msg", content: ids.map(id => ({ type: "tool_use", id, name: "mcp__custom-tools__edit_alias", input: normalized })) } };
	if (wire !== undefined) message.wire_tool_inputs = wire;
	processAssistantMessage(message, model, names, c);
};
const doneCalls = () => events.findLast(e => e.type === "done").message.content.filter(b => b.type === "toolCall");
const waitFor = id => c.pendingToolCalls.set(id, { toolName: "edit", args: piNormalized, generation: c.callbackGeneration, resolve() {} });

beforeEach(() => {
	resetStack();
	c = ctx();
	c.resetTurnState(model);
	events = [];
	c.currentPiStream = { push: e => events.push(e), end() {} };
});
afterEach(() => { cancelScheduledToolUseEnd(c); resetStack(); });

for (const beforeStop of [true, false]) {
	it(`preserves complete streamed JSON when the normalized yield arrives ${beforeStop ? "before" : "after"} block stop`, () => {
		start();
		if (!beforeStop) event({ type: "content_block_stop", index: 0 });
		complete();
		complete();
		if (beforeStop) event({ type: "content_block_stop", index: 0 });
		event({ type: "message_stop" });
		assert.deepEqual(doneCalls().map(b => b.arguments), [piOriginal]);
		assert.equal(c.claimToolCall("edit", piNormalized).match, "tool-args");
		assert.deepEqual(c.queryToolArgs.get("a"), piNormalized);
	});
}

it("uses ID-keyed wire inputs without streaming, and a late re-yield cannot replace the delivered arguments", () => {
	complete({ a: original });
	complete();
	assert.deepEqual(doneCalls().map(b => b.arguments), [piOriginal]);
	assert.equal(c.claimToolUseId("a", "edit", piNormalized).outcome, "claimed");
});

it("uses wire inputs for missing streamed siblings and preserves them across metadata-free re-yields", () => {
	c.turnSawStreamEvent = true;
	complete({ a: original, b: { ...original, file_path: "b.txt" } }, ["a", "b"]);
	complete(undefined, ["a", "b"]);
	finalizeToolUseTurnAtAssistantBoundary(c);
	assert.deepEqual(doneCalls().map(b => b.arguments), [piOriginal, { ...piOriginal, path: "b.txt" }]);
	assert.deepEqual([...c.queryToolArgs.values()], [piNormalized, piNormalized]);
});

for (const boundary of [false, true]) {
	it(`preserves complete original JSON for every sibling in the ${boundary ? "assistant" : "MCP"} grace finalizer`, () => {
		start("a");
		start("b", JSON.stringify({ ...original, file_path: "b.txt" }), 1);
		for (const id of ["a", "b"]) {
			assert.equal(c.claimToolUseId(id, "edit", piNormalized).outcome, "claimed");
			waitFor(id);
		}
		if (boundary) finalizeToolUseTurnAtAssistantBoundary(c);
		else finalizeToolUseTurnFromMcpInvocation(c, "a", "edit", piNormalized);
		assert.deepEqual(doneCalls().map(b => b.arguments), [piOriginal, { ...piOriginal, path: "b.txt" }]);
		assert.deepEqual([...c.queryToolArgs.values()], [piNormalized, piNormalized]);
	});
}

it("keeps handler-first synthesis when no original input exists", () => {
	c.claimToolUseId("a", "edit", piNormalized);
	waitFor("a");
	finalizeToolUseTurnFromMcpInvocation(c, "a", "edit", piNormalized);
	assert.deepEqual(doneCalls().map(b => b.arguments), [piNormalized]);
});

it("settles genuinely truncated JSON from its tagged handler, but never forwards a cancelled sibling", () => {
	start("a", '{"file_path":');
	start("b", '{"file_path":', 1);
	for (const id of ["a", "b"]) { c.claimToolUseId(id, "edit", piNormalized); waitFor(id); }
	assert.equal(withdrawCancelledToolCall(c, "b"), true);
	finalizeToolUseTurnFromMcpInvocation(c, "a", "edit", piNormalized);
	assert.deepEqual(doneCalls().map(b => [b.id, b.arguments]), [["a", piNormalized]]);
});

for (const parked of [false, true]) {
	it(`refuses to guess an untagged callback when distinct originals collapse to identical normalized arguments${parked ? " across a message boundary" : ""}`, () => {
		complete({ a: original, b: normalized }, ["a", "b"]);
		if (parked) {
			for (const id of ["a", "b"]) c.reapedResults.set(id, { content: [{ type: "text", text: id }] });
			c.resetToolTracking();
		}
		const claim = c.claimToolCall("edit", piNormalized);
		assert.equal(claim.toolCallId, undefined);
		assert.equal(claim.ambiguous, true);
		assert.equal(c.claimToolUseId("b", "edit", piNormalized).outcome, "claimed");
		assert.equal(c.claimToolCall("edit", piNormalized).toolCallId, "a");
	});
}
