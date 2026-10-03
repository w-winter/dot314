// A rebuild that starts from Claude Code's own transcript.
//
// Claude Code puts content into its requests that never reaches Pi and keeps
// it as records in its transcript: attachments rendered as system reminders,
// tool results in the form the MCP handler delivered them, its own synthetic
// and meta records. Pi's history cannot reproduce those bytes, so a session
// imported from Pi differs from the requests Claude Code sent from its first
// message on, and the next request re-caches the whole conversation. Here the
// rebuild keeps Claude Code's records for the longest prefix that provably
// equals Pi's history, and the caller imports from Pi only what follows it.
//
// planNativePrefix walks Pi's messages and the old transcript's main chain
// together over whole groups (a prompt, or an assistant message with all of
// its tool results) and compares their content. forkNativePrefix copies that
// prefix into a new session with the SDK's forkSession, through an in-memory
// SessionStore: the SDK reads the records planNativePrefix verified and hands
// back the forked records, and nothing touches the disk until the caller
// writes them.

import { forkSession, type SessionStore, type SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import type { Context } from "@earendil-works/pi-ai";
import { getSessionPath } from "cc-session-io";
import { readFileSync } from "fs";
import { isDeepStrictEqual } from "node:util";
import { isChildExecutedTool } from "./connectors.ts";
import { PROVIDER_ID, convertPiMessages, sanitizeToolId, toolResultContentToAnthropic, unreplayableTrailingTurns, userMessageToAnthropic } from "./convert.ts";
import { debug } from "./debug.ts";
import { toolResultToMcpContent } from "./extract-tool-results.ts";
import { isPiDispatchable, mapToolArgs, mapToolName } from "./tool-mapping.ts";
import { extractUserPrompt, extractUserPromptBlocks } from "./user-prompt.ts";

type PiMessage = Context["messages"][number];

/** A transcript line, as parsed. */
type TranscriptRecord = SessionStoreEntry & {
	parentUuid?: unknown;
	isSidechain?: unknown;
	isMeta?: unknown;
	subtype?: unknown;
	attachment?: unknown;
	message?: unknown;
};

interface RecordMessage {
	id?: unknown;
	model?: unknown;
	content: unknown;
}

/** The verified prefix of the old transcript. */
export interface NativePrefix {
	oldSessionId: string;
	/** Every record of the old transcript, as read once by planNativePrefix. */
	records: TranscriptRecord[];
	/** Uuid of the last chain record the prefix keeps. */
	cutUuid: string;
	/** How many of Pi's prior messages the prefix covers: [0, piCount). */
	piCount: number;
	/** The old session's own custom title, if it had one. */
	title?: string;
}

export type NativePrefixPlan = { prefix: NativePrefix } | { reason: string };

/** The forked session, not yet written. */
export interface ForkedPrefix {
	sessionId: string;
	entries: SessionStoreEntry[];
	/** Uuid of the forked copy of the cut record: the record Pi's tail chains from. */
	leafUuid: string;
}

// The record types forkSession treats as transcript (sdk.mjs `Mye`).
const CHAIN_TYPES = new Set(["user", "assistant", "attachment", "system", "progress"]);

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const recordMessage = (record: TranscriptRecord): RecordMessage => record.message as RecordMessage;

// A user message Pi sent while the query ran. Claude Code keeps it as this
// attachment; Pi keeps it as a user message, so the prefix ends before it.
function isQueuedCommand(record: TranscriptRecord): boolean {
	return record.type === "attachment" && isObject(record.attachment) && record.attachment.type === "queued_command";
}

function isSyntheticAssistant(record: TranscriptRecord): boolean {
	return record.type === "assistant" && recordMessage(record).model === "<synthetic>";
}

// Claude Code's own records, which have no Pi counterpart: they ride along
// after a group. A synthetic assistant record ("No response requested.") is
// kept only in front of a group that matched, so the prefix never ends on it.
function isTrailingCarry(record: TranscriptRecord): boolean {
	if (isQueuedCommand(record)) return false;
	return record.type === "attachment" || record.type === "system" || record.type === "progress" ||
		(record.type === "user" && record.isMeta === true);
}

function isLeadingCarry(record: TranscriptRecord): boolean {
	return isTrailingCarry(record) || isSyntheticAssistant(record);
}

/** Content blocks reduced to what a request carries, or undefined for a block
 *  type no Pi message produces. A string is one text block. */
function normalizeBlocks(content: unknown): unknown[] | undefined {
	if (typeof content === "string") return [{ type: "text", text: content }];
	if (!Array.isArray(content)) return undefined;
	const blocks: unknown[] = [];
	for (const block of content) {
		if (!isObject(block)) return undefined;
		if (block.type === "text" && typeof block.text === "string") {
			blocks.push({ type: "text", text: block.text });
		} else if (block.type === "image" && isObject(block.source) && block.source.type === "base64") {
			blocks.push({ type: "image", source: { type: "base64", media_type: block.source.media_type, data: block.source.data } });
		} else {
			return undefined;
		}
	}
	return blocks;
}

function sameContent(native: unknown, candidates: unknown[]): boolean {
	const normalized = normalizeBlocks(native);
	if (!normalized) return false;
	return candidates.some((candidate) => {
		const expected = normalizeBlocks(candidate);
		return expected !== undefined && isDeepStrictEqual(normalized, expected);
	});
}

/** Pi user messages as the bridge sends them as one query's prompt
 *  (user-prompt.ts, as index.ts startFreshQuery calls it). */
function promptForm(messages: PiMessage[]): unknown {
	const blocks = messages.some((message) => Array.isArray(message.content) && (message.content as unknown[]).some((block) => isObject(block) && block.type === "image"))
		? extractUserPromptBlocks(messages)
		: null;
	return blocks ?? extractUserPrompt(messages);
}

/** A Pi tool result as the MCP handler delivered it to Claude Code
 *  (extract-tool-results.ts toolResultToMcpContent, as index.ts
 *  extractAllToolResults hands it to the handler), with an MCP image in the
 *  form Claude Code stores it. Before it stores a successful result, Claude
 *  Code replaces one with no content, an empty array or only text blocks of
 *  whitespace with "(<tool> completed with no output)", naming the tool as
 *  its call does. A failed result is stored as its error text instead, and a
 *  result with an image is output. */
function deliveredResultForm(message: PiMessage, toolName: string | undefined): unknown {
	const blocks = toolResultToMcpContent(message.content as Parameters<typeof toolResultToMcpContent>[0]);
	const failed = (message as { isError?: boolean }).isError === true;
	if (toolName !== undefined && !failed && blocks.every((block) => block.type === "text" && block.text.trim() === "")) return `(${toolName} completed with no output)`;
	return blocks.map((block) =>
		block.type === "text"
			? { type: "text", text: block.text }
			: { type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } });
}

