// Connector prime/snapshot host: the per-credential-scope inventory cache the
// query path reads synchronously. Extracted from index.ts —
// this is process-lifetime runtime state, not provider streaming logic.
//
// Connector declarations for the query path, cached per credential scope. The
// inventory is one HTTPS round trip; doing it per TURN would add that latency
// to every message, and an account's connector set does not change
// mid-session. Keyed by CLAUDE_CONFIG_DIR because that is what selects the
// account — the org UUID in the request path is ignored, so two accounts on
// one host differ only by which credential directory was read.
//
// FAILS OPEN. If credentials or the inventory call fail we return no
// declarations and the turn proceeds exactly as it does today: connectors may
// race, which is the bug, but a network blip must not break the turn outright.

import { readFileSync as nodeReadFileSync } from "node:fs";
import { readCachedConnectors, scopeKeyFor, writeCachedConnectors } from "./connector-cache.js";
import { listAccountConnectors, resolveClaudeOAuth } from "./connector-inventory.js";
import { connectorMcpServers } from "./connectors.js";
import { debug } from "./debug.js";

// Read a credential file, treating any read error as "absent" — a missing or
// unreadable candidate must fall through to the next one, not abort resolution.
export function readCredentialFile(path: string): string | undefined {
	try {
		return nodeReadFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

const connectorServerCache = new Map<string, Record<string, unknown>>();
const connectorServerPending = new Set<string>();
// Epoch ms of the last FAILED inventory attempt per scope, so a persistently
// failing account cools down instead of issuing one HTTPS request per turn
//  Missing credentials are exempt: that check is a local file read
// with no request to bound, and a just-completed `claude login` must take
// effect on the next turn.
const connectorServerFailureAt = new Map<string, number>();

// Deadline on the inventory round trip. Without one, a hung claude.ai request
// held the pending flag forever — same budget as the account-host probe's
// ACCOUNT_PROBE_DEADLINE_MS.
const CONNECTOR_PRIME_TIMEOUT_MS = 10_000;
const CONNECTOR_PRIME_FAILURE_COOLDOWN_MS = 60_000;

/** Overrides for tests; production callers use the defaults. */
export type PrimeConnectorOverrides = {
	timeoutMs?: number;
	failureCooldownMs?: number;
	now?: () => number;
};

function connectorScopeKey(claudeConfigDir: string | undefined = process.env.CLAUDE_CONFIG_DIR): string {
	// One rule for every scope key — the on-disk cache and this in-memory cache
	// must name the same scopes (see scopeKeyFor).
	return scopeKeyFor(claudeConfigDir);
}

// Credential resolution env for a selected scope: managed requests always pass
// their RESOLVED dir (accountSessionScope), so the parent's CLAUDE_CONFIG_DIR
// never leaks into another profile's lookup; legacy passes undefined and keeps
// the process-env rule.
export function connectorCredentialEnv(claudeConfigDir: string | undefined = process.env.CLAUDE_CONFIG_DIR): NodeJS.ProcessEnv {
	const env = { ...process.env };
	if (claudeConfigDir?.trim()) env.CLAUDE_CONFIG_DIR = claudeConfigDir.trim();
	else delete env.CLAUDE_CONFIG_DIR;
	return env;
}

// Kick off the inventory fetch for the current credential scope. Fire and
// forget: the query path can only read a SYNCHRONOUS snapshot, because
// streamClaudeAgentSdk returns a stream and claims the SDK query handle in the
// same tick — there is no await boundary to hang a fetch on without
// restructuring abort handling.
//
// Primed at provider registration so the result is in hand well before the
// first turn (the call measured ~400ms against app startup). If a turn arrives
// first it declares nothing and behaves exactly as it does today — the race is
// back for that one turn, which is the bug, but never worse than the status quo.
//
// FAILS OPEN throughout: no credentials, a failed inventory, or a thrown call
// all resolve to "declare nothing" rather than breaking the turn. Failures are
// NOT cached. Caching a transient registration failure would pin `{}` for the
// process lifetime, keeping every later turn undeclared and the disk-cache
// fallback unreachable. Leaving the key unset makes the next snapshot retry;
// the pending set dedupes concurrent fetches, and a failed inventory attempt
// stamps a per-scope cooldown so a persistently failing account backs off
// instead of re-priming on every turn.
export function primeConnectorServers(claudeConfigDir?: string, overrides: PrimeConnectorOverrides = {}): void {
	const key = connectorScopeKey(claudeConfigDir);
	if (connectorServerCache.has(key) || connectorServerPending.has(key)) return;
	const now = overrides.now ?? Date.now;
	const cooldownMs = overrides.failureCooldownMs ?? CONNECTOR_PRIME_FAILURE_COOLDOWN_MS;
	const failedAt = connectorServerFailureAt.get(key);
	if (failedAt !== undefined && now() - failedAt < cooldownMs) {
		debug("connectors: prime cooling down after failure; declaring none until retry window opens");
		return;
	}
	connectorServerPending.add(key);
	void (async () => {
		let failed = false;
		try {
			const credentials = resolveClaudeOAuth(readCredentialFile, connectorCredentialEnv(claudeConfigDir));
			if (!credentials) {
				debug("connectors: no OAuth credentials; declaring none (will retry)");
				return;
			}
			const inventory = await listAccountConnectors({
				credentials,
				// A hung inventory request must not outlive the deadline: the abort
				// surfaces as `ok: false` and takes the cooldown path below.
				signal: AbortSignal.timeout(overrides.timeoutMs ?? CONNECTOR_PRIME_TIMEOUT_MS),
			});
			if (!inventory.ok) {
				failed = true;
				debug(`connectors: inventory failed (${inventory.reason}); declaring none (will retry after cooldown)`);
				return;
			}
			const servers = connectorMcpServers(inventory);
			debug(`connectors: declaring ${Object.keys(servers).length} of ${inventory.connectors.length} installed`,
				Object.keys(servers).join(", ") || "none");
			connectorServerCache.set(key, servers);
			connectorServerFailureAt.delete(key);
			// Persist so the NEXT cold process has this synchronously. Priming always
			// loses the race against turn 1 in its own process; a cache written by an
			// earlier run is the only thing turn 1 can read in time.
			if (writeCachedConnectors(inventory.connectors, key)) {
				debug(`connectors: cached ${inventory.connectors.length} entries`);
			}
		} catch (error) {
			failed = true;
			debug("connectors: declaration lookup threw; declaring none (will retry after cooldown)", error);
		} finally {
			if (failed) connectorServerFailureAt.set(key, now());
			connectorServerPending.delete(key);
		}
	})();
}

/** Synchronous snapshot for the query path; `{}` until priming resolves. */
export function connectorServersSnapshot(claudeConfigDir?: string): Record<string, unknown> {
	const key = connectorScopeKey(claudeConfigDir);
	const ready = connectorServerCache.get(key);
	if (ready) return ready;
	// Always start (or continue) the live fetch — the cache is a head start, not
	// a replacement, and the refresh keeps the next process current.
	primeConnectorServers(claudeConfigDir);
	// Fall back to the previous run's inventory, read synchronously. This is the
	// only thing that can populate turn 1 of a cold process, because priming
	// cannot finish before the first query is built.
	const cached = readCachedConnectors(key);
	if (!cached) return {};
	const servers = connectorMcpServers({ ok: true, complete: true, connectors: cached });
	if (Object.keys(servers).length === 0) return {};
	debug(`connectors: turn-1 declarations from cache — ${Object.keys(servers).join(", ")}`);
	return servers;
}
