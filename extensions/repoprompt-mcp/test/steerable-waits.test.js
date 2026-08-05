import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_RUN_WAIT_GUIDANCE,
  QUEUE_STEER_ACCEPTED_EVENT,
  ObserverInterruptControlError,
  SteeringWaitCoordinator,
  classifyAgentRunCall,
  runObserverInterruptibleCall,
  supportsObserverInterruptibleAgentWait,
} from "../dist/steerable-waits.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function controlledCoordinator() {
  let nextTimerId = 1;
  const scheduled = new Map();
  const coordinator = new SteeringWaitCoordinator({
    schedule(callback) {
      const timerId = nextTimerId++;
      scheduled.set(timerId, callback);
      return timerId;
    },
    cancelScheduled(timerId) {
      scheduled.delete(timerId);
    },
  });
  return {
    coordinator,
    flushTimers() {
      const callbacks = [...scheduled.values()];
      scheduled.clear();
      for (const callback of callbacks) callback();
    },
    get scheduledCount() {
      return scheduled.size;
    },
  };
}

function acceptedEvent(sequence = 1, overrides = {}) {
  return {
    version: 1,
    producer: "pi-queue-steer",
    producerEpochId: "epoch-1",
    sessionId: "pi-session-1",
    sequence,
    ...overrides,
  };
}

test("accepted-steer event channel is versioned", () => {
  assert.equal(QUEUE_STEER_ACCEPTED_EVENT, "pi-queue-steer:accepted-steer:v1");
});

test("stock confirmation interrupts only its captured active cohort", () => {
  const harness = controlledCoordinator();
  harness.coordinator.beginSession("pi-session-1");
  const first = harness.coordinator.registerObserver();
  const second = harness.coordinator.registerObserver();
  let pending = false;

  harness.coordinator.observeStockSteerCandidate({
    sessionId: "pi-session-1",
    pendingMessagesBefore: false,
    hasPendingMessages: () => pending,
  });
  first.dispose();
  const later = harness.coordinator.registerObserver();
  pending = true;
  harness.flushTimers();

  assert.equal(first.signal.aborted, false);
  assert.equal(second.signal.aborted, true);
  assert.equal(later.signal.aborted, false);
});

test("stock confirmation requires an attributable false-to-true transition", () => {
  const harness = controlledCoordinator();
  harness.coordinator.beginSession("pi-session-1");
  const observer = harness.coordinator.registerObserver();

  harness.coordinator.observeStockSteerCandidate({
    sessionId: "pi-session-1",
    pendingMessagesBefore: true,
    hasPendingMessages: () => true,
  });
  assert.equal(harness.scheduledCount, 0);

  harness.coordinator.observeStockSteerCandidate({
    sessionId: "pi-session-1",
    pendingMessagesBefore: false,
    hasPendingMessages: () => false,
  });
  harness.flushTimers();
  assert.equal(observer.signal.aborted, false);
});

test("queue event interrupts the current cohort and claims a stock candidate", () => {
  const harness = controlledCoordinator();
  harness.coordinator.beginSession("pi-session-1");
  const observer = harness.coordinator.registerObserver();
  harness.coordinator.observeStockSteerCandidate({
    sessionId: "pi-session-1",
    pendingMessagesBefore: false,
    hasPendingMessages: () => true,
  });

  harness.coordinator.observeQueueSteerAccepted(acceptedEvent());

  assert.equal(observer.signal.aborted, true);
  assert.equal(harness.scheduledCount, 0);
  const later = harness.coordinator.registerObserver();
  harness.flushTimers();
  assert.equal(later.signal.aborted, false);
});

test("no-active duplicate stale and content-bearing queue events cannot affect a future wait", () => {
  const harness = controlledCoordinator();
  harness.coordinator.beginSession("pi-session-1");
  harness.coordinator.observeQueueSteerAccepted(acceptedEvent(2));
  const observer = harness.coordinator.registerObserver();

  harness.coordinator.observeQueueSteerAccepted(acceptedEvent(2));
  harness.coordinator.observeQueueSteerAccepted(acceptedEvent(1));
  harness.coordinator.observeQueueSteerAccepted(acceptedEvent(3, { text: "private steering" }));
  harness.coordinator.observeQueueSteerAccepted(acceptedEvent(3, { sessionId: "other-session" }));

  assert.equal(observer.signal.aborted, false);
});

