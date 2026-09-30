// Anthropic rejects a subscription request it treats as a third-party app with
// HTTP 400, and Claude Code reports it in Anthropic's words: "API Error: 400
// Third-party apps now draw from your extra usage, not your plan limits. ...".
// The bridge sends every request as it is and only explains this error.

import { join } from "node:path";
import { displayPath, piUserDir } from "./config.js";

/** True for Anthropic's third-party-app rejection, recognized by its own words. */
export function isThirdPartyAppRejection(text: string): boolean {
	return /third-party apps/i.test(text) && /extra usage/i.test(text);
}

// The hint avoids everything Pi's isRetryableAssistantError and
// isContextOverflow match, so Pi neither retries nor compacts on the error.
function thirdPartyAppHint(): string {
	return "Pi Claude: Anthropic treats a system prompt that carries Pi's documentation line, with both "
		+ "\"custom providers (docs/custom-provider.md)\" and \"pi packages (docs/packages.md)\", as a third-party app. "
		+ `Set systemPrompt.replacement in ${displayPath(join(piUserDir(), "claude-bridge.json"))} to replace Pi's default prompt. `
		+ "An extension that copies Pi's full system prompt into its own model call has to send its own prompt instead.";
}

/** `message` with the bridge's hint added when it is Anthropic's third-party-app
 *  rejection; any other message unchanged. */
export function withThirdPartyAppHint(message: string): string {
	if (!isThirdPartyAppRejection(message)) return message;
	const hint = thirdPartyAppHint();
	return message.includes(hint) ? message : `${message}\n\n${hint}`;
}
