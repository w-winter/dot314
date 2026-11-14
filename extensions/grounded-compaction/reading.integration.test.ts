import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";

import { contentText, fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemPrompt, type AssistantMessage, type FauxResponseFactory, type JsonObject } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { parseConfig, registerGroundedCompaction, runGroundedBranchSummaryAugmentation, runGroundedCompaction } from "./index.ts";

const say = (text: string) => fauxAssistantMessage(text);
const call = (name: string, args: JsonObject) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const readingBlock = (files: string[]) => `<grounded-required-reading>\n${JSON.stringify({ paths: files })}\n</grounded-required-reading>`;

const ExecInput = Type.Object({ command: Type.String(), emit: Type.Boolean() });
const execTool: ToolDefinition<typeof ExecInput> = {
    name: "exec", label: "exec", description: "Read through a nested shell call and optionally emit its result.", parameters: ExecInput,
    async execute(_id, input, signal, _onUpdate, ctx) {
        const outcome = await ctx.executeTool("bash", { command: input.command }, { signal });
        return { content: [{ type: "text", text: input.emit ? JSON.stringify(outcome.result) : "Nested call completed." }], details: undefined };
    },
};

async function harness(dir: string, manager = SessionManager.create(dir, path.join(dir, "sessions"))) {
    const work: AssistantMessage[] = [];
    const summaries: string[] = [];
    const summaryPrompts: string[] = [];
    const config = parseConfig({ enforceCompactionMandatoryReading: true, includeFilesTouched: "off", verbatimUserMessageTokens: 1000 });
    const deps = {
        loadConfig: async () => config,
        collectFilesTouched: () => [],
        loadCompactionPrompt: async () => "Summarize the goal and remaining work.",
        loadBranchSummaryPrompt: async () => "Summarize the work on the abandoned branch.",
    };
    const factory = (pi: ExtensionAPI) => registerGroundedCompaction(pi, {
        loadConfig: deps.loadConfig,
        runCompaction: (event, ctx, queryPreviousSummary) => runGroundedCompaction(event, ctx, { ...deps, queryPreviousSummary }),
        runBranchSummary: (event, ctx) => runGroundedBranchSummaryAugmentation(event, ctx, deps),
    });
    const faux = fauxProvider({ provider: "faux", models: [{ id: "required-reading", contextWindow: 100_000 }], tokensPerSecond: 100_000 });
    const respond: FauxResponseFactory = (context) => {
        faux.appendResponses([respond]);
        const prompt = context.messages.filter((message) => message.role === "user").map((message) => contentText(message.content)).join("\n");
        const system = getCurrentSystemPrompt(context.messages);
        const grounded = system.includes("structured compaction summary");
        if (grounded || system.includes("You are a context summarization assistant.")) {
            if (grounded && config.enforceCompactionMandatoryReading) assert.ok(system.includes("<grounded-required-reading>"), "the system prompt must require the reading block");
            summaryPrompts.push(`${system}\n${prompt}`);
            const response = summaries.shift();
            assert.ok(response, "a summary response must have been queued");
            const prefix = system.includes("## Retention response format") ? '## Grounded retention decisions\n```json\n{"decisions":[]}\n```\n' : "";
            return say(prefix + response);
        }
        return work.shift() ?? say("Waiting for the required files.");
    };
    // Split-turn compaction starts history and prefix requests in parallel.
    faux.setResponses([respond, respond]);
    const runtime = await ModelRuntime.create({ authPath: path.join(dir, "test-auth.json"), modelsPath: null, refreshOnCreate: false });
    runtime.registerNativeProvider(faux.provider);
    const settings = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 1000, reserveTokens: 1000 } }, { projectTrusted: true });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings, extensionFactories: [factory] });
    await loader.reload();
    const { session } = await createAgentSession({
        cwd: dir, agentDir: dir, model: faux.getModel(), modelRuntime: runtime, thinkingLevel: "off", resourceLoader: loader,
        tools: ["read", "bash", "write", "exec"], customTools: [execTool], sessionManager: manager, settingsManager: settings,
    });
    function results() {
        return manager.getBranch().flatMap((entry) => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []);
    }
    return { session, manager, work, summaries, summaryPrompts, results, config };
}

