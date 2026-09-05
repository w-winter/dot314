import { contentText, type Message } from "@earendil-works/pi-ai";
import { serializeConversation } from "@earendil-works/pi-coding-agent";

function truncateToolResult(text: string, maxChars: number): string {
    if (text.length <= maxChars) {
        return text;
    }

    const truncatedChars = text.length - maxChars;
    return `${text.slice(0, maxChars)}\n\n[... ${truncatedChars} more characters truncated]`;
}

/** Serialize messages in order; null retains full tool-result text, otherwise cap each result. */
export function serializeConversationForCompaction(messages: Message[], toolResultChars: number | null): string {
    const parts: string[] = [];

    for (const message of messages) {
        if (message.role !== "toolResult") {
            const serializedMessage = serializeConversation([message]);
            if (serializedMessage) {
                parts.push(serializedMessage);
            }
            continue;
        }

        const content = contentText(message.content, "");
        if (content) {
            const serializedContent = toolResultChars === null
                ? content
                : truncateToolResult(content, toolResultChars);
            parts.push(`[Tool result]: ${serializedContent}`);
        }
    }

    return parts.join("\n\n");
}
