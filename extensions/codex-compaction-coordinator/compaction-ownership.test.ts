import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
    createEventBus,
    type CompactionEntry,
    type ExtensionAPI,
    type ExtensionContext,
    type ExtensionEvent,
    type SessionBeforeCompactEvent,
    type SessionBeforeCompactResult,
    type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { registerGroundedCompactionHandlers } from "../grounded-compaction/registration.ts";
import { createAssistantResponse, createEvent, createModel } from "../grounded-compaction/test/fixtures.ts";
import { registerModelAwareCompaction } from "../model-aware-compaction/index.ts";
import coordinator from "./index.ts";

const conversionEntry = fileURLToPath(new URL(
    "../../npm/node_modules/@howaboua/pi-codex-conversion/dist/index.js", import.meta.url,
));
const requireConversion = createRequire(conversionEntry);
const { prepareExtensionCompaction }: {
    prepareExtensionCompaction: (
        pi: ExtensionAPI, event: SessionBeforeCompactEvent, ctx: ExtensionContext,
    ) => Promise<SessionBeforeCompactResult | undefined>;
} = requireConversion("@howaboua/pi-codex-conversion/dist/compaction.js");
const { ALL_CODEX_ADAPTER_TOOL_NAMES }: { ALL_CODEX_ADAPTER_TOOL_NAMES: string[] } = requireConversion(
    "@howaboua/pi-codex-conversion/dist/adapter/activation/runtime-plan.js",
);

type Method = "pi" | "v2" | "both";
type Hook = (event: ExtensionEvent, ctx: ExtensionContext) => object | void | Promise<object | void>;
type CompactionHook = (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => Promise<SessionBeforeCompactResult | void>;
type HarnessContext = Pick<ExtensionContext, "cwd" | "isProjectTrusted" | "model" | "hasUI" | "getContextUsage" | "getSystemPrompt"> & {
    ui: Pick<ExtensionContext["ui"], "notify">;
    sessionManager: Pick<ExtensionContext["sessionManager"], "getBranch" | "getEntries" | "getLeafId" | "getSessionId">;
};
let directory: string;
let previousAgentDir: string | undefined;

beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "compaction-ownership-"));
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = directory;
});

afterEach(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(directory, { recursive: true, force: true });
});

function saveConfig(method: Method, path = join(directory, "pi-codex-conversion.json"), extra = {}) {
    writeFileSync(path, JSON.stringify({ executionMode: "normal", compaction: { method }, ...extra }));
}

function checkpoint(summary = "[OpenAI native compaction checkpoint]"): CompactionEntry {
    return {
        type: "compaction", id: "checkpoint", parentId: null, timestamp: "2026-07-24T00:00:02.000Z",
        firstKeptEntryId: "kept", tokensBefore: 12_345, summary,
        details: {
            strategy: "openai-responses-compaction-v2",
            provider: "openai-codex", api: "openai-codex-responses", model: "gpt-test",
            baseUrl: "https://chatgpt.com/backend-api",
            compactedWindow: [{ type: "compaction_summary", encrypted_content: "sealed" }],
            createdAt: "2026-07-24T00:00:02.000Z",
        },
    };
}

async function harness(method: Method, order: "grounded-first" | "native-first", trusted = true) {
    const hooks = new Map<string, Hook[]>();
    const notices: string[] = [];
    const calls: string[] = [];
    const context: HarnessContext = {
        cwd: directory,
        isProjectTrusted: () => trusted,
        model: createModel({ id: "gpt-test", provider: "openai-codex", api: "openai-codex-responses" }),
        hasUI: true,
        ui: { notify: (message: string) => { notices.push(message); } },
        getContextUsage: () => ({ tokens: 160_000, contextWindow: 200_000, percent: 80 }),
        getSystemPrompt: () => "",
        sessionManager: {
            getBranch: () => [], getEntries: () => [], getLeafId: () => null, getSessionId: () => "test",
        },
    };
    // SAFETY: these handlers use the supplied model, trust, UI, usage, and session-reader methods only.
    const ctx = context as ExtensionContext;
    const api: Pick<ExtensionAPI, "events" | "on" | "registerCommand" | "registerEntryRenderer" | "getCommands" | "getAllTools"> = {
        events: createEventBus(),
        on(name, hook) {
            const registered = hooks.get(name) ?? [];
            // SAFETY: dispatch selects handlers by their registered event name before passing that event's payload.
            registered.push(hook as Hook);
            hooks.set(name, registered);
            return () => { hooks.set(name, registered.filter((entry) => entry !== hook)); };
        },
        registerCommand() {},
        registerEntryRenderer() {},
        getCommands: () => [{
            name: "codex", source: "extension",
            sourceInfo: { source: "npm:@howaboua/pi-codex-conversion", path: conversionEntry, scope: "user", origin: "package" },
        }],
        getAllTools: () => ALL_CODEX_ADAPTER_TOOL_NAMES.map((name) => ({
            name, description: name, parameters: Type.Object({}), exposure: "direct",
            sourceInfo: { source: "npm:@howaboua/pi-codex-conversion", path: conversionEntry, scope: "user", origin: "package" },
        })),
    };
    // SAFETY: this registration double implements the event, command, renderer, and tool-discovery APIs used here.
    const pi = api as ExtensionAPI;
    const registerGrounded = () => registerGroundedCompactionHandlers(pi, {
        runCompaction: () => {
            calls.push("grounded");
            return { compaction: { summary: "grounded", firstKeptEntryId: "kept", tokensBefore: 1 } };
        },
        runBranchSummary: () => undefined,
    });
    // Run pi-codex-conversion's preparation protocol before the native summarization stub.
    const native: CompactionHook = async (event, context) => {
        const prepared = await prepareExtensionCompaction(pi, event, context);
        if (prepared?.cancel || prepared?.compaction) return prepared;
        const latest = event.branchEntries.at(-1);
        if (method === "pi" && !(latest?.type === "compaction" && latest.summary === "[OpenAI native compaction checkpoint]")) return;
        calls.push("native");
        return { compaction: { summary: "native", firstKeptEntryId: "kept", tokensBefore: 1 } };
    };
    if (order === "native-first") pi.on("session_before_compact", native);
    registerGrounded();
    if (order === "grounded-first") pi.on("session_before_compact", native);
    coordinator(pi);
    for (const hook of hooks.get("session_start") ?? []) await hook({ type: "session_start", reason: "startup" }, ctx);

    return {
        pi, ctx, hooks, calls, notices,
        async compact(branchEntries: SessionEntry[] = [], signal = new AbortController().signal) {
            const event = createEvent({ branchEntries, signal });
            let result: SessionBeforeCompactResult | undefined;
            for (const hook of hooks.get("session_before_compact") ?? []) {
                // SAFETY: this list contains only handlers registered for the compaction event and result contract.
                const candidate = await (hook as CompactionHook)(event, ctx);
                if (candidate) result = candidate;
                if (candidate?.cancel) break;
            }
            return result;
        },
    };
}

