import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";

import repopromptMcp from "../dist/index.js";
import { clearBinding, persistBinding } from "../dist/binding.js";
import { getRpClient, RpClient, resetRpClient } from "../dist/client.js";
import { ContextBuilderJobManager } from "../dist/context-builder-jobs.js";
import { AUTO_SELECTION_ENTRY_TYPE } from "../dist/types.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function textResult(text) {
  return { content: [{ type: "text", text }], isError: false };
}

async function expectRpError(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.match(error.message, new RegExp(`^\\[${code}\\]`, "u"));
    return true;
  });
}

function createMockPi() {
  const handlers = new Map();
  const commands = new Map();
  const tools = new Map();
  const entries = [];
  return {
    on(event, handler) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
    registerCommand(name, command) {
      commands.set(name, command);
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
      entries.push({ type: "custom", customType, data });
    },
    async emit(event, ctx) {
      for (const handler of handlers.get(event) ?? []) {
        await handler({ type: event }, ctx);
      }
    },
    entries,
  };
}

function createContext(cwd, entries) {
  return {
    hasUI: false,
    cwd,
    ui: { notify() {} },
    sessionManager: {
      getBranch() {
        return entries;
      },
      getSessionFile() {
        return path.join(cwd, "session.jsonl");
      },
      getSessionId() {
        return "session-id";
      },
      getLeafId() {
        return "leaf-id";
      },
    },
  };
}

async function createBlockedLazyRecoveryHarness({
  failInitialConnect = false,
  failReconnect = false,
  failRootRecovery = false,
  launchApp,
} = {}) {
  const originalHome = process.env.HOME;
  const tempHome = mkdtempSync(path.join(os.tmpdir(), "rp-lazy-recovery-home-"));
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "rp-lazy-recovery-root-"));
  const originalConnect = RpClient.prototype.connect;
  const originalClose = RpClient.prototype.close;
  const originalCallTool = RpClient.prototype.callTool;
  let blockedWindows = deferred();
  let blockedBinding;
  const forwardedCalls = [];
  let connectCalls = 0;

  process.env.HOME = tempHome;
  mkdirSync(path.join(tempHome, ".pi", "agent", "extensions"), { recursive: true });
  writeFileSync(
    path.join(tempHome, ".pi", "agent", "extensions", "repoprompt-mcp.json"),
    JSON.stringify({
      activeApp: "ce",
      apps: {
        ce: { command: "fake-rp", args: [] },
        classic: { command: "fake-rp-classic", args: [] },
      },
      autoBindOnStart: false,
      autoSelectReadSlices: false,
    }),
  );
  await resetRpClient();
  clearBinding();

  RpClient.prototype.connect = async function connect() {
    connectCalls += 1;
    if ((failInitialConnect && connectCalls === 1) || (failReconnect && connectCalls > 1)) {
      throw new Error("RepoPrompt is unavailable");
    }
    this.client = {};
    this.transport = {};
    this._status = "connected";
    this._tools = [
      { name: "context_builder", description: "Build context", inputSchema: { type: "object" } },
      { name: "read_file", description: "Read", inputSchema: { type: "object" } },
      { name: "list_windows", description: "List windows", inputSchema: { type: "object" } },
      { name: "bind_context", description: "Bind context", inputSchema: { type: "object" } },
      { name: "manage_workspaces", description: "Manage workspaces", inputSchema: { type: "object" } },
      { name: "get_file_tree", description: "Get tree", inputSchema: { type: "object" } },
    ];
    this.publishedToolListGeneration = 0;
    this.toolListInvalidationGeneration = 0;
  };
  RpClient.prototype.close = async function close() {
    this.client = null;
    this.transport = null;
    this._status = "disconnected";
    this._tools = [];
    this.publishedToolListGeneration = null;
  };
  RpClient.prototype.callTool = async function callTool(name, args = {}, _onUpdate, signal) {
    if (name === "list_windows") {
      return blockedWindows.promise;
    }
    if (name === "bind_context") {
      if (args.op === "list") {
        if (blockedBinding) {
          return blockedBinding.promise;
        }
        return textResult("## Tabs ✅\n\n- `TAB-1` • Pi Session [bound]");
      }
      return textResult(`called ${name}`);
    }
    if (name === "manage_workspaces") {
      return textResult(`called ${name}`);
    }
    if (name === "get_file_tree" && failRootRecovery) {
      throw new Error("root lookup failed");
    }
    forwardedCalls.push({ name, args, signal });
    return textResult(`called ${name}`);
  };

  const pi = createMockPi();
  repopromptMcp(pi, launchApp ? { launchApp } : {});
  persistBinding(
    pi,
    { app: "ce", windowId: 7, tab: "TAB-1", workspace: "repo" },
    { activeApp: "ce", apps: { ce: {} }, persistBinding: true },
  );
  const ctx = createContext(repoRoot, pi.entries);
  ctx.ui.notify = () => {};

  return {
    get blockedWindows() {
      return blockedWindows;
    },
    blockNextWindowsCall() {
      blockedWindows = deferred();
    },
    get blockedBinding() {
      return blockedBinding;
    },
    blockNextBindingCall() {
      blockedBinding = deferred();
    },
    ctx,
    forwardedCalls,
    get connectCalls() {
      return connectCalls;
    },
    pi,
    async cleanup() {
      blockedWindows.resolve(textResult(""));
      blockedBinding?.resolve(textResult(""));
      RpClient.prototype.connect = originalConnect;
      RpClient.prototype.close = originalClose;
      RpClient.prototype.callTool = originalCallTool;
      process.env.HOME = originalHome;
      await resetRpClient();
      clearBinding();
      rmSync(tempHome, { recursive: true, force: true });
      rmSync(repoRoot, { recursive: true, force: true });
    },
  };
}

