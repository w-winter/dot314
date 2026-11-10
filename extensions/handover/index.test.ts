import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";

import type { FilesTouchedEntry } from "../_shared/files-touched-core.ts";
import { renderFilesTouchedManifestBlock } from "../grounded-compaction/index.ts";
import handoverExtension from "./index.ts";

const LEDGER_LEGEND = "R=read, W=write, E=edit, M=move/rename, D=delete";
const DRAFT_BODY = "## Brief\nContinue the parser work in src/parser.ts.";
const MODEL_AUTHORED_TAIL = `## Files touched\n${LEDGER_LEGEND}\n\n\`\`\`text\nE  src/parser.ts\n\`\`\``;
const TRACKED_FILE: FilesTouchedEntry = {
    path: "/repo/src/parser.ts",
    displayPath: "src/parser.ts",
    operations: new Set(["edit"]),
    lastTimestamp: 1,
};

const tempDirs: string[] = [];

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

type Notification = { message: string; level?: string };
type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
type SessionStartHandler = (event: { reason: string; previousSessionFile: string }, ctx: { hasUI: boolean }) => Promise<void>;
type ChildEditorContext = { hasUI: boolean; ui: { setEditorText(text: string): void; notify(): void } };

/** Runs the registered /handover command against temp config and session files with a simulated drafting model */
async function runHandover(options: {
    configText?: string;
    compactionSummaries?: string[];
    compactionDetails?: unknown[];
    /** Cancels child creation, which clears the pending draft without starting an auto-submit countdown */
    cancelChildSession?: boolean;
    /** The simulated model's reply; defaults to a draft body followed by a model-authored files-touched list */
    draft?: string;
}) {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "handover-test-"));
    tempDirs.push(tempDir);
    const configPath = path.join(tempDir, "config.json");
    if (options.configText !== undefined) {
        await writeFile(configPath, options.configText, "utf8");
    }
    const sessionFile = path.join(tempDir, "session.jsonl");

    const entries: SessionEntry[] = (options.compactionSummaries ?? []).map((summary, index) => ({
        type: "compaction",
        id: `compaction-${index}`,
        parentId: null,
        timestamp: new Date(0).toISOString(),
        summary,
        firstKeptEntryId: "first-kept",
        tokensBefore: 1000,
        details: options.compactionDetails?.[index],
    }));
    const prompts: string[] = [];
    const notifications: Notification[] = [];
    const collectCalls: SessionEntry[][] = [];
    let editorText: string | undefined;
    let newSessionCalls = 0;
    let command: CommandHandler | undefined;
    const sessionStartHandlers: SessionStartHandler[] = [];

    const fakePi = {
        events: { on: () => () => {}, emit: () => {} },
        on(eventName: string, handler: SessionStartHandler) {
            if (eventName === "session_start") sessionStartHandlers.push(handler);
        },
        registerCommand(_name: string, registration: { handler: CommandHandler }) {
            command = registration.handler;
        },
        sendUserMessage(prompt: string) {
            prompts.push(prompt);
            // SAFETY: draft extraction reads only the id, type, and message role and content of these entries.
            entries.push(
                { id: `user-${prompts.length}`, type: "message", message: { role: "user", content: prompt } } as SessionEntry,
                {
                    id: `assistant-${prompts.length}`,
                    type: "message",
                    message: { role: "assistant", content: [{ type: "text", text: options.draft ?? `${DRAFT_BODY}\n\n${MODEL_AUTHORED_TAIL}` }] },
                } as SessionEntry,
            );
        },
    };
    // SAFETY: /handover uses only these Pi API members.
    const pi = Object.assign({} as ExtensionAPI, fakePi);

    handoverExtension(pi, {
        configPath,
        collectFilesTouched: (branchEntries) => {
            collectCalls.push(branchEntries);
            return [TRACKED_FILE];
        },
    });
    assert.ok(command);

    // SAFETY: /handover reads only these members of the command context.
    const ctx = Object.assign({} as ExtensionCommandContext, {
        hasUI: true,
        cwd: tempDir,
        ui: {
            notify: (message: string, level?: string) => notifications.push({ message, level }),
            setStatus: () => {},
            setWorkingMessage: () => {},
            setEditorText: () => {},
        },
        sessionManager: {
            getSessionFile: () => sessionFile,
            getEntries: () => entries,
            getBranch: () => entries,
        },
        isIdle: () => true,
        hasPendingMessages: () => false,
        waitForIdle: async () => {},
        newSession: async (request: { withSession: (replacementCtx: ChildEditorContext) => Promise<void> }) => {
            newSessionCalls += 1;
            if (options.cancelChildSession) return { cancelled: true };
            await request.withSession({
                hasUI: true,
                ui: { setEditorText: (text: string) => { editorText = text; }, notify: () => {} },
            });
            return { cancelled: false };
        },
    });

    await command("", ctx);
    if (newSessionCalls > 0 && !options.cancelChildSession) {
        // Consume the pending draft through the extension's own session_start path so no temp state survives the test
        for (const handler of sessionStartHandlers) {
            await handler({ reason: "new", previousSessionFile: sessionFile }, { hasUI: true });
        }
    }

    return { prompts, notifications, collectCalls, editorText, newSessionCalls, configPath };
}

