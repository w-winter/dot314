import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTEXT_BUILDER_CONSUMED_TOMBSTONE_LIMIT,
  CONTEXT_BUILDER_JOB_CAPACITY,
  ContextBuilderJobError,
  ContextBuilderJobManager,
} from "../dist/context-builder-jobs.js";

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
    toolName: "context_builder",
    userArgs: { instructions: "Plan it" },
    toolCatalogFreshness: "fresh",
  };
}

function textResult(text) {
  return { content: [{ type: "text", text }], isError: false };
}

function createManager(options = {}) {
  let nextId = 1;
  return new ContextBuilderJobManager({
    createJobId: () => `cb_test_${nextId++}`,
    warn: () => {},
    ...options,
  });
}

function wait(manager, jobId, signal, timeoutMs = 5) {
  return manager.wait(
    jobId,
    { kind: "bounded", timeoutMs },
    signal ? { callerSignal: signal } : undefined,
  );
}

async function expectJobError(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof ContextBuilderJobError);
    assert.equal(error.code, code);
    return true;
  });
}

test("ContextBuilderJobManager rejects duplicate running jobs for one target", () => {
  const manager = createManager();
  const work = deferred();
  const first = manager.start({ descriptor: descriptor(), run: () => work.promise });
  let secondRunnerCalled = false;

  assert.throws(
    () => manager.start({
      descriptor: descriptor(),
      run: async () => {
        secondRunnerCalled = true;
        return textResult("unexpected");
      },
    }),
    (error) => {
      assert.ok(error instanceof ContextBuilderJobError);
      assert.equal(error.code, "context_builder_already_running");
      assert.equal(error.jobId, first.jobId);
      return true;
    },
  );
  assert.equal(secondRunnerCalled, false);
});

test("ContextBuilderJobManager preserves live collision wording and permits consumed ID reuse", async () => {
  const manager = createManager({ createJobId: () => "cb_reused" });
  const firstWork = deferred();
  const first = manager.start({ descriptor: descriptor("TAB-1"), run: () => firstWork.promise });
  let collidingRunnerCalled = false;

  assert.throws(
    () => manager.start({
      descriptor: descriptor("TAB-2"),
      run: async () => {
        collidingRunnerCalled = true;
        return textResult("unexpected");
      },
    }),
    (error) => {
      assert.equal(error.message, "Context Builder job ID collision: cb_reused");
      return true;
    },
  );
  assert.equal(collidingRunnerCalled, false);

  firstWork.resolve(textResult("first"));
  assert.deepEqual((await wait(manager, first.jobId)).result, textResult("first"));

  const reused = manager.start({
    descriptor: descriptor("TAB-2"),
    run: async () => textResult("second"),
  });
  assert.equal(reused.jobId, first.jobId);
  assert.deepEqual((await wait(manager, reused.jobId)).result, textResult("second"));
});

