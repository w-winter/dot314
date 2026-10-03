// A small Claude Code transcript in the shape Claude Code 2.1.283 writes, and
// the Pi history that produced it: a prompt with its attachments, a turn whose
// thinking and tool_use records share one message id, the tool result with
// the reminder Claude Code adds after it, a final text, a second prompt, a
// tool call aborted by the user, and Claude Code's interrupt record after it.
// A read call that failed sits between: Claude Code stores a failed result as
// a string.
//
// Pi's side is what the bridge's stream records, not a copy of Claude Code's:
// a tool call's arguments went through tool-mapping.ts mapToolArgs, so bash
// carries the default timeout and read's file_path is Pi's path. All values
// are made up.

/** The query's tool name maps, as index.ts resolveMcpTools builds them. */
export const TOOL_NAMES = new Map([["bash", "mcp__custom-tools__bash"], ["read", "mcp__custom-tools__read"]]);
export const PI_TOOL_NAMES = new Map([["mcp__custom-tools__bash", "bash"], ["mcp__custom-tools__read", "read"]]);
export const BASH_TOOL = { name: "bash", description: "Run a command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } };
export const READ_TOOL = { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } };

const PROMPT_1 = "Run echo one, then reply DONE.";
const PROMPT_2 = "Run sleep 40.";

export const user = (content) => ({ role: "user", content, timestamp: 0 });
const claude = (stopReason, content) => ({ role: "assistant", provider: "pi-claude", api: "anthropic", model: "claude-haiku-4-5", stopReason, content, timestamp: 0 });
const thinking = (text, signature) => ({ type: "thinking", thinking: text, thinkingSignature: signature });
const bash = (id, command) => ({ type: "toolCall", id, name: "bash", arguments: { command, timeout: 120 } });
const read = (id, path) => ({ type: "toolCall", id, name: "read", arguments: { path } });
const result = (toolCallId, toolName, text, isError = false) => ({ role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError, timestamp: 0 });

/** Pi's history before the prompt that follows the abort. `result1` replaces
 *  the first tool result's text, and `signature1` the first thinking block's
 *  signature; `parallel` adds the turn with two parallel calls, whose first
 *  result's text `result4` replaces; `steer` adds the user message Pi sent
 *  while that turn's calls ran, after their results. `prompt2` lists the
 *  texts of the user messages in a row that Pi holds for the second prompt,
 *  each a text block as Pi's convertToLlm makes of an extension's message. */
export function piPriors({ prompt1 = PROMPT_1, result1 = "one\n", signature1 = "sig-a1", parallel = false, result4 = "two\n", steer, prompt2 } = {}) {
	return [
		user(prompt1),
		claude("toolUse", [thinking("Run it.", signature1), bash("toolu_fixture_1", "echo one")]),
		result("toolu_fixture_1", "bash", result1),
		claude("toolUse", [read("toolu_fixture_2", "notes.md")]),
		result("toolu_fixture_2", "read", "File not found: notes.md", true),
		...(parallel ? [
			claude("toolUse", [thinking("Both.", "sig-p1"), bash("toolu_fixture_4", "echo two"), read("toolu_fixture_5", "a.md")]),
			result("toolu_fixture_4", "bash", result4),
			result("toolu_fixture_5", "read", "alpha\n"),
			...(steer ? [user(steer)] : []),
		] : []),
		claude("stop", [thinking("Done.", "sig-a2"), { type: "text", text: "DONE" }]),
		...(prompt2 ? prompt2.map((text) => user([{ type: "text", text }])) : [user(PROMPT_2)]),
		claude("toolUse", [thinking("Sleep.", "sig-a3"), bash("toolu_fixture_3", "sleep 40")]),
		result("toolu_fixture_3", "bash", "Command aborted", true),
	];
}

/** The transcript's records, and the uuid of the record that ends the part
 *  Pi's history covers exactly (the reminder after the second prompt) and of
 *  the one after the first prompt's attachments. `offChainText` adds a text
 *  chunk of the first assistant message as a sibling record off the main
 *  chain, which Claude Code's loader stitches back into that message.
 *  `parallel` adds a turn with two parallel calls the way Claude Code writes
 *  one: the calls chained under one message id, each result parented to its
 *  own call, so only the last result is on the main chain. `steer` puts
 *  Claude Code's record of a user message sent while those calls ran, a
 *  queued_command attachment, off the main chain beneath the last call
 *  (`under: "call"`) or beneath the first, off-chain result
 *  (`under: "result"`). `tiedResult` parents the off-chain result on the
 *  record before the turn instead, so only its call's id ties it to it.
 *  `thinkingTail` ends every thinking block's text, as Claude often ends one
 *  with "\n\n" that Pi's copy can lack; `signature1` replaces the first
 *  thinking block's signature. `emptyResult1` makes the first tool's output
 *  that text of only whitespace, which Claude Code stores as its note that
 *  the call had no output. `prompt2` replaces the second prompt's text, as
 *  when the bridge joined several of Pi's user messages into it. */
