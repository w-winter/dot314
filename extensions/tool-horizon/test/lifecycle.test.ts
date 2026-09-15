import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { initTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	TOOL_HORIZON_DISABLED_STATE,
	TOOL_HORIZON_STATE_CUSTOM_TYPE,
	computeBoundaryFingerprint,
	getToolHorizonRuntimeSnapshot,
	loadToolHorizonStateFromEntries,
	type EventMessage,
	type SessionEntry,
} from "../core.ts";
import toolHorizonExtension, { type ToolHorizonConfig } from "../index.ts";
import {
	TOOL_HORIZON_CHECKPOINT_ABSENCE_STATE,
	TOOL_HORIZON_CHECKPOINT_MESSAGE_CUSTOM_TYPE,
	TOOL_HORIZON_CHECKPOINT_STATE_CUSTOM_TYPE,
	type ToolHorizonCheckpointState,
} from "../provenance.ts";

const TIMESTAMP = "2026-07-29T00:00:00.000Z";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

function messageEntry(id: string, message: EventMessage): SessionEntry {
	return { id, type: "message", timestamp: TIMESTAMP, message } as unknown as SessionEntry;
}

function customEntry(id: string, customType: string, data: unknown): SessionEntry {
	return { id, type: "custom", timestamp: TIMESTAMP, customType, data } as unknown as SessionEntry;
}

function stateEntryPair(id: string, state: unknown): SessionEntry[] {
	return [
		customEntry(`${id}-checkpoint`, TOOL_HORIZON_CHECKPOINT_STATE_CUSTOM_TYPE, TOOL_HORIZON_CHECKPOINT_ABSENCE_STATE),
		customEntry(id, TOOL_HORIZON_STATE_CUSTOM_TYPE, state),
	];
}

function compactionEntry(id: string, firstKeptEntryId: string): SessionEntry {
	return {
		id,
		type: "compaction",
		timestamp: TIMESTAMP,
		summary: "Compacted history",
		firstKeptEntryId,
		tokensBefore: 100,
	} as unknown as SessionEntry;
}

function parentLinkedBranch(entries: SessionEntry[]): SessionEntry[] {
	return entries.map((entry, index) => ({
		...entry,
		parentId: index > 0 ? entries[index - 1].id : null,
	})) as SessionEntry[];
}

const TEST_CONFIG: ToolHorizonConfig = {
	checkpointUseGuidance: "Test checkpoint guidance.",
	warnBeforeRestoreAllThresholdPercent: 85,
	restoreAllAfterCompaction: true,
};

type AppendedEntry = {
	id: string;
	customType: string;
	data: unknown;
};

type LifecycleHarness = {
	branch: SessionEntry[];
	appended: AppendedEntry[];
	notifications: string[];
	statuses: Array<string | undefined>;
	context: ExtensionContext;
	emit(event: string, payload?: unknown): Promise<unknown>;
	runCommand(args: string): Promise<void>;
	appendMessage(id: string, message: EventMessage): void;
	setIdle(value: boolean): void;
};

function createLifecycleHarness(options: {
	branch: SessionEntry[];
	sessionId: string;
	idle?: boolean;
	menuInputs?: string[][];
}): LifecycleHarness {
	const branch = parentLinkedBranch(options.branch);
	const handlers = new Map<string, Handler>();
	const appended: AppendedEntry[] = [];
	const notifications: string[] = [];
	const statuses: Array<string | undefined> = [];
	const menuInputs = [...(options.menuInputs ?? [])];
	let commandHandler: ((args: string, ctx: ExtensionContext) => Promise<void> | void) | null = null;
	let idle = options.idle ?? true;
	let appendedEntryCount = 0;

	const currentLeafId = (): string | null => (branch.at(-1) as { id?: string } | undefined)?.id ?? null;
	const appendCustomEntry = (customType: string, data: unknown): void => {
		appendedEntryCount += 1;
		const id = `appended-${appendedEntryCount}`;
		const entry = {
			...customEntry(id, customType, data),
			parentId: currentLeafId(),
		} as SessionEntry;
		branch.push(entry);
		appended.push({ id, customType, data });
	};
	const getTree = () => {
		let children: unknown[] = [];
		for (let index = branch.length - 1; index >= 0; index--) {
			children = [{ entry: branch[index], children }];
		}
		return children;
	};
	const api = {
		events: { on: () => () => {}, emit() {} },
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		registerCommand(
			_name: string,
			command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> | void },
		) {
			commandHandler = command.handler;
		},
		appendEntry: appendCustomEntry,
	} as unknown as ExtensionAPI;
	const context = {
		cwd: "/workspace",
		hasUI: true,
		isIdle: () => idle,
		model: { contextWindow: 200_000 },
		getContextUsage: () => ({ tokens: 0 }),
		sessionManager: {
			getBranch: () => branch,
			getLeafId: currentLeafId,
			getSessionId: () => options.sessionId,
			getTree,
		},
		ui: {
			notify: (message: string) => notifications.push(message),
			setStatus: (_key: string, value: string | undefined) => statuses.push(value),
			theme: { fg: (_tone: string, text: string) => text },
			custom: async (factory: (
				tui: { terminal: { rows: number }; requestRender(): void; setFocus(component: unknown): void },
				theme: { fg(tone: string, text: string): string; bold(text: string): string },
				keybindings: unknown,
				done: (value: unknown) => void,
			) => { render(width: number): string[]; handleInput(data: string): void }) => {
				let selected: unknown = null;
				const component = factory(
					{ terminal: { rows: 40 }, requestRender() {}, setFocus() {} },
					{ fg: (_tone, text) => text, bold: (text) => text },
					undefined,
					(value) => { selected = value; },
				);
				component.render(80);
				for (const input of menuInputs.shift() ?? []) component.handleInput(input);
				return selected;
			},
		},
	} as unknown as ExtensionContext;

	toolHorizonExtension(api, TEST_CONFIG);
	return {
		branch,
		appended,
		notifications,
		statuses,
		context,
		emit: async (event, payload = {}) => handlers.get(event)?.(payload, context),
		runCommand: async (args) => {
			await commandHandler?.(args, context);
		},
		appendMessage: (id, message) => {
			branch.push({ ...messageEntry(id, message), parentId: currentLeafId() } as SessionEntry);
		},
		setIdle: (value) => { idle = value; },
	};
}

