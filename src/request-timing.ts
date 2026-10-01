// Per-request timing for the debug log. With CLAUDE_BRIDGE_DEBUG=1 every Pi
// provider request writes one `timing:` JSON line when it settles: where its
// time went (phase offsets from streamSimple entry), why its session sync did
// not reuse, the long bridge-side steps it ran, and the process pressure
// around it. With debug off nothing here runs: no record, no stream wrapper,
// no event-loop monitor, and the step helpers return before measuring.

import { monitorEventLoopDelay, type ELDHistogram } from "node:perf_hooks";
import type { AssistantMessageEvent, AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { DEBUG, debug, debugWriteTotals } from "./debug.ts";
import { peekCtx, type QueryContext } from "./query-state.ts";

/** fresh: a new Claude query. tool-result: Pi's results delivered into the
 *  live query. continuation: Pi's results arriving after the query ended. */
export type RequestKind = "fresh" | "tool-result" | "continuation";

export type TimingPhase =
	| "sync" | "query" | "init" | "firstSdkMessage" | "firstStreamEvent" | "firstDelta"
	| "resultReleased" | "handlerAnswered" | "sdkResult" | "turnEnd" | "settled";

export type TimingStep = "rebuildWrite" | "persist" | "fingerprint" | "digest";

/** The session sync of a fresh query: its path, and when that is not REUSE,
 *  why (session-persistence.ts syncSharedSession) and the reason the record
 *  was marked for rebuild, if it was. */
export interface SyncTiming {
	path: "reuse" | "rebuild" | "clean-start" | "foreign-one-shot";
	cause?: string;
	mark?: string;
	priors?: number;
	missed?: number;
}

export type StepTotals = Partial<Record<TimingStep, { n: number; ms: number }>>;

const DELTA_EVENTS = new Set(["text_delta", "thinking_delta", "toolcall_delta"]);

let nextSeq = 1;

// Process-wide, not per-request state: one shared event-loop monitor runs
// while any request is live, and is reset when the first one starts. On
// globalThis under a versioned symbol, like the lane registries, because a
// parent and a subagent can load separate copies of this module.
interface LoopStoreV1 {
	monitor: ELDHistogram | undefined;
	live: number;
	started: number;
}

const LOOP_STORE_SYMBOL = Symbol.for("kendex.pi.claude-bridge.request-timing-loop.v1");

function loopStore(): LoopStoreV1 {
	const host = globalThis as Record<symbol, unknown>;
	let store = host[LOOP_STORE_SYMBOL] as LoopStoreV1 | undefined;
	if (!store) {
		store = { monitor: undefined, live: 0, started: 0 };
		host[LOOP_STORE_SYMBOL] = store;
	}
	return store;
}

const ms = (value: number): number => Math.round(value * 10) / 10;

export class RequestTiming {
	readonly seq = nextSeq++;
	kind: RequestKind = "fresh";
	sync?: SyncTiming;
	resumed?: boolean;
	queries = 0;
	settled = false;
	/** The request's last `usage:` line, so a repeat is not logged again. */
	lastUsageLine?: string;
	usageRepeats = 0;
	readonly steps: StepTotals = {};
	private readonly t0 = performance.now();
	private readonly phases: Partial<Record<TimingPhase, number>> = {};
	private readonly cpuStart = process.cpuUsage();
	private readonly rssStart = process.memoryUsage.rss();
	private readonly debugStart = debugWriteTotals();
	private readonly startedAt: number;
	private readonly sharedAtStart: boolean;

	constructor(private readonly lane: string | undefined, private readonly model: string, private readonly msgs: number) {
		const loop = loopStore();
		this.startedAt = ++loop.started;
		if (loop.live++ === 0) {
			loop.monitor ??= monitorEventLoopDelay();
			loop.monitor.reset();
			loop.monitor.enable();
		}
		this.sharedAtStart = loop.live > 1;
	}

	/** Records the first time `name` happens in this request. */
	phase(name: TimingPhase): void {
		if (this.settled || this.phases[name] !== undefined) return;
		this.phases[name] = ms(performance.now() - this.t0);
	}

	noteSync(sync: SyncTiming, resumed: boolean): void {
		this.sync = sync;
		this.resumed = resumed;
		this.phase("sync");
	}

	noteQuery(): void {
		this.queries += 1;
		this.phase("query");
	}

	addStep(step: TimingStep, duration: number, count = 1): void {
		addStep(this.steps, step, duration, count);
	}

	/** Every event pushed to the request's Pi stream passes here. */
	observe(event: AssistantMessageEvent): void {
		if (DELTA_EVENTS.has(event.type)) this.phase("firstDelta");
		else if (event.type === "done" || event.type === "error") {
			this.phase("turnEnd");
			this.settle(event.type === "done" ? event.reason : (event.error as { rateLimitType?: unknown }).rateLimitType === "stream_idle" ? "idle-timeout" : event.reason);
		}
	}

	settle(outcome: string): void {
		if (this.settled) return;
		this.phase("settled");
		this.settled = true;
		const cpu = process.cpuUsage(this.cpuStart);
		const debugNow = debugWriteTotals();
		const steps: Record<string, { n: number; ms: number }> = {};
		for (const [step, total] of Object.entries(this.steps)) steps[step] = { n: total.n, ms: ms(total.ms) };
		steps.debugWrite = { n: debugNow.lines - this.debugStart.lines, ms: ms(debugNow.ms - this.debugStart.ms) };
		const loop = loopStore();
		const monitor = loop.monitor!;
		debug(`timing: ${JSON.stringify({
			lane: this.lane ?? null,
			seq: this.seq,
			kind: this.kind,
			model: this.model,
			msgs: this.msgs,
			outcome,
			...(this.sync ? { sync: this.sync } : {}),
			...(this.resumed !== undefined ? { resumed: this.resumed } : {}),
			queries: this.queries,
			phases: this.phases,
			steps,
			// The monitor covers every request live since it was last reset;
			// `shared` says another request overlapped this one.
			loop: {
				maxMs: ms(monitor.max / 1e6),
				p99Ms: ms(monitor.percentile(99) / 1e6),
				shared: this.sharedAtStart || loop.started !== this.startedAt,
			},
			cpu: { userMs: ms(cpu.user / 1000), systemMs: ms(cpu.system / 1000) },
			rssMb: { start: ms(this.rssStart / 1048576), end: ms(process.memoryUsage.rss() / 1048576) },
			usageRepeats: this.usageRepeats,
		})}`);
		if (--loop.live === 0) monitor.disable();
	}
}

function addStep(steps: StepTotals, step: TimingStep, duration: number, count: number): void {
	const total = steps[step] ??= { n: 0, ms: 0 };
	total.n += count;
	total.ms += duration;
}

/** A timing record for the Pi request answered on `stream`, or undefined with
 *  debug off. The stream's push and end are observed for the first delta,
 *  the turn end and the settle; what Pi receives is unchanged. */
export function startRequestTiming(stream: AssistantMessageEventStream, lane: string | undefined, model: string, msgs: number): RequestTiming | undefined {
	if (!DEBUG) return undefined;
	const timing = new RequestTiming(lane, model, msgs);
	const push = stream.push.bind(stream);
	const end = stream.end.bind(stream);
	stream.push = (event) => {
		push(event);
		timing.observe(event);
	};
	stream.end = (result) => {
		end(result);
		timing.settle("ended");
	};
	return timing;
}

/** Makes `timing` the record steps in this query context's lane count
 *  toward, and hands it the steps that ran since the context's previous
 *  request settled (a session persist after Pi's message_end). */
export function attachRequestTiming(c: QueryContext, timing: RequestTiming): void {
	c.timing = timing;
	const carried = c.timingCarry;
	c.timingCarry = undefined;
	if (carried) for (const [step, total] of Object.entries(carried) as Array<[TimingStep, { n: number; ms: number }]>) timing.addStep(step, total.ms, total.n);
}

/** Start of a step measured only under debug; pass the value to stepEnd. */
export function stepStart(): number {
	return DEBUG ? performance.now() : 0;
}

/** Adds a step's duration to the current lane's live request, or carries it
 *  to that lane's next request when none is live. */
export function stepEnd(step: TimingStep, started: number): void {
	if (!DEBUG) return;
	const duration = performance.now() - started;
	const c = peekCtx();
	if (!c) return;
	if (c.timing && !c.timing.settled) c.timing.addStep(step, duration);
	else addStep(c.timingCarry ??= {}, step, duration, 1);
}
