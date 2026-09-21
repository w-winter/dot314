// Must load before any bridge module: diag assertions need the debug flag
// set when src/debug.ts is evaluated.
import "./lib/debug-env.mjs";

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
	__testSetBridgeIntegrityState,
	__testGetBridgeIntegrityState,
	__testSetSdkQueryFactory,
	probeClaudeAccountProfile,
	streamClaudeAgentSdk,
} from "../src/index.ts";
import * as piAi from "@earendil-works/pi-ai";
import { buildModels } from "../src/models.ts";
import { resolveGetModels } from "../src/pi-ai-compat.ts";
import { buildNativeProvider } from "../src/native-provider.ts";
import { RATE_LIMIT_TOKEN } from "../src/rate-limit.ts";
import { setExtensionApi } from "../src/bridge-state.ts";
import { CLAUDE_ACCOUNT_ROUTER_SYMBOL } from "../src/account-router.ts";
import { setConnectorCallAuditSink } from "../src/connector-audit.ts";
import { ctx, resetStack } from "../src/query-state.ts";
import { runInRequestLane } from "../src/request-lane.ts";

const model = {
	id: "claude-haiku-4-5",
	name: "Claude Haiku",
	api: "claude-bridge",
	provider: "pi-claude",
	baseUrl: "claude-bridge",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8192,
};
const contextWithPrompt = (messages) => ({
	messages: [
		{ role: "system", content: "test system prompt", timestamp: 0 },
		...messages,
	],
});
const context = contextWithPrompt([{ role: "user", content: "hello", timestamp: Date.now() }]);

function fakeSdkQuery(messages, accountLabel, observed) {
	let closed = false;
	return {
		async *[Symbol.asyncIterator]() {
			for (const message of messages) {
				if (closed) break;
				if (message instanceof Error) throw message;
				yield message;
			}
		},
		close() { closed = true; },
		async interrupt() { closed = true; },
		async accountInfo() {
			return { email: `${accountLabel}@example.com`, subscriptionType: "max" };
		},
		async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
			observed.usageProbes.push(accountLabel);
			return { subscription_type: "max", rate_limits_available: true, rate_limits: null };
		},
	};
}

function makeRouter(observed, options = {}) {
	const accounts = [
		{ profileId: "a", label: "account-a", configDir: "/profiles/a" },
		{ profileId: "b", label: "account-b", configDir: "/profiles/b" },
	];
	return {
		version: 1,
		acquire(input) {
			observed.acquires.push(input);
			if (options.unavailable) {
				const error = new Error("No Claude subscription account is available");
				if (options.resetAtMs) Object.assign(error, { resetAtMs: options.resetAtMs, rateLimitType: "all_accounts" });
				throw error;
			}
			const excluded = new Set(input.excludedProfileIds ?? []);
			const selected = accounts.find((account) => !excluded.has(account.profileId));
			if (!selected) throw new Error("All Claude accounts are cooling down");
			return selected;
		},
		recordIdentity(profileId, identity) { observed.identities.push({ profileId, identity }); },
		recordUsage(profileId) { observed.usageRecords.push(profileId); },
		recordRateLimit(profileId, info) {
			observed.rateLimits.push({ profileId, info });
			return Date.now() + 60_000;
		},
		recordFailure(profileId, kind) { observed.failures.push({ profileId, kind }); },
		recordSuccess(profileId) { observed.successes.push(profileId); },
		current() { return undefined; },
	};
}

function observedState() {
	return {
		acquires: [],
		queryEnvs: [],
		usageProbes: [],
		usageRecords: [],
		identities: [],
		rateLimits: [],
		failures: [],
		successes: [],
	};
}

async function collect(stream) {
	const events = [];
	for await (const event of stream) events.push(event);
	return events;
}

function textEvents(events) {
	return events.filter((event) => event.type === "text_delta").map((event) => event.delta);
}

function bridgeStateFor(sessionId) {
	return runInRequestLane(sessionId, () => __testGetBridgeIntegrityState());
}

let notifications;
let emittedRateLimitEvents;
let diagDir;

function readDiagLog() {
	try { return readFileSync(process.env.CLAUDE_BRIDGE_DIAG_PATH, "utf8"); } catch { return ""; }
}

beforeEach(() => {
	process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT = "0";
	// Legacy (no-router) paths gate on credential presence; an env token is an
	// existence-only signal that never gets read.
	process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token";
	// Keep diagnostics out of the real user diag log — and readable for the
	// tests that assert on them (debug-env.mjs enabled the gating flag).
	diagDir = mkdtempSync(join(tmpdir(), "bridge-diag-"));
	process.env.CLAUDE_BRIDGE_DIAG_PATH = join(diagDir, "diag.log");
	resetStack();
	notifications = [];
	emittedRateLimitEvents = [];
	__testSetBridgeIntegrityState({
		sharedSession: null,
		ui: { notify: (message, level) => notifications.push({ message, level }) },
	});
	setExtensionApi({
		events: { emit: (name, payload) => emittedRateLimitEvents.push({ name, payload }) },
		appendEntry: () => {},
	});
});

afterEach(() => {
	delete process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT;
	delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
	delete process.env.CLAUDE_BRIDGE_DIAG_PATH;
	rmSync(diagDir, { recursive: true, force: true });
	delete globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL];
	__testSetSdkQueryFactory();
	setExtensionApi(undefined);
	resetStack();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
});

const STREAMED_TEXT = (text) => [
	{ type: "stream_event", event: { type: "message_start", message: { model: model.id, usage: { input_tokens: 1 } } } },
	{ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
	{ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } },
];

