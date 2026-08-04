import assert from "node:assert/strict";
import test from "node:test";

import { summarizeRpCall, summarizeRpResult } from "../dist/presentation-summary.js";


test("summarizeRpCall condenses common tool calls", () => {
  assert.equal(
    summarizeRpCall({
      call: "read_file",
      args: { path: "daily_monitor.py", start_line: 121, limit: 120 },
    }),
    "Read File • daily_monitor.py"
  );

  assert.equal(
    summarizeRpCall({
      call: "file_search",
      args: { pattern: "run_queries", path: "daily_monitor.py" },
    }),
    'Search • "run_queries"'
  );

  assert.equal(
    summarizeRpCall({
      call: "manage_workspaces",
      args: { action: "create", name: "Invocing", open_in_new_window: true },
    }),
    "Create Workspace • Invocing"
  );

  assert.equal(
    summarizeRpCall({ search: "workspace" }),
    'Tool Search • "workspace"'
  );

  assert.equal(
    summarizeRpCall({ describe: "manage_workspaces" }),
    "Describe • manage_workspaces"
  );

  assert.equal(
    summarizeRpCall({ windows: true }),
    "Windows"
  );

  assert.equal(
    summarizeRpCall({ bind: { window: 16 } }),
    "Bind • W16"
  );

  assert.equal(
    summarizeRpCall({}),
    "Status"
  );
});


test("get_code_structure summaries use the arguments actually sent for Classic and CE", () => {
  const classicArgs = {
    paths: ["src/a.ts", "src/b.ts"],
    scope: "paths",
    max_results: 25,
  };
  const ceArgs = {
    paths: ["src"],
    expand: "both",
    depth: 2,
    signatures: false,
    size: "large",
  };

  assert.equal(
    summarizeRpCall({ call: "get_code_structure", args: classicArgs }),
    "Code Structure • paths src/a.ts, src/b.ts • scope paths • max_results 25"
  );
  assert.deepEqual(
    summarizeRpResult({ mode: "call", tool: "get_code_structure", args: classicArgs }),
    { primary: "paths src/a.ts, src/b.ts • scope paths • max_results 25" }
  );
  assert.equal(
    summarizeRpCall({ call: "get_code_structure", args: ceArgs }),
    "Code Structure • paths src • expand both • depth 2 • signatures false • size large"
  );
  assert.deepEqual(
    summarizeRpResult({ mode: "call", tool: "get_code_structure", args: ceArgs }),
    { primary: "paths src • expand both • depth 2 • signatures false • size large" }
  );
  assert.equal(summarizeRpCall({ call: "get_code_structure", args: {} }), "Code Structure");
  assert.deepEqual(
    summarizeRpResult({ mode: "call", tool: "get_code_structure", args: {} }),
    { primary: "structure loaded" }
  );
});


test("summarizeRpResult condenses read and search tool results", () => {
  assert.deepEqual(
    summarizeRpResult({
      mode: "call",
      tool: "read_file",
      args: { path: "daily_monitor.py", start_line: 121, limit: 120 },
    }),
    {
      primary: "lines 121-240",
    }
  );

  assert.deepEqual(
    summarizeRpResult({
      mode: "call",
      tool: "file_search",
      args: { pattern: "run_queries", filter: { paths: ["daily_monitor.py"] } },
    }),
    {
      primary: "in daily_monitor.py",
    }
  );
});


test("summarizeRpResult condenses workspace and binding state", () => {
  assert.deepEqual(
    summarizeRpResult({
      mode: "search",
      count: 3,
    }),
    {
      primary: "3 tools found",
    }
  );

  assert.deepEqual(
    summarizeRpResult({
      mode: "describe",
      tool: { name: "manage_workspaces" },
    }),
    {
      primary: "manage_workspaces • parameters available",
    }
  );

  assert.deepEqual(
    summarizeRpResult({
      mode: "call",
      tool: "workspace_context",
      args: { include: ["prompt", "selection", "code"] },
    }),
    {
      primary: "prompt, selection, code",
    }
  );

  assert.deepEqual(
    summarizeRpResult({
      mode: "call",
      tool: "manage_workspaces",
      args: { action: "create", name: "Invocing", open_in_new_window: true },
    }),
    {
      primary: "Invocing • new window",
    }
  );

  assert.deepEqual(
    summarizeRpResult({
      mode: "call",
      tool: "manage_workspaces",
      args: { action: "list" },
    }),
    {
      primary: "workspaces listed",
    }
  );

  assert.deepEqual(
    summarizeRpResult({
      mode: "windows",
      count: 6,
    }),
    {
      primary: "6 windows available",
    }
  );

  assert.deepEqual(
    summarizeRpResult({
      mode: "bind",
      binding: { windowId: 16, workspace: "pi-mono (1)" },
      tabLabel: "agent",
    }),
    {
      primary: "pi-mono (1) • Tab agent",
    }
  );

  assert.deepEqual(
    summarizeRpResult({
      mode: "status",
      status: "connected",
      toolsCount: 23,
      binding: { windowId: 16, workspace: "pi-mono (1)" },
    }),
    {
      primary: "connected • 23 tools • W16 • pi-mono (1)",
    }
  );
});
