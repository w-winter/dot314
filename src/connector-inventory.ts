// Deterministic enumeration of a Claude account's installed claude.ai connectors.
//
// The capability probe this replaces asked the MODEL to enumerate connectors via
// ToolSearch. A search returns what the search surfaced, which is a LOWER BOUND —
// nothing in the result distinguishes "these are the connectors" from "these are
// the connectors the search happened to return this time". Downstream then stored
// that lower bound as authoritative, so an account with Slack attached could
// report an inventory without Slack and no failure signal.
//
// This module asks the account instead of the model. Verified live against a
// personal claude_max org: the endpoint is POST (a GET returns 405) and each
// result carries BOTH `directoryUuid` (the catalog identity) and
// `installedServerId` (this account's installed instance). A marketplace catalog
// entry has no installed-server id, which is what establishes this as the
// INSTALLED set rather than the registry listing.
//
// INSTALLED IS NOT ATTACHED. This endpoint reports what the ACCOUNT has
// installed. It says nothing about whether a given connector's MCP server has
// finished attaching inside the `claude` child that is about to run a turn —
// this is a plain HTTPS call and does not consult that process at all. The two
// are separate: the ToolSearch probe can report only what is attached, so an
// inventory must not imply availability. They are
// observable and can legitimately disagree: a correct `complete: true` inventory
// can name Slack while `mcp__claude_ai_Slack__*` is not yet callable in this
// process. Treat an inventory as NECESSARY BUT NOT SUFFICIENT for
// availability and keep an attach-time check on the call path; do not derive
// "can I call this tool right now" from this result.
//
// Because the answer comes from the account rather than a model turn, the result
// is complete by construction — hence `complete: true` on success, and no
// "partial" state. A failure is a failure, never an empty-but-successful list.

const CONNECTOR_NS_PREFIX = "mcp__claude_ai_";
const DEFAULT_API_BASE = "https://api.anthropic.com";
const DEFAULT_PROXY_BASE = "https://mcp-proxy.anthropic.com/v1/mcp";
// OAuth-token requests to the Anthropic API require this beta header; without it
// endpoints reject the bearer credential.
const OAUTH_BETA_HEADER = "oauth-2025-04-20";

export type ConnectorEntry = {
	name: string;
	/** This account's installed instance. Present on every live result observed. */
	installedServerId?: string;
	/** Catalog identity, shared across accounts that install the same connector. */
	directoryUuid?: string;
	/**
	 * Account-side install state. `"connected"` marks the connectors the CLI
	 * actually attempts; everything else it never gives a `Starting connection`
	 * line at all. The CLI attempts exactly the entries marked `connected`.
	 */
	installState?: string;
	description?: string;
	isAuthless?: boolean;
};

// Discriminated so a caller cannot read `connectors` without having checked `ok`.
// `complete` is carried explicitly rather than implied: the whole defect this
// fixes was a result that looked authoritative while being a lower bound.
// The absent side of each variant is declared as `?: undefined` rather than
// omitted: this package compiles with `strict: false`, where narrowing a union
// by a boolean discriminant does not reliably filter members, so a bare
// `{ok:true}|{ok:false}` pair makes `inventory.reason` a compile error at every
// call site. Spelling both sides keeps the union discriminated AND readable
// without depending on strictNullChecks-era narrowing.
export type ConnectorInventory =
	| { ok: true; complete: true; connectors: ConnectorEntry[]; reason?: undefined }
	| { ok: false; complete: false; connectors?: undefined; reason: string };

// SCOPING IS BY TOKEN, NOT BY ORG. Verified live: the org UUID in the path is
// ignored — an all-zero UUID and the literal string "not-a-uuid" both returned
// the bearer token's own account, identically to the real org. A multi-account
// host therefore CANNOT select an account by passing its organizationUuid; the
// only thing that selects an account is which credential the token came from
// (i.e. which CLAUDE_CONFIG_DIR was read). Getting that wrong yields a
// confident, well-formed answer for the WRONG account.
//
// The real UUID is still sent rather than a placeholder, so the call keeps
// working if the API starts enforcing it.
export type ClaudeOAuthCredentials = {
	accessToken: string;
	organizationUuid: string;
};

type Json = Record<string, any>;