function createTransformedContextFixture(): {
	branch: SessionEntry[];
	transformedPayload: EventMessage[];
	boundaryMessage: EventMessage;
	suffixMessage: EventMessage;
} {
	const leadingMessage: EventMessage = { role: "user", content: [{ type: "text", text: "leading context" }] };
	const toolCallMessage: EventMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id: "old-read", name: "read", arguments: { path: "src/old.ts" } }],
	};
	const toolResultMessage: EventMessage = {
		role: "toolResult",
		toolCallId: "old-read",
		toolName: "read",
		content: [{ type: "text", text: "old contents" }],
		isError: false,
	};
	const boundaryMessage: EventMessage = { role: "user", content: [{ type: "text", text: "keep from here" }] };
	const suffixMessage: EventMessage = { role: "assistant", content: [{ type: "text", text: "retained response" }] };
	const state = {
		enabled: true,
		boundaryMode: "from-entry" as const,
		boundaryFingerprint: computeBoundaryFingerprint(boundaryMessage, 3),
	};
	return {
		branch: [
			messageEntry("leading", leadingMessage),
			messageEntry("tool-call", toolCallMessage),
			messageEntry("tool-result", toolResultMessage),
			messageEntry("boundary-message", boundaryMessage),
			messageEntry("suffix", suffixMessage),
			...stateEntryPair("transformed-state", state),
		],
		transformedPayload: [toolCallMessage, toolResultMessage, boundaryMessage, suffixMessage],
		boundaryMessage,
		suffixMessage,
	};
}

async function captureSessionStartStatus(branch: SessionEntry[], sessionId: string): Promise<string | undefined> {
	const linkedBranch = parentLinkedBranch(branch);
	let sessionStartHandler: Handler | null = null;
	const statuses: Array<string | undefined> = [];
	const api = {
		events: { on: () => () => {}, emit() {} },
		on(event: string, handler: Handler) {
			if (event === "session_start") sessionStartHandler = handler;
		},
		registerCommand() {},
	} as unknown as ExtensionAPI;
	const context = {
		cwd: "/workspace",
		hasUI: true,
		isIdle: () => true,
		sessionManager: {
			getBranch: () => linkedBranch,
			getLeafId: () => linkedBranch.at(-1)?.id ?? null,
			getSessionId: () => sessionId,
		},
		ui: {
			notify: () => {},
			setStatus: (_key: string, value: string | undefined) => statuses.push(value),
			theme: { fg: (_tone: string, text: string) => text },
		},
	} as unknown as ExtensionContext;

	toolHorizonExtension(api, TEST_CONFIG);
	await sessionStartHandler?.({}, context);
	return statuses.at(-1);
}

test("test_packaged_restore_all_after_compaction_is_enabled_by_default", () => {
	const packagedConfig = JSON.parse(
		readFileSync(new URL("../config.json", import.meta.url), "utf-8"),
	) as ToolHorizonConfig;

	expect(packagedConfig.restoreAllAfterCompaction).toBe(true);
});

test("test_footer_status_pins_pending_restoring_and_unresolved_forms", async () => {
	const pendingState = {
		enabled: true,
		boundaryMode: "pending",
		boundaryFingerprint: null,
	};
	const unresolvedState = {
		enabled: true,
		boundaryMode: "from-entry",
		boundaryFingerprint: {
			role: "user",
			textPrefix: "missing",
			toolNames: null,
			toolCount: 0,
			payloadIndex: 0,
		},
	};
	const unresolved = [
		messageEntry("user", { role: "user", content: [{ type: "text", text: "present" }] }),
		...stateEntryPair("unresolved", unresolvedState),
	];

	expect(await captureSessionStartStatus(stateEntryPair("pending", pendingState), "pending-session")).toBe("horizon: pending");
	expect(await captureSessionStartStatus(stateEntryPair("restoring", unresolvedState), "restoring-session")).toBe("horizon: restoring");
	expect(await captureSessionStartStatus(unresolved, "unresolved-session")).toBe("horizon: ?");
});

