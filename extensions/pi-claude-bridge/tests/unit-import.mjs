#!/usr/bin/env node
// Unit tests for pi→Anthropic message conversion (convert.ts).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeToolId, convertPiMessages } from "../src/convert.js";
import { findUnpairedToolUses, recoverLaterToolResults } from "../src/tool-pairing-audit.js";

/** Shorthand: convert pi messages and return just the anthropic messages. */
function convert(messages, customToolNameToSdk) {
	return convertPiMessages(messages, customToolNameToSdk).anthropicMessages;
}

// --- Tests ---

describe("tool ID sanitization", () => {
	it("Kimi-style IDs with dots and colons", () => {
		const msgs = [
			{ role: "assistant", content: [{ type: "toolCall", id: "functions.bash:0", name: "bash", arguments: { cmd: "ls" } }] },
			{ role: "toolResult", toolCallId: "functions.bash:0", content: "file.txt" },
		];
		const result = convert(msgs);
		assert.equal(result[0].content[0].id, "functions_bash_0");
		assert.equal(result[1].content[0].tool_use_id, "functions_bash_0");
	});

	it("IDs with spaces and special chars", () => {
		const msgs = [
			{ role: "assistant", content: [{ type: "toolCall", id: "tool call#1@foo", name: "bash", arguments: {} }] },
			{ role: "toolResult", toolCallId: "tool call#1@foo", content: "ok" },
		];
		const result = convert(msgs);
		assert.equal(result[0].content[0].id, "tool_call_1_foo");
		assert.equal(result[1].content[0].tool_use_id, "tool_call_1_foo");
	});

	it("already-valid Anthropic IDs pass through unchanged", () => {
		const msgs = [
			{ role: "assistant", content: [{ type: "toolCall", id: "toolu_abc123-XYZ", name: "read", arguments: {} }] },
			{ role: "toolResult", toolCallId: "toolu_abc123-XYZ", content: "data" },
		];
		const result = convert(msgs);
		assert.equal(result[0].content[0].id, "toolu_abc123-XYZ");
		assert.equal(result[1].content[0].tool_use_id, "toolu_abc123-XYZ");
	});

	it("tool_use and tool_result IDs stay paired after sanitization", () => {
		const ids = ["fn.read:0", "fn.write:1", "fn.bash:2"];
		const msgs = [];
		for (const id of ids) {
			msgs.push({ role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: {} }] });
			msgs.push({ role: "toolResult", toolCallId: id, content: "ok" });
		}
		const result = convert(msgs);
		for (let i = 0; i < ids.length; i++) {
			const useId = result[i * 2].content[0].id;
			const resultId = result[i * 2 + 1].content[0].tool_use_id;
			assert.equal(useId, resultId, `pair ${i}: tool_use=${useId} tool_result=${resultId}`);
		}
	});
});

describe("empty text block filtering", () => {
	it("assistant with empty text + toolCall → only toolCall", () => {
		const msgs = [
			{ role: "assistant", content: [
				{ type: "text", text: "" },
				{ type: "toolCall", id: "abc", name: "read", arguments: {} },
			]},
		];
		const result = convert(msgs);
		assert.equal(result.length, 1);
		assert.equal(result[0].content.length, 1);
		assert.equal(result[0].content[0].type, "tool_use");
	});

	it("assistant with only empty text → placeholder", () => {
		const msgs = [
			{ role: "assistant", content: [{ type: "text", text: "" }] },
		];
		const result = convert(msgs);
		assert.equal(result.length, 1);
		assert.equal(result[0].content[0].text, "[incompatible content omitted]");
	});

	it("assistant with non-empty text → preserved", () => {
		const msgs = [
			{ role: "assistant", content: [{ type: "text", text: "Hello world" }] },
		];
		const result = convert(msgs);
		assert.equal(result.length, 1);
		assert.equal(result[0].content[0].text, "Hello world");
	});

	it("assistant with multiple text blocks, some empty", () => {
		const msgs = [
			{ role: "assistant", content: [
				{ type: "text", text: "" },
				{ type: "text", text: "real content" },
				{ type: "text", text: "" },
			]},
		];
		const result = convert(msgs);
		assert.equal(result.length, 1);
		assert.equal(result[0].content.length, 1);
		assert.equal(result[0].content[0].text, "real content");
	});
});