/**
 * The server name Claude Code itself registers a claude.ai connector under.
 *
 * This is the `mcpServers` KEY to use when declaring a connector explicitly, and
 * it is load-bearing rather than cosmetic: the key IS the tool namespace. Keyed
 * as anything else, the same connector appears twice — once from our
 * declaration and once from the CLI's own loader — and consumers that pin
 * fully-qualified tool names (memsira's executor hard-codes them into
 * `--allowedTools` and its system prompt, and never globs a namespace) would
 * be allowed to call neither copy reliably. Verified live: keyed as the CLI's
 * name there is ONE server entry and one namespace (27 servers); keyed otherwise
 * both appear (28 servers).
 *
 * What merges is the NAMESPACE, not the connection. Under the shared name the
 * declaration and the CLI's own loader each still connect: across 40 cold runs
 * the baseline logged 1 Slack connect (7 proxy connects total) and the declared
 * arm logged 2 Slack connects (8 total), in 20 of 20 runs with no exceptions.
 * Declaring N connectors therefore costs ~2N connections, not N. They run in
 * parallel — slowest-connect per run moved from a 1192ms median to 1278ms, worst
 * 1544ms, well inside the 5s cap — but that was measured with ONE declaration.
 */
export function connectorServerName(connectorName: string): string {
	return `claude.ai ${connectorName.trim()}`;
}

/**
 * The claude.ai MCP proxy endpoint for one installed connector.
 *
 * The `url` field is REQUIRED by the runtime schema, but the CLI does not
 * connect to it: for `type: "claudeai-proxy"` it derives the endpoint from `id`.
 * Caught live — pointing `url` at a local server that never responds still
 * logged `Using claude.ai proxy at …/mcpsrv_01Wcus…` and connected. So this
 * builds the honest value for a required field; it is `id` that must be right.
 *
 * That also explains why both id forms work: the `mcpsrv_…` id from
 * `GET /v1/mcp_servers` and the `installedServerId` UUID this module returns
 * each connected and served identical tools with the CLI's own connector
 * loading disabled. Both resolve at the proxy; neither depends on `url`.
 */
export function connectorProxyUrl(installedServerId: string, proxyBase: string = DEFAULT_PROXY_BASE): string {
	return `${trimTrailingSlashes(proxyBase)}/${encodeURIComponent(installedServerId)}`;
}

/**
 * Tool-namespace prefix for a connector, e.g. `Google Calendar` →
 * `mcp__claude_ai_Google_Calendar__`. Connector servers are named after the
 * connector with whitespace replaced by underscores; corroborated against the
 * independently-authored CLAUDE_AI_CONNECTOR_TOOL_PATTERNS in connectors.ts,
 * which was built from a live tool enumeration rather than from this rule.
 */
export function connectorServerNamespace(connectorName: string): string {
	return `${CONNECTOR_NS_PREFIX}${connectorName.trim().replace(/\s+/g, "_")}__`;
}

// Candidate credential files, in precedence order. CLAUDE_CONFIG_DIR is set
// per-account by hosts that run one sidecar per Claude account, so when it is
// set that root is probed EXCLUSIVELY: falling through to `~/.claude`/$HOME
// would silently borrow the DEFAULT account's token for a managed profile
// whose own `.credentials.json` is missing — a confident, well-formed answer
// for the wrong account (see the token-scoping note above). Only the
// no-config-dir default probes the home locations. Both file names are probed
// under each root because the token and the org UUID do not reliably live in
// the same file across versions.
export function credentialCandidatePaths(env: NodeJS.ProcessEnv = process.env): string[] {
	const roots: string[] = [];
	const configDir = env.CLAUDE_CONFIG_DIR?.trim();
	if (configDir) {
		roots.push(configDir);
	} else {
		const home = env.HOME?.trim();
		if (home) roots.push(`${home}/.claude`, home);
	}
	const seen = new Set<string>();
	const paths: string[] = [];
	for (const root of roots) {
		for (const name of [".credentials.json", ".claude.json"]) {
			const p = `${root}/${name}`;
			if (!seen.has(p)) { seen.add(p); paths.push(p); }
		}
	}
	return paths;
}

/**
 * Pull the OAuth access token and organization UUID out of the Claude config.
 * They are scanned independently across all candidate files because they are not
 * guaranteed to co-locate: on the machine this was verified against, the token
 * lives in `.credentials.json` and the org UUID in `.claude.json`.
 *
 * `readFile` returns undefined for a missing/unreadable path. Parse failures are
 * skipped rather than thrown — a corrupt file must not mask a good one later in
 * the list.
 */