test("test_here_with_unstable_tail_persists_pending", async () => {
	const branch = [messageEntry("assistant", { role: "assistant", content: [] })];
	const handlers = new Map<string, Handler>();
	let commandHandler: ((args: string, ctx: ExtensionContext) => Promise<void> | void) | null = null;
	const appended: Array<{ customType: string; data: unknown }> = [];
	const api = {
		events: { on: () => () => {}, emit() {} },
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		registerCommand(
			_name: string,
			command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> | void },
		) {
			commandHandler = command.handler;
		},
		appendEntry(customType: string, data: unknown) {
			appended.push({ customType, data });
		},
	} as unknown as ExtensionAPI;
	const context = {
		cwd: "/workspace",
		hasUI: true,
		isIdle: () => true,
		sessionManager: {
			getBranch: () => branch,
			getLeafId: () => "assistant",
			getSessionId: () => "unstable-tail-session",
		},
		ui: {
			notify: () => {},
			setStatus: () => {},
			theme: { fg: (_tone: string, text: string) => text },
		},
	} as unknown as ExtensionContext;

	toolHorizonExtension(api, TEST_CONFIG);
	await handlers.get("session_start")?.({}, context);
	await commandHandler?.("here", context);

	expect(appended).toEqual([
		{
			customType: TOOL_HORIZON_CHECKPOINT_STATE_CUSTOM_TYPE,
			data: TOOL_HORIZON_CHECKPOINT_ABSENCE_STATE,
		},
		{
			customType: TOOL_HORIZON_STATE_CUSTOM_TYPE,
			data: { enabled: true, boundaryMode: "pending", boundaryFingerprint: null },
		},
	]);
});

test("test_canonical_subcommands_route_to_here_pick_and_all", async () => {
	let commandHandler: ((args: string, ctx: ExtensionContext) => Promise<void> | void) | null = null;
	const appended: Array<{ customType: string; data: unknown }> = [];
	const notifications: string[] = [];
	const api = {
		events: { on: () => () => {}, emit() {} },
		on() {},
		registerCommand(
			_name: string,
			command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> | void },
		) {
			commandHandler = command.handler;
		},
		appendEntry(customType: string, data: unknown) {
			appended.push({ customType, data });
		},
	} as unknown as ExtensionAPI;
	const context = {
		hasUI: true,
		isIdle: () => true,
		sessionManager: {
			getBranch: () => [],
			getLeafId: () => null,
			getSessionId: () => "routing-session",
		},
		ui: {
			notify: (message: string) => notifications.push(message),
			setStatus: () => {},
			theme: { fg: (_tone: string, text: string) => text },
		},
	} as unknown as ExtensionContext;

	toolHorizonExtension(api, TEST_CONFIG);
	await commandHandler?.("here", context);
	await commandHandler?.("pick", context);
	await commandHandler?.("all", context);

	expect(appended.map((entry) => entry.customType)).toEqual([
		TOOL_HORIZON_CHECKPOINT_STATE_CUSTOM_TYPE,
		TOOL_HORIZON_STATE_CUSTOM_TYPE,
		TOOL_HORIZON_STATE_CUSTOM_TYPE,
	]);
	expect(appended[1]?.data).toEqual({ enabled: true, boundaryMode: "pending", boundaryFingerprint: null });
	expect(appended[2]?.data).toEqual(TOOL_HORIZON_DISABLED_STATE);
	expect(notifications).toContain("tool-horizon: no cached model context for this branch yet");
	expect(notifications).toContain("tool-horizon: restored all tool history");
});

test("test_picker_selection_rejects_revision_session_and_leaf_changes", async () => {
	initTheme();
	for (const mutation of ["revision", "session", "leaf"] as const) {
		const first = messageEntry("user-1", { role: "user", content: [{ type: "text", text: "first" }] });
		const second = messageEntry("user-2", { role: "user", content: [{ type: "text", text: "second" }] });
		const branch = [first, second];
		const handlers = new Map<string, Handler>();
		let commandHandler: ((args: string, ctx: ExtensionContext) => Promise<void> | void) | null = null;
		let sessionId = `picker-${mutation}`;
		let leafId = "user-2";
		const appended: unknown[] = [];
		const notifications: string[] = [];
		const api = {
			events: { on: () => () => {}, emit() {} },
			on(event: string, handler: Handler) {
				handlers.set(event, handler);
			},
			registerCommand(
				_name: string,
				command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> | void },
			) {
				commandHandler = command.handler;
			},
			appendEntry(customType: string, data: unknown) {
				appended.push({ customType, data });
			},
		} as unknown as ExtensionAPI;
		let context: ExtensionContext;
		context = {
			cwd: "/workspace",
			hasUI: true,
			isIdle: () => true,
			sessionManager: {
				getBranch: () => branch,
				getLeafId: () => leafId,
				getSessionId: () => sessionId,
				getTree: () => [{ entry: first, children: [{ entry: second, children: [] }] }],
			},
			ui: {
				notify: (message: string) => notifications.push(message),
				setStatus: () => {},
				theme: { fg: (_tone: string, text: string) => text },
				custom: async (factory: (
					tui: { terminal: { rows: number }; requestRender(): void; setFocus(component: unknown): void },
					theme: { fg(color: string, text: string): string; bold(text: string): string },
					keybindings: unknown,
					done: (value: unknown) => void,
				) => { render(width: number): string[]; handleInput(data: string): void }) => {
					let selected: unknown = null;
					const overlay = factory(
						{ terminal: { rows: 40 }, requestRender() {}, setFocus() {} },
						{ fg: (_tone, text) => text, bold: (text) => text },
						undefined,
						(value) => { selected = value; },
					);
					overlay.render(100);
					if (mutation === "revision") {
						await handlers.get("context")?.({
							messages: [
								{ role: "user", content: [{ type: "text", text: "first" }] },
								{ role: "user", content: [{ type: "text", text: "second" }] },
							],
						}, context);
					} else if (mutation === "session") {
						sessionId = `${sessionId}-changed`;
					} else {
						leafId = "user-1";
					}
					overlay.handleInput("\r");
					return selected;
				},
			},
		} as unknown as ExtensionContext;

		toolHorizonExtension(api, TEST_CONFIG);
		await handlers.get("session_start")?.({}, context);
		await commandHandler?.("pick", context);

		expect(appended).toEqual([]);
		expect(notifications).toContain("tool-horizon: context changed while the picker was open — horizon not set");
	}
});

