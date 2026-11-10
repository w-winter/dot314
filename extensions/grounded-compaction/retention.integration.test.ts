import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";

import { contentText, fauxAssistantMessage, fauxProvider, getCurrentSystemPrompt, getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import { estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import {
    createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
    type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { readGroundedRetentionRecord } from "../_shared/grounded-compaction-record.ts";
import { parseConfig, registerGroundedCompaction, runGroundedCompaction } from "./index.ts";

const LONG_SOURCE = `Preserve the public API.\r\n${"Diagnostic detail 🙂\n".repeat(30)}`;

it("retains exact revisions through real compaction, resume, forks and failed attempts", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "grounded-retention-e2e-"));
    let passed = false;
    const sessions: Awaited<ReturnType<typeof createAgentSession>>["session"][] = [];
    try {
        let retention = true;
        let behavior: "normal" | "length" | "invalid" | "change-leaf" | "abort" = "normal";
        const requests: TranscriptContext[] = [];
        let activeManager: SessionManager;
        let controller = new AbortController();
        const factory = (pi: ExtensionAPI) => registerGroundedCompaction(pi, {
            runCompaction: (event, ctx, queryPreviousSummary) => runGroundedCompaction({ ...event, signal: controller.signal }, ctx, {
                collectFilesTouched: () => [],
                loadConfig: async () => parseConfig({
                    includeFilesTouched: "writerAndReader", verbatimUserMessageTokens: retention ? 4000 : null, verbatimUserMessageFlagChars: 100,
                }),
                loadCompactionPrompt: async () => "Include every current constraint. Preserve the public API.",
                loadBranchSummaryPrompt: async () => undefined,
                queryPreviousSummary,
            }),
        });
        async function start(manager: SessionManager) {
            activeManager = manager;
            const faux = fauxProvider({ provider: "faux", models: [{ id: "retention-e2e", contextWindow: 100_000 }], tokensPerSecond: 100_000 });
            faux.setResponses(Array.from({ length: 40 }, () => (context: TranscriptContext) => {
                requests.push(structuredClone(context));
                if (!getCurrentSystemPrompt(context.messages).includes("structured compaction summary")) {
                    return fauxAssistantMessage("Work remains in progress. ".repeat(30));
                }
                if (behavior === "abort") controller.abort();
                if (behavior === "change-leaf") activeManager.appendCustomEntry("test-change", {});
                if (behavior === "length") return fauxAssistantMessage("truncated summary", { stopReason: "length" });
                if (behavior === "invalid") return fauxAssistantMessage("missing retention envelope");
                const prompt = context.messages.filter((message) => message.role === "user").map((message) => contentText(message.content)).join("\n");
                const decisions = [...prompt.matchAll(/^\[User entryId="([^"]+)"; retention-editable\]/gm)].map((match) => ({
                    entryId: match[1], action: "excerpt", ranges: [{ startLine: 1, endLine: 1 }],
                }));
                const body = "## Brief\nPreserve the public API. Work is still incomplete.";
                return fauxAssistantMessage(retention ? `## Grounded retention decisions\n\n\`\`\`json\n${JSON.stringify({ decisions })}\n\`\`\`\n\n${body}` : body);
            }));
            const runtime = await ModelRuntime.create({ authPath: path.join(dir, "test-auth.json"), modelsPath: null, refreshOnCreate: false });
            runtime.registerNativeProvider(faux.provider);
            const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, extensionFactories: [factory] });
            await resourceLoader.reload();
            const { session } = await createAgentSession({
                cwd: dir, agentDir: dir, model: faux.getModel(), thinkingLevel: "off", modelRuntime: runtime,
                resourceLoader, tools: ["read"], sessionManager: manager,
                settingsManager: SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 20, reserveTokens: 1000 } }),
            });
            sessions.push(session);
            return session;
        }
        function latest(manager: SessionManager) {
            const entry = manager.getBranch().findLast((entry) => entry.type === "compaction");
            assert.ok(entry);
            const record = readGroundedRetentionRecord(entry);
            assert.ok(record);
            return { entry, record };
        }
        async function checkFiles(manager: SessionManager) {
            const { record } = latest(manager);
            for (const id of record.retainedEntryIds) {
                if (!Object.hasOwn(record.decisions, id)) continue;
                const decision = record.decisions[id];
                const file = path.join(manager.getSessionDir(), `${manager.getSessionId()}.verbatim`, `${decision.contentHash}.txt`);
                assert.deepEqual(await readFile(file), Buffer.from(LONG_SOURCE));
            }
        }
        const manager = SessionManager.create(dir, path.join(dir, "sessions"));
        let session = await start(manager);
        await session.prompt(LONG_SOURCE);
        const first = manager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "user");
        assert.ok(first);
        const tail = manager.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
        assert.ok(tail);
        const replacement = "Effective kept-tail replacement. ".repeat(20);
        manager.appendContextEdit(tail.id, { content: replacement });
        const toolsBefore = getCurrentTools(manager.buildSessionProjection().messages);
        assert.ok(toolsBefore.some((tool) => tool.name === "read"));
        await session.compact();
        assert.deepEqual(latest(manager).record.retainedEntryIds, [first.id]);
        await checkFiles(manager);
        const savedSummary = latest(manager).entry.summary;
        const beforeContinuation = requests.length;
        await session.prompt(LONG_SOURCE);
        const continuation = requests[beforeContinuation];
        assert.deepEqual(getCurrentTools(continuation.messages), toolsBefore);
        const rendered = continuation.messages.map((message) => contentText(message.content, "")).join("\n");
        assert.equal(rendered.split(savedSummary).length - 1, 1);
        assert.equal(rendered.split("## Files touched (cumulative)").length - 1, 1);
        assert.equal(rendered.split(replacement).length - 1, 1);
        assert.ok(!rendered.includes("Work remains in progress."));
        assert.ok(continuation.messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0) + 1000 <= 100_000);
        const second = manager.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "user");
        assert.ok(second);
        manager.appendContextEdit(first.id, null);
        await session.compact();
        assert.deepEqual(latest(manager).record.retainedEntryIds, [second.id]);
        assert.equal(latest(manager).record.decisions[first.id], undefined);
        await checkFiles(manager);
        const savedFile = manager.getSessionFile();
        assert.ok(savedFile);
        assert.ok((await readFile(savedFile, "utf8")).includes('"groundedRetention"'));
        session.dispose();
        const resumed = SessionManager.open(savedFile);
        session = await start(resumed);
        await session.prompt("Continue after resume");
        await session.compact();
        await checkFiles(resumed);
        const child = SessionManager.forkFrom(savedFile, dir, path.join(dir, "children"));
        session.dispose();
        session = await start(child);
        await session.prompt("Continue in child");
        await session.compact();
        await checkFiles(child);
        assert.notEqual(child.getSessionId(), resumed.getSessionId());
        assert.equal(latest(child).record.decisions[first.id], undefined);

        for (const failure of ["length", "invalid", "change-leaf", "abort"] as const) {
            behavior = "normal";
            await session.prompt(`Attempt ${failure}`);
            const count = child.getBranch().filter((entry) => entry.type === "compaction").length;
            behavior = failure;
            await assert.rejects(session.compact(), /cancel/i);
            assert.equal(child.getBranch().filter((entry) => entry.type === "compaction").length, count);
            controller = new AbortController();
        }
        behavior = "normal";
        const record = latest(child).record;
        const decision = record.decisions[second.id];
        assert.ok(decision);
        const corruptPath = path.join(child.getSessionDir(), `${child.getSessionId()}.verbatim`, `${decision.contentHash}.txt`);
        await writeFile(corruptPath, "corrupt");
        await session.prompt("Try another compaction");
        await assert.rejects(session.compact(), /cancel/i);
        assert.equal(await readFile(corruptPath, "utf8"), "corrupt");

        retention = false;
        behavior = "change-leaf";
        const disabledCompactions = child.getBranch().filter((entry) => entry.type === "compaction").length;
        await assert.rejects(session.compact(), /cancel/i);
        assert.equal(child.getBranch().filter((entry) => entry.type === "compaction").length, disabledCompactions);
        assert.equal(child.getLeafEntry()?.type, "custom");
        behavior = "normal";
        const beforeDisabled = requests.length;
        await session.compact();
        const input = JSON.stringify(requests.slice(beforeDisabled));
        assert.ok(!input.includes("Exact source revision"));
        assert.ok(!input.includes("retention-editable"));
        assert.ok(input.includes("Preserve the public API"));
        assert.ok((await readdir(child.getSessionDir())).some((name) => name.endsWith(".jsonl")));
        passed = true;
    } finally {
        for (const session of sessions) session.dispose();
        if (passed) execFileSync("trash", [dir]);
        else console.error(`Retention E2E artifact: ${dir}`);
    }
});
