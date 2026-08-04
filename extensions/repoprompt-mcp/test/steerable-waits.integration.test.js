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

test("registered explicit agent_run wait aborts only its request and remains re-waitable", async () => {
  const originalHome = process.env.HOME;
  const originalConnect = RpClient.prototype.connect;
  const originalClose = RpClient.prototype.close;
  const originalCallTool = RpClient.prototype.callTool;
  const tempHome = mkdtempSync(path.join(os.tmpdir(), "rp-steerable-agent-home-"));
  process.env.HOME = tempHome;
  let waitCalls = 0;
  let firstRequestSignal;
  let childActive = true;
  const forwardedSignals = [];

  try {
    mkdirSync(path.join(tempHome, ".pi", "agent", "extensions"), { recursive: true });
    writeFileSync(
      path.join(tempHome, ".pi", "agent", "extensions", "repoprompt-mcp.json"),
      JSON.stringify({ activeApp: "ce", apps: { ce: { command: "fake-rp", args: [] } } }),
    );
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
    RpClient.prototype.callTool = function callTool(name, args, _timeout, signal) {
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
          binding: { binding_kind: "tab_context", context_id: "TAB-1" },
        })));
      }
      assert.equal(name, "agent_run");
      if (args.op !== "wait" || "prompt" in args) {
        forwardedSignals.push(signal);
        return Promise.resolve(textResult(`forwarded ${args.op}`));
      }
      waitCalls += 1;
      if (waitCalls === 1) {
        firstRequestSignal = signal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      childActive = false;
      return Promise.resolve(textResult("child completed"));
    };

    const harness = createHarness();
    const coordinator = new SteeringWaitCoordinator();
    repopromptMcp(harness.pi, { steeringWaitCoordinator: coordinator });
    coordinator.beginSession("pi-session-integration");
    const args = { op: "wait", session_ids: ["child-a", "child-b"], timeout: 60 };
    const firstWait = harness.rpTool.execute(
      "agent-wait",
      { call: "agent_run", args },
      undefined,
      undefined,
      harness.context,
    );
    await new Promise((resolve) => setImmediate(resolve));
    harness.emitAcceptedQueueSteer();
    const interrupted = await settleWithin(firstWait);
    assert.equal(interrupted.details.waitObservation.result, "interrupted_by_steering");
    assert.deepEqual(interrupted.details.waitObservation.sessionIds, ["child-a", "child-b"]);
    assert.equal(firstRequestSignal.aborted, true);
    assert.equal(childActive, true);

    const terminal = await harness.rpTool.execute(
      "agent-rewait",
      { call: "agent_run", args },
      undefined,
      undefined,
      harness.context,
    );
    assert.match(terminal.content[0].text, /child completed/u);
    assert.equal(childActive, false);

    const unwrappedCalls = [
      { op: "wait", session_id: "child-a", prompt: "invalid start-only field" },
      { op: "poll", session_id: "child-a" },
      { op: "cancel", session_id: "child-a" },
      { op: "respond", session_id: "child-a", response: "yes" },
      { op: "steer", session_id: "child-a", message: "next", wait: true },
      { op: "steer", session_id: "child-a", message: "next", wait: false },
    ];
    for (const forwardedArgs of unwrappedCalls) {
      await harness.rpTool.execute(
        `agent-${forwardedArgs.op}`,
        { call: "agent_run", args: forwardedArgs },
        undefined,
        undefined,
        harness.context,
      );
    }
    assert.deepEqual(forwardedSignals, Array(unwrappedCalls.length).fill(undefined));
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
