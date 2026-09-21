import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import claudeBridge, {
	__testGetBridgeIntegrityState,
	__testSetBridgeIntegrityState,
	__testSetSdkQueryFactory,
	streamClaudeAgentSdk,
} from "../src/index.ts";
import {
	__testSharedSessionLaneCount,
	deleteSharedSessionLane,
	setExtensionApi,
} from "../src/bridge-state.ts";
import {
	__testQueryLaneCount,
	ctx,
	deleteQueryLane,
	resetStack,
} from "../src/query-state.ts";
import { currentRequestLaneId, runInRequestLane } from "../src/request-lane.ts";
import {
	cancelScheduledSessionPersistence,
	schedulePersistSharedSession,
} from "../src/session-persistence.ts";

const model = {
	id: "claude-haiku-4-5",
	name: "Claude Haiku",
	api: "claude-bridge",
	provider: "pi-claude",
	baseUrl: "claude-bridge",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8192,
};

function deferred() {
	let resolve;
	const promise = new Promise((done) => { resolve = done; });
	return { promise, resolve };
}

function streamedText(text) {
	return [
		{ type: "stream_event", event: { type: "message_start", message: { model: model.id, usage: { input_tokens: 1 } } } },
		{ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
		{ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } },
	];
}

async function collect(stream) {
	const events = [];
	for await (const event of stream) events.push(event);
	return events;
}

const userMessage = (text) => ({ role: "user", content: text, timestamp: Date.now() });

function streamWithPrompt(context, options = {}) {
	return streamClaudeAgentSdk(model, {
		...context,
		messages: [
			{ role: "system", content: "test system prompt", timestamp: 0 },
			...context.messages,
		],
	}, options);
}

/** A fake SDK query that emits one tool_use for `call-<label>` and then stays
 *  open (like a real query waiting on its MCP handler) until its gate opens. */
function toolUseQueryFactory(gates) {
	return ({ prompt }) => {
		const label = String(prompt);
		const gate = deferred();
		gates.set(label, gate);
		let closed = false;
		return {
			async *[Symbol.asyncIterator]() {
				yield { type: "system", subtype: "init", session_id: `sdk-${label}` };
				yield { type: "stream_event", event: { type: "message_start", message: { id: `m-${label}`, model: model.id, usage: { input_tokens: 1 } } } };
				yield { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `call-${label}`, name: "mytool", input: {} } } };
				yield { type: "stream_event", event: { type: "content_block_stop", index: 0 } };
				yield { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } } };
				yield { type: "stream_event", event: { type: "message_stop" } };
				await gate.promise;
				if (closed) return;
				yield { type: "result", subtype: "success", result: `done-${label}` };
			},
			close() { closed = true; gate.resolve(); },
			async interrupt() { closed = true; gate.resolve(); },
		};
	};
}

function toolLoopContext(label, resultFor = label, text = `${label}-output`) {
	return {
		messages: [
			userMessage(label),
			{ role: "assistant", content: [{ type: "toolCall", id: `call-${resultFor}`, name: "mytool", arguments: {} }], timestamp: Date.now() },
			{ role: "toolResult", toolCallId: `call-${resultFor}`, toolName: "mytool", content: [{ type: "text", text }], isError: false, timestamp: Date.now() },
		],
	};
}

function makeFakePi(handlers) {
	return {
		on: (event, handler) => { handlers.set(event, handler); },
		registerCommand: () => {},
		registerProvider: () => {},
		events: { emit: () => {} },
		appendEntry: () => {},
	};
}

/** An in-memory session (pi --no-session) forks by mutating the SAME
 *  SessionManager's id before session_shutdown fires. */
function makeSession(initialId) {
	let sessionId = initialId;
	const sessionManager = {
		getSessionId: () => sessionId,
		getEntries: () => [],
		getCwd: () => process.cwd(),
		buildSessionContext: () => ({ messages: [] }),
	};
	return {
		sessionManager,
		ctxLike: { sessionManager, ui: { notify: () => {} }, cwd: process.cwd() },
		fork: (nextId) => { sessionId = nextId; },
	};
}

function seedLane(sessionId) {
	runInRequestLane(sessionId, () => {
		ctx().activeQuery = { id: `${sessionId}-query` };
		__testSetBridgeIntegrityState({ sharedSession: { sessionId: `${sessionId}-session`, cursor: 1, cwd: `/${sessionId}` } });
	});
}

