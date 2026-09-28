// Which Pi user messages a running Claude query already owns, and which of the
// others are new instructions.
//
// A query owns the history it started with (its prompt carried it to Claude)
// and every user message it later queued for replay. Pi may hand the bridge a
// callback context that is NOT an append-only extension of the one the query
// started with: extensions transform the provider context on every call
// (pi-coding-agent installs the extension `context` event as transformContext),
// so messages can be dropped, inserted or rewritten. A position in the starting
// context is therefore no acknowledgement. Ownership is tracked by identity:
// Pi's user messages (and the custom, bashExecution and summary messages
// convertToLlm turns into role "user") all carry a timestamp and content.
//
// Identity alone cannot tell a new message from an old one rewritten with new
// content AND a new timestamp: neither key matches anything. Position relative
// to what the query already knew can. The ANCHOR is the last message of the
// callback context the query knew before this callback: an owned user message,
// or (through the caller's `isKnown`) an assistant message the bridge produced
// in this query or a tool result an earlier callback delivered. Pi appends new
// input at the end, so an unknown user message after the anchor is new. One
// before it is new too when every owned user message is still present (then
// nothing was rewritten; an extension only moved it). When an owned message is
// missing, a pre-anchor unknown message may be its rewrite or a moved new
// message, and a rebuild owns it: position alone never declares input
// delivered.
//
// Separate from index.ts so query-state.ts can hold one per QueryContext.

import { createHash } from "node:crypto";

interface UserLike {
	role: string;
	content?: unknown;
	timestamp?: unknown;
}

function normalizedContent(content: unknown): unknown {
	// A custom message with string content and its converted text-block form
	// are the same message.
	if (typeof content === "string") return [{ t: content }];
	if (!Array.isArray(content)) return { other: content ?? null };
	return content.map((block: any) => {
		if (block?.type === "text") return { t: block.text ?? "" };
		if (block?.type === "image") return { i: block.mimeType ?? "", d: block.data ?? "" };
		return block ?? null;
	});
}

function contentDigest(content: unknown): string {
	let serialized: string;
	try {
		serialized = JSON.stringify(normalizedContent(content)) ?? "";
	} catch {
		serialized = String(content);
	}
	return createHash("sha256").update(serialized).digest("hex").slice(0, 32);
}

function userTimestamp(message: UserLike): number | undefined {
	return typeof message.timestamp === "number" && Number.isFinite(message.timestamp) ? message.timestamp : undefined;
}

/** Stable identity of a user message: timestamp plus a content digest. A
 *  message without a usable timestamp gets a content-only key, which can only
 *  ever match an owned message that also had none. */
export function userMessageIdentity(message: UserLike): string {
	const timestamp = userTimestamp(message);
	return `${timestamp === undefined ? "-" : `t${timestamp}`}:${contentDigest(message.content)}`;
}

export interface UserMessageClassification {
	/** Indexes of new user messages, after the anchor: queue them, in order. */
	fresh: number[];
	/** Indexes of user messages whose identity cannot be settled. Replaying one
	 *  could resend content Claude already has; skipping one could lose input.
	 *  The caller hands them to a rebuild. A message is unresolved when it has
	 *  no timestamp; when it shares the timestamp OR the content of an owned
	 *  message that is missing from this context (an extension rewrote that
	 *  message, or re-created it under a new timestamp); when the context holds
	 *  no anchor at all (the history was replaced, so nothing tells old from
	 *  new); when it sits before the anchor while an owned message is missing
	 *  (it may be that message rewritten, or a new message an extension moved);
	 *  or when Pi replaced the history during the query, so any unmatched
	 *  message may be a summary of history Claude already has. */
	unresolved: number[];
	/** Index of the anchor, or -1 when the context holds none. */
	anchor: number;
	/** How many owned user messages this context no longer carries. */
	missingOwned: number;
}

