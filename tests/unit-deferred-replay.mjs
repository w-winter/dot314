/**
 * Tests for planDeferredUserReplay — the re-entrant branch's capture plan for
 * user messages pi injects mid-query (steer drain, followUp delivery).
 *
 * When the context ends in MULTIPLE trailing user messages, only
 * the last was deferred while the cursor advanced past all of them — the
 * earlier ones were permanently and silently lost. The plan must cover the
 * entire trailing user run, and the caller advances the cursor to the end of
 * the context only when the plan produced a replay prompt (otherwise it stops
 * at runStart so nothing unclaimed is skipped).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planDeferredUserReplay } from "../src/index.ts";

const user = (text) => ({ role: "user", content: text });
const toolResult = () => ({ role: "toolResult", content: [], toolCallId: "t1" });
const assistant = () => ({ role: "assistant", content: [] });

describe("planDeferredUserReplay", () => {
	it("captures BOTH trailing users after a tool result (kendex#967 shape)", () => {
		const messages = [assistant(), toolResult(), user("u_a"), user("u_b")];

		const plan = planDeferredUserReplay(messages);

		assert.equal(plan.runStart, 2);
		assert.equal(plan.userMessageCount, 2);
		// Both messages, in order, in one combined replay prompt.
		assert.equal(plan.prompt, "u_a\n\nu_b");
		// Caller contract: prompt captured → cursor lands at messages.length,
		// covering exactly the messages that were deferred.
		assert.equal(messages.length, plan.runStart + plan.userMessageCount);
	});

	it("keeps the single trailing user unchanged", () => {
		const plan = planDeferredUserReplay([assistant(), toolResult(), user("steer")]);

		assert.equal(plan.runStart, 2);
		assert.equal(plan.userMessageCount, 1);
		assert.equal(plan.prompt, "steer");
	});

	it("returns no prompt when the context does not end in a user message", () => {
		const plan = planDeferredUserReplay([assistant(), toolResult()]);

		assert.equal(plan.runStart, 2);
		assert.equal(plan.userMessageCount, 0);
		assert.equal(plan.prompt, null);
	});

	it("returns no prompt for an all-empty user run so the caller can diagnose it", () => {
		const plan = planDeferredUserReplay([assistant(), toolResult(), user(""), user("  ")]);

		// runStart still marks the run — the caller holds the cursor here instead
		// of silently claiming messages that were never captured.
		assert.equal(plan.runStart, 2);
		assert.equal(plan.userMessageCount, 2);
		assert.equal(plan.prompt, null);
	});
});

// The replay plan carries both text and image blocks. An image-only run must be
// captured rather than skipped.
describe("planDeferredUserReplay image blocks (kendex#993)", () => {
	const image = () => ({ type: "image", data: "aGk=", mimeType: "image/png" });

	it("carries blocks alongside text for a mixed run", () => {
		const messages = [
			{ role: "assistant", content: [] },
			{ role: "user", content: [{ type: "text", text: "look at this" }, image()] },
			{ role: "user", content: "and fix it" },
		];

		const plan = planDeferredUserReplay(messages);

		assert.equal(plan.userMessageCount, 2);
		assert.equal(plan.prompt, "look at this\n\nand fix it");
		assert.ok(Array.isArray(plan.blocks), "block form present when the run carries images");
		assert.ok(plan.blocks.some((b) => b.type === "image"), "image block preserved");
		assert.ok(plan.blocks.some((b) => b.type === "text" && b.text === "and fix it"), "text preserved in block form");
	});

	it("captures an image-only run (no usable text) instead of skipping it", () => {
		const messages = [
			{ role: "assistant", content: [] },
			{ role: "user", content: [image()] },
		];

		const plan = planDeferredUserReplay(messages);

		assert.equal(plan.prompt, null);
		assert.ok(Array.isArray(plan.blocks) && plan.blocks.length > 0, "image-only run still produces a replay payload");
	});

	it("returns null blocks for a text-only run", () => {
		const plan = planDeferredUserReplay([{ role: "user", content: "plain" }]);
		assert.equal(plan.blocks, null);
		assert.equal(plan.prompt, "plain");
	});
});

// The caller passes the captured position through queryCtx.latestCursor. The
// run walk must never cross below it or queue the same steer twice.
describe("planDeferredUserReplay capture bound (kendex#1009)", () => {
	it("issue reproduction: a second steer queues each message exactly once", () => {
		// steer #1 arrives with the tool result; captured, cursor advances.
		const queue = [];
		let messages = [user("original"), assistant(), toolResult(), user("STEER-ONE")];
		const first = planDeferredUserReplay(messages, 0);
		queue.push(first.prompt);
		assert.equal(first.runStart, 3);
		const captured = messages.length; // caller: capturedThrough on capture

		// steer #2 arrives while the query is still active — same trailing run,
		// one message longer.
		messages = [...messages, user("STEER-TWO")];
		const second = planDeferredUserReplay(messages, captured);
		queue.push(second.prompt);

		// Before the bound this was ["STEER-ONE", "STEER-ONE\n\nSTEER-TWO"].
		assert.deepEqual(queue, ["STEER-ONE", "STEER-TWO"]);
		assert.equal(second.runStart, 4, "the walk must stop at the captured position");
		assert.equal(second.userMessageCount, 1);
		// Cursor math stays consistent: this capture covers exactly the run.
		assert.equal(messages.length, second.runStart + second.userMessageCount);
	});

	it("returns an empty plan when everything is already captured", () => {
		const messages = [assistant(), toolResult(), user("steer")];
		const plan = planDeferredUserReplay(messages, messages.length);

		assert.equal(plan.prompt, null);
		assert.equal(plan.blocks, null);
		assert.equal(plan.userMessageCount, 0);
		// runStart === capturedThrough === messages.length: the caller's skip
		// branch holds the cursor there, advancing nothing.
		assert.equal(plan.runStart, 3);
	});

	it("still sweeps up an UNCAPTURED empty steer below a later real one (kendex#967 interplay)", () => {
		// Callback 1 saw only an empty steer: nothing captured, and the caller
		// held the cursor at runStart (2), NOT past the empty message.
		let messages = [assistant(), toolResult(), user("")];
		const first = planDeferredUserReplay(messages, 0);
		assert.equal(first.prompt, null);
		const captured = first.runStart; // caller: capturedThrough on skip
		assert.equal(captured, 2);

		// Callback 2: a real steer lands behind it. The bound is the HELD
		// position, so the empty message is still part of the plan and finally
		// gets owned by this capture.
		messages = [...messages, user("real steer")];
		const second = planDeferredUserReplay(messages, captured);

		assert.equal(second.runStart, 2);
		assert.equal(second.userMessageCount, 2);
		// The empty message contributes only the join separator.
		assert.equal(second.prompt, "\n\nreal steer");
	});

	it("does not re-send already-captured image blocks (kendex#993 interplay)", () => {
		const image = { type: "image", data: "aGk=", mimeType: "image/png" };
		let messages = [assistant(), { role: "user", content: [image] }];
		const first = planDeferredUserReplay(messages, 0);
		assert.ok(Array.isArray(first.blocks) && first.blocks.length > 0, "image steer captured");
		const captured = messages.length;

		messages = [...messages, user("follow-up text")];
		const second = planDeferredUserReplay(messages, captured);

		assert.equal(second.prompt, "follow-up text");
		assert.equal(second.blocks, null, "the captured image must not be queued a second time");
	});
});
