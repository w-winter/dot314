// The prompt a fresh query sends Claude Code for Pi's trailing user
// messages. Claude Code records exactly this as the prompt's user record, so
// a rebuild that keeps Claude Code's own records (native-fork.ts) compares
// Pi's user messages through the same functions.

import type { Base64ImageSource, ContentBlockParam } from "@anthropic-ai/sdk/resources";
import type { Context } from "@earendil-works/pi-ai";
import { messageContentToText } from "./convert.ts";
import { debug } from "./debug.ts";

/** Combine one or more consecutive user messages into a single SDK prompt.
 *
 *  Representation divergence, accepted on purpose: this MERGES N pi user
 *  messages into ONE Claude user record ("\n\n"-joined), while a REBUILD
 *  (convertPiMessages in convert.ts) imports the same pi history as N separate
 *  user records. Streaming N SDKUserMessages instead would collapse N pi turns
 *  into one Pi reply with double-counted usage, so the join stays. The merged
 *  form is only ever a query's live prompt — it is never re-imported. A
 *  rebuild that forks Claude Code's own transcript (native-fork.ts) keeps
 *  the merged record when it equals this join of Pi's whole run of user
 *  messages, and imports Pi's messages after it as separate records. */
export function extractUserPrompt(messages: Context["messages"]): string | null {
	if (messages.length === 0 || messages.some((message) => message.role !== "user")) return null;
	return messages.map((message) =>
		typeof message.content === "string" ? message.content : messageContentToText(message.content) || "",
	).join("\n\n");
}

/** Combine consecutive user messages as ContentBlockParam[] while preserving images.
 *  Returns null if no images — caller should fall back to the string prompt.
 *  Same N-into-1 merge as extractUserPrompt (see its comment for why). */
export function extractUserPromptBlocks(messages: Context["messages"]): ContentBlockParam[] | null {
	if (messages.length === 0 || messages.some((message) => message.role !== "user")) return null;

	let hasImage = false;
	const blocks: ContentBlockParam[] = [];
	for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
		const content = messages[messageIndex].content;
		if (messageIndex > 0) blocks.push({ type: "text", text: "\n\n" });
		if (typeof content === "string") {
			if (content) blocks.push({ type: "text", text: content });
			continue;
		}
		if (!Array.isArray(content)) {
			debug(`extractUserPromptBlocks: content is ${typeof content}`);
			continue;
		}
		debug(`extractUserPromptBlocks: ${content.length} blocks, types=${content.map((b: any) => b.type).join(",")}`);
		for (const block of content) {
			if (block.type === "text" && block.text) {
				blocks.push({ type: "text", text: block.text });
			} else if (block.type === "image") {
				debug(`image block: mimeType=${(block as any).mimeType}, data length=${((block as any).data ?? "").length}, keys=${Object.keys(block).join(",")}`);
				if (!(block as any).data || !(block as any).mimeType) {
					debug(`image block missing data or mimeType, skipping`);
					continue;
				}
				hasImage = true;
				blocks.push({
					type: "image",
					source: { type: "base64", media_type: block.mimeType as Base64ImageSource["media_type"], data: block.data },
				});
			}
		}
	}
	return hasImage ? blocks : null;
}
