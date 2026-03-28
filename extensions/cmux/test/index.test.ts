import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type ExecResult = {
	code: number;
	stdout: string;
	stderr?: string;
};

type EventHandler = (event: unknown, ctx: TestContext) => Promise<void> | void;

type TestContext = {
	hasUI: boolean;
	model?: { id: string };
	sessionManager: {
		getBranch(): unknown[];
	};
	getContextUsage(): { tokens?: number } | undefined;
};

type Harness = {
	handlers: Map<string, EventHandler>;
	execCalls: Array<{ command: string; args: string[] }>;
	pi: ExtensionAPI;
};

const ORIGINAL_CMUX_SOCKET_PATH = process.env.CMUX_SOCKET_PATH;
const ORIGINAL_CMUX_WORKSPACE_ID = process.env.CMUX_WORKSPACE_ID;

function createContext(): TestContext {
	return {
		hasUI: true,
		sessionManager: {
			getBranch: () => [],
		},
		getContextUsage: () => undefined,
	};
}

function createHarness(treeOutputs: string[]): Harness {
	const handlers = new Map<string, EventHandler>();
	const execCalls: Array<{ command: string; args: string[] }> = [];
	let treeIndex = 0;

	const pi = {
		on(event: string, handler: EventHandler): void {
			handlers.set(event, handler);
		},
		exec: async (command: string, args: string[]): Promise<ExecResult> => {
			execCalls.push({ command, args });
			assert.equal(command, "cmux");

			if (args[0] === "tree") {
				const stdout = treeOutputs[treeIndex] ?? treeOutputs.at(-1) ?? "";
				treeIndex += 1;
				return { code: 0, stdout };
			}

			return { code: 0, stdout: "" };
		},
		getSessionName: (): string => "alpha-session",
		getThinkingLevel: (): "off" => "off",
	} as unknown as ExtensionAPI;

	return { handlers, execCalls, pi };
}

async function loadExtension() {
	process.env.CMUX_SOCKET_PATH = "/tmp/cmux.sock";
	process.env.CMUX_WORKSPACE_ID = "workspace-shell-123";
	const moduleUrl = new URL(`../index.ts?test=${Date.now()}`, import.meta.url);
	return (await import(moduleUrl.href)).default as (pi: ExtensionAPI) => void;
}

afterEach(() => {
	if (ORIGINAL_CMUX_SOCKET_PATH === undefined) {
		delete process.env.CMUX_SOCKET_PATH;
	} else {
		process.env.CMUX_SOCKET_PATH = ORIGINAL_CMUX_SOCKET_PATH;
	}

	if (ORIGINAL_CMUX_WORKSPACE_ID === undefined) {
		delete process.env.CMUX_WORKSPACE_ID;
	} else {
		process.env.CMUX_WORKSPACE_ID = ORIGINAL_CMUX_WORKSPACE_ID;
	}
});

test("agent_end sync uses the shell workspace id instead of cmux current-workspace", async () => {
	const cmuxExtension = await loadExtension();
	const harness = createHarness([
		'workspace workspace:1 "alpha-session"\n  pane pane:1\n    surface surface:1\n',
		'workspace workspace:1 "original-title"\n  pane pane:1\n    surface surface:1\n',
	]);
	cmuxExtension(harness.pi);

	const sessionStartHandler = harness.handlers.get("session_start");
	const agentEndHandler = harness.handlers.get("agent_end");
	assert.ok(sessionStartHandler, "expected session_start handler");
	assert.ok(agentEndHandler, "expected agent_end handler");

	await sessionStartHandler({}, createContext());
	harness.execCalls.length = 0;

	await agentEndHandler({}, createContext());

	assert.equal(
		harness.execCalls.some((call) => call.command === "cmux" && call.args[0] === "current-workspace"),
		false,
	);

	assert.deepEqual(
		harness.execCalls.find((call) => call.command === "cmux" && call.args[0] === "tree")?.args,
		["tree", "--workspace", "workspace-shell-123"],
	);
	assert.deepEqual(
		harness.execCalls.find((call) => call.command === "cmux" && call.args[0] === "rename-workspace")?.args,
		["rename-workspace", "--workspace", "workspace-shell-123", "alpha-session"],
	);
});
