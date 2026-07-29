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
    waitTimeoutMs: 5,
    createJobId: () => `cb_test_${nextId++}`,
    warn: () => {},
    ...options,
  });
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

test("ContextBuilderJobManager start results do not expose manager-owned target state", async () => {
  const manager = createManager();
  const work = deferred();
  const originalDescriptor = descriptor();
  const started = manager.start({ descriptor: originalDescriptor, run: () => work.promise });

  started.descriptor.target.tab = "MUTATED";
  work.resolve(textResult("done"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual((await manager.wait(started.jobId)).descriptor, originalDescriptor);

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
  const running = await manager.wait(jobId);

  assert.equal(running.status, "running");
  running.descriptor.target.tab = "MUTATED";
  work.resolve(textResult("done"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual((await manager.wait(jobId)).descriptor, originalDescriptor);

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

  const running = await manager.wait(started.jobId);
  assert.equal(running.status, "running");
  running.descriptor.userArgs.options.paths.push("wait-mutation.ts");

  work.resolve(textResult("done"));
  const completed = await manager.wait(started.jobId);
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
  assert.deepEqual((await manager.wait(first.jobId)).result, textResult("first"));
  const replacement = manager.start({ descriptor: descriptor("TAB-1"), run: async () => textResult("replacement") });
  assert.notEqual(replacement.jobId, first.jobId);

  secondWork.resolve(textResult("second"));
});

test("ContextBuilderJobManager wait times out without consuming the job", async () => {
  const manager = createManager();
  const work = deferred();
  const { jobId } = manager.start({ descriptor: descriptor(), run: () => work.promise });

  assert.deepEqual(await manager.wait(jobId), {
    status: "running",
    jobId,
    descriptor: descriptor(),
  });

  work.resolve(textResult("done"));
  const completed = await manager.wait(jobId);
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.result, textResult("done"));
  await expectJobError(manager.wait(jobId), "context_builder_job_consumed");
});

test("ContextBuilderJobManager gives a terminal result to only one concurrent waiter", async () => {
  const manager = createManager({ waitTimeoutMs: 100 });
  const work = deferred();
  const { jobId } = manager.start({ descriptor: descriptor(), run: () => work.promise });
  const waits = [manager.wait(jobId), manager.wait(jobId)];

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

  await expectJobError(manager.wait(jobId), "context_builder_job_failed");
  await expectJobError(manager.wait(jobId), "context_builder_job_consumed");
  await expectJobError(manager.wait("cb_unknown"), "context_builder_job_not_found");
});

test("ContextBuilderJobManager rejects an invalid runtime runner result", async () => {
  const manager = createManager();
  const { jobId } = manager.start({ descriptor: descriptor(), run: async () => undefined });

  await expectJobError(manager.wait(jobId), "context_builder_job_failed");
  await expectJobError(manager.wait(jobId), "context_builder_job_consumed");
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
  await manager.wait(started[0].jobId);
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
    await manager.wait(started.jobId);
  }

  await expectJobError(manager.wait(firstJobId), "context_builder_job_not_found");
  await expectJobError(manager.wait(latestJobId), "context_builder_job_consumed");
});

test("ContextBuilderJobManager aborting a waiter leaves the background job running", async () => {
  const manager = createManager({ waitTimeoutMs: 100 });
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
  const waiting = manager.wait(jobId, controller.signal);
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
  await assert.rejects(manager.wait(jobId, terminalController.signal), (error) => {
    assert.equal(error.code, "context_builder_wait_aborted");
    assert.match(error.message, /did not cancel or consume/u);
    return true;
  });
  assert.deepEqual((await manager.wait(jobId)).result, textResult("done"));
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
  await expectJobError(manager.wait(jobId), "context_builder_job_not_found");
});

test("ContextBuilderJobManager settlement followed by reset cancels an active waiter", async () => {
  const manager = createManager({ waitTimeoutMs: 100 });
  const work = deferred();
  const { jobId } = manager.start({ descriptor: descriptor(), run: () => work.promise });
  const waiting = manager.wait(jobId);

  work.resolve(textResult("done"));
  queueMicrotask(() => manager.reset("reconnect"));

  await expectJobError(waiting, "context_builder_job_cancelled");
  await expectJobError(manager.wait(jobId), "context_builder_job_not_found");
});

test("ContextBuilderJobManager reset aborts jobs, wakes waiters, and clears occupancy", async () => {
  const manager = createManager({ waitTimeoutMs: 100 });
  const oldWork = deferred();
  let oldSignal;
  const { jobId } = manager.start({
    descriptor: descriptor(),
    run: (signal) => {
      oldSignal = signal;
      return oldWork.promise;
    },
  });
  const waiting = manager.wait(jobId);
  await new Promise((resolve) => setImmediate(resolve));

  manager.reset("reconnect");
  assert.equal(oldSignal.aborted, true);
  await expectJobError(waiting, "context_builder_job_cancelled");
  await expectJobError(manager.wait(jobId), "context_builder_job_not_found");

  const next = manager.start({ descriptor: descriptor(), run: async () => textResult("new") });
  oldWork.reject(new Error("late rejection"));
  assert.deepEqual((await manager.wait(next.jobId)).result, textResult("new"));
});
