// The claude.ai connector namespace belongs to the CHILD's own MCP servers.
// The model must receive only one name for each capability because it can
// imitate an alias that the dispatcher does not accept and
// got a real `Tool ... not found` from the MCP dispatcher before retrying the
// canonical one — one wasted round-trip per affected call.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mapPiToolNameToSdk } from "../src/convert.ts";
import { isChildExecutedTool } from "../src/connectors.ts";
import { resolveMcpTools } from "../src/index.ts";

const CONNECTOR_TOOL = "mcp__claude_ai_Slack__slack_search_channels";

describe("connector names are never aliased into the child's history", () => {
	it("passes a connector name through unchanged", () => {
		assert.equal(mapPiToolNameToSdk(CONNECTOR_TOOL), CONNECTOR_TOOL);
		assert.equal(
			mapPiToolNameToSdk("mcp__claude_ai_Atlassian__getConfluencePage"),
			"mcp__claude_ai_Atlassian__getConfluencePage",
		);
	});

	it("does not produce the PascalCase alias that was observed live", () => {
		// The exact string from memsira's child transcript 672467eb.
		assert.notEqual(mapPiToolNameToSdk(CONNECTOR_TOOL), "McpClaudeAiSlackSlackSearchChannels");
	});

	it("still maps everything else as before", () => {
		assert.equal(mapPiToolNameToSdk("read"), "Read");
		assert.equal(mapPiToolNameToSdk("bash"), "Bash");
		assert.equal(mapPiToolNameToSdk("my_custom_tool"), "MyCustomTool");
		assert.equal(mapPiToolNameToSdk(""), "");
	});

	it("still prefers an explicit custom mapping for a non-connector tool", () => {
		const map = new Map([["my_custom_tool", "mcp__pi__my_custom_tool"]]);
		assert.equal(mapPiToolNameToSdk("my_custom_tool", map), "mcp__pi__my_custom_tool");
	});

	it("a connector name wins over a custom mapping — the namespace is the child's", () => {
		// A host that put a connector-named tool in Pi's set cannot reclaim the
		// name: the call is treated as child-executed either way, so re-offering
		// it under our prefix would only produce an uncallable second name.
		const map = new Map([[CONNECTOR_TOOL, `mcp__pi__${CONNECTOR_TOOL}`]]);
		assert.equal(mapPiToolNameToSdk(CONNECTOR_TOOL, map), CONNECTOR_TOOL);
		assert.equal(isChildExecutedTool(CONNECTOR_TOOL), true);
	});
});

describe("the bridge MCP manifest never re-offers a child-native tool", () => {
	it("drops a connector-named Pi tool instead of advertising a second name for it", () => {
		const { mcpTools, customToolNameToSdk, customToolNameToPi } = resolveMcpTools({
			tools: [
				{ name: "read", description: "read a file", parameters: { type: "object" } },
				{ name: CONNECTOR_TOOL, description: "squatting on the child's namespace", parameters: { type: "object" } },
			],
		});

		assert.deepEqual(mcpTools.map((t) => t.name), ["read"]);
		assert.equal(customToolNameToSdk.has(CONNECTOR_TOOL), false);
		assert.equal(customToolNameToPi.has(`mcp__pi__${CONNECTOR_TOOL}`), false);
	});

	it("still offers ordinary Pi tools, and still honours excludeToolName", () => {
		const { mcpTools } = resolveMcpTools(
			{
				tools: [
					{ name: "read", description: "", parameters: { type: "object" } },
					{ name: "bash", description: "", parameters: { type: "object" } },
				],
			},
			"bash",
		);
		assert.deepEqual(mcpTools.map((t) => t.name), ["read"]);
	});

	it("tolerates a context with no tools", () => {
		assert.deepEqual(resolveMcpTools({}).mcpTools, []);
	});
});
