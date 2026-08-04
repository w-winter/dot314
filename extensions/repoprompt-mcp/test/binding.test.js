import assert from "node:assert/strict";
import test from "node:test";

import {
  autoDetectAndBind,
  bindToTab,
  bindToWindow,
  createAndBindTab,
  ensureBindingHasTab,
  establishRoutingInventoryContract,
  executeRoutingMutation,
  fetchWindowTabs,
  fetchWindows,
  findMatchingWindow,
  getRouteSelectorDecision,
  getRouteState,
  getVerifiedBinding,
  persistBinding,
  reconcileObservedInventoryRoute,
  resetBindingStateForTests,
  restoreBinding,
} from "../dist/binding.js";
import { ROUTING_OBSERVATION_TIMEOUT_MS } from "../dist/routing-inventory.js";
import { BINDING_ENTRY_TYPE, AUTO_SELECTION_ENTRY_TYPE } from "../dist/types.js";
import {
  catalog as ceCatalog,
  inventoryScenarios as ceScenarios,
} from "./fixtures/ce-1.2/evidence.js";
import {
  catalog as classicCatalog,
  inventoryScenarios as classicScenarios,
} from "./fixtures/classic-2.1.32/evidence.js";

function makeTestConfig(overrides = {}) {
  return {
    activeApp: "ce",
    apps: { ce: {}, classic: {} },
    persistBinding: true,
    ...overrides,
  };
}

