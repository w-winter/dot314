import { assertMcpToolResult } from "./mcp-tool-result.js";
import type { McpToolResult, RpAppId } from "./types.js";

export interface RepoPromptJobTarget {
  readonly app: RpAppId;
  readonly windowId: number;
  readonly tab: string;
}

export type RepoPromptJobResetReason =
  | "active_app_change"
  | "connected_app_change"
  | "reconnect"
  | "session_shutdown"
  | "startup_retry";

export interface RetainedMcpJobRequest<TDescriptor> {
  readonly descriptor: TDescriptor;
  run(signal: AbortSignal): Promise<McpToolResult>;
}

export type RetainedMcpJobWaitPolicy =
  | {
      readonly kind: "until_settled";
    }
  | {
      readonly kind: "bounded";
      readonly timeoutMs: number;
    };

export type RetainedMcpJobWaitOutcome<TDescriptor> =
  | {
      readonly status: "running";
      readonly jobId: string;
      readonly descriptor: TDescriptor;
    }
  | {
      readonly status: "completed";
      readonly jobId: string;
      readonly descriptor: TDescriptor;
      readonly result: McpToolResult;
    }
  | {
      readonly status: "failed";
      readonly jobId: string;
      readonly descriptor: TDescriptor;
      readonly message: string;
    };

export type RetainedMcpJobFailure =
  | {
      readonly reason: "target_occupied";
      readonly target: RepoPromptJobTarget;
      readonly jobId: string;
      readonly status: "running" | "terminal";
    }
  | {
      readonly reason: "capacity_exceeded";
      readonly target: RepoPromptJobTarget;
      readonly capacity: number;
    }
  | {
      readonly reason: "id_collision";
      readonly jobId: string;
    }
  | {
      readonly reason: "cancelled";
      readonly target: RepoPromptJobTarget;
      readonly jobId: string;
      readonly resetReason: RepoPromptJobResetReason;
    }
  | {
      readonly reason: "consumed";
      readonly target: RepoPromptJobTarget;
      readonly jobId: string;
    }
  | {
      readonly reason: "not_found";
      readonly jobId: string;
    }
  | {
      readonly reason: "wait_aborted";
      readonly jobId: string;
      readonly target?: RepoPromptJobTarget;
    };

export class RetainedMcpJobError extends Error {
  readonly failure: RetainedMcpJobFailure;

  constructor(failure: RetainedMcpJobFailure) {
    super(failure.reason);
    this.name = "RetainedMcpJobError";
    this.failure = structuredClone(failure);
  }
}

interface RunningRecord<TDescriptor> {
  readonly status: "running";
  readonly descriptor: TDescriptor;
  readonly targetKey: string;
  readonly controller: AbortController;
  readonly changed: Promise<{ kind: "settled" } | { kind: "reset"; reason: RepoPromptJobResetReason }>;
  readonly notifyChanged: (
    value: { kind: "settled" } | { kind: "reset"; reason: RepoPromptJobResetReason },
  ) => void;
}

interface CompletedRecord<TDescriptor> {
  readonly status: "completed";
  readonly descriptor: TDescriptor;
  readonly targetKey: string;
  readonly result: McpToolResult;
}

interface FailedRecord<TDescriptor> {
  readonly status: "failed";
  readonly descriptor: TDescriptor;
  readonly targetKey: string;
  readonly message: string;
}

type RetainedMcpJobRecord<TDescriptor> =
  | RunningRecord<TDescriptor>
  | CompletedRecord<TDescriptor>
  | FailedRecord<TDescriptor>;

export type RetainedMcpJobFailureKind = "invalid_result" | "runner_rejected";

export interface RetainedMcpJobRegistryOptions<TDescriptor> {
  readonly capacity: number;
  readonly consumedTombstoneLimit: number;
  readonly consumedJobIdPolicy: "reject" | "reuse";
  readonly createJobId: () => string;
  readonly cloneDescriptor: (descriptor: TDescriptor) => TDescriptor;
  readonly invalidResultMessage: string;
  readonly onDetachedFailure?: (
    jobId: string,
    descriptor: TDescriptor,
    message: string,
    kind: RetainedMcpJobFailureKind,
  ) => void | Promise<void>;
}

function targetKey(target: RepoPromptJobTarget): string {
  return JSON.stringify([target.app, target.windowId, target.tab]);
}

function errorMessage(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "Unknown error";
  }
}