export interface ClassifyOptions {
	/** Pi replaced the history while the query ran and the restart was
	 *  declined: every unmatched message goes to a rebuild. */
	historyReplaced?: boolean;
	/** A non-user message the query knew before this callback (an assistant
	 *  message it produced, a tool result an earlier callback delivered). Owned
	 *  user messages are always known. */
	isKnown?: (message: UserLike, index: number) => boolean;
}

interface OwnedEntry {
	count: number;
	timestamp: number | undefined;
	digest: string;
}

/** Multiset of owned user-message identities, query-local. */
export class UserMessageLedger {
	private readonly owned = new Map<string, OwnedEntry>();

	/** A ledger owning every user message in `messages` (a query's starting
	 *  context). */
	static fromHistory(messages: readonly UserLike[]): UserMessageLedger {
		const ledger = new UserMessageLedger();
		for (const message of messages) if (message?.role === "user") ledger.own(message);
		return ledger;
	}

	own(message: UserLike): void {
		const timestamp = userTimestamp(message);
		const digest = contentDigest(message.content);
		const key = `${timestamp === undefined ? "-" : `t${timestamp}`}:${digest}`;
		const entry = this.owned.get(key);
		if (entry) entry.count += 1;
		else this.owned.set(key, { count: 1, timestamp, digest });
	}

	get size(): number {
		let total = 0;
		for (const entry of this.owned.values()) total += entry.count;
		return total;
	}

	/** Split the user messages of a callback context into owned, fresh and
	 *  unresolved. Owned occurrences are matched in order, so two identical
	 *  messages only count as owned as often as they were owned. An unmatched
	 *  message then gets:
	 *  - unresolved: no anchor, `historyReplaced`, no timestamp, or the
	 *    timestamp or content of a MISSING owned message (evidence that it is an
	 *    owned message in altered form);
	 *  - fresh: otherwise, when it sits after the anchor;
	 *  - fresh: otherwise, before the anchor, when no owned message is missing
	 *    (nothing was rewritten, so it is new input an extension moved);
	 *  - unresolved: otherwise, before the anchor with an owned message
	 *    missing (a rewrite of that message, or moved new input: ambiguous).
	 *  Two distinct messages created in the same millisecond, or a repeated
	 *  "continue" while the first is still in context, are both still new. */
	classify(messages: readonly UserLike[], options: ClassifyOptions = {}): UserMessageClassification {
		const matched = new Map<string, number>();
		const unmatched: number[] = [];
		let anchor = -1;
		for (let index = 0; index < messages.length; index++) {
			const message = messages[index];
			if (message?.role !== "user") {
				if (message && options.isKnown?.(message, index)) anchor = index;
				continue;
			}
			const key = userMessageIdentity(message);
			const used = matched.get(key) ?? 0;
			if (used < (this.owned.get(key)?.count ?? 0)) {
				matched.set(key, used + 1);
				anchor = index;
				continue;
			}
			unmatched.push(index);
		}
		const fresh: number[] = [];
		const unresolved: number[] = [];
		const missingTimestamps = new Set<number>();
		const missingDigests = new Set<string>();
		let missingOwned = 0;
		for (const [key, entry] of this.owned) {
			const missing = entry.count - (matched.get(key) ?? 0);
			if (missing <= 0) continue;
			missingOwned += missing;
			if (entry.timestamp !== undefined) missingTimestamps.add(entry.timestamp);
			missingDigests.add(entry.digest);
		}
		if (unmatched.length === 0) return { fresh, unresolved, anchor, missingOwned };
		if (options.historyReplaced || anchor < 0) return { fresh, unresolved: unmatched, anchor, missingOwned };
		for (const index of unmatched) {
			const message = messages[index];
			const timestamp = userTimestamp(message);
			if (timestamp === undefined || missingTimestamps.has(timestamp) || missingDigests.has(contentDigest(message.content))) unresolved.push(index);
			else if (index > anchor || missingOwned === 0) fresh.push(index);
			else unresolved.push(index);
		}
		return { fresh, unresolved, anchor, missingOwned };
	}
}
