// Anthropic rejects a subscription request it treats as a third-party app with
// HTTP 400, and Claude Code reports it in Anthropic's words: "API Error: 400
// Third-party apps now draw from your extra usage, not your plan limits. ...".
// The bridge sends every request as it is and only explains this error.

/** True for Anthropic's third-party-app rejection, recognized by its own words. */
export function isThirdPartyAppRejection(text: string): boolean {
	return /third-party apps/i.test(text) && /extra usage/i.test(text);
}

// Fixed text with no runtime values: Pi's isRetryableAssistantError and
// isContextOverflow read the whole error, so a path or other value in it could
// make Pi retry or compact. This text matches neither.
const THIRD_PARTY_APP_HINT = "Pi Claude: Anthropic treats a system prompt that carries Pi's documentation line, with both "
	+ "\"custom providers (docs/custom-provider.md)\" and \"pi packages (docs/packages.md)\", as a third-party app. "
	+ "Set systemPrompt.replacement in the user claude-bridge.json (in ~/.pi/agent unless PI_CODING_AGENT_DIR moves it) to replace Pi's default prompt. "
	+ "An extension that copies Pi's full system prompt into its own model call has to send its own prompt instead.";

/** `message` with the bridge's hint added when it is Anthropic's third-party-app
 *  rejection; any other message unchanged. */
export function withThirdPartyAppHint(message: string): string {
	const hint = thirdPartyAppHintFor(message);
	return !hint || message.includes(hint) ? message : `${message}\n\n${hint}`;
}

/** The bridge's hint when `message` is Anthropic's third-party-app rejection. */
export function thirdPartyAppHintFor(message: string): string | undefined {
	return isThirdPartyAppRejection(message) ? THIRD_PARTY_APP_HINT : undefined;
}

/** `message` without the bridge's hint, for a report that quotes the failure
 *  and adds the hint on its own. */
export function withoutThirdPartyAppHint(message: string): string {
	return message.replace(`\n\n${THIRD_PARTY_APP_HINT}`, "");
}