export class RetainedMcpJobRegistry<TDescriptor extends { readonly target: RepoPromptJobTarget }> {
  private readonly options: RetainedMcpJobRegistryOptions<TDescriptor>;
  private readonly jobsById = new Map<string, RetainedMcpJobRecord<TDescriptor>>();
  private readonly outstandingJobIdByTarget = new Map<string, string>();
  private readonly consumedTargetByJobId = new Map<string, RepoPromptJobTarget>();
  private resetGeneration = 0;
  private lastResetReason: RepoPromptJobResetReason | null = null;

  constructor(options: RetainedMcpJobRegistryOptions<TDescriptor>) {
    this.options = options;
  }

  start(request: RetainedMcpJobRequest<TDescriptor>): { jobId: string; descriptor: TDescriptor } {
    const descriptor = this.options.cloneDescriptor(request.descriptor);
    const key = targetKey(descriptor.target);
    const outstandingJobId = this.outstandingJobIdByTarget.get(key);
    if (outstandingJobId) {
      const outstandingRecord = this.jobsById.get(outstandingJobId);
      if (!outstandingRecord) {
        throw new Error(`Retained MCP job occupancy invariant violated for job ${outstandingJobId}`);
      }
      throw new RetainedMcpJobError({
        reason: "target_occupied",
        target: { ...descriptor.target },
        jobId: outstandingJobId,
        status: outstandingRecord.status === "running" ? "running" : "terminal",
      });
    }

    if (this.jobsById.size >= this.options.capacity) {
      throw new RetainedMcpJobError({
        reason: "capacity_exceeded",
        target: { ...descriptor.target },
        capacity: this.options.capacity,
      });
    }

    const jobId = this.options.createJobId();
    const collidesWithLiveJob = this.jobsById.has(jobId);
    const collidesWithConsumedJob = this.consumedTargetByJobId.has(jobId);
    if (collidesWithLiveJob || (collidesWithConsumedJob && this.options.consumedJobIdPolicy === "reject")) {
      throw new RetainedMcpJobError({ reason: "id_collision", jobId });
    }
    if (collidesWithConsumedJob) {
      this.consumedTargetByJobId.delete(jobId);
    }

    let notifyChanged!: RunningRecord<TDescriptor>["notifyChanged"];
    const changed = new Promise<Parameters<RunningRecord<TDescriptor>["notifyChanged"]>[0]>((resolve) => {
      notifyChanged = resolve;
    });
    const record: RunningRecord<TDescriptor> = {
      status: "running",
      descriptor,
      targetKey: key,
      controller: new AbortController(),
      changed,
      notifyChanged,
    };

    this.jobsById.set(jobId, record);
    this.outstandingJobIdByTarget.set(key, jobId);

    void Promise.resolve().then(async () => {
      if (this.jobsById.get(jobId) !== record) {
        return;
      }

      let result: McpToolResult;
      try {
        result = await request.run(record.controller.signal);
      } catch (error) {
        this.fail(jobId, record, error, "runner_rejected");
        return;
      }

      try {
        assertMcpToolResult(result, this.options.invalidResultMessage);
      } catch (error) {
        this.fail(jobId, record, error, "invalid_result");
        return;
      }
      this.complete(jobId, record, result);
    });

    return { jobId, descriptor: this.options.cloneDescriptor(descriptor) };
  }

  async wait(
    jobId: string,
    policy: RetainedMcpJobWaitPolicy,
    signal?: AbortSignal,
  ): Promise<RetainedMcpJobWaitOutcome<TDescriptor>> {
    if (signal?.aborted) {
      throw this.waitAborted(jobId);
    }

    const waitGeneration = this.resetGeneration;
    const initial = this.jobsById.get(jobId);
    if (!initial) {
      throw this.unavailableJobError(jobId);
    }
    if (initial.status !== "running") {
      return this.consume(jobId, initial);
    }

    type WaitWake =
      | { kind: "settled" }
      | { kind: "reset"; reason: RepoPromptJobResetReason }
      | { kind: "timeout" }
      | { kind: "aborted" };

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    const wakePromises: Array<Promise<WaitWake>> = [initial.changed];
    if (policy.kind === "bounded") {
      wakePromises.push(new Promise<{ kind: "timeout" }>((resolve) => {
        timeoutId = setTimeout(() => resolve({ kind: "timeout" }), policy.timeoutMs);
      }));
    }
    if (signal) {
      wakePromises.push(new Promise<{ kind: "aborted" }>((resolve) => {
        abortListener = () => resolve({ kind: "aborted" });
        signal.addEventListener("abort", abortListener, { once: true });
      }));
    }

    try {
      const wake = await Promise.race(wakePromises);
      if (wake.kind === "reset") {
        throw new RetainedMcpJobError({
          reason: "cancelled",
          target: { ...initial.descriptor.target },
          jobId,
          resetReason: wake.reason,
        });
      }
      if (wake.kind === "aborted") {
        throw this.waitAborted(jobId, initial.descriptor.target);
      }

      if (this.resetGeneration !== waitGeneration) {
        if (!this.lastResetReason) {
          throw new Error("Retained MCP reset generation invariant violated");
        }
        throw new RetainedMcpJobError({
          reason: "cancelled",
          target: { ...initial.descriptor.target },
          jobId,
          resetReason: this.lastResetReason,
        });
      }

      const current = this.jobsById.get(jobId);
      if (!current) {
        throw this.unavailableJobError(jobId);
      }
      if (current.status === "running") {
        if (wake.kind !== "timeout") {
          throw new Error(`Retained MCP job ${jobId} woke without settlement or a bounded timeout`);
        }
        return {
          status: "running",
          jobId,
          descriptor: this.options.cloneDescriptor(current.descriptor),
        };
      }
      return this.consume(jobId, current);
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
      if (signal && abortListener) {
        signal.removeEventListener("abort", abortListener);
      }
    }
  }

