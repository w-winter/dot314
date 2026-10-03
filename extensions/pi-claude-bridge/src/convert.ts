// Pure pi→Anthropic message conversion helpers.
// Extracted so they can be tested without pulling in the full extension runtime.

import type { AssistantMessage, Message as PiMessage } from "@earendil-works/pi-ai";
import type { ContentBlock, Message as SessionMessage } from "cc-session-io";
import { pascalCase } from "change-case";
import { isChildExecutedTool } from "./connectors.ts";

export const PROVIDER_ID = "pi-claude";

export const PI_TO_SDK_TOOL_NAME: Record<string, string> = {
	read: "Read", write: "Write", edit: "Edit", bash: "Bash",
};

export function sanitizeToolId(id: string, cache: Map<string, string>): string {
	const existing = cache.get(id);
	if (existing) return existing;
	const clean = id.replace(/[^a-zA-Z0-9_-]/g, "_");
	cache.set(id, clean);
	return clean;
}

export function mapPiToolNameToSdk(name: string, customToolNameToSdk?: Map<string, string>): string {
	if (!name) return "";
	// A claude.ai connector name is ALREADY the child's own tool id — the child
	// owns that namespace natively. PascalCasing it invented an alias
	// (`mcp__claude_ai_Slack__slack_search_channels` →
	// `McpClaudeAiSlackSlackSearchChannels`) that appeared in the child's
	// projected history, so the model imitated it on the next turn and got a
	// real `Tool ... not found` from the MCP dispatcher before retrying the
	// canonical name — one wasted round-trip per affected call.
	//
	// Connector names stopped reaching this function at all once they stopped
	// being mirrored as Pi tool calls (isChildExecutedTool), so this is the
	// belt to that braces: LEGACY Pi history recorded before that fix still
	// carries them, and a rebuild would still project the alias.
	if (isChildExecutedTool(name)) return name;
	const normalized = name.toLowerCase();
	if (customToolNameToSdk) {
		const mapped = customToolNameToSdk.get(name) ?? customToolNameToSdk.get(normalized);
		if (mapped) return mapped;
	}
	if (PI_TO_SDK_TOOL_NAME[normalized]) return PI_TO_SDK_TOOL_NAME[normalized];
	return pascalCase(name);
}

export function messageContentToText(
	content: string | Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts = [];
	let hasText = false;
	for (const block of content) {
		if (block.type === "text" && block.text) { parts.push(block.text); hasText = true; }
		else if (block.type !== "text" && block.type !== "image") { parts.push(`[${block.type}]`); }
	}
	return hasText ? parts.join("\n") : "";
}

function imageBlockToAnthropic(block: { data?: string; mimeType?: string }): ContentBlock | undefined {
	if (!block.data || !block.mimeType) return undefined;
	return { type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } } as ContentBlock;
}

export function toolResultContentToAnthropic(
	content: string | Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
): string | ContentBlock[] {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const blocks: ContentBlock[] = [];
	for (const block of content) {
		if (block.type === "text" && block.text) {
			blocks.push({ type: "text", text: block.text });
		} else if (block.type === "image") {
			const image = imageBlockToAnthropic(block);
			if (image) blocks.push(image);
		} else if (block.type) {
			blocks.push({ type: "text", text: `[${block.type}]` });
		}
	}
	if (blocks.length === 0) return "";
	if (blocks.every((block) => block.type === "text")) return blocks.map((block) => (block as { text: string }).text).join("\n");
	return blocks;
}

function assistantProvenancePrefix(msg: PiMessage): string | undefined {
	if (msg.role !== "assistant") return undefined;
	const provider = typeof (msg as any).provider === "string" ? (msg as any).provider : undefined;
	const model = typeof (msg as any).model === "string" ? (msg as any).model : undefined;
	const api = typeof (msg as any).api === "string" ? (msg as any).api : undefined;
	if (!provider && !model && !api) return undefined;
	if (provider === PROVIDER_ID || api === "anthropic") return undefined;
	return `[Prior Pi assistant response from ${provider ?? api ?? "unknown-provider"}${model ? `/${model}` : ""}]\n`;
}