async function settleWithin(promise, timeoutMs = 500) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Promise did not settle before timeout")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

test("rp runs Context Builder through the asynchronous start and wait protocol", async () => {
  const originalHome = process.env.HOME;
  const tempHome = mkdtempSync(path.join(os.tmpdir(), "rp-context-builder-home-"));
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "rp-context-builder-root-"));
  process.env.HOME = tempHome;

  const originalConnect = RpClient.prototype.connect;
  const originalClose = RpClient.prototype.close;
  const originalCallTool = RpClient.prototype.callTool;
  const builderWork = deferred();
  const lifecycleWork = deferred();
  const calls = [];
  const lifecycleEvents = [];
  let connectCalls = 0;
  let contextBuilderCalls = 0;
  let tabCreated = false;
  let pendingClose;
  let onAppendEntry;
  let shutdownPromise;

  try {
    mkdirSync(path.join(tempHome, ".pi", "agent", "extensions"), { recursive: true });
    writeFileSync(
      path.join(tempHome, ".pi", "agent", "extensions", "repoprompt-mcp.json"),
      JSON.stringify({
        activeApp: "ce",
        apps: { ce: { command: "fake-rp", args: [] } },
        autoBindOnStart: false,
        autoSelectReadSlices: false,
        suppressHostDisconnectedLog: false,
      }),
    );

    await resetRpClient();
    clearBinding();

    RpClient.prototype.connect = async function connect() {
      connectCalls += 1;
      this.client = {};
      this.transport = {};
      this._status = "connected";
      this.toolListInvalidationGeneration = 0;
      this.publishedToolListGeneration = 0;
      this._tools = [
        {
          name: "context_builder",
          description: "Build repository context",
          inputSchema: { type: "object", properties: { instructions: { type: "string" } } },
        },
        { name: "read_file", description: "Read a file", inputSchema: { type: "object" } },
        { name: "list_windows", description: "List windows", inputSchema: { type: "object" } },
        { name: "manage_workspaces", description: "Manage workspaces", inputSchema: { type: "object" } },
        { name: "bind_context", description: "Bind context", inputSchema: { type: "object" } },
      ];
    };

    RpClient.prototype.close = async function close() {
      lifecycleEvents.push("close");
      if (pendingClose) {
        const close = pendingClose;
        await close.promise;
        if (pendingClose === close) {
          pendingClose = undefined;
        }
      }
      this.client = null;
      this.transport = null;
      this._status = "disconnected";
      this._tools = [];
      this.publishedToolListGeneration = null;
    };

    RpClient.prototype.callTool = async function callTool(name, args = {}, _timeout, signal) {
      calls.push({ name, args, signal });
      if (name === "list_windows") {
        return textResult("- Window `7` • WS: repo • Roots: 1\n- Window `8` • WS: other • Roots: 1");
      }
      if (name === "read_file") {
        return textResult(`read ${args.path}`);
      }
      if (name === "bind_context" && args.op === "list") {
        return textResult(tabCreated ? "## Tabs ✅\n\n- `TAB-NEW` • Pi Session [bound]" : "## Tabs ✅");
      }
      if (name === "bind_context" && args.op === "bind") {
        return textResult(`Selected tab \`${args.context_id}\``);
      }
      if (name === "manage_workspaces" && args.action === "create_tab") {
        tabCreated = true;
        return textResult("Created tab `TAB-NEW` • Pi Session [bound]");
      }
      if (name === "context_builder") {
        contextBuilderCalls += 1;
        if (contextBuilderCalls === 1) {
          return builderWork.promise;
        }
        if (contextBuilderCalls === 2) {
          return textResult("builder after reconnect");
        }
        if (contextBuilderCalls === 3) {
          return { content: [{ type: "text", text: "builder MCP error" }], isError: true };
        }
        if (contextBuilderCalls === 4) {
          throw new Error("builder rejected");
        }
        signal.addEventListener("abort", () => lifecycleEvents.push("abort"), { once: true });
        return lifecycleWork.promise;
      }
      throw new Error(`Unexpected tool: ${name}`);
    };

    const pi = createMockPi();
    const appendEntry = pi.appendEntry.bind(pi);
    pi.appendEntry = (customType, data) => {
      appendEntry(customType, data);
      onAppendEntry?.(customType, data);
    };
    const manager = new ContextBuilderJobManager({
      waitTimeoutMs: 5,
      createJobId: (() => {
        let id = 1;
        return () => `cb_integration_${id++}`;
      })(),
      warn: () => {},
    });
    repopromptMcp(pi, { contextBuilderJobs: manager });
    const config = {
      activeApp: "ce",
      apps: { ce: {} },
      persistBinding: true,
    };
    persistBinding(pi, { app: "ce", windowId: 7, workspace: "repo" }, config);

    const rpTool = pi.getTool("rp");
    const ctx = createContext(repoRoot, pi.entries);
    const renderedError = rpTool.renderResult(
      { content: [{ type: "text", text: "[context_builder_job_not_found] missing" }], details: {} },
      { expanded: false, isPartial: false },
      { fg: (color, text) => `${color}:${text}` },
      { isError: true },
    );
    assert.match(renderedError.render(120).join("\n"), /error:↳ \[context_builder_job_not_found\]/u);

    await expectRpError(
      rpTool.execute(
        "wait-with-lower-priority-describe",
        { call: "context_builder_wait", args: { job_id: "cb_unknown" }, describe: "read_file" },
        undefined,
        undefined,
        ctx,
      ),
      "context_builder_job_not_found",
    );
    assert.equal(connectCalls, 0);

    const preAbortedStart = new AbortController();
    preAbortedStart.abort();
    const callsBeforePreAbort = calls.length;
    const entriesBeforePreAbort = pi.entries.length;
    await expectRpError(
      rpTool.execute(
        "builder-pre-aborted-without-tab",
        { call: "context_builder", args: { instructions: "No side effects" } },
        preAbortedStart.signal,
        undefined,
        ctx,
      ),
      "context_builder_start_aborted",
    );
    assert.equal(calls.length, callsBeforePreAbort);
    assert.equal(pi.entries.length, entriesBeforePreAbort);

    await expectRpError(
      rpTool.execute(
        "builder-missing-context",
        { call: "context_builder", args: { instructions: "No context" } },
        undefined,
        undefined,
        undefined,
      ),
      "missing_tab_binding",
    );
    assert.equal(contextBuilderCalls, 0);

    const connectedClient = getRpClient();
    const connectedTools = connectedClient._tools;
    connectedClient._tools = connectedTools.filter((tool) => tool.name !== "context_builder");
    await expectRpError(
      rpTool.execute(
        "builder-not-found",
        { call: "context_builder", args: { instructions: "Missing tool" } },
        undefined,
        undefined,
        ctx,
      ),
      "not_found",
    );
    connectedClient._tools = connectedTools;
    assert.equal(contextBuilderCalls, 0);

    onAppendEntry = (_customType, data) => {
      if (data?.tab !== "TAB-NEW") {
        return;
      }
      onAppendEntry = undefined;
      persistBinding(pi, { app: "ce", windowId: 8, tab: "TAB-RACE", workspace: "other" }, config);
    };

    const start = await rpTool.execute(
      "builder-1",
      { call: "context_builder", args: { instructions: "Plan it", _windowID: 999 } },
      undefined,
      undefined,
      ctx,
    );
    assert.ok(start.details.contextBuilderJob, JSON.stringify({ start, calls }));
    assert.equal(start.details.contextBuilderJob.jobId, "cb_integration_1");
    assert.equal(start.details.contextBuilderJob.status, "running");
    assert.deepEqual(start.details.contextBuilderJob.target, { app: "ce", windowId: 7, tab: "TAB-NEW" });
    assert.match(start.content[0].text, /context_builder_wait/u);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls.at(-1).args, {
      instructions: "Plan it",
      _windowID: 7,
      context_id: "TAB-NEW",
    });
    assert.ok(calls.at(-1).signal instanceof AbortSignal);
    start.details.contextBuilderJob.target.tab = "MUTATED-BY-TOOL-RESULT-HOOK";
    persistBinding(pi, { app: "ce", windowId: 7, tab: "TAB-NEW", workspace: "repo" }, config);

    const ordinary = await rpTool.execute(
      "read-1",
      { call: "read_file", args: { path: "src/main.ts" } },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(ordinary.content[0].text, "read src/main.ts");

    await expectRpError(
      rpTool.execute(
        "builder-2",
        { call: "context_builder", args: { instructions: "Again" } },
        undefined,
        undefined,
        ctx,
      ),
      "context_builder_already_running",
    );
    assert.equal(contextBuilderCalls, 1);

    const running = await rpTool.execute(
      "wait-1",
      { call: "context_builder_wait", args: { job_id: "cb_integration_1" } },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(running.details.contextBuilderJob.status, "running");

    builderWork.resolve({
      content: [
        { type: "text", text: "builder result" },
        { type: "image", data: "abc", mimeType: "image/png" },
      ],
      isError: false,
    });
    const completed = await rpTool.execute(
      "wait-2",
      { call: "context_builder_wait", args: { job_id: "cb_integration_1" } },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(completed.details.contextBuilderJob.status, "completed");
    assert.deepEqual(completed.details.contextBuilderJob.target, { app: "ce", windowId: 7, tab: "TAB-NEW" });
    assert.equal(completed.details.tool, "context_builder");
    assert.deepEqual(completed.content, [
      { type: "text", text: "builder result" },
      { type: "image", data: "abc", mimeType: "image/png" },
    ]);

    await expectRpError(
      rpTool.execute(
        "wait-3",
        { call: "context_builder_wait", args: { job_id: "cb_integration_1" } },
        undefined,
        undefined,
        ctx,
      ),
      "context_builder_job_consumed",
    );

    const reconnectClose = deferred();
    pendingClose = reconnectClose;
    const reconnectPromise = pi.getCommand("rp").handler("reconnect", ctx);
    await new Promise((resolve) => setImmediate(resolve));

    const callsBeforeReconnectStart = contextBuilderCalls;
    const startDuringReconnect = rpTool.execute(
      "builder-during-reconnect",
      { call: "context_builder", args: { instructions: "Wait for reconnect" } },
      undefined,
      undefined,
      ctx,
    );
    let reconnectStartSettled = false;
    void startDuringReconnect.then(
      () => { reconnectStartSettled = true; },
      () => { reconnectStartSettled = true; },
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reconnectStartSettled, false);
    assert.equal(contextBuilderCalls, callsBeforeReconnectStart);

    reconnectClose.resolve();
    await reconnectPromise;
    const reconnectStart = await startDuringReconnect;
    assert.equal(reconnectStart.details.contextBuilderJob.jobId, "cb_integration_2");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(contextBuilderCalls, callsBeforeReconnectStart + 1);
    const reconnectResult = await rpTool.execute(
      "wait-after-reconnect",
      { call: "context_builder_wait", args: { job_id: "cb_integration_2" } },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(reconnectResult.content[0].text, "builder after reconnect");
    persistBinding(pi, { app: "ce", windowId: 7, tab: "TAB-NEW", workspace: "repo" }, config);

    await expectRpError(
      rpTool.execute(
        "wait-invalid",
        { call: "context_builder_wait", args: { job_id: "cb_integration_1", extra: true } },
        undefined,
        undefined,
        ctx,
      ),
      "invalid_context_builder_wait_args",
    );
    await expectRpError(
      rpTool.execute(
        "wait-unknown",
        { call: "context_builder_wait", args: { job_id: "cb_unknown" } },
        undefined,
        undefined,
        ctx,
      ),
      "context_builder_job_not_found",
    );

    const startController = new AbortController();
    startController.abort();
    const callsBeforeAbortedStart = contextBuilderCalls;
    await expectRpError(
      rpTool.execute(
        "builder-aborted",
        { call: "context_builder", args: { instructions: "Do not start" } },
        startController.signal,
        undefined,
        ctx,
      ),
      "context_builder_start_aborted",
    );
    assert.equal(contextBuilderCalls, callsBeforeAbortedStart);

    const described = await rpTool.execute(
      "describe-1",
      { describe: "context_builder_wait" },
      undefined,
      undefined,
      ctx,
    );
    assert.match(described.content[0].text, /210 seconds/u);
    assert.match(described.content[0].text, /job_id/u);

    const searched = await rpTool.execute(
      "search-1",
      { search: "context builder wait" },
      undefined,
      undefined,
      ctx,
    );
    assert.ok(searched.details.matches.includes("context_builder_wait"));

    const errorStart = await rpTool.execute(
      "builder-error",
      { call: "context_builder", args: { instructions: "Return an MCP error" } },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(errorStart.details.contextBuilderJob.jobId, "cb_integration_3");
    await expectRpError(
      rpTool.execute(
        "wait-error",
        { call: "context_builder_wait", args: { job_id: "cb_integration_3" } },
        undefined,
        undefined,
        ctx,
      ),
      "context_builder_tool_failed",
    );

    const rejectedStart = await rpTool.execute(
      "builder-rejected",
      { call: "context_builder", args: { instructions: "Reject" } },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(rejectedStart.details.contextBuilderJob.jobId, "cb_integration_4");
    await expectRpError(
      rpTool.execute(
        "wait-rejected",
        { call: "context_builder_wait", args: { job_id: "cb_integration_4" } },
        undefined,
        undefined,
        ctx,
      ),
      "context_builder_job_failed",
    );

    const lifecycleStart = await rpTool.execute(
      "builder-3",
      { call: "context_builder", args: { instructions: "Long plan" } },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(lifecycleStart.details.contextBuilderJob.jobId, "cb_integration_5");
    await new Promise((resolve) => setImmediate(resolve));

    persistBinding(pi, { app: "ce", windowId: 8, workspace: "other" }, config);
    tabCreated = false;
    onAppendEntry = (_customType, data) => {
      if (data?.windowId !== 8 || data?.tab !== "TAB-NEW") {
        return;
      }
      onAppendEntry = undefined;
      shutdownPromise = pi.emit("session_shutdown", ctx);
    };
    await expectRpError(
      rpTool.execute(
        "builder-reset-during-binding",
        { call: "context_builder", args: { instructions: "Must not start" } },
        undefined,
        undefined,
        ctx,
      ),
      "context_builder_start_cancelled",
    );
    await shutdownPromise;
    assert.equal(contextBuilderCalls, 5);
    assert.deepEqual(lifecycleEvents.slice(-2), ["abort", "close"]);
    lifecycleWork.reject(new Error("cancelled"));
  } finally {
    RpClient.prototype.connect = originalConnect;
    RpClient.prototype.close = originalClose;
    RpClient.prototype.callTool = originalCallTool;
    process.env.HOME = originalHome;
    await resetRpClient();
    clearBinding();
    rmSync(tempHome, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("superseded session startup cannot pause a successful reconnect", async () => {
  const originalHome = process.env.HOME;
  const tempHome = mkdtempSync(path.join(os.tmpdir(), "rp-stale-startup-home-"));
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "rp-stale-startup-root-"));
  const originalConnect = RpClient.prototype.connect;
  const originalClose = RpClient.prototype.close;
  const originalCallTool = RpClient.prototype.callTool;
  const initialConnect = deferred();
  let connectCalls = 0;

  process.env.HOME = tempHome;
  try {
    mkdirSync(path.join(tempHome, ".pi", "agent", "extensions"), { recursive: true });
    writeFileSync(
      path.join(tempHome, ".pi", "agent", "extensions", "repoprompt-mcp.json"),
      JSON.stringify({
        activeApp: "ce",
        apps: { ce: { command: "fake-rp", args: [] } },
        autoBindOnStart: false,
        autoSelectReadSlices: false,
      }),
    );
    await resetRpClient();
    clearBinding();

    RpClient.prototype.connect = async function connect() {
      connectCalls += 1;
      if (connectCalls === 1) {
        return initialConnect.promise;
      }
      this.client = {};
      this.transport = {};
      this._status = "connected";
      this._tools = [{ name: "read_file", description: "Read", inputSchema: { type: "object" } }];
      this.publishedToolListGeneration = 0;
      this.toolListInvalidationGeneration = 0;
    };
    RpClient.prototype.close = async function close() {
      this.client = null;
      this.transport = null;
      this._status = "disconnected";
      this._tools = [];
      this.publishedToolListGeneration = null;
    };
    RpClient.prototype.callTool = async function callTool(name) {
      assert.equal(name, "read_file");
      return textResult("read after reconnect");
    };

    const pi = createMockPi();
    repopromptMcp(pi);
    persistBinding(
      pi,
      { app: "ce", windowId: 7, tab: "TAB-1", workspace: "repo" },
      { activeApp: "ce", apps: { ce: {} }, persistBinding: true },
    );
    const ctx = createContext(repoRoot, pi.entries);
    const notifications = [];
    ctx.ui.notify = (message) => notifications.push(message);

    await pi.emit("session_start", ctx);
    assert.equal(connectCalls, 1);
    await pi.getCommand("rp").handler("reconnect", ctx);
    assert.equal(connectCalls, 2);

    initialConnect.reject(new Error("stale startup failed"));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const result = await pi.getTool("rp").execute(
      "read-after-reconnect",
      { call: "read_file", args: { path: "src/main.ts" } },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(result.content[0].text, "read after reconnect");
    assert.equal(connectCalls, 2);
    assert.equal(notifications.some((message) => message.includes("extension paused")), false);
  } finally {
    RpClient.prototype.connect = originalConnect;
    RpClient.prototype.close = originalClose;
    RpClient.prototype.callTool = originalCallTool;
    process.env.HOME = originalHome;
    initialConnect.reject(new Error("test cleanup"));
    await resetRpClient();
    clearBinding();
    rmSync(tempHome, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("session shutdown prevents a blocked reconnect from reconnecting", async () => {
  const originalHome = process.env.HOME;
  const tempHome = mkdtempSync(path.join(os.tmpdir(), "rp-reconnect-shutdown-home-"));
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "rp-reconnect-shutdown-root-"));
  const originalConnect = RpClient.prototype.connect;
  const originalClose = RpClient.prototype.close;
  const originalCallTool = RpClient.prototype.callTool;
  let connectCalls = 0;
  let blockedClose;

  process.env.HOME = tempHome;
  try {
    mkdirSync(path.join(tempHome, ".pi", "agent", "extensions"), { recursive: true });
    writeFileSync(
      path.join(tempHome, ".pi", "agent", "extensions", "repoprompt-mcp.json"),
      JSON.stringify({
        activeApp: "ce",
        apps: { ce: { command: "fake-rp", args: [] } },
        autoBindOnStart: false,
        autoSelectReadSlices: false,
      }),
    );
    await resetRpClient();
    clearBinding();

    RpClient.prototype.connect = async function connect() {
      connectCalls += 1;
      this.client = {};
      this.transport = {};
      this._status = "connected";
      this._tools = [{ name: "read_file", description: "Read", inputSchema: { type: "object" } }];
      this.publishedToolListGeneration = 0;
      this.toolListInvalidationGeneration = 0;
    };
    RpClient.prototype.close = async function close() {
      if (blockedClose) {
        await blockedClose.promise;
      }
      this.client = null;
      this.transport = null;
      this._status = "disconnected";
      this._tools = [];
      this.publishedToolListGeneration = null;
    };
    RpClient.prototype.callTool = async function callTool(name) {
      assert.equal(name, "read_file");
      return textResult("read result");
    };

    const pi = createMockPi();
    repopromptMcp(pi);
    persistBinding(
      pi,
      { app: "ce", windowId: 7, tab: "TAB-1", workspace: "repo" },
      { activeApp: "ce", apps: { ce: {} }, persistBinding: true },
    );
    const ctx = createContext(repoRoot, pi.entries);
    const notifications = [];
    ctx.ui.notify = (message) => notifications.push(message);
    await pi.getTool("rp").execute(
      "connect",
      { call: "read_file", args: { path: "src/main.ts" } },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(connectCalls, 1);

    blockedClose = deferred();
    const reconnectPromise = pi.getCommand("rp").handler("reconnect", ctx);
    await new Promise((resolve) => setImmediate(resolve));
    const shutdownPromise = pi.emit("session_shutdown", ctx);
    await new Promise((resolve) => setImmediate(resolve));

    blockedClose.resolve();
    await Promise.all([reconnectPromise, shutdownPromise]);

    assert.equal(connectCalls, 1);
    assert.equal(getRpClient().isConnected, false);
    assert.equal(notifications.some((message) => message.includes("reconnected")), false);
  } finally {
    RpClient.prototype.connect = originalConnect;
    RpClient.prototype.close = originalClose;
    RpClient.prototype.callTool = originalCallTool;
    process.env.HOME = originalHome;
    blockedClose?.resolve();
    await resetRpClient();
    clearBinding();
    rmSync(tempHome, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("blocked post-connect recovery does not delay a later reconnect", async () => {
  const originalHome = process.env.HOME;
  const tempHome = mkdtempSync(path.join(os.tmpdir(), "rp-blocked-recovery-home-"));
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "rp-blocked-recovery-root-"));
  const originalConnect = RpClient.prototype.connect;
  const originalClose = RpClient.prototype.close;
  const originalCallTool = RpClient.prototype.callTool;
  const blockedWindows = deferred();
  let connectCalls = 0;

  process.env.HOME = tempHome;
  try {
    mkdirSync(path.join(tempHome, ".pi", "agent", "extensions"), { recursive: true });
    writeFileSync(
      path.join(tempHome, ".pi", "agent", "extensions", "repoprompt-mcp.json"),
      JSON.stringify({
        activeApp: "ce",
        apps: { ce: { command: "fake-rp", args: [] } },
        autoBindOnStart: false,
        autoSelectReadSlices: false,
      }),
    );
    await resetRpClient();
    clearBinding();

    RpClient.prototype.connect = async function connect() {
      connectCalls += 1;
      this.client = {};
      this.transport = {};
      this._status = "connected";
      this._tools = [
        { name: "read_file", description: "Read", inputSchema: { type: "object" } },
        { name: "list_windows", description: "List windows", inputSchema: { type: "object" } },
        { name: "bind_context", description: "Bind context", inputSchema: { type: "object" } },
      ];
      this.publishedToolListGeneration = 0;
      this.toolListInvalidationGeneration = 0;
    };
    RpClient.prototype.close = async function close() {
      this.client = null;
      this.transport = null;
      this._status = "disconnected";
      this._tools = [];
      this.publishedToolListGeneration = null;
    };
    RpClient.prototype.callTool = async function callTool(name, args = {}) {
      if (name === "list_windows") {
        return blockedWindows.promise;
      }
      if (name === "bind_context" && args.op === "list") {
        return textResult("## Tabs \u2705\n\n- `TAB-1` \u2022 Pi Session [bound]");
      }
      return textResult(`called ${name}`);
    };

    const pi = createMockPi();
    repopromptMcp(pi);
    persistBinding(
      pi,
      { app: "ce", windowId: 7, tab: "TAB-1", workspace: "repo" },
      { activeApp: "ce", apps: { ce: {} }, persistBinding: true },
    );
    const ctx = createContext(repoRoot, pi.entries);
    const notifications = [];
    ctx.ui.notify = (message) => notifications.push(message);

    // The first call connects, then blocks inside post-connect selection recovery
    const blockedCall = pi.getTool("rp").execute(
      "read-blocked",
      { call: "read_file", args: { path: "src/main.ts" } },
      undefined,
      undefined,
      ctx,
    );
    blockedCall.catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(connectCalls, 1);

    const reconnectPromise = pi.getCommand("rp").handler("reconnect", ctx);
    reconnectPromise.catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    // Reconnect reset and reconnected the client even though the earlier recovery is still blocked
    assert.equal(connectCalls, 2);

    blockedWindows.resolve(textResult("- Window `7` \u2022 WS: repo \u2022 Roots: 1"));
    await Promise.allSettled([blockedCall, reconnectPromise]);
  } finally {
    RpClient.prototype.connect = originalConnect;
    RpClient.prototype.close = originalClose;
    RpClient.prototype.callTool = originalCallTool;
    process.env.HOME = originalHome;
    blockedWindows.resolve(textResult(""));
    await resetRpClient();
    clearBinding();
    rmSync(tempHome, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("concurrent calls wait for lazy-connect recovery before dispatch", async () => {
  const harness = await createBlockedLazyRecoveryHarness();
  const pending = [];
  try {
    const rpTool = harness.pi.getTool("rp");
    pending.push(rpTool.execute(
      "read-connect",
      { call: "read_file", args: { path: "src/first.ts" } },
      undefined,
      undefined,
      harness.ctx,
    ));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.connectCalls, 1);

    pending.push(rpTool.execute(
      "read-concurrent",
      { call: "read_file", args: { path: "src/second.ts" } },
      undefined,
      undefined,
      harness.ctx,
    ));
    pending.push(rpTool.execute(
      "builder-concurrent",
      { call: "context_builder", args: { instructions: "Review it" } },
      undefined,
      undefined,
      harness.ctx,
    ));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(harness.forwardedCalls, []);

    harness.blockedWindows.resolve(textResult("- Window `7` • WS: repo • Roots: 1"));
    await Promise.all(pending);
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(harness.forwardedCalls.map(({ name }) => name).sort(), [
      "context_builder",
      "read_file",
      "read_file",
    ]);
    for (const call of harness.forwardedCalls) {
      assert.equal(call.args._windowID, 7);
      assert.equal(call.args.context_id, "TAB-1");
    }
  } finally {
    harness.blockedWindows.resolve(textResult(""));
    await Promise.allSettled(pending);
    await harness.cleanup();
  }
});

test("concurrent calls wait for reconnect recovery before dispatch", async () => {
  const harness = await createBlockedLazyRecoveryHarness();
  const pending = [];
  try {
    const rpTool = harness.pi.getTool("rp");
    const initialCall = rpTool.execute(
      "read-initial",
      { call: "read_file", args: { path: "src/initial.ts" } },
      undefined,
      undefined,
      harness.ctx,
    );
    pending.push(initialCall);
    await new Promise((resolve) => setImmediate(resolve));
    harness.blockedWindows.resolve(textResult("- Window `7` • WS: repo • Roots: 1"));
    await initialCall;
    const initialDispatchCount = harness.forwardedCalls.length;

    harness.blockNextWindowsCall();
    const reconnect = harness.pi.getCommand("rp").handler("reconnect", harness.ctx);
    pending.push(reconnect);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.connectCalls, 2);

    const waitingCall = rpTool.execute(
      "read-waiting",
      { call: "read_file", args: { path: "src/waiting.ts" } },
      undefined,
      undefined,
      harness.ctx,
    );
    pending.push(waitingCall);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.forwardedCalls.length, initialDispatchCount);

    harness.blockedWindows.resolve(textResult("- Window `7` • WS: repo • Roots: 1"));
    await Promise.all([reconnect, waitingCall]);
    assert.equal(harness.forwardedCalls.length, initialDispatchCount + 1);
  } finally {
    harness.blockedWindows.resolve(textResult(""));
    await Promise.allSettled(pending);
    await harness.cleanup();
  }
});

test("app-switch root recovery failures are reported", async () => {
  const harness = await createBlockedLazyRecoveryHarness({ failRootRecovery: true });
  const pending = [];
  try {
    const rpTool = harness.pi.getTool("rp");
    const initialCall = rpTool.execute(
      "read-initial",
      { call: "read_file", args: { path: "src/initial.ts" } },
      undefined,
      undefined,
      harness.ctx,
    );
    pending.push(initialCall);
    await new Promise((resolve) => setImmediate(resolve));
    harness.blockedWindows.resolve(textResult("- Window `7` • WS: repo • Roots: 1"));
    await initialCall;

    harness.pi.appendEntry(AUTO_SELECTION_ENTRY_TYPE, {
      app: "ce",
      windowId: 7,
      workspace: "repo",
      tab: "TAB-1",
      fullPaths: ["src/initial.ts"],
      slicePaths: [],
    });
    const notifications = [];
    harness.ctx.ui.notify = (message, level) => notifications.push({ message, level });
    harness.blockNextWindowsCall();

    const switchPromise = harness.pi.getCommand("rp").handler("app classic", harness.ctx);
    pending.push(switchPromise);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.connectCalls, 2);
    harness.blockedWindows.resolve(textResult("- Window `8` • WS: classic • Roots: 0"));
    await switchPromise;

    assert.ok(notifications.some(({ message, level }) => (
      level === "warning" && message.includes("handover failed: root lookup failed")
    )));
    assert.equal(notifications.some(({ message }) => message.includes("selected and bound")), false);
  } finally {
    harness.blockedWindows.resolve(textResult(""));
    await Promise.allSettled(pending);
    await harness.cleanup();
  }
});

test("Context Builder start aborts promptly during connection recovery", async () => {
  const harness = await createBlockedLazyRecoveryHarness();
  const controller = new AbortController();
  let startPromise;
  try {
    startPromise = harness.pi.getTool("rp").execute(
      "builder-abort-connection",
      { call: "context_builder", args: { instructions: "Review it" } },
      controller.signal,
      undefined,
      harness.ctx,
    );
    startPromise.catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.connectCalls, 1);

    controller.abort();
    await assert.rejects(settleWithin(startPromise), /\[context_builder_start_aborted\]/u);
    assert.deepEqual(harness.forwardedCalls, []);

    harness.blockedWindows.resolve(textResult("- Window `7` • WS: repo • Roots: 1"));
    const ordinary = await harness.pi.getTool("rp").execute(
      "read-after-abort",
      { call: "read_file", args: { path: "src/after.ts" } },
      undefined,
      undefined,
      harness.ctx,
    );
    assert.equal(ordinary.content[0].text, "called read_file");
    assert.deepEqual(harness.forwardedCalls.map(({ name }) => name), ["read_file"]);
  } finally {
    harness.blockedWindows.resolve(textResult(""));
    if (startPromise) {
      await Promise.allSettled([startPromise]);
    }
    await harness.cleanup();
  }
});

test("Context Builder start aborts promptly during tab recovery", async () => {
  const harness = await createBlockedLazyRecoveryHarness();
  const pending = [];
  try {
    const rpTool = harness.pi.getTool("rp");
    const initialCall = rpTool.execute(
      "read-initial",
      { call: "read_file", args: { path: "src/initial.ts" } },
      undefined,
      undefined,
      harness.ctx,
    );
    pending.push(initialCall);
    await new Promise((resolve) => setImmediate(resolve));
    harness.blockedWindows.resolve(textResult("- Window `7` • WS: repo • Roots: 1"));
    await initialCall;

    persistBinding(
      harness.pi,
      { app: "ce", windowId: 7, workspace: "repo" },
      { activeApp: "ce", apps: { ce: {} }, persistBinding: true },
    );
    harness.blockNextBindingCall();
    const controller = new AbortController();
    const startPromise = rpTool.execute(
      "builder-abort-tab",
      { call: "context_builder", args: { instructions: "Review it" } },
      controller.signal,
      undefined,
      harness.ctx,
    );
    pending.push(startPromise);
    startPromise.catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));

    controller.abort();
    await assert.rejects(settleWithin(startPromise), /\[context_builder_start_aborted\]/u);
    assert.equal(harness.forwardedCalls.some(({ name }) => name === "context_builder"), false);

    harness.blockedBinding.resolve(textResult("## Tabs ✅\n\n- `TAB-1` • Pi Session [bound]"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.forwardedCalls.some(({ name }) => name === "context_builder"), false);
  } finally {
    harness.blockedWindows.resolve(textResult(""));
    harness.blockedBinding?.resolve(textResult(""));
    await Promise.allSettled(pending);
    await harness.cleanup();
  }
});

test("Context Builder waits for startup recovery before dispatch", async () => {
  const launchWork = deferred();
  let launchCalls = 0;
  const harness = await createBlockedLazyRecoveryHarness({
    failInitialConnect: true,
    launchApp: async () => {
      launchCalls += 1;
      return launchWork.promise;
    },
  });
  let startPromise;
  try {
    await harness.pi.emit("session_start", harness.ctx);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.connectCalls, 1);
    assert.equal(launchCalls, 1);

    const rpTool = harness.pi.getTool("rp");
    startPromise = rpTool.execute(
      "builder-startup-recovery",
      { call: "context_builder", args: { instructions: "Review it" } },
      undefined,
      undefined,
      harness.ctx,
    );
    startPromise.catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.connectCalls, 1);
    assert.deepEqual(harness.forwardedCalls, []);

    launchWork.resolve(true);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.connectCalls, 2);
    assert.deepEqual(harness.forwardedCalls, []);

    harness.blockedWindows.resolve(textResult("- Window `7` • WS: repo • Roots: 1"));
    const started = await startPromise;
    const jobId = started.details.contextBuilderJob.jobId;
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(harness.forwardedCalls.map(({ name }) => name), ["context_builder"]);

    const completed = await rpTool.execute(
      "builder-startup-wait",
      { call: "context_builder_wait", args: { job_id: jobId } },
      undefined,
      undefined,
      harness.ctx,
    );
    assert.equal(completed.details.contextBuilderJob.status, "completed");
    assert.equal(completed.content[0].text, "called context_builder");
  } finally {
    launchWork.resolve(false);
    harness.blockedWindows.resolve(textResult(""));
    if (startPromise) {
      await Promise.allSettled([startPromise]);
    }
    await harness.cleanup();
  }
});

test("a recovery waiter revalidates after a failed reconnect", async () => {
  const harness = await createBlockedLazyRecoveryHarness({ failReconnect: true });
  const pending = [];
  try {
    const rpTool = harness.pi.getTool("rp");
    const connectingCall = rpTool.execute(
      "read-connect",
      { call: "read_file", args: { path: "src/first.ts" } },
      undefined,
      undefined,
      harness.ctx,
    );
    pending.push(connectingCall);
    connectingCall.catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));

    const waitingCall = rpTool.execute(
      "read-waiting",
      { call: "read_file", args: { path: "src/second.ts" } },
      undefined,
      undefined,
      harness.ctx,
    );
    pending.push(waitingCall);
    waitingCall.catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));

    await harness.pi.getCommand("rp").handler("reconnect", harness.ctx);
    harness.blockedWindows.resolve(textResult("- Window `7` • WS: repo • Roots: 1"));

    await assert.rejects(settleWithin(waitingCall), /not currently available/u);
    assert.equal(harness.connectCalls, 2);
    assert.deepEqual(harness.forwardedCalls, []);
  } finally {
    harness.blockedWindows.resolve(textResult(""));
    await Promise.allSettled(pending);
    await harness.cleanup();
  }
});

test("a superseded recovery waiter does not depend on the obsolete flight settling", async () => {
  const harness = await createBlockedLazyRecoveryHarness();
  const pending = [];
  try {
    const rpTool = harness.pi.getTool("rp");
    const connectingCall = rpTool.execute(
      "read-connect",
      { call: "read_file", args: { path: "src/first.ts" } },
      undefined,
      undefined,
      harness.ctx,
    );
    pending.push(connectingCall);
    connectingCall.catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));

    const waitingCall = rpTool.execute(
      "read-waiting",
      { call: "read_file", args: { path: "src/second.ts" } },
      undefined,
      undefined,
      harness.ctx,
    );
    pending.push(waitingCall);
    waitingCall.catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));

    await harness.pi.emit("session_shutdown", harness.ctx);
    await assert.rejects(settleWithin(waitingCall), /connection lifecycle superseded: session_shutdown/u);
    assert.deepEqual(harness.forwardedCalls, []);
  } finally {
    harness.blockedWindows.resolve(textResult(""));
    await Promise.allSettled(pending);
    await harness.cleanup();
  }
});