// A prompt either came from Claude Code's query (the prompt form) or from an
// earlier rebuild's import (the import form).
function promptMatches(record: TranscriptRecord, message: PiMessage): boolean {
	return sameContent(recordMessage(record).content, [promptForm([message]), userMessageToAnthropic(message).content]);
}

// Claude Code stores a successful MCP result as its content blocks and a
// failed one as its text; sameContent reads a string as one text block.
// `toolName` is the name of the call the result answers, in Claude Code's
// transcript.
function toolResultMatches(block: Record<string, unknown>, message: PiMessage, toolName: string | undefined): boolean {
	if ((block.is_error === true) !== ((message as { isError?: boolean }).isError === true)) return false;
	const content = message.content as Parameters<typeof toolResultContentToAnthropic>[0];
	return sameContent(block.content, [deliveredResultForm(message, toolName), toolResultContentToAnthropic(content) || ""]);
}

/** The block the bridge's stream records in Pi for a block of Claude Code's
 *  assistant message (assistant-stream.ts processStreamEvent and
 *  renderCompletedBlocks): text and thinking as they arrived, and a tool_use
 *  as a toolCall named by mapToolName with its input through mapToolArgs, the
 *  same calls the stream makes. Undefined for a block the stream does not
 *  mirror into Pi (a child-executed or non-dispatchable tool, redacted
 *  thinking, server tools): Pi's message then lacks it. */
function streamedPiBlock(block: unknown, customToolNameToPi: Map<string, string> | undefined): unknown {
	if (!isObject(block)) return undefined;
	if (block.type === "text" && typeof block.text === "string") return { type: "text", text: block.text };
	if (block.type === "thinking" && typeof block.thinking === "string") {
		return { type: "thinking", thinking: block.thinking, thinkingSignature: block.signature };
	}
	if (block.type !== "tool_use" || typeof block.id !== "string" || typeof block.name !== "string") return undefined;
	if (isChildExecutedTool(block.name) || !isPiDispatchable(block.name, customToolNameToPi)) return undefined;
	const name = mapToolName(block.name, customToolNameToPi);
	return { type: "toolCall", id: block.id, name, arguments: mapToolArgs(name, block.input as Record<string, unknown> | undefined) };
}

