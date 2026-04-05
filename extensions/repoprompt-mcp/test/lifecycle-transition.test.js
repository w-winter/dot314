import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";

import repopromptMcp from "../dist/index.js";
import { clearBinding } from "../dist/binding.js";
import { RpClient, resetRpClient } from "../dist/client.js";
import { AUTO_SELECTION_ENTRY_TYPE, BINDING_ENTRY_TYPE } from "../dist/types.js";

function makeTextResult(text) {
  return {
    isError: false,
    content: [{ type: "text", text }],
  };
}

function renderTabs(tabs) {
  return [
    "## Tabs ✅",
    "",
    ...tabs.flatMap((tab) => {
      const states = [];
      if (tab.active) states.push("active");
      if (tab.bound) states.push("bound");
      const stateText = states.length > 0 ? ` [${states.join(", ")}]` : "";
      return [
        `- \`${tab.id}\` • ${tab.name}${stateText}`,
        `  • ${tab.files} files`,
      ];
    }),
  ].join("\n");
}

function renderContexts(tabs) {
  return tabs
    .map((tab) => {
      const states = [];
      if (tab.active) states.push("active");
      if (tab.bound) states.push("bound");
      const stateText = states.length > 0 ? ` [${states.join(", ")}]` : "";
      return `- ${tab.name}${stateText} — context_id: \`${tab.id}\``;
    })
    .join("\n");
}

