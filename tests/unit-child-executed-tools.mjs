// A claude.ai connector tool executes INSIDE the claude child. It must stay out
// of the Pi stream on every emission path while remaining observable to audit.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { noteChildExecutedToolResults, processAssistantMessage, processStreamEvent } from "../src/index.ts";
import { isChildExecutedTool, isChildInternalTool, isConnectorTool } from "../src/connectors.ts";
import { QueryContext, ctx, resetStack } from "../src/query-state.ts";

const model = {
	api: "claude-bridge",
	provider: "pi-claude",
	id: "claude-haiku-4-5",
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const CONNECTOR_TOOL = "mcp__claude_ai_Slack__slack_read_user_profile";

function installFakeStream() {
	const events = [];
	ctx().currentPiStream = {
		push(event) { events.push(event); },
		end(result) { events.push({ type: "stream_end", result }); },
	};
	return events;
}

function streamEvent(event) {
	return { type: "stream_event", event };
}

describe("child-executed tool classification", () => {
	it("claims every claude.ai connector namespace", () => {
		assert.equal(isChildExecutedTool(CONNECTOR_TOOL), true);
		assert.equal(isChildExecutedTool("mcp__claude_ai_Atlassian__getConfluencePage"), true);
		// Namespace-only, so an org-custom connector nobody has enumerated still counts.
		assert.equal(isChildExecutedTool("mcp__claude_ai_Some_Org_Thing__whatever"), true);
	});

	it("claims Claude Code's in-process meta-tools by exact name (kendex#980)", () => {
		for (const name of ["ToolSearch", "ScheduleWakeup"]) {
			assert.equal(isChildExecutedTool(name), true, name);
			assert.equal(isChildInternalTool(name), true, name);
			// A child built-in is NOT a connector: it must stay out of every
			// connector-only path (audit trail, write classification).
			assert.equal(isConnectorTool(name), false, name);
		}
		assert.equal(isConnectorTool(CONNECTOR_TOOL), true);
		assert.equal(isChildInternalTool(CONNECTOR_TOOL), false);
	});

	it("does NOT claim the MCP-resource built-ins, under either SDK spelling (kendex#1007)", () => {
		// The SDK renames these between the request side and the stream side
		// (`ReadMcpResource` → `ReadMcpResourceTool`), which is how the old
		// request-side entries sat dead in the set. Both spellings are excluded
		// on purpose: a resource read stays a mirrored, Pi-visible tool call —
		// the mirror is the audit surface for out-of-process hosts.
		for (const name of ["ListMcpResources", "ReadMcpResource", "ListMcpResourcesTool", "ReadMcpResourceTool"]) {
			assert.equal(isChildInternalTool(name), false, name);
			assert.equal(isChildExecutedTool(name), false, name);
			assert.equal(isConnectorTool(name), false, name);
		}
	});

	it("claims nothing else — a Pi tool mismatch must still surface as a dispatcher error", () => {
		assert.equal(isChildExecutedTool("bash"), false);
		assert.equal(isChildExecutedTool("mcp__custom-tools__read"), false);
		// A different MCP server is not a claude.ai connector.
		assert.equal(isChildExecutedTool("mcp__claude_code_docs__search"), false);
		assert.equal(isChildExecutedTool(undefined), false);
	});

	it("matches child-internal names exactly, never as a prefix, suffix, or case variant", () => {
		// "ToolSearchTool" keeps the exact-name alias rule from being changed with
		// suffix matching: an SDK alias earns membership by being LISTED, never
		// by resembling a listed name.
		for (const name of ["ToolSearchX", "mytoolsearch", "toolsearch", "XToolSearch", "ToolSearch2", "ToolSearchTool", "listmcpresources", "ReadMcpResourceToolX"]) {
			assert.equal(isChildExecutedTool(name), false, name);
			assert.equal(isChildInternalTool(name), false, name);
		}
	});
});

describe("child-executed tools are never mirrored as Pi tool calls", () => {
	beforeEach(() => resetStack());

	it("skips a streamed connector tool_use and leaves the turn open", () => {
		const c = ctx();
		c.resetTurnState(model);
		const events = installFakeStream();

		processStreamEvent(streamEvent({
			type: "content_block_start",
			index: 0,
			content_block: { type: "tool_use", id: "toolu_conn", name: CONNECTOR_TOOL, input: {} },
		}), new Map(), model);
		processStreamEvent(streamEvent({
			type: "content_block_delta",
			index: 0,
			delta: { type: "input_json_delta", partial_json: "{\"user_id\":\"U1\"}" },
		}), new Map(), model);
		processStreamEvent(streamEvent({ type: "content_block_stop", index: 0 }), new Map(), model);

		assert.equal(c.turnBlocks.length, 0, "connector call must not become a Pi content block");
		assert.equal(c.turnSawToolCall, false, "connector call is not a Pi turn boundary");
		assert.deepEqual(c.turnToolCallIds, [], "Pi owes no result, so nothing is expected back");
		assert.equal(c.currentPiStream !== null, true, "the Pi turn must stay open");
		assert.deepEqual(events.map((e) => e.type), ["start"]);
		assert.equal(c.childExecutedToolCalls.get("toolu_conn"), CONNECTOR_TOOL);
	});

	it("does not end the turn on a message_stop that only saw a connector call", () => {
		const c = ctx();
		c.resetTurnState(model);
		installFakeStream();

		processStreamEvent(streamEvent({
			type: "content_block_start",
			index: 0,
			content_block: { type: "tool_use", id: "toolu_conn", name: CONNECTOR_TOOL, input: {} },
		}), new Map(), model);
		processStreamEvent(streamEvent({ type: "message_stop" }), new Map(), model);

		assert.equal(c.currentPiStream !== null, true, "ending here would strand the answer text");
	});

	it("keeps streaming the answer text into the same Pi message after the connector call", () => {
		const c = ctx();
		c.resetTurnState(model);
		installFakeStream();

		processStreamEvent(streamEvent({
			type: "content_block_start",
			index: 0,
			content_block: { type: "tool_use", id: "toolu_conn", name: CONNECTOR_TOOL, input: {} },
		}), new Map(), model);
		processStreamEvent(streamEvent({ type: "content_block_stop", index: 0 }), new Map(), model);
		// The child's follow-up assistant message reuses index 0 for its text block.
		processStreamEvent(streamEvent({ type: "message_start", message: { model: "claude-haiku-4-5" } }), new Map(), model);
		processStreamEvent(streamEvent({
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		}), new Map(), model);
		processStreamEvent(streamEvent({
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: "Brad Mahaffey" },
		}), new Map(), model);
		processStreamEvent(streamEvent({ type: "content_block_stop", index: 0 }), new Map(), model);

		assert.equal(c.turnBlocks.length, 1);
		assert.equal(c.turnBlocks[0].type, "text");
		assert.equal(c.turnBlocks[0].text, "Brad Mahaffey", "a stale skip-index must not swallow real text");
	});

	it("skips a connector tool_use on the assistant-boundary path without ending the turn", () => {
		const c = ctx();
		c.resetTurnState(model);
		installFakeStream();
		c.turnSawStreamEvent = true;

		processAssistantMessage({
			type: "assistant",
			message: {
				content: [{ type: "tool_use", id: "toolu_conn", name: CONNECTOR_TOOL, input: { user_id: "U1" } }],
			},
		}, model, new Map());

		assert.equal(c.turnBlocks.length, 0);
		assert.equal(c.turnSawToolCall, false);
		assert.equal(c.currentPiStream !== null, true, "no Pi tool call means no turn boundary");
		assert.equal(c.childExecutedToolCalls.get("toolu_conn"), CONNECTOR_TOOL);
	});

	it("skips a connector tool_use on the no-stream-events fallback path", () => {
		const c = ctx();
		c.resetTurnState(model);
		installFakeStream();

		processAssistantMessage({
			type: "assistant",
			message: {
				content: [
					{ type: "text", text: "checking" },
					{ type: "tool_use", id: "toolu_conn", name: CONNECTOR_TOOL, input: { user_id: "U1" } },
				],
			},
		}, model, new Map());

		assert.deepEqual(c.turnBlocks.map((b) => b.type), ["text"]);
		assert.equal(c.turnSawToolCall, false);
		assert.equal(c.currentPiStream !== null, true);
	});

	it("still mirrors a Pi tool call alongside a connector call in the same message", () => {
		const c = ctx();
		c.resetTurnState(model);
		installFakeStream();
		c.turnSawStreamEvent = true;

		processAssistantMessage({
			type: "assistant",
			message: {
				content: [
					{ type: "tool_use", id: "toolu_conn", name: CONNECTOR_TOOL, input: {} },
					{ type: "tool_use", id: "toolu_pi", name: "mcp__custom-tools__read", input: { file_path: "README.md" } },
				],
			},
		}, model, new Map([["mcp__custom-tools__read", "read"]]));

		assert.equal(c.turnBlocks.length, 1, "only the Pi tool call is mirrored");
		assert.equal(c.turnBlocks[0].name, "read");
		assert.deepEqual(c.turnToolCallIds, ["toolu_pi"]);
		// The boundary arms the grace timer instead of ending the turn directly
		// and lets message_stop end it, so message_delta's usage can land first.
		assert.equal(c.turnSawToolCall, true);
		assert.ok(c.scheduledToolUseEnd, "a real Pi tool call arms the deferred turn end");
		processStreamEvent(streamEvent({ type: "message_stop" }), new Map(), model);
		assert.equal(c.currentPiStream, null, "message_stop ends the tool-use turn");
		assert.equal(c.scheduledToolUseEnd, null, "grace timer disarmed at turn end");
	});

	it("still enters a streamed connector call into the connector-call audit", () => {
		const c = ctx();
		c.resetTurnState(model);
		installFakeStream();

		processStreamEvent(streamEvent({
			type: "content_block_start",
			index: 0,
			content_block: { type: "tool_use", id: "toolu_conn", name: CONNECTOR_TOOL, input: {} },
		}), new Map(), model);

		assert.equal(c.connectorCallAudit.has("toolu_conn"), true, "a connector call is auditable");
		assert.equal(c.connectorCallAudit.get("toolu_conn").name, CONNECTOR_TOOL);
	});

	it("skips a streamed ToolSearch without mirroring, queuing, or auditing it (kendex#980)", () => {
		const c = ctx();
		c.resetTurnState(model);
		const events = installFakeStream();

		processStreamEvent(streamEvent({
			type: "content_block_start",
			index: 0,
			content_block: { type: "tool_use", id: "toolu_ts", name: "ToolSearch", input: {} },
		}), new Map(), model);
		processStreamEvent(streamEvent({
			type: "content_block_delta",
			index: 0,
			delta: { type: "input_json_delta", partial_json: "{\"query\":\"select:WebFetch\"}" },
		}), new Map(), model);
		processStreamEvent(streamEvent({ type: "content_block_stop", index: 0 }), new Map(), model);

		assert.equal(c.turnBlocks.length, 0, "ToolSearch must not become a Pi content block");
		assert.equal(c.turnSawToolCall, false, "ToolSearch is not a Pi turn boundary");
		assert.deepEqual(c.turnToolCallIds, [], "Pi owes no result, so nothing can queue in pendingResults");
		assert.equal(c.pendingResults.size, 0);
		assert.equal(c.currentPiStream !== null, true, "the Pi turn must stay open");
		assert.deepEqual(events.map((e) => e.type), ["start"], "the deltas were skipped, not streamed");
		assert.equal(c.childExecutedStreamIndexes.has(0), true, "the block's stream index is claimed for skipping");
		// A built-in is tool plumbing, not account-data access: no audit entry,
		// and no result recognition needed.
		assert.equal(c.connectorCallAudit.size, 0);
		assert.equal(c.childExecutedToolCalls.size, 0);
	});

	it("does not end the turn on a message_stop that only saw a ToolSearch call", () => {
		const c = ctx();
		c.resetTurnState(model);
		installFakeStream();

		processStreamEvent(streamEvent({
			type: "content_block_start",
			index: 0,
			content_block: { type: "tool_use", id: "toolu_ts", name: "ToolSearch", input: {} },
		}), new Map(), model);
		processStreamEvent(streamEvent({ type: "message_stop" }), new Map(), model);

		assert.equal(c.currentPiStream !== null, true, "ending here would be a spurious pi-turn boundary");
	});

	it("skips a ToolSearch tool_use on the assistant-boundary path without ending the turn", () => {
		const c = ctx();
		c.resetTurnState(model);
		installFakeStream();
		c.turnSawStreamEvent = true;

		processAssistantMessage({
			type: "assistant",
			message: {
				content: [{ type: "tool_use", id: "toolu_ts", name: "ToolSearch", input: { query: "select:WebFetch" } }],
			},
		}, model, new Map());

		assert.equal(c.turnBlocks.length, 0);
		assert.equal(c.turnSawToolCall, false);
		assert.equal(c.currentPiStream !== null, true, "no Pi tool call means no turn boundary");
		assert.equal(c.connectorCallAudit.size, 0);
		assert.equal(c.childExecutedToolCalls.size, 0);
	});

	it("skips a ToolSearch tool_use on the no-stream-events fallback path", () => {
		const c = ctx();
		c.resetTurnState(model);
		installFakeStream();

		processAssistantMessage({
			type: "assistant",
			message: {
				content: [
					{ type: "text", text: "loading a tool" },
					{ type: "tool_use", id: "toolu_ts", name: "ToolSearch", input: { query: "select:WebFetch" } },
				],
			},
		}, model, new Map());

		assert.deepEqual(c.turnBlocks.map((b) => b.type), ["text"]);
		assert.equal(c.turnSawToolCall, false);
		assert.equal(c.currentPiStream !== null, true);
		assert.equal(c.connectorCallAudit.size, 0);
	});

	it("still mirrors a Pi tool coincidentally named like a child built-in", () => {
		const c = ctx();
		c.resetTurnState(model);
		installFakeStream();
		c.turnSawStreamEvent = true;

		processAssistantMessage({
			type: "assistant",
			message: {
				content: [{ type: "tool_use", id: "toolu_x", name: "mcp__custom-tools__ToolSearchX", input: {} }],
			},
		}, model, new Map([["mcp__custom-tools__ToolSearchX", "ToolSearchX"]]));

		assert.equal(c.turnBlocks.length, 1, "an exact-name miss stays a real Pi tool call");
		assert.equal(c.turnBlocks[0].name, "ToolSearchX");
		assert.equal(c.turnSawToolCall, true);
	});

	it("does not mirror bare Pi tools or foreign MCP calls on any emission path", () => {
		const manifest = new Map([
			["mcp__custom-tools__read", "read"],
			["mcp__custom-tools__grep", "grep"],
		]);
		const freshContext = () => {
			resetStack();
			const c = ctx();
			c.resetTurnState(model);
			installFakeStream();
			return c;
		};
		const assertNoPiCall = (c, committedOutput) => {
			assert.equal(c.turnBlocks.length, 0);
			assert.equal(c.turnSawToolCall, false);
			assert.deepEqual(c.turnToolCallIds, []);
			assert.equal(c.committedOutput, committedOutput);
		};

		let c = freshContext();
		processStreamEvent(streamEvent({
			type: "content_block_start", index: 0,
			content_block: { type: "tool_use", id: "toolu_bare", name: "grep", input: {} },
		}), manifest, model);
		processStreamEvent(streamEvent({ type: "content_block_stop", index: 0 }), manifest, model);
		assertNoPiCall(c, false);

		c = freshContext();
		processStreamEvent(streamEvent({
			type: "content_block_start", index: 0,
			content_block: { type: "tool_use", id: "toolu_nameless", input: {} },
		}), manifest, model);
		processStreamEvent(streamEvent({ type: "content_block_stop", index: 0 }), manifest, model);
		assertNoPiCall(c, false);

		c = freshContext();
		processStreamEvent(streamEvent({
			type: "content_block_start", index: 0,
			content_block: { type: "tool_use", id: "toolu_native_stream", name: "mcp__filesystem__read_file", input: {} },
		}), manifest, model);
		processStreamEvent(streamEvent({ type: "content_block_stop", index: 0 }), manifest, model);
		assertNoPiCall(c, true);

		c = freshContext();
		processStreamEvent(streamEvent({
			type: "content_block_start", index: 0,
			content_block: { type: "tool_use", id: "toolu_native_slash_stream", name: "mcp/filesystem/read_file", input: {} },
		}), manifest, model);
		processStreamEvent(streamEvent({ type: "content_block_stop", index: 0 }), manifest, model);
		assertNoPiCall(c, true);

		c = freshContext();
		c.turnSawStreamEvent = true;
		processAssistantMessage({
			type: "assistant",
			message: { content: [{ type: "tool_use", id: "toolu_native_boundary", name: "mcp__filesystem__read_file", input: {} }] },
		}, model, manifest);
		assertNoPiCall(c, true);

		c = freshContext();
		processAssistantMessage({
			type: "assistant",
			message: { content: [{ type: "tool_use", id: "toolu_native_fallback", name: "mcp__filesystem__read_file", input: {} }] },
		}, model, manifest);
		assertNoPiCall(c, true);

		c = freshContext();
		processAssistantMessage({
			type: "assistant",
			message: { content: [{ type: "tool_use", id: "toolu_bare_fallback", name: "bash", input: {} }] },
		}, model, manifest);
		assertNoPiCall(c, false);
	});

	it("mirrors a streamed MCP-resource read under its stream-side spelling (kendex#1007)", () => {
		// What actually arrives on the stream is the SDK's ALIASED name
		// (`ReadMcpResourceTool`, not the request-side `ReadMcpResource`), and it
		// must surface in Pi: the mirror is the resource-read audit surface for
		// hosts with no view of the child transcript.
		const c = ctx();
		c.resetTurnState(model);
		installFakeStream();

		processStreamEvent(streamEvent({
			type: "content_block_start",
			index: 0,
			content_block: { type: "tool_use", id: "toolu_rr", name: "ReadMcpResourceTool", input: {} },
		}), new Map([["mcp__custom-tools__grep", "grep"]]), model);

		assert.equal(c.turnBlocks.length, 1, "a resource read is a visible Pi tool call");
		assert.equal(c.turnBlocks[0].name, "ReadMcpResourceTool");
		assert.equal(c.turnSawToolCall, true);
		assert.equal(c.childExecutedStreamIndexes.has(0), false, "its deltas must stream, not be skipped");
	});

	it("mirrors an MCP-resource enumeration on the assistant-boundary path too (kendex#1007)", () => {
		const c = ctx();
		c.resetTurnState(model);
		installFakeStream();
		c.turnSawStreamEvent = true;

		processAssistantMessage({
			type: "assistant",
			message: {
				content: [{ type: "tool_use", id: "toolu_lr", name: "ListMcpResourcesTool", input: { server: "s1" } }],
			},
		}, model, new Map([["mcp__custom-tools__grep", "grep"]]));

		assert.equal(c.turnBlocks.length, 1);
		assert.equal(c.turnBlocks[0].name, "ListMcpResourcesTool");
		assert.equal(c.turnSawToolCall, true);
	});
});

