import assert from "node:assert/strict";
import test from "node:test";

import {
  displayIdentityFor,
  persistedIntentFromAutoSelectionEntry,
  persistedIntentFromBindingEntry,
  ROUTE_SELECTOR_KEYS,
  RouteStore,
} from "../dist/route-state.js";

const WINDOW_IDENTITY = {
  app: "ce",
  windowId: 10,
  workspace: "agent",
  autoDetected: false,
};

const TAB_ROUTE = {
  kind: "tab",
  identity: WINDOW_IDENTITY,
  contextId: "00000000-0000-4000-8000-000000001010",
  tabName: "Routing repair",
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("only a verified tab route yields dispatch selectors", () => {
  const store = new RouteStore();
  assert.equal(store.selectorDecision({}).kind, "blocked");

  store.restoreIntent(WINDOW_IDENTITY);
  assert.equal(store.selectorDecision({}).kind, "blocked");

  store.restoreIntent({ ...WINDOW_IDENTITY, tabContextId: TAB_ROUTE.contextId });
  assert.equal(store.selectorDecision({}).kind, "blocked");

  store.publishVerified(TAB_ROUTE);
  assert.deepEqual(store.selectorDecision({}), {
    kind: "selectors",
    args: { _windowID: 10, context_id: TAB_ROUTE.contextId },
  });
});

test("display identity is derived from one atomic route snapshot", () => {
  const store = new RouteStore();
  store.restoreIntent({ ...WINDOW_IDENTITY, tabContextId: TAB_ROUTE.contextId });

  assert.deepEqual(displayIdentityFor(store.statusSnapshot()), {
    ...WINDOW_IDENTITY,
    stateKind: "intent",
    tabContextId: TAB_ROUTE.contextId,
  });
  assert.equal(store.selectorDecision({}).kind, "blocked");

  store.quarantine("route_disappeared", "The restored tab is absent");
  assert.deepEqual(displayIdentityFor(store.statusSnapshot()), {
    ...WINDOW_IDENTITY,
    stateKind: "quarantined",
    quarantineCause: "route_disappeared",
    quarantineDiagnostic: "The restored tab is absent",
    tabContextId: TAB_ROUTE.contextId,
  });
  assert.equal(store.selectorDecision({}).kind, "blocked");
});

test("both persisted entry families parse as intent only", () => {
  const bindingIntent = persistedIntentFromBindingEntry({
    app: "ce",
    windowId: 10,
    tab: TAB_ROUTE.contextId,
    workspace: "agent",
  }, "ce");
  const autoSelectionIntent = persistedIntentFromAutoSelectionEntry({
    app: "ce",
    windowId: 10,
    tab: TAB_ROUTE.contextId,
    workspace: "agent",
    fullPaths: ["src/index.ts"],
    slicePaths: [],
  }, "ce");

  assert.deepEqual(bindingIntent, {
    app: "ce",
    windowId: 10,
    workspace: "agent",
    tabContextId: TAB_ROUTE.contextId,
  });
  assert.deepEqual(autoSelectionIntent, bindingIntent);

  const store = new RouteStore();
  store.restoreIntent(bindingIntent);
  assert.equal(store.snapshot().kind, "intent");
  assert.equal(store.snapshotVerified(), null);
  assert.equal(store.selectorDecision({}).kind, "blocked");
});

test("caller selectors must match the verified route as one complete set", () => {
  const store = new RouteStore();
  store.publishVerified(TAB_ROUTE);

  assert.deepEqual(ROUTE_SELECTOR_KEYS, ["_windowID", "context_id"]);
  assert.equal(store.selectorDecision({
    callerArgs: { context_id: TAB_ROUTE.contextId },
  }).kind, "conflict");
  assert.equal(store.selectorDecision({
    callerArgs: { _windowID: 10 },
  }).kind, "conflict");
  assert.equal(store.selectorDecision({
    callerArgs: { _windowID: 11, context_id: TAB_ROUTE.contextId },
  }).kind, "conflict");
  assert.deepEqual(store.selectorDecision({
    callerArgs: { _windowID: 10, context_id: TAB_ROUTE.contextId },
  }), {
    kind: "selectors",
    args: { _windowID: 10, context_id: TAB_ROUTE.contextId },
  });
});

test("persistence failure is surfaced without discarding verified live authority", () => {
  const store = new RouteStore();
  const result = store.publishVerified(TAB_ROUTE, () => {
    throw new Error("session storage unavailable");
  });

  assert.equal(result.kind, "published");
  assert.equal(result.persistence, "degraded");
  assert.match(result.diagnostic, /session storage unavailable/u);
  assert.deepEqual(store.snapshotVerified(), TAB_ROUTE);
  assert.match(
    displayIdentityFor(store.statusSnapshot()).persistenceDiagnostic,
    /branch persistence failed/u
  );
  assert.equal(store.selectorDecision({}).kind, "selectors");
});

test("window observations cannot be published as verified authority", () => {
  const store = new RouteStore();
  assert.throws(
    () => store.publishVerified({ kind: "window", identity: WINDOW_IDENTITY }),
    /verified route requires a concrete tab/u
  );
  assert.deepEqual(store.snapshot(), { kind: "unbound" });
  assert.equal(store.selectorDecision({}).kind, "blocked");
});

test("test reset deterministically clears state and coordinator state", async () => {
  const store = new RouteStore();
  store.publishVerified(TAB_ROUTE);
  store.resetForTests();

  assert.deepEqual(store.snapshot(), { kind: "unbound" });
  assert.equal(displayIdentityFor(store.statusSnapshot()), null);
  await store.waitForRoutePublication();
  assert.equal(await store.runRouteChange(async () => "usable"), "usable");
});

test("coordinator serializes publication while ordinary snapshots remain parallel", async () => {
  const store = new RouteStore();
  store.publishVerified(TAB_ROUTE);
  const gate = deferred();
  const order = [];

  const first = store.runRouteChange(async () => {
    order.push("first:start");
    await gate.promise;
    order.push("first:end");
  });
  const second = store.runRouteChange(async () => {
    order.push("second");
  });

  await Promise.resolve();
  assert.deepEqual(store.snapshotVerified(), TAB_ROUTE);
  assert.deepEqual(order, ["first:start"]);

  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first:start", "first:end", "second"]);
});

test("throw and abort paths release coordinator waiters and leave later route changes usable", async () => {
  const store = new RouteStore();
  await assert.rejects(
    store.runRouteChange(async () => {
      throw new Error("reconciliation failed");
    }),
    /reconciliation failed/u
  );
  assert.equal(await store.runRouteChange(async () => "after-throw"), "after-throw");

  const gate = deferred();
  const first = store.runRouteChange(async () => {
    await gate.promise;
  });
  const controller = new AbortController();
  const aborted = store.runRouteChange(async () => "must-not-run", controller.signal);
  const later = store.runRouteChange(async () => "after-abort");
  controller.abort(new Error("cancelled waiter"));
  gate.resolve();

  await first;
  await assert.rejects(aborted, /cancelled waiter/u);
  assert.equal(await later, "after-abort");
});

test("dispatch leases atomically capture immutable selectors and publication generation", async () => {
  const store = new RouteStore();
  store.publishVerified(TAB_ROUTE);

  const issued = await store.issueDispatch({
    callerArgs: { _windowID: 10, context_id: TAB_ROUTE.contextId },
  }, (lease) => lease);
  assert.equal(issued.kind, "issued");
  const lease = issued.lease;
  assert.deepEqual(lease.route, TAB_ROUTE);
  assert.deepEqual(lease.selectors, { _windowID: 10, context_id: TAB_ROUTE.contextId });
  assert.equal(store.ownsDispatchLease(lease), true);

  store.publishVerified({
    kind: "tab",
    identity: { ...WINDOW_IDENTITY, windowId: 11 },
    contextId: "00000000-0000-4000-8000-000000001111",
    tabName: "New route",
  });

  assert.equal(store.ownsDispatchLease(lease), false);
  assert.equal(store.snapshot().kind, "verified");
  assert.equal(store.snapshotVerified().identity.windowId, 11);
});

test("dispatch issue is atomic with route changes while in-flight reads remain parallel", async () => {
  const store = new RouteStore();
  store.publishVerified(TAB_ROUTE);
  const firstRequest = deferred();
  const secondRequest = deferred();
  const order = [];

  const first = await store.issueDispatch({}, () => {
    order.push("first:dispatched");
    return firstRequest.promise;
  });
  const second = await store.issueDispatch({}, () => {
    order.push("second:dispatched");
    return secondRequest.promise;
  });
  const mutation = store.runRouteChange(async () => {
    order.push("mutation");
  });

  await mutation;
  assert.deepEqual(order, ["first:dispatched", "second:dispatched", "mutation"]);
  firstRequest.resolve("first");
  secondRequest.resolve("second");
  assert.deepEqual(await Promise.all([first.request, second.request]), ["first", "second"]);
});
