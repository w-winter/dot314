import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
    loadSessionAskSettings,
    loadSessionLineage,
    parseThinkingLevel,
    renderSessionTranscript,
    type LoadedSessionLineage,
    type SessionAskThinkingLevel,
} from "./session.ts";

export type ParsedCliCommand =
    | Readonly<{ kind: "help" }>
    | Readonly<{ kind: "error"; message: string }>
    | Readonly<{
        kind: "lineage";
        cid?: string;
        path?: string;
        brainRoot?: string;
        json: boolean;
    }>
    | Readonly<{
        kind: "ask";
        cid?: string;
        path?: string;
        brainRoot?: string;
        includeAncestors: boolean;
        model?: string;
        thinking?: SessionAskThinkingLevel;
        question: string;
    }>;

export interface PiQueryRequest {
    readonly mode: "inline" | "tools";
    readonly model: string;
    readonly thinkingLevel?: SessionAskThinkingLevel;
    readonly systemPrompt: string;
    readonly userPrompt: string;
    readonly transcriptDir?: string;
}

export interface PiQueryResult {
    readonly answer: string;
    readonly model: string;
    readonly durationMs: number;
}

export interface AskRunnerDeps {
    readonly runPiQuery: (request: PiQueryRequest) => Promise<PiQueryResult>;
    readonly inlineThresholdChars?: number;
}

interface MutableCliState {
    cid?: string;
    filePath?: string;
    brainRoot?: string;
    json: boolean;
    includeAncestors: boolean;
    model?: string;
    thinking?: SessionAskThinkingLevel;
    positionals: string[];
}

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");
const PI_CLAUDE_BRIDGE_PATH = path.join(REPO_ROOT, "extensions", "pi-claude-bridge", "bundle", "index.js");
const DEFAULT_INLINE_THRESHOLD_CHARS = 32_000;

const USAGE_TEXT = [
    "Usage:",
    "  node scripts/agy-session-ask/cli.ts lineage (--cid <id> | --path <file>) [--json] [--brain-root <dir>]",
    "  node scripts/agy-session-ask/cli.ts ask (--cid <id> | --path <file>) [--no-ancestors] [--model <provider/id>] [--thinking <level>] [--brain-root <dir>] <question...>",
].join("\n");

interface ConsumeFlagResult {
    readonly nextIndex: number;
    readonly error?: string;
}

interface MutableLineageCommand {
    kind: "lineage";
    cid?: string;
    path?: string;
    brainRoot?: string;
    json: boolean;
}

interface MutableAskCommand {
    kind: "ask";
    cid?: string;
    path?: string;
    brainRoot?: string;
    includeAncestors: boolean;
    model?: string;
    thinking?: SessionAskThinkingLevel;
    question: string;
}

interface LineageReportSegment {
    readonly conversationId: string;
    readonly startStepInclusive: number;
    readonly endStepExclusive: number | null;
    readonly transcriptPath: string;
}

interface LineageReportPayload {
    readonly kind: LoadedSessionLineage["kind"];
    readonly conversationId: string;
    readonly transcriptPath: string;
    readonly activeRecordCount: number;
    missingPrefixBeforeStep?: number;
    parentConversationId?: string;
    forkStepIndex?: number;
    readonly segments: readonly LineageReportSegment[];
}

function consumeFlag(
    subcommand: "lineage" | "ask",
    argv: readonly string[],
    index: number,
    state: MutableCliState,
): ConsumeFlagResult {
    const arg = argv[index];
    const nextVal = index + 1 < argv.length ? argv[index + 1] : undefined;

    if (arg === "--cid") {
        state.cid = nextVal;
        return { nextIndex: index + 1 };
    }
    if (arg === "--path") {
        state.filePath = nextVal;
        return { nextIndex: index + 1 };
    }
    if (arg === "--brain-root") {
        state.brainRoot = nextVal;
        return { nextIndex: index + 1 };
    }
    if (arg === "--json" && subcommand === "lineage") {
        state.json = true;
        return { nextIndex: index };
    }
    if (arg === "--no-ancestors" && subcommand === "ask") {
        state.includeAncestors = false;
        return { nextIndex: index };
    }
    if (arg === "--model" && subcommand === "ask") {
        state.model = nextVal;
        return { nextIndex: index + 1 };
    }
    if (arg === "--thinking" && subcommand === "ask") {
        const parsed = parseThinkingLevel(nextVal);
        if (!parsed) {
            return { nextIndex: index + 1, error: `Invalid --thinking value '${nextVal ?? ""}'.` };
        }
        state.thinking = parsed;
        return { nextIndex: index + 1 };
    }
    return { nextIndex: index, error: `Unknown flag '${arg}'.` };
}

