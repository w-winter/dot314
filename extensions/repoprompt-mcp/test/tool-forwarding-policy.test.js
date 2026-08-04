import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_MANAGE_OPERATIONS,
  AGENT_RUN_OPERATIONS,
  BIND_CONTEXT_OPERATIONS,
  MANAGE_WORKSPACES_ACTIONS,
  MANAGE_WORKTREE_OPERATIONS,
  buildForwardedCallArgs,
  buildForwardedUserArgs,
  classifyForwardingOperation,
  isRoutingMutationClass,
  operationForTool,
} from "../dist/tool-forwarding-policy.js";

test("buildForwardedUserArgs forces verbose apply_edits", () => {
  assert.deepEqual(
    buildForwardedUserArgs({
      toolName: "apply_edits",
      userArgs: { path: "demo.txt", search: "old", replace: "new" },
    }),
    { path: "demo.txt", search: "old", replace: "new", verbose: true }
  );

  assert.deepEqual(
    buildForwardedUserArgs({
      toolName: "apply_edits",
      userArgs: { path: "demo.txt", search: "old", replace: "new", verbose: false },
    }),
    { path: "demo.txt", search: "old", replace: "new", verbose: true }
  );
});

test("buildForwardedUserArgs preserves other tool args and strips read_file bypass_cache", () => {
  assert.deepEqual(
    buildForwardedUserArgs({
      toolName: "read_file",
      userArgs: { path: "demo.txt", start_line: 1, bypass_cache: true },
    }),
    { path: "demo.txt", start_line: 1 }
  );

  assert.deepEqual(
    buildForwardedUserArgs({
      toolName: "git",
      userArgs: { op: "diff", detail: "patches" },
    }),
    { op: "diff", detail: "patches" }
  );
});

test("forwarded call args preserve routing-operation selectors and remove selectors from global calls", () => {
  const callerRoutingArgs = {
    op: "bind",
    context_id: "TAB-NEW",
    _windowID: 11,
  };
  assert.deepEqual(
    buildForwardedCallArgs({
      forwardingClass: "routing_mutation",
      userArgs: callerRoutingArgs,
      verifiedSelectors: { _windowID: 5, context_id: "TAB-OLD" },
    }),
    callerRoutingArgs
  );
  assert.deepEqual(
    buildForwardedCallArgs({
      forwardingClass: "route_independent",
      userArgs: { op: "poll", session_id: "SESSION", _windowID: 5, context_id: "TAB-OLD" },
    }),
    { op: "poll", session_id: "SESSION" }
  );
});

test("ordinary calls receive one verified selector set without overwriting matching caller selectors", () => {
  const selectors = { _windowID: 5, context_id: "TAB-LIVE" };
  assert.deepEqual(
    buildForwardedCallArgs({
      forwardingClass: "route_dependent",
      userArgs: { path: "src/index.ts" },
      verifiedSelectors: selectors,
    }),
    { path: "src/index.ts", ...selectors }
  );
  assert.deepEqual(
    buildForwardedCallArgs({
      forwardingClass: "route_dependent",
      userArgs: { path: "src/index.ts", ...selectors },
      verifiedSelectors: selectors,
    }),
    { path: "src/index.ts", ...selectors }
  );
  assert.deepEqual(
    buildForwardedCallArgs({
      forwardingClass: "route_dependent",
      userArgs: { path: "src/index.ts", _windowID: 99, context_id: "CALLER" },
      verifiedSelectors: selectors,
    }),
    { path: "src/index.ts", ...selectors }
  );
});

test("manage_worktree source semantics pin only route-changing operations as routing mutations", () => {
  const expected = new Map([
    ["list", "route_dependent"],
    ["show", "route_dependent"],
    ["create", "workspace_routing_mutation"],
    ["bind", "workspace_routing_mutation"],
    ["select", "workspace_routing_mutation"],
    ["unbind", "workspace_routing_mutation"],
    ["preview", "route_dependent"],
    ["apply", "route_dependent"],
    ["status", "route_dependent"],
    ["continue", "route_dependent"],
    ["abort", "route_dependent"],
  ]);

  for (const [operation, forwardingClass] of expected) {
    assert.deepEqual(classifyForwardingOperation("manage_worktree", operation), {
      kind: "classified",
      forwardingClass,
    });
  }
});

test("manage_worktree routing mutations receive no injected route selectors", () => {
  assert.deepEqual(
    buildForwardedCallArgs({
      forwardingClass: "workspace_routing_mutation",
      userArgs: { op: "bind", worktree_id: "WT-1", session_id: "SESSION-1" },
      verifiedSelectors: { _windowID: 5, context_id: "TAB-LIVE" },
    }),
    { op: "bind", worktree_id: "WT-1", session_id: "SESSION-1" }
  );
});

test("the pinned current operation inventory has no unclassified routing action", () => {
  for (const operation of BIND_CONTEXT_OPERATIONS) {
    assert.equal(classifyForwardingOperation("bind_context", operation).kind, "classified");
  }
  for (const action of MANAGE_WORKSPACES_ACTIONS) {
    assert.equal(classifyForwardingOperation("manage_workspaces", action).kind, "classified");
  }
  for (const operation of MANAGE_WORKTREE_OPERATIONS) {
    assert.equal(classifyForwardingOperation("manage_worktree", operation).kind, "classified");
  }
  for (const operation of AGENT_RUN_OPERATIONS) {
    assert.equal(classifyForwardingOperation("agent_run", operation).kind, "classified");
  }
  for (const operation of AGENT_MANAGE_OPERATIONS) {
    assert.equal(classifyForwardingOperation("agent_manage", operation).kind, "classified");
  }

  assert.equal(classifyForwardingOperation("bind_context", "future").kind, "rejected");
  assert.equal(classifyForwardingOperation("manage_workspaces", "future").kind, "rejected");
  assert.equal(classifyForwardingOperation("manage_worktree", "future").kind, "rejected");
  assert.deepEqual(classifyForwardingOperation("future_additive_tool"), {
    kind: "classified",
    forwardingClass: "route_dependent",
  });
});

test("prototype property names are rejected as unknown routing operations", () => {
  for (const toolName of ["bind_context", "manage_workspaces", "manage_worktree", "agent_run", "agent_manage"]) {
    for (const operation of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      assert.equal(
        classifyForwardingOperation(toolName, operation).kind,
        "rejected",
        `${toolName} ${operation}`
      );
    }
  }
});

test("operation extraction and mutation ownership are explicit", () => {
  assert.equal(operationForTool("manage_workspaces", { action: "create_tab" }), "create_tab");
  assert.equal(operationForTool("bind_context", { op: "bind" }), "bind");
  assert.equal(isRoutingMutationClass("routing_mutation"), true);
  assert.equal(isRoutingMutationClass("workspace_routing_mutation"), true);
  assert.equal(isRoutingMutationClass("routing_observation"), false);
  assert.equal(isRoutingMutationClass("route_dependent"), false);
});
