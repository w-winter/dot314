import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";

import { loadConversionCompaction, type ConversionCompaction } from "./conversion-compaction.ts";
import { registerCodexCompactionPortability } from "./portability.ts";
import { registerCodexCompactionPrewarm } from "./prewarm.ts";
import { registerPortableSummaryEntryRenderer } from "./portable-summary-renderer.ts";
import { registerPreviousSummaryResponder } from "./previous-summary-responder.ts";

export const CODEX_COMPACTION_COORDINATION_EVENT =
    "codex-compaction-coordinator:coordination-query";

export type GroundedCoordinationResponse =
    | { status: "unavailable" }
    | { status: "available"; decision: "delegate-to-pi-pipeline" }
    | { status: "error"; error: string };

export type CodexCompactionCoordinationQuery = {
    kind: "grounded-session-compaction";
    model?: { provider: string; api: string; id: string };
    event: SessionBeforeCompactEvent;
    context: ExtensionContext;
    response: GroundedCoordinationResponse;
};

type ModelIdentity = { provider: string; api: string; id: string };

type MutableCoordinationQuery = {
    kind: unknown;
    model?: unknown;
    event?: unknown;
    context?: unknown;
    response: unknown;
};

// Pi supplies the full event and context. The schema checks the coordination envelope.
const CompactionRequestSchema = Type.Object({
    event: Type.Unsafe<SessionBeforeCompactEvent>(Type.Object({ branchEntries: Type.Array(Type.Object({ type: Type.String() })) })),
    context: Type.Unsafe<ExtensionContext>(Type.Object({ cwd: Type.String() })),
});

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
    let unsubscribePreviousSummary: (() => void) | undefined = registerPreviousSummaryResponder(pi);
    let unsubscribe: (() => void) | undefined;
    let conversion:
        | { status: "ready"; policy: ConversionCompaction | undefined }
        | { status: "error"; error: string } = { status: "error", error: "Compaction coordination has not initialized; run /reload." };

    pi.on("session_start", (_event, ctx) => {
        try {
            conversion = { status: "ready", policy: loadConversionCompaction(pi, ctx) };
        } catch (error) {
            conversion = { status: "error", error: error instanceof Error ? error.message : String(error) };
            if (ctx.hasUI) ctx.ui.notify(`Codex compaction coordination failed: ${conversion.error}`, "error");
        }
        pi.on("session_before_compact", (event, context) => {
            if (conversion.status === "error") {
                if (context.hasUI) context.ui.notify(`Codex compaction coordination failed: ${conversion.error}`, "error");
                return { cancel: true };
            }
            return conversion.policy?.prepare(event, context);
        });
    });

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
            if (conversion.status === "error") throw new Error(conversion.error);
            if (!Check(CompactionRequestSchema, payload)) throw new Error("Invalid compaction coordination request");
            const response: GroundedCoordinationResponse = conversion.policy?.delegates(payload.event, payload.context)
                ? { status: "available", decision: "delegate-to-pi-pipeline" }
                : { status: "unavailable" };
            payload.response = mergeCoordinationResponse(payload.response, response);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            payload.response = mergeCoordinationResponse(payload.response, {
                status: "error",
                error: `Codex compaction coordination failed: ${message}`,
            });
        }
    });

    pi.on("session_shutdown", () => {
        if (conversion.status === "ready") conversion.policy?.dispose();
        unsubscribe?.();
        unsubscribe = undefined;
        unsubscribePreviousSummary?.();
        unsubscribePreviousSummary = undefined;
    });
}
