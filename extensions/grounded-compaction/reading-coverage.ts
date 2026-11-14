import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText, type ToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Check } from "typebox/value";

import { parseCompletedFileActions } from "../_shared/files-touched-core.ts";
import { canonicalReadingPath } from "./required-reading.ts";

const ReadInputSchema = Type.Object({
    path: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 1 })), limit: Type.Optional(Type.Integer({ minimum: 1 })),
});
const BashInputSchema = Type.Object({ command: Type.String() });
const ExecInputSchema = Type.Object({ cmd: Type.String(), workdir: Type.Optional(Type.String()) });
const TraceMetadataSchema = Type.Object({ codeMode: Type.Literal(true), traces: Type.Array(Type.Unknown()) });
const TraceSchema = Type.Object({
    name: Type.String(), input: Type.Unknown(), status: Type.Literal("done"),
    result: Type.Object({ isError: Type.Optional(Type.Boolean()) }),
});
type LineRange = { start: number; end: number };
type ReadRequest = LineRange & { path: string };
type ToolResult = Extract<AgentMessage, { role: "toolResult" }>;

/** Unread, inclusive one-based line ranges in the current file, sorted in file order. */
export interface OutstandingReading {
    path: string;
    ranges: LineRange[];
}

/** Credits complete visible files or attributed read chunks whose emitted text matches the current file. */
export function outstandingReading(paths: readonly string[], messages: readonly AgentMessage[], systemPrompt: string, cwd: string): OutstandingReading[] {
    const visible = [systemPrompt];
    const calls = new Map<string, ToolCall>();
    const reads: { request: ReadRequest; texts: string[] }[] = [];
    for (const message of messages) {
        if (message.role === "user" || (message.role === "toolResult" && !message.isError)) {
            const texts = visibleTexts(message.content);
            visible.push(...texts);
            if (message.role === "toolResult") reads.push(...readRequests(message, calls, cwd).map((request) => ({ request, texts })));
        }
        if (message.role === "assistant") {
            for (const call of message.content.filter((block) => block.type === "toolCall")) calls.set(call.id, call);
        }
    }
    return paths.flatMap((file) => {
        if (!statSync(file, { throwIfNoEntry: false })?.isFile()) return [];
        const contents = readFileSync(file, "utf8");
        if (!contents || visible.some((text) => text.includes(contents))) return [];
        const lines = contents.match(/[^\n]*\n|[^\n]+$/g) ?? [];
        const canonicalFile = canonicalReadingPath(file);
        const covered = new Set<number>();
        for (const read of reads) {
            if (read.request.path === canonicalFile) creditRead(lines, read.request, read.texts, covered);
        }
        const ranges = missingRanges(lines.length, covered);
        return ranges.length > 0 ? [{ path: file, ranges }] : [];
    });
}

function visibleTexts(content: Parameters<typeof contentText>[0]): string[] {
    const text = contentText(content);
    const texts = [text, ...decodedOutputStrings(text)];
    if (Array.isArray(content)) {
        for (const block of content) {
            if (block.type === "text" && block.text !== text) texts.push(block.text, ...decodedOutputStrings(block.text));
        }
    }
    return texts;
}

