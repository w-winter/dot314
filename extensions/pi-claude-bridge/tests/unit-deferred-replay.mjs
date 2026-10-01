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
import { UserMessageLedger } from "../src/user-message-ledger.ts";

const user = (text) => ({ role: "user", content: text });
const toolResult = () => ({ role: "toolResult", content: [], toolCallId: "t1" });
const assistant = () => ({ role: "assistant", content: [] });
// Pi stamps every user message (and every custom/bash/summary message it
// converts to one) with a creation timestamp.
let clock = 1_000;
const stamped = (text) => ({ role: "user", content: text, timestamp: clock++ });
// Stands in for the provider's check: an assistant message the bridge produced
// in this query (it carries a tool call the query forwarded to Pi) is a
// message the query already knew, so it anchors the old/new split.
const known = { isKnown: (message) => message.role === "assistant" };

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


// The caller passes the query's ledger (queryCtx.ownedUserMessages): its
// starting history plus everything earlier callbacks queued. A message it
// owns is never queued again.
describe("planDeferredUserReplay ownership ledger (kendex#1009)", () => {
	it("issue reproduction: a second steer queues each message exactly once", () => {
		const original = stamped("original");
		const ledger = UserMessageLedger.fromHistory([original]);
		const queue = [];
		let messages = [original, assistant(), toolResult(), stamped("STEER-ONE")];
		const first = planDeferredUserReplay(messages, ledger);
		queue.push(first.prompt);
		assert.equal(first.runStart, 3);
		for (const index of first.freshIndexes) ledger.own(messages[index]); // caller: on capture

		// steer #2 arrives while the query is still active, behind the first.
		messages = [...messages, stamped("STEER-TWO")];
		const second = planDeferredUserReplay(messages, ledger);
		queue.push(second.prompt);

		// Re-planning without ownership gave ["STEER-ONE", "STEER-ONE\n\nSTEER-TWO"].
		assert.deepEqual(queue, ["STEER-ONE", "STEER-TWO"]);
		assert.equal(second.runStart, 4);
		assert.equal(second.userMessageCount, 1);
	});

	it("returns an empty plan when everything is already owned", () => {
		const steer = stamped("steer");
		const messages = [assistant(), toolResult(), steer];
		const plan = planDeferredUserReplay(messages, UserMessageLedger.fromHistory(messages));

		assert.equal(plan.prompt, null);
		assert.equal(plan.blocks, null);
		assert.equal(plan.userMessageCount, 0);
		assert.equal(plan.runStart, 3, "no fresh user: runStart === messages.length");
	});

	it("still sweeps up an UNOWNED empty steer below a later real one (kendex#967 interplay)", () => {
		const ledger = new UserMessageLedger();
		// Callback 1 saw only an empty steer: nothing captured, nothing owned, and
		// the caller held the cursor at runStart.
		let messages = [assistant(), toolResult(), stamped("")];
		const first = planDeferredUserReplay(messages, ledger, known);
		assert.equal(first.prompt, null);
		assert.equal(first.runStart, 2);

		// Callback 2: a real steer lands behind it. The empty one is still fresh,
		// so this capture finally owns it.
		messages = [...messages, stamped("real steer")];
		const second = planDeferredUserReplay(messages, ledger, known);

		assert.equal(second.runStart, 2);
		assert.equal(second.userMessageCount, 2);
		assert.equal(second.prompt, "\n\nreal steer");
	});

	it("does not re-send already-owned image blocks (kendex#993 interplay)", () => {
		const image = { type: "image", data: "aGk=", mimeType: "image/png" };
		const ledger = new UserMessageLedger();
		let messages = [assistant(), { role: "user", content: [image], timestamp: clock++ }];
		const first = planDeferredUserReplay(messages, ledger, known);
		assert.ok(Array.isArray(first.blocks) && first.blocks.length > 0, "image steer captured");
		for (const index of first.freshIndexes) ledger.own(messages[index]);

		messages = [...messages, stamped("follow-up text")];
		const second = planDeferredUserReplay(messages, ledger, known);

		assert.equal(second.prompt, "follow-up text");
		assert.equal(second.blocks, null, "the owned image must not be queued a second time");
	});
});

