import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
	accountSessionScope,
	claudeDirForProfile,
	classifyClaudeFailure,
	rateLimitResetMs,
	rateLimitTypeFromInfo,
	RetryEventBuffer,
	subscriberProfileEnv,
} from "../src/account-router.ts";

function fakeStream() {
	const events = [];
	let ended = false;
	return {
		events,
		get ended() { return ended; },
		push(event) { events.push(event); },
		end() { ended = true; },
	};
}

describe("subscriberProfileEnv", () => {
	it("selects CLAUDE_CONFIG_DIR without inheriting API billing credentials", () => {
		const env = subscriberProfileEnv(
			{ configDir: "/profiles/max" },
			{
				PATH: "/bin",
				CLAUDE_CONFIG_DIR: "/profiles/old",
				ANTHROPIC_API_KEY: "secret",
				ANTHROPIC_AUTH_TOKEN: "secret",
				ANTHROPIC_OAUTH_TOKEN: "secret",
				CLAUDE_CODE_OAUTH_TOKEN: "secret",
				ANTHROPIC_BASE_URL: "https://gateway.invalid",
				ANTHROPIC_CUSTOM_HEADERS: "Authorization: secret",
				ANTHROPIC_AWS_API_KEY: "secret",
				ANTHROPIC_FOUNDRY_AUTH_TOKEN: "secret",
				AWS_BEARER_TOKEN_BEDROCK: "secret",
				CLAUDE_CODE_USE_BEDROCK: "1",
			},
		);
		assert.equal(env.PATH, "/bin");
		assert.equal(env.CLAUDE_CONFIG_DIR, "/profiles/max");
		assert.equal(env.ANTHROPIC_API_KEY, undefined);
		assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
		assert.equal(env.ANTHROPIC_OAUTH_TOKEN, undefined);
		assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
		assert.equal(env.ANTHROPIC_BASE_URL, undefined);
		assert.equal(env.ANTHROPIC_CUSTOM_HEADERS, undefined);
		assert.equal(env.ANTHROPIC_AWS_API_KEY, undefined);
		assert.equal(env.ANTHROPIC_FOUNDRY_AUTH_TOKEN, undefined);
		assert.equal(env.AWS_BEARER_TOKEN_BEDROCK, undefined);
		assert.equal(env.CLAUDE_CODE_USE_BEDROCK, undefined);
	});

	it("uses the real default profile by unsetting CLAUDE_CONFIG_DIR", () => {
		const env = subscriberProfileEnv(
			{ configDir: undefined },
			{ CLAUDE_CONFIG_DIR: "/profiles/old" },
		);
		assert.equal(env.CLAUDE_CONFIG_DIR, undefined);
	});
});

describe("claudeDirForProfile", () => {
	it("resolves the profile dir, else the real ~/.claude default — never the process env", () => {
		assert.equal(claudeDirForProfile({ configDir: "/profiles/max" }), "/profiles/max");
		assert.equal(claudeDirForProfile({ configDir: "  " }), join(homedir(), ".claude"));
		assert.equal(claudeDirForProfile({}), join(homedir(), ".claude"));
	});
});

describe("RetryEventBuffer", () => {
	it("discards protocol setup events when an account fails before output", () => {
		const target = fakeStream();
		const buffer = new RetryEventBuffer(target);
		buffer.push({ type: "start", partial: {} });
		buffer.push({ type: "text_start", contentIndex: 0, partial: {} });
		buffer.discard();
		buffer.end();
		assert.deepEqual(target.events, []);
		assert.equal(target.ended, false);
	});

	it("flushes setup exactly once at the first visible delta", () => {
		const target = fakeStream();
		let commits = 0;
		const buffer = new RetryEventBuffer(target, () => { commits += 1; });
		buffer.push({ type: "start", partial: {} });
		buffer.push({ type: "text_start", contentIndex: 0, partial: {} });
		buffer.push({ type: "text_delta", contentIndex: 0, delta: "hello", partial: {} });
		buffer.push({ type: "text_end", contentIndex: 0, content: "hello", partial: {} });
		buffer.end();
		assert.deepEqual(target.events.map((event) => event.type), [
			"start", "text_start", "text_delta", "text_end",
		]);
		assert.equal(commits, 1);
		assert.equal(target.ended, true);
	});

	it("treats a complete tool call as committed output", () => {
		const target = fakeStream();
		const buffer = new RetryEventBuffer(target);
		buffer.push({ type: "start", partial: {} });
		buffer.push({ type: "toolcall_end", contentIndex: 0, toolCall: {}, partial: {} });
		assert.equal(buffer.hasCommittedOutput, true);
		assert.deepEqual(target.events.map((event) => event.type), ["start", "toolcall_end"]);
	});
});

