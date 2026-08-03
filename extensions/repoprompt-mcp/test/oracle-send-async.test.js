import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";

import repopromptMcp from "../dist/index.js";
import { clearBinding, persistBinding } from "../dist/binding.js";
import { getRpClient, RpClient, resetRpClient } from "../dist/client.js";
import { OracleSendJobManager } from "../dist/oracle-send-jobs.js";
import { SteeringWaitCoordinator } from "../dist/steerable-waits.js";

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

function registerRepoPromptMcp(pi, dependencies = {}) {
  const steeringWaitCoordinator = new SteeringWaitCoordinator();
  steeringWaitCoordinator.beginSession("session-id");
  pi.steeringWaitCoordinator = steeringWaitCoordinator;
  repopromptMcp(pi, { ...dependencies, steeringWaitCoordinator });
}

function createMockPi() {
  const handlers = new Map();
  const commands = new Map();
  const tools = new Map();
  const entries = [];
  return {
    events: { on() {}, emit() {} },
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
  const notifications = [];
  return {
    hasUI: false,
    cwd,
    ui: {
      notify(message, level) {
        notifications.push({ message, level });
      },
    },
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
    notifications,
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

function oracleSchema(modes = ["chat", "plan", "review"]) {
  return {
    type: "object",
    properties: {
      message: { type: "string" },
      mode: { type: "string", enum: modes },
      chat_id: { type: "string" },
      model: { type: "string" },
      new_chat: { type: "boolean" },
      export_response: { type: "boolean" },
    },
    required: ["message"],
  };
}

async function createHarness({
  activeApp = "ce",
  binding = { app: activeApp, windowId: 7, tab: "TAB-1", workspace: "repo" },
  tools,
  connect,
  callTool,
  resolveBackgroundWaitPolicy = () => ({ kind: "bounded", timeoutMs: 5 }),
} = {}) {
  const originalHome = process.env.HOME;
  const tempHome = mkdtempSync(path.join(os.tmpdir(), "rp-oracle-send-home-"));
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "rp-oracle-send-root-"));
  const originalConnect = RpClient.prototype.connect;
  const originalClose = RpClient.prototype.close;
  const originalCallTool = RpClient.prototype.callTool;
  const calls = [];
  let connectCalls = 0;
  const availableTools = tools ?? [{
    name: "oracle_send",
    description: "Consult Oracle",
    inputSchema: oracleSchema(activeApp === "classic" ? ["chat", "plan", "edit", "review"] : undefined),
  }];

  process.env.HOME = tempHome;
  mkdirSync(path.join(tempHome, ".pi", "agent", "extensions"), { recursive: true });
  const extensionConfigPath = path.join(tempHome, ".pi", "agent", "extensions", "repoprompt-mcp.json");
  const extensionConfig = {
    activeApp,
    apps: {
      ce: { command: "fake-rp", args: [] },
      classic: { command: "fake-rp-classic", args: [] },
    },
    autoBindOnStart: false,
    autoSelectReadSlices: false,
  };
  const writeExtensionConfig = (overrides = {}) => {
    writeFileSync(extensionConfigPath, JSON.stringify({ ...extensionConfig, ...overrides }));
  };
  writeExtensionConfig();
  await resetRpClient();
  clearBinding();

  RpClient.prototype.connect = async function connectClient(...args) {
    connectCalls += 1;
    if (connect) {
      await connect.call(this, ...args);
    }
    this.client = {};
    this.transport = {};
    this._status = "connected";
    this.toolListInvalidationGeneration = 0;
    this.publishedToolListGeneration = 0;
    this._tools = availableTools;
  };
  RpClient.prototype.close = async function closeClient() {
    this.client = null;
    this.transport = null;
    this._status = "disconnected";
    this._tools = [];
    this.publishedToolListGeneration = null;
  };
  RpClient.prototype.callTool = async function callToolClient(name, args = {}, _timeout, signal) {
    calls.push({ name, args, signal });
    if (callTool) {
      return callTool({ name, args, signal, calls });
    }
    return textResult(`called ${name}`);
  };

  const pi = createMockPi();
  let nextId = 1;
  const oracleSendJobs = new OracleSendJobManager({
    createJobId: () => `oracle_integration_${nextId++}`,
    warn: () => {},
  });
  registerRepoPromptMcp(pi, { oracleSendJobs, resolveBackgroundWaitPolicy });
  const config = { activeApp, apps: { [activeApp]: {} }, persistBinding: true };
  if (binding) {
    persistBinding(pi, binding, config);
  }
  const ctx = createContext(repoRoot, pi.entries);

  return {
    calls,
    ctx,
    get connectCalls() {
      return connectCalls;
    },
    pi,
    rpTool: pi.getTool("rp"),
    config,
    writeExtensionConfig,
    async cleanup() {
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

test("rp starts waits and consumes one Oracle request without losing result content", async () => {
  const oracleWork = deferred();
  let oracleCalls = 0;
  const harness = await createHarness({
    callTool: ({ name }) => {
      if (name !== "oracle_send") throw new Error(`Unexpected tool: ${name}`);
      oracleCalls += 1;
      return oracleWork.promise;
    },
  });

  try {
    await expectRpError(
      harness.rpTool.execute(
        "wait-before-connect",
        { call: "oracle_send_wait", args: { job_id: "oracle_unknown" }, describe: "oracle_send" },
        undefined,
        undefined,
        harness.ctx,
      ),
      "oracle_send_job_not_found",
    );
    assert.equal(harness.connectCalls, 0);

    const startController = new AbortController();
    const start = await settleWithin(harness.rpTool.execute(
      "oracle-1",
      {
        call: "oracle_send",
        args: {
          message: "Review this",
          mode: "review",
          chat_id: "chat-1",
          model: "Review",
          new_chat: false,
          export_response: true,
          _windowID: 999,
        },
      },
      startController.signal,
      undefined,
      harness.ctx,
    ));

    assert.match(start.content[0].text, /oracle_send_wait/u);
    assert.equal(start.details.oracleSendJob.jobId, "oracle_integration_1");
    assert.equal(start.details.oracleSendJob.status, "running");
    assert.deepEqual(start.details.oracleSendJob.target, { app: "ce", windowId: 7, tab: "TAB-1" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(oracleCalls, 1);
    assert.deepEqual(harness.calls[0].args, {
      message: "Review this",
      mode: "review",
      chat_id: "chat-1",
      model: "Review",
      new_chat: false,
      export_response: true,
      _windowID: 7,
      context_id: "TAB-1",
    });
    assert.ok(harness.calls[0].signal instanceof AbortSignal);
    startController.abort();
    assert.equal(harness.calls[0].signal.aborted, false);

    await expectRpError(
      harness.rpTool.execute(
        "oracle-duplicate",
        { call: "oracle_send", args: { message: "Again", mode: "chat" } },
        undefined,
        undefined,
        harness.ctx,
      ),
      "oracle_send_already_running",
    );
    assert.equal(oracleCalls, 1);

    const running = await harness.rpTool.execute(
      "oracle-wait-running",
      { call: "oracle_send_wait", args: { job_id: "oracle_integration_1" } },
      undefined,
      undefined,
      harness.ctx,
    );
    assert.equal(running.details.oracleSendJob.status, "running");
    assert.equal(oracleCalls, 1);

    oracleWork.resolve({
      content: [
        { type: "text", text: "Ship" },
        { type: "image", data: "abc", mimeType: "image/png" },
        { type: "resource", resource: { uri: "file:///tmp/review.md", text: "exported" } },
      ],
      isError: false,
    });
    const completed = await harness.rpTool.execute(
      "oracle-wait-completed",
      { call: "oracle_send_wait", args: { job_id: "oracle_integration_1" } },
      undefined,
      undefined,
      harness.ctx,
    );
    assert.equal(completed.details.oracleSendJob.status, "completed");
    assert.equal(completed.details.tool, "oracle_send");
    assert.deepEqual(completed.content, [
      { type: "text", text: "Ship" },
      { type: "image", data: "abc", mimeType: "image/png" },
      {
        type: "text",
        text: JSON.stringify({ type: "resource", resource: { uri: "file:///tmp/review.md", text: "exported" } }),
      },
    ]);
    assert.equal(oracleCalls, 1);
    await expectRpError(
      harness.rpTool.execute(
        "oracle-wait-consumed",
        { call: "oracle_send_wait", args: { job_id: "oracle_integration_1" } },
        undefined,
        undefined,
        harness.ctx,
      ),
      "oracle_send_job_consumed",
    );
  } finally {
    oracleWork.resolve(textResult("cleanup"));
    await harness.cleanup();
  }
});

test("rp reloads Oracle wait policy config without resending retained work", async () => {
  const originalCacheRetention = process.env.PI_CACHE_RETENTION;
  process.env.PI_CACHE_RETENTION = "long";
  const oracleWork = deferred();
  const policyInputs = [];
  let oracleSignal;
  const harness = await createHarness({
    callTool: ({ signal }) => {
      oracleSignal = signal;
      return oracleWork.promise;
    },
    resolveBackgroundWaitPolicy: (input) => {
      policyInputs.push(structuredClone(input));
      return input.heartbeatEnabled
        ? { kind: "bounded", timeoutMs: 5 }
        : { kind: "until_settled" };
    },
  });

  try {
    harness.ctx.model = {
      provider: "openai",
      api: "openai-responses",
      id: "gpt-5.6-sol",
      baseUrl: "https://api.openai.com/v1",
    };
    const started = await harness.rpTool.execute(
      "oracle-indefinite-start",
      { call: "oracle_send", args: { message: "Review", mode: "review" } },
      undefined,
      undefined,
      harness.ctx,
    );
    await new Promise((resolve) => setImmediate(resolve));

    const running = await harness.rpTool.execute(
      "oracle-bounded-running",
      { call: "oracle_send_wait", args: { job_id: started.details.oracleSendJob.jobId } },
      undefined,
      undefined,
      harness.ctx,
    );
    assert.equal(running.details.oracleSendJob.status, "running");
    assert.equal(oracleSignal.aborted, false);
    assert.deepEqual(policyInputs.at(-1), {
      heartbeatEnabled: true,
      cacheTtlMsByModel: {},
      model: harness.ctx.model,
      processCacheRetention: "long",
    });

    harness.writeExtensionConfig({
      backgroundWaitHeartbeatEnabled: false,
      backgroundWaitCacheTtlMsByModel: { "anthropic/*": 420_000 },
    });
    const connectsBeforeConfigReloadWait = harness.connectCalls;
    harness.ctx.model = {
      provider: "anthropic",
      api: "anthropic-messages",
      id: "claude-sonnet-4-5",
      baseUrl: "https://api.anthropic.com",
    };
    let settled = false;
    const completionWait = harness.rpTool.execute(
      "oracle-indefinite-complete",
      { call: "oracle_send_wait", args: { job_id: started.details.oracleSendJob.jobId } },
      undefined,
      undefined,
      harness.ctx,
    ).finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    assert.deepEqual(policyInputs.at(-1), {
      heartbeatEnabled: false,
      cacheTtlMsByModel: { "anthropic/*": 420_000 },
      model: harness.ctx.model,
      processCacheRetention: "long",
    });
    assert.equal(harness.connectCalls, connectsBeforeConfigReloadWait);

    oracleWork.resolve(textResult("done"));
    assert.equal((await completionWait).content[0].text, "done");
    assert.equal(harness.calls.filter((call) => call.name === "oracle_send").length, 1);
  } finally {
    oracleWork.resolve(textResult("cleanup"));
    if (originalCacheRetention === undefined) {
      delete process.env.PI_CACHE_RETENTION;
    } else {
      process.env.PI_CACHE_RETENTION = originalCacheRetention;
    }
    await harness.cleanup();
  }
});

test("rp preserves Oracle MCP errors and rejected call_failed responses once", async () => {
  let call = 0;
  const malformedResults = [
    undefined,
    { content: [null], isError: false },
    { content: [{ type: "text" }], isError: false },
    { content: [{ type: "image", data: 42, mimeType: "image/png" }], isError: false },
    { content: new Array(1), isError: false },
    { content: [{ type: "resource", resource: { uri: "file:///missing-payload" } }], isError: false },
    { content: [{ type: "unsupported_content", payload: "value" }], isError: false },
  ];
  const harness = await createHarness({
    callTool: () => {
      call += 1;
      if (call === 1) {
        return { content: [{ type: "text", text: "Oracle MCP error" }], isError: true };
      }
      if (call === 2) {
        throw new Error("provider rejected");
      }
      return malformedResults[call - 3];
    },
  });

  try {
    const mcpStart = await harness.rpTool.execute(
      "oracle-mcp-error",
      { call: "oracle_send", args: { message: "First", mode: "chat" } },
      undefined,
      undefined,
      harness.ctx,
    );
    const mcpResult = await harness.rpTool.execute(
      "oracle-mcp-error-wait",
      { call: "oracle_send_wait", args: { job_id: mcpStart.details.oracleSendJob.jobId } },
      undefined,
      undefined,
      harness.ctx,
    );
    assert.equal(mcpResult.isError, true);
    assert.equal(mcpResult.content[0].text, "Oracle MCP error");

    const rejectedStart = await harness.rpTool.execute(
      "oracle-rejected",
      { call: "oracle_send", args: { message: "Second", mode: "plan" } },
      undefined,
      undefined,
      harness.ctx,
    );
    const rejected = await harness.rpTool.execute(
      "oracle-rejected-wait",
      { call: "oracle_send_wait", args: { job_id: rejectedStart.details.oracleSendJob.jobId } },
      undefined,
      undefined,
      harness.ctx,
    );
    assert.equal(rejected.isError, true);
    assert.equal(rejected.details.error, "call_failed");
    assert.equal(rejected.details.oracleSendJob.status, "failed");
    assert.match(rejected.content[0].text, /^Failed to call oracle_send: provider rejected/u);
    assert.match(rejected.content[0].text, /Expected parameters:/u);
    await expectRpError(
      harness.rpTool.execute(
        "oracle-rejected-consumed",
        { call: "oracle_send_wait", args: { job_id: rejectedStart.details.oracleSendJob.jobId } },
        undefined,
        undefined,
        harness.ctx,
      ),
      "oracle_send_job_consumed",
    );

    for (const [index] of malformedResults.entries()) {
      const malformedStart = await harness.rpTool.execute(
        `oracle-malformed-${index}`,
        { call: "oracle_send", args: { message: `Malformed ${index}` } },
        undefined,
        undefined,
        harness.ctx,
      );
      const malformed = await harness.rpTool.execute(
        `oracle-malformed-${index}-wait`,
        { call: "oracle_send_wait", args: { job_id: malformedStart.details.oracleSendJob.jobId } },
        undefined,
        undefined,
        harness.ctx,
      );
      assert.equal(malformed.isError, true);
      assert.equal(malformed.details.error, "call_failed");
      assert.equal(malformed.details.oracleSendJob.status, "failed");
      assert.match(malformed.content[0].text, /Oracle send runner returned an invalid MCP tool result/u);
      assert.match(malformed.content[0].text, /Expected parameters:/u);
      await expectRpError(
        harness.rpTool.execute(
          `oracle-malformed-${index}-consumed`,
          { call: "oracle_send_wait", args: { job_id: malformedStart.details.oracleSendJob.jobId } },
          undefined,
          undefined,
          harness.ctx,
        ),
        "oracle_send_job_consumed",
      );
    }
  } finally {
    await harness.cleanup();
  }
});

test("rp starts omitted chat plan and review Oracle modes asynchronously", async () => {
  const cases = [
    { message: "Omitted" },
    { message: "Chat", mode: "chat" },
    { message: "Plan", mode: "plan" },
    { message: "Review", mode: "review" },
  ];
  const workByMessage = new Map(cases.map(({ message }) => [message, deferred()]));
  const harness = await createHarness({
    callTool: ({ args }) => workByMessage.get(args.message).promise,
  });

  try {
    for (const oracleCase of cases) {
      const start = await settleWithin(harness.rpTool.execute(
        `oracle-${oracleCase.message}`,
        { call: "oracle_send", args: oracleCase },
        undefined,
        undefined,
        harness.ctx,
      ));
      assert.equal(start.details.oracleSendJob.status, "running");
      const forwarded = harness.calls.at(-1).args;
      assert.equal(forwarded.message, oracleCase.message);
      if (oracleCase.mode === undefined) {
        assert.equal("mode" in forwarded, false);
      } else {
        assert.equal(forwarded.mode, oracleCase.mode);
      }
      workByMessage.get(oracleCase.message).resolve(textResult(oracleCase.message));
      const completed = await harness.rpTool.execute(
        `oracle-${oracleCase.message}-wait`,
        { call: "oracle_send_wait", args: { job_id: start.details.oracleSendJob.jobId } },
        undefined,
        undefined,
        harness.ctx,
      );
      assert.equal(completed.content[0].text, oracleCase.message);
    }
    assert.equal(harness.calls.length, cases.length);
  } finally {
    for (const work of workByMessage.values()) {
      work.resolve(textResult("cleanup"));
    }
    await harness.cleanup();
  }
});

test("rp Oracle jobs are per-tab mode-agnostic and separate from Context Builder", async () => {
  const workByTab = new Map([
    ["TAB-1", deferred()],
    ["TAB-2", deferred()],
  ]);
  const harness = await createHarness({
    activeApp: "classic",
    tools: [
      {
        name: "RepoPrompt_oracle_send",
        description: "Consult Oracle",
        inputSchema: oracleSchema(["chat", "plan", "edit", "review"]),
      },
      { name: "context_builder", description: "Build context", inputSchema: { type: "object" } },
    ],
    callTool: ({ name, args }) => {
      if (name === "context_builder") return textResult("builder");
      return workByTab.get(args.context_id).promise;
    },
  });

  try {
    const editStart = await harness.rpTool.execute(
      "classic-edit",
      { call: "oracle_send", args: { message: "Edit", mode: "edit" } },
      undefined,
      undefined,
      harness.ctx,
    );
    assert.equal(editStart.details.tool, "RepoPrompt_oracle_send");

    const builderStart = await harness.rpTool.execute(
      "builder-same-tab",
      { call: "context_builder", args: { instructions: "Plan" } },
      undefined,
      undefined,
      harness.ctx,
    );
    assert.equal(builderStart.details.contextBuilderJob.status, "running");

    persistBinding(
      harness.pi,
      { app: "classic", windowId: 7, tab: "TAB-2", workspace: "repo" },
      harness.config,
    );
    const secondTab = await harness.rpTool.execute(
      "oracle-tab-2",
      { call: "oracle_send", args: { message: "Review", mode: "review" } },
      undefined,
      undefined,
      harness.ctx,
    );
    assert.equal(secondTab.details.oracleSendJob.status, "running");
    assert.notEqual(secondTab.details.oracleSendJob.jobId, editStart.details.oracleSendJob.jobId);
  } finally {
    workByTab.get("TAB-1").resolve(textResult("tab 1"));
    workByTab.get("TAB-2").resolve(textResult("tab 2"));
    await harness.cleanup();
  }
});

test("rp discovery preserves Oracle schema and shadows server wait tools", async () => {
  const schema = oracleSchema();
  const harness = await createHarness({
    tools: [
      { name: "oracle_send", description: "Consult Oracle", inputSchema: schema },
      { name: "RepoPrompt_oracle_send_wait", description: "Server wait", inputSchema: { type: "string" } },
    ],
  });

  try {
    const described = await harness.rpTool.execute(
      "describe-oracle",
      { describe: "oracle_send" },
      undefined,
      undefined,
      harness.ctx,
    );
    assert.match(described.content[0].text, /starts every generic Oracle send asynchronously/u);
    assert.deepEqual(described.details.tool.inputSchema, schema);

    const waitSearch = await harness.rpTool.execute(
      "search-wait",
      { search: "oracle_send_wait" },
      undefined,
      undefined,
      harness.ctx,
    );
    assert.equal(waitSearch.details.matches.filter((name) => name === "oracle_send_wait").length, 1);
    assert.match(waitSearch.content[0].text, /prompt-cache deadline/u);
    assert.match(waitSearch.content[0].text, /next action/u);
    assert.doesNotMatch(waitSearch.content[0].text, /210 seconds/u);
    assert.doesNotMatch(waitSearch.content[0].text, /Server wait/u);

    const client = getRpClient();
    client.toolListInvalidationGeneration += 1;
    const localWait = await harness.rpTool.execute(
      "describe-local-stale",
      { describe: "oracle_send_wait" },
      undefined,
      undefined,
      harness.ctx,
    );
    assert.doesNotMatch(localWait.content[0].text, /catalog is stale/u);
    assert.match(localWait.content[0].text, /Reconnects, app switches, extension reloads, and session shutdown/u);
    const localBuilderWait = await harness.rpTool.execute(
      "describe-builder-wait-stale",
      { describe: "context_builder_wait" },
      undefined,
      undefined,
      harness.ctx,
    );
    assert.doesNotMatch(localBuilderWait.content[0].text, /catalog is stale/u);
    assert.doesNotMatch(localBuilderWait.content[0].text, /Other RepoPrompt tools remain synchronous/u);
    assert.match(
      localBuilderWait.content[0].text,
      /Reconnects, app switches, extension reloads, and session shutdown/u,
    );
    const staleOracle = await harness.rpTool.execute(
      "describe-oracle-stale",
      { describe: "oracle_send" },
      undefined,
      undefined,
      harness.ctx,
    );
    assert.match(staleOracle.content[0].text, /catalog is stale/u);
  } finally {
    await harness.cleanup();
  }
});

test("rp lazy same-app reconnection resets the Oracle job epoch", async () => {
  const oldWork = deferred();
  const newWork = deferred();
  let oldSignal;
  let call = 0;
  const harness = await createHarness({
    callTool: ({ signal }) => {
      call += 1;
      if (call === 1) {
        oldSignal = signal;
        return oldWork.promise;
      }
      return newWork.promise;
    },
  });

  try {
    const oldStart = await harness.rpTool.execute(
      "oracle-before-lazy-reconnect",
      { call: "oracle_send", args: { message: "Old", mode: "review" } },
      undefined,
      undefined,
      harness.ctx,
    );
    await new Promise((resolve) => setImmediate(resolve));
    getRpClient()._status = "error";

    const newStart = await harness.rpTool.execute(
      "oracle-after-lazy-reconnect",
      { call: "oracle_send", args: { message: "New", mode: "review" } },
      undefined,
      undefined,
      harness.ctx,
    );
    assert.equal(oldSignal.aborted, true);
    assert.equal(harness.calls.length, 2);
    assert.notEqual(newStart.details.oracleSendJob.jobId, oldStart.details.oracleSendJob.jobId);
    await expectRpError(
      harness.rpTool.execute(
        "oracle-old-after-lazy-reconnect",
        { call: "oracle_send_wait", args: { job_id: oldStart.details.oracleSendJob.jobId } },
        undefined,
        undefined,
        harness.ctx,
      ),
      "oracle_send_job_not_found",
    );

    oldWork.resolve(textResult("late old result"));
    newWork.resolve(textResult("new result"));
    const completed = await harness.rpTool.execute(
      "oracle-new-after-lazy-reconnect",
      { call: "oracle_send_wait", args: { job_id: newStart.details.oracleSendJob.jobId } },
      undefined,
      undefined,
      harness.ctx,
    );
    assert.equal(completed.content[0].text, "new result");
  } finally {
    oldWork.resolve(textResult("cleanup"));
    newWork.resolve(textResult("cleanup"));
    await harness.cleanup();
  }
});

test("rp Oracle start abort during connection recovery prevents dispatch", async () => {
  const connectWork = deferred();
  const harness = await createHarness({
    connect: () => connectWork.promise,
    callTool: () => textResult("unexpected"),
  });

  try {
    const controller = new AbortController();
    const start = harness.rpTool.execute(
      "oracle-abort-connect",
      { call: "oracle_send", args: { message: "Review", mode: "review" } },
      controller.signal,
      undefined,
      harness.ctx,
    );
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await expectRpError(settleWithin(start), "oracle_send_start_aborted");
    assert.equal(harness.calls.length, 0);
    connectWork.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.calls.length, 0);
  } finally {
    connectWork.resolve();
    await harness.cleanup();
  }
});

test("rp snapshots Oracle invocation before connection recovery", async () => {
  const connectWork = deferred();
  const harness = await createHarness({
    connect: () => connectWork.promise,
    callTool: () => textResult("done"),
  });
  const params = {
    call: "oracle_send",
    args: { message: "Original", mode: "review", options: { paths: ["src/original.ts"] } },
  };

  try {
    const startPromise = harness.rpTool.execute(
      "oracle-snapshot-connect",
      params,
      undefined,
      undefined,
      harness.ctx,
    );
    await new Promise((resolve) => setImmediate(resolve));
    params.call = "read_file";
    params.args.message = "Mutated";
    params.args.options.paths.push("src/mutated.ts");
    connectWork.resolve();

    const started = await startPromise;
    assert.equal(started.details.tool, "oracle_send");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(harness.calls[0].args, {
      message: "Original",
      mode: "review",
      options: { paths: ["src/original.ts"] },
      _windowID: 7,
      context_id: "TAB-1",
    });
  } finally {
    connectWork.resolve();
    await harness.cleanup();
  }
});

test("rp Oracle start abort during tab recovery preserves the Oracle abort code", async () => {
  const windowsWork = deferred();
  const bindingWork = deferred();
  let blockBinding = false;
  const harness = await createHarness({
    tools: [
      { name: "oracle_send", description: "Consult Oracle", inputSchema: oracleSchema() },
      { name: "read_file", description: "Read", inputSchema: { type: "object" } },
      { name: "list_windows", description: "List windows", inputSchema: { type: "object" } },
      { name: "bind_context", description: "Bind context", inputSchema: { type: "object" } },
      { name: "manage_workspaces", description: "Manage workspaces", inputSchema: { type: "object" } },
      { name: "get_file_tree", description: "Get tree", inputSchema: { type: "object" } },
    ],
    callTool: ({ name, args }) => {
      if (name === "list_windows") return windowsWork.promise;
      if (name === "bind_context" && args.op === "list" && blockBinding) return bindingWork.promise;
      return textResult(`called ${name}`);
    },
  });

  try {
    const initialRead = harness.rpTool.execute(
      "oracle-tab-initial-read",
      { call: "read_file", args: { path: "src/initial.ts" } },
      undefined,
      undefined,
      harness.ctx,
    );
    await new Promise((resolve) => setImmediate(resolve));
    windowsWork.resolve(textResult("- Window `7` • WS: repo • Roots: 1"));
    await initialRead;
    persistBinding(
      harness.pi,
      { app: "ce", windowId: 7, workspace: "repo" },
      harness.config,
    );
    blockBinding = true;

    const controller = new AbortController();
    const start = harness.rpTool.execute(
      "oracle-abort-tab",
      { call: "oracle_send", args: { message: "Review", mode: "review" } },
      controller.signal,
      undefined,
      harness.ctx,
    );
    start.catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await expectRpError(settleWithin(start), "oracle_send_start_aborted");
    bindingWork.resolve(textResult("## Tabs ✅\n\n- `TAB-1` • Pi Session [bound]"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.calls.filter((call) => call.name === "oracle_send").length, 0);
  } finally {
    bindingWork.resolve(textResult("## Tabs ✅"));
    await harness.cleanup();
  }
});

test("rp snapshots Oracle catalog identity before tab recovery", async () => {
  const bindingWork = deferred();
  let blockBinding = false;
  const oracleTool = { name: "oracle_send", description: "Consult Oracle", inputSchema: oracleSchema() };
  const harness = await createHarness({
    tools: [
      oracleTool,
      { name: "list_windows", description: "List windows", inputSchema: { type: "object" } },
      { name: "bind_context", description: "Bind context", inputSchema: { type: "object" } },
      { name: "manage_workspaces", description: "Manage workspaces", inputSchema: { type: "object" } },
      { name: "get_file_tree", description: "Get tree", inputSchema: { type: "object" } },
    ],
    callTool: ({ name, args }) => {
      if (name === "list_windows") return textResult("- Window `7` • WS: repo • Roots: 1");
      if (name === "bind_context" && args.op === "list" && blockBinding) return bindingWork.promise;
      if (name === "bind_context" && args.op === "bind") {
        return textResult(`Selected tab \`${args.context_id}\``);
      }
      if (name === "manage_workspaces" && args.action === "create_tab") {
        return textResult("Created tab `TAB-NEW` • Pi Session [bound]");
      }
      if (name === "oracle_send") throw new Error("provider rejected");
      return textResult(`called ${name}`);
    },
  });

  try {
    await harness.rpTool.execute(
      "oracle-connect-before-catalog-snapshot",
      { describe: "oracle_send" },
      undefined,
      undefined,
      harness.ctx,
    );
    persistBinding(
      harness.pi,
      { app: "ce", windowId: 7, workspace: "repo" },
      harness.config,
    );
    blockBinding = true;

    const startPromise = harness.rpTool.execute(
      "oracle-catalog-snapshot",
      { call: "oracle_send", args: { message: "Review", mode: "review" } },
      undefined,
      undefined,
      harness.ctx,
    );
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    oracleTool.name = "mutated_oracle_send";
    oracleTool.inputSchema = {
      type: "object",
      properties: { mutated_field: { type: "string" } },
      required: ["mutated_field"],
    };
    bindingWork.resolve(textResult("## Tabs ✅\n\n- `TAB-1` • Pi Session [bound]"));

    const started = await startPromise;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.calls.filter((call) => call.name === "oracle_send").length, 1);
    const failed = await harness.rpTool.execute(
      "oracle-catalog-snapshot-wait",
      { call: "oracle_send_wait", args: { job_id: started.details.oracleSendJob.jobId } },
      undefined,
      undefined,
      harness.ctx,
    );
    assert.match(failed.content[0].text, /chat_id/u);
    assert.doesNotMatch(failed.content[0].text, /mutated_field/u);
  } finally {
    bindingWork.resolve(textResult("## Tabs ✅"));
    await harness.cleanup();
  }
});

test("rp lifecycle reset during failing tab recovery reports start cancellation", async () => {
  const bindingWork = deferred();
  let blockBinding = false;
  const harness = await createHarness({
    tools: [
      { name: "oracle_send", description: "Consult Oracle", inputSchema: oracleSchema() },
      { name: "list_windows", description: "List windows", inputSchema: { type: "object" } },
      { name: "bind_context", description: "Bind context", inputSchema: { type: "object" } },
      { name: "manage_workspaces", description: "Manage workspaces", inputSchema: { type: "object" } },
      { name: "get_file_tree", description: "Get tree", inputSchema: { type: "object" } },
    ],
    callTool: ({ name, args }) => {
      if (name === "list_windows") return textResult("- Window `7` • WS: repo • Roots: 1");
      if (name === "bind_context" && args.op === "list" && blockBinding) return bindingWork.promise;
      return textResult(`called ${name}`);
    },
  });

  try {
    await harness.rpTool.execute(
      "oracle-connect-before-failing-tab-recovery",
      { describe: "oracle_send" },
      undefined,
      undefined,
      harness.ctx,
    );
    persistBinding(
      harness.pi,
      { app: "ce", windowId: 7, workspace: "repo" },
      harness.config,
    );
    blockBinding = true;

    const start = harness.rpTool.execute(
      "oracle-reset-failing-tab-recovery",
      { call: "oracle_send", args: { message: "Review", mode: "review" } },
      undefined,
      undefined,
      harness.ctx,
    );
    start.catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    await harness.pi.emit("session_shutdown", harness.ctx);
    bindingWork.reject(new Error("binding unavailable after reset"));

    await expectRpError(settleWithin(start), "oracle_send_start_cancelled");
    assert.equal(harness.calls.filter((call) => call.name === "oracle_send").length, 0);
  } finally {
    bindingWork.resolve(textResult("## Tabs ✅"));
    await harness.cleanup();
  }
});

test("rp lifecycle reset aborts Oracle work and invalidates its job ID", async () => {
  const oracleWork = deferred();
  let oracleSignal;
  const harness = await createHarness({
    callTool: ({ signal }) => {
      oracleSignal = signal;
      return oracleWork.promise;
    },
    resolveBackgroundWaitPolicy: () => ({ kind: "until_settled" }),
  });

  try {
    const start = await harness.rpTool.execute(
      "oracle-reset",
      { call: "oracle_send", args: { message: "Review", mode: "review" } },
      undefined,
      undefined,
      harness.ctx,
    );
    await new Promise((resolve) => setImmediate(resolve));
    const waiting = harness.rpTool.execute(
      "oracle-reset-wait",
      { call: "oracle_send_wait", args: { job_id: start.details.oracleSendJob.jobId } },
      undefined,
      undefined,
      harness.ctx,
    );

    await harness.pi.emit("session_shutdown", harness.ctx);
    assert.equal(oracleSignal.aborted, true);
    await expectRpError(waiting, "oracle_send_job_cancelled");
    harness.pi.steeringWaitCoordinator.beginSession("session-id");
    await expectRpError(
      harness.rpTool.execute(
        "oracle-after-reset",
        { call: "oracle_send_wait", args: { job_id: start.details.oracleSendJob.jobId } },
        undefined,
        undefined,
        harness.ctx,
      ),
      "oracle_send_job_not_found",
    );
  } finally {
    oracleWork.resolve(textResult("late"));
    await harness.cleanup();
  }
});

test("slash rp oracle remains synchronous and does not expose a job ID", async () => {
  const oracleWork = deferred();
  const harness = await createHarness({ callTool: () => oracleWork.promise });

  try {
    const commandPromise = harness.pi.getCommand("rp").handler("oracle --mode plan Review this", harness.ctx);
    let settled = false;
    void commandPromise.then(() => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    oracleWork.resolve(textResult("command result"));
    await commandPromise;
    assert.equal(harness.ctx.notifications.some(({ message }) => /command result/u.test(message)), true);
    assert.equal(harness.ctx.notifications.some(({ message }) => /oracle_/u.test(message)), false);
  } finally {
    oracleWork.resolve(textResult("cleanup"));
    await harness.cleanup();
  }
});