// A user message that is not at the end of the new suffix is still unowned.
// Only capturing a trailing run let the cursor pass it without a replay owner.
describe("planDeferredUserReplay non-trailing users", () => {
	const system = () => ({ role: "system", content: "", timestamp: 0 });
	const started = () => {
		const original = stamped("original");
		return { original, ledger: UserMessageLedger.fromHistory([original]) };
	};

	it("captures a user followed by a non-user message", () => {
		const { original, ledger } = started();
		const plan = planDeferredUserReplay([original, assistant(), toolResult(), stamped("STEER"), system()], ledger);

		assert.equal(plan.runStart, 3);
		assert.equal(plan.userMessageCount, 1);
		assert.equal(plan.prompt, "STEER");
	});

	it("captures every user split by tool results, in order", () => {
		const { original, ledger } = started();
		const plan = planDeferredUserReplay([original, assistant(), toolResult(), stamped("FIRST"), toolResult(), stamped("SECOND")], ledger);

		assert.equal(plan.runStart, 3);
		assert.equal(plan.userMessageCount, 2);
		assert.equal(plan.prompt, "FIRST\n\nSECOND");
	});

	it("holds at the first user of an all-empty suffix even when it is not trailing", () => {
		const { original, ledger } = started();
		const plan = planDeferredUserReplay([original, assistant(), toolResult(), stamped(" "), system()], ledger);

		assert.equal(plan.prompt, null);
		assert.equal(plan.blocks, null);
		assert.equal(plan.runStart, 3, "the caller holds its cursor at the unowned user");
	});

	it("reports no fresh users as runStart === messages.length", () => {
		const { original, ledger } = started();
		const messages = [original, assistant(), toolResult(), system()];
		const plan = planDeferredUserReplay(messages, ledger);

		assert.equal(plan.userMessageCount, 0);
		assert.equal(plan.runStart, messages.length);
	});
});

