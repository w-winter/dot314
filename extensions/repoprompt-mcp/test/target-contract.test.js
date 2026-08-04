import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_MANAGE_OPERATIONS,
  AGENT_RUN_OPERATIONS,
  BIND_CONTEXT_OPERATIONS,
  CE_1_2_TARGET_CONTRACT,
  CLASSIC_2_1_32_TARGET_CONTRACT,
  MANAGE_WORKSPACES_ACTIONS,
  MANAGE_WORKTREE_OPERATIONS,
  classifyForwardingOperation,
} from "../dist/target-contract.js";
import { catalog as ceCatalog, evidence as ceEvidence, inventoryScenarios as ceScenarios } from "./fixtures/ce-1.2/evidence.js";
import {
  catalog as classicCatalog,
  evidence as classicEvidence,
  inventoryScenarios as classicScenarios,
} from "./fixtures/classic-2.1.32/evidence.js";

function expectClass(toolName, operation, forwardingClass) {
  assert.deepEqual(classifyForwardingOperation(toolName, operation), {
    kind: "classified",
    forwardingClass,
  });
}

function catalogWithMutation(catalog, mutate) {
  const clone = structuredClone(catalog.tools);
  mutate(clone);
  return clone;
}

function operationEnum(catalog, toolName, propertyName) {
  return catalog.tools.find((tool) => tool.name === toolName).inputSchema.properties[propertyName].enum;
}

test("supported target profiles construct target-correct inventory and bind requests", () => {
  assert.deepEqual(CE_1_2_TARGET_CONTRACT.inventoryArgs(), { op: "list", _rawJSON: true });
  assert.deepEqual(CLASSIC_2_1_32_TARGET_CONTRACT.inventoryArgs(), { op: "list", _rawJSON: true });
  assert.deepEqual(
    CE_1_2_TARGET_CONTRACT.bindArgs("00000000-0000-4000-8000-000000000001", 10),
    { op: "bind", context_id: "00000000-0000-4000-8000-000000000001" }
  );
  assert.deepEqual(
    CLASSIC_2_1_32_TARGET_CONTRACT.bindArgs("00000000-0000-4000-8000-000000000001", 10),
    { op: "bind", context_id: "00000000-0000-4000-8000-000000000001", window_id: 10 }
  );
  assert.deepEqual(CE_1_2_TARGET_CONTRACT.rootObservationArgs(11), {
    type: "roots",
    _windowID: 11,
    _rawJSON: true,
  });
});

test("frozen catalogs establish target-specific Oracle and code-structure capabilities", () => {
  const ce = CE_1_2_TARGET_CONTRACT.inspectCapabilities(ceCatalog.tools);
  const classic = CLASSIC_2_1_32_TARGET_CONTRACT.inspectCapabilities(classicCatalog.tools);

  assert.equal(ce.kind, "supported");
  assert.deepEqual(ce.capabilities.oracle, {
    kind: "available",
    value: { modes: ["chat", "plan", "review"] },
  });
  assert.deepEqual(ce.capabilities.codeStructure, {
    kind: "available",
    value: { vocabulary: ["paths", "expand", "depth", "signatures", "size"] },
  });
  assert.equal(ce.capabilities.rootObservation.kind, "available");
  assert.equal(ce.capabilities.inventoryRequiresObservation, false);

  assert.equal(classic.kind, "supported");
  assert.deepEqual(classic.capabilities.oracle, {
    kind: "available",
    value: { modes: ["chat", "plan", "edit", "review"] },
  });
  assert.deepEqual(classic.capabilities.codeStructure, {
    kind: "available",
    value: { vocabulary: ["scope", "paths", "max_results"] },
  });
  assert.equal(classic.capabilities.rootObservation.kind, "unavailable");
  assert.equal(classic.capabilities.inventoryRequiresObservation, true);
});

