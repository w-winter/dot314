import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import type { ExtensionAPI, ToolInfo } from "@mariozechner/pi-coding-agent";

type EventHandler = (event: unknown, ctx: TestContext) => Promise<void> | void;

type TestContext = {
	sessionManager: {
		getBranch(): unknown[];
	};
};

type Harness = {
	pi: ExtensionAPI;
	eventHandlers: Map<string, EventHandler>;
	setActiveToolsCalls: string[][];
	getActiveTools(): string[];
};

const ORIGINAL_PI_CODING_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
const TEMP_DIRS: string[] = [];

function createTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	TEMP_DIRS.push(dir);
	return dir;
}

function restoreEnvVar(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name];
		return;
	}

	process.env[name] = value;
}

async function loadToolsModule() {
	const moduleUrl = new URL(`../index.ts?test=${Date.now()}-${Math.random()}`, import.meta.url);
	return import(moduleUrl.href) as Promise<typeof import("../index.ts")>;
}

function createHarness(options: { allTools: string[]; activeTools: string[] }): Harness {
	const eventHandlers = new Map<string, EventHandler>();
	const setActiveToolsCalls: string[][] = [];
	const allTools = options.allTools.map((name) => ({ name })) as ToolInfo[];
	let activeTools = [...options.activeTools];

	const pi = {
		on(event: string, handler: EventHandler): void {
			eventHandlers.set(event, handler);
		},
		registerCommand(): void {
			// No-op for restore-path tests.
		},
		getAllTools(): ToolInfo[] {
			return allTools;
		},
		getActiveTools(): string[] {
			return [...activeTools];
		},
		setActiveTools(nextTools: string[]): void {
			activeTools = [...nextTools];
			setActiveToolsCalls.push([...nextTools]);
		},
		appendEntry(): void {
			// No-op for restore-path tests.
		},
	} as unknown as ExtensionAPI;

	return {
		pi,
		eventHandlers,
		setActiveToolsCalls,
		getActiveTools: () => [...activeTools],
	};
}

function createContext(getBranch: () => unknown[]): TestContext {
	return {
		sessionManager: {
			getBranch,
		},
	};
}

function writeGlobalConfig(agentDir: string, config: unknown): void {
	const configPath = join(agentDir, "extensions", "tools", "tools.json");
	mkdirSync(dirname(configPath), { recursive: true });
	writeFileSync(configPath, JSON.stringify(config, null, 2));
}

afterEach(() => {
	restoreEnvVar("PI_CODING_AGENT_DIR", ORIGINAL_PI_CODING_AGENT_DIR);
	for (const dir of TEMP_DIRS.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("V2 restore disables only explicitly disabled tools", async () => {
	const toolsModule = await loadToolsModule();
	const harness = createHarness({
		allTools: ["read", "write", "caller_ping", "subagent_done"],
		activeTools: ["read", "write", "caller_ping", "subagent_done"],
	});
	toolsModule.default(harness.pi);

	await harness.eventHandlers.get("session_start")?.(
		{},
		createContext(() => [
			{
				type: "custom",
				customType: "tools-config",
				data: { version: 2, overrides: { read: "disabled" } },
			},
		]) as never,
	);

	assert.deepEqual(harness.getActiveTools(), ["write", "caller_ping", "subagent_done"]);
	assert.deepEqual(harness.setActiveToolsCalls, [["write", "caller_ping", "subagent_done"]]);
});

test("legacy enabledTools snapshots do not disable newly available tools by omission", async () => {
	const toolsModule = await loadToolsModule();
	const harness = createHarness({
		allTools: ["read", "write", "caller_ping", "subagent_done"],
		activeTools: ["read", "write", "caller_ping", "subagent_done"],
	});
	toolsModule.default(harness.pi);

	await harness.eventHandlers.get("session_start")?.(
		{},
		createContext(() => [
			{
				type: "custom",
				customType: "tools-config",
				data: { enabledTools: ["read", "write"] },
			},
		]) as never,
	);

	assert.deepEqual(harness.getActiveTools(), ["read", "write", "caller_ping", "subagent_done"]);
	assert.equal(harness.setActiveToolsCalls.length, 0);
});

test("legacy enabledTools can still positively re-enable a currently inactive tool", async () => {
	const toolsModule = await loadToolsModule();
	const harness = createHarness({
		allTools: ["read", "write", "extra"],
		activeTools: ["read"],
	});
	toolsModule.default(harness.pi);

	await harness.eventHandlers.get("session_start")?.(
		{},
		createContext(() => [
			{
				type: "custom",
				customType: "tools-config",
				data: { enabledTools: ["read", "extra"] },
			},
		]) as never,
	);

	assert.deepEqual(harness.getActiveTools(), ["read", "extra"]);
	assert.deepEqual(harness.setActiveToolsCalls, [["read", "extra"]]);
});

test("session_tree rebases current active tools before applying the next branch state", async () => {
	const toolsModule = await loadToolsModule();
	const harness = createHarness({
		allTools: ["read", "write", "caller_ping"],
		activeTools: ["read", "write", "caller_ping"],
	});
	toolsModule.default(harness.pi);

	const branchState = {
		entries: [
			{
				type: "custom",
				customType: "tools-config",
				data: { version: 2, overrides: { read: "disabled" } },
			},
		],
	};
	const ctx = createContext(() => branchState.entries);

	await harness.eventHandlers.get("session_start")?.({}, ctx as never);
	branchState.entries = [];
	await harness.eventHandlers.get("session_tree")?.({}, ctx as never);

	assert.deepEqual(harness.getActiveTools(), ["read", "write", "caller_ping"]);
	assert.deepEqual(harness.setActiveToolsCalls, [
		["write", "caller_ping"],
		["read", "write", "caller_ping"],
	]);
});

test("empty valid branch state overrides the global file instead of merging with it", async () => {
	const agentDir = createTempDir("tools-ext-");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	writeGlobalConfig(agentDir, { version: 2, overrides: { caller_ping: "disabled" } });

	const toolsModule = await loadToolsModule();
	const harness = createHarness({
		allTools: ["read", "write", "caller_ping"],
		activeTools: ["read", "write", "caller_ping"],
	});
	toolsModule.default(harness.pi);

	await harness.eventHandlers.get("session_start")?.(
		{},
		createContext(() => [
			{
				type: "custom",
				customType: "tools-config",
				data: { version: 2, overrides: {} },
			},
		]) as never,
	);

	assert.deepEqual(harness.getActiveTools(), ["read", "write", "caller_ping"]);
	assert.equal(harness.setActiveToolsCalls.length, 0);
});

test("getConfigPath resolves from PI_CODING_AGENT_DIR when present", async () => {
	const agentDir = createTempDir("tools-ext-");
	process.env.PI_CODING_AGENT_DIR = agentDir;

	const toolsModule = await loadToolsModule();
	assert.equal(toolsModule.__test__.getConfigPath(), join(agentDir, "extensions", "tools", "tools.json"));
});