  reset(reason: RepoPromptJobResetReason): void {
    this.resetGeneration += 1;
    this.lastResetReason = reason;
    for (const record of this.jobsById.values()) {
      if (record.status !== "running") {
        continue;
      }
      record.controller.abort(reason);
      record.notifyChanged({ kind: "reset", reason });
    }
    this.jobsById.clear();
    this.outstandingJobIdByTarget.clear();
    this.consumedTargetByJobId.clear();
  }

  private complete(jobId: string, record: RunningRecord<TDescriptor>, result: McpToolResult): void {
    if (this.jobsById.get(jobId) !== record) {
      return;
    }
    this.jobsById.set(jobId, {
      status: "completed",
      descriptor: record.descriptor,
      targetKey: record.targetKey,
      result,
    });
    record.notifyChanged({ kind: "settled" });
  }

  private fail(
    jobId: string,
    record: RunningRecord<TDescriptor>,
    error: unknown,
    kind: RetainedMcpJobFailureKind,
  ): void {
    if (this.jobsById.get(jobId) !== record) {
      return;
    }
    const message = errorMessage(error);
    this.jobsById.set(jobId, {
      status: "failed",
      descriptor: record.descriptor,
      targetKey: record.targetKey,
      message,
    });
    record.notifyChanged({ kind: "settled" });
    if (!record.controller.signal.aborted && this.options.onDetachedFailure) {
      void Promise.resolve()
        .then(() => this.options.onDetachedFailure?.(
          jobId,
          this.options.cloneDescriptor(record.descriptor),
          message,
          kind,
        ))
        .catch(() => {
          // Detached diagnostics must not alter job settlement
        });
    }
  }

  private consume(
    jobId: string,
    record: CompletedRecord<TDescriptor> | FailedRecord<TDescriptor>,
  ): RetainedMcpJobWaitOutcome<TDescriptor> {
    this.jobsById.delete(jobId);
    this.outstandingJobIdByTarget.delete(record.targetKey);
    this.rememberConsumed(jobId, record.descriptor.target);

    if (record.status === "failed") {
      return {
        status: "failed",
        jobId,
        descriptor: this.options.cloneDescriptor(record.descriptor),
        message: record.message,
      };
    }

    return {
      status: "completed",
      jobId,
      descriptor: this.options.cloneDescriptor(record.descriptor),
      result: record.result,
    };
  }

  private rememberConsumed(jobId: string, target: RepoPromptJobTarget): void {
    this.consumedTargetByJobId.set(jobId, { ...target });
    if (this.consumedTargetByJobId.size <= this.options.consumedTombstoneLimit) {
      return;
    }

    const oldest = this.consumedTargetByJobId.keys().next();
    if (oldest.done) {
      throw new Error("Retained MCP consumed tombstone invariant violated");
    }
    this.consumedTargetByJobId.delete(oldest.value);
  }

  private unavailableJobError(jobId: string): RetainedMcpJobError {
    const consumedTarget = this.consumedTargetByJobId.get(jobId);
    return consumedTarget
      ? new RetainedMcpJobError({
          reason: "consumed",
          target: { ...consumedTarget },
          jobId,
        })
      : new RetainedMcpJobError({ reason: "not_found", jobId });
  }

  private waitAborted(jobId: string, target?: RepoPromptJobTarget): RetainedMcpJobError {
    return new RetainedMcpJobError({
      reason: "wait_aborted",
      jobId,
      ...(target ? { target: { ...target } } : {}),
    });
  }
}
