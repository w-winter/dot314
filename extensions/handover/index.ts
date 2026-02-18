import { access, readFile } from "node:fs/promises";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";

import type {
    ExtensionAPI,
    ExtensionCommandContext,
    ExtensionContext,
    SessionEntry,
} from "@mariozechner/pi-coding-agent";
import { Key, matchesKey } from "@mariozechner/pi-tui";

const STATUS_KEY = "handover";
const DEFAULT_AUTO_SUBMIT_SECONDS = 10;

const AGENT_DIR = path.join(os.homedir(), ".pi", "agent");

const REWIND_EXTENSION_DIR = path.join(AGENT_DIR, "extensions", "rewind");
const REWIND_EXTENSION_CANDIDATES = [
    "index.ts",
    "index.js",
    path.join("dist", "index.js"),
    path.join("build", "index.js"),
    "package.json",
];

const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(EXTENSION_DIR, "config.json");

// Optional override (user-editable) to avoid touching the .ts file
const PROMPT_OVERRIDE_PATH = path.join(EXTENSION_DIR, "prompt.md");

const DEFAULT_STYLE_GUIDE = `
## What to include
- **Context**: what we were trying to accomplish and why
- **Current state**: what is implemented/working right now
- **Key decisions & constraints**: APIs chosen, patterns to follow, gotchas
- **Files & code hotspots**: paths and what they contain (only important ones)
- **Open questions / risks**: unknowns, edge cases, failures encountered
- **Next steps**: concrete, ordered checklist for continuing

## Style
- Be concise but high-density
- Prefer bullets and short sections
- Include exact file paths / commands only when they materially help
`;

type ExtensionConfig = {
    autoSubmitSeconds: number;
};

type PendingAutoSubmit = {
    ctx: ExtensionContext;
    sessionFile: string;
    interval: ReturnType<typeof setInterval>;
    unsubscribeInput: () => void;
};

type SessionRecord = {
    entryIndex: number;
    type: string;
    timestamp?: string;
    summary?: string;
    tokensBefore?: number;
};

function truncateText(text: string, maxChars: number): string {
    const normalized = text ?? "";
    if (normalized.length <= maxChars) {
        return normalized;
    }

    return normalized.slice(0, maxChars) + `... (${normalized.length - maxChars} more chars)`;
}

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

async function loadConfig(): Promise<ExtensionConfig> {
    const fallback: ExtensionConfig = { autoSubmitSeconds: DEFAULT_AUTO_SUBMIT_SECONDS };

    try {
        const raw = await readFile(CONFIG_PATH, "utf8");
        const parsed = JSON.parse(raw) as Partial<ExtensionConfig>;
        const rawSeconds = parsed.autoSubmitSeconds;

        if (typeof rawSeconds !== "number" || Number.isNaN(rawSeconds)) {
            return fallback;
        }

        return {
            autoSubmitSeconds: Math.max(0, Math.min(300, Math.floor(rawSeconds))),
        };
    } catch {
        return fallback;
    }
}

async function isRewindInstalled(): Promise<boolean> {
    try {
        await access(REWIND_EXTENSION_DIR);
    } catch {
        return false;
    }

    for (const relPath of REWIND_EXTENSION_CANDIDATES) {
        try {
            await access(path.join(REWIND_EXTENSION_DIR, relPath));
            return true;
        } catch {
            // keep looking
        }
    }

    return false;
}

async function requestConversationOnlyForkWhenRewindIsInstalled(pi: ExtensionAPI): Promise<boolean> {
    if (!(await isRewindInstalled())) {
        return false;
    }

    // Only emit the preference when rewind is actually installed to avoid
    // accidentally influencing forks in environments without rewind.
    pi.events.emit("rewind:fork-preference", {
        mode: "conversation-only",
        source: "fork-from-first",
    });

    return true;
}

function getFirstUserEntryId(entries: SessionEntry[]): string | undefined {
    for (const entry of entries) {
        if (entry.type !== "message") {
            continue;
        }

        if (entry.message?.role === "user") {
            return entry.id;
        }
    }

    return undefined;
}

async function loadCompactionRecords(sessionPath: string): Promise<SessionRecord[]> {
    const records: SessionRecord[] = [];

    const stream = fs.createReadStream(sessionPath, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    const maxCompactionRecords = 20;

    let entryIndex = 0;
    for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }

        let parsed: any;
        try {
            parsed = JSON.parse(trimmed);
        } catch {
            continue;
        }

        entryIndex += 1;

        const recordType = typeof parsed?.type === "string" ? parsed.type : "unknown";
        if (recordType !== "compaction") {
            continue;
        }

        records.push({
            entryIndex,
            type: recordType,
            timestamp: typeof parsed?.timestamp === "string" ? parsed.timestamp : undefined,
            summary: typeof parsed?.summary === "string" ? parsed.summary : undefined,
            tokensBefore: typeof parsed?.tokensBefore === "number" ? parsed.tokensBefore : undefined,
        });

        if (records.length > maxCompactionRecords) {
            records.shift();
        }
    }

    return records;
}

