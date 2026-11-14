import { realpathSync, statSync } from "node:fs";
import path from "node:path";

import type { BranchSummaryEntry, CompactionEntry } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

const ReadingResponseSchema = Type.Object({ paths: Type.Array(Type.String({ minLength: 1 })) }, { additionalProperties: false });
const ReadingRecordSchema = Type.Object({
    version: Type.Literal(1), paths: ReadingResponseSchema.properties.paths,
}, { additionalProperties: false });

export type RequiredReadingRecord = Static<typeof ReadingRecordSchema>;

interface RequiredReadingResponse {
    summaryBody: string;
    reading: RequiredReadingRecord;
}

export class RequiredReadingError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "RequiredReadingError";
    }
}

export const REQUIRED_READING_INSTRUCTIONS = `## Required reading response contract
Choose the smallest set of text files the next agent needs to read before continuing the task. List absolute paths to individual files, not directories, globs or URLs. Include needed files even if they were read earlier: the harness checks whether their contents are still available to the next agent.

Finish your response with exactly one block in this form, replacing the example path:
<grounded-required-reading>
{"paths":["/absolute/path/to/file"]}
</grounded-required-reading>
Include the block even when no files are needed, using {"paths":[]}. The JSON object must contain only the paths array. Put each tag on its own unindented line. Do not wrap the block in a code fence or write anything after the closing tag.

Put reading requirements only in this block. Other file references may remain in the summary when they explain the work.`;

/** Parses the extension-owned final response block. Missing, ambiguous or malformed lists reject the summary. */
export function parseRequiredReadingResponse(response: string): RequiredReadingResponse {
    const match = /(?:^|\n)<grounded-required-reading>\r?\n([\s\S]*?)\r?\n<\/grounded-required-reading>\s*$/.exec(response);
    if (!match || [...response.matchAll(/^<\/?grounded-required-reading>\r?$/gm)].length !== 2) {
        throw new RequiredReadingError("Missing or ambiguous grounded-required-reading response block");
    }
    const value: unknown = JSON.parse(match[1]);
    if (!Check(ReadingResponseSchema, value) || value.paths.some((file) => !path.isAbsolute(file) || file.includes("\0"))) {
        throw new RequiredReadingError("Required reading must contain only absolute file paths");
    }
    const summaryBody = response.slice(0, match.index).trim();
    if (!summaryBody) throw new RequiredReadingError("Required reading response has no summary body");
    return { summaryBody, reading: { version: 1, paths: [...new Set(value.paths.map(canonicalReadingPath))] } };
}

/** Reads validated metadata, never prose that happens to mention a reading list. */
export function requiredReadingRecord(entry: CompactionEntry | BranchSummaryEntry): RequiredReadingRecord | undefined {
    if (entry.details === null || entry.details === undefined) return undefined;
    const property = Object.getOwnPropertyDescriptor(entry.details, "groundedReading");
    if (!property) return undefined;
    const record: unknown = property.value;
    if (!Check(ReadingRecordSchema, record) || record.paths.some((file) => !path.isAbsolute(file) || file.includes("\0"))) {
        throw new RequiredReadingError(`Invalid required-reading metadata on entry ${entry.id}`);
    }
    return record;
}

export function canonicalReadingPath(file: string): string {
    return statSync(file, { throwIfNoEntry: false }) ? realpathSync(file) : path.resolve(file);
}

/** Keeps the requirements available to subsequent summarizers while enforcement uses the saved metadata. */
export function appendRequiredReading(summary: string, reading: RequiredReadingRecord): string {
    return `${summary.trimEnd()}\n\n<grounded-required-reading>\n${JSON.stringify({ paths: reading.paths })}\n</grounded-required-reading>`;
}
