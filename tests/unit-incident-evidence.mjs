// Incident evidence is validated by kind where it is recorded: every string an
// incident keeps (diag metadata, flight-recorder ids and kinds, the model)
// must have the exact shape of its kind, or it is replaced by a placeholder.
// A tool name is kept only when Pi registered that tool in this process.
import "./lib/debug-env.mjs";

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Type } from "@earendil-works/pi-ai";

import { __testSetBridgeIntegrityState, __testSetSdkQueryFactory, streamClaudeAgentSdk } from "../src/index.ts";
import { setExtensionApi } from "../src/bridge-state.ts";
import { __testResetIncidents, recordIncident } from "../src/incidents.ts";
import { resetStack } from "../src/query-state.ts";

const model = {
	id: "claude-haiku-4-5",
	name: "Claude Haiku",
	api: "claude-bridge",
	provider: "pi-claude",
	baseUrl: "claude-bridge",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8192,
};

// Real shapes, as Claude and Claude Code write them.
const TOOL_USE_ID = "toolu_01D7FLrfh4GYq7yT1ULFeyMV";
const SERVER_TOOL_USE_ID = "srvtoolu_01WYG3ziw53XMcoyKL4XcZmE";
const MESSAGE_ID = "msg_01XFDUDYJgAACzvnptvVoYEL";
const SESSION_UUID = "8b2c4d6e-1f3a-4b5c-9d7e-0a1b2c3d4e5f";
const MCP_TOOL = "mcp__git__get_pr_by_id_from_repo_with_org_name";
// Synthetic: 30 bytes of a hash of fixed text, valid base64 and base64url.
const TOKEN = createHash("sha256").update("synthetic-review-token-34135").digest().subarray(0, 30).toString("base64");

let agentDir;

async function collect(stream) {
	const events = [];
	for await (const event of stream) events.push(event);
	return events;
}

/** Runs one request whose Pi context offers `names` as tools: how Pi's tool
 *  list reaches the bridge. */
async function offerPiTools(names) {
	__testSetSdkQueryFactory(() => ({
		async *[Symbol.asyncIterator]() {
			yield { type: "system", subtype: "init", session_id: "evidence-session", claude_code_version: "9.9.9" };
			yield { type: "result", subtype: "success", result: "ok", session_id: "evidence-session" };
		},
		close() {},
		async interrupt() {},
	}));
	const tools = names.map((name) => ({ name, description: "A Pi tool", parameters: Type.Object({}) }));
	await collect(streamClaudeAgentSdk(model, { messages: [{ role: "system", content: "test system prompt", toolsAdded: tools, timestamp: 0 }, { role: "user", content: "hello", timestamp: 1 }] }, { sessionId: "evidence" }));
}

const record = (data, source) => recordIncident("tool_handler_unmatched@mcpToolHandler", "user-visible", data, source);

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "bridge-evidence-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT = "0";
	process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token";
	process.env.CLAUDE_BRIDGE_DIAG_PATH = join(agentDir, "diag.log");
	resetStack();
	__testResetIncidents();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: { notify: () => {} } });
	setExtensionApi({ events: { emit: () => {} }, appendEntry: () => {} });
});

afterEach(() => {
	delete process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT;
	delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
	delete process.env.CLAUDE_BRIDGE_DIAG_PATH;
	__testSetSdkQueryFactory();
	setExtensionApi(undefined);
	resetStack();
	__testResetIncidents();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
	rmSync(agentDir, { recursive: true, force: true });
});