export function resolveClaudeOAuth(
	readFile: (path: string) => string | undefined,
	env: NodeJS.ProcessEnv = process.env,
): ClaudeOAuthCredentials | undefined {
	let accessToken: string | undefined;
	let organizationUuid: string | undefined;

	for (const path of credentialCandidatePaths(env)) {
		const raw = readFile(path);
		if (!raw) continue;
		let parsed: Json;
		try {
			parsed = JSON.parse(raw) as Json;
		} catch {
			continue;
		}
		accessToken ??= nonEmptyString(parsed?.claudeAiOauth?.accessToken);
		organizationUuid ??= nonEmptyString(parsed?.oauthAccount?.organizationUuid);
		if (accessToken && organizationUuid) break;
	}

	if (!accessToken || !organizationUuid) return undefined;
	return { accessToken, organizationUuid };
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function connectorsListUrl(organizationUuid: string, apiBase: string = DEFAULT_API_BASE): string {
	return `${trimTrailingSlashes(apiBase)}/api/oauth/organizations/${encodeURIComponent(organizationUuid)}/mcp/connectors/list`;
}

// Linear-time trailing-slash trim. This was `apiBase.replace(/\/+$/, "")`, which
// CodeQL correctly flags as a polynomial regex on uncontrolled input: `apiBase`
// is a caller-supplied parameter, and an anchored `+` backtracks on a long run
// of slashes. It only became reachable as library input once this module gained
// a real export surface, which is exactly the exposure the export was for.
function trimTrailingSlashes(value: string): string {
	let end = value.length;
	while (end > 0 && value.charCodeAt(end - 1) === 47 /* "/" */) end--;
	return value.slice(0, end);
}

export type ListConnectorsDeps = {
	credentials: ClaudeOAuthCredentials;
	fetchImpl?: typeof fetch;
	apiBase?: string;
	signal?: AbortSignal;
};

/**
 * Enumerate the account's installed connectors. Never throws: transport and
 * protocol failures come back as `{ ok: false }` with a reason, so a caller can
 * distinguish "this account has no connectors" (ok, empty list) from "we could
 * not find out" — the distinction the search-driven probe could not express.
 *
 * The reason string is built only from the HTTP status and the API's own error
 * message; the bearer token is never interpolated into it or logged.
 */
export async function listAccountConnectors(deps: ListConnectorsDeps): Promise<ConnectorInventory> {
	const { credentials, apiBase, signal } = deps;
	const fetchImpl = deps.fetchImpl ?? fetch;
	const url = connectorsListUrl(credentials.organizationUuid, apiBase);
	// Every failure return goes through this. Transport errors are the risk: a
	// fetch/proxy layer is free to put the request headers — and therefore the
	// bearer token — into the message it throws, and that message would otherwise
	// land in a reason string that callers log.
	const fail = (reason: string): ConnectorInventory =>
		({ ok: false, complete: false, reason: redactSecret(reason, credentials.accessToken) });

	let response: Response;
	try {
		response = await fetchImpl(url, {
			method: "POST",
			headers: {
				"Authorization": `Bearer ${credentials.accessToken}`,
				"anthropic-beta": OAUTH_BETA_HEADER,
				"Content-Type": "application/json",
			},
			body: "{}",
			signal,
		});
	} catch (error) {
		return fail(`connector list request failed: ${errorText(error)}`);
	}

	let bodyText: string;
	try {
		bodyText = await response.text();
	} catch (error) {
		return fail(`connector list response unreadable: ${errorText(error)}`);
	}

	if (!response.ok) {
		return fail(`connector list returned HTTP ${response.status}${apiErrorSuffix(bodyText)}`);
	}

	let parsed: Json;
	try {
		parsed = JSON.parse(bodyText) as Json;
	} catch {
		return fail("connector list returned a non-JSON body");
	}

	// A missing/!Array `results` is a protocol change, not an empty account. Treat
	// it as failure — reporting "no connectors" here would recreate exactly the
	// silent-wrong-answer failure this module exists to remove.
	if (!Array.isArray(parsed?.results)) {
		return fail("connector list response had no results array");
	}

	const connectors: ConnectorEntry[] = [];
	for (const raw of parsed.results as unknown[]) {
		const entry = raw as Json;
		const name = nonEmptyString(entry?.name);
		// An unnamed entry cannot be matched to a tool namespace by any consumer,
		// so silently keeping it would understate the inventory in a way the
		// caller could not detect. Fail instead.
		if (!name) {
			return fail("connector list contained an entry with no name");
		}
		connectors.push({
			name,
			installedServerId: nonEmptyString(entry?.installedServerId),
			directoryUuid: nonEmptyString(entry?.directoryUuid),
			installState: nonEmptyString(entry?.installState),
			description: nonEmptyString(entry?.description),
			isAuthless: typeof entry?.isAuthless === "boolean" ? entry.isAuthless : undefined,
		});
	}

	return { ok: true, complete: true, connectors };
}

function apiErrorSuffix(bodyText: string): string {
	try {
		const message = (JSON.parse(bodyText) as Json)?.error?.message;
		return typeof message === "string" && message.trim() ? ` (${message.trim()})` : "";
	} catch {
		return "";
	}
}

// Replace the bearer token wherever it appears in text headed for a caller.
// Also covers a URL-encoded rendering, since some transports encode headers into
// an error's message. Short/empty tokens are not substituted — an over-eager
// match would corrupt unrelated text.
function redactSecret(text: string, secret: string): string {
	if (!secret || secret.length < 8) return text;
	let out = text;
	for (const form of new Set([secret, encodeURIComponent(secret)])) {
		out = out.split(form).join("[redacted]");
	}
	return out;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
