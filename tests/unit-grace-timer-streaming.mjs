// The tool-use grace timer is the backstop for a stream whose terminal events
// never arrive. The SDK yields a completed assistant copy per content block,
// so the FIRST finished call of a parallel batch arms it while the model may
// still be writing a sibling's arguments. Counted from the arming, it cut such
// a sibling off mid-stream: the call was pruned as truncated (a
// partial_tool_calls_pruned integrity entry on a healthy turn) and one Claude
// message was split across two Pi turns. Seen live at 2026-09-27T22:01:40Z and
// 22:01:47Z (toolu_017iD8…, toolu_01DtYc…). Claude Code 2.1.283 sends no
// stream events while a call's arguments are written (a real Haiku call was
// silent ~5.5 s), so the sibling's silence can be long.
import "./lib/debug-env.mjs";

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { processAssistantMessage, processStreamEvent } from "../src/index.ts";
import { FINALIZE_MAX_REARMS } from "../src/assistant-stream.ts";
import { setExtensionApi } from "../src/bridge-state.ts";
import { ctx, resetStack } from "../src/query-state.ts";

const model = {
	api: "claude-bridge",
	provider: "pi-claude",
	id: "claude-haiku-4-5",
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const toolMap = new Map([["mcp__custom-tools__bash", "bash"]]);

let integrity;
beforeEach(() => {
	resetStack();
	integrity = [];
	setExtensionApi({ events: { emit: () => {} }, appendEntry: (_type, data) => integrity.push(data) });
});
afterEach(() => {
	setExtensionApi(undefined);
	resetStack();
});

function installFakeStream() {
	const events = [];
	ctx().currentPiStream = {
		push(event) { events.push(event); },
		end() { events.push({ type: "stream_end" }); },
	};
	return events;
}

const streamEvent = (event) => processStreamEvent({ type: "stream_event", event }, toolMap, model);
const toolStart = (index, id) => streamEvent({ type: "content_block_start", index, content_block: { type: "tool_use", id, name: "mcp__custom-tools__bash", input: {} } });
const jsonDelta = (index, partial_json) => streamEvent({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json } });
const assistantCopy = (id, command) => processAssistantMessage({
	type: "assistant",
	message: { id: "msg_1", content: [{ type: "tool_use", id, name: "mcp__custom-tools__bash", input: { command } }] },
}, model, toolMap);

/** Call A finishes (its completed copy arms the grace timer); call B has
 *  started and received part of its arguments. */
function firstCallDoneSecondStreaming() {
	const c = ctx();
	c.resetTurnState(model);
	const events = installFakeStream();
	streamEvent({ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 10, output_tokens: 1 } } });
	toolStart(0, "toolu_a");
	jsonDelta(0, '{"command":"ls"}');
	assistantCopy("toolu_a", "ls");
	streamEvent({ type: "content_block_stop", index: 0 });
	assert.ok(c.scheduledToolUseEnd, "the first finished call arms the grace timer");
	toolStart(1, "toolu_b");
	jsonDelta(1, '{"command":"echo ');
	return { c, events };
}

describe("tool-use grace timer while a sibling call is still streaming", () => {
	it("a sibling whose arguments finish slowly ships complete, with no prune", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const { c, events } = firstCallDoneSecondStreaming();
		// Seven seconds of steady deltas, far past one grace period after arming.
		for (let i = 0; i < 7; i++) {
			t.mock.timers.tick(1000);
			jsonDelta(1, "x");
		}
		// Claude Code sends no stream events while the model writes a call's
		// arguments and flushes them when the block completes: a long silence.
		for (let i = 0; i < 20; i++) t.mock.timers.tick(1000);
		assert.ok(c.currentPiStream, "the turn must stay open while the sibling is still being written");
		jsonDelta(1, 'yz"}');
		assistantCopy("toolu_b", "echo xxxxxxxyz");
		streamEvent({ type: "content_block_stop", index: 1 });
		streamEvent({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 90 } });
		streamEvent({ type: "message_stop" });

		const done = events.filter((event) => event.type === "done");
		assert.equal(done.length, 1, "one Claude message, one Pi turn");
		const calls = done[0].message.content.filter((block) => block.type === "toolCall");
		assert.deepEqual(calls.map((call) => call.id), ["toolu_a", "toolu_b"]);
		assert.equal(calls[1].arguments.command, "echo xxxxxxxyz");
		assert.ok(calls.every((call) => !("partialJson" in call)));
		assert.equal(done[0].message.usage.output, 90, "message_delta usage reaches the delivered message");
		assert.deepEqual(integrity, [], "a healthy turn records no integrity entry");
	});

	it("a sibling whose stream goes silent is still pruned as truncated", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const { c, events } = firstCallDoneSecondStreaming();
		for (let i = 0; i < FINALIZE_MAX_REARMS; i++) t.mock.timers.tick(1500);
		assert.ok(c.currentPiStream, "a partial call gets the full silence budget");
		t.mock.timers.tick(1500);

		assert.equal(c.currentPiStream, null, "silence past the re-arm budget force-ends the turn");
		const done = events.filter((event) => event.type === "done");
		assert.equal(done.length, 1);
		assert.deepEqual(done[0].message.content.map((block) => block.id), ["toolu_a"], "the truncated call never ships");
		assert.equal(integrity.length, 1);
		assert.equal(integrity[0].label, "partial_tool_calls_pruned");
		assert.deepEqual(integrity[0].calls, [{ id: "toolu_b", name: "bash" }]);
	});

	it("a long write with regular gaps is never pruned: the budget counts consecutive silence", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const { c, events } = firstCallDoneSecondStreaming();
		// 59 deltas 2 s apart: ~118 s of writing, no gap longer than 2 s.
		for (let i = 0; i < 59; i++) {
			t.mock.timers.tick(2000);
			jsonDelta(1, "x");
		}
		t.mock.timers.tick(1500);
		assert.ok(c.currentPiStream, "an active write must not be cut off by quiet gaps it already survived");
		// A second long pause after activity gets the whole budget again.
		for (let i = 0; i < FINALIZE_MAX_REARMS - 1; i++) t.mock.timers.tick(1500);
		assert.ok(c.currentPiStream);
		jsonDelta(1, '"}');
		streamEvent({ type: "content_block_stop", index: 1 });
		streamEvent({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 90 } });
		streamEvent({ type: "message_stop" });
		const done = events.filter((event) => event.type === "done");
		assert.equal(done.length, 1);
		assert.deepEqual(done[0].message.content.map((block) => block.id), ["toolu_a", "toolu_b"]);
		assert.equal(done[0].message.content[1].arguments.command, `echo ${"x".repeat(59)}`);
		assert.deepEqual(integrity, []);
	});

	it("a stream that goes silent with every call complete still ends after one grace period", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const c = ctx();
		c.resetTurnState(model);
		const events = installFakeStream();
		streamEvent({ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 10 } } });
		toolStart(0, "toolu_a");
		jsonDelta(0, '{"command":"ls"}');
		assistantCopy("toolu_a", "ls");
		streamEvent({ type: "content_block_stop", index: 0 });
		t.mock.timers.tick(1499);
		assert.ok(c.currentPiStream);
		t.mock.timers.tick(1);
		assert.equal(c.currentPiStream, null, "the deadlock backstop is unchanged");
		assert.equal(events.filter((event) => event.type === "done").length, 1);
		assert.deepEqual(integrity, []);
	});
});
