// Detect missing assistant tool_use ↔ user tool_result pairs before cc-session-io
// repairs them with synthetic "[no tool result recorded]" blocks.
// Kept pure so tests can exercise the exact audit without activating Pi.

export interface RecoveredToolResult {
	id: string;
	assistantIndex: number;
	sourceUserIndex: number;
	targetUserIndex: number;
}

export interface MissingToolResult {
	id: string;
	toolName: string;
	assistantIndex: number;
	userIndex: number | null;
}

function contentBlocks(content: unknown): Array<Record<string, any>> {
	return Array.isArray(content) ? content.filter((block): block is Record<string, any> => Boolean(block && typeof block === "object")) : [];
}

function toolUses(content: unknown): Array<{ id: string; name: string }> {
	return contentBlocks(content)
		.filter((block) => block.type === "tool_use" && typeof block.id === "string")
		.map((block) => ({ id: block.id, name: typeof block.name === "string" && block.name ? block.name : "unknown" }));
}

function toolResultIds(content: unknown): Set<string> {
	const ids = new Set<string>();
	for (const block of contentBlocks(content)) {
		if (block.type === "tool_result" && typeof block.tool_use_id === "string") ids.add(block.tool_use_id);
	}
	return ids;
}

/**
 * Pi can split a parallel Claude tool batch into several visible turns when a
 * steer is drained after the first tool result. The first assistant message
 * still contains every tool_use, while later sibling results sit behind small
 * duplicate assistant/tool-result pairs. Anthropic history requires every
 * result immediately after the original batch, so copy those already-recorded
 * later results into that first user result message before generic repair adds
 * a false "[no tool result recorded]" placeholder.
 *
 * The later pair stays intact because Pi also recorded its duplicate tool_use;
 * copying is therefore required to keep both assistant messages valid.
 */
export function recoverLaterToolResults(
	messages: Array<{ role?: string; content?: unknown }>,
): RecoveredToolResult[] {
	const recovered: RecoveredToolResult[] = [];
	for (let i = 0; i < messages.length; i++) {
		const assistant = messages[i];
		if (assistant?.role !== "assistant") continue;
		const uses = toolUses(assistant.content);
		if (uses.length === 0) continue;

		const target = messages[i + 1];
		if (target?.role !== "user") continue;
		const present = toolResultIds(target.content);
		const missing = uses.filter((use) => !present.has(use.id));
		if (missing.length === 0) continue;

		for (const use of missing) {
			let sourceBlock: Record<string, any> | undefined;
			let sourceUserIndex = -1;
			for (let j = i + 2; j < messages.length; j++) {
				const candidate = messages[j];
				if (candidate?.role !== "user") continue;
				sourceBlock = contentBlocks(candidate.content).find(
					(block) => block.type === "tool_result" && block.tool_use_id === use.id,
				);
				if (sourceBlock) {
					sourceUserIndex = j;
					break;
				}
			}
			if (!sourceBlock) continue;

			const targetBlocks = Array.isArray(target.content)
				? target.content as Array<Record<string, any>>
				: typeof target.content === "string" && target.content
					? [{ type: "text", text: target.content }]
					: [];
			// tool_result blocks must lead the user message; insert the recovered
			// result after the existing tool_results, never after trailing text.
			let insertAt = 0;
			while (insertAt < targetBlocks.length && targetBlocks[insertAt]?.type === "tool_result") insertAt++;
			targetBlocks.splice(insertAt, 0, { ...sourceBlock });
			target.content = targetBlocks;
			present.add(use.id);
			recovered.push({ id: use.id, assistantIndex: i, sourceUserIndex, targetUserIndex: i + 1 });
		}
	}
	return recovered;
}

/**
 * Anthropic history requires an assistant message containing tool_use blocks to
 * be followed by a user message containing matching tool_result blocks. Return
 * every tool_use that would force repairToolPairing to synthesize a result.
 */
export function findUnpairedToolUses(messages: Array<{ role?: string; content?: unknown }>): MissingToolResult[] {
	const missing: MissingToolResult[] = [];
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg?.role !== "assistant") continue;
		const uses = toolUses(msg.content);
		if (uses.length === 0) continue;

		const next = messages[i + 1];
		const nextUserIndex = next?.role === "user" ? i + 1 : null;
		const resultIds = nextUserIndex == null ? new Set<string>() : toolResultIds(next.content);
		for (const use of uses) {
			if (!resultIds.has(use.id)) {
				missing.push({ id: use.id, toolName: use.name, assistantIndex: i, userIndex: nextUserIndex });
			}
		}
	}
	return missing;
}

export const LOST_TOOL_RESULT_TEXT =
	"Claude bridge: the result of this tool call was lost before the session was rebuilt "
	+ "(the turn was interrupted). Treat the call as failed — it may or may not have executed. "
	+ "Re-run the tool if its output is still needed.";

/**
 * Insert explicit, bridge-authored error results for every unpaired tool_use,
 * IN PLACE, before cc-session-io's repairToolPairing runs.
 *
 * repairToolPairing backfills with a bare "[no tool result recorded]" — a
 * placeholder the model reads as tool OUTPUT and continues to reason from.
 * An is_error result that says what happened and what to do turns a
 * silent correctness hazard into a recoverable failure.
 *
 * Results are prepended to the immediately following user message (tool_result
 * blocks must lead a user message), or a synthetic user message is inserted when none
 * follows. `missing` must come from findUnpairedToolUses on the same array.
 */
export function insertLostToolResultPlaceholders(
	messages: Array<{ role?: string; content?: unknown }>,
	missing: MissingToolResult[],
): void {
	const block = (id: string) => ({ type: "tool_result", tool_use_id: id, content: LOST_TOOL_RESULT_TEXT, is_error: true });
	const byAssistant = new Map<number, MissingToolResult[]>();
	for (const item of missing) {
		const group = byAssistant.get(item.assistantIndex) ?? [];
		group.push(item);
		byAssistant.set(item.assistantIndex, group);
	}
	// Descending order ensures that inserting a user message does not shift an index
	// for a group that is earlier in the array.
	for (const assistantIndex of [...byAssistant.keys()].sort((a, b) => b - a)) {
		const group = byAssistant.get(assistantIndex)!;
		const blocks = group.map((item) => block(item.id));
		const userIndex = group[0].userIndex;
		if (userIndex != null && messages[userIndex]?.role === "user") {
			const user = messages[userIndex] as { role: string; content: unknown };
			const existing = typeof user.content === "string"
				? (user.content ? [{ type: "text", text: user.content }] : [])
				: Array.isArray(user.content) ? user.content : [];
			user.content = [...blocks, ...existing];
		} else {
			messages.splice(assistantIndex + 1, 0, { role: "user", content: blocks });
		}
	}
}

export function summarizeMissingToolNames(missing: MissingToolResult[]): Array<{ name: string; count: number }> {
	const counts = new Map<string, number>();
	for (const item of missing) counts.set(item.toolName, (counts.get(item.toolName) ?? 0) + 1);
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([name, count]) => ({ name, count }));
}