/** A block of Pi's assistant message, reduced to the fields the stream sets. */
function storedPiBlock(block: unknown): unknown {
	if (!isObject(block)) return block;
	switch (block.type) {
		case "text": return { type: "text", text: block.text };
		case "thinking": return block.redacted === true ? block : { type: "thinking", thinking: block.thinking, thinkingSignature: block.thinkingSignature };
		case "toolCall": return { type: "toolCall", id: block.id, name: block.name, arguments: block.arguments };
		default: return block;
	}
}

/**
 * Whether Pi holds Claude Code's signed thinking block without its trailing
 * whitespace. Claude often ends a thinking block with "\n\n", and a Pi
 * extension may trim the text of the message Pi keeps (one that labels
 * thinking for display does, at `message_end`). The signature is the API's
 * identity for the block, so the block is the same one; the fork then
 * carries Claude Code's bytes, which are what Claude saw. Without a
 * signature nothing identifies the block, so it never matches this way.
 */
function trimmedSignedThinking(native: unknown, stored: unknown): boolean {
	if (!isObject(native) || !isObject(stored) || native.type !== "thinking" || stored.type !== "thinking" || stored.redacted === true) return false;
	const signature = native.signature;
	if (typeof signature !== "string" || signature === "" || stored.thinkingSignature !== signature) return false;
	return typeof native.thinking === "string" && stored.thinking === native.thinking.trimEnd();
}

/** Whether Pi's assistant message is what the bridge's stream recorded for
 *  Claude Code's message made of `blocks`. */
function streamedMatches(blocks: unknown[], message: PiMessage, customToolNameToPi: Map<string, string> | undefined): boolean {
	const assistant = message as { provider?: unknown; api?: unknown; content?: unknown };
	if (assistant.provider !== PROVIDER_ID && assistant.api !== "anthropic") return false;
	const content = assistant.content;
	if (!Array.isArray(content) || content.length !== blocks.length) return false;
	return blocks.every((block, n) => {
		const streamed = streamedPiBlock(block, customToolNameToPi);
		return streamed !== undefined && (isDeepStrictEqual(streamed, storedPiBlock(content[n])) || trimmedSignedThinking(block, content[n]));
	});
}

/** Whether Claude Code's message made of `blocks` is what a rebuild imports
 *  for Pi's assistant message (convert.ts convertPiMessages): records an
 *  earlier rebuild wrote. */
function importedMatches(blocks: unknown[], message: PiMessage, customToolNameToSdk: Map<string, string> | undefined): boolean {
	const expected = convertPiMessages([message], customToolNameToSdk).anthropicMessages[0]?.content;
	if (!Array.isArray(expected) || expected.length !== blocks.length) return false;
	return expected.every((block, n) => importedBlockMatches(blocks[n], block as unknown as Record<string, unknown>));
}

function importedBlockMatches(native: unknown, expected: Record<string, unknown>): boolean {
	if (!isObject(native) || native.type !== expected.type) return false;
	switch (expected.type) {
		case "text": return native.text === expected.text;
		case "thinking": return native.thinking === expected.thinking && native.signature === expected.signature;
		case "redacted_thinking": return native.data === expected.data;
		case "tool_use": return native.id === expected.id && native.name === expected.name && isDeepStrictEqual(native.input, expected.input);
		default: return false;
	}
}

function isSkippedAssistant(message: PiMessage): boolean {
	return message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted");
}

/** Where a matched group ends in the chain. */
interface GroupMatch {
	/** Index of the Pi message after the group. */
	next: number;
	/** Chain index of the last record the prefix keeps. */
	last: number;
	/** Chain index where the next group's search starts. */
	end: number;
	/** A queued_command follows: no later group can match. */
	stop: boolean;
	/** The off-chain tool result records Claude Code's loader adds to this
	 *  group and that were verified against Pi's results, each as
	 *  `<uuid of the chain record it follows>\n<uuid>`. */
	stitched: string[];
}

function readTranscript(path: string): { records: TranscriptRecord[] } | { reason: string } {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		return { reason: (error as NodeJS.ErrnoException).code === "ENOENT" ? "old-session-missing" : "old-session-unreadable" };
	}
	const records: TranscriptRecord[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			return { reason: "unparseable-line" };
		}
		if (!isObject(value) || typeof value.type !== "string") return { reason: "unknown-record-shape" };
		records.push(value as TranscriptRecord);
	}
	return { records };
}

/** The main chain, root first: the last non-sidechain transcript record and
 *  its parents. */
