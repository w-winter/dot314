import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isPiDispatchable, mapToolName } from "../src/index.ts";

describe("tool name mapping", () => {
	it("maps known Claude builtin names to Pi tool names", () => {
		assert.equal(mapToolName("Read"), "read");
	});

	it("maps MCP-qualified custom tool names back to Pi tool names", () => {
		const map = new Map([
			["mcp__custom-tools__grep", "grep"],
			["mcp__custom-tools__cameltool", "CamelTool"],
		]);
		assert.equal(mapToolName("mcp__custom-tools__grep", map), "grep");
		assert.equal(mapToolName("mcp__custom-tools__Grep", map), "grep");
		assert.equal(mapToolName("mcp__custom_tools__grep"), "grep");
		assert.equal(mapToolName("mcp/custom-tools/grep"), "grep");
		assert.equal(mapToolName("mcp/custom_tools/grep"), "grep");
		assert.equal(mapToolName("mcp__custom_tools__CamelTool", map), "CamelTool");
	});

	it("treats a populated bridged manifest as authoritative", () => {
		const map = new Map([
			["mcp__custom-tools__read", "read"],
			["mcp__custom-tools__grep", "grep"],
		]);
		assert.equal(isPiDispatchable("bash", map), false);
		assert.equal(isPiDispatchable("grep", map), false);
		assert.equal(isPiDispatchable("mcp__filesystem__read_file", map), false);
		assert.equal(isPiDispatchable("mcp/filesystem/read_file", map), false);
		assert.equal(isPiDispatchable("mcp/filesystem/read_file", new Map()), false);
		assert.equal(isPiDispatchable("mcp__custom-tools__grep", map), true);
		assert.equal(isPiDispatchable("mcp__custom_tools__grep", map), true);
		assert.equal(isPiDispatchable("mcp/custom-tools/grep", map), true);
		assert.equal(isPiDispatchable("mcp__custom-tools__missing", map), false);
		for (const name of ["ListMcpResources", "ListMcpResourcesTool", "ReadMcpResource", "ReadMcpResourceTool"]) {
			assert.equal(isPiDispatchable(name, map), true);
		}
		assert.equal(isPiDispatchable("grep", new Map()), true);
	});
});
