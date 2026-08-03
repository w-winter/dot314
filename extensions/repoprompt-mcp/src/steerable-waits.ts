import type { RpAppId } from "./types.js";

// Subscriber-side mirror of a versioned event owned and published by the separate pi-queue-steer
// extension, which documents the channel name, payload schema, and content-free guarantee in its
// README. Nothing here requires that extension: when it is absent the channel is simply silent and
// steering is detected through Pi's own pending-message transition instead. Treat the literals below
// as a published contract, and follow the producer's version suffix rather than reinterpreting v1.
export const QUEUE_STEER_ACCEPTED_EVENT = "pi-queue-steer:accepted-steer:v1";

interface QueueSteerAcceptedEventV1 {
  readonly version: 1;
  readonly producer: "pi-queue-steer";
  readonly producerEpochId: string;
  readonly sessionId: string;
  readonly sequence: number;
}

export interface SteeringWaitObserver {
  readonly signal: AbortSignal;
  dispose(): void;
}

interface StockSteerCandidate {
  readonly sessionId: string;
  readonly generation: number;
  readonly observerIds: readonly number[];
  readonly timerHandle: unknown;
}

export interface SteeringWaitCoordinatorOptions {
  readonly schedule?: (callback: () => void) => unknown;
  readonly cancelScheduled?: (timerHandle: unknown) => void;
}

const QUEUE_STEER_EVENT_KEYS = [
  "producer",
  "producerEpochId",
  "sequence",
  "sessionId",
  "version",
] as const;

function parseQueueSteerAcceptedEvent(payload: unknown): QueueSteerAcceptedEventV1 | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }

  const record = payload as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== QUEUE_STEER_EVENT_KEYS.length
    || keys.some((key, index) => key !== QUEUE_STEER_EVENT_KEYS[index])
  ) {
    return null;
  }

  if (
    record.version !== 1
    || record.producer !== "pi-queue-steer"
    || typeof record.producerEpochId !== "string"
    || record.producerEpochId.length === 0
    || typeof record.sessionId !== "string"
    || record.sessionId.length === 0
    || typeof record.sequence !== "number"
    || !Number.isSafeInteger(record.sequence)
    || record.sequence <= 0
  ) {
    return null;
  }

  return {
    version: 1,
    producer: "pi-queue-steer",
    producerEpochId: record.producerEpochId,
    sessionId: record.sessionId,
    sequence: record.sequence,
  };
}

export class SteeringWaitCoordinator {
  private readonly schedule: (callback: () => void) => unknown;
  private readonly cancelScheduled: (timerHandle: unknown) => void;
  private readonly activeObservers = new Map<number, AbortController>();
  private readonly acceptedSequenceByProducerEpoch = new Map<string, number>();
  private readonly stockCandidates: StockSteerCandidate[] = [];
  private currentSessionId: string | null = null;
  private generation = 0;
  private nextObserverId = 1;

  constructor(options: SteeringWaitCoordinatorOptions = {}) {
    this.schedule = options.schedule ?? ((callback) => setTimeout(callback, 0));
    this.cancelScheduled = options.cancelScheduled ?? ((timerHandle) => {
      clearTimeout(timerHandle as ReturnType<typeof setTimeout>);
    });
  }

  beginSession(sessionId: string): void {
    if (sessionId.length === 0) {
      throw new Error("Steering wait session ID must be non-empty");
    }
    this.clearObserversAndCandidates();
    this.acceptedSequenceByProducerEpoch.clear();
    this.currentSessionId = sessionId;
  }

  registerObserver(): SteeringWaitObserver {
    if (!this.currentSessionId) {
      throw new Error("Steering wait coordinator has no active Pi session");
    }

    const observerId = this.nextObserverId++;
    const controller = new AbortController();
    this.activeObservers.set(observerId, controller);
    let disposed = false;
    return {
      signal: controller.signal,
      dispose: () => {
        if (disposed) {
          return;
        }
        disposed = true;
        this.activeObservers.delete(observerId);
      },
    };
  }

  observeStockSteerCandidate(input: {
    readonly sessionId: string;
    readonly pendingMessagesBefore: boolean;
    readonly hasPendingMessages: () => boolean;
  }): void {
    if (
      !this.currentSessionId
      || input.sessionId !== this.currentSessionId
      || input.pendingMessagesBefore
      || this.activeObservers.size === 0
    ) {
      return;
    }

    const generation = this.generation;
    const observerIds = [...this.activeObservers.keys()];
    let candidate!: StockSteerCandidate;
    const timerHandle = this.schedule(() => {
      this.removeStockCandidate(candidate, false);
      if (
        this.currentSessionId !== candidate.sessionId
        || this.generation !== candidate.generation
        || !input.hasPendingMessages()
      ) {
        return;
      }
      this.interruptObservers(candidate.observerIds);
    });
    candidate = {
      sessionId: input.sessionId,
      generation,
      observerIds,
      timerHandle,
    };
    this.stockCandidates.push(candidate);
  }