describe("thinking block filtering", () => {
	it("non-Anthropic provider thinking blocks dropped", () => {
		const msgs = [
			{ role: "assistant", content: [
				{ type: "thinking", thinking: "let me think..." },
				{ type: "text", text: "answer" },
			]},
		];
		const result = convert(msgs);
		assert.equal(result.length, 1);
		assert.equal(result[0].content.length, 1);
		assert.equal(result[0].content[0].type, "text");
	});

	it("canonical pi-claude thinking with signature is preserved", () => {
		const msgs = [
			{ role: "assistant", provider: "pi-claude", content: [
				{ type: "thinking", thinking: "reasoning...", thinkingSignature: "sig123" },
				{ type: "text", text: "answer" },
			]},
		];
		const result = convert(msgs);
		assert.equal(result[0].content.length, 2);
		assert.equal(result[0].content[0].type, "thinking");
		assert.equal(result[0].content[0].signature, "sig123");
	});

	it("Anthropic provider via api field", () => {
		const msgs = [
			{ role: "assistant", api: "anthropic", content: [
				{ type: "thinking", thinking: "hmm", thinkingSignature: "sig456" },
				{ type: "text", text: "done" },
			]},
		];
		const result = convert(msgs);
		assert.equal(result[0].content.length, 2);
		assert.equal(result[0].content[0].type, "thinking");
	});

	it("Anthropic provider thinking WITHOUT signature → dropped", () => {
		const msgs = [
			{ role: "assistant", provider: "pi-claude", content: [
				{ type: "thinking", thinking: "no sig" },
				{ type: "text", text: "answer" },
			]},
		];
		const result = convert(msgs);
		assert.equal(result[0].content.length, 1);
		assert.equal(result[0].content[0].type, "text");
	});

	it("assistant with only thinking (non-Anthropic) → placeholder", () => {
		const msgs = [
			{ role: "assistant", content: [
				{ type: "thinking", thinking: "deep thoughts" },
			]},
		];
		const result = convert(msgs);
		assert.equal(result.length, 1);
		assert.equal(result[0].content[0].text, "[incompatible content omitted]");
	});

	it("Claude redacted thinking → redacted_thinking with its data", () => {
		const result = convert([
			{ role: "assistant", provider: "pi-claude", stopReason: "stop", content: [
				{ type: "thinking", thinking: "[Reasoning redacted]", thinkingSignature: "opaque-payload", redacted: true },
				{ type: "text", text: "answer" },
			] },
		]);
		assert.deepEqual(result[0].content, [
			{ type: "redacted_thinking", data: "opaque-payload" },
			{ type: "text", text: "answer" },
		]);
	});

	it("non-Claude assistant provider provenance is preserved", () => {
		const result = convert([
			{ role: "assistant", provider: "openai", model: "gpt-test", content: [{ type: "text", text: "hello" }] },
		]);
		assert.equal(result[0].content[0].text, "[Prior Pi assistant response from openai/gpt-test]\n");
		assert.equal(result[0].content[1].text, "hello");
	});
});

