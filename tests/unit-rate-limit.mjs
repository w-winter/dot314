/**
 * Tests for Claude SDK rate-limit event rendering.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_STREAM_IDLE_TIMEOUT_MS,
	STREAM_IDLE_BACKOFF_HINT_MS,
	buildStreamIdleTimeoutErrorMessage,
	createStreamIdleWatchdog,
	formatAllowedRateLimitWarning,
	formatResetTimestamp,
	normalizeRateLimitUtilization,
	resetTimestampMs,
	streamIdleTimeoutMsFromEnv,
} from "../src/index.ts";

describe("rate-limit reset timestamps", () => {
	// SDKRateLimitInfo.resetsAt is a bare number in epoch SECONDS. Treating it
	// as milliseconds rendered "resets Jan 21, 1970" for a Jul 2026 reset.
	const JUL_30_2026_SECONDS = 1785412800;

	it("treats a bare numeric resetsAt as epoch seconds", () => {
		assert.equal(resetTimestampMs(JUL_30_2026_SECONDS), JUL_30_2026_SECONDS * 1000);
		assert.match(formatResetTimestamp(JUL_30_2026_SECONDS), /2026/);
		assert.doesNotMatch(formatResetTimestamp(JUL_30_2026_SECONDS), /1970/);
	});

	it("passes epoch milliseconds through unchanged", () => {
		assert.equal(resetTimestampMs(JUL_30_2026_SECONDS * 1000), JUL_30_2026_SECONDS * 1000);
		assert.match(formatResetTimestamp(JUL_30_2026_SECONDS * 1000), /2026/);
	});

	it("parses ISO strings and rejects garbage", () => {
		assert.equal(resetTimestampMs("2026-07-30T11:00:00Z"), Date.parse("2026-07-30T11:00:00Z"));
		assert.equal(resetTimestampMs("not a date"), undefined);
		assert.equal(resetTimestampMs(undefined), undefined);
		assert.equal(formatResetTimestamp(undefined), "unknown");
	});
});

describe("rate_limit_event allowed_warning", () => {
	it("suppresses low fractional utilization for seven_day warnings", () => {
		const warning = formatAllowedRateLimitWarning({
			status: "allowed_warning",
			rateLimitType: "seven_day",
			utilization: 0.01,
		});

		assert.equal(warning, undefined);
	});

	// Exact 1 falls between the fractional (0<v<1) and percent (1<v<=100)
	// branches unless handled directly, which suppresses the warning.
	// at precisely 100% utilization. It now reads as the fractional form (100%):
	// the fail-closed direction, since under the percent convention 1% is below
	// the threshold anyway and nothing is lost by warning.
	it("warns at exact 1, read as the fractional form (100%)", () => {
		const warning = formatAllowedRateLimitWarning({
			status: "allowed_warning",
			rateLimitType: "seven_day",
			utilization: 1,
		});

		assert.equal(warning, "Claude rate limit warning: nearing seven_day limit; check Claude Code /usage for exact utilization.");
	});

	it("normalizes the full boundary matrix", () => {
		assert.equal(normalizeRateLimitUtilization(0), 0);
		assert.equal(normalizeRateLimitUtilization(0.5), 50);
		assert.equal(normalizeRateLimitUtilization(1), 100);
		assert.equal(normalizeRateLimitUtilization(1.5), 1.5);
		assert.equal(normalizeRateLimitUtilization(100), 100);
		assert.equal(normalizeRateLimitUtilization(101), undefined);
		assert.equal(normalizeRateLimitUtilization(NaN), undefined);
		assert.equal(normalizeRateLimitUtilization(-1), undefined);
		assert.equal(normalizeRateLimitUtilization("91"), undefined);
		assert.equal(normalizeRateLimitUtilization(undefined), undefined);
	});

	it("normalizes fractional and percent values before thresholding", () => {
		assert.equal(normalizeRateLimitUtilization(0.91), 91);
		assert.equal(normalizeRateLimitUtilization(91), 91);
		assert.equal(
			formatAllowedRateLimitWarning({
				status: "allowed_warning",
				rateLimitType: "seven_day",
				utilization: 0.91,
			}),
			"Claude rate limit warning: nearing seven_day limit; check Claude Code /usage for exact utilization.",
		);
	});
});

describe("stream-idle timeout", () => {
	it("parses env timeout with seconds default and disable value", () => {
		assert.equal(streamIdleTimeoutMsFromEnv({}), DEFAULT_STREAM_IDLE_TIMEOUT_MS);
		assert.equal(streamIdleTimeoutMsFromEnv({ CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT: "45" }), 45_000);
		assert.equal(streamIdleTimeoutMsFromEnv({ CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT: "250ms" }), 250);
		assert.equal(streamIdleTimeoutMsFromEnv({ CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT: "2m" }), 120_000);
		assert.equal(streamIdleTimeoutMsFromEnv({ CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT: "0" }), 0);
		assert.equal(streamIdleTimeoutMsFromEnv({ CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT: "bogus" }), DEFAULT_STREAM_IDLE_TIMEOUT_MS);
	});

	it("builds an error that existing rate-limit classifiers can detect", () => {
		const message = buildStreamIdleTimeoutErrorMessage(90_000);
		assert.match(message, /stream idle timeout/i);
		assert.match(message, /529 overloaded\/rate limit/i);
		assert.match(message, new RegExp(String(STREAM_IDLE_BACKOFF_HINT_MS / 1000)));
	});

	it("fires after the timeout of silence from Claude Code", () => {
		let now = 0;
		const timers = [];
		const state = {
			activeQuery: {},
			currentPiStream: {},
			turnOutput: { timestamp: 0 },
			waitingToolCalls: 0,
		};
		const timeouts = [];
		const watchdog = createStreamIdleWatchdog({
			clearTimer: (timer) => { timer.cancelled = true; },
			getState: () => state,
			now: () => now,
			onTimeout: (info) => timeouts.push(info),
			setTimer: (fn, delayMs) => {
				const timer = { cancelled: false, delayMs, fn };
				timers.push(timer);
				return timer;
			},
			timeoutMs: 1_000,
		});

		watchdog.refresh();
		assert.equal(timers.at(-1).delayMs, 1_000);
		now = 400;
		watchdog.noteChunk();
		assert.equal(timers.at(-1).delayMs, 1_000);
		now = 1_399;
		timers.at(-1).fn();
		assert.equal(timeouts.length, 0);
		assert.equal(timers.at(-1).delayMs, 1);
		now = 1_400;
		timers.at(-1).fn();
		assert.deepEqual(timeouts, [{ idleMs: 1_000, timeoutMs: 1_000 }]);
		assert.equal(watchdog.timedOut(), true);
	});

	// A fake clock that runs every armed timer as time passes, so a test can
	// state "N ms of silence" without knowing how the watchdog re-arms.
	function clockedWatchdog(state, timeoutMs = 1_000) {
		let now = 0;
		let timer = null;
		const timeouts = [];
		const watchdog = createStreamIdleWatchdog({
			clearTimer: (handle) => { if (timer === handle) timer = null; },
			getState: () => state,
			now: () => now,
			onTimeout: (info) => timeouts.push(info),
			setTimer: (fn, delayMs) => (timer = { at: now + delayMs, fn }),
			timeoutMs,
		});
		const advance = (ms) => {
			const until = now + ms;
			while (timer && timer.at <= until) {
				const due = timer;
				timer = null;
				now = due.at;
				due.fn();
			}
			now = until;
		};
		return { watchdog, timeouts, advance };
	}
	const liveState = () => ({ activeQuery: {}, currentPiStream: {}, turnOutput: { timestamp: 0 }, waitingToolCalls: 0 });

	it("still fires when Claude Code goes silent after its output started", () => {
		const { watchdog, timeouts, advance } = clockedWatchdog(liveState());
		watchdog.refresh();
		advance(300);
		watchdog.noteChunk(); // first text delta
		advance(999);
		assert.equal(timeouts.length, 0);
		advance(1);
		assert.equal(timeouts.length, 1);
	});

	it("never fires while an MCP handler waits on Pi, and restarts the clock when it is answered", () => {
		const state = liveState();
		const { watchdog, timeouts, advance } = clockedWatchdog(state);
		watchdog.refresh();
		state.waitingToolCalls = 1;
		advance(60_000);
		assert.equal(timeouts.length, 0);
		state.waitingToolCalls = 0;
		advance(900);
		assert.equal(timeouts.length, 0, "silence is only counted from the end of the wait");
		advance(2_000);
		assert.equal(timeouts.length, 1);
	});

	it("never fires while Pi holds no stream because it is executing a tool", () => {
		const state = liveState();
		const { watchdog, timeouts, advance } = clockedWatchdog(state);
		watchdog.refresh();
		state.currentPiStream = null;
		advance(60_000);
		assert.equal(timeouts.length, 0);
	});

	it("grants the backoff an API retry notice announces", () => {
		const { watchdog, timeouts, advance } = clockedWatchdog(liveState());
		watchdog.refresh();
		watchdog.noteChunk(5_000);
		advance(5_999);
		assert.equal(timeouts.length, 0);
		advance(1);
		assert.equal(timeouts.length, 1);
	});
});