function mainChain(records: TranscriptRecord[]): { chain: TranscriptRecord[] } | { reason: string } {
	const byUuid = new Map<string, TranscriptRecord>();
	let leaf: TranscriptRecord | undefined;
	for (const record of records) {
		if (!CHAIN_TYPES.has(record.type) || record.isSidechain === true) continue;
		if (typeof record.uuid !== "string") return { reason: "unknown-record-shape" };
		if ((record.type === "user" || record.type === "assistant") &&
			!(isObject(record.message) && (typeof record.message.content === "string" || Array.isArray(record.message.content)))) {
			return { reason: "unknown-record-shape" };
		}
		if (!byUuid.has(record.uuid)) byUuid.set(record.uuid, record);
		leaf = record;
	}
	if (!leaf) return { reason: "no-native-history" };
	const chain: TranscriptRecord[] = [];
	const seen = new Set<string>();
	for (let record: TranscriptRecord | undefined = leaf; record;) {
		if (seen.has(record.uuid!)) return { reason: "broken-chain" };
		seen.add(record.uuid!);
		// Claude Code compacted this transcript; Pi never sees that summary.
		if (record.type === "system" && record.subtype === "compact_boundary") return { reason: "compacted" };
		chain.push(record);
		const parent = record.parentUuid;
		if (parent === null || parent === undefined) break;
		if (typeof parent !== "string") return { reason: "unknown-record-shape" };
		record = byUuid.get(parent);
		if (!record) return { reason: "broken-chain" };
	}
	return { chain: chain.reverse() };
}

/**
 * The longest prefix of `priors` that the old transcript's main chain holds
 * with equal content, and where the chain ends for it. Fails with a reason
 * when the transcript cannot be read as Claude Code writes it, or when not
 * even the first group matches.
 */
