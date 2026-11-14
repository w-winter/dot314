import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionBeforeCompactEvent, SessionBeforeTreeEvent, SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";

import type { GroundedCompactionConfig, runGroundedCompaction } from "../index.ts";

export type TestContext = {
    hasUI: boolean;
    ui: {
        notify(message: string, level?: string): void;
    };
    model?: Model<Api>;
    cwd?: string | null;
    sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionDir" | "getSessionId" | "getLeafId" | "getBranch" | "getEntries">;
    modelRegistry: {
        getAll(): Model<Api>[];
        streamSimple: ExtensionContext["modelRegistry"]["streamSimple"];
        getApiKeyAndHeaders(model: Model<Api>): Promise<
            | { ok: true; apiKey?: string; headers?: Record<string, string> }
            | { ok: false; error: string }
        >;
    };
};

export type GroundedRunDeps = NonNullable<Parameters<typeof runGroundedCompaction>[2]>;

export function createModel(overrides?: Partial<Model<Api>>): Model<Api> {
    return {
        id: "claude-sonnet-4",
        name: "Claude Sonnet 4",
        provider: "anthropic",
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        reasoning: true,
        input: ["text"],
        cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
        },
        contextWindow: 200_000,
        maxTokens: 8_000,
        ...overrides,
    };
}

export function createAssistantResponse(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-sonnet-4",
        usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
            },
        },
        stopReason,
        timestamp: Date.now(),
    };
}

export function messageEntry(id: string, role: "user" | "assistant" | "toolResult", text: string): SessionMessageEntry {
    const base = { id, parentId: null, timestamp: new Date().toISOString() };
    if (role === "toolResult") {
        return {
            ...base,
            type: "message",
            message: {
                role,
                toolCallId: `tool-${id}`,
                toolName: "read",
                content: [{ type: "text", text }],
                isError: false,
                timestamp: Date.now(),
            },
        };
    }
    if (role === "assistant") return { ...base, type: "message", message: createAssistantResponse(text) };
    return {
        ...base,
        type: "message",
        message: {
            role,
            content: [{ type: "text", text }],
            timestamp: Date.now(),
        },
    };
}

export function thinkingEntry(level: string): SessionEntry {
    return {
        id: `thinking-${level}`,
        type: "thinking_level_change",
        thinkingLevel: level,
        parentId: null,
        timestamp: new Date().toISOString(),
    };
}

interface TestContextFixture {
    ctx: TestContext;
    notifications: string[];
    notificationLevels: Array<{ message: string; level?: string }>;
    authLookups: string[];
}

export function createContext(
    models: Model<Api>[],
    currentModel = models[0],
    authFailures: ReadonlySet<string> = new Set(),
): TestContextFixture {
    const notifications: string[] = [];
    const notificationLevels: Array<{ message: string; level?: string }> = [];
    const authLookups: string[] = [];

    return {
        notifications,
        notificationLevels,
        authLookups,
        ctx: {
            hasUI: true,
            ui: {
                notify(message, level) {
                    notifications.push(message);
                    notificationLevels.push({ message, level });
                },
            },
            model: currentModel,
            cwd: "/repo",
            sessionManager: { getSessionDir: () => "", getSessionId: () => "test", getLeafId: () => null, getBranch: () => [], getEntries: () => [] },
            modelRegistry: {
                getAll() {
                    return models;
                },
                streamSimple() {
                    throw new Error("Unexpected live model call in test");
                },
                async getApiKeyAndHeaders(model) {
                    const reference = `${model.provider}/${model.id}`;
                    authLookups.push(reference);
                    if (authFailures.has(reference)) {
                        return { ok: false as const, error: `no credentials for ${reference}` };
                    }
                    return { ok: true as const, apiKey: "test-key" };
                },
            },
        },
    };
}

export function createEvent(overrides?: Partial<SessionBeforeCompactEvent>): SessionBeforeCompactEvent {
    const historyEntry = messageEntry("history-user", "user", "Fix the failing tests");
    const keptEntry = messageEntry("kept-assistant", "assistant", "Investigating");

    const event: SessionBeforeCompactEvent = {
        type: "session_before_compact",
        reason: "manual",
        willRetry: false,
        customInstructions: undefined,
        signal: new AbortController().signal,
        branchEntries: [historyEntry, keptEntry],
        preparation: {
            firstKeptEntryId: keptEntry.id,
            messagesToSummarize: [historyEntry.message],
            turnPrefixMessages: [],
            isSplitTurn: false,
            tokensBefore: 321,
            previousSummary: undefined,
            fileOps: {
                read: new Set(),
                written: new Set(),
                edited: new Set(),
            },
            settings: {
                enabled: true,
                reserveTokens: 800,
                keepRecentTokens: 400,
            },
        },
        ...overrides,
    };
    if (event.preparation.previousSummary !== undefined) {
        event.branchEntries = [{
            type: "compaction", id: "previous-compaction", parentId: null, timestamp: new Date(0).toISOString(),
            summary: event.preparation.previousSummary, firstKeptEntryId: event.branchEntries[0].id, tokensBefore: 100,
        }, ...event.branchEntries];
    }
    event.branchEntries = event.branchEntries.map((entry, index, entries) => ({
        ...entry, parentId: index ? entries[index - 1].id : null,
    }));
    return event;
}

export function createTreeEvent(overrides?: Partial<SessionBeforeTreeEvent>): SessionBeforeTreeEvent {
    const branchEntries = [
        messageEntry("tree-user", "user", "Check branch work"),
        messageEntry("tree-assistant", "assistant", "Investigating tree summary"),
    ];

    return {
        type: "session_before_tree",
        signal: new AbortController().signal,
        preparation: {
            targetId: "target-1",
            oldLeafId: "leaf-1",
            commonAncestorId: "ancestor-1",
            entriesToSummarize: branchEntries,
            userWantsSummary: true,
            customInstructions: undefined,
            replaceInstructions: false,
            label: undefined,
        },
        ...overrides,
    };
}

export function createTestConfig(overrides: Partial<GroundedCompactionConfig> = {}): GroundedCompactionConfig {
    return {
        enforceCompactionMandatoryReading: false,
        enforceBranchMandatoryReading: false,
        includeFilesTouched: {
            inCompactionSummary: "off",
            inBranchSummary: "off",
        },
        defaultPreset: "current",
        toolResultChars: null,
        verbatimUserMessageTokens: null,
        verbatimUserMessageFlagChars: 8000,
        presets: {},
        ...overrides,
    };
}

export function createDeps(overrides: Partial<GroundedRunDeps> = {}): GroundedRunDeps {
    return {
        complete: async () => createAssistantResponse("summary"),
        collectFilesTouched: () => [],
        loadConfig: async () => createTestConfig(),
        loadCompactionPrompt: async () => "Keep it concise",
        loadBranchSummaryPrompt: async () => undefined,
        // No extension holds readable text for a previous compaction, as when the coordinator is not loaded.
        queryPreviousSummary: () => ({ status: "unavailable" }),
        ...overrides,
    };
}