describe("usage across a Pi turn that spans several child messages", () => {
	beforeEach(() => resetStack());

	it("accumulates what each finished child message billed", () => {
		const c = ctx();
		c.resetTurnState(model);
		installFakeStream();

		// Child message 1: the connector call. Big cache write, tiny output.
		processStreamEvent(streamEvent({
			type: "message_start",
			message: { id: "msg_1", model: model.id, usage: { input_tokens: 10, output_tokens: 0, cache_creation_input_tokens: 55685 } },
		}), new Map(), model);
		processStreamEvent(streamEvent({ type: "message_delta", delta: {}, usage: { output_tokens: 3 } }), new Map(), model);

		// Child message 2: the answer. Its own separate billed call.
		processStreamEvent(streamEvent({
			type: "message_start",
			message: { id: "msg_2", model: model.id, usage: { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 53631, cache_creation_input_tokens: 2083 } },
		}), new Map(), model);
		processStreamEvent(streamEvent({ type: "message_delta", delta: {}, usage: { output_tokens: 110 } }), new Map(), model);

		assert.equal(c.turnOutput.usage.input, 15, "both calls' input is billed");
		assert.equal(c.turnOutput.usage.output, 113);
		assert.equal(c.turnOutput.usage.cacheRead, 53631);
		assert.equal(c.turnOutput.usage.cacheWrite, 57768, "the first message's cache write must not be dropped");
		assert.equal(c.turnOutput.usage.totalTokens, 15 + 113 + 53631 + 57768);
	});

	it("replaces rather than doubles within one child message", () => {
		const c = ctx();
		c.resetTurnState(model);
		installFakeStream();

		processStreamEvent(streamEvent({
			type: "message_start",
			message: { model: model.id, usage: { input_tokens: 10, output_tokens: 0 } },
		}), new Map(), model);
		// Anthropic re-reports the same message's growing output.
		processStreamEvent(streamEvent({ type: "message_delta", delta: {}, usage: { output_tokens: 40 } }), new Map(), model);
		processStreamEvent(streamEvent({ type: "message_delta", delta: {}, usage: { output_tokens: 90 } }), new Map(), model);

		assert.equal(c.turnOutput.usage.input, 10);
		assert.equal(c.turnOutput.usage.output, 90, "cumulative-per-message counters must not be summed");
	});

	it("accumulates on the no-stream-events path too", () => {
		// The SDK can deliver a turn as complete `assistant` messages with no
		// stream events. That path begins the following child message, so
		// it must bank the previous one exactly as `message_start` does.
		const c = ctx();
		c.resetTurnState(model);
		installFakeStream();

		processAssistantMessage({
			type: "assistant",
			message: { id: "msg_1", content: [{ type: "text", text: "first" }], usage: { input_tokens: 10, output_tokens: 20 } },
		}, model, new Map());
		processAssistantMessage({
			type: "assistant",
			message: { id: "msg_2", content: [{ type: "text", text: "second" }], usage: { input_tokens: 5, output_tokens: 7 } },
		}, model, new Map());

		assert.equal(c.turnOutput.usage.input, 15);
		assert.equal(c.turnOutput.usage.output, 27, "the first assistant message's output must not be dropped");
	});

	it("does not double-count a message whose message_start already streamed", () => {
		// A child message that emits message_start but
		// NO content blocks leaves `turnSawStreamEvent` false, so the SDK's completed
		// copy of that SAME message lands on the no-stream-events path. Banking per
		// call site counted it twice; banking per message id does not.
		const c = ctx();
		c.resetTurnState(model);
		installFakeStream();

		processStreamEvent(streamEvent({
			type: "message_start",
			message: { id: "msg_1", model: model.id, usage: { input_tokens: 10, output_tokens: 0 } },
		}), new Map(), model);
		processStreamEvent(streamEvent({ type: "message_delta", delta: {}, usage: { output_tokens: 40 } }), new Map(), model);
		// The SDK's completed copy of the SAME message (same id).
		processAssistantMessage({
			type: "assistant",
			message: { id: "msg_1", content: [{ type: "text", text: "hi" }], usage: { input_tokens: 10, output_tokens: 40 } },
		}, model, new Map());

		assert.equal(c.turnOutput.usage.input, 10, "one message must be billed once");
		assert.equal(c.turnOutput.usage.output, 40);
	});

	it("still accumulates when the SDK reports no message ids", () => {
		// Older/streamless shapes carry no id. Each call then means what it says.
		const c = ctx();
		c.resetTurnState(model);
		installFakeStream();

		processAssistantMessage({
			type: "assistant",
			message: { content: [{ type: "text", text: "a" }], usage: { input_tokens: 3, output_tokens: 4 } },
		}, model, new Map());
		processAssistantMessage({
			type: "assistant",
			message: { content: [{ type: "text", text: "b" }], usage: { input_tokens: 3, output_tokens: 4 } },
		}, model, new Map());

		assert.equal(c.turnOutput.usage.input, 6);
		assert.equal(c.turnOutput.usage.output, 8);
	});

	it("starts fresh for the next Pi message", () => {
		const c = ctx();
		c.resetTurnState(model);
		installFakeStream();
		processStreamEvent(streamEvent({
			type: "message_start",
			message: { model: model.id, usage: { input_tokens: 10, output_tokens: 7 } },
		}), new Map(), model);

		c.resetTurnState(model);
		installFakeStream();
		processStreamEvent(streamEvent({
			type: "message_start",
			message: { model: model.id, usage: { input_tokens: 4, output_tokens: 2 } },
		}), new Map(), model);

		assert.equal(c.turnOutput.usage.input, 4, "a new Pi message does not inherit the old turn's total");
		assert.equal(c.turnOutput.usage.output, 2);
	});
});