function makeTextResult(value, isError = false) {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function currentSelectorArgs() {
  const decision = getRouteSelectorDecision({});
  assert.equal(decision.kind, "selectors");
  return decision.args;
}

function makeMockSession(branchEntries = [], appendError = null) {
  const entries = [...branchEntries];
  const pi = {
    appendEntry(customType, data) {
      if (appendError) {
        throw appendError;
      }
      entries.push({ type: "custom", customType, data });
    },
  };
  const ctx = {
    sessionManager: {
      getBranch() {
        return entries;
      },
    },
  };
  return { pi, ctx, entries };
}

function rawTab({ id, name, roots = ["/fixtures/repo"], active = false, bound = false, files = 0 }) {
  return {
    context_id: id,
    name,
    repo_paths: roots,
    is_active: active,
    is_bound: bound,
    selected_file_count: files,
  };
}

function rawInventory({ windowId = 5, workspace = "agent", tabs = [], binding = { kind: "unbound" } }) {
  const rawBinding = binding.kind === "bound"
    ? { binding_kind: "tab_context", context_id: binding.contextId }
    : binding.kind === "window"
      ? { binding_kind: "window", window_id: windowId }
      : { binding_kind: "unbound" };
  return {
    windows: [{ window_id: windowId, workspace: { name: workspace }, tabs }],
    binding: rawBinding,
  };
}

async function createMutableInventoryClient(options = {}) {
  const state = {
    windowId: options.windowId ?? 5,
    workspace: options.workspace ?? "agent",
    tabs: structuredClone(options.tabs ?? []),
    binding: structuredClone(options.binding ?? { kind: "unbound" }),
    calls: [],
    createCount: 0,
    inventoryFailure: null,
  };
  const client = {
    isConnected: true,
    tools: options.tools ?? [
      ...structuredClone(ceCatalog.tools),
      { name: "manage_selection" },
      { name: "oracle_utils" },
    ],
    async callTool(name, args, _timeout, signal) {
      state.calls.push({ name, args, signal });
      if (name === "bind_context" && args.op === "list") {
        if (state.inventoryFailure) {
          return state.inventoryFailure;
        }
        return makeTextResult(rawInventory(state));
      }
      if (name === "bind_context" && args.op === "bind") {
        const target = state.tabs.find((tab) => tab.context_id === args.context_id);
        if (!target) {
          return makeTextResult(`Missing context ${args.context_id}`, true);
        }
        if (options.bindOutcome === "throw") {
          throw new Error("bind transport failed");
        }
        if (options.bindOutcome === "isError") {
          const observedContextId = options.bindErrorObservedContextId;
          if (observedContextId) {
            state.binding = { kind: "bound", contextId: observedContextId };
            for (const tab of state.tabs) {
              tab.is_bound = tab.context_id === observedContextId;
            }
          }
          return makeTextResult("bind rejected", true);
        }
        if (options.bindOutcome !== "mismatch") {
          state.binding = { kind: "bound", contextId: target.context_id };
          for (const tab of state.tabs) {
            tab.is_bound = tab.context_id === target.context_id;
          }
        }
        return makeTextResult({ bound: target.context_id });
      }
      if (name === "manage_workspaces" && args.action === "create_tab") {
        state.createCount += 1;
        if (options.createOutcome === "throw") {
          throw new Error("create transport failed");
        }
        if (options.createOutcome === "isError") {
          const observedContextId = options.createErrorObservedContextId;
          if (observedContextId) {
            state.binding = { kind: "bound", contextId: observedContextId };
            for (const tab of state.tabs) {
              tab.is_bound = tab.context_id === observedContextId;
            }
          }
          return makeTextResult("create rejected", true);
        }
        const created = rawTab({
          id: `TAB-CREATED-${state.createCount}`,
          name: "Created",
          bound: true,
          files: 0,
        });
        for (const tab of state.tabs) {
          tab.is_bound = false;
        }
        state.tabs.push(created);
        state.binding = { kind: "bound", contextId: created.context_id };
        return makeTextResult({ created_context_id: created.context_id });
      }
      if (name === "manage_selection") {
        const tab = state.tabs.find((candidate) => candidate.context_id === args.context_id);
        return makeTextResult(`${tab?.selected_file_count ?? 0} total tokens`);
      }
      if (name === "oracle_utils") {
        if (options.blockOracleSessions) {
          return await new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        }
        return makeTextResult(options.oracleSessions ?? "No Oracle sessions");
      }
      throw new Error(`Unexpected call ${name} ${JSON.stringify(args)}`);
    },
  };
  await establishRoutingInventoryContract(makeTestConfig(), client);
  state.calls.length = 0;
  state.inventoryFailure = options.inventoryFailure ?? null;
  return { client, state };
}

test.afterEach(() => {
  resetBindingStateForTests();
});

test("WI3A canonical inventory is not masked by incomplete workspace inference", async () => {
  const calls = [];
  const client = {
    isConnected: true,
    tools: structuredClone(ceCatalog.tools),
    async callTool(name, args) {
      calls.push({ name, args });
      if (name === "manage_workspaces") {
        return makeTextResult({ showing_window_ids: [2, 10] });
      }
      return makeTextResult(ceScenarios.multiWindow);
    },
  };

  await establishRoutingInventoryContract(makeTestConfig(), client);
  calls.length = 0;
  const windows = await fetchWindows(undefined, makeTestConfig(), client);

  // Old failure reason retained from the red gate: non-empty workspace inference returned [2, 10]
  assert.deepEqual(windows.map((window) => window.id), [2, 10, 11]);
  assert.deepEqual(calls, [{ name: "bind_context", args: { op: "list", _rawJSON: true } }]);
});

test("fetchWindowTabs filters one global inventory locally without window_id", async () => {
  const calls = [];
  const client = {
    isConnected: true,
    tools: structuredClone(ceCatalog.tools),
    async callTool(name, args) {
      calls.push({ name, args });
      return makeTextResult(ceScenarios.multiWindow);
    },
  };

  await establishRoutingInventoryContract(makeTestConfig(), client);
  calls.length = 0;
  const tabs = await fetchWindowTabs(11, client, makeTestConfig());
  assert.deepEqual(tabs.map((tab) => tab.name), ["Tab Eleven"]);
  assert.deepEqual(calls, [{ name: "bind_context", args: { op: "list", _rawJSON: true } }]);
});

test("inventory call failure and malformed success fail closed while valid empty stays empty", async () => {
  async function establishedClientFor(result) {
    let callCount = 0;
    const client = {
      isConnected: true,
      tools: structuredClone(ceCatalog.tools),
      callTool: async () => {
        callCount += 1;
        return callCount === 1 ? makeTextResult(ceScenarios.validEmpty) : result;
      },
    };
    await establishRoutingInventoryContract(makeTestConfig(), client);
    return client;
  }

  const failedClient = await establishedClientFor(makeTextResult("inventory failed", true));
  await assert.rejects(
    fetchWindows(undefined, makeTestConfig(), failedClient),
    /routing inventory unavailable: inventory failed/u
  );

  const malformedClient = await establishedClientFor(makeTextResult("not-json"));
  await assert.rejects(
    fetchWindows(undefined, makeTestConfig(), malformedClient),
    /did not return JSON content/u
  );

  const emptyClient = await establishedClientFor(makeTextResult(ceScenarios.validEmpty));
  assert.deepEqual(await fetchWindows(undefined, makeTestConfig(), emptyClient), []);
});

test("root observation failure keeps the window visible and blocks no-match auto detection", async () => {
  const client = {
    isConnected: true,
    tools: structuredClone(ceCatalog.tools),
    async callTool(name) {
      return name === "bind_context"
        ? makeTextResult(ceScenarios.rootUnavailable)
        : makeTextResult("root probe failed", true);
    },
  };

  await establishRoutingInventoryContract(makeTestConfig(), client);
  const windows = await fetchWindows(undefined, makeTestConfig(), client);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].id, 12);
  assert.deepEqual(windows[0].roots, []);
  assert.equal(windows[0].rootsUnavailableDiagnostic, "root probe failed");
  assert.deepEqual(findMatchingWindow(windows, "/fixtures/unknown").rootsUnavailableWindowIds, [12]);
});

