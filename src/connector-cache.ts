// Cross-PROCESS cache of the connector inventory.
//
//  primes the inventory at provider registration, but the fetch takes ~1.5s
// while the first query is built at ~0.5-0.8s, so turn 1 of a cold sidecar goes
// out with no declarations and preserves the failure this cache prevents.
//
// An in-process cache cannot help the consumer that needs it most. drovr builds
// a sidecar lazily on the first bridge round and, since their sidecars are
// per-SESSION, each chat starts a separate cold process. The
// cache therefore has to survive process boundaries.
//
// Keyed by credential scope, because that is what selects the account: the org
// UUID in the inventory request is ignored and only the credential decides whose
// connectors come back. Two accounts on one host must not share a cache entry.
//
// Everything here is best-effort. A missing, unreadable, corrupt, stale, or
// wrong-version cache returns undefined and the caller falls back to today's
// behaviour — the same fail-open contract as the inventory call itself.
//
// The ON-DISK FORMAT HAS AN EXTERNAL READER. drovr quarantines this
// bundle to its sidecar process, so rather than calling `listAccountConnectors`
// in-process it re-implements the reader half — path
// `<piUserDir()>/connector-cache/<sha256(CLAUDE_CONFIG_DIR).hex[0..16]>.json`,
// payload `{version, scope, savedAt, connectors}` where `scope` is the FULL
// sha256 hex of the scope key (version 2; version 1 stored the raw
// CLAUDE_CONFIG_DIR path, which is account-identifying and does not belong in
// a state file), 7-day max age — as the "is this connector installed" half of
// its write gate.
//
// That coupling fails OPEN on drift by design, so a format change degrades them
// from two gates to one rather than breaking them. It is still worth making the
// change knowingly: bump CACHE_VERSION so their staleness check rejects rather
// than misreads, and say so in the changelog. `unit-connector-cache.mjs` pins
// the path shape and payload keys.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { piUserDir } from "./config.js";
import { debug } from "./debug.js";
import type { ConnectorEntry } from "./connector-inventory.js";

const CACHE_VERSION = 2;
/** Long enough to be useful across a machine's lifetime, short enough that a
 *  removed connector stops being declared without needing a manual purge. A
 *  stale entry is not dangerous — a connector that does not resolve simply
 *  fails to connect, which is the fail-open path — so this is hygiene, not a
 *  correctness boundary. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * THE canonical credential-scope key: a trimmed CLAUDE_CONFIG_DIR, or the
 * `"<default>"` sentinel for the default account. The on-disk cache format has
 * an external reader (see the module header), and the in-memory prime cache in
 * connector-runtime.ts keys the same scopes — both MUST agree on this rule, so
 * there is exactly one implementation.
 */
export function scopeKeyFor(claudeConfigDir?: string): string {
	return claudeConfigDir?.trim() || "<default>";
}

export function connectorCacheScopeKey(env: NodeJS.ProcessEnv = process.env): string {
	return scopeKeyFor(env.CLAUDE_CONFIG_DIR);
}

// Full sha256 hex of a scope key. The filename keeps only the first 16 chars;
// the payload stores the whole digest so a truncated-hash collision (or a
// hand-copied file) is still caught by the scope check in readCachedConnectors.
function connectorCacheScopeDigest(scopeKey: string): string {
	return createHash("sha256").update(scopeKey).digest("hex");
}

/**
 * Our own state directory, not the Claude config dir. The credential directory
 * belongs to the CLI; the scope is encoded in the filename instead so we never
 * write into someone else's tree. Hashed rather than escaped because a config
 * dir is an arbitrary absolute path.
 */
export function connectorCachePath(scopeKey: string = connectorCacheScopeKey()): string {
	const digest = connectorCacheScopeDigest(scopeKey).slice(0, 16);
	return join(piUserDir(), "connector-cache", `${digest}.json`);
}

/**
 * Synchronous by design. The query path has no await boundary to hang a read on
 * — `streamClaudeAgentSdk` returns its stream and claims the SDK query handle in
 * the same tick — which is the whole reason the in-memory prime loses the race.
 * A single small `readFileSync` is what makes turn 1 reachable at all.
 */
export function readCachedConnectors(
	scopeKey: string = connectorCacheScopeKey(),
	now: number = Date.now(),
): ConnectorEntry[] | undefined {
	let raw: string;
	try {
		raw = readFileSync(connectorCachePath(scopeKey), "utf8");
	} catch {
		return undefined;
	}
	let parsed: any;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		// A corrupt cache degrades to the no-cache path by contract, but silently
		// doing so on every turn is how a bad file hides forever.
		debug(`connector-cache: corrupt cache ${connectorCachePath(scopeKey)}:`, error instanceof Error ? error.message : String(error));
		return undefined;
	}
	if (parsed?.version !== CACHE_VERSION) return undefined;
	// The scope digest is stored as well as hashed into the path: a truncated-
	// hash collision or a hand-copied file would otherwise hand one account
	// another's connectors, which is the exact failure the token-scoping note in
	// connector-inventory.ts warns about. The payload carries the digest, never
	// the raw scope key — a config-dir path is account-identifying and the
	// filename is already hashed for the same reason.
	if (parsed?.scope !== connectorCacheScopeDigest(scopeKey)) return undefined;
	const savedAt = typeof parsed?.savedAt === "number" ? parsed.savedAt : 0;
	if (!savedAt || now - savedAt > MAX_AGE_MS || savedAt > now) return undefined;
	if (!Array.isArray(parsed?.connectors)) return undefined;
	const connectors = parsed.connectors.filter(
		(entry: any) => entry && typeof entry.name === "string" && entry.name.trim(),
	);
	return connectors.length > 0 ? (connectors as ConnectorEntry[]) : undefined;
}

/** Best-effort write; a failure here must never affect the turn. */
export function writeCachedConnectors(
	connectors: ConnectorEntry[],
	scopeKey: string = connectorCacheScopeKey(),
	now: number = Date.now(),
): boolean {
	if (!Array.isArray(connectors) || connectors.length === 0) return false;
	const path = connectorCachePath(scopeKey);
	try {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		writeFileSync(
			path,
			JSON.stringify({ version: CACHE_VERSION, scope: connectorCacheScopeDigest(scopeKey), savedAt: now, connectors }),
			{ mode: 0o600 },
		);
		return true;
	} catch (error) {
		// Best-effort by contract, but a persistent write failure means every cold
		// process re-loses the turn-1 race this cache exists to win — say so.
		debug(`connector-cache: write failed ${path}:`, error instanceof Error ? error.message : String(error));
		return false;
	}
}
