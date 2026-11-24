export const GROUNDED_COMPACTION_MARKER = "[AGY-GROUNDED-COMPACTION";

/**
 * Empirically verified safe ceiling per injected systemMessage step.
 * Antigravity hard-truncates individual SYSTEM_MESSAGE steps at 49,152 bytes (48 KiB)
 * including its ~170-byte XML wrapper; 38,000 bytes leaves generous headroom.
 */
export const DEFAULT_MAX_CHUNK_BYTES = 38_000;

const CHARS_PER_TOKEN = 3.5;
const USER_REQUEST_RE = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/;
const USER_REQUEST_OPEN_RE = /^\s*<USER_REQUEST>\s*/;
const COMPACT_CMD_RE = /^\/compact(?:\s+([\s\S]*))?$/;
const ERROR_STATUSES = new Set(["ERROR", "INVALID"]);

const SUPPLEMENT_PREFIX =
    "## Verbatim user messages\n\nGrouped by UTC date and labeled with transcript step index and time. Later decisions in the summary and kept conversation determine current status.";

const SUPPLEMENT_DEDUPED_PREFIX =
    "## Verbatim user messages\n\nMessages already retained verbatim in Antigravity's # User Requests section above are omitted here to avoid duplication; older and truncated messages appear below in full, grouped by UTC date and labeled with transcript step index and time. Later decisions in the summary and kept conversation determine current status.";

const NATIVE_USER_REQUESTS_RE = /# User Requests\r?\n[^\r\n]*\r?\n([\s\S]*?)\r?\n\r?\n<summary>/;
const NATIVE_TRUNCATED_SUFFIX_RE = /\r?\n<truncated \d+ bytes>$/;

export interface ToolCallRecord {
    readonly name: string;
    readonly args: Record<string, unknown>;
}

export type TranscriptRecord =
    | Readonly<{
        kind: "USER_INPUT";
        stepIndex: number;
        createdAt: string;
        content: string;
    }>
    | Readonly<{
        kind: "PLANNER_RESPONSE";
        stepIndex: number;
        createdAt: string;
        content: string;
        toolCalls: readonly ToolCallRecord[];
    }>
    | Readonly<{
        kind: "GENERIC";
        stepIndex: number;
        createdAt: string;
        status: string;
        content: string;
        error?: string;
    }>
    | Readonly<{
        kind: "CHECKPOINT";
        stepIndex: number;
        createdAt: string;
        content: string;
    }>
    | Readonly<{
        kind: "SYSTEM_MESSAGE";
        stepIndex: number;
        createdAt: string;
        content: string;
    }>;

export type CompactDirective =
    | Readonly<{ isCompact: false }>
    | Readonly<{ isCompact: true; focusText?: string }>;

export interface SerializedSpanResult {
    readonly serializedConversation: string;
    readonly focusText?: string;
    readonly hasContent: boolean;
}

export interface NativeUserRequest {
    readonly text: string;
    readonly truncated: boolean;
}

