// Native pi >=0.81 provider construction (bridge 2.x).
//
// Bridge 1.x could not register unconditionally: pi's legacy
// ModelRegistry.hasConfiguredAuth() treated the dummy `apiKey: "not-used"` as
// "configured", so the models looked connected while every request failed at
// spawn. 1.x therefore gated register/unregister on real credential presence
// (decideRegistration). The native Provider form inverts that: the provider is
// ALWAYS registered, and `auth.apiKey.check/resolve` report configured-ness
// from the same existence-only probes, so pi itself hides claude-bridge models
// while no Claude credentials are present and shows them when they appear.
//
// What the native form does NOT change (see DEVELOPMENT.md "Provider
// registration"): the process-global primary-instance/stream-guard tokens stay
// (pi's registerNativeProvider is replace-by-id, so an unguarded subagent
// re-registration would still swap in its own streamSimple), and the pre-spawn
// credential fail-fast in streamSimple stays (a mid-session logout must fail
// the turn with an actionable message even if the picker snapshot is stale).
//
// SECURITY: like auth-presence.ts, this module only reports credential
// EXISTENCE. resolve() hands pi the same dummy key the legacy config carried —
// the Claude Code subprocess does its own authentication; pi never needs a
// real secret, so none is read or exposed.

import { hasClaudeCredentials } from "./auth-presence.js";
import { PROVIDER_ID } from "./convert.js";

export const NATIVE_PROVIDER_UNSUPPORTED_MESSAGE =
	"Claude bridge 2.x requires pi >= 0.81 (native provider API). Upgrade the host pi, or pin @vanillagreen/pi-claude-bridge@1.x.";

/** pi-ai gained createProvider in 0.81 alongside the object-form
 *  registerProvider; its presence is the capability signal for both. */
export function supportsNativeProvider(piAi: unknown): boolean {
	return typeof (piAi as { createProvider?: unknown })?.createProvider === "function";
}

/** Auth source label for pi's status UI, chosen by the same existence-only
 *  probes hasClaudeCredentials uses. Never reads credential contents. */
export function claudeAuthSourceLabel(env: NodeJS.ProcessEnv = process.env): string {
	if (env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) return "CLAUDE_CODE_OAUTH_TOKEN";
	if (env.ANTHROPIC_API_KEY?.trim()) return "ANTHROPIC_API_KEY";
	if (env.ANTHROPIC_AUTH_TOKEN?.trim()) return "ANTHROPIC_AUTH_TOKEN";
	return "Claude Code login";
}

/**
 * Build the Provider object for pi.registerProvider(provider).
 *
 * `piAi` is the HOST's pi-ai namespace (the bundle externalizes it), passed in
 * rather than imported so a pre-0.81 host fails the supportsNativeProvider()
 * check with a clear message instead of crashing module load on a missing
 * named export. `env` is bindable for tests; the credential probes themselves
 * run at check/resolve CALL time, so a login/logout between calls is seen.
 */
export function buildNativeProvider(
	piAi: unknown,
	models: Array<Record<string, unknown>>,
	streamSimple: (...args: unknown[]) => unknown,
	env: NodeJS.ProcessEnv = process.env,
	// Availability probe. Defaults to direct credential presence; the extension
	// passes a probe that also accepts a companion account-router pool.
	hasCredentials: () => boolean = () => hasClaudeCredentials(env),
): unknown {
	if (!supportsNativeProvider(piAi)) throw new Error(NATIVE_PROVIDER_UNSUPPORTED_MESSAGE);
	// The legacy config path stamped provider/api/baseUrl onto each model during
	// composition; createProvider passes models through verbatim, so stamp here.
	// Stamps win over any provider field the source model carries — the models
	// come from pi-ai's anthropic registry and must be re-homed under pi-claude.
	const stamped = models.map((model) => ({ ...model, api: "claude-bridge", baseUrl: "claude-bridge", provider: PROVIDER_ID }));
	// The Claude Code subprocess router IS the implementation for both stream
	// entry points — there is no raw-API shape to dispatch to.
	const streams = {
		stream: streamSimple,
		streamSimple,
	};
	return (piAi as { createProvider: (input: unknown) => unknown }).createProvider({
		id: PROVIDER_ID,
		name: "Pi Claude",
		baseUrl: "claude-bridge",
		auth: {
			apiKey: {
				name: "Claude Code credentials",
				// check() exists so pi's availability pass never has to call
				// resolve(): both are existence-only, but check is the documented
				// side-effect-free probe.
				check: async () => (hasCredentials() ? { type: "api_key" as const, source: claudeAuthSourceLabel(env) } : undefined),
				resolve: async () => (hasCredentials()
					? { auth: { apiKey: "not-used" }, source: claudeAuthSourceLabel(env) }
					: undefined),
			},
		},
		models: stamped,
		api: streams,
	});
}