test("both persisted entry families restore intent only and cannot authorize selectors", () => {
  const { ctx } = makeMockSession([
    {
      type: "custom",
      customType: BINDING_ENTRY_TYPE,
      data: { app: "ce", windowId: 5, workspace: "agent" },
    },
    {
      type: "custom",
      customType: AUTO_SELECTION_ENTRY_TYPE,
      data: {
        app: "ce",
        windowId: 5,
        workspace: "agent",
        tab: "TAB-MISSING",
        fullPaths: [],
        slicePaths: [],
      },
    },
  ]);

  const restored = restoreBinding(ctx, makeTestConfig());

  assert.equal(restored.tab, "TAB-MISSING");
  assert.equal(getRouteState().kind, "intent");
  assert.equal(getVerifiedBinding(), null);
  assert.equal(getRouteSelectorDecision({}).kind, "blocked");
});

test("explicit tab bind uses target contract args and publishes only after confirming observation", async () => {
  const { pi, entries } = makeMockSession();
  const { client, state } = await createMutableInventoryClient({
    tabs: [
      rawTab({ id: "TAB-OLD", name: "Old", bound: true }),
      rawTab({ id: "TAB-NEW", name: "New" }),
    ],
    binding: { kind: "bound", contextId: "TAB-OLD" },
  });

  const binding = await bindToTab(pi, 5, "New", makeTestConfig(), client);

  assert.equal(binding.tab, "TAB-NEW");
  assert.deepEqual(
    state.calls.find((call) => call.name === "bind_context" && call.args.op === "bind").args,
    { op: "bind", context_id: "TAB-NEW" }
  );
  assert.equal(entries.at(-1).data.tab, "TAB-NEW");
  assert.equal(getRouteState().kind, "verified");
  assert.deepEqual(currentSelectorArgs(), { _windowID: 5, context_id: "TAB-NEW" });
});

test("explicit window bind selects an observed safe tab and publishes verified tab authority", async () => {
  const { pi } = makeMockSession();
  const { client, state } = await createMutableInventoryClient({
    tabs: [
      rawTab({ id: "TAB-DIRTY", name: "Dirty", bound: true, files: 2 }),
      rawTab({ id: "TAB-SAFE", name: "Safe", files: 0 }),
    ],
    binding: { kind: "bound", contextId: "TAB-DIRTY" },
  });

  const binding = await bindToWindow(pi, 5, undefined, makeTestConfig(), client);

  assert.equal(binding.tab, "TAB-SAFE");
  assert.deepEqual(currentSelectorArgs(), { _windowID: 5, context_id: "TAB-SAFE" });
  assert.equal(getRouteState().route.kind, "tab");
  assert.equal(state.calls.filter((call) => call.args.op === "bind").length, 1);
  assert.equal(state.createCount, 0);
});