describe("legacy sessions (no account router)", () => {
	it("completes a rejected rate limit + streamed recovery exactly like a success", async () => {
		// A rejected five_hour rate_limit_event followed by
		// the SDK's own fallback-model recovery must yield ONE rate-limit
		// notification, NO trailing error event, and a persisted session.
		let calls = 0;
		__testSetSdkQueryFactory(() => {
			calls += 1;
			return fakeSdkQuery([
				{ type: "system", subtype: "init", session_id: "session-legacy" },
				{
					type: "rate_limit_event",
					rate_limit_info: {
						status: "rejected",
						rateLimitType: "five_hour",
						resetsAt: new Date(Date.now() + 60_000).toISOString(),
					},
				},
				...STREAMED_TEXT("recovered"),
				{ type: "result", subtype: "success", result: "recovered" },
			], "legacy", observedState());
		});

		const events = await collect(streamClaudeAgentSdk(model, context, { sessionId: "legacy-recovery" }));
		assert.equal(calls, 1);
		assert.deepEqual(textEvents(events), ["recovered"]);
		assert.equal(events.filter((event) => event.type === "error").length, 0);
		assert.equal(events.filter((event) => event.type === "done").length, 1);
		const rateLimitNotifies = notifications.filter((n) => n.message.includes(RATE_LIMIT_TOKEN));
		assert.equal(rateLimitNotifies.length, 1, "exactly one rate-limit toast");
		assert.equal(emittedRateLimitEvents.length, 1, "exactly one pi-claude:rate-limit event");
		const { sharedSession } = bridgeStateFor("legacy-recovery");
		assert.equal(sharedSession?.sessionId, "session-legacy", "session persisted on success");
		assert.equal(sharedSession?.needsRebuild, undefined);
	});

	it("surfaces usage-limit copy once and still persists the session", async () => {
		__testSetSdkQueryFactory(() => fakeSdkQuery([
			{ type: "system", subtype: "init", session_id: "session-legacy" },
			{ type: "result", subtype: "error_during_execution", errors: ["You've hit your weekly limit · resets Thursday 4am"] },
		], "legacy", observedState()));

		const events = await collect(streamClaudeAgentSdk(model, context, { sessionId: "legacy-usage-limit" }));
		const errors = events.filter((event) => event.type === "error");
		assert.equal(errors.length, 1);
		assert.match(errors[0].error.errorMessage, /weekly limit/);
		const { sharedSession } = bridgeStateFor("legacy-usage-limit");
		assert.equal(sharedSession?.sessionId, "session-legacy", "session persisted after usage-limit error");
	});

	it("never replays deferred user messages after a terminal failure", async () => {
		// Surfacing a terminal failure ends the Pi stream. A continuation query
		// spawned after that would run with its output invisible while its tool
		// side effects still execute — so the deferred-replay loop must not run.
		// The dropped steers must be dropped LOUDLY: the cursor already
		// advanced over them on the promise of replay, so the surviving record
		// must carry needsRebuild (rebuild re-imports them from Pi history) and
		// the drop must be diagnosed.
		let calls = 0;
		__testSetSdkQueryFactory(() => {
			calls += 1;
			return {
				async *[Symbol.asyncIterator]() {
					// Pi injected a steer mid-query; the provider path deferred it.
					ctx().deferredUserMessages.push({ text: "queued steer" });
					yield { type: "system", subtype: "init", session_id: "session-legacy" };
					for (const message of STREAMED_TEXT("partial work")) yield message;
					yield { type: "result", subtype: "error_max_turns", errors: ["max turns exceeded"] };
				},
				close() {},
				async interrupt() {},
			};
		});

		const events = await collect(streamClaudeAgentSdk(model, context, { sessionId: "deferred-terminal" }));
		assert.equal(calls, 1, "no continuation query may be spawned after a surfaced failure");
		assert.equal(events.filter((event) => event.type === "error").length, 1);
		const { sharedSession } = bridgeStateFor("deferred-terminal");
		assert.equal(sharedSession?.sessionId, "session-legacy", "session record still persisted");
		assert.equal(sharedSession?.needsRebuild, true, "record with dropped steers behind its cursor must rebuild");
		const diag = readDiagLog();
		assert.match(diag, /deferred_user_messages_dropped/, "the drop must be diagnosed");
		// the entry records count + text length — never the steer's content.
		assert.doesNotMatch(diag, /queued steer/, "no user-authored text in the diagnostic");
		assert.match(diag, /"textLengths":\[12\]/, "the entry records the dropped steer's length");
	});

	it("surfaces other non-success result subtypes as an explicit error and persists the session", async () => {
		// error_max_turns and error_during_execution must surface while session
		// bookkeeping remains intact.
		__testSetSdkQueryFactory(() => fakeSdkQuery([
			{ type: "system", subtype: "init", session_id: "session-legacy" },
			...STREAMED_TEXT("partial work"),
			{ type: "result", subtype: "error_max_turns", errors: ["max turns exceeded"] },
		], "legacy", observedState()));

		const events = await collect(streamClaudeAgentSdk(model, context, { sessionId: "legacy-max-turns" }));
		const errors = events.filter((event) => event.type === "error");
		assert.equal(errors.length, 1);
		assert.match(errors[0].error.errorMessage, /max turns/);
		const { sharedSession } = bridgeStateFor("legacy-max-turns");
		assert.equal(sharedSession?.sessionId, "session-legacy");
		assert.equal(sharedSession?.needsRebuild, undefined);
	});
});

