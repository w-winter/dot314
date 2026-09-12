import { test } from "node:test";
import assert from "node:assert/strict";
import { connectorProxyUrl, connectorServerName } from "../src/connector-inventory.ts";
import { connectorMcpServers } from "../src/connectors.ts";

const ok = (connectors) => ({ ok: true, complete: true, connectors });

test("declares only connectors the account reports as connected", () => {
	// installState mirrors what the account returns: `connected` is exactly the
	// set the CLI itself attempts. Declaring the rest would ask alwaysLoad to
	// block startup on servers that never connect.
	const servers = connectorMcpServers(ok([
		{ name: "Slack", installedServerId: "id-slack", installState: "connected" },
		{ name: "Asana", installedServerId: "id-asana", installState: "unknown" },
		{ name: "Box", installedServerId: "id-box" },
	]));
	assert.deepEqual(Object.keys(servers), ["claude.ai Slack"]);
});

test("COMPATIBILITY CONTRACT: the server key is `claude.ai <Connector>` — changing it breaks memsira", () => {
	// This is a cross-repo contract, not a style choice. Read this before
	// "improving" the key format.
	//
	// The mcpServers key IS the tool namespace. memsira's claude_tools.rs
	// hard-codes FULLY-QUALIFIED connector tool names into `--allowedTools` and
	// into its executor system prompt, and never globs a namespace. So if this
	// format changes, every memsira connector WRITE silently stops matching a
	// real tool and surfaces to the user as "unavailable" rather than as an
	// error naming the cause — the worst possible failure shape, because it
	// looks like a missing connector rather than a broken contract.
	//
	// Keyed as anything else, the connector also appears TWICE (28 servers vs
	// 27), once from our declaration and once from the CLI's own loader.
	//
	// If this test fails, you are making a breaking change for a downstream
	// repo. Coordinate with memsira first; see docs/cross-repo.md
	// "The Connector Server Key Is The Tool Namespace — Must-Agree Across Repos".
	assert.equal(connectorServerName("Slack"), "claude.ai Slack");
	assert.equal(connectorServerName("Google Calendar"), "claude.ai Google Calendar");
	assert.equal(connectorServerName("  Figma  "), "claude.ai Figma", "trimmed, not otherwise rewritten");
	// No case-folding, no separator substitution, no id in the key — the tool
	// namespace derives from this string and memsira pins the result verbatim.
	const servers = connectorMcpServers(ok([
		{ name: "Google Calendar", installedServerId: "id-cal", installState: "connected" },
	]));
	assert.deepEqual(Object.keys(servers), ["claude.ai Google Calendar"]);
});

test("emits the claudeai-proxy shape with alwaysLoad set", () => {
	const servers = connectorMcpServers(ok([
		{ name: "Slack", installedServerId: "id-slack", installState: "connected" },
	]));
	assert.deepEqual(servers["claude.ai Slack"], {
		type: "claudeai-proxy",
		url: connectorProxyUrl("id-slack"),
		id: "id-slack",
		// The whole mechanism: blocks startup until connected, so the tools are
		// present when the turn-1 prompt is built.
		alwaysLoad: true,
	});
});

test("proxy url targets the claude.ai mcp proxy and escapes the id", () => {
	assert.equal(connectorProxyUrl("id-slack"), "https://mcp-proxy.anthropic.com/v1/mcp/id-slack");
	assert.equal(connectorProxyUrl("a/b"), "https://mcp-proxy.anthropic.com/v1/mcp/a%2Fb");
	assert.equal(connectorProxyUrl("x", "https://example.test/mcp///"), "https://example.test/mcp/x");
});

test("a connected connector with no installed server id is skipped, not emitted broken", () => {
	const servers = connectorMcpServers(ok([
		{ name: "Slack", installState: "connected" },
	]));
	assert.deepEqual(servers, {});
});

test("a failed inventory declares nothing rather than throwing", () => {
	// Fail open: a network blip must not break the turn, it just means the
	// connectors race again for that session.
	assert.deepEqual(connectorMcpServers({ ok: false, complete: false, reason: "boom" }), {});
});

test("CLAUDE_BRIDGE_CONNECTOR_DECLARE=off disables declarations without disabling connectors", () => {
	// The alwaysLoad barrier's worst-case bound is not established (5s per the
	// SDK doc comment vs 30000ms in the CLI's own log), so an account with slow
	// connectors needs a way out that does not cost them connectors entirely.
	const inv = { ok: true, complete: true, connectors: [
		{ name: "Slack", installedServerId: "id-slack", installState: "connected" },
	] };
	const prev = process.env.CLAUDE_BRIDGE_CONNECTOR_DECLARE;
	try {
		for (const off of ["off", "0", "false", "no", "OFF"]) {
			process.env.CLAUDE_BRIDGE_CONNECTOR_DECLARE = off;
			assert.deepEqual(connectorMcpServers(inv), {}, `expected ${off} to disable`);
		}
		for (const on of ["", "on", "1", "true"]) {
			process.env.CLAUDE_BRIDGE_CONNECTOR_DECLARE = on;
			assert.deepEqual(Object.keys(connectorMcpServers(inv)), ["claude.ai Slack"], `expected ${on || "<empty>"} to keep declarations`);
		}
	} finally {
		if (prev === undefined) delete process.env.CLAUDE_BRIDGE_CONNECTOR_DECLARE;
		else process.env.CLAUDE_BRIDGE_CONNECTOR_DECLARE = prev;
	}
});
