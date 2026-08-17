import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import repopromptMcp from "../dist/index.js";
import { clearBinding } from "../dist/binding.js";
import { RpClient, resetRpClient } from "../dist/client.js";
import { ContextBuilderJobManager } from "../dist/context-builder-jobs.js";
import { OracleSendJobManager } from "../dist/oracle-send-jobs.js";
import { catalog as ceCatalog } from "./fixtures/ce-1.2/evidence.js";
import {
  catalog as classicCatalog,
  inventoryScenarios as classicInventoryScenarios,
} from "./fixtures/classic-2.1.32/evidence.js";
import {
  QUEUE_STEER_ACCEPTED_EVENT,
  SteeringWaitCoordinator,
} from "../dist/steerable-waits.js";

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

function createHarness() {
  const handlers = new Map();
  const eventHandlers = new Map();
  const tools = new Map();
  let pendingMessages = false;
  const context = {
    hasUI: false,
    cwd: "/tmp/steerable-waits-integration",
    ui: { notify() {}, setStatus() {} },
    hasPendingMessages: () => pendingMessages,
    sessionManager: {
      getBranch: () => [],
      getSessionFile: () => "/tmp/steerable-waits-integration/session.jsonl",
      getSessionId: () => "pi-session-integration",
      getLeafId: () => "leaf-integration",
    },
  };
  const pi = {
    events: {
      on(channel, handler) {
        const registered = eventHandlers.get(channel) ?? [];
        registered.push(handler);
        eventHandlers.set(channel, registered);
      },
      emit(channel, payload) {
        for (const handler of eventHandlers.get(channel) ?? []) handler(payload);
      },
    },
    on(event, handler) {
      const registered = handlers.get(event) ?? [];
      registered.push(handler);
      handlers.set(event, registered);
    },
    registerCommand() {},
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    appendEntry() {},
  };
  return {
    context,
    pi,
    get rpTool() {
      return tools.get("rp");
    },
    addQueueInputHandler(before) {
      const queueHandler = () => {
        pi.events.emit(QUEUE_STEER_ACCEPTED_EVENT, {
          version: 1,
          producer: "pi-queue-steer",
          producerEpochId: "composed-epoch",
          sessionId: "pi-session-integration",
          sequence: 1,
        });
        return { action: "handled" };
      };
      const registered = handlers.get("input") ?? [];
      handlers.set("input", before ? [queueHandler, ...registered] : [...registered, queueHandler]);
    },
    async dispatchInteractiveSteer() {
      for (const handler of handlers.get("input") ?? []) {
        const result = await handler({
          source: "interactive",
          streamingBehavior: "steer",
          text: "private composed steering",
        }, context);
        if (result.action === "handled") break;
      }
    },
    emitAcceptedQueueSteer(sequence = 1) {
      pi.events.emit(QUEUE_STEER_ACCEPTED_EVENT, {
        version: 1,
        producer: "pi-queue-steer",
        producerEpochId: "integration-epoch",
        sessionId: "pi-session-integration",
        sequence,
      });
    },
    async emitStockSteer(text) {
      pendingMessages = false;
      for (const handler of handlers.get("input") ?? []) {
        const result = await handler({
          source: "interactive",
          streamingBehavior: "steer",
          text,
          images: [{ type: "image", data: "private-image", mimeType: "image/png" }],
        }, context);
        assert.equal(result.action, "continue");
      }
      pendingMessages = true;
    },
  };
}