export function userMessageToAnthropic(msg: PiMessage): SessionMessage {
	if (typeof msg.content === "string") return { role: "user", content: msg.content || "[empty]" };
	if (Array.isArray(msg.content)) {
		const parts = [];
		for (const block of msg.content) {
			if (block.type === "text" && block.text) parts.push({ type: "text", text: block.text });
			else if (block.type === "image" && block.data && block.mimeType) parts.push(imageBlockToAnthropic(block));
		}
		const kept = parts.filter(Boolean) as ContentBlock[];
		return { role: "user", content: kept.length ? kept : "[image]" };
	}
	return { role: "user", content: "[empty]" };
}

function toolResultToAnthropicBlock(msg: PiMessage, sanitizedIds: Map<string, string>): ContentBlock {
	const content = toolResultContentToAnthropic(msg.content as string | Array<{ type: string; text?: string; data?: string; mimeType?: string }>);
	return {
		type: "tool_result",
		tool_use_id: sanitizeToolId((msg as { toolCallId: string }).toolCallId, sanitizedIds),
		content: content || "",
		is_error: (msg as { isError?: boolean }).isError,
	} as ContentBlock;
}

function hasToolUse(msg: PiMessage): boolean {
	return msg.role === "assistant" && Array.isArray(msg.content) && msg.content.some((block) => block.type === "toolCall");
}

function isClaudeAssistant(msg: PiMessage): msg is AssistantMessage {
	return msg.role === "assistant" && (msg.provider === PROVIDER_ID || msg.api === "anthropic");
}

function isSkippedAssistant(msg: PiMessage): boolean {
	return msg.role === "assistant" && (msg.stopReason === "error" || msg.stopReason === "aborted");
}

/** A Claude thinking block exactly as the API returned it, or undefined when
 *  it cannot be replayed (no signature, or a redacted block without its payload). */
function claudeThinkingToAnthropic(block: { thinking?: string; thinkingSignature?: string; redacted?: boolean }): ContentBlock | undefined {
	const sig = block.thinkingSignature;
	if (!sig) return undefined;
	if (block.redacted) return { type: "redacted_thinking", data: sig } as unknown as ContentBlock;
	return { type: "thinking", thinking: block.thinking ?? "", signature: sig };
}

// The API rejects a request whose latest assistant message carries thinking
// blocks that differ from its original response, so a REBUILD cannot import
// that message with a block removed. Older ones may lose blocks: the API
// strips their thinking.
function hasUnreplayableThinking(msg: PiMessage): boolean {
	if (!isClaudeAssistant(msg) || !Array.isArray(msg.content)) return false;
	return msg.content.some((block) => block.type === "thinking" && !claudeThinkingToAnthropic(block));
}

/** Indexes of the trailing Claude turns a rebuild cannot replay exactly: from
 *  the latest assistant back, each one with unreplayable thinking, so that the
 *  latest assistant left in the import replays as returned. Error and aborted
 *  turns are never imported and are passed over. */
export function unreplayableTrailingTurns(messages: PiMessage[]): Set<number> {
	const turns = new Set<number>();
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant" || isSkippedAssistant(msg)) continue;
		if (!hasUnreplayableThinking(msg)) break;
		turns.add(i);
	}
	return turns;
}

export const UNREPLAYED_TURN_NOTE_HEADER = "[Claude bridge: one of your earlier replies could not be replayed as-is, because part of its thinking was cut off. This note records what that reply said and did, in order.]";

/** A piece of a note: a line of text, or an image block. */
type NotePart = string | ContentBlock;

/** A tool result's content as a note carries it, in its own order: each text
 *  block, each image as the image block the normal import builds, and a text
 *  marker for an image that converter cannot carry (no data or mimeType) or
 *  for any other block. */
function toolResultNoteText(content: unknown): NotePart[] {
	if (typeof content === "string") return content ? [content] : [];
	if (!Array.isArray(content)) return [];
	const parts: NotePart[] = [];
	for (const block of content as Array<{ type?: string; text?: string; data?: string; mimeType?: string }>) {
		if (block.type === "text") {
			if (block.text) parts.push(block.text);
		} else if (block.type === "image") {
			parts.push(imageBlockToAnthropic(block) ?? `[${block.mimeType ?? "unknown"} image, not carried in this note]`);
		} else {
			parts.push(`[${block.type}]`);
		}
	}
	return parts;
}

