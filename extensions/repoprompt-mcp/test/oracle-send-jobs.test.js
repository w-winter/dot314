import assert from "node:assert/strict";
import test from "node:test";

import {
  ORACLE_SEND_CONSUMED_TOMBSTONE_LIMIT,
  ORACLE_SEND_JOB_CAPACITY,
  OracleSendJobError,
  OracleSendJobManager,
} from "../dist/oracle-send-jobs.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function descriptor(tab = "TAB-1") {
  return {
    target: { app: "ce", windowId: 4, tab },
    toolName: "oracle_send",
    userArgs: { message: "Review it", mode: "review", options: { paths: ["src/a.ts"] } },
    toolCatalogFreshness: "fresh",
    toolInputSchema: { type: "object", properties: { message: { type: "string" } } },
  };
}

function textResult(text) {
  return { content: [{ type: "text", text }], isError: false };
}

function createManager(options = {}) {
  let nextId = 1;
  return new OracleSendJobManager({
    createJobId: () => `oracle_test_${nextId++}`,
    warn: () => {},
    ...options,
  });
}

function wait(manager, jobId, signal, timeoutMs = 5) {
  return manager.wait(jobId, { kind: "bounded", timeoutMs }, signal);
}

async function expectJobError(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof OracleSendJobError);
    assert.equal(error.code, code);
    return true;
  });
}

