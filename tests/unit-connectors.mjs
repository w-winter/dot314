import { test } from "node:test";
import assert from "node:assert/strict";
import {
	connectorsEnabledFromEnv,
	connectorsEnabledFor,
	toolIsolationForQuery,
	CLAUDE_AI_CONNECTOR_TOOL_PATTERNS,
	CONNECTOR_DISCOVERY_TOOLS,
	CLAUDE_BRIDGE_TOOL_ISOLATION,
	DISALLOWED_BUILTIN_TOOLS,
	CONNECTOR_WRITE_TOOLS,
	isConnectorTool,
	isConnectorWriteTool,
	connectorBuiltinAllowlistHook,
	connectorQueryOptions,
	connectorWriteDenyHook,
	settingSourcesForQuery,
} from "../src/connectors.ts";
import { connectorServerNamespace } from "../src/connector-inventory.ts";

function withEnv(value, fn) {
	const prev = process.env.CLAUDE_BRIDGE_ENABLE_CONNECTORS;
	if (value === undefined) delete process.env.CLAUDE_BRIDGE_ENABLE_CONNECTORS;
	else process.env.CLAUDE_BRIDGE_ENABLE_CONNECTORS = value;
	try { return fn(); } finally {
		if (prev === undefined) delete process.env.CLAUDE_BRIDGE_ENABLE_CONNECTORS;
		else process.env.CLAUDE_BRIDGE_ENABLE_CONNECTORS = prev;
	}
}

test("connectorsEnabledFromEnv parses truthy/falsey", () => {
	for (const v of ["1", "true", "yes", "on", "TRUE", " On "]) assert.equal(withEnv(v, connectorsEnabledFromEnv), true, v);
	for (const v of [undefined, "", "0", "false", "no", "off", "nope"]) assert.equal(withEnv(v, connectorsEnabledFromEnv), false, String(v));
});

test("connectorsEnabledFor: env OR config.provider.enableConnectors", () => {
	assert.equal(withEnv(undefined, () => connectorsEnabledFor(undefined)), false);
	assert.equal(withEnv(undefined, () => connectorsEnabledFor({ provider: {} })), false);
	assert.equal(withEnv(undefined, () => connectorsEnabledFor({ provider: { enableConnectors: true } })), true);
	assert.equal(withEnv("0", () => connectorsEnabledFor({ provider: { enableConnectors: true } })), true);
	assert.equal(withEnv("1", () => connectorsEnabledFor({ provider: { enableConnectors: false } })), true);
});

test("toolIsolationForQuery(false) is the default isolation (connectors suppressed)", () => {
	const iso = toolIsolationForQuery(false);
	assert.deepEqual(iso, CLAUDE_BRIDGE_TOOL_ISOLATION);
	assert.deepEqual(iso.tools, []); // empty --tools; connectors intentionally hidden
});

test("toolIsolationForQuery(true) exposes connectors: drops empty tools, allows patterns, un-blocks ToolSearch", () => {
	const iso = toolIsolationForQuery(true);
	// `tools: []` must be omitted (an empty --tools allowlist strips cloud connectors).
	assert.equal("tools" in iso, false);
	// Connector namespaces are auto-allowed.
	for (const p of CLAUDE_AI_CONNECTOR_TOOL_PATTERNS) assert.ok(iso.allowedTools.includes(p), `allow ${p}`);
	// Discovery tools (ToolSearch etc.) must NOT be disallowed — connectors are deferred behind them.
	for (const d of CONNECTOR_DISCOVERY_TOOLS) assert.ok(!iso.disallowedTools.includes(d), `un-block ${d}`);
	// File/shell built-ins stay blocked so Pi keeps tool ownership.
	for (const b of ["Read", "Write", "Bash", "WebFetch"]) assert.ok(iso.disallowedTools.includes(b), `still block ${b}`);
});

// --- connectors mode must not load repo-controlled settings ---

test("CONTRACT: connectors mode loads USER setting sources only", () => {
	// Settings files carry `env` and `apiKeyHelper`; "project"/"local" would let
	// a hostile checkout's .claude/settings.json reinject the provider-override
	// env the bridge scrubs (e.g. ANTHROPIC_BASE_URL). Connector state is
	// user-scope, so ["user"] is sufficient for connectors to surface.
	assert.deepEqual(settingSourcesForQuery(true), ["user"]);
	for (const scope of ["project", "local"]) {
		assert.ok(!settingSourcesForQuery(true).includes(scope), `must not include ${scope}`);
	}
});

test("explicit provider.settingSources wins verbatim in connectors mode", () => {
	assert.deepEqual(settingSourcesForQuery(true, ["user", "project"]), ["user", "project"]);
	assert.deepEqual(settingSourcesForQuery(true, []), []);
});

test("non-connectors use explicit isolation unless setting sources are configured", () => {
	assert.deepEqual(settingSourcesForQuery(false), []);
	assert.deepEqual(settingSourcesForQuery(false, ["user"]), ["user"]);
	assert.deepEqual(settingSourcesForQuery(false, ["user", "local"]), ["user", "local"]);
});

