// The `claude_bridge_incident` tool: registered at every extension load, with
// or without `incidents.repo`, it lists the incidents recorded in this Pi
// process and shows one with the same validated evidence an issue carries.
// Filing through it is covered in unit-incident-filing.mjs.
import "./lib/debug-env.mjs";

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { tsImport } from "tsx/esm/api";

import claudeBridge from "../src/index.ts";
import { setExtensionApi } from "../src/bridge-state.ts";
import { __testResetIncidents, recordIncident } from "../src/incidents.ts";

const REPO = "nicobailon/bridge-incidents";
const TOOL = "claude_bridge_incident";
const TOOL_USE_ID = "toolu_01D7FLrfh4GYq7yT1ULFeyMV";
// Synthetic, never a credential: a string no validated field may keep.
const SENTINEL = "SENTINEL-free-text-never-shown";

let agentDir;

function loadTools(bridge = claudeBridge) {
	const tools = new Map();
	bridge({
		on: () => {},
		registerCommand: () => {},
		registerProvider: () => {},
		registerTool: (tool) => tools.set(tool.name, tool),
		events: { emit: () => {} },
		appendEntry: () => {},
	});
	return tools;
}

function incidentTool(bridge) {
	const tool = loadTools(bridge).get(TOOL);
	assert.ok(tool, "the incident tool is registered");
	return tool;
}

async function runTool(tool, params) {
	const result = await tool.execute("call-1", params, undefined, undefined, {});
	return result.content.map((block) => block.text).join("");
}

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "bridge-incident-tool-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	__testResetIncidents();
	setExtensionApi({ events: { emit: () => {} }, appendEntry: () => {} });
});

afterEach(() => {
	setExtensionApi(undefined);
	__testResetIncidents();
	rmSync(agentDir, { recursive: true, force: true });
});

