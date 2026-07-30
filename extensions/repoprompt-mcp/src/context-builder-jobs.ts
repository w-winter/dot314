import { randomUUID } from "node:crypto";

import {
  RetainedMcpJobError,
  RetainedMcpJobRegistry,
  type RepoPromptJobResetReason,
  type RepoPromptJobTarget,
  type RetainedMcpJobFailure,
} from "./mcp-tool-jobs.js";
import type { McpToolResult, ToolCatalogFreshness } from "./types.js";

export const CONTEXT_BUILDER_WAIT_TIMEOUT_MS = 210_000;
export const CONTEXT_BUILDER_CONSUMED_TOMBSTONE_LIMIT = 256;
export const CONTEXT_BUILDER_JOB_CAPACITY = 16;

export type ContextBuilderResetReason = RepoPromptJobResetReason;
export type ContextBuilderJobTarget = RepoPromptJobTarget;

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

export interface ContextBuilderJobManagerOptions {
  waitTimeoutMs?: number;
  createJobId?: () => string;
  warn?: (message: string) => void | Promise<void>;
}

function copyDescriptor(descriptor: ContextBuilderJobDescriptor): ContextBuilderJobDescriptor {
  return {
    ...descriptor,
    target: { ...descriptor.target },
    userArgs: structuredClone(descriptor.userArgs),
  };
}

function contextBuilderError(failure: RetainedMcpJobFailure): Error {
  switch (failure.reason) {
    case "target_occupied": {
      const running = failure.status === "running";
      return new ContextBuilderJobError(
        running ? "context_builder_already_running" : "context_builder_result_unconsumed",
        running
          ? `Context Builder is already running for this app/window/tab as job "${failure.jobId}". ` +
            "Wait for that job before starting another on this tab."
          : `Context Builder job "${failure.jobId}" has a terminal result awaiting consumption. ` +
            "Wait for that job before starting another on this tab.",
        failure.jobId,
        failure.target,
      );
    }
    case "capacity_exceeded":
      return new ContextBuilderJobError(
        "context_builder_capacity_exceeded",
        `Context Builder has reached its ${failure.capacity}-job capacity. ` +
          "Consume a terminal result or reset the RepoPrompt connection before starting another job.",
        undefined,
        failure.target,
      );
    case "id_collision":
      return new Error(`Context Builder job ID collision: ${failure.jobId}`);
    case "cancelled":
      return new ContextBuilderJobError(
        "context_builder_job_cancelled",
        `Context Builder job "${failure.jobId}" was cancelled: ${failure.resetReason}.`,
        failure.jobId,
        failure.target,
      );
    case "consumed":
      return new ContextBuilderJobError(
        "context_builder_job_consumed",
        `Context Builder job "${failure.jobId}" has already been consumed.`,
        failure.jobId,
        failure.target,
      );
    case "not_found":
      return new ContextBuilderJobError(
        "context_builder_job_not_found",
        `Unknown Context Builder job ID "${failure.jobId}".`,
        failure.jobId,
      );
    case "wait_aborted":
      return new ContextBuilderJobError(
        "context_builder_wait_aborted",
        `Waiting for Context Builder job "${failure.jobId}" was cancelled; ` +
          "this wait did not cancel or consume the job.",
        failure.jobId,
        failure.target,
      );
  }
}

export class ContextBuilderJobManager {
  private readonly registry: RetainedMcpJobRegistry<ContextBuilderJobDescriptor>;

  constructor(options: ContextBuilderJobManagerOptions = {}) {
    const warn = options.warn ?? ((message: string) => console.warn(message));
    this.registry = new RetainedMcpJobRegistry({
      waitTimeoutMs: options.waitTimeoutMs ?? CONTEXT_BUILDER_WAIT_TIMEOUT_MS,
      capacity: CONTEXT_BUILDER_JOB_CAPACITY,
      consumedTombstoneLimit: CONTEXT_BUILDER_CONSUMED_TOMBSTONE_LIMIT,
      consumedJobIdPolicy: "reuse",
      createJobId: options.createJobId ?? (() => `cb_${randomUUID()}`),
      cloneDescriptor: copyDescriptor,
      invalidResultMessage: "Context Builder runner returned an invalid MCP tool result",
      onDetachedFailure: (jobId, descriptor, message) => {
        const { app, windowId, tab } = descriptor.target;
        return warn(`Context Builder job ${jobId} failed for ${app}/${windowId}/${tab}: ${message}`);
      },
    });
  }

  start(request: StartContextBuilderJobRequest): { jobId: string; descriptor: ContextBuilderJobDescriptor } {
    try {
      return this.registry.start(request);
    } catch (error) {
      if (error instanceof RetainedMcpJobError) {
        throw contextBuilderError(error.failure);
      }
      throw error;
    }
  }

  async wait(jobId: string, signal?: AbortSignal): Promise<ContextBuilderJobWaitOutcome> {
    try {
      const outcome = await this.registry.wait(jobId, signal);
      if (outcome.status === "failed") {
        throw new ContextBuilderJobError(
          "context_builder_job_failed",
          `Context Builder job "${jobId}" failed: ${outcome.message}`,
          jobId,
          outcome.descriptor.target,
        );
      }
      return outcome;
    } catch (error) {
      if (error instanceof RetainedMcpJobError) {
        throw contextBuilderError(error.failure);
      }
      throw error;
    }
  }

  reset(reason: ContextBuilderResetReason): void {
    this.registry.reset(reason);
  }
}