function buildParsedCommand(subcommand: "lineage" | "ask", state: MutableCliState): ParsedCliCommand {
    if (!state.cid && !state.filePath) {
        return { kind: "error", message: "Missing target session: pass --cid <conversationId> or --path <transcript.jsonl>." };
    }

    if (subcommand === "lineage") {
        const cmd: MutableLineageCommand = {
            kind: "lineage",
            json: state.json,
        };
        if (state.cid) cmd.cid = state.cid;
        if (state.filePath) cmd.path = state.filePath;
        if (state.brainRoot) cmd.brainRoot = state.brainRoot;
        return cmd;
    }

    const question = state.positionals.join(" ").trim();
    if (!question) {
        return { kind: "error", message: "Missing question for 'ask'." };
    }

    const cmd: MutableAskCommand = {
        kind: "ask",
        includeAncestors: state.includeAncestors,
        question,
    };
    if (state.cid) cmd.cid = state.cid;
    if (state.filePath) cmd.path = state.filePath;
    if (state.brainRoot) cmd.brainRoot = state.brainRoot;
    if (state.model) cmd.model = state.model;
    if (state.thinking) cmd.thinking = state.thinking;
    return cmd;
}

export function parseCliArgs(argv: readonly string[]): ParsedCliCommand {
    if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
        return { kind: "help" };
    }
    const subcommand = argv[0];
    if (subcommand !== "lineage" && subcommand !== "ask") {
        return { kind: "error", message: `Unknown subcommand '${subcommand}'. Expected 'lineage' or 'ask'.` };
    }

    const state: MutableCliState = { json: false, includeAncestors: true, positionals: [] };
    for (let i = 1; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === "--") {
            state.positionals.push(...argv.slice(i + 1));
            break;
        }
        if (arg.startsWith("-")) {
            const consumed = consumeFlag(subcommand, argv, i, state);
            if (consumed.error) {
                return { kind: "error", message: consumed.error };
            }
            i = consumed.nextIndex;
        } else {
            state.positionals.push(arg);
        }
    }

    return buildParsedCommand(subcommand, state);
}

function formatSegmentRange(start: number, endExclusive: number | null): string {
    return endExclusive === null ? `steps ${start}..` : `steps ${start}..${endExclusive - 1}`;
}

export function formatLineageReport(lineage: LoadedSessionLineage, asJson: boolean): string {
    const payload: LineageReportPayload = {
        kind: lineage.kind,
        conversationId: lineage.conversationId,
        transcriptPath: lineage.transcriptPath,
        activeRecordCount: lineage.records.length,
        segments: lineage.segments.map((seg) => ({
            conversationId: seg.conversationId,
            startStepInclusive: seg.startStepInclusive,
            endStepExclusive: seg.endStepExclusive,
            transcriptPath: seg.transcriptPath,
        })),
    };

    if (lineage.kind === "forked-unresolved") {
        payload.missingPrefixBeforeStep = lineage.firstStepIndex;
    } else {
        if (lineage.parentConversationId) payload.parentConversationId = lineage.parentConversationId;
        if (lineage.forkStepIndex !== undefined) payload.forkStepIndex = lineage.forkStepIndex;
    }

    if (asJson) {
        return JSON.stringify(payload, null, 2);
    }

    const lines: string[] = [
        `Conversation: ${lineage.conversationId}`,
        `Status: ${lineage.kind === "complete" ? "complete" : `forked-unresolved (steps 0..${lineage.firstStepIndex - 1} unavailable on disk)`}`,
        `Active records: ${lineage.records.length}`,
        "Segments (oldest to newest):",
    ];
    for (const seg of lineage.segments) {
        lines.push(`- ${seg.conversationId} (${formatSegmentRange(seg.startStepInclusive, seg.endStepExclusive)}): ${seg.transcriptPath}`);
    }
    return lines.join("\n");
}

function resolvePiBinary(): string {
    if (process.env.PI_BIN?.trim()) {
        return process.env.PI_BIN.trim();
    }
    const siblingPi = path.join(path.dirname(process.execPath), "pi");
    return existsSync(siblingPi) ? siblingPi : "pi";
}