test("explicit window bind reverse-scans binding history for the requested window before safe-tab fallback", async () => {
  const { pi, ctx } = makeMockSession([
    {
      type: "custom",
      customType: BINDING_ENTRY_TYPE,
      data: { app: "ce", windowId: 5, workspace: "agent", tab: "TAB-A" },
    },
    {
      type: "custom",
      customType: BINDING_ENTRY_TYPE,
      data: { app: "ce", windowId: 6, workspace: "other", tab: "TAB-B" },
    },
  ]);
  const { client, state } = await createMutableInventoryClient({
    tabs: [
      rawTab({ id: "TAB-A", name: "Historical", files: 2 }),
      rawTab({ id: "TAB-SAFE", name: "Safe", files: 0 }),
    ],
    binding: { kind: "unbound" },
  });

  const binding = await bindToWindow(
    pi,
    5,
    undefined,
    makeTestConfig(),
    client,
    undefined,
    ctx
  );

  assert.equal(binding.tab, "TAB-A");
  assert.deepEqual(currentSelectorArgs(), { _windowID: 5, context_id: "TAB-A" });
  assert.equal(state.createCount, 0);
  assert.equal(
    state.calls.filter((call) => call.name === "bind_context" && call.args.op === "bind").length,
    1
  );
});

test("explicit window bind provisions exactly one background tab when no observed tab is safe", async () => {
  const { pi } = makeMockSession();
  const { client, state } = await createMutableInventoryClient({
    tabs: [rawTab({ id: "TAB-DIRTY", name: "Dirty", bound: true, files: 2 })],
    binding: { kind: "bound", contextId: "TAB-DIRTY" },
  });

  const binding = await bindToWindow(pi, 5, undefined, makeTestConfig(), client);

  assert.equal(binding.tab, "TAB-CREATED-1");
  assert.deepEqual(currentSelectorArgs(), { _windowID: 5, context_id: "TAB-CREATED-1" });
  assert.equal(state.createCount, 1);
  assert.deepEqual(
    state.calls.find((call) => call.name === "manage_workspaces").args,
    { action: "create_tab", window_id: 5, bind: true, focus: false }
  );
});

test("explicit window bind preserves a prior verified route when the requested window is absent", async () => {
  const { pi } = makeMockSession();
  const { client, state } = await createMutableInventoryClient({
    tabs: [rawTab({ id: "TAB-LIVE", name: "Live", bound: true })],
    binding: { kind: "bound", contextId: "TAB-LIVE" },
  });
  await bindToTab(pi, 5, "TAB-LIVE", makeTestConfig(), client);
  const mutationCallsBefore = state.calls.filter(
    (call) => call.args.op === "bind" || call.args.action === "create_tab"
  ).length;

  await assert.rejects(
    bindToWindow(pi, 99, undefined, makeTestConfig(), client),
    /window 99 not found/u
  );

  assert.equal(getRouteState().kind, "verified");
  assert.deepEqual(currentSelectorArgs(), { _windowID: 5, context_id: "TAB-LIVE" });
  assert.equal(
    state.calls.filter((call) => call.args.op === "bind" || call.args.action === "create_tab").length,
    mutationCallsBefore
  );
});

test("explicit tab bind quarantines when fresh observation does not match the requested context", async () => {
  const { pi } = makeMockSession();
  const { client, state } = await createMutableInventoryClient({
    tabs: [
      rawTab({ id: "TAB-OLD", name: "Old", bound: true }),
      rawTab({ id: "TAB-NEW", name: "New" }),
    ],
    binding: { kind: "bound", contextId: "TAB-OLD" },
    bindOutcome: "mismatch",
  });

  await assert.rejects(
    bindToTab(pi, 5, "New", makeTestConfig(), client),
    /did not confirm bound context TAB-NEW/u
  );
  assert.equal(state.calls.filter((call) => call.args.op === "bind").length, 1);
  assert.equal(getRouteState().kind, "quarantined");
});