describe("the claude_bridge_incident tool", () => {
	it("is registered once at load, the same with and without incidents.repo, and adds nothing to the system prompt", () => {
		const off = loadTools();
		writeFileSync(join(agentDir, "claude-bridge.json"), JSON.stringify({ incidents: { repo: REPO } }));
		const on = loadTools();
		assert.deepEqual([...off.keys()], [TOOL]);
		assert.deepEqual([...on.keys()], [TOOL]);
		const [a, b] = [off.get(TOOL), on.get(TOOL)];
		assert.equal(a.description, b.description);
		assert.deepEqual(a.parameters, b.parameters);
		assert.equal(a.promptSnippet, undefined);
		assert.equal(a.promptGuidelines, undefined);
		assert.deepEqual(a.parameters.properties.action.enum, ["list", "show", "file"]);
		assert.deepEqual(a.parameters.required, ["action"]);
		assert.match(a.description, /bridge incidents only/i);
		assert.match(a.description, /tell the user/i);
	});

	it("lists this process's incidents newest first, without expected cleanup, and without incidents.repo", async () => {
		const tool = incidentTool();
		assert.equal(await runTool(tool, { action: "list" }), "No Claude bridge incidents in this Pi process.");
		const older = recordIncident("session_verify_fail@verifyWrittenSession", "silent", {});
		recordIncident("partial_tool_calls_pruned@abort", "expected", {});
		await new Promise((resolve) => setTimeout(resolve, 5));
		const newer = recordIncident("tool_call_dead@answerUnclaimedToolUse", "user-visible", {});
		recordIncident("tool_call_dead@answerUnclaimedToolUse", "user-visible", {});

		const lines = (await runTool(tool, { action: "list" })).split("\n");
		assert.equal(lines[0], "Claude bridge incidents in this Pi process, newest first (2):");
		assert.equal(lines.length, 3);
		assert.equal(lines[1], `- ${newer.id}: Claude Code called a tool whose call had already ended. (tool_call_dead at answerUnclaimedToolUse, user-visible, seen 2 times, first ${newer.firstSeen}, last ${newer.lastSeen})`);
		assert.equal(lines[2], `- ${older.id}: The session file the bridge wrote for Claude Code did not read back as written. (session_verify_fail at verifyWrittenSession, silent, seen 1 time, first ${older.firstSeen}, last ${older.lastSeen})`);
	});

	it("bounds the list", async () => {
		const tool = incidentTool();
		for (let i = 0; i < 45; i++) recordIncident(`empty_prompt@site${i}`, "silent", {});
		const lines = (await runTool(tool, { action: "list" })).split("\n");
		assert.equal(lines[0], "Claude bridge incidents in this Pi process, newest first (45):");
		assert.equal(lines.length, 1 + 20 + 1);
		assert.equal(lines.at(-1), "… and 25 older incidents not shown.");
	});

	it("shows one incident with its validated evidence, diag metadata and latest recorder snapshot, without incidents.repo", async () => {
		const tool = incidentTool();
		const data = { toolCallId: TOOL_USE_ID, recordedName: SENTINEL, errorText: SENTINEL };
		recordIncident("tool_call_id_other_tool@answerUnclaimedToolUse", "user-visible", data, { recorder: { snapshot: () => [{ t: 1, kind: "tools_call", id: TOOL_USE_ID }] } });
		const incident = recordIncident("tool_call_id_other_tool@answerUnclaimedToolUse", "user-visible", data, { recorder: { snapshot: () => [{ t: 2, kind: "claim_other_tool", id: SENTINEL }] } });

		const text = await runTool(tool, { action: "show", incident: incident.id });
		assert.ok(text.startsWith(`Incident ${incident.id}: tool_call_id_other_tool at answerUnclaimedToolUse (user-visible)\n\nClaude Code sent a tool call id that the bridge recorded for a different tool.\nWhat the user saw: an error was shown, naming this incident.`), text);
		for (const expected of ["| Class | user-visible |", "| Count | 2 |", "## Diag metadata", TOOL_USE_ID, "[unregistered tool name]", "droppedFields", "## Latest recorder snapshot", "claim_other_tool", "[invalid tool_use id]"]) {
			assert.ok(text.includes(expected), `show has ${expected}`);
		}
		assert.ok(!text.includes(SENTINEL), "nothing unvalidated reaches the agent");
		assert.ok(!text.includes("\"tools_call\""), "the latest snapshot, not the first");

		const silent = recordIncident("session_verify_fail@verifyWrittenSession", "silent", {});
		assert.match(await runTool(tool, { action: "show", incident: silent.id }), /\nWhat the user saw: nothing; the bridge recovered silently\.\n/);
	});

	it("refuses an unknown or expected incident, and show or file without an id", async () => {
		const tool = incidentTool();
		const expected = recordIncident("partial_tool_calls_pruned@abort", "expected", {});
		await assert.rejects(runTool(tool, { action: "show", incident: "bi-zzzz" }), /^Error: Unknown incident bi-zzzz: no incident with that id in this Pi process\./);
		await assert.rejects(runTool(tool, { action: "show", incident: expected.id }), new RegExp(`Unknown incident ${expected.id}`));
		await assert.rejects(runTool(tool, { action: "show" }), /An incident id is required/);
		await assert.rejects(runTool(tool, { action: "file", summary: "x" }), /An incident id is required/);
	});

	it("lists and shows incidents another copy of the bridge recorded", async () => {
		// Pi loads a fresh copy of every module of the extension per session
		// it starts with its own loader (an in-process subagent); the copy that
		// serves the requests records the incidents.
		const incident = recordIncident("session_verify_fail@verifyWrittenSession", "silent", {});
		const copy = await tsImport("../src/index.ts", import.meta.url);
		const tool = incidentTool(copy.default);
		assert.match(await runTool(tool, { action: "list" }), new RegExp(`- ${incident.id}: `));
		assert.match(await runTool(tool, { action: "show", incident: incident.id }), new RegExp(`^Incident ${incident.id}: `));
	});
});
