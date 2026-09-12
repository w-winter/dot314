// --- Claude credential presence (availability honesty) ---
//
// The bridge may only advertise claude-bridge models when the machine actually
// has Claude credentials the Claude Agent SDK can authenticate with. Otherwise
// pi's ModelRegistry.hasConfiguredAuth() would treat the dummy `apiKey:
// "not-used"` as "configured" and the provider would look connected while every
// request fails at spawn time.
//
// This module answers one pure question: hasClaudeCredentials() — are real
// credentials present RIGHT NOW? Since 2.0 it feeds the native provider's
// auth check/resolve (native-provider.ts) and the pre-spawn fail-fast, rather
// than gating register/unregister transitions (the 1.x decideRegistration
// state machine is gone — registration is unconditional and pi hides
// unconfigured providers' models itself).
//
// SECURITY: this module only ever checks for the EXISTENCE of credentials — a
// file's presence, an env var being non-empty, a settings key being a non-empty
// string. It NEVER opens or logs `.credentials.json`, and where it must parse
// `settings.json` (for apiKeyHelper) it reads only whether the key is a
// non-empty string and never logs its value. Credential CONTENTS are never read
// or logged.

import { existsSync, readFileSync } from "fs";
import { homedir, platform as osPlatform } from "os";
import { join } from "path";

/**
 * Resolve the Claude config directory the same way the bundled cc-session-io
 * (getClaudeDir) and Claude Code itself resolve it: an explicit
 * CLAUDE_CONFIG_DIR wins, otherwise ~/.claude.
 *
 * Deliberate divergence from cc-session-io's plain `env ?? default`: we treat a
 * SET-BUT-EMPTY/whitespace CLAUDE_CONFIG_DIR as unset and fall back to ~/.claude
 * (an empty string would otherwise resolve credential probes to the process cwd
 * root). The returned value is trimmed so downstream joins never carry stray
 * whitespace.
 */
export function resolveClaudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env.CLAUDE_CONFIG_DIR;
	if (typeof configured === "string" && configured.trim().length > 0) return configured.trim();
	return join(homedir(), ".claude");
}

function nonEmptyEnv(value: string | undefined): boolean {
	return typeof value === "string" && value.trim().length > 0;
}

// Matches how Claude Code interprets its boolean provider-routing env flags:
// only "1" / "true" (case-insensitive) enable them.
function envTruthy(value: string | undefined): boolean {
	const v = value?.trim().toLowerCase();
	return v === "1" || v === "true";
}

/**
 * True when `${configDir}/settings.json` exists, parses as JSON, and carries a
 * non-empty `apiKeyHelper` string (an enterprise/custom auth command that
 * produces a key). Parse/read errors are tolerated as "not present". The helper
 * VALUE is never logged — only its presence/non-emptiness is used.
 */
function hasApiKeyHelper(configDir: string): boolean {
	try {
		const settingsPath = join(configDir, "settings.json");
		if (!existsSync(settingsPath)) return false;
		const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as { apiKeyHelper?: unknown };
		return typeof parsed?.apiKeyHelper === "string" && parsed.apiKeyHelper.trim().length > 0;
	} catch {
		return false;
	}
}

/**
 * True when real Claude credentials are present in any location the Claude Agent
 * SDK would authenticate from, WITHOUT reading credential contents. Checked in
 * cheap-first order:
 *   - env: non-empty CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY /
 *     ANTHROPIC_AUTH_TOKEN, or any truthy cloud-provider routing flag the Claude
 *     Code SDK recognizes — CLAUDE_CODE_USE_BEDROCK / _VERTEX / _FOUNDRY /
 *     _ANTHROPIC_AWS / _MANTLE (such routing needs no local key file);
 *   - `.credentials.json` in the resolved config dir (existence only — the file
 *     is never opened; written mode 0600 by `claude login`);
 *   - `settings.json` apiKeyHelper (presence only — see hasApiKeyHelper).
 *
 * PLATFORM ASYMMETRY: on macOS the `claude` CLI stores OAuth tokens in the login
 * Keychain, NOT in `.credentials.json`, so file-absence is NOT evidence of
 * logged-out and we cannot cheaply/safely probe the Keychain here. On darwin,
 * when no other signal is present, we default to credentialed=true — preserving
 * an "always available" result for Mac subscription users. Honesty
 * enforcement therefore applies on Linux/Windows, where `.credentials.json`
 * existence is an observable, truthful proxy (empirically, `claude auth logout`
 * unlinks it).
 */
export function hasClaudeCredentials(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = osPlatform(),
): boolean {
	if (nonEmptyEnv(env.CLAUDE_CODE_OAUTH_TOKEN)) return true;
	if (nonEmptyEnv(env.ANTHROPIC_API_KEY)) return true;
	if (nonEmptyEnv(env.ANTHROPIC_AUTH_TOKEN)) return true;
	if (envTruthy(env.CLAUDE_CODE_USE_BEDROCK)) return true;
	if (envTruthy(env.CLAUDE_CODE_USE_VERTEX)) return true;
	if (envTruthy(env.CLAUDE_CODE_USE_FOUNDRY)) return true;
	if (envTruthy(env.CLAUDE_CODE_USE_ANTHROPIC_AWS)) return true;
	if (envTruthy(env.CLAUDE_CODE_USE_MANTLE)) return true;

	const configDir = resolveClaudeConfigDir(env);
	if (existsSync(join(configDir, ".credentials.json"))) return true;
	if (hasApiKeyHelper(configDir)) return true;

	if (platform === "darwin") return true;

	return false;
}