describe("child-executed tool results", () => {
	beforeEach(() => resetStack());

	it("recognizes the child's own result without re-delivering it", () => {
		const c = ctx();
		c.resetTurnState(model);
		c.noteChildExecutedToolCall("toolu_conn", CONNECTOR_TOOL, 0);

		noteChildExecutedToolResults({
			type: "user",
			message: {
				content: [{ type: "tool_result", tool_use_id: "toolu_conn", content: "User ID: US9TAA048" }],
			},
		});

		// Observation only: nothing is queued for Pi, and no Pi block appears.
		assert.equal(c.pendingResults.size, 0);
		assert.equal(c.turnBlocks.length, 0);
	});

	it("ignores a tool_result for a call the child did not own", () => {
		const c = ctx();
		c.resetTurnState(model);
		c.noteChildExecutedToolCall("toolu_conn", CONNECTOR_TOOL, 0);

		noteChildExecutedToolResults({
			type: "user",
			message: { content: [{ type: "tool_result", tool_use_id: "toolu_other", content: "x" }] },
		});

		assert.equal(c.pendingResults.size, 0);
	});

	it("ignores a ToolSearch result even when a connector call is in flight", () => {
		// The connector call keeps result recognition armed, but the built-in's
		// own result must not be recognized or audited — its id was never noted.
		const c = ctx();
		c.resetTurnState(model);
		c.noteChildExecutedToolCall("toolu_conn", CONNECTOR_TOOL, 0);
		c.noteChildExecutedToolCall("toolu_ts", "ToolSearch", 1);

		noteChildExecutedToolResults({
			type: "user",
			message: { content: [{ type: "tool_result", tool_use_id: "toolu_ts", content: "loaded 1 tool" }] },
		});

		assert.equal(c.childExecutedToolCalls.has("toolu_ts"), false);
		assert.equal(c.connectorCallAudit.has("toolu_ts"), false);
		assert.equal(c.connectorCallAudit.has("toolu_conn"), true, "the connector call stays auditable");
		assert.equal(c.childExecutedStreamIndexes.has(1), true, "the built-in's stream index is still skipped");
	});

	it("tolerates a plain user echo with no tool results", () => {
		ctx().resetTurnState(model);
		ctx().noteChildExecutedToolCall("toolu_conn", CONNECTOR_TOOL, 0);
		noteChildExecutedToolResults({ type: "user", message: { content: "just a prompt echo" } });
		noteChildExecutedToolResults({ type: "user", message: {} });
	});
});

