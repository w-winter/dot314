import { type AssistantMessage, type AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { type QueryContext } from "./query-state.js";

export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 90_000;
export const STREAM_IDLE_BACKOFF_HINT_MS = 60_000;
export const STREAM_IDLE_TIMEOUT_ENV = "CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT";

type TimerHandle = ReturnType<typeof setTimeout>;

export interface StreamIdleWatchdogState {
	activeQuery: unknown | null;
	currentPiStream: AssistantMessageEventStream | null;
	turnOutput: AssistantMessage | null;
	turnSawStreamEvent: boolean;
	turnStarted: boolean;
}

export interface StreamIdleTimeoutInfo {
	idleMs: number;
	timeoutMs: number;
}

export interface StreamIdleWatchdog {
	dispose: () => void;
	noteChunk: () => void;
	refresh: () => void;
	timedOut: () => boolean;
}

export const activeStreamIdleWatchdogs = new WeakMap<QueryContext, StreamIdleWatchdog>();

function parseDurationLiteralMs(value: string, defaultUnit: "ms" | "s" = "s"): number | undefined {
	const text = value.trim().toLowerCase();
	if (!text) return undefined;
	if (["off", "false", "disabled", "disable"].includes(text)) return 0;
	const match = text.match(/^(\d+(?:\.\d+)?)\s*(ms|msec|msecs|milliseconds?|s|sec|secs|seconds?|m|min|mins|minutes?)?$/i);
	if (!match) return undefined;
	const amount = Number(match[1]);
	if (!Number.isFinite(amount) || amount < 0) return undefined;
	const unit = (match[2] ?? defaultUnit).toLowerCase();
	const multiplier = ["ms", "msec", "msecs", "millisecond", "milliseconds"].includes(unit)
		? 1
		: ["s", "sec", "secs", "second", "seconds"].includes(unit)
			? 1000
			: ["m", "min", "mins", "minute", "minutes"].includes(unit)
				? 60_000
				: undefined;
	if (multiplier === undefined) return undefined;
	const ms = Math.round(amount * multiplier);
	return Number.isFinite(ms) ? ms : undefined;
}

export function streamIdleTimeoutMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env[STREAM_IDLE_TIMEOUT_ENV]?.trim();
	if (!raw) return DEFAULT_STREAM_IDLE_TIMEOUT_MS;
	return parseDurationLiteralMs(raw, "s") ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
}

export function formatDurationShort(ms: number): string {
	if (ms < 180_000 && ms % 1000 === 0) return `${ms / 1000}s`;
	if (ms % 60_000 === 0) return `${ms / 60_000}m`;
	if (ms % 1000 === 0) return `${ms / 1000}s`;
	return `${ms}ms`;
}

export function buildStreamIdleTimeoutErrorMessage(timeoutMs: number): string {
	return `Claude Code stream idle timeout after ${formatDurationShort(timeoutMs)} with no assistant/tool output; treating stalled stream as retryable 529 overloaded/rate limit condition. Retry after ${formatDurationShort(STREAM_IDLE_BACKOFF_HINT_MS)}.`;
}

export function createStreamIdleWatchdog({
	clearTimer = (timer: TimerHandle) => clearTimeout(timer),
	getState,
	now = () => Date.now(),
	onTimeout,
	setTimer = (fn: () => void, delayMs: number) => setTimeout(fn, delayMs),
	timeoutMs,
}: {
	clearTimer?: (timer: TimerHandle) => void;
	getState: () => StreamIdleWatchdogState;
	now?: () => number;
	onTimeout: (info: StreamIdleTimeoutInfo) => void;
	setTimer?: (fn: () => void, delayMs: number) => TimerHandle;
	timeoutMs: number;
}): StreamIdleWatchdog {
	let disposed = false;
	let lastChunkAt = now();
	let timer: TimerHandle | null = null;
	let didTimeout = false;

	const clear = () => {
		if (!timer) return;
		try { clearTimer(timer); } catch { /* best effort */ }
		timer = null;
	};

	const shouldMonitor = (state: StreamIdleWatchdogState): boolean => Boolean(
		timeoutMs > 0
		&& state.activeQuery
		&& state.currentPiStream
		&& state.turnOutput
		&& !state.turnStarted
		&& !state.turnSawStreamEvent,
	);

	const schedule = () => {
		clear();
		if (disposed || didTimeout || timeoutMs <= 0) return;
		const state = getState();
		if (!shouldMonitor(state)) return;
		const turnStartedAt = typeof state.turnOutput?.timestamp === "number" ? state.turnOutput.timestamp : 0;
		const idleStartedAt = Math.max(lastChunkAt, turnStartedAt);
		const idleMs = Math.max(0, now() - idleStartedAt);
		if (idleMs >= timeoutMs) {
			didTimeout = true;
			onTimeout({ idleMs, timeoutMs });
			return;
		}
		timer = setTimer(schedule, Math.max(1, timeoutMs - idleMs));
		(timer as { unref?: () => void }).unref?.();
	};

	return {
		dispose: () => {
			disposed = true;
			clear();
		},
		noteChunk: () => {
			lastChunkAt = now();
			schedule();
		},
		refresh: schedule,
		timedOut: () => didTimeout,
	};
}