test("test_pending_boundary_capture_defers_persistence_until_agent_settled", async () => {
	const narrativeMessage: EventMessage = { role: "user", content: [{ type: "text", text: "stable narrative" }] };
	const pendingState = { enabled: true, boundaryMode: "pending" as const, boundaryFingerprint: null };
	const harness = createLifecycleHarness({
		branch: [messageEntry("narrative", narrativeMessage), ...stateEntryPair("pending-state", pendingState)],
		sessionId: "pending-capture-session",
		idle: false,
	});

	await harness.emit("session_start");
	const contextResult = await harness.emit("context", { messages: [narrativeMessage] });
	const capturedSnapshot = getToolHorizonRuntimeSnapshot("pending-capture-session");

	expect(contextResult).toBeUndefined();
	expect(harness.appended).toEqual([]);
	expect(capturedSnapshot?.state).toEqual(pendingState);
	expect(capturedSnapshot?.rawMessages).toEqual([narrativeMessage]);
	expect(capturedSnapshot?.filteredMessages).toEqual([narrativeMessage]);

	harness.setIdle(true);
	await harness.emit("agent_settled");

	expect(harness.appended.map(({ customType, data }) => ({ customType, data }))).toEqual([
		{
			customType: TOOL_HORIZON_CHECKPOINT_STATE_CUSTOM_TYPE,
			data: TOOL_HORIZON_CHECKPOINT_ABSENCE_STATE,
		},
		{
			customType: TOOL_HORIZON_STATE_CUSTOM_TYPE,
			data: {
				enabled: true,
				boundaryMode: "after-entry",
				boundaryFingerprint: computeBoundaryFingerprint(narrativeMessage, 0),
			},
		},
	]);
	const settledState = loadToolHorizonStateFromEntries(harness.branch, true);
	expect(settledState.enabled).toBe(true);
	expect(settledState.boundaryMode).toBe("after-entry");
	expect(getToolHorizonRuntimeSnapshot("pending-capture-session")?.state).toEqual(settledState);
});

test("test_pending_boundary_invalidated_before_settle_remains_pending_and_recaptures", async () => {
	const settledMessage: EventMessage = { role: "user", content: [{ type: "text", text: "settled narrative" }] };
	const capturedMessage: EventMessage = { role: "user", content: [{ type: "text", text: "different narrative" }] };
	const pendingState = { enabled: true, boundaryMode: "pending" as const, boundaryFingerprint: null };
	const harness = createLifecycleHarness({
		branch: [messageEntry("narrative", settledMessage), ...stateEntryPair("pending-state", pendingState)],
		sessionId: "pending-invalidation-session",
		idle: false,
	});

	await harness.emit("session_start");
	await harness.emit("context", { messages: [capturedMessage] });
	harness.setIdle(true);
	await harness.emit("agent_settled");

	expect(harness.appended).toEqual([]);
	expect(loadToolHorizonStateFromEntries(harness.branch, true)).toEqual(pendingState);
	expect(getToolHorizonRuntimeSnapshot("pending-invalidation-session")?.state).toEqual(pendingState);

	harness.setIdle(false);
	await harness.emit("context", { messages: [settledMessage] });
	harness.setIdle(true);
	await harness.emit("agent_settled");

	expect(harness.appended.map((entry) => entry.customType)).toEqual([
		TOOL_HORIZON_CHECKPOINT_STATE_CUSTOM_TYPE,
		TOOL_HORIZON_STATE_CUSTOM_TYPE,
	]);
	expect((harness.appended[1]?.data as { boundaryMode?: string }).boundaryMode).toBe("after-entry");
});

test("test_turn_end_reconciliation_appends_only_one_exact_matching_assistant", async () => {
	const userMessage: EventMessage = { role: "user", content: [{ type: "text", text: "question" }] };
	const assistantMessage: EventMessage = {
		role: "assistant",
		content: [{ type: "text", text: "answer" }],
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
	};
	const harness = createLifecycleHarness({
		branch: [messageEntry("user", userMessage)],
		sessionId: "turn-end-exact-session",
	});

	await harness.emit("session_start");
	harness.appendMessage("assistant", assistantMessage);
	await harness.emit("turn_end", { message: assistantMessage });

	const snapshot = getToolHorizonRuntimeSnapshot("turn-end-exact-session");
	expect(harness.appended).toEqual([]);
	expect(snapshot?.rawMessages).toHaveLength(2);
	expect(snapshot?.filteredMessages).toHaveLength(2);
	expect(snapshot?.filteredToRawIndices).toEqual([0, 1]);
	const appendedAssistant = snapshot?.rawMessages[1];
	expect(appendedAssistant).toEqual(assistantMessage);
	expect(appendedAssistant).not.toBe(assistantMessage);
	expect(appendedAssistant?.content).not.toBe(assistantMessage.content);
	if (!Array.isArray(appendedAssistant?.content) || !Array.isArray(assistantMessage.content)) {
		throw new Error("expected assistant content arrays");
	}
	expect(appendedAssistant.content[0]).not.toBe(assistantMessage.content[0]);
});

