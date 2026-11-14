import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText, type ToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Check } from "typebox/value";

import { canonicalReadingPath } from "./required-reading.ts";

const ReadInputSchema = Type.Object({ path: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 1 })) });

/** Whole current file contents must be visible, or native read chunks must cover every line without gaps. */
export function outstandingReading(paths: readonly string[], messages: readonly AgentMessage[], systemPrompt: string, cwd: string): string[] {
    const visible = [systemPrompt];
    const calls = new Map<string, ToolCall>();
    for (const message of messages) {
        if (message.role === "user" || (message.role === "toolResult" && !message.isError)) {
            const text = contentText(message.content);
            visible.push(text);
            // Code Mode can emit a tool result as JSON instead of plain text.
            visible.push(...decodedOutputStrings(text));
        }
        if (message.role === "assistant") {
            for (const block of message.content) if (block.type === "toolCall") calls.set(block.id, block);
        }
    }
    return paths.filter((file) => {
        if (!statSync(file, { throwIfNoEntry: false })?.isFile()) return false;
        const contents = readFileSync(file, "utf8");
        if (!contents || visible.some((text) => text.includes(contents))) return false;
        return !nativeReadCoverage(file, contents, messages, calls, cwd);
    });
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

function nativeReadCoverage(file: string, contents: string, messages: readonly AgentMessage[], calls: ReadonlyMap<string, ToolCall>, cwd: string): boolean {
    const lines = contents.split("\n");
    const covered = new Set<number>();
    for (const message of messages) {
        if (message.role !== "toolResult" || message.isError) continue;
        const call = calls.get(message.toolCallId);
        if (!call || call.name !== "read" || !Check(ReadInputSchema, call.arguments)) continue;
        if (canonicalReadingPath(path.resolve(cwd, call.arguments.path)) !== file) continue;
        const start = (call.arguments.offset ?? 1) - 1;
        const output = contentText(message.content).split("\n");
        // Compare actual returned lines. A requested limit or a successful read alone proves nothing.
        for (let i = 0; i < output.length && start + i < lines.length; i++) {
            if (output[i] !== lines[start + i]) break;
            covered.add(start + i);
        }
    }
    return covered.size === lines.length;
}
