import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import type {
    ExtensionAPI,
    ExtensionCommandContext,
    ExtensionContext,
    SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

import { collectFilesTouched, registerFilesTouchedTracking, type FilesTouchedEntry } from "../_shared/files-touched-core.ts";
import { readGroundedSummaryBody } from "../_shared/grounded-compaction-record.ts";

const STATUS_KEY = "handover";
const DEFAULT_AUTO_SUBMIT_SECONDS = 10;
const HANDOVER_TITLE = "Handover message";
const PENDING_HANDOVER_DIR = path.join(os.tmpdir(), "pi-handover-pending");

const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(EXTENSION_DIR, "config.json");

// Optional override (user-editable) to avoid touching the .ts file
const PROMPT_OVERRIDE_PATH = path.join(EXTENSION_DIR, "prompt.md");

const DEFAULT_STYLE_GUIDE = `
# What to include

Use these section headings exactly. Omit a section only if it is truly empty. Prefer bullets under each heading.

## Brief
The user's desired outcome, how the current task serves it, current state, and immediate next action. Preserve the user's stated acceptance conditions and note if the objective changed from the original request.

## Constraints & preferences
Requirements, preferences, or constraints stated by the user that must be respected.

## Key decisions & rejected paths
Decisions made with brief rationale, including approaches tried and ruled out. Equally important: what was abandoned, what failed, and why those paths were closed.

## Unexpected findings
What contradicted expectations about the codebase, task, or dependencies. Gotchas and edge cases discovered. What is believed but with low confidence. Distinguish observed facts from inferences.

## Status
What is verified-done, what is implemented but unverified, what is in progress, what is blocked. Record the exact commands or checks used to verify the work and their last observed results. Note relevant changes made after those checks. Check the last several user messages for unresolved requests before marking anything done.

## Continuation logistics
- Mandatory reading: exact file paths the next agent should open first.
- Environment context, where applicable: ports, env vars, services, active deployments.
- Pending human decisions or approvals.

Rehydration targets (optional)
If applicable: topics where the needed level of detail depends on unresolved questions. Note what would trigger the need to rehydrate from the parent session.

## Next steps
Concrete next actions in execution order. Note dependencies between steps. If the next action depends on uncertain or potentially outdated information, state what needs to be checked.

# Style
- The new session starts with near-zero context; make the summary self-contained and high-density
- Preserve exact file paths, symbol names, commands, and error text where useful
- Output only markdown for the summary
`;

const FilesTouchedModeSchema = Type.Union([Type.Literal("off"), Type.Literal("writer"), Type.Literal("writerAndReader")]);

/** Who sees the files-touched list: nobody, the drafting model only, or the drafting model and the child session */
type FilesTouchedMode = Static<typeof FilesTouchedModeSchema>;

// Fields are checked separately: an invalid includeFilesTouched fails, while an invalid autoSubmitSeconds keeps its default
const ConfigFileSchema = Type.Object({
    autoSubmitSeconds: Type.Optional(Type.Unknown()),
    includeFilesTouched: Type.Optional(Type.Unknown()),
});
const AutoSubmitSecondsSchema = Type.Number();

type ExtensionConfig = {
    autoSubmitSeconds: number;
    includeFilesTouched: FilesTouchedMode;
};

/** The files-touched list for one handover; only "writerAndReader" also appends it to the child draft */
type FilesTouchedLedger =
    | { mode: "off" }
    | { mode: "writer" | "writerAndReader"; block: string };

type HandoverDependencies = {
    configPath: string;
    collectFilesTouched: typeof collectFilesTouched;
};

const DEFAULT_CONFIG: ExtensionConfig = {
    autoSubmitSeconds: DEFAULT_AUTO_SUBMIT_SECONDS,
    includeFilesTouched: "writer",
};

const NO_FILE_INVENTORY_CONSTRAINT = "- do not add a files-touched section, files modified section, files changed section, or any other exhaustive file inventory";
const MOVED_FILE_GUIDANCE = "for moves established by the conversation, refer to the file by its final path, and mention an old path only to explain the move, relevant history, or an unresolved discrepancy";

const FILES_TOUCHED_CONSTRAINTS = {
    off: [NO_FILE_INVENTORY_CONSTRAINT],
    writer: [
        "- use the files-touched list below as factual input; it may canonicalize moved paths and does not establish current filesystem state or event order",
        "- the list is input for you only and will not be included in the final handover; do not reproduce it, restate it exhaustively, or refer the next agent to it",
        "- name in the relevant sections the files the next agent needs, especially files written, edited, moved, or deleted that continuing the work depends on, and list in \"Mandatory reading\" only the ones to open first",
        `- ${MOVED_FILE_GUIDANCE}; do not infer a source-to-destination mapping from the list alone`,
        NO_FILE_INVENTORY_CONSTRAINT,
    ],
    writerAndReader: [
        "- use the files-touched list below as factual input; it will be appended verbatim to the final handover draft",
        "- mention in \"Mandatory reading\" only the subset that matters for continuation; do not restate the full list",
        `${NO_FILE_INVENTORY_CONSTRAINT}; the system will append the authoritative list verbatim`,
        "- do not duplicate the full list in prose",
        `- the list shows a moved or renamed file only at its final path; ${MOVED_FILE_GUIDANCE}`,
    ],
} satisfies Record<FilesTouchedMode, readonly string[]>;

// Matches the files-touched tail that grounded-compaction appends to saved compaction summaries
const COMPACTION_LEDGER_TAIL_PATTERN = /(?:(?:^|\n{2,})(?:---\n\n)?## Files touched(?: \(cumulative\))?\nR=read, W=write, E=edit, M=move\/rename, D=delete\n\n```text\n(?:(?!\n```)[\s\S])*\n```)+\s*$/;

type PendingAutoSubmit = {
    ctx: ExtensionContext;
    sessionFile: string;
    interval: ReturnType<typeof setInterval>;
    unsubscribeInput: () => void;
};

type PendingHandoverDraft = {
    previousSessionFile: string;
    draft: string;
    autoSubmitSeconds: number;
};

function extractTextFromContent(content: unknown): string {
    if (typeof content === "string") {
        return content.trim();
    }

    if (!Array.isArray(content)) {
        return "";
    }

    // Content parts can vary by provider/runtime. Prefer any part that exposes a
    // string `text` field (common for both `type: "text"` and `type: "output_text"`).
    return content
        .map((part) => {
            if (!part || typeof part !== "object") {
                return "";
            }

            return typeof (part as any).text === "string" ? (part as any).text : "";
        })
        .filter(Boolean)
        .join("\n")
        .trim();
}

function isEditableInput(data: string): boolean {
    if (!data) {
        return false;
    }

    if (data.length === 1) {
        const charCode = data.charCodeAt(0);
        if (charCode >= 32 && charCode !== 127) {
            return true;
        }

        if (charCode === 8 || charCode === 13) {
            return true;
        }
    }

    if (data === "\n" || data === "\r" || data === "\x7f") {
        return true;
    }

    if (data.length > 1 && !data.startsWith("\x1b")) {
        return true;
    }

    return false;
}

function getStatusLine(ctx: ExtensionContext, seconds: number): string {
    const accent = ctx.ui.theme.fg("accent", `handover auto-submit in ${seconds}s`);
    const hint = ctx.ui.theme.fg("dim", "(type or Esc to cancel)");
    return `${accent} ${hint}`;
}

/** Parses config.json text; throws on invalid JSON, a non-object top level, or an invalid includeFilesTouched */
function parseConfig(text: string): ExtensionConfig {
    const value: unknown = JSON.parse(text);
    if (!Check(ConfigFileSchema, value)) {
        throw new Error("Invalid handover config: top-level value must be an object");
    }

    const { autoSubmitSeconds, includeFilesTouched = DEFAULT_CONFIG.includeFilesTouched } = value;
    if (!Check(FilesTouchedModeSchema, includeFilesTouched)) {
        throw new Error('Invalid handover config: includeFilesTouched must be "off", "writer", or "writerAndReader"');
    }

    return {
        autoSubmitSeconds: Check(AutoSubmitSecondsSchema, autoSubmitSeconds)
            ? Math.max(0, Math.min(300, Math.floor(autoSubmitSeconds)))
            : DEFAULT_AUTO_SUBMIT_SECONDS,
        includeFilesTouched,
    };
}

/** A missing file yields defaults; any other read, JSON, or validation failure throws with the config path */
async function loadConfig(configPath: string): Promise<ExtensionConfig> {
    try {
        return parseConfig(await readFile(configPath, "utf8"));
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return { ...DEFAULT_CONFIG };
        }
        throw new Error(`Failed to load handover config from ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
}

function getPendingHandoverPath(previousSessionFile: string): string {
    const hash = createHash("sha256").update(previousSessionFile).digest("hex");
    return path.join(PENDING_HANDOVER_DIR, `${hash}.json`);
}

async function writePendingHandoverDraft(payload: PendingHandoverDraft): Promise<void> {
    await mkdir(PENDING_HANDOVER_DIR, { recursive: true });
    await writeFile(getPendingHandoverPath(payload.previousSessionFile), JSON.stringify(payload), "utf8");
}

async function consumePendingHandoverDraft(previousSessionFile: string): Promise<PendingHandoverDraft | null> {
    const pendingPath = getPendingHandoverPath(previousSessionFile);

    try {
        const raw = await readFile(pendingPath, "utf8");
        await unlink(pendingPath).catch(() => {
            // ignore
        });

        const parsed = JSON.parse(raw) as Partial<PendingHandoverDraft>;
        if (
            parsed.previousSessionFile !== previousSessionFile
            || typeof parsed.draft !== "string"
            || typeof parsed.autoSubmitSeconds !== "number"
        ) {
            return null;
        }

        return {
            previousSessionFile,
            draft: parsed.draft,
            autoSubmitSeconds: parsed.autoSubmitSeconds,
        };
    } catch {
        return null;
    }
}

async function clearPendingHandoverDraft(previousSessionFile: string): Promise<void> {
    try {
        await unlink(getPendingHandoverPath(previousSessionFile));
    } catch {
        // ignore
    }
}

function buildPriorCompactionAddendum(ctx: ExtensionCommandContext): string {
    const compactions = ctx.sessionManager.getBranch().filter((entry) => entry.type === "compaction");
    // The drafting model already has the latest compaction summary in its context. Each summary carries the
    // previous one forward, so the one before it, in full, stands in for all older summaries.
    const previous = compactions.at(-2);
    if (!previous) {
        return "";
    }

    // The fresh files-touched list supersedes ledgers saved with older summaries
    const summary = readGroundedSummaryBody(previous).trimEnd().replace(COMPACTION_LEDGER_TAIL_PATTERN, "").trim();
    if (!summary) {
        return "";
    }

    return [
        "## Previous compaction summary",
        `This is the compaction summary before the latest one on this branch, from ${previous.tokensBefore.toLocaleString()} tokens. The latest summary is already in your context. Use this one only for still-relevant details that the latest summary and the later conversation do not cover; where they disagree, the later sources win.`,
        "",
        summary,
    ].join("\n");
}

async function loadStyleGuide(): Promise<string> {
    try {
        const raw = await readFile(PROMPT_OVERRIDE_PATH, "utf8");
        const trimmed = raw.trim();
        return trimmed.length > 0 ? trimmed : DEFAULT_STYLE_GUIDE.trim();
    } catch {
        return DEFAULT_STYLE_GUIDE.trim();
    }
}

type DraftGenerationResult =
    | { ok: true; draft: string; ledger: FilesTouchedLedger }
    | { ok: false; error: string };

function formatManifestOperations(file: FilesTouchedEntry): string {
    const operations: string[] = [];
    if (file.operations.has("read")) operations.push("R");
    if (file.operations.has("write")) operations.push("W");
    if (file.operations.has("edit")) operations.push("E");
    if (file.operations.has("move")) operations.push("M");
    if (file.operations.has("delete")) operations.push("D");
    return operations.join("").padEnd(2, " ");
}

function renderFilesTouchedManifestBlock(files: FilesTouchedEntry[]): string {
    const lines = [
        "## Files touched",
        "R=read, W=write, E=edit, M=move/rename, D=delete",
        "",
        "```text",
    ];

    if (files.length === 0) {
        lines.push("(no tracked files)");
    } else {
        for (const file of files) {
            lines.push(`${formatManifestOperations(file)} ${file.displayPath}`);
        }
    }

    lines.push("```");
    return lines.join("\n");
}

function stripModelAuthoredFilesTouchedTail(draft: string): string {
    let cleaned = draft.trimEnd();

    // The fenced list must be the draft's last block, so its body may not contain another fence line
    const trailingPatterns = [
        /\n{2,}---\n{1,}Files touched in this session[^\n]*:\n{1,}```text(?:(?!\n```)[\s\S])*\n```\s*$/i,
        /\n{2,}#{1,6}\s+Files touched[^\n]*\n(?:(?!```|#)[^\n]*\n)*```text(?:(?!\n```)[\s\S])*\n```\s*$/i,
        /\n{2,}Files touched in this session[^\n]*:\n{1,}```text(?:(?!\n```)[\s\S])*\n```\s*$/i,
    ];

    let changed = true;
    while (changed) {
        changed = false;
        for (const pattern of trailingPatterns) {
            const next = cleaned.replace(pattern, "").trimEnd();
            if (next !== cleaned) {
                cleaned = next;
                changed = true;
            }
        }
    }

    return cleaned;
}

function prependHandoverTitle(draft: string): string {
    const trimmedDraft = draft.trim();
    const titleLine = `# ${HANDOVER_TITLE}`;
    if (!trimmedDraft) {
        return titleLine;
    }

    return trimmedDraft.startsWith(titleLine) ? trimmedDraft : `${titleLine}\n\n${trimmedDraft}`;
}

