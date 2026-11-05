import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import claudeBridge, { __testSetSdkQueryFactory } from "../src/index.ts";
import { CLAUDE_ACCOUNT_ROUTER_SYMBOL } from "../src/account-router.ts";
import { PARENT_SESSION_ENV } from "./fixtures/parent-session-env.mjs";

const CATALOG = [
	{ value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku", description: "Fast" },
	{ value: "claude-new-model[1m]", displayName: "New model", description: "New" },
];
const ENV_KEYS = ["PI_CODING_AGENT_DIR", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_BRIDGE_ISOLATED", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", ...Object.keys(PARENT_SESSION_ENV), "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"];
let root;
let previousEnv;
let commands;
let notices;
let inputs;
let closed;
let registered;
let keepAlive;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "bridge-model-catalog-"));
	previousEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	Object.assign(process.env, PARENT_SESSION_ENV, { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "0" });
	Object.assign(process.env, { PI_CODING_AGENT_DIR: root, CLAUDE_CONFIG_DIR: join(root, "claude"), CLAUDE_CODE_OAUTH_TOKEN: "offline-test", CLAUDE_BRIDGE_ISOLATED: "1", ANTHROPIC_API_KEY: "unused-key", ANTHROPIC_AUTH_TOKEN: "unused-token", ANTHROPIC_BASE_URL: "https://unused.invalid" });
	commands = new Map();
	notices = [];
	inputs = [];
	closed = 0;
	registered = [];
	claudeBridge({ on() {}, registerCommand(name, command) { commands.set(name, command); }, registerProvider(provider) { registered.push(provider); }, events: { emit() {} }, appendEntry() {} });
	__testSetSdkQueryFactory(input => {
		inputs.push(input);
		return { async supportedModels() { return CATALOG; }, close() { closed++; }, async interrupt() {} };
	});
	keepAlive = setInterval(() => {}, 1000);
});

afterEach(() => {
	clearInterval(keepAlive);
	__testSetSdkQueryFactory();
	delete globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL];
	for (const [key, value] of Object.entries(previousEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(root, { recursive: true, force: true });
});

const command = (context = {}) => commands.get("pi-claude").handler("models", { cwd: root, ui: { notify(message, level) { notices.push({ message, level }); } }, ...context });

it("reports the CLI catalog without a model prompt or changing provider registration", async () => {
	const registrationCount = registered.length;
	await command();
	assert.match(notices.at(-1).message, /claude-haiku-4-5-20251001/);
	assert.match(notices.at(-1).message, /claude-new-model\[1m\]/);
	assert.match(notices.at(-1).message, /not listed/i);
	assert.equal(notices.at(-1).level, "info");
	assert.equal(registered.length, registrationCount);
	assert.deepEqual(await inputs[0].prompt[Symbol.asyncIterator]().next(), { value: undefined, done: true }, "the SDK input stream emits no model prompt");
	assert.equal(inputs[0].options.env.ANTHROPIC_API_KEY, undefined);
	assert.equal(inputs[0].options.env.ANTHROPIC_AUTH_TOKEN, undefined);
	assert.equal(inputs[0].options.env.ANTHROPIC_BASE_URL, undefined);
	for (const key of Object.keys(PARENT_SESSION_ENV)) assert.equal(inputs[0].options.env[key], key === "CLAUDE_CODE_ENTRYPOINT" ? "pi-claude-bridge" : undefined, key);
	assert.equal(inputs[0].options.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
	assert.equal(closed, 1);
});

it("uses the active managed profile and refuses to substitute the default login", async () => {
	let profile = { profileId: "b", label: "Account B", configDir: join(root, "profile-b") };
	globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL] = {
		version: 1,
		current(modelId, sessionId) { assert.equal(modelId, "claude-haiku-5-5"); assert.equal(sessionId, "catalog-session"); return profile; },
		acquire() { assert.fail("discovery must not select or rotate an account"); },
	};
	const context = { model: { id: "claude-haiku-5-5", provider: "pi-claude" }, sessionManager: { getSessionId() { return "catalog-session"; } } };
	await command(context);
	assert.equal(inputs[0].options.env.CLAUDE_CONFIG_DIR, profile.configDir);
	assert.equal(inputs[0].options.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
	for (const key of Object.keys(PARENT_SESSION_ENV)) assert.equal(inputs[0].options.env[key], key === "CLAUDE_CODE_ENTRYPOINT" ? "pi-claude-bridge" : undefined, key);
	assert.equal(inputs[0].options.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
	assert.match(notices.at(-1).message, /Account B/);
	profile = undefined;
	await command(context);
	assert.equal(inputs.length, 1);
	assert.match(notices.at(-1).message, /select|selected/i);
	assert.equal(notices.at(-1).level, "warning");
});

it("reports discovery failure and can retry on the next explicit command", async () => {
	let attempts = 0;
	__testSetSdkQueryFactory(() => ({
		async supportedModels() { if (attempts++ === 0) throw new Error("initialization failed"); return CATALOG; },
		close() { closed++; },
	}));
	await command();
	assert.equal(notices.at(-1).level, "error");
	await command();
	assert.equal(notices.at(-1).level, "info");
	assert.equal(attempts, 2);
	assert.equal(closed, 2);
});

it("cancels a pending discovery and closes its worker", async () => {
	__testSetSdkQueryFactory(input => { inputs.push(input); return { supportedModels() { return new Promise(() => {}); }, close() { closed++; } }; });
	const controller = new AbortController();
	const pending = command({ signal: controller.signal });
	controller.abort();
	await pending;
	assert.equal(closed, 1);
	assert.equal(inputs[0].options.abortController.signal.aborted, true);
	assert.equal(notices.at(-1).level, "info");
	assert.match(notices.at(-1).message, /cancel/i);
});

it("bounds an unresponsive discovery instead of leaving the command pending", async context => {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	__testSetSdkQueryFactory(input => { inputs.push(input); return { supportedModels() { return new Promise(() => {}); }, close() { closed++; } }; });
	const pending = command();
	context.mock.timers.tick(10_000);
	await pending;
	assert.equal(closed, 1);
	assert.equal(inputs[0].options.abortController.signal.aborted, true);
	assert.equal(notices.at(-1).level, "error");
});
