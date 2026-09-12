/**
 * Tests for the native (pi >=0.81) provider construction — bridge 2.x's
 * replacement for the credential-gated register/unregister state machine.
 * The provider registers unconditionally; these tests pin that its auth
 * check/resolve report configured-ness truthfully (that is what makes pi hide
 * unconfigured claude-bridge models), that credential probes run at CALL time
 * (login/logout between calls is seen), and that both stream entry points are
 * the Claude Code subprocess router.
 * Uses the real modules — no API calls, no extension activation.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	NATIVE_PROVIDER_UNSUPPORTED_MESSAGE,
	buildNativeProvider,
	claudeAuthSourceLabel,
	supportsNativeProvider,
} from "../src/native-provider.ts";
import * as piAi from "@earendil-works/pi-ai";

// The darwin keychain fallback makes "no credentials" unobservable via env
// probes; production embedders and CI are linux, so pin the unconfigured-case
// assertions there.
const onDarwin = process.platform === "darwin";

async function withTempConfigDir(fn) {
	const dir = mkdtempSync(join(tmpdir(), "claude-bridge-native-test-"));
	try {
		return await fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const MODELS = [
	{ id: "claude-haiku-4-5", name: "Claude Haiku 4.5", reasoning: false, input: ["text"], contextWindow: 200000, maxTokens: 64000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
];

describe("supportsNativeProvider", () => {
	it("detects the installed pi-ai (>=0.81) as supported", () => {
		assert.equal(supportsNativeProvider(piAi), true);
	});

	it("rejects hosts without createProvider (pi-ai 0.80.x shape)", () => {
		assert.equal(supportsNativeProvider({}), false);
		assert.equal(supportsNativeProvider(undefined), false);
		assert.equal(supportsNativeProvider({ createProvider: "nope" }), false);
	});
});

describe("claudeAuthSourceLabel", () => {
	it("names the env token that will authenticate, else the login default", () => {
		assert.equal(claudeAuthSourceLabel({ CLAUDE_CODE_OAUTH_TOKEN: "tok" }), "CLAUDE_CODE_OAUTH_TOKEN");
		assert.equal(claudeAuthSourceLabel({ ANTHROPIC_API_KEY: "key" }), "ANTHROPIC_API_KEY");
		assert.equal(claudeAuthSourceLabel({}), "Claude Code login");
	});
});

describe("buildNativeProvider", () => {
	it("throws the versioned message on a pre-0.81 host shape", () => {
		assert.throws(() => buildNativeProvider({}, MODELS, () => {}), new RegExp("requires pi >= 0.81"));
		assert.match(NATIVE_PROVIDER_UNSUPPORTED_MESSAGE, /pi-claude-bridge@1\.x/);
	});

	it("builds a provider whose id, models, and stamped fields match the bridge contract", () => {
		const provider = buildNativeProvider(piAi, MODELS, () => {}, {});
		assert.equal(provider.id, "pi-claude");
		const models = provider.getModels();
		assert.equal(models.length, 1);
		assert.equal(models[0].id, "claude-haiku-4-5");
		// The legacy config path stamped these during composition; the native
		// path must stamp them itself or downstream provider routing breaks.
		assert.equal(models[0].provider, "pi-claude");
		assert.equal(models[0].api, "claude-bridge");
	});

	it("re-homes source models under pi-claude even when they carry a provider field", () => {
		const provider = buildNativeProvider(piAi, [{ ...MODELS[0], provider: "anthropic" }], () => {}, {});
		assert.equal(provider.getModels()[0].provider, "pi-claude");
		assert.equal(provider.getModels()[0].api, "claude-bridge");
	});

	it("accepts a dynamic companion account-pool credential probe", async () => {
		let available = false;
		const provider = buildNativeProvider(piAi, MODELS, () => {}, {}, () => available);
		assert.equal(await provider.auth.apiKey.check({ ctx: {} }), undefined);
		available = true;
		assert.deepEqual(
			await provider.auth.apiKey.check({ ctx: {} }),
			{ type: "api_key", source: "Claude Code login" },
		);
		assert.equal((await provider.auth.apiKey.resolve({ ctx: {} })).auth.apiKey, "not-used");
	});

	it("reports unconfigured when no credential signal exists", { skip: onDarwin }, () => withTempConfigDir(async (dir) => {
		const provider = buildNativeProvider(piAi, MODELS, () => {}, { CLAUDE_CONFIG_DIR: dir });
		assert.equal(await provider.auth.apiKey.check({ ctx: {} }), undefined);
		assert.equal(await provider.auth.apiKey.resolve({ ctx: {} }), undefined);
	}));

	it("reports configured with a source label when credentials exist", () => withTempConfigDir(async (dir) => {
		writeFileSync(join(dir, ".credentials.json"), "{}");
		const provider = buildNativeProvider(piAi, MODELS, () => {}, { CLAUDE_CONFIG_DIR: dir });
		const check = await provider.auth.apiKey.check({ ctx: {} });
		assert.deepEqual(check, { type: "api_key", source: "Claude Code login" });
		const resolved = await provider.auth.apiKey.resolve({ ctx: {} });
		assert.equal(resolved.auth.apiKey, "not-used");
		assert.equal(resolved.source, "Claude Code login");
	}));

	it("re-probes credentials at call time — login and logout between calls are seen", { skip: onDarwin }, () => withTempConfigDir(async (dir) => {
		const provider = buildNativeProvider(piAi, MODELS, () => {}, { CLAUDE_CONFIG_DIR: dir });
		assert.equal(await provider.auth.apiKey.check({ ctx: {} }), undefined, "starts unconfigured");
		writeFileSync(join(dir, ".credentials.json"), "{}");
		assert.notEqual(await provider.auth.apiKey.check({ ctx: {} }), undefined, "login is seen without rebuilding the provider");
		rmSync(join(dir, ".credentials.json"));
		assert.equal(await provider.auth.apiKey.check({ ctx: {} }), undefined, "logout is seen without rebuilding the provider");
	}));

	it("routes BOTH stream entry points through the given streamSimple (subscription billing path)", () => {
		const calls = [];
		const streamSimple = (...args) => { calls.push(args); return "stream-result"; };
		const provider = buildNativeProvider(piAi, MODELS, streamSimple, {});
		const model = provider.getModels()[0];
		assert.equal(provider.streamSimple(model, { messages: [] }, {}), "stream-result");
		assert.equal(provider.stream(model, { messages: [] }, {}), "stream-result");
		assert.equal(calls.length, 2);
	});
});