describe("managed account stream rotation", () => {
	it("retries a rejected pre-output request on the next profile without leaking the first attempt", async () => {
		const observed = observedState();
		globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL] = makeRouter(observed);
		let calls = 0;
		__testSetSdkQueryFactory((input) => {
			observed.queryEnvs.push(input.options.env);
			calls += 1;
			if (calls === 1) {
				return fakeSdkQuery([
					{ type: "system", subtype: "init", session_id: "session-a" },
					{
						type: "rate_limit_event",
						rate_limit_info: {
							status: "rejected",
							rateLimitType: "five_hour",
							resetsAt: new Date(Date.now() + 60_000).toISOString(),
						},
					},
					{
						type: "assistant",
						error: "rate_limit",
						message: {
							model: "<synthetic>",
							content: [{ type: "text", text: "You've hit your session limit" }],
							usage: { input_tokens: 0, output_tokens: 0 },
						},
					},
					{ type: "result", subtype: "success", result: "You've hit your session limit" },
				], "a", observed);
			}
			return fakeSdkQuery([
				{ type: "system", subtype: "init", session_id: "session-b" },
				{ type: "result", subtype: "success", result: "ok-from-b" },
			], "b", observed);
		});

		const events = await collect(streamClaudeAgentSdk(model, context, { sessionId: "pi-session" }));
		assert.equal(calls, 2);
		assert.equal(observed.acquires.length, 2);
		assert.deepEqual(observed.acquires[1].excludedProfileIds, ["a"]);
		assert.deepEqual(observed.queryEnvs.map((env) => env.CLAUDE_CONFIG_DIR), [
			"/profiles/a", "/profiles/b",
		]);
		// Managed children never inherit the host's Claude OAuth token.
		assert.ok(observed.queryEnvs.every((env) => env.CLAUDE_CODE_OAUTH_TOKEN === undefined));
		assert.deepEqual(textEvents(events), ["ok-from-b"]);
		assert.equal(events.filter((event) => event.type === "error").length, 0);
		assert.equal(events.filter((event) => event.type === "start").length, 1);
		assert.equal(observed.rateLimits[0].profileId, "a");
		assert.deepEqual(observed.successes, ["b"]);
	});

	it("completes a rejected rate limit + in-place recovery without rotating or erroring", async () => {
		// Managed twin of the B1 legacy test: the CLI's own fallback recovery
		// clears the held failure; the router still learns the rate limit.
		const observed = observedState();
		globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL] = makeRouter(observed);
		let calls = 0;
		__testSetSdkQueryFactory(() => {
			calls += 1;
			return fakeSdkQuery([
				{ type: "system", subtype: "init", session_id: "session-a" },
				{
					type: "rate_limit_event",
					rate_limit_info: {
						status: "rejected",
						rateLimitType: "five_hour",
						resetsAt: new Date(Date.now() + 60_000).toISOString(),
					},
				},
				...STREAMED_TEXT("recovered-managed"),
				{ type: "result", subtype: "success", result: "recovered-managed" },
			], "a", observed);
		});

		const events = await collect(streamClaudeAgentSdk(model, context, { sessionId: "managed-recovery" }));
		assert.equal(calls, 1);
		assert.deepEqual(textEvents(events), ["recovered-managed"]);
		assert.equal(events.filter((event) => event.type === "error").length, 0);
		assert.equal(observed.rateLimits.length, 1);
		assert.deepEqual(observed.successes, ["a"]);
	});

	it("rotates on a pre-output network failure", async () => {
		const observed = observedState();
		globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL] = makeRouter(observed);
		let calls = 0;
		__testSetSdkQueryFactory((input) => {
			observed.queryEnvs.push(input.options.env);
			calls += 1;
			return calls === 1
				? fakeSdkQuery([
					{ type: "system", subtype: "init", session_id: "session-a" },
					new Error("socket timeout before response"),
				], "a", observed)
				: fakeSdkQuery([
					{ type: "system", subtype: "init", session_id: "session-b" },
					{ type: "result", subtype: "success", result: "network-recovered" },
				], "b", observed);
		});

		const events = await collect(streamClaudeAgentSdk(model, context, { sessionId: "network-session" }));
		assert.equal(calls, 2);
		assert.deepEqual(observed.failures, [{ profileId: "a", kind: "network" }]);
		assert.ok(textEvents(events).includes("network-recovered"));
		assert.equal(events.some((event) => event.type === "error"), false);
	});

	it("terminates the stream when an abort lands after a rotation retry was queued", async () => {
		// requestRotation discards the attempt buffer and nulls currentPiStream;
		// only the retry re-entry ends the outer stream. An abort in the window
		// between queueing the retry and starting it must still terminate the
		// stream — silently skipping the retry left the consumer hanging forever.
		const observed = observedState();
		globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL] = makeRouter(observed);
		const controller = new AbortController();
		let calls = 0;
		__testSetSdkQueryFactory(() => {
			calls += 1;
			const sdkQuery = fakeSdkQuery([
				{ type: "system", subtype: "init", session_id: "session-a" },
				new Error("socket timeout before response"),
			], "a", observed);
			const innerClose = sdkQuery.close.bind(sdkQuery);
			// The teardown between "retry queued" and "retry started" closes the
			// failed attempt's query — aborting there lands in exactly the window
			// under test.
			sdkQuery.close = () => {
				controller.abort();
				innerClose();
			};
			return sdkQuery;
		});

		const events = await collect(streamClaudeAgentSdk(model, context, {
			sessionId: "abort-after-queued-retry",
			signal: controller.signal,
		}));
		assert.equal(calls, 1, "the queued retry must not start after the abort");
		const last = events[events.length - 1];
		assert.equal(last?.type, "error");
		assert.equal(last?.reason, "aborted");
	});

	it("surfaces a mid-retry throw as an error event instead of ending the stream silently", async () => {
		// A throw while forwarding the rotated attempt's events must surface
		// instead of ending the stream
		// FIRST and the pipeline .catch then pushed its error event into an
		// already-ended stream — a silent drop. The consumer read a failed
		// rotation as a normal completion.
		const observed = observedState();
		globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL] = makeRouter(observed);
		let calls = 0;
		__testSetSdkQueryFactory(() => {
			calls += 1;
			return calls === 1
				? fakeSdkQuery([
					{ type: "system", subtype: "init", session_id: "session-a" },
					new Error("socket timeout before response"),
				], "a", observed)
				: fakeSdkQuery([
					{ type: "system", subtype: "init", session_id: "session-b" },
					...STREAMED_TEXT("from-b"),
					{ type: "result", subtype: "success", result: "from-b" },
				], "b", observed);
		});

		const stream = streamClaudeAgentSdk(model, context, { sessionId: "mid-retry-throw" });
		// Model the transport dying mid-retry: the first visible event forwarded
		// from the rotated attempt blows up inside the retry drain loop.
		const push = stream.push.bind(stream);
		let armed = true;
		stream.push = (event) => {
			if (armed && event.type === "text_delta") {
				armed = false;
				throw new Error("mid-retry transport failure");
			}
			return push(event);
		};

		const events = await collect(stream);
		assert.equal(calls, 2, "the rotation retry started");
		const errors = events.filter((event) => event.type === "error");
		assert.equal(errors.length, 1, "the failed rotation must surface an error event");
		assert.match(errors[0].error.errorMessage, /mid-retry transport failure/);
	});

	it("treats an Extra Usage rejection as a model limit and rotates accounts", async () => {
		const observed = observedState();
		globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL] = makeRouter(observed);
		let calls = 0;
		__testSetSdkQueryFactory(() => {
			calls += 1;
			return calls === 1
				? fakeSdkQuery([
					{ type: "system", subtype: "init", session_id: "session-a" },
					{ type: "assistant", error: "extra_usage_disabled" },
					{ type: "result", subtype: "success", result: "Extra usage is disabled" },
				], "a", observed)
				: fakeSdkQuery([
					{ type: "system", subtype: "init", session_id: "session-b" },
					{ type: "result", subtype: "success", result: "recovered-without-local-billing-policy" },
				], "b", observed);
		});

		const events = await collect(streamClaudeAgentSdk(model, context, { sessionId: "extra-usage-session" }));
		assert.equal(calls, 2);
		assert.deepEqual(observed.failures, [{ profileId: "a", kind: "rate-limit" }]);
		assert.ok(textEvents(events).includes("recovered-without-local-billing-policy"));
		assert.equal(events.some((event) => event.type === "error"), false);
	});

	it("never replays after visible text has committed", async () => {
		const observed = observedState();
		globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL] = makeRouter(observed);
		let calls = 0;
		__testSetSdkQueryFactory(() => {
			calls += 1;
			return fakeSdkQuery([
				{ type: "system", subtype: "init", session_id: "session-a" },
				...STREAMED_TEXT("already-visible"),
				{
					type: "assistant",
					error: "rate_limit",
					message: { model: model.id, content: [{ type: "text", text: "already-visible" }], usage: { input_tokens: 1, output_tokens: 1 } },
				},
				{
					type: "rate_limit_event",
					rate_limit_info: {
						status: "rejected",
						rateLimitType: "five_hour",
						resetsAt: new Date(Date.now() + 60_000).toISOString(),
					},
				},
				{ type: "result", subtype: "error_during_execution", errors: ["rate limit"] },
			], "a", observed);
		});

		const events = await collect(streamClaudeAgentSdk(model, context, { sessionId: "pi-session" }));
		assert.equal(calls, 1);
		assert.equal(observed.acquires.length, 1);
		assert.ok(textEvents(events).includes("already-visible"));
		assert.equal(events.filter((event) => event.type === "error").length, 1);
	});

	it("uses the attempt buffer as a replay guard if context commit state is disturbed", async () => {
		const observed = observedState();
		globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL] = makeRouter(observed);
		let calls = 0;
		__testSetSdkQueryFactory(() => {
			calls += 1;
			return {
				async *[Symbol.asyncIterator]() {
					yield { type: "system", subtype: "init", session_id: "buffer-guard-session" };
					for (const message of STREAMED_TEXT("committed-by-buffer")) yield message;
					// Model the reentrancy race: a different live context received the
					// commit stamp, leaving this attempt context falsely replayable.
					// The buffer's own committed flag must still block the replay.
					ctx().committedOutput = false;
					throw new Error("socket timeout after buffered output");
				},
				close() {},
				async interrupt() {},
				async accountInfo() { return {}; },
				async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() { return {}; },
			};
		});

		const events = await collect(streamClaudeAgentSdk(model, context, { sessionId: "buffer-replay-guard" }));
		assert.equal(calls, 1);
		assert.equal(observed.acquires.length, 1);
		assert.deepEqual(observed.failures, [{ profileId: "a", kind: "network" }]);
		assert.ok(textEvents(events).includes("committed-by-buffer"));
		assert.equal(events.filter((event) => event.type === "error").length, 1);
	});

	it("records a post-output transport failure without replaying the request", async () => {
		const observed = observedState();
		globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL] = makeRouter(observed);
		let calls = 0;
		__testSetSdkQueryFactory(() => {
			calls += 1;
			return fakeSdkQuery([
				{ type: "system", subtype: "init", session_id: "session-a" },
				...STREAMED_TEXT("committed"),
				new Error("socket timeout after output"),
			], "a", observed);
		});

		const events = await collect(streamClaudeAgentSdk(model, context, { sessionId: "post-output-network" }));
		assert.equal(calls, 1);
		assert.deepEqual(observed.failures, [{ profileId: "a", kind: "network" }]);
		assert.ok(textEvents(events).includes("committed"));
		assert.equal(events.filter((event) => event.type === "error").length, 1);
	});

	it("never replays after a child-executed connector call starts", async () => {
		const observed = observedState();
		globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL] = makeRouter(observed);
		let calls = 0;
		__testSetSdkQueryFactory(() => {
			calls += 1;
			return fakeSdkQuery([
				{ type: "system", subtype: "init", session_id: "connector-session" },
				{ type: "stream_event", event: { type: "message_start", message: { model: model.id, usage: { input_tokens: 1 } } } },
				{
					type: "stream_event",
					event: {
						type: "content_block_start",
						index: 0,
						content_block: { type: "tool_use", id: "connector-1", name: "mcp__claude_ai_Gmail__search_threads", input: {} },
					},
				},
				new Error("socket timeout after connector dispatch"),
			], "a", observed);
		});

		const events = await collect(streamClaudeAgentSdk(model, context, { sessionId: "connector-replay-boundary" }));
		assert.equal(calls, 1);
		assert.equal(observed.acquires.length, 1);
		assert.deepEqual(observed.failures, [{ profileId: "a", kind: "network" }]);
		assert.equal(events.filter((event) => event.type === "error").length, 1);
	});

	it("still rotates when only a child-internal built-in (ToolSearch) ran before the failure", async () => {
		// B3: ToolSearch is pure plumbing with no account-visible side effect —
		// it must NOT mark the turn non-rotatable the way a connector call does.
		const observed = observedState();
		globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL] = makeRouter(observed);
		let calls = 0;
		__testSetSdkQueryFactory(() => {
			calls += 1;
			return calls === 1
				? fakeSdkQuery([
					{ type: "system", subtype: "init", session_id: "session-a" },
					{ type: "stream_event", event: { type: "message_start", message: { model: model.id, usage: { input_tokens: 1 } } } },
					{
						type: "stream_event",
						event: {
							type: "content_block_start",
							index: 0,
							content_block: { type: "tool_use", id: "search-1", name: "ToolSearch", input: {} },
						},
					},
					new Error("socket timeout after tool search"),
				], "a", observed)
				: fakeSdkQuery([
					{ type: "system", subtype: "init", session_id: "session-b" },
					{ type: "result", subtype: "success", result: "rotated-after-toolsearch" },
				], "b", observed);
		});

		const events = await collect(streamClaudeAgentSdk(model, context, { sessionId: "toolsearch-rotatable" }));
		assert.equal(calls, 2);
		assert.deepEqual(observed.failures, [{ profileId: "a", kind: "network" }]);
		assert.ok(textEvents(events).includes("rotated-after-toolsearch"));
		assert.equal(events.some((event) => event.type === "error"), false);
	});

	it("uses Opus only after the account router reports every Fable allowance spent", async () => {
		const observed = observedState();
		const fableModel = { ...model, id: "claude-fable-5-1", name: "Claude Fable 5.1" };
		const router = makeRouter(observed);
		router.acquire = (input) => {
			observed.acquires.push(input);
			return {
				profileId: "b",
				label: "account-b",
				configDir: "/profiles/b",
				modelId: "claude-opus-5",
				fallbackReason: "fable-quota",
			};
		};
		globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL] = router;
		let queryOptions;
		__testSetSdkQueryFactory((input) => {
			queryOptions = input.options;
			return fakeSdkQuery([
				{ type: "system", subtype: "init", session_id: "opus-session" },
				{ type: "result", subtype: "success", result: "opus-after-fable" },
			], "b", observed);
		});

		const events = await collect(streamClaudeAgentSdk(fableModel, context, { sessionId: "fable-spent" }));
		assert.equal(queryOptions.model, "claude-opus-5");
		assert.equal(queryOptions.fallbackModel, "claude-opus-4-8");
		assert.equal(queryOptions.env.CLAUDE_CONFIG_DIR, "/profiles/b");
		assert.ok(textEvents(events).includes("opus-after-fable"));
	});

	it("selects registered Fable 5.1 without skipping another managed account", async () => {
		const observed = observedState();
		const getModels = await resolveGetModels(piAi);
		const provider = buildNativeProvider(piAi, buildModels(getModels("anthropic")), streamClaudeAgentSdk);
		const fableModel = provider.getModels()[0];
		assert.equal(fableModel.name, "Claude Fable 5.1");
		globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL] = makeRouter(observed);
		let queryOptions;
		__testSetSdkQueryFactory((input) => {
			queryOptions = input.options;
			return fakeSdkQuery([
				{ type: "system", subtype: "init", session_id: "fable-session" },
				{ type: "result", subtype: "success", result: "fable-first" },
			], "a", observed);
		});

		await collect(provider.streamSimple(fableModel, context, { sessionId: "fable-ready" }));
		assert.equal(queryOptions.model, "claude-fable-5-1");
		assert.equal(queryOptions.fallbackModel, undefined);
	});

	it("surfaces an unavailable pool without starting Claude Code", async () => {
		const observed = observedState();
		const resetAtMs = Date.now() + 60_000;
		globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL] = makeRouter(observed, { unavailable: true, resetAtMs });
		let calls = 0;
		__testSetSdkQueryFactory(() => {
			calls += 1;
			throw new Error("must not start");
		});

		const events = await collect(streamClaudeAgentSdk(model, context, { sessionId: "pi-session" }));
		assert.equal(calls, 0);
		assert.equal(events.length, 1);
		assert.equal(events[0].type, "error");
		assert.match(events[0].error.errorMessage, /No Claude subscription account/);
		assert.equal(events[0].error.resetAtMs, resetAtMs);
		assert.equal(events[0].error.rateLimitType, "all_accounts");
	});

	it("reports an already-aborted request without rotating", async () => {
		const observed = observedState();
		globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL] = makeRouter(observed);
		let calls = 0;
		__testSetSdkQueryFactory(() => {
			calls += 1;
			return fakeSdkQuery([
				{ type: "system", subtype: "init", session_id: "session-a" },
				{ type: "result", subtype: "success", result: "must-not-render" },
			], "a", observed);
		});
		const controller = new AbortController();
		controller.abort();
		const events = await collect(streamClaudeAgentSdk(model, context, {
			sessionId: "aborted-session",
			signal: controller.signal,
		}));
		assert.equal(calls, 1);
		assert.equal(observed.acquires.length, 1);
		assert.equal(events.filter((event) => event.type === "error").length, 1);
		assert.equal(events.find((event) => event.type === "error")?.reason, "aborted");
	});

	it("does not rotate an unclassified invalid request", async () => {
		const observed = observedState();
		globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL] = makeRouter(observed);
		let calls = 0;
		__testSetSdkQueryFactory(() => {
			calls += 1;
			return fakeSdkQuery([
				{ type: "system", subtype: "init", session_id: "session-a" },
				{ type: "result", subtype: "error_during_execution", errors: ["invalid request shape"] },
			], "a", observed);
		});

		const events = await collect(streamClaudeAgentSdk(model, context, { sessionId: "pi-session" }));
		assert.equal(calls, 1);
		assert.equal(observed.acquires.length, 1);
		assert.equal(events.filter((event) => event.type === "error").length, 1);
	});

	it("clears mid-turn rebuild flags after a successful managed completion", async () => {
		// A transient needsRebuild/forceRotate set mid-turn must not survive a
		// completed managed query: success persists a fresh record on purpose.
		const observed = observedState();
		globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL] = makeRouter(observed);
		runInRequestLane("clear-flags", () => __testSetBridgeIntegrityState({
			sharedSession: {
				sessionId: "existing-session",
				cursor: 0,
				cwd: process.cwd(),
				accountProfileId: "a",
				claudeConfigDir: "/profiles/a",
			},
		}));
		__testSetSdkQueryFactory(() => ({
			async *[Symbol.asyncIterator]() {
				yield { type: "system", subtype: "init", session_id: "successful-session" };
				const state = __testGetBridgeIntegrityState().sharedSession;
				if (state) {
					__testSetBridgeIntegrityState({
						sharedSession: { ...state, needsRebuild: true, forceRotate: true },
					});
				}
				yield { type: "result", subtype: "success", result: "success-clears-flags" };
			},
			close() {},
			async interrupt() {},
			async accountInfo() { return { email: "a@example.com", subscriptionType: "max" }; },
			async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() { return {}; },
		}));

		const events = await collect(streamClaudeAgentSdk(model, context, { sessionId: "clear-flags" }));
		assert.ok(textEvents(events).includes("success-clears-flags"));
		const state = bridgeStateFor("clear-flags").sharedSession;
		assert.equal(state?.sessionId, "successful-session");
		assert.equal(state?.accountProfileId, "a");
		assert.equal(state?.claudeConfigDir, "/profiles/a");
		assert.equal(state?.needsRebuild, undefined);
		assert.equal(state?.forceRotate, undefined);
	});
});

