import assert from "node:assert/strict";
import test from "node:test";

import {
  adoptObservedStickyRoute,
  getRouteSelectorDecision,
  getRouteState,
  establishRoutingInventoryContract,
  observeRouteStatus,
  persistBinding,
  quarantineRoute,
  resetBindingStateForTests,
  restoreBinding,
} from "../dist/binding.js";
import {
  parseSelectionSummaryFromJson,
  parseWorkspaceContextSelectionSummaryFromText,
} from "../dist/index.js";
import { BINDING_ENTRY_TYPE } from "../dist/types.js";
import { catalog as ceCatalog } from "./fixtures/ce-1.2/evidence.js";

test("parseWorkspaceContextSelectionSummaryFromText parses selected file count and selection tokens", () => {
  const text = [
    "## Prompt Context ✅",
    "- **Copy Preset**: Manual",
    "**26,690 total tokens**",
    "",
    "- **Selection**: 12,626",
    "  - Files: 12,626",
    "- File tree: 14,064",
    "- **Selected files**: 3 total (3 slice)",
    "- Token breakdown: slice 12626",
    "",
    "### Selection",
    "3 files • 12,626 tokens (Auto view)",
  ].join("\n");

  assert.deepEqual(parseWorkspaceContextSelectionSummaryFromText(text), {
    fileCount: 3,
    tokens: 12626,
  });
});

test("parseWorkspaceContextSelectionSummaryFromText does not misread manage_selection token rows as file counts", () => {
  const text = [
    "## Selection ✅",
    "**26,690 total tokens**",
    "",
    "Files: 12,626 (12,626 full)",
    "Other: tree 14,064",
  ].join("\n");

  assert.equal(parseWorkspaceContextSelectionSummaryFromText(text), null);
});

test("parseSelectionSummaryFromJson does not misread selection token totals as file counts", () => {
  const value = {
    selection: {
      files: 12626,
      tokens: 12626,
    },
    summary: {
      fileCount: 3,
      totalTokens: 12626,
    },
  };

  assert.deepEqual(parseSelectionSummaryFromJson(value), {
    fileCount: 3,
    tokens: 12626,
  });
});

function makeInventory({ tabs = [], binding = { binding_kind: "unbound" }, windows = null } = {}) {
  return {
    windows: windows ?? [{
      window_id: 5,
      workspace: { id: "workspace-5", name: "agent" },
      tabs: tabs.map((tab) => ({
        context_id: tab.id,
        name: tab.name,
        is_active: tab.active,
        is_bound: tab.bound,
        selected_file_count: 0,
        repo_paths: ["/Users/ww/dot314/agent"],
      })),
    }],
    binding,
  };
}

async function makeStatusClient(inventory, options = {}) {
  const calls = [];
  let useConfiguredResult = false;
  const client = {
    calls,
    tools: options.tools ?? structuredClone(ceCatalog.tools),
    async callTool(name, args) {
      calls.push({ name, args });
      if (useConfiguredResult && options.result) {
        return options.result;
      }
      return {
        isError: false,
        content: [{ type: "text", text: JSON.stringify(inventory ?? makeInventory()) }],
      };
    },
  };
  if (client.tools.some((tool) => tool.name === "bind_context")) {
    await establishRoutingInventoryContract(STATUS_CONFIG, client);
    calls.length = 0;
    useConfiguredResult = true;
  }
  return client;
}

function makeIntentContext(entries) {
  return {
    sessionManager: {
      getBranch() {
        return entries;
      },
    },
  };
}

const STATUS_CONFIG = { activeApp: "ce", persistBinding: true };

test("status reports window-bound intent and verified tab authority with observation-only calls", async () => {
  resetBindingStateForTests();
  const intentEntries = [{
    type: "custom",
    customType: BINDING_ENTRY_TYPE,
    data: { app: "ce", windowId: 5, workspace: "agent" },
  }];
  restoreBinding(makeIntentContext(intentEntries), STATUS_CONFIG);
  const windowClient = await makeStatusClient(makeInventory({
    binding: { binding_kind: "window", window_id: 5 },
  }));

  const windowStatus = await observeRouteStatus(STATUS_CONFIG, windowClient);
  assert.equal(windowStatus.routeState, "intent");
  assert.match(windowStatus.diagnostic, /not been verified for dispatch/u);
  assert.equal(getRouteSelectorDecision({}).kind, "blocked");
  assert.deepEqual(windowClient.calls.map((call) => call.args), [{ op: "list", _rawJSON: true }]);

  const entries = [];
  persistBinding({ appendEntry(type, data) { entries.push({ type, data }); } }, {
    app: "ce",
    windowId: 5,
    workspace: "agent",
    tab: "TAB-LIVE",
  }, STATUS_CONFIG, "Live");
  const tabClient = await makeStatusClient(makeInventory({
    tabs: [{ id: "TAB-LIVE", name: "Live", active: false, bound: true }],
    binding: { binding_kind: "tab_context", window_id: 5, context_id: "TAB-LIVE" },
  }));

  const tabStatus = await observeRouteStatus(STATUS_CONFIG, tabClient);
  assert.equal(tabStatus.routeState, "verified_tab");
  assert.deepEqual(tabStatus.tab, {
    contextId: "TAB-LIVE",
    name: "Live",
    isActive: false,
    isBound: true,
  });
  assert.equal(entries.length, 1);
  resetBindingStateForTests();
});

