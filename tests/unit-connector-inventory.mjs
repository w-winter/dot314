/**
 * Tests for deterministic connector enumeration.
 * Pins: credential resolution across split files and per-account CLAUDE_CONFIG_DIR,
 * the POST shape the endpoint requires, and — most importantly — that every
 * non-success path reports failure rather than an empty-but-successful list.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	connectorServerNamespace,
	connectorsListUrl,
	credentialCandidatePaths,
	listAccountConnectors,
	resolveClaudeOAuth,
} from "../src/connector-inventory.js";
import { CLAUDE_AI_CONNECTOR_TOOL_PATTERNS } from "../src/connectors.js";

const CREDS = { accessToken: "sk-ant-oat01-secret", organizationUuid: "org-uuid-1" };

// Mirrors the live payload observed on a personal claude_max org.
const LIVE_BODY = JSON.stringify({
	results: [
		{
			name: "Gmail",
			description: "Draft replies, summarize threads, & search your inbox",
			directoryUuid: "2701e52f-b826-4aaf-8b25-11f2a97c98b0",
			installedServerId: "cd7a4f5c-c21e-403f-aa35-481aff1d1bb5",
			customOAuthClientId: null,
			installState: "unknown",
			isAuthless: false,
		},
		{ name: "Google Calendar", directoryUuid: "2a838eaa", installedServerId: "43bfe39d", isAuthless: false },
		{ name: "Google Drive", directoryUuid: "b89f7865", installedServerId: "9a94a59a", isAuthless: false },
	],
	opt_in_required: false,
	message: null,
});

const okFetch = (body = LIVE_BODY, status = 200) => {
	const calls = [];
	const impl = async (url, init) => {
		calls.push({ url, init });
		return new Response(body, { status });
	};
	impl.calls = calls;
	return impl;
};

describe("credential resolution", () => {
	it("reads token and org UUID from separate files", () => {
		const files = {
			"/h/.claude/.credentials.json": JSON.stringify({ claudeAiOauth: { accessToken: "tok" } }),
			"/h/.claude.json": JSON.stringify({ oauthAccount: { organizationUuid: "org" } }),
		};
		const got = resolveClaudeOAuth((p) => files[p], { HOME: "/h" });
		assert.deepEqual(got, { accessToken: "tok", organizationUuid: "org" });
	});

	it("prefers CLAUDE_CONFIG_DIR over HOME so per-account sidecars stay isolated", () => {
		const files = {
			"/acct-b/.credentials.json": JSON.stringify({ claudeAiOauth: { accessToken: "b-tok" } }),
			"/acct-b/.claude.json": JSON.stringify({ oauthAccount: { organizationUuid: "b-org" } }),
			"/h/.claude/.credentials.json": JSON.stringify({ claudeAiOauth: { accessToken: "a-tok" } }),
			"/h/.claude.json": JSON.stringify({ oauthAccount: { organizationUuid: "a-org" } }),
		};
		const got = resolveClaudeOAuth((p) => files[p], { HOME: "/h", CLAUDE_CONFIG_DIR: "/acct-b" });
		assert.deepEqual(got, { accessToken: "b-tok", organizationUuid: "b-org" });
	});

	it("skips a corrupt file instead of letting it mask a later good one", () => {
		const files = {
			"/h/.claude/.credentials.json": "{ not json",
			"/h/.claude.json": JSON.stringify({
				claudeAiOauth: { accessToken: "tok" },
				oauthAccount: { organizationUuid: "org" },
			}),
		};
		const got = resolveClaudeOAuth((p) => files[p], { HOME: "/h" });
		assert.deepEqual(got, { accessToken: "tok", organizationUuid: "org" });
	});

	it("returns undefined when either half is missing", () => {
		const onlyToken = { "/h/.claude/.credentials.json": JSON.stringify({ claudeAiOauth: { accessToken: "tok" } }) };
		assert.equal(resolveClaudeOAuth((p) => onlyToken[p], { HOME: "/h" }), undefined);
		const onlyOrg = { "/h/.claude.json": JSON.stringify({ oauthAccount: { organizationUuid: "org" } }) };
		assert.equal(resolveClaudeOAuth((p) => onlyOrg[p], { HOME: "/h" }), undefined);
		assert.equal(resolveClaudeOAuth(() => undefined, { HOME: "/h" }), undefined);
	});

	it("probes ONLY the CLAUDE_CONFIG_DIR root when it is set (no HOME fallback)", () => {
		// A managed profile with a missing .credentials.json must NOT silently
		// borrow the default account's token — that is a confident, well-formed
		// answer for the wrong account.
		const paths = credentialCandidatePaths({ HOME: "/h", CLAUDE_CONFIG_DIR: "/cfg" });
		assert.deepEqual(paths, ["/cfg/.credentials.json", "/cfg/.claude.json"]);
	});

	it("keeps the HOME candidates when no config dir is selected", () => {
		const paths = credentialCandidatePaths({ HOME: "/h" });
		assert.deepEqual(paths, [
			"/h/.claude/.credentials.json",
			"/h/.claude/.claude.json",
			"/h/.credentials.json",
			"/h/.claude.json",
		]);
	});

	it("a managed profile missing its credentials resolves nothing rather than the default account", () => {
		const files = {
			// Default account fully present under HOME…
			"/h/.claude/.credentials.json": JSON.stringify({ claudeAiOauth: { accessToken: "default-tok" } }),
			"/h/.claude.json": JSON.stringify({ oauthAccount: { organizationUuid: "default-org" } }),
		};
		// …but the selected profile dir is empty: no borrowing.
		const got = resolveClaudeOAuth((p) => files[p], { HOME: "/h", CLAUDE_CONFIG_DIR: "/profiles/b" });
		assert.equal(got, undefined);
	});
});

describe("request shape", () => {
	it("POSTs with the bearer token and oauth beta header", async () => {
		const f = okFetch();
		await listAccountConnectors({ credentials: CREDS, fetchImpl: f });
		assert.equal(f.calls.length, 1);
		const { url, init } = f.calls[0];
		assert.equal(url, "https://api.anthropic.com/api/oauth/organizations/org-uuid-1/mcp/connectors/list");
		// GET returns 405 on this endpoint — the method is load-bearing.
		assert.equal(init.method, "POST");
		assert.equal(init.headers.Authorization, `Bearer ${CREDS.accessToken}`);
		assert.equal(init.headers["anthropic-beta"], "oauth-2025-04-20");
		assert.equal(init.body, "{}");
	});

	it("percent-encodes the org UUID into the path", () => {
		assert.match(connectorsListUrl("a/b"), /organizations\/a%2Fb\/mcp/);
	});

	it("honors an apiBase override without doubling slashes", () => {
		assert.equal(
			connectorsListUrl("o", "https://example.test/"),
			"https://example.test/api/oauth/organizations/o/mcp/connectors/list",
		);
	});
});

describe("success path", () => {
	it("returns every connector, marked complete", async () => {
		const got = await listAccountConnectors({ credentials: CREDS, fetchImpl: okFetch() });
		assert.equal(got.ok, true);
		assert.equal(got.complete, true);
		assert.deepEqual(got.connectors.map((c) => c.name), ["Gmail", "Google Calendar", "Google Drive"]);
	});

	it("keeps installedServerId — the field that proves this is the attached set", async () => {
		const got = await listAccountConnectors({ credentials: CREDS, fetchImpl: okFetch() });
		assert.equal(got.connectors[0].installedServerId, "cd7a4f5c-c21e-403f-aa35-481aff1d1bb5");
		assert.equal(got.connectors[0].directoryUuid, "2701e52f-b826-4aaf-8b25-11f2a97c98b0");
	});

	it("an account with no connectors is a successful empty list, not a failure", async () => {
		const got = await listAccountConnectors({
			credentials: CREDS,
			fetchImpl: okFetch(JSON.stringify({ results: [] })),
		});
		assert.equal(got.ok, true);
		assert.equal(got.complete, true);
		assert.deepEqual(got.connectors, []);
	});
});

describe("failure paths never masquerade as an empty inventory", () => {
	const expectFailure = (got, fragment) => {
		assert.equal(got.ok, false);
		assert.equal(got.complete, false);
		assert.match(got.reason, fragment);
		assert.equal(got.connectors, undefined);
	};

	it("HTTP error", async () => {
		const body = JSON.stringify({ error: { message: "Method Not Allowed" } });
		expectFailure(
			await listAccountConnectors({ credentials: CREDS, fetchImpl: okFetch(body, 405) }),
			/HTTP 405 \(Method Not Allowed\)/,
		);
	});

	it("transport throw", async () => {
		const boom = async () => { throw new Error("ECONNREFUSED"); };
		expectFailure(
			await listAccountConnectors({ credentials: CREDS, fetchImpl: boom }),
			/request failed: ECONNREFUSED/,
		);
	});

	it("non-JSON body", async () => {
		expectFailure(
			await listAccountConnectors({ credentials: CREDS, fetchImpl: okFetch("<html>502</html>") }),
			/non-JSON body/,
		);
	});

	it("missing results array is a protocol change, not an empty account", async () => {
		expectFailure(
			await listAccountConnectors({ credentials: CREDS, fetchImpl: okFetch(JSON.stringify({ ok: true })) }),
			/no results array/,
		);
	});

	it("an unnamed entry fails rather than silently shrinking the list", async () => {
		const body = JSON.stringify({ results: [{ name: "Gmail" }, { installedServerId: "x" }] });
		expectFailure(
			await listAccountConnectors({ credentials: CREDS, fetchImpl: okFetch(body) }),
			/entry with no name/,
		);
	});

	it("never leaks the access token into a failure reason", async () => {
		const results = await Promise.all([
			listAccountConnectors({ credentials: CREDS, fetchImpl: okFetch("nope", 500) }),
			listAccountConnectors({ credentials: CREDS, fetchImpl: async () => { throw new Error(CREDS.accessToken); } }),
		]);
		for (const r of results) assert.ok(!r.reason.includes("sk-ant-oat01-secret"), r.reason);
	});
});

describe("connectorServerNamespace", () => {
	it("maps connector names to their tool namespace", () => {
		assert.equal(connectorServerNamespace("Gmail"), "mcp__claude_ai_Gmail__");
		assert.equal(connectorServerNamespace("Google Calendar"), "mcp__claude_ai_Google_Calendar__");
	});

	// Corroboration, not restatement: CLAUDE_AI_CONNECTOR_TOOL_PATTERNS was built
	// from a live tool enumeration, independently of this naming rule.
	it("agrees with the independently-derived connector tool patterns", () => {
		for (const name of ["Gmail", "Google Calendar", "Google Drive", "Slack", "Atlassian"]) {
			assert.ok(
				CLAUDE_AI_CONNECTOR_TOOL_PATTERNS.includes(`${connectorServerNamespace(name)}*`),
				`no pattern for ${name}`,
			);
		}
	});
});