test("test_turn_end_reconciliation_skips_non_exact_branch_suffix", async () => {
	const userMessage: EventMessage = { role: "user", content: [{ type: "text", text: "question" }] };
	const assistantMessage: EventMessage = { role: "assistant", content: [{ type: "text", text: "answer" }] };
	const harness = createLifecycleHarness({
		branch: [messageEntry("user", userMessage)],
		sessionId: "turn-end-non-exact-session",
	});

	await harness.emit("session_start");
	const before = getToolHorizonRuntimeSnapshot("turn-end-non-exact-session")?.rawMessages;
	harness.appendMessage("assistant", assistantMessage);
	harness.appendMessage("follow-up", { role: "user", content: [{ type: "text", text: "another question" }] });
	await harness.emit("turn_end", { message: assistantMessage });

	expect(getToolHorizonRuntimeSnapshot("turn-end-non-exact-session")?.rawMessages).toBe(before);
	expect(harness.appended).toEqual([]);
});

test("test_picker_refreshes_canonical_cache_after_unreconciled_branch_suffix", async () => {
	initTheme();
	const userMessage: EventMessage = { role: "user", content: [{ type: "text", text: "question" }] };
	const assistantMessage: EventMessage = { role: "assistant", content: [{ type: "text", text: "answer" }] };
	const followUpMessage: EventMessage = { role: "user", content: [{ type: "text", text: "another question" }] };
	const harness = createLifecycleHarness({
		branch: [messageEntry("user", userMessage)],
		sessionId: "picker-stale-canonical-session",
	});

	await harness.emit("session_start");
	harness.appendMessage("assistant", assistantMessage);
	harness.appendMessage("follow-up", followUpMessage);
	await harness.emit("turn_end", { message: assistantMessage });
	await harness.runCommand("pick");

	expect(getToolHorizonRuntimeSnapshot("picker-stale-canonical-session")?.rawMessages).toEqual([
		userMessage,
		assistantMessage,
		followUpMessage,
	]);
	expect(harness.notifications).not.toContain(
		"tool-horizon: the session tree no longer matches the cached model context, so no horizon can be resolved",
	);
	expect(harness.appended).toEqual([]);
});

test("test_context_transforming_extension_payload_is_pruned_as_received", async () => {
	const fixture = createTransformedContextFixture();
	const harness = createLifecycleHarness({
		branch: fixture.branch,
		sessionId: "transformed-pruning-session",
	});

	await harness.emit("session_start");
	const result = await harness.emit("context", { messages: fixture.transformedPayload });
	const snapshot = getToolHorizonRuntimeSnapshot("transformed-pruning-session");

	expect(result).toEqual({ messages: [fixture.boundaryMessage, fixture.suffixMessage] });
	expect(snapshot?.state.enabled).toBe(true);
	expect(snapshot?.resolvedBoundaryIndex).toBe(2);
	expect(snapshot?.rawMessages).toEqual(fixture.transformedPayload);
	expect(snapshot?.filteredMessages).toEqual([fixture.boundaryMessage, fixture.suffixMessage]);
	expect(snapshot?.filteredToRawIndices).toEqual([2, 3]);
});

test("test_checkpoint_stays_at_boundary_across_append_only_turns", async () => {
	const fixture = createTransformedContextFixture();
	const state = {
		enabled: true,
		boundaryMode: "after-entry" as const,
		boundaryFingerprint: computeBoundaryFingerprint(fixture.suffixMessage, 3),
	};
	const checkpoint: ToolHorizonCheckpointState = {
		version: 1,
		scope: "before-boundary",
		boundaryMode: state.boundaryMode,
		boundarySignature: JSON.stringify({
			boundaryMode: state.boundaryMode,
			boundaryFingerprint: state.boundaryFingerprint,
		}),
		generatedAt: 0,
		files: {
			read: ["src/old.ts"],
			modified: [],
			created: [],
			deleted: [],
			moved: [],
		},
	};
	const branch = fixture.branch.map((entry) => {
		if (entry.type !== "custom") return entry;
		if (entry.customType === TOOL_HORIZON_CHECKPOINT_STATE_CUSTOM_TYPE) {
			return customEntry(entry.id, TOOL_HORIZON_CHECKPOINT_STATE_CUSTOM_TYPE, checkpoint);
		}
		if (entry.customType === TOOL_HORIZON_STATE_CUSTOM_TYPE) {
			return customEntry(entry.id, TOOL_HORIZON_STATE_CUSTOM_TYPE, state);
		}
		return entry;
	});
	const harness = createLifecycleHarness({
		branch,
		sessionId: "checkpoint-prefix-session",
	});
	const appendedAssistant: EventMessage = {
		role: "assistant",
		content: [{ type: "text", text: "new response" }],
	};
	const appendedUser: EventMessage = {
		role: "user",
		content: [{ type: "text", text: "new question" }],
	};

	await harness.emit("session_start");
	const firstResult = await harness.emit("context", { messages: fixture.transformedPayload }) as {
		messages: EventMessage[];
	};
	const secondResult = await harness.emit("context", {
		messages: [...fixture.transformedPayload, appendedAssistant, appendedUser],
	}) as { messages: EventMessage[] };

	expect(firstResult.messages.at(-1)).toMatchObject({
		role: "custom",
		customType: TOOL_HORIZON_CHECKPOINT_MESSAGE_CUSTOM_TYPE,
		content: expect.stringContaining("<use>Test checkpoint guidance.</use>"),
	});
	expect(firstResult.messages.slice(0, -1)).toEqual([fixture.boundaryMessage, fixture.suffixMessage]);
	expect(secondResult.messages.slice(0, firstResult.messages.length)).toEqual(firstResult.messages);
	expect(secondResult.messages.slice(firstResult.messages.length)).toEqual([appendedAssistant, appendedUser]);
});