test("OracleSendJobManager creates opaque Oracle IDs and rejects collisions", async () => {
  const defaultManager = new OracleSendJobManager({ warn: () => {} });
  const defaultWork = deferred();
  const opaque = defaultManager.start({ descriptor: descriptor(), run: () => defaultWork.promise });
  assert.match(
    opaque.jobId,
    /^oracle_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
  defaultManager.reset("reconnect");
  defaultWork.resolve(textResult("late"));

  const collisionManager = createManager({ createJobId: () => "oracle_collision" });
  const firstWork = deferred();
  collisionManager.start({ descriptor: descriptor("TAB-1"), run: () => firstWork.promise });
  assert.throws(
    () => collisionManager.start({ descriptor: descriptor("TAB-2"), run: async () => textResult("unexpected") }),
    /job ID collision: oracle_collision/u,
  );
  collisionManager.reset("reconnect");
  firstWork.resolve(textResult("late"));

  const consumedCollisionManager = createManager({ createJobId: () => "oracle_consumed_collision" });
  const consumed = consumedCollisionManager.start({
    descriptor: descriptor("TAB-CONSUMED"),
    run: async () => textResult("done"),
  });
  await wait(consumedCollisionManager, consumed.jobId);
  assert.throws(
    () => consumedCollisionManager.start({
      descriptor: descriptor("TAB-REUSED"),
      run: async () => textResult("unexpected"),
    }),
    /job ID collision: oracle_consumed_collision/u,
  );
});

test("OracleSendJobManager gives pre-aborted waits precedence over job lookup", async () => {
  const manager = createManager();
  const controller = new AbortController();
  controller.abort();
  await expectJobError(wait(manager, "oracle_unknown", controller.signal), "oracle_send_wait_aborted");
});

test("OracleSendJobManager isolates descriptors across start wait and completion", async () => {
  const manager = createManager();
  const work = deferred();
  const original = descriptor();
  const started = manager.start({ descriptor: original, run: () => work.promise });

  started.descriptor.target.tab = "MUTATED";
  started.descriptor.userArgs.options.paths.push("start.ts");
  started.descriptor.toolInputSchema.properties.extra = {};
  const running = await wait(manager, started.jobId);
  assert.equal(running.status, "running");
  running.descriptor.userArgs.options.paths.push("wait.ts");

  work.resolve(textResult("done"));
  const completed = await wait(manager, started.jobId);
  assert.deepEqual(completed.descriptor, original);
});

test("OracleSendJobManager accepts text blob and mime-typed resources", async () => {
  const manager = createManager();
  const resources = [
    { type: "resource", resource: { uri: "file:///text", text: "text response" } },
    { type: "resource", resource: { uri: "file:///blob", blob: "YmFzZTY0" } },
    {
      type: "resource",
      resource: { uri: "file:///typed", text: "typed response", mimeType: "text/plain" },
    },
  ];

  for (const resource of resources) {
    const started = manager.start({
      descriptor: descriptor(),
      run: async () => ({ content: [resource], isError: false }),
    });
    const outcome = await wait(manager, started.jobId);
    assert.equal(outcome.status, "completed");
    assert.deepEqual(outcome.result.content, [resource]);
  }
});

test("OracleSendJobManager rejects running and terminal-unconsumed jobs on one target", async () => {
  const manager = createManager();
  const work = deferred();
  const first = manager.start({ descriptor: descriptor(), run: () => work.promise });

  assert.throws(
    () => manager.start({ descriptor: descriptor(), run: async () => textResult("unexpected") }),
    (error) => {
      assert.equal(error.code, "oracle_send_already_running");
      assert.equal(error.jobId, first.jobId);
      return true;
    },
  );

  work.resolve(textResult("done"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.throws(
    () => manager.start({ descriptor: descriptor(), run: async () => textResult("unexpected") }),
    (error) => {
      assert.equal(error.code, "oracle_send_result_unconsumed");
      assert.equal(error.jobId, first.jobId);
      return true;
    },
  );

  await wait(manager, first.jobId);
  assert.ok(manager.start({ descriptor: descriptor(), run: async () => textResult("next") }).jobId);
});

test("OracleSendJobManager permits different tabs and bounds distinct retained targets", async () => {
  const manager = createManager();
  const work = Array.from({ length: ORACLE_SEND_JOB_CAPACITY }, () => deferred());
  const started = work.map((jobWork, index) => manager.start({
    descriptor: descriptor(`TAB-${index}`),
    run: () => jobWork.promise,
  }));

  assert.equal(started.length, ORACLE_SEND_JOB_CAPACITY);
  assert.throws(
    () => manager.start({ descriptor: descriptor("TAB-OVERFLOW"), run: async () => textResult("unexpected") }),
    (error) => error.code === "oracle_send_capacity_exceeded",
  );

  work[0].resolve(textResult("done"));
  await wait(manager, started[0].jobId);
  assert.ok(manager.start({ descriptor: descriptor("TAB-NEW"), run: async () => textResult("new") }).jobId);
});

test("OracleSendJobManager waits until settlement without a heartbeat", async () => {
  const manager = createManager();
  const work = deferred();
  const { jobId } = manager.start({ descriptor: descriptor(), run: () => work.promise });
  let settled = false;
  const waiting = manager.wait(jobId, { kind: "until_settled" }).finally(() => {
    settled = true;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  work.resolve(textResult("done"));
  assert.deepEqual((await waiting).result, textResult("done"));
});

test("OracleSendJobManager runner failure wakes a waiter without a heartbeat", async () => {
  const manager = createManager();
  const work = deferred();
  const { jobId } = manager.start({ descriptor: descriptor(), run: () => work.promise });
  const waiting = manager.wait(jobId, { kind: "until_settled" });

  work.reject(new Error("upstream timed out"));
  const failed = await waiting;
  assert.equal(failed.status, "failed");
  assert.equal(failed.message, "upstream timed out");
});

test("OracleSendJobManager timeout and waiter abort do not cancel or consume", async () => {
  const manager = createManager();
  const work = deferred();
  let jobSignal;
  const { jobId } = manager.start({
    descriptor: descriptor(),
    run: (signal) => {
      jobSignal = signal;
      return work.promise;
    },
  });

  assert.equal((await wait(manager, jobId)).status, "running");
  const controller = new AbortController();
  const waiting = manager.wait(jobId, { kind: "until_settled" }, controller.signal);
  controller.abort();
  await expectJobError(waiting, "oracle_send_wait_aborted");
  assert.equal(jobSignal.aborted, false);

  work.resolve(textResult("done"));
  assert.deepEqual((await wait(manager, jobId)).result, textResult("done"));
  await expectJobError(wait(manager, jobId), "oracle_send_job_consumed");
});

test("OracleSendJobManager gives a terminal result to only one concurrent waiter", async () => {
  const manager = createManager();
  const work = deferred();
  const { jobId } = manager.start({ descriptor: descriptor(), run: () => work.promise });
  const waits = [wait(manager, jobId), wait(manager, jobId)];

  work.resolve(textResult("done"));
  const outcomes = await Promise.allSettled(waits);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.find((outcome) => outcome.status === "rejected").reason.code, "oracle_send_job_consumed");
});

test("OracleSendJobManager retains failures without leaking provider text to warnings", async () => {
  const warnings = [];
  const sensitiveMessage = (
    "provider failed for message Review it mode review chat chat-secret model Review export /tmp/secret.md"
  );
  const manager = createManager({ warn: (message) => warnings.push(message) });
  const rejected = manager.start({
    descriptor: descriptor(),
    run: async () => {
      throw new Error(sensitiveMessage);
    },
  });
  const failed = await wait(manager, rejected.jobId);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(failed.status, "failed");
  assert.equal(failed.message, sensitiveMessage);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /oracle_test_1.*ce\/4\/TAB-1.*upstream call rejected/u);
  assert.doesNotMatch(warnings[0], /Review it|review|chat-secret|\/tmp\/secret\.md|provider failed/u);
});

test("OracleSendJobManager retains malformed content entries as failed outcomes", async () => {
  const manager = createManager();
  const malformedResults = [
    undefined,
    { content: [null], isError: false },
    { content: [{ type: "text" }], isError: false },
    { content: [{ type: "image", data: 42, mimeType: "image/png" }], isError: false },
    { content: new Array(1), isError: false },
    { content: [{ type: "resource", resource: { uri: "file:///missing-payload" } }], isError: false },
    { content: [{ type: "unsupported_content", payload: "value" }], isError: false },
  ];

  for (const malformedResult of malformedResults) {
    const malformed = manager.start({ descriptor: descriptor(), run: async () => malformedResult });
    const outcome = await wait(manager, malformed.jobId);
    assert.equal(outcome.status, "failed");
    assert.match(outcome.message, /invalid MCP tool result/u);
  }
});

test("OracleSendJobManager retains non-stringifiable rejection values", async () => {
  const manager = createManager();
  const rejected = manager.start({
    descriptor: descriptor(),
    run: async () => {
      throw Object.create(null);
    },
  });

  const outcome = await wait(manager, rejected.jobId);
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.message, "Unknown error");
});

test("OracleSendJobManager wakes waiters when asynchronous warning delivery rejects", async () => {
  const work = deferred();
  const manager = createManager({
    warn: async () => {
      throw new Error("logger unavailable");
    },
  });
  const started = manager.start({ descriptor: descriptor(), run: () => work.promise });
  const waiting = wait(manager, started.jobId);
  await new Promise((resolve) => setImmediate(resolve));

  work.reject(new Error("provider failed"));
  const outcome = await waiting;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.message, "provider failed");
});

test("OracleSendJobManager reset before dispatch prevents invocation", async () => {
  const manager = createManager();
  let runnerCalls = 0;
  const { jobId } = manager.start({
    descriptor: descriptor(),
    run: async () => {
      runnerCalls += 1;
      return textResult("unexpected");
    },
  });

  manager.reset("reconnect");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runnerCalls, 0);
  await expectJobError(wait(manager, jobId), "oracle_send_job_not_found");
});