it("enforces generated reading lists while crediting system instructions and full retained reads, including split reads", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "grounded-reading-e2e-"));
    await mkdir(path.join(dir, ".pi"));
    await writeFile(path.join(dir, "AGENTS.md"), "Project agent instructions.\n");
    await writeFile(path.join(dir, ".pi", "APPEND_SYSTEM.md"), "Project workflow instructions.\n");
    const erased = path.join(dir, "erased.md");
    const kept = path.join(dir, "kept.md");
    const partial = path.join(dir, "partial.md");
    await writeFile(erased, "Content from the older summarized span.\n");
    await writeFile(kept, "Content retained verbatim in the split-turn suffix.\n");
    await writeFile(partial, "First line.\nSecond line.\nThird line.\n");
    let h = await harness(dir);
    let passed = false;
    try {
        h.work.push(call("read", { path: erased }), say("Earlier work complete."));
        await h.session.prompt("Read the old report.");
        h.work.push(call("read", { path: kept }), call("read", { path: partial, limit: 1 }), say("Ready to continue."));
        await h.session.prompt("A large user-message span. ".repeat(1000));
        const required = [erased, kept, partial, path.join(dir, "AGENTS.md"), path.join(dir, ".pi", "APPEND_SYSTEM.md"), dir];
        h.summaries.push(`## Brief\nContinue the task.\n${readingBlock(required)}`, `Split-turn progress.\n${readingBlock(required)}`);
        await h.session.compact();
        assert.ok(h.summaryPrompts.every((prompt) => prompt.includes("<grounded-required-reading>")));
        const reminders = h.manager.getBranch().filter((entry) => entry.type === "custom_message").filter((entry) => entry.customType === "grounded-required-reading");
        assert.equal(reminders.length, 1);
        const reminder = contentText(reminders[0].content);
        assert.ok(reminder.includes("<grounded-required-reading>"));
        assert.ok(required.every((file) => !reminder.includes(path.basename(file))), "initial reminders must reference the summary instead of repeating its paths");
        const saved = h.manager.getSessionFile();
        assert.ok(saved);
        h.session.dispose();
        h = await harness(dir, SessionManager.open(saved));
        h.work.push(call("bash", { command: "echo premature" }), call("read", { path: erased }),
            call("bash", { command: "echo still-partial" }), call("read", { path: partial, offset: 2 }),
            call("bash", { command: "echo released" }), say("Done."));
        await h.session.prompt("Continue after compaction.");
        const commands = h.results().filter((result) => result.toolName === "bash");
        assert.equal(commands.length, 3);
        assert.equal(commands[0].isError, true);
        const diagnostic = contentText(commands[0].content);
        assert.ok(diagnostic.includes("erased.md") && diagnostic.includes("partial.md"));
        assert.ok(!diagnostic.includes("kept.md") && !diagnostic.includes("AGENTS.md") && !diagnostic.includes("APPEND_SYSTEM.md"));
        assert.equal(commands[1].isError, true);
        assert.equal(contentText(commands[2].content).trim(), "released");
        const sessionFile = h.manager.getSessionFile();
        assert.ok(sessionFile);
        await writeFile(path.join(dir, "receipt.json"), JSON.stringify({ sessionFile, blocked: 2, released: true }));
        passed = true;
    } finally {
        h.session.dispose();
        if (passed) execFileSync("trash", [dir]);
        else console.error(`Reading E2E artifact: ${dir}`);
    }
});