export function nativeTranscript(sessionId, cwd, { offChainText, parallel = false, steer, tiedResult = false, thinkingTail = "", signature1 = "sig-a1", emptyResult1, prompt2 = PROMPT_2 } = {}) {
	const records = [];
	let next = 0;
	let parent = null;
	const base = () => ({ isSidechain: false, userType: "external", entrypoint: "sdk-ts", cwd, sessionId, version: "2.1.283", gitBranch: "main", timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, next)).toISOString() });
	const chain = (record) => {
		const entry = { parentUuid: parent, ...base(), ...record, uuid: `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}` };
		parent = entry.uuid;
		records.push(entry);
		return entry.uuid;
	};
	const meta = (record) => records.push({ ...record, sessionId });
	const reminder = (attachment, text, renderedRole = "system") => chain({ type: "attachment", attachment, rendered: [{ content: `<system-reminder>\n${text}\n</system-reminder>` }], renderedRole });
	const prompt = (text) => chain({ type: "user", promptId: "prompt-fixture", message: { role: "user", content: [{ type: "text", text }] }, permissionMode: "bypassPermissions", promptSource: "sdk" });
	const assistant = (id, block, stop) => chain({
		type: "assistant",
		requestId: `req_${id}`,
		message: { model: "claude-haiku-4-5-20251001", id, type: "message", role: "assistant", content: [block], stop_reason: stop, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
	});
	const think = (text, signature) => ({ type: "thinking", thinking: text + thinkingTail, signature });
	const toolResult = (block, extra) => chain({ type: "user", promptId: "prompt-fixture", message: { role: "user", content: [block] }, ...extra });
	// A record off the main chain: the chain's next record does not follow it.
	const sibling = (record) => {
		const entry = { ...base(), ...record, uuid: `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}` };
		records.push(entry);
		return entry.uuid;
	};

	meta({ type: "queue-operation", operation: "enqueue", timestamp: "2026-01-01T00:00:00.000Z" });
	prompt(PROMPT_1);
	reminder({ type: "environment", snapshot: { workingDirectory: cwd, platform: "darwin" } }, "# Environment\nWorking directory: (fixture)");
	reminder({ type: "model", identity: { modelId: "claude-haiku-4-5" }, text: "You are a fixture model." }, "You are a fixture model.");
	reminder({ type: "total_tokens_reminder", text: "<total_tokens>1000 tokens left</total_tokens>" }, "<total_tokens>1000 tokens left</total_tokens>");
	meta({ type: "atis-latch", atis: "" });
	const firstPromptEnd = reminder({ type: "date", date: "2026-01-01" }, "Today's date is 2026-01-01.");
	if (offChainText) {
		records.push({
			parentUuid: firstPromptEnd, ...base(), type: "assistant", requestId: "req_msg_fixture_a1", uuid: "00000000-0000-4000-8000-0000000000ff",
			message: { model: "claude-haiku-4-5-20251001", id: "msg_fixture_a1", type: "message", role: "assistant", content: [{ type: "text", text: offChainText }], stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
		});
	}
	assistant("msg_fixture_a1", think("Run it.", signature1), "tool_use");
	const a1 = assistant("msg_fixture_a1", { type: "tool_use", id: "toolu_fixture_1", name: "mcp__custom-tools__bash", input: { command: "echo one" }, caller: { type: "direct" } }, "tool_use");
	toolResult(
		{ tool_use_id: "toolu_fixture_1", type: "tool_result", content: emptyResult1 === undefined ? [{ type: "text", text: "one\n" }] : "(mcp__custom-tools__bash completed with no output)" },
		{ toolUseResult: [{ type: "text", text: emptyResult1 ?? "one\n" }], sourceToolAssistantUUID: a1 },
	);
	reminder({ type: "total_tokens_reminder", text: "<total_tokens>900 tokens left</total_tokens>" }, "<total_tokens>900 tokens left</total_tokens>");
	const r1 = assistant("msg_fixture_r1", { type: "tool_use", id: "toolu_fixture_2", name: "mcp__custom-tools__read", input: { file_path: "notes.md" }, caller: { type: "direct" } }, "tool_use");
	toolResult({ type: "tool_result", content: "File not found: notes.md", is_error: true, tool_use_id: "toolu_fixture_2" }, { toolUseResult: "Error: File not found: notes.md", sourceToolAssistantUUID: r1 });
	reminder({ type: "total_tokens_reminder", text: "<total_tokens>850 tokens left</total_tokens>" }, "<total_tokens>850 tokens left</total_tokens>");
	if (parallel) {
		const beforeTurn = parent;
		assistant("msg_fixture_p1", think("Both.", "sig-p1"), "tool_use");
		const p1 = assistant("msg_fixture_p1", { type: "tool_use", id: "toolu_fixture_4", name: "mcp__custom-tools__bash", input: { command: "echo two" }, caller: { type: "direct" } }, "tool_use");
		const p2 = assistant("msg_fixture_p1", { type: "tool_use", id: "toolu_fixture_5", name: "mcp__custom-tools__read", input: { file_path: "a.md" }, caller: { type: "direct" } }, "tool_use");
		const queued = (parentUuid) => sibling({
			parentUuid, type: "attachment", renderedRole: "system",
			attachment: { type: "queued_command", prompt: steer.text, source_uuid: "00000000-0000-4000-8000-0000000000aa", commandMode: "prompt", timestamp: base().timestamp },
			rendered: [{ content: `<system-reminder>\nThe user sent a new message while you were working:\n${steer.text}\n</system-reminder>` }],
		});
		if (steer?.under === "call") queued(p2);
		const offChainResult = sibling({
			parentUuid: tiedResult ? beforeTurn : p1, type: "user", promptId: "prompt-fixture",
			message: { role: "user", content: [{ tool_use_id: "toolu_fixture_4", type: "tool_result", content: [{ type: "text", text: "two\n" }] }] },
			toolUseResult: [{ type: "text", text: "two\n" }], sourceToolAssistantUUID: p1,
		});
		if (steer?.under === "result") queued(offChainResult);
		toolResult({ tool_use_id: "toolu_fixture_5", type: "tool_result", content: [{ type: "text", text: "alpha\n" }] }, { toolUseResult: [{ type: "text", text: "alpha\n" }], sourceToolAssistantUUID: p2 });
		reminder({ type: "total_tokens_reminder", text: "<total_tokens>825 tokens left</total_tokens>" }, "<total_tokens>825 tokens left</total_tokens>");
	}
	assistant("msg_fixture_a2", think("Done.", "sig-a2"), "end_turn");
	assistant("msg_fixture_a2", { type: "text", text: "DONE" }, "end_turn");
	meta({ type: "last-prompt", lastPrompt: PROMPT_1, leafUuid: parent });
	meta({ type: "queue-operation", operation: "enqueue", timestamp: "2026-01-01T00:01:00.000Z" });
	prompt(prompt2);
	const coveredEnd = reminder({ type: "total_tokens_reminder", text: "<total_tokens>800 tokens left</total_tokens>" }, "<total_tokens>800 tokens left</total_tokens>");
	assistant("msg_fixture_a3", think("Sleep.", "sig-a3"), "tool_use");
	const a3 = assistant("msg_fixture_a3", { type: "tool_use", id: "toolu_fixture_3", name: "mcp__custom-tools__bash", input: { command: "sleep 40" }, caller: { type: "direct" } }, "tool_use");
	toolResult(
		{ type: "tool_result", content: "The user doesn't want to proceed with this tool use. The tool use was rejected.", is_error: true, tool_use_id: "toolu_fixture_3" },
		{ toolUseResult: "User rejected tool use", toolDenialKind: "user-rejected", sourceToolAssistantUUID: a3 },
	);
	chain({ type: "user", promptId: "prompt-fixture", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] } });
	meta({ type: "last-prompt", lastPrompt: prompt2, leafUuid: parent });
	meta({ type: "mode", mode: "normal" });
	return { records, coveredEnd, firstPromptEnd };
}

/** The main chain of a transcript: the last chain record and its parents,
 *  root first. */
export function mainChain(records) {
	const chainTypes = new Set(["user", "assistant", "attachment", "system"]);
	const byUuid = new Map(records.filter((record) => chainTypes.has(record.type)).map((record) => [record.uuid, record]));
	const chain = [];
	for (let record = records.filter((entry) => chainTypes.has(entry.type)).at(-1); record; record = record.parentUuid ? byUuid.get(record.parentUuid) : undefined) chain.unshift(record);
	return chain;
}

/** What a record puts into a request. */
export const rendered = (record) => ({ type: record.type, message: record.message, attachment: record.attachment, rendered: record.rendered });

/** An imported record's content by block shape. */
export const shape = (record) => [record.type, typeof record.message.content === "string"
	? record.message.content
	: record.message.content.map((block) => block.type === "tool_result" ? `tool_result:${block.tool_use_id}` : block.type === "tool_use" ? `tool_use:${block.id}` : block.type)];