test("a call queued behind a failed reconnect observes the paused state", async () => {
  const originalHome = process.env.HOME;
  const tempHome = mkdtempSync(path.join(os.tmpdir(), "rp-paused-queue-home-"));
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "rp-paused-queue-root-"));
  const originalConnect = RpClient.prototype.connect;
  const originalClose = RpClient.prototype.close;
  const originalCallTool = RpClient.prototype.callTool;
  let connectCalls = 0;
  let blockedClose;

  process.env.HOME = tempHome;
  try {
    mkdirSync(path.join(tempHome, ".pi", "agent", "extensions"), { recursive: true });
    writeFileSync(
      path.join(tempHome, ".pi", "agent", "extensions", "repoprompt-mcp.json"),
      JSON.stringify({
        activeApp: "ce",
        apps: { ce: { command: "fake-rp", args: [] } },
        autoBindOnStart: false,
        autoSelectReadSlices: false,
      }),
    );
    await resetRpClient();
    clearBinding();

    RpClient.prototype.connect = async function connect() {
      connectCalls += 1;
      if (connectCalls > 1) {
        throw new Error("RepoPrompt is unavailable");
      }
      this.client = {};
      this.transport = {};
      this._status = "connected";
      this._tools = [
        { name: "read_file", description: "Read", inputSchema: { type: "object" } },
        { name: "list_windows", description: "List windows", inputSchema: { type: "object" } },
        { name: "bind_context", description: "Bind context", inputSchema: { type: "object" } },
      ];
      this.publishedToolListGeneration = 0;
      this.toolListInvalidationGeneration = 0;
    };
    RpClient.prototype.close = async function close() {
      if (blockedClose) {
        await blockedClose.promise;
      }
      this.client = null;
      this.transport = null;
      this._status = "disconnected";
      this._tools = [];
      this.publishedToolListGeneration = null;
    };
    RpClient.prototype.callTool = async function callTool(name, args = {}) {
      if (name === "list_windows") {
        return textResult("- Window `7` \u2022 WS: repo \u2022 Roots: 1");
      }
      if (name === "bind_context" && args.op === "list") {
        return textResult("## Tabs \u2705\n\n- `TAB-1` \u2022 Pi Session [bound]");
      }
      return textResult(`called ${name}`);
    };

    const pi = createMockPi();
    repopromptMcp(pi);
    persistBinding(
      pi,
      { app: "ce", windowId: 7, tab: "TAB-1", workspace: "repo" },
      { activeApp: "ce", apps: { ce: {} }, persistBinding: true },
    );
    const ctx = createContext(repoRoot, pi.entries);
    ctx.ui.notify = () => {};

    await pi.getTool("rp").execute(
      "read-initial",
      { call: "read_file", args: { path: "src/main.ts" } },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(connectCalls, 1);

    blockedClose = deferred();
    const reconnectPromise = pi.getCommand("rp").handler("reconnect", ctx);
    reconnectPromise.catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));

    // Queued while the reconnect still reports the extension as available
    const queuedCall = pi.getTool("rp").execute(
      "read-queued",
      { call: "read_file", args: { path: "src/other.ts" } },
      undefined,
      undefined,
      ctx,
    );
    const queuedRejection = assert.rejects(queuedCall, /not currently available/u);
    await new Promise((resolve) => setImmediate(resolve));

    blockedClose.resolve();
    await reconnectPromise;
    await queuedRejection;

    // The queued call must not have started a second connection of its own
    assert.equal(connectCalls, 2);
  } finally {
    RpClient.prototype.connect = originalConnect;
    RpClient.prototype.close = originalClose;
    RpClient.prototype.callTool = originalCallTool;
    process.env.HOME = originalHome;
    blockedClose?.resolve();
    await resetRpClient();
    clearBinding();
    rmSync(tempHome, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
