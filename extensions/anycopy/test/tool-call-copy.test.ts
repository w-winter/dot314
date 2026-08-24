import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	formatJsonForDisplay,
	formatToolCallResultForClipboard,
	resolveToolCallFromParents,
} from "../tool-call-copy.ts";

type Node = { entry: SessionEntry };
const entry = (value: Record<string, unknown>): SessionEntry => value as unknown as SessionEntry;
const assistant = entry({
	type: "message",
	id: "assistant",
	parentId: "root",
	message: {
		role: "assistant",
		content: [
			{ type: "toolCall", id: "call-a", name: "read", arguments: { path: "a.ts" } },
			{ type: "toolCall", id: "call-b", name: "grep", arguments: { pattern: "needle" } },
		],
	},
});
const nodes = new Map<string, Node>([["assistant", { entry: assistant }]]);

test("resolveToolCallFromParents matches the exact call id", () => {
	const result = entry({
		type: "message",
		id: "result",
		parentId: "assistant",
		message: { role: "toolResult", toolCallId: "call-b", toolName: "grep", content: [] },
	});
	assert.deepEqual(resolveToolCallFromParents(result, nodes), {
		name: "grep",
		arguments: { pattern: "needle" },
	});
});

test("tool result copy always includes its matching invocation and readable result", () => {
	const result = entry({
		type: "message",
		id: "result",
		parentId: "assistant",
		message: {
			role: "toolResult",
			toolCallId: "call-a",
			toolName: "read",
			content: [{ type: "text", text: "file body" }],
			details: { internal: true },
		},
	});
	assert.equal(
		formatToolCallResultForClipboard(result, nodes),
		`toolCall:\n\n{\n  "name": "read",\n  "arguments": {\n    "path": "a.ts"\n  }\n}\n\ntoolResult:\n\nfile body`,
	);
});

test("ordinary nodes do not acquire a synthetic tool invocation", () => {
	assert.equal(formatToolCallResultForClipboard(assistant, nodes), null);
});

test("tool call lookup handles parent chains deeper than thirty entries", () => {
	const deepNodes = new Map(nodes);
	let parentId = "assistant";
	for (let index = 0; index < 40; index += 1) {
		const id = `intermediate-${index}`;
		deepNodes.set(id, { entry: entry({ type: "custom", id, parentId }) });
		parentId = id;
	}
	const result = entry({
		type: "message",
		id: "deep-result",
		parentId,
		message: { role: "toolResult", toolCallId: "call-a", toolName: "read", content: [] },
	});

	assert.deepEqual(resolveToolCallFromParents(result, deepNodes), {
		name: "read",
		arguments: { path: "a.ts" },
	});
});

test("tool call lookup terminates on malformed parent cycles", () => {
	const cyclicNodes = new Map<string, Node>([
		["cycle-a", { entry: entry({ type: "custom", id: "cycle-a", parentId: "cycle-b" }) }],
		["cycle-b", { entry: entry({ type: "custom", id: "cycle-b", parentId: "cycle-a" }) }],
	]);
	const result = entry({
		type: "message",
		id: "result",
		parentId: "cycle-a",
		message: { role: "toolResult", toolCallId: "call-a", toolName: "read", content: [] },
	});

	assert.equal(resolveToolCallFromParents(result, cyclicNodes), null);
});

test("JSON display formatting degrades safely for unserializable values", () => {
	const cyclic: Record<string, unknown> = {};
	cyclic.self = cyclic;
	assert.equal(formatJsonForDisplay(cyclic), "[unserializable]");
});