test("test_restore_all_reseeds_payload_cache_from_the_current_branch", async () => {
	const fixture = createTransformedContextFixture();
	const harness = createLifecycleHarness({
		branch: fixture.branch,
		sessionId: "restore-all-reseed-session",
	});
	const branchPayload = fixture.branch
		.filter((entry) => entry.type === "message")
		.map((entry) => (entry as SessionEntry & { message: EventMessage }).message);

	await harness.emit("session_start");
	await harness.emit("context", { messages: fixture.transformedPayload });
	expect(getToolHorizonRuntimeSnapshot("restore-all-reseed-session")?.rawMessages).toEqual(fixture.transformedPayload);

	await harness.runCommand("all");

	expect(getToolHorizonRuntimeSnapshot("restore-all-reseed-session")?.rawMessages).toEqual(branchPayload);
	expect(harness.notifications).toContain("tool-horizon: restored all tool history");
});

test("test_context_transforming_extension_keeps_picker_and_turn_end_fail_closed", async () => {
	const fixture = createTransformedContextFixture();
	const harness = createLifecycleHarness({
		branch: fixture.branch,
		sessionId: "transformed-strict-session",
	});

	await harness.emit("session_start");
	await harness.emit("context", { messages: fixture.transformedPayload });
	const transformedSnapshot = getToolHorizonRuntimeSnapshot("transformed-strict-session");
	await harness.runCommand("pick");

	expect(harness.appended).toEqual([]);
	expect(harness.notifications).toContain(
		"tool-horizon: the session tree no longer matches the cached model context, so no horizon can be resolved",
	);

	const completedAssistant: EventMessage = { role: "assistant", content: [{ type: "text", text: "new answer" }] };
	harness.appendMessage("completed-assistant", completedAssistant);
	await harness.emit("turn_end", { message: completedAssistant });

	expect(getToolHorizonRuntimeSnapshot("transformed-strict-session")?.rawMessages).toBe(transformedSnapshot?.rawMessages);
	expect(harness.appended).toEqual([]);
});

test("test_control_menu_left_right_paging_behavior_is_preserved", async () => {
	initTheme();
	const harness = createLifecycleHarness({
		branch: [],
		sessionId: "menu-paging-session",
		menuInputs: [
			["\u001b[C", "\r"],
			["\u001b[C", "\u001b[D", "\r"],
		],
	});

	await harness.emit("session_start");
	await harness.runCommand("");
	expect(harness.appended).toEqual([]);

	await harness.runCommand("");
	expect(harness.appended.map((entry) => entry.customType)).toEqual([
		TOOL_HORIZON_CHECKPOINT_STATE_CUSTOM_TYPE,
		TOOL_HORIZON_STATE_CUSTOM_TYPE,
	]);
	expect(harness.appended[1]?.data).toEqual({
		enabled: true,
		boundaryMode: "pending",
		boundaryFingerprint: null,
	});
});

test("test_boundary_commit_failure_before_leaf_advance_does_not_install_state", async () => {
	const branch = [messageEntry("user", { role: "user", content: [{ type: "text", text: "stable" }] })];
	const handlers = new Map<string, Handler>();
	let commandHandler: ((args: string, ctx: ExtensionContext) => Promise<void> | void) | null = null;
	let failWrite = true;
	let abortCount = 0;
	let shutdownCount = 0;
	const appended: Array<{ customType: string; data: unknown }> = [];
	const api = {
		events: { on: () => () => {}, emit() {} },
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		registerCommand(
			_name: string,
			command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> | void },
		) {
			commandHandler = command.handler;
		},
		appendEntry(customType: string, data: unknown) {
			if (failWrite) throw new Error("write failed before leaf advance");
			appended.push({ customType, data });
		},
	} as unknown as ExtensionAPI;
	const context = {
		cwd: "/workspace",
		hasUI: true,
		isIdle: () => true,
		abort: () => { abortCount += 1; },
		shutdown: () => { shutdownCount += 1; },
		sessionManager: {
			getBranch: () => branch,
			getLeafId: () => "user",
			getSessionId: () => "write-before-session",
		},
		ui: {
			notify: () => {},
			setStatus: () => {},
			theme: { fg: (_tone: string, text: string) => text },
		},
	} as unknown as ExtensionContext;

	toolHorizonExtension(api, TEST_CONFIG);
	await handlers.get("session_start")?.({}, context);
	await expect(commandHandler!("here", context)).rejects.toThrow("write failed before leaf advance");

	expect(appended).toEqual([]);
	expect(abortCount).toBe(0);
	expect(shutdownCount).toBe(0);
	expect(getToolHorizonRuntimeSnapshot("write-before-session")?.state).toEqual(TOOL_HORIZON_DISABLED_STATE);

	failWrite = false;
	await commandHandler!("here", context);
	expect(appended.map((entry) => entry.customType)).toEqual([
		TOOL_HORIZON_CHECKPOINT_STATE_CUSTOM_TYPE,
		TOOL_HORIZON_STATE_CUSTOM_TYPE,
	]);
});