test("verified tab status rejects a context moved outside its stored window and workspace", async () => {
  resetBindingStateForTests();
  persistBinding({ appendEntry() {} }, {
    app: "ce",
    windowId: 5,
    workspace: "agent",
    tab: "TAB-MOVED",
  }, STATUS_CONFIG, "Moved");
  const client = await makeStatusClient(makeInventory({
    windows: [
      {
        window_id: 5,
        workspace: { id: "workspace-5", name: "agent" },
        tabs: [{
          context_id: "TAB-MOVED",
          name: "Moved",
          is_active: false,
          is_bound: false,
          selected_file_count: 0,
          repo_paths: ["/Users/ww/dot314/agent"],
        }],
      },
      {
        window_id: 6,
        workspace: { id: "workspace-6", name: "other" },
        tabs: [{
          context_id: "TAB-MOVED",
          name: "Moved",
          is_active: true,
          is_bound: true,
          selected_file_count: 0,
          repo_paths: ["/Users/ww/other"],
        }],
      },
    ],
    binding: { binding_kind: "tab_context", window_id: 6, context_id: "TAB-MOVED" },
  }));

  const status = await observeRouteStatus(STATUS_CONFIG, client);
  assert.equal(status.routeState, "stale");
  assert.match(status.diagnostic, /TAB-MOVED.*window 5/u);
  assert.deepEqual(getRouteSelectorDecision({ callerArgs: {} }), {
    kind: "selectors",
    args: { _windowID: 5, context_id: "TAB-MOVED" },
  });
  assert.equal(getRouteState().kind, "verified");
  resetBindingStateForTests();
});

test("sticky adoption follows the observed presentation window for the same logical context", async () => {
  resetBindingStateForTests();
  const entries = [{
    type: "custom",
    customType: BINDING_ENTRY_TYPE,
    data: { app: "ce", windowId: 5, workspace: "agent", tab: "TAB-SHARED" },
  }];
  restoreBinding(makeIntentContext(entries), STATUS_CONFIG);
  const appended = [];
  const client = await makeStatusClient(makeInventory({
    windows: [
      {
        window_id: 5,
        workspace: { id: "workspace-5", name: "agent" },
        tabs: [{
          context_id: "TAB-SHARED",
          name: "Shared",
          is_active: false,
          is_bound: false,
          selected_file_count: 0,
          repo_paths: ["/Users/ww/dot314/agent"],
        }],
      },
      {
        window_id: 6,
        workspace: { id: "workspace-6", name: "other" },
        tabs: [{
          context_id: "TAB-SHARED",
          name: "Shared",
          is_active: true,
          is_bound: true,
          selected_file_count: 0,
          repo_paths: ["/Users/ww/other"],
        }],
      },
    ],
    binding: { binding_kind: "tab_context", window_id: 6, context_id: "TAB-SHARED" },
  }));

  const result = await adoptObservedStickyRoute({
    appendEntry(type, data) {
      appended.push({ type, data });
    },
  }, STATUS_CONFIG, client);

  assert.equal(result.kind, "adopted");
  assert.equal(result.binding.windowId, 6);
  assert.equal(result.binding.tab, "TAB-SHARED");
  assert.equal(getRouteState().kind, "verified");
  assert.deepEqual(getRouteSelectorDecision({ callerArgs: {} }), {
    kind: "selectors",
    args: { _windowID: 6, context_id: "TAB-SHARED" },
  });
  assert.equal(appended.length, 1);
  resetBindingStateForTests();
});