export function planNativePrefix(
	priors: Context["messages"],
	oldSessionId: string,
	cwd: string,
	claudeDir: string | undefined,
	customToolNameToSdk?: Map<string, string>,
	customToolNameToPi?: Map<string, string>,
): NativePrefixPlan {
	const read = readTranscript(getSessionPath(oldSessionId, cwd, claudeDir));
	if ("reason" in read) return { reason: read.reason };
	const walked = mainChain(read.records);
	if ("reason" in walked) return { reason: walked.reason };
	const { chain } = walked;
	// The transcript as forkSession slices it (sdk.mjs `TL`), and the records
	// Claude Code's loader would add to its main chain.
	const transcript = forkSlice(read.records);
	const stitched = stitchedRecords(transcript, chain);

	// Claude Code's records that follow a group: attachments, meta and system
	// records. The prefix keeps them up to a queued_command, never cutting on
	// a progress record (forkSession does not copy those).
	const trailing = (from: number, last: number, next: number, verified: string[] = []): GroupMatch => {
		let end = from;
		let cut = last;
		while (end < chain.length && isTrailingCarry(chain[end])) {
			if (chain[end].type !== "progress") cut = end;
			end++;
		}
		return { next, last: cut, end, stop: end < chain.length && isQueuedCommand(chain[end]), stitched: verified };
	};

	const matchPrompt = (at: number, index: number): GroupMatch | undefined => {
		const record = chain[at];
		if (!record || record.type !== "user" || record.isMeta === true) return undefined;
		const content = recordMessage(record).content;
		if (Array.isArray(content) && content.some((block) => isObject(block) && block.type === "tool_result")) return undefined;
		if (promptMatches(record, priors[index])) return trailing(at + 1, at, index + 1);
		// A prompt the bridge built from several of Pi's user messages in a
		// row (session-persistence.ts planIncrementalPromptBatch): the batch
		// runs from the prompt's start to the end of Pi's context, so it is
		// the whole run of user messages, and Pi's next message is the reply.
		let end = index;
		while (end < priors.length && priors[end].role === "user") end++;
		if (end - index < 2 || end === priors.length || !sameContent(content, [promptForm(priors.slice(index, end))])) return undefined;
		return trailing(at + 1, at, end);
	};

	// An assistant message: its records sharing one message id, then every
	// tool result it is owed, in one or more user records.
	const matchTurn = (at: number, index: number): GroupMatch | undefined => {
		const first = chain[at];
		if (!first || first.type !== "assistant" || isSyntheticAssistant(first)) return undefined;
		const messageId = recordMessage(first).id;
		if (typeof messageId !== "string") return undefined;
		let position = at;
		const blocks: unknown[] = [];
		while (position < chain.length && chain[position].type === "assistant" && recordMessage(chain[position]).id === messageId) {
			const content = recordMessage(chain[position]).content;
			if (!Array.isArray(content)) return undefined;
			blocks.push(...content);
			position++;
		}
		if (!streamedMatches(blocks, priors[index], customToolNameToPi) && !importedMatches(blocks, priors[index], customToolNameToSdk)) return undefined;
		let last = position - 1;
		let next = index + 1;
		const verified: string[] = [];
		const calls = blocks.filter((block) => isObject(block) && block.type === "tool_use") as Array<{ id: string; name: string }>;
		const callIds = calls.map((call) => call.id);
		const callNames = new Map(calls.map((call) => [call.id, call.name]));
		if (callIds.length > 0) {
			// Pi's results follow the assistant directly and answer exactly its
			// calls; anything else (a steer between them, a split batch) ends
			// the prefix before this group. A call's id is Pi's as the stream
			// recorded it, or sanitized as an earlier rebuild imported it.
			const ids = new Map<string, string>();
			const results = new Map<string, PiMessage>();
			while (next < priors.length && priors[next].role === "toolResult") {
				const raw = (priors[next] as { toolCallId: string }).toolCallId;
				const clean = sanitizeToolId(raw, ids);
				if (results.has(raw) || results.has(clean)) return undefined;
				results.set(raw, priors[next]);
				if (clean !== raw) results.set(clean, priors[next]);
				next++;
			}
			if (next - (index + 1) !== callIds.length || new Set(callIds.map((id) => results.get(id))).size !== callIds.length || callIds.some((id) => !results.has(id))) return undefined;
			const answered = new Set<string>();
			// A user record that holds only tool results, each equal to Pi's
			// result for its call and the call's first.
			const answers = (record: TranscriptRecord): boolean => {
				const content = record.type === "user" ? recordMessage(record).content : undefined;
				if (!Array.isArray(content) || content.length === 0 || !content.every((block) => isObject(block) && block.type === "tool_result")) return false;
				for (const block of content as Array<Record<string, unknown>>) {
					const id = block.tool_use_id;
					const result = typeof id === "string" ? results.get(id) : undefined;
					if (!result || answered.has(id as string) || !toolResultMatches(block, result, callNames.get(id as string))) return false;
					answered.add(id as string);
				}
				return true;
			};
			// Results Claude Code wrote off the chain (a parallel batch parents
			// each on its own call) that its loader adds after this message.
			// An assistant record it adds stays unverified, and
			// lastCarriedExactly ends the prefix before this group. So does a
			// result tied to the message only by its call's id: Claude Code's
			// own loader adds that one only behind a feature flag.
			const key = chain[position - 1].uuid!;
			for (const record of stitched.records.get(key) ?? []) {
				if (record.type !== "user") continue;
				if (stitched.tied.has(record.uuid!) || !answers(record)) return undefined;
				verified.push(`${key}\n${record.uuid}`);
			}
			while (answered.size < callIds.length) {
				const record = chain[position];
				if (!record) return undefined;
				if (isTrailingCarry(record)) {
					position++;
					continue;
				}
				if (!answers(record)) return undefined;
				last = position;
				position++;
			}
		}
		return trailing(position, last, next, verified);
	};

	let position = 0;
	let index = 0;
	// Every matched group's end, in order: where the prefix may be cut.
	const ends: PrefixEnd[] = [];
	// The import replaces the trailing turns it cannot replay with a note,
	// and only for the messages it imports. An earlier rebuild may have
	// imported such a turn with its thinking dropped while a later reply
	// followed it, so the prefix ends before the first of them.
	const unreplayable = unreplayableTrailingTurns(priors);
	const limit = unreplayable.size > 0 ? Math.min(...unreplayable) : priors.length;
	while (index < limit) {
		const message = priors[index];
		// What the import writes nothing for: a failed or aborted reply with its
		// results, and anything that is not a conversation message. It counts
		// as covered only once a group after it matches.
		if (isSkippedAssistant(message)) {
			index++;
			while (index < priors.length && priors[index].role === "toolResult") index++;
			continue;
		}
		if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") {
			index++;
			continue;
		}
		let start = position;
		while (start < chain.length && isLeadingCarry(chain[start])) start++;
		const group = message.role === "user" ? matchPrompt(start, index)
			: message.role === "assistant" ? matchTurn(start, index)
			: undefined;
		if (!group) break;
		index = group.next;
		ends.push({ piCount: group.next, cut: group.last, stitched: group.stitched });
		position = group.end;
		if (group.stop) break;
	}
	if (ends.length === 0) return { reason: "no-verified-prefix" };
	const { end, steered } = lastCarriedExactly(transcript, chain, ends);
	const old8 = oldSessionId.slice(0, 8);
	const steer = `${old8} copies a queued_command, which Claude Code renders as a user message Pi holds too`;
	if (!end) {
		debug(steered
			? `native prefix: ${steer}, before its first matched group's end`
			: `native prefix: ${old8} has unverified user or assistant records off its main chain before its first matched group's end`);
		return { reason: steered ? "queued-command" : "off-chain-records" };
	}
	if (end !== ends.at(-1)) {
		debug(steered
			? `native prefix: ${steer}; prefix ends at ${end.piCount} of ${ends.at(-1)!.piCount} matched pi msgs, before it`
			: `native prefix: ${old8} has unverified user or assistant records off its main chain; prefix ends at ${end.piCount} of ${ends.at(-1)!.piCount} matched pi msgs, before the first of them`);
	}
	const { piCount, cut } = end;
	let title: string | undefined;
	for (const record of read.records) {
		if (record.type === "custom-title" && typeof record.customTitle === "string" && record.customTitle.trim()) title = record.customTitle;
	}
	return {
		prefix: {
			oldSessionId,
			records: read.records,
			cutUuid: chain[cut].uuid!,
			piCount,
			...(title ? { title } : {}),
		},
	};
}

