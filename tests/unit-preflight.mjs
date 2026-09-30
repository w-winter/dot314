/**
 * Tests for Claude executable preflight diagnostics.
 * The checks do not require Claude Code to be installed; they use temp files
 * and the current Node executable as a known platform binary.
 */
import { chmodSync, existsSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { __testSetBridgeIntegrityState, __testSetSdkQueryFactory, preflightClaudeExecutable, spawnClaudeCodeWithDiagnostics, streamClaudeAgentSdk, wrapClaudeSpawnErrorForSdk } from "../src/index.ts";
import { setExtensionApi } from "../src/bridge-state.ts";
import { resetStack } from "../src/query-state.ts";

// The agent loop of the Pi the owner runs, when installed here.
const INSTALLED_PI_AGENT = "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/agent.js";
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

function withTempDir(fn) {
	const dir = mkdtempSync(join(tmpdir(), "claude-bridge-preflight-"));
	let cleanupNow = true;
	const cleanup = () => rmSync(dir, { recursive: true, force: true });
	try {
		const result = fn(dir);
		if (result && typeof result.then === "function") {
			cleanupNow = false;
			return result.finally(cleanup);
		}
		return result;
	} finally {
		if (cleanupNow) cleanup();
	}
}

describe("preflightClaudeExecutable", () => {
	it("accepts an existing executable shebang script", () => withTempDir((dir) => {
		const script = join(dir, "claude-wrapper");
		writeFileSync(script, "#!/bin/sh\nexit 0\n");
		chmodSync(script, 0o755);

		const result = preflightClaudeExecutable(script, dir);
		assert.equal(result.path, script);
		assert.equal(result.cwd, dir);
		assert.equal(result.fileType, "shebang-script");
	}));

	it("accepts the current Node executable as an existing platform binary", () => withTempDir((dir) => {
		const result = preflightClaudeExecutable(process.execPath, dir);
		assert.equal(result.path, process.execPath);
		assert.match(result.fileType, /^(elf|mach-o|pe)$/);
	}));

	it("accepts an executable over 2 GiB by its header", () => withTempDir((dir) => {
		const script = join(dir, "claude-large");
		writeFileSync(script, "#!/bin/sh\nexit 0\n");
		chmodSync(script, 0o755);
		// Sparse: the extension takes no disk space.
		truncateSync(script, 2 ** 31 + 1);

		const result = preflightClaudeExecutable(script, dir);
		assert.equal(result.fileType, "shebang-script");
	}));

	it("reports errno details for a non-existent executable path", () => withTempDir((dir) => {
		const missing = join(dir, "missing-claude");
		assert.throws(
			() => preflightClaudeExecutable(missing, dir),
			(error) => {
				assert.equal(error.name, "ClaudeExecutablePreflightError");
				assert.equal(error.code, "ENOENT");
				assert.equal(error.path, missing);
				assert.equal(error.cwd, dir);
				assert.equal(error.syscall, "stat");
				assert.match(error.message, /code=ENOENT/);
				assert.match(error.message, /errno=-?\d+/);
				assert.match(error.message, /syscall=stat/);
				assert.doesNotMatch(error.message, /native binary not found/);
				return true;
			},
		);
	}));

	it("reports errno details for a deleted cwd before checking the executable", () => withTempDir((dir) => {
		rmSync(dir, { recursive: true, force: true });
		assert.throws(
			() => preflightClaudeExecutable(process.execPath, dir),
			(error) => {
				assert.equal(error.name, "ClaudeExecutablePreflightError");
				assert.equal(error.code, "ENOENT");
				assert.equal(error.path, dir);
				assert.equal(error.cwd, dir);
				assert.equal(error.syscall, "stat");
				assert.match(error.message, /cwd is not reachable/);
				assert.ok(error.message.includes(`cwd=${dir}`));
				assert.doesNotMatch(error.message, /native binary not found/);
				return true;
			},
		);
	}));

	it("reports structured details when cwd is a file", () => withTempDir((dir) => {
		const fileCwd = join(dir, "not-a-directory");
		writeFileSync(fileCwd, "not a directory\n");
		assert.throws(
			() => preflightClaudeExecutable(process.execPath, fileCwd),
			(error) => {
				assert.equal(error.name, "ClaudeExecutablePreflightError");
				assert.equal(error.code, "ENOTDIR");
				assert.equal(error.path, fileCwd);
				assert.equal(error.cwd, fileCwd);
				assert.equal(error.syscall, "chdir");
				assert.match(error.message, /cwd is not a directory/);
				assert.ok(error.message.includes(`cwd=${fileCwd}`));
				return true;
			},
		);
	}));

	it("rewrites spawn ENOENT so SDK surfaces diagnostic context", async () => withTempDir(async (dir) => {
		const missing = join(dir, "missing-claude");
		const proc = spawnClaudeCodeWithDiagnostics({
			command: missing,
			args: [],
			cwd: dir,
			env: {},
			signal: new AbortController().signal,
		});
		const error = await new Promise((resolve) => proc.once("error", resolve));
		assert.equal(error.name, "ClaudeSpawnDiagnosticError");
		assert.equal(error.code, "CLAUDE_BRIDGE_SPAWN_FAILED");
		assert.equal(error.originalCode, "ENOENT");
		assert.match(error.originalMessage, /ENOENT/);
		assert.equal(error.path, missing);
		assert.equal(error.cwd, dir);
		assert.match(error.message, /code=ENOENT/);
		assert.match(error.message, /syscall=spawn/);
		assert.doesNotMatch(error.message, /native binary not found/);
		assert.notEqual(error.cause, error);
		assert.doesNotThrow(() => JSON.stringify(error));
		assert.doesNotMatch(error.stack ?? "", /wrapClaudeSpawnErrorForSdk/);
	}));
});

// A preflight or spawn error the bridge writes reaches Pi as the bridge wrote
// it: thrown out of the provider call with its fields, or as the Pi error
// event's text, whichever way the SDK passes it on.
describe("a bridge-authored executable or spawn error reaching Pi", () => {
	let agentDir;
	const saved = {};
	const ENV = ["PI_CODING_AGENT_DIR", "CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR"];
	beforeEach(() => {
		for (const key of ENV) saved[key] = process.env[key];
		agentDir = mkdtempSync(join(tmpdir(), "claude-bridge-preflight-pi-"));
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT = "0";
		process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token";
		process.env.CLAUDE_CONFIG_DIR = agentDir;
		resetStack();
		__testSetBridgeIntegrityState({ sharedSession: null, ui: { notify: () => {} } });
		setExtensionApi({ events: { emit: () => {} }, appendEntry: () => {} });
	});
	afterEach(() => {
		__testSetSdkQueryFactory();
		setExtensionApi(undefined);
		resetStack();
		__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
		for (const key of ENV) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
		rmSync(agentDir, { recursive: true, force: true });
	});

	const context = () => ({
		messages: [
			{ role: "system", content: "test system prompt", timestamp: 0 },
			{ role: "user", content: "hello", timestamp: Date.now() },
		],
	});
	async function collect(stream) {
		const events = [];
		for await (const event of stream) events.push(event);
		return events;
	}
	/** An executable whose interpreter does not exist: the preflight passes,
	 *  Node's spawn fails with ENOENT and the bridge rewrites the error. */
	function unlaunchableClaude() {
		const executable = join(agentDir, "unlaunchable-claude");
		writeFileSync(executable, `#!${join(agentDir, "missing-interpreter")}\n`, { mode: 0o755 });
		writeFileSync(join(agentDir, "claude-bridge.json"), JSON.stringify({ provider: { pathToClaudeCodeExecutable: executable } }));
		return executable;
	}
	function assertSpawnFailure(events, expected) {
		const last = events.at(-1);
		assert.equal(last.type, "error");
		assert.equal(last.error.stopReason, "error");
		assert.equal(last.error.model, model.id, "the message keeps its fields");
		expected(last.error.errorMessage);
	}

	it("throws a failed executable preflight out of the provider call with its text and fields", async () => {
		const missing = join(agentDir, "missing-claude");
		writeFileSync(join(agentDir, "claude-bridge.json"), JSON.stringify({ provider: { pathToClaudeCodeExecutable: missing } }));
		__testSetSdkQueryFactory(() => { throw new Error("a failed preflight must not start Claude Code"); });
		let thrown;
		try {
			streamClaudeAgentSdk(model, context(), { sessionId: "preflight-throw" });
		} catch (error) {
			thrown = error;
		}
		assert.ok(thrown, "the preflight throws");
		assert.match(thrown.message, /^Claude Code executable preflight failed: cannot access resolved executable before spawning Claude Code\. \(code=ENOENT [^)]*\)$/);
		assert.equal(thrown.name, "ClaudeExecutablePreflightError");
		assert.equal(thrown.code, "ENOENT");
		assert.equal(thrown.path, missing);
		// What Pi's own agent loop makes of it: an error message with that text.
		if (existsSync(INSTALLED_PI_AGENT)) {
			const { Agent } = await import(INSTALLED_PI_AGENT);
			const agent = new Agent({ initialState: { model, systemPrompt: "test system prompt" }, streamFn: streamClaudeAgentSdk, sessionId: "preflight-agent" });
			await agent.prompt("hello");
			const last = agent.state.messages.at(-1);
			assert.equal(last.stopReason, "error");
			assert.equal(last.errorMessage, thrown.message);
		}
	});

	it("ends the request with the spawn diagnostic the SDK iterator throws as is", async () => {
		const executable = unlaunchableClaude();
		let diagnostic;
		__testSetSdkQueryFactory(({ options }) => ({
			async *[Symbol.asyncIterator]() {
				const child = options.spawnClaudeCodeProcess({ command: executable, args: [], cwd: agentDir, env: {}, signal: new AbortController().signal });
				diagnostic = await new Promise((resolve) => child.once("error", resolve));
				throw diagnostic;
			},
			close() {},
			async interrupt() {},
		}));
		const events = await collect(streamClaudeAgentSdk(model, context(), { sessionId: "spawn-direct" }));
		assert.equal(diagnostic.name, "ClaudeSpawnDiagnosticError");
		assertSpawnFailure(events, (text) => assert.equal(text, diagnostic.message));
		assert.match(diagnostic.message, /^Claude Code spawn failed: /);
		assert.equal(diagnostic.originalCode, "ENOENT", "the thrown error keeps its fields");
		assert.equal(diagnostic.path, executable);
	});

	it("ends the request with the spawn diagnostic the real SDK rewraps as its spawn failure", async () => {
		const executable = unlaunchableClaude();
		__testSetSdkQueryFactory(); // the installed Claude Agent SDK; its spawn fails before anything runs
		const events = await collect(streamClaudeAgentSdk(model, context(), { sessionId: "spawn-sdk" }));
		assertSpawnFailure(events, (text) => {
			assert.ok(text.startsWith("Failed to spawn Claude Code process: Claude Code spawn failed: "), text);
			assert.ok(text.endsWith(` command=${executable})`), text);
		});
	});

	it("ends the request with the spawn diagnostic the SDK rewraps for a write after exit", async () => {
		const executable = unlaunchableClaude();
		const spawnError = Object.assign(new Error(`spawn ${executable} ENOENT`), { code: "ENOENT", errno: -2, syscall: `spawn ${executable}`, path: executable });
		const diagnostic = wrapClaudeSpawnErrorForSdk(spawnError, { command: executable, args: [], cwd: agentDir, env: {}, signal: new AbortController().signal });
		// The SDK's form (sdk.mjs ProcessTransport.write): its token redaction
		// leaves this text as it is, since it holds no credential.
		const rewrapped = new Error(`Cannot write to process that exited with error: Failed to spawn Claude Code process: ${diagnostic.message}`);
		__testSetSdkQueryFactory(() => ({
			async *[Symbol.asyncIterator]() { throw rewrapped; },
			close() {},
			async interrupt() {},
		}));
		const events = await collect(streamClaudeAgentSdk(model, context(), { sessionId: "spawn-write" }));
		assertSpawnFailure(events, (text) => assert.equal(text, rewrapped.message));
	});
});