async function buildPriorCompactionsAddendum(ctx: ExtensionCommandContext): Promise<string> {
    const sessionPath = ctx.sessionManager.getSessionFile();
    if (!sessionPath || !sessionPath.endsWith(".jsonl") || !fs.existsSync(sessionPath)) {
        return "";
    }

    try {
        const compactions = await loadCompactionRecords(sessionPath);

        // Drop the most recent compaction: the current model likely already has it in view
        const prior = compactions.slice(0, Math.max(0, compactions.length - 1));
        if (prior.length === 0) {
            return "";
        }

        const maxPerSummaryChars = 4000;
        const maxTotalChars = 12000;

        const lines: string[] = [];
        lines.push("## Prior compaction summaries (verbatim)");
        lines.push("");

        let used = 0;
        for (let i = prior.length - 1; i >= 0; i -= 1) {
            const record = prior[i];
            const summary = (record.summary ?? "").trim();
            if (!summary) {
                continue;
            }

            const header = `- [#${record.entryIndex}]`;
            const compactedFrom = typeof record.tokensBefore === "number" ? ` (from ${record.tokensBefore.toLocaleString()} tokens)` : "";
            const block = `${header}${compactedFrom}\n\n${truncateText(summary, maxPerSummaryChars)}`;

            if (used + block.length > maxTotalChars) {
                lines.push("- (older compaction summaries omitted due to size cap)");
                break;
            }

            lines.push(block);
            lines.push("");
            used += block.length;
        }

        return lines.join("\n").trim();
    } catch {
        return "";
    }
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
    | { ok: true; draft: string }
    | { ok: false; error: string };

function createNonce(): string {
    return `handover-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function buildHandoverInstructionPrompt(params: {
    purpose: string;
    styleGuide: string;
    priorCompactionsAddendum: string;
    nonce: string;
}): string {
    const { purpose, styleGuide, priorCompactionsAddendum, nonce } = params;

    const parts: string[] = [];

    // Marker for reliably correlating the assistant response to this exact prompt.
    // We match it in the *user* entry; the assistant is instructed not to echo it.
    parts.push(`<!-- handover-nonce: ${nonce} -->`);
    parts.push("");

    parts.push("You are generating a single rich handover / rehydration message for continuing this work in a NEW Pi session.");
    parts.push("");
    parts.push("Constraints:");
    parts.push("- Do NOT call tools");
    parts.push("- Do NOT write any files");
    parts.push("- Do NOT include the handover-nonce marker in your output");
    parts.push("- Output ONLY the final handover message in markdown (no <analysis> tags, no <plan> tags)");
    parts.push("- Make it high-signal and self-contained (assume the new session has near-zero context)");
    parts.push("");
    parts.push(`# Purpose\n${purpose.trim()}`);
    parts.push("");

    if (priorCompactionsAddendum.trim()) {
        parts.push(priorCompactionsAddendum.trim());
        parts.push("");
    }

    parts.push("## Style guide (adapt as needed)");
    parts.push("");
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

    while (Date.now() - startedAt < timeoutMs) {
        const afterEntries = ctx.sessionManager.getEntries();
        const draft = extractAssistantDraftForNonce({ afterEntries, beforeEntryIds, nonce });
        if (draft) {
            return draft;
        }

        // Wait for the agent loop to run. ctx.waitForIdle() only waits for streaming
        // to finish; it can return immediately if the queued user message hasn't
        // started processing yet. So we combine it with small sleeps.
        if (!ctx.isIdle() || ctx.hasPendingMessages()) {
            await ctx.waitForIdle();
        }

        await sleep(80);
    }

    return null;
}

async function generateHandoverDraftViaAgent(params: {
    pi: ExtensionAPI;
    ctx: ExtensionCommandContext;
    purpose: string;
    styleGuide: string;
    priorCompactionsAddendum: string;
}): Promise<DraftGenerationResult> {
    const { pi, ctx, purpose, styleGuide, priorCompactionsAddendum } = params;

    const ready = await waitForQuiescentSession(ctx);
    if (!ready) {
        return {
            ok: false,
            error: "Please wait for pending messages to finish (or cancel streaming) and run /handover again",
        };
    }

    const beforeEntries = ctx.sessionManager.getEntries();
    const beforeEntryIds = new Set(beforeEntries.map((entry) => entry.id));

    const nonce = createNonce();
    const prompt = buildHandoverInstructionPrompt({
        purpose,
        styleGuide,
        priorCompactionsAddendum,
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

    return { ok: true, draft };
}

export default function (pi: ExtensionAPI) {
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

        // Purpose is optional: if omitted, default to a simple continuation goal
        // (do not prompt, so `/handover` is a fast one-shot workflow)
        const purpose = args.trim() || "Continue from the current milestone/state with a clean child session and a rich rehydration message";

        const styleGuide = await loadStyleGuide();
        const priorCompactionsAddendum = await buildPriorCompactionsAddendum(ctx);

        const draftResult = await generateHandoverDraftViaAgent({
            pi,
            ctx,
            purpose,
            styleGuide,
            priorCompactionsAddendum,
        });

        if (!draftResult.ok) {
            ctx.ui.notify(draftResult.error, "error");
            return;
        }

        const draft = draftResult.draft;

        const firstUserEntryId = getFirstUserEntryId(ctx.sessionManager.getEntries());
        if (!firstUserEntryId) {
            ctx.ui.notify("No user message found to fork from", "warning");
            return;
        }

        const rewindInstalled = await requestConversationOnlyForkWhenRewindIsInstalled(pi);
        if (rewindInstalled) {
            ctx.ui.notify("Rewind detected: forcing conversation-only fork", "info");
        }

        const forkResult = await ctx.fork(firstUserEntryId);
        if (forkResult.cancelled) {
            ctx.ui.notify("Fork cancelled", "warning");
            return;
        }

        ctx.ui.setEditorText(draft);

        const config = await loadConfig();
        if (config.autoSubmitSeconds <= 0) {
            ctx.ui.notify("Draft ready in editor (auto-submit disabled)", "info");
            return;
        }

        startCountdown(ctx, config.autoSubmitSeconds);
    };

    for (const eventName of [
        "session_before_switch",
        "session_switch",
        "session_before_fork",
        "session_fork",
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

    pi.registerCommand("handover", {
        description: "Generate rich handover draft, fork from first user message, prefill editor, optional auto-submit",
        handler: runHandover,
    });


}