test("status reports intent, stale intent, quarantine, observation failure, unsupported, and valid-empty unbound", async () => {
  resetBindingStateForTests();
  const entries = [{
    type: "custom",
    customType: BINDING_ENTRY_TYPE,
    data: { app: "ce", windowId: 5, workspace: "agent", tab: "TAB-INTENT" },
  }];
  restoreBinding(makeIntentContext(entries), STATUS_CONFIG);

  const matchingClient = await makeStatusClient(makeInventory({
    tabs: [{ id: "TAB-INTENT", name: "Intent", active: true, bound: true }],
    binding: { binding_kind: "tab_context", window_id: 5, context_id: "TAB-INTENT" },
  }));
  assert.equal((await observeRouteStatus(STATUS_CONFIG, matchingClient)).routeState, "intent");
  assert.equal(entries.length, 1);

  const staleClient = await makeStatusClient(makeInventory());
  assert.equal((await observeRouteStatus(STATUS_CONFIG, staleClient)).routeState, "stale");

  quarantineRoute("ambiguous_mutation_result", "mutation outcome unknown");
  await establishRoutingInventoryContract(STATUS_CONFIG, matchingClient);
  matchingClient.calls.length = 0;
  assert.equal((await observeRouteStatus(STATUS_CONFIG, matchingClient)).routeState, "quarantined");

  const failedClient = await makeStatusClient(null, {
    result: { isError: true, content: [{ type: "text", text: "inventory unavailable" }] },
  });
  const failedStatus = await observeRouteStatus(STATUS_CONFIG, failedClient);
  assert.equal(failedStatus.routeState, "observation_failed");
  assert.match(failedStatus.diagnostic, /inventory unavailable/u);

  const malformedClient = await makeStatusClient(null, {
    result: { isError: false, content: [{ type: "text", text: '{"windows":"invalid","binding":{}}' }] },
  });
  const malformedStatus = await observeRouteStatus(STATUS_CONFIG, malformedClient);
  assert.equal(malformedStatus.routeState, "observation_failed");
  assert.match(malformedStatus.diagnostic, /no windows array/u);

  const unsupportedClient = await makeStatusClient(makeInventory(), { tools: [] });
  assert.equal((await observeRouteStatus(STATUS_CONFIG, unsupportedClient)).routeState, "unsupported");
  assert.deepEqual(unsupportedClient.calls, []);

  resetBindingStateForTests();
  const emptyClient = await makeStatusClient(makeInventory({ windows: [] }));
  assert.equal((await observeRouteStatus(STATUS_CONFIG, emptyClient)).routeState, "unbound");
  resetBindingStateForTests();
});

test("status exposes degraded persistence while keeping an observed route verified", async () => {
  resetBindingStateForTests();
  const publication = persistBinding({
    appendEntry() {
      throw new Error("session branch is read-only");
    },
  }, {
    app: "ce",
    windowId: 5,
    workspace: "agent",
    tab: "TAB-LIVE",
  }, STATUS_CONFIG, "Live");
  assert.equal(publication.persistence, "degraded");

  const client = await makeStatusClient(makeInventory({
    tabs: [{ id: "TAB-LIVE", name: "Live", active: true, bound: true }],
    binding: { binding_kind: "tab_context", window_id: 5, context_id: "TAB-LIVE" },
  }));
  const status = await observeRouteStatus(STATUS_CONFIG, client);
  assert.equal(status.routeState, "verified_tab");
  assert.match(status.persistenceDiagnostic, /session branch is read-only/u);
  resetBindingStateForTests();
});

test("sticky adoption rejects conflicting restored intent without persistence or dispatch selectors", async () => {
  resetBindingStateForTests();
  const entries = [{
    type: "custom",
    customType: BINDING_ENTRY_TYPE,
    data: { app: "ce", windowId: 5, workspace: "agent", tab: "TAB-INTENT" },
  }];
  restoreBinding(makeIntentContext(entries), STATUS_CONFIG);
  const appended = [];
  const client = await makeStatusClient(makeInventory({
    tabs: [
      { id: "TAB-INTENT", name: "Intent", active: false, bound: false },
      { id: "TAB-OTHER", name: "Other", active: true, bound: true },
    ],
    binding: { binding_kind: "tab_context", window_id: 5, context_id: "TAB-OTHER" },
  }));

  const result = await adoptObservedStickyRoute({
    appendEntry(type, data) {
      appended.push({ type, data });
    },
  }, STATUS_CONFIG, client);

  assert.equal(result.kind, "conflict");
  assert.match(result.diagnostic, /TAB-INTENT.*TAB-OTHER/u);
  assert.equal(getRouteState().kind, "intent");
  assert.equal(getRouteSelectorDecision({ callerArgs: {} }).kind, "blocked");
  assert.deepEqual(appended, []);
  resetBindingStateForTests();
});

test("window-only sticky binding cannot replace a restored tab intent", async () => {
  resetBindingStateForTests();
  const entries = [{
    type: "custom",
    customType: BINDING_ENTRY_TYPE,
    data: { app: "ce", windowId: 5, workspace: "agent", tab: "TAB-INTENT" },
  }];
  restoreBinding(makeIntentContext(entries), STATUS_CONFIG);
  const appended = [];
  const client = await makeStatusClient(makeInventory({
    tabs: [{ id: "TAB-INTENT", name: "Intent", active: true, bound: false }],
    binding: { binding_kind: "window", window_id: 5 },
  }));

  const result = await adoptObservedStickyRoute({
    appendEntry(type, data) {
      appended.push({ type, data });
    },
  }, STATUS_CONFIG, client);

  assert.equal(result.kind, "conflict");
  assert.match(result.diagnostic, /requires a tab binding/u);
  assert.equal(getRouteState().kind, "intent");
  assert.deepEqual(appended, []);
  resetBindingStateForTests();
});
