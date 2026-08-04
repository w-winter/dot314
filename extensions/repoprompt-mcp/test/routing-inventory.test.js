import assert from "node:assert/strict";
import test from "node:test";

import {
  establishInventoryContract,
  ROUTING_OBSERVATION_TIMEOUT_MS,
  observeRoutingInventory,
  observeWindowRoots,
  parseRoutingInventory,
  tabsForWindow,
  windowFromInventory,
} from "../dist/routing-inventory.js";
import {
  CE_1_2_TARGET_CONTRACT,
  CLASSIC_2_1_32_TARGET_CONTRACT,
} from "../dist/target-contract.js";
import { inventoryScenarios as ceScenarios } from "./fixtures/ce-1.2/evidence.js";
import { inventoryScenarios as classicScenarios } from "./fixtures/classic-2.1.32/evidence.js";

function textResult(value, isError = false) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function fakeClient({ tools = ["bind_context", "get_file_tree"], callTool }) {
  return {
    tools: tools.map((name) => ({
      name,
      description: name,
      inputSchema: name.toLowerCase().endsWith("get_file_tree")
        ? {
            type: "object",
            properties: { type: { type: "string", enum: ["files", "roots"] } },
          }
        : { type: "object" },
    })),
    callTool,
  };
}

test("multi-window fixture preserves all three windows, roots, tabs, and sticky binding", () => {
  const result = parseRoutingInventory(ceScenarios.multiWindow, CE_1_2_TARGET_CONTRACT);

  assert.equal(result.kind, "observed");
  assert.deepEqual(result.inventory.windows.map((window) => window.id), [2, 10, 11]);
  assert.deepEqual(result.inventory.connectionBinding, {
    kind: "bound",
    contextId: "00000000-0000-4000-8000-000000001010",
  });
  assert.deepEqual(windowFromInventory(result.inventory, 2).roots, {
    kind: "observed",
    paths: ["/fixtures/workspace-two", "/fixtures/shared"],
  });
  assert.deepEqual(tabsForWindow(result.inventory, 11).map((tab) => tab.name), ["Tab Eleven"]);
  assert.deepEqual(tabsForWindow(result.inventory, 999), []);
});

test("three-window reproduction proves workspace inventory is not routing inventory", () => {
  const result = parseRoutingInventory(ceScenarios.multiWindow, CE_1_2_TARGET_CONTRACT);
  assert.equal(result.kind, "observed");
  assert.deepEqual(ceScenarios.incompleteWorkspaceInventoryWindowIds, [2, 10]);
  assert.deepEqual(result.inventory.windows.map((window) => window.id), [2, 10, 11]);
  assert.notDeepEqual(
    ceScenarios.incompleteWorkspaceInventoryWindowIds,
    result.inventory.windows.map((window) => window.id)
  );
});

test("valid-empty, unbound, and malformed observations remain distinct", () => {
  const empty = parseRoutingInventory(ceScenarios.validEmpty, CE_1_2_TARGET_CONTRACT);
  const unbound = parseRoutingInventory(ceScenarios.unbound, CE_1_2_TARGET_CONTRACT);
  const malformed = parseRoutingInventory(ceScenarios.malformed, CE_1_2_TARGET_CONTRACT);

  assert.equal(empty.kind, "observed");
  assert.deepEqual(empty.inventory.windows, []);
  assert.deepEqual(empty.inventory.connectionBinding, { kind: "unbound" });

  assert.equal(unbound.kind, "observed");
  assert.equal(unbound.inventory.windows.length, 1);
  assert.deepEqual(unbound.inventory.connectionBinding, { kind: "unbound" });

  assert.equal(malformed.kind, "malformed");
  assert.match(malformed.diagnostic, /window_id/u);
});

test("window-only connection binding is represented rather than collapsed into unbound", () => {
  const fixture = structuredClone(ceScenarios.unbound);
  fixture.binding = {
    binding_kind: "window",
    window_id: 2,
    repo_paths: ["/fixtures/workspace-two"],
    explicit: false,
    run_scoped: false,
  };

  const result = parseRoutingInventory(fixture, CE_1_2_TARGET_CONTRACT);
  assert.equal(result.kind, "observed");
  assert.deepEqual(result.inventory.connectionBinding, { kind: "window", windowId: 2 });
});

test("binding references absent from inventory are malformed", () => {
  const missingTab = structuredClone(ceScenarios.unbound);
  missingTab.binding = {
    binding_kind: "tab_context",
    context_id: "00000000-0000-4000-8000-999999999999",
  };
  const missingWindow = structuredClone(ceScenarios.unbound);
  missingWindow.binding = { binding_kind: "window", window_id: 999 };

  for (const fixture of [missingTab, missingWindow]) {
    const result = parseRoutingInventory(fixture, CE_1_2_TARGET_CONTRACT);
    assert.equal(result.kind, "malformed");
    assert.match(result.diagnostic, /absent from the inventory/u);
  }
});