// Extensions transform the provider context on every call (Pi installs the
// extension `context` event as transformContext), so a callback context need
// not extend the starting one. A position in the starting context is no
// delivery boundary; identity is.
describe("planDeferredUserReplay under context transforms", () => {
	it("finds a steer behind a PRUNED history (context shorter than at start)", () => {
		const history = [stamped("earlier-one"), stamped("earlier-two"), stamped("earlier-three"), stamped("earlier-four")];
		const start = stamped("start");
		const system = { role: "system", content: "", timestamp: 0 };
		const ledger = UserMessageLedger.fromHistory([system, ...history, start]);
		// 6 messages at start; the steer lands at index 4 of a 5-message context.
		const messages = [system, start, assistant(), toolResult(), stamped("STEER-AFTER-PRUNE")];
		const plan = planDeferredUserReplay(messages, ledger);

		assert.equal(plan.prompt, "STEER-AFTER-PRUNE");
		assert.deepEqual(plan.freshIndexes, [4]);
		assert.deepEqual(plan.unresolvedIndexes, []);
	});

	it("never replays the prompt when inserted messages GROW the context ahead of it", () => {
		const earlier = stamped("earlier");
		const start = stamped("start");
		const ledger = UserMessageLedger.fromHistory([earlier, start]);
		const injected = { role: "system", content: "", timestamp: 0 };
		const messages = [injected, injected, earlier, start, assistant(), toolResult(), stamped("STEER")];
		const plan = planDeferredUserReplay(messages, ledger);

		assert.equal(plan.prompt, "STEER");
		assert.deepEqual(plan.freshIndexes, [6]);
	});

	it("hands a REWRITTEN owned message to a rebuild instead of replaying or skipping it", () => {
		const earlier = stamped("earlier with a long attachment");
		const start = stamped("start");
		const ledger = UserMessageLedger.fromHistory([earlier, start]);
		const rewritten = { ...earlier, content: "[attachment pruned]" };
		const messages = [rewritten, start, assistant(), toolResult(), stamped("STEER")];
		const plan = planDeferredUserReplay(messages, ledger);

		assert.equal(plan.prompt, "STEER", "the rewritten message is not replayed");
		assert.deepEqual(plan.unresolvedIndexes, [0]);
	});

	it("hands a user message without a timestamp to a rebuild unless the query already owns it", () => {
		const bare = { role: "user", content: "reminder" };
		const start = stamped("start");
		const known = planDeferredUserReplay([bare, start, assistant(), toolResult()], UserMessageLedger.fromHistory([bare, start]));
		assert.deepEqual(known.unresolvedIndexes, [], "an owned bare message matches by content");
		assert.equal(known.userMessageCount, 0);

		const unknown = planDeferredUserReplay([start, assistant(), toolResult(), { role: "user", content: "who sent this?" }], UserMessageLedger.fromHistory([start]));
		assert.deepEqual(unknown.unresolvedIndexes, [3]);
		assert.equal(unknown.prompt, null);
	});

	it("treats string content and its converted text-block form as the same message", () => {
		const timestamp = clock++;
		const ledger = UserMessageLedger.fromHistory([{ role: "user", content: "from intercom", timestamp }]);
		const plan = planDeferredUserReplay([{ role: "user", content: [{ type: "text", text: "from intercom" }], timestamp }], ledger);

		assert.equal(plan.userMessageCount, 0);
		assert.deepEqual(plan.unresolvedIndexes, []);
	});

	it("keeps a new message fresh when it shares a millisecond with an owned message that is still present", () => {
		const timestamp = clock++;
		const owned = { role: "user", content: "queued steer", timestamp };
		const ledger = UserMessageLedger.fromHistory([owned]);
		const plan = planDeferredUserReplay([owned, assistant(), toolResult(), { role: "user", content: "intercom, same ms", timestamp }], ledger);

		assert.equal(plan.prompt, "intercom, same ms");
		assert.deepEqual(plan.unresolvedIndexes, []);
	});

	it("counts identical owned messages as a multiset", () => {
		const timestamp = clock++;
		const twin = () => ({ role: "user", content: "continue", timestamp });
		const ledger = UserMessageLedger.fromHistory([twin()]);
		const plan = planDeferredUserReplay([twin(), assistant(), toolResult(), twin()], ledger);

		// The second copy has the owned one's timestamp, and nothing owned is
		// missing, so it is a distinct new message.
		assert.deepEqual(plan.freshIndexes, [3]);
		ledger.own(twin());
		assert.equal(planDeferredUserReplay([twin(), twin()], ledger).userMessageCount, 0);
	});

	it("hands a RE-STAMPED copy of a missing owned message to a rebuild instead of replaying it", () => {
		const start = stamped("start");
		const ledger = UserMessageLedger.fromHistory([start]);
		const copy = { ...start, timestamp: clock++ };
		const plan = planDeferredUserReplay([copy, assistant(), toolResult(), stamped("STEER")], ledger, known);

		assert.equal(plan.prompt, "STEER");
		assert.deepEqual(plan.unresolvedIndexes, [0]);
	});

	it("hands every unowned message to a rebuild once Pi replaced the history during the query", () => {
		const start = stamped("start");
		const ledger = UserMessageLedger.fromHistory([start]);
		const summary = stamped("The conversation history before this point was compacted into the following summary: ...");
		const plan = planDeferredUserReplay([summary, assistant(), toolResult(), stamped("STEER")], ledger, { historyReplaced: true });

		assert.equal(plan.prompt, null, "a summary of history Claude has must not be replayed as a steer");
		assert.deepEqual(plan.unresolvedIndexes, [0, 3]);
	});
});