describe("compaction method ownership", () => {
    for (const order of ["grounded-first", "native-first"] as const) {
        for (const method of ["pi", "v2", "both"] as const) {
            it(`${method} selects one summarizer with ${order}`, async () => {
                saveConfig(method);
                const h = await harness(method, order);
                const owner = method === "pi" ? "grounded" : "native";
                assert.equal((await h.compact())?.compaction?.summary, owner);
                assert.deepEqual(h.calls, [owner]);
            });
        }

        it(`converts an opaque checkpoint once, then uses grounded with ${order}`, async () => {
            saveConfig("pi");
            const h = await harness("pi", order);
            assert.equal((await h.compact([checkpoint()]))?.compaction?.summary, "native");
            const converted: CompactionEntry = { ...checkpoint("converted"), id: "converted", details: {} };
            assert.equal((await h.compact([checkpoint(), converted]))?.compaction?.summary, "grounded");
            assert.equal((await h.compact([checkpoint("readable Both summary")]))?.compaction?.summary, "grounded");
            assert.deepEqual(h.calls, ["native", "grounded", "grounded"]);
        });

        it(`requires reload before generating either summary with ${order}`, async () => {
            saveConfig("v2");
            const h = await harness("v2", order);
            saveConfig("pi");
            assert.deepEqual(await h.compact(), { cancel: true });
            assert.deepEqual(h.calls, []);
            assert.match(h.notices.join("\n"), /\/reload/);
            for (const hook of h.hooks.get("session_shutdown") ?? []) {
                await hook({ type: "session_shutdown", reason: "reload" }, h.ctx);
            }
            const reloaded = await harness("pi", order);
            assert.equal((await reloaded.compact())?.compaction?.summary, "grounded");
        });
    }

    it("honors trusted project settings and ignores untrusted project settings", async () => {
        saveConfig("v2");
        mkdirSync(join(directory, ".pi"));
        saveConfig("pi", join(directory, ".pi", "pi-codex-conversion.json"));
        const trusted = await harness("pi", "native-first", true);
        assert.equal((await trusted.compact())?.compaction?.summary, "grounded");
        const untrusted = await harness("v2", "native-first", false);
        assert.equal((await untrusted.compact())?.compaction?.summary, "native");
    });

    it("leaves grounded in control when native compaction is inactive", async () => {
        saveConfig("v2", undefined, { voiceFeaturesOnly: true });
        const h = await harness("pi", "native-first");
        assert.equal((await h.compact())?.compaction?.summary, "grounded");
    });

    it("cancels an aborted compaction before invoking either summarizer", async () => {
        saveConfig("pi");
        const h = await harness("pi", "native-first");
        assert.deepEqual(await h.compact([], AbortSignal.abort()), { cancel: true });
        assert.deepEqual(h.calls, []);
    });

    it("routes model-aware triggers to grounded in Pi-summary mode", async () => {
        saveConfig("pi");
        const h = await harness("pi", "native-first");
        const policyPath = join(directory, "thresholds.json");
        writeFileSync(policyPath, JSON.stringify({ global: 50, models: {} }));
        registerModelAwareCompaction(h.pi, { configPath: policyPath, isAutoCompactionEnabled: () => true });
        const assistant = createAssistantResponse("done");
        assistant.usage.totalTokens = 160_000;
        for (const hook of h.hooks.get("message_end") ?? []) await hook({ type: "message_end", message: assistant }, h.ctx);
        for (const hook of h.hooks.get("agent_end") ?? []) await hook({ type: "agent_end", messages: [assistant] }, h.ctx);
        assert.ok(assistant.usage.totalTokens > h.ctx.model!.contextWindow);
        assert.equal((await h.compact())?.compaction?.summary, "grounded");
    });
});