test("clean explicit bind error never adopts or persists an unrelated observed sticky tab", async () => {
  const { pi, entries } = makeMockSession();
  const { client, state } = await createMutableInventoryClient({
    tabs: [
      rawTab({ id: "TAB-OLD", name: "Old", bound: true }),
      rawTab({ id: "TAB-A", name: "Requested" }),
      rawTab({ id: "TAB-B", name: "Unrelated" }),
    ],
    binding: { kind: "bound", contextId: "TAB-OLD" },
    bindOutcome: "isError",
    bindErrorObservedContextId: "TAB-B",
  });
  await bindToTab(pi, 5, "TAB-OLD", makeTestConfig(), client);
  const persistedBefore = entries.length;

  await assert.rejects(
    bindToTab(pi, 5, "TAB-A", makeTestConfig(), client),
    /bind rejected/u
  );

  assert.equal(state.calls.filter((call) => call.args.op === "bind").length, 1);
  assert.equal(entries.length, persistedBefore);
  assert.equal(entries.some((entry) => entry.data?.tab === "TAB-B"), false);
  assert.equal(getRouteState().kind, "quarantined");
  assert.equal(getRouteSelectorDecision({}).kind, "blocked");
});

test("clean explicit create error never adopts or persists an unrelated observed sticky tab", async () => {
  const { pi, entries } = makeMockSession();
  const { client, state } = await createMutableInventoryClient({
    tabs: [
      rawTab({ id: "TAB-OLD", name: "Old", bound: true, files: 2 }),
      rawTab({ id: "TAB-B", name: "Unrelated" }),
    ],
    binding: { kind: "bound", contextId: "TAB-OLD" },
    createOutcome: "isError",
    createErrorObservedContextId: "TAB-B",
  });
  await bindToTab(pi, 5, "TAB-OLD", makeTestConfig(), client);
  const persistedBefore = entries.length;

  await assert.rejects(
    createAndBindTab(pi, 5, makeTestConfig(), client),
    /create rejected/u
  );

  assert.equal(state.createCount, 1);
  assert.equal(entries.length, persistedBefore);
  assert.equal(entries.some((entry) => entry.data?.tab === "TAB-B"), false);
  assert.equal(getRouteState().kind, "quarantined");
  assert.equal(getRouteSelectorDecision({}).kind, "blocked");
});

test("explicit create quarantines an ambiguous thrown mutation without replay", async () => {
  const { pi } = makeMockSession();
  const { client, state } = await createMutableInventoryClient({
    tabs: [rawTab({ id: "TAB-OLD", name: "Old", bound: true })],
    binding: { kind: "bound", contextId: "TAB-OLD" },
    createOutcome: "throw",
  });

  await assert.rejects(
    createAndBindTab(pi, 5, makeTestConfig(), client),
    /create transport failed/u
  );
  assert.equal(state.createCount, 1);
  assert.equal(getRouteState().kind, "quarantined");
  assert.equal(getRouteState().cause, "ambiguous_mutation_result");
});

test("explicit create binds one background tab and confirms it from fresh inventory", async () => {
  const { pi, entries } = makeMockSession();
  const { client, state } = await createMutableInventoryClient({
    tabs: [rawTab({ id: "TAB-OLD", name: "Old", bound: true, files: 2 })],
    binding: { kind: "bound", contextId: "TAB-OLD" },
  });

  const binding = await createAndBindTab(pi, 5, makeTestConfig(), client);

  assert.equal(binding.tab, "TAB-CREATED-1");
  assert.equal(state.createCount, 1);
  assert.deepEqual(
    state.calls.find((call) => call.name === "manage_workspaces").args,
    { action: "create_tab", window_id: 5, bind: true, focus: false }
  );
  assert.equal(entries.at(-1).data.tab, "TAB-CREATED-1");
});