type PrefixEnd = { piCount: number; cut: number; stitched: string[] };

/**
 * The last of `ends` whose fork carries exactly the verified records.
 * forkSession copies the transcript's non-sidechain records in file order
 * through the cut (sdk.mjs `TL`: sliced at the cut's index; `Hye` drops only
 * records that would take over the leaf). When Claude Code then loads the
 * fork, `Jc` walks the parent chain from the leaf and `a_e` adds the records
 * stitchedRecords finds, wherever they sit in the slice. The cut qualifies
 * when every chain record through it lies inside the slice, the records
 * stitched into the slice's chain are exactly the off-chain results the
 * groups through it verified (at their places), and the slice holds no
 * other user or assistant record.
 *
 * Claude Code's own loader also adds the attachment, system and meta
 * records hanging off the chain beneath an assistant message that called
 * tools, or beneath its results (the `Uar` tail recovery in the claude
 * binary, which `a_e` lacks). Those are Claude Code's own and Pi has no
 * counterpart, except a queued_command: Pi's steer, rendered as a user
 * message, which Pi holds as one and the import would write again. So the
 * slice through the cut holds no queued_command, on the chain or off it.
 * `steered` says whether that ruled out a later cut.
 */
function lastCarriedExactly(transcript: TranscriptRecord[], chain: TranscriptRecord[], ends: PrefixEnd[]): { end?: PrefixEnd; steered: boolean } {
	const isMessage = (record: TranscriptRecord): boolean => record.type === "user" || record.type === "assistant";
	// Where each record sits in the slice, and how many user and assistant
	// records the slice holds through each position.
	const position = new Map<string, number>();
	const messagesThrough: number[] = [];
	let messages = 0;
	for (const record of transcript) {
		if (!position.has(record.uuid!)) position.set(record.uuid!, messagesThrough.length);
		if (isMessage(record)) messages++;
		messagesThrough.push(messages);
	}
	const chainMessagesThrough: number[] = [];
	let onChain = 0;
	for (const record of chain) chainMessagesThrough.push(onChain += isMessage(record) ? 1 : 0);
	const verifiedThrough: number[] = [];
	let verified = 0;
	for (const end of ends) verifiedThrough.push(verified += end.stitched.length);
	const steer = transcript.findIndex(isQueuedCommand);
	let steered = false;
	for (let n = ends.length - 1; n >= 0; n--) {
		const { cut } = ends[n];
		const at = position.get(chain[cut].uuid!)!;
		if (steer !== -1 && at >= steer) {
			steered = true;
			continue;
		}
		const through = chain.slice(0, cut + 1);
		if (through.some((record) => position.get(record.uuid!)! > at)) continue;
		if (messagesThrough[at] !== chainMessagesThrough[cut] + verifiedThrough[n]) continue;
		const expected = new Set(ends.slice(0, n + 1).flatMap((end) => end.stitched));
		const carried: string[] = [];
		for (const [key, records] of stitchedRecords(transcript.slice(0, at + 1), through).records) {
			for (const record of records) carried.push(record.type === "user" ? `${key}\n${record.uuid}` : `assistant\n${record.uuid}`);
		}
		if (carried.length === expected.size && carried.every((entry) => expected.has(entry))) return { end: ends[n], steered };
	}
	return { steered };
}

/** The records forkSession treats as the transcript, in file order: the
 *  non-sidechain records of its types (sdk.mjs `Mye`, `TL`). */
