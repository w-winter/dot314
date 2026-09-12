/**
 * Coverage for grace-timer finalize forwarding
 * partial `{}` arguments, the same tool_use dispatching twice across turns, and
 * handlers stranded forever when their call never reached Pi.
 * Uses the real modules — no API calls, no extension activation.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { processAssistantMessage, processStreamEvent } from "../src/index.ts";
import { FINALIZE_MAX_REARMS, endToolUseTurn, finalizeToolUseTurnFromMcpInvocation } from "../src/assistant-stream.ts";
import { ctx, drainStrandedToolCalls, failStrandedToolCall, resetStack, takeQueuedOrParkedResult } from "../src/query-state.ts";

const model = {
	api: "claude-bridge",
	provider: "pi-claude",
	id: "claude-haiku-4-5",
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function installFakeStream() {
	const events = [];
	const stream = {
		push(event) { events.push(event); },
		end(result) { events.push({ type: "stream_end", result }); },
	};
	ctx().currentPiStream = stream;
	return events;
}

describe("grace finalize argument settlement", () => {
	beforeEach(() => resetStack());

	it("settles a still-partial block from the handler's authoritative args, never the partial JSON", () => {
		const c = ctx();
		c.resetTurnState(model);
		const events = installFakeStream();
		c.recordToolCall("t1", "web_fetch", {});
		c.turnBlocks.push({
			type: "toolCall", id: "t1", name: "web_fetch",
			arguments: {}, partialJson: "{\"url\":\"https://trunc", index: 0,
		});

		finalizeToolUseTurnFromMcpInvocation(c, "t1", "web_fetch", { url: "https://example.com/CHANGELOG.md" });

		const end = events.find((e) => e.type === "toolcall_end");
		assert.deepEqual(end.toolCall.arguments, { url: "https://example.com/CHANGELOG.md" });
		const done = events.find((e) => e.type === "done");
		assert.equal(done.reason, "toolUse");
		assert.deepEqual(done.message.content[0].arguments, { url: "https://example.com/CHANGELOG.md" });
		assert.equal(c.currentPiStream, null, "turn ended");
		assert.ok(c.forwardedToolCallIds.has("t1"), "executed call is marked forwarded");
	});

	it("settles fired siblings from their handlers' args and re-arms for silent ones instead of truncating", () => {
		const c = ctx();
		c.resetTurnState(model);
		const events = installFakeStream();
		for (const [id, name] of [["t1", "bash"], ["t2", "bash"], ["t3", "bash"]]) {
			c.recordToolCall(id, name, {});
			c.turnBlocks.push({ type: "toolCall", id, name, arguments: {}, partialJson: "{\"comman", index: c.turnBlocks.length });
		}
		c.pendingToolCalls.set("t2", { toolName: "bash", args: { command: "echo sibling" }, generation: 0, resolve: () => {} });

		finalizeToolUseTurnFromMcpInvocation(c, "t1", "bash", { command: "ls" });

		assert.deepEqual(c.turnBlocks[0].arguments, { command: "ls" });
		assert.deepEqual(c.turnBlocks[1].arguments, { command: "echo sibling" });
		assert.ok("partialJson" in c.turnBlocks[2], "silent sibling stays unsettled");
		assert.ok(c.currentPiStream, "turn NOT ended while a sibling has no arguments anywhere");
		assert.ok(c.scheduledToolUseEnd, "grace re-armed for the lagging stream");
		assert.equal(events.some((e) => e.type === "done"), false);

		// Grace exhausted: the inexecutable block is pruned, never executed.
		finalizeToolUseTurnFromMcpInvocation(c, "t1", "bash", { command: "ls" }, FINALIZE_MAX_REARMS);

		const done = events.find((e) => e.type === "done");
		assert.ok(done, "turn ends once grace is exhausted");
		assert.deepEqual(done.message.content.map((b) => b.id), ["t1", "t2"]);
		assert.ok(c.forwardedToolCallIds.has("t1"));
		assert.ok(c.forwardedToolCallIds.has("t2"));
		assert.equal(c.forwardedToolCallIds.has("t3"), false, "pruned call is not owed a result");
	});
});

describe("cross-turn duplicate dispatch suppression", () => {
	beforeEach(() => resetStack());

	function endTurnWithCall(id) {
		const c = ctx();
		c.resetTurnState(model);
		installFakeStream();
		c.recordToolCall(id, "bash", { command: "x" });
		c.turnBlocks.push({ type: "toolCall", id, name: "bash", arguments: { command: "x" } });
		endToolUseTurn(c);
		return c;
	}

	it("endToolUseTurn stamps every executed call as forwarded", () => {
		const c = endTurnWithCall("t1");
		assert.ok(c.forwardedToolCallIds.has("t1"));
	});

	it("a lagging stream replay of a forwarded call is suppressed, deltas and stops included", () => {
		const c = endTurnWithCall("t1");
		c.resetTurnState(model);
		const events = installFakeStream();

		processStreamEvent({ type: "stream_event", event: {
			type: "content_block_start", index: 0,
			content_block: { type: "tool_use", id: "t1", name: "mcp__custom-tools__bash" },
		} }, new Map([["mcp__custom-tools__bash", "bash"]]), model);
		processStreamEvent({ type: "stream_event", event: {
			type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"command\":\"x\"}" },
		} }, new Map(), model);
		processStreamEvent({ type: "stream_event", event: { type: "content_block_stop", index: 0 } }, new Map(), model);

		assert.equal(c.turnBlocks.length, 0, "duplicate block never recorded");
		assert.ok(c.suppressedStreamIndexes.has(0));
		assert.equal(events.some((e) => String(e.type).startsWith("toolcall")), false, "no toolcall events reach Pi");
		assert.equal(c.turnSawToolCall, false, "a suppressed duplicate is not a turn boundary");
	});

	it("a completed-message replay of a forwarded call is skipped and does not end the turn", () => {
		const c = endTurnWithCall("t1");
		c.resetTurnState(model);
		const events = installFakeStream();

		processAssistantMessage({ type: "assistant", message: {
			content: [{ type: "tool_use", id: "t1", name: "mcp__custom-tools__bash", input: { command: "x" } }],
		} }, model, new Map([["mcp__custom-tools__bash", "bash"]]));

		assert.equal(c.turnBlocks.length, 0);
		assert.equal(events.some((e) => String(e.type).startsWith("toolcall")), false);
		assert.ok(c.currentPiStream, "not a tool_use boundary: the stream stays open");
	});

	it("the finalize synthesize path never re-emits a forwarded or dead id", () => {
		const c = endTurnWithCall("t1");
		c.resetTurnState(model);
		const events = installFakeStream();

		finalizeToolUseTurnFromMcpInvocation(c, "t1", "bash", { command: "x" });

		assert.equal(events.some((e) => String(e.type).startsWith("toolcall")), false);
		assert.ok(c.currentPiStream, "turn left to its own terminal events");
	});
});

describe("stranded handler resolution", () => {
	beforeEach(() => resetStack());

	it("finalize with a dead stream fails the unforwarded waiting handler with a retryable error", () => {
		const c = ctx();
		let resolved;
		c.pendingToolCalls.set("t9", { toolName: "web_fetch", args: { url: "x" }, generation: 0, resolve: (r) => { resolved = r; } });

		finalizeToolUseTurnFromMcpInvocation(c, "t9", "web_fetch", { url: "x" });

		assert.ok(resolved, "handler resolved instead of waiting forever");
		assert.equal(resolved.isError, true);
		assert.match(resolved.content[0].text, /never forwarded to Pi/);
		assert.equal(c.pendingToolCalls.size, 0);
		assert.ok(c.deadToolCallIds.has("t9"), "failed call can never be dispatched later");
	});

	it("failStrandedToolCall leaves forwarded handlers waiting for their steer-split result", () => {
		const c = ctx();
		let resolved;
		c.forwardedToolCallIds.add("t8");
		c.pendingToolCalls.set("t8", { toolName: "bash", args: {}, generation: 0, resolve: (r) => { resolved = r; } });

		assert.equal(failStrandedToolCall(c, "t8"), false);
		assert.equal(resolved, undefined);
		assert.ok(c.pendingToolCalls.has("t8"));
	});

	it("the delivery-site drain fails only unforwarded handlers from settled generations", () => {
		const c = ctx();
		c.callbackGeneration = 1;
		const results = {};
		const register = (id, generation) => c.pendingToolCalls.set(id, {
			toolName: "bash", args: {}, generation, resolve: (r) => { results[id] = r; },
		});
		register("old-unforwarded", 0);
		register("old-forwarded", 0);
		c.forwardedToolCallIds.add("old-forwarded");
		register("current", 1);

		const stranded = drainStrandedToolCalls(c);

		assert.deepEqual(stranded, [{ id: "old-unforwarded", toolName: "bash" }]);
		assert.equal(results["old-unforwarded"].isError, true);
		assert.equal(results["old-forwarded"], undefined, "Pi still owes this one a result");
		assert.equal(results["current"], undefined, "racing the live callback is not stranded");
		assert.ok(c.deadToolCallIds.has("old-unforwarded"));
		assert.ok(c.pendingToolCalls.has("old-forwarded"));
		assert.ok(c.pendingToolCalls.has("current"));
	});
});

describe("post-boundary claim recovery (production path)", () => {
	beforeEach(() => resetStack());

	it("a late handler claims its parked result through claimToolCall after the boundary wiped the records", () => {
		const c = ctx();
		c.recordToolCall("x", "web_fetch", { url: "https://a.example" });
		c.pendingResults.set("x", { toolCallId: "x", content: [{ type: "text", text: "real" }] });
		c.takeStaleQueuedResults();
		c.resetToolTracking();

		const claim = c.claimToolCall("web_fetch", { url: "https://a.example" });
		assert.equal(claim.toolCallId, "x", "claim pairs the late handler with its own parked result");
		assert.equal(claim.match, "tool-args");
		assert.equal(takeQueuedOrParkedResult(c, claim.toolCallId).content[0].text, "real");
	});

	it("a late handler with a parked result never steals a live same-name call", () => {
		const c = ctx();
		c.recordToolCall("x", "bash", { command: "make deploy" });
		c.pendingResults.set("x", { toolCallId: "x", content: [{ type: "text", text: "deployed" }] });
		c.takeStaleQueuedResults();
		c.resetToolTracking();
		// The following turn streams same-name call Y, the sole live candidate.
		c.recordToolCall("y", "bash", { command: "echo other" });

		const lateClaim = c.claimToolCall("bash", { command: "make deploy" });
		assert.equal(lateClaim.toolCallId, "x", "exact-args parked pairing outranks the sole live fallback");
		const liveClaim = c.claimToolCall("bash", { command: "echo other" });
		assert.equal(liveClaim.toolCallId, "y", "the live call keeps its own id");
	});

	it("a sole result-backed candidate is claimable without exact args, several are refused", () => {
		const c = ctx();
		c.recordToolCall("x", "edit", { path: "a", edits: [] });
		c.pendingResults.set("x", { toolCallId: "x", content: [{ type: "text", text: "ok" }] });
		c.takeStaleQueuedResults();
		c.resetToolTracking();

		const sole = c.claimToolCall("edit", { path: "a", edits: [{ oldText: "1", newText: "2" }] });
		assert.equal(sole.toolCallId, "x");
		assert.equal(sole.match, "tool-name");
		assert.equal(sole.argsMismatch, true);

		resetStack();
		const c2 = ctx();
		for (const id of ["p", "q"]) {
			c2.recordToolCall(id, "read", { path: id });
			c2.pendingResults.set(id, { toolCallId: id, content: [{ type: "text", text: id }] });
		}
		c2.takeStaleQueuedResults();
		c2.resetToolTracking();
		const refused = c2.claimToolCall("read", { path: "neither" });
		assert.equal(refused.match, "none", "two candidates and no exact match: cross-pairing refused");
	});
});

describe("turn-end safety invariants", () => {
	beforeEach(() => resetStack());

	it("endToolUseTurn never ships a still-partial block", () => {
		const c = ctx();
		c.resetTurnState(model);
		const events = installFakeStream();
		c.recordToolCall("sealed", "bash", { command: "ls" });
		c.turnBlocks.push({ type: "toolCall", id: "sealed", name: "bash", arguments: { command: "ls" } });
		c.recordToolCall("partial", "bash", {});
		c.turnBlocks.push({ type: "toolCall", id: "partial", name: "bash", arguments: {}, partialJson: "{\"comman", index: 1 });

		endToolUseTurn(c);

		const done = events.find((e) => e.type === "done");
		assert.deepEqual(done.message.content.map((b) => b.id), ["sealed"]);
		assert.ok(c.forwardedToolCallIds.has("sealed"));
		assert.equal(c.forwardedToolCallIds.has("partial"), false, "a pruned call is not owed a result");
	});

	it("a completed-message block suppresses its lagging same-turn stream twin", () => {
		const c = ctx();
		c.resetTurnState(model);
		const events = installFakeStream();
		c.turnSawStreamEvent = true;
		// Completed yield beat the stream: block recorded complete.
		processAssistantMessage({ type: "assistant", message: {
			content: [{ type: "tool_use", id: "t1", name: "mcp__custom-tools__bash", input: { command: "echo hi" } }],
		} }, model, new Map([["mcp__custom-tools__bash", "bash"]]));
		assert.equal(c.turnBlocks.length, 1);

		// The same call's stream twin arrives afterwards.
		processStreamEvent({ type: "stream_event", event: {
			type: "content_block_start", index: 0,
			content_block: { type: "tool_use", id: "t1", name: "mcp__custom-tools__bash" },
		} }, new Map([["mcp__custom-tools__bash", "bash"]]), model);
		processStreamEvent({ type: "stream_event", event: { type: "content_block_stop", index: 0 } }, new Map(), model);

		assert.equal(c.turnBlocks.length, 1, "no second copy of the block");
		assert.equal("partialJson" in c.turnBlocks[0], false, "the complete copy is untouched");
		endToolUseTurn(c);
		const done = events.find((e) => e.type === "done");
		assert.deepEqual(done.message.content.map((b) => b.id), ["t1"], "the id ships exactly once");
	});

	it("finalize for a forwarded id still ends the turn for its executable siblings", () => {
		const c = ctx();
		c.forwardedToolCallIds.add("old");
		c.resetTurnState(model);
		const events = installFakeStream();
		c.recordToolCall("live", "bash", { command: "ls" });
		c.turnBlocks.push({ type: "toolCall", id: "live", name: "bash", arguments: { command: "ls" } });

		finalizeToolUseTurnFromMcpInvocation(c, "old", "bash", { command: "x" });

		const done = events.find((e) => e.type === "done");
		assert.ok(done, "the consumed grace timer still ends the turn");
		assert.deepEqual(done.message.content.map((b) => b.id), ["live"], "the forwarded id is not re-emitted");
	});

	it("a completed-message yield on a dead stream never mutates the delivered turn", () => {
		const c = ctx();
		c.resetTurnState(model);
		installFakeStream();
		c.recordToolCall("t1", "bash", { command: "ls" });
		c.turnBlocks.push({ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } });
		endToolUseTurn(c);
		const deliveredContent = c.turnOutput.content;
		const lengthAtDelivery = deliveredContent.length;
		c.turnSawStreamEvent = true;

		processAssistantMessage({ type: "assistant", message: {
			content: [
				{ type: "tool_use", id: "t1", name: "mcp__custom-tools__bash", input: { command: "ls" } },
				{ type: "tool_use", id: "t2", name: "mcp__custom-tools__bash", input: { command: "pwd" } },
			] } }, model, new Map([["mcp__custom-tools__bash", "bash"]]));

		assert.equal(deliveredContent.length, lengthAtDelivery, "Pi's delivered message is never appended to behind its back");
	});
});

describe("parked early results", () => {
	beforeEach(() => resetStack());

	it("a message-boundary reap parks results for a late handler instead of destroying them", () => {
		const c = ctx();
		c.queryToolNames.set("a", "web_fetch");
		c.pendingResults.set("a", { toolCallId: "a", content: [{ type: "text", text: "real output" }] });

		const stale = c.takeStaleQueuedResults();

		assert.deepEqual(stale, [{ id: "a", toolName: "web_fetch" }]);
		assert.equal(c.pendingResults.size, 0);
		const late = takeQueuedOrParkedResult(c, "a");
		assert.equal(late.content[0].text, "real output");
		assert.equal(takeQueuedOrParkedResult(c, "a"), undefined, "consumed exactly once");
	});

	it("takeQueuedOrParkedResult prefers the live queue over the parked store", () => {
		const c = ctx();
		c.pendingResults.set("a", { toolCallId: "a", content: [{ type: "text", text: "queued" }] });
		c.reapedResults.set("a", { toolCallId: "a", content: [{ type: "text", text: "parked" }] });

		assert.equal(takeQueuedOrParkedResult(c, "a").content[0].text, "queued");
		assert.equal(takeQueuedOrParkedResult(c, "a").content[0].text, "parked");
	});

	it("an id present in both stores is one claim candidate, not an ambiguous pair", () => {
		const c = ctx();
		c.recordToolCall("a", "web_fetch", { url: "https://a.example" });
		c.pendingResults.set("a", { toolCallId: "a", content: [{ type: "text", text: "queued" }] });
		c.reapedResults.set("a", { toolCallId: "a", content: [{ type: "text", text: "parked" }] });
		c.resetToolTracking();

		const claim = c.claimToolCall("web_fetch", { url: "https://a.example" });
		assert.equal(claim.toolCallId, "a");
		assert.equal(claim.ambiguous, false, "duplicate store membership must not inflate ambiguity");
	});
});