describe("account-replay commit boundary (committedOutput)", () => {
	// Rotation to another account must be forbidden the moment an
	// account-visible side effect starts — a connector dispatch — but a
	// child-internal built-in (ToolSearch et al.) is pure plumbing and must
	// leave the turn rotatable.
	it("a child-internal built-in before visible output does NOT commit", () => {
		const queryCtx = new QueryContext();
		queryCtx.noteChildExecutedToolCall("t1", "ToolSearch", 0);
		queryCtx.noteChildExecutedToolCall("t2", "ScheduleWakeup");
		assert.equal(queryCtx.committedOutput, false);
	});

	it("a connector dispatch commits, even without a stream index or id", () => {
		const withId = new QueryContext();
		withId.noteChildExecutedToolCall("c1", CONNECTOR_TOOL, 0);
		assert.equal(withId.committedOutput, true);

		const withoutId = new QueryContext();
		withoutId.noteChildExecutedToolCall(undefined, CONNECTOR_TOOL);
		assert.equal(withoutId.committedOutput, true);
	});

	it("resetTurnState does not clear the query-scoped commit flag", () => {
		const queryCtx = new QueryContext();
		queryCtx.noteChildExecutedToolCall("c1", CONNECTOR_TOOL, 0);
		queryCtx.resetTurnState({ api: "claude-bridge", provider: "pi-claude", id: "claude-haiku-4-5" });
		assert.equal(queryCtx.committedOutput, true);
	});
});