test("target contracts accept only their own bound-context discriminator", () => {
  const classic = parseRoutingInventory(
    classicScenarios.multiWindow,
    CLASSIC_2_1_32_TARGET_CONTRACT
  );
  assert.equal(classic.kind, "observed");
  assert.deepEqual(classic.inventory.connectionBinding, {
    kind: "bound",
    contextId: "00000000-0000-4000-8000-000000001010",
  });

  const classicShapeForCe = parseRoutingInventory(
    classicScenarios.multiWindow,
    CE_1_2_TARGET_CONTRACT
  );
  assert.equal(classicShapeForCe.kind, "malformed");
  assert.match(classicShapeForCe.diagnostic, /binding_kind "context" is unsupported/u);

  const ceShapeForClassic = parseRoutingInventory(
    ceScenarios.multiWindow,
    CLASSIC_2_1_32_TARGET_CONTRACT
  );
  assert.equal(ceShapeForClassic.kind, "malformed");
  assert.match(ceShapeForClassic.diagnostic, /binding_kind "tab_context" is unsupported/u);
});

test("zero-tab window remains visible with roots unavailable", () => {
  const result = parseRoutingInventory(ceScenarios.rootUnavailable, CE_1_2_TARGET_CONTRACT);

  assert.equal(result.kind, "observed");
  assert.equal(result.inventory.windows.length, 1);
  assert.deepEqual(result.inventory.windows[0].tabs, []);
  assert.equal(result.inventory.windows[0].roots.kind, "unavailable");
  assert.match(result.inventory.windows[0].roots.diagnostic, /no tab carrying repo_paths/u);
});

test("invalid inventory root strings are malformed and cannot participate in matching", () => {
  for (const rootPath of ["", "   ", "relative/root"]) {
    const fixture = structuredClone(ceScenarios.unbound);
    fixture.windows[0].tabs[0].repo_paths = [rootPath];
    const result = parseRoutingInventory(fixture, CE_1_2_TARGET_CONTRACT);
    assert.equal(result.kind, "malformed");
    assert.match(result.diagnostic, /invalid required field/u);
  }
});

test("established observer issues one global JSON bind_context list through a prefixed tool", async () => {
  const calls = [];
  const client = fakeClient({
    tools: ["RepoPrompt_bind_context"],
    callTool: async (name, args) => {
      calls.push({ name, args });
      return textResult(ceScenarios.multiWindow);
    },
  });

  const establishment = await establishInventoryContract(client, CE_1_2_TARGET_CONTRACT);
  assert.equal(establishment.kind, "established");
  const result = await observeRoutingInventory(establishment.token);
  assert.equal(result.kind, "observed");
  assert.equal(result.inventory.windows.length, 3);
  assert.deepEqual(calls, [
    { name: "RepoPrompt_bind_context", args: { op: "list", _rawJSON: true } },
    { name: "RepoPrompt_bind_context", args: { op: "list", _rawJSON: true } },
  ]);
});

test("establishment distinguishes missing tool, thrown call, MCP error, and malformed success", async () => {
  const missing = await establishInventoryContract(
    fakeClient({ tools: [], callTool: async () => textResult({}) }),
    CE_1_2_TARGET_CONTRACT
  );
  assert.deepEqual(missing, { kind: "tool_missing", toolName: "bind_context" });

  const thrown = await establishInventoryContract(
    fakeClient({ callTool: async () => { throw new Error("transport unavailable"); } }),
    CE_1_2_TARGET_CONTRACT
  );
  assert.deepEqual(thrown, { kind: "call_failed", diagnostic: "transport unavailable" });

  const upstreamError = await establishInventoryContract(
    fakeClient({ callTool: async () => textResult("inventory failed", true) }),
    CE_1_2_TARGET_CONTRACT
  );
  assert.deepEqual(upstreamError, { kind: "call_failed", diagnostic: "inventory failed" });

  const malformed = await establishInventoryContract(
    fakeClient({ callTool: async () => textResult("not JSON") }),
    CE_1_2_TARGET_CONTRACT
  );
  assert.deepEqual(malformed, {
    kind: "malformed",
    diagnostic: "bind_context list did not return JSON content",
  });
});

test("observation without an establishment token is refused for both targets", async () => {
  for (const contract of [CE_1_2_TARGET_CONTRACT, CLASSIC_2_1_32_TARGET_CONTRACT]) {
    let callCount = 0;
    const client = fakeClient({
      callTool: async () => {
        callCount += 1;
        return textResult(
          contract.app === "classic" ? classicScenarios.multiWindow : ceScenarios.multiWindow
        );
      },
    });

    const unestablished = await observeRoutingInventory(null);
    assert.equal(unestablished.kind, "contract_unestablished");
    assert.equal(callCount, 0);

    const establishment = await establishInventoryContract(client, contract);
    assert.equal(establishment.kind, "established");
    assert.equal(callCount, 1);
    assert.equal((await observeRoutingInventory(establishment.token)).kind, "observed");
    assert.equal(callCount, 2);
  }
});