// A rebuild's import (noteUnreplayableTurns). The note in the written session
// is owned by the REBUILD tests in unit-sync-shared-session.mjs.
describe("latest assistant thinking replay", () => {
	const rebuildConvert = (messages) => convertPiMessages(messages, undefined, { noteUnreplayableTurns: true }).anthropicMessages;
	/** A note's text, whether it is a string or a content array. */
	const noteText = (content) => typeof content === "string" ? content : content.map((block) => block.text ?? "").join("\n");
	const history = [
		{ role: "user", content: "start" },
		{ role: "assistant", provider: "pi-claude", stopReason: "toolUse", content: [
			{ type: "thinking", thinking: "step one", thinkingSignature: "sig1" },
			{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a" } },
		] },
		{ role: "toolResult", toolCallId: "t1", toolName: "read", content: "body" },
	];
	const cutTail = (provider = "pi-claude") => ({ role: "assistant", provider, stopReason: "toolUse", content: [
		{ type: "thinking", thinking: "settled", thinkingSignature: "sig2" },
		{ type: "thinking", thinking: "settled too", thinkingSignature: "sig3" },
		{ type: "thinking", thinking: "cut off mid-thought" },
		{ type: "text", text: "reading b" },
		{ type: "toolCall", id: "t2", name: "read", arguments: { path: "b" } },
	] });
	const tailResult = { role: "toolResult", toolCallId: "t2", toolName: "read", content: "b body" };

	it("keeps a historical Claude assistant with only its signed thinking blocks", () => {
		const result = rebuildConvert([...history, cutTail(), tailResult,
			{ role: "assistant", provider: "pi-claude", stopReason: "stop", content: [{ type: "text", text: "done" }] }]);
		assert.deepEqual(result[3], { role: "assistant", content: [
			{ type: "thinking", thinking: "settled", signature: "sig2" },
			{ type: "thinking", thinking: "settled too", signature: "sig3" },
			{ type: "text", text: "reading b" },
			{ type: "tool_use", id: "t2", name: "Read", input: { path: "b" } },
		] });
		assert.deepEqual(result[4].content.map((block) => block.tool_use_id), ["t2"]);
		assert.equal(result.length, 6);
	});

	it("keeps a latest Claude assistant whose thinking blocks are all signed or redacted", () => {
		const signed = cutTail();
		signed.content = signed.content.filter((block) => block.type !== "thinking" || block.thinkingSignature);
		signed.content.unshift({ type: "thinking", thinking: "[Reasoning redacted]", thinkingSignature: "opaque-payload", redacted: true });
		const result = rebuildConvert([...history, signed, tailResult]);
		assert.deepEqual(result[3].content.map((block) => block.type), ["redacted_thinking", "thinking", "thinking", "text", "tool_use"]);
		assert.deepEqual(result[4].content.map((block) => block.tool_use_id), ["t2"]);
	});

	it("keeps a latest assistant from a non-Claude provider", () => {
		const result = rebuildConvert([...history, cutTail("openai"), tailResult]);
		assert.deepEqual(result[3].content.map((block) => block.type), ["text", "text", "tool_use"]);
		assert.equal(result[3].content[1].text, "reading b");
		assert.deepEqual(result[4].content.map((block) => block.tool_use_id), ["t2"]);
	});

	it("notes a text-only latest turn with its text", () => {
		const textOnly = { role: "assistant", provider: "pi-claude", stopReason: "stop", content: [
			{ type: "thinking", thinking: "cut off mid-thought" },
			{ type: "text", text: "The file has two sections." },
		] };
		const result = rebuildConvert([...history, textOnly]);
		assert.equal(result.length, 4);
		assert.equal(result[3].role, "user");
		assert.match(noteText(result[3].content), /could not be replayed as-is/);
		assert.ok(noteText(result[3].content).includes("The file has two sections."), noteText(result[3].content));
	});

	it("carries a tool result's image in the note and keeps its error flag", () => {
		const failed = { role: "toolResult", toolCallId: "t2", toolName: "read", isError: true, content: [
			{ type: "text", text: "partial read" },
			{ type: "image", data: "aGk=", mimeType: "image/png" },
			{ type: "image", mimeType: "image/jpeg" },
		] };
		const note = rebuildConvert([...history, cutTail(), failed]).at(-1).content;
		assert.deepEqual(note.map((block) => block.type), ["text", "image", "text"]);
		assert.ok(note[0].text.endsWith("Call 1 returned an error:\npartial read"), note[0].text);
		assert.deepEqual(note[1], { type: "image", source: { type: "base64", media_type: "image/png", data: "aGk=" } });
		assert.equal(note[2].text, "[image/jpeg image, not carried in this note]", "an image without data keeps a marker");
	});

	it("lists the turn's text and calls in order, then the results in the order they came back", () => {
		const turn = { role: "assistant", provider: "pi-claude", stopReason: "toolUse", content: [
			{ type: "thinking", thinking: "cut off mid-thought" },
			{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a" } },
			{ type: "text", text: "Now the second file." },
			{ type: "toolCall", id: "c2", name: "read", arguments: { path: "b" } },
			{ type: "toolCall", id: "c3", name: "read", arguments: { path: "c" } },
		] };
		const result2 = { role: "toolResult", toolCallId: "c2", toolName: "read", content: "B body" };
		const result1 = { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "A body" }] };
		const note = noteText(rebuildConvert([...history, turn, result2, result1]).at(-1).content);
		const at = (part) => {
			const index = note.indexOf(part);
			assert.ok(index >= 0, `${part} is missing from: ${note}`);
			return index;
		};
		// The turn's own order, then the results in the order they came back.
		const order = ['{"path":"a"}', "Now the second file.", '{"path":"b"}', '{"path":"c"}', "B body", "A body"].map(at);
		assert.deepEqual(order, [...order].sort((a, b) => a - b), note);
		// Each call has a number, each result names its call, and a call with no result says so.
		for (const part of ['Call 1: you called read with arguments {"path":"a"}.', "Call 2 returned:\nB body", "Call 1 returned:\nA body"]) at(part);
		assert.ok(note.endsWith("Call 3: no result was recorded."), note);
	});

	it("notes each trailing turn until the latest assistant replays exactly", () => {
		const earlierCut = cutTail();
		const laterCut = { role: "assistant", provider: "pi-claude", stopReason: "stop", content: [
			{ type: "thinking", thinking: "also cut" },
			{ type: "text", text: "b is empty" },
		] };
		const result = rebuildConvert([...history, earlierCut, tailResult, laterCut]);
		assert.deepEqual(result.map((message) => message.role), ["user", "assistant", "user", "user", "user"]);
		assert.deepEqual(result[1].content[0], { type: "thinking", thinking: "step one", signature: "sig1" });
		assert.ok(noteText(result[3].content).includes("b body") && noteText(result[4].content).includes("b is empty"));
	});
});