it("cancels malformed compactions, accepts an explicit empty list, and leaves enforcement off by default", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "grounded-reading-contract-"));
    const h = await harness(dir);
    let passed = false;
    try {
        h.config.verbatimUserMessageTokens = null;
        h.work.push(say("Work remains. ".repeat(300)));
        await h.session.prompt("Prepare a checkpoint. ".repeat(300));
        for (const invalid of ["Missing reading list.", readingBlock([]) + readingBlock([]),
            '<grounded-required-reading>\n{"paths":["relative.md"]}\n</grounded-required-reading>']) {
            h.summaries.push(`Summary.\n${invalid}`);
            const before = h.manager.getLeafId();
            await assert.rejects(h.session.compact(), /cancel/i);
            assert.equal(h.manager.getLeafId(), before);
        }
        h.summaries.push(`Summary.\n${readingBlock([])}`);
        await h.session.compact();
        h.work.push(call("bash", { command: "echo no-required-files" }), say("Done."));
        await h.session.prompt("Continue.");
        assert.equal(contentText(h.results().at(-1)!.content).trim(), "no-required-files");

        h.config.enforceCompactionMandatoryReading = parseConfig({}).enforceCompactionMandatoryReading;
        h.work.push(say("More work remains. ".repeat(300)));
        await h.session.prompt("Prepare another checkpoint. ".repeat(300));
        h.summaries.push("Summary with no reading block.", "Split-turn progress without a reading block.");
        await h.session.compact();
        assert.ok(!h.summaryPrompts.at(-1)!.includes("## Required reading response contract"));
        passed = true;
    } finally {
        h.session.dispose();
        if (passed) execFileSync("trash", [dir]);
        else console.error(`Reading contract E2E artifact: ${dir}`);
    }
});

it("branch summaries credit destination reads, not reads on the abandoned branch, and reject invalid reading responses", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "grounded-reading-tree-"));
    const common = path.join(dir, "common.md");
    const abandoned = path.join(dir, "abandoned.md");
    await writeFile(common, "Shared ancestor report.\n");
    await writeFile(abandoned, "Abandoned branch report.\n");
    const h = await harness(dir);
    let passed = false;
    try {
        h.config.enforceCompactionMandatoryReading = false;
        h.config.enforceBranchMandatoryReading = true;
        h.work.push(call("read", { path: common }), say("Shared work."));
        await h.session.prompt("Read the shared report.");
        const target = h.manager.getLeafId();
        assert.ok(target);
        h.work.push(call("read", { path: abandoned }), say("Branch work."));
        await h.session.prompt("Read the branch report.");
        for (const invalid of ["No reading block.", '<grounded-required-reading>\n{"paths":"wrong"}\n</grounded-required-reading>']) {
            h.summaries.push(`Summary.\n${invalid}`);
            const before = h.manager.getLeafId();
            const result = await h.session.navigateTree(target, { summarize: true });
            assert.equal(result.cancelled, true);
            assert.equal(h.manager.getLeafId(), before);
        }
        h.summaries.push(`Branch summary.\n${readingBlock([common, abandoned])}`);
        const result = await h.session.navigateTree(target, { summarize: true });
        assert.equal(result.cancelled, false);
        assert.ok(h.summaryPrompts.at(-1)!.includes("<grounded-required-reading>"));
        h.config.enforceCompactionMandatoryReading = true;
        h.config.enforceBranchMandatoryReading = false;
        h.work.push(call("bash", { command: "echo branch-disabled" }), say("Related work."));
        await h.session.prompt("Use the branch notes as reference.");
        assert.equal(contentText(h.results().at(-1)!.content).trim(), "branch-disabled");
        h.config.enforceCompactionMandatoryReading = false;
        h.config.enforceBranchMandatoryReading = true;
        h.work.push(call("bash", { command: "echo premature" }), call("read", { path: abandoned }),
            call("bash", { command: "echo released" }), say("Done."));
        await h.session.prompt("Continue on the destination branch.");
        const commands = h.results().filter((result) => result.toolName === "bash").slice(-2);
        assert.equal(commands[0].isError, true);
        assert.ok(contentText(commands[0].content).includes("abandoned.md"));
        assert.ok(!contentText(commands[0].content).includes("common.md"));
        assert.equal(contentText(commands[1].content).trim(), "released");
        passed = true;
    } finally {
        h.session.dispose();
        if (passed) execFileSync("trash", [dir]);
        else console.error(`Branch reading E2E artifact: ${dir}`);
    }
});

