import { platform as osPlatform } from "node:os";
import { claudeChildEnv } from "./account-router.ts";
import { hasClaudeCredentials } from "./auth-presence.ts";
import { loadConfig } from "./config.ts";
import { connectorsEnabledFor, settingSourcesForQuery } from "./connectors.ts";

/** Checks whether a provider query can authenticate with the default account's environment and settings. */
export function hasDirectClaudeLogin(
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = osPlatform(),
): boolean {
	const config = loadConfig(cwd);
	return hasClaudeCredentials(
		claudeChildEnv(undefined, config.provider.inheritAnthropicEnv, env),
		platform,
		settingSourcesForQuery(connectorsEnabledFor(config), config.provider.settingSources),
	);
}