function finalizeDraft(draft: string, ledger: FilesTouchedLedger): string {
    const cleanedDraft = stripModelAuthoredFilesTouchedTail(draft);
    const titledDraft = prependHandoverTitle(cleanedDraft);
    return ledger.mode === "writerAndReader" ? `${titledDraft.trimEnd()}\n\n${ledger.block}` : titledDraft;
}

function createNonce(): string {
    return `handover-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function buildHandoverInstructionPrompt(params: {
    purpose: string;
    styleGuide: string;
    priorCompactionsAddendum: string;
    ledger: FilesTouchedLedger;
    nonce: string;
}): string {
    const { purpose, styleGuide, priorCompactionsAddendum, ledger, nonce } = params;

    const parts: string[] = [];

    // Marker for reliably correlating the assistant response to this exact prompt.
    // We match it in the *user* entry; the assistant is instructed not to echo it.
    parts.push(`<!-- handover-nonce: ${nonce} -->`);
    parts.push("");

    parts.push("You are generating a single rich handover / rehydration message for continuing this work in a new session.");
    parts.push("");
    parts.push("# Constraints:");
    parts.push("- do not call tools");
    parts.push("- do not write any files");
    parts.push("- do not include the handover-nonce marker in your output");
    parts.push("- output only the final handover message in markdown");
    parts.push("- do not add a document title; the final handover will be titled by the system");
    parts.push("- make it high-signal and self-contained; the agent reading it in the new session will have near-zero context");
    parts.push("- the new session will not see the latest compaction summary or any branch summaries in your context; treat them as sources, not text to reproduce: check them for anything the sections below ask for that the next agent still needs (constraints and preferences in force, decisions and rejected paths that prevent redone work, unresolved findings and open requests, exact paths and commands it must act on), include that, and leave out history, completed steps, and detail that would not change what the next agent does");
    parts.push(...FILES_TOUCHED_CONSTRAINTS[ledger.mode]);
    parts.push("");
    parts.push(`# Purpose\n${purpose.trim()}`);
    parts.push("");

    if (priorCompactionsAddendum.trim()) {
        parts.push(priorCompactionsAddendum.trim());
        parts.push("");
    }

    if (ledger.mode !== "off") {
        parts.push(ledger.block.trim());
        parts.push("");
    }
    parts.push(styleGuide.trim());

    return parts.join("\n").trim();
}