function decodedOutputStrings(text: string): string[] {
    let value: unknown;
    try { value = JSON.parse(text); }
    catch (error) {
        if (error instanceof SyntaxError) return []; // Plain text is compared separately.
        throw error;
    }
    const strings: string[] = [];
    addJsonStrings(value, strings);
    return strings;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Parses decoded external JSON output into visible strings.
function addJsonStrings(value: unknown, strings: string[]): void {
    if (Check(Type.String(), value)) strings.push(value);
    else if (Array.isArray(value)) for (const item of value) addJsonStrings(item, strings);
    else if (Check(Type.Record(Type.String(), Type.Unknown()), value)) for (const item of Object.values(value)) addJsonStrings(item, strings);
}

function readRequests(message: ToolResult, calls: ReadonlyMap<string, ToolCall>, cwd: string): ReadRequest[] {
    const requests: ReadRequest[] = [];
    const call = calls.get(message.toolCallId);
    if (call) requests.push(...callReads(call.name, call.arguments, cwd));
    for (const nested of message.nestedCalls?.calls ?? []) {
        if (nested.status === "ok") requests.push(...callReads(nested.name, nested.arguments, cwd));
    }
    if (Check(TraceMetadataSchema, message.details)) {
        for (const trace of message.details.traces) {
            if (Check(TraceSchema, trace) && !trace.result.isError) requests.push(...callReads(trace.name, trace.input, cwd));
        }
    }
    return requests;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Parses direct and nested tool arguments at the external boundary.
function callReads(name: string, input: unknown, cwd: string): ReadRequest[] {
    if (name === "read" && Check(ReadInputSchema, input)) {
        const start = input.offset ?? 1;
        return [{ path: canonicalReadingPath(path.resolve(cwd, input.path)), start, end: input.limit === undefined ? Infinity : start + input.limit - 1 }];
    }
    let command: string;
    if (name === "bash" && Check(BashInputSchema, input)) command = input.command;
    else if (name === "exec_command" && Check(ExecInputSchema, input)) {
        command = input.cmd;
        cwd = path.resolve(cwd, input.workdir ?? ".");
    } else return [];
    const range = sedRead(command, cwd);
    if (range) return [range];
    return parseCompletedFileActions({
        toolName: "bash", toolArguments: { command }, cwd,
        toolResult: { content: undefined, details: undefined, isError: false },
    }).actions.flatMap((action) => action.kind === "touch" && action.operation === "read"
        ? [{ path: canonicalReadingPath(path.resolve(cwd, action.path)), start: 1, end: Infinity }] : []);
}

function sedRead(command: string, cwd: string): ReadRequest | undefined {
    // Accept only literal paths and a single print range; no shell evaluation or sed program interpretation.
    const match = /^sed\s+-n\s+(['"]?)([1-9]\d*)(?:,([1-9]\d*|\$))?p\1\s+('[^']*'|"[^"$`\\]*"|[^\s'"\\$`;&|<>()*?\[\]{}~#!]+)\s*$/.exec(command);
    if (!match) return undefined;
    const start = Number(match[2]);
    const endText = match.at(3);
    const end = endText === "$" ? Infinity : Number(endText ?? match[2]);
    if (!Number.isSafeInteger(start) || (end !== Infinity && !Number.isSafeInteger(end)) || end < start) return undefined;
    const operand = match[4];
    const file = operand.startsWith("'") || operand.startsWith('"') ? operand.slice(1, -1) : operand;
    return { path: canonicalReadingPath(path.resolve(cwd, file)), start, end };
}

function creditRead(lines: readonly string[], request: LineRange, texts: readonly string[], covered: Set<number>): void {
    const start = request.start - 1;
    let count = 0;
    let upper = Math.max(0, Math.min(request.end, lines.length) - start);
    // Binary search avoids comparing every growing prefix against a large tool result.
    while (count < upper) {
        const middle = Math.ceil((count + upper) / 2);
        const chunk = lines.slice(start, start + middle).join("");
        const present = texts.some((text) => chunk.endsWith("\n")
            ? text.startsWith(chunk) || text.includes(`\n${chunk}`)
            : text === chunk || text.startsWith(`${chunk}\n`) || text.endsWith(`\n${chunk}`) || text.includes(`\n${chunk}\n`));
        if (present) count = middle;
        else upper = middle - 1;
    }
    for (let i = start; i < start + count; i++) covered.add(i);
}

function missingRanges(lineCount: number, covered: ReadonlySet<number>): LineRange[] {
    const ranges: LineRange[] = [];
    for (let index = 0; index < lineCount; index++) {
        if (covered.has(index)) continue;
        const previous = ranges.at(-1);
        if (previous && previous.end === index) previous.end = index + 1;
        else ranges.push({ start: index + 1, end: index + 1 });
    }
    return ranges;
}