describe("reentrant subagent queries and the shared session (C1)", () => {
	it("a foreign short context arriving mid-query never shrinks the parent cursor", async () => {
		// While a parent query is active, a reentrant subagent call routed through
		// this instance lands in the tool-result delivery path carrying ITS OWN
		// short conversation. Writing that context's length would shrink the
		// parent's cursor from 40 down to the foreign context's length.
		const parentRecord = { sessionId: "parent-session-0001", cursor: 40, cwd: "/parent" };
		runInRequestLane("parent", () => __testSetBridgeIntegrityState({ sharedSession: { ...parentRecord } }));
		let release;
		const gate = new Promise((resolve) => { release = resolve; });
		__testSetSdkQueryFactory(() => ({
			async *[Symbol.asyncIterator]() {
				yield { type: "system", subtype: "init", session_id: "parent-live" };
				await gate; // hold the parent query active
				yield { type: "result", subtype: "success", result: "parent-done" };
			},
			close() {},
			async interrupt() {},
		}));

		// Parent turn: fresh query, sets ctx().activeQuery. Rebuild is skipped
		// (single-message context → Case 1), so the seeded record survives sync.
		const parentStream = streamClaudeAgentSdk(model, context, { sessionId: "parent" });
		assert.ok(parentStream);
		await new Promise((resolve) => setTimeout(resolve, 10));
		const before = JSON.stringify(bridgeStateFor("parent").sharedSession);

		// Reentrant call: a subagent's own short [user] conversation (empty text,
		// so nothing is queued for replay — this isolates the cursor guard).
		const subagentStream = streamClaudeAgentSdk(model, contextWithPrompt([
			{ role: "user", content: "", timestamp: Date.now() },
		]), { sessionId: "subagent" });
		assert.ok(subagentStream, "the reentrant call returns a stream");
		const after = bridgeStateFor("parent").sharedSession;
		assert.equal(JSON.stringify(after), before, "parent record must be byte-identical after the reentrant call");
		assert.equal(after?.cursor, 40, "cursor must not shrink to the foreign context's length");

		// Let the parent finish and the whole promise chain settle before the
		// factory is reset, so nothing floats into the next test. (The parent
		// stream itself is left unconsumed: the reentrant delivery re-pointed
		// rendering at the subagent's stream, which is part of what this guard
		// contains — the cursor and record stay correct regardless.)
		release();
		await new Promise((resolve) => setTimeout(resolve, 50));
	});

	it("a subagent-shaped fresh query gets no resume id from the parent record", async () => {
		// A subagent call can also arrive while no query is active (parent idle
		// between turns). Its short [user] context with the parent's large cursor
		// must not CLAMP into a REUSE plan for the parent's Claude session. The
		// plan rejects and the query runs as a clean one-shot.
		runInRequestLane("subagent", () => __testSetBridgeIntegrityState({ sharedSession: { sessionId: "parent-session-0002", cursor: 40, cwd: "/parent" } }));
		let queryOptions;
		__testSetSdkQueryFactory((input) => {
			queryOptions = input.options;
			return fakeSdkQuery([
				{ type: "system", subtype: "init", session_id: "subagent-child" },
				{ type: "result", subtype: "success", result: "subagent-answer" },
			], "legacy", observedState());
		});

		const events = await collect(streamClaudeAgentSdk(model, contextWithPrompt([
			{ role: "user", content: "subagent prompt", timestamp: Date.now() },
		]), { sessionId: "subagent" }));
		assert.equal(queryOptions.resume, undefined, "must not resume the parent's Claude session");
		assert.deepEqual(textEvents(events), ["subagent-answer"]);
	});
});

