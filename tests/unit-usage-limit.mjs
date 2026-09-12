/**
 * Tests for usage-limit message helpers. (The narrow extra-usage detector and
 * its /extra-usage helper flow were removed in 3.0 — Extra Usage is owned by
 * the claude.ai account settings.)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatResetTimestamp, isUsageLimitMessage, uniqueNonEmptyLines } from "../src/index.ts";

describe("Claude usage-limit messages", () => {
	it("deduplicates repeated Claude Code error lines", () => {
		assert.deepEqual(uniqueNonEmptyLines(["You're out of extra usage", "You're out of extra usage", " other "]), [
			"You're out of extra usage",
			"other",
		]);
	});

	it("formats reset timestamps with timezone context", () => {
		const formatted = formatResetTimestamp("2026-05-23T13:19:55Z");
		assert.match(formatted, /2026|May|23|13|1|UTC|GMT|AM|PM/i);
		assert.equal(formatResetTimestamp("not a date"), "unknown");
	});

	it("matches the CLI's official plan and Extra Usage limit copy", () => {
		assert.equal(isUsageLimitMessage("You've hit your weekly limit · resets Thursday 4am"), true);
		assert.equal(isUsageLimitMessage("You've reached your session limit"), true);
		assert.equal(isUsageLimitMessage("You're out of usage credits"), true);
		assert.equal(isUsageLimitMessage("You're out of extra usage"), true);
		assert.equal(isUsageLimitMessage("Your seat type doesn't include extra usage"), true);
	});

	it("matches text embedded in a result payload's errors array", () => {
		const resultMessage = {
			type: "result",
			subtype: "error_during_execution",
			errors: ["You've hit your weekly limit · resets Thursday 4am"],
		};
		assert.equal(isUsageLimitMessage(resultMessage), true);
	});

	it("ignores unrelated errors and generic rate-limit prose", () => {
		assert.equal(isUsageLimitMessage("Claude rate limited; resets at 12:00"), false);
		assert.equal(isUsageLimitMessage(new Error("ECONNRESET")), false);
		assert.equal(isUsageLimitMessage(undefined), false);
	});
});
