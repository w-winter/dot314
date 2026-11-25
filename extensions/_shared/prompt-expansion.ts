import { createHash, randomUUID } from "node:crypto";
import { Type } from "typebox";
import { Check } from "typebox/value";

const PREFIX = "<!-- pi-prompt-expansion ";
const SUFFIX = " -->";

type TextRange = readonly [start: number, end: number];

const OffsetSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const MetadataSchema = Type.Object({
    source: Type.String({ minLength: 1 }),
    hash: Type.String(),
    instructionsHash: Type.String(),
    userTextRanges: Type.Array(Type.Tuple([OffsetSchema, OffsetSchema])),
}, { additionalProperties: false });

export interface PromptExpansion {
    source: string;
    text: string;
    /** UTF-16 offsets in text, with an exclusive end. */
    userTextRanges: readonly TextRange[];
    instructionsKey: string;
    /** Ranges enclosing user text in the serialized message, including inserted metadata when crossed. */
    protectedRanges: readonly TextRange[];
}

const digest = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

function hashInstructions(source: string, text: string, ranges: readonly TextRange[]): string {
    const instructions: string[] = [];
    let cursor = 0;
    for (const [start, end] of ranges) {
        instructions.push(text.slice(cursor, start));
        cursor = end;
    }
    instructions.push(text.slice(cursor));
    return digest(JSON.stringify([source, instructions]));
}

/** Records user-text boundaries before interpolation removes the distinction from generated instructions. */
export class PromptExpansionWriter {
    private readonly marker = `pi-user-text-${randomUUID()}:`;
    private readonly values: string[] = [];
    private readonly source: string;

    constructor(source: string) { this.source = source; }

    userText(text: string): string {
        const index = this.values.push(text) - 1;
        return `${this.marker}${index};`;
    }

    expand(rendered: string) {
        let text = "";
        let cursor = 0;
        const userTextRanges: TextRange[] = [];
        for (const match of rendered.matchAll(new RegExp(`${this.marker}(\\d+);`, "g"))) {
            text += rendered.slice(cursor, match.index);
            const value = this.values.at(Number(match[1]));
            if (value === undefined) throw new Error("Unknown prompt expansion user-text marker");
            const start = text.length;
            text += value;
            userTextRanges.push([start, text.length]);
            cursor = match.index + match[0].length;
        }
        return { text: text + rendered.slice(cursor), userTextRanges };
    }

    serialize(rendered: string): string {
        const { text, userTextRanges } = this.expand(rendered);
        const metadata = {
            source: this.source, hash: digest(text), userTextRanges,
            instructionsHash: hashInstructions(this.source, text, userTextRanges),
        };
        const newline = text.indexOf("\n");
        const offset = newline < 0 ? text.length : newline;
        // Keep the first line intact so Pi still recognizes the skill envelope.
        return `${text.slice(0, offset)}\n${PREFIX}${JSON.stringify(metadata)}${SUFFIX}${text.slice(offset)}`;
    }
}

/** Validates expansion metadata against its exact text revision before exposing user-text ranges. */
export function readPromptExpansion(serialized: string): PromptExpansion | undefined {
    const newline = serialized.indexOf("\n");
    if (newline < 0 || !serialized.startsWith(PREFIX, newline + 1)) return undefined;
    const nextNewline = serialized.indexOf("\n", newline + 1);
    const header = serialized.slice(newline + 1, nextNewline < 0 ? undefined : nextNewline);
    if (!header.endsWith(SUFFIX)) throw new Error("Invalid prompt expansion header");
    let metadata: unknown;
    try { metadata = JSON.parse(header.slice(PREFIX.length, -SUFFIX.length)); }
    catch (cause) { throw new Error("Invalid prompt expansion metadata JSON", { cause }); }
    if (!Check(MetadataSchema, metadata)) throw new Error("Invalid prompt expansion metadata");
    const text = serialized.slice(0, newline) + (nextNewline < 0 ? "" : serialized.slice(nextNewline));
    if (digest(text) !== metadata.hash) throw new Error("Prompt expansion text does not match its metadata");
    const userTextRanges: TextRange[] = [];
    let cursor = 0;
    for (const [start, end] of metadata.userTextRanges) {
        if (start < cursor || end < start || end > text.length) throw new Error("Invalid prompt expansion range");
        userTextRanges.push([start, end]);
        cursor = end;
    }
    const instructionsKey = hashInstructions(metadata.source, text, userTextRanges);
    if (instructionsKey !== metadata.instructionsHash) throw new Error("Invalid prompt expansion instructions hash");
    const serializedOffset = (offset: number) => offset + (offset >= newline ? header.length + 1 : 0);
    return {
        source: metadata.source, text, userTextRanges,
        protectedRanges: userTextRanges.map(([start, end]) => [serializedOffset(start), serializedOffset(end)]),
        instructionsKey,
    };
}