test("stale persisted UUID is never adopted when inventory observation fails", async () => {
  const { pi, ctx } = makeMockSession([
    {
      type: "custom",
      customType: BINDING_ENTRY_TYPE,
      data: { app: "ce", windowId: 5, workspace: "agent", tab: "TAB-MISSING" },
    },
  ]);
  restoreBinding(ctx, makeTestConfig());
  const { client, state } = await createMutableInventoryClient({
    inventoryFailure: makeTextResult("observation unavailable", true),
  });

  await assert.rejects(
    ensureBindingHasTab(pi, ctx, makeTestConfig(), client),
    /observation unavailable/u
  );
  assert.equal(state.calls.some((call) => call.args.op === "bind"), false);
  assert.equal(state.calls.some((call) => call.args.action === "create_tab"), false);
  assert.equal(getRouteState().kind, "intent");
  assert.equal(getRouteSelectorDecision({}).kind, "blocked");
});

test("stale persisted UUID recovers only through an observed safe candidate", async () => {
  const { pi, ctx, entries } = makeMockSession([
    {
      type: "custom",
      customType: BINDING_ENTRY_TYPE,
      data: { app: "ce", windowId: 5, workspace: "agent", tab: "TAB-MISSING" },
    },
  ]);
  restoreBinding(ctx, makeTestConfig());
  const { client } = await createMutableInventoryClient({
    tabs: [rawTab({ id: "TAB-SAFE", name: "Safe", files: 0 })],
  });

  const binding = await ensureBindingHasTab(pi, ctx, makeTestConfig(), client, {
    recoverIfMissing: true,
  });

  assert.equal(binding.tab, "TAB-SAFE");
  assert.equal(entries.at(-1).data.tab, "TAB-SAFE");
  assert.deepEqual(currentSelectorArgs(), { _windowID: 5, context_id: "TAB-SAFE" });
});

test("abbreviated Oracle tab IDs prevent protected tab reuse", async () => {
  const { pi, ctx } = makeMockSession([
    {
      type: "custom",
      customType: BINDING_ENTRY_TYPE,
      data: { app: "ce", windowId: 5, workspace: "agent", tab: "TAB-MISSING" },
    },
  ]);
  restoreBinding(ctx, makeTestConfig());
  const { client } = await createMutableInventoryClient({
    tabs: [
      rawTab({ id: "ABCDEF-0001", name: "Oracle", files: 0 }),
      rawTab({ id: "TAB-SAFE", name: "Safe", files: 0 }),
    ],
    oracleSessions: "session tab=ABCDEF…",
  });

  const binding = await ensureBindingHasTab(pi, ctx, makeTestConfig(), client, {
    recoverIfMissing: true,
  });

  assert.equal(binding.tab, "TAB-SAFE");
});

test("aborting an in-flight safety probe releases the route coordinator", async () => {
  const { pi, ctx } = makeMockSession([
    {
      type: "custom",
      customType: BINDING_ENTRY_TYPE,
      data: { app: "ce", windowId: 5, workspace: "agent", tab: "TAB-MISSING" },
    },
  ]);
  restoreBinding(ctx, makeTestConfig());
  const blocked = await createMutableInventoryClient({
    tabs: [rawTab({ id: "TAB-SAFE", name: "Safe", files: 0 })],
    blockOracleSessions: true,
  });
  const controller = new AbortController();
  const recovery = ensureBindingHasTab(
    pi,
    ctx,
    makeTestConfig(),
    blocked.client,
    { recoverIfMissing: true },
    controller.signal,
  );
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();

  await assert.rejects(recovery, (error) => error?.name === "AbortError");
  assert.equal(
    blocked.state.calls.find((call) => call.name === "oracle_utils").signal,
    controller.signal,
  );

  const healthy = await createMutableInventoryClient({
    tabs: [rawTab({ id: "TAB-LIVE", name: "Live" })],
    binding: { kind: "unbound" },
  });
  const rebound = await bindToWindow(pi, 5, undefined, makeTestConfig(), healthy.client);
  assert.equal(rebound.windowId, 5);
});

