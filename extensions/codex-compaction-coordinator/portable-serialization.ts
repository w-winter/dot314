import { contentText, type AssistantMessage, type Message } from "@earendil-works/pi-ai";

const PORTABLE_DEFAULT_TOOL_RESULT_CHARS = 2_000;

function serializeAssistant(message: AssistantMessage): string[] {
    const parts: string[] = [];
    const thinking: string[] = [];
    const calls: string[] = [];
    for (const block of message.content) {
        if (block.type === "thinking") {
            thinking.push(block.thinking);
        } else if (block.type === "toolCall") {
            const args = Object.entries(block.arguments)
                .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
                .join(", ");
            calls.push(`${block.name}(${args})`);
        }
    }
    if (thinking.length > 0) parts.push(`[Assistant thinking]: ${thinking.join("\n")}`);
    if (message.content.some((block) => block.type === "text")) {
        parts.push(`[Assistant]: ${contentText(message.content)}`);
    }
    if (calls.length > 0) parts.push(`[Assistant tool calls]: ${calls.join("; ")}`);
    return parts;
}

/** Persisted proof format: includes thinking; null keeps full tool results, otherwise each result is head-truncated. */
export function serializePortableConversation(
    messages: Message[],
    toolResultChars: number | null = PORTABLE_DEFAULT_TOOL_RESULT_CHARS,
): string {
    const parts = messages.flatMap((message) => {
        switch (message.role) {
            case "user": {
                const text = contentText(message.content, "");
                return text ? [`[User]: ${text}`] : [];
            }
            case "assistant":
                return serializeAssistant(message);
            case "toolResult": {
                const text = contentText(message.content, "");
                if (!text) return [];
                const result = toolResultChars === null || text.length <= toolResultChars
                    ? text
                    : `${text.slice(0, toolResultChars)}\n\n[... ${text.length - toolResultChars} more characters truncated]`;
                return [`[Tool result]: ${result}`];
            }
            case "system":
                return [];
        }
    });
    return parts.join("\n\n");
}