// Identity alone cannot tell a new message from an older one rewritten under
// new content AND a new timestamp. The anchor, the last message the query
// already knew, can: Pi appends new input at the end.
describe("planDeferredUserReplay anchors the old/new split on the last known message", () => {
	it("hands an older message rewritten under new content and a new timestamp to a rebuild (stage D2 review 2)", () => {
		const earlier = stamped("earlier-one: a long pasted log");
		const start = stamped("start");
		const ledger = UserMessageLedger.fromHistory([earlier, start]);
		const messages = [stamped("earlier-one: [log pruned]"), start, assistant(), toolResult(), stamped("STEER")];
		const plan = planDeferredUserReplay(messages, ledger, known);

		assert.equal(plan.prompt, "STEER");
		assert.deepEqual(plan.freshIndexes, [4]);
		assert.deepEqual(plan.unresolvedIndexes, [0], "an owned message is missing, so a rebuild owns it");
		assert.equal(plan.anchorIndex, 2);
		assert.equal(plan.missingOwned, 1);
	});

	it("anchors on a known assistant or tool result when no owned user is left in the context", () => {
		const ledger = UserMessageLedger.fromHistory([stamped("start")]);
		const earlierResult = { role: "toolResult", content: [], toolCallId: "earlier" };
		const messages = [stamped("rewritten prompt"), earlierResult, toolResult(), stamped("STEER")];
		const plan = planDeferredUserReplay(messages, ledger, { isKnown: (message) => message === earlierResult });

		assert.equal(plan.anchorIndex, 1, "a tool result from an earlier callback anchors; this callback's does not");
		assert.deepEqual(plan.unresolvedIndexes, [0]);
		assert.deepEqual(plan.freshIndexes, [3]);
		assert.equal(plan.prompt, "STEER");
	});

	it("hands every unknown user to a rebuild when the context holds no anchor at all", () => {
		const ledger = UserMessageLedger.fromHistory([stamped("start")]);
		const messages = [stamped("a summary of everything so far"), toolResult(), stamped("STEER")];
		const plan = planDeferredUserReplay(messages, ledger, { isKnown: () => false });

		assert.equal(plan.anchorIndex, -1);
		assert.equal(plan.prompt, null, "nothing is replayed as a steer");
		assert.deepEqual(plan.unresolvedIndexes, [0, 2], "nothing is silently lost: a rebuild owns them");
	});

	it("still sends identity evidence to a rebuild on either side of the anchor", () => {
		const start = stamped("start");
		const ledger = UserMessageLedger.fromHistory([start]);
		// The prompt re-created AFTER the anchor under a new timestamp: its
		// content is that of a missing owned message, so it is no new steer.
		const plan = planDeferredUserReplay([assistant(), toolResult(), { ...start, timestamp: clock++ }], ledger, known);

		assert.equal(plan.prompt, null);
		assert.deepEqual(plan.unresolvedIndexes, [2]);
	});

	it("treats a new message moved before the anchor as fresh while every owned message is present (stage D2 review 3)", () => {
		const start = stamped("start");
		const ledger = UserMessageLedger.fromHistory([start]);
		const moved = stamped("STEER-RELOCATED");
		const plan = planDeferredUserReplay([start, moved, assistant(), toolResult(), stamped("STEER-AFTER")], ledger, known);

		assert.equal(plan.missingOwned, 0);
		assert.deepEqual(plan.freshIndexes, [1, 4], "both queued, in context order");
		assert.equal(plan.prompt, "STEER-RELOCATED\n\nSTEER-AFTER");
		assert.deepEqual(plan.unresolvedIndexes, []);
	});

	it("hands a moved message to a rebuild when an owned message is missing, and keeps the post-anchor steer fresh", () => {
		const earlier = stamped("earlier");
		const start = stamped("start");
		const ledger = UserMessageLedger.fromHistory([earlier, start]);
		const plan = planDeferredUserReplay([stamped("STEER-RELOCATED"), start, assistant(), toolResult(), stamped("STEER-AFTER")], ledger, known);

		assert.equal(plan.missingOwned, 1);
		assert.deepEqual(plan.unresolvedIndexes, [0]);
		assert.equal(plan.prompt, "STEER-AFTER");
	});
});
