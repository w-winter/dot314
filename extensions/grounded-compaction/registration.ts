import type {
    ExtensionAPI,
    ExtensionContext,
    SessionBeforeCompactEvent,
    SessionBeforeTreeEvent,
    SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

const CODEX_COMPACTION_COORDINATION_EVENT = "codex-compaction-coordinator:coordination-query";
const PREVIOUS_SUMMARY_EVENT = "grounded-compaction:previous-summary-query";

/**
 * Another extension's answer for a previous compaction entry: `unavailable` keeps the stored summary,
 * `available` replaces it with readable text, and `error` means the entry's owner cannot supply that text now.
 */
const PreviousSummaryResponseSchema = Type.Union([
    Type.Object({ status: Type.Literal("unavailable") }, { additionalProperties: false }),
    Type.Object({ status: Type.Literal("available"), summary: Type.String({ pattern: "\\S" }) }, { additionalProperties: false }),
    Type.Object({ status: Type.Literal("error"), error: Type.String({ pattern: "\\S" }) }, { additionalProperties: false }),
]);
export type PreviousSummaryResponse = Static<typeof PreviousSummaryResponseSchema>;

export type PreviousSummaryRequest = {
    compactionEntryId: string;
    branchEntries: readonly SessionEntry[];
    /** Every session entry, so an owner can find records stored on sibling branches. */
    sessionEntries: readonly SessionEntry[];
};

export type PreviousSummaryLookup = (request: PreviousSummaryRequest) => PreviousSummaryResponse;

/** The emitted payload. A listener may replace `response` with anything, so it is parsed after the emit. */
type PreviousSummaryQuery = PreviousSummaryRequest & {
    kind: "readable-previous-summary";
    response: unknown;
};

type GroundedCoordinationResponse =
    | { status: "unavailable" }
    | { status: "available"; decision: "delegate-to-pi-pipeline" }
    | { status: "error"; error: string };

type GroundedCompactionCoordinationQuery = {
    kind: "grounded-session-compaction";
    model?: { provider: string; api: string; id: string };
    response: GroundedCoordinationResponse;
};

function hasExactEnumerableOwnKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    const actualKeys = Object.keys(value);
    return actualKeys.length === keys.length && actualKeys.every((key) => keys.includes(key));
}

function normalizeGroundedCoordinationResponse(value: unknown): GroundedCoordinationResponse {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return { status: "error", error: "invalid response from compaction coordinator" };
    }
    const response = value as Record<string, unknown>;
    if (hasExactEnumerableOwnKeys(response, ["status"]) && response.status === "unavailable") {
        return { status: "unavailable" };
    }
    if (
        hasExactEnumerableOwnKeys(response, ["status", "decision"])
        && response.status === "available"
        && response.decision === "delegate-to-pi-pipeline"
    ) {
        return { status: "available", decision: "delegate-to-pi-pipeline" };
    }
    if (
        hasExactEnumerableOwnKeys(response, ["status", "error"])
        && response.status === "error"
        && typeof response.error === "string"
        && response.error
    ) {
        return { status: "error", error: response.error };
    }
    return { status: "error", error: "invalid response from compaction coordinator" };
}

/** Asks other extensions for readable text standing in for a previous compaction entry's stored summary. */
function queryReadablePreviousSummary(pi: ExtensionAPI, request: PreviousSummaryRequest): PreviousSummaryResponse {
    const query: PreviousSummaryQuery = { kind: "readable-previous-summary", ...request, response: { status: "unavailable" } };
    pi.events.emit(PREVIOUS_SUMMARY_EVENT, query);
    return Check(PreviousSummaryResponseSchema, query.response)
        ? query.response
        : { status: "error", error: "invalid previous-summary response" };
}

export interface GroundedCompactionHandlers<CompactionResult, BranchSummaryResult> {
    runCompaction: (
        event: SessionBeforeCompactEvent,
        ctx: ExtensionContext,
        queryPreviousSummary: PreviousSummaryLookup,
    ) => Promise<CompactionResult> | CompactionResult;
    runBranchSummary: (
        event: SessionBeforeTreeEvent,
        ctx: ExtensionContext,
    ) => Promise<BranchSummaryResult> | BranchSummaryResult;
}

export function queryGroundedCompactionDelegation(
    pi: ExtensionAPI,
    model: GroundedCompactionCoordinationQuery["model"],
): GroundedCoordinationResponse {
    const query: GroundedCompactionCoordinationQuery = {
        kind: "grounded-session-compaction",
        model,
        response: { status: "unavailable" },
    };
    pi.events.emit(CODEX_COMPACTION_COORDINATION_EVENT, query);
    return normalizeGroundedCoordinationResponse(query.response);
}

export function registerGroundedCompactionHandlers<CompactionResult, BranchSummaryResult>(
    pi: ExtensionAPI,
    handlers: GroundedCompactionHandlers<CompactionResult, BranchSummaryResult>,
): void {
    pi.on("session_before_compact", async (event, ctx) => {
        const coordination = queryGroundedCompactionDelegation(pi, ctx.model);
        if (coordination.status === "available") {
            return undefined;
        }
        if (coordination.status === "error") {
            if (ctx.hasUI) {
                ctx.ui.notify(`Grounded compaction coordination failed: ${coordination.error}`, "error");
            }
            return { cancel: true };
        }
        return handlers.runCompaction(event, ctx, (request) => queryReadablePreviousSummary(pi, request));
    });

    pi.on("session_before_tree", async (event, ctx) => handlers.runBranchSummary(event, ctx));
}
