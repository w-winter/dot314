import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export type ToolCallInvocation = {
	name: string;
	arguments: Record<string, unknown>;
};

type SessionTreeNodeLike = {
	entry: SessionEntry;
};

const MAX_PARENT_TRAVERSAL_DEPTH = 30;

export const getToolName = (entry: SessionEntry): string | null => {
	if (entry.type !== "message") return null;
	const message = entry.message as { role?: string; toolName?: unknown };
	if (message.role !== "toolResult") return null;
	return typeof message.toolName === "string" ? message.toolName : null;
};

export const resolveToolCallFromParents = (
	entry: SessionEntry,
	nodeById: ReadonlyMap<string, SessionTreeNodeLike>,
): ToolCallInvocation | null => {
	if (entry.type !== "message") return null;
	const resultMessage = entry.message as { role?: string; toolCallId?: unknown };
	if (resultMessage.role !== "toolResult" || typeof resultMessage.toolCallId !== "string") return null;

	let parentId = entry.parentId;
	for (let depth = 0; depth < MAX_PARENT_TRAVERSAL_DEPTH && parentId; depth += 1) {
		const parentEntry = nodeById.get(parentId)?.entry;
		if (!parentEntry) return null;
		if (parentEntry.type === "message") {
			const message = parentEntry.message as { role?: string; content?: unknown };
			if (message.role === "assistant" && Array.isArray(message.content)) {
				const block = message.content.find((candidate: unknown) => {
					if (typeof candidate !== "object" || candidate === null) return false;
					const value = candidate as Record<string, unknown>;
					return value.type === "toolCall" && value.id === resultMessage.toolCallId &&
						typeof value.name === "string" && typeof value.arguments === "object" &&
						value.arguments !== null && !Array.isArray(value.arguments);
				}) as { name: string; arguments: Record<string, unknown> } | undefined;
				if (block) return { name: block.name, arguments: block.arguments };
			}
		}
		parentId = parentEntry.parentId;
	}
	return null;
};

const formatResultContent = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		if (content.length === 0) return "[]";
		const textBlocks = content.filter(
			(block): block is { type: "text"; text: string } =>
				typeof block === "object" && block !== null &&
				(block as { type?: unknown }).type === "text" &&
				typeof (block as { text?: unknown }).text === "string",
		);
		if (textBlocks.length === content.length) return textBlocks.map((block) => block.text).join("");
	}
	return JSON.stringify(content ?? [], null, 2);
};

export const formatToolCallResultForClipboard = (
	entry: SessionEntry,
	nodeById: ReadonlyMap<string, SessionTreeNodeLike>,
): string | null => {
	const invocation = resolveToolCallFromParents(entry, nodeById);
	if (!invocation || entry.type !== "message") return null;
	const message = entry.message as { content?: unknown; isError?: boolean };
	const resultLabel = message.isError === true ? "toolResult (error)" : "toolResult";
	return `toolCall:\n\n${JSON.stringify(invocation, null, 2)}\n\n${resultLabel}:\n\n${formatResultContent(message.content)}`;
};