  observeQueueSteerAccepted(payload: unknown): void {
    const event = parseQueueSteerAcceptedEvent(payload);
    if (!event || !this.currentSessionId || event.sessionId !== this.currentSessionId) {
      return;
    }

    const producerKey = JSON.stringify([event.sessionId, event.producerEpochId]);
    const highestSequence = this.acceptedSequenceByProducerEpoch.get(producerKey) ?? 0;
    if (event.sequence <= highestSequence) {
      return;
    }
    this.acceptedSequenceByProducerEpoch.set(producerKey, event.sequence);

    const candidate = this.stockCandidates.find((item) => item.sessionId === event.sessionId);
    if (candidate) {
      this.removeStockCandidate(candidate, true);
    }
    this.interruptObservers([...this.activeObservers.keys()]);
  }

  invalidateActiveObservers(): void {
    this.clearObserversAndCandidates();
  }

  shutdown(): void {
    this.clearObserversAndCandidates();
    this.acceptedSequenceByProducerEpoch.clear();
    this.currentSessionId = null;
  }

  private interruptObservers(observerIds: readonly number[]): void {
    const controllers: AbortController[] = [];
    for (const observerId of observerIds) {
      const controller = this.activeObservers.get(observerId);
      if (!controller) {
        continue;
      }
      this.activeObservers.delete(observerId);
      controllers.push(controller);
    }
    for (const controller of controllers) {
      controller.abort("accepted_steering");
    }
  }

  private removeStockCandidate(candidate: StockSteerCandidate, cancelTimer: boolean): void {
    const index = this.stockCandidates.indexOf(candidate);
    if (index < 0) {
      return;
    }
    this.stockCandidates.splice(index, 1);
    if (cancelTimer) {
      this.cancelScheduled(candidate.timerHandle);
    }
  }

  private clearObserversAndCandidates(): void {
    this.generation += 1;
    this.activeObservers.clear();
    for (const candidate of this.stockCandidates) {
      this.cancelScheduled(candidate.timerHandle);
    }
    this.stockCandidates.length = 0;
  }
}

export type AgentRunWaitTarget =
  | {
      readonly kind: "single";
      readonly sessionId: string;
    }
  | {
      readonly kind: "any";
      readonly sessionIds: readonly [string, ...string[]];
    };

export type AgentRunCallClassification =
  | {
      readonly kind: "steerable_wait";
      readonly target: AgentRunWaitTarget;
    }
  | { readonly kind: "detached_start" }
  | { readonly kind: "attached_start_unsupported" }
  | { readonly kind: "poll_like" }
  | { readonly kind: "blocking_steer_unsupported" }
  | { readonly kind: "passthrough" };

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function optionalTimeout(record: Readonly<Record<string, unknown>>, field: string): number | null | undefined {
  if (!Object.hasOwn(record, field)) {
    return undefined;
  }
  const value = record[field];
  if (value === undefined) {
    return undefined;
  }
  return finiteNumber(value) ? value : null;
}

/**
 * Whether a RepoPrompt target's explicit agent waits can be interrupted locally by accepted steering.
 *
 * Interrupting a wait aborts the in-flight MCP request, which is only safe where cancelling that request
 * is known to release the observation alone and leave the child session running. That contract is
 * established for RepoPrompt CE. Classic exposes `agent_run` as well, but its cancellation ownership has
 * not been verified, so its waits are forwarded untouched. Both the forwarding gate and the catalog
 * description consume this predicate, so a target can never be advertised as steerable without also
 * being treated as steerable.
 */
export function supportsObserverInterruptibleAgentWait(app: RpAppId): boolean {
  return app === "ce";
}

export function classifyAgentRunCall(args: Readonly<Record<string, unknown>>): AgentRunCallClassification {
  if (!Object.hasOwn(args, "op")) {
    return { kind: "passthrough" };
  }
  const operation = args.op;
  if (operation === "wait") {
    const canonicalKeys = new Set(["op", "session_id", "session_ids", "timeout"]);
    if (Object.keys(args).some((key) => !canonicalKeys.has(key))) {
      return { kind: "passthrough" };
    }
    const timeout = optionalTimeout(args, "timeout");
    if (timeout === null || (timeout !== undefined && timeout < 0)) {
      return { kind: "passthrough" };
    }

    const hasSingleId = Object.hasOwn(args, "session_id");
    const hasMultipleIds = Object.hasOwn(args, "session_ids");
    if (hasSingleId === hasMultipleIds) {
      return { kind: "passthrough" };
    }
    if (hasSingleId) {
      if (typeof args.session_id !== "string" || args.session_id.trim().length === 0) {
        return { kind: "passthrough" };
      }
      return timeout === 0
        ? { kind: "poll_like" }
        : { kind: "steerable_wait", target: { kind: "single", sessionId: args.session_id } };
    }
    if (!Array.isArray(args.session_ids) || args.session_ids.length === 0) {
      return { kind: "passthrough" };
    }
    const sessionIds = Array.from(args.session_ids);
    if (!sessionIds.every((sessionId) => typeof sessionId === "string" && sessionId.trim().length > 0)) {
      return { kind: "passthrough" };
    }
    return timeout === 0
      ? { kind: "poll_like" }
      : {
          kind: "steerable_wait",
          target: { kind: "any", sessionIds: sessionIds as [string, ...string[]] },
        };
  }

  if (operation === "start") {
    if (args.detach !== undefined && typeof args.detach !== "boolean") {
      return { kind: "passthrough" };
    }
    const timeout = optionalTimeout(args, "timeout");
    if (timeout === null || (timeout !== undefined && timeout < 0)) {
      return { kind: "passthrough" };
    }
    if (args.detach === true) {
      return { kind: "detached_start" };
    }
    return timeout === 0 ? { kind: "poll_like" } : { kind: "attached_start_unsupported" };
  }

  if (operation === "steer") {
    if (args.wait !== undefined && typeof args.wait !== "boolean") {
      return { kind: "passthrough" };
    }
    const timeout = optionalTimeout(args, "timeout_seconds");
    if (timeout === null || (timeout !== undefined && timeout < 0)) {
      return { kind: "passthrough" };
    }
    const waiting = args.wait ?? timeout !== undefined;
    if (!waiting || timeout === 0) {
      return { kind: "poll_like" };
    }
    return { kind: "blocking_steer_unsupported" };
  }

  if (operation === "poll") {
    return { kind: "poll_like" };
  }
  return { kind: "passthrough" };
}