function findNewUserEntryIndexByNonce(params: {
    afterEntries: SessionEntry[];
    beforeEntryIds: Set<string>;
    nonce: string;
}): number {
    const { afterEntries, beforeEntryIds, nonce } = params;

    for (let i = 0; i < afterEntries.length; i += 1) {
        const entry = afterEntries[i];
        if (beforeEntryIds.has(entry.id)) {
            continue;
        }

        if (entry.type !== "message") {
            continue;
        }

        if (entry.message?.role !== "user") {
            continue;
        }

        const text = extractTextFromContent(entry.message?.content);
        if (!text) {
            continue;
        }

        if (text.includes(nonce)) {
            return i;
        }
    }

    return -1;
}

function extractAssistantDraftForNonce(params: {
    afterEntries: SessionEntry[];
    beforeEntryIds: Set<string>;
    nonce: string;
}): string | null {
    const { afterEntries, beforeEntryIds, nonce } = params;

    const userIndex = findNewUserEntryIndexByNonce({ afterEntries, beforeEntryIds, nonce });
    if (userIndex < 0) {
        return null;
    }

    for (let i = userIndex + 1; i < afterEntries.length; i += 1) {
        const entry = afterEntries[i];
        if (beforeEntryIds.has(entry.id)) {
            continue;
        }

        if (entry.type !== "message") {
            continue;
        }

        if (entry.message?.role !== "assistant") {
            continue;
        }

        const text = extractTextFromContent(entry.message?.content);
        if (!text) {
            continue;
        }

        // If the model accidentally echoed the nonce comment, strip it.
        const cleaned = text.replace(/<!--\s*handover-nonce:[\s\S]*?-->/g, "").trim();
        return (cleaned || text).trim();
    }

    return null;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

async function waitForQuiescentSession(ctx: ExtensionCommandContext, timeoutMs = 60_000): Promise<boolean> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
        if (ctx.isIdle() && !ctx.hasPendingMessages()) {
            return true;
        }

        // waitForIdle only waits for streaming; pending queue items may still exist.
        await ctx.waitForIdle();
        await sleep(80);
    }

    return ctx.isIdle() && !ctx.hasPendingMessages();
}