test("discovery tools are a subset of the default disallow list", () => {
	for (const d of CONNECTOR_DISCOVERY_TOOLS) assert.ok(DISALLOWED_BUILTIN_TOOLS.includes(d), `${d} is disallowed by default`);
});

test("CONTRACT: connectors.ts and connector-inventory.ts agree on the connector namespace prefix", () => {
	// CONNECTOR_NS_PREFIX is deliberately duplicated between the two modules
	// (connector-inventory also builds standalone). This makes drift loud: the
	// namespace connector-inventory derives for a server MUST classify as a
	// connector tool, and the literal prefix is pinned so a change has to be
	// made knowingly in both places.
	const namespace = connectorServerNamespace("Probe Server");
	assert.equal(namespace, "mcp__claude_ai_Probe_Server__");
	assert.equal(isConnectorTool(`${namespace}get_thing`), true);
	assert.ok(namespace.startsWith("mcp__claude_ai_"), "shared literal prefix");
	assert.equal(isConnectorTool("mcp__claude_ai_X__anything"), true);
});

// --- C13: connectors-mode builtin containment is a fail-closed ALLOWLIST ---
// DISALLOWED_BUILTIN_TOOLS blocks the CLI built-ins known TODAY, but a
// connectors session ingests untrusted third-party content, and a future
// built-in absent from that denylist would be callable by whatever that
// content talks the model into. The allowlist hook denies everything that is
// not a bridged custom tool, a claude.ai connector tool, or discovery.

async function runAllowlistHook(toolName) {
	const hook = connectorBuiltinAllowlistHook();
	return hook({ hook_event_name: "PreToolUse", tool_name: toolName, tool_input: {}, tool_use_id: "t1" }, "t1", { signal: new AbortController().signal });
}

test("allowlist hook permits bridged custom tools, connector tools, and discovery", async () => {
	const allowed = [
		"mcp__custom-tools__read",
		"mcp__custom-tools__anything_else",
		"mcp__claude_ai_Gmail__search_threads",
		"mcp__claude_ai_Some_Org_Thing__whatever",
		...CONNECTOR_DISCOVERY_TOOLS,
	];
	for (const name of allowed) {
		assert.equal((await runAllowlistHook(name)).continue, true, `${name} must pass`);
	}
});

// --- hooks see the CLI's canonical (aliased) tool names ---

test("allowlist hook permits the discovery built-ins under BOTH spellings (kendex#1011)", async () => {
	// Literal names, deliberately NOT derived from CONNECTOR_DISCOVERY_TOOLS: a
	// hook's tool_name carries the CLI's canonical (aliased) spelling, and a
	// test written from the request-side constant passes either way. The test
	// names ListMcpResourcesTool and ReadMcpResourceTool directly because these are the tools the
	// allowlist documents as permitted (verified live on claude 2.1.220).
	const spellings = [
		"ToolSearch",
		"ListMcpResources", "ListMcpResourcesTool",
		"ReadMcpResource", "ReadMcpResourceTool",
	];
	for (const name of spellings) {
		assert.equal((await runAllowlistHook(name)).continue, true, `${name} must pass`);
	}
});

test("allowlist hook still denies near-misses of the discovery names", async () => {
	const denied = [
		"ReadMcpResourceToolX", "XListMcpResourcesTool", "ToolSearchTool",
		"readmcpresourcetool", "ListMcpResourcesToo", "McpResourceTool",
	];
	for (const name of denied) {
		const out = await runAllowlistHook(name);
		assert.equal(out.hookSpecificOutput?.permissionDecision, "deny", `${name} must be denied`);
	}
});

test("CONTRACT: the request-side option surface still carries request-side spellings only (kendex#1011)", () => {
	// The SDK's rule parser alias-normalizes option strings, so the request-side
	// spellings are correct THERE and must not be "fixed" to the canonical ones.
	// Pinned with literal names for the same reason as the hook test above.
	assert.deepEqual(CONNECTOR_DISCOVERY_TOOLS, ["ToolSearch", "ListMcpResources", "ReadMcpResource"]);
	const expected = DISALLOWED_BUILTIN_TOOLS.filter((t) => !["ToolSearch", "ListMcpResources", "ReadMcpResource"].includes(t));
	assert.deepEqual(toolIsolationForQuery(true, "allow").disallowedTools, expected);
	assert.deepEqual(toolIsolationForQuery(true, "deny").disallowedTools, [...expected, ...CONNECTOR_WRITE_TOOLS]);
	for (const iso of [toolIsolationForQuery(true, "allow"), toolIsolationForQuery(true, "deny")]) {
		for (const name of ["ListMcpResourcesTool", "ReadMcpResourceTool"]) {
			assert.ok(!iso.disallowedTools.includes(name), `${name} must not leak into SDK options`);
			assert.ok(!iso.allowedTools.includes(name), `${name} must not leak into SDK options`);
		}
	}
});

test("allowlist hook denies denylisted AND future/unknown builtins (fail closed)", async () => {
	const denied = [
		"Bash", // already denylisted — belt
		"SlashCommand", // a real CLI builtin absent from the denylist
		"SomeFutureBuiltin2027", // an unknown future name
		"mcp__some_other_server__do_thing", // an unrelated MCP server
	];
	for (const name of denied) {
		const out = await runAllowlistHook(name);
		assert.equal(out.hookSpecificOutput?.permissionDecision, "deny", `${name} must be denied`);
	}
});