describe("message structure", () => {
	it("aborted and errored assistant turns and their tool results are not imported", () => {
		const msgs = [
			{ role: "user", content: "before" },
			{ role: "assistant", stopReason: "aborted", content: [
				{ type: "toolCall", id: "toolu_aborted", name: "bash", arguments: {}, partialJson: "" },
			] },
			{ role: "toolResult", toolCallId: "toolu_aborted", content: "orphaned" },
			{ role: "assistant", stopReason: "error", content: [] },
			{ role: "user", content: "after" },
		];
		assert.deepEqual(convert(msgs), [
			{ role: "user", content: "before" },
			{ role: "user", content: "after" },
		]);
	});

	it("filters skipped-call results from assistant lookahead and consecutive result groups", () => {
		const aborted = { role: "assistant", stopReason: "aborted", content: [
			{ type: "toolCall", id: "a", name: "read", arguments: {} },
		] };
		const successful = { role: "assistant", stopReason: "toolUse", content: [
			{ type: "toolCall", id: "b", name: "read", arguments: {} },
		] };
		const resultA = { role: "toolResult", toolCallId: "a", content: "must be omitted" };
		const resultB = { role: "toolResult", toolCallId: "b", content: "kept" };

		assert.deepEqual(convert([aborted, successful, resultB, resultA])[1].content.map((block) => block.tool_use_id), ["b"]);
		assert.deepEqual(convert([aborted, { role: "toolResult", toolCallId: "other", content: "kept" }, resultA])[0].content.map((block) => block.tool_use_id), ["other"]);
	});

	it("toolResult → user with tool_result content", () => {
		const msgs = [
			{ role: "toolResult", toolCallId: "id1", content: "result text", isError: false },
		];
		const result = convert(msgs);
		assert.equal(result[0].role, "user");
		assert.equal(result[0].content[0].type, "tool_result");
		assert.equal(result[0].content[0].tool_use_id, "id1");
		assert.equal(result[0].content[0].content, "result text");
		assert.equal(result[0].content[0].is_error, false);
	});

	it("toolResult with isError=true", () => {
		const msgs = [
			{ role: "toolResult", toolCallId: "id1", content: "oh no", isError: true },
		];
		assert.equal(convert(msgs)[0].content[0].is_error, true);
	});

	it("multiple tool results in sequence", () => {
		const msgs = [
			{ role: "assistant", content: [
				{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a.txt" } },
				{ type: "toolCall", id: "t2", name: "read", arguments: { path: "b.txt" } },
			]},
			{ role: "toolResult", toolCallId: "t1", content: "content a" },
			{ role: "toolResult", toolCallId: "t2", content: "content b" },
		];
		const result = convert(msgs);
		assert.equal(result.length, 2);
		assert.equal(result[0].role, "assistant");
		assert.equal(result[0].content.length, 2);
		assert.equal(result[1].role, "user");
		assert.equal(result[1].content[0].tool_use_id, "t1");
		assert.equal(result[1].content[1].tool_use_id, "t2");
	});

	it("grouped parallel tool results satisfy pairing audit", () => {
		const msgs = [
			{ role: "assistant", content: [
				{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a.txt" } },
				{ type: "toolCall", id: "t2", name: "read", arguments: { path: "b.txt" } },
			] },
			{ role: "toolResult", toolCallId: "t1", content: "content a" },
			{ role: "toolResult", toolCallId: "t2", content: "content b" },
		];
		const result = convert(msgs);
		assert.equal(result[1].content.length, 2);
		assert.deepEqual(result[1].content.map((block) => block.tool_use_id), ["t1", "t2"]);
		assert.deepEqual(findUnpairedToolUses(result), []);
	});

	it("interleaved user prompts after a tool-use assistant are replayed after grouped tool results", () => {
		const msgs = [
			{ role: "assistant", content: [
				{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a.txt" } },
				{ type: "toolCall", id: "t2", name: "read", arguments: { path: "b.txt" } },
			] },
			{ role: "toolResult", toolCallId: "t1", content: "content a" },
			{ role: "user", content: "please continue after tools" },
			{ role: "toolResult", toolCallId: "t2", content: "content b" },
		];

		const result = convert(msgs);
		assert.equal(result.length, 3);
		assert.deepEqual(result[1].content.map((block) => block.tool_use_id), ["t1", "t2"]);
		assert.equal(result[2].role, "user");
		assert.equal(result[2].content, "please continue after tools");
		assert.deepEqual(findUnpairedToolUses(result), []);
	});

	it("recovers real sibling results when a steer splits one parallel batch across later turns", () => {
		const msgs = [
			{ role: "assistant", content: [
				{ type: "toolCall", id: "t1", name: "SlowTool", arguments: { seconds: 3 } },
				{ type: "toolCall", id: "t2", name: "SlowTool", arguments: { seconds: 4 } },
				{ type: "toolCall", id: "t3", name: "SlowTool", arguments: { seconds: 5 } },
			] },
			{ role: "toolResult", toolCallId: "t1", content: "first" },
			{ role: "user", content: "steer" },
			{ role: "assistant", content: [{ type: "toolCall", id: "t2", name: "SlowTool", arguments: { seconds: 4 } }] },
			{ role: "toolResult", toolCallId: "t2", content: "second" },
			{ role: "assistant", content: [{ type: "toolCall", id: "t3", name: "SlowTool", arguments: { seconds: 5 } }] },
			{ role: "toolResult", toolCallId: "t3", content: "third" },
		];

		const result = convert(msgs);
		assert.deepEqual(findUnpairedToolUses(result).map((item) => item.id), ["t2", "t3"]);
		assert.deepEqual(
			recoverLaterToolResults(result).map((item) => item.id),
			["t2", "t3"],
		);
		assert.deepEqual(findUnpairedToolUses(result), []);
		assert.deepEqual(
			result[1].content.map((block) => block.tool_use_id),
			["t1", "t2", "t3"],
		);
		assert.equal(result[1].content[1].content, "second");
		assert.equal(result[1].content[2].content, "third");
	});

	it("inserts recovered tool_results BEFORE text blocks in the target user message", () => {
		// The target user message already mixes a delivered tool_result with
		// interleaved steer text. The recovered sibling result must land in the
		// leading tool_result run, not after the text (Anthropic convention).
		const messages = [
			{ role: "assistant", content: [
				{ type: "tool_use", id: "t1", name: "SlowTool", input: {} },
				{ type: "tool_use", id: "t2", name: "SlowTool", input: {} },
			] },
			{ role: "user", content: [
				{ type: "tool_result", tool_use_id: "t1", content: "first" },
				{ type: "text", text: "steer text" },
			] },
			{ role: "assistant", content: [{ type: "tool_use", id: "t2", name: "SlowTool", input: {} }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "second" }] },
		];

		assert.deepEqual(recoverLaterToolResults(messages).map((item) => item.id), ["t2"]);
		assert.deepEqual(
			messages[1].content.map((block) => block.type),
			["tool_result", "tool_result", "text"],
		);
		assert.deepEqual(
			messages[1].content.filter((block) => block.type === "tool_result").map((block) => block.tool_use_id),
			["t1", "t2"],
		);
	});

	it("converts a plain-string target user message and leads with the recovered result", () => {
		const messages = [
			{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "SlowTool", input: {} }] },
			{ role: "user", content: "steer only" },
			{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "SlowTool", input: {} }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "late" }] },
		];

		assert.deepEqual(recoverLaterToolResults(messages).map((item) => item.id), ["t1"]);
		assert.deepEqual(messages[1].content.map((block) => block.type), ["tool_result", "text"]);
		assert.equal(messages[1].content[1].text, "steer only");
	});

	it("mixed conversation: user → assistant(tool) → toolResult → assistant(text)", () => {
		const msgs = [
			{ role: "user", content: "read file.txt" },
			{ role: "assistant", content: [
				{ type: "toolCall", id: "call1", name: "read", arguments: { path: "file.txt" } },
			]},
			{ role: "toolResult", toolCallId: "call1", content: "hello world" },
			{ role: "assistant", content: [{ type: "text", text: "The file says hello world." }] },
		];
		const result = convert(msgs);
		assert.equal(result.length, 4);
		assert.equal(result[0].role, "user");
		assert.equal(result[0].content, "read file.txt");
		assert.equal(result[1].role, "assistant");
		assert.equal(result[1].content[0].type, "tool_use");
		assert.equal(result[1].content[0].name, "Read");
		assert.equal(result[2].role, "user");
		assert.equal(result[2].content[0].type, "tool_result");
		assert.equal(result[3].role, "assistant");
		assert.equal(result[3].content[0].text, "The file says hello world.");
	});

	it("user string content", () => {
		assert.equal(convert([{ role: "user", content: "hello" }])[0].content, "hello");
	});

	it("user empty string → [empty]", () => {
		assert.equal(convert([{ role: "user", content: "" }])[0].content, "[empty]");
	});

	it("user with array content containing text blocks", () => {
		const result = convert([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
		assert.deepEqual(result[0].content, [{ type: "text", text: "hi" }]);
	});

	it("user with empty text blocks in array → [image] fallback", () => {
		assert.equal(convert([{ role: "user", content: [{ type: "text", text: "" }] }])[0].content, "[image]");
	});

	it("tool name mapping: pi names → SDK names", () => {
		const msgs = [
			{ role: "assistant", content: [
				{ type: "toolCall", id: "a", name: "read", arguments: {} },
				{ type: "toolCall", id: "b", name: "bash", arguments: {} },
			]},
		];
		const result = convert(msgs);
		assert.equal(result[0].content[0].name, "Read");
		assert.equal(result[0].content[1].name, "Bash");
	});

	it("toolResult with array content extracts text", () => {
		const msgs = [
			{ role: "toolResult", toolCallId: "x", content: [
				{ type: "text", text: "line 1" },
				{ type: "text", text: "line 2" },
			]},
		];
		assert.equal(convert(msgs)[0].content[0].content, "line 1\nline 2");
	});

	it("toolResult with image content preserves image blocks", () => {
		const result = convert([{ role: "toolResult", toolCallId: "x", content: [
			{ type: "text", text: "screenshot" },
			{ type: "image", mimeType: "image/png", data: "abc123" },
		] }]);
		const content = result[0].content[0].content;
		assert.equal(Array.isArray(content), true);
		assert.equal(content[0].type, "text");
		assert.equal(content[1].type, "image");
		assert.equal(content[1].source.media_type, "image/png");
	});
});
