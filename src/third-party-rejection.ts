// Anthropic rejects a subscription request it treats as a third-party app with
// HTTP 400, and Claude Code reports it in Anthropic's words: "API Error: 400
// Third-party apps now draw from your extra usage, not your plan limits. ...".

/** True for Anthropic's third-party-app rejection, recognized by its own words. */
export function isThirdPartyAppRejection(text: string): boolean {
	return /third-party apps/i.test(text) && /extra usage/i.test(text);
}