describe("stream-independent metadata capture (C3)", () => {
	it("captures a terminal result failure that arrives after a tool-use turn ended the stream", async () => {
		// A tool-use message_stop ends the Pi stream (currentPiStream = null). A
		// terminal `result` failure arriving after that boundary was skipped by
		// the stream guard: the attempt looked like a success to the router.
		const observed = observedState();
		globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL] = makeRouter(observed);
		__testSetSdkQueryFactory(() => fakeSdkQuery([
			{ type: "system", subtype: "init", session_id: "session-a" },
			{ type: "stream_event", event: { type: "message_start", message: { id: "m1", model: model.id, usage: { input_tokens: 1 } } } },
			{ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call-1", name: "mytool", input: {} } } },
			{ type: "stream_event", event: { type: "content_block_stop", index: 0 } },
			{ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } } },
			{ type: "stream_event", event: { type: "message_stop" } },
			// Stream is now ended (tool-use boundary) — this must still classify.
			{ type: "result", subtype: "error_during_execution", errors: ["internal server error"] },
		], "a", observed));

		const events = await collect(streamClaudeAgentSdk(model, context, { sessionId: "post-boundary-failure" }));
		// The Pi stream ended at the toolUse boundary, so completion runs after.
		await new Promise((resolve) => setTimeout(resolve, 25));
		assert.ok(events.some((event) => event.type === "done" && event.reason === "toolUse"));
		assert.deepEqual(observed.failures, [{ profileId: "a", kind: "server" }], "failure classified despite the ended stream");
		assert.deepEqual(observed.successes, [], "the attempt must not be recorded as a success");
	});

	it("audits a connector result that arrives after the stream ended instead of 'unobserved'", async () => {
		const auditRecords = [];
		setConnectorCallAuditSink((record) => auditRecords.push(record));
		try {
			__testSetSdkQueryFactory(() => fakeSdkQuery([
				{ type: "system", subtype: "init", session_id: "session-conn" },
				{ type: "stream_event", event: { type: "message_start", message: { id: "m1", model: model.id, usage: { input_tokens: 1 } } } },
				// Child-executed connector call (not mirrored, does not end the turn)…
				{ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "conn-1", name: "mcp__claude_ai_Gmail__search_threads", input: {} } } },
				// …then a Pi tool call that DOES end the Pi turn.
				{ type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "call-1", name: "mytool", input: {} } } },
				{ type: "stream_event", event: { type: "content_block_stop", index: 1 } },
				{ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } } },
				{ type: "stream_event", event: { type: "message_stop" } },
				// Stream is ended; the connector's real result arrives late on a
				// `user` message and must still be observed and audited.
				{ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "conn-1", content: "found 3 threads" }] } },
				{ type: "result", subtype: "success", result: "done" },
			], "legacy", observedState()));

			await collect(streamClaudeAgentSdk(model, context, { sessionId: "late-connector-result" }));
			await new Promise((resolve) => setTimeout(resolve, 25));
			const record = auditRecords.find((entry) => entry.toolUseId === "conn-1");
			assert.ok(record, "the connector call must be audited");
			assert.equal(record.outcome, "ok", "the observed late result must not be recorded as unobserved");
		} finally {
			setConnectorCallAuditSink(undefined);
		}
	});
});

