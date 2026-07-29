import { randomUUID } from "node:crypto";

import type { McpToolResult, RpAppId, ToolCatalogFreshness } from "./types.js";

export const CONTEXT_BUILDER_WAIT_TIMEOUT_MS = 210_000;
export const CONTEXT_BUILDER_CONSUMED_TOMBSTONE_LIMIT = 256;
export const CONTEXT_BUILDER_JOB_CAPACITY = 16;

export type ContextBuilderResetReason =
  | "active_app_change"
  | "connected_app_change"
  | "reconnect"
  | "session_shutdown"
  | "startup_retry";

export interface ContextBuilderJobTarget {
  readonly app: RpAppId;
  readonly windowId: number;
  readonly tab: string;
}

export interface ContextBuilderJobDescriptor {
  readonly target: ContextBuilderJobTarget;
  readonly toolName: string;
  readonly userArgs: Readonly<Record<string, unknown>>;
  readonly toolCatalogFreshness: ToolCatalogFreshness;
}

export interface StartContextBuilderJobRequest {
  descriptor: ContextBuilderJobDescriptor;
  run(signal: AbortSignal): Promise<McpToolResult>;
}

export type ContextBuilderJobWaitOutcome =
  | {
      status: "running";
      jobId: string;
      descriptor: ContextBuilderJobDescriptor;
    }
  | {
      status: "completed";
      jobId: string;
      descriptor: ContextBuilderJobDescriptor;
      result: McpToolResult;
    };

export type ContextBuilderJobErrorCode =
  | "context_builder_already_running"
  | "context_builder_capacity_exceeded"
  | "context_builder_job_cancelled"
  | "context_builder_job_consumed"
  | "context_builder_job_failed"
  | "context_builder_job_not_found"
  | "context_builder_result_unconsumed"
  | "context_builder_wait_aborted";

export class ContextBuilderJobError extends Error {
  readonly code: ContextBuilderJobErrorCode;
  readonly jobId?: string;
  readonly target?: ContextBuilderJobTarget;

  constructor(
    code: ContextBuilderJobErrorCode,
    message: string,
    jobId?: string,
    target?: ContextBuilderJobTarget,
  ) {
    super(message);
    this.name = "ContextBuilderJobError";
    this.code = code;
    this.jobId = jobId;
    this.target = target ? { ...target } : undefined;
  }
}

interface RunningRecord {
  status: "running";
  descriptor: ContextBuilderJobDescriptor;
  targetKey: string;
  controller: AbortController;
  changed: Promise<{ kind: "settled" } | { kind: "reset"; reason: ContextBuilderResetReason }>;
  notifyChanged(value: { kind: "settled" } | { kind: "reset"; reason: ContextBuilderResetReason }): void;
}

interface CompletedRecord {
  status: "completed";
  descriptor: ContextBuilderJobDescriptor;
  targetKey: string;
  result: McpToolResult;
}

interface FailedRecord {
  status: "failed";
  descriptor: ContextBuilderJobDescriptor;
  targetKey: string;
  message: string;
}

type ContextBuilderJobRecord = RunningRecord | CompletedRecord | FailedRecord;

export interface ContextBuilderJobManagerOptions {
  waitTimeoutMs?: number;
  createJobId?: () => string;
  warn?: (message: string) => void;
}