/** A note's sections as content blocks: the lines of a section joined by one
 *  newline and sections by a blank line, with each image block between the
 *  text blocks around it. */
function noteContent(sections: NotePart[][]): ContentBlock[] {
	const blocks: ContentBlock[] = [];
	let text = "";
	sections.forEach((section, s) => section.forEach((part, p) => {
		if (typeof part === "string") {
			text += (text ? (p > 0 ? "\n" : s > 0 ? "\n\n" : "") : "") + part;
			return;
		}
		if (text) blocks.push({ type: "text", text });
		text = "";
		blocks.push(part);
	}));
	if (text) blocks.push({ type: "text", text });
	return blocks;
}

/** The user-side note a rebuild imports in place of a Claude turn it cannot
 *  replay exactly and that turn's tool results. The turn wrote all of its text
 *  and calls before any result came back, so the note lists its text and each
 *  numbered tool call's Pi name and arguments in content order, then each
 *  result by call number and error flag in the order `results` holds them
 *  (history order), then each call with no recorded result. A result's images
 *  are carried as image blocks in their place. Not its thinking. Nothing is
 *  cut, so it carries what the normal import would. */
function unreplayedTurnNote(msg: AssistantMessage, results: Map<string, PiMessage>): ContentBlock[] {
	const sections: NotePart[][] = [[UNREPLAYED_TURN_NOTE_HEADER]];
	const callNumbers = new Map<string, number>();
	for (const block of msg.content) {
		if (block.type === "text" && block.text) {
			sections.push(["You wrote:", block.text]);
		} else if (block.type === "toolCall") {
			const number = callNumbers.size + 1;
			callNumbers.set(block.id, number);
			sections.push([`Call ${number}: you called ${block.name} with arguments ${JSON.stringify(block.arguments ?? {})}.`]);
		}
	}
	if (callNumbers.size === 0) return noteContent(sections);
	sections.push(["The results came back afterwards, in this order."]);
	const answered = new Set<string>();
	for (const [id, result] of results) {
		const number = callNumbers.get(id);
		if (number === undefined || result.role !== "toolResult") continue;
		answered.add(id);
		const content = toolResultNoteText(result.content);
		sections.push([result.isError ? `Call ${number} returned an error:` : `Call ${number} returned:`, ...(content.length > 0 ? content : ["(no text)"])]);
	}
	for (const [id, number] of callNumbers) {
		if (!answered.has(id)) sections.push([`Call ${number}: no result was recorded.`]);
	}
	return noteContent(sections);
}

/** Convert pi message array to Anthropic API format. `noteUnreplayableTurns`
 *  is for writing a Claude session only; history digests must not pass it.
 *  `notedTurns` lists the tool calls of each turn it replaced with a note. */