function createMockPi(entries, session = {}) {
  const handlers = new Map();
  const commands = new Map();
  const tools = new Map();

  return {
    on(event, handler) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
    registerCommand(name, definition) {
      commands.set(name, definition);
    },
    getCommand(name) {
      return commands.get(name);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    getTool(name) {
      return tools.get(name);
    },
    appendEntry(customType, data) {
      const leafState = session.leafState ?? null;
      if (leafState) {
        const nextLeafId = `leaf-${leafState.nextId ?? 1}`;
        const previousLeafId = leafState.current ?? null;
        leafState.nextId = (leafState.nextId ?? 1) + 1;
        leafState.current = nextLeafId;
        entries.push({
          type: "custom",
          customType,
          data,
          id: nextLeafId,
          parentId: previousLeafId,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      entries.push({ type: "custom", customType, data });
    },
    sendMessage() {},
    async emit(event, ctx, eventData = {}) {
      for (const handler of handlers.get(event) ?? []) {
        await handler({ type: event, ...eventData }, ctx);
      }
    },
  };
}

function createContext(branchEntries, cwd, hasUI = false, session = {}) {
  const sessionFile = session.sessionFile ?? path.join(cwd, `${session.sessionId ?? "session"}.jsonl`);
  const sessionId = session.sessionId ?? "session-id";
  const leafId = session.leafId ?? "leaf-id";
  const leafState = session.leafState ?? null;

  return {
    hasUI,
    cwd,
    ui: {
      notify() {},
      setStatus() {},
    },
    sessionManager: {
      getBranch() {
        return branchEntries;
      },
      getSessionFile() {
        return sessionFile;
      },
      getSessionId() {
        return sessionId;
      },
      getLeafId() {
        return leafState?.current ?? leafId;
      },
    },
  };
}

async function drainLifecycle() {
  for (let i = 0; i < 6; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function installMockRpClient(state) {
  const originalConnect = RpClient.prototype.connect;
  const originalClose = RpClient.prototype.close;
  const originalCallTool = RpClient.prototype.callTool;

  RpClient.prototype.connect = async function connect() {
    if (state.failConnect === true) {
      this.client = null;
      this.transport = null;
      this._status = "error";
      this._tools = [];
      throw new Error("RepoPrompt unavailable");
    }

    this.client = {};
    this.transport = {};
    this._status = "connected";
    this._tools = [
      { name: "list_windows", description: "" },
      { name: "manage_workspaces", description: "" },
      { name: "bind_context", description: "" },
      { name: "manage_selection", description: "" },
      { name: "chats", description: "" },
    ];
  };

  RpClient.prototype.close = async function close() {
    this.client = null;
    this.transport = null;
    this._status = "disconnected";
    this._tools = [];
  };

  RpClient.prototype.callTool = async function callTool(name, args = {}) {
    state.calls.push({ name, args });

    if (name === "list_windows") {
      return makeTextResult("- Window `5` • WS: chat-tree • Roots: 1");
    }

    if (name === "bind_context" && args.op === "list") {
      return makeTextResult(renderContexts(state.tabsByWindow.get(args.window_id) ?? []));
    }

    if (name === "bind_context" && args.op === "bind") {
      for (const tabs of state.tabsByWindow.values()) {
        for (const tab of tabs) {
          tab.active = tab.id === args.context_id;
          tab.bound = tab.id === args.context_id;
        }
      }
      return makeTextResult(`Bound context \`${args.context_id}\``);
    }

    if (name === "manage_workspaces" && args.action === "list_tabs") {
      return makeTextResult(renderTabs(state.tabsByWindow.get(args._windowID) ?? []));
    }

    if (name === "manage_workspaces" && args.action === "select_tab") {
      const tabs = state.tabsByWindow.get(args._windowID) ?? [];
      for (const tab of tabs) {
        tab.active = tab.id === args.tab;
        if (tab.id === args.tab) {
          tab.bound = true;
        }
      }
      return makeTextResult(`Selected tab \`${args.tab}\``);
    }

    if (name === "manage_workspaces" && args.action === "create_tab") {
      const createdTabId = state.createdTabId ?? "TAB-CREATED";
      const tabs = state.tabsByWindow.get(args._windowID) ?? [];
      tabs.push({ id: createdTabId, name: "Pi Session", active: false, bound: true, files: 0 });
      state.tabsByWindow.set(args._windowID, tabs);
      return makeTextResult(`Created tab \`${createdTabId}\` • Pi Session [bound]`);
    }

    if (name === "chats") {
      return makeTextResult([
        "## Chats ✅",
        "- **Count**: 0",
        "- **Scope**: tab",
        `- **Tab**: \`${args.tab_id}\``,
      ].join("\n"));
    }

    if (name === "manage_selection") {
      const tabId = args.context_id ?? args._tabID;
      const selection = state.liveSelectionByTab.get(tabId) ?? new Set();

      if (args.op === "remove") {
        if ((state.failNextRemoveCount ?? 0) > 0) {
          state.failNextRemoveCount -= 1;
          throw new Error(`Selection remove failed for ${tabId}`);
        }

        if ((state.failNextRemoveAsResultCount ?? 0) > 0) {
          state.failNextRemoveAsResultCount -= 1;
          return {
            isError: true,
            content: [{ type: "text", text: `Selection remove failed for ${tabId}` }],
          };
        }

        if ((state.failNextRemoveIgnorableResultCount ?? 0) > 0) {
          state.failNextRemoveIgnorableResultCount -= 1;
          return {
            isError: true,
            content: [{
              type: "text",
              text: state.ignorableRemoveErrorText ?? `RepoPrompt tab ${JSON.stringify(tabId)} not found in window ${args._windowID}`,
            }],
          };
        }

        for (const item of args.paths ?? []) {
          selection.delete(item);
        }
        state.liveSelectionByTab.set(tabId, selection);
      }

      if (args.op === "add" && args.mode === "full") {
        if ((state.failNextAddCount ?? 0) > 0) {
          state.failNextAddCount -= 1;
          throw new Error(`Selection add failed for ${tabId}`);
        }

        if ((state.failNextAddAsResultCount ?? 0) > 0) {
          state.failNextAddAsResultCount -= 1;
          return {
            isError: true,
            content: [{ type: "text", text: `Selection add failed for ${tabId}` }],
          };
        }

        if ((state.failAddByTab?.get(tabId) ?? 0) > 0) {
          state.failAddByTab.set(tabId, state.failAddByTab.get(tabId) - 1);
          throw new Error(`Selection add failed for ${tabId}`);
        }

        for (const item of args.paths ?? []) {
          selection.add(item);
        }
        state.liveSelectionByTab.set(tabId, selection);
      }

      const tabs = state.tabsByWindow.get(args._windowID) ?? [];
      for (const tab of tabs) {
        if (tab.id === tabId) {
          tab.files = selection.size;
        }
      }

      return makeTextResult("Selection updated");
    }

    throw new Error(`Unexpected tool call: ${name} ${JSON.stringify(args)}`);
  };

  return () => {
    RpClient.prototype.connect = originalConnect;
    RpClient.prototype.close = originalClose;
    RpClient.prototype.callTool = originalCallTool;
  };
}

function sortedSelection(state, tabId) {
  return [...(state.liveSelectionByTab.get(tabId) ?? new Set())].sort();
}

async function clearPendingTransitionState() {
  try {
    const module = await import("../dist/transition-state.js");
    if (typeof module.clearPendingTransitionSelectionState === "function") {
      module.clearPendingTransitionSelectionState();
    }
  } catch {
    // transition-state does not exist before the migration lands
  }
}

async function getPendingTransitionStateSnapshot() {
  try {
    const module = await import("../dist/transition-state.js");
    if (typeof module.getPendingTransitionState === "function") {
      return module.getPendingTransitionState();
    }
  } catch {
    // transition-state does not exist before the migration lands
  }

  return null;
}

async function setPendingTransitionSourceState(state, retryMode) {
  try {
    const module = await import("../dist/transition-state.js");
    if (typeof module.setPendingTransitionSelectionState === "function") {
      module.setPendingTransitionSelectionState(state, retryMode);
    }
  } catch {
    // transition-state does not exist before the migration lands
  }
}

async function setPendingTransitionTargetSnapshot(identity, binding, state, retryMode) {
  try {
    const module = await import("../dist/transition-state.js");
    if (typeof module.setPendingTransitionTargetState === "function") {
      module.setPendingTransitionTargetState(identity, binding, state, retryMode);
    }
  } catch {
    // transition-state does not exist before the migration lands
  }
}

test("session_start(reason=resume) on a fresh runtime replays the previous live selection into the resumed branch", async () => {
  const originalHome = process.env.HOME;
  const tempHome = mkdtempSync(path.join(os.tmpdir(), "rp-lifecycle-home-"));
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "rp-lifecycle-root-"));
  const repoRoot = path.join(tempRoot, "chat-tree");
  process.env.HOME = tempHome;

  const state = {
    failConnect: false,
    calls: [],
    failAddByTab: new Map(),
    tabsByWindow: new Map([
      [5, [
        { id: "TAB-OLD", name: "Old", active: false, bound: false, files: 1 },
        { id: "TAB-NEW", name: "New", active: true, bound: false, files: 0 },
      ]],
    ]),
    liveSelectionByTab: new Map([
      ["TAB-OLD", new Set(["src/Old.tsx"])],
      ["TAB-NEW", new Set()],
    ]),
  };
  const restoreClient = installMockRpClient(state);

  try {
    mkdirSync(path.join(tempHome, ".pi", "agent", "extensions"), { recursive: true });
    writeFileSync(
      path.join(tempHome, ".pi", "agent", "extensions", "repoprompt-mcp.json"),
      JSON.stringify({ command: "fake-rp", args: [], suppressHostDisconnectedLog: false })
    );

    mkdirSync(path.join(repoRoot, "src"), { recursive: true });
    writeFileSync(path.join(repoRoot, "src", "Old.tsx"), "export const oldValue = 1\n");
    writeFileSync(path.join(repoRoot, "src", "New.tsx"), "export const newValue = 2\n");

    await resetRpClient();
    clearBinding();
    await clearPendingTransitionState();

    const oldEntries = [
      {
        type: "custom",
        customType: BINDING_ENTRY_TYPE,
        data: { windowId: 5, workspace: "chat-tree", tab: "TAB-OLD" },
      },
      {
        type: "custom",
        customType: AUTO_SELECTION_ENTRY_TYPE,
        data: {
          windowId: 5,
          workspace: "chat-tree",
          tab: "TAB-OLD",
          fullPaths: ["src/Old.tsx"],
          slicePaths: [],
        },
      },
    ];

    const newEntries = [
      {
        type: "custom",
        customType: BINDING_ENTRY_TYPE,
        data: { windowId: 5, workspace: "chat-tree", tab: "TAB-NEW" },
      },
      {
        type: "custom",
        customType: AUTO_SELECTION_ENTRY_TYPE,
        data: {
          windowId: 5,
          workspace: "chat-tree",
          tab: "TAB-NEW",
          fullPaths: ["src/New.tsx"],
          slicePaths: [],
        },
      },
    ];

    const oldPi = createMockPi(oldEntries);
    repopromptMcp(oldPi);
    await oldPi.emit("session_start", createContext(oldEntries, repoRoot), { reason: "startup" });
    await drainLifecycle();
    await oldPi.emit("session_shutdown", createContext(oldEntries, repoRoot), {});

    state.calls = [];

    const newPi = createMockPi(newEntries);
    repopromptMcp(newPi);
    await newPi.emit("session_start", createContext(newEntries, repoRoot), {
      reason: "resume",
      previousSessionFile: path.join(tempRoot, "old-session.jsonl"),
    });
    await drainLifecycle();

    assert.deepEqual(sortedSelection(state, "TAB-OLD"), []);
    assert.deepEqual(sortedSelection(state, "TAB-NEW"), ["src/New.tsx"]);

    const bindContextCalls = state.calls.filter((call) => call.name === "bind_context");
    assert.ok(bindContextCalls.some((call) => call.args.op === "list" && call.args.window_id === 5));
    assert.ok(bindContextCalls.some((call) => call.args.op === "bind" && call.args.context_id === "TAB-NEW"));

    const selectionCalls = state.calls.filter((call) => call.name === "manage_selection");
    assert.deepEqual(
      selectionCalls.map((call) => ({ op: call.args.op, tab: call.args.context_id, paths: call.args.paths ?? [] })),
      [
        { op: "remove", tab: "TAB-OLD", paths: ["src/Old.tsx"] },
        { op: "add", tab: "TAB-NEW", paths: ["src/New.tsx"] },
      ]
    );
  } finally {
    restoreClient();
    process.env.HOME = originalHome;
    await resetRpClient();
    clearBinding();
    await clearPendingTransitionState();
    rmSync(tempHome, { recursive: true, force: true });
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("reconnect preserves recovered selection after first replay fails post-binding-recovery even if leafId advances", async () => {
  const originalHome = process.env.HOME;
  const tempHome = mkdtempSync(path.join(os.tmpdir(), "rp-lifecycle-retry-home-"));
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "rp-lifecycle-retry-root-"));
  const repoRoot = path.join(tempRoot, "chat-tree");
  process.env.HOME = tempHome;

  const state = {
    failConnect: false,
    calls: [],
    failAddByTab: new Map(),
    failNextAddCount: 0,
    createdTabId: "TAB-NEW",
    tabsByWindow: new Map([
      [5, [{ id: "TAB-OLD", name: "Original", active: true, bound: false, files: 1 }]],
    ]),
    liveSelectionByTab: new Map([
      ["TAB-OLD", new Set(["src/Old.tsx"])],
      ["TAB-NEW", new Set()],
    ]),
  };
  const restoreClient = installMockRpClient(state);

  try {
    mkdirSync(path.join(tempHome, ".pi", "agent", "extensions"), { recursive: true });
    writeFileSync(
      path.join(tempHome, ".pi", "agent", "extensions", "repoprompt-mcp.json"),
      JSON.stringify({ command: "fake-rp", args: [], suppressHostDisconnectedLog: false })
    );

    mkdirSync(path.join(repoRoot, "src"), { recursive: true });
    writeFileSync(path.join(repoRoot, "src", "Old.tsx"), "export const oldValue = 1\n");

    await resetRpClient();
    clearBinding();
    await clearPendingTransitionState();

    const oldEntries = [
      {
        type: "custom",
        customType: BINDING_ENTRY_TYPE,
        data: { windowId: 5, workspace: "chat-tree", tab: "TAB-OLD" },
      },
      {
        type: "custom",
        customType: AUTO_SELECTION_ENTRY_TYPE,
        data: {
          windowId: 5,
          workspace: "chat-tree",
          tab: "TAB-OLD",
          fullPaths: ["src/Old.tsx"],
          slicePaths: [],
        },
      },
    ];

    const newEntries = [
      {
        type: "custom",
        customType: BINDING_ENTRY_TYPE,
        data: { windowId: 5, workspace: "chat-tree", tab: "TAB-OLD" },
      },
      {
        type: "custom",
        customType: AUTO_SELECTION_ENTRY_TYPE,
        data: {
          windowId: 5,
          workspace: "chat-tree",
          tab: "TAB-OLD",
          fullPaths: ["src/Old.tsx"],
          slicePaths: [],
        },
      },
    ];
    const newSessionLeafState = { current: "leaf-old", nextId: 1 };

    const oldPi = createMockPi(oldEntries);
    repopromptMcp(oldPi);
    await oldPi.emit("session_start", createContext(oldEntries, repoRoot), { reason: "startup" });
    await drainLifecycle();
    await oldPi.emit("session_shutdown", createContext(oldEntries, repoRoot), {});

    state.tabsByWindow = new Map([
      [5, [{ id: "TAB-NEW", name: "Recovered", active: true, bound: false, files: 0 }]],
    ]);
    state.liveSelectionByTab.set("TAB-NEW", new Set());
    state.calls = [];

    const newPi = createMockPi(newEntries, { leafState: newSessionLeafState });
    repopromptMcp(newPi);
    const newCtx = createContext(newEntries, repoRoot, true, { leafState: newSessionLeafState });
    state.failNextAddCount = 10;
    await newPi.emit("session_start", newCtx, {
      reason: "resume",
      previousSessionFile: path.join(tempRoot, "old-session.jsonl"),
    });
    await drainLifecycle();

    assert.deepEqual(sortedSelection(state, "TAB-NEW"), []);

    const preReconnectAutoSelectionEntries = newEntries.filter(
      (entry) => entry.type === "custom" && entry.customType === AUTO_SELECTION_ENTRY_TYPE
    );
    assert.deepEqual(preReconnectAutoSelectionEntries.at(-1)?.data, {
      windowId: 5,
      workspace: "chat-tree",
      tab: "TAB-OLD",
      fullPaths: ["src/Old.tsx"],
      slicePaths: [],
    });

    const bindingEntriesAfterFailure = newEntries.filter(
      (entry) => entry.type === "custom" && entry.customType === BINDING_ENTRY_TYPE
    );
    assert.deepEqual(bindingEntriesAfterFailure.at(-1)?.data, {
      windowId: 5,
      workspace: "chat-tree",
      tab: "TAB-NEW",
    });
    assert.equal(newSessionLeafState.current, "leaf-1");

    state.failNextAddCount = 0;

    const reconnectCommand = newPi.getCommand("rp");
    assert.ok(reconnectCommand, "rp command should be registered");

    await reconnectCommand.handler("reconnect", newCtx);

    assert.deepEqual(sortedSelection(state, "TAB-OLD"), []);
    assert.deepEqual(sortedSelection(state, "TAB-NEW"), ["src/Old.tsx"]);

    const bindContextCalls = state.calls.filter((call) => call.name === "bind_context");
    assert.ok(bindContextCalls.some((call) => call.args.op === "list" && call.args.window_id === 5));
    assert.ok(bindContextCalls.some((call) => call.args.op === "bind" && call.args.context_id === "TAB-NEW"));

    const selectionCalls = state.calls.filter((call) => call.name === "manage_selection");
    assert.ok(selectionCalls.some((call) => call.args.op === "remove" && call.args.context_id === "TAB-OLD"));
    assert.ok(
      selectionCalls.filter((call) => call.args.op === "add" && call.args.context_id === "TAB-NEW").length >= 2
    );

    const autoSelectionEntries = newEntries.filter(
      (entry) => entry.type === "custom" && entry.customType === AUTO_SELECTION_ENTRY_TYPE
    );
    assert.deepEqual(autoSelectionEntries.at(-1)?.data, {
      windowId: 5,
      workspace: "chat-tree",
      tab: "TAB-NEW",
      fullPaths: ["src/Old.tsx"],
      slicePaths: [],
    });
  } finally {
    restoreClient();
    process.env.HOME = originalHome;
    await resetRpClient();
    clearBinding();
    await clearPendingTransitionState();
    rmSync(tempHome, { recursive: true, force: true });
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("replay failure via MCP isError preserves pending transition state", async () => {
  const originalHome = process.env.HOME;
  const tempHome = mkdtempSync(path.join(os.tmpdir(), "rp-lifecycle-result-error-home-"));
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "rp-lifecycle-result-error-root-"));
  const repoRoot = path.join(tempRoot, "chat-tree");
  process.env.HOME = tempHome;

  const state = {
    failConnect: false,
    calls: [],
    failAddByTab: new Map(),
    failNextAddCount: 0,
    failNextAddAsResultCount: 0,
    createdTabId: "TAB-NEW",
    tabsByWindow: new Map([
      [5, [{ id: "TAB-OLD", name: "Original", active: true, bound: false, files: 1 }]],
    ]),
    liveSelectionByTab: new Map([
      ["TAB-OLD", new Set(["src/Old.tsx"])],
      ["TAB-NEW", new Set()],
    ]),
  };
  const restoreClient = installMockRpClient(state);

  try {
    mkdirSync(path.join(tempHome, ".pi", "agent", "extensions"), { recursive: true });
    writeFileSync(
      path.join(tempHome, ".pi", "agent", "extensions", "repoprompt-mcp.json"),
      JSON.stringify({ command: "fake-rp", args: [], suppressHostDisconnectedLog: false })
    );

    mkdirSync(path.join(repoRoot, "src"), { recursive: true });
    writeFileSync(path.join(repoRoot, "src", "Old.tsx"), "export const oldValue = 1\n");

    await resetRpClient();
    clearBinding();
    await clearPendingTransitionState();

    const oldEntries = [
      {
        type: "custom",
        customType: BINDING_ENTRY_TYPE,
        data: { windowId: 5, workspace: "chat-tree", tab: "TAB-OLD" },
      },
      {
        type: "custom",
        customType: AUTO_SELECTION_ENTRY_TYPE,
        data: {
          windowId: 5,
          workspace: "chat-tree",
          tab: "TAB-OLD",
          fullPaths: ["src/Old.tsx"],
          slicePaths: [],
        },
      },
    ];

    const newEntries = [
      {
        type: "custom",
        customType: BINDING_ENTRY_TYPE,
        data: { windowId: 5, workspace: "chat-tree", tab: "TAB-OLD" },
      },
      {
        type: "custom",
        customType: AUTO_SELECTION_ENTRY_TYPE,
        data: {
          windowId: 5,
          workspace: "chat-tree",
          tab: "TAB-OLD",
          fullPaths: ["src/Old.tsx"],
          slicePaths: [],
        },
      },
    ];

    const oldPi = createMockPi(oldEntries);
    repopromptMcp(oldPi);
    await oldPi.emit("session_start", createContext(oldEntries, repoRoot, false, {
      sessionId: "session-a",
      leafId: "leaf-a",
      sessionFile: path.join(tempRoot, "session-a.jsonl"),
    }), { reason: "startup" });
    await drainLifecycle();
    await oldPi.emit("session_shutdown", createContext(oldEntries, repoRoot, false, {
      sessionId: "session-a",
      leafId: "leaf-a",
      sessionFile: path.join(tempRoot, "session-a.jsonl"),
    }), {});

    state.tabsByWindow = new Map([
      [5, [{ id: "TAB-NEW", name: "Recovered", active: true, bound: false, files: 0 }]],
    ]);
    state.liveSelectionByTab.set("TAB-NEW", new Set());
    state.calls = [];

    const newPi = createMockPi(newEntries);
    repopromptMcp(newPi);
    const newCtx = createContext(newEntries, repoRoot, true, {
      sessionId: "session-b",
      leafId: "leaf-b",
      sessionFile: path.join(tempRoot, "session-b.jsonl"),
    });
    state.failNextAddAsResultCount = 10;
    await newPi.emit("session_start", newCtx, {
      reason: "resume",
      previousSessionFile: path.join(tempRoot, "session-a.jsonl"),
    });
    await drainLifecycle();

    assert.deepEqual(sortedSelection(state, "TAB-NEW"), []);

    const preReconnectAutoSelectionEntries = newEntries.filter(
      (entry) => entry.type === "custom" && entry.customType === AUTO_SELECTION_ENTRY_TYPE
    );
    assert.deepEqual(preReconnectAutoSelectionEntries.at(-1)?.data, {
      windowId: 5,
      workspace: "chat-tree",
      tab: "TAB-OLD",
      fullPaths: ["src/Old.tsx"],
      slicePaths: [],
    });

    const bindingEntriesAfterFailure = newEntries.filter(
      (entry) => entry.type === "custom" && entry.customType === BINDING_ENTRY_TYPE
    );
    assert.deepEqual(bindingEntriesAfterFailure.at(-1)?.data, {
      windowId: 5,
      workspace: "chat-tree",
      tab: "TAB-NEW",
    });

    state.failNextAddAsResultCount = 0;

    const reconnectCommand = newPi.getCommand("rp");
    assert.ok(reconnectCommand, "rp command should be registered");

    await reconnectCommand.handler("reconnect", newCtx);

    assert.deepEqual(sortedSelection(state, "TAB-OLD"), []);
    assert.deepEqual(sortedSelection(state, "TAB-NEW"), ["src/Old.tsx"]);

    const autoSelectionEntries = newEntries.filter(
      (entry) => entry.type === "custom" && entry.customType === AUTO_SELECTION_ENTRY_TYPE
    );
    assert.deepEqual(autoSelectionEntries.at(-1)?.data, {
      windowId: 5,
      workspace: "chat-tree",
      tab: "TAB-NEW",
      fullPaths: ["src/Old.tsx"],
      slicePaths: [],
    });
  } finally {
    restoreClient();
    process.env.HOME = originalHome;
    await resetRpClient();
    clearBinding();
    await clearPendingTransitionState();
    rmSync(tempHome, { recursive: true, force: true });
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("cross-binding remove MCP isError aborts transition and preserves pending state", async () => {
  const originalHome = process.env.HOME;
  const tempHome = mkdtempSync(path.join(os.tmpdir(), "rp-lifecycle-remove-error-home-"));
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "rp-lifecycle-remove-error-root-"));
  const repoRoot = path.join(tempRoot, "chat-tree");
  process.env.HOME = tempHome;

  const state = {
    failConnect: false,
    calls: [],
    failAddByTab: new Map(),
    failNextAddCount: 0,
    failNextAddAsResultCount: 0,
    failNextRemoveAsResultCount: 0,
    createdTabId: "TAB-NEW",
    tabsByWindow: new Map([
      [5, [
        { id: "TAB-OLD", name: "Old", active: true, bound: false, files: 1 },
        { id: "TAB-NEW", name: "New", active: false, bound: false, files: 0 },
      ]],
    ]),
    liveSelectionByTab: new Map([
      ["TAB-OLD", new Set(["src/Old.tsx"])],
      ["TAB-NEW", new Set()],
    ]),
  };
  const restoreClient = installMockRpClient(state);

  try {
    mkdirSync(path.join(tempHome, ".pi", "agent", "extensions"), { recursive: true });
    writeFileSync(
      path.join(tempHome, ".pi", "agent", "extensions", "repoprompt-mcp.json"),
      JSON.stringify({ command: "fake-rp", args: [], suppressHostDisconnectedLog: false })
    );

    mkdirSync(path.join(repoRoot, "src"), { recursive: true });
    writeFileSync(path.join(repoRoot, "src", "Old.tsx"), "export const oldValue = 1\n");
    writeFileSync(path.join(repoRoot, "src", "New.tsx"), "export const newValue = 2\n");

    await resetRpClient();
    clearBinding();
    await clearPendingTransitionState();
    await setPendingTransitionSourceState({
      windowId: 5,
      workspace: "chat-tree",
      tab: "TAB-OLD",
      fullPaths: ["src/Old.tsx"],
      slicePaths: [],
    });

    const pendingBeforeReconnect = await getPendingTransitionStateSnapshot();
    assert.equal(pendingBeforeReconnect?.sourceState?.tab, "TAB-OLD");

    const newEntries = [
      {
        type: "custom",
        customType: BINDING_ENTRY_TYPE,
        data: { windowId: 5, workspace: "chat-tree", tab: "TAB-NEW" },
      },
      {
        type: "custom",
        customType: AUTO_SELECTION_ENTRY_TYPE,
        data: {
          windowId: 5,
          workspace: "chat-tree",
          tab: "TAB-NEW",
          fullPaths: ["src/New.tsx"],
          slicePaths: [],
        },
      },
    ];

    const newCtx = createContext(newEntries, repoRoot, true, {
      sessionId: "session-b",
      leafId: "leaf-b",
      sessionFile: path.join(tempRoot, "session-b.jsonl"),
    });
    const newPi = createMockPi(newEntries);
    repopromptMcp(newPi);

    const reconnectCommand = newPi.getCommand("rp");
    assert.ok(reconnectCommand, "rp command should be registered");

    state.failNextRemoveAsResultCount = 1;
    await reconnectCommand.handler("reconnect", newCtx);

    const failedSelectionCalls = state.calls.filter((call) => call.name === "manage_selection");
    assert.deepEqual(
      failedSelectionCalls.map((call) => ({ op: call.args.op, tab: call.args.context_id, paths: call.args.paths ?? [] })),
      [{ op: "remove", tab: "TAB-OLD", paths: ["src/Old.tsx"] }]
    );
    assert.deepEqual(sortedSelection(state, "TAB-OLD"), ["src/Old.tsx"]);
    assert.deepEqual(sortedSelection(state, "TAB-NEW"), []);

    const pendingAfterFailure = await getPendingTransitionStateSnapshot();
    assert.equal(pendingAfterFailure?.sourceState?.tab, "TAB-OLD");
    assert.equal(pendingAfterFailure?.targetBinding?.tab, "TAB-NEW");
    assert.equal(pendingAfterFailure?.targetIdentity?.sessionId, "session-b");

    state.failNextRemoveAsResultCount = 0;
    await reconnectCommand.handler("reconnect", newCtx);

    assert.deepEqual(sortedSelection(state, "TAB-OLD"), []);
    assert.deepEqual(sortedSelection(state, "TAB-NEW"), ["src/New.tsx"]);
    assert.equal(await getPendingTransitionStateSnapshot(), null);
  } finally {
    restoreClient();
    process.env.HOME = originalHome;
    await resetRpClient();
    clearBinding();
    await clearPendingTransitionState();
    rmSync(tempHome, { recursive: true, force: true });
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("missing old binding/window remove failure is ignored, but desired replay still succeeds", async () => {
  const originalHome = process.env.HOME;
  const tempHome = mkdtempSync(path.join(os.tmpdir(), "rp-lifecycle-remove-missing-home-"));
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "rp-lifecycle-remove-missing-root-"));
  const repoRoot = path.join(tempRoot, "chat-tree");
  process.env.HOME = tempHome;

  const state = {
    failConnect: false,
    calls: [],
    failAddByTab: new Map(),
    failNextAddCount: 0,
    failNextAddAsResultCount: 0,
    failNextRemoveIgnorableResultCount: 0,
    ignorableRemoveErrorText: "RepoPrompt tab \"TAB-OLD\" not found in window 5",
    createdTabId: "TAB-NEW",
    tabsByWindow: new Map([
      [5, [{ id: "TAB-OLD", name: "Old", active: true, bound: false, files: 1 }]],
    ]),
    liveSelectionByTab: new Map([
      ["TAB-OLD", new Set(["src/Old.tsx"])],
      ["TAB-NEW", new Set()],
    ]),
  };
  const restoreClient = installMockRpClient(state);

  try {
    mkdirSync(path.join(tempHome, ".pi", "agent", "extensions"), { recursive: true });
    writeFileSync(
      path.join(tempHome, ".pi", "agent", "extensions", "repoprompt-mcp.json"),
      JSON.stringify({ command: "fake-rp", args: [], suppressHostDisconnectedLog: false })
    );

    mkdirSync(path.join(repoRoot, "src"), { recursive: true });
    writeFileSync(path.join(repoRoot, "src", "Old.tsx"), "export const oldValue = 1\n");
    writeFileSync(path.join(repoRoot, "src", "New.tsx"), "export const newValue = 2\n");

    await resetRpClient();
    clearBinding();
    await clearPendingTransitionState();

    const oldEntries = [
      {
        type: "custom",
        customType: BINDING_ENTRY_TYPE,
        data: { windowId: 5, workspace: "chat-tree", tab: "TAB-OLD" },
      },
      {
        type: "custom",
        customType: AUTO_SELECTION_ENTRY_TYPE,
        data: {
          windowId: 5,
          workspace: "chat-tree",
          tab: "TAB-OLD",
          fullPaths: ["src/Old.tsx"],
          slicePaths: [],
        },
      },
    ];

    const newEntries = [
      {
        type: "custom",
        customType: BINDING_ENTRY_TYPE,
        data: { windowId: 5, workspace: "chat-tree", tab: "TAB-NEW" },
      },
      {
        type: "custom",
        customType: AUTO_SELECTION_ENTRY_TYPE,
        data: {
          windowId: 5,
          workspace: "chat-tree",
          tab: "TAB-NEW",
          fullPaths: ["src/New.tsx"],
          slicePaths: [],
        },
      },
    ];

    const oldCtx = createContext(oldEntries, repoRoot, false, {
      sessionId: "session-a",
      leafId: "leaf-a",
      sessionFile: path.join(tempRoot, "session-a.jsonl"),
    });
    const oldPi = createMockPi(oldEntries);
    repopromptMcp(oldPi);
    await oldPi.emit("session_start", oldCtx, { reason: "startup" });
    await drainLifecycle();
    await oldPi.emit("session_shutdown", oldCtx, {});

    state.tabsByWindow = new Map([
      [5, [{ id: "TAB-NEW", name: "New", active: true, bound: false, files: 0 }]],
    ]);
    state.liveSelectionByTab.set("TAB-NEW", new Set());
    state.calls = [];

    const newCtx = createContext(newEntries, repoRoot, true, {
      sessionId: "session-b",
      leafId: "leaf-b",
      sessionFile: path.join(tempRoot, "session-b.jsonl"),
    });
    const newPi = createMockPi(newEntries);
    repopromptMcp(newPi);
    state.failNextRemoveIgnorableResultCount = 1;
    await newPi.emit("session_start", newCtx, {
      reason: "resume",
      previousSessionFile: path.join(tempRoot, "session-a.jsonl"),
    });
    await drainLifecycle();

    assert.deepEqual(sortedSelection(state, "TAB-NEW"), ["src/New.tsx"]);
    assert.equal(await getPendingTransitionStateSnapshot(), null);

    const selectionCalls = state.calls.filter((call) => call.name === "manage_selection");
    assert.ok(selectionCalls.some((call) => call.args.op === "remove" && call.args.context_id === "TAB-OLD"));
    assert.ok(selectionCalls.some((call) => call.args.op === "add" && call.args.context_id === "TAB-NEW"));
  } finally {
    restoreClient();
    process.env.HOME = originalHome;
    await resetRpClient();
    clearBinding();
    await clearPendingTransitionState();
    rmSync(tempHome, { recursive: true, force: true });
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("later unrelated transition does not reuse stale pending target", async () => {
  const originalHome = process.env.HOME;
  const tempHome = mkdtempSync(path.join(os.tmpdir(), "rp-lifecycle-stale-target-home-"));
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "rp-lifecycle-stale-target-root-"));
  const repoRoot = path.join(tempRoot, "chat-tree");
  process.env.HOME = tempHome;

  const state = {
    failConnect: false,
    calls: [],
    failAddByTab: new Map(),
    failNextAddCount: 0,
    failNextAddAsResultCount: 0,
    createdTabId: "TAB-CREATED",
    tabsByWindow: new Map([
      [5, [{ id: "TAB-OLD", name: "Original", active: true, bound: false, files: 1 }]],
    ]),
    liveSelectionByTab: new Map([
      ["TAB-OLD", new Set(["src/Old.tsx"])],
      ["TAB-B", new Set()],
      ["TAB-C", new Set()],
    ]),
  };
  const restoreClient = installMockRpClient(state);

  try {
    mkdirSync(path.join(tempHome, ".pi", "agent", "extensions"), { recursive: true });
    writeFileSync(
      path.join(tempHome, ".pi", "agent", "extensions", "repoprompt-mcp.json"),
      JSON.stringify({ command: "fake-rp", args: [], suppressHostDisconnectedLog: false })
    );

    mkdirSync(path.join(repoRoot, "src"), { recursive: true });
    writeFileSync(path.join(repoRoot, "src", "Old.tsx"), "export const oldValue = 1\n");
    writeFileSync(path.join(repoRoot, "src", "B.tsx"), "export const bValue = 2\n");
    writeFileSync(path.join(repoRoot, "src", "C.tsx"), "export const cValue = 3\n");

    await resetRpClient();
    clearBinding();
    await clearPendingTransitionState();

    const aEntries = [
      {
        type: "custom",
        customType: BINDING_ENTRY_TYPE,
        data: { windowId: 5, workspace: "chat-tree", tab: "TAB-OLD" },
      },
      {
        type: "custom",
        customType: AUTO_SELECTION_ENTRY_TYPE,
        data: {
          windowId: 5,
          workspace: "chat-tree",
          tab: "TAB-OLD",
          fullPaths: ["src/Old.tsx"],
          slicePaths: [],
        },
      },
    ];

    const bEntries = [
      {
        type: "custom",
        customType: BINDING_ENTRY_TYPE,
        data: { windowId: 5, workspace: "chat-tree", tab: "TAB-B" },
      },
      {
        type: "custom",
        customType: AUTO_SELECTION_ENTRY_TYPE,
        data: {
          windowId: 5,
          workspace: "chat-tree",
          tab: "TAB-B",
          fullPaths: ["src/B.tsx"],
          slicePaths: [],
        },
      },
    ];

    const cEntries = [
      {
        type: "custom",
        customType: BINDING_ENTRY_TYPE,
        data: { windowId: 5, workspace: "chat-tree", tab: "TAB-C" },
      },
      {
        type: "custom",
        customType: AUTO_SELECTION_ENTRY_TYPE,
        data: {
          windowId: 5,
          workspace: "chat-tree",
          tab: "TAB-C",
          fullPaths: ["src/C.tsx"],
          slicePaths: [],
        },
      },
    ];

    const aPi = createMockPi(aEntries);
    repopromptMcp(aPi);
    const aCtx = createContext(aEntries, repoRoot, false, {
      sessionId: "session-a",
      leafId: "leaf-a",
      sessionFile: path.join(tempRoot, "session-a.jsonl"),
    });
    await aPi.emit("session_start", aCtx, { reason: "startup" });
    await drainLifecycle();
    await aPi.emit("session_shutdown", aCtx, {});

    state.tabsByWindow = new Map([
      [5, [{ id: "TAB-B", name: "B", active: true, bound: false, files: 0 }]],
    ]);
    state.calls = [];

    const bPi = createMockPi(bEntries);
    repopromptMcp(bPi);
    const bCtx = createContext(bEntries, repoRoot, true, {
      sessionId: "session-b",
      leafId: "leaf-b",
      sessionFile: path.join(tempRoot, "session-b.jsonl"),
    });
    state.failNextAddCount = 1;
    await bPi.emit("session_start", bCtx, {
      reason: "resume",
      previousSessionFile: path.join(tempRoot, "session-a.jsonl"),
    });
    await drainLifecycle();
    await bPi.emit("session_shutdown", bCtx, {});

    state.tabsByWindow = new Map([
      [5, [
        { id: "TAB-B", name: "B", active: false, bound: false, files: 0 },
        { id: "TAB-C", name: "C", active: true, bound: false, files: 0 },
      ]],
    ]);
    state.liveSelectionByTab.set("TAB-C", new Set());
    state.calls = [];

    const cPi = createMockPi(cEntries);
    repopromptMcp(cPi);
    const cCtx = createContext(cEntries, repoRoot, true, {
      sessionId: "session-c",
      leafId: "leaf-c",
      sessionFile: path.join(tempRoot, "session-c.jsonl"),
    });
    await cPi.emit("session_start", cCtx, {
      reason: "resume",
      previousSessionFile: path.join(tempRoot, "session-b.jsonl"),
    });
    await drainLifecycle();

    assert.deepEqual(sortedSelection(state, "TAB-B"), []);
    assert.deepEqual(sortedSelection(state, "TAB-C"), ["src/C.tsx"]);

    const selectionCalls = state.calls.filter((call) => call.name === "manage_selection");
    assert.ok(selectionCalls.some((call) => call.args.op === "add" && call.args.context_id === "TAB-C"));
    assert.ok(!selectionCalls.some((call) => call.args.op === "add" && call.args.context_id === "TAB-B"));
  } finally {
    restoreClient();
    process.env.HOME = originalHome;
    await resetRpClient();
    clearBinding();
    await clearPendingTransitionState();
    rmSync(tempHome, { recursive: true, force: true });
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("session_start(reason=reload) refreshes stale same-session pending target", async () => {
  const originalHome = process.env.HOME;
  const tempHome = mkdtempSync(path.join(os.tmpdir(), "rp-lifecycle-reload-refresh-home-"));
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "rp-lifecycle-reload-refresh-root-"));
  const repoRoot = path.join(tempRoot, "chat-tree");
  process.env.HOME = tempHome;

  const state = {
    failConnect: false,
    calls: [],
    failAddByTab: new Map(),
    tabsByWindow: new Map([
      [5, [{ id: "TAB-CURRENT", name: "Current", active: true, bound: false, files: 1 }]],
    ]),
    liveSelectionByTab: new Map([
      ["TAB-CURRENT", new Set(["src/Current.tsx"])],
      ["TAB-STALE", new Set()],
    ]),
  };
  const restoreClient = installMockRpClient(state);

  try {
    mkdirSync(path.join(tempHome, ".pi", "agent", "extensions"), { recursive: true });
    writeFileSync(
      path.join(tempHome, ".pi", "agent", "extensions", "repoprompt-mcp.json"),
      JSON.stringify({ command: "fake-rp", args: [], suppressHostDisconnectedLog: false })
    );

    mkdirSync(path.join(repoRoot, "src"), { recursive: true });
    writeFileSync(path.join(repoRoot, "src", "Current.tsx"), "export const currentValue = 1\n");
    writeFileSync(path.join(repoRoot, "src", "Stale.tsx"), "export const staleValue = 2\n");

    await resetRpClient();
    clearBinding();
    await clearPendingTransitionState();

    const entries = [
      {
        type: "custom",
        customType: BINDING_ENTRY_TYPE,
        data: { windowId: 5, workspace: "chat-tree", tab: "TAB-CURRENT" },
      },
      {
        type: "custom",
        customType: AUTO_SELECTION_ENTRY_TYPE,
        data: {
          windowId: 5,
          workspace: "chat-tree",
          tab: "TAB-CURRENT",
          fullPaths: ["src/Current.tsx"],
          slicePaths: [],
        },
      },
    ];
    const ctx = createContext(entries, repoRoot, true, {
      sessionId: "session-reload",
      sessionFile: path.join(tempRoot, "session-reload.jsonl"),
    });

    await setPendingTransitionTargetSnapshot(
      {
        sessionFile: path.join(tempRoot, "session-reload.jsonl"),
        sessionId: "session-reload",
      },
      { windowId: 5, workspace: "chat-tree", tab: "TAB-STALE" },
      {
        windowId: 5,
        workspace: "chat-tree",
        tab: "TAB-STALE",
        fullPaths: ["src/Stale.tsx"],
        slicePaths: [],
      },
      "startup"
    );

    const pi = createMockPi(entries);
    repopromptMcp(pi);
    await pi.emit("session_start", ctx, { reason: "reload" });
    await drainLifecycle();

    const selectionCalls = state.calls.filter((call) => call.name === "manage_selection");
    assert.deepEqual(selectionCalls, []);
    assert.deepEqual(sortedSelection(state, "TAB-CURRENT"), ["src/Current.tsx"]);
    assert.equal(await getPendingTransitionStateSnapshot(), null);
  } finally {
    restoreClient();
    process.env.HOME = originalHome;
    await resetRpClient();
    clearBinding();
    await clearPendingTransitionState();
    rmSync(tempHome, { recursive: true, force: true });
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("resume-mode session_start failure before sync preserves transition retry mode on reconnect", async () => {
  const originalHome = process.env.HOME;
  const tempHome = mkdtempSync(path.join(os.tmpdir(), "rp-lifecycle-resume-early-failure-home-"));
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "rp-lifecycle-resume-early-failure-root-"));
  const repoRoot = path.join(tempRoot, "chat-tree");
  process.env.HOME = tempHome;

  const state = {
    failConnect: true,
    calls: [],
    failAddByTab: new Map(),
    createdTabId: "TAB-CREATED",
    tabsByWindow: new Map([
      [5, [{ id: "TAB-DIRTY", name: "Dirty", active: true, bound: false, files: 1 }]],
    ]),
    liveSelectionByTab: new Map([["TAB-DIRTY", new Set(["src/Dirty.tsx"])]]),
  };
  const restoreClient = installMockRpClient(state);

  try {
    mkdirSync(path.join(tempHome, ".pi", "agent", "extensions"), { recursive: true });
    writeFileSync(
      path.join(tempHome, ".pi", "agent", "extensions", "repoprompt-mcp.json"),
      JSON.stringify({ command: "fake-rp", args: [], suppressHostDisconnectedLog: false })
    );

    mkdirSync(path.join(repoRoot, "src"), { recursive: true });
    writeFileSync(path.join(repoRoot, "src", "Dirty.tsx"), "export const dirtyValue = 1\n");

    await resetRpClient();
    clearBinding();
    await clearPendingTransitionState();

    const entries = [
      {
        type: "custom",
        customType: BINDING_ENTRY_TYPE,
        data: { windowId: 5, workspace: "chat-tree" },
      },
    ];
    const ctx = createContext(entries, repoRoot, true, {
      sessionId: "session-resume",
      sessionFile: path.join(tempRoot, "session-resume.jsonl"),
    });

    const pi = createMockPi(entries);
    repopromptMcp(pi);
    await pi.emit("session_start", ctx, {
      reason: "resume",
      previousSessionFile: path.join(tempRoot, "old-session.jsonl"),
    });
    await drainLifecycle();

    const pendingAfterFailure = await getPendingTransitionStateSnapshot();
    assert.equal(pendingAfterFailure?.retryMode, "transition");
    assert.equal(pendingAfterFailure?.targetBinding?.tab, undefined);

    state.failConnect = false;
    const reconnectCommand = pi.getCommand("rp");
    assert.ok(reconnectCommand, "rp command should be registered");

    await reconnectCommand.handler("reconnect", ctx);

    assert.ok(
      !state.calls.some((call) => call.name === "manage_workspaces" && call.args.action === "create_tab"),
      JSON.stringify(state.calls, null, 2)
    );
    const bindingEntries = entries.filter(
      (entry) => entry.type === "custom" && entry.customType === BINDING_ENTRY_TYPE
    );
    assert.deepEqual(bindingEntries.at(-1)?.data, { windowId: 5, workspace: "chat-tree" });
    assert.equal(await getPendingTransitionStateSnapshot(), null);
  } finally {
    restoreClient();
    process.env.HOME = originalHome;
    await resetRpClient();
    clearBinding();
    await clearPendingTransitionState();
    rmSync(tempHome, { recursive: true, force: true });
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("successful sync with autoSelectReadSlices disabled clears pending target state", async () => {
  const originalHome = process.env.HOME;
  const tempHome = mkdtempSync(path.join(os.tmpdir(), "rp-lifecycle-no-autoselect-home-"));
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "rp-lifecycle-no-autoselect-root-"));
  const repoRoot = path.join(tempRoot, "chat-tree");
  process.env.HOME = tempHome;

  const state = {
    failConnect: false,
    calls: [],
    failAddByTab: new Map(),
    tabsByWindow: new Map([
      [5, [{ id: "TAB-CURRENT", name: "Current", active: true, bound: false, files: 0 }]],
    ]),
    liveSelectionByTab: new Map([["TAB-CURRENT", new Set()]]),
  };
  const restoreClient = installMockRpClient(state);

  try {
    mkdirSync(path.join(tempHome, ".pi", "agent", "extensions"), { recursive: true });
    writeFileSync(
      path.join(tempHome, ".pi", "agent", "extensions", "repoprompt-mcp.json"),
      JSON.stringify({ command: "fake-rp", args: [], suppressHostDisconnectedLog: false, autoSelectReadSlices: false })
    );

    mkdirSync(repoRoot, { recursive: true });

    await resetRpClient();
    clearBinding();
    await clearPendingTransitionState();

    const entries = [
      {
        type: "custom",
        customType: BINDING_ENTRY_TYPE,
        data: { windowId: 5, workspace: "chat-tree", tab: "TAB-CURRENT" },
      },
    ];
    const ctx = createContext(entries, repoRoot, true, {
      sessionId: "session-no-autoselect",
      sessionFile: path.join(tempRoot, "session-no-autoselect.jsonl"),
    });

    const pi = createMockPi(entries);
    repopromptMcp(pi);
    await pi.emit("session_start", ctx, { reason: "startup" });
    await drainLifecycle();

    assert.equal(await getPendingTransitionStateSnapshot(), null);
    assert.deepEqual(
      state.calls.filter((call) => call.name === "manage_selection"),
      []
    );
  } finally {
    restoreClient();
    process.env.HOME = originalHome;
    await resetRpClient();
    clearBinding();
    await clearPendingTransitionState();
    rmSync(tempHome, { recursive: true, force: true });
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("startup-mode pending target state retries in startup mode on reconnect", async () => {
  const originalHome = process.env.HOME;
  const tempHome = mkdtempSync(path.join(os.tmpdir(), "rp-lifecycle-startup-retry-home-"));
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "rp-lifecycle-startup-retry-root-"));
  const repoRoot = path.join(tempRoot, "chat-tree");
  process.env.HOME = tempHome;

  const state = {
    failConnect: false,
    calls: [],
    failAddByTab: new Map(),
    createdTabId: "TAB-CREATED",
    tabsByWindow: new Map([[5, []]]),
    liveSelectionByTab: new Map([["TAB-CREATED", new Set()]]),
  };
  const restoreClient = installMockRpClient(state);

  try {
    mkdirSync(path.join(tempHome, ".pi", "agent", "extensions"), { recursive: true });
    writeFileSync(
      path.join(tempHome, ".pi", "agent", "extensions", "repoprompt-mcp.json"),
      JSON.stringify({ command: "fake-rp", args: [], suppressHostDisconnectedLog: false })
    );

    mkdirSync(repoRoot, { recursive: true });

    await resetRpClient();
    clearBinding();
    await clearPendingTransitionState();

    const entries = [
      {
        type: "custom",
        customType: BINDING_ENTRY_TYPE,
        data: { windowId: 5, workspace: "chat-tree" },
      },
    ];
    const ctx = createContext(entries, repoRoot, true, {
      sessionId: "session-startup",
      leafId: "leaf-startup",
      sessionFile: path.join(tempRoot, "session-startup.jsonl"),
    });

    await setPendingTransitionTargetSnapshot(
      {
        sessionFile: path.join(tempRoot, "session-startup.jsonl"),
        sessionId: "session-startup",
        leafId: "leaf-startup",
      },
      { windowId: 5, workspace: "chat-tree" },
      null,
      "startup"
    );

    const pendingBeforeReconnect = await getPendingTransitionStateSnapshot();
    assert.equal(pendingBeforeReconnect?.retryMode, "startup");
    assert.equal(pendingBeforeReconnect?.targetBinding?.tab, undefined);

    const pi = createMockPi(entries);
    repopromptMcp(pi);
    const reconnectCommand = pi.getCommand("rp");
    assert.ok(reconnectCommand, "rp command should be registered");

    await reconnectCommand.handler("reconnect", ctx);

    assert.ok(
      state.calls.some((call) => call.name === "manage_workspaces" && call.args.action === "create_tab"),
      JSON.stringify(state.calls, null, 2)
    );
    assert.ok(entries.some((entry) => entry.customType === BINDING_ENTRY_TYPE && entry.data.tab === "TAB-CREATED"));
    assert.equal(await getPendingTransitionStateSnapshot(), null);
  } finally {
    restoreClient();
    process.env.HOME = originalHome;
    await resetRpClient();
    clearBinding();
    await clearPendingTransitionState();
    rmSync(tempHome, { recursive: true, force: true });
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("/rp reconnect completes a deferred resume reconciliation after RepoPrompt was unavailable during session_start", async () => {
  const originalHome = process.env.HOME;
  const tempHome = mkdtempSync(path.join(os.tmpdir(), "rp-lifecycle-reconnect-home-"));
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "rp-lifecycle-reconnect-root-"));
  const repoRoot = path.join(tempRoot, "chat-tree");
  process.env.HOME = tempHome;

  const state = {
    failConnect: false,
    calls: [],
    failAddByTab: new Map(),
    tabsByWindow: new Map([
      [5, [
        { id: "TAB-OLD", name: "Old", active: false, bound: false, files: 1 },
        { id: "TAB-NEW", name: "New", active: true, bound: false, files: 0 },
      ]],
    ]),
    liveSelectionByTab: new Map([
      ["TAB-OLD", new Set(["src/Old.tsx"])],
      ["TAB-NEW", new Set()],
    ]),
  };
  const restoreClient = installMockRpClient(state);

  try {
    mkdirSync(path.join(tempHome, ".pi", "agent", "extensions"), { recursive: true });
    writeFileSync(
      path.join(tempHome, ".pi", "agent", "extensions", "repoprompt-mcp.json"),
      JSON.stringify({ command: "fake-rp", args: [], suppressHostDisconnectedLog: false })
    );

    mkdirSync(path.join(repoRoot, "src"), { recursive: true });
    writeFileSync(path.join(repoRoot, "src", "Old.tsx"), "export const oldValue = 1\n");
    writeFileSync(path.join(repoRoot, "src", "New.tsx"), "export const newValue = 2\n");

    await resetRpClient();
    clearBinding();
    await clearPendingTransitionState();

    const oldEntries = [
      {
        type: "custom",
        customType: BINDING_ENTRY_TYPE,
        data: { windowId: 5, workspace: "chat-tree", tab: "TAB-OLD" },
      },
      {
        type: "custom",
        customType: AUTO_SELECTION_ENTRY_TYPE,
        data: {
          windowId: 5,
          workspace: "chat-tree",
          tab: "TAB-OLD",
          fullPaths: ["src/Old.tsx"],
          slicePaths: [],
        },
      },
    ];

    const newEntries = [
      {
        type: "custom",
        customType: BINDING_ENTRY_TYPE,
        data: { windowId: 5, workspace: "chat-tree", tab: "TAB-NEW" },
      },
      {
        type: "custom",
        customType: AUTO_SELECTION_ENTRY_TYPE,
        data: {
          windowId: 5,
          workspace: "chat-tree",
          tab: "TAB-NEW",
          fullPaths: ["src/New.tsx"],
          slicePaths: [],
        },
      },
    ];

    const oldPi = createMockPi(oldEntries);
    repopromptMcp(oldPi);
    await oldPi.emit("session_start", createContext(oldEntries, repoRoot), { reason: "startup" });
    await drainLifecycle();
    await oldPi.emit("session_shutdown", createContext(oldEntries, repoRoot), {});

    state.calls = [];
    state.failConnect = true;
    const newPi = createMockPi(newEntries);
    repopromptMcp(newPi);
    const newCtx = createContext(newEntries, repoRoot, true);
    await newPi.emit("session_start", newCtx, {
      reason: "resume",
      previousSessionFile: path.join(tempRoot, "old-session.jsonl"),
    });
    await drainLifecycle();

    const preReconnectSelectionCalls = state.calls.filter((call) => call.name === "manage_selection");
    assert.equal(preReconnectSelectionCalls.length, 0);
    assert.deepEqual(sortedSelection(state, "TAB-OLD"), ["src/Old.tsx"]);
    assert.deepEqual(sortedSelection(state, "TAB-NEW"), []);

    state.failConnect = false;
    const reconnectCommand = newPi.getCommand("rp");
    assert.ok(reconnectCommand, "rp command should be registered");

    await reconnectCommand.handler("reconnect", newCtx);

    assert.deepEqual(sortedSelection(state, "TAB-OLD"), []);
    assert.deepEqual(sortedSelection(state, "TAB-NEW"), ["src/New.tsx"]);

    const bindContextCalls = state.calls.filter((call) => call.name === "bind_context");
    assert.ok(bindContextCalls.some((call) => call.args.op === "list" && call.args.window_id === 5));
    assert.ok(bindContextCalls.some((call) => call.args.op === "bind" && call.args.context_id === "TAB-NEW"));

    const selectionCalls = state.calls.filter((call) => call.name === "manage_selection");
    assert.deepEqual(
      selectionCalls.map((call) => ({ op: call.args.op, tab: call.args.context_id, paths: call.args.paths ?? [] })),
      [
        { op: "remove", tab: "TAB-OLD", paths: ["src/Old.tsx"] },
        { op: "add", tab: "TAB-NEW", paths: ["src/New.tsx"] },
      ]
    );
  } finally {
    restoreClient();
    process.env.HOME = originalHome;
    await resetRpClient();
    clearBinding();
    await clearPendingTransitionState();
    rmSync(tempHome, { recursive: true, force: true });
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