describe("incident evidence", () => {
	it("keeps a tool name Pi registered, however long, and replaces any other", async () => {
		await offerPiTools([MCP_TOOL, "echo"]);
		const incident = record({
			toolName: MCP_TOOL,
			recordedName: "not_a_pi_tool",
			calls: [{ id: TOOL_USE_ID, name: "echo" }, { id: TOOL_USE_ID, name: TOKEN }],
		});
		assert.equal(incident.diag.toolName, MCP_TOOL);
		assert.equal(incident.diag.recordedName, "[unregistered tool name]");
		assert.deepEqual(incident.diag.calls, [{ id: TOOL_USE_ID, name: "echo" }, { id: TOOL_USE_ID, name: "[unregistered tool name]" }]);
	});

	it("does not take a tool name no request offered", () => {
		assert.equal(record({ toolName: MCP_TOOL }).diag.toolName, "[unregistered tool name]");
	});

	it("keeps only Claude's tool_use and message id shapes", () => {
		const incident = record({
			toolCallId: TOOL_USE_ID,
			id: SERVER_TOOL_USE_ID,
			messageId: MESSAGE_ID,
			unmatchedResultIds: [TOOL_USE_ID, "toolu_1", "call_abc", TOKEN, `${TOOL_USE_ID}x`],
			turnToolCallIds: [`msg_${TOOL_USE_ID.slice(6)}`],
		});
		assert.equal(incident.diag.toolCallId, TOOL_USE_ID);
		assert.equal(incident.diag.id, SERVER_TOOL_USE_ID);
		assert.equal(incident.diag.messageId, MESSAGE_ID);
		assert.deepEqual(incident.diag.unmatchedResultIds, [TOOL_USE_ID, "[invalid unmatchedResultIds]", "[invalid unmatchedResultIds]", "[invalid unmatchedResultIds]", "[invalid unmatchedResultIds]"]);
		assert.deepEqual(incident.diag.turnToolCallIds, ["[invalid turnToolCallIds]"]);
		assert.equal(recordIncident("tool_call_dead@answerUnclaimedToolUse", "user-visible", { messageId: TOKEN }).diag.messageId, "[invalid messageId]");
	});

	it("keeps recorder ids and kinds of the right shape only", () => {
		const incident = record({}, {
			recorder: {
				snapshot: () => [
					{ t: 0, kind: "query_start", n: 2 },
					{ t: 1, kind: "content_block_start", id: TOOL_USE_ID, index: 0 },
					{ t: 2, kind: "result_error_during_execution" },
					{ t: 3, kind: "tools_call", id: TOKEN },
					{ t: 4, kind: "tools_call", id: MCP_TOOL },
					{ t: 5, kind: TOKEN },
				],
			},
			turnOutput: { model: "claude-sonnet-4-6" },
		});
		assert.deepEqual(incident.snapshot, [
			{ t: 0, kind: "query_start", n: 2 },
			{ t: 1, kind: "content_block_start", id: TOOL_USE_ID, index: 0 },
			{ t: 2, kind: "result_error_during_execution" },
			{ t: 3, kind: "tools_call", id: "[invalid tool_use id]" },
			{ t: 4, kind: "tools_call", id: "[invalid tool_use id]" },
			{ t: 5, kind: "[invalid kind]" },
		]);
		assert.equal(incident.model, "claude-sonnet-4-6");
		assert.equal(recordIncident("tool_call_dead@answerUnclaimedToolUse", "user-visible", {}, { turnOutput: { model: TOKEN } }).model, "[invalid model]");
	});

	it("keeps session ids, versions, errors and roles of their exact shape", () => {
		const good = record({
			sessionId: SESSION_UUID,
			sharedSession: { sessionId: "8b2c4d6e" },
			version: "2.1.3",
			previousVersion: "2.0.76-beta.1",
			errorName: "ClaudeSpawnDiagnosticError",
			code: "ENOENT",
			syscall: "spawn",
			lastMsgRole: "toolResult",
			promptRoles: "user user",
			messageRoles: "[0]system [1]user [2]assistant [3]toolResult [4]custom",
		});
		assert.deepEqual(good.diag, {
			sessionId: SESSION_UUID,
			sharedSession: { sessionId: "8b2c4d6e" },
			version: "2.1.3",
			previousVersion: "2.0.76-beta.1",
			errorName: "ClaudeSpawnDiagnosticError",
			code: "ENOENT",
			syscall: "spawn",
			lastMsgRole: "toolResult",
			promptRoles: "user user",
			messageRoles: "[0]system [1]user [2]assistant [3]toolResult [4]custom",
		});
		const bad = recordIncident("tool_call_dead@answerUnclaimedToolUse", "user-visible", {
			sessionId: TOKEN,
			sharedSession: { sessionId: "8B2C4D6E" },
			version: TOKEN,
			previousVersion: "2.1",
			errorName: TOKEN,
			code: TOKEN,
			syscall: "spawn /private/path",
			lastMsgRole: "Secret",
			promptRoles: `user ${TOKEN}`,
			messageRoles: "[0]system [1]user [2]SECRET",
		});
		assert.deepEqual(bad.diag, {
			sessionId: "[invalid sessionId]",
			sharedSession: { sessionId: "[invalid sessionId]" },
			version: "[invalid version]",
			previousVersion: "[invalid previousVersion]",
			errorName: "[invalid errorName]",
			code: "[invalid code]",
			syscall: "[invalid syscall]",
			lastMsgRole: "[invalid lastMsgRole]",
			promptRoles: "[invalid promptRoles]",
			messageRoles: "[invalid messageRoles]",
		});
	});

	it("keeps sites from the code's site table and labels of label shape", () => {
		const incident = record({
			site: "finalize-no-stream",
			cause: "stream-idle-timeout",
			subtype: "error_during_execution",
			kind: "rate-limit",
			discarded: [{ type: "tool_use", index: 1, id: TOOL_USE_ID }],
		});
		assert.deepEqual(incident.diag, {
			site: "finalize-no-stream",
			cause: "stream-idle-timeout",
			subtype: "error_during_execution",
			kind: "rate-limit",
			discarded: [{ type: "tool_use", index: 1, id: TOOL_USE_ID }],
		});
		const bad = recordIncident("tool_call_dead@answerUnclaimedToolUse", "user-visible", { site: "someFunctionNobodyWrote", cause: TOKEN, subtype: TOKEN.toLowerCase(), kind: "Rate Limit", why: `restreamed as ${MESSAGE_ID}` });
		assert.deepEqual(bad.diag, {
			site: "[invalid site]",
			cause: "[invalid cause]",
			subtype: "[invalid subtype]",
			kind: "[invalid kind]",
			why: "[invalid why]",
		});
	});
});