async function waitForAssistantDraft(params: {
    ctx: ExtensionCommandContext;
    beforeEntryIds: Set<string>;
    nonce: string;
    timeoutMs?: number;
}): Promise<string | null> {
    const { ctx, beforeEntryIds, nonce, timeoutMs = 5 * 60 * 1000 } = params;

    const startedAt = Date.now();

    for (;;) {
        const afterEntries = ctx.sessionManager.getEntries();
        const draft = extractAssistantDraftForNonce({ afterEntries, beforeEntryIds, nonce });
        if (draft) {
            return draft;
        }

        // waitForIdle() can outlast the deadline; inspect its completed response first.
        if (Date.now() - startedAt >= timeoutMs) {
            return null;
        }

        // Wait for the agent loop to run. ctx.waitForIdle() only waits for streaming
        // to finish; it can return immediately if the queued user message hasn't
        // started processing yet. So we combine it with small sleeps.
        if (!ctx.isIdle() || ctx.hasPendingMessages()) {
            await ctx.waitForIdle();
        }

        await sleep(80);
    }
}

async function generateHandoverDraftViaAgent(params: {
    pi: ExtensionAPI;
    ctx: ExtensionCommandContext;
    purpose: string;
    styleGuide: string;
    priorCompactionsAddendum: string;
    filesTouchedMode: FilesTouchedMode;
    collectFilesTouched: typeof collectFilesTouched;
}): Promise<DraftGenerationResult> {
    const { pi, ctx, purpose, styleGuide, priorCompactionsAddendum, filesTouchedMode } = params;

    const ready = await waitForQuiescentSession(ctx);
    if (!ready) {
        return {
            ok: false,
            error: "Please wait for pending messages to finish (or cancel streaming) and run /handover again",
        };
    }

    let ledger: FilesTouchedLedger;
    try {
        ledger = filesTouchedMode === "off"
            ? { mode: "off" }
            : {
                mode: filesTouchedMode,
                block: renderFilesTouchedManifestBlock(params.collectFilesTouched(ctx.sessionManager.getBranch(), ctx.cwd)),
            };
    } catch (error) {
        return {
            ok: false,
            error: `Failed to build files-touched list: ${error instanceof Error ? error.message : String(error)}`,
        };
    }

    const beforeEntries = ctx.sessionManager.getEntries();
    const beforeEntryIds = new Set(beforeEntries.map((entry) => entry.id));

    const nonce = createNonce();
    const prompt = buildHandoverInstructionPrompt({
        purpose,
        styleGuide,
        priorCompactionsAddendum,
        ledger,
        nonce,
    });

    ctx.ui.setWorkingMessage("Generating handover draft…");
    pi.sendUserMessage(prompt);

    const draft = await waitForAssistantDraft({ ctx, beforeEntryIds, nonce });
    ctx.ui.setWorkingMessage();

    if (!draft) {
        return {
            ok: false,
            error: "Could not extract handover draft from assistant output",
        };
    }

    return { ok: true, draft, ledger };
}