test("queue event parser rejects every malformed or content-bearing payload shape", () => {
  const invalidPayloads = [
    null,
    [],
    "event",
    {},
    acceptedEvent(1, { version: 2 }),
    acceptedEvent(1, { producer: "another-extension" }),
    acceptedEvent(1, { producerEpochId: "" }),
    acceptedEvent(1, { producerEpochId: 42 }),
    acceptedEvent(1, { sessionId: "" }),
    acceptedEvent(1, { sessionId: 42 }),
    acceptedEvent(0),
    acceptedEvent(-1),
    acceptedEvent(1.5),
    acceptedEvent(Number.MAX_SAFE_INTEGER + 1),
    acceptedEvent(1, { sequence: "1" }),
    acceptedEvent(1, { text: "private steering" }),
    {
      version: 1,
      producer: "pi-queue-steer",
      producerEpochId: "epoch-1",
      sessionId: "pi-session-1",
      renamedSequence: 1,
    },
  ];

  for (const payload of invalidPayloads) {
    const harness = controlledCoordinator();
    harness.coordinator.beginSession("pi-session-1");
    const observer = harness.coordinator.registerObserver();
    harness.coordinator.observeQueueSteerAccepted(payload);
    assert.equal(observer.signal.aborted, false, JSON.stringify(payload));
  }
});

test("lifecycle invalidation disarms observers and timers without reporting steering", () => {
  const harness = controlledCoordinator();
  harness.coordinator.beginSession("pi-session-1");
  const observer = harness.coordinator.registerObserver();
  harness.coordinator.observeStockSteerCandidate({
    sessionId: "pi-session-1",
    pendingMessagesBefore: false,
    hasPendingMessages: () => true,
  });

  harness.coordinator.invalidateActiveObservers();
  assert.equal(observer.signal.aborted, false);
  assert.equal(harness.scheduledCount, 0);

  const later = harness.coordinator.registerObserver();
  harness.coordinator.observeQueueSteerAccepted(acceptedEvent());
  assert.equal(later.signal.aborted, true);
});

test("session transitions reject prior-session events", () => {
  const harness = controlledCoordinator();
  harness.coordinator.beginSession("pi-session-1");
  harness.coordinator.observeQueueSteerAccepted(acceptedEvent());
  harness.coordinator.beginSession("pi-session-2");
  const observer = harness.coordinator.registerObserver();
  harness.coordinator.observeQueueSteerAccepted(acceptedEvent(2));
  assert.equal(observer.signal.aborted, false);
});