describe("router callback safety (C5/C7)", () => {
	it("counts a rejected rate limit once when the iterator then throws", async () => {
		// The SDK rejects the rate limit as an event and THEN throws out of the
		// iterator. Re-classifying the thrown error lost rateLimitInfo, so
		// recordFailure ran on top of the recordRateLimit the event already
		// delivered — a double-counted cooldown.
		const observed = observedState();
		globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL] = makeRouter(observed);
		let calls = 0;
		__testSetSdkQueryFactory(() => {
			calls += 1;
			return calls === 1
				? fakeSdkQuery([
					{ type: "system", subtype: "init", session_id: "session-a" },
					{
						type: "rate_limit_event",
						rate_limit_info: {
							status: "rejected",
							rateLimitType: "five_hour",
							resetsAt: new Date(Date.now() + 60_000).toISOString(),
						},
					},
					new Error("Claude Code exited before completing the request"),
				], "a", observed)
				: fakeSdkQuery([
					{ type: "system", subtype: "init", session_id: "session-b" },
					{ type: "result", subtype: "success", result: "rotated-after-throw" },
				], "b", observed);
		});

		const events = await collect(streamClaudeAgentSdk(model, context, { sessionId: "throw-after-rate-limit" }));
		assert.equal(calls, 2, "the rate-limited attempt still rotates");
		assert.equal(observed.rateLimits.length, 1, "recordRateLimit exactly once");
		assert.deepEqual(observed.failures, [], "recordFailure must not double-count the same rejection");
		assert.ok(textEvents(events).includes("rotated-after-throw"));
	});

	it("a throwing recordSuccess cannot fail a delivered turn", async () => {
		const observed = observedState();
		const router = makeRouter(observed);
		router.recordSuccess = () => { throw new Error("telemetry exploded"); };
		globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL] = router;
		__testSetSdkQueryFactory(() => fakeSdkQuery([
			{ type: "system", subtype: "init", session_id: "session-a" },
			...STREAMED_TEXT("delivered"),
			{ type: "result", subtype: "success", result: "delivered" },
		], "a", observedState()));

		const events = await collect(streamClaudeAgentSdk(model, context, { sessionId: "throwing-success" }));
		assert.deepEqual(textEvents(events), ["delivered"]);
		assert.equal(events.filter((event) => event.type === "error").length, 0, "no error after a throwing telemetry callback");
		assert.equal(events.filter((event) => event.type === "done").length, 1);
	});
});

