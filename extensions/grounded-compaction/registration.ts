import type {
    ExtensionAPI,
    ExtensionContext,
    SessionBeforeCompactEvent,
    SessionBeforeTreeEvent,
} from "@earendil-works/pi-coding-agent";

const CODEX_COMPACTION_COORDINATION_EVENT = "codex-compaction-coordinator:coordination-query";

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

export interface GroundedCompactionHandlers<CompactionResult, BranchSummaryResult> {
    runCompaction: (
        event: SessionBeforeCompactEvent,
        ctx: ExtensionContext,
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
        return handlers.runCompaction(event, ctx);
    });

    pi.on("session_before_tree", async (event, ctx) => handlers.runBranchSummary(event, ctx));
}
