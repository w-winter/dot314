import path from "node:path";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

import type { loadConfig } from "./configuration.ts";
import { outstandingReading, type OutstandingReading } from "./reading-coverage.ts";
import { requiredReadingRecord } from "./required-reading.ts";

const READING_MESSAGE = "grounded-required-reading";
const READING_OFF = "grounded-reading-off";
const READING_REMINDER = "grounded-reading-reminder";
const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const SHELL_TOOLS = new Set(["bash", "exec", "wait", "exec_command", "write_stdin", "codemode"]);

/** Enforces the latest summary on the active branch when its summary type is enabled. */
export function registerReadingGate(pi: ExtensionAPI, getConfig: typeof loadConfig): void {
    let requestMessages: readonly AgentMessage[] | undefined;
    pi.on("context_with_system", (event) => { requestMessages = event.messages; });
    pi.on("session_start", () => { requestMessages = undefined; });

    const pending = async (ctx: ExtensionContext) => {
        const config = await getConfig();
        if (!config.enforceCompactionMandatoryReading && !config.enforceBranchMandatoryReading) return undefined;
        const branch = ctx.sessionManager.getBranch();
        // Projection puts a compaction before its kept entries, so select the transition in branch order.
        const transition = branch.findLast((entry) => entry.type === "compaction" || entry.type === "branch_summary");
        if (!transition) return undefined;
        const enabled = transition.type === "compaction" ? config.enforceCompactionMandatoryReading : config.enforceBranchMandatoryReading;
        if (!enabled) return undefined;
        const records = requiredReadingRecord(transition)?.paths ?? [];
        if (records.length === 0 || hasMarker(branch, READING_OFF, transition.id)) return undefined;
        const projection = ctx.sessionManager.buildSessionProjection();
        const files = outstandingReading([...new Set(records)], requestMessages ?? projection.messages, ctx.getSystemPrompt(), ctx.cwd);
        const summaryKind = transition.type === "compaction" ? "compaction" : "branch";
        return files.length > 0 ? { transitionId: transition.id, files, summaryKind } : undefined;
    };
    const remind = async (ctx: ExtensionContext) => {
        requestMessages = undefined;
        const reading = await pending(ctx);
        if (reading) pi.sendMessage({
            customType: READING_MESSAGE,
            content: `[grounded-compaction] Read outstanding files in the latest ${reading.summaryKind} summary's <grounded-required-reading> block before continuing. Contents already in context are exempt. Use read; if unavailable, use cat or sed -n 'START,ENDp' with a literal file path. Emit one bounded file chunk per call. Other tools remain restricted until the required contents are in context.`,
            display: false,
        }, { deliverAs: "steer" });
    };
    pi.on("session_compact", (_event, ctx) => remind(ctx));
    pi.on("session_tree", (_event, ctx) => remind(ctx));
    pi.on("tool_call", async (event, ctx) => {
        if (READ_TOOLS.has(event.toolName)) return;
        const reading = await pending(ctx);
        if (!reading) return;
        if (!pi.getActiveTools().includes("read") && SHELL_TOOLS.has(event.toolName)) return;
        return { block: true, reason: instruction(reading.files, ctx.cwd) };
    });
    pi.on("agent_before_settle", async (event, ctx) => {
        if (event.outcome !== "completed") return;
        const reading = await pending(ctx);
        if (!reading || hasMarker(ctx.sessionManager.getBranch(), READING_REMINDER, reading.transitionId)) return;
        return {
            entries: [...event.entries,
                { type: "custom" as const, customType: READING_REMINDER, data: reading.transitionId },
                { type: "custom_message" as const, customType: READING_MESSAGE, content: instruction(reading.files, ctx.cwd), display: false },
            ],
            continue: true,
        };
    });
    pi.registerCommand("reading-gate-off", {
        description: "Suspend required reading until the next compaction or branch summary",
        handler: async (_args, ctx) => {
            const transition = ctx.sessionManager.getBranch()
                .findLast((entry) => entry.type === "compaction" || entry.type === "branch_summary");
            if (transition) pi.appendEntry(READING_OFF, transition.id);
            ctx.ui.notify("Required-reading enforcement suspended until the next summary.", "info");
        },
    });
}

function hasMarker(entries: readonly SessionEntry[], customType: string, transitionId: string): boolean {
    return entries.some((entry) => entry.type === "custom" && entry.customType === customType && entry.data === transitionId);
}

function instruction(files: readonly OutstandingReading[], cwd: string): string {
    const paths = files.map((file) => {
        const relative = path.relative(cwd, file.path);
        const ranges = file.ranges.map(({ start, end }) => start === end ? `${start}` : `${start}-${end}`).join(", ");
        return `${relative.startsWith("..") ? file.path : relative} (lines ${ranges})`;
    });
    return `[grounded-compaction] Read missing lines before continuing: ${paths.join(", ")}. Use read offsets/limits or sed -n 'START,ENDp' with a literal file path. Emit one bounded file chunk per call. Other tools unlock when all required lines are in context.`;
}