it("does not reactivate an older compaction's reading list after a branch summary with enforcement disabled", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "grounded-reading-branch-off-"));
    const file = path.join(dir, "required.md");
    await writeFile(file, "Original reference contents.\n");
    let h = await harness(dir);
    let passed = false;
    try {
        h.config.verbatimUserMessageTokens = null;
        h.work.push(say("Work remains. ".repeat(300)));
        await h.session.prompt("Prepare a checkpoint. ".repeat(300));
        h.summaries.push(`Compaction summary.\n${readingBlock([file])}`);
        await h.session.compact();
        h.work.push(call("read", { path: file }), say("Shared work."));
        await h.session.prompt("Continue after compaction.");
        h.work.push(say("Ready to explore another approach."));
        await h.session.prompt("Additional shared work. ".repeat(1000));
        const target = h.manager.getLeafId();
        assert.ok(target);
        h.work.push(say("Work on another approach."));
        await h.session.prompt("Explore another approach.");
        await writeFile(file, "Reference changed while exploring the other branch.\n");
        const remindersBefore = h.manager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === "grounded-required-reading").length;
        h.summaries.push("Branch notes for reference.");
        const result = await h.session.navigateTree(target, { summarize: true });
        assert.equal(result.cancelled, false);
        assert.ok(!h.summaryPrompts.at(-1)!.includes("<grounded-required-reading>"));
        assert.equal(h.manager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === "grounded-required-reading").length, remindersBefore,
            "branch navigation must not issue a reminder for the older compaction");
        const saved = h.manager.getSessionFile();
        assert.ok(saved);
        h.session.dispose();
        h = await harness(dir, SessionManager.open(saved));
        h.work.push(call("bash", { command: "echo unrestricted" }), say("Done."));
        await h.session.prompt("Consider the branch notes.");
        assert.equal(contentText(h.results().at(-1)!.content).trim(), "unrestricted");

        h.config.verbatimUserMessageTokens = null;
        h.work.push(say("More work remains."));
        await h.session.prompt("Prepare another checkpoint.");
        h.summaries.push(`New compaction.\n${readingBlock([file])}`, `Split-turn progress.\n${readingBlock([file])}`);
        await h.session.compact();
        h.work.push(call("bash", { command: "echo premature" }), call("read", { path: file }),
            call("bash", { command: "echo released" }), say("Done."));
        await h.session.prompt("Continue after the new compaction.");
        const commands = h.results().filter((result) => result.toolName === "bash").slice(-2);
        assert.equal(commands[0].isError, true);
        assert.equal(contentText(commands[1].content).trim(), "released");
        passed = true;
    } finally {
        h.session.dispose();
        if (passed) execFileSync("trash", [dir]);
        else console.error(`Branch enforcement E2E artifact: ${dir}`);
    }
});

it("requires nested shell reads to emit file contents rather than merely recording a successful call", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "grounded-reading-nested-"));
    const file = path.join(dir, "required.md");
    const target = path.join(dir, "result.txt");
    await writeFile(file, "Complete nested result visible to the model.\n");
    const h = await harness(dir);
    let passed = false;
    try {
        h.config.verbatimUserMessageTokens = null;
        h.session.setActiveToolsByName(["bash", "write", "exec"]);
        h.work.push(say("Work remains. ".repeat(300)));
        await h.session.prompt("Prepare a checkpoint. ".repeat(300));
        h.summaries.push(`Summary.\n${readingBlock([file])}`);
        await h.session.compact();
        h.work.push(call("exec", { command: `cat '${file}'`, emit: false }), call("write", { path: target, content: "premature" }),
            call("exec", { command: `cat '${file}'`, emit: true }), call("write", { path: target, content: "released" }), say("Done."));
        await h.session.prompt("Continue.");
        const writes = h.results().filter((result) => result.toolName === "write");
        assert.equal(writes.length, 2);
        assert.equal(writes[0].isError, true);
        assert.equal(writes[1].isError, false);
        passed = true;
    } finally {
        h.session.dispose();
        if (passed) execFileSync("trash", [dir]);
        else console.error(`Nested reading E2E artifact: ${dir}`);
    }
});
