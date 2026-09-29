// Shared mutable SDK query factory + its test seam. In its own module so both
// the provider entry (index.ts) and the account host spawn children through
// the same seam — tests swap the factory once and every spawn path honors it.

import { query } from "@anthropic-ai/claude-agent-sdk";
import { isBridgeClaudeError } from "./claude-executable.js";
import { markExternalError } from "./incidents.js";

export type SdkQueryFactory = typeof query;

let sdkQueryFactory: SdkQueryFactory = query;

/** The text of an error the SDK threw. It is registered as Claude Code's own
 *  (markExternalError: it reaches Pi without an incident) unless the bridge
 *  wrote it, as its spawn diagnostic or executable preflight, which the SDK
 *  can pass through or rewrap (isBridgeClaudeError). Those name an incident
 *  where they reach Pi. */
export function sdkErrorText(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	return isBridgeClaudeError(error) ? text : markExternalError(text);
}

/** Starts a query through the current factory, so a swapped test factory
 *  reaches every spawn path. What the SDK throws is its own error unless the
 *  bridge wrote it (sdkErrorText). */
export function sdkQuery(params: Parameters<SdkQueryFactory>[0]): ReturnType<SdkQueryFactory> {
	try {
		return sdkQueryFactory(params);
	} catch (error) {
		if (error instanceof Error && typeof error.message === "string") sdkErrorText(error);
		throw error;
	}
}

/** Test seam for exercising the real bridge retry/session orchestration without
 *  spending Claude usage. Production never calls this. */
export function __testSetSdkQueryFactory(factory?: SdkQueryFactory): void {
	sdkQueryFactory = factory ?? query;
}
