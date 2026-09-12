import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { processAssistantMessage, processStreamEvent } from "../src/index.ts";
import { ctx, resetStack } from "../src/query-state.ts";

const model = {
	api: "claude-bridge",
	provider: "pi-claude",
	id: "claude-haiku-4-5",
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function installFakeStream() {
	const events = [];
	const stream = {
		push(event) { events.push(event); },
		end(result) { events.push({ type: "stream_end", result }); },
	};
	ctx().currentPiStream = stream;
	return events;
}

describe("assistant tool-use boundary fallback", () => {
	beforeEach(() => resetStack());

	it("defers the streamed tool-use turn end to message_stop so message_delta usage lands", () => {
		const c = ctx();
		c.resetTurnState(model);
		const events = installFakeStream();
		c.turnSawStreamEvent = true;
		c.turnSawToolCall = true;
		c.turnToolCallIds = ["toolu_1"];
		c.turnBlocks.push({
			type: "toolCall",
			id: "toolu_1",
			name: "bash",
			arguments: {},
			partialJson: "{\"command\":\"echo hi\"}",
			index: 0,
		});

		processAssistantMessage({
			type: "assistant",
			message: {
				content: [{
					type: "tool_use",
					id: "toolu_1",
					name: "mcp__custom-tools__bash",
					input: { command: "echo hi" },
				}],
			},
		}, model, new Map([["mcp__custom-tools__bash", "bash"]]));

		// Boundary arms the deferred end instead of closing the stream: the SDK
		// yields this assistant message BEFORE message_delta, and message_delta is
		// what carries the message's real output-token count.
		assert.ok(c.currentPiStream, "boundary must not end the stream directly");
		assert.ok(c.scheduledToolUseEnd, "boundary arms the grace timer");
		assert.deepEqual(c.turnToolCallIds, ["toolu_1"]);
		assert.equal(c.turnBlocks.length, 1, "must not duplicate streamed tool call block");
		assert.equal(c.turnBlocks[0].arguments.command, "echo hi");
		assert.ok(!("partialJson" in c.turnBlocks[0]), "partial JSON should be finalized");

		// message_delta then message_stop — the normal terminal events.
		processStreamEvent({ type: "stream_event", event: {
			type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 187 },
		} }, new Map(), model);
		processStreamEvent({ type: "stream_event", event: { type: "message_stop" } }, new Map(), model);

		assert.equal(c.currentPiStream, null);
		assert.equal(c.scheduledToolUseEnd, null, "grace timer disarmed at turn end");
		assert.equal(c.turnOutput.stopReason, "toolUse");
		assert.equal(c.turnOutput.usage.output, 187, "message_delta usage must reach the delivered message");
		assert.equal(events.at(-2).type, "done");
		assert.equal(events.at(-2).reason, "toolUse");
		assert.equal(events.at(-2).message.usage.output, 187, "done event carries the real output count");
		assert.equal(events.at(-1).type, "stream_end");
	});

	it("adds missing tool-use blocks from assistant message before ending the turn", () => {
		const c = ctx();
		c.resetTurnState(model);
		const events = installFakeStream();
		c.turnSawStreamEvent = true;

		processAssistantMessage({
			type: "assistant",
			message: {
				content: [{
					type: "tool_use",
					id: "toolu_missing",
					name: "mcp__custom-tools__read",
					input: { file_path: "README.md" },
				}],
			},
		}, model, new Map([["mcp__custom-tools__read", "read"]]));

		assert.ok(c.currentPiStream, "boundary defers the end to message_stop");
		assert.ok(c.scheduledToolUseEnd, "boundary arms the grace timer");
		assert.deepEqual(c.turnToolCallIds, ["toolu_missing"]);
		assert.equal(c.turnBlocks.length, 1);
		assert.equal(c.turnBlocks[0].name, "read");
		assert.equal(c.turnBlocks[0].arguments.path, "README.md");
		processStreamEvent({ type: "stream_event", event: { type: "message_stop" } }, new Map([["mcp__custom-tools__read", "read"]]), model);
		assert.equal(c.currentPiStream, null);
		assert.deepEqual(events.map((event) => event.type), ["start", "toolcall_start", "toolcall_end", "done", "stream_end"]);
	});

	it("grace timer force-ends the tool-use turn when terminal events never arrive", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const c = ctx();
		c.resetTurnState(model);
		const events = installFakeStream();
		c.turnSawStreamEvent = true;

		processAssistantMessage({
			type: "assistant",
			message: {
				content: [{
					type: "tool_use",
					id: "toolu_silent",
					name: "mcp__custom-tools__bash",
					input: { command: "echo hi" },
				}],
			},
		}, model, new Map([["mcp__custom-tools__bash", "bash"]]));

		assert.ok(c.currentPiStream, "turn stays open awaiting message_stop");
		assert.ok(c.scheduledToolUseEnd, "grace timer armed");

		t.mock.timers.tick(1500);

		assert.equal(c.currentPiStream, null, "grace elapsed — turn force-ended");
		assert.equal(c.scheduledToolUseEnd, null);
		assert.equal(events.at(-2).type, "done");
		assert.equal(events.at(-2).reason, "toolUse");
		assert.equal(events.at(-1).type, "stream_end");
	});

	it("records assistant tool-use ids even after the stream already ended", () => {
		const c = ctx();
		c.resetTurnState(model);
		c.turnSawStreamEvent = true;
		c.turnSawToolCall = true;
		c.currentPiStream = null;
		c.recordToolCall("toolu_streamed", "bash", { command: "echo first", timeout: 120 });
		c.turnBlocks.push({
			type: "toolCall",
			id: "toolu_streamed",
			name: "bash",
			arguments: { command: "echo first", timeout: 120 },
		});

		processAssistantMessage({
			type: "assistant",
			message: {
				content: [
					{
						type: "tool_use",
						id: "toolu_streamed",
						name: "mcp__custom-tools__bash",
						input: { command: "echo first" },
					},
					{
						type: "tool_use",
						id: "toolu_missing_after_stop",
						name: "mcp__custom-tools__write",
						input: { file_path: "out.txt", content: "ok" },
					},
				],
			},
		}, model, new Map([
			["mcp__custom-tools__bash", "bash"],
			["mcp__custom-tools__write", "write"],
		]));

		assert.equal(c.currentPiStream, null);
		assert.deepEqual(c.turnToolCallIds, ["toolu_streamed", "toolu_missing_after_stop"]);
		// Ids are recorded (claims and result matching need them), but the content
		// array is NOT appended to: after endToolUseTurn it is the message Pi
		// already holds by reference, and a push would land a call in a delivered
		// message behind Pi's back. The unforwarded call reaches Pi
		// through its next-turn replay instead.
		assert.equal(c.turnBlocks.length, 1);
		assert.equal(c.turnBlocks[0].name, "bash");
	});

	it("ignores a late bare message_stop so the next assistant fallback still renders text", () => {
		const c = ctx();
		c.resetTurnState(model);
		installFakeStream();

		processStreamEvent({ type: "stream_event", event: { type: "message_stop" } }, new Map(), model);

		assert.equal(c.turnSawStreamEvent, false, "late stop-only event must not mask assistant fallback");
		assert.equal(c.currentPiStream !== null, true);

		processAssistantMessage({
			type: "assistant",
			message: {
				content: [{ type: "text", text: "next turn text" }],
			},
		}, model, new Map());

		assert.equal(c.turnBlocks.length, 1);
		assert.equal(c.turnBlocks[0].type, "text");
		assert.equal(c.turnBlocks[0].text, "next turn text");
	});

	it("ignores late unmatched content_block events so assistant fallback is not masked", () => {
		const c = ctx();
		c.resetTurnState(model);
		installFakeStream();

		processStreamEvent({ type: "stream_event", event: { type: "content_block_delta", index: 7, delta: { type: "text_delta", text: "late" } } }, new Map(), model);
		processStreamEvent({ type: "stream_event", event: { type: "content_block_stop", index: 7 } }, new Map(), model);

		assert.equal(c.turnSawStreamEvent, false, "unmatched late content events must not mask assistant fallback");
		assert.equal(c.turnBlocks.length, 0);

		processAssistantMessage({
			type: "assistant",
			message: {
				content: [{ type: "text", text: "fallback after stale content event" }],
			},
		}, model, new Map());

		assert.equal(c.turnBlocks.length, 1);
		assert.equal(c.turnBlocks[0].text, "fallback after stale content event");
	});

	it("updates the Pi assistant model when Claude Code switches models at message_start", () => {
		const c = ctx();
		c.resetTurnState({ ...model, id: "claude-fable-5-1" });
		installFakeStream();

		processStreamEvent({
			type: "stream_event",
			event: {
				type: "message_start",
				message: {
					model: "claude-opus-4-8",
					usage: { input_tokens: 1, output_tokens: 0 },
				},
			},
		}, new Map(), model);

		assert.equal(c.turnOutput.model, "claude-opus-4-8");
		assert.equal(c.turnSawStreamEvent, false);
	});

	it("records fallback assistant blocks without rendering them as text", () => {
		const c = ctx();
		c.resetTurnState({ ...model, id: "claude-fable-5-1" });
		installFakeStream();

		processAssistantMessage({
			type: "assistant",
			message: {
				model: "claude-opus-4-8",
				content: [{
					type: "fallback",
					from: { model: "claude-fable-5-1" },
					to: { model: "claude-opus-4-8" },
				}],
			},
		}, model, new Map());

		assert.equal(c.turnOutput.model, "claude-opus-4-8");
		assert.equal(c.turnBlocks.length, 0);
	});
});