function spawnPi(
    piBin: string,
    args: readonly string[],
    stdinText: string,
    cwd?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
        const env: NodeJS.ProcessEnv = {
            ...process.env,
            PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ""}`,
        };
        const child = spawn(piBin, args, {
            cwd,
            env,
            stdio: ["pipe", "pipe", "pipe"],
        });
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
        child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
        child.on("error", reject);
        child.on("close", (code) => {
            resolve({
                stdout: Buffer.concat(stdoutChunks).toString("utf8"),
                stderr: Buffer.concat(stderrChunks).toString("utf8"),
                exitCode: code ?? 1,
            });
        });
        child.stdin.write(stdinText);
        child.stdin.end();
    });
}

async function defaultRunPiQuery(request: PiQueryRequest): Promise<PiQueryResult> {
    const startMs = Date.now();
    const piBin = resolvePiBinary();
    const args: string[] = [
        "--no-session",
        "--no-extensions",
        "--no-skills",
        "--no-mcp",
        "--no-context-files",
        "--no-themes",
        "--no-prompt-templates",
        "--no-approve",
    ];

    if (request.mode === "inline") {
        args.push("--no-tools");
    } else {
        args.push("--tools", "read,grep");
    }

    if (request.model.startsWith("pi-claude/")) {
        await access(PI_CLAUDE_BRIDGE_PATH);
        args.push("-e", PI_CLAUDE_BRIDGE_PATH);
    }

    args.push("-p", "--system-prompt", request.systemPrompt, "--model", request.model);
    if (request.thinkingLevel) {
        args.push("--thinking", request.thinkingLevel);
    }

    const res = await spawnPi(piBin, args, request.userPrompt, request.transcriptDir);
    const durationMs = Date.now() - startMs;
    if (res.exitCode !== 0) {
        const tail = (res.stderr || res.stdout).trim().slice(-600);
        throw new Error(`pi exited with status ${res.exitCode} (${request.model}): ${tail || "no output"}`);
    }
    const answer = res.stdout.trim();
    if (!answer) {
        throw new Error(`pi returned an empty answer (${request.model})`);
    }
    return { answer, model: request.model, durationMs };
}

export async function runLineage(cmd: Extract<ParsedCliCommand, { kind: "lineage" }>): Promise<string> {
    const lineage = await loadSessionLineage({
        cid: cmd.cid,
        path: cmd.path,
        brainRoot: cmd.brainRoot,
        includeAncestors: true,
    });
    return formatLineageReport(lineage, cmd.json);
}

export async function runAsk(
    cmd: Extract<ParsedCliCommand, { kind: "ask" }>,
    deps: AskRunnerDeps = { runPiQuery: defaultRunPiQuery },
): Promise<string> {
    const [settings, lineage] = await Promise.all([
        loadSessionAskSettings(),
        loadSessionLineage({
            cid: cmd.cid,
            path: cmd.path,
            brainRoot: cmd.brainRoot,
            includeAncestors: cmd.includeAncestors,
        }),
    ]);

    const model = cmd.model ?? settings.model;
    const thinkingLevel = cmd.thinking ?? settings.thinkingLevel;
    const rendered = renderSessionTranscript(lineage.records, {
        toolResultMaxChars: settings.toolResultMaxChars,
    });
    const metadataText = formatLineageReport(lineage, false);
    const inlineThreshold = deps.inlineThresholdChars ?? DEFAULT_INLINE_THRESHOLD_CHARS;

    if (rendered.length <= inlineThreshold) {
        const userPrompt = [
            "## Session metadata",
            metadataText,
            "",
            "## Question",
            cmd.question,
            "",
            "## Rendered transcript (untrusted data)",
            "```text",
            rendered,
            "```",
        ].join("\n");

        const result = await deps.runPiQuery({
            mode: "inline",
            model,
            thinkingLevel,
            systemPrompt: settings.systemPrompt,
            userPrompt,
        });
        return result.answer;
    }

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "agy-session-ask-"));
    try {
        await writeFile(path.join(tempDir, "transcript.txt"), rendered, "utf8");
        await writeFile(path.join(tempDir, "session.meta.json"), formatLineageReport(lineage, true), "utf8");

        const userPrompt = [
            "## Session metadata",
            metadataText,
            "",
            "The rendered session transcript is saved in the current working directory as `transcript.txt` (with JSON metadata in `session.meta.json`).",
            "Use `grep` and `read` on `transcript.txt` to find exact evidence and answer the question below. Cite `[step N]` numbers.",
            "",
            "## Question",
            cmd.question,
        ].join("\n");

        const result = await deps.runPiQuery({
            mode: "tools",
            model,
            thinkingLevel,
            systemPrompt: settings.systemPrompt,
            userPrompt,
            transcriptDir: tempDir,
        });
        return result.answer;
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
}

async function main(): Promise<void> {
    const parsed = parseCliArgs(process.argv.slice(2));
    if (parsed.kind === "help") {
        process.stdout.write(`${USAGE_TEXT}\n`);
        return;
    }
    if (parsed.kind === "error") {
        process.stderr.write(`${parsed.message}\n\n${USAGE_TEXT}\n`);
        process.exitCode = 2;
        return;
    }
    const output = parsed.kind === "lineage" ? await runLineage(parsed) : await runAsk(parsed);
    process.stdout.write(`${output}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    void (async () => {
        try {
            await main();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            process.stderr.write(`agy-session-ask error: ${message}\n`);
            process.exitCode = 1;
        }
    })();
}