test("CE 1.2 raw workspace mode schema passes while emitted call arguments remain required", () => {
  const workspaceSchema = ceCatalog.tools.find(
    (tool) => tool.name === "manage_workspaces"
  ).inputSchema;
  assert.deepEqual(workspaceSchema.properties.mode, { type: "string" });
  assert.equal(CE_1_2_TARGET_CONTRACT.inspectCapabilities(ceCatalog.tools).kind, "supported");

  const withoutUnownedMode = catalogWithMutation(ceCatalog, (tools) => {
    delete tools.find((tool) => tool.name === "manage_workspaces").inputSchema.properties.mode;
  });
  assert.equal(CE_1_2_TARGET_CONTRACT.inspectCapabilities(withoutUnownedMode).kind, "supported");

  const emittedProperties = new Map([
    ["action", "string"],
    ["window_id", "integer"],
    ["bind", "boolean"],
    ["focus", "boolean"],
  ]);
  for (const [propertyName, expectedType] of emittedProperties) {
    const missing = catalogWithMutation(ceCatalog, (tools) => {
      delete tools.find(
        (tool) => tool.name === "manage_workspaces"
      ).inputSchema.properties[propertyName];
    });
    const changed = catalogWithMutation(ceCatalog, (tools) => {
      tools.find(
        (tool) => tool.name === "manage_workspaces"
      ).inputSchema.properties[propertyName].type = expectedType === "string" ? "integer" : "string";
    });

    for (const candidate of [missing, changed]) {
      const result = CE_1_2_TARGET_CONTRACT.inspectCapabilities(candidate);
      assert.equal(result.kind, "unsupported");
      assert.ok(result.diagnostics.some((diagnostic) => diagnostic.includes(propertyName)));
    }
  }

  const missingCreateTabAction = catalogWithMutation(ceCatalog, (tools) => {
    const action = tools.find(
      (tool) => tool.name === "manage_workspaces"
    ).inputSchema.properties.action;
    action.enum = action.enum.filter((value) => value !== "create_tab");
  });
  const result = CE_1_2_TARGET_CONTRACT.inspectCapabilities(missingCreateTabAction);
  assert.equal(result.kind, "unsupported");
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.includes("create_tab")));
});

test("schema recognition uses containment and accepts harmless additive catalog changes", () => {
  const additiveTools = catalogWithMutation(ceCatalog, (tools) => {
    tools.push({ name: "future_tool", description: "additive", inputSchema: { type: "object" } });
    tools.find((tool) => tool.name === "bind_context").inputSchema.properties.future_selector = { type: "string" };
    tools.find((tool) => tool.name === "bind_context").inputSchema.properties.op.enum.push("future_observation");
    tools.find((tool) => tool.name === "oracle_send").inputSchema.properties.mode.enum.push("future_mode");
  });

  assert.equal(CE_1_2_TARGET_CONTRACT.inspectCapabilities(additiveTools).kind, "supported");
});

test("core routing fingerprint ignores unowned operation and property removal", () => {
  const withoutUnownedCapabilities = catalogWithMutation(ceCatalog, (tools) => {
    const workspaceSchema = tools.find(
      (tool) => tool.name === "manage_workspaces"
    ).inputSchema;
    workspaceSchema.properties.action.enum = workspaceSchema.properties.action.enum.filter(
      (value) => value !== "remove_folder"
    );
    delete workspaceSchema.properties.folder_path;
    delete workspaceSchema.properties.allow_active;
  });

  assert.equal(
    CE_1_2_TARGET_CONTRACT.inspectCapabilities(withoutUnownedCapabilities).kind,
    "supported"
  );
});

test("schema recognition rejects changed core routing shapes", () => {
  const missingContextSelector = catalogWithMutation(ceCatalog, (tools) => {
    delete tools.find((tool) => tool.name === "bind_context").inputSchema.properties.context_id;
  });
  const operationNotRequired = catalogWithMutation(ceCatalog, (tools) => {
    tools.find((tool) => tool.name === "bind_context").inputSchema.required = [];
  });
  const changedSelectorType = catalogWithMutation(ceCatalog, (tools) => {
    tools.find((tool) => tool.name === "bind_context").inputSchema.properties.context_id.type = "integer";
  });
  const additiveRequiredProperty = catalogWithMutation(ceCatalog, (tools) => {
    const schema = tools.find((tool) => tool.name === "bind_context").inputSchema;
    schema.properties.future_selector = { type: "string" };
    schema.required.push("future_selector");
  });
  const changedSchemaType = catalogWithMutation(ceCatalog, (tools) => {
    tools.find((tool) => tool.name === "bind_context").inputSchema.type = "array";
  });

  for (const tools of [
    missingContextSelector,
    operationNotRequired,
    changedSelectorType,
    additiveRequiredProperty,
    changedSchemaType,
  ]) {
    const result = CE_1_2_TARGET_CONTRACT.inspectCapabilities(tools);
    assert.equal(result.kind, "unsupported");
    assert.ok(result.diagnostics.length > 0);
  }
});

test("optional feature drift is diagnosed without rejecting the core routing contract", () => {
  const tools = catalogWithMutation(ceCatalog, (catalogTools) => {
    catalogTools.find((tool) => tool.name === "oracle_send").inputSchema.properties.mode.enum = ["chat", "plan"];
    const codeStructure = catalogTools.find((tool) => tool.name === "get_code_structure").inputSchema.properties;
    codeStructure.paths.items.type = "integer";
    delete codeStructure.size;
  });
  const result = CE_1_2_TARGET_CONTRACT.inspectCapabilities(tools);

  assert.equal(result.kind, "supported");
  assert.equal(result.capabilities.oracle.kind, "unavailable");
  assert.match(result.capabilities.oracle.diagnostic, /review/u);
  assert.equal(result.capabilities.codeStructure.kind, "unavailable");
  assert.match(result.capabilities.codeStructure.diagnostic, /size/u);
});