function forkSlice(records: TranscriptRecord[]): TranscriptRecord[] {
	return records.filter((record) => CHAIN_TYPES.has(record.type) && record.isSidechain !== true && typeof record.uuid === "string");
}

const messageIdOf = (record: TranscriptRecord): string | undefined => {
	if (record.type !== "assistant" || !isObject(record.message)) return undefined;
	return typeof record.message.id === "string" ? record.message.id : undefined;
};

/** The string `key` of each `type` block in a record's content (sdk.mjs `Yc`). */
function blockIds(record: TranscriptRecord, type: string, key: string): string[] {
	const content = isObject(record.message) ? record.message.content : undefined;
	if (!Array.isArray(content)) return [];
	return content.flatMap((block) => isObject(block) && block.type === type && typeof block[key] === "string" ? [block[key] as string] : []);
}

/**
 * What Claude Code's loader adds to a fork's main chain, by the uuid of the
 * chain record it follows: sdk.mjs `a_e` run on what forkSession writes from
 * `slice`, whose chain is `chain`. For each message id on the chain it adds,
 * after the message's last chain record, the message's records off the chain
 * and then the tool result records filed under any of the message's records
 * (each by timestamp): a result is filed under its parent, and under the
 * record holding the tool_use it answers. A result parented elsewhere is
 * added only if it answers a call of the message that no result added
 * before it answers. forkSession clears `sourceToolAssistantUUID` (`RL`), so
 * that field ties nothing in a fork, and it drops progress records,
 * parenting a record on its nearest other ancestor in the slice, or on
 * nothing (`TL`). `tied` names the results added though not parented on
 * the message: Claude Code's own loader (`Uar`) adds those only while its
 * `tengu_foamy_spring` flag is on. It orders the added records by file
 * position rather than timestamp; what counts here is which records are
 * added, as the order is the loader's on the same records either way.
 */
function stitchedRecords(slice: TranscriptRecord[], chain: TranscriptRecord[]): { records: Map<string, TranscriptRecord[]>; tied: Set<string> } {
	const added = new Map<string, TranscriptRecord[]>();
	const tiedOnly = new Set<string>();
	const assistants = chain.filter((record) => record.type === "assistant");
	if (assistants.length === 0) return { records: added, tied: tiedOnly };
	const byUuid = new Map<string, TranscriptRecord>();
	for (const record of slice) if (!byUuid.has(record.uuid!)) byUuid.set(record.uuid!, record);
	const parentOf = (record: TranscriptRecord): string | undefined => {
		const seen = new Set<string>();
		for (let parent = record.parentUuid; typeof parent === "string";) {
			const found = byUuid.get(parent);
			if (!found) return undefined;
			if (found.type !== "progress" || seen.has(parent)) return parent;
			seen.add(parent);
			parent = found.parentUuid;
		}
		return undefined;
	};
	const kept = [...byUuid.values()].filter((record) => record.type !== "progress");
	const lastOnChain = new Map<string, TranscriptRecord>();
	for (const record of assistants) {
		const id = messageIdOf(record);
		if (id) lastOnChain.set(id, record);
	}
	const push = (map: Map<string, TranscriptRecord[]>, key: string, record: TranscriptRecord) => {
		const list = map.get(key);
		if (list) list.push(record);
		else map.set(key, [record]);
	};
	const sameMessage = new Map<string, TranscriptRecord[]>();
	const callRecord = new Map<string, TranscriptRecord | null>();
	const results: TranscriptRecord[] = [];
	for (const record of kept) {
		const id = messageIdOf(record);
		if (id) {
			push(sameMessage, id, record);
			for (const call of blockIds(record, "tool_use", "id")) {
				const holder = callRecord.get(call);
				callRecord.set(call, holder === undefined || (holder !== null && messageIdOf(holder) === id) ? record : null);
			}
		} else if (record.type === "user" && parentOf(record) !== undefined && blockIds(record, "tool_result", "tool_use_id").length > 0) {
			results.push(record);
		}
	}
	const filed = new Map<string, TranscriptRecord[]>();
	const filedKeys = new Set<string>();
	const file = (key: string, record: TranscriptRecord) => {
		if (filedKeys.has(`${key}\n${record.uuid}`)) return;
		filedKeys.add(`${key}\n${record.uuid}`);
		push(filed, key, record);
	};
	const agentOf = (record: TranscriptRecord): unknown => (record as { agentId?: unknown }).agentId;
	for (const record of results) {
		file(parentOf(record)!, record);
		for (const call of blockIds(record, "tool_result", "tool_use_id")) {
			const holder = callRecord.get(call);
			if (holder && agentOf(holder) === agentOf(record)) file(holder.uuid!, record);
		}
	}
	const answeredOnChain = new Set(chain.flatMap((record) => blockIds(record, "tool_result", "tool_use_id")));
	const filePosition = new Map<string, number>();
	kept.forEach((record, at) => { if (!filePosition.has(record.uuid!)) filePosition.set(record.uuid!, at); });
	const taken = new Set(chain.map((record) => record.uuid!));
	const done = new Set<string>();
	const byTime = (a: TranscriptRecord, b: TranscriptRecord) => String(a.timestamp ?? "").localeCompare(String(b.timestamp ?? ""));
	for (const record of assistants) {
		const id = messageIdOf(record);
		if (!id || done.has(id)) continue;
		done.add(id);
		const siblings = sameMessage.get(id) ?? [record];
		const own = new Set(siblings.map((sibling) => sibling.uuid!));
		const offChain = siblings.filter((sibling) => !taken.has(sibling.uuid!));
		const parented: TranscriptRecord[] = [];
		const tied: TranscriptRecord[] = [];
		const seen = new Set<string>();
		for (const sibling of siblings) {
			for (const result of filed.get(sibling.uuid!) ?? []) {
				if (taken.has(result.uuid!) || seen.has(result.uuid!)) continue;
				seen.add(result.uuid!);
				(own.has(parentOf(result)!) ? parented : tied).push(result);
			}
		}
		if (tied.length > 0) {
			const answered = new Set(answeredOnChain);
			for (const result of parented) for (const call of blockIds(result, "tool_result", "tool_use_id")) answered.add(call);
			tied.sort((a, b) => filePosition.get(a.uuid!)! - filePosition.get(b.uuid!)!);
			for (const result of tied) {
				const calls = blockIds(result, "tool_result", "tool_use_id");
				if (!calls.some((call) => !answered.has(call) && own.has(callRecord.get(call)?.uuid ?? ""))) continue;
				for (const call of calls) answered.add(call);
				tiedOnly.add(result.uuid!);
				parented.push(result);
			}
		}
		if (offChain.length === 0 && parented.length === 0) continue;
		offChain.sort(byTime);
		parented.sort(byTime);
		const records = [...offChain, ...parented];
		for (const stitched of records) taken.add(stitched.uuid!);
		added.set(lastOnChain.get(id)!.uuid!, records);
	}
	return { records: added, tied: tiedOnly };
}