describe("classifyClaudeFailure", () => {
	// Copy → classification table. Keep every observed error shape here so a
	// regex change shows its blast radius.
	const TABLE = [
		["rate_limit", "rate-limit"],
		["You've hit your session limit · resets 7:10pm", "rate-limit"],
		["You've hit your weekly limit · resets Thursday 4am", "rate-limit"],
		["Too many requests", "rate-limit"],
		["Extra usage is disabled for this account", "rate-limit"],
		["overage not provisioned", "rate-limit"],
		["You have exceeded your usage quota", "rate-limit"],
		["API quota exceeded for requests", "rate-limit"],
		["status 429 Too Many Requests", "rate-limit"],
		["authentication_failed", "auth"],
		["401 authentication_error", "auth"],
		["OAuth token has expired; please run /login", "auth"],
		["Unauthorized", "auth"],
		// 403/permission_error: another profile may be allowed where this org
		// restriction blocks — rotation posture matches 401.
		["permission_error", "auth"],
		["HTTP 403 permission_error", "auth"],
		["OAuth org not allowed: oauth_org_not_allowed", "auth"],
		// Bare "permission denied" is just as likely a filesystem EACCES, which
		// no other account can fix.
		["EACCES: permission denied, open '/etc/hosts'", undefined],
		["Credit balance is too low", "billing"],
		["billing error: payment required", "billing"],
		["API overloaded", "overloaded"],
		["API Error: 529 overloaded_error", "overloaded"],
		["internal server error", "server"],
		["HTTP 500", "server"],
		["status 503 service unavailable capacity", "overloaded"],
		["socket timeout", "network"],
		["fetch failed", "network"],
		["ECONNRESET while streaming", "network"],
		// Tightened cases (S5): bare numbers and non-usage quota must not match.
		["disk quota exceeded", undefined],
		["the request took 500ms", undefined],
		["processed 429 rows", undefined],
		["line 502 of the file", undefined],
		["invalid request", undefined],
	];

	it("classifies error copy per the table", () => {
		for (const [copy, expected] of TABLE) {
			assert.equal(classifyClaudeFailure(copy), expected, `copy: ${copy}`);
		}
	});

	it("classifies structured status fields before prose", () => {
		assert.equal(classifyClaudeFailure({ status: 429, message: "request rejected" }), "rate-limit");
		assert.equal(classifyClaudeFailure({ statusCode: 401, message: "nope" }), "auth");
		assert.equal(classifyClaudeFailure({ status: 529 }), "overloaded");
		assert.equal(classifyClaudeFailure({ status: 500, message: "boom" }), "server");
		assert.equal(classifyClaudeFailure({ status: 402 }), "billing");
		// Anthropic maps 403 to permission_error (org restrictions,
		// oauth_org_not_allowed); message text alone must also classify.
		assert.equal(classifyClaudeFailure({ status: 403, type: "permission_error", message: "Permission denied" }), "auth");
		assert.equal(classifyClaudeFailure({ type: "permission_error", message: "Your organization does not allow this model" }), "auth");
	});
});

describe("account routing helpers", () => {
	it("normalizes camel/snake rate-limit payload variants", () => {
		const resetSeconds = Math.floor((Date.now() + 60_000) / 1000);
		assert.equal(rateLimitTypeFromInfo({ rate_limit_type: "seven_day_fable" }), "seven_day_fable");
		assert.equal(rateLimitResetMs({ resets_at: resetSeconds }), resetSeconds * 1000);
		assert.equal(rateLimitResetMs({ resetsAt: "2030-01-01T00:00:00Z" }), Date.parse("2030-01-01T00:00:00Z"));
	});

	it("resolves the session scope's claude dir like the child env", () => {
		assert.deepEqual(
			accountSessionScope({ profileId: "2", label: "max", configDir: "/profiles/max" }),
			{ accountProfileId: "2", claudeConfigDir: "/profiles/max" },
		);
		// A managed default-profile still carries an EXPLICIT resolved dir so
		// bridge-side session IO can never fall back to the parent's env (S1).
		assert.deepEqual(
			accountSessionScope({ profileId: "1", label: "default" }),
			{ accountProfileId: "1", claudeConfigDir: join(homedir(), ".claude") },
		);
		assert.deepEqual(accountSessionScope(undefined), {});
	});
});
