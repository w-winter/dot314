import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerCodexCompactionPortability } from "./portability.ts";
import { registerCodexCompactionPrewarm } from "./prewarm.ts";
import { registerPortableSummaryEntryRenderer } from "./portable-summary-renderer.ts";

export const CODEX_COMPACTION_COORDINATION_EVENT =
    "codex-compaction-coordinator:coordination-query";

export type GroundedCoordinationResponse =
    | { status: "unavailable" }
    | { status: "available"; decision: "delegate-to-pi-pipeline" }
    | { status: "error"; error: string };

export type CodexCompactionCoordinationQuery = {
    kind: "grounded-session-compaction";
    model?: { provider: string; api: string; id: string };
    response: GroundedCoordinationResponse;
};

type ModelIdentity = { provider: string; api: string; id: string };

type MutableCoordinationQuery = {
    kind: unknown;
    model?: unknown;
    response: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasExactEnumerableOwnKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    const actualKeys = Object.keys(value);
    return actualKeys.length === keys.length && actualKeys.every((key) => keys.includes(key));
}

function isModelIdentity(value: unknown): value is ModelIdentity {
    return isRecord(value)
        && typeof value.provider === "string"
        && typeof value.api === "string"
        && typeof value.id === "string";
}

function isCanonicalCodexModel(model: ModelIdentity): boolean {
    return model.provider === "openai-codex" && model.api === "openai-codex-responses";
}

function isMutableCoordinationQuery(value: unknown): value is MutableCoordinationQuery {
    return isRecord(value) && Object.hasOwn(value, "response");
}

function normalizeCoordinationResponse(value: unknown): GroundedCoordinationResponse {
    if (!isRecord(value)) return { status: "error", error: "Invalid compaction coordination response" };
    if (hasExactEnumerableOwnKeys(value, ["status"]) && value.status === "unavailable") {
        return { status: "unavailable" };
    }
    if (
        hasExactEnumerableOwnKeys(value, ["status", "decision"])
        && value.status === "available"
        && value.decision === "delegate-to-pi-pipeline"
    ) {
        return { status: "available", decision: value.decision };
    }
    if (
        hasExactEnumerableOwnKeys(value, ["status", "error"])
        && value.status === "error"
        && typeof value.error === "string"
        && value.error
    ) {
        return { status: "error", error: value.error };
    }
    return { status: "error", error: "Invalid compaction coordination response" };
}

function mergeCoordinationResponse(
    current: unknown,
    next: GroundedCoordinationResponse,
): GroundedCoordinationResponse {
    const normalized = normalizeCoordinationResponse(current);
    if (normalized.status === "error") return normalized;
    if (next.status === "error") return next;
    if (normalized.status === "unavailable") return next;
    return normalized;
}

export default function codexCompactionCoordinator(pi: ExtensionAPI): void {
    registerPortableSummaryEntryRenderer(pi);
    registerCodexCompactionPrewarm(pi);
    registerCodexCompactionPortability(pi);
    let unsubscribe: (() => void) | undefined;

    unsubscribe = pi.events.on(CODEX_COMPACTION_COORDINATION_EVENT, (payload: unknown) => {
        if (
            !isMutableCoordinationQuery(payload)
            || payload.kind !== "grounded-session-compaction"
            || !isModelIdentity(payload.model)
        ) {
            return;
        }

        if (!isCanonicalCodexModel(payload.model)) {
            return;
        }

        try {
            payload.response = mergeCoordinationResponse(payload.response, {
                status: "available",
                decision: "delegate-to-pi-pipeline",
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            payload.response = mergeCoordinationResponse(payload.response, {
                status: "error",
                error: `Codex compaction coordination failed: ${message}`,
            });
        }
    });

    pi.on("session_shutdown", () => {
        unsubscribe?.();
        unsubscribe = undefined;
    });
}