test("test_boundary_commit_failure_after_leaf_advance_quarantines_session", async () => {
	const branch = [messageEntry("user", { role: "user", content: [{ type: "text", text: "stable" }] })];
	const handlers = new Map<string, Handler>();
	let commandHandler: ((args: string, ctx: ExtensionContext) => Promise<void> | void) | null = null;
	let leafId = "user";
	let writeCount = 0;
	let abortCount = 0;
	let shutdownCount = 0;
	const appended: Array<{ customType: string; data: unknown }> = [];
	const notifications: string[] = [];
	const api = {
		events: { on: () => () => {}, emit() {} },
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		registerCommand(
			_name: string,
			command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> | void },
		) {
			commandHandler = command.handler;
		},
		appendEntry(customType: string, data: unknown) {
			writeCount += 1;
			if (writeCount === 1) {
				appended.push({ customType, data });
				leafId = "checkpoint";
				return;
			}
			leafId = "state-failed";
			throw new Error("state write failed after leaf advance");
		},
	} as unknown as ExtensionAPI;
	const context = {
		cwd: "/workspace",
		hasUI: true,
		isIdle: () => true,
		abort: () => { abortCount += 1; },
		shutdown: () => { shutdownCount += 1; },
		sessionManager: {
			getBranch: () => branch,
			getLeafId: () => leafId,
			getSessionId: () => "write-after-session",
		},
		ui: {
			notify: (message: string) => notifications.push(message),
			setStatus: () => {},
			theme: { fg: (_tone: string, text: string) => text },
		},
	} as unknown as ExtensionContext;

	toolHorizonExtension(api, TEST_CONFIG);
	await handlers.get("session_start")?.({}, context);
	await expect(commandHandler!("here", context)).rejects.toThrow("state write failed after leaf advance");

	expect(appended.map((entry) => entry.customType)).toEqual([TOOL_HORIZON_CHECKPOINT_STATE_CUSTOM_TYPE]);
	expect(abortCount).toBe(1);
	expect(shutdownCount).toBe(1);
	expect(getToolHorizonRuntimeSnapshot("write-after-session")?.state).toEqual(TOOL_HORIZON_DISABLED_STATE);
	expect(await handlers.get("input")?.({}, context)).toEqual({ action: "handled" });
	await expect(handlers.get("context")?.({ messages: [] }, context)).rejects.toThrow(
		"Pi will shut down to prevent writes beneath an unpersisted entry",
	);
	await expect(commandHandler!("all", context)).rejects.toThrow(
		"Pi will shut down to prevent writes beneath an unpersisted entry",
	);
	expect(notifications.some((message) => message.includes("session persistence failed after advancing the branch"))).toBe(true);
});

test("test_compaction_policy_is_a_branch_state_transition", () => {
	const enabled = { enabled: true, boundaryMode: "pending", boundaryFingerprint: null };
	const boundary = customEntry("boundary-a", TOOL_HORIZON_STATE_CUSTOM_TYPE, enabled);
	const compaction = compactionEntry("compaction", "boundary-a");
	const reenabled = customEntry("boundary-b", TOOL_HORIZON_STATE_CUSTOM_TYPE, enabled);

	expect(loadToolHorizonStateFromEntries([boundary, compaction], true).enabled).toBe(false);
	expect(loadToolHorizonStateFromEntries([boundary, compaction, messageEntry("continuation", { role: "user", content: [] })], true).enabled)
		.toBe(false);
	expect(loadToolHorizonStateFromEntries([boundary, compaction, reenabled], true).enabled).toBe(true);
	expect(loadToolHorizonStateFromEntries([boundary, compaction], false).enabled).toBe(true);
});

test("test_compaction_restore_all_suppresses_immediately_and_persists_when_settled", async () => {
	const assistant: EventMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "src/model.ts" } }],
	};
	const result: EventMessage = {
		role: "toolResult",
		toolCallId: "t1",
		toolName: "read",
		content: [{ type: "text", text: "content" }],
		isError: false,
	};
	const user: EventMessage = { role: "user", content: [{ type: "text", text: "continue" }] };
	const compactedPayload: EventMessage[] = [
		{ role: "compactionSummary", summary: "Compacted history", tokensBefore: 100 },
		user,
	];
	const enabledState = {
		enabled: true,
		boundaryMode: "from-entry" as const,
		boundaryFingerprint: computeBoundaryFingerprint(user, 2),
	};
	const checkpoint = {
		version: 1,
		scope: "before-boundary",
		boundaryMode: "from-entry",
		boundarySignature: JSON.stringify({
			boundaryMode: enabledState.boundaryMode,
			boundaryFingerprint: enabledState.boundaryFingerprint,
		}),
		generatedAt: 0,
		files: { read: ["src/model.ts"], modified: [], created: [], deleted: [], moved: [] },
	};
	const branch = parentLinkedBranch([
		messageEntry("assistant", assistant),
		messageEntry("result", result),
		messageEntry("user", user),
		customEntry("checkpoint", TOOL_HORIZON_CHECKPOINT_STATE_CUSTOM_TYPE, checkpoint),
		customEntry("boundary", TOOL_HORIZON_STATE_CUSTOM_TYPE, enabledState),
	]);
	const handlers = new Map<string, Handler>();
	const appended: Array<{ customType: string; data: unknown }> = [];
	const notifications: string[] = [];
	const statuses: Array<string | undefined> = [];
	let commandName: string | null = null;
	let commandHandler: ((args: string, ctx: ExtensionContext) => Promise<void> | void) | null = null;
	let idle = false;
	const api = {
		events: { on: () => () => {}, emit() {} },
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		registerCommand(
			name: string,
			command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> | void },
		) {
			commandName = name;
			commandHandler = command.handler;
		},
		appendEntry(customType: string, data: unknown) {
			appended.push({ customType, data });
		},
	} as unknown as ExtensionAPI;
	const context = {
		cwd: "/workspace",
		hasUI: true,
		isIdle: () => idle,
		sessionManager: {
			getBranch: () => branch,
			getLeafId: () => "boundary",
			getSessionId: () => "session",
		},
		ui: {
			notify: (message: string) => notifications.push(message),
			setStatus: (_key: string, value: string | undefined) => statuses.push(value),
			theme: { fg: (_tone: string, text: string) => text },
		},
	} as unknown as ExtensionContext;
	const config: ToolHorizonConfig = {
		checkpointUseGuidance: "Test checkpoint guidance.",
		warnBeforeRestoreAllThresholdPercent: 85,
		restoreAllAfterCompaction: true,
	};
	toolHorizonExtension(api, config);
	expect(commandName).toBe("tool-horizon");

	await handlers.get("session_start")?.({}, context);
	expect(statuses.at(-1)).toBe("horizon: 3/3");
	branch.push({ ...compactionEntry("compaction", "user"), parentId: "boundary" } as SessionEntry);
	await handlers.get("session_compact")?.({}, context);
	const contextResult = await handlers.get("context")?.({ messages: compactedPayload }, context);

	expect(contextResult).toBeUndefined();
	expect(appended).toHaveLength(0);

	await commandHandler?.("here", context);
	expect(notifications.at(-1)).toContain("automatic history restoration is pending");
	expect(appended).toHaveLength(0);

	// Model a canceled switch: the before-event fires, but no subsequent session_start replaces it.
	await handlers.get("session_before_switch")?.({}, context);
	idle = true;
	await handlers.get("agent_settled")?.({}, context);

	expect(appended).toEqual([
		{
			customType: TOOL_HORIZON_STATE_CUSTOM_TYPE,
			data: { enabled: false, boundaryMode: null, boundaryFingerprint: null },
		},
	]);
});