test("agent_run guidance assigns RepoPrompt CE wait scheduling to the extension", () => {
  assert.match(AGENT_RUN_WAIT_GUIDANCE, /RepoPrompt CE Agent Mode/u);
  assert.match(AGENT_RUN_WAIT_GUIDANCE, /scheduled automatically/u);
  assert.match(AGENT_RUN_WAIT_GUIDANCE, /current Pi parent model's prompt-cache policy/u);
  assert.match(AGENT_RUN_WAIT_GUIDANCE, /child keeps running and remains re-waitable/u);
  assert.match(AGENT_RUN_WAIT_GUIDANCE, /timeout:0 polls immediately/u);
  assert.match(AGENT_RUN_WAIT_GUIDANCE, /Attached starts and wait-enabled steer calls/u);
  assert.doesNotMatch(AGENT_RUN_WAIT_GUIDANCE, /timeout:\s*[1-9]\d*/u);
});

test("agent_run classifier wraps only canonical blocking explicit waits", () => {
  assert.deepEqual(classifyAgentRunCall({ op: "wait", session_id: "one" }), {
    kind: "steerable_wait",
    target: { kind: "single", sessionId: "one" },
  });
  assert.deepEqual(classifyAgentRunCall({ op: "wait", session_ids: ["a", "b"], timeout: 10 }), {
    kind: "steerable_wait",
    target: { kind: "any", sessionIds: ["a", "b"] },
  });
  assert.equal(classifyAgentRunCall({ op: "wait", session_id: "one", timeout: 0 }).kind, "poll_like");
  assert.equal(classifyAgentRunCall({ op: "wait", session_id: "one", timeout: -1 }).kind, "passthrough");
  assert.equal(classifyAgentRunCall({ op: "wait", session_id: "one", session_ids: ["two"] }).kind, "passthrough");
  assert.equal(classifyAgentRunCall({ op: "start", detach: true }).kind, "detached_start");
  assert.equal(classifyAgentRunCall({ op: "start" }).kind, "attached_start_unsupported");
  assert.equal(classifyAgentRunCall({ op: "start", timeout: 0 }).kind, "poll_like");
  assert.equal(classifyAgentRunCall({ op: "steer", wait: true }).kind, "blocking_steer_unsupported");
  assert.equal(classifyAgentRunCall({ op: "steer", timeout_seconds: 10 }).kind, "blocking_steer_unsupported");
  assert.equal(classifyAgentRunCall({ op: "steer", wait: false, timeout_seconds: 10 }).kind, "poll_like");
  assert.equal(classifyAgentRunCall({ op: "poll", session_id: "one" }).kind, "poll_like");
  assert.equal(classifyAgentRunCall({ op: "cancel", session_id: "one" }).kind, "passthrough");
  assert.equal(classifyAgentRunCall({ op: "respond", session_id: "one" }).kind, "passthrough");

  const malformedCalls = [
    { op: "wait" },
    { op: "wait", session_id: "" },
    { op: "wait", session_id: "   " },
    { op: "wait", session_ids: [] },
    { op: "wait", session_ids: ["one", "   "] },
    { op: "wait", session_ids: Array(2) },
    { op: "wait", session_ids: ["one", 2] },
    { op: "wait", session_id: "one", session_ids: [] },
    { op: "wait", session_id: "", session_ids: ["one"] },
    { op: "wait", session_id: "one", prompt: "invalid start-only field" },
    { op: "wait", session_id: "one", timeout: "10" },
    { op: "wait", session_id: "one", timeout: Number.NaN },
    { op: "wait", session_id: "one", timeout: Number.POSITIVE_INFINITY },
    { op: "start", detach: "true" },
    { op: "start", timeout: -1 },
    { op: "steer", wait: "true" },
    { op: "steer", timeout_seconds: "10" },
    { op: "steer", timeout_seconds: Number.NaN },
    { op: "steer", timeout_seconds: Number.POSITIVE_INFINITY },
    { op: "steer", timeout_seconds: -1 },
  ];
  for (const malformedCall of malformedCalls) {
    assert.equal(classifyAgentRunCall(malformedCall).kind, "passthrough", JSON.stringify(malformedCall));
  }
  assert.equal(supportsObserverInterruptibleAgentWait("ce"), true);
  assert.equal(supportsObserverInterruptibleAgentWait("classic"), false);
  const inheritedTimeout = Object.assign(Object.create({ timeout: 0 }), { op: "wait", session_id: "one" });
  assert.equal(classifyAgentRunCall(inheritedTimeout).kind, "steerable_wait");
  const inheritedOperation = Object.assign(Object.create({ op: "wait" }), { session_id: "one" });
  assert.equal(classifyAgentRunCall(inheritedOperation).kind, "passthrough");
});

test("agent_run steering aborts only the request observer", async () => {
  const steering = new AbortController();
  const caller = new AbortController();
  const lifecycle = new AbortController();
  let requestSignal;
  let childActive = true;
  let childCancelCalls = 0;

  const resultPromise = runObserverInterruptibleCall({
    run(signal) {
      requestSignal = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
    steeringSignal: steering.signal,
    callerSignal: caller.signal,
    lifecycleSignal: lifecycle.signal,
  });
  steering.abort();

  assert.deepEqual(await resultPromise, { kind: "interrupted_by_steering" });
  assert.equal(requestSignal.aborted, true);
  assert.equal(childActive, true);
  assert.equal(childCancelCalls, 0);

  childActive = false;
  const terminal = await runObserverInterruptibleCall({
    run: async () => ({ status: "completed" }),
    steeringSignal: new AbortController().signal,
    lifecycleSignal: lifecycle.signal,
  });
  assert.deepEqual(terminal, { kind: "upstream", value: { status: "completed" } });
});

test("settled upstream result remains authoritative over same-turn steering", async () => {
  const steering = new AbortController();
  const upstream = deferred();
  const resultPromise = runObserverInterruptibleCall({
    run: () => upstream.promise,
    steeringSignal: steering.signal,
    lifecycleSignal: new AbortController().signal,
  });

  upstream.resolve({ status: "timed_out" });
  steering.abort();
  assert.deepEqual(await resultPromise, { kind: "upstream", value: { status: "timed_out" } });
});

test("lifecycle and caller cancellation remain distinct from steering", async () => {
  for (const expectedCode of ["lifecycle_invalidated", "caller_aborted"]) {
    const caller = new AbortController();
    const lifecycle = new AbortController();
    const steering = new AbortController();
    const resultPromise = runObserverInterruptibleCall({
      run: (signal) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
      steeringSignal: steering.signal,
      callerSignal: caller.signal,
      lifecycleSignal: lifecycle.signal,
    });

    if (expectedCode === "lifecycle_invalidated") {
      steering.abort();
      lifecycle.abort();
    } else {
      steering.abort();
      caller.abort();
    }

    await assert.rejects(resultPromise, (error) => {
      assert.ok(error instanceof ObserverInterruptControlError);
      assert.equal(error.code, expectedCode);
      return true;
    });
  }
});

test("upstream connection failure is not converted to steering", async () => {
  const failure = new Error("connection closed");
  await assert.rejects(
    runObserverInterruptibleCall({
      run: async () => { throw failure; },
      steeringSignal: new AbortController().signal,
      lifecycleSignal: new AbortController().signal,
    }),
    (error) => error === failure,
  );
});
