import { randomUUID } from "node:crypto";

import {
  RetainedMcpJobError,
  RetainedMcpJobRegistry,
  type RepoPromptJobResetReason,
  type RepoPromptJobTarget,
  type RetainedMcpJobFailure,
  type RetainedMcpJobWaitPolicy,
} from "./mcp-tool-jobs.js";
import type { McpToolResult, ToolCatalogFreshness } from "./types.js";

export const ORACLE_SEND_TOOL_NAME = "oracle_send";
export const ORACLE_SEND_WAIT_TOOL_NAME = "oracle_send_wait";
export const ORACLE_SEND_JOB_CAPACITY = 16;
export const ORACLE_SEND_CONSUMED_TOMBSTONE_LIMIT = 256;

export interface OracleSendJobDescriptor {
  readonly target: RepoPromptJobTarget;
  readonly toolName: string;
  readonly userArgs: Readonly<Record<string, unknown>>;
  readonly toolCatalogFreshness: ToolCatalogFreshness;
  readonly toolInputSchema?: unknown;
}

export interface StartOracleSendJobRequest {
  readonly descriptor: OracleSendJobDescriptor;
  run(signal: AbortSignal): Promise<McpToolResult>;
}

export type OracleSendJobWaitOutcome =
  | {
      readonly status: "running";
      readonly jobId: string;
      readonly descriptor: OracleSendJobDescriptor;
    }
  | {
      readonly status: "completed";
      readonly jobId: string;
      readonly descriptor: OracleSendJobDescriptor;
      readonly result: McpToolResult;
    }
  | {
      readonly status: "failed";
      readonly jobId: string;
      readonly descriptor: OracleSendJobDescriptor;
      readonly message: string;
    };

export type OracleSendJobErrorCode =
  | "oracle_send_already_running"
  | "oracle_send_capacity_exceeded"
  | "oracle_send_job_cancelled"
  | "oracle_send_job_consumed"
  | "oracle_send_job_not_found"
  | "oracle_send_result_unconsumed"
  | "oracle_send_wait_aborted";

export class OracleSendJobError extends Error {
  readonly code: OracleSendJobErrorCode;
  readonly jobId?: string;
  readonly target?: RepoPromptJobTarget;

  constructor(
    code: OracleSendJobErrorCode,
    message: string,
    jobId?: string,
    target?: RepoPromptJobTarget,
  ) {
    super(message);
    this.name = "OracleSendJobError";
    this.code = code;
    this.jobId = jobId;
    this.target = target ? { ...target } : undefined;
  }
}

export interface OracleSendJobManagerOptions {
  readonly createJobId?: () => string;
  readonly warn?: (message: string) => void | Promise<void>;
}

function copyDescriptor(descriptor: OracleSendJobDescriptor): OracleSendJobDescriptor {
  return {
    ...descriptor,
    target: { ...descriptor.target },
    userArgs: structuredClone(descriptor.userArgs),
    toolInputSchema: structuredClone(descriptor.toolInputSchema),
  };
}

function oracleSendError(failure: RetainedMcpJobFailure): Error {
  switch (failure.reason) {
    case "target_occupied": {
      const running = failure.status === "running";
      return new OracleSendJobError(
        running ? "oracle_send_already_running" : "oracle_send_result_unconsumed",
        running
          ? `Oracle send is already running for this app/window/tab as job "${failure.jobId}". ` +
            "Wait for that job before starting another on this tab."
          : `Oracle send job "${failure.jobId}" has a terminal result awaiting consumption. ` +
            "Wait for that job before starting another on this tab.",
        failure.jobId,
        failure.target,
      );
    }
    case "capacity_exceeded":
      return new OracleSendJobError(
        "oracle_send_capacity_exceeded",
        `Oracle send has reached its ${failure.capacity}-job capacity. ` +
          "Consume a terminal result or reset the RepoPrompt connection before starting another job.",
        undefined,
        failure.target,
      );
    case "id_collision":
      return new Error(`Retained MCP job ID collision: ${failure.jobId}`);
    case "cancelled":
      return new OracleSendJobError(
        "oracle_send_job_cancelled",
        `Oracle send job "${failure.jobId}" was cancelled: ${failure.resetReason}.`,
        failure.jobId,
        failure.target,
      );
    case "consumed":
      return new OracleSendJobError(
        "oracle_send_job_consumed",
        `Oracle send job "${failure.jobId}" has already been consumed.`,
        failure.jobId,
        failure.target,
      );
    case "not_found":
      return new OracleSendJobError(
        "oracle_send_job_not_found",
        `Unknown Oracle send job ID "${failure.jobId}".`,
        failure.jobId,
      );
    case "wait_aborted":
      return new OracleSendJobError(
        "oracle_send_wait_aborted",
        `Waiting for Oracle send job "${failure.jobId}" was cancelled; ` +
          "this wait did not cancel or consume the job.",
        failure.jobId,
        failure.target,
      );
  }
}

export class OracleSendJobManager {
  private readonly registry: RetainedMcpJobRegistry<OracleSendJobDescriptor>;

  constructor(options: OracleSendJobManagerOptions = {}) {
    const warn = options.warn ?? ((message: string) => console.warn(message));
    this.registry = new RetainedMcpJobRegistry({
      capacity: ORACLE_SEND_JOB_CAPACITY,
      consumedTombstoneLimit: ORACLE_SEND_CONSUMED_TOMBSTONE_LIMIT,
      consumedJobIdPolicy: "reject",
      createJobId: options.createJobId ?? (() => `oracle_${randomUUID()}`),
      cloneDescriptor: copyDescriptor,
      invalidResultMessage: "Oracle send runner returned an invalid MCP tool result",
      onDetachedFailure: (jobId, descriptor, _message, kind) => {
        const { app, windowId, tab } = descriptor.target;
        const cause = kind === "invalid_result" ? "invalid MCP result" : "upstream call rejected";
        return warn(`Oracle send job ${jobId} failed for ${app}/${windowId}/${tab}: ${cause}`);
      },
    });
  }

  start(request: StartOracleSendJobRequest): { jobId: string; descriptor: OracleSendJobDescriptor } {
    try {
      return this.registry.start(request);
    } catch (error) {
      if (error instanceof RetainedMcpJobError) {
        throw oracleSendError(error.failure);
      }
      throw error;
    }
  }

  async wait(
    jobId: string,
    policy: RetainedMcpJobWaitPolicy,
    signal?: AbortSignal,
  ): Promise<OracleSendJobWaitOutcome> {
    try {
      return await this.registry.wait(jobId, policy, signal);
    } catch (error) {
      if (error instanceof RetainedMcpJobError) {
        throw oracleSendError(error.failure);
      }
      throw error;
    }
  }

  reset(reason: RepoPromptJobResetReason): void {
    this.registry.reset(reason);
  }
}
