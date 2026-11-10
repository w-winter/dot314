import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { constants } from "node:fs";
import { link, mkdir, open, unlink } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";

import { contentText, getCurrentSystemMessage, type UserMessage, type SystemMessage } from "@earendil-works/pi-ai";
import { estimateMessageTokens, estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import {
    buildSessionProjection,
    convertToLlm,
    type CompactionEntry,
    type ContextEditEntry,
    type ProjectedSessionEntry,
    type SessionBeforeCompactEvent,
    type SessionEntry,
    type SessionMessageEntry,
    type SessionProjection,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";

import {
    LineRangeSchema,
    readGroundedRetentionRecord,
    type LineRange,
    type SavedRetentionDecision,
    type GroundedRetentionRecord,
} from "../_shared/grounded-compaction-record.ts";
import { serializeConversationForCompaction } from "../_shared/compaction-serialization.ts";
import { appendReaderLedger, stripGroundedCompactionManifestTail, type FilesTouchedLedger } from "./prompts.ts";
import type { PreviousSummaryResponse } from "./registration.ts";

type ProjectedMessage = ProjectedSessionEntry["messages"][number];

export type RetentionErrorCode =
    | "session-state"
    | "source-mapping"
    | "previous-summary"
    | "invalid-record"
    | "invalid-decisions"
    | "continuation-capacity"
    | "recovery-file";

/** A retention failure. Messages carry identifiers and counts only, never source text. */
export class RetentionError extends Error {
    readonly code: RetentionErrorCode;
    readonly entryIds: readonly string[];

    constructor(code: RetentionErrorCode, message: string, entryIds: readonly string[] = [], options?: ErrorOptions) {
        super(message, options);
        this.name = "RetentionError";
        this.code = code;
        this.entryIds = entryIds;
    }
}

/** One line of a text: `[start, contentEnd)` is its content and `[start, end)` includes its terminator. */
export interface TextLine {
    start: number;
    contentEnd: number;
    end: number;
}

/**
 * One user message eligible for retention: its session entry, the effective text a model could have seen,
 * and the SHA-256 of that text. The hash identifies the revision, not the occurrence.
 */
export interface UserMessageSource {
    entryId: string;
    timestamp: string;
    text: string;
    contentHash: string;
    lines: readonly TextLine[];
}

/** A message in a prepared summarization span, paired with the session entry it came from. */
export interface SpanRecord {
    sourceEntry: SessionEntry;
    message: ProjectedMessage;
}

/** Session state captured when a compaction attempt starts; the result is valid only while it still holds. */
export interface CompactionOwner {
    sessionId: string;
    sessionDir: string;
    leafId: string | null;
    model: { provider: string; id: string; contextWindow: number } | undefined;
    systemMessage: SystemMessage | undefined;
}

/** Frozen source history needed only by retention-enabled attempts. */
export interface RetentionSnapshot {
    sessionId: string;
    sessionDir: string;
    leafId: string;
    continuingModel: { key: string; contextWindow: number };
    branchEntries: readonly SessionEntry[];
    projection: SessionProjection;
}

/** Retention inputs for one attempt: every eligible source in branch order, the request spans, and carried decisions. */
export interface RetentionSources {
    candidates: readonly UserMessageSource[];
    history: readonly SpanRecord[];
    turnPrefix: readonly SpanRecord[];
    /** Decisions fixed before the writer runs: skill-rule excerpts, and saved decisions for the same entry and text revision. */
    carriedDecisions: ReadonlyMap<string, SavedRetentionDecision>;
    /** Entries a writer may shorten: at least the flag length, without a carried decision, and not a skill expansion. */
    offerable: ReadonlySet<string>;
}

export function hashText(text: string): string {
    return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Splits text into lines, treating CRLF, LF, and lone CR as one terminator each. Concatenating every line's `[start, end)` yields the text. */
export function splitTextLines(text: string): TextLine[] {
    const lines: TextLine[] = [];
    let start = 0;
    let index = 0;
    while (index < text.length) {
        const char = text[index];
        if (char === "\r" || char === "\n") {
            const end = char === "\r" && text[index + 1] === "\n" ? index + 2 : index + 1;
            lines.push({ start, contentEnd: index, end });
            start = end;
            index = end;
            continue;
        }
        index += 1;
    }
    if (start < text.length) {
        lines.push({ start, contentEnd: text.length, end: text.length });
    }
    return lines;
}

/** Returns a reason when ranges are not ascending, disjoint, and within `lineCount`; undefined when valid. */
export function describeInvalidRanges(ranges: readonly LineRange[], lineCount: number): string | undefined {
    if (ranges.length === 0) return "no ranges";
    let previousEnd = 0;
    for (const range of ranges) {
        if (range.startLine > range.endLine) return `range ${range.startLine}-${range.endLine} is reversed`;
        if (range.startLine <= previousEnd) return `range ${range.startLine}-${range.endLine} overlaps or precedes the previous range`;
        if (range.endLine > lineCount) return `range ${range.startLine}-${range.endLine} exceeds ${lineCount} lines`;
        previousEnd = range.endLine;
    }
    return undefined;
}

/** The exact original substring selected by one valid range, including the last line's terminator. */
export function sliceRange(source: UserMessageSource, range: LineRange): string {
    return source.text.slice(source.lines[range.startLine - 1].start, source.lines[range.endLine - 1].end);
}

function isUserMessageEntry(entry: SessionEntry): entry is SessionMessageEntry & { message: UserMessage } {
    return entry.type === "message" && entry.message.role === "user";
}

function createSource(entry: SessionMessageEntry, text: string): UserMessageSource {
    return { entryId: entry.id, timestamp: entry.timestamp, text, contentHash: hashText(text), lines: splitTextLines(text) };
}

/** Captures the session, branch, continuing model, and projection an attempt is bound to. */
export function captureRetentionSnapshot(
    event: SessionBeforeCompactEvent,
    owner: Omit<CompactionOwner, "systemMessage">,
): RetentionSnapshot {
    const { model, leafId } = owner;
    if (!model || !Number.isFinite(model.contextWindow) || model.contextWindow <= 0) {
        throw new RetentionError("session-state", "Retention needs a continuing model with a positive context window");
    }
    const lastEntry = event.branchEntries.at(-1);
    if (!leafId || lastEntry?.id !== leafId) {
        throw new RetentionError("session-state", "The compaction branch does not end at the session's current leaf");
    }
    let branchEntries: SessionEntry[];
    let projection: SessionProjection;
    try {
        branchEntries = structuredClone(event.branchEntries);
        projection = buildSessionProjection(branchEntries);
    } catch (cause) { throw new RetentionError("session-state", "Retention source snapshot could not be constructed", [], { cause }); }
    return {
        sessionId: owner.sessionId,
        sessionDir: owner.sessionDir,
        leafId,
        continuingModel: { key: `${model.provider}/${model.id}`, contextWindow: model.contextWindow },
        branchEntries,
        projection,
    };
}

/** Checks the session and effective prompt/tool state against the attempt's captured owner. */
export function assertCompactionOwner(
    owner: CompactionOwner,
    session: { getSessionId(): string; getSessionDir(): string; getLeafId(): string | null; getBranch(): SessionEntry[] },
    model: { provider: string; id: string; contextWindow: number } | undefined,
): void {
    if (session.getSessionId() !== owner.sessionId || session.getSessionDir() !== owner.sessionDir
        || session.getLeafId() !== owner.leafId || !model || !owner.model
        || model.provider !== owner.model.provider || model.id !== owner.model.id
        || model.contextWindow !== owner.model.contextWindow) {
        throw new RetentionError("session-state", "Session, branch or continuing model changed during compaction");
    }
    const current = getCurrentSystemMessage(buildSessionProjection(session.getBranch()).messages);
    if (!isDeepStrictEqual(current, owner.systemMessage)) {
        throw new RetentionError("session-state", "System prompt or tool state changed during compaction");
    }
}

/**
 * Resolves the prepared prior summary by its effective compaction entry, never by a Markdown delimiter. For an entry
 * without a grounded retention record, readable text from `queryReadableSummary` replaces the stored summary; an
 * `error` answer cancels compaction rather than summarizing from text the entry's owner says is unreadable.
 */
export function readPreparedSummaryBody(
    event: SessionBeforeCompactEvent,
    projection: SessionProjection,
    queryReadableSummary: (compactionEntryId: string) => PreviousSummaryResponse,
): string | undefined {
    const source = projection.entries.find(({ sourceEntry, messages }) => sourceEntry.type === "compaction" && messages.length > 0)?.sourceEntry;
    const previous = event.preparation.previousSummary;
    if (!source) {
        // compat-ok: first compaction has no previous summary; later preparations must identify its source entry.
        if (previous !== undefined) throw new RetentionError("previous-summary", "Prepared previous summary has no effective source compaction");
        return undefined;
    }
    if (source.type !== "compaction" || source.summary !== previous) {
        throw new RetentionError("previous-summary", "Prepared previous summary does not match its effective source compaction", [source.id]);
    }
    let record;
    try {
        record = readGroundedRetentionRecord(source);
    } catch (cause) {
        throw new RetentionError("invalid-record", "Invalid prior compaction retention record", [source.id], { cause });
    }
    if (record) return record.summaryBody;
    const readable = queryReadableSummary(source.id);
    // compat-ok: `error` is the entry owner's answer when it cannot supply readable text yet; compaction cancels.
    if (readable.status === "error") throw new RetentionError("previous-summary", readable.error, [source.id]);
    return stripGroundedCompactionManifestTail(readable.status === "available" ? readable.summary : source.summary);
}

/** Pairs prepared messages with their source entries by ordered structural equality with the projection. */
function mapPreparedSpans(
    event: SessionBeforeCompactEvent,
    projected: readonly ProjectedSessionEntry[],
    cutIndex: number,
) {
    // Mirrors the message selection of Pi's prepareCompaction: compaction entries and system messages are prompt state, not conversation
    const records = projected.slice(0, cutIndex).flatMap((entry) => entry.sourceEntry.type === "compaction"
        ? []
        : entry.messages.filter((message) => message.role !== "system").map((message) => ({ sourceEntry: entry.sourceEntry, message })));
    const { messagesToSummarize, turnPrefixMessages } = event.preparation;
    const prepared = [...messagesToSummarize, ...turnPrefixMessages];
    if (records.length !== prepared.length || records.some((record, index) => !isDeepStrictEqual(record.message, prepared[index]))) {
        throw new RetentionError(
            "source-mapping",
            `Prepared compaction spans (${prepared.length} messages) do not match the session projection (${records.length} messages)`,
        );
    }
    return { history: records.slice(0, messagesToSummarize.length), turnPrefix: records.slice(messagesToSummarize.length) };
}

function latestContextEdits(branch: readonly SessionEntry[]): Map<string, ContextEditEntry> {
    const edits = new Map<string, ContextEditEntry>();
    for (const entry of branch) {
        if (entry.type === "context_edit") edits.set(entry.targetId, entry);
    }
    return edits;
}

function readLatestRecordDecisions(branch: readonly SessionEntry[]): Record<string, SavedRetentionDecision> {
    for (let index = branch.length - 1; index >= 0; index -= 1) {
        const entry = branch[index];
        if (entry.type !== "compaction") continue;
        let record;
        try {
            record = readGroundedRetentionRecord(entry);
        } catch (error) {
            throw new RetentionError("invalid-record", error instanceof Error ? error.message : String(error), [entry.id], { cause: error });
        }
        if (record) return record.decisions;
    }
    return {};
}

function projectedUserText(entry: ProjectedSessionEntry | undefined): string {
    const message = entry?.messages[0];
    return message?.role === "user" ? contentText(message.content, "") : "";
}

function collectRetentionCandidates(
    entries: readonly SessionEntry[], projected: readonly ProjectedSessionEntry[], projectedCut: number,
    edits: ReadonlyMap<string, ContextEditEntry>,
): UserMessageSource[] {
    const projectedById = new Map(projected.slice(0, projectedCut).map((entry) => [entry.sourceEntry.id, entry]));
    const projectedIds = new Set(projected.map((entry) => entry.sourceEntry.id));
    const candidates: UserMessageSource[] = [];
    for (const entry of entries) {
        if (!isUserMessageEntry(entry)) continue;
        let text: string;
        if (projectedIds.has(entry.id)) {
            text = projectedUserText(projectedById.get(entry.id));
        } else {
            const edit = edits.get(entry.id);
            if (edit?.replacement === null) continue;
            text = contentText(edit ? edit.replacement.content : entry.message.content, "");
        }
        if (text) candidates.push(createSource(entry, text));
    }
    return candidates;
}

// The envelope Pi writes when expanding a skill command; skill-templates writes the same one.
const SKILL_OPENING_LINE = /^<skill name="[^"]*" location="([^"]*)">$/;
const SKILL_CLOSING_LINE = "</skill>";
const TEMPLATED_SKILL_FILE = ".template.md";

type SkillExpansion = { kind: "templated" } | { kind: "plain"; decision: SavedRetentionDecision };

/**
 * Reads a message that begins with a skill expansion. A skill-templates rendering depends on its invocation and
 * cannot be rebuilt from the template, so it stays whole. A plain skill keeps its opening line, which names the
 * skill file, and the text after the first closing line; a closing line quoted in the body only keeps more text.
 */
function readSkillExpansion(source: UserMessageSource): SkillExpansion | undefined {
    const lineText = (index: number) => source.text.slice(source.lines[index].start, source.lines[index].contentEnd);
    const opening = SKILL_OPENING_LINE.exec(lineText(0));
    const closing = source.lines.findIndex((_, index) => index > 0 && lineText(index) === SKILL_CLOSING_LINE);
    if (!opening || closing < 0) return undefined;
    if (opening[1].endsWith(TEMPLATED_SKILL_FILE)) return { kind: "templated" };
    const ranges = [{ startLine: 1, endLine: 1 }];
    if (closing + 1 < source.lines.length) ranges.push({ startLine: closing + 2, endLine: source.lines.length });
    return { kind: "plain", decision: { contentHash: source.contentHash, action: "excerpt", ranges } };
}

/**
 * Resolves retention sources for one attempt. Messages still in the active projection use their projected
 * text; user entries already summarized by earlier compactions use the latest context edit on the branch.
 * Omitted messages and empty text produce no source. Messages of at least `flagChars` that begin with a skill
 * expansion are decided by rule, replacing any saved decision. Throws `RetentionError` when the preparation
 * cannot be tied to session entries or saved decisions are malformed.
 */
export function prepareRetentionSources(
    event: SessionBeforeCompactEvent, snapshot: RetentionSnapshot, flagChars: number,
): RetentionSources {
    const branch = snapshot.branchEntries;
    const firstKeptEntryId = event.preparation.firstKeptEntryId;
    const branchCut = branch.findIndex((entry) => entry.id === firstKeptEntryId);
    const projected = snapshot.projection.entries;
    const projectedCut = projected.findIndex((entry) => entry.sourceEntry.id === firstKeptEntryId);
    if (branchCut < 0 || projectedCut < 0) {
        throw new RetentionError("source-mapping", `First kept entry ${firstKeptEntryId} is not on the projected branch`, [firstKeptEntryId]);
    }

    const spans = mapPreparedSpans(event, projected, projectedCut);
    const candidates = collectRetentionCandidates(branch.slice(0, branchCut), projected, projectedCut, latestContextEdits(branch));

    const candidatesById = new Map(candidates.map((source) => [source.entryId, source]));
    const carriedDecisions = new Map<string, SavedRetentionDecision>();
    for (const [entryId, decision] of Object.entries(readLatestRecordDecisions(branch))) {
        const source = candidatesById.get(entryId);
        if (!source || source.contentHash !== decision.contentHash) continue;
        const invalid = decision.action === "excerpt" ? describeInvalidRanges(decision.ranges, source.lines.length) : undefined;
        if (invalid) {
            throw new RetentionError("invalid-record", `Saved retention decision for entry ${entryId} is invalid: ${invalid}`, [entryId]);
        }
        carriedDecisions.set(entryId, decision);
    }

    const offerable = new Set<string>();
    for (const source of candidates) {
        if (source.text.length < flagChars) continue;
        const skill = readSkillExpansion(source);
        if (skill?.kind === "plain") carriedDecisions.set(source.entryId, skill.decision);
        else if (skill) carriedDecisions.delete(source.entryId);
        else if (!carriedDecisions.has(source.entryId)) offerable.add(source.entryId);
    }

    return { candidates, history: spans.history, turnPrefix: spans.turnPrefix, carriedDecisions, offerable };
}

/** Sources in one prepared span, keyed by entry ID. */
export function sourcesInSpan(sources: RetentionSources, span: readonly SpanRecord[]): Map<string, UserMessageSource> {
    const byId = new Map(sources.candidates.map((source) => [source.entryId, source]));
    const inSpan = new Map<string, UserMessageSource>();
    for (const record of span) {
        const source = isUserMessageEntry(record.sourceEntry) ? byId.get(record.sourceEntry.id) : undefined;
        if (source) inSpan.set(source.entryId, source);
    }
    return inSpan;
}

/** An exported span and the only sources its writer may shorten. */
export interface RetentionSpan {
    text: string;
    offered: ReadonlyMap<string, UserMessageSource>;
}

export function serializeRetentionSpan(
    span: readonly SpanRecord[], sources: RetentionSources, toolResultChars: number | null,
): RetentionSpan {
    const inSpan = sourcesInSpan(sources, span);
    const offered = new Map([...inSpan].filter(([id]) => sources.offerable.has(id)));
    const text = span.map(({ sourceEntry, message }) => {
        const source = inSpan.get(sourceEntry.id);
        if (!source) return serializeConversationForCompaction(convertToLlm([message]), toolResultChars);
        const editable = offered.has(source.entryId);
        const header = `[User entryId=${JSON.stringify(source.entryId)}${editable ? "; retention-editable" : ""}]`;
        const content = editable
            ? source.lines.map((line, index) => `${index + 1} | ${source.text.slice(line.start, line.contentEnd)}`).join("\n")
            : source.text;
        return `${header}\n${content}`;
    }).filter(Boolean).join("\n\n");
    return { text, offered };
}

const DecisionEnvelopeSchema = Type.Object({
    decisions: Type.Array(Type.Union([
        Type.Object({
            entryId: Type.String(), action: Type.Literal("excerpt"), ranges: Type.Array(LineRangeSchema, { minItems: 1 }),
        }, { additionalProperties: false }),
        Type.Object({
            entryId: Type.String(), action: Type.Literal("reference"), note: Type.String({ pattern: "\\S" }),
        }, { additionalProperties: false }),
    ])),
}, { additionalProperties: false });

/** A validated summary body and decisions bound to the request's offered sources. */
export interface RetentionResponse {
    summaryBody: string;
    decisions: ReadonlyMap<string, SavedRetentionDecision>;
}

/** Parses one response against that request's offered IDs; no source text is copied from the response. */
export function parseRetentionResponse(text: string, offered: ReadonlyMap<string, UserMessageSource>): RetentionResponse {
    const match = /^## Grounded retention decisions\r?\n\s*```json\r?\n([\s\S]*?)\r?\n```\r?\n([\s\S]*)$/.exec(text.trim());
    if (!match || !match[2].trim()) throw new RetentionError("invalid-decisions", "Missing retention envelope or summary body");
    let envelope: unknown;
    try { envelope = JSON.parse(match[1]); } catch (cause) {
        throw new RetentionError("invalid-decisions", "Retention decisions are not valid JSON", [], { cause });
    }
    if (!Check(DecisionEnvelopeSchema, envelope)) throw new RetentionError("invalid-decisions", "Invalid retention decision schema");
    const decisions = new Map<string, SavedRetentionDecision>();
    for (const decision of envelope.decisions) {
        const source = offered.get(decision.entryId);
        if (!source) throw new RetentionError("invalid-decisions", "A retention decision targets an entry not offered in this request");
        if (decisions.has(source.entryId)) throw new RetentionError("invalid-decisions", "Duplicate retention decision", [source.entryId]);
        if (decision.action === "excerpt") {
            const invalid = describeInvalidRanges(decision.ranges, source.lines.length);
            if (invalid) throw new RetentionError("invalid-decisions", invalid, [source.entryId]);
            decisions.set(source.entryId, { contentHash: source.contentHash, action: "excerpt", ranges: decision.ranges });
        } else {
            decisions.set(source.entryId, { contentHash: source.contentHash, action: "reference", note: decision.note });
        }
    }
    return { summaryBody: match[2].trim(), decisions };
}

/** A selected fragment; only shortened fragments need an exact-recovery file. */
export interface SelectedRetention {
    source: UserMessageSource;
    fragment: string;
    recoveryPath: string | null;
}

interface RetainedSupplement {
    summary: string;
    supplement: string;
    record: GroundedRetentionRecord;
    selected: readonly SelectedRetention[];
}

const SUPPLEMENT_PREFIX = "\n\n---\n\n## Verbatim user messages\n\nGrouped by UTC date and labeled with session entry ID and time. Later decisions in the summary and kept conversation determine current status.";

// Session timestamps are ISO 8601 in UTC: YYYY-MM-DDTHH:MM:SS.sssZ
const utcDate = (source: UserMessageSource) => source.timestamp.slice(0, 10);
const utcMinute = (source: UserMessageSource) => source.timestamp.slice(11, 16);
const dateLine = (source: UserMessageSource) => `\n\n${utcDate(source)}`;

/** Fences text under a label. The fence is longer than any backtick run in the text, so the text cannot close it. */
function fencedBlock(label: string, text: string): string {
    let fenceLength = 3;
    for (const match of text.matchAll(/`+/g)) fenceLength = Math.max(fenceLength, match[0].length + 1);
    const fence = "`".repeat(fenceLength);
    return `${fence}${label}\n${text}${text.endsWith("\n") ? "" : "\n"}${fence}`;
}

/** Renders one message without its date line: an unqualified label marks complete original text. */
function renderRetainedSource(
    source: UserMessageSource, decision: SavedRetentionDecision | undefined, snapshot: RetentionSnapshot,
): SelectedRetention {
    const label = `${source.entryId} ${utcMinute(source)}`;
    if (!decision) return { source, fragment: `\n\n${fencedBlock(label, source.text)}`, recoveryPath: null };
    if (!snapshot.sessionDir) throw new RetentionError("recovery-file", "Shortened retention requires a session directory", [source.entryId]);
    const recoveryPath = path.resolve(snapshot.sessionDir, `${snapshot.sessionId}.verbatim`, `${source.contentHash}.txt`);
    const blocks = decision.action === "reference"
        ? [fencedBlock(`${label} generated description`, decision.note)]
        : decision.ranges.map((range) => fencedBlock(`${label} lines ${range.startLine}-${range.endLine}`, sliceRange(source, range)));
    return { source, fragment: `\n\n${blocks.join("\n")}\nExact source revision: ${JSON.stringify(recoveryPath)}`, recoveryPath };
}

/** Joins fragments in conversation order, printing each UTC date once, before its first message. */
function joinByDate(selected: readonly SelectedRetention[]): string {
    return selected.map(({ source, fragment }, index) => {
        const sameDate = index > 0 && utcDate(selected[index - 1].source) === utcDate(source);
        return (sameDate ? "" : dateLine(source)) + fragment;
    }).join("");
}

/** Estimates a prospective ordinary compaction and returns space beyond the response reservation, or throws. */
export function remainingContinuationTokens(params: {
    branchEntries: readonly SessionEntry[]; projection: SessionProjection;
    firstKeptEntryId: string; tokensBefore: number; summary: string;
    contextWindow: number | undefined; reserveTokens: number;
}): number {
    if (params.contextWindow === undefined || !Number.isFinite(params.contextWindow) || params.contextWindow <= 0) {
        throw new RetentionError("continuation-capacity", "A continuing model with a positive context window is required");
    }
    const systemMessage = getCurrentSystemMessage(params.projection.messages);
    const draft: CompactionEntry = {
        type: "compaction", id: randomUUID(), parentId: params.branchEntries.at(-1)?.id ?? null,
        timestamp: new Date().toISOString(), firstKeptEntryId: params.firstKeptEntryId, tokensBefore: params.tokensBefore,
        summary: params.summary,
    };
    if (systemMessage) draft.systemMessage = systemMessage;
    const tokens = convertToLlm(buildSessionProjection([...params.branchEntries, draft]).messages)
        .reduce((sum, message) => sum + estimateMessageTokens(message), 0);
    const limit = params.contextWindow - params.reserveTokens;
    if (tokens > limit) throw new RetentionError("continuation-capacity", `Continuation estimate ${tokens} exceeds available capacity ${limit}`);
    return limit - tokens;
}

/** Selects complete fragments newest first, then verifies the supplement and projected continuation budgets. */
export function selectRetainedSupplement(params: {
    event: SessionBeforeCompactEvent;
    snapshot: RetentionSnapshot;
    sources: RetentionSources;
    decisions: ReadonlyMap<string, SavedRetentionDecision>;
    summaryBody: string;
    ledger: FilesTouchedLedger;
    budget: number;
}): RetainedSupplement {
    const { event, snapshot, sources, decisions, summaryBody, ledger, budget } = params;
    const capacity = {
        branchEntries: snapshot.branchEntries, projection: snapshot.projection,
        firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore,
        contextWindow: snapshot.continuingModel.contextWindow, reserveTokens: event.preparation.settings.reserveTokens,
    };
    const base = appendReaderLedger(summaryBody, ledger);
    const available = Math.min(budget, remainingContinuationTokens({ ...capacity, summary: base }));
    let used = estimateTextTokens(SUPPLEMENT_PREFIX);
    const selected: SelectedRetention[] = [];
    for (let index = sources.candidates.length - 1; index >= 0; index--) {
        const source = sources.candidates[index];
        const fragment = renderRetainedSource(source, decisions.get(source.entryId), snapshot);
        // Each message is charged its own date line, so sharing one can only make the joined text smaller.
        const tokens = estimateTextTokens(dateLine(source) + fragment.fragment);
        if (used + tokens > available) continue;
        selected.push(fragment);
        used += tokens;
    }
    selected.reverse();
    const supplement = selected.length ? SUPPLEMENT_PREFIX + joinByDate(selected) : "";
    const summary = appendReaderLedger(summaryBody + supplement, ledger);
    remainingContinuationTokens({ ...capacity, summary });
    if (estimateTextTokens(supplement) > budget) throw new RetentionError("continuation-capacity", "Rendered supplement exceeds its configured budget");
    return {
        summary, supplement, selected,
        record: { version: 1, summaryBody, decisions: Object.fromEntries(decisions), retainedEntryIds: selected.map(({ source }) => source.entryId) },
    };
}

function hasCode(cause: unknown, code: string): boolean {
    return cause instanceof Error && "code" in cause && cause.code === code;
}

async function verifyRecoveryFile(filePath: string, source: UserMessageSource): Promise<boolean> {
    let file;
    try {
        file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
        if (hasCode(error, "ENOENT")) return false;
        throw error;
    }
    try {
        if (!(await file.stat()).isFile()) throw new Error("Recovery destination is not a regular file");
        const bytes = await file.readFile();
        if (createHash("sha256").update(bytes).digest("hex") !== source.contentHash) {
            throw new Error("Recovery file differs from the effective source revision");
        }
        return true;
    } finally { await file.close(); }
}

async function publishRecoveryFile(source: UserMessageSource, recoveryPath: string, signal: AbortSignal): Promise<void> {
    if (await verifyRecoveryFile(recoveryPath, source)) return;
    await mkdir(path.dirname(recoveryPath), { recursive: true, mode: 0o700 });
    signal.throwIfAborted();
    const temporary = `${recoveryPath}.${randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try {
        try { await file.writeFile(source.text, { encoding: "utf8", signal }); }
        finally { await file.close(); }
        signal.throwIfAborted();
        try { await link(temporary, recoveryPath); }
        catch (cause) { if (!hasCode(cause, "EEXIST")) throw cause; }
        if (!await verifyRecoveryFile(recoveryPath, source)) throw new Error("Recovery publication is missing");
    } finally { await unlink(temporary); }
}

/** Publishes only selected shortened sources. Atomic link creation cannot replace an existing destination. */
export async function publishSelectedSidecars(selected: readonly SelectedRetention[], signal: AbortSignal): Promise<void> {
    for (const { source, recoveryPath } of selected) {
        signal.throwIfAborted();
        if (recoveryPath === null) continue;
        try { await publishRecoveryFile(source, recoveryPath, signal); }
        catch (cause) {
            signal.throwIfAborted();
            throw new RetentionError("recovery-file", "Exact recovery file could not be published or verified", [source.entryId], { cause });
        }
    }
    signal.throwIfAborted();
}
