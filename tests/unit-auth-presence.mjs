/**
 * Tests for claude-bridge credential presence detection and the pure
 * registration decision that gates provider availability (W8-2 availability
 * honesty). These exercise auth-presence.ts directly — no live pi instance.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveClaudeConfigDir, hasClaudeCredentials } from "../src/auth-presence.ts";

function withTempHome(fn) {
	const root = mkdtempSync(join(tmpdir(), "claude-bridge-auth-"));
	try {
		return fn(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

// Pin the platform to linux in credential tests so the darwin Keychain default
// never masks a real false/true; darwin behavior is tested explicitly.
const LINUX = "linux";

describe("resolveClaudeConfigDir", () => {
	it("prefers an explicit non-empty CLAUDE_CONFIG_DIR", () => {
		assert.equal(resolveClaudeConfigDir({ CLAUDE_CONFIG_DIR: "/custom/dir" }), "/custom/dir");
	});

	it("returns the TRIMMED CLAUDE_CONFIG_DIR value", () => {
		assert.equal(resolveClaudeConfigDir({ CLAUDE_CONFIG_DIR: "  /custom/dir  " }), "/custom/dir");
	});

	it("ignores an empty/whitespace CLAUDE_CONFIG_DIR and falls back to ~/.claude", () => {
		const fallback = resolveClaudeConfigDir({ CLAUDE_CONFIG_DIR: "   " });
		assert.ok(fallback.endsWith("/.claude"), `expected ~/.claude fallback, got ${fallback}`);
	});

	it("falls back to ~/.claude when unset", () => {
		const fallback = resolveClaudeConfigDir({});
		assert.ok(fallback.endsWith("/.claude"), `expected ~/.claude fallback, got ${fallback}`);
	});
});

describe("hasClaudeCredentials", () => {
	it("is false when no signal and no .credentials.json exists (linux)", () => withTempHome((dir) => {
		assert.equal(hasClaudeCredentials({ CLAUDE_CONFIG_DIR: dir }, LINUX), false);
	}));

	it("is true when .credentials.json exists in the resolved config dir", () => withTempHome((dir) => {
		writeFileSync(join(dir, ".credentials.json"), "{}");
		assert.equal(hasClaudeCredentials({ CLAUDE_CONFIG_DIR: dir }, LINUX), true);
	}));

	it("honors CLAUDE_CONFIG_DIR override for the credentials file location", () => withTempHome((dir) => {
		const nested = join(dir, "alt");
		mkdirSync(nested, { recursive: true });
		writeFileSync(join(nested, ".credentials.json"), "{}");
		assert.equal(hasClaudeCredentials({ CLAUDE_CONFIG_DIR: nested }, LINUX), true);
		assert.equal(hasClaudeCredentials({ CLAUDE_CONFIG_DIR: dir }, LINUX), false);
	}));

	// Env-based credential sources (no file needed) --------------------------
	it("is true for non-empty CLAUDE_CODE_OAUTH_TOKEN", () => withTempHome((dir) => {
		assert.equal(hasClaudeCredentials({ CLAUDE_CONFIG_DIR: dir, CLAUDE_CODE_OAUTH_TOKEN: "tok" }, LINUX), true);
	}));

	it("is true for non-empty ANTHROPIC_API_KEY", () => withTempHome((dir) => {
		assert.equal(hasClaudeCredentials({ CLAUDE_CONFIG_DIR: dir, ANTHROPIC_API_KEY: "sk-ant-x" }, LINUX), true);
	}));

	it("is true for non-empty ANTHROPIC_AUTH_TOKEN", () => withTempHome((dir) => {
		assert.equal(hasClaudeCredentials({ CLAUDE_CONFIG_DIR: dir, ANTHROPIC_AUTH_TOKEN: "at-x" }, LINUX), true);
	}));

	it("is true for truthy CLAUDE_CODE_USE_BEDROCK (1/true), false otherwise", () => withTempHome((dir) => {
		assert.equal(hasClaudeCredentials({ CLAUDE_CONFIG_DIR: dir, CLAUDE_CODE_USE_BEDROCK: "1" }, LINUX), true);
		assert.equal(hasClaudeCredentials({ CLAUDE_CONFIG_DIR: dir, CLAUDE_CODE_USE_BEDROCK: "true" }, LINUX), true);
		assert.equal(hasClaudeCredentials({ CLAUDE_CONFIG_DIR: dir, CLAUDE_CODE_USE_BEDROCK: "0" }, LINUX), false);
		assert.equal(hasClaudeCredentials({ CLAUDE_CONFIG_DIR: dir, CLAUDE_CODE_USE_BEDROCK: "yes" }, LINUX), false);
	}));

	it("is true for truthy CLAUDE_CODE_USE_VERTEX (1/true)", () => withTempHome((dir) => {
		assert.equal(hasClaudeCredentials({ CLAUDE_CONFIG_DIR: dir, CLAUDE_CODE_USE_VERTEX: "1" }, LINUX), true);
		assert.equal(hasClaudeCredentials({ CLAUDE_CONFIG_DIR: dir, CLAUDE_CODE_USE_VERTEX: "false" }, LINUX), false);
	}));

	it("is true for truthy CLAUDE_CODE_USE_FOUNDRY / _ANTHROPIC_AWS / _MANTLE", () => withTempHome((dir) => {
		for (const flag of ["CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_USE_ANTHROPIC_AWS", "CLAUDE_CODE_USE_MANTLE"]) {
			assert.equal(hasClaudeCredentials({ CLAUDE_CONFIG_DIR: dir, [flag]: "1" }, LINUX), true, `${flag}=1`);
			assert.equal(hasClaudeCredentials({ CLAUDE_CONFIG_DIR: dir, [flag]: "true" }, LINUX), true, `${flag}=true`);
			assert.equal(hasClaudeCredentials({ CLAUDE_CONFIG_DIR: dir, [flag]: "0" }, LINUX), false, `${flag}=0`);
		}
	}));

	it("treats empty/whitespace token env vars as absent", () => withTempHome((dir) => {
		assert.equal(hasClaudeCredentials({ CLAUDE_CONFIG_DIR: dir, CLAUDE_CODE_OAUTH_TOKEN: "", ANTHROPIC_API_KEY: "   ", ANTHROPIC_AUTH_TOKEN: "" }, LINUX), false);
	}));

	// settings.json apiKeyHelper ---------------------------------------------
	it("is true when settings.json has a non-empty apiKeyHelper string", () => withTempHome((dir) => {
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ apiKeyHelper: "/usr/local/bin/get-key.sh" }));
		assert.equal(hasClaudeCredentials({ CLAUDE_CONFIG_DIR: dir }, LINUX), true);
	}));

	it("is false when settings.json lacks apiKeyHelper or it is empty", () => withTempHome((dir) => {
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ apiKeyHelper: "", other: 1 }));
		assert.equal(hasClaudeCredentials({ CLAUDE_CONFIG_DIR: dir }, LINUX), false);
	}));

	it("tolerates malformed settings.json as apiKeyHelper-absent", () => withTempHome((dir) => {
		writeFileSync(join(dir, "settings.json"), "{ not valid json");
		assert.equal(hasClaudeCredentials({ CLAUDE_CONFIG_DIR: dir }, LINUX), false);
	}));

	// Platform asymmetry -----------------------------------------------------
	it("defaults to credentialed on darwin when no other signal is present", () => withTempHome((dir) => {
		assert.equal(hasClaudeCredentials({ CLAUDE_CONFIG_DIR: dir }, "darwin"), true);
	}));

	it("does NOT default-credential on linux/win32 without a signal", () => withTempHome((dir) => {
		assert.equal(hasClaudeCredentials({ CLAUDE_CONFIG_DIR: dir }, "linux"), false);
		assert.equal(hasClaudeCredentials({ CLAUDE_CONFIG_DIR: dir }, "win32"), false);
	}));
});