test("test_control_menu_renders_canonical_actions_and_descriptions", async () => {
	const captureMenu = async (branch: SessionEntry[], sessionId: string): Promise<string[]> => {
		const handlers = new Map<string, Handler>();
		let commandHandler: ((args: string, ctx: ExtensionContext) => Promise<void> | void) | null = null;
		let renderedLines: string[] = [];
		const api = {
			events: { on: () => () => {}, emit() {} },
			on(event: string, handler: Handler) {
				handlers.set(event, handler);
			},
			registerCommand(
				_name: string,
				command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> | void },
			) {
				commandHandler = command.handler;
			},
		} as unknown as ExtensionAPI;
		const context = {
			cwd: "/workspace",
			hasUI: true,
			isIdle: () => true,
			sessionManager: {
				getBranch: () => branch,
				getLeafId: () => (branch.at(-1) as { id?: string } | undefined)?.id ?? null,
				getSessionId: () => sessionId,
			},
			ui: {
				notify: () => {},
				setStatus: () => {},
				theme: { fg: (_tone: string, text: string) => text },
				custom: async (factory: (
					tui: { requestRender(): void },
					theme: { fg(tone: string, text: string): string; bold(text: string): string },
					keybindings: unknown,
					done: (value: string | null) => void,
				) => { render(width: number): string[] }) => {
					const component = factory(
						{ requestRender() {} },
						{ fg: (_tone, text) => text, bold: (text) => text },
						undefined,
						() => {},
					);
					renderedLines = component.render(60);
					return null;
				},
			},
		} as unknown as ExtensionContext;

		toolHorizonExtension(api, TEST_CONFIG);
		await handlers.get("session_start")?.({}, context);
		await commandHandler?.("", context);
		return renderedLines;
	};
	const inactiveLines = await captureMenu([], "inactive-menu-session");
	const activeLines = await captureMenu(stateEntryPair("pending", {
		enabled: true,
		boundaryMode: "pending",
		boundaryFingerprint: null,
	}), "active-menu-session");
	const inactiveText = inactiveLines.join("\n");
	const activeText = activeLines.join("\n");

	expect(inactiveText).toContain("Set horizon here");
	expect(inactiveText).toContain("(/tool-horizon here)");
	expect(inactiveText).toContain("Choose horizon from session tree");
	expect(inactiveText).toContain("(/tool-horizon pick)");
	expect(inactiveText).toContain("Cancel");
	expect(inactiveText).not.toContain("Restore all tool history");
	expect(activeText).toContain("Restore all tool history");
	expect(activeText).toContain("(/tool-horizon all)");
});

test("test_former_subcommands_are_rejected_without_mutation", async () => {
	let commandHandler: ((args: string, ctx: ExtensionContext) => Promise<void> | void) | null = null;
	const appended: unknown[] = [];
	const notifications: string[] = [];
	const commandNames: string[] = [];
	const api = {
		events: { on: () => () => {}, emit() {} },
		on() {},
		registerCommand(
			name: string,
			command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> | void },
		) {
			commandNames.push(name);
			commandHandler = command.handler;
		},
		appendEntry(customType: string, data: unknown) {
			appended.push({ customType, data });
		},
	} as unknown as ExtensionAPI;
	const context = {
		hasUI: true,
		isIdle: () => true,
		sessionManager: {
			getBranch: () => [],
			getLeafId: () => null,
			getSessionId: () => "session",
		},
		ui: {
			notify: (message: string) => notifications.push(message),
			setStatus: () => {},
			theme: { fg: (_tone: string, text: string) => text },
		},
	} as unknown as ExtensionContext;

	toolHorizonExtension(api, {
		checkpointUseGuidance: "Test checkpoint guidance.",
		warnBeforeRestoreAllThresholdPercent: 85,
		restoreAllAfterCompaction: true,
	});
	expect(commandNames).toEqual(["tool-horizon"]);
	await commandHandler?.("now", context);
	await commandHandler?.("off", context);

	expect(appended).toEqual([]);
	expect(notifications).toEqual([
		"Usage: /tool-horizon [here|pick|all]",
		"Usage: /tool-horizon [here|pick|all]",
	]);
});