type ForkSession = typeof forkSession;

let forkSessionImpl: ForkSession = forkSession;

/** Test seam: wrap or replace the SDK's forkSession. Production never calls this. */
export function __testSetForkSession(impl?: ForkSession): void {
	forkSessionImpl = impl ?? forkSession;
}

/**
 * Copy the verified prefix into a new session with the SDK's forkSession,
 * which assigns fresh uuids, keeps the parent chain and remaps what refers to
 * uuids (attachment source ids, compaction metadata). The store hands the SDK
 * the records planNativePrefix read, so the fork copies exactly what was
 * verified, from the right config dir, whatever the process env says; the
 * forked records come back in memory for the caller to write.
 *
 * The fork names itself "<title> (fork)" unless given a title. The old
 * session's own title, if it had one, is passed on; otherwise the title
 * record is left out, as a full import writes none, and a session forked on
 * every rebuild would otherwise grow a "(fork)" suffix each time.
 */
export async function forkNativePrefix(prefix: NativePrefix, cwd: string): Promise<ForkedPrefix> {
	const appended: SessionStoreEntry[] = [];
	const store: SessionStore = {
		load: async (key) => key.sessionId === prefix.oldSessionId && key.subpath === undefined ? prefix.records : null,
		append: async (_key, entries) => {
			appended.push(...entries);
		},
	};
	const { sessionId } = await forkSessionImpl(prefix.oldSessionId, {
		dir: cwd,
		upToMessageId: prefix.cutUuid,
		sessionStore: store,
		...(prefix.title ? { title: prefix.title } : {}),
	});
	const entries = prefix.title ? appended : appended.filter((entry) => entry.type !== "custom-title");
	const leaf = entries.find((entry) => isObject(entry.forkedFrom) && entry.forkedFrom.messageUuid === prefix.cutUuid);
	if (!leaf || typeof leaf.uuid !== "string") throw new Error("the fork has no copy of the cut record");
	if (entries.some((entry) => entry.sessionId !== sessionId)) throw new Error("the fork wrote records for another session id");
	return { sessionId, entries, leafUuid: leaf.uuid };
}
