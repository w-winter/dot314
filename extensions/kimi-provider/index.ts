/**
 * Kimi Code Provider Extension
 *
 * Registers a single provider (`kimi`) with one model (`kimi-for-coding`), using
 * Kimi's Anthropic-compatible "coding agents" endpoint.
 *
 * The OpenAI-compatible endpoint currently returns:
 *   "403 Kimi For Coding is currently only available for Coding Agents..."
 * when called from pi (OpenAI JS SDK user agent), so we intentionally do not
 * expose a second model/provider for it.
 */

import type { ExtensionAPI, ProviderModelConfig } from "@mariozechner/pi-coding-agent";

const DEFAULT_KIMI_ANTHROPIC_BASE_URL = "https://api.kimi.com/coding/";

function ensureTrailingSlash(url: string): string {
	return url.endsWith("/") ? url : `${url}/`;
}

function getFirstEnvValue(names: string[]): string | undefined {
	for (const name of names) {
		const value = process.env[name];
		if (value && value.trim().length > 0) return value;
	}
	return undefined;
}

const KIMI_FOR_CODING_MODEL: ProviderModelConfig = {
	id: "kimi-for-coding",
	name: "Kimi for Coding",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 262_144,
	maxTokens: 32_768,
};

export default function (pi: ExtensionAPI) {
	// Anthropic-compatible (Claude Code style)
	// Environment variables from Kimi docs:
	//   ANTHROPIC_BASE_URL=https://api.kimi.com/coding/
	//   ANTHROPIC_API_KEY=sk-kimi-...
	const anthropicBaseUrl = ensureTrailingSlash(
		getFirstEnvValue(["ANTHROPIC_BASE_URL", "KIMI_ANTHROPIC_BASE_URL"]) ?? DEFAULT_KIMI_ANTHROPIC_BASE_URL,
	);

	// Prefer ANTHROPIC_API_KEY (matches Kimi docs), but allow KIMI_API_KEY as a convenience
	const anthropicApiKey = getFirstEnvValue(["ANTHROPIC_API_KEY", "KIMI_API_KEY"]);

	pi.registerProvider("kimi", {
		baseUrl: anthropicBaseUrl,
		apiKey: anthropicApiKey ?? "ANTHROPIC_API_KEY",
		api: "anthropic-messages",
		models: [KIMI_FOR_CODING_MODEL],
	});
}