describe("account host probe (probeProfile)", () => {
	it("settles within its deadline and kills a stalled probe child", async () => {
		// probeProfile is a published entry point and `signal` is optional: a
		// wedged child (never ends, even after close) must not hang the returned
		// promise forever.
		let closed = false;
		__testSetSdkQueryFactory(() => ({
			async *[Symbol.asyncIterator]() {
				yield { type: "system", subtype: "init", session_id: "probe-session" };
				await new Promise(() => {});
			},
			close() { closed = true; },
			async interrupt() {},
			async accountInfo() {
				return { email: "a@example.com", subscriptionType: "max" };
			},
			async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
				return { subscription_type: "max" };
			},
		}));

		const result = await probeClaudeAccountProfile({
			profile: { profileId: "a", label: "account-a" },
			cwd: process.cwd(),
			deadlineMs: 100,
		});
		assert.deepEqual(result, {});
		assert.equal(closed, true, "the expired probe must kill its child");
	});

	it("spawns the probe child with tool isolation AND a deny-all PreToolUse hook", async () => {
		// The probe runs /usage under bypassPermissions, so tool containment is
		// the only gate — it must carry both layers (C12).
		let probeOptions;
		__testSetSdkQueryFactory((input) => {
			probeOptions = input.options;
			return fakeSdkQuery([{ type: "system", subtype: "init", session_id: "probe-session" }], "a", observedState());
		});

		await probeClaudeAccountProfile({
			profile: { profileId: "a", label: "account-a" },
			cwd: process.cwd(),
			deadlineMs: 500,
		});
		assert.deepEqual(probeOptions.tools, [], "built-in tool set removed");
		assert.ok(probeOptions.disallowedTools.includes("Bash"), "built-ins disallowed");
		const hook = probeOptions.hooks?.PreToolUse?.[0]?.hooks?.[0];
		assert.equal(typeof hook, "function", "deny-all PreToolUse hook registered");
		const out = await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {} }, "t1", { signal: new AbortController().signal });
		assert.equal(out.hookSpecificOutput.permissionDecision, "deny", "every tool call is denied");
	});

	it("returns identity and usage when the probe completes before the deadline", async () => {
		__testSetSdkQueryFactory(() => {
			let closed = false;
			return {
				async *[Symbol.asyncIterator]() {
					if (!closed) yield { type: "system", subtype: "init", session_id: "probe-session" };
				},
				close() { closed = true; },
				async interrupt() { closed = true; },
				async accountInfo() {
					return { email: "a@example.com", organization: "Org", subscriptionType: "max" };
				},
				async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
					return { subscription_type: "max" };
				},
			};
		});

		const result = await probeClaudeAccountProfile({
			profile: { profileId: "a", label: "account-a" },
			cwd: process.cwd(),
		});
		assert.equal(result.identity?.email, "a@example.com");
		assert.deepEqual(result.usage, { subscription_type: "max" });
	});
});