test("OracleSendJobManager cancels an old waiter when reset reuses its job ID", async () => {
  const work = deferred();
  const nextWork = deferred();
  const manager = createManager({
    createJobId: () => "oracle_reused",
  });
  const old = manager.start({ descriptor: descriptor("TAB-OLD"), run: () => work.promise });
  const oldWait = wait(manager, old.jobId);
  let next;

  work.resolve(textResult("old result"));
  queueMicrotask(() => {
    manager.reset("reconnect");
    next = manager.start({ descriptor: descriptor("TAB-NEW"), run: () => nextWork.promise });
  });

  await expectJobError(oldWait, "oracle_send_job_cancelled");
  assert.equal(next.jobId, old.jobId);
  nextWork.resolve(textResult("new result"));
  const nextOutcome = await wait(manager, next.jobId);
  assert.equal(nextOutcome.status, "completed");
  assert.deepEqual(nextOutcome.result, textResult("new result"));
});

test("OracleSendJobManager reset aborts work wakes waiters and suppresses late settlement", async () => {
  const manager = createManager();
  const work = deferred();
  let jobSignal;
  const { jobId } = manager.start({
    descriptor: descriptor(),
    run: (signal) => {
      jobSignal = signal;
      return work.promise;
    },
  });
  const waiting = manager.wait(jobId, { kind: "until_settled" });
  await new Promise((resolve) => setImmediate(resolve));

  manager.reset("active_app_change");
  assert.equal(jobSignal.aborted, true);
  await expectJobError(waiting, "oracle_send_job_cancelled");
  await expectJobError(wait(manager, jobId), "oracle_send_job_not_found");

  const next = manager.start({ descriptor: descriptor(), run: async () => textResult("next") });
  work.reject(new Error("late rejection"));
  assert.deepEqual((await wait(manager, next.jobId)).result, textResult("next"));
});

test("OracleSendJobManager bounds consumed tombstones", async () => {
  const manager = createManager();
  let firstJobId;
  let latestJobId;

  for (let index = 0; index <= ORACLE_SEND_CONSUMED_TOMBSTONE_LIMIT; index += 1) {
    const started = manager.start({ descriptor: descriptor(), run: async () => textResult(`done-${index}`) });
    firstJobId ??= started.jobId;
    latestJobId = started.jobId;
    await wait(manager, started.jobId);
  }

  await expectJobError(wait(manager, firstJobId), "oracle_send_job_not_found");
  await expectJobError(wait(manager, latestJobId), "oracle_send_job_consumed");
});