function descriptor(toolName) {
  return {
    target: { app: "ce", windowId: 4, tab: "TAB-1" },
    toolName,
    userArgs: toolName === "context_builder" ? { instructions: "Plan it" } : { message: "Review it" },
    toolCatalogFreshness: "fresh",
    ...(toolName === "oracle_send" ? { toolInputSchema: { type: "object" } } : {}),
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

test("queue-backed steering releases the same wait in both input-handler orders", async () => {
  for (const queueHandlerFirst of [true, false]) {
    const harness = createHarness();
    const coordinator = new SteeringWaitCoordinator();
    const work = deferred();
    let jobSignal;
    const contextBuilderJobs = new ContextBuilderJobManager({
      createJobId: () => `cb-order-${queueHandlerFirst ? "first" : "last"}`,
      warn: () => {},
    });
    repopromptMcp(harness.pi, {
      steeringWaitCoordinator: coordinator,
      contextBuilderJobs,
      resolveBackgroundWaitPolicy: () => ({ kind: "until_settled" }),
    });
    coordinator.beginSession("pi-session-integration");
    harness.addQueueInputHandler(queueHandlerFirst);
    const job = contextBuilderJobs.start({
      descriptor: descriptor("context_builder"),
      run: (signal) => {
        jobSignal = signal;
        return work.promise;
      },
    });
    const wait = harness.rpTool.execute(
      `wait-order-${queueHandlerFirst}`,
      { call: "context_builder_wait", args: { job_id: job.jobId } },
      undefined,
      undefined,
      harness.context,
    );
    await new Promise((resolve) => setImmediate(resolve));
    await harness.dispatchInteractiveSteer();
    const interrupted = await settleWithin(wait);
    assert.equal(interrupted.details.waitObservation.result, "interrupted_by_steering");
    assert.equal(jobSignal.aborted, false);
    work.resolve(textResult("done"));
  }
});

test("registered stock and queue signals release retained waits without cancelling work", async () => {
  const harness = createHarness();
  const coordinator = new SteeringWaitCoordinator();
  const contextBuilderJobs = new ContextBuilderJobManager({ createJobId: () => "cb-integration", warn: () => {} });
  const oracleSendJobs = new OracleSendJobManager({ createJobId: () => "oracle-integration", warn: () => {} });
  repopromptMcp(harness.pi, {
    steeringWaitCoordinator: coordinator,
    contextBuilderJobs,
    oracleSendJobs,
    resolveBackgroundWaitPolicy: () => ({ kind: "until_settled" }),
  });
  coordinator.beginSession("pi-session-integration");

  const builderWork = deferred();
  let builderSignal;
  const builder = contextBuilderJobs.start({
    descriptor: descriptor("context_builder"),
    run: (signal) => {
      builderSignal = signal;
      return builderWork.promise;
    },
  });
  const builderWait = harness.rpTool.execute(
    "builder-wait",
    { call: "context_builder_wait", args: { job_id: builder.jobId } },
    undefined,
    undefined,
    harness.context,
  );
  await new Promise((resolve) => setImmediate(resolve));
  await harness.emitStockSteer("private stock steering");
  const builderInterrupted = await settleWithin(builderWait);
  assert.equal(builderInterrupted.details.waitObservation.result, "interrupted_by_steering");
  assert.equal(builderInterrupted.details.contextBuilderJob.status, "running");
  assert.equal(builderSignal.aborted, false);
  assert.doesNotMatch(JSON.stringify(builderInterrupted), /private stock steering|private-image/u);
  builderWork.resolve(textResult("builder done"));
  const builderTerminal = await harness.rpTool.execute(
    "builder-terminal",
    { call: "context_builder_wait", args: { job_id: builder.jobId } },
    undefined,
    undefined,
    harness.context,
  );
  assert.match(builderTerminal.content[0].text, /builder done/u);

  const oracleWork = deferred();
  let oracleSignal;
  const oracle = oracleSendJobs.start({
    descriptor: descriptor("oracle_send"),
    run: (signal) => {
      oracleSignal = signal;
      return oracleWork.promise;
    },
  });
  const oracleWait = harness.rpTool.execute(
    "oracle-wait",
    { call: "oracle_send_wait", args: { job_id: oracle.jobId } },
    undefined,
    undefined,
    harness.context,
  );
  await new Promise((resolve) => setImmediate(resolve));
  harness.emitAcceptedQueueSteer();
  const oracleInterrupted = await settleWithin(oracleWait);
  assert.equal(oracleInterrupted.details.waitObservation.result, "interrupted_by_steering");
  assert.equal(oracleSignal.aborted, false);
  oracleWork.resolve(textResult("oracle done"));
  const oracleTerminal = await harness.rpTool.execute(
    "oracle-terminal",
    { call: "oracle_send_wait", args: { job_id: oracle.jobId } },
    undefined,
    undefined,
    harness.context,
  );
  assert.match(oracleTerminal.content[0].text, /oracle done/u);
});

test("one accepted steer releases every registered retained observer active at acceptance", async () => {
  const harness = createHarness();
  const coordinator = new SteeringWaitCoordinator();
  const contextBuilderJobs = new ContextBuilderJobManager({ createJobId: () => "cb-overlap", warn: () => {} });
  const oracleSendJobs = new OracleSendJobManager({ createJobId: () => "oracle-overlap", warn: () => {} });
  repopromptMcp(harness.pi, {
    steeringWaitCoordinator: coordinator,
    contextBuilderJobs,
    oracleSendJobs,
    resolveBackgroundWaitPolicy: () => ({ kind: "until_settled" }),
  });
  coordinator.beginSession("pi-session-integration");
  const builderWork = deferred();
  const oracleWork = deferred();
  const builder = contextBuilderJobs.start({
    descriptor: descriptor("context_builder"),
    run: () => builderWork.promise,
  });
  const oracle = oracleSendJobs.start({
    descriptor: { ...descriptor("oracle_send"), target: { app: "ce", windowId: 4, tab: "TAB-2" } },
    run: () => oracleWork.promise,
  });
  const waits = [
    harness.rpTool.execute(
      "builder-overlap",
      { call: "context_builder_wait", args: { job_id: builder.jobId } },
      undefined,
      undefined,
      harness.context,
    ),
    harness.rpTool.execute(
      "oracle-overlap",
      { call: "oracle_send_wait", args: { job_id: oracle.jobId } },
      undefined,
      undefined,
      harness.context,
    ),
  ];
  await new Promise((resolve) => setImmediate(resolve));
  harness.emitAcceptedQueueSteer();
  const interrupted = await Promise.all(waits.map((wait) => settleWithin(wait)));
  assert.deepEqual(
    interrupted.map((result) => result.details.waitObservation.result),
    ["interrupted_by_steering", "interrupted_by_steering"],
  );
  builderWork.resolve(textResult("builder terminal"));
  oracleWork.resolve(textResult("oracle terminal"));
});

test("agent_run blocking wait does not forward the two-minute CE default", async () => {
  const originalHome = process.env.HOME;
  const originalConnect = RpClient.prototype.connect;
  const originalClose = RpClient.prototype.close;
  const originalCallTool = RpClient.prototype.callTool;
  const tempHome = mkdtempSync(path.join(os.tmpdir(), "rp-steerable-agent-home-"));
  const configDirectory = path.join(tempHome, ".pi", "agent", "extensions");
  const configPath = path.join(configDirectory, "repoprompt-mcp.json");
  process.env.HOME = tempHome;
  let holdFirstWait = true;
  let firstRequestSignal;
  let childActive = true;
  const forwardedAgentCalls = [];

  const writeConfig = (overrides = {}) => writeFileSync(configPath, JSON.stringify({
    activeApp: "ce",
    apps: { ce: { command: "fake-rp", args: [] } },
    ...overrides,
  }));

  try {
    mkdirSync(configDirectory, { recursive: true });
    writeConfig();
    await resetRpClient();
    clearBinding();

    RpClient.prototype.connect = async function connect() {
      this.client = {};
      this.transport = {};
      this._status = "connected";
      this.toolListInvalidationGeneration = 0;
      this.publishedToolListGeneration = 0;
      this._tools = ceCatalog.tools
        .filter((tool) => ["agent_run", "bind_context", "manage_workspaces"].includes(tool.name))
        .map((tool) => structuredClone(tool));
    };
    RpClient.prototype.close = async function close() {
      this.client = null;
      this.transport = null;
      this._status = "disconnected";
      this._tools = [];
      this.publishedToolListGeneration = null;
    };
    RpClient.prototype.callTool = function callTool(name, args, timeoutMs, signal) {
      if (name === "bind_context" && args.op === "list") {
        return Promise.resolve(textResult(JSON.stringify({
          windows: [{
            window_id: 7,
            workspace: { id: "workspace-7", name: "repo" },
            active_context_id: "TAB-1",
            tabs: [{
              context_id: "TAB-1",
              name: "Pi Session",
              is_active: true,
              is_bound: true,
              selected_file_count: 0,
              repo_paths: ["/tmp/steerable-waits-integration"],
            }],
          }],
          binding: { binding_kind: "tab_context", window_id: 7, context_id: "TAB-1" },
        })));
      }
      assert.equal(name, "agent_run");
      forwardedAgentCalls.push({ args: structuredClone(args), timeoutMs, signal });
      if (args.session_id === "timeout-error") {
        return Promise.reject(new Error("MCP request timed out"));
      }
      if (holdFirstWait && args.op === "wait" && args.timeout !== 0 && !("prompt" in args)) {
        holdFirstWait = false;
        firstRequestSignal = signal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      if (args.op === "wait") childActive = false;
      return Promise.resolve(textResult(`forwarded ${args.op}`));
    };

    const harness = createHarness();
    harness.context.model = {
      provider: "openai-codex",
      api: "openai-codex-responses",
      id: "gpt-5.6-sol",
      baseUrl: "https://chatgpt.com/backend-api",
    };
    const coordinator = new SteeringWaitCoordinator();
    repopromptMcp(harness.pi, { steeringWaitCoordinator: coordinator });
    coordinator.beginSession("pi-session-integration");
    const executeAgentRun = (toolCallId, args) => harness.rpTool.execute(
      toolCallId,
      { call: "agent_run", args },
      undefined,
      undefined,
      harness.context,
    );
    const originalArgs = { op: "wait", session_ids: ["child-a", "child-b"], timeout: 120 };
    const firstWait = executeAgentRun("agent-wait", originalArgs);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(forwardedAgentCalls[0].args, {
      op: "wait",
      session_ids: ["child-a", "child-b"],
      timeout: 1_080,
    });
    assert.equal(forwardedAgentCalls[0].timeoutMs, 90 * 60 * 1000);
    assert.deepEqual(originalArgs, { op: "wait", session_ids: ["child-a", "child-b"], timeout: 120 });

    harness.emitAcceptedQueueSteer();
    const interrupted = await settleWithin(firstWait);
    assert.equal(interrupted.details.waitObservation.result, "interrupted_by_steering");
    assert.deepEqual(interrupted.details.waitObservation.sessionIds, ["child-a", "child-b"]);
    assert.equal(firstRequestSignal.aborted, true);
    assert.equal(childActive, true);

    harness.context.model = {
      provider: "unverified",
      api: "unverified",
      id: "unknown",
      baseUrl: "https://example.com",
    };
    const terminal = await executeAgentRun("agent-rewait", originalArgs);
    assert.match(terminal.content[0].text, /forwarded wait/u);
    assert.equal(forwardedAgentCalls.at(-1).args.timeout, 5_340);
    assert.equal(childActive, false);

    harness.context.model = {
      provider: "openai-codex",
      api: "openai-codex-responses",
      id: "gpt-5.6-sol",
      baseUrl: "https://chatgpt.com/backend-api",
    };
    const canonicalCases = [
      [{ op: "wait", session_id: "child-a" }, 1_080],
      [{ op: "wait", session_id: "child-a", timeout: 999 }, 1_080],
      [{ op: "wait", session_ids: ["child-b", "child-a"], timeout: 15 }, 1_080],
    ];
    for (const [args, expectedTimeout] of canonicalCases) {
      await executeAgentRun(`canonical-${expectedTimeout}-${forwardedAgentCalls.length}`, args);
      assert.equal(forwardedAgentCalls.at(-1).args.timeout, expectedTimeout);
      assert.equal(forwardedAgentCalls.at(-1).timeoutMs, 90 * 60 * 1000);
      if (args.session_ids) assert.deepEqual(forwardedAgentCalls.at(-1).args.session_ids, args.session_ids);
    }

    const passthroughCases = [
      { op: "wait", session_id: "child-a", timeout: 0 },
      { op: "wait", session_id: "child-a", timeout: 120, prompt: "invalid start-only field" },
      { op: "poll", session_id: "child-a" },
      { op: "cancel", session_id: "child-a" },
      { op: "respond", session_id: "child-a", response: "yes" },
      { op: "steer", session_id: "child-a", message: "next", wait: true },
      { op: "steer", session_id: "child-a", message: "next", wait: false },
    ];
    for (const args of passthroughCases) {
      await executeAgentRun(`passthrough-${args.op}-${forwardedAgentCalls.length}`, args);
      assert.deepEqual(forwardedAgentCalls.at(-1).args, args);
      assert.equal(forwardedAgentCalls.at(-1).timeoutMs, undefined);
      assert.equal(forwardedAgentCalls.at(-1).signal, undefined);
    }

    writeConfig({ backgroundWaitCacheTtlMsByModel: { "openai-codex/gpt-5.6-sol": 600_000 } });
    await executeAgentRun("agent-override", { op: "wait", session_id: "child-a" });
    assert.equal(forwardedAgentCalls.at(-1).args.timeout, 540);

    writeConfig({ backgroundWaitHeartbeatEnabled: false });
    await executeAgentRun("agent-heartbeats-disabled", { op: "wait", session_id: "child-a" });
    assert.equal(forwardedAgentCalls.at(-1).args.timeout, 5_340);

    const timeoutFailure = await executeAgentRun("agent-timeout-error", {
      op: "wait",
      session_id: "timeout-error",
    });
    assert.equal(timeoutFailure.isError, true);
    assert.match(timeoutFailure.content[0].text, /MCP request timed out/u);
  } finally {
    RpClient.prototype.connect = originalConnect;
    RpClient.prototype.close = originalClose;
    RpClient.prototype.callTool = originalCallTool;
    process.env.HOME = originalHome;
    clearBinding();
    await resetRpClient();
    rmSync(tempHome, { recursive: true, force: true });
  }
});

test("RepoPrompt Classic agent_run wait preserves the caller timeout", async () => {
  const originalHome = process.env.HOME;
  const originalConnect = RpClient.prototype.connect;
  const originalClose = RpClient.prototype.close;
  const originalCallTool = RpClient.prototype.callTool;
  const tempHome = mkdtempSync(path.join(os.tmpdir(), "rp-classic-agent-home-"));
  process.env.HOME = tempHome;
  let forwardedAgentCall;

  try {
    const configDirectory = path.join(tempHome, ".pi", "agent", "extensions");
    mkdirSync(configDirectory, { recursive: true });
    writeFileSync(
      path.join(configDirectory, "repoprompt-mcp.json"),
      JSON.stringify({ activeApp: "classic", apps: { classic: { command: "fake-classic", args: [] } } }),
    );
    await resetRpClient();
    clearBinding();

    RpClient.prototype.connect = async function connect() {
      this.client = {};
      this.transport = {};
      this._status = "connected";
      this.toolListInvalidationGeneration = 0;
      this.publishedToolListGeneration = 0;
      this._tools = classicCatalog.tools
        .filter((tool) => ["agent_run", "bind_context", "manage_workspaces"].includes(tool.name))
        .map((tool) => structuredClone(tool));
    };
    RpClient.prototype.close = async function close() {
      this.client = null;
      this.transport = null;
      this._status = "disconnected";
      this._tools = [];
      this.publishedToolListGeneration = null;
    };
    RpClient.prototype.callTool = function callTool(name, args, timeoutMs, signal) {
      if (name === "bind_context" && args.op === "list") {
        return Promise.resolve(textResult(JSON.stringify(classicInventoryScenarios.multiWindow)));
      }
      assert.equal(name, "agent_run");
      forwardedAgentCall = { args: structuredClone(args), timeoutMs, signal };
      return Promise.resolve(textResult("classic wait"));
    };

    const harness = createHarness();
    const coordinator = new SteeringWaitCoordinator();
    repopromptMcp(harness.pi, { steeringWaitCoordinator: coordinator });
    coordinator.beginSession("pi-session-integration");
    const args = { op: "wait", session_id: "classic-child", timeout: 120 };
    await harness.rpTool.execute(
      "classic-agent-wait",
      { call: "agent_run", args },
      undefined,
      undefined,
      harness.context,
    );
    assert.deepEqual(forwardedAgentCall, { args, timeoutMs: undefined, signal: undefined });
  } finally {
    RpClient.prototype.connect = originalConnect;
    RpClient.prototype.close = originalClose;
    RpClient.prototype.callTool = originalCallTool;
    process.env.HOME = originalHome;
    clearBinding();
    await resetRpClient();
    rmSync(tempHome, { recursive: true, force: true });
  }
});
