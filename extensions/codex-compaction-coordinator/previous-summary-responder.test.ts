import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Api, Context, Model } from "@earendil-works/pi-ai";
import {
    createEventBus,
    type CompactionEntry,
    type ContextEvent,
    type ContextEventResult,
    type ExtensionAPI,
    type SessionBeforeCompactEvent,
    type SessionBeforeCompactResult,
    type SessionEntry,
    type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";

import { registerGroundedCompaction, runGroundedCompaction } from "../grounded-compaction/index.ts";
import type { PortableSummarizerProvenance } from "../grounded-compaction/portable-summarizer.ts";
import { createAssistantResponse, createDeps, createModel, createTestConfig, messageEntry } from "../grounded-compaction/test/fixtures.ts";
import codexCompactionCoordinator from "./index.ts";
import { PORTABLE_SUMMARY_CUSTOM_TYPE } from "./portable-record.ts";
import { GROUNDED_PREVIOUS_SUMMARY_EVENT } from "./previous-summary-responder.ts";

const NATIVE_PLACEHOLDER = "[OpenAI native compaction checkpoint]";
const PORTABLE_SUMMARY = "PORTABLE SUMMARY: the user asked to remember alpha";
const PROVENANCE: PortableSummarizerProvenance = {
    provider: "anthropic",
    api: "anthropic-messages",
    modelId: "claude-sonnet-4",
    thinkingLevel: "high",
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    promptFingerprint: "b".repeat(64),
};

/** The fields of Pi's extension context that the coordinator's and grounded-compaction's hooks read here. */
function createHarnessContext(model: Model<Api>, branch: () => SessionEntry[], notices: string[]) {
    const controller = new AbortController();
    return {
        cwd: "/repo",
        model,
        signal: controller.signal,
        abort: () => controller.abort(),
        hasUI: true,
        ui: { notify: (message: string) => { notices.push(message); } },
        modelRegistry: {
            getAll: () => [model],
            getProvider: (provider: string) => (provider === model.provider ? { id: provider, name: provider } : undefined),
            getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }),
        },
        sessionManager: {
            getSessionId: () => "session-1",
            getSessionDir: () => "/sessions",
            getBranch: branch,
            getEntries: branch,
            getLeafId: () => branch()[branch().length - 1].id,
        },
    };
}

type HarnessContext = ReturnType<typeof createHarnessContext>;
type HarnessHook<Event, Result> = (event: Event, ctx: HarnessContext) => Promise<Result | void> | Result | void;
/** Any Pi hook, as the registration double receives it. */
type RegisteredHook = (event: never, ctx: never) => object | void;

/** The query payload as a test observes it; the responder replaces `response`. */
type QueryPayload = {
    kind: "readable-previous-summary";
    compactionEntryId: string;
    branchEntries: readonly SessionEntry[];
    sessionEntries: readonly SessionEntry[];
    response: object;
};

function linked(entries: SessionEntry[]): SessionEntry[] {
    return entries.map((entry, index) => ({ ...entry, parentId: index ? entries[index - 1].id : null }));
}

function nativeCheckpoint(id: string, firstKeptEntryId: string): CompactionEntry {
    return {
        type: "compaction",
        id,
        parentId: null,
        timestamp: "2026-07-24T00:00:02.000Z",
        summary: NATIVE_PLACEHOLDER,
        firstKeptEntryId,
        tokensBefore: 12_345,
        details: {
            strategy: "openai-responses-compaction-v2",
            provider: "openai-codex",
            api: "openai-codex-responses",
            model: "gpt-test",
            baseUrl: "https://chatgpt.com/backend-api",
            compactedWindow: [{ type: "compaction_summary", encrypted_content: "sealed" }],
            createdAt: "2026-07-24T00:00:02.000Z",
        },
    };
}