export type ObserverInterruptControlErrorCode = "caller_aborted" | "lifecycle_invalidated";

export class ObserverInterruptControlError extends Error {
  readonly code: ObserverInterruptControlErrorCode;

  constructor(code: ObserverInterruptControlErrorCode) {
    super(code);
    this.name = "ObserverInterruptControlError";
    this.code = code;
  }
}

type UpstreamSettlement<T> =
  | { readonly kind: "fulfilled"; readonly value: T }
  | { readonly kind: "rejected"; readonly error: unknown };

type LocalWake = "steering" | ObserverInterruptControlErrorCode;

export async function runObserverInterruptibleCall<T>(input: {
  readonly run: (signal: AbortSignal) => Promise<T>;
  readonly steeringSignal: AbortSignal;
  readonly callerSignal?: AbortSignal;
  readonly lifecycleSignal: AbortSignal;
}): Promise<
  | { readonly kind: "upstream"; readonly value: T }
  | { readonly kind: "interrupted_by_steering" }
> {
  if (input.lifecycleSignal.aborted) {
    throw new ObserverInterruptControlError("lifecycle_invalidated");
  }
  if (input.callerSignal?.aborted) {
    throw new ObserverInterruptControlError("caller_aborted");
  }

  const requestController = new AbortController();
  let upstreamSettlement: UpstreamSettlement<T> | undefined;
  const upstreamPromise = input.run(requestController.signal).then<UpstreamSettlement<T>, UpstreamSettlement<T>>(
    (value) => {
      const settlement = { kind: "fulfilled" as const, value };
      upstreamSettlement = settlement;
      return settlement;
    },
    (error) => {
      const settlement = { kind: "rejected" as const, error };
      upstreamSettlement = settlement;
      return settlement;
    },
  );

  const cleanup: Array<() => void> = [];
  const abortWake = (signal: AbortSignal, wake: LocalWake): Promise<LocalWake> => new Promise((resolve) => {
    if (signal.aborted) {
      resolve(wake);
      return;
    }
    const listener = () => resolve(wake);
    signal.addEventListener("abort", listener, { once: true });
    cleanup.push(() => signal.removeEventListener("abort", listener));
  });

  const wakePromises: Array<Promise<UpstreamSettlement<T> | LocalWake>> = [
    upstreamPromise,
    abortWake(input.lifecycleSignal, "lifecycle_invalidated"),
    abortWake(input.steeringSignal, "steering"),
  ];
  if (input.callerSignal) {
    wakePromises.push(abortWake(input.callerSignal, "caller_aborted"));
  }

  try {
    const winner = await Promise.race(wakePromises);
    if (typeof winner !== "string") {
      if (winner.kind === "rejected") {
        throw winner.error;
      }
      return { kind: "upstream", value: winner.value };
    }

    await Promise.resolve();
    if (upstreamSettlement) {
      if (upstreamSettlement.kind === "rejected") {
        throw upstreamSettlement.error;
      }
      return { kind: "upstream", value: upstreamSettlement.value };
    }

    const localOutcome: LocalWake = input.lifecycleSignal.aborted
      ? "lifecycle_invalidated"
      : input.callerSignal?.aborted
        ? "caller_aborted"
        : input.steeringSignal.aborted
          ? "steering"
          : winner;
    requestController.abort(localOutcome);
    void upstreamPromise.then(() => undefined);

    if (localOutcome === "steering") {
      return { kind: "interrupted_by_steering" };
    }
    throw new ObserverInterruptControlError(localOutcome);
  } finally {
    for (const removeListener of cleanup) {
      removeListener();
    }
  }
}