test("ContextBuilderJobManager start results do not expose manager-owned target state", async () => {
  const manager = createManager();
  const work = deferred();
  const originalDescriptor = descriptor();
  const started = manager.start({ descriptor: originalDescriptor, run: () => work.promise });

  started.descriptor.target.tab = "MUTATED";
  work.resolve(textResult("done"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual((await wait(manager, started.jobId)).descriptor, originalDescriptor);

  const replacement = manager.start({
    descriptor: originalDescriptor,
    run: async () => textResult("replacement"),
  });
  assert.notEqual(replacement.jobId, started.jobId);
});

test("ContextBuilderJobManager running waits do not expose manager-owned target state", async () => {
  const manager = createManager();
  const work = deferred();
  const originalDescriptor = descriptor();
  const { jobId } = manager.start({ descriptor: originalDescriptor, run: () => work.promise });
  const running = await wait(manager, jobId);

  assert.equal(running.status, "running");
  running.descriptor.target.tab = "MUTATED";
  work.resolve(textResult("done"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual((await wait(manager, jobId)).descriptor, originalDescriptor);

  const replacement = manager.start({
    descriptor: originalDescriptor,
    run: async () => textResult("replacement"),
  });
  assert.notEqual(replacement.jobId, jobId);
});

test("ContextBuilderJobManager deeply isolates descriptor arguments", async () => {
  const manager = createManager();
  const work = deferred();
  const originalDescriptor = {
    ...descriptor(),
    userArgs: { instructions: "Plan it", options: { paths: ["src/a.ts"] } },
  };
  const started = manager.start({ descriptor: originalDescriptor, run: () => work.promise });
  started.descriptor.userArgs.options.paths.push("start-mutation.ts");

  const running = await wait(manager, started.jobId);
  assert.equal(running.status, "running");
  running.descriptor.userArgs.options.paths.push("wait-mutation.ts");

  work.resolve(textResult("done"));
  const completed = await wait(manager, started.jobId);
  assert.deepEqual(completed.descriptor.userArgs, originalDescriptor.userArgs);
});

test("ContextBuilderJobManager permits different tabs and releases occupancy on consumption", async () => {
  const manager = createManager();
  const firstWork = deferred();
  const secondWork = deferred();
  const first = manager.start({ descriptor: descriptor("TAB-1"), run: () => firstWork.promise });
  const second = manager.start({ descriptor: descriptor("TAB-2"), run: () => secondWork.promise });

  assert.notEqual(first.jobId, second.jobId);
  firstWork.resolve(textResult("first"));
  await new Promise((resolve) => setImmediate(resolve));

  assert.throws(
    () => manager.start({ descriptor: descriptor("TAB-1"), run: async () => textResult("unexpected") }),
    (error) => error instanceof ContextBuilderJobError && error.code === "context_builder_result_unconsumed",
  );
  assert.deepEqual((await wait(manager, first.jobId)).result, textResult("first"));
  const replacement = manager.start({ descriptor: descriptor("TAB-1"), run: async () => textResult("replacement") });
  assert.notEqual(replacement.jobId, first.jobId);

  secondWork.resolve(textResult("second"));
});

test("ContextBuilderJobManager wait times out without consuming the job", async () => {
  const manager = createManager();
  const work = deferred();
  const { jobId } = manager.start({ descriptor: descriptor(), run: () => work.promise });

  assert.deepEqual(await wait(manager, jobId), {
    status: "running",
    jobId,
    descriptor: descriptor(),
  });

  work.resolve(textResult("done"));
  const completed = await wait(manager, jobId);
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.result, textResult("done"));
  await expectJobError(wait(manager, jobId), "context_builder_job_consumed");
});

test("ContextBuilderJobManager prefers settlement published at a bounded deadline", async () => {
  const manager = createManager();
  const work = deferred();
  const { jobId } = manager.start({ descriptor: descriptor(), run: () => work.promise });
  setTimeout(() => work.resolve(textResult("done")), 0);

  const completed = await manager.wait(jobId, { kind: "bounded", timeoutMs: 0 });
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.result, textResult("done"));
});

test("ContextBuilderJobManager gives a terminal result to only one concurrent waiter", async () => {
  const manager = createManager();
  const work = deferred();
  const { jobId } = manager.start({ descriptor: descriptor(), run: () => work.promise });
  const waits = [wait(manager, jobId), wait(manager, jobId)];

  work.resolve(textResult("done"));
  const outcomes = await Promise.allSettled(waits);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  const rejection = outcomes.find((outcome) => outcome.status === "rejected");
  assert.equal(rejection.reason.code, "context_builder_job_consumed");
});

test("ContextBuilderJobManager retains failure until one wait consumes it", async () => {
  const manager = createManager();
  const { jobId } = manager.start({
    descriptor: descriptor(),
    run: async () => {
      throw new Error("builder failed");
    },
  });

  await expectJobError(wait(manager, jobId), "context_builder_job_failed");
  await expectJobError(wait(manager, jobId), "context_builder_job_consumed");
  await expectJobError(wait(manager, "cb_unknown"), "context_builder_job_not_found");
});

test("ContextBuilderJobManager rejects an invalid runtime runner result", async () => {
  const manager = createManager();
  const { jobId } = manager.start({ descriptor: descriptor(), run: async () => undefined });

  await expectJobError(wait(manager, jobId), "context_builder_job_failed");
  await expectJobError(wait(manager, jobId), "context_builder_job_consumed");
  const replacement = manager.start({ descriptor: descriptor(), run: async () => textResult("replacement") });
  assert.notEqual(replacement.jobId, jobId);
});

test("ContextBuilderJobManager bounds outstanding jobs and releases capacity", async () => {
  const manager = createManager();
  const work = Array.from({ length: CONTEXT_BUILDER_JOB_CAPACITY }, () => deferred());
  const started = work.map((jobWork, index) => manager.start({
    descriptor: descriptor(`TAB-${index}`),
    run: () => jobWork.promise,
  }));

  assert.throws(
    () => manager.start({ descriptor: descriptor("TAB-OVERFLOW"), run: async () => textResult("unexpected") }),
    (error) => error instanceof ContextBuilderJobError && error.code === "context_builder_capacity_exceeded",
  );

  work[0].resolve(textResult("first"));
  await wait(manager, started[0].jobId);
  const afterConsumption = manager.start({
    descriptor: descriptor("TAB-AFTER-CONSUMPTION"),
    run: async () => textResult("after consumption"),
  });
  assert.ok(afterConsumption.jobId);

  manager.reset("reconnect");
  const afterReset = manager.start({
    descriptor: descriptor("TAB-AFTER-RESET"),
    run: async () => textResult("after reset"),
  });
  assert.ok(afterReset.jobId);
});

test("ContextBuilderJobManager bounds consumed job tombstones", async () => {
  const manager = createManager();
  let firstJobId;
  let latestJobId;

  for (let index = 0; index <= CONTEXT_BUILDER_CONSUMED_TOMBSTONE_LIMIT; index += 1) {
    const started = manager.start({ descriptor: descriptor(), run: async () => textResult(`done-${index}`) });
    firstJobId ??= started.jobId;
    latestJobId = started.jobId;
    await wait(manager, started.jobId);
  }

  await expectJobError(wait(manager, firstJobId), "context_builder_job_not_found");
  await expectJobError(wait(manager, latestJobId), "context_builder_job_consumed");
});

test("ContextBuilderJobManager waits until settlement without a heartbeat", async () => {
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

test("ContextBuilderJobManager aborting a waiter leaves the background job running", async () => {
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
  const controller = new AbortController();
  const waiting = manager.wait(jobId, { kind: "until_settled" }, { callerSignal: controller.signal });
  controller.abort();

  await assert.rejects(waiting, (error) => {
    assert.equal(error.code, "context_builder_wait_aborted");
    assert.match(error.message, /did not cancel or consume/u);
    return true;
  });
  assert.equal(jobSignal.aborted, false);

  work.resolve(textResult("done"));
  await new Promise((resolve) => setImmediate(resolve));
  const terminalController = new AbortController();
  terminalController.abort();
  await assert.rejects(wait(manager, jobId, terminalController.signal), (error) => {
    assert.equal(error.code, "context_builder_wait_aborted");
    assert.match(error.message, /did not cancel or consume/u);
    return true;
  });
  assert.deepEqual((await wait(manager, jobId)).result, textResult("done"));
});

test("ContextBuilderJobManager reset before dispatch does not invoke the runner", async () => {
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
  await expectJobError(wait(manager, jobId), "context_builder_job_not_found");
});

test("ContextBuilderJobManager settlement followed by reset cancels an active waiter", async () => {
  const manager = createManager();
  const work = deferred();
  const { jobId } = manager.start({ descriptor: descriptor(), run: () => work.promise });
  const waiting = wait(manager, jobId);

  work.resolve(textResult("done"));
  queueMicrotask(() => manager.reset("reconnect"));

  await expectJobError(waiting, "context_builder_job_cancelled");
  await expectJobError(wait(manager, jobId), "context_builder_job_not_found");
});

test("ContextBuilderJobManager reset aborts jobs, wakes waiters, and clears occupancy", async () => {
  const manager = createManager();
  const oldWork = deferred();
  let oldSignal;
  const { jobId } = manager.start({
    descriptor: descriptor(),
    run: (signal) => {
      oldSignal = signal;
      return oldWork.promise;
    },
  });
  const waiting = manager.wait(jobId, { kind: "until_settled" });
  await new Promise((resolve) => setImmediate(resolve));

  manager.reset("reconnect");
  assert.equal(oldSignal.aborted, true);
  await expectJobError(waiting, "context_builder_job_cancelled");
  await expectJobError(wait(manager, jobId), "context_builder_job_not_found");

  const next = manager.start({ descriptor: descriptor(), run: async () => textResult("new") });
  oldWork.reject(new Error("late rejection"));
  assert.deepEqual((await wait(manager, next.jobId)).result, textResult("new"));
});

test("ContextBuilderJobManager steering interruption preserves the job and occupancy", async () => {
  const manager = createManager();
  const work = deferred();
  const steering = new AbortController();
  let jobSignal;
  const { jobId } = manager.start({
    descriptor: descriptor(),
    run: (signal) => {
      jobSignal = signal;
      return work.promise;
    },
  });
  const waiting = manager.wait(
    jobId,
    { kind: "until_settled" },
    { steeringSignal: steering.signal },
  );
  await new Promise((resolve) => setImmediate(resolve));
  steering.abort();

  assert.deepEqual(await waiting, {
    status: "interrupted_by_steering",
    jobId,
    descriptor: descriptor(),
  });
  assert.equal(jobSignal.aborted, false);
  assert.throws(
    () => manager.start({ descriptor: descriptor(), run: async () => textResult("unexpected") }),
    (error) => error.code === "context_builder_already_running",
  );

  work.resolve(textResult("done"));
  assert.deepEqual((await wait(manager, jobId)).result, textResult("done"));
  await expectJobError(wait(manager, jobId), "context_builder_job_consumed");
});

test("ContextBuilderJobManager terminal caller and reset outcomes outrank steering", async () => {
  const terminalManager = createManager();
  const terminalWork = deferred();
  const terminalSteering = new AbortController();
  const terminalJob = terminalManager.start({ descriptor: descriptor(), run: () => terminalWork.promise });
  const terminalWait = terminalManager.wait(
    terminalJob.jobId,
    { kind: "until_settled" },
    { steeringSignal: terminalSteering.signal },
  );
  terminalWork.resolve(textResult("terminal"));
  terminalSteering.abort();
  assert.deepEqual((await terminalWait).result, textResult("terminal"));

  const callerManager = createManager();
  const callerWork = deferred();
  const caller = new AbortController();
  const callerSteering = new AbortController();
  const callerJob = callerManager.start({ descriptor: descriptor(), run: () => callerWork.promise });
  const callerWait = callerManager.wait(
    callerJob.jobId,
    { kind: "until_settled" },
    { callerSignal: caller.signal, steeringSignal: callerSteering.signal },
  );
  callerSteering.abort();
  caller.abort();
  await expectJobError(callerWait, "context_builder_wait_aborted");
  callerManager.reset("reconnect");

  const resetManager = createManager();
  const resetWork = deferred();
  const resetSteering = new AbortController();
  const resetJob = resetManager.start({ descriptor: descriptor(), run: () => resetWork.promise });
  const resetWait = resetManager.wait(
    resetJob.jobId,
    { kind: "until_settled" },
    { steeringSignal: resetSteering.signal },
  );
  resetSteering.abort();
  resetManager.reset("reconnect");
  await expectJobError(resetWait, "context_builder_job_cancelled");
});

test("ContextBuilderJobManager steering signals affect only their owning waiter", async () => {
  const manager = createManager();
  const work = deferred();
  const firstSteering = new AbortController();
  const secondSteering = new AbortController();
  const { jobId } = manager.start({ descriptor: descriptor(), run: () => work.promise });
  const firstWait = manager.wait(
    jobId,
    { kind: "until_settled" },
    { steeringSignal: firstSteering.signal },
  );
  let secondSettled = false;
  const secondWait = manager.wait(
    jobId,
    { kind: "until_settled" },
    { steeringSignal: secondSteering.signal },
  ).finally(() => {
    secondSettled = true;
  });

  firstSteering.abort();
  assert.equal((await firstWait).status, "interrupted_by_steering");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondSettled, false);
  work.resolve(textResult("done"));
  assert.deepEqual((await secondWait).result, textResult("done"));
});
