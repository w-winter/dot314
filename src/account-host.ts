// Reciprocal account-host service: a local /usage probe the companion account
// manager calls to read a profile's identity and usage figures under that
// profile's credential scope. Extracted from index.ts (pure move).

import { subscriberProfileEnv, type ClaudeAccountRoute, type ClaudeBridgeAccountHostV1 } from "./account-router.js";
import { preflightClaudeExecutable, resolveClaudeExecutable, spawnClaudeCodeWithDiagnostics } from "./claude-executable.js";
import { loadConfig } from "./config.js";
import { CLAUDE_BRIDGE_TOOL_ISOLATION, denyAllToolsHook } from "./connectors.js";
import { debug, makeCliDebugOptions } from "./debug.js";
import { sdkQueryFactory } from "./sdk-query.js";

/** Local /usage probe for the reciprocal account-host service: the companion
 *  account manager asks the bridge (the SDK owner) to read a profile's identity
 *  and usage figures under that profile's credential scope. */
// This is a published entry point (BRIDGE_ACCOUNT_HOST.probeProfile) and
// `signal` is optional, so a stalled child with no caller signal would hang the
// returned promise forever and leak the process. The internal deadline bounds
// every call; generous next to the in-query probe's 1.5s race because a cold
// child spawn is part of the budget here.
const ACCOUNT_PROBE_DEADLINE_MS = 10_000;

export async function probeClaudeAccountProfile(input: {
	profile: ClaudeAccountRoute;
	cwd: string;
	signal?: AbortSignal;
	/** Deadline override for tests; production callers use the default. */
	deadlineMs?: number;
}): Promise<{
	identity?: { email?: string; organization?: string; subscriptionType?: string; authMethod?: string };
	usage?: unknown;
}> {
	const config = loadConfig(input.cwd);
	const claudeExecutable = resolveClaudeExecutable(config.provider?.pathToClaudeCodeExecutable);
	if (claudeExecutable) preflightClaudeExecutable(claudeExecutable, input.cwd);
	const probe = sdkQueryFactory({
		prompt: "/usage",
		options: {
			cwd: input.cwd,
			env: {
				...subscriberProfileEnv(input.profile),
				ENABLE_CLAUDEAI_MCP_SERVERS: "0",
				DISABLE_AUTO_COMPACT: "1",
			},
			maxTurns: 1,
			// bypassPermissions makes tool containment the only gate, so the probe
			// gets BOTH layers: the standard bridge isolation lists AND a deny-all
			// PreToolUse hook — a /usage probe has no business executing anything.
			permissionMode: "bypassPermissions",
			...CLAUDE_BRIDGE_TOOL_ISOLATION,
			hooks: { PreToolUse: [{ hooks: [denyAllToolsHook()] }] },
			...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
			spawnClaudeCodeProcess: spawnClaudeCodeWithDiagnostics,
			...makeCliDebugOptions("account-probe"),
		},
	});
	const onAbort = () => {
		void probe.interrupt().catch(() => {});
		try { probe.close(); } catch {}
	};
	if (input.signal?.aborted) onAbort();
	else input.signal?.addEventListener("abort", onAbort, { once: true });
	let controls: Promise<{
		identity?: { email?: string; organization?: string; subscriptionType?: string; authMethod?: string };
		usage?: unknown;
	}> | undefined;
	let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<"deadline">((resolveDeadline) => {
		deadlineTimer = setTimeout(() => {
			debug(`account-probe: deadline expired for ${input.profile.label}; killing probe child`);
			onAbort();
			resolveDeadline("deadline");
		}, input.deadlineMs ?? ACCOUNT_PROBE_DEADLINE_MS);
		deadlineTimer.unref?.();
	});
	const consume = (async () => {
		for await (const message of probe) {
			if (message.type === "system" && (message as any).subtype === "init" && !controls) {
				controls = Promise.allSettled([
					probe.accountInfo(),
					probe.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(),
				]).then(([identityResult, usageResult]) => ({
					...(identityResult.status === "fulfilled" ? { identity: {
						email: identityResult.value.email,
						organization: identityResult.value.organization,
						subscriptionType: identityResult.value.subscriptionType,
					} } : {}),
					...(usageResult.status === "fulfilled" ? { usage: usageResult.value } : {}),
				}));
			}
		}
		return controls ? await controls : {};
	})();
	try {
		// The race — not close() alone — is what guarantees the promise settles: a
		// truly wedged child can survive close(), and then the for-await above
		// never ends.
		const result = await Promise.race([consume, deadline]);
		return result === "deadline" ? {} : result;
	} finally {
		clearTimeout(deadlineTimer);
		input.signal?.removeEventListener("abort", onAbort);
		probe.close();
		// After a deadline kill the consumer may still reject; that outcome is
		// already accounted for.
		void consume.catch(() => {});
	}
}

export const BRIDGE_ACCOUNT_HOST: ClaudeBridgeAccountHostV1 = {
	version: 1,
	probeProfile: probeClaudeAccountProfile,
};