describe("no-stream-events fallback: same-message re-yields", () => {
	beforeEach(() => resetStack());

	it("renders a re-yielded identical text block only once", () => {
		// The SDK yields the SAME assistant message more than once (partial +
		// completed copies share one id). A rate-limited turn must print its
		// warning only once through this path.
		const c = ctx();
		c.resetTurnState(model);
		const events = installFakeStream();
		const msg = {
			type: "assistant",
			message: {
				id: "msg_dup",
				content: [{ type: "text", text: "You've hit your weekly limit · resets Jul 30, 4am" }],
				usage: { input_tokens: 1, output_tokens: 2 },
			},
		};

		processAssistantMessage(msg, model, new Map());
		processAssistantMessage(msg, model, new Map());

		assert.equal(c.turnBlocks.filter((b) => b.type === "text").length, 1);
		assert.equal(events.filter((e) => e.type === "text_start").length, 1);
	});

	it("a distinct new message still renders", () => {
		const c = ctx();
		c.resetTurnState(model);
		const events = installFakeStream();
		const mk = (id, text) => ({ type: "assistant", message: { id, content: [{ type: "text", text }] } });

		processAssistantMessage(mk("msg_a", "first"), model, new Map());
		processAssistantMessage(mk("msg_b", "second"), model, new Map());

		assert.deepEqual(c.turnBlocks.filter((b) => b.type === "text").map((b) => b.text), ["first", "second"]);
		assert.equal(events.filter((e) => e.type === "text_start").length, 2);
	});

	it("renders identical text only once even when the yields carry different ids", () => {
		// A rejected turn's synthesized error message arrives as multiple yields
		// whose ids differ or are absent. Identical error blocks must still
		// collapse into one Pi message.
		const c = ctx();
		c.resetTurnState(model);
		const events = installFakeStream();
		const text = "You've hit your weekly limit · resets Jul 30, 4am (America/Los_Angeles)";
		const mk = (id) => ({ type: "assistant", message: { ...(id ? { id } : {}), content: [{ type: "text", text }] } });

		processAssistantMessage(mk("msg_attempt_1"), model, new Map());
		processAssistantMessage(mk("msg_attempt_2"), model, new Map());
		processAssistantMessage(mk(undefined), model, new Map());

		assert.equal(c.turnBlocks.filter((b) => b.type === "text").length, 1);
		assert.equal(events.filter((e) => e.type === "text_start").length, 1);
	});

	it("does not duplicate a re-yielded tool call block and keeps claim state", () => {
		const c = ctx();
		c.resetTurnState(model);
		const events = installFakeStream();
		const msg = {
			type: "assistant",
			message: {
				id: "msg_tool",
				content: [{ type: "tool_use", id: "toolu_dup", name: "mcp__custom-tools__bash", input: { command: "echo hi" } }],
			},
		};

		processAssistantMessage(msg, model, new Map([["mcp__custom-tools__bash", "bash"]]));
		const claim = c.claimToolCall("bash", { command: "echo hi", timeout: 120 });
		assert.equal(claim.toolCallId, "toolu_dup");

		processAssistantMessage(msg, model, new Map([["mcp__custom-tools__bash", "bash"]]));

		assert.equal(c.turnBlocks.filter((b) => b.type === "toolCall").length, 1, "no duplicate toolCall block");
		assert.equal(events.filter((e) => e.type === "toolcall_start").length, 1);
		assert.equal(c.claimedToolCallIds.has("toolu_dup"), true, "same-message re-yield must not wipe claim state");
	});
});
