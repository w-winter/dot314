import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { pathToFileURL } from "node:url";

import {
  bindToTab,
  clearBinding,
  createAndBindTab,
  ensureBindingHasTab,
  findMatchingWindow,
  parseRootList,
  parseTabList,
  parseWindowList,
  persistBinding,
  restoreBinding,
} from "../dist/binding.js";
import { AUTO_SELECTION_ENTRY_TYPE, BINDING_ENTRY_TYPE } from "../dist/types.js";

const HOME = os.homedir();

function makeMockSession(branchEntries = []) {
  const entries = [...branchEntries];
  const pi = {
    appendEntry(customType, data) {
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

function makeTextResult(text) {
  return {
    isError: false,
    content: [{ type: "text", text }],
  };
}

test.afterEach(() => {
  clearBinding();
});

test("parseWindowList parses workspaces with suffixes and instances", () => {
  const input = [
    "- Window `1` • WS: chat-tree (5) • Roots: 1 • instance=1",
    "- Window `3` • WS: dot314 • Roots: 2 • instance=4",
    "- Window `4` • WS: wave-metrics (4) • Roots: 1",
  ].join("\n");

  const windows = parseWindowList(input);

  assert.equal(windows.length, 3);
  assert.deepEqual(
    windows.map((w) => ({ id: w.id, workspace: w.workspace, instance: w.instance })),
    [
      { id: 1, workspace: "chat-tree (5)", instance: 1 },
      { id: 3, workspace: "dot314", instance: 4 },
      { id: 4, workspace: "wave-metrics (4)", instance: undefined },
    ]
  );
});

test("parseRootList handles bullets, file:// URIs, and ~", () => {
  const absPath = path.join(HOME, "dot314");
  const fileUriPath = path.join(HOME, "pi-mono");
  const fileUri = pathToFileURL(fileUriPath).toString();

  const input = [
    `- ${absPath}`,
    `• ${fileUri}`,
    "~/.config",
  ].join("\n");

  const roots = parseRootList(input);

  assert.ok(roots.includes(absPath));
  assert.ok(roots.includes(fileUriPath));
  assert.ok(roots.includes(path.join(HOME, ".config")));
});

test("findMatchingWindow prefers the most specific matching root per window", () => {
  const dot314Root = path.join(HOME, "dot314");
  const piMonoRoot = path.join(HOME, "pi-mono");

  const windows = [
    {
      id: 1,
      workspace: "A",
      roots: [HOME, dot314Root],
    },
    {
      id: 2,
      workspace: "B",
      roots: [piMonoRoot],
    },
  ];

  const result = findMatchingWindow(windows, path.join(dot314Root, "agent", "extensions"));

  assert.equal(result.ambiguous, false);
  assert.equal(result.window?.id, 1);
  assert.equal(result.root, dot314Root);
});

test("findMatchingWindow matches when cwd equals the root", () => {
  const dot314Root = path.join(HOME, "dot314");

  const windows = [
    {
      id: 1,
      workspace: "A",
      roots: [dot314Root],
    },
  ];

  const result = findMatchingWindow(windows, dot314Root);

  assert.equal(result.ambiguous, false);
  assert.equal(result.window?.id, 1);
  assert.equal(result.root, dot314Root);
});

test("findMatchingWindow resolves symlinked roots before matching cwd", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "rp-binding-"));

  try {
    const realRoot = path.join(tempDir, "real-root");
    const symlinkRoot = path.join(tempDir, "symlink-root");
    const realCwd = path.join(realRoot, "agent");

    mkdirSync(realCwd, { recursive: true });
    symlinkSync(realRoot, symlinkRoot);

    const windows = [
      {
        id: 5,
        workspace: "pi-agent",
        roots: [symlinkRoot],
      },
    ];

    const result = findMatchingWindow(windows, realCwd);

    assert.equal(result.ambiguous, false);
    assert.equal(result.window?.id, 5);
    assert.equal(result.root, symlinkRoot);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("findMatchingWindow returns null when cwd is outside all roots", () => {
  const dot314Root = path.join(HOME, "dot314");

  const windows = [
    {
      id: 1,
      workspace: "A",
      roots: [dot314Root],
    },
  ];

  const result = findMatchingWindow(windows, path.join(HOME, "somewhere-else"));

  assert.equal(result.ambiguous, false);
  assert.equal(result.window, null);
  assert.equal(result.root, null);
  assert.equal(result.matches.length, 0);
});

test("findMatchingWindow returns ambiguous when best match is tied across windows", () => {
  const dot314Root = path.join(HOME, "dot314");

  const windows = [
    {
      id: 1,
      workspace: "A",
      roots: [dot314Root],
    },
    {
      id: 2,
      workspace: "B",
      roots: [dot314Root],
    },
  ];

  const result = findMatchingWindow(windows, path.join(dot314Root, "agent"));

  assert.equal(result.ambiguous, true);
  assert.equal(result.window, null);
  assert.equal(result.root, null);
  assert.equal(result.matches.length, 2);
});

test("parseTabList parses active and bound flags", () => {
  const tabs = parseTabList([
    "- `TAB-1` • Alpha [active] [bound]",
    "- `TAB-2` • Beta",
  ].join("\n"));

  assert.deepEqual(tabs, [
    { id: "TAB-1", name: "Alpha", isActive: true, isBound: true },
    { id: "TAB-2", name: "Beta", isActive: undefined, isBound: undefined },
  ]);
});

test("parseTabList strips combined state annotations from tab names", () => {
  const tabs = parseTabList([
    "- `TAB-1` • T3 [active, bound]",
    "- `TAB-2` • T4 [bound, out-of-focus]",
    "- `TAB-3` • T5 [bound, in-focus]",
  ].join("\n"));

  assert.deepEqual(tabs, [
    { id: "TAB-1", name: "T3", isActive: true, isBound: true },
    { id: "TAB-2", name: "T4", isActive: false, isBound: true },
    { id: "TAB-3", name: "T5", isActive: true, isBound: true },
  ]);
});

test("parseTabList leaves missing focus markers as unknown", () => {
  const tabs = parseTabList([
    "- `TAB-1` • T3 [bound]",
    "- `TAB-2` • T4",
  ].join("\n"));

  assert.deepEqual(tabs, [
    { id: "TAB-1", name: "T3", isActive: undefined, isBound: true },
    { id: "TAB-2", name: "T4", isActive: undefined, isBound: undefined },
  ]);
});

test("parseTabList captures per-tab selected file counts from detail rows", () => {
  const tabs = parseTabList([
    "- `TAB-1` • T1 [active] [bound]",
    "  • 0 files",
    "- `TAB-2` • T2",
    "  • 2 files: binding.ts, types.ts",
  ].join("\n"));

  assert.deepEqual(tabs, [
    { id: "TAB-1", name: "T1", isActive: true, isBound: true, selectedFileCount: 0 },
    { id: "TAB-2", name: "T2", isActive: undefined, isBound: undefined, selectedFileCount: 2 },
  ]);
});

test("bindToTab selects a live tab by name and persists its concrete id", async () => {
  const { pi, entries } = makeMockSession();
  const config = {};

  const calls = [];
  const client = {
    isConnected: true,
    tools: [{ name: "list_windows" }, { name: "manage_workspaces" }],
    async callTool(name, args) {
      calls.push({ name, args });
      if (name === "list_windows") {
        return makeTextResult("- Window `5` • WS: pi-agent • Roots: 1");
      }
      if (args.action === "list_tabs") {
        return makeTextResult("## Tabs ✅\n\n- `UUID-T1` • T1 [active]\n- `UUID-T2` • T2 [bound]");
      }
      if (args.action === "select_tab") {
        return makeTextResult("Selected tab `UUID-T1`");
      }
      throw new Error(`Unexpected action: ${args.action}`);
    },
  };

  const binding = await bindToTab(pi, 5, "T1", config, client);

  assert.equal(binding.tab, "UUID-T1");
  assert.equal(binding.workspace, "pi-agent");
  assert.equal(calls.filter((call) => call.args?.action === "select_tab")[0]?.args?.tab, "UUID-T1");
  assert.equal(entries.at(-1)?.data?.tab, "UUID-T1");
});

test("createAndBindTab persists the created bound tab id", async () => {
  const { pi, entries } = makeMockSession();
  const config = {};

  let listTabsCount = 0;
  const client = {
    isConnected: true,
    tools: [{ name: "list_windows" }, { name: "manage_workspaces" }],
    async callTool(name, args) {
      if (name === "list_windows") {
        return makeTextResult("- Window `5` • WS: pi-agent • Roots: 1");
      }
      if (args.action === "create_tab") {
        return makeTextResult("Created tab `UUID-T3` • T3 [bound]");
      }
      if (args.action === "select_tab") {
        return makeTextResult("Selected tab `UUID-T3`");
      }
      if (args.action === "list_tabs") {
        listTabsCount += 1;
        return listTabsCount === 1
          ? makeTextResult("## Tabs ✅\n\n- `UUID-T3` • T3 [bound]")
          : makeTextResult("## Tabs ✅\n\n- `UUID-T3` • T3 [bound]");
      }
      throw new Error(`Unexpected action: ${args.action}`);
    },
  };

  const binding = await createAndBindTab(pi, 5, config, client);

  assert.equal(binding.tab, "UUID-T3");
  assert.equal(binding.workspace, "pi-agent");
  assert.equal(entries.at(-1)?.data?.tab, "UUID-T3");
});

test("createAndBindTab prefers the created tab when list_tabs still reports the old bound tab", async () => {
  const { pi, entries } = makeMockSession();
  const config = {};

  const calls = [];
  const client = {
    isConnected: true,
    tools: [{ name: "list_windows" }, { name: "manage_workspaces" }],
    async callTool(name, args) {
      calls.push({ name, args });
      if (name === "list_windows") {
        return makeTextResult("- Window `5` • WS: pi-agent • Roots: 1");
      }
      if (args.action === "create_tab") {
        return makeTextResult("Created tab `UUID-T14` • T14 [bound]");
      }
      if (args.action === "select_tab") {
        return makeTextResult("Selected tab `UUID-T14`");
      }
      if (args.action === "list_tabs") {
        return makeTextResult([
          "## Tabs ✅",
          "",
          "- `UUID-T1` • T1 [active] [bound]",
          "- `UUID-T14` • T14",
        ].join("\n"));
      }
      throw new Error(`Unexpected action: ${args.action}`);
    },
  };

  const binding = await createAndBindTab(pi, 5, config, client);

  assert.equal(binding.tab, "UUID-T14");
  assert.equal(entries.at(-1)?.data?.tab, "UUID-T14");
  assert.equal(calls.filter((call) => call.args?.action === "select_tab")[0]?.args?.tab, "UUID-T14");
});

test("createAndBindTab identifies the new tab from list_tabs delta when create_tab output is unparseable", async () => {
  const { pi, entries } = makeMockSession();
  const config = {};

  let listTabsCount = 0;
  const calls = [];
  const client = {
    isConnected: true,
    tools: [{ name: "list_windows" }, { name: "manage_workspaces" }],
    async callTool(name, args) {
      calls.push({ name, args });
      if (name === "list_windows") {
        return makeTextResult("- Window `5` • WS: pi-agent • Roots: 1");
      }
      if (args.action === "create_tab") {
        return makeTextResult("Created new tab");
      }
      if (args.action === "select_tab") {
        return makeTextResult("Selected tab `UUID-T14`");
      }
      if (args.action === "list_tabs") {
        listTabsCount += 1;
        return listTabsCount === 1
          ? makeTextResult([
              "## Tabs ✅",
              "",
              "- `UUID-T1` • T1 [active] [bound]",
            ].join("\n"))
          : makeTextResult([
              "## Tabs ✅",
              "",
              "- `UUID-T1` • T1 [active] [bound]",
              "- `UUID-T14` • T14",
            ].join("\n"));
      }
      throw new Error(`Unexpected action: ${args.action}`);
    },
  };

  const binding = await createAndBindTab(pi, 5, config, client);

  assert.equal(binding.tab, "UUID-T14");
  assert.equal(entries.at(-1)?.data?.tab, "UUID-T14");
  assert.equal(calls.filter((call) => call.args?.action === "select_tab")[0]?.args?.tab, "UUID-T14");
});

test("createAndBindTab fails closed when create_tab output is unparseable and no unique new tab appears", async () => {
  const { pi } = makeMockSession();
  const config = {};

  const client = {
    isConnected: true,
    tools: [{ name: "list_windows" }, { name: "manage_workspaces" }],
    async callTool(name, args) {
      if (name === "list_windows") {
        return makeTextResult("- Window `5` • WS: pi-agent • Roots: 1");
      }
      if (args.action === "create_tab") {
        return makeTextResult("Created new tab");
      }
      if (args.action === "list_tabs") {
        return makeTextResult([
          "## Tabs ✅",
          "",
          "- `UUID-T1` • T1 [active] [bound]",
        ].join("\n"));
      }
      throw new Error(`Unexpected action: ${args.action}`);
    },
  };

  await assert.rejects(
    () => createAndBindTab(pi, 5, config, client),
    /did not report the created tab unambiguously/
  );
});

test("restoreBinding falls back to the most recent auto-selection tab", () => {
  const { ctx } = makeMockSession([
    {
      type: "custom",
      customType: AUTO_SELECTION_ENTRY_TYPE,
      data: {
        windowId: 5,
        workspace: "pi-agent",
        tab: "TAB-AUTO",
        fullPaths: [],
        slicePaths: [],
      },
    },
  ]);

  const binding = restoreBinding(ctx, {});

  assert.deepEqual(binding, {
    windowId: 5,
    workspace: "pi-agent",
    tab: "TAB-AUTO",
  });
});

test("restoreBinding fills a missing binding tab from auto-selection history", () => {
  const { ctx } = makeMockSession([
    {
      type: "custom",
      customType: BINDING_ENTRY_TYPE,
      data: { windowId: 5, workspace: "pi-agent" },
    },
    {
      type: "custom",
      customType: AUTO_SELECTION_ENTRY_TYPE,
      data: {
        windowId: 5,
        workspace: "pi-agent",
        tab: "TAB-AUTO",
        fullPaths: [],
        slicePaths: [],
      },
    },
  ]);

  const binding = restoreBinding(ctx, {});

  assert.deepEqual(binding, {
    windowId: 5,
    workspace: "pi-agent",
    tab: "TAB-AUTO",
    autoDetected: false,
  });
});

test("ensureBindingHasTab reuses the most recent branch tab for the current window", async () => {
  const { pi, ctx, entries } = makeMockSession();
  const config = {};

  persistBinding(pi, { windowId: 5, workspace: "pi-agent", tab: "TAB-1" }, config);
  persistBinding(pi, { windowId: 5, workspace: "pi-agent" }, config);

  const calls = [];
  const client = {
    isConnected: true,
    tools: [{ name: "manage_workspaces" }],
    async callTool(name, args) {
      calls.push({ name, args });
      if (args.action === "list_tabs") {
        return makeTextResult("## Tabs ✅\n\n- `TAB-1` • Alpha\n- `TAB-2` • Beta [active]");
      }
      if (args.action === "select_tab") {
        return makeTextResult("Selected tab `TAB-1`");
      }
      throw new Error(`Unexpected action: ${args.action}`);
    },
  };

  const binding = await ensureBindingHasTab(pi, ctx, config, client);

  assert.equal(binding?.tab, "TAB-1");
  assert.equal(calls.filter((call) => call.args.action === "create_tab").length, 0);
  assert.equal(calls.filter((call) => call.args.action === "select_tab").length, 1);
  assert.equal(entries.at(-1)?.data?.tab, "TAB-1");
});

test("ensureBindingHasTab reuses the most recent auto-selection tab for the current window", async () => {
  const { pi, ctx, entries } = makeMockSession([
    {
      type: "custom",
      customType: AUTO_SELECTION_ENTRY_TYPE,
      data: {
        windowId: 5,
        workspace: "pi-agent",
        tab: "TAB-AUTO",
        fullPaths: [],
        slicePaths: [],
      },
    },
  ]);
  const config = {};

  persistBinding(pi, { windowId: 5, workspace: "pi-agent" }, config);

  const calls = [];
  const client = {
    isConnected: true,
    tools: [{ name: "manage_workspaces" }],
    async callTool(name, args) {
      calls.push({ name, args });
      if (args.action === "list_tabs") {
        return makeTextResult("## Tabs ✅\n\n- `TAB-AUTO` • T3\n- `TAB-OTHER` • T4 [active]");
      }
      if (args.action === "select_tab") {
        return makeTextResult("Selected tab `TAB-AUTO`");
      }
      throw new Error(`Unexpected action: ${args.action}`);
    },
  };

  const binding = await ensureBindingHasTab(pi, ctx, config, client);

  assert.equal(binding?.tab, "TAB-AUTO");
  assert.equal(calls.filter((call) => call.args.action === "create_tab").length, 0);
  assert.equal(calls.filter((call) => call.args.action === "select_tab").length, 1);
  assert.equal(entries.at(-1)?.data?.tab, "TAB-AUTO");
});

test("ensureBindingHasTab skips tab creation during replay when createIfMissing is false", async () => {
  const { pi, ctx } = makeMockSession();
  const config = {};

  persistBinding(pi, { windowId: 5, workspace: "pi-agent" }, config);

  const calls = [];
  const client = {
    isConnected: true,
    tools: [{ name: "manage_workspaces" }],
    async callTool(name, args) {
      calls.push({ name, args });
      if (args.action === "list_tabs") {
        return makeTextResult("## Tabs ✅\n\n- `TAB-OLD` • Existing [active]");
      }
      if (args.action === "select_tab") {
        return makeTextResult("Selected tab `TAB-OLD`");
      }
      if (args.action === "create_tab") {
        return makeTextResult("Created tab `TAB-NEW` • Pi Session [bound]");
      }
      throw new Error(`Unexpected action: ${args.action}`);
    },
  };

  const binding = await ensureBindingHasTab(pi, ctx, config, client, { createIfMissing: false });

  assert.equal(binding?.tab, undefined);
  assert.equal(calls.filter((call) => call.args.action === "create_tab").length, 0);
  assert.equal(calls.filter((call) => call.args.action === "select_tab").length, 0);
});

test("ensureBindingHasTab prefers the active populated tab for a window-only binding", async () => {
  const { pi, ctx, entries } = makeMockSession();
  const config = {};

  persistBinding(pi, { windowId: 5, workspace: "pi-agent" }, config);

  const calls = [];
  const client = {
    isConnected: true,
    tools: [{ name: "manage_workspaces" }],
    async callTool(name, args) {
      calls.push({ name, args });
      if (args.action === "list_tabs") {
        return makeTextResult([
          "## Tabs ✅",
          "",
          "- `TAB-1` • T1 [active]",
          "  • 3 files: package.json, ConversationTree.tsx, constants.ts",
          "- `TAB-2` • T2 [bound]",
          "  • 0 files",
        ].join("\n"));
      }
      if (args.action === "select_tab") {
        return makeTextResult("Selected tab `TAB-1`");
      }
      if (args.action === "create_tab") {
        return makeTextResult("Created tab `TAB-3` • T3 [bound]");
      }
      throw new Error(`Unexpected action: ${args.action}`);
    },
  };

  const binding = await ensureBindingHasTab(pi, ctx, config, client, {
    reuseSoleEmptyTab: true,
  });

  assert.equal(binding?.tab, "TAB-1");
  assert.equal(calls.filter((call) => call.args.action === "create_tab").length, 0);
  assert.equal(calls.filter((call) => call.args.action === "select_tab").length, 1);
  assert.equal(entries.at(-1)?.data?.tab, "TAB-1");
});

test("ensureBindingHasTab prefers the active populated tab over stale branch tab history for a window-only binding", async () => {
  const { pi, ctx, entries } = makeMockSession();
  const config = {};

  persistBinding(pi, { windowId: 5, workspace: "pi-agent", tab: "TAB-OLD" }, config);
  persistBinding(pi, { windowId: 5, workspace: "pi-agent" }, config);

  const calls = [];
  const client = {
    isConnected: true,
    tools: [{ name: "manage_workspaces" }],
    async callTool(name, args) {
      calls.push({ name, args });
      if (args.action === "list_tabs") {
        return makeTextResult([
          "## Tabs ✅",
          "",
          "- `TAB-ACTIVE` • T2 [active]",
          "  • 3 files: package.json, ConversationTree.tsx, constants.ts",
          "- `TAB-OLD` • T1 [bound]",
          "  • 0 files",
        ].join("\n"));
      }
      if (args.action === "select_tab") {
        return makeTextResult("Selected tab `TAB-ACTIVE`");
      }
      if (args.action === "create_tab") {
        return makeTextResult("Created tab `TAB-NEW` • T3 [bound]");
      }
      throw new Error(`Unexpected action: ${args.action}`);
    },
  };

  const binding = await ensureBindingHasTab(pi, ctx, config, client, {
    reuseSoleEmptyTab: true,
  });

  assert.equal(binding?.tab, "TAB-ACTIVE");
  assert.equal(calls.filter((call) => call.args.action === "create_tab").length, 0);
  assert.equal(calls.filter((call) => call.args.action === "select_tab").length, 1);
  assert.equal(entries.at(-1)?.data?.tab, "TAB-ACTIVE");
});

test("ensureBindingHasTab reuses the sole empty tab instead of creating a new tab", async () => {
  const { pi, ctx, entries } = makeMockSession();
  const config = {};

  persistBinding(pi, { windowId: 5, workspace: "pi-agent" }, config);

  const calls = [];
  const client = {
    isConnected: true,
    tools: [{ name: "manage_workspaces" }],
    async callTool(name, args) {
      calls.push({ name, args });
      if (args.action === "list_tabs") {
        return makeTextResult([
          "## Tabs ✅",
          "",
          "- `TAB-1` • T1 [active]",
          "  • 0 files",
        ].join("\n"));
      }
      if (args.action === "select_tab") {
        return makeTextResult("Selected tab `TAB-1`");
      }
      if (args.action === "create_tab") {
        return makeTextResult("Created tab `TAB-2` • T2 [bound]");
      }
      throw new Error(`Unexpected action: ${args.action}`);
    },
  };

  const binding = await ensureBindingHasTab(pi, ctx, config, client, {
    reuseSoleEmptyTab: true,
  });

  assert.equal(binding?.tab, "TAB-1");
  assert.equal(calls.filter((call) => call.args.action === "create_tab").length, 0);
  assert.equal(calls.filter((call) => call.args.action === "select_tab").length, 1);
  assert.equal(entries.at(-1)?.data?.tab, "TAB-1");
});

test("ensureBindingHasTab reuses an already bound empty tab before creating a new tab", async () => {
  const { pi, ctx, entries } = makeMockSession();
  const config = {};

  persistBinding(pi, { windowId: 5, workspace: "pi-agent" }, config);

  const calls = [];
  const client = {
    isConnected: true,
    tools: [{ name: "manage_workspaces" }],
    async callTool(name, args) {
      calls.push({ name, args });
      if (args.action === "list_tabs") {
        return makeTextResult([
          "## Tabs ✅",
          "",
          "- `TAB-1` • T1 [active]",
          "  • 0 files",
          "- `TAB-2` • T2 [bound]",
          "  • 0 files",
        ].join("\n"));
      }
      if (args.action === "select_tab") {
        return makeTextResult("Selected tab `TAB-2`");
      }
      if (args.action === "create_tab") {
        return makeTextResult("Created tab `TAB-3` • T3 [bound]");
      }
      throw new Error(`Unexpected action: ${args.action}`);
    },
  };

  const binding = await ensureBindingHasTab(pi, ctx, config, client, {
    reuseSoleEmptyTab: true,
  });

  assert.equal(binding?.tab, "TAB-2");
  assert.equal(calls.filter((call) => call.args.action === "create_tab").length, 0);
  assert.equal(calls.filter((call) => call.args.action === "select_tab").length, 0);
  assert.equal(entries.at(-1)?.data?.tab, "TAB-2");
});

test("ensureBindingHasTab reuses an existing empty tab when multiple blank tabs are available", async () => {
  const { pi, ctx, entries } = makeMockSession();
  const config = {};

  persistBinding(pi, { windowId: 5, workspace: "pi-agent" }, config);

  const calls = [];
  const client = {
    isConnected: true,
    tools: [{ name: "manage_workspaces" }],
    async callTool(name, args) {
      calls.push({ name, args });
      if (args.action === "list_tabs") {
        return makeTextResult([
          "## Tabs ✅",
          "",
          "- `TAB-1` • T1 [active]",
          "  • 0 files",
          "- `TAB-2` • T2",
          "  • 0 files",
        ].join("\n"));
      }
      if (args.action === "select_tab") {
        return makeTextResult("Selected tab `TAB-1`");
      }
      if (args.action === "create_tab") {
        return makeTextResult("Created tab `TAB-3` • T3 [bound]");
      }
      throw new Error(`Unexpected action: ${args.action}`);
    },
  };

  const binding = await ensureBindingHasTab(pi, ctx, config, client, {
    reuseSoleEmptyTab: true,
  });

  assert.equal(binding?.tab, "TAB-1");
  assert.equal(calls.filter((call) => call.args.action === "create_tab").length, 0);
  assert.equal(calls.filter((call) => call.args.action === "select_tab").length, 1);
  assert.equal(entries.at(-1)?.data?.tab, "TAB-1");
});

test("ensureBindingHasTab does not create a new tab during passive replay when the prior tab is stale and there is no recoverable state", async () => {
  const { pi, ctx } = makeMockSession();
  const config = {};

  persistBinding(pi, { windowId: 5, workspace: "pi-agent", tab: "TAB-OLD" }, config);

  const calls = [];
  const client = {
    isConnected: true,
    tools: [{ name: "manage_workspaces" }],
    async callTool(name, args) {
      calls.push({ name, args });
      if (args.action === "list_tabs") {
        return makeTextResult("## Tabs ✅\n\n- `TAB-OTHER` • Existing [active]\n  • 3 files: a.ts, b.ts, c.ts");
      }
      if (args.action === "create_tab") {
        return makeTextResult("Created tab `TAB-NEW` • Pi Session [bound]");
      }
      throw new Error(`Unexpected action: ${args.action}`);
    },
  };

  const binding = await ensureBindingHasTab(pi, ctx, config, client, {
    createIfMissing: false,
    recoverIfMissing: false,
    reuseSoleEmptyTab: true,
  });

  assert.equal(binding?.tab, "TAB-OLD");
  assert.equal(calls.filter((call) => call.args.action === "create_tab").length, 0);
});

test("ensureBindingHasTab reserves replay tab creation for true recovery", async () => {
  const { pi, ctx, entries } = makeMockSession();
  const config = {};

  persistBinding(pi, { windowId: 5, workspace: "pi-agent", tab: "TAB-OLD" }, config);

  let listTabsCount = 0;
  const calls = [];
  const client = {
    isConnected: true,
    tools: [{ name: "manage_workspaces" }],
    async callTool(name, args) {
      calls.push({ name, args });
      if (args.action === "list_tabs") {
        listTabsCount += 1;
        return listTabsCount === 1
          ? makeTextResult("## Tabs ✅\n\n- `TAB-OTHER` • Existing [active]\n  • 2 files: a.ts, b.ts")
          : makeTextResult("## Tabs ✅\n\n- `TAB-OTHER` • Existing [active]\n  • 2 files: a.ts, b.ts\n- `TAB-NEW` • Pi Session [bound]\n  • 0 files");
      }
      if (args.action === "create_tab") {
        return makeTextResult("Created tab `TAB-NEW` • Pi Session [bound]");
      }
      if (args.action === "select_tab") {
        return makeTextResult("Selected tab `TAB-NEW`");
      }
      throw new Error(`Unexpected action: ${args.action}`);
    },
  };

  const binding = await ensureBindingHasTab(pi, ctx, config, client, {
    createIfMissing: false,
    recoverIfMissing: true,
    reuseSoleEmptyTab: true,
  });

  assert.equal(binding?.tab, "TAB-NEW");
  assert.equal(calls.filter((call) => call.args.action === "create_tab").length, 1);
  assert.equal(entries.at(-1)?.data?.tab, "TAB-NEW");
});

test("ensureBindingHasTab provisions exactly one tab when the branch has none", async () => {
  const { pi, ctx, entries } = makeMockSession();
  const config = {};

  persistBinding(pi, { windowId: 5, workspace: "pi-agent" }, config);

  let listTabsCount = 0;
  const calls = [];
  const client = {
    isConnected: true,
    tools: [{ name: "manage_workspaces" }],
    async callTool(name, args) {
      calls.push({ name, args });
      if (args.action === "list_tabs") {
        listTabsCount += 1;
        return listTabsCount === 1
          ? makeTextResult("## Tabs ✅\n\n- `TAB-OLD` • Existing [active]")
          : makeTextResult("## Tabs ✅\n\n- `TAB-OLD` • Existing [active]\n- `TAB-NEW` • Pi Session [bound]");
      }
      if (args.action === "create_tab") {
        return makeTextResult("Created tab `TAB-NEW` • Pi Session [bound]");
      }
      if (args.action === "select_tab") {
        return makeTextResult("Selected tab `TAB-NEW`");
      }
      throw new Error(`Unexpected action: ${args.action}`);
    },
  };

  const firstBinding = await ensureBindingHasTab(pi, ctx, config, client);
  const secondBinding = await ensureBindingHasTab(pi, ctx, config, client);

  assert.equal(firstBinding?.tab, "TAB-NEW");
  assert.equal(secondBinding?.tab, "TAB-NEW");
  assert.equal(calls.filter((call) => call.args.action === "create_tab").length, 1);
  assert.equal(entries.filter((entry) => entry.data?.tab === "TAB-NEW").length, 1);
});

test("ensureBindingHasTab reprovisions when the stored tab is stale", async () => {
  const { pi, ctx } = makeMockSession();
  const config = {};

  persistBinding(pi, { windowId: 5, workspace: "pi-agent", tab: "TAB-OLD" }, config);

  let listTabsCount = 0;
  const calls = [];
  const client = {
    isConnected: true,
    tools: [{ name: "manage_workspaces" }],
    async callTool(name, args) {
      calls.push({ name, args });
      if (args.action === "list_tabs") {
        listTabsCount += 1;
        return listTabsCount === 1
          ? makeTextResult("## Tabs ✅\n\n- `TAB-OTHER` • Existing [active]")
          : makeTextResult("## Tabs ✅\n\n- `TAB-OTHER` • Existing [active]\n- `TAB-NEW` • Pi Session [bound]");
      }
      if (args.action === "create_tab") {
        return makeTextResult("Created tab `TAB-NEW` • Pi Session [bound]");
      }
      if (args.action === "select_tab") {
        return makeTextResult("Selected tab `TAB-NEW`");
      }
      throw new Error(`Unexpected action: ${args.action}`);
    },
  };

  const binding = await ensureBindingHasTab(pi, ctx, config, client);

  assert.equal(binding?.tab, "TAB-NEW");
  assert.equal(calls.filter((call) => call.args.action === "create_tab").length, 1);
});
