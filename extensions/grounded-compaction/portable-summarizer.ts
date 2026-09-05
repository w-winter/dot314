import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

export const GROUNDED_PORTABLE_SUMMARIZER_EVENT = "grounded-compaction:portable-summarizer-query";

export type PortableSummarizerProvenance = {
    provider: string;
    api: string;
    modelId: string;
    thinkingLevel: ThinkingLevel | null;
    contextWindow: number;
    maxOutputTokens: number;
    promptFingerprint: string;
};

export type PortableSummaryUsage = {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        total: number;
    };
};

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type GroundedPortableSummarizerSession = {
    descriptor: PortableSummarizerProvenance;
    /** Tool-result character cap for this session's source serialization; null retains full text. */
    toolResultChars: number | null;
    summarizeNext(request: {
        previousSummary: string | null;
        sourceText: string;
        startOffset: number;
        coverageEntries: readonly SessionEntry[];
        signal: AbortSignal;
    }): Promise<{
        summary: string;
        endOffset: number;
        usage: PortableSummaryUsage | null;
    }>;
};

export type GroundedPortableSummarizerResponse =
    | { status: "unavailable" }
    | {
        status: "available";
        openSession: (signal: AbortSignal) => Promise<GroundedPortableSummarizerSession>;
    }
    | { status: "error"; error: string };

export type GroundedPortableSummarizerQuery = {
    kind: "open-portable-summarizer";
    context: {
        model: Model<Api>;
        modelRegistry: ExtensionContext["modelRegistry"];
        cwd: string;
    };
    branchEntries: readonly SessionEntry[];
    response: GroundedPortableSummarizerResponse;
};

export type GroundedPortableSummarizerOpenRequest = Pick<
    GroundedPortableSummarizerQuery,
    "context" | "branchEntries"
>;

export type GroundedPortableSummarizerOpener = (
    request: GroundedPortableSummarizerOpenRequest,
    signal: AbortSignal,
) => Promise<GroundedPortableSummarizerSession>;

type MutablePortableSummarizerQuery = {
    kind: "open-portable-summarizer";
    context: GroundedPortableSummarizerQuery["context"];
    branchEntries: readonly SessionEntry[];
    response: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    const actualKeys = Object.keys(value);
    return actualKeys.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isMutablePortableSummarizerQuery(value: unknown): value is MutablePortableSummarizerQuery {
    if (!isRecord(value) || !hasExactKeys(value, ["kind", "context", "branchEntries", "response"])) {
        return false;
    }
    if (value.kind !== "open-portable-summarizer" || !Array.isArray(value.branchEntries) || !isRecord(value.context)) {
        return false;
    }
    if (!hasExactKeys(value.context, ["model", "modelRegistry", "cwd"])) {
        return false;
    }

    const { model, modelRegistry, cwd } = value.context;
    return typeof cwd === "string"
        && isRecord(model)
        && typeof model.provider === "string"
        && typeof model.api === "string"
        && typeof model.id === "string"
        && isRecord(modelRegistry)
        && typeof modelRegistry.getAll === "function"
        && typeof modelRegistry.getProvider === "function"
        && typeof modelRegistry.getApiKeyAndHeaders === "function";
}

export function normalizeGroundedPortableSummarizerResponse(
    value: unknown,
): GroundedPortableSummarizerResponse {
    if (!isRecord(value)) {
        return { status: "error", error: "Invalid grounded portable summarizer response" };
    }
    if (value.status === "unavailable" && hasExactKeys(value, ["status"])) {
        return { status: "unavailable" };
    }
    if (
        value.status === "available"
        && typeof value.openSession === "function"
        && hasExactKeys(value, ["status", "openSession"])
    ) {
        return {
            status: "available",
            openSession: value.openSession as (signal: AbortSignal) => Promise<GroundedPortableSummarizerSession>,
        };
    }
    if (
        value.status === "error"
        && typeof value.error === "string"
        && value.error.length > 0
        && hasExactKeys(value, ["status", "error"])
    ) {
        return { status: "error", error: value.error };
    }
    return { status: "error", error: "Invalid grounded portable summarizer response" };
}

export function mergeGroundedPortableSummarizerResponse(
    current: unknown,
    next: GroundedPortableSummarizerResponse,
): GroundedPortableSummarizerResponse {
    const normalizedCurrent = normalizeGroundedPortableSummarizerResponse(current);
    const normalizedNext = normalizeGroundedPortableSummarizerResponse(next);

    if (normalizedCurrent.status === "error") return normalizedCurrent;
    if (normalizedNext.status === "error") return normalizedNext;
    if (normalizedCurrent.status === "unavailable") return normalizedNext;
    if (normalizedNext.status === "unavailable") return normalizedCurrent;
    return { status: "error", error: "Multiple grounded portable summarizer responders" };
}

export function registerGroundedPortableSummarizer(
    pi: ExtensionAPI,
    openSession: GroundedPortableSummarizerOpener,
): void {
    let unsubscribe: (() => void) | undefined;

    unsubscribe = pi.events.on(GROUNDED_PORTABLE_SUMMARIZER_EVENT, (payload: unknown) => {
        if (!isMutablePortableSummarizerQuery(payload)) {
            return;
        }

        try {
            const request: GroundedPortableSummarizerOpenRequest = {
                context: payload.context,
                branchEntries: [...payload.branchEntries],
            };
            payload.response = mergeGroundedPortableSummarizerResponse(payload.response, {
                status: "available",
                openSession: (signal) => openSession(request, signal),
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            payload.response = mergeGroundedPortableSummarizerResponse(payload.response, {
                status: "error",
                error: `Grounded portable summarizer registration failed: ${message}`,
            });
        }
    });

    pi.on("session_shutdown", () => {
        unsubscribe?.();
        unsubscribe = undefined;
    });
}