/** A switch away from Codex: history, a native checkpoint keeping `a1`, then work on another provider. */
function switchedBranch() {
    const u1 = messageEntry("u1", "user", "remember alpha");
    const a1 = messageEntry("a1", "assistant", "noted alpha");
    const u2 = messageEntry("u2", "user", "now fix the parser");
    const a2 = messageEntry("a2", "assistant", "parser fixed");
    const u3 = messageEntry("u3", "user", "run the tests");
    const a3 = messageEntry("a3", "assistant", "tests pass");
    const summarized: SessionMessageEntry[] = [a1, u2, a2];
    return {
        entries: linked([u1, a1, nativeCheckpoint("cp", a1.id), u2, a2, u3, a3]),
        summarized,
        firstKeptEntryId: u3.id,
    };
}

function createHarness(options: { retentionTokens: number | null }) {
    const bus = createEventBus();
    const contextHooks: HarnessHook<ContextEvent, ContextEventResult>[] = [];
    const compactionHooks: HarnessHook<SessionBeforeCompactEvent, SessionBeforeCompactResult>[] = [];
    const { entries, summarized, firstKeptEntryId } = switchedBranch();
    let branch = entries;
    const requests: Context[] = [];
    const notices: string[] = [];
    const api: Partial<ExtensionAPI> = {
        events: bus,
        on: (eventName: string, hook: RegisteredHook) => {
            if (eventName === "context") {
                // SAFETY: Pi passes the context event's own handler, which reads only harness context fields.
                contextHooks.push(hook as HarnessHook<ContextEvent, ContextEventResult>);
            }
            if (eventName === "session_before_compact") {
                // SAFETY: Pi passes the compaction event's own handler, which reads only harness context fields.
                compactionHooks.push(hook as HarnessHook<SessionBeforeCompactEvent, SessionBeforeCompactResult>);
            }
            return () => undefined;
        },
        registerCommand: () => undefined,
        registerEntryRenderer: () => undefined,
        appendEntry: (customType, data) => {
            const entry: SessionEntry = {
                type: "custom",
                id: `record-${branch.length}`,
                parentId: branch[branch.length - 1].id,
                timestamp: "2026-07-24T00:00:03.000Z",
                customType,
                data,
            };
            branch = [...branch, entry];
        },
    };
    // SAFETY: the coordinator and grounded-compaction use only the event bus, hook, renderer, command and append APIs.
    const pi = api as ExtensionAPI;

    codexCompactionCoordinator(pi);
    registerGroundedCompaction(pi, {
        openPortableSession: async () => ({
            descriptor: PROVENANCE,
            toolResultChars: null,
            summarizeNext: async (request) => ({ summary: PORTABLE_SUMMARY, endOffset: request.sourceText.length, usage: null }),
        }),
        runCompaction: (event, ctx, queryPreviousSummary) => runGroundedCompaction(event, ctx, createDeps({
            loadConfig: async () => createTestConfig({ verbatimUserMessageTokens: options.retentionTokens }),
            complete: async (_model, context) => {
                requests.push(structuredClone(context));
                const body = "## Brief\nThe parser is fixed and tests pass.";
                return createAssistantResponse(options.retentionTokens === null
                    ? body
                    : `## Grounded retention decisions\n\n\`\`\`json\n{"decisions":[]}\n\`\`\`\n\n${body}`);
            },
            queryPreviousSummary,
        })),
    });
    const context = createHarnessContext(createModel(), () => branch, notices);

    return {
        bus,
        requests,
        notices,
        get branch() { return branch; },
        /** Runs the request-time context hooks, which build the portable summary for the checkpoint. */
        async sendRequest() {
            for (const hook of contextHooks) await hook({ type: "context", messages: [] }, context);
        },
        async compact() {
            const event: SessionBeforeCompactEvent = {
                type: "session_before_compact",
                reason: "manual",
                willRetry: false,
                customInstructions: undefined,
                signal: new AbortController().signal,
                branchEntries: branch,
                preparation: {
                    firstKeptEntryId,
                    messagesToSummarize: summarized.map((entry) => entry.message),
                    turnPrefixMessages: [],
                    isSplitTurn: false,
                    tokensBefore: 1_000,
                    previousSummary: NATIVE_PLACEHOLDER,
                    fileOps: { read: new Set(), written: new Set(), edited: new Set() },
                    settings: { enabled: true, reserveTokens: 800, keepRecentTokens: 400 },
                },
            };
            const [handler] = compactionHooks;
            assert.ok(handler);
            return handler(event, context);
        },
    };
}

