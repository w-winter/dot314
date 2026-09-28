import { type Context } from "@earendil-works/pi-ai";
import { createHash } from "crypto";
import { convertPiMessages } from "./convert.js";

// Digest of the history Claude Code already holds, so warm reuse of its
// session can check that Pi's copy still matches. A message count cannot show
// a same-length rewrite (a Pi context edit, an extension's context transform),
// and Claude Code resumes ITS OWN transcript, so the stale copy would stay in
// force for the rest of the session.
//
// Covered: the projection the bridge imports into Claude (convertPiMessages),
// meaning message order and roles, user text and images, assistant text, and
// each tool call's id, name and arguments, plus which tool results follow it.
// Deliberately NOT covered:
//   - tool-result bodies and error flags: context pruners (pi-prune,
//     pi-jev-pruner) replace old results in every provider call. Claude keeps
//     the originals it received, which is harmless, while a rebuild for each
//     pruned body would cost a cold prompt cache on every turn;
//   - thinking blocks: display extensions relabel or strip them per call and
//     they carry no instruction Claude could act on;
//   - system messages, timestamps, usage and other metadata, which the import
//     drops anyway;
//   - the served-tool alias map: a tool call is identified by its Pi name, so
//     a changed tool surface does not invalidate old calls.
//
// The version prefix lets a future projection change adopt old digests once
// (see historyDigestMatches) instead of rebuilding every session at upgrade.
const HISTORY_DIGEST_VERSION = "h1";

type ProjectedBlock = { type: string; [key: string]: unknown };

function coveredBlock(block: ProjectedBlock): unknown {
	switch (block.type) {
		case "text": return ["text", block.text];
		case "image": return ["image", (block.source as { media_type?: string; data?: string } | undefined)?.media_type, (block.source as { data?: string } | undefined)?.data];
		case "tool_use": return ["tool_use", block.id, block.name, block.input ?? {}];
		case "tool_result": return ["tool_result", block.tool_use_id];
		case "thinking":
		case "redacted_thinking":
			return undefined;
		default: return [block.type];
	}
}

/** Versioned digest of `messages` as the bridge would import them into Claude
 *  Code (see the coverage note above). Pass exactly the slice Claude holds. */
export function historyDigest(messages: Context["messages"]): string {
	const { anthropicMessages } = convertPiMessages(messages);
	const hash = createHash("sha256");
	for (const message of anthropicMessages) {
		const content = typeof message.content === "string"
			? [["text", message.content]]
			: (message.content as unknown as ProjectedBlock[]).map(coveredBlock).filter((block) => block !== undefined);
		hash.update(JSON.stringify([message.role, content]));
		hash.update("\n");
	}
	return `${HISTORY_DIGEST_VERSION}:${hash.digest("hex")}`;
}

/** Whether the history Claude holds (`recorded`, stamped when the cursor last
 *  moved) is still Pi's `prior` slice. A record without a digest of this
 *  version (older bridge, older marker) cannot be checked: it is accepted and
 *  the caller stamps a fresh one, so such a record is never stuck. */
export function historyDigestMatches(recorded: string | undefined, prior: Context["messages"]): { matches: boolean; checked: boolean } {
	if (!isCurrentDigest(recorded)) return { matches: true, checked: false };
	return { matches: recorded === historyDigest(prior), checked: true };
}

function isCurrentDigest(value: string | undefined): value is string {
	return typeof value === "string" && value.startsWith(`${HISTORY_DIGEST_VERSION}:`);
}

/** REUSE check for a shared record: Pi's messages before the record's cursor
 *  must match its digest, and when the prompt starts one past the cursor (Pi
 *  appended the reply the record's query delivered), that reply must still be
 *  what the bridge delivered. Converting a message list and then one trailing
 *  assistant equals converting them together, so the two digests are checked
 *  separately. */
export function sharedHistoryMatches(
	record: { cursor: number; historyDigest?: string; trailingAssistantDigest?: string },
	messages: Context["messages"],
	promptStart: number,
): { matches: boolean; checked: boolean } {
	const prior = historyDigestMatches(record.historyDigest, messages.slice(0, record.cursor));
	if (!prior.matches) return prior;
	if (promptStart !== record.cursor + 1 || !isCurrentDigest(record.trailingAssistantDigest)) return prior;
	return { matches: record.trailingAssistantDigest === historyDigest(messages.slice(record.cursor, promptStart)), checked: prior.checked };
}
