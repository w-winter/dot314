import { type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import { createHash } from "crypto";
import { convertPiMessages } from "./convert.ts";
import { stepEnd, stepStart } from "./request-timing.ts";

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
//   - the served-tool alias map: a tool call is identified by its exact Pi
//     name (never the PascalCase fallback, which merges `read_file` and
//     `readFile`), so a changed tool surface does not invalidate old calls.
//
// Root rule: a stored digest only ever describes history Claude actually
// holds, meaning content the bridge imported (REBUILD) or delivered itself
// (the prompt, and each reply Pi received from the bridge). A Pi view that
// fails that check is never stamped; the record gets UNVERIFIED_HISTORY_DIGEST,
// which matches nothing, plus a rebuild mark.
//
// The version prefix lets a future projection change adopt old digests once
// (see historyDigestMatches) instead of rebuilding every session at upgrade.
const HISTORY_DIGEST_VERSION = "h1";

/** Recorded instead of a digest when the history Claude holds is unknown or
 *  known to differ from Pi's. Matches no history, whatever the version. */
export const UNVERIFIED_HISTORY_DIGEST = "unverified";

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
	const started = stepStart();
	// Identity name map: every tool call keeps its exact Pi name.
	const exactToolNames = new Map<string, string>();
	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content) if (block.type === "toolCall" && typeof block.name === "string") exactToolNames.set(block.name, block.name);
	}
	const { anthropicMessages } = convertPiMessages(messages, exactToolNames);
	const hash = createHash("sha256");
	for (const message of anthropicMessages) {
		const content = typeof message.content === "string"
			? [["text", message.content]]
			: (message.content as unknown as ProjectedBlock[]).map(coveredBlock).filter((block) => block !== undefined);
		hash.update(JSON.stringify([message.role, content]));
		hash.update("\n");
	}
	const digest = `${HISTORY_DIGEST_VERSION}:${hash.digest("hex")}`;
	stepEnd("digest", started);
	return digest;
}

/** Whether the history Claude holds (`recorded`, stamped when the cursor last
 *  moved) is still Pi's `prior` slice. A record without a digest of this
 *  version (older bridge, older marker) cannot be checked: it is accepted and
 *  the caller stamps a fresh one, so such a record is never stuck. */
export function historyDigestMatches(recorded: string | undefined, prior: Context["messages"]): { matches: boolean; checked: boolean } {
	if (recorded === UNVERIFIED_HISTORY_DIGEST) return { matches: false, checked: true };
	if (!isCurrentDigest(recorded)) return { matches: true, checked: false };
	return { matches: recorded === historyDigest(prior), checked: true };
}

function isCurrentDigest(value: string | undefined): value is string {
	return typeof value === "string" && value.startsWith(`${HISTORY_DIGEST_VERSION}:`);
}

/** Digest of one assistant message the bridge delivered to Pi, as Pi's copy
 *  must project: a tool call still streaming when the turn ended never reaches
 *  Pi (terminalMessage prunes it). */
export function deliveredAssistantDigest(message: AssistantMessage): string {
	const content = (message.content as Array<{ type?: string }>).filter((block) => !(block?.type === "toolCall" && "partialJson" in block));
	return historyDigest([{ ...message, content } as AssistantMessage]);
}

/** What the bridge has put into Claude's history during one query, in
 *  delivery order, and how much of it a verified claim already covers. */
export interface DeliveryLedger {
	/** Every reply the bridge delivered to Pi (deliveredAssistantDigest), in order. */
	assistants: ReadonlyArray<{ digest: string; callIds: readonly string[] }>;
	/** How many of `assistants` lie inside the verified claim already. */
	claimedAssistants: number;
	/** Tool results already inside the verified claim. */
	claimedResultIds: ReadonlySet<string>;
}

/** Whether messages[from, to) is EXACTLY what the bridge put into Claude's
 *  history since the claim at `from`: every reply delivered since then (none
 *  missing, none extra, in delivery order), results only for calls those or
 *  earlier delivered replies made, each once and only if Claude received it,
 *  and user messages only at `acceptedUserIndexes` (accepted for delivery by
 *  this query: written to its running child, or queued for a continuation).
 *  System messages are invisible to the digest and pass. Returns the
 *  result ids the suffix covers, or undefined when it is not Claude's. */
export function deliveredSuffix(
	messages: Context["messages"],
	from: number,
	to: number,
	ledger: DeliveryLedger,
	opts: { resultReceived: (id: string) => boolean; acceptedUserIndexes: ReadonlySet<number> },
): Set<string> | undefined {
	const pending = ledger.assistants.slice(ledger.claimedAssistants);
	const callable = new Set(ledger.assistants.slice(0, ledger.claimedAssistants).flatMap((entry) => entry.callIds));
	const results = new Set<string>();
	let next = 0;
	for (let i = Math.max(0, from); i < to; i++) {
		const message = messages[i];
		if (!message) return undefined;
		if (message.role === "system") continue;
		if (message.role === "assistant") {
			if (next >= pending.length || historyDigest([message]) !== pending[next].digest) return undefined;
			for (const id of pending[next].callIds) callable.add(id);
			next++;
			continue;
		}
		if (message.role === "toolResult") {
			const id = message.toolCallId;
			if (!callable.has(id) || ledger.claimedResultIds.has(id) || results.has(id) || !opts.resultReceived(id)) return undefined;
			results.add(id);
			continue;
		}
		if (message.role === "user" && opts.acceptedUserIndexes.has(i)) continue;
		return undefined;
	}
	return next === pending.length ? results : undefined;
}

/** REUSE check for a shared record: Pi's messages before the record's cursor
 *  must match its digest, and when the prompt starts one past the cursor (Pi
 *  appended the reply the record's query delivered), that reply must be what
 *  the bridge delivered. Converting a message list and then one trailing
 *  assistant equals converting them together, so the two digests are checked
 *  separately. A digested record without a reply digest cannot vouch for that
 *  assistant, so it does not match. */
export function sharedHistoryMatches(
	record: { cursor: number; historyDigest?: string; trailingAssistantDigest?: string },
	messages: Context["messages"],
	promptStart: number,
): { matches: boolean; checked: boolean } {
	const prior = historyDigestMatches(record.historyDigest, messages.slice(0, record.cursor));
	if (!prior.matches || !prior.checked || promptStart !== record.cursor + 1) return prior;
	return { matches: record.trailingAssistantDigest === historyDigest(messages.slice(record.cursor, promptStart)), checked: true };
}