test("recovery creates at most one background tab across repeated calls", async () => {
  const { pi, ctx } = makeMockSession();
  const { client, state } = await createMutableInventoryClient({
    tabs: [rawTab({ id: "TAB-DIRTY", name: "Dirty", files: 2 })],
    binding: { kind: "unbound" },
  });
  await bindToWindow(pi, 5, undefined, makeTestConfig(), client);

  const first = await ensureBindingHasTab(pi, ctx, makeTestConfig(), client);
  const second = await ensureBindingHasTab(pi, ctx, makeTestConfig(), client);

  assert.equal(first.tab, "TAB-CREATED-1");
  assert.equal(second.tab, "TAB-CREATED-1");
  assert.equal(state.createCount, 1);
});

test("auto-bind applies deterministic partial-root precedence", () => {
  const windows = [
    { id: 2, workspace: "observed", roots: ["/fixtures/repo"] },
    {
      id: 3,
      workspace: "unknown",
      roots: [],
      rootsUnavailableDiagnostic: "probe failed",
    },
  ];

  assert.equal(findMatchingWindow(windows, "/fixtures/repo/src").window.id, 2);
  assert.deepEqual(findMatchingWindow(windows, "/fixtures/other").rootsUnavailableWindowIds, [3]);
});

test("Classic ordinary observation requires one successful explicit per-connection probe", async () => {
  const calls = [];
  const client = {
    isConnected: true,
    tools: classicCatalog.tools,
    async callTool(name, args) {
      calls.push({ name, args });
      return makeTextResult(classicScenarios.multiWindow);
    },
  };
  const config = makeTestConfig({ activeApp: "classic" });

  await assert.rejects(fetchWindows(undefined, config, client), /unestablished for this connection/u);
  assert.equal(calls.length, 0);

  await establishRoutingInventoryContract(config, client);
  assert.equal(calls.length, 1);
  assert.deepEqual((await fetchWindows(undefined, config, client)).map((window) => window.id), [2, 10, 11]);
  assert.equal(calls.length, 2);
});

test("failed Classic explicit probe leaves ordinary observation fail-closed", async () => {
  let calls = 0;
  const client = {
    isConnected: true,
    tools: classicCatalog.tools,
    async callTool() {
      calls += 1;
      return makeTextResult("malformed output");
    },
  };
  const config = makeTestConfig({ activeApp: "classic" });

  await assert.rejects(
    establishRoutingInventoryContract(config, client),
    /did not return JSON content/u
  );
  await assert.rejects(fetchWindows(undefined, config, client), /unestablished for this connection/u);
  assert.equal(calls, 1);
});

test("autoDetectAndBind reports root observation failure instead of treating it as no match", async () => {
  const originalCwd = process.cwd();
  const { pi } = makeMockSession();
  const client = {
    isConnected: true,
    tools: structuredClone(ceCatalog.tools),
    async callTool(name) {
      return name === "bind_context"
        ? makeTextResult(ceScenarios.rootUnavailable)
        : makeTextResult("root lookup failed", true);
    },
  };

  try {
    process.chdir("/tmp");
    await establishRoutingInventoryContract(makeTestConfig(), client);
    const result = await autoDetectAndBind(pi, makeTestConfig(), undefined, client);
    assert.deepEqual(result.rootsUnavailableWindowIds, [12]);
    assert.equal(result.binding, null);
  } finally {
    process.chdir(originalCwd);
  }
});

test("clean mutation error observes independently after caller cancellation", async () => {
  resetBindingStateForTests();
  const controller = new AbortController();
  const observationCalls = [];
  const client = {
    tools: structuredClone(ceCatalog.tools),
    async callTool(name, args, timeoutMs, signal) {
      observationCalls.push({ name, args, timeoutMs, signal });
      if (signal?.aborted) {
        throw signal.reason ?? new Error("caller aborted");
      }
      return makeTextResult(ceScenarios.multiWindow);
    },
  };
  await establishRoutingInventoryContract(makeTestConfig(), client);
  observationCalls.length = 0;

  const execution = await executeRoutingMutation({
    operationLabel: "bind_context bind",
    operationClass: "routing_mutation",
    config: makeTestConfig(),
    client,
    signal: controller.signal,
    async dispatch() {
      controller.abort(new Error("caller cancelled after result"));
      return makeTextResult("bind rejected", true);
    },
    reconcile() {
      throw new Error("failed mutation must not use success reconciliation");
    },
  });

  assert.equal(execution.kind, "failed");
  assert.equal(observationCalls.length, 1);
  assert.equal(observationCalls[0].timeoutMs, ROUTING_OBSERVATION_TIMEOUT_MS);
  assert.equal(observationCalls[0].signal, undefined);
  resetBindingStateForTests();
});

