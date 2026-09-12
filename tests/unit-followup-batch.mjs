import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planIncrementalPromptBatch } from "../src/index.ts";

const msg = (role) => ({ role, content: role === "assistant" ? [] : role });
const roles = (...values) => values.map(msg);

describe("planIncrementalPromptBatch", () => {
	it("batches followUpMode=all users after Claude's trailing assistant", () => {
		const plan = planIncrementalPromptBatch(
			roles("user", "assistant", "user", "user"),
			1,
		);

		assert.deepEqual(plan, {
			promptStart: 2,
			userMessageCount: 2,
		});
	});

	it("keeps the normal single-user reuse path unchanged", () => {
		const plan = planIncrementalPromptBatch(
			roles("user", "assistant", "user"),
			1,
		);

		assert.deepEqual(plan, {
			promptStart: 2,
			userMessageCount: 1,
		});
	});

	it("supports a cursor already advanced past the assistant", () => {
		const plan = planIncrementalPromptBatch(
			roles("user", "assistant", "user", "user"),
			2,
		);

		assert.deepEqual(plan, {
			promptStart: 2,
			userMessageCount: 2,
		});
	});

	it("rejects genuine history divergence containing an intervening assistant", () => {
		const plan = planIncrementalPromptBatch(
			roles("user", "assistant", "user", "assistant", "user"),
			1,
		);

		assert.equal(plan, undefined);
	});

	it("rejects a non-user final prompt", () => {
		assert.equal(
			planIncrementalPromptBatch(roles("user", "assistant", "toolResult"), 1),
			undefined,
		);
	});

	it("rejects a toolResult inside the pending tail", () => {
		assert.equal(
			planIncrementalPromptBatch(roles("user", "assistant", "toolResult", "user"), 1),
			undefined,
		);
	});

	it("rejects a cursor beyond the array instead of clamping (reentrant/foreign context)", () => {
		// A cursor past the end proves the messages array is NOT the conversation
		// the cursor describes — e.g. a subagent's short reentrant context while
		// the parent cursor is 40. Clamping would fabricate a REUSE plan that
		// resumed the parent session against foreign history.
		const messages = roles("user");
		assert.equal(planIncrementalPromptBatch(messages, 40), undefined);
		// cursor == messages.length also means Claude owns the trailing user
		// already. Clamping would resend that owned message as another prompt.
		assert.equal(planIncrementalPromptBatch(roles("user", "assistant", "user"), 3), undefined);
		// The legitimate boundary (cursor == lastIndex) still plans a REUSE.
		assert.deepEqual(planIncrementalPromptBatch(roles("user", "assistant", "user"), 2), {
			promptStart: 2,
			userMessageCount: 1,
		});
	});
});