test("root observer uses the proven hidden selector and never converts failure to zero roots", async () => {
  const calls = [];
  const successClient = fakeClient({
    callTool: async (name, args) => {
      calls.push({ name, args });
      return textResult({ roots_count: 2, uses_legend: false, tree: "/fixtures/one\n/fixtures/two" });
    },
  });
  const success = await observeWindowRoots(successClient, CE_1_2_TARGET_CONTRACT, 12);
  assert.deepEqual(success, { kind: "observed", paths: ["/fixtures/one", "/fixtures/two"] });
  assert.deepEqual(calls, [{
    name: "get_file_tree",
    args: { type: "roots", _windowID: 12, _rawJSON: true },
  }]);

  const failed = await observeWindowRoots(
    fakeClient({ callTool: async () => textResult("root lookup failed", true) }),
    CE_1_2_TARGET_CONTRACT,
    12
  );
  assert.deepEqual(failed, { kind: "unavailable", diagnostic: "root lookup failed" });

  const malformed = await observeWindowRoots(
    fakeClient({ callTool: async () => textResult({ roots_count: 2, tree: "/fixtures/one" }) }),
    CE_1_2_TARGET_CONTRACT,
    12
  );
  assert.equal(malformed.kind, "unavailable");
  assert.match(malformed.diagnostic, /reported 2 roots/u);

  const relative = await observeWindowRoots(
    fakeClient({ callTool: async () => textResult({ roots_count: 1, tree: "relative/root" }) }),
    CE_1_2_TARGET_CONTRACT,
    12
  );
  assert.deepEqual(relative, {
    kind: "unavailable",
    diagnostic: "get_file_tree roots returned a non-absolute path",
  });

  const zeroRoots = await observeWindowRoots(
    fakeClient({ callTool: async () => textResult({ roots_count: 0, tree: "" }) }),
    CE_1_2_TARGET_CONTRACT,
    12
  );
  assert.deepEqual(zeroRoots, { kind: "observed", paths: [] });
});

test("root observer requires advertised type=roots before calling", async () => {
  let callCount = 0;
  const client = {
    tools: [{ name: "get_file_tree", description: "tree", inputSchema: { type: "object", properties: {} } }],
    callTool: async () => {
      callCount += 1;
      return textResult({ roots_count: 0, tree: "" });
    },
  };

  const result = await observeWindowRoots(client, CE_1_2_TARGET_CONTRACT, 12);
  assert.deepEqual(result, {
    kind: "unavailable",
    diagnostic: "get_file_tree does not advertise type=roots",
  });
  assert.equal(callCount, 0);
});

test("Classic root observation is blocked by the recorded hidden-selector evidence gap", async () => {
  let callCount = 0;
  const result = await observeWindowRoots(
    fakeClient({ callTool: async () => { callCount += 1; return textResult({}); } }),
    CLASSIC_2_1_32_TARGET_CONTRACT,
    2
  );

  assert.equal(result.kind, "unavailable");
  assert.match(result.diagnostic, /Classic 2\.1\.32 \(334\).*binding_kind context/u);
  assert.equal(callCount, 0);
});

test("routing inventory and root probes use the dedicated observation timeout", async () => {
  const calls = [];
  const signal = new AbortController().signal;
  const client = fakeClient({
    callTool: async (name, args, timeoutMs, observedSignal) => {
      calls.push({ name, args, timeoutMs, signal: observedSignal });
      return name === "bind_context"
        ? textResult(ceScenarios.multiWindow)
        : textResult({ roots_count: 0, tree: "" });
    },
  });

  const establishment = await establishInventoryContract(client, CE_1_2_TARGET_CONTRACT, signal);
  assert.equal(establishment.kind, "established");
  assert.equal((await observeRoutingInventory(establishment.token, signal)).kind, "observed");
  assert.equal((await observeWindowRoots(client, CE_1_2_TARGET_CONTRACT, 2, signal)).kind, "observed");
  assert.deepEqual(calls.map((call) => call.timeoutMs), [
    ROUTING_OBSERVATION_TIMEOUT_MS,
    ROUTING_OBSERVATION_TIMEOUT_MS,
    ROUTING_OBSERVATION_TIMEOUT_MS,
  ]);
  assert.deepEqual(calls.map((call) => call.signal), [signal, signal, signal]);
});

test("Classic 2.1.32 scenarios use the observed context binding discriminator", () => {
  const parsed = parseRoutingInventory(
    classicScenarios.multiWindow,
    CLASSIC_2_1_32_TARGET_CONTRACT
  );
  assert.equal(parsed.kind, "observed");
  assert.deepEqual(parsed.inventory.windows.map((window) => window.id), [2, 10, 11]);
  assert.match(classicScenarios.provenance, /Classic 2\.1\.32 binding_kind context/u);
});