test("successful mutation observation cannot reconcile after a newer route publication", async () => {
  resetBindingStateForTests();
  const { pi, entries } = makeMockSession();
  const config = makeTestConfig();
  persistBinding(pi, {
    app: "ce",
    windowId: 5,
    workspace: "agent",
    tab: "TAB-OLD",
  }, config);
  const observationEntered = deferred();
  const releaseObservation = deferred();
  let contractEstablished = false;
  const client = {
    tools: structuredClone(ceCatalog.tools),
    async callTool(name, args) {
      assert.equal(name, "bind_context");
      assert.equal(args.op, "list");
      if (!contractEstablished) {
        return makeTextResult(ceScenarios.multiWindow);
      }
      const captured = makeTextResult(rawInventory({
        tabs: [
          rawTab({ id: "TAB-A", name: "Requested", bound: true }),
          rawTab({ id: "TAB-NEWER", name: "Newer" }),
        ],
        binding: { kind: "bound", contextId: "TAB-A" },
      }));
      observationEntered.resolve();
      await releaseObservation.promise;
      return captured;
    },
  };
  await establishRoutingInventoryContract(config, client);
  contractEstablished = true;
  let reconciled = false;

  const pending = executeRoutingMutation({
    operationLabel: "bind_context bind for TAB-A",
    operationClass: "routing_mutation",
    config,
    client,
    async dispatch() {
      return makeTextResult("Bound context `TAB-A`");
    },
    reconcile(inventory) {
      reconciled = true;
      return reconcileObservedInventoryRoute(pi, config, inventory);
    },
  });
  await observationEntered.promise;
  persistBinding(pi, {
    app: "ce",
    windowId: 5,
    workspace: "agent",
    tab: "TAB-NEWER",
  }, config);
  const persistedBeforeCompletion = entries.length;
  releaseObservation.resolve();

  const execution = await pending;

  assert.equal(execution.kind, "superseded");
  assert.equal(execution.cause, "superseded");
  assert.equal(execution.possiblePartialSuccess, true);
  assert.equal(reconciled, false);
  assert.equal(entries.length, persistedBeforeCompletion);
  assert.equal(getVerifiedBinding()?.tab, "TAB-NEWER");
  resetBindingStateForTests();
});

test("successful routing mutation ending window-only publishes non-dispatchable intent", async () => {
  resetBindingStateForTests();
  const { pi, entries } = makeMockSession();
  const { client } = await createMutableInventoryClient({
    tabs: [rawTab({ id: "TAB-SAFE", name: "Safe", files: 0 })],
    binding: { kind: "window" },
  });

  const execution = await executeRoutingMutation({
    operationLabel: "workspace mutation",
    operationClass: "workspace_routing_mutation",
    config: makeTestConfig(),
    client,
    async dispatch() {
      return makeTextResult("mutation completed");
    },
    reconcile(inventory) {
      return reconcileObservedInventoryRoute(pi, makeTestConfig(), inventory);
    },
  });

  assert.equal(execution.kind, "reconciled");
  assert.equal(execution.result.isError, undefined);
  assert.equal(execution.value.tab, undefined);
  assert.equal(getRouteState().kind, "intent");
  assert.equal(getVerifiedBinding(), null);
  assert.equal(getRouteSelectorDecision({}).kind, "blocked");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].data.windowId, 5);
  assert.equal(entries[0].data.tab, undefined);
  resetBindingStateForTests();
});