function targetKey(target: ContextBuilderJobTarget): string {
  return JSON.stringify([target.app, target.windowId, target.tab]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertMcpToolResult(result: unknown): asserts result is McpToolResult {
  if (
    typeof result !== "object" ||
    result === null ||
    !Array.isArray((result as { content?: unknown }).content) ||
    (
      "isError" in result &&
      typeof (result as { isError?: unknown }).isError !== "boolean" &&
      (result as { isError?: unknown }).isError !== undefined
    )
  ) {
    throw new Error("Context Builder runner returned an invalid MCP tool result");
  }
}

function copyDescriptor(descriptor: ContextBuilderJobDescriptor): ContextBuilderJobDescriptor {
  return {
    ...descriptor,
    target: { ...descriptor.target },
    userArgs: structuredClone(descriptor.userArgs),
  };
}

export class ContextBuilderJobManager {
  private readonly waitTimeoutMs: number;
  private readonly createJobId: () => string;
  private readonly warn: (message: string) => void;
  private readonly jobsById = new Map<string, ContextBuilderJobRecord>();
  private readonly outstandingJobIdByTarget = new Map<string, string>();
  private readonly consumedTargetByJobId = new Map<string, ContextBuilderJobTarget>();
  private resetGeneration = 0;
  private lastResetReason: ContextBuilderResetReason | null = null;

  constructor(options: ContextBuilderJobManagerOptions = {}) {
    this.waitTimeoutMs = options.waitTimeoutMs ?? CONTEXT_BUILDER_WAIT_TIMEOUT_MS;
    this.createJobId = options.createJobId ?? (() => `cb_${randomUUID()}`);
    this.warn = options.warn ?? ((message) => console.warn(message));
  }

  start(request: StartContextBuilderJobRequest): { jobId: string; descriptor: ContextBuilderJobDescriptor } {
    const descriptor = copyDescriptor(request.descriptor);
    const key = targetKey(descriptor.target);
    const outstandingJobId = this.outstandingJobIdByTarget.get(key);
    if (outstandingJobId) {
      const outstandingRecord = this.jobsById.get(outstandingJobId);
      if (!outstandingRecord) {
        throw new Error(`Context Builder occupancy invariant violated for job ${outstandingJobId}`);
      }
      const running = outstandingRecord.status === "running";
      throw new ContextBuilderJobError(
        running ? "context_builder_already_running" : "context_builder_result_unconsumed",
        running
          ? `Context Builder is already running for this app/window/tab as job "${outstandingJobId}". ` +
            "Wait for that job before starting another on this tab."
          : `Context Builder job "${outstandingJobId}" has a terminal result awaiting consumption. ` +
            "Wait for that job before starting another on this tab.",
        outstandingJobId,
        descriptor.target,
      );
    }

    if (this.jobsById.size >= CONTEXT_BUILDER_JOB_CAPACITY) {
      throw new ContextBuilderJobError(
        "context_builder_capacity_exceeded",
        `Context Builder has reached its ${CONTEXT_BUILDER_JOB_CAPACITY}-job capacity. ` +
          "Consume a terminal result or reset the RepoPrompt connection before starting another job.",
        undefined,
        descriptor.target,
      );
    }

    const jobId = this.createJobId();
    if (this.jobsById.has(jobId)) {
      throw new Error(`Context Builder job ID collision: ${jobId}`);
    }

    let notifyChanged!: RunningRecord["notifyChanged"];
    const changed = new Promise<Parameters<RunningRecord["notifyChanged"]>[0]>((resolve) => {
      notifyChanged = resolve;
    });
    const record: RunningRecord = {
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

      try {
        const result = await request.run(record.controller.signal);
        assertMcpToolResult(result);
        this.complete(jobId, record, result);
      } catch (error) {
        this.fail(jobId, record, error);
      }
    });

    return { jobId, descriptor: copyDescriptor(descriptor) };
  }

  async wait(jobId: string, signal?: AbortSignal): Promise<ContextBuilderJobWaitOutcome> {
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

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    const timeout = new Promise<{ kind: "timeout" }>((resolve) => {
      timeoutId = setTimeout(() => resolve({ kind: "timeout" }), this.waitTimeoutMs);
    });
    const aborted = new Promise<{ kind: "aborted" }>((resolve) => {
      if (!signal) {
        return;
      }
      abortListener = () => resolve({ kind: "aborted" });
      signal.addEventListener("abort", abortListener, { once: true });
    });

    try {
      const wake = await Promise.race([initial.changed, timeout, aborted]);
      if (wake.kind === "reset") {
        throw new ContextBuilderJobError(
          "context_builder_job_cancelled",
          `Context Builder job "${jobId}" was cancelled: ${wake.reason}.`,
          jobId,
          initial.descriptor.target,
        );
      }
      if (wake.kind === "aborted") {
        throw this.waitAborted(jobId, initial.descriptor.target);
      }

      const current = this.jobsById.get(jobId);
      if (!current) {
        if (this.resetGeneration !== waitGeneration) {
          if (!this.lastResetReason) {
            throw new Error("Context Builder reset generation invariant violated");
          }
          throw new ContextBuilderJobError(
            "context_builder_job_cancelled",
            `Context Builder job "${jobId}" was cancelled: ${this.lastResetReason}.`,
            jobId,
            initial.descriptor.target,
          );
        }
        throw this.unavailableJobError(jobId);
      }
      if (current.status === "running") {
        return { status: "running", jobId, descriptor: copyDescriptor(current.descriptor) };
      }
      return this.consume(jobId, current);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (signal && abortListener) {
        signal.removeEventListener("abort", abortListener);
      }
    }
  }

  reset(reason: ContextBuilderResetReason): void {
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

  private complete(jobId: string, record: RunningRecord, result: McpToolResult): void {
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

  private fail(jobId: string, record: RunningRecord, error: unknown): void {
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
    if (!record.controller.signal.aborted) {
      const { app, windowId, tab } = record.descriptor.target;
      this.warn(`Context Builder job ${jobId} failed for ${app}/${windowId}/${tab}: ${message}`);
    }
    record.notifyChanged({ kind: "settled" });
  }

  private consume(
    jobId: string,
    record: CompletedRecord | FailedRecord,
  ): ContextBuilderJobWaitOutcome {
    this.jobsById.delete(jobId);
    this.outstandingJobIdByTarget.delete(record.targetKey);
    this.rememberConsumed(jobId, record.descriptor.target);

    if (record.status === "failed") {
      throw new ContextBuilderJobError(
        "context_builder_job_failed",
        `Context Builder job "${jobId}" failed: ${record.message}`,
        jobId,
        record.descriptor.target,
      );
    }

    return {
      status: "completed",
      jobId,
      descriptor: copyDescriptor(record.descriptor),
      result: record.result,
    };
  }

  private rememberConsumed(jobId: string, target: ContextBuilderJobTarget): void {
    this.consumedTargetByJobId.set(jobId, { ...target });
    if (this.consumedTargetByJobId.size <= CONTEXT_BUILDER_CONSUMED_TOMBSTONE_LIMIT) {
      return;
    }

    const oldest = this.consumedTargetByJobId.keys().next();
    if (oldest.done) {
      throw new Error("Context Builder consumed tombstone invariant violated");
    }
    this.consumedTargetByJobId.delete(oldest.value);
  }

  private unavailableJobError(jobId: string): ContextBuilderJobError {
    const consumedTarget = this.consumedTargetByJobId.get(jobId);
    return consumedTarget
      ? new ContextBuilderJobError(
          "context_builder_job_consumed",
          `Context Builder job "${jobId}" has already been consumed.`,
          jobId,
          consumedTarget,
        )
      : new ContextBuilderJobError(
          "context_builder_job_not_found",
          `Unknown Context Builder job ID "${jobId}".`,
          jobId,
        );
  }

  private waitAborted(jobId: string, target?: ContextBuilderJobTarget): ContextBuilderJobError {
    return new ContextBuilderJobError(
      "context_builder_wait_aborted",
      `Waiting for Context Builder job "${jobId}" was cancelled; this wait did not cancel or consume the job.`,
      jobId,
      target,
    );
  }
}
