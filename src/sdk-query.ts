// Shared mutable SDK query factory + its test seam. In its own module so both
// the provider entry (index.ts) and the account host spawn children through
// the same seam — tests swap the factory once and every spawn path honors it.

import { query } from "@anthropic-ai/claude-agent-sdk";

export type SdkQueryFactory = typeof query;

let sdkQueryFactory: SdkQueryFactory = query;

/** Starts a query through the current factory, so a swapped test factory
 *  reaches every spawn path. */
export function sdkQuery(params: Parameters<SdkQueryFactory>[0]): ReturnType<SdkQueryFactory> {
	return sdkQueryFactory(params);
}

/** Test seam for exercising the real bridge retry/session orchestration without
 *  spending Claude usage. Production never calls this. */
export function __testSetSdkQueryFactory(factory?: SdkQueryFactory): void {
	sdkQueryFactory = factory ?? query;
}
