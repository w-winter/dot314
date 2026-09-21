import {
	buildContextEntries,
	estimateTokens,
	sessionEntryToContextMessages,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";

export type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const TOOL_HORIZON_STATE_CUSTOM_TYPE = "tool-horizon-state";
export const TOOL_HORIZON_STATUS_KEY = "tool-horizon";
const ENTRY_PREVIEW_LIMIT = 60;
const FINGERPRINT_TEXT_LIMIT = 120;
const FINGERPRINT_MATCH_THRESHOLD = 3;

export type BoundaryMode = "from-entry" | "after-entry" | "pending";

export type BoundaryFingerprint = {
	role: string;
	textPrefix: string | null;
	toolNames: string[] | null;
	toolCount: number;
	payloadIndex: number;
};

export type ResolvedToolHorizonState = {
	enabled: true;
	boundaryMode: "from-entry" | "after-entry";
	boundaryFingerprint: BoundaryFingerprint;
};

export type ToolHorizonState =
	| {
			enabled: false;
			boundaryMode: null;
			boundaryFingerprint: null;
	}
	| {
			enabled: true;
			boundaryMode: "pending";
			boundaryFingerprint: null;
	}
	| ResolvedToolHorizonState;

export type ToolCallBlock = {
	type: "toolCall";
	id?: string;
	name?: string;
	arguments?: unknown;
};

export type TextBlock = {
	type: "text";
	text?: string;
};

export type ThinkingBlock = {
	type: "thinking";
	thinking?: string;
	redacted?: boolean;
};

export type ContentBlock = ToolCallBlock | TextBlock | ThinkingBlock | { type?: string; [key: string]: unknown };

export type EventMessage = {
	role?: string;
	toolCallId?: string;
	content?: ContentBlock[] | string | null;
	[key: string]: unknown;
};

export type PayloadDiagnostics = {
	roles: string[];
	blockTypes: string[];
	payloadToolIds: Set<string>;
};

export type ToolHorizonRuntimeSnapshot = {
	state: ToolHorizonState;
	rawMessages: EventMessage[] | null;
	filteredMessages: EventMessage[] | null;
	filteredToRawIndices: number[];
	resolvedBoundaryIndex: number | null;
};

export type ContextMessageSourceType = "message" | "custom_message" | "branch_summary" | "compaction";

export type ContextMessageEntry = {
	id: string;
	sourceType: ContextMessageSourceType;
	message: EventMessage;
};

type ToolHorizonRuntimeStore = {
	sessionId: string | null;
	snapshot: ToolHorizonRuntimeSnapshot | null;
};

const TOOL_HORIZON_RUNTIME_KEY = Symbol.for("pi.extensions.tool-horizon.runtime.v1");

function getToolHorizonRuntimeStore(): ToolHorizonRuntimeStore {
	const globalStore = globalThis as typeof globalThis & {
		[TOOL_HORIZON_RUNTIME_KEY]?: ToolHorizonRuntimeStore;
	};
	const existing = globalStore[TOOL_HORIZON_RUNTIME_KEY];
	if (existing) return existing;
	const created: ToolHorizonRuntimeStore = {
		sessionId: null,
		snapshot: null,
	};
	globalStore[TOOL_HORIZON_RUNTIME_KEY] = created;
	return created;
}

export function getToolHorizonRuntimeSnapshot(sessionId: string | null | undefined): ToolHorizonRuntimeSnapshot | null {
	if (!sessionId) return null;
	const store = getToolHorizonRuntimeStore();
	return store.sessionId === sessionId ? store.snapshot : null;
}

export function setToolHorizonRuntimeSnapshot(
	sessionId: string | null | undefined,
	snapshot: ToolHorizonRuntimeSnapshot | null,
): void {
	const store = getToolHorizonRuntimeStore();
	if (!sessionId) {
		store.sessionId = null;
		store.snapshot = null;
		return;
	}
	store.sessionId = sessionId;
	store.snapshot = snapshot;
}

export const TOOL_HORIZON_DISABLED_STATE: ToolHorizonState = {
	enabled: false,
	boundaryMode: null,
	boundaryFingerprint: null,
};

function getContextMessageSourceType(entry: SessionEntry): ContextMessageSourceType {
	if (
		entry.type === "message" ||
		entry.type === "custom_message" ||
		entry.type === "branch_summary" ||
		entry.type === "compaction"
	) {
		return entry.type;
	}
	throw new Error(`Session entry ${entry.id} (${entry.type}) projected a context message from an unsupported source type`);
}

export function adaptSessionEntryProjection(
	entry: SessionEntry,
	projectedMessages: readonly EventMessage[],
): ContextMessageEntry[] {
	if (projectedMessages.length === 0) return [];
	const sourceType = getContextMessageSourceType(entry);
	return projectedMessages.map((message) => ({
		id: entry.id,
		sourceType,
		message,
	}));
}

export function buildContextMessageEntries(
	branchEntries: SessionEntry[],
	leafId: string | null,
): ContextMessageEntry[] {
	const byId = new Map(branchEntries.map((entry) => [entry.id, entry]));
	return buildContextEntries(branchEntries, leafId, byId)
		.flatMap((entry) => adaptSessionEntryProjection(entry, sessionEntryToContextMessages(entry)));
}

/**
	* Collect the branch messages that compaction removed from the context payload
	*
	* Pi's active projection identifies the latest compaction on the selected leaf path. Tool Horizon
	* then recovers the hidden prefix from the parent-linked branch because Pi exposes no equivalent
	* compacted-away projection.
	*
	* Args:
	*     branchEntries (SessionEntry[]): Current parent-linked branch, oldest first
	*     leafId (string | null): Selected branch leaf
	*
	* Returns:
	*     The messages hidden by the latest compaction, in branch order, or none when the branch has
	*     never been compacted
	*/
export function collectCompactedAwayMessages(
	branchEntries: SessionEntry[],
	leafId: string | null,
): EventMessage[] {
	const byId = new Map(branchEntries.map((entry) => [entry.id, entry]));
	const activeEntries = buildContextEntries(branchEntries, leafId, byId);
	const activeCompaction = activeEntries.find((entry) => entry.type === "compaction");
	if (!activeCompaction || activeCompaction.type !== "compaction") return [];
	const compactionIndex = branchEntries.findIndex((entry) => entry.id === activeCompaction.id);
	if (compactionIndex < 0) return [];

	const messages: EventMessage[] = [];
	for (let index = 0; index < compactionIndex; index++) {
		const entry = branchEntries[index];
		if (entry.id === activeCompaction.firstKeptEntryId) break;
		if (entry.type === "compaction") continue;
		const projected = adaptSessionEntryProjection(entry, sessionEntryToContextMessages(entry));
		messages.push(...projected.map((item) => item.message));
	}
	return messages;
}

export function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function getString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function isBoundaryMode(value: unknown): value is BoundaryMode {
	return value === "from-entry" || value === "after-entry" || value === "pending";
}

export function truncate(text: string, limit: number = ENTRY_PREVIEW_LIMIT): string {
	const compact = text.replace(/\s+/g, " ").trim();
	if (compact.length <= limit) return compact;
	return `${compact.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
}

export function estimatePayloadTokens(value: unknown): number {
	if (Array.isArray(value)) {
		return value.reduce((total, item) => total + estimatePayloadTokens(item), 0);
	}
	if (isObject(value) && typeof value.role === "string") {
		return estimateTokens(value as never);
	}
	if (typeof value === "string") {
		return Math.ceil(value.length / 4);
	}
	return 0;
}

export function formatContextTokenSavings(tokens: number): string {
	const nonNegativeTokens = Math.max(0, Math.floor(tokens));
	if (nonNegativeTokens < 1000) return `−${nonNegativeTokens} context tokens`;
	return `−${(nonNegativeTokens / 1000).toFixed(1)}k context tokens`;
}

export function getTextBlocks(content: EventMessage["content"]): string[] {
	if (typeof content === "string") {
		const text = truncate(content);
		return text ? [text] : [];
	}
	if (!Array.isArray(content)) return [];
	return content
		.filter((block): block is TextBlock => isObject(block) && block.type === "text")
		.map((block) => truncate(String(block.text ?? ""), FINGERPRINT_TEXT_LIMIT))
		.filter(Boolean);
}

export function getToolCallNames(content: EventMessage["content"]): string[] {
	if (!Array.isArray(content)) return [];
	const names: string[] = [];
	for (const block of content) {
		if (!isObject(block) || block.type !== "toolCall") continue;
		const name = getString(block.name);
		if (name) names.push(name);
	}
	return names;
}

export function getThinkingBlocks(content: EventMessage["content"]): string[] {
	if (!Array.isArray(content)) return [];
	const out: string[] = [];
	for (const block of content) {
		if (!isObject(block)) continue;
		if (block.type === "thinking") {
			const text = truncate(String((block as ThinkingBlock).thinking ?? ""), FINGERPRINT_TEXT_LIMIT);
			if (text) out.push(text);
		}
	}
	return out;
}

function getComparableText(msg: EventMessage): string | null {
	const summary = getString((msg as { summary?: unknown }).summary);
	if (summary) return truncate(summary, FINGERPRINT_TEXT_LIMIT);
	return getTextBlocks(msg.content).at(0) ?? getThinkingBlocks(msg.content).at(0) ?? null;
}

function getComparableCustomType(msg: EventMessage): string | null {
	return getString((msg as { customType?: unknown }).customType);
}

function compareToolNames(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalizeToolNames(names: readonly string[]): string[] {
	return [...names].sort(compareToolNames);
}

function getComparableToolNames(msg: EventMessage): string[] | null {
	const names = getToolCallNames(msg.content);
	return names.length > 0 ? canonicalizeToolNames(names) : null;
}

function sameStringArray(a: string[] | null, b: string[] | null): boolean {
	if (a === null || b === null) return a === b;
	if (a.length !== b.length) return false;
	return a.every((value, index) => value === b[index]);
}

export type ContextAlignmentField = "role" | "customType" | "toolResultId" | "text" | "toolNames";

export type ContextAlignmentComparable = {
	role: string | null;
	customType: string | null;
	toolResultId: string | null;
	text: string | null;
	toolNames: string[] | null;
};

export function getContextAlignmentComparable(message: EventMessage): ContextAlignmentComparable {
	return {
		role: getString(message.role),
		customType: getComparableCustomType(message),
		toolResultId: getToolResultId(message),
		text: getComparableText(message),
		toolNames: getComparableToolNames(message),
	};
}

export function getContextAlignmentMismatchFields(expected: EventMessage, actual: EventMessage): ContextAlignmentField[] {
	const expectedComparable = getContextAlignmentComparable(expected);
	const actualComparable = getContextAlignmentComparable(actual);
	const mismatches: ContextAlignmentField[] = [];
	if (!expectedComparable.role || expectedComparable.role !== actualComparable.role) mismatches.push("role");
	if (
		(expectedComparable.customType !== null || actualComparable.customType !== null) &&
		expectedComparable.customType !== actualComparable.customType
	) {
		mismatches.push("customType");
	}
	if (
		(expectedComparable.toolResultId !== null || actualComparable.toolResultId !== null) &&
		expectedComparable.toolResultId !== actualComparable.toolResultId
	) {
		mismatches.push("toolResultId");
	}
	if ((expectedComparable.text !== null || actualComparable.text !== null) && expectedComparable.text !== actualComparable.text) {
		mismatches.push("text");
	}
	if (
		(expectedComparable.toolNames !== null || actualComparable.toolNames !== null) &&
		!sameStringArray(expectedComparable.toolNames, actualComparable.toolNames)
	) {
		mismatches.push("toolNames");
	}
	return mismatches;
}

function stableJsonStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableJsonStringify(item)).join(",")}]`;
	}
	const entries = Object.entries(value as Record<string, unknown>)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableJsonStringify(entryValue)}`);
	return `{${entries.join(",")}}`;
}

function normalizeContentForContextAlignment(content: EventMessage["content"]): unknown {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return null;
	return content.map((block) => {
		if (!isObject(block)) return block;
		const type = getString(block.type) ?? null;
		if (type === "text") {
			return { type, text: String((block as TextBlock).text ?? "") };
		}
		if (type === "thinking") {
			return { type, thinking: String((block as ThinkingBlock).thinking ?? "") };
		}
		if (type === "toolCall") {
			return {
				type,
				id: getToolCallBlockId(block),
				name: getString((block as { name?: unknown }).name),
				arguments: (block as { arguments?: unknown }).arguments ?? null,
			};
		}
		return Object.fromEntries(Object.entries(block).sort(([a], [b]) => a.localeCompare(b)));
	});
}

function getExactContextAlignmentSignature(message: EventMessage): string {
	return stableJsonStringify({
		role: getString(message.role),
		customType: getComparableCustomType(message),
		toolResultId: getToolResultId(message),
		summary: getString((message as { summary?: unknown }).summary),
		content: normalizeContentForContextAlignment(message.content),
		sections: message.sections ?? null,
		toolsAdded: message.toolsAdded ?? null,
		toolsRemoved: message.toolsRemoved ?? null,
	});
}

export function messagesMatchForContextAlignment(expected: EventMessage, actual: EventMessage): boolean {
	return getExactContextAlignmentSignature(expected) === getExactContextAlignmentSignature(actual);
}

export type ContextPayloadAlignmentError = {
	kind: "message-mismatch";
	contextEntryIndex: number;
	rawPayloadIndex: number;
	sourceType: ContextMessageSourceType;
	mismatchFields: ContextAlignmentField[];
};

export type ContextPayloadPrefixMatch = {
	entryIdToRawPayloadIndex: Map<string, number>;
	nextRawPayloadIndex: number;
	remainingContextEntryIndex: number;
	skippedCustomMessageEntryIds: string[];
};

export type ExactContextPayloadAlignmentError =
	| ContextPayloadAlignmentError
	| {
			kind: "unconsumed-raw-payload";
			firstUnmatchedRawPayloadIndex: number;
			rawPayloadLength: number;
		}
	| {
			kind: "remaining-context-entries";
			firstRemainingContextEntryIndex: number;
			remainingNonCustomEntryIds: string[];
		};

/**
	* Walk branch-derived context entries against a raw payload prefix, recovering session entry IDs
	*
	* This is the single canonical alignment algorithm, shared by turn-end reconciliation and the
	* boundary picker. It advances strictly in order and never searches ahead, so identical-looking
	* messages map by sequential occurrence rather than by content lookup. The only tolerated
	* discrepancy is an unmatched `custom_message` branch entry, which is skipped without consuming a
	* raw message; any other mismatch aborts immediately.
	*
	* Args:
	*     contextEntries (readonly ContextMessageEntry[]): branch-derived entries, in branch order
	*     rawPayload (readonly EventMessage[]): the cached raw payload to align against
	*
	* Returns:
	*     A prefix match describing how far both cursors advanced, or a typed mismatch error
	*/
export function matchContextMessageEntryPrefix(
	contextEntries: readonly ContextMessageEntry[],
	rawPayload: readonly EventMessage[],
): ContextPayloadPrefixMatch | ContextPayloadAlignmentError {
	const entryIdToRawPayloadIndex = new Map<string, number>();
	const skippedCustomMessageEntryIds: string[] = [];
	let rawPayloadIndex = 0;
	let contextEntryIndex = 0;

	for (; contextEntryIndex < contextEntries.length; contextEntryIndex++) {
		if (rawPayloadIndex >= rawPayload.length) break;
		const entry = contextEntries[contextEntryIndex];
		if (messagesMatchForContextAlignment(entry.message, rawPayload[rawPayloadIndex])) {
			entryIdToRawPayloadIndex.set(entry.id, rawPayloadIndex);
			rawPayloadIndex += 1;
			continue;
		}
		if (entry.sourceType === "custom_message") {
			skippedCustomMessageEntryIds.push(entry.id);
			continue;
		}
		return {
			kind: "message-mismatch",
			contextEntryIndex,
			rawPayloadIndex,
			sourceType: entry.sourceType,
			mismatchFields: getContextAlignmentMismatchFields(entry.message, rawPayload[rawPayloadIndex]),
		};
	}

	return {
		entryIdToRawPayloadIndex,
		nextRawPayloadIndex: rawPayloadIndex,
		remainingContextEntryIndex: contextEntryIndex,
		skippedCustomMessageEntryIds,
	};
}

/**
	* Align branch-derived context entries against a raw payload, requiring exact mutual coverage
	*
	* The boundary picker needs a stronger contract than turn-end reconciliation: every raw payload
	* message must be accounted for, and no required branch entry may remain. Trailing unmatched
	* `custom_message` entries are tolerated, matching the prefix matcher. On any failure the caller
	* must discard the result entirely rather than using a partial mapping, because a partial map
	* would let the picker claim a boundary the payload does not actually contain.
	*
	* Args:
	*     contextEntries (readonly ContextMessageEntry[]): branch-derived entries, in branch order
	*     rawPayload (readonly EventMessage[]): the cached raw payload to align against
	*
	* Returns:
	*     A complete entryId -> raw payload index map, or a typed alignment error
	*/
export function alignContextMessageEntriesExactly(
	contextEntries: readonly ContextMessageEntry[],
	rawPayload: readonly EventMessage[],
): Map<string, number> | ExactContextPayloadAlignmentError {
	const prefix = matchContextMessageEntryPrefix(contextEntries, rawPayload);
	if ("kind" in prefix) return prefix;

	if (prefix.nextRawPayloadIndex !== rawPayload.length) {
		return {
			kind: "unconsumed-raw-payload",
			firstUnmatchedRawPayloadIndex: prefix.nextRawPayloadIndex,
			rawPayloadLength: rawPayload.length,
		};
	}

	const remaining = contextEntries.slice(prefix.remainingContextEntryIndex);
	const remainingNonCustomEntryIds = remaining
		.filter((entry) => entry.sourceType !== "custom_message")
		.map((entry) => entry.id);
	if (remainingNonCustomEntryIds.length > 0) {
		return {
			kind: "remaining-context-entries",
			firstRemainingContextEntryIndex: prefix.remainingContextEntryIndex,
			remainingNonCustomEntryIds,
		};
	}

	return prefix.entryIdToRawPayloadIndex;
}

/**
	* Describe a typed alignment failure for diagnostic logging
	*
	* Args:
	*     error (ExactContextPayloadAlignmentError): the failure to describe
	*
	* Returns:
	*     A single-line, secret-free summary suitable for debug logs
	*/
export function describeContextPayloadAlignmentError(error: ExactContextPayloadAlignmentError): string {
	if (error.kind === "message-mismatch") {
		return `message-mismatch contextEntry=${error.contextEntryIndex} rawPayload=${error.rawPayloadIndex} sourceType=${error.sourceType} fields=${error.mismatchFields.join(",") || "none"}`;
	}
	if (error.kind === "unconsumed-raw-payload") {
		return `unconsumed-raw-payload firstUnmatched=${error.firstUnmatchedRawPayloadIndex} rawPayloadLength=${error.rawPayloadLength}`;
	}
	return `remaining-context-entries firstRemaining=${error.firstRemainingContextEntryIndex} count=${error.remainingNonCustomEntryIds.length}`;
}

export function getToolCallBlockId(block: ContentBlock): string | null {
	if (!isObject(block) || block.type !== "toolCall") return null;
	return getString(block.id);
}

export function getToolIdsFromAssistantMessage(msg: EventMessage): string[] {
	if (msg.role !== "assistant" || !Array.isArray(msg.content)) return [];
	const ids: string[] = [];
	for (const block of msg.content) {
		const id = getToolCallBlockId(block);
		if (id) ids.push(id);
	}
	return ids;
}

export function getToolResultId(msg: EventMessage): string | null {
	return getString(msg.toolCallId);
}

export function countToolCalls(content: EventMessage["content"]): number {
	return getToolCallNames(content).length;
}

export function hasThinkingBlock(content: EventMessage["content"]): boolean {
	if (!Array.isArray(content)) return false;
	return content.some((block) => isObject(block) && block.type === "thinking");
}

export function getProtectedPruneContext(messages: readonly EventMessage[]): {
	protectedAssistantIdx: number;
	protectedIds: Set<string>;
} {
	let protectedAssistantIdx = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant" && hasThinkingBlock(msg.content)) {
			protectedAssistantIdx = i;
			break;
		}
	}
	const protectedIds = new Set<string>();
	if (protectedAssistantIdx >= 0) {
		for (const id of getToolIdsFromAssistantMessage(messages[protectedAssistantIdx])) protectedIds.add(id);
	}
	return { protectedAssistantIdx, protectedIds };
}

export function applyPruningAtBoundary(
	messages: readonly EventMessage[],
	resolvedBoundaryIndex: number,
	boundaryMode: BoundaryMode,
): {
	filteredMessages: EventMessage[];
	keptRawIndices: number[];
	changed: boolean;
	reclaimedTokens: number;
	payloadPruneIds: Set<string>;
	protectedIds: Set<string>;
	protectedAssistantIdx: number;
} {
	const payloadPruneIds = new Set<string>();
	for (let i = 0; i < messages.length; i++) {
		const beforeBoundary = boundaryMode === "after-entry" ? i <= resolvedBoundaryIndex : i < resolvedBoundaryIndex;
		if (!beforeBoundary) continue;
		for (const id of getToolIdsFromAssistantMessage(messages[i])) payloadPruneIds.add(id);
	}

	const { protectedAssistantIdx, protectedIds } = getProtectedPruneContext(messages);
	let changed = false;
	const filteredMessages: EventMessage[] = [];
	const keptRawIndices: number[] = [];

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg.role === "toolResult") {
			const id = getToolResultId(msg);
			if (id && payloadPruneIds.has(id) && !protectedIds.has(id)) {
				changed = true;
				continue;
			}
			filteredMessages.push(msg);
			keptRawIndices.push(i);
			continue;
		}

		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			if (i === protectedAssistantIdx && hasThinkingBlock(msg.content)) {
				filteredMessages.push(msg);
				keptRawIndices.push(i);
				continue;
			}

			const withoutPrunedToolCalls = msg.content.filter((block) => {
				if (!isObject(block) || block.type !== "toolCall") return true;
				const id = getToolCallBlockId(block);
				if (!id) return true;
				return !payloadPruneIds.has(id) || protectedIds.has(id);
			});

			// When a tool call is stripped from a non-protected assistant message, its signed
			// thinking blocks must also be removed because the assistant content was modified.
			const strippedToolCalls = withoutPrunedToolCalls.length !== msg.content.length;
			const nextContent = strippedToolCalls
				? withoutPrunedToolCalls.filter((block) => !isObject(block) || block.type !== "thinking")
				: withoutPrunedToolCalls;

			if (nextContent.length !== msg.content.length) changed = true;
			// Drop assistants that pruning emptied, not assistants that arrived empty. Pi's projection
			// normalizes null content to [], so an already-empty assistant must survive unchanged.
			if (nextContent.length === 0 && msg.content.length > 0) {
				changed = true;
				continue;
			}
			filteredMessages.push(nextContent.length === msg.content.length ? msg : { ...msg, content: nextContent });
			keptRawIndices.push(i);
			continue;
		}

		filteredMessages.push(msg);
		keptRawIndices.push(i);
	}

	return {
		filteredMessages,
		keptRawIndices,
		changed,
		reclaimedTokens: Math.max(0, estimatePayloadTokens(messages) - estimatePayloadTokens(filteredMessages)),
		payloadPruneIds,
		protectedIds,
		protectedAssistantIdx,
	};
}

/**
	* Compute the raw indices that are valid "from-entry" pruning boundaries
	*
	* A boundary is valid only when pruning at it leaves the selected message and the entire suffix
	* byte-identical: that is what lets the picker promise "this entry is kept" and what keeps the
	* deterministic checkpoint (which covers only rawPayload[0, B)) complete.
	*
	* Derivation from applyPruningAtBoundary: payloadPruneIds is built exclusively from assistants
	* before the boundary; user, branchSummary, compactionSummary, and custom messages are always
	* pushed by reference; and an assistant at or after the boundary can only lose blocks if one of its
	* own tool-call ids appears in payloadPruneIds, which cannot happen because tool-call ids are
	* unique per call. Therefore the only message at or after the boundary that pruning can ever change
	* is a tool result answering a call issued before the boundary.
	*
	* This deliberately does NOT consult protected-thinking state. getProtectedPruneContext resolves
	* against the whole payload and shields the most recent thinking-bearing assistant and its results,
	* so a projection-based check would report "nothing changed" for a tool result sitting just after a
	* currently protected assistant — and would then silently delete that very message on a later turn,
	* once a newer thinking-bearing assistant takes over protection. Validity must be stable across
	* turns, so it is derived structurally instead.
	*
	* Args:
	*     rawPayload (readonly EventMessage[]): the pre-pruning payload to analyze
	*
	* Returns:
	*     Set of raw indices that are safe "from-entry" boundaries
	*/
export function computeBoundarySafeRawIndices(rawPayload: readonly EventMessage[]): Set<number> {
	const issuerIndexByToolCallId = new Map<string, number>();
	for (let i = 0; i < rawPayload.length; i++) {
		for (const id of getToolIdsFromAssistantMessage(rawPayload[i])) {
			if (!issuerIndexByToolCallId.has(id)) issuerIndexByToolCallId.set(id, i);
		}
	}

	// minIssuerIndexAtOrAfter[i] = lowest issuing-assistant index among tool results at index >= i.
	// A tool result whose issuer is absent from the payload (orphaned by compaction or an earlier
	// prune) can never enter payloadPruneIds, so it contributes no constraint.
	const safe = new Set<number>();
	let minIssuerIndexAtOrAfter = Number.POSITIVE_INFINITY;
	for (let i = rawPayload.length - 1; i >= 0; i--) {
		const message = rawPayload[i];
		if (message.role === "toolResult") {
			const resultId = getToolResultId(message);
			const issuerIndex = resultId === null ? undefined : issuerIndexByToolCallId.get(resultId);
			if (issuerIndex !== undefined && issuerIndex < minIssuerIndexAtOrAfter) {
				minIssuerIndexAtOrAfter = issuerIndex;
			}
		}
		if (minIssuerIndexAtOrAfter >= i) safe.add(i);
	}
	return safe;
}

export function collectPayloadDiagnostics(messages: EventMessage[]): PayloadDiagnostics {
	const roles = new Set<string>();
	const blockTypes = new Set<string>();
	const payloadToolIds = new Set<string>();
	for (const msg of messages) {
		if (typeof msg.role === "string") roles.add(msg.role);
		const toolResultId = getToolResultId(msg);
		if (toolResultId) payloadToolIds.add(toolResultId);
		if (!Array.isArray(msg.content)) continue;
		for (const block of msg.content) {
			if (!isObject(block)) continue;
			const type = getString(block.type);
			if (type) blockTypes.add(type);
			const toolCallId = getToolCallBlockId(block);
			if (toolCallId) payloadToolIds.add(toolCallId);
		}
	}
	return { roles: [...roles], blockTypes: [...blockTypes], payloadToolIds };
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
	const actualKeys = Object.keys(value);
	return actualKeys.length === expectedKeys.length && expectedKeys.every((key) => Object.hasOwn(value, key));
}

function normalizeBoundaryFingerprint(value: unknown): BoundaryFingerprint | null {
	if (!isObject(value) || !hasExactKeys(value, ["role", "textPrefix", "toolNames", "toolCount", "payloadIndex"])) {
		return null;
	}
	const role = getString(value.role);
	if (!role) return null;
	const textPrefix = value.textPrefix === null ? null : getString(value.textPrefix);
	if (value.textPrefix !== null && textPrefix === null) return null;
	if (textPrefix !== null && textPrefix !== truncate(textPrefix, FINGERPRINT_TEXT_LIMIT)) return null;
	const toolNamesRaw = value.toolNames;
	if (toolNamesRaw !== null && !Array.isArray(toolNamesRaw)) return null;
	const toolNames = toolNamesRaw === null ? null : toolNamesRaw.every((name) => getString(name) !== null)
		? [...toolNamesRaw] as string[]
		: null;
	if (toolNamesRaw !== null && toolNames === null) return null;
	if (toolNames && !sameStringArray(toolNames, canonicalizeToolNames(toolNames))) return null;
	const toolCount = value.toolCount;
	const payloadIndex = value.payloadIndex;
	if (typeof toolCount !== "number" || !Number.isInteger(toolCount) || toolCount < 0) return null;
	if (typeof payloadIndex !== "number" || !Number.isInteger(payloadIndex) || payloadIndex < 0) return null;
	if (toolNames === null ? toolCount !== 0 : toolNames.length === 0 || toolNames.length !== toolCount) return null;
	if (textPrefix === null && toolNames === null) return null;
	return { role, textPrefix, toolNames, toolCount, payloadIndex };
}

export function normalizeToolHorizonState(value: unknown): ToolHorizonState {
	if (!isObject(value) || !hasExactKeys(value, ["enabled", "boundaryMode", "boundaryFingerprint"])) {
		return TOOL_HORIZON_DISABLED_STATE;
	}
	if (value.enabled !== true) return TOOL_HORIZON_DISABLED_STATE;
	const boundaryMode = value.boundaryMode;
	if (!isBoundaryMode(boundaryMode)) return TOOL_HORIZON_DISABLED_STATE;
	if (boundaryMode === "pending") {
		return value.boundaryFingerprint === null
			? { enabled: true, boundaryMode, boundaryFingerprint: null }
			: TOOL_HORIZON_DISABLED_STATE;
	}
	const boundaryFingerprint = normalizeBoundaryFingerprint(value.boundaryFingerprint);
	return boundaryFingerprint
		? { enabled: true, boundaryMode, boundaryFingerprint }
		: TOOL_HORIZON_DISABLED_STATE;
}

/** Reduce explicit state entries and optional compaction restore-all transitions in chronological branch order */
export function loadToolHorizonStateFromEntries(
	entries: SessionEntry[] | undefined,
	restoreAllAfterCompaction: boolean,
): ToolHorizonState {
	let state = TOOL_HORIZON_DISABLED_STATE;
	for (const entry of entries ?? []) {
		if (entry.type === "custom" && entry.customType === TOOL_HORIZON_STATE_CUSTOM_TYPE) {
			state = normalizeToolHorizonState(entry.data);
		} else if (restoreAllAfterCompaction && entry.type === "compaction") {
			state = TOOL_HORIZON_DISABLED_STATE;
		}
	}
	return state;
}

export function getPayloadNarrativeLabel(msg: EventMessage): string | null {
	if (msg.role === "user") {
		const text = getTextBlocks(msg.content)[0];
		return text ? `👤 ${truncate(text)}` : null;
	}
	if (msg.role === "assistant") {
		const text = getTextBlocks(msg.content)[0];
		if (text) {
			const toolCount = countToolCalls(msg.content);
			return toolCount > 0 ? `🤖 ${truncate(text)} (+${toolCount} tools)` : `🤖 ${truncate(text)}`;
		}
		if (hasThinkingBlock(msg.content)) return "🤖 [thinking]";
		return null;
	}
	if (msg.role === "compactionSummary") {
		const text = getString((msg as { summary?: unknown }).summary);
		return text ? `🗜 ${truncate(text)}` : null;
	}
	return null;
}

/**
	* Extract the comparable text a fingerprint is built from
	*
	* Reads the whole message rather than only its content blocks, so compaction summaries and branch
	* summaries — which carry `summary` and no content — produce a usable prefix. Without this they
	* score 1 against a match threshold of 3 and can never be resolved as boundaries.
	*/
function getFingerprintText(msg: EventMessage): string | null {
	const summary = getString((msg as { summary?: unknown }).summary);
	if (summary) return truncate(summary, FINGERPRINT_TEXT_LIMIT);
	const text = getTextBlocks(msg.content)[0] ?? null;
	if (text) return text;
	return getThinkingBlocks(msg.content)[0] ?? null;
}

export function computeBoundaryFingerprint(msg: EventMessage, payloadIndex: number): BoundaryFingerprint {
	const textPrefix = getFingerprintText(msg);
	const toolNames = getToolCallNames(msg.content);
	return {
		role: msg.role ?? "unknown",
		textPrefix,
		toolNames: toolNames.length > 0 ? canonicalizeToolNames(toolNames) : null,
		toolCount: toolNames.length,
		payloadIndex,
	};
}

function boundaryFingerprintScore(msg: EventMessage, fingerprint: BoundaryFingerprint): number {
	if ((msg.role ?? "unknown") !== fingerprint.role) return 0;
	let score = 1;
	const candidateText = getFingerprintText(msg);
	if (fingerprint.textPrefix && candidateText === fingerprint.textPrefix) score += 3;
	const candidateNames = getToolCallNames(msg.content);
	const sortedCandidateNames = candidateNames.length > 0 ? canonicalizeToolNames(candidateNames) : null;
	if (fingerprint.toolNames && sortedCandidateNames && fingerprint.toolNames.length === sortedCandidateNames.length && fingerprint.toolNames.every((name, idx) => name === sortedCandidateNames[idx])) {
		score += 2;
	}
	if (fingerprint.toolCount > 0 && fingerprint.toolCount === candidateNames.length) score += 1;
	return score;
}

export function resolveBoundaryIndex(messages: readonly EventMessage[], fingerprint: BoundaryFingerprint | null): number | null {
	if (!fingerprint) return null;
	let bestIndex: number | null = null;
	let bestScore = 0;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (let i = 0; i < messages.length; i++) {
		const score = boundaryFingerprintScore(messages[i], fingerprint);
		if (score < FINGERPRINT_MATCH_THRESHOLD) continue;
		const distance = Math.abs(i - fingerprint.payloadIndex);
		if (score > bestScore || (score === bestScore && distance < bestDistance) || (score === bestScore && distance === bestDistance && (bestIndex === null || i > bestIndex))) {
			bestScore = score;
			bestDistance = distance;
			bestIndex = i;
		}
	}
	return bestIndex;
}
