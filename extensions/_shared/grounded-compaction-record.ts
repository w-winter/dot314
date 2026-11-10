import type { CompactionEntry } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

/** Key under a compaction entry's `details` where grounded-compaction stores its retention record. */
export const GROUNDED_RETENTION_DETAILS_KEY = "groundedRetention";

const RECORD_VERSION = 1;

/** Inclusive, 1-based line numbers within one user message's effective text. */
export const LineRangeSchema = Type.Object(
    {
        startLine: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
        endLine: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    },
    { additionalProperties: false },
);
export type LineRange = Static<typeof LineRangeSchema>;

const ContentHashSchema = Type.String({ pattern: "^[0-9a-f]{64}$" });

/** A shortening decision bound to one text revision, identified by the SHA-256 of that text. */
const SavedRetentionDecisionSchema = Type.Union([
    Type.Object(
        {
            contentHash: ContentHashSchema,
            action: Type.Literal("excerpt"),
            ranges: Type.Array(LineRangeSchema, { minItems: 1 }),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            contentHash: ContentHashSchema,
            action: Type.Literal("reference"),
            note: Type.String({ pattern: "\\S" }),
        },
        { additionalProperties: false },
    ),
]);
export type SavedRetentionDecision = Static<typeof SavedRetentionDecisionSchema>;

/**
 * What grounded-compaction persists with a compaction that retains user messages.
 * `summaryBody` is the model-written summary before any appended supplement or files-touched ledger, and the
 * saved summary begins with it. `decisions` is keyed by session entry ID. `retainedEntryIds` lists, in branch
 * order, the entries whose text or excerpt the saved summary actually carries.
 */
const GroundedRetentionRecordSchema = Type.Object(
    {
        version: Type.Literal(RECORD_VERSION),
        summaryBody: Type.String({ pattern: "\\S" }),
        decisions: Type.Record(Type.String(), SavedRetentionDecisionSchema),
        retainedEntryIds: Type.Array(Type.String()),
    },
    { additionalProperties: false },
);
export type GroundedRetentionRecord = Static<typeof GroundedRetentionRecordSchema>;

type SummaryCompaction = Pick<CompactionEntry, "id" | "summary" | "details">;

/**
 * The validated retention record saved with a compaction, or undefined when the compaction has none.
 * Throws when a record is present but has an unsupported version, fails the schema, or describes a body the
 * saved summary does not begin with.
 */
export function readGroundedRetentionRecord(entry: SummaryCompaction): GroundedRetentionRecord | undefined {
    const details = entry.details;
    if (details === null || details === undefined) return undefined;
    const marker = Object.getOwnPropertyDescriptor(details, GROUNDED_RETENTION_DETAILS_KEY);
    if (!marker) return undefined;
    const record: unknown = marker.value;
    if (!Check(GroundedRetentionRecordSchema, record)) {
        throw new Error(`Compaction ${entry.id} has an invalid grounded retention record`);
    }
    if (!entry.summary.startsWith(record.summaryBody)) {
        throw new Error(`Compaction ${entry.id} summary does not begin with its recorded summary body`);
    }
    return record;
}

/**
 * The model-written summary of a compaction: the recorded body when grounded-compaction appended retained
 * user messages after it, otherwise the saved summary unchanged. Throws on an invalid retention record.
 */
export function readGroundedSummaryBody(entry: SummaryCompaction): string {
    return readGroundedRetentionRecord(entry)?.summaryBody ?? entry.summary;
}