export default function (
    pi: ExtensionAPI,
    deps: HandoverDependencies = { configPath: CONFIG_PATH, collectFilesTouched },
) {
    registerFilesTouchedTracking(pi);
    let pending: PendingAutoSubmit | null = null;

    const clearPending = (ctx?: ExtensionContext, notify?: string) => {
        if (!pending) {
            return;
        }

        clearInterval(pending.interval);
        pending.unsubscribeInput();
        pending.ctx.ui.setStatus(STATUS_KEY, undefined);

        const localPending = pending;
        pending = null;

        if (notify && ctx) {
            ctx.ui.notify(notify, "info");
            return;
        }

        if (notify) {
            localPending.ctx.ui.notify(notify, "info");
        }
    };

    const autoSubmitDraft = () => {
        if (!pending) {
            return;
        }

        const active = pending;
        const currentSession = active.ctx.sessionManager.getSessionFile();
        if (!currentSession || currentSession !== active.sessionFile) {
            clearPending(undefined);
            return;
        }

        const draft = active.ctx.ui.getEditorText().trim();
        clearPending(undefined);

        if (!draft) {
            active.ctx.ui.notify("Draft is empty", "warning");
            return;
        }

        active.ctx.ui.setEditorText("");

        try {
            if (active.ctx.isIdle()) {
                pi.sendUserMessage(draft);
            } else {
                pi.sendUserMessage(draft, { deliverAs: "followUp" });
            }
        } catch {
            pi.sendUserMessage(draft);
        }
    };

    const startCountdown = (ctx: ExtensionContext, secondsTotal: number) => {
        clearPending(ctx);

        const sessionFile = ctx.sessionManager.getSessionFile();
        if (!sessionFile) {
            ctx.ui.notify("Auto-submit disabled: could not determine session identity", "warning");
            return;
        }

        let secondsRemaining = secondsTotal;
        ctx.ui.setStatus(STATUS_KEY, getStatusLine(ctx, secondsRemaining));

        const unsubscribeInput = ctx.ui.onTerminalInput((data) => {
            if (matchesKey(data, Key.escape)) {
                clearPending(ctx, "Auto-submit cancelled");
                return { consume: true };
            }

            // If the user presses Enter, Pi will submit the editor. We should stop
            // the countdown to avoid an additional auto-submit, but do it silently
            // (no confusing "cancelled" toast).
            if (data === "\r" || data === "\n" || data === "\r\n") {
                clearPending(ctx);
                return undefined;
            }

            if (isEditableInput(data)) {
                clearPending(ctx, "Auto-submit cancelled");
            }

            return undefined;
        });

        const interval = setInterval(() => {
            if (!pending) {
                return;
            }

            secondsRemaining -= 1;
            if (secondsRemaining <= 0) {
                autoSubmitDraft();
                return;
            }

            ctx.ui.setStatus(STATUS_KEY, getStatusLine(ctx, secondsRemaining));
        }, 1000);

        pending = {
            ctx,
            sessionFile,
            interval,
            unsubscribeInput,
        };
    };

    const runHandover = async (args: string, ctx: ExtensionCommandContext) => {
        if (!ctx.hasUI) {
            ctx.ui.notify("/handover requires interactive mode", "error");
            return;
        }

        const previousSessionFile = ctx.sessionManager.getSessionFile();
        if (!previousSessionFile) {
            ctx.ui.notify("/handover requires a persisted session file", "error");
            return;
        }

        // Loaded before drafting: an invalid files-touched setting must stop the handover, not fall back silently
        let config: ExtensionConfig;
        try {
            config = await loadConfig(deps.configPath);
        } catch (error) {
            ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
            return;
        }

        // Purpose is optional: if omitted, default to a simple continuation goal
        // (do not prompt, so `/handover` is a fast one-shot workflow)
        const purpose = args.trim() || "Continue from the current milestone/state with a clean child session and a rich rehydration message";

        const styleGuide = await loadStyleGuide();
        const priorCompactionsAddendum = buildPriorCompactionAddendum(ctx);

        const draftResult = await generateHandoverDraftViaAgent({
            pi,
            ctx,
            purpose,
            styleGuide,
            priorCompactionsAddendum,
            filesTouchedMode: config.includeFilesTouched,
            collectFilesTouched: deps.collectFilesTouched,
        });

        if (!draftResult.ok) {
            ctx.ui.notify(draftResult.error, "error");
            return;
        }

        const finalDraft = finalizeDraft(draftResult.draft, draftResult.ledger);

        await writePendingHandoverDraft({
            previousSessionFile,
            draft: finalDraft,
            autoSubmitSeconds: config.autoSubmitSeconds,
        });

        try {
            const newSessionResult = await ctx.newSession({
                parentSession: previousSessionFile,
                withSession: async (replacementCtx) => {
                    if (!replacementCtx.hasUI) {
                        return;
                    }

                    replacementCtx.ui.setEditorText(finalDraft);
                    if (config.autoSubmitSeconds <= 0) {
                        replacementCtx.ui.notify("Draft ready in editor (auto-submit disabled)", "info");
                    }
                },
            });
            if (newSessionResult.cancelled) {
                await clearPendingHandoverDraft(previousSessionFile);
                ctx.ui.notify("Child session creation cancelled", "warning");
                return;
            }
        } catch (error) {
            await clearPendingHandoverDraft(previousSessionFile);
            throw error;
        }
    };

    for (const eventName of [
        "session_before_switch",
        "session_before_fork",
        "session_before_tree",
        "session_tree",
        "session_shutdown",
    ] as const) {
        pi.on(eventName as any, (_event: any, eventCtx: any) => {
            if (pending) {
                clearPending(eventCtx);
            }
        });
    }

    pi.on("session_start", async (event, ctx) => {
        if (event.reason !== "new" || !event.previousSessionFile || !ctx.hasUI) {
            return;
        }

        const pendingDraft = await consumePendingHandoverDraft(event.previousSessionFile);
        if (!pendingDraft) {
            return;
        }

        if (pendingDraft.autoSubmitSeconds <= 0) {
            return;
        }

        startCountdown(ctx, pendingDraft.autoSubmitSeconds);
    });

    pi.registerCommand("handover", {
        description: "Generate rich handover draft, create a linked child session, prefill editor, optional auto-submit",
        handler: runHandover,
    });


}