function requestText(context: Context): string {
    return JSON.stringify(context.messages);
}

function query(branch: readonly SessionEntry[], compactionEntryId: string): QueryPayload {
    return {
        kind: "readable-previous-summary",
        compactionEntryId,
        branchEntries: branch,
        sessionEntries: branch,
        response: { status: "unavailable" },
    };
}

describe("readable previous summary after a native Codex checkpoint", () => {
    it("uses an embedded readable checkpoint summary without requiring a separate portable record", () => {
        const harness = createHarness({ retentionTokens: null });
        const entry = { ...nativeCheckpoint("readable", "kept"), summary: "Readable summary from Both mode" };
        const payload = query([...harness.branch, entry], entry.id);
        harness.bus.emit(GROUNDED_PREVIOUS_SUMMARY_EVENT, payload);
        assert.deepEqual(payload.response, { status: "unavailable" });
    });

    for (const retentionTokens of [null, 4_000]) {
        it(`continues ordinary compaction from the complete portable summary (retention ${retentionTokens ?? "off"})`, async () => {
            const harness = createHarness({ retentionTokens });
            await harness.sendRequest();
            assert.ok(harness.branch.some((entry) => entry.type === "custom" && entry.customType === PORTABLE_SUMMARY_CUSTOM_TYPE));

            const result = await harness.compact();

            assert.ok(result?.compaction, `compaction was not produced: ${harness.notices.join("\n")}`);
            assert.equal(harness.requests.length, 1);
            assert.match(requestText(harness.requests[0]), new RegExp(PORTABLE_SUMMARY));
            assert.doesNotMatch(requestText(harness.requests[0]), /OpenAI native compaction checkpoint/);
        });
    }

    it("cancels ordinary compaction while the portable summary is incomplete", async () => {
        const harness = createHarness({ retentionTokens: null });

        const result = await harness.compact();

        assert.deepEqual(result, { cancel: true });
        assert.equal(harness.requests.length, 0);
        const diagnostic = harness.notices.find((notice) => notice.includes("\"previous-summary\""));
        assert.ok(diagnostic, harness.notices.join("\n"));
        assert.match(diagnostic, /not complete yet, so compaction was skipped/);
        assert.match(diagnostic, /\/codex-portability prewarm/);
    });

    it("leaves the stored summary in place when the previous compaction is not a native checkpoint", () => {
        const harness = createHarness({ retentionTokens: null });
        const plaintext: CompactionEntry = {
            type: "compaction",
            id: "plain",
            parentId: harness.branch[harness.branch.length - 1].id,
            timestamp: "2026-07-24T00:00:04.000Z",
            summary: "## Brief\nEarlier work.",
            firstKeptEntryId: "u3",
            tokensBefore: 500,
        };
        const payload = query([...harness.branch, plaintext], plaintext.id);

        harness.bus.emit(GROUNDED_PREVIOUS_SUMMARY_EVENT, payload);

        assert.deepEqual(payload.response, { status: "unavailable" });
    });

    it("reports a malformed portable record instead of a summary", () => {
        const harness = createHarness({ retentionTokens: null });
        const malformed: SessionEntry = {
            type: "custom",
            id: "bad-record",
            parentId: harness.branch[harness.branch.length - 1].id,
            timestamp: "2026-07-24T00:00:04.000Z",
            customType: PORTABLE_SUMMARY_CUSTOM_TYPE,
            data: { kind: "codex-compaction-coordinator:portable-summary-v2", version: 1 },
        };
        const payload = query([...harness.branch, malformed], "cp");
        const original = console.error;
        console.error = () => undefined;
        try {
            harness.bus.emit(GROUNDED_PREVIOUS_SUMMARY_EVENT, payload);
        } finally {
            console.error = original;
        }

        assert.match(JSON.stringify(payload.response), /^\{"status":"error","error":"Portable summary lookup failed: /);
    });
});
