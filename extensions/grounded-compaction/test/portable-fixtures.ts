import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { PortableSummaryUsage } from "../portable-summarizer.ts";

export const EXPECTED_USAGE: PortableSummaryUsage = {
    input: 101,
    output: 23,
    cacheRead: 7,
    cacheWrite: 5,
    totalTokens: 136,
    cost: {
        input: 0.1,
        output: 0.2,
        cacheRead: 0.03,
        cacheWrite: 0.04,
        total: 0.37,
    },
};

export function createModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
    return {
        id: "gpt-portable",
        name: "GPT Portable",
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com",
        reasoning: true,
        input: ["text"],
        cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
        },
        contextWindow: 20_000,
        maxTokens: 4_000,
        ...overrides,
    };
}

export function createAssistantResponse(
    text = "portable summary",
    overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-portable",
        usage: structuredClone(EXPECTED_USAGE),
        stopReason: "stop",
        timestamp: Date.now(),
        ...overrides,
    };
}