test("classification tables exactly match the frozen advertised operation enums", () => {
  for (const catalog of [ceCatalog, classicCatalog]) {
    assert.deepEqual(operationEnum(catalog, "bind_context", "op"), [...BIND_CONTEXT_OPERATIONS]);
    assert.deepEqual(operationEnum(catalog, "manage_workspaces", "action"), [...MANAGE_WORKSPACES_ACTIONS]);
    assert.deepEqual(operationEnum(catalog, "agent_run", "op"), [...AGENT_RUN_OPERATIONS]);
    assert.deepEqual(operationEnum(catalog, "agent_manage", "op"), [...AGENT_MANAGE_OPERATIONS]);
  }
  assert.deepEqual(operationEnum(ceCatalog, "manage_worktree", "op"), [...MANAGE_WORKTREE_OPERATIONS]);
});

test("all bind_context and manage_workspaces operations have pinned classifications", () => {
  assert.deepEqual(BIND_CONTEXT_OPERATIONS, ["list", "status", "bind"]);
  expectClass("bind_context", "list", "routing_observation");
  expectClass("bind_context", "status", "routing_observation");
  expectClass("bind_context", "bind", "routing_mutation");

  assert.equal(MANAGE_WORKSPACES_ACTIONS.length, 12);
  for (const operation of ["list", "list_tabs"]) {
    expectClass("manage_workspaces", operation, "workspace_observation");
  }
  for (const operation of MANAGE_WORKSPACES_ACTIONS.filter((value) => !["list", "list_tabs"].includes(value))) {
    expectClass("manage_workspaces", operation, "workspace_routing_mutation");
  }
});

test("manage_worktree, agent_run, and agent_manage requirements are pinned", () => {
  assert.equal(MANAGE_WORKTREE_OPERATIONS.length, 11);
  for (const operation of ["create", "bind", "select", "unbind"]) {
    expectClass("manage_worktree", operation, "workspace_routing_mutation");
  }
  for (const operation of MANAGE_WORKTREE_OPERATIONS.filter(
    (value) => !["create", "bind", "select", "unbind"].includes(value)
  )) {
    expectClass("manage_worktree", operation, "route_dependent");
  }

  assert.equal(AGENT_RUN_OPERATIONS.length, 6);
  expectClass("agent_run", "start", "route_dependent");
  for (const operation of AGENT_RUN_OPERATIONS.filter((value) => value !== "start")) {
    expectClass("agent_run", operation, "route_independent");
  }

  assert.equal(AGENT_MANAGE_OPERATIONS.length, 10);
  for (const operation of ["list_sessions", "create_session"]) {
    expectClass("agent_manage", operation, "route_dependent");
  }
  for (const operation of AGENT_MANAGE_OPERATIONS.filter((value) => !["list_sessions", "create_session"].includes(value))) {
    expectClass("agent_manage", operation, "route_independent");
  }
});

test("unknown routing operations fail closed and unknown additive tools default route-dependent", () => {
  assert.equal(classifyForwardingOperation("bind_context", "future").kind, "rejected");
  assert.equal(classifyForwardingOperation("manage_workspaces", "future").kind, "rejected");
  assert.equal(classifyForwardingOperation("manage_worktree", "future").kind, "rejected");
  expectClass("future_additive_tool", undefined, "route_dependent");
  expectClass("app_settings", undefined, "route_independent");
  expectClass("RepoPrompt_oracle_send_wait", undefined, "route_independent");
});

test("fixtures pin scenario coverage and hidden-selector evidence without inventing Classic proof", () => {
  for (const scenarios of [ceScenarios, classicScenarios]) {
    for (const name of ["multiWindow", "validEmpty", "unbound", "rootUnavailable", "malformed"]) {
      assert.ok(name in scenarios, `missing ${name}`);
    }
  }

  assert.equal(ceEvidence.hiddenWindowSelector, "proven");
  assert.equal(ceEvidence.jsonInventory, "proven");
  assert.equal(classicEvidence.hiddenWindowSelector, "unresolved");
  assert.equal(classicEvidence.jsonInventory, "unresolved");
  assert.match(classicEvidence.diagnostic, /Classic 2\.1\.32 \(334\).*binding_kind context/u);
  assert.equal(classicCatalog.tools.some((tool) => tool.name === "manage_worktree"), false);
});