export interface VerbatimSelectionResult {
    readonly section: string;
    readonly selectedCount: number;
    readonly estimatedTokens: number;
    readonly omittedNativeCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function estimateTextTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function extractUserRequestText(rawContent: string): string {
    const match = USER_REQUEST_RE.exec(rawContent);
    if (match) {
        return match[1].trim();
    }
    return rawContent.replace(USER_REQUEST_OPEN_RE, "").trim();
}

export function parseCompactCommand(userText: string): CompactDirective {
    const trimmed = userText.trim();
    const match = COMPACT_CMD_RE.exec(trimmed);
    if (!match) {
        return { isCompact: false };
    }
    const focus = match[1]?.trim();
    return focus ? { isCompact: true, focusText: focus } : { isCompact: true };
}

/**
 * Parses numbered items from Antigravity's native CHECKPOINT `# User Requests` section.
 * Distinguishes verbatim entries from entries truncated with `\n<truncated N bytes>`.
 */
export function parseNativeUserRequests(checkpointContent: string): NativeUserRequest[] {
    const sectionMatch = NATIVE_USER_REQUESTS_RE.exec(checkpointContent);
    if (!sectionMatch) {
        return [];
    }
    const body = sectionMatch[1];
    if (!body.startsWith("1. ")) {
        return [];
    }

    const items: NativeUserRequest[] = [];
    let index = 1;
    let pos = 3;

    while (pos <= body.length) {
        const nextMarker = `\n${index + 1}. `;
        const nextPos = body.indexOf(nextMarker, pos);
        const raw = (nextPos === -1 ? body.slice(pos) : body.slice(pos, nextPos)).trimEnd();
        const truncMatch = NATIVE_TRUNCATED_SUFFIX_RE.exec(raw);
        if (truncMatch) {
            items.push({ text: raw.slice(0, truncMatch.index), truncated: true });
        } else {
            items.push({ text: raw, truncated: false });
        }
        if (nextPos === -1) {
            break;
        }
        index += 1;
        pos = nextPos + nextMarker.length;
    }

    return items;
}

export function nativeRequestMatchesUserText(request: NativeUserRequest, userText: string): boolean {
    return request.truncated ? userText.startsWith(request.text) : userText === request.text;
}

/**
 * Strips the child's own post-fork USER_INPUT records from the tail of native `# User Requests`,
 * returning the remaining pre-fork items, or null if the tail does not align cleanly.
 */
export function extractPreForkNativeRequests(
    nativeRequests: readonly NativeUserRequest[],
    childRecords: readonly TranscriptRecord[],
    checkpointStep: number,
): NativeUserRequest[] | null {
    if (nativeRequests.length === 0) {
        return null;
    }
    const childUsers: string[] = [];
    for (const record of childRecords) {
        if (record.stepIndex >= checkpointStep || record.kind !== "USER_INPUT") {
            continue;
        }
        const text = extractUserRequestText(record.content);
        if (text) {
            childUsers.push(text);
        }
    }
    if (childUsers.length >= nativeRequests.length) {
        return null;
    }
    const splitIndex = nativeRequests.length - childUsers.length;
    for (let i = 0; i < childUsers.length; i += 1) {
        if (!nativeRequestMatchesUserText(nativeRequests[splitIndex + i], childUsers[i])) {
            return null;
        }
    }
    return nativeRequests.slice(0, splitIndex);
}

export interface ActiveCheckpointRef {
    readonly stepIndex: number;
    readonly createdAt: string;
    readonly key: string;
}

export function makeCheckpointKey(stepIndex: number, createdAt: string): string {
    return `${stepIndex}@${createdAt}`;
}

function pruneRewoundSteps(seenSteps: Set<number>, activeMap: Map<number, unknown>, rewindStep: number): void {
    for (const step of seenSteps) {
        if (step >= rewindStep) {
            seenSteps.delete(step);
            activeMap.delete(step);
        }
    }
}

/**
 * Reconstructs the active checkpoint sequence across append-only `/rewind` entries and returns
 * the latest active CHECKPOINT, or null if none remain on the active timeline.
 */
export function findLatestActiveCheckpoint(jsonlContent: string): ActiveCheckpointRef | null {
    if (!jsonlContent.includes('"CHECKPOINT"')) {
        return null;
    }

    const seenSteps = new Set<number>();
    const activeCheckpoints = new Map<number, ActiveCheckpointRef>();

    for (const rawLine of jsonlContent.split("\n")) {
        const line = rawLine.trim();
        if (!line) {
            continue;
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(line);
        } catch {
            continue;
        }
        if (!isRecord(parsed) || typeof parsed.step_index !== "number" || !Number.isInteger(parsed.step_index)) {
            continue;
        }
        const stepIndex = parsed.step_index;
        if (seenSteps.has(stepIndex)) {
            pruneRewoundSteps(seenSteps, activeCheckpoints, stepIndex);
        }
        seenSteps.add(stepIndex);

        if (parsed.type === "CHECKPOINT") {
            const createdAt = typeof parsed.created_at === "string" ? parsed.created_at : "";
            activeCheckpoints.set(stepIndex, {
                stepIndex,
                createdAt,
                key: makeCheckpointKey(stepIndex, createdAt),
            });
        }
    }

    let latest: ActiveCheckpointRef | null = null;
    for (const checkpoint of activeCheckpoints.values()) {
        if (latest === null || checkpoint.stepIndex > latest.stepIndex) {
            latest = checkpoint;
        }
    }
    return latest;
}

function parseToolCalls(raw: unknown): ToolCallRecord[] {
    if (!Array.isArray(raw)) {
        return [];
    }
    const calls: ToolCallRecord[] = [];
    for (const item of raw) {
        if (!isRecord(item) || typeof item.name !== "string" || !item.name) {
            continue;
        }
        let args: Record<string, unknown> = {};
        if (isRecord(item.args)) {
            args = item.args;
        } else if (typeof item.args === "string") {
            try {
                const decoded: unknown = JSON.parse(item.args);
                if (isRecord(decoded)) {
                    args = decoded;
                }
            } catch {
                args = { raw: item.args };
            }
        }
        calls.push({ name: item.name, args });
    }
    return calls;
}

/**
 * Parses an append-only Antigravity JSONL transcript into the active linear branch:
 * duplicate `step_index` values indicate `/rewind` and discard prior entries `>= step_index`,
 * while out-of-order first-time parallel tool completions are preserved and sorted by `stepIndex`.
 */
export function parseTranscriptRecords(jsonlContent: string): TranscriptRecord[] {
    const seenSteps = new Set<number>();
    const activeByStep = new Map<number, TranscriptRecord>();

    for (const rawLine of jsonlContent.split("\n")) {
        const line = rawLine.trim();
        if (!line) {
            continue;
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(line);
        } catch {
            continue;
        }
        if (
            !isRecord(parsed)
            || typeof parsed.step_index !== "number"
            || !Number.isInteger(parsed.step_index)
        ) {
            continue;
        }
        const stepIndex = parsed.step_index;
        if (seenSteps.has(stepIndex)) {
            pruneRewoundSteps(seenSteps, activeByStep, stepIndex);
        }
        seenSteps.add(stepIndex);

        if (typeof parsed.type !== "string") {
            continue;
        }
        const createdAt = typeof parsed.created_at === "string" ? parsed.created_at : "";
        const content = typeof parsed.content === "string" ? parsed.content : "";

        switch (parsed.type) {
            case "USER_INPUT":
                activeByStep.set(stepIndex, { kind: "USER_INPUT", stepIndex, createdAt, content });
                break;
            case "PLANNER_RESPONSE":
                activeByStep.set(stepIndex, {
                    kind: "PLANNER_RESPONSE",
                    stepIndex,
                    createdAt,
                    content,
                    toolCalls: parseToolCalls(parsed.tool_calls),
                });
                break;
            case "GENERIC":
                activeByStep.set(stepIndex, {
                    kind: "GENERIC",
                    stepIndex,
                    createdAt,
                    status: typeof parsed.status === "string" ? parsed.status : "DONE",
                    content,
                    ...(typeof parsed.error === "string" && parsed.error.trim() ? { error: parsed.error.trim() } : {}),
                });
                break;
            case "CHECKPOINT":
                activeByStep.set(stepIndex, { kind: "CHECKPOINT", stepIndex, createdAt, content });
                break;
            case "SYSTEM_MESSAGE":
                activeByStep.set(stepIndex, { kind: "SYSTEM_MESSAGE", stepIndex, createdAt, content });
                break;
            default:
                break;
        }
    }

    return [...activeByStep.values()].sort((a, b) => a.stepIndex - b.stepIndex);
}

function truncateToolResult(text: string, maxChars: number): string {
    if (text.length <= maxChars) {
        return text;
    }
    const omitted = text.length - maxChars;
    return `${text.slice(0, maxChars)}\n\n[... ${omitted} more characters truncated]`;
}

function formatToolCallsBlock(toolCalls: readonly ToolCallRecord[]): string {
    return toolCalls
        .map((call) => `${call.name}(${JSON.stringify(call.args)})`)
        .join("; ");
}

/**
 * Serializes transcript records strictly inside `(startStepExclusive, endStepExclusive)`.
 * Excludes native CHECKPOINT records and previously injected grounded-compaction chunks.
 */
export function serializeSpanForSummary(
    records: readonly TranscriptRecord[],
    startStepExclusive: number,
    endStepExclusive: number,
    toolResultChars: number | null,
): SerializedSpanResult {
    const parts: string[] = [];
    const pendingTools: string[] = [];
    let focusText: string | undefined;
    let hasContent = false;

    for (const record of records) {
        if (record.stepIndex <= startStepExclusive || record.stepIndex >= endStepExclusive) {
            continue;
        }

        switch (record.kind) {
            case "USER_INPUT": {
                const text = extractUserRequestText(record.content);
                if (!text) {
                    break;
                }
                const compact = parseCompactCommand(text);
                if (compact.isCompact) {
                    if (compact.focusText) {
                        focusText = compact.focusText;
                    }
                    break;
                }
                parts.push(`[User step=${record.stepIndex}]: ${text}`);
                hasContent = true;
                break;
            }
            case "PLANNER_RESPONSE": {
                const text = record.content.trim();
                if (text) {
                    parts.push(`[Assistant]: ${text}`);
                    hasContent = true;
                }
                if (record.toolCalls.length > 0) {
                    for (const call of record.toolCalls) {
                        pendingTools.push(call.name);
                    }
                    parts.push(`[Assistant tool calls]: ${formatToolCallsBlock(record.toolCalls)}`);
                    hasContent = true;
                }
                break;
            }
            case "GENERIC": {
                const toolName = pendingTools.shift() ?? "tool";
                const isError = Boolean(record.error) || ERROR_STATUSES.has(record.status);
                const resultSegments: string[] = [];
                if (record.error) {
                    resultSegments.push(record.error);
                }
                if (record.content.trim()) {
                    resultSegments.push(record.content.trim());
                }
                const combined = resultSegments.join("\n");
                if (!combined) {
                    if (isError) {
                        parts.push(`[Tool result ${toolName} (error)]: (empty error)`);
                    }
                    break;
                }
                const bounded = toolResultChars === null ? combined : truncateToolResult(combined, toolResultChars);
                const suffix = isError ? " (error)" : "";
                parts.push(`[Tool result ${toolName}${suffix}]: ${bounded}`);
                break;
            }
            case "SYSTEM_MESSAGE":
            case "CHECKPOINT":
                break;
        }
    }

    return {
        serializedConversation: parts.join("\n\n"),
        ...(focusText ? { focusText } : {}),
        hasContent,
    };
}

type FileOp = "read" | "write" | "edit";

function extractToolFilePath(call: ToolCallRecord): { op: FileOp; filePath: string } | null {
    const strArg = (key: string): string | null => {
        const val = call.args[key];
        return typeof val === "string" && val.trim() ? val.trim() : null;
    };

    switch (call.name) {
        case "read_file":
        case "view_file": {
            const p = strArg("Path") ?? strArg("AbsolutePath");
            return p ? { op: "read", filePath: p } : null;
        }
        case "write_file":
        case "write_to_file": {
            const p = strArg("Path") ?? strArg("TargetFile");
            return p ? { op: "write", filePath: p } : null;
        }
        case "edit_file":
        case "replace_file_content":
        case "multi_replace_file_content": {
            const p = strArg("Path") ?? strArg("TargetFile");
            return p ? { op: "edit", filePath: p } : null;
        }
        default:
            return null;
    }
}

export function collectAgyFilesTouchedBlock(
    records: readonly TranscriptRecord[],
    endStepExclusive: number,
): string {
    const opsByPath = new Map<string, Set<FileOp>>();

    for (const record of records) {
        if (record.stepIndex >= endStepExclusive || record.kind !== "PLANNER_RESPONSE") {
            continue;
        }
        for (const call of record.toolCalls) {
            const extracted = extractToolFilePath(call);
            if (!extracted) {
                continue;
            }
            let ops = opsByPath.get(extracted.filePath);
            if (!ops) {
                ops = new Set<FileOp>();
                opsByPath.set(extracted.filePath, ops);
            }
            ops.add(extracted.op);
        }
    }

    const lines = [
        "## Files touched",
        "R=read, W=write, E=edit, M=move/rename, D=delete",
        "",
        "```text",
    ];
    if (opsByPath.size === 0) {
        lines.push("(no tracked files)");
    } else {
        const sortedEntries = [...opsByPath.entries()].sort(([a], [b]) => a.localeCompare(b));
        for (const [filePath, ops] of sortedEntries) {
            const flags: string[] = [];
            if (ops.has("read")) flags.push("R");
            if (ops.has("write")) flags.push("W");
            if (ops.has("edit")) flags.push("E");
            lines.push(`${flags.join("").padEnd(2, " ")} ${filePath}`);
        }
    }
    lines.push("```");
    return lines.join("\n");
}

function fencedBlock(label: string, text: string): string {
    let fenceLength = 3;
    for (const match of text.matchAll(/`+/g)) {
        fenceLength = Math.max(fenceLength, match[0].length + 1);
    }
    const fence = "`".repeat(fenceLength);
    return `${fence}${label}\n${text}${text.endsWith("\n") ? "" : "\n"}${fence}`;
}

interface CandidateUserMessage {
    readonly stepIndex: number;
    readonly utcDate: string;
    readonly utcMinute: string;
    readonly fragment: string;
}

function formatUtcParts(createdAt: string): { utcDate: string; utcMinute: string } {
    if (createdAt.length >= 16 && createdAt[4] === "-" && createdAt[10] === "T") {
        return { utcDate: createdAt.slice(0, 10), utcMinute: createdAt.slice(11, 16) };
    }
    return { utcDate: "unknown-date", utcMinute: "00:00" };
}

function findNativeVerbatimStepIndices(
    allUsersBeforeCp: readonly { stepIndex: number; text: string }[],
    nativeUserRequests: readonly NativeUserRequest[],
): Set<number> {
    const retained = new Set<number>();
    if (nativeUserRequests.length === 0 || allUsersBeforeCp.length === 0) {
        return retained;
    }
    const compareLen = Math.min(allUsersBeforeCp.length, nativeUserRequests.length);
    const userTail = allUsersBeforeCp.slice(allUsersBeforeCp.length - compareLen);
    const nativeTail = nativeUserRequests.slice(nativeUserRequests.length - compareLen);

    for (let i = 0; i < compareLen; i += 1) {
        if (!nativeRequestMatchesUserText(nativeTail[i], userTail[i].text)) {
            return new Set();
        }
    }
    for (let i = 0; i < compareLen; i += 1) {
        if (!nativeTail[i].truncated) {
            retained.add(userTail[i].stepIndex);
        }
    }
    return retained;
}

/**
 * Selects verbatim user messages strictly before `endStepExclusive`, newest first,
 * omitting messages already preserved untruncated in Antigravity's native `# User Requests`,
 * skipping any single message that doesn't fit remaining budget, then renders chronologically.
 */
export function selectVerbatimUserMessages(
    records: readonly TranscriptRecord[],
    endStepExclusive: number,
    tokenBudget: number,
    nativeUserRequests: readonly NativeUserRequest[] = [],
): VerbatimSelectionResult {
    if (tokenBudget <= 0) {
        return { section: "", selectedCount: 0, estimatedTokens: 0, omittedNativeCount: 0 };
    }

    const allUsersBeforeCp: Array<{ stepIndex: number; createdAt: string; text: string }> = [];
    for (const record of records) {
        if (record.stepIndex >= endStepExclusive || record.kind !== "USER_INPUT") {
            continue;
        }
        const text = extractUserRequestText(record.content);
        if (text) {
            allUsersBeforeCp.push({ stepIndex: record.stepIndex, createdAt: record.createdAt, text });
        }
    }

    const nativeVerbatimSteps = findNativeVerbatimStepIndices(allUsersBeforeCp, nativeUserRequests);

    const candidates: CandidateUserMessage[] = [];
    let omittedNativeCount = 0;
    for (const user of allUsersBeforeCp) {
        if (parseCompactCommand(user.text).isCompact) {
            continue;
        }
        if (nativeVerbatimSteps.has(user.stepIndex)) {
            omittedNativeCount += 1;
            continue;
        }
        const { utcDate, utcMinute } = formatUtcParts(user.createdAt);
        const label = `step-${user.stepIndex} ${utcMinute}`;
        candidates.push({
            stepIndex: user.stepIndex,
            utcDate,
            utcMinute,
            fragment: `\n\n${fencedBlock(label, user.text)}`,
        });
    }

    const prefix = omittedNativeCount > 0 ? SUPPLEMENT_DEDUPED_PREFIX : SUPPLEMENT_PREFIX;
    let used = estimateTextTokens(prefix);
    const selected: CandidateUserMessage[] = [];

    for (let i = candidates.length - 1; i >= 0; i -= 1) {
        const candidate = candidates[i];
        const dateHeader = `\n\n${candidate.utcDate}`;
        const cost = estimateTextTokens(dateHeader + candidate.fragment);
        if (used + cost > tokenBudget) {
            continue;
        }
        selected.push(candidate);
        used += cost;
    }

    if (selected.length === 0) {
        return { section: "", selectedCount: 0, estimatedTokens: 0, omittedNativeCount };
    }

    selected.reverse();
    const joined = selected
        .map((item, index) => {
            const sameDate = index > 0 && selected[index - 1].utcDate === item.utcDate;
            return (sameDate ? "" : `\n\n${item.utcDate}`) + item.fragment;
        })
        .join("");

    const section = prefix + joined;
    return {
        section,
        selectedCount: selected.length,
        estimatedTokens: estimateTextTokens(section),
        omittedNativeCount,
    };
}

/** Finds the largest index `end` in `(start, text.length]` whose UTF-8 byte length is <= `maxBytes`, never splitting surrogate pairs. */
function sliceUtf8ToMaxBytes(text: string, start: number, maxBytes: number): number {
    let low = start + 1;
    let high = Math.min(text.length, start + maxBytes);
    let best = start;

    while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const byteLen = Buffer.byteLength(text.slice(start, mid), "utf8");
        if (byteLen <= maxBytes) {
            best = mid;
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }

    // Never split a UTF-16 surrogate pair; backing up one code unit keeps UTF-8 byte length <= maxBytes.
    if (best > start && best < text.length) {
        const prevCode = text.charCodeAt(best - 1);
        if (prevCode >= 0xd800 && prevCode <= 0xdbff) {
            best -= 1;
        }
    }

    if (best <= start) {
        const cp = text.codePointAt(start);
        return start + (cp !== undefined && cp > 0xffff ? 2 : 1);
    }

    // Prefer splitting cleanly after a blank line or newline within the latter half of the slice.
    if (best < text.length) {
        const minPreferred = start + Math.floor((best - start) * 0.5);
        const paragraphBreak = text.lastIndexOf("\n\n", best - 2);
        if (paragraphBreak >= minPreferred) {
            return paragraphBreak + 2;
        }
        const lineBreak = text.lastIndexOf("\n", best - 1);
        if (lineBreak >= minPreferred) {
            return lineBreak + 1;
        }
    }

    return best;
}

/**
 * Splits `headerBlock + "\n\n" + bodyText` into labeled chunks that each fit strictly within
 * `maxChunkBytes` UTF-8 bytes so Antigravity's per-step SYSTEM_MESSAGE cap never truncates them.
 */
export function chunkInjectedPayload(params: {
    checkpointStep: number;
    headerBlock: string;
    bodyText: string;
    maxChunkBytes?: number;
}): string[] {
    const maxChunkBytes = params.maxChunkBytes ?? DEFAULT_MAX_CHUNK_BYTES;
    const tagPrefix = `${GROUNDED_COMPACTION_MARKER} checkpoint=${params.checkpointStep} part=`;
    // Reserve space for up to 4-digit part counts ("9999/9999]\n").
    const reservedTagBytes = Buffer.byteLength(`${tagPrefix}9999/9999]\n`, "utf8");
    const firstHeaderPrefix = `${params.headerBlock}\n\n`;
    const firstHeaderBytes = Buffer.byteLength(firstHeaderPrefix, "utf8");

    if (reservedTagBytes + firstHeaderBytes + 64 > maxChunkBytes) {
        throw new Error(`maxChunkBytes (${maxChunkBytes}) is too small for the chunk header`);
    }

    const slices: string[] = [];
    let offset = 0;

    while (offset < params.bodyText.length || slices.length === 0) {
        const isFirst = slices.length === 0;
        const availableBytes = maxChunkBytes - reservedTagBytes - (isFirst ? firstHeaderBytes : 0);
        if (offset >= params.bodyText.length) {
            slices.push("");
            break;
        }
        const nextOffset = sliceUtf8ToMaxBytes(params.bodyText, offset, availableBytes);
        slices.push(params.bodyText.slice(offset, nextOffset));
        offset = nextOffset;
    }

    const total = slices.length;
    return slices.map((slice, index) => {
        const tag = `${tagPrefix}${index + 1}/${total}]\n`;
        return index === 0 ? `${tag}${firstHeaderPrefix}${slice}` : `${tag}${slice}`;
    });
}