/** Extension registration writes under PI_CODING_AGENT_DIR; keep it disposable. */
async function withAgentDir(run) {
	const agentDir = mkdtempSync(join(tmpdir(), "bridge-agent-dir-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		return await run();
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	}
}

function persistCapture() {
	const entries = [];
	setExtensionApi({ events: { emit: () => {} }, appendEntry: (type, data) => entries.push({ type, data }) });
	return entries;
}

function persistSessionManager(piSessionId) {
	return {
		getSessionId: () => piSessionId,
		getEntries: () => [],
		getCwd: () => process.cwd(),
		buildSessionContext: () => ({ messages: [userMessage("hi")] }),
	};
}

beforeEach(() => {
	process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT = "0";
	process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token";
	resetStack();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: { notify: () => {} } });
	setExtensionApi({ events: { emit: () => {} }, appendEntry: () => {} });
});

afterEach(() => {
	delete process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT;
	delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
	__testSetSdkQueryFactory();
	setExtensionApi(undefined);
	resetStack();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
});

describe("provider request session lanes", () => {
	it("keeps an active parent and parallel in-process subagents independent", async () => {
		const gates = new Map();
		const started = [];
		__testSetSdkQueryFactory(({ prompt }) => {
			const label = String(prompt);
			const gate = deferred();
			gates.set(label, gate);
			started.push(label);
			let closed = false;
			return {
				async *[Symbol.asyncIterator]() {
					yield { type: "system", subtype: "init", session_id: `sdk-${label}` };
					await gate.promise;
					if (closed) return;
					for (const message of streamedText(`answer-${label}`)) yield message;
					yield { type: "result", subtype: "success", result: `answer-${label}` };
				},
				close() { closed = true; gate.resolve(); },
				async interrupt() { closed = true; gate.resolve(); },
			};
		});

		const requests = ["parent", "child-a", "child-b", "child-c"].map((label) => ({
			label,
			stream: streamWithPrompt(
				{ messages: [{ role: "user", content: label, timestamp: Date.now() }] },
				{ sessionId: label },
			),
		}));
		const results = requests.map(({ stream }) => collect(stream));

		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.deepEqual(started.sort(), requests.map(({ label }) => label).sort());
		for (const gate of gates.values()) gate.resolve();

		const events = await Promise.all(results);
		for (let index = 0; index < requests.length; index += 1) {
			const label = requests[index].label;
			assert.deepEqual(
				events[index].filter((event) => event.type === "text_delta").map((event) => event.delta),
				[`answer-${label}`],
			);
			assert.equal(
				runInRequestLane(label, () => __testGetBridgeIntegrityState().sharedSession?.sessionId),
				`sdk-${label}`,
			);
			assert.equal(runInRequestLane(label, () => ctx().activeQuery), null);
		}
	});

	it("aborts one session without stopping a concurrent sibling", async () => {
		const gates = new Map();
		__testSetSdkQueryFactory(({ prompt }) => {
			const label = String(prompt);
			const gate = deferred();
			gates.set(label, gate);
			let closed = false;
			return {
				async *[Symbol.asyncIterator]() {
					yield { type: "system", subtype: "init", session_id: `sdk-${label}` };
					await gate.promise;
					if (closed) return;
					for (const message of streamedText(`answer-${label}`)) yield message;
					yield { type: "result", subtype: "success", result: `answer-${label}` };
				},
				close() { closed = true; gate.resolve(); },
				async interrupt() { closed = true; gate.resolve(); },
			};
		});

		const childAbort = new AbortController();
		const parentEvents = collect(streamWithPrompt(
			{ messages: [{ role: "user", content: "parent", timestamp: Date.now() }] },
			{ sessionId: "parent" },
		));
		const childEvents = collect(streamWithPrompt(
			{ messages: [{ role: "user", content: "child", timestamp: Date.now() }] },
			{ sessionId: "child", signal: childAbort.signal },
		));

		await new Promise((resolve) => setTimeout(resolve, 20));
		childAbort.abort();
		gates.get("parent").resolve();

		const [parent, child] = await Promise.all([parentEvents, childEvents]);
		assert.deepEqual(
			parent.filter((event) => event.type === "text_delta").map((event) => event.delta),
			["answer-parent"],
		);
		assert.ok(child.some((event) => event.type === "error" && event.reason === "aborted"));
		assert.equal(runInRequestLane("parent", () => ctx().activeQuery), null);
		assert.equal(runInRequestLane("child", () => ctx().activeQuery), null);
	});

	it("does not let one lane overwrite another lane's mutable state", () => {
		runInRequestLane("parent", () => {
			ctx().activeQuery = { id: "parent-query" };
			__testSetBridgeIntegrityState({ sharedSession: { sessionId: "parent-session", cursor: 5, cwd: "/parent" } });
		});
		runInRequestLane("child", () => {
			ctx().activeQuery = { id: "child-query" };
			__testSetBridgeIntegrityState({ sharedSession: { sessionId: "child-session", cursor: 1, cwd: "/child" } });
		});

		assert.equal(runInRequestLane("parent", () => ctx().activeQuery.id), "parent-query");
		assert.equal(runInRequestLane("parent", () => __testGetBridgeIntegrityState().sharedSession.sessionId), "parent-session");
		assert.equal(runInRequestLane("child", () => ctx().activeQuery.id), "child-query");
		assert.equal(runInRequestLane("child", () => __testGetBridgeIntegrityState().sharedSession.sessionId), "child-session");
	});

	it("treats an empty session id as a real lane rather than the default lane", () => {
		__testSetBridgeIntegrityState({
			sharedSession: { sessionId: "default-session", cursor: 0, cwd: "/default" },
		});

		runInRequestLane("", () => {
			assert.equal(currentRequestLaneId(), "");
			assert.equal(__testGetBridgeIntegrityState().sharedSession, null);
			ctx().activeQuery = { id: "empty-id-query" };
			__testSetBridgeIntegrityState({ sharedSession: { sessionId: "empty-id-session", cursor: 1, cwd: "/empty" } });
		});

		assert.equal(__testGetBridgeIntegrityState().sharedSession.sessionId, "default-session");
		assert.equal(runInRequestLane("", () => ctx().activeQuery.id), "empty-id-query");
		assert.equal(runInRequestLane("", () => __testGetBridgeIntegrityState().sharedSession.sessionId), "empty-id-session");
	});

	it("does not let the first named lane claim default-host session state", () => {
		const defaultRecord = { sessionId: "direct-host-session", cursor: 2, cwd: "/direct" };
		__testSetBridgeIntegrityState({ sharedSession: defaultRecord });

		assert.equal(runInRequestLane("child-first", () => __testGetBridgeIntegrityState().sharedSession), null);
		assert.deepEqual(__testGetBridgeIntegrityState().sharedSession, defaultRecord);
	});

	it("shares lane registries across separately loaded extension module instances", async () => {
		const suffix = `instance=${Date.now()}-${Math.random()}`;
		const siblingBridgeState = await import(`../src/bridge-state.ts?${suffix}`);
		const siblingQueryState = await import(`../src/query-state.ts?${suffix}`);
		const siblingRequestLane = await import(`../src/request-lane.ts?${suffix}`);

		runInRequestLane("shared-child", () => {
			ctx().activeQuery = { id: "primary-query" };
			__testSetBridgeIntegrityState({ sharedSession: { sessionId: "primary-session", cursor: 3, cwd: "/shared" } });
		});
		siblingRequestLane.runInRequestLane("shared-child", () => {
			assert.equal(siblingQueryState.ctx().activeQuery.id, "primary-query");
			assert.equal(siblingBridgeState.getSharedSession().sessionId, "primary-session");
			siblingBridgeState.setSharedSession({ sessionId: "sibling-session", cursor: 4, cwd: "/shared" });
		});

		assert.equal(runInRequestLane("shared-child", () => __testGetBridgeIntegrityState().sharedSession.sessionId), "sibling-session");
	});

	it("prunes only the shutting-down session's shared and query lanes", () => {
		for (const sessionId of ["parent", "child"]) {
			runInRequestLane(sessionId, () => {
				ctx().activeQuery = { id: `${sessionId}-query` };
				__testSetBridgeIntegrityState({ sharedSession: { sessionId: `${sessionId}-session`, cursor: 1, cwd: `/${sessionId}` } });
			});
		}
		assert.equal(__testQueryLaneCount(), 2);
		assert.equal(__testSharedSessionLaneCount(), 2);

		deleteQueryLane("child");
		deleteSharedSessionLane("child");

		assert.equal(__testQueryLaneCount(), 1);
		assert.equal(__testSharedSessionLaneCount(), 1);
		assert.equal(runInRequestLane("parent", () => ctx().activeQuery.id), "parent-query");
		assert.equal(runInRequestLane("parent", () => __testGetBridgeIntegrityState().sharedSession.sessionId), "parent-session");
		assert.equal(runInRequestLane("child", () => __testGetBridgeIntegrityState().sharedSession), null);

		deleteQueryLane("parent");
		deleteSharedSessionLane("parent");
		assert.equal(__testQueryLaneCount(), 0);
		assert.equal(__testSharedSessionLaneCount(), 0);
	});

	it("routes concurrent tool-result deliveries to the lane that owns the call", async () => {
		const gates = new Map();
		__testSetSdkQueryFactory(toolUseQueryFactory(gates));

		const [aEvents, bEvents] = await Promise.all([
			collect(streamWithPrompt({ messages: [userMessage("A")] }, { sessionId: "A" })),
			collect(streamWithPrompt({ messages: [userMessage("B")] }, { sessionId: "B" })),
		]);
		assert.ok(aEvents.some((event) => event.type === "done" && event.reason === "toolUse"), "A reached its tool turn");
		assert.ok(bEvents.some((event) => event.type === "done" && event.reason === "toolUse"), "B reached its tool turn");
		assert.ok(runInRequestLane("A", () => ctx().activeQuery), "A still active");
		assert.ok(runInRequestLane("B", () => ctx().activeQuery), "B still active");
		assert.equal(runInRequestLane("A", () => ctx().hasRecordedToolCall("call-A")), true);
		assert.equal(runInRequestLane("A", () => ctx().hasRecordedToolCall("call-B")), false);
		assert.equal(runInRequestLane("B", () => ctx().hasRecordedToolCall("call-B")), true);

		// Pi delivers B's result on lane B: queued for B's handler, invisible to A.
		assert.ok(streamWithPrompt(toolLoopContext("B"), { sessionId: "B" }));
		assert.equal(runInRequestLane("B", () => ctx().pendingResults.has("call-B")), true, "B queued its own result");
		assert.equal(runInRequestLane("A", () => ctx().pendingResults.size), 0, "A untouched by B's delivery");
		assert.equal(runInRequestLane("A", () => ctx().activeQuery !== null), true, "A still active after B's delivery");

		// A result carrying B's call id delivered on lane A is refused, not applied.
		assert.ok(streamWithPrompt(toolLoopContext("A", "B", "misrouted"), { sessionId: "A" }));
		assert.equal(runInRequestLane("A", () => ctx().pendingResults.has("call-B")), false, "A refuses a foreign call id");
		assert.equal(runInRequestLane("B", () => ctx().pendingResults.get("call-B")?.content?.[0]?.text), "B-output", "B's queued result is intact");

		for (const gate of gates.values()) gate.resolve();
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal(runInRequestLane("A", () => ctx().activeQuery), null);
		assert.equal(runInRequestLane("B", () => ctx().activeQuery), null);
	});

	it("marks only the aborted lane when the abort comes from another lane's context", async () => {
		const parentRecord = { sessionId: "parent-session", cursor: 3, cwd: "/parent" };
		const directRecord = { sessionId: "direct-host-session", cursor: 2, cwd: "/direct" };
		// The default lane holds a direct-host record (the test hook resets every
		// named lane when called outside a lane, so seed it first).
		__testSetBridgeIntegrityState({ sharedSession: { ...directRecord } });
		runInRequestLane("parent", () => __testSetBridgeIntegrityState({ sharedSession: { ...parentRecord } }));
		assert.deepEqual(runInRequestLane("parent", () => __testGetBridgeIntegrityState().sharedSession), parentRecord);
		assert.deepEqual(__testGetBridgeIntegrityState().sharedSession, directRecord);
		const gates = new Map();
		__testSetSdkQueryFactory(toolUseQueryFactory(gates));

		// A named-lane child with an in-flight tool call, aborted from the PARENT's
		// async context (an AbortSignal listener runs in the aborter's context).
		const childAbort = new AbortController();
		const child = collect(streamWithPrompt({ messages: [userMessage("child")] }, { sessionId: "child", signal: childAbort.signal }));
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.ok(runInRequestLane("child", () => ctx().activeQuery), "child is mid tool call");
		runInRequestLane("parent", () => childAbort.abort());
		await child;
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.deepEqual(
			runInRequestLane("parent", () => __testGetBridgeIntegrityState().sharedSession),
			parentRecord,
			"the aborter's lane must not be marked needsRebuild/forceRotate",
		);
		assert.deepEqual(__testGetBridgeIntegrityState().sharedSession, directRecord, "the default lane must not be marked either");

		// A DEFAULT-lane query aborted from a named lane marks the default record, not the named lane.
		const directAbort = new AbortController();
		const direct = collect(streamWithPrompt({ messages: [userMessage("direct")] }, { signal: directAbort.signal }));
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.ok(ctx().activeQuery, "direct-host query is mid tool call");
		runInRequestLane("parent", () => directAbort.abort());
		await direct;
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.deepEqual(runInRequestLane("parent", () => __testGetBridgeIntegrityState().sharedSession), parentRecord, "named lane untouched by a default-lane abort");
		assert.equal(__testGetBridgeIntegrityState().sharedSession?.needsRebuild, true, "the default lane record carries the abort mark");
		assert.equal(__testGetBridgeIntegrityState().sharedSession?.forceRotate, true);
	});

	it("releases the lane of a cacheRetention:none one-shot once it settles", async () => {
		__testSetSdkQueryFactory(({ prompt }) => {
			const label = String(prompt);
			return {
				async *[Symbol.asyncIterator]() {
					yield { type: "system", subtype: "init", session_id: `sdk-${label}` };
					for (const message of streamedText(`answer-${label}`)) yield message;
					yield { type: "result", subtype: "success", result: `answer-${label}` };
				},
				close() {},
				async interrupt() {},
			};
		});

		// A regular turn keeps its lane and record; Pi's compaction/branch-summary
		// one-shots (fresh sessionId + cacheRetention "none") must not accumulate.
		await collect(streamWithPrompt({ messages: [userMessage("turn")] }, { sessionId: "turn-1" }));
		for (const n of [1, 2, 3]) {
			await collect(streamWithPrompt({ messages: [userMessage(`summary-${n}`)] }, { sessionId: `summary-${n}`, cacheRetention: "none" }));
		}
		await new Promise((resolve) => setTimeout(resolve, 20));

		assert.equal(runInRequestLane("turn-1", () => __testGetBridgeIntegrityState().sharedSession?.sessionId), "sdk-turn");
		assert.equal(__testQueryLaneCount(), 1, "only the regular turn's query lane remains");
		assert.equal(__testSharedSessionLaneCount(), 1, "only the regular turn's session record remains");
	});

	it("prunes the session that started, not a fork id mutated onto the same in-memory session manager", async () => {
		await withAgentDir(() => {
			const handlers = new Map();
			claudeBridge(makeFakePi(handlers));

			// Two sessions start through the same handlers, the child AFTER the
			// parent: the parent's fork protection must survive the later start.
			const parent = makeSession("original");
			const child = makeSession("child");
			handlers.get("session_start")({ reason: "startup" }, parent.ctxLike);
			seedLane("original");
			handlers.get("session_start")({ reason: "new" }, child.ctxLike);
			seedLane("child");
			assert.equal(__testQueryLaneCount(), 2);
			assert.equal(__testSharedSessionLaneCount(), 2);

			parent.fork("forked");
			handlers.get("session_shutdown")({ reason: "fork" }, parent.ctxLike);
			assert.equal(runInRequestLane("original", () => __testGetBridgeIntegrityState().sharedSession), null, "the original session's record is pruned");
			assert.equal(__testQueryLaneCount(), 1, "only the child's query lane remains");
			assert.equal(__testSharedSessionLaneCount(), 1, "only the child's record remains");
			assert.equal(runInRequestLane("child", () => __testGetBridgeIntegrityState().sharedSession?.sessionId), "child-session", "a concurrent sibling is untouched");
			assert.equal(runInRequestLane("child", () => ctx().activeQuery?.id), "child-query");

			handlers.get("session_shutdown")({ reason: "quit" }, child.ctxLike);
			assert.equal(__testQueryLaneCount(), 0);
			assert.equal(__testSharedSessionLaneCount(), 0);
		});
	});

	it("prunes the started lane when session_start and session_shutdown reach different module instances", async () => {
		await withAgentDir(async () => {
			const primaryHandlers = new Map();
			const reloadedHandlers = new Map();
			claudeBridge(makeFakePi(primaryHandlers));
			// A `/reload` mid-session (or a child agent's own module copy) hands the
			// shutdown to a separately loaded extension instance.
			const reloaded = await import(`../src/index.ts?instance=${Date.now()}-${Math.random()}`);
			reloaded.default(makeFakePi(reloadedHandlers));

			const session = makeSession("original");
			primaryHandlers.get("session_start")({ reason: "startup" }, session.ctxLike);
			seedLane("original");
			// The live session the manager's id names once the fork mutates it.
			seedLane("forked");
			assert.equal(__testQueryLaneCount(), 2);
			assert.equal(__testSharedSessionLaneCount(), 2);

			session.fork("forked");
			reloadedHandlers.get("session_shutdown")({ reason: "fork" }, session.ctxLike);

			assert.equal(runInRequestLane("original", () => __testGetBridgeIntegrityState().sharedSession), null, "the started session's record is pruned");
			assert.equal(runInRequestLane("forked", () => __testGetBridgeIntegrityState().sharedSession?.sessionId), "forked-session", "the live fork's record survives");
			assert.equal(runInRequestLane("forked", () => ctx().activeQuery?.id), "forked-query");
			assert.equal(__testQueryLaneCount(), 1);
			assert.equal(__testSharedSessionLaneCount(), 1);
		});
	});

	it("shares the started-lane registry across separately loaded extension module instances", async () => {
		await withAgentDir(async () => {
			const handlers = new Map();
			claudeBridge(makeFakePi(handlers));
			const suffix = `instance=${Date.now()}-${Math.random()}`;
			const primaryBridgeState = await import("../src/bridge-state.ts");
			const siblingBridgeState = await import(`../src/bridge-state.ts?${suffix}`);

			const session = makeSession("original");
			handlers.get("session_start")({ reason: "startup" }, session.ctxLike);

			assert.equal(siblingBridgeState.takeStartedLane(session.sessionManager), "original", "a sibling module instance observes the entry");
			assert.equal(primaryBridgeState.takeStartedLane(session.sessionManager), undefined, "one registry, one shutdown per start");
		});
	});

	it("cancels only the shutting-down session's pending session persist", async () => {
		const entries = persistCapture();
		const managerA = persistSessionManager("pi-A");
		const managerB = persistSessionManager("pi-B");
		for (const [laneId, sessionManager] of [["A", managerA], ["B", managerB]]) {
			runInRequestLane(laneId, () => {
				__testSetBridgeIntegrityState({ sharedSession: { sessionId: `sdk-${laneId}`, cursor: 1, cwd: process.cwd() } });
				schedulePersistSharedSession({ sessionManager });
			});
		}

		cancelScheduledSessionPersistence(managerA);
		await new Promise((resolve) => setTimeout(resolve, 20));

		assert.deepEqual(entries.map((entry) => entry.data.piSessionId), ["pi-B"], "B's pending persist survives A's shutdown");
		assert.equal(entries[0].data.sessionId, "sdk-B");
	});

	it("keeps one pending persist per session manager, writing the latest record", async () => {
		const entries = persistCapture();
		const sessionManager = persistSessionManager("pi-A");
		runInRequestLane("A", () => {
			for (const cursor of [0, 1]) {
				__testSetBridgeIntegrityState({ sharedSession: { sessionId: "sdk-A", cursor, cwd: process.cwd() } });
				schedulePersistSharedSession({ sessionManager });
			}
		});
		await new Promise((resolve) => setTimeout(resolve, 20));

		assert.equal(entries.length, 1, "the later schedule supersedes the pending one");
		assert.equal(entries[0].data.cursor, 1);
	});
});