describe("handover files-touched audiences", () => {
    it("reads the recorded body instead of appended user material", async () => {
        const body = "Summary body\n\n## Verbatim user messages\nThis heading is part of the summary.";
        const run = await runHandover({
            configText: '{"autoSubmitSeconds":0,"includeFilesTouched":"off"}',
            compactionSummaries: [`${body}\n\nSupplement-only text`, "Latest body"],
            compactionDetails: [{ groundedRetention: { version: 1, summaryBody: body, decisions: {}, retainedEntryIds: [] } }],
        });
        assert.ok(run.prompts[0].includes(body));
        assert.ok(!run.prompts[0].includes("Supplement-only text"));
    });
    it("handover routes the fresh ledger to the configured audiences", async () => {
        const block = renderFilesTouchedManifestBlock([TRACKED_FILE]);

        const off = await runHandover({ configText: '{"autoSubmitSeconds": 0, "includeFilesTouched": "off"}' });
        assert.equal(off.collectCalls.length, 0);
        assert.ok(!off.prompts[0].includes(block));
        assert.doesNotMatch(off.prompts[0], /files-touched list/);
        assert.equal(off.editorText, `# Handover message\n\n${DRAFT_BODY}`);

        const writer = await runHandover({ configText: '{"autoSubmitSeconds": 0, "includeFilesTouched": "writer"}' });
        assert.equal(writer.collectCalls.length, 1);
        assert.ok(writer.prompts[0].includes(block));
        assert.match(writer.prompts[0], /will not be included in the final handover/);
        assert.doesNotMatch(writer.prompts[0], /appended/);
        assert.equal(writer.editorText, `# Handover message\n\n${DRAFT_BODY}`);

        const writerAndReader = await runHandover({ configText: '{"autoSubmitSeconds": 0, "includeFilesTouched": "writerAndReader"}' });
        assert.equal(writerAndReader.collectCalls.length, 1);
        assert.match(writerAndReader.prompts[0], /appended verbatim/);
        assert.equal(writerAndReader.editorText, `# Handover message\n\n${DRAFT_BODY}\n\n${block}`);
    });

    it("handover strips a model-authored files-touched list only when it ends the draft", async () => {
        const nextSteps = "## Next steps\nRun the suite:\n\n```text\nnpm test\n```";
        const labeledList = "Files touched in this session:\n\n```text\nE  src/parser.ts\n```";
        for (const draft of [
            `${DRAFT_BODY}\n\n${MODEL_AUTHORED_TAIL}\n\n${nextSteps}`,
            `${DRAFT_BODY}\n\n${labeledList}\n\n${nextSteps}`,
        ]) {
            const run = await runHandover({ configText: '{"autoSubmitSeconds": 0, "includeFilesTouched": "writer"}', draft });
            assert.equal(run.editorText, `# Handover message\n\n${draft}`);
        }
    });

    it("handover rejects invalid configuration before drafting", async () => {
        for (const configText of ['{"includeFilesTouched": true}', '{"includeFilesTouched": "reader"}', "{not json", "[]"]) {
            const run = await runHandover({ configText });
            assert.equal(run.notifications.length, 1, configText);
            assert.equal(run.notifications[0].level, "error");
            assert.ok(run.notifications[0].message.includes(run.configPath), configText);
            assert.equal(run.prompts.length, 0);
            assert.equal(run.collectCalls.length, 0);
            assert.equal(run.newSessionCalls, 0);
        }
        const rejectedBoolean = await runHandover({ configText: '{"includeFilesTouched": false}' });
        assert.match(rejectedBoolean.notifications[0].message, /must be "off", "writer", or "writerAndReader"/);

        for (const configText of [undefined, '{"autoSubmitSeconds": "x"}']) {
            const run = await runHandover({ configText, cancelChildSession: true });
            assert.equal(run.collectCalls.length, 1);
            assert.match(run.prompts[0], /will not be included in the final handover/);
        }
    });

    it("handover includes the previous compaction summary on the branch in full without its ledger", async () => {
        const manyFiles = Array.from({ length: 300 }, (_, index): FilesTouchedEntry => ({
            path: `/repo/src/module-${index}.ts`,
            displayPath: `src/module-${index}.ts`,
            operations: new Set(["read"]),
            lastTimestamp: index,
        }));
        const cumulativeLedger = renderFilesTouchedManifestBlock(manyFiles, "## Files touched (cumulative)");
        assert.ok(cumulativeLedger.length > 4000);

        const run = await runHandover({
            configText: '{"autoSubmitSeconds": 0, "includeFilesTouched": "off"}',
            compactionSummaries: [
                `Older body\n\n---\n\n${cumulativeLedger}`,
                `Middle body\n\n## Earlier section\n\nKept src/kept.ts\n\n${renderFilesTouchedManifestBlock([TRACKED_FILE])}`,
                "Latest body",
            ],
        });
        const prompt = run.prompts[0];
        assert.match(prompt, /## Previous compaction summary\n/);
        assert.doesNotMatch(prompt, /Older body/);
        assert.match(prompt, /Middle body/);
        assert.match(prompt, /src\/kept\.ts/);
        assert.ok(!prompt.includes(LEDGER_LEGEND));
        assert.doesNotMatch(prompt, /more chars/);
        assert.doesNotMatch(prompt, /Latest body/);

        const ledgerOnly = await runHandover({
            configText: '{"autoSubmitSeconds": 0, "includeFilesTouched": "off"}',
            compactionSummaries: [cumulativeLedger, "Latest body"],
        });
        assert.doesNotMatch(ledgerOnly.prompts[0], /## Previous compaction summary/);
    });
});