test("allowlist hook denies on malformed input and on exceptions", async () => {
	const hook = connectorBuiltinAllowlistHook();
	const malformed = await hook({ hook_event_name: "PreToolUse", tool_name: 42 }, "t1", { signal: new AbortController().signal });
	assert.equal(malformed.hookSpecificOutput.permissionDecision, "deny");
	// A throwing property access inside the body must convert to a deny.
	const trap = new Proxy({}, {
		get(_target, prop) {
			if (prop === "hook_event_name") return "PreToolUse";
			throw new Error("hostile input");
		},
	});
	const out = await hook(trap, "t1", { signal: new AbortController().signal });
	assert.equal(out.hookSpecificOutput.permissionDecision, "deny", "an exception must deny, never allow");
});

test("connectorQueryOptions wires the allowlist hook in BOTH write modes", async () => {
	for (const mode of ["deny", "allow"]) {
		const opts = connectorQueryOptions(true, mode);
		const hooks = opts.hooks?.PreToolUse?.[0]?.hooks ?? [];
		assert.ok(hooks.length >= 1, `mode ${mode} registers hooks`);
		// The FIRST hook is the allowlist: it must deny an unknown builtin.
		const out = await hooks[0]({ hook_event_name: "PreToolUse", tool_name: "SlashCommand", tool_input: {} }, "t1", { signal: new AbortController().signal });
		assert.equal(out.hookSpecificOutput?.permissionDecision, "deny", `mode ${mode} denies unknown builtins`);
	}
	// Write-deny mode additionally carries the write-deny hook.
	assert.equal(connectorQueryOptions(true, "deny").hooks.PreToolUse[0].hooks.length, 2);
	assert.equal(connectorQueryOptions(true, "allow").hooks.PreToolUse[0].hooks.length, 1);
});

// --- the deny reason is shared source shown verbatim to a model ---

test("CONTRACT: the connector write-deny reason names no host product", async () => {
	const hook = connectorWriteDenyHook();
	const out = await hook({
		hook_event_name: "PreToolUse",
		tool_name: "mcp__claude_ai_Gmail__create_draft",
	});
	const reason = out.hookSpecificOutput.permissionDecisionReason;

	// The string goes straight to the `claude` child's model in EVERY consuming
	// app, so naming one host tells another app's model to use a product it has
	// never heard of. Each host describes its own approval flow in its own
	// prompt; this only has to say that one exists.
	for (const product of ["Memsira", "memsira", "drovr", "Drovr", "hyprtrade"]) {
		assert.ok(!reason.includes(product), `deny reason must not name "${product}": ${reason}`);
	}
	assert.ok(reason.includes("mcp__claude_ai_Gmail__create_draft"), "names the refused tool");
	assert.ok(/host application/i.test(reason), "points at the host's approval flow generically");

	// The malformed-input path returns the same message, so it cannot drift.
	const fallback = await hook({ hook_event_name: "PreToolUse", tool_name: 42 });
	assert.equal(fallback.hookSpecificOutput.permissionDecision, "deny");
	for (const product of ["Memsira", "memsira", "drovr"]) {
		assert.ok(!fallback.hookSpecificOutput.permissionDecisionReason.includes(product));
	}
});

// --- CONNECTOR_WRITE_TOOLS is a public contract, not an internal detail ---

// memsira routes connector writes through its own gated approval flow; drovr
// keeps its chat sidecar permanently write-`deny` and runs an approved write as
// a one-shot `claude -p` scoped to exactly one tool. Both pin the
// actions they expose against this classification, because "the sidecar
// structurally cannot do this itself" is THIS module's claim, not theirs.
//
// Reclassifying an entry here as a READ would make a consumer's confirmation
// card bypassable, and nothing downstream would notice. Additions are safe and
// expected — this asserts every listed id still classifies as a write, so a
// removal or a read-verb rename has to be deliberate.
test("CONTRACT: every CONNECTOR_WRITE_TOOLS entry still classifies as a write", () => {
	assert.ok(CONNECTOR_WRITE_TOOLS.length > 0, "the write list must not be emptied");
	for (const name of CONNECTOR_WRITE_TOOLS) {
		assert.equal(isConnectorWriteTool(name), true, `${name} must stay a write`);
	}
});

test("CONTRACT: the connectors consumers gate on are all represented", () => {
	// A whole connector family vanishing from the list is the shape that would
	// silently un-gate a consumer, so pin the families rather than exact ids.
	// Server segments as they actually appear in the tool id — Google connectors
	// are `Google_Calendar` / `Google_Drive`, not `Calendar` / `Drive`.
	for (const ns of ["Gmail", "Google_Calendar", "Google_Drive", "Slack", "Atlassian"]) {
		assert.ok(
			CONNECTOR_WRITE_TOOLS.some((t) => t.includes(`claude_ai_${ns}__`)),
			`${ns} writes must stay enumerated`,
		);
	}
});
