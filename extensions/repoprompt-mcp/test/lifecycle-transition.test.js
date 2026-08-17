import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";

import repopromptMcp from "../dist/index.js";
import {
  clearBinding,
  getBinding,
  getRouteSelectorDecision,
  getRouteState,
  persistBinding,
  quarantineRoute,
  runRouteChange,
} from "../dist/binding.js";
import { RpClient, resetRpClient } from "../dist/client.js";
import {
  MANAGE_WORKSPACES_ACTIONS,
  MANAGE_WORKTREE_OPERATIONS,
  classifyForwardingOperation,
} from "../dist/tool-forwarding-policy.js";
import { AUTO_SELECTION_ENTRY_TYPE, BINDING_ENTRY_TYPE } from "../dist/types.js";
import { catalog as ceCatalog } from "./fixtures/ce-1.2/evidence.js";
import { catalog as classicCatalog } from "./fixtures/classic-2.1.32/evidence.js";

function makeTextResult(text) {
  return {
    isError: false,
    content: [{ type: "text", text }],
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

function fixtureToolByName(catalog, name) {
  return catalog.tools.find((tool) => tool.name === name);
}

function withFixtureSchemas(tools, command) {
  const catalog = command.includes("classic") ? classicCatalog : ceCatalog;
  return tools.map((tool) => {
    const fixtureTool = fixtureToolByName(catalog, tool.name);
    return fixtureTool?.inputSchema && !tool.inputSchema
      ? { ...tool, inputSchema: structuredClone(fixtureTool.inputSchema) }
      : { ...tool };
  });
}

function renderRoutingInventory(state) {
  const windows = [...state.tabsByWindow.entries()].map(([windowId, tabs]) => ({
    window_id: windowId,
    is_current_window: windowId === (state.currentWindowId ?? 5),
    workspace: {
      id: `workspace-${windowId}`,
      name: state.workspaceByWindow?.get(windowId) ?? "chat-tree",
    },
    ...(tabs.find((tab) => tab.active) ? { active_context_id: tabs.find((tab) => tab.active).id } : {}),
    tabs: tabs.map((tab) => ({
      context_id: tab.id,
      name: tab.name,
      is_active: tab.active === true,
      is_bound: tab.bound === true,
      selected_file_count: tab.files,
      repo_paths: tab.repoPaths ?? state.rootsByWindow?.get(windowId) ?? [],
    })),
  }));
  const liveTabs = [...state.tabsByWindow.values()].flat();
  const boundContextId = liveTabs.some((tab) => tab.id === state.boundContextId)
    ? state.boundContextId
    : liveTabs.find((tab) => tab.bound)?.id;
  const boundWindowId = [...state.tabsByWindow.entries()].find(([, tabs]) => (
    tabs.some((tab) => tab.id === boundContextId)
  ))?.[0];
  state.boundContextId = boundContextId;
  return {
    windows,
    binding: boundContextId
      ? {
          binding_kind: state.currentCommand?.includes("classic") ? "context" : "tab_context",
          window_id: boundWindowId,
          context_id: boundContextId,
        }
      : state.windowBoundId !== undefined
        ? { binding_kind: "window", window_id: state.windowBoundId }
        : { binding_kind: "unbound" },
  };
}

function makeTestConfig(overrides = {}) {
  return {
    activeApp: "ce",
    apps: {
      ce: {
        command: "fake-rp",
        args: [],
      },
    },
    suppressHostDisconnectedLog: false,
    ...overrides,
  };
}

function createMockPi(entries, session = {}) {
  const handlers = new Map();
  const commands = new Map();
  const tools = new Map();

  return {
    events: { on() {}, emit() {} },
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

  state.markCatalogStale = () => {
    assert.ok(state.currentClient, "an MCP client must be connected before invalidating tools");
    state.currentClient.toolListInvalidationGeneration += 1;
  };

  state.publishTools = (tools) => {
    assert.ok(state.currentClient, "an MCP client must be connected before publishing tools");
    state.currentClient._tools = tools.map((tool) => ({ ...tool }));
    state.currentClient.publishedToolListGeneration = state.currentClient.toolListInvalidationGeneration;
    state.currentClient.toolCatalogRevision += 1;
  };

  RpClient.prototype.connect = async function connect(command, args, env) {
    state.connects?.push({ command, args, env });
    state.currentCommand = command;

    if (state.failConnect === true) {
      this.client = null;
      this.transport = null;
      this._status = "error";
      this._tools = [];
      this.publishedToolListGeneration = null;
      throw new Error("RepoPrompt unavailable");
    }

    this.client = {};
    this.transport = {};
    this._status = "connected";
    this._error = undefined;
    this.catalogRefreshError = undefined;
    this.toolListInvalidationGeneration = 0;
    this.publishedToolListGeneration = 0;
    this.toolCatalogRevision = 1;
    state.currentClient = this;
    this._tools = withFixtureSchemas(state.toolsByCommand?.get(command) ?? [
      { name: "manage_workspaces", description: "" },
      { name: "bind_context", description: "" },
      { name: "manage_selection", description: "" },
      { name: "oracle_utils", description: "" },
    ], command);
  };

  RpClient.prototype.close = async function close() {
    if (state.currentClient === this) {
      state.currentClient = null;
    }
    this.client = null;
    this.transport = null;
    this._status = "disconnected";
    this._tools = [];
    this.toolListInvalidationGeneration = 0;
    this.publishedToolListGeneration = null;
  };

  RpClient.prototype.callTool = async function callTool(name, args = {}, _timeout, signal) {
    state.calls.push({ name, args });

    if (name === "bind_context" && args.op === "list") {
      state.inventoryCallCount = (state.inventoryCallCount ?? 0) + 1;
      if (state.failInventoryOnCalls?.has(state.inventoryCallCount)) {
        return {
          isError: true,
          content: [{ type: "text", text: "routing inventory unavailable" }],
        };
      }
      if ((state.throwNextInventoryCount ?? 0) > 0) {
        state.throwNextInventoryCount -= 1;
        throw new Error("routing inventory transport failed");
      }
      if ((state.failNextInventoryCount ?? 0) > 0) {
        state.failNextInventoryCount -= 1;
        return {
          isError: true,
          content: [{ type: "text", text: "routing inventory unavailable" }],
        };
      }
      if ((state.malformedNextInventoryCount ?? 0) > 0) {
        state.malformedNextInventoryCount -= 1;
        return makeTextResult(JSON.stringify({ windows: "invalid", binding: {} }));
      }
      const inventoryResult = makeTextResult(JSON.stringify(renderRoutingInventory(state)));
      state.beforeInventoryResponse?.({ callCount: state.inventoryCallCount });
      const blocker = state.blockNextInventory
        ?? state.blockInventoryOnCalls?.get(state.inventoryCallCount);
      if (blocker) {
        state.blockNextInventory = null;
        state.blockInventoryOnCalls?.delete(state.inventoryCallCount);
        blocker.signal = signal;
        blocker.entered.resolve();
        if (blocker.rejectOnAbort && signal) {
          signal.throwIfAborted();
          await Promise.race([
            blocker.release.promise,
            new Promise((_, reject) => {
              signal.addEventListener(
                "abort",
                () => reject(signal.reason ?? new Error("routing inventory aborted")),
                { once: true }
              );
            }),
          ]);
        } else {
          await blocker.release.promise;
        }
      }
      return inventoryResult;
    }

    const isRoutingMutation = (name === "bind_context" && args.op === "bind")
      || (name === "manage_workspaces"
        && !["list", "list_tabs"].includes(args.action))
      || (name === "manage_worktree"
        && ["create", "bind", "select", "unbind"].includes(args.op));
    if (isRoutingMutation) {
      state.routingMutationCallCount = (state.routingMutationCallCount ?? 0) + 1;
      const outcome = state.routingMutationOutcomes?.shift() ?? "success";
      if (outcome === "isError") {
        state.beforeRoutingMutationError?.({ name, args });
        return {
          isError: true,
          content: [{ type: "text", text: "routing mutation rejected" }],
        };
      }
      if (outcome === "throw") {
        throw new Error("routing mutation transport failed");
      }
      if (outcome === "timeout") {
        const error = new Error("routing mutation timed out");
        error.name = "TimeoutError";
        throw error;
      }
      if (outcome === "abort") {
        const error = new Error("routing mutation aborted");
        error.name = "AbortError";
        throw error;
      }
      state.beforeRoutingMutationSuccess?.({ name, args });
    }

    if (name === "bind_context" && args.op === "bind") {
      const observedContextId = state.bindContextObservedId ?? args.context_id;
      state.boundContextId = observedContextId;
      for (const tabs of state.tabsByWindow.values()) {
        for (const tab of tabs) {
          tab.active = tab.id === observedContextId;
          tab.bound = tab.id === observedContextId;
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
      const tabs = state.tabsByWindow.get(args.window_id) ?? [];
      for (const tab of tabs) {
        tab.bound = false;
      }
      tabs.push({
        id: createdTabId,
        name: "Pi Session",
        active: false,
        bound: true,
        files: 0,
        repoPaths: tabs[0]?.repoPaths,
      });
      state.tabsByWindow.set(args.window_id, tabs);
      state.boundContextId = createdTabId;
      return makeTextResult(`Created tab \`${createdTabId}\` • Pi Session [bound]`);
    }

    if (isRoutingMutation) {
      return makeTextResult(`Completed ${name} ${args.action ?? args.op}`);
    }

    if (name === "oracle_utils") {
      return makeTextResult("No Oracle sessions");
    }

    if (name === "manage_selection") {
      const tabId = args.context_id ?? args._tabID;

      if (
        state.enforceStickyContextBinding === true &&
        tabId &&
        state.boundContextId &&
        tabId !== state.boundContextId
      ) {
        return {
          isError: true,
          content: [{
            type: "text",
            text: [
              `Invalid params: Explicit tab context hint for manage_selection targets tab ${tabId},`,
              `but this connection is already bound to tab ${state.boundContextId}.`,
              "Clear or intentionally rebind the connection before targeting a different tab context.",
            ].join(" "),
          }],
        };
      }

      if (args.op === "get" && state.blockNextSelectionGet) {
        const blocker = state.blockNextSelectionGet;
        state.blockNextSelectionGet = null;
        blocker.entered.resolve();
        await blocker.release.promise;
      }

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

    if (state.forwardedTools?.has(name)) {
      const deferredResult = state.forwardedDeferred?.get(name);
      if (deferredResult) {
        return await deferredResult.promise;
      }
      const outcome = state.forwardedCallOutcomes?.shift();
      if (["throw", "timeout", "abort"].includes(outcome)) {
        state.beforeForwardedFailure?.({ name, args });
        const error = new Error(`Forwarded ${name} ${outcome}`);
        if (outcome === "timeout") {
          error.name = "TimeoutError";
        } else if (outcome === "abort") {
          error.name = "AbortError";
        }
        throw error;
      }
      if ((state.failNextForwardedCallCount ?? 0) > 0) {
        state.failNextForwardedCallCount -= 1;
        state.beforeForwardedFailure?.({ name, args });
        return {
          isError: true,
          content: [{ type: "text", text: `Failed ${name}` }],
        };
      }
      return makeTextResult(`Called ${name}`);
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
      module.setPendingTransitionSelectionState(state ? { app: "ce", ...state } : state, retryMode);
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

async function withRoutingLifecycleHarness(options, run) {
  const originalHome = process.env.HOME;
  const tempHome = mkdtempSync(path.join(os.tmpdir(), "rp-routing-harness-home-"));
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "rp-routing-harness-root-"));
  process.env.HOME = tempHome;
  const state = {
    failConnect: false,
    calls: [],
    failAddByTab: new Map(),
    liveSelectionByTab: new Map(),
    forwardedTools: new Set(),
    ...options.state,
  };
  const restoreClient = installMockRpClient(state);

  try {
    mkdirSync(path.join(tempHome, ".pi", "agent", "extensions"), { recursive: true });
    const config = makeTestConfig({ autoBindOnStart: false, ...options.config });
    writeFileSync(
      path.join(tempHome, ".pi", "agent", "extensions", "repoprompt-mcp.json"),
      JSON.stringify(config)
    );

    await resetRpClient();
    clearBinding();
    await clearPendingTransitionState();

    const entries = options.entries ?? [];
    const pi = createMockPi(entries);
    repopromptMcp(pi);
    const ctx = createContext(entries, tempRoot, options.hasUI === true);
    ctx.ui.notify = options.notify ?? (() => {});
    if (options.skipSessionStart !== true) {
      await pi.emit("session_start", ctx, { reason: options.reason ?? "startup" });
      await drainLifecycle();
    }

    await run({ state, entries, pi, ctx, config, tempRoot });
  } finally {
    restoreClient();
    process.env.HOME = originalHome;
    await resetRpClient();
    clearBinding();
    await clearPendingTransitionState();
    rmSync(tempHome, { recursive: true, force: true });
    rmSync(tempRoot, { recursive: true, force: true });
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
      JSON.stringify(makeTestConfig())
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
          data: { app: "ce", windowId: 5, workspace: "chat-tree", tab: "TAB-OLD" },
      },
      {
        type: "custom",
        customType: AUTO_SELECTION_ENTRY_TYPE,
          data: {
            app: "ce",
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
          data: { app: "ce", windowId: 5, workspace: "chat-tree", tab: "TAB-NEW" },
      },
      {
        type: "custom",
        customType: AUTO_SELECTION_ENTRY_TYPE,
          data: {
            app: "ce",
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
    assert.ok(bindContextCalls.some((call) => call.args.op === "list" && call.args.window_id === undefined));
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
      JSON.stringify(makeTestConfig())
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
        data: { app: "ce", windowId: 5, workspace: "chat-tree", tab: "TAB-OLD" },
      },
      {
        type: "custom",
        customType: AUTO_SELECTION_ENTRY_TYPE,
        data: {
          app: "ce",
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
        data: { app: "ce", windowId: 5, workspace: "chat-tree", tab: "TAB-OLD" },
      },
      {
        type: "custom",
        customType: AUTO_SELECTION_ENTRY_TYPE,
        data: {
          app: "ce",
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
      app: "ce",
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
      app: "ce",
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
    assert.ok(bindContextCalls.some((call) => call.args.op === "list" && call.args.window_id === undefined));
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
      app: "ce",
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
      JSON.stringify(makeTestConfig())
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
        data: { app: "ce", windowId: 5, workspace: "chat-tree", tab: "TAB-OLD" },
      },
      {
        type: "custom",
        customType: AUTO_SELECTION_ENTRY_TYPE,
        data: {
          app: "ce",
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
        data: { app: "ce", windowId: 5, workspace: "chat-tree", tab: "TAB-OLD" },
      },
      {
        type: "custom",
        customType: AUTO_SELECTION_ENTRY_TYPE,
        data: {
          app: "ce",
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
      app: "ce",
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
      app: "ce",
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
      app: "ce",
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
      JSON.stringify(makeTestConfig())
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
        data: { app: "ce", windowId: 5, workspace: "chat-tree", tab: "TAB-NEW" },
      },
      {
        type: "custom",
        customType: AUTO_SELECTION_ENTRY_TYPE,
        data: {
          app: "ce",
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
    ignorableRemoveErrorText: "Invalid params: Window 5 does not host context_id 'TAB-OLD'. Available windows: 1, 2, 3",
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
      JSON.stringify(makeTestConfig())
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
        data: { app: "ce", windowId: 5, workspace: "chat-tree", tab: "TAB-OLD" },
      },
      {
        type: "custom",
        customType: AUTO_SELECTION_ENTRY_TYPE,
        data: {
          app: "ce",
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
        data: { app: "ce", windowId: 5, workspace: "chat-tree", tab: "TAB-NEW" },
      },
      {
        type: "custom",
        customType: AUTO_SELECTION_ENTRY_TYPE,
        data: {
          app: "ce",
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
      JSON.stringify(makeTestConfig())
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
        data: { app: "ce", windowId: 5, workspace: "chat-tree", tab: "TAB-OLD" },
      },
      {
        type: "custom",
        customType: AUTO_SELECTION_ENTRY_TYPE,
        data: {
          app: "ce",
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
        data: { app: "ce", windowId: 5, workspace: "chat-tree", tab: "TAB-B" },
      },
      {
        type: "custom",
        customType: AUTO_SELECTION_ENTRY_TYPE,
        data: {
          app: "ce",
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
        data: { app: "ce", windowId: 5, workspace: "chat-tree", tab: "TAB-C" },
      },
      {
        type: "custom",
        customType: AUTO_SELECTION_ENTRY_TYPE,
        data: {
          app: "ce",
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
      JSON.stringify(makeTestConfig())
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
        data: { app: "ce", windowId: 5, workspace: "chat-tree", tab: "TAB-CURRENT" },
      },
      {
        type: "custom",
        customType: AUTO_SELECTION_ENTRY_TYPE,
        data: {
          app: "ce",
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
      JSON.stringify(makeTestConfig())
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
        data: { app: "ce", windowId: 5, workspace: "chat-tree" },
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
    assert.deepEqual(bindingEntries.at(-1)?.data, { app: "ce", windowId: 5, workspace: "chat-tree" });
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
      JSON.stringify(makeTestConfig({ autoSelectReadSlices: false }))
    );

    mkdirSync(repoRoot, { recursive: true });

    await resetRpClient();
    clearBinding();
    await clearPendingTransitionState();

    const entries = [
      {
        type: "custom",
        customType: BINDING_ENTRY_TYPE,
        data: { app: "ce", windowId: 5, workspace: "chat-tree", tab: "TAB-CURRENT" },
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
      JSON.stringify(makeTestConfig())
    );

    mkdirSync(repoRoot, { recursive: true });

    await resetRpClient();
    clearBinding();
    await clearPendingTransitionState();

    const entries = [
      {
        type: "custom",
        customType: BINDING_ENTRY_TYPE,
        data: { app: "ce", windowId: 5, workspace: "chat-tree" },
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
      JSON.stringify(makeTestConfig())
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
        data: { app: "ce", windowId: 5, workspace: "chat-tree", tab: "TAB-OLD" },
      },
      {
        type: "custom",
        customType: AUTO_SELECTION_ENTRY_TYPE,
        data: {
          app: "ce",
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
        data: { app: "ce", windowId: 5, workspace: "chat-tree", tab: "TAB-NEW" },
      },
      {
        type: "custom",
        customType: AUTO_SELECTION_ENTRY_TYPE,
        data: {
          app: "ce",
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
    assert.ok(bindContextCalls.some((call) => call.args.op === "list" && call.args.window_id === undefined));
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

test("session_tree rewind between live tabs adopts target tab without mutating source selection", async () => {
  const originalHome = process.env.HOME;
  const tempHome = mkdtempSync(path.join(os.tmpdir(), "rp-tree-live-tab-home-"));
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "rp-tree-live-tab-root-"));
  const repoRoot = path.join(tempRoot, "chat-tree");
  process.env.HOME = tempHome;

  const state = {
    failConnect: false,
    calls: [],
    connects: [],
    failAddByTab: new Map(),
    enforceStickyContextBinding: true,
    boundContextId: "TAB-NEW",
    tabsByWindow: new Map([
      [5, [
        { id: "TAB-OLD", name: "Old", active: false, bound: false, files: 1 },
        { id: "TAB-NEW", name: "New", active: true, bound: true, files: 1 },
      ]],
    ]),
    liveSelectionByTab: new Map([
      ["TAB-OLD", new Set(["src/Old.tsx"])],
      ["TAB-NEW", new Set(["src/New.tsx"])],
    ]),
  };
  const restoreClient = installMockRpClient(state);

  try {
    const config = makeTestConfig();
    mkdirSync(path.join(tempHome, ".pi", "agent", "extensions"), { recursive: true });
    writeFileSync(
      path.join(tempHome, ".pi", "agent", "extensions", "repoprompt-mcp.json"),
      JSON.stringify(config)
    );

    mkdirSync(path.join(repoRoot, "src"), { recursive: true });
    writeFileSync(path.join(repoRoot, "src", "Old.tsx"), "export const oldValue = 1\n");
    writeFileSync(path.join(repoRoot, "src", "New.tsx"), "export const newValue = 2\n");

    await resetRpClient();
    clearBinding();
    await clearPendingTransitionState();

    const newEntries = [
      {
        type: "custom",
        customType: BINDING_ENTRY_TYPE,
        data: { app: "ce", windowId: 5, workspace: "chat-tree", tab: "TAB-NEW" },
      },
      {
        type: "custom",
        customType: AUTO_SELECTION_ENTRY_TYPE,
        data: {
          app: "ce",
          windowId: 5,
          workspace: "chat-tree",
          tab: "TAB-NEW",
          fullPaths: ["src/New.tsx"],
          slicePaths: [],
        },
      },
    ];

    const oldEntries = [
      {
        type: "custom",
        customType: BINDING_ENTRY_TYPE,
        data: { app: "ce", windowId: 5, workspace: "chat-tree", tab: "TAB-OLD" },
      },
      {
        type: "custom",
        customType: AUTO_SELECTION_ENTRY_TYPE,
        data: {
          app: "ce",
          windowId: 5,
          workspace: "chat-tree",
          tab: "TAB-OLD",
          fullPaths: ["src/Old.tsx"],
          slicePaths: [],
        },
      },
    ];

    const pi = createMockPi(newEntries);
    repopromptMcp(pi);
    await pi.emit("session_start", createContext(newEntries, repoRoot), { reason: "startup" });
    await drainLifecycle();

    state.calls = [];

    await pi.emit("session_tree", createContext(oldEntries, repoRoot), {});

    assert.deepEqual(sortedSelection(state, "TAB-OLD"), ["src/Old.tsx"]);
    assert.deepEqual(sortedSelection(state, "TAB-NEW"), ["src/New.tsx"]);

    const selectionCalls = state.calls.filter((call) => call.name === "manage_selection");
    assert.deepEqual(
      selectionCalls.map((call) => ({ op: call.args.op, tab: call.args.context_id, paths: call.args.paths ?? [] })),
      [{ op: "add", tab: "TAB-OLD", paths: ["src/Old.tsx"] }]
    );
    assert.deepEqual(
      state.calls.filter((call) => call.name === "bind_context" && call.args.op === "bind").at(-1)?.args,
      { op: "bind", context_id: "TAB-OLD" }
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

test("/rp tab new creates and binds an isolated tab without replaying prior selection", async () => {
  const originalHome = process.env.HOME;
  const tempHome = mkdtempSync(path.join(os.tmpdir(), "rp-tab-new-home-"));
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "rp-tab-new-root-"));
  process.env.HOME = tempHome;

  const state = {
    failConnect: false,
    calls: [],
    connects: [],
    failAddByTab: new Map(),
    tabsByWindow: new Map([
      [5, [
        { id: "TAB-OLD", name: "Old", active: true, bound: true, files: 1 },
      ]],
    ]),
    liveSelectionByTab: new Map([
      ["TAB-OLD", new Set(["src/Old.tsx"])],
      ["TAB-CREATED", new Set()],
    ]),
  };
  const restoreClient = installMockRpClient(state);

  try {
    const config = makeTestConfig();
    mkdirSync(path.join(tempHome, ".pi", "agent", "extensions"), { recursive: true });
    writeFileSync(
      path.join(tempHome, ".pi", "agent", "extensions", "repoprompt-mcp.json"),
      JSON.stringify(config)
    );

    await resetRpClient();
    clearBinding();
    await clearPendingTransitionState();

    const entries = [];
    const pi = createMockPi(entries);
    repopromptMcp(pi);
    persistBinding(pi, { windowId: 5, workspace: "chat-tree", tab: "TAB-OLD" }, config);

    const notifications = [];
    const ctx = createContext(entries, tempRoot, true);
    ctx.ui.notify = (message, level) => {
      notifications.push({ message, level });
    };

    const command = pi.getCommand("rp");
    assert.ok(command, "rp command should be registered");

    await command.handler("status", ctx);
    state.calls.length = 0;
    await setPendingTransitionSourceState({
      windowId: 5,
      workspace: "chat-tree",
      tab: "TAB-OLD",
      fullPaths: ["src/Old.tsx"],
      slicePaths: [],
    }, "transition");

    await command.handler("tab new", ctx);

    assert.deepEqual(state.calls.filter((call) => call.name === "manage_selection"), []);
    assert.deepEqual(
      state.calls.filter(
        (call) => call.name === "manage_workspaces" && call.args.action === "create_tab"
      ).at(-1)?.args,
      { action: "create_tab", window_id: 5, bind: true, focus: false }
    );
    assert.equal(
      state.calls.some((call) => call.name === "bind_context" && call.args.op === "bind"),
      false
    );
    assert.deepEqual(sortedSelection(state, "TAB-OLD"), ["src/Old.tsx"]);
    assert.deepEqual(sortedSelection(state, "TAB-CREATED"), []);
    assert.ok(entries.some((entry) => entry.customType === BINDING_ENTRY_TYPE && entry.data.tab === "TAB-CREATED"));
    assert.ok(notifications.some((item) => item.message.includes("Bound to window 5")));
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

test("/rp app switches target, appends session state, and status reports the active app", async () => {
  const originalHome = process.env.HOME;
  const tempHome = mkdtempSync(path.join(os.tmpdir(), "rp-app-switch-home-"));
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "rp-app-switch-root-"));
  process.env.HOME = tempHome;

  const state = {
    failConnect: false,
    calls: [],
    connects: [],
    failAddByTab: new Map(),
    tabsByWindow: new Map(),
    liveSelectionByTab: new Map(),
  };
  const restoreClient = installMockRpClient(state);

  try {
    mkdirSync(path.join(tempHome, ".pi", "agent", "extensions"), { recursive: true });
    writeFileSync(
      path.join(tempHome, ".pi", "agent", "extensions", "repoprompt-mcp.json"),
      JSON.stringify(makeTestConfig({
        apps: {
          ce: { command: "ce-mcp", args: [] },
          classic: { command: "classic-mcp", args: ["--stdio"], env: { RP_APP: "classic" } },
        },
      }))
    );

    await resetRpClient();
    clearBinding();
    await clearPendingTransitionState();

    const entries = [];
    const pi = createMockPi(entries);
    repopromptMcp(pi);

    const notifications = [];
    const ctx = createContext(entries, tempRoot, true);
    ctx.ui.notify = (message, level) => {
      notifications.push({ message, level });
    };

    const command = pi.getCommand("rp");
    assert.ok(command, "rp command should be registered");

    await command.handler("app classic", ctx);
    await command.handler("status", ctx);

    assert.deepEqual(state.connects.at(-1), {
      command: "classic-mcp",
      args: ["--stdio"],
      env: { RP_APP: "classic" },
    });
    assert.ok(entries.some((entry) => entry.customType === "repoprompt-mcp-active-app" && entry.data.app === "classic"));
    assert.ok(notifications.some((item) => item.message.includes("RepoPrompt Classic (classic) selected")));
    assert.ok(notifications.some((item) => item.message.includes("App: RepoPrompt Classic (classic)")));
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

test("extension catalog consumers observe harness-published freshness without reconnecting or binding", async () => {
  const originalHome = process.env.HOME;
  const tempHome = mkdtempSync(path.join(os.tmpdir(), "rp-app-catalog-home-"));
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "rp-app-catalog-root-"));
  process.env.HOME = tempHome;

  const globalTools = [
    { name: "app_settings", description: "" },
    { name: "bind_context", description: "" },
    { name: "manage_workspaces", description: "" },
  ];
  const state = {
    failConnect: false,
    calls: [],
    connects: [],
    failAddByTab: new Map(),
    tabsByWindow: new Map(),
    liveSelectionByTab: new Map(),
    forwardedTools: new Set(["app_settings", "agent_run"]),
    toolsByCommand: new Map([
      ["classic-mcp", [...globalTools, { name: "agent_run", description: "" }]],
      ["ce-mcp", globalTools],
    ]),
  };
  const restoreClient = installMockRpClient(state);

  try {
    mkdirSync(path.join(tempHome, ".pi", "agent", "extensions"), { recursive: true });
    writeFileSync(
      path.join(tempHome, ".pi", "agent", "extensions", "repoprompt-mcp.json"),
      JSON.stringify(makeTestConfig({
        activeApp: "classic",
        autoBindOnStart: false,
        apps: {
          ce: { command: "ce-mcp", args: [] },
          classic: { command: "classic-mcp", args: [] },
        },
      }))
    );

    await resetRpClient();
    clearBinding();
    await clearPendingTransitionState();

    const entries = [];
    const pi = createMockPi(entries);
    repopromptMcp(pi);
    const notifications = [];
    const ctx = createContext(entries, tempRoot, false);
    ctx.ui.notify = (message, level) => {
      notifications.push({ message, level });
    };
    const command = pi.getCommand("rp");
    const rpTool = pi.getTool("rp");
    assert.ok(command, "rp command should be registered");
    assert.ok(rpTool, "rp tool should be registered");

    await pi.emit("session_start", ctx, { reason: "startup" });
    await drainLifecycle();
    await command.handler("app ce", ctx);
    state.markCatalogStale();
    state.calls.length = 0;

    await command.handler("status", ctx);
    const staleStatus = await rpTool.execute("stale-status", {}, undefined, () => {}, ctx);
    const staleSearch = await rpTool.execute("stale-search", { search: "app" }, undefined, () => {}, ctx);
    const staleMissingSearch = await rpTool.execute(
      "stale-missing-search",
      { search: "agent_run" },
      undefined,
      () => {},
      ctx
    );
    const staleDescribe = await rpTool.execute(
      "stale-describe",
      { describe: "app_settings" },
      undefined,
      () => {},
      ctx
    );
    const staleMissingDescribe = await rpTool.execute(
      "stale-missing-describe",
      { describe: "agent_run" },
      undefined,
      () => {},
      ctx
    );
    const staleKnownCall = await rpTool.execute(
      "stale-known-call",
      { call: "app_settings", args: { op: "list" } },
      undefined,
      () => {},
      ctx
    );
    const staleMissingCall = await rpTool.execute(
      "stale-missing-call",
      { call: "agent_run", args: { op: "poll", session_id: "SESSION" } },
      undefined,
      () => {},
      ctx
    );

    assert.ok(notifications.some((item) => item.message.includes("Tool catalog: stale (3 last-known tools)")));
    assert.match(staleStatus.content[0].text, /Tool catalog: stale \(3 last-known tools\)/u);
    assert.equal(staleStatus.details.toolCatalogFreshness, "stale");
    assert.match(staleSearch.content[0].text, /results come from the last successful catalog/u);
    assert.equal(staleSearch.details.toolCatalogFreshness, "stale");
    assert.equal(staleMissingSearch.isError, true);
    assert.equal(staleMissingSearch.details.error, "catalog_stale");
    assert.match(staleDescribe.content[0].text, /results come from the last successful catalog/u);
    assert.equal(staleDescribe.details.toolCatalogFreshness, "stale");
    assert.equal(staleMissingDescribe.isError, true);
    assert.equal(staleMissingDescribe.details.error, "catalog_stale");
    assert.equal(staleKnownCall.details.toolCatalogFreshness, "stale");
    assert.equal(staleMissingCall.isError, true);
    assert.equal(staleMissingCall.details.error, "catalog_stale");
    assert.equal(state.calls.filter((call) => call.name === "app_settings").length, 1);
    assert.equal(state.calls.some((call) => call.name === "agent_run"), false);

    state.publishTools([...globalTools, { name: "agent_run", description: "" }]);

    const freshStatus = await rpTool.execute("fresh-status", {}, undefined, () => {}, ctx);
    const freshSearch = await rpTool.execute(
      "fresh-search",
      { search: "agent_run" },
      undefined,
      () => {},
      ctx
    );
    const freshDescribe = await rpTool.execute(
      "fresh-describe",
      { describe: "agent_run" },
      undefined,
      () => {},
      ctx
    );
    const freshCall = await rpTool.execute(
      "fresh-call",
      { call: "agent_run", args: { op: "poll", session_id: "SESSION" } },
      undefined,
      () => {},
      ctx
    );

    assert.match(freshStatus.content[0].text, /Tool catalog: fresh \(4 tools\)/u);
    assert.equal(freshStatus.details.toolCatalogFreshness, "fresh");
    assert.equal(freshSearch.details.toolCatalogFreshness, "fresh");
    assert.equal(freshDescribe.details.toolCatalogFreshness, "fresh");
    assert.equal(freshCall.details.toolCatalogFreshness, "fresh");
    assert.equal(state.calls.filter((call) => call.name === "agent_run").length, 1);
    assert.equal(state.connects.length, 2);
    assert.equal(state.calls.some((call) => call.name === "bind_context" && call.args.op === "bind"), false);
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

test("/rp app keeps failed target active and marks status paused", async () => {
  const originalHome = process.env.HOME;
  const tempHome = mkdtempSync(path.join(os.tmpdir(), "rp-app-switch-fail-home-"));
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "rp-app-switch-fail-root-"));
  process.env.HOME = tempHome;

  const state = {
    failConnect: true,
    calls: [],
    connects: [],
    failAddByTab: new Map(),
    tabsByWindow: new Map(),
    liveSelectionByTab: new Map(),
  };
  const restoreClient = installMockRpClient(state);

  try {
    mkdirSync(path.join(tempHome, ".pi", "agent", "extensions"), { recursive: true });
    writeFileSync(
      path.join(tempHome, ".pi", "agent", "extensions", "repoprompt-mcp.json"),
      JSON.stringify(makeTestConfig({
        apps: {
          ce: { command: "ce-mcp", args: [] },
          classic: { command: "classic-mcp", args: [] },
        },
      }))
    );

    await resetRpClient();
    clearBinding();
    await clearPendingTransitionState();

    const entries = [];
    const pi = createMockPi(entries);
    repopromptMcp(pi);

    const notifications = [];
    const ctx = createContext(entries, tempRoot, true);
    ctx.ui.notify = (message, level) => {
      notifications.push({ message, level });
    };

    const command = pi.getCommand("rp");
    assert.ok(command, "rp command should be registered");

    await command.handler("app classic", ctx);
    await command.handler("status", ctx);

    assert.deepEqual(state.connects.at(-1), { command: "classic-mcp", args: [], env: undefined });
    assert.ok(entries.some((entry) => entry.customType === "repoprompt-mcp-active-app" && entry.data.app === "classic"));
    assert.ok(notifications.some((item) => item.level === "error" && item.message.includes("Failed to connect")));
    assert.ok(notifications.some((item) => item.message.includes("App: RepoPrompt Classic (classic)")));
    assert.ok(notifications.some((item) => item.message.includes("Extension: ⏸ paused")));
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

test("agent_run steering guidance is advertised only while RepoPrompt CE is the active target", async () => {
  const originalHome = process.env.HOME;
  const tempHome = mkdtempSync(path.join(os.tmpdir(), "rp-agent-run-desc-home-"));
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "rp-agent-run-desc-root-"));
  process.env.HOME = tempHome;

  const upstreamDescription = "Spawn and control Agent Mode sessions.";
  const agentRunCatalog = [
    { name: "agent_run", description: upstreamDescription },
    { name: "bind_context", description: "" },
    { name: "manage_workspaces", description: "" },
  ];
  const state = {
    failConnect: false,
    calls: [],
    connects: [],
    failAddByTab: new Map(),
    tabsByWindow: new Map(),
    liveSelectionByTab: new Map(),
    forwardedTools: new Set(["agent_run"]),
    toolsByCommand: new Map([
      ["ce-mcp", agentRunCatalog],
      ["classic-mcp", agentRunCatalog],
    ]),
  };
  const restoreClient = installMockRpClient(state);

  try {
    mkdirSync(path.join(tempHome, ".pi", "agent", "extensions"), { recursive: true });
    writeFileSync(
      path.join(tempHome, ".pi", "agent", "extensions", "repoprompt-mcp.json"),
      JSON.stringify(makeTestConfig({
        activeApp: "ce",
        autoBindOnStart: false,
        apps: {
          ce: { command: "ce-mcp", args: [] },
          classic: { command: "classic-mcp", args: [] },
        },
      }))
    );

    await resetRpClient();
    clearBinding();
    await clearPendingTransitionState();

    const entries = [];
    const pi = createMockPi(entries);
    repopromptMcp(pi);
    const ctx = createContext(entries, tempRoot, false);
    ctx.ui.notify = () => {};
    const command = pi.getCommand("rp");
    const rpTool = pi.getTool("rp");
    assert.match(rpTool.description, /RepoPrompt CE Agent Mode/u);
    assert.match(rpTool.description, /scheduled automatically/u);
    assert.match(rpTool.description, /prompt-cache policy/u);
    assert.doesNotMatch(rpTool.description, /timeout:\s*[1-9]\d*/u);

    await pi.emit("session_start", ctx, { reason: "startup" });
    await drainLifecycle();

    const ceDescribe = await rpTool.execute("ce-describe", { describe: "agent_run" }, undefined, () => {}, ctx);
    const ceText = ceDescribe.content[0].text;
    assert.match(ceText, /RepoPrompt CE Agent Mode/u);
    assert.match(ceText, /scheduled automatically/u);
    assert.match(ceText, /child keeps running and remains re-waitable/u);
    assert.doesNotMatch(ceText, /timeout:\s*[1-9]\d*/u);

    await command.handler("app classic", ctx);
    await drainLifecycle();

    const classicDescribe = await rpTool.execute(
      "classic-describe",
      { describe: "agent_run" },
      undefined,
      () => {},
      ctx
    );
    const classicText = classicDescribe.content[0].text;
    assert.match(classicText, /Spawn and control Agent Mode sessions\./u);
    assert.doesNotMatch(classicText, /scheduled automatically/u);
    assert.doesNotMatch(classicText, /prompt-cache policy/u);
    assert.doesNotMatch(classicText, /observer-interruptible/u);
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

test("WI3A caller bind selectors survive and reconcile all four routing authorities", async () => {
  const originalHome = process.env.HOME;
  const tempHome = mkdtempSync(path.join(os.tmpdir(), "rp-route-mutation-home-"));
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "rp-route-mutation-root-"));
  process.env.HOME = tempHome;

  const oldTabId = "TAB-OLD";
  const newTabId = "TAB-NEW";
  const state = {
    failConnect: false,
    calls: [],
    connects: [],
    boundContextId: oldTabId,
    enforceStickyContextBinding: true,
    failAddByTab: new Map(),
    tabsByWindow: new Map([[
      5,
      [
        { id: oldTabId, name: "Old", active: true, bound: true, files: 0 },
        { id: newTabId, name: "New", active: false, bound: false, files: 0 },
      ],
    ]]),
    liveSelectionByTab: new Map(),
    forwardedTools: new Set(),
  };
  const restoreClient = installMockRpClient(state);

  try {
    mkdirSync(path.join(tempHome, ".pi", "agent", "extensions"), { recursive: true });
    writeFileSync(
      path.join(tempHome, ".pi", "agent", "extensions", "repoprompt-mcp.json"),
      JSON.stringify(makeTestConfig({ autoBindOnStart: false }))
    );

    await resetRpClient();
    clearBinding();
    await clearPendingTransitionState();

    const entries = [];
    const pi = createMockPi(entries);
    repopromptMcp(pi);
    const ctx = createContext(entries, tempRoot, false);
    await pi.emit("session_start", ctx, { reason: "startup" });
    await drainLifecycle();

    persistBinding(pi, { app: "ce", windowId: 5, workspace: "chat-tree", tab: oldTabId }, makeTestConfig());
    const rpTool = pi.getTool("rp");
    await rpTool.execute(
      "bind-new-tab",
      { call: "bind_context", args: { op: "bind", context_id: newTabId } },
      undefined,
      () => {},
      ctx
    );

    const bindCall = state.calls.filter(
      (call) => call.name === "bind_context" && call.args.op === "bind"
    ).at(-1);
    const liveInventoryBound = state.tabsByWindow.get(5).find((tab) => tab.bound)?.id;
    const persistedTab = entries.filter((entry) => entry.customType === BINDING_ENTRY_TYPE).at(-1)?.data?.tab;

    // Old failure reason: cached selectors overwrote TAB-NEW, and the generic success path
    // never reconciled live inventory, sticky binding, route store, or branch persistence
    assert.deepEqual({
      forwardedContext: bindCall?.args.context_id,
      liveInventory: liveInventoryBound,
      stickyBinding: state.boundContextId,
      routeStore: getBinding()?.tab,
      branchPersistence: persistedTab,
    }, {
      forwardedContext: newTabId,
      liveInventory: newTabId,
      stickyBinding: newTabId,
      routeStore: newTabId,
      branchPersistence: newTabId,
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

test("startup adopts a non-conflicting sticky tab and persists the verified route", async () => {
  await withRoutingLifecycleHarness({
    state: {
      boundContextId: "TAB-LIVE",
      tabsByWindow: new Map([[5, [
        { id: "TAB-LIVE", name: "Live", active: true, bound: true, files: 0 },
      ]]]),
    },
  }, async ({ state, entries }) => {
    assert.equal(getRouteState().kind, "verified");
    assert.equal(getBinding()?.tab, "TAB-LIVE");
    assert.equal(state.boundContextId, "TAB-LIVE");
    assert.equal(
      entries.filter((entry) => entry.customType === BINDING_ENTRY_TYPE).at(-1)?.data.tab,
      "TAB-LIVE"
    );
    assert.equal(
      state.calls.some((call) => call.name === "bind_context" && call.args.op === "bind"),
      false
    );
    assert.equal(
      state.calls.some((call) => call.name === "manage_workspaces" && call.args.action === "create_tab"),
      false
    );
  });
});

test("startup records a window-only connection as non-dispatchable intent without mutation", async () => {
  await withRoutingLifecycleHarness({
    state: {
      windowBoundId: 5,
      tabsByWindow: new Map([[5, [
        { id: "TAB-SAFE", name: "Safe", active: true, bound: false, files: 0 },
      ]]]),
    },
  }, async ({ state, entries, pi, ctx }) => {
    assert.equal(getRouteState().kind, "intent");
    assert.equal(getBinding()?.windowId, 5);
    assert.equal(getBinding()?.tab, undefined);
    assert.equal(state.routingMutationCallCount ?? 0, 0);
    assert.equal(
      entries.filter((entry) => entry.customType === BINDING_ENTRY_TYPE).length,
      0
    );
    const status = await pi.getTool("rp").execute("window-status", {}, undefined, () => {}, ctx);
    assert.equal(status.details.routeState, "intent");
    assert.doesNotMatch(status.content[0].text, /verified window/u);
  });
});

test("startup auto-binds the safe tab in the window matching cwd", async () => {
  const notifications = [];
  await withRoutingLifecycleHarness({
    hasUI: true,
    config: { autoBindOnStart: true },
    notify: (message, level) => notifications.push({ message, level }),
    state: {
      windowBoundId: 5,
      tabsByWindow: new Map([[5, [
        {
          id: "TAB-SAFE",
          name: "Safe",
          active: true,
          bound: false,
          files: 0,
          repoPaths: [process.cwd()],
        },
      ]]]),
    },
  }, async ({ state, entries }) => {
    assert.equal(getRouteState().kind, "verified");
    assert.equal(getBinding()?.tab, "TAB-SAFE");
    assert.equal(getBinding()?.autoDetected, true);
    assert.equal(state.boundContextId, "TAB-SAFE");
    assert.equal(state.routingMutationCallCount, 1);
    assert.equal(
      entries.filter((entry) => entry.customType === BINDING_ENTRY_TYPE).at(-1)?.data.tab,
      "TAB-SAFE"
    );
    assert.equal(notifications.filter(({ level }) => level === "warning").length, 0);
    assert.ok(notifications.some(({ message }) => message.includes("auto-bound to window 5")));
  });
});

test("startup automatic bind failure emits one concise warning", async () => {
  const notifications = [];
  await withRoutingLifecycleHarness({
    hasUI: true,
    config: { autoBindOnStart: true },
    notify: (message, level) => notifications.push({ message, level }),
    state: {
      windowBoundId: 5,
      routingMutationOutcomes: ["isError"],
      tabsByWindow: new Map([[5, [
        {
          id: "TAB-SAFE",
          name: "Safe",
          active: true,
          bound: false,
          files: 0,
          repoPaths: [process.cwd()],
        },
      ]]]),
    },
  }, async ({ state }) => {
    const warnings = notifications.filter(({ level }) => level === "warning");
    assert.equal(getRouteState().kind, "intent");
    assert.equal(state.routingMutationCallCount, 1);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].message, /automatic tab binding failed.*Run \/rp bind/u);
    assert.doesNotMatch(warnings[0].message, /Recommended:|Alternatives:|bind_context/u);
  });
});

test("startup auto-bind cannot supersede a newer explicit route publication", async () => {
  const entered = deferred();
  const release = deferred();
  const notifications = [];
  await withRoutingLifecycleHarness({
    skipSessionStart: true,
    hasUI: true,
    config: { autoBindOnStart: true },
    notify: (message, level) => notifications.push({ message, level }),
    state: {
      windowBoundId: 5,
      blockInventoryOnCalls: new Map([[2, { entered, release, rejectOnAbort: false }]]),
      tabsByWindow: new Map([[5, [
        {
          id: "TAB-STARTUP",
          name: "Startup",
          active: true,
          bound: false,
          files: 0,
          repoPaths: [process.cwd()],
        },
        {
          id: "TAB-USER",
          name: "User",
          active: false,
          bound: false,
          files: 0,
          repoPaths: [process.cwd()],
        },
      ]]]),
    },
  }, async ({ state, entries, pi, ctx }) => {
    const startup = pi.emit("session_start", ctx, { reason: "startup" });
    await entered.promise;

    state.boundContextId = "TAB-USER";
    for (const tab of state.tabsByWindow.get(5)) {
      tab.active = tab.id === "TAB-USER";
      tab.bound = tab.id === "TAB-USER";
    }
    persistBinding(
      pi,
      {
        app: "ce",
        windowId: 5,
        tab: "TAB-USER",
        workspace: "chat-tree",
        autoDetected: false,
      },
      makeTestConfig(),
      "User"
    );
    assert.equal(getBinding()?.tab, "TAB-USER");
    assert.equal(getBinding()?.autoDetected, false);

    release.resolve();
    await startup;
    await drainLifecycle();

    assert.equal(getBinding()?.tab, "TAB-USER");
    assert.equal(state.boundContextId, "TAB-USER");
    assert.equal(state.routingMutationCallCount ?? 0, 0);
    assert.equal(
      entries.filter((entry) => entry.customType === BINDING_ENTRY_TYPE).at(-1)?.data.tab,
      "TAB-USER"
    );
    assert.equal(notifications.filter(({ level }) => level === "warning").length, 0);
  });
});

test("ambiguous startup auto-bind failures quarantine without replay and warn once", async (t) => {
  for (const failure of [
    { name: "thrown mutation", state: { routingMutationOutcomes: ["throw"] } },
    {
      name: "failed post-mutation observation",
      state: {
        beforeRoutingMutationSuccess({ name, args }) {
          if (name === "bind_context" && args.op === "bind") {
            this.failNextInventoryCount = 1;
          }
        },
      },
    },
  ]) {
    await t.test(failure.name, async () => {
      const notifications = [];
      await withRoutingLifecycleHarness({
        hasUI: true,
        config: { autoBindOnStart: true },
        notify: (message, level) => notifications.push({ message, level }),
        state: {
          windowBoundId: 5,
          ...failure.state,
          tabsByWindow: new Map([[5, [
            {
              id: "TAB-SAFE",
              name: "Safe",
              active: true,
              bound: false,
              files: 0,
              repoPaths: [process.cwd()],
            },
          ]]]),
        },
      }, async ({ state }) => {
        const warnings = notifications.filter(({ level }) => level === "warning");
        assert.equal(getRouteState().kind, "quarantined");
        assert.equal(state.routingMutationCallCount, 1);
        assert.equal(warnings.length, 1);
        assert.match(warnings[0].message, /automatic tab binding failed.*Run \/rp bind/u);
        assert.doesNotMatch(warnings[0].message, /Recommended:|Alternatives:|bind_context/u);
      });
    });
  }
});

test("startup keeps failed observation as intent and valid-empty inventory becomes unbound without mutation", async (t) => {
  const intentEntries = () => [{
    type: "custom",
    customType: BINDING_ENTRY_TYPE,
    data: { app: "ce", windowId: 5, workspace: "agent", tab: "TAB-INTENT" },
  }];

  await t.test("observation failure remains non-dispatchable", async () => {
    await withRoutingLifecycleHarness({
      entries: intentEntries(),
      state: {
        failInventoryOnCalls: new Set([2]),
        tabsByWindow: new Map([[5, [
          { id: "TAB-INTENT", name: "Intent", active: true, bound: false, files: 0 },
        ]]]),
      },
    }, async ({ state, entries }) => {
      assert.equal(getRouteState().kind, "intent");
      assert.equal(entries.length, 1);
      assert.equal(state.routingMutationCallCount ?? 0, 0);
    });
  });

  await t.test("valid-empty inventory proves absence", async () => {
    await withRoutingLifecycleHarness({
      entries: intentEntries(),
      state: { tabsByWindow: new Map() },
    }, async ({ state, entries }) => {
      assert.equal(getRouteState().kind, "unbound");
      assert.equal(entries.length, 1);
      assert.equal(state.routingMutationCallCount ?? 0, 0);
    });
  });
});

test("status observes verified and missing routes without bind, create, persist, or state transition", async () => {
  await withRoutingLifecycleHarness({
    state: {
      boundContextId: "TAB-LIVE",
      tabsByWindow: new Map([[5, [
        { id: "TAB-LIVE", name: "Live", active: true, bound: true, files: 0 },
      ]]]),
    },
  }, async ({ state, entries, pi, ctx }) => {
    const rpTool = pi.getTool("rp");
    const entryCount = entries.length;
    state.calls.length = 0;

    const verified = await rpTool.execute("status-verified", {}, undefined, () => {}, ctx);
    assert.equal(verified.details.routeState, "verified_tab");
    assert.deepEqual(
      state.calls.map((call) => ({ name: call.name, args: call.args })),
      [{ name: "bind_context", args: { op: "list", _rawJSON: true } }]
    );
    assert.equal(entries.length, entryCount);

    state.tabsByWindow.set(5, []);
    state.boundContextId = undefined;
    state.calls.length = 0;
    const stale = await rpTool.execute("status-stale", {}, undefined, () => {}, ctx);
    assert.equal(stale.details.routeState, "stale");
    assert.doesNotMatch(stale.content[0].text, /TAB-LIVE \[bound/u);
    assert.equal(getRouteState().kind, "verified");
    assert.equal(entries.length, entryCount);
    assert.equal(state.routingMutationCallCount ?? 0, 0);
  });
});

test("generic create_tab bind:true reconciles live inventory, sticky binding, route store, and persistence", async () => {
  await withRoutingLifecycleHarness({
    state: {
      boundContextId: "TAB-OLD",
      createdTabId: "TAB-CREATED",
      tabsByWindow: new Map([[5, [
        { id: "TAB-OLD", name: "Old", active: true, bound: true, files: 0 },
      ]]]),
    },
  }, async ({ state, entries, pi, ctx }) => {
    const rpTool = pi.getTool("rp");
    state.calls.length = 0;
    const result = await rpTool.execute(
      "create-tab",
      { call: "manage_workspaces", args: { action: "create_tab", window_id: 5, bind: true, focus: false } },
      undefined,
      () => {},
      ctx
    );

    assert.equal(result.isError, false);
    assert.deepEqual(
      state.calls.find((call) => call.name === "manage_workspaces")?.args,
      { action: "create_tab", window_id: 5, bind: true, focus: false }
    );
    assert.equal(state.boundContextId, "TAB-CREATED");
    assert.equal(getBinding()?.tab, "TAB-CREATED");
    assert.equal(
      entries.filter((entry) => entry.customType === BINDING_ENTRY_TYPE).at(-1)?.data.tab,
      "TAB-CREATED"
    );
    assert.equal(state.routingMutationCallCount, 1);
  });
});

test("clean routing isError re-observes once, returns the original failure, and never replays", async () => {
  await withRoutingLifecycleHarness({
    state: {
      boundContextId: "TAB-OLD",
      routingMutationOutcomes: ["isError"],
      tabsByWindow: new Map([[5, [
        { id: "TAB-OLD", name: "Old", active: true, bound: true, files: 0 },
        { id: "TAB-NEW", name: "New", active: false, bound: false, files: 0 },
      ]]]),
    },
  }, async ({ state, entries, pi, ctx }) => {
    const rpTool = pi.getTool("rp");
    const persistedBefore = entries.filter(
      (entry) => entry.customType === BINDING_ENTRY_TYPE
    ).length;
    state.calls.length = 0;
    const result = await rpTool.execute(
      "clean-error",
      { call: "bind_context", args: { op: "bind", context_id: "TAB-NEW" } },
      undefined,
      () => {},
      ctx
    );

    assert.equal(result.isError, true);
    assert.equal(result.details.error, "routing_mutation_failed");
    assert.deepEqual(result.details.routingReconciliation, {
      cause: "mutation_failed_route_unchanged",
      priorAuthorityPreserved: true,
      upstreamIsError: true,
    });
    assert.match(result.content[0].text, /routing mutation rejected/u);
    assert.equal(
      entries.filter((entry) => entry.customType === BINDING_ENTRY_TYPE).length,
      persistedBefore
    );
    assert.equal(state.routingMutationCallCount, 1);
    assert.equal(state.calls.filter((call) => call.name === "bind_context" && call.args.op === "list").length, 1);
    assert.equal(getRouteState().kind, "verified");
    assert.equal(getBinding()?.tab, "TAB-OLD");
  });
});

test("clean generic mutation error quarantines instead of adopting unrelated observed route B", async () => {
  await withRoutingLifecycleHarness({
    state: {
      boundContextId: "TAB-OLD",
      routingMutationOutcomes: ["isError"],
      tabsByWindow: new Map([[5, [
        { id: "TAB-OLD", name: "Old", active: true, bound: true, files: 0 },
        { id: "TAB-A", name: "Requested", active: false, bound: false, files: 0 },
        { id: "TAB-B", name: "Unrelated", active: false, bound: false, files: 0 },
      ]]]),
      beforeRoutingMutationError() {
        this.boundContextId = "TAB-B";
        for (const tab of this.tabsByWindow.get(5)) {
          tab.active = tab.id === "TAB-B";
          tab.bound = tab.id === "TAB-B";
        }
      },
    },
  }, async ({ state, entries, pi, ctx }) => {
    const persistedBefore = entries.filter(
      (entry) => entry.customType === BINDING_ENTRY_TYPE
    ).length;
    state.calls.length = 0;

    const result = await pi.getTool("rp").execute(
      "clean-error-route-changed",
      { call: "bind_context", args: { op: "bind", context_id: "TAB-A" } },
      undefined,
      () => {},
      ctx
    );

    assert.equal(result.isError, true);
    assert.equal(result.details.error, "routing_mutation_failed");
    assert.deepEqual(result.details.routingReconciliation, {
      cause: "mutation_failed_route_unproven",
      priorAuthorityPreserved: false,
      upstreamIsError: true,
    });
    assert.match(result.content[0].text, /routing mutation rejected/u);
    assert.equal(getRouteState().kind, "quarantined");
    assert.equal(getRouteSelectorDecision({}).kind, "blocked");
    assert.equal(
      entries.filter((entry) => entry.customType === BINDING_ENTRY_TYPE).length,
      persistedBefore
    );
    assert.equal(entries.some((entry) => entry.data?.tab === "TAB-B"), false);
    assert.equal(state.routingMutationCallCount, 1);
    assert.equal(state.calls.filter((call) => call.name === "bind_context" && call.args.op === "list").length, 1);
  });
});

test("thrown, timeout, and abort mutation outcomes quarantine unconditionally and leave the coordinator reusable", async (t) => {
  for (const outcome of ["throw", "timeout", "abort"]) {
    await t.test(outcome, async () => {
      await withRoutingLifecycleHarness({
        state: {
          boundContextId: "TAB-OLD",
          routingMutationOutcomes: [outcome, "success"],
          tabsByWindow: new Map([[5, [
            { id: "TAB-OLD", name: "Old", active: true, bound: true, files: 0 },
            { id: "TAB-NEW", name: "New", active: false, bound: false, files: 0 },
          ]]]),
        },
      }, async ({ state, pi, ctx }) => {
        const rpTool = pi.getTool("rp");
        const failed = await rpTool.execute(
          `mutation-${outcome}`,
          { call: "bind_context", args: { op: "bind", context_id: "TAB-NEW" } },
          undefined,
          () => {},
          ctx
        );
        assert.equal(failed.isError, true);
        assert.equal(getRouteState().kind, "quarantined");
        assert.equal(getRouteState().cause, "ambiguous_mutation_result");
        assert.equal(state.routingMutationCallCount, 1);

        const recovered = await rpTool.execute(
          `recover-${outcome}`,
          { call: "bind_context", args: { op: "bind", context_id: "TAB-NEW" } },
          undefined,
          () => {},
          ctx
        );
        assert.equal(recovered.isError, false);
        assert.equal(getRouteState().kind, "verified");
        assert.equal(getBinding()?.tab, "TAB-NEW");
        assert.equal(state.routingMutationCallCount, 2);
      });
    });
  }
});

test("failed post-mutation observation quarantines, annotates the result, blocks ordinary dispatch, and does not replay", async () => {
  await withRoutingLifecycleHarness({
    state: {
      boundContextId: "TAB-OLD",
      forwardedTools: new Set(["read_file"]),
      toolsByCommand: new Map([["fake-rp", [
        { name: "bind_context", description: "" },
        { name: "manage_workspaces", description: "" },
        { name: "read_file", description: "" },
      ]]]),
      tabsByWindow: new Map([[5, [
        { id: "TAB-OLD", name: "Old", active: true, bound: true, files: 0 },
        { id: "TAB-NEW", name: "New", active: false, bound: false, files: 0 },
      ]]]),
    },
  }, async ({ state, pi, ctx }) => {
    const rpTool = pi.getTool("rp");
    state.failNextInventoryCount = 1;
    const result = await rpTool.execute(
      "post-observation-failure",
      { call: "bind_context", args: { op: "bind", context_id: "TAB-NEW" } },
      undefined,
      () => {},
      ctx
    );

    assert.equal(result.isError, true);
    assert.equal(result.details.error, "routing_reconciliation_failed");
    assert.deepEqual(result.details.routingReconciliation, {
      cause: "post_mutation_observation_failed",
      possiblePartialSuccess: true,
      upstreamIsError: false,
    });
    assert.match(result.content.at(-1).text, /routing state was quarantined/u);
    assert.equal(getRouteState().kind, "quarantined");
    assert.equal(getRouteState().cause, "post_mutation_observation_failed");
    assert.equal(state.routingMutationCallCount, 1);

    const callsBeforeBlockedRead = state.calls.length;
    const blocked = await rpTool.execute(
      "blocked-read",
      { call: "read_file", args: { path: "src/index.ts" } },
      undefined,
      () => {},
      ctx
    );
    assert.equal(blocked.isError, true);
    assert.equal(state.calls.length, callsBeforeBlockedRead);
  });
});

test("failed ordinary route-dependent calls re-observe disappearance and sticky conflicts without replay", async (t) => {
  for (const failureKind of ["disappearance", "conflict"]) {
    await t.test(failureKind, async () => {
      await withRoutingLifecycleHarness({
        state: {
          boundContextId: "TAB-OLD",
          failNextForwardedCallCount: 1,
          forwardedTools: new Set(["read_file"]),
          toolsByCommand: new Map([["fake-rp", [
            { name: "bind_context", description: "" },
            { name: "manage_workspaces", description: "" },
            { name: "read_file", description: "" },
          ]]]),
          tabsByWindow: new Map([[5, [
            { id: "TAB-OLD", name: "Old", active: true, bound: true, files: 0 },
            { id: "TAB-NEW", name: "New", active: false, bound: false, files: 0 },
          ]]]),
          beforeForwardedFailure() {
            if (failureKind === "disappearance") {
              this.tabsByWindow.set(5, this.tabsByWindow.get(5).filter((tab) => tab.id !== "TAB-OLD"));
              this.boundContextId = undefined;
              return;
            }
            this.boundContextId = "TAB-NEW";
            for (const tab of this.tabsByWindow.get(5)) {
              tab.bound = tab.id === "TAB-NEW";
            }
          },
        },
      }, async ({ state, pi, ctx }) => {
        const rpTool = pi.getTool("rp");
        const failed = await rpTool.execute(
          `ordinary-${failureKind}`,
          { call: "read_file", args: { path: "src/index.ts" } },
          undefined,
          () => {},
          ctx
        );
        assert.equal(failed.isError, true);
        assert.match(failed.content[0].text, /Failed read_file/u);
        assert.equal(getRouteState().kind, "quarantined");
        assert.equal(
          getRouteState().cause,
          failureKind === "disappearance" ? "route_disappeared" : "route_conflict"
        );
        assert.equal(state.calls.filter((call) => call.name === "read_file").length, 1);

        const callsBeforeSecond = state.calls.length;
        const blocked = await rpTool.execute(
          `ordinary-${failureKind}-blocked`,
          { call: "read_file", args: { path: "src/index.ts" } },
          undefined,
          () => {},
          ctx
        );
        assert.equal(blocked.isError, true);
        assert.equal(state.calls.length, callsBeforeSecond);
      });
    });
  }
});

test("route-independent calls are selector-free and ordinary caller selectors must match atomically", async () => {
  await withRoutingLifecycleHarness({
    state: {
      boundContextId: "TAB-LIVE",
      forwardedTools: new Set(["agent_run", "read_file", "future_tool"]),
      toolsByCommand: new Map([["fake-rp", [
        { name: "bind_context", description: "" },
        { name: "manage_workspaces", description: "" },
        { name: "agent_run", description: "" },
        { name: "read_file", description: "" },
        { name: "future_tool", description: "" },
      ]]]),
      tabsByWindow: new Map([[5, [
        { id: "TAB-LIVE", name: "Live", active: true, bound: true, files: 0 },
      ]]]),
    },
  }, async ({ state, pi, ctx }) => {
    const rpTool = pi.getTool("rp");
    await rpTool.execute(
      "global-poll",
      {
        call: "agent_run",
        args: { op: "poll", session_id: "SESSION", _windowID: 99, context_id: "OTHER" },
      },
      undefined,
      () => {},
      ctx
    );
    assert.deepEqual(state.calls.filter((call) => call.name === "agent_run").at(-1)?.args, {
      op: "poll",
      session_id: "SESSION",
    });

    const readsBeforeConflict = state.calls.filter((call) => call.name === "read_file").length;
    const conflict = await rpTool.execute(
      "partial-selector",
      { call: "read_file", args: { path: "src/index.ts", context_id: "TAB-LIVE" } },
      undefined,
      () => {},
      ctx
    );
    assert.equal(conflict.isError, true);
    assert.equal(conflict.details.error, "conflict");
    assert.equal(state.calls.filter((call) => call.name === "read_file").length, readsBeforeConflict);

    await rpTool.execute(
      "matching-selector",
      {
        call: "read_file",
        args: { path: "src/index.ts", _windowID: 5, context_id: "TAB-LIVE" },
      },
      undefined,
      () => {},
      ctx
    );
    assert.deepEqual(state.calls.filter((call) => call.name === "read_file").at(-1)?.args, {
      path: "src/index.ts",
      _windowID: 5,
      context_id: "TAB-LIVE",
    });

    await rpTool.execute(
      "unknown-verified",
      { call: "future_tool", args: { value: 1 } },
      undefined,
      () => {},
      ctx
    );
    assert.deepEqual(state.calls.filter((call) => call.name === "future_tool").at(-1)?.args, {
      value: 1,
      _windowID: 5,
      context_id: "TAB-LIVE",
    });

    clearBinding();
    const futureCallsBefore = state.calls.filter((call) => call.name === "future_tool").length;
    const blockedUnknown = await rpTool.execute(
      "unknown-unbound",
      { call: "future_tool", args: { value: 1 } },
      undefined,
      () => {},
      ctx
    );
    assert.equal(blockedUnknown.isError, true);
    assert.equal(state.calls.filter((call) => call.name === "future_tool").length, futureCallsBefore);
  });
});

test("app switch adopts the target connection sticky tab before ordinary forwarding", async () => {
  await withRoutingLifecycleHarness({
    config: {
      activeApp: "ce",
      apps: {
        ce: { command: "ce-mcp", args: [] },
        classic: { command: "classic-mcp", args: [] },
      },
    },
    state: {
      boundContextId: "TAB-LIVE",
      toolsByCommand: new Map([
        ["ce-mcp", [
          { name: "bind_context", description: "" },
          { name: "manage_workspaces", description: "" },
        ]],
        ["classic-mcp", [
          { name: "bind_context", description: "" },
          { name: "manage_workspaces", description: "" },
        ]],
      ]),
      tabsByWindow: new Map([[5, [
        { id: "TAB-LIVE", name: "Live", active: true, bound: true, files: 0 },
      ]]]),
    },
  }, async ({ state, entries, pi, ctx }) => {
    const command = pi.getCommand("rp");
    state.calls.length = 0;
    await command.handler("app classic", ctx);

    assert.equal(getRouteState().kind, "verified");
    assert.equal(getBinding()?.app, "classic");
    assert.equal(getBinding()?.tab, "TAB-LIVE");
    assert.equal(
      entries.filter((entry) => entry.customType === BINDING_ENTRY_TYPE).at(-1)?.data.app,
      "classic"
    );
    assert.equal(state.routingMutationCallCount ?? 0, 0);
    assert.ok(state.calls.some((call) => call.name === "bind_context" && call.args.op === "list"));
  });
});

test("manage_workspaces mutation failures reconcile or quarantine without replay", async (t) => {
  await t.test("clean isError re-observes the prior verified route", async () => {
    await withRoutingLifecycleHarness({
      state: {
        boundContextId: "TAB-OLD",
        routingMutationOutcomes: ["isError"],
        tabsByWindow: new Map([[5, [
          { id: "TAB-OLD", name: "Old", active: true, bound: true, files: 0 },
        ]]]),
      },
    }, async ({ state, pi, ctx }) => {
      const result = await pi.getTool("rp").execute(
        "workspace-clean-error",
        { call: "manage_workspaces", args: { action: "create_tab", window_id: 5, bind: true } },
        undefined,
        () => {},
        ctx
      );

      assert.equal(result.isError, true);
      assert.equal(getRouteState().kind, "verified");
      assert.equal(getBinding()?.tab, "TAB-OLD");
      assert.equal(state.routingMutationCallCount, 1);
      assert.equal(state.calls.filter((call) => call.name === "manage_workspaces" && call.args.action === "create_tab").length, 1);
    });
  });

  for (const outcome of ["throw", "timeout", "abort"]) {
    await t.test(`${outcome} quarantines and permits a later explicit recovery`, async () => {
      await withRoutingLifecycleHarness({
        state: {
          boundContextId: "TAB-OLD",
          routingMutationOutcomes: [outcome, "success"],
          tabsByWindow: new Map([[5, [
            { id: "TAB-OLD", name: "Old", active: true, bound: true, files: 0 },
          ]]]),
        },
      }, async ({ state, pi, ctx }) => {
        const rpTool = pi.getTool("rp");
        const failed = await rpTool.execute(
          `workspace-${outcome}`,
          { call: "manage_workspaces", args: { action: "create_tab", window_id: 5, bind: true } },
          undefined,
          () => {},
          ctx
        );
        assert.equal(failed.isError, true);
        assert.equal(getRouteState().kind, "quarantined");
        assert.equal(getRouteState().cause, "ambiguous_mutation_result");

        const recovered = await rpTool.execute(
          `workspace-${outcome}-recover`,
          { call: "manage_workspaces", args: { action: "create_tab", window_id: 5, bind: true } },
          undefined,
          () => {},
          ctx
        );
        assert.equal(recovered.isError, false);
        assert.equal(getRouteState().kind, "verified");
        assert.equal(getBinding()?.tab, "TAB-CREATED");
        assert.equal(state.routingMutationCallCount, 2);
      });
    });
  }

  await t.test("successful mutation with failed observation quarantines", async () => {
    await withRoutingLifecycleHarness({
      state: {
        boundContextId: "TAB-OLD",
        tabsByWindow: new Map([[5, [
          { id: "TAB-OLD", name: "Old", active: true, bound: true, files: 0 },
        ]]]),
      },
    }, async ({ state, pi, ctx }) => {
      state.failNextInventoryCount = 1;
      const result = await pi.getTool("rp").execute(
        "workspace-post-observation",
        { call: "manage_workspaces", args: { action: "create_tab", window_id: 5, bind: true } },
        undefined,
        () => {},
        ctx
      );

      assert.equal(result.isError, true);
      assert.equal(result.details.error, "routing_reconciliation_failed");
      assert.match(result.content.at(-1).text, /routing state was quarantined/u);
      assert.equal(getRouteState().kind, "quarantined");
      assert.equal(getRouteState().cause, "post_mutation_observation_failed");
      assert.equal(state.routingMutationCallCount, 1);
    });
  });
});

test("failed ordinary call with failed re-observation quarantines as observation failure without replay", async () => {
  await withRoutingLifecycleHarness({
    state: {
      boundContextId: "TAB-LIVE",
      failNextForwardedCallCount: 1,
      forwardedTools: new Set(["read_file"]),
      toolsByCommand: new Map([["fake-rp", [
        { name: "bind_context", description: "" },
        { name: "manage_workspaces", description: "" },
        { name: "read_file", description: "" },
      ]]]),
      tabsByWindow: new Map([[5, [
        { id: "TAB-LIVE", name: "Live", active: true, bound: true, files: 0 },
      ]]]),
    },
  }, async ({ state, pi, ctx }) => {
    state.failNextInventoryCount = 1;
    const result = await pi.getTool("rp").execute(
      "ordinary-observation-failure",
      { call: "read_file", args: { path: "src/index.ts" } },
      undefined,
      () => {},
      ctx
    );

    assert.equal(result.isError, true);
    assert.equal(getRouteState().kind, "quarantined");
    assert.equal(getRouteState().cause, "observation_failed");
    assert.equal(state.calls.filter((call) => call.name === "read_file").length, 1);
  });
});

test("every current workspace mutation action uses the generic reconciliation failure policy", async (t) => {
  const mutationActions = MANAGE_WORKSPACES_ACTIONS.filter(
    (action) => !["list", "list_tabs"].includes(action)
  );
  const outcomes = ["success", "isError", "throw", "timeout", "abort", "post_observation"];

  for (const action of mutationActions) {
    for (const outcome of outcomes) {
      await t.test(`${action}: ${outcome}`, async () => {
        await withRoutingLifecycleHarness({
          state: {
            boundContextId: "TAB-OLD",
            routingMutationOutcomes: [outcome === "post_observation" ? "success" : outcome],
            tabsByWindow: new Map([[5, [
              { id: "TAB-OLD", name: "Old", active: true, bound: true, files: 0 },
            ]]]),
          },
        }, async ({ state, pi, ctx }) => {
          if (outcome === "post_observation") {
            state.failNextInventoryCount = 1;
          }
          const result = await pi.getTool("rp").execute(
            `workspace-${action}-${outcome}`,
            { call: "manage_workspaces", args: { action, window_id: 5, bind: true } },
            undefined,
            () => {},
            ctx
          );

          assert.equal(state.routingMutationCallCount, 1);
          assert.equal(
            state.calls.filter((call) => call.name === "manage_workspaces" && call.args.action === action).length,
            1
          );
          if (outcome === "success" || outcome === "isError") {
            assert.equal(getRouteState().kind, "verified");
          } else {
            assert.equal(getRouteState().kind, "quarantined");
            assert.equal(
              getRouteState().cause,
              outcome === "post_observation" ? "post_mutation_observation_failed" : "ambiguous_mutation_result"
            );
          }
          assert.equal(result.isError, outcome !== "success");
        });
      });
    }
  }
});

test("every route-changing manage_worktree operation uses generic reconciliation without selectors or replay", async (t) => {
  const mutationOperations = MANAGE_WORKTREE_OPERATIONS.filter((operation) => {
    const classification = classifyForwardingOperation("manage_worktree", operation);
    return classification.kind === "classified"
      && classification.forwardingClass === "workspace_routing_mutation";
  });
  assert.deepEqual(mutationOperations, ["create", "bind", "select", "unbind"]);
  const outcomes = ["success", "isError", "throw", "timeout", "abort", "post_observation"];
  const toolsByCommand = new Map([["fake-rp", [
    { name: "bind_context", description: "" },
    { name: "manage_workspaces", description: "" },
    { name: "manage_worktree", description: "" },
  ]]]);
  const argsForOperation = (operation) => {
    switch (operation) {
      case "create":
        return { op: operation, branch: "test-branch", bind: true, session_id: "SESSION-1" };
      case "bind":
      case "select":
        return { op: operation, worktree_id: "WT-1", session_id: "SESSION-1" };
      case "unbind":
        return { op: operation, session_id: "SESSION-1", all: true };
      default:
        throw new Error(`Unexpected manage_worktree mutation operation: ${operation}`);
    }
  };

  for (const operation of mutationOperations) {
    for (const outcome of outcomes) {
      await t.test(`${operation}: ${outcome}`, async () => {
        await withRoutingLifecycleHarness({
          state: {
            boundContextId: "TAB-OLD",
            routingMutationOutcomes: [outcome === "post_observation" ? "success" : outcome],
            toolsByCommand,
            tabsByWindow: new Map([[5, [
              { id: "TAB-OLD", name: "Old", active: true, bound: true, files: 0 },
            ]]]),
          },
        }, async ({ state, entries, pi, ctx }) => {
          if (outcome === "post_observation") {
            state.failNextInventoryCount = 1;
          }
          state.calls.length = 0;
          const operationArgs = argsForOperation(operation);
          const result = await pi.getTool("rp").execute(
            `worktree-${operation}-${outcome}`,
            { call: "manage_worktree", args: operationArgs },
            undefined,
            () => {},
            ctx
          );

          assert.equal(state.routingMutationCallCount, 1);
          const mutationCalls = state.calls.filter(
            (call) => call.name === "manage_worktree" && call.args.op === operation
          );
          assert.equal(mutationCalls.length, 1);
          assert.deepEqual(mutationCalls[0].args, operationArgs);
          assert.equal(Object.hasOwn(mutationCalls[0].args, "_windowID"), false);
          assert.equal(Object.hasOwn(mutationCalls[0].args, "context_id"), false);

          if (outcome === "success" || outcome === "isError") {
            assert.equal(getRouteState().kind, "verified");
            assert.equal(getBinding()?.tab, "TAB-OLD");
            assert.equal(state.boundContextId, "TAB-OLD");
            assert.equal(
              entries.filter((entry) => entry.customType === BINDING_ENTRY_TYPE).at(-1)?.data.tab,
              "TAB-OLD"
            );
            assert.equal(
              state.calls.filter((call) => call.name === "bind_context" && call.args.op === "list").length,
              1
            );
          } else {
            assert.equal(getRouteState().kind, "quarantined");
            assert.equal(
              getRouteState().cause,
              outcome === "post_observation" ? "post_mutation_observation_failed" : "ambiguous_mutation_result"
            );
          }
          assert.equal(result.isError, outcome !== "success");
        });
      });
    }
  }
});

test("unknown routing actions are rejected locally without an upstream call", async () => {
  await withRoutingLifecycleHarness({
    state: {
      boundContextId: "TAB-LIVE",
      tabsByWindow: new Map([[5, [
        { id: "TAB-LIVE", name: "Live", active: true, bound: true, files: 0 },
      ]]]),
    },
  }, async ({ state, pi, ctx }) => {
    const callsBefore = state.calls.length;
    const result = await pi.getTool("rp").execute(
      "unknown-routing-action",
      { call: "manage_workspaces", args: { action: "future_action" } },
      undefined,
      () => {},
      ctx
    );

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /update the routing classification first/u);
    assert.equal(result.details.tool, "manage_workspaces");
    assert.equal(state.calls.length, callsBefore);

    for (const operation of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      const prototypeResult = await pi.getTool("rp").execute(
        `prototype-${operation}`,
        { call: "manage_workspaces", args: { action: operation } },
        undefined,
        () => {},
        ctx
      );
      assert.equal(prototypeResult.isError, true);
      assert.match(prototypeResult.content[0].text, /update the routing classification first/u);
      assert.equal(state.calls.length, callsBefore);
    }
  });
});

test("background starts cannot recover intent or quarantine implicitly", async (t) => {
  const tools = new Map([["fake-rp", [
    { name: "bind_context", description: "" },
    { name: "manage_workspaces", description: "" },
    { name: "context_builder", description: "" },
  ]]]);

  await t.test("intent", async () => {
    await withRoutingLifecycleHarness({
      entries: [{
        type: "custom",
        customType: BINDING_ENTRY_TYPE,
        data: { app: "ce", windowId: 5, workspace: "agent", tab: "TAB-INTENT" },
      }],
      state: {
        failInventoryOnCalls: new Set([2]),
        toolsByCommand: tools,
        tabsByWindow: new Map([[5, [
          { id: "TAB-INTENT", name: "Intent", active: true, bound: false, files: 0 },
        ]]]),
      },
    }, async ({ state, pi, ctx }) => {
      const callsBefore = state.calls.length;
      await assert.rejects(
        pi.getTool("rp").execute(
          "background-intent",
          { call: "context_builder", args: { instructions: "must not start" } },
          undefined,
          () => {},
          ctx
        ),
        /missing_tab_binding/u
      );
      assert.equal(getRouteState().kind, "intent");
      assert.equal(state.calls.length, callsBefore);
      assert.equal(state.routingMutationCallCount ?? 0, 0);
    });
  });

  await t.test("quarantine", async () => {
    await withRoutingLifecycleHarness({
      state: {
        boundContextId: "TAB-LIVE",
        toolsByCommand: tools,
        tabsByWindow: new Map([[5, [
          { id: "TAB-LIVE", name: "Live", active: true, bound: true, files: 0 },
        ]]]),
      },
    }, async ({ state, pi, ctx }) => {
      quarantineRoute("ambiguous_mutation_result", "uncertain route");
      const callsBefore = state.calls.length;
      await assert.rejects(
        pi.getTool("rp").execute(
          "background-quarantine",
          { call: "context_builder", args: { instructions: "must not start" } },
          undefined,
          () => {},
          ctx
        ),
        /missing_tab_binding/u
      );
      assert.equal(getRouteState().kind, "quarantined");
      assert.equal(state.calls.length, callsBefore);
    });
  });
});

test("background starts validate caller selectors before stripping transport selectors", async (t) => {
  for (const toolName of ["context_builder", "oracle_send"]) {
    for (const selectorCase of [
      { name: "mismatch", selectors: { _windowID: 9, context_id: "TAB-OTHER" } },
      { name: "partial", selectors: { context_id: "TAB-LIVE" } },
    ]) {
      await t.test(`${toolName} ${selectorCase.name}`, async () => {
        await withRoutingLifecycleHarness({
          state: {
            boundContextId: "TAB-LIVE",
            forwardedTools: new Set([toolName]),
            toolsByCommand: new Map([["fake-rp", [
              { name: "bind_context", description: "" },
              { name: "manage_workspaces", description: "" },
              toolName === "context_builder"
                ? {
                    name: "context_builder",
                    description: "Build context",
                    inputSchema: { type: "object", properties: { instructions: { type: "string" } } },
                  }
                : fixtureToolByName(ceCatalog, toolName),
            ]]]),
            tabsByWindow: new Map([[5, [
              { id: "TAB-LIVE", name: "Live", active: true, bound: true, files: 0 },
            ]]]),
          },
        }, async ({ state, pi, ctx }) => {
          state.calls.length = 0;
          const result = await pi.getTool("rp").execute(
            `${toolName}-${selectorCase.name}`,
            {
              call: toolName,
              args: {
                ...(toolName === "context_builder"
                  ? { instructions: "must not start" }
                  : { message: "must not start" }),
                ...selectorCase.selectors,
              },
            },
            undefined,
            () => {},
            ctx
          );

          assert.equal(result.isError, true);
          assert.equal(result.details.error, "conflict");
          assert.match(result.content[0].text, /selector|context_id|_windowID/u);
          assert.equal(state.calls.some((call) => call.name === toolName), false);
          assert.equal(result.details.contextBuilderJob, undefined);
          assert.equal(result.details.oracleSendJob, undefined);
        });
      });
    }
  }
});

test("reconnect cancellation prevents deferred obsolete recovery from publishing stale intent", async () => {
  const entered = deferred();
  const release = deferred();
  const blocker = { entered, release, rejectOnAbort: true, signal: undefined };
  await withRoutingLifecycleHarness({
    skipSessionStart: true,
    hasUI: true,
    config: { autoBindOnStart: true },
    state: {
      connects: [],
      blockInventoryOnCalls: new Map([[3, blocker]]),
      tabsByWindow: new Map([[5, [
        {
          id: "TAB-OLD",
          name: "Old",
          active: true,
          bound: false,
          files: 0,
          repoPaths: [process.cwd()],
        },
      ]]]),
    },
  }, async ({ state, entries, pi, ctx }) => {
    const startup = pi.emit("session_start", ctx, { reason: "startup" });
    await entered.promise;

    state.tabsByWindow.set(5, [{
      id: "TAB-NEW",
      name: "New",
      active: true,
      bound: true,
      files: 0,
      repoPaths: [process.cwd()],
    }]);
    state.boundContextId = "TAB-NEW";
    const reconnect = pi.getCommand("rp").handler("reconnect", ctx);
    await drainLifecycle();
    release.resolve();
    await Promise.allSettled([startup, reconnect]);
    await drainLifecycle();

    assert.ok(blocker.signal, "obsolete auto-detection inventory must receive the lifecycle signal");
    assert.equal(blocker.signal.aborted, true);
    assert.equal(getRouteState().kind, "verified");
    assert.equal(getBinding()?.tab, "TAB-NEW");
    assert.equal(
      entries.filter((entry) => entry.customType === BINDING_ENTRY_TYPE).at(-1)?.data.tab,
      "TAB-NEW"
    );
  });
});

test("lazy routing observations and explicit slash binds connect without recovering prior intent", async (t) => {
  const intentEntries = () => [{
    type: "custom",
    customType: BINDING_ENTRY_TYPE,
    data: { app: "ce", windowId: 5, workspace: "chat-tree", tab: "TAB-OLD" },
  }];
  const lazyState = () => ({
    tabsByWindow: new Map([[5, [
      { id: "TAB-OLD", name: "Old", active: true, bound: false, files: 0 },
    ]]]),
  });

  await t.test("bind_context list", async () => {
    await withRoutingLifecycleHarness({
      skipSessionStart: true,
      entries: intentEntries(),
      state: lazyState(),
    }, async ({ state, pi, ctx }) => {
      const result = await pi.getTool("rp").execute(
        "lazy-list",
        { call: "bind_context", args: { op: "list" } },
        undefined,
        () => {},
        ctx
      );

      assert.equal(result.isError, false);
      assert.equal(state.routingMutationCallCount ?? 0, 0);
      assert.equal(
        state.calls.some((call) => call.name === "bind_context" && call.args.op === "bind"),
        false
      );
      assert.equal(
        state.calls.some((call) => call.name === "manage_workspaces" && call.args.action === "create_tab"),
        false
      );
    });
  });

  await t.test("/rp bind", async () => {
    await withRoutingLifecycleHarness({
      skipSessionStart: true,
      entries: intentEntries(),
      state: lazyState(),
    }, async ({ state, pi, ctx }) => {
      await pi.getCommand("rp").handler("bind 5", ctx);

      const firstMutationIndex = state.calls.findIndex(
        (call) => (call.name === "bind_context" && call.args.op === "bind")
          || (call.name === "manage_workspaces" && call.args.action === "create_tab")
      );
      const observationsBeforeMutation = state.calls
        .slice(0, firstMutationIndex)
        .filter((call) => call.name === "bind_context" && call.args.op === "list");
      assert.equal(state.routingMutationCallCount, 1);
      assert.ok(observationsBeforeMutation.length >= 2);
      assert.equal(getRouteState().kind, "verified");
    });
  });
});

test("explicit binds adopt target branch selection without mutating the previously bound tab", async (t) => {
  const bindCases = [
    {
      name: "slash bind",
      invoke: async ({ pi, ctx }) => {
        await pi.getCommand("rp").handler("bind 5 TAB-NEW", ctx);
      },
    },
    {
      name: "tool bind",
      invoke: async ({ pi, ctx }) => {
        const result = await pi.getTool("rp").execute(
          "bind-new-tab",
          { bind: { window: 5, tab: "TAB-NEW" } },
          undefined,
          () => {},
          ctx
        );
        assert.notEqual(result.isError, true);
      },
    },
  ];

  for (const bindCase of bindCases) {
    await t.test(bindCase.name, async () => {
      const entries = [
        {
          type: "custom",
          customType: BINDING_ENTRY_TYPE,
          data: { app: "ce", windowId: 5, workspace: "chat-tree", tab: "TAB-OLD" },
        },
        {
          type: "custom",
          customType: AUTO_SELECTION_ENTRY_TYPE,
          data: {
            app: "ce",
            windowId: 5,
            workspace: "chat-tree",
            tab: "TAB-OLD",
            fullPaths: ["src/Old.tsx"],
            slicePaths: [],
          },
        },
      ];

      await withRoutingLifecycleHarness({
        entries,
        config: { autoSelectReadSlices: true },
        state: {
          boundContextId: "TAB-OLD",
          enforceStickyContextBinding: true,
          tabsByWindow: new Map([[5, [
            { id: "TAB-OLD", name: "Old", active: true, bound: true, files: 1 },
            { id: "TAB-NEW", name: "New", active: false, bound: false, files: 0 },
          ]]]),
          liveSelectionByTab: new Map([
            ["TAB-OLD", new Set(["src/Old.tsx"])],
            ["TAB-NEW", new Set()],
          ]),
        },
      }, async ({ state, pi, ctx }) => {
        state.calls.length = 0;

        await bindCase.invoke({ pi, ctx });

        assert.equal(getBinding()?.tab, "TAB-NEW");
        assert.deepEqual(sortedSelection(state, "TAB-OLD"), ["src/Old.tsx"]);
        assert.deepEqual(sortedSelection(state, "TAB-NEW"), []);
        assert.deepEqual(state.calls.filter((call) => call.name === "manage_selection"), []);
      });
    });
  }
});

test("explicit bind adopts target state after an in-flight old-route auto-selection update", async () => {
  const selectionGetEntered = deferred();
  const releaseSelectionGet = deferred();
  const entries = [
    {
      type: "custom",
      customType: BINDING_ENTRY_TYPE,
      data: { app: "ce", windowId: 5, workspace: "chat-tree", tab: "TAB-OLD" },
    },
    {
      type: "custom",
      customType: AUTO_SELECTION_ENTRY_TYPE,
      data: {
        app: "ce",
        windowId: 5,
        workspace: "chat-tree",
        tab: "TAB-OLD",
        fullPaths: ["src/leased.ts"],
        slicePaths: [],
      },
    },
    {
      type: "custom",
      customType: AUTO_SELECTION_ENTRY_TYPE,
      data: {
        app: "ce",
        windowId: 5,
        workspace: "chat-tree",
        tab: "TAB-NEW",
        fullPaths: ["src/target.ts"],
        slicePaths: [],
      },
    },
  ];

  await withRoutingLifecycleHarness({
    entries,
    config: { autoSelectReadSlices: true },
    state: {
      boundContextId: "TAB-OLD",
      enforceStickyContextBinding: true,
      forwardedTools: new Set(["read_file"]),
      toolsByCommand: new Map([["fake-rp", [
        { name: "bind_context", description: "" },
        { name: "manage_workspaces", description: "" },
        { name: "manage_selection", description: "" },
        { name: "read_file", description: "" },
      ]]]),
      tabsByWindow: new Map([[5, [
        { id: "TAB-OLD", name: "Old", active: true, bound: true, files: 1 },
        { id: "TAB-NEW", name: "New", active: false, bound: false, files: 1 },
      ]]]),
      liveSelectionByTab: new Map([
        ["TAB-OLD", new Set(["src/leased.ts"])],
        ["TAB-NEW", new Set(["src/target.ts"])],
      ]),
    },
  }, async ({ state, pi, ctx, tempRoot }) => {
    mkdirSync(path.join(tempRoot, "src"), { recursive: true });
    writeFileSync(path.join(tempRoot, "src", "leased.ts"), "export const leased = true\n");
    for (const tab of state.tabsByWindow.get(5)) {
      tab.repoPaths = [tempRoot];
    }
    state.calls.length = 0;
    state.blockNextSelectionGet = {
      entered: selectionGetEntered,
      release: releaseSelectionGet,
    };

    const read = pi.getTool("rp").execute(
      "old-route-read",
      { call: "read_file", args: { path: "src/leased.ts" } },
      undefined,
      () => {},
      ctx
    );
    await selectionGetEntered.promise;

    const bind = pi.getTool("rp").execute(
      "bind-target",
      { bind: { window: 5, tab: "TAB-NEW" } },
      undefined,
      () => {},
      ctx
    );
    while (state.boundContextId !== "TAB-NEW") {
      await new Promise((resolve) => setImmediate(resolve));
    }

    releaseSelectionGet.resolve();
    const [readResult, bindResult] = await Promise.all([read, bind]);

    assert.notEqual(readResult.isError, true);
    assert.notEqual(bindResult.isError, true);
    assert.equal(getBinding()?.tab, "TAB-NEW");

    await pi.emit("session_shutdown", ctx, {});
    const pendingState = await getPendingTransitionStateSnapshot();
    assert.equal(pendingState?.sourceState?.tab, "TAB-NEW");
    assert.deepEqual(pendingState?.sourceState?.fullPaths, ["src/target.ts"]);
  });
});

test("tool bind preserves its catalog revision through inventory before mutation dispatch", async () => {
  await withRoutingLifecycleHarness({
    state: {
      boundContextId: "TAB-LIVE",
      tabsByWindow: new Map([[5, [
        { id: "TAB-LIVE", name: "Live", active: true, bound: true, files: 0 },
        { id: "TAB-A", name: "Requested", active: false, bound: false, files: 0 },
      ]]]),
    },
  }, async ({ state, pi, ctx }) => {
    state.calls.length = 0;
    state.beforeInventoryResponse = () => {
      state.beforeInventoryResponse = undefined;
      const incompatibleTools = structuredClone(state.currentClient.tools);
      delete incompatibleTools.find(
        (tool) => tool.name === "bind_context"
      ).inputSchema.properties.context_id;
      state.publishTools(incompatibleTools);
    };

    const result = await pi.getTool("rp").execute(
      "catalog-changed-tool-bind",
      { bind: { window: 5, tab: "TAB-A" } },
      undefined,
      () => {},
      ctx
    );

    assert.equal(result.isError, true);
    assert.equal(result.details.error, "catalog_changed");
    assert.equal(
      state.calls.some((call) => call.name === "bind_context" && call.args.op === "bind"),
      false
    );
    assert.equal(getRouteState().kind, "verified");
    assert.equal(getBinding()?.tab, "TAB-LIVE");
  });
});

test("generic bind success quarantines when observation does not confirm the requested context", async () => {
  await withRoutingLifecycleHarness({
    state: {
      boundContextId: "TAB-OLD",
      bindContextObservedId: "TAB-OLD",
      tabsByWindow: new Map([[5, [
        { id: "TAB-OLD", name: "Old", active: true, bound: true, files: 0 },
        { id: "TAB-NEW", name: "New", active: false, bound: false, files: 0 },
      ]]]),
    },
  }, async ({ state, pi, ctx }) => {
    state.calls.length = 0;
    const result = await pi.getTool("rp").execute(
      "mismatched-bind",
      { call: "bind_context", args: { op: "bind", context_id: "TAB-NEW" } },
      undefined,
      () => {},
      ctx
    );

    assert.equal(result.isError, true);
    assert.equal(result.details.error, "routing_reconciliation_failed");
    assert.deepEqual(result.details.routingReconciliation, {
      cause: "post_mutation_observation_failed",
      possiblePartialSuccess: true,
      upstreamIsError: false,
    });
    assert.match(result.content[0].text, /Bound context `TAB-NEW`/u);
    assert.match(result.content.at(-1).text, /bound context TAB-NEW/u);
    assert.equal(getRouteState().kind, "quarantined");
    assert.equal(state.routingMutationCallCount, 1);
    assert.equal(state.calls.filter((call) => call.args.op === "bind").length, 1);
    assert.equal(state.calls.filter((call) => call.args.op === "list").length, 1);
  });
});

test("generic mutation success reports superseded without changing a newer route", async () => {
  await withRoutingLifecycleHarness({
    state: {
      boundContextId: "TAB-OLD",
      tabsByWindow: new Map([[5, [
        { id: "TAB-OLD", name: "Old", active: true, bound: true, files: 0 },
        { id: "TAB-A", name: "Requested", active: false, bound: false, files: 0 },
        { id: "TAB-NEWER", name: "Newer", active: false, bound: false, files: 0 },
      ]]]),
    },
  }, async ({ state, entries, pi, ctx, config }) => {
    state.calls.length = 0;
    const entered = deferred();
    const release = deferred();
    state.blockNextInventory = { entered, release };
    const pending = pi.getTool("rp").execute(
      "superseded-bind",
      { call: "bind_context", args: { op: "bind", context_id: "TAB-A" } },
      undefined,
      () => {},
      ctx
    );
    await entered.promise;

    persistBinding(pi, {
      app: "ce",
      windowId: 5,
      workspace: "chat-tree",
      tab: "TAB-NEWER",
    }, config);
    state.boundContextId = "TAB-NEWER";
    for (const tab of state.tabsByWindow.get(5)) {
      tab.active = tab.id === "TAB-NEWER";
      tab.bound = tab.id === "TAB-NEWER";
    }
    const persistedBeforeCompletion = entries.length;
    release.resolve();

    const result = await pending;

    assert.equal(result.isError, true);
    assert.equal(result.details.error, "routing_mutation_superseded");
    assert.deepEqual(result.details.routingReconciliation, {
      cause: "superseded",
      possiblePartialSuccess: true,
      upstreamIsError: false,
    });
    assert.equal(entries.length, persistedBeforeCompletion);
    assert.equal(getRouteState().kind, "verified");
    assert.equal(getBinding()?.tab, "TAB-NEWER");
    assert.equal(state.calls.filter((call) => call.args.op === "bind").length, 1);
  });
});

test("successful window-only mutation returns upstream success and publishes non-dispatchable intent", async () => {
  await withRoutingLifecycleHarness({
    state: {
      boundContextId: "TAB-LIVE",
      tabsByWindow: new Map([[5, [
        { id: "TAB-LIVE", name: "Live", active: true, bound: true, files: 0 },
      ]]]),
      beforeRoutingMutationSuccess() {
        this.boundContextId = undefined;
        this.windowBoundId = 5;
        for (const tab of this.tabsByWindow.get(5)) {
          tab.active = false;
          tab.bound = false;
        }
      },
    },
  }, async ({ state, entries, pi, ctx }) => {
    state.calls.length = 0;
    const result = await pi.getTool("rp").execute(
      "window-only-switch",
      { call: "manage_workspaces", args: { action: "switch", window_id: 5 } },
      undefined,
      () => {},
      ctx
    );

    assert.equal(result.isError, false);
    assert.match(result.content[0].text, /Completed manage_workspaces switch/u);
    assert.equal(getRouteState().kind, "intent");
    assert.equal(getBinding()?.windowId, 5);
    assert.equal(getBinding()?.tab, undefined);
    assert.equal(getRouteSelectorDecision({}).kind, "blocked");
    assert.equal(entries.at(-1).customType, BINDING_ENTRY_TYPE);
    assert.equal(entries.at(-1).data.windowId, 5);
    assert.equal(entries.at(-1).data.tab, undefined);
    assert.equal(state.calls.filter((call) => call.name === "manage_workspaces").length, 1);
  });
});

test("read completion after a route change cannot update the replacement route", async () => {
  const readResult = deferred();
  await withRoutingLifecycleHarness({
    config: { autoSelectReadSlices: true },
    state: {
      boundContextId: "TAB-OLD",
      forwardedDeferred: new Map([["read_file", readResult]]),
      forwardedTools: new Set(["read_file"]),
      toolsByCommand: new Map([["fake-rp", [
        { name: "bind_context", description: "" },
        { name: "manage_workspaces", description: "" },
        { name: "manage_selection", description: "" },
        { name: "read_file", description: "" },
      ]]]),
      tabsByWindow: new Map([[5, [
        { id: "TAB-OLD", name: "Old", active: true, bound: true, files: 0 },
        { id: "TAB-NEW", name: "New", active: false, bound: false, files: 0 },
      ]]]),
    },
  }, async ({ state, entries, pi, ctx, config, tempRoot }) => {
    mkdirSync(path.join(tempRoot, "src"), { recursive: true });
    writeFileSync(path.join(tempRoot, "src", "leased.ts"), "export const leased = true\n");
    for (const tab of state.tabsByWindow.get(5)) {
      tab.repoPaths = [tempRoot];
    }
    state.calls.length = 0;
    const autoSelectionCount = entries.filter(
      (entry) => entry.customType === AUTO_SELECTION_ENTRY_TYPE
    ).length;

    const read = pi.getTool("rp").execute(
      "leased-read",
      { call: "read_file", args: { path: "src/leased.ts" } },
      undefined,
      () => {},
      ctx
    );
    while (!state.calls.some((call) => call.name === "read_file")) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    persistBinding(pi, {
      app: "ce",
      windowId: 5,
      workspace: "chat-tree",
      tab: "TAB-NEW",
    }, config);
    readResult.resolve(makeTextResult("## File Read ✅\n- **Path**: `src/leased.ts`"));
    await read;

    assert.equal(getBinding()?.tab, "TAB-NEW");
    assert.equal(
      entries.filter((entry) => entry.customType === AUTO_SELECTION_ENTRY_TYPE).length,
      autoSelectionCount
    );
    assert.equal(state.calls.some((call) => call.name === "manage_selection"), false);
  });
});

test("a stale ordinary failure cannot quarantine a newer published route", async () => {
  const readResult = deferred();
  await withRoutingLifecycleHarness({
    state: {
      boundContextId: "TAB-OLD",
      forwardedDeferred: new Map([["read_file", readResult]]),
      forwardedTools: new Set(["read_file"]),
      toolsByCommand: new Map([["fake-rp", [
        { name: "bind_context", description: "" },
        { name: "manage_workspaces", description: "" },
        { name: "read_file", description: "" },
      ]]]),
      tabsByWindow: new Map([[5, [
        { id: "TAB-OLD", name: "Old", active: true, bound: true, files: 0 },
        { id: "TAB-NEW", name: "New", active: false, bound: false, files: 0 },
      ]]]),
    },
  }, async ({ state, pi, ctx, config }) => {
    state.calls.length = 0;
    const read = pi.getTool("rp").execute(
      "stale-failure",
      { call: "read_file", args: { path: "src/index.ts" } },
      undefined,
      () => {},
      ctx
    );
    while (!state.calls.some((call) => call.name === "read_file")) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    persistBinding(pi, {
      app: "ce",
      windowId: 5,
      workspace: "chat-tree",
      tab: "TAB-NEW",
    }, config);
    state.boundContextId = "TAB-NEW";
    for (const tab of state.tabsByWindow.get(5)) {
      tab.bound = tab.id === "TAB-NEW";
    }
    readResult.resolve({
      isError: true,
      content: [{ type: "text", text: "stale read failed" }],
    });
    await read;

    assert.equal(getRouteState().kind, "verified");
    assert.equal(getBinding()?.tab, "TAB-NEW");
    assert.equal(state.calls.filter((call) => call.name === "read_file").length, 1);
  });
});

test("slash Oracle dispatch retains its issued lease across a later route publication", async () => {
  const oracleResult = deferred();
  await withRoutingLifecycleHarness({
    state: {
      boundContextId: "TAB-OLD",
      forwardedDeferred: new Map([["oracle_send", oracleResult]]),
      forwardedTools: new Set(["oracle_send"]),
      toolsByCommand: new Map([["fake-rp", [
        { name: "bind_context", description: "" },
        { name: "manage_workspaces", description: "" },
        fixtureToolByName(ceCatalog, "oracle_send"),
      ]]]),
      tabsByWindow: new Map([[5, [
        { id: "TAB-OLD", name: "Old", active: true, bound: true, files: 0 },
        { id: "TAB-NEW", name: "New", active: false, bound: false, files: 0 },
      ]]]),
    },
  }, async ({ state, pi, ctx, config }) => {
    state.calls.length = 0;
    const oracle = pi.getCommand("rp").handler("oracle hello", ctx);
    while (!state.calls.some((call) => call.name === "oracle_send")) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const oracleCall = state.calls.find((call) => call.name === "oracle_send");

    persistBinding(pi, {
      app: "ce",
      windowId: 5,
      workspace: "chat-tree",
      tab: "TAB-NEW",
    }, config);
    oracleResult.resolve(makeTextResult("done"));
    await oracle;

    assert.equal(oracleCall.args.context_id, "TAB-OLD");
    assert.equal(oracleCall.args._windowID, 5);
    assert.equal(getBinding()?.tab, "TAB-NEW");
  });
});

test("slash Oracle failure reconciles only while its dispatch lease owns the route", async (t) => {
  for (const obsolete of [false, true]) {
    await t.test(obsolete ? "obsolete lease" : "current lease", async () => {
      const oracleResult = deferred();
      await withRoutingLifecycleHarness({
        state: {
          boundContextId: "TAB-OLD",
          forwardedDeferred: new Map([["oracle_send", oracleResult]]),
          forwardedTools: new Set(["oracle_send"]),
          toolsByCommand: new Map([["fake-rp", [
            { name: "bind_context", description: "" },
            { name: "manage_workspaces", description: "" },
            fixtureToolByName(ceCatalog, "oracle_send"),
          ]]]),
          tabsByWindow: new Map([[5, [
            { id: "TAB-OLD", name: "Old", active: true, bound: true, files: 0 },
            { id: "TAB-NEW", name: "New", active: false, bound: false, files: 0 },
          ]]]),
        },
      }, async ({ state, pi, ctx, config }) => {
        state.calls.length = 0;
        const oracle = pi.getCommand("rp").handler("oracle fail", ctx);
        while (!state.calls.some((call) => call.name === "oracle_send")) {
          await new Promise((resolve) => setImmediate(resolve));
        }

        if (obsolete) {
          persistBinding(pi, {
            app: "ce",
            windowId: 5,
            workspace: "chat-tree",
            tab: "TAB-NEW",
          }, config);
          state.boundContextId = "TAB-NEW";
          for (const tab of state.tabsByWindow.get(5)) {
            tab.bound = tab.id === "TAB-NEW";
          }
        } else {
          state.tabsByWindow.set(5, state.tabsByWindow.get(5).filter((tab) => tab.id !== "TAB-OLD"));
          state.boundContextId = undefined;
        }
        oracleResult.resolve({
          isError: true,
          content: [{ type: "text", text: "Oracle failed" }],
        });
        await oracle;

        assert.equal(getRouteState().kind, obsolete ? "verified" : "quarantined");
        if (obsolete) {
          assert.equal(getBinding()?.tab, "TAB-NEW");
        } else {
          assert.equal(getRouteState().cause, "route_disappeared");
        }
        assert.equal(state.calls.filter((call) => call.name === "oracle_send").length, 1);
      });
    });
  }
});

test("background start failures reconcile only while their immutable lease owns the route", async (t) => {
  for (const toolName of ["context_builder", "oracle_send"]) {
    for (const obsolete of [false, true]) {
      await t.test(`${toolName} ${obsolete ? "obsolete" : "current"} lease`, async () => {
        const backgroundResult = deferred();
        await withRoutingLifecycleHarness({
          state: {
            boundContextId: "TAB-OLD",
            forwardedDeferred: new Map([[toolName, backgroundResult]]),
            forwardedTools: new Set([toolName]),
            toolsByCommand: new Map([["fake-rp", [
              { name: "bind_context", description: "" },
              { name: "manage_workspaces", description: "" },
              toolName === "context_builder"
                ? {
                    name: "context_builder",
                    description: "Build context",
                    inputSchema: { type: "object", properties: { instructions: { type: "string" } } },
                  }
                : fixtureToolByName(ceCatalog, toolName),
            ]]]),
            tabsByWindow: new Map([[5, [
              { id: "TAB-OLD", name: "Old", active: true, bound: true, files: 0 },
              { id: "TAB-NEW", name: "New", active: false, bound: false, files: 0 },
            ]]]),
          },
        }, async ({ state, pi, ctx, config }) => {
          state.calls.length = 0;
          const rpTool = pi.getTool("rp");
          const start = await rpTool.execute(
            `start-${toolName}-${obsolete}`,
            {
              call: toolName,
              args: toolName === "context_builder"
                ? { instructions: "fail" }
                : { message: "fail", new_chat: true },
            },
            undefined,
            () => {},
            ctx
          );
          while (!state.calls.some((call) => call.name === toolName)) {
            await new Promise((resolve) => setImmediate(resolve));
          }

          if (obsolete) {
            persistBinding(pi, {
              app: "ce",
              windowId: 5,
              workspace: "chat-tree",
              tab: "TAB-NEW",
            }, config);
            state.boundContextId = "TAB-NEW";
            for (const tab of state.tabsByWindow.get(5)) {
              tab.bound = tab.id === "TAB-NEW";
            }
          } else {
            state.tabsByWindow.set(5, state.tabsByWindow.get(5).filter((tab) => tab.id !== "TAB-OLD"));
            state.boundContextId = undefined;
          }
          backgroundResult.resolve({
            isError: true,
            content: [{ type: "text", text: `${toolName} failed` }],
          });
          await drainLifecycle();

          assert.equal(getRouteState().kind, obsolete ? "verified" : "quarantined");
          if (obsolete) {
            assert.equal(getBinding()?.tab, "TAB-NEW");
          } else {
            assert.equal(getRouteState().cause, "route_disappeared");
          }
          assert.equal(state.calls.filter((call) => call.name === toolName).length, 1);
          assert.ok(
            start.details.contextBuilderJob?.jobId || start.details.oracleSendJob?.jobId
          );
        });
      });
    }
  }
});

test("a compatible catalog republish blocks queued issuance with typed catalog_changed", async () => {
  await withRoutingLifecycleHarness({
    state: {
      boundContextId: "TAB-LIVE",
      forwardedTools: new Set(["read_file"]),
      toolsByCommand: new Map([["fake-rp", [
        { name: "bind_context", description: "" },
        { name: "manage_workspaces", description: "" },
        { name: "read_file", description: "" },
      ]]]),
      tabsByWindow: new Map([[5, [
        { id: "TAB-LIVE", name: "Live", active: true, bound: true, files: 0 },
      ]]]),
    },
  }, async ({ state, pi, ctx, config }) => {
    persistBinding(pi, {
      app: "ce",
      windowId: 5,
      workspace: "chat-tree",
      tab: "TAB-LIVE",
    }, config, "Live");
    state.calls.length = 0;

    const blockerEntered = deferred();
    const releaseBlocker = deferred();
    const blocker = runRouteChange(async () => {
      blockerEntered.resolve();
      await releaseBlocker.promise;
    });
    await blockerEntered.promise;
    const pending = pi.getTool("rp").execute(
      "catalog-changed-read",
      { call: "read_file", args: { path: "src/index.ts" } },
      undefined,
      () => {},
      ctx
    );
    await new Promise((resolve) => setImmediate(resolve));

    state.publishTools(structuredClone(state.currentClient.tools));
    releaseBlocker.resolve();

    const result = await pending;
    await blocker;
    assert.equal(result.isError, true);
    assert.equal(result.details.error, "catalog_changed");
    assert.equal(state.calls.some((call) => call.name === "read_file"), false);
    assert.equal(getRouteState().kind, "verified");
    assert.equal(getBinding()?.tab, "TAB-LIVE");
  });
});

test("changed catalog revisions block queued issuance without revoking prior authority", async (t) => {
  const scenarios = [
    {
      name: "generic route-dependent call",
      target: (call) => call.name === "read_file",
      invoke: ({ pi, ctx }) => pi.getTool("rp").execute(
        "queued-read",
        { call: "read_file", args: { path: "src/index.ts" } },
        undefined,
        () => {},
        ctx
      ),
    },
    {
      name: "queued routing mutation",
      target: (call) => call.name === "bind_context" && call.args.op === "bind",
      invoke: ({ pi, ctx }) => pi.getTool("rp").execute(
        "queued-bind",
        { call: "bind_context", args: { op: "bind", context_id: "TAB-A" } },
        undefined,
        () => {},
        ctx
      ),
    },
    {
      name: "interactive bind",
      target: (call) => call.name === "bind_context" && call.args.op === "bind",
      invoke: ({ pi, ctx }) => pi.getCommand("rp").handler("bind 5 TAB-A", ctx),
    },
    {
      name: "slash Oracle",
      target: (call) => call.name === "oracle_send",
      invoke: ({ pi, ctx }) => pi.getCommand("rp").handler("oracle check catalog", ctx),
    },
    {
      name: "Context Builder background start",
      target: (call) => call.name === "context_builder",
      invoke: ({ pi, ctx }) => pi.getTool("rp").execute(
        "queued-context-builder",
        { call: "context_builder", args: { instructions: "Inspect routing" } },
        undefined,
        () => {},
        ctx
      ),
    },
    {
      name: "Oracle background start",
      target: (call) => call.name === "oracle_send",
      invoke: ({ pi, ctx }) => pi.getTool("rp").execute(
        "queued-oracle",
        { call: "oracle_send", args: { message: "Inspect routing" } },
        undefined,
        () => {},
        ctx
      ),
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      await withRoutingLifecycleHarness({
        hasUI: true,
        state: {
          boundContextId: "TAB-LIVE",
          forwardedTools: new Set(["read_file", "context_builder", "oracle_send"]),
          toolsByCommand: new Map([["fake-rp", [
            { name: "bind_context", description: "" },
            { name: "manage_workspaces", description: "" },
            { name: "read_file", description: "" },
            { name: "context_builder", description: "" },
            { name: "oracle_send", description: "" },
          ]]]),
          tabsByWindow: new Map([[5, [
            { id: "TAB-LIVE", name: "Live", active: true, bound: true, files: 0 },
            { id: "TAB-A", name: "Requested", active: false, bound: false, files: 0 },
          ]]]),
        },
      }, async ({ state, pi, ctx, config }) => {
        persistBinding(pi, {
          app: "ce",
          windowId: 5,
          workspace: "chat-tree",
          tab: "TAB-LIVE",
        }, config, "Live");
        state.calls.length = 0;

        const blockerEntered = deferred();
        const releaseBlocker = deferred();
        const blocker = runRouteChange(async () => {
          blockerEntered.resolve();
          await releaseBlocker.promise;
        });
        await blockerEntered.promise;
        const pending = Promise.resolve().then(() => scenario.invoke({ pi, ctx }));
        await new Promise((resolve) => setImmediate(resolve));

        const incompatibleTools = structuredClone(state.currentClient.tools);
        delete incompatibleTools.find(
          (tool) => tool.name === "bind_context"
        ).inputSchema.properties.context_id;
        state.publishTools(incompatibleTools);
        releaseBlocker.resolve();

        const result = await pending.catch(() => undefined);
        await blocker;
        await drainLifecycle();
        if (scenario.name === "queued routing mutation") {
          assert.equal(result?.details.error, "catalog_changed");
        }
        assert.equal(state.calls.some(scenario.target), false);
        assert.equal(getRouteState().kind, "verified");
        assert.equal(getBinding()?.tab, "TAB-LIVE");
      });
    });
  }
});

test("fresh incompatible catalogs block every extension-owned routing flow and lifecycle", async (t) => {
  const scenarios = [
    {
      name: "slash windows",
      invoke: async ({ pi, ctx }) => await pi.getCommand("rp").handler("windows", ctx),
    },
    {
      name: "slash bind",
      invoke: async ({ pi, ctx }) => await pi.getCommand("rp").handler("bind 5", ctx),
    },
    {
      name: "slash tab",
      invoke: async ({ pi, ctx }) => await pi.getCommand("rp").handler("tab new", ctx),
    },
    {
      name: "tool windows",
      invoke: async ({ pi, ctx }) => await pi.getTool("rp").execute(
        "incompatible-windows",
        { windows: true },
        undefined,
        () => {},
        ctx
      ),
    },
    {
      name: "tool bind",
      invoke: async ({ pi, ctx }) => await pi.getTool("rp").execute(
        "incompatible-bind",
        { bind: { window: 5 } },
        undefined,
        () => {},
        ctx
      ),
    },
    {
      name: "session tree lifecycle",
      invoke: async ({ pi, ctx }) => await pi.emit("session_tree", ctx, {}),
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      await withRoutingLifecycleHarness({
        hasUI: true,
        state: {
          boundContextId: "TAB-LIVE",
          tabsByWindow: new Map([[5, [
            { id: "TAB-LIVE", name: "Live", active: true, bound: true, files: 0 },
          ]]]),
        },
      }, async ({ state, pi, ctx }) => {
        const incompatibleTools = structuredClone(state.currentClient.tools);
        delete incompatibleTools.find(
          (tool) => tool.name === "bind_context"
        ).inputSchema.properties.context_id;
        state.publishTools(incompatibleTools);
        state.calls.length = 0;

        await scenario.invoke({ pi, ctx });

        assert.equal(state.calls.length, 0);
        assert.notEqual(getRouteState().kind, "verified");
      });
    });
  }
});

test("fresh incompatible catalogs revoke route-dependent dispatch while paused diagnostics remain local", async () => {
  await withRoutingLifecycleHarness({
    state: {
      boundContextId: "TAB-LIVE",
      forwardedTools: new Set(["read_file"]),
      toolsByCommand: new Map([["fake-rp", [
        { name: "bind_context", description: "" },
        { name: "manage_workspaces", description: "" },
        { name: "read_file", description: "" },
      ]]]),
      tabsByWindow: new Map([[5, [
        { id: "TAB-LIVE", name: "Live", active: true, bound: true, files: 0 },
      ]]]),
    },
  }, async ({ state, pi, ctx }) => {
    const incompatibleTools = structuredClone(state.currentClient.tools);
    delete incompatibleTools.find(
      (tool) => tool.name === "bind_context"
    ).inputSchema.properties.context_id;
    state.publishTools(incompatibleTools);
    state.calls.length = 0;

    const blocked = await pi.getTool("rp").execute(
      "incompatible-read",
      { call: "read_file", args: { path: "src/index.ts" } },
      undefined,
      () => {},
      ctx
    );
    assert.equal(blocked.isError, true);
    assert.match(blocked.content[0].text, /Unsupported RepoPrompt CE/u);
    assert.equal(state.calls.some((call) => call.name === "read_file"), false);
    assert.notEqual(getRouteState().kind, "verified");

    const callsBeforeDiagnostics = state.calls.length;
    const status = await pi.getTool("rp").execute("paused-status", {}, undefined, () => {}, ctx);
    const search = await pi.getTool("rp").execute(
      "paused-search",
      { search: "bind_context" },
      undefined,
      () => {},
      ctx
    );
    const describe = await pi.getTool("rp").execute(
      "paused-describe",
      { describe: "bind_context" },
      undefined,
      () => {},
      ctx
    );

    assert.equal(status.details.routeState, "unsupported");
    assert.match(search.content[0].text, /bind_context/u);
    assert.match(describe.content[0].text, /bind_context/u);
    assert.equal(state.calls.length, callsBeforeDiagnostics);
  });
});

test("thrown ordinary route-dependent failures re-observe without replay", async (t) => {
  const cases = [
    { outcome: "throw", cause: "route_disappeared", failObservation: false },
    { outcome: "timeout", cause: "route_disappeared", failObservation: false },
    { outcome: "abort", cause: "route_disappeared", failObservation: false },
    { outcome: "throw", cause: "observation_failed", failObservation: true },
  ];

  for (const [index, scenario] of cases.entries()) {
    await t.test(`${scenario.outcome}-${scenario.cause}`, async () => {
      await withRoutingLifecycleHarness({
        state: {
          boundContextId: "TAB-LIVE",
          forwardedCallOutcomes: [scenario.outcome],
          forwardedTools: new Set(["read_file"]),
          toolsByCommand: new Map([["fake-rp", [
            { name: "bind_context", description: "" },
            { name: "manage_workspaces", description: "" },
            { name: "read_file", description: "" },
          ]]]),
          tabsByWindow: new Map([[5, [
            { id: "TAB-LIVE", name: "Live", active: true, bound: true, files: 0 },
          ]]]),
          beforeForwardedFailure() {
            if (scenario.failObservation) {
              this.failNextInventoryCount = 1;
              return;
            }
            this.tabsByWindow.set(5, []);
            this.boundContextId = undefined;
          },
        },
      }, async ({ state, pi, ctx }) => {
        const result = await pi.getTool("rp").execute(
          `ordinary-thrown-${index}`,
          { call: "read_file", args: { path: "src/index.ts" } },
          undefined,
          () => {},
          ctx
        );

        assert.equal(result.isError, true);
        assert.equal(getRouteState().kind, "quarantined");
        assert.equal(getRouteState().cause, scenario.cause);
        assert.equal(state.calls.filter((call) => call.name === "read_file").length, 1);
      });
    });
  }
});
