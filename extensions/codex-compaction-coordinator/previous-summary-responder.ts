import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

import { describeNativeEpoch } from "./native-checkpoint-source.ts";
import { derivePortablePlan, discoverChain } from "./portability.ts";

/** Grounded-compaction asks this before summarizing from a previous compaction entry's stored summary. */
export const GROUNDED_PREVIOUS_SUMMARY_EVENT = "grounded-compaction:previous-summary-query";

const INCOMPLETE_SUMMARY_MESSAGE = "The portable summary of the latest Codex checkpoint is not complete yet, so compaction was skipped. "
    + "It is built on the next request to this model; /codex-portability prewarm builds it now.";

type PreviousSummaryResponse =
    | { status: "unavailable" }
    | { status: "available"; summary: string }
    | { status: "error"; error: string };

// Entries come from Pi's session through grounded-compaction; the coordinator's own readers validate their fields.
const SessionEntrySchema = Type.Unsafe<SessionEntry>(Type.Object({ id: Type.String(), type: Type.String() }));

/** Grounded-compaction's payload; the responder writes its answer to `response`. */
const PreviousSummaryQuerySchema = Type.Object({
    kind: Type.Literal("readable-previous-summary"),
    compactionEntryId: Type.String(),
    branchEntries: Type.Array(SessionEntrySchema),
    sessionEntries: Type.Array(SessionEntrySchema),
    response: Type.Unknown(),
});

type PreviousSummaryQuery = Static<typeof PreviousSummaryQuerySchema>;

/**
 * Answers for the latest native checkpoint on the branch with its complete portable summary. Returns undefined
 * when the entry is not that checkpoint, or when the checkpoint covers no visible history, so the stored summary stands.
 */
function resolvePreviousSummary(query: PreviousSummaryQuery): PreviousSummaryResponse | undefined {
    const epoch = describeNativeEpoch(query.branchEntries);
    // An epoch error means a native checkpoint follows the latest plaintext compaction, so the entry is a checkpoint.
    if (epoch.status === "error") return { status: "error", error: epoch.message };
    if (epoch.checkpoints.at(-1)?.entryId !== query.compactionEntryId) return undefined;
    const plan = derivePortablePlan(query.branchEntries, epoch);
    const chain = discoverChain(plan, query.sessionEntries, query.branchEntries, () => undefined);
    if (chain.completedCheckpoints !== plan.checkpoints.length || chain.tip?.record.state !== "complete") {
        return { status: "error", error: INCOMPLETE_SUMMARY_MESSAGE };
    }
    return chain.summary === null ? undefined : { status: "available", summary: chain.summary };
}

/** Registers the coordinator's answer to grounded-compaction's previous-summary query; returns its unsubscribe. */
export function registerPreviousSummaryResponder(pi: ExtensionAPI): () => void {
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Pi's event bus delivers untyped payloads; the schema check parses this one.
    return pi.events.on(GROUNDED_PREVIOUS_SUMMARY_EVENT, (payload: unknown) => {
        if (!Check(PreviousSummaryQuerySchema, payload)) return;
        try {
            const response = resolvePreviousSummary(payload);
            if (response) payload.response = response;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error({
                component: "codex-compaction-coordinator",
                code: "PREVIOUS_SUMMARY_LOOKUP_FAILED",
                compactionEntryId: payload.compactionEntryId,
                message,
            });
            payload.response = { status: "error", error: `Portable summary lookup failed: ${message}` };
        }
    });
}