export function convertPiMessages(
	messages: PiMessage[],
	customToolNameToSdk?: Map<string, string>,
	opts: { noteUnreplayableTurns?: boolean } = {},
): { anthropicMessages: SessionMessage[]; sanitizedIds: Map<string, string>; notedTurns: Array<{ calls: Array<{ id: string; name: string }> }> } {
	const anthropicMessages = [];
	const sanitizedIds = new Map();
	const skippedToolCallIds = new Set<string>();
	const isSkippedToolResult = (message: PiMessage): boolean =>
		message.role === "toolResult" && skippedToolCallIds.has(message.toolCallId);
	const unreplayable = opts.noteUnreplayableTurns ? unreplayableTrailingTurns(messages) : new Set<number>();
	const notedTurns: Array<{ calls: Array<{ id: string; name: string }> }> = [];
	// A steer can split one turn's results across later messages, so a note
	// finds its results by id anywhere after the turn. The map keeps history
	// order, which is the order the note lists them in.
	const resultsById = new Map<string, PiMessage>();
	if (unreplayable.size > 0) for (const message of messages) {
		if (message.role === "toolResult" && !resultsById.has(message.toolCallId)) resultsById.set(message.toolCallId, message);
	}

	const pushToolResultGroup = (toolMessages: PiMessage[]): void => {
		const included = toolMessages.filter((message) => !isSkippedToolResult(message));
		if (included.length === 0) return;
		anthropicMessages.push({
			role: "user",
			content: included.map((toolMsg) => toolResultToAnthropicBlock(toolMsg, sanitizedIds)),
		});
	};

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg.role === "user") {
			// Rebuild imports each pi user message as its OWN record. The REUSE path
			// (extractUserPrompt/extractUserPromptBlocks in user-prompt.ts) instead merges a
			// trailing user run into one "\n\n"-joined prompt — accepted divergence,
			// see the comment there; the merged form is never re-imported here.
			anthropicMessages.push(userMessageToAnthropic(msg));
		} else if (msg.role === "assistant") {
			const content = Array.isArray(msg.content) ? msg.content : [];
			// Match pi-ai's provider transform: failed turns are incomplete stream
			// snapshots, not model-authored history. Pi's agent loop returns before
			// dispatching their tool calls, so any associated results are orphaned
			// history and must not be imported either.
			if (isSkippedAssistant(msg) || unreplayable.has(i)) {
				for (const block of content) {
					if (block.type === "toolCall") skippedToolCallIds.add(block.id);
				}
				if (unreplayable.has(i)) {
					// Its results are imported in the note, not as tool_result blocks.
					anthropicMessages.push({ role: "user", content: unreplayedTurnNote(msg as AssistantMessage, resultsById) });
					notedTurns.push({ calls: content.filter((block) => block.type === "toolCall").map((block) => ({ id: block.id, name: block.name })) });
				}
				continue;
			}
			const blocks = [];
			const provenance = assistantProvenancePrefix(msg);
			if (provenance) blocks.push({ type: "text", text: provenance });
			for (const block of content) {
				if (block.type === "text" && block.text) {
					blocks.push({ type: "text", text: block.text });
				} else if (block.type === "thinking") {
					const thinking = isClaudeAssistant(msg) ? claudeThinkingToAnthropic(block) : undefined;
					if (thinking) blocks.push(thinking);
				} else if (block.type === "toolCall") {
					const toolName = mapPiToolNameToSdk(block.name, customToolNameToSdk);
					blocks.push({ type: "tool_use", id: sanitizeToolId(block.id, sanitizedIds), name: toolName, input: block.arguments ?? {} });
				}
			}
			if (!blocks.length) blocks.push({ type: "text", text: "[incompatible content omitted]" });
			anthropicMessages.push({ role: "assistant", content: blocks });

			// Pi may inject steer/followUp user messages between parallel tool
			// results, while runtime extraction treats every toolResult after the
			// assistant (until the next assistant) as one turn. Claude history must
			// put all tool_result blocks immediately after the tool_use assistant;
			// replay interleaved user text only after that grouped result message.
			if (hasToolUse(msg)) {
				const toolMessages: PiMessage[] = [];
				const interleavedUsers: PiMessage[] = [];
				let j = i + 1;
				for (; j < messages.length; j++) {
					const next = messages[j];
					if (next.role === "assistant") break;
					if (next.role === "toolResult") toolMessages.push(next);
					else if (next.role === "user") interleavedUsers.push(next);
					else break;
				}
				if (toolMessages.length > 0) {
					pushToolResultGroup(toolMessages);
					for (const userMsg of interleavedUsers) anthropicMessages.push(userMessageToAnthropic(userMsg));
					i = j - 1;
				}
			}
		} else if (msg.role === "toolResult") {
			const blocks: ContentBlock[] = [];
			for (; i < messages.length; i++) {
				const toolMsg = messages[i];
				if (toolMsg.role !== "toolResult") { i--; break; }
				if (isSkippedToolResult(toolMsg)) continue;
				blocks.push(toolResultToAnthropicBlock(toolMsg, sanitizedIds));
			}
			if (blocks.length > 0) anthropicMessages.push({ role: "user", content: blocks });
		}
	}

	return { anthropicMessages, sanitizedIds, notedTurns };
}
