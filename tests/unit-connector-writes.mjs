import { test } from "node:test";
import assert from "node:assert/strict";
import {
	connectorWriteModeFromEnv,
	connectorWriteModeFor,
	toolIsolationForQuery,
	connectorQueryOptions,
	connectorWriteDenyHook,
	isConnectorWriteTool,
	CONNECTOR_WRITE_TOOLS,
	CLAUDE_AI_CONNECTOR_TOOL_PATTERNS,
} from "../bundle/index.js";

function withEnv(value, fn) {
	const prev = process.env.CLAUDE_BRIDGE_CONNECTOR_WRITE;
	if (value === undefined) delete process.env.CLAUDE_BRIDGE_CONNECTOR_WRITE;
	else process.env.CLAUDE_BRIDGE_CONNECTOR_WRITE = value;
	try { return fn(); } finally {
		if (prev === undefined) delete process.env.CLAUDE_BRIDGE_CONNECTOR_WRITE;
		else process.env.CLAUDE_BRIDGE_CONNECTOR_WRITE = prev;
	}
}

// Drive the hook the way the SDK does: PreToolUse input + tool name.
async function runHook(hook, toolName) {
	return hook({ hook_event_name: "PreToolUse", tool_name: toolName, tool_input: {}, tool_use_id: "t1" }, "t1", { signal: new AbortController().signal });
}
function isDeny(out) {
	return out?.hookSpecificOutput?.permissionDecision === "deny";
}

test("connectorWriteModeFromEnv parses deny/allow (case-insensitive), else undefined", () => {
	assert.equal(withEnv("allow", connectorWriteModeFromEnv), "allow");
	assert.equal(withEnv(" ALLOW ", connectorWriteModeFromEnv), "allow");
	assert.equal(withEnv("deny", connectorWriteModeFromEnv), "deny");
	assert.equal(withEnv("DENY", connectorWriteModeFromEnv), "deny");
	for (const v of [undefined, "", "1", "true", "read-only", "nope"]) {
		assert.equal(withEnv(v, connectorWriteModeFromEnv), undefined, String(v));
	}
});

test("connectorWriteModeFor defaults to deny (no env, no config)", () => {
	assert.equal(withEnv(undefined, () => connectorWriteModeFor(undefined)), "deny");
	assert.equal(withEnv(undefined, () => connectorWriteModeFor({ provider: {} })), "deny");
});

test("connectorWriteModeFor: env allow enables writes", () => {
	assert.equal(withEnv("allow", () => connectorWriteModeFor(undefined)), "allow");
});

test("connectorWriteModeFor: config allow enables writes", () => {
	assert.equal(withEnv(undefined, () => connectorWriteModeFor({ provider: { connectorWriteMode: "allow" } })), "allow");
});

test("connectorWriteModeFor: env beats config both directions", () => {
	assert.equal(withEnv("deny", () => connectorWriteModeFor({ provider: { connectorWriteMode: "allow" } })), "deny");
	assert.equal(withEnv("allow", () => connectorWriteModeFor({ provider: { connectorWriteMode: "deny" } })), "allow");
});

test("connectorWriteModeFor FAILS CLOSED on unvalidated config values", () => {
	// Legacy config files are merged raw; a truthy non-"allow" value must NOT
	// silently open writes. Anything that isn't a valid "allow" resolves to
	// "deny" (validated strings are trimmed + lowercased first).
	for (const bad of ["Deny", "read-only", "on", "1", "allowed", true, 1, {}, null]) {
		assert.equal(
			withEnv(undefined, () => connectorWriteModeFor({ provider: { connectorWriteMode: bad } })),
			"deny",
			`config value ${JSON.stringify(bad)} must resolve to deny`,
		);
	}
});

test("isConnectorWriteTool classifies known + future write tools as writes (fail closed)", () => {
	const writes = [
		...CONNECTOR_WRITE_TOOLS,
		// not-yet-known future writes must still classify as writes
		"mcp__claude_ai_Gmail__send_message",
		"mcp__claude_ai_Gmail__update_draft",
		"mcp__claude_ai_Gmail__create_filter",
		"mcp__claude_ai_Google_Drive__update_file",
		"mcp__claude_ai_Google_Drive__delete_file",
		"mcp__claude_ai_Google_Drive__move_file",
		"mcp__claude_ai_Google_Calendar__add_attendee",
	];
	for (const name of writes) assert.equal(isConnectorWriteTool(name), true, name);
});

test("isConnectorWriteTool leaves connector reads + non-connector tools available", () => {
	const reads = [
		"mcp__claude_ai_Gmail__search_threads",
		"mcp__claude_ai_Gmail__get_message",
		"mcp__claude_ai_Gmail__list_labels",
		"mcp__claude_ai_Google_Calendar__list_events",
		"mcp__claude_ai_Google_Calendar__get_event",
		"mcp__claude_ai_Google_Drive__search_files",
		"mcp__claude_ai_Google_Drive__fetch_file",
		"mcp__claude_ai_Google_Drive__download_file",
		// discovery + Pi custom tools are never connector writes
		"ToolSearch",
		"ListMcpResources",
		"mcp__custom-tools__anything",
	];
	for (const name of reads) assert.equal(isConnectorWriteTool(name), false, name);
});

test("isConnectorWriteTool denies writes on UNKNOWN connector namespaces", () => {
	// Connectors attach account-wide: any claude.ai connector beyond the Google
	// trio must be write-denied too, or its mutations run ungated inside claude.
	const writes = [
		"mcp__claude_ai_Slack__send_message",
		"mcp__claude_ai_Atlassian__create_issue",
		"mcp__claude_ai_Figma__update_file",
		"mcp__claude_ai_Notion__delete_page",
	];
	for (const name of writes) assert.equal(isConnectorWriteTool(name), true, name);
});

test("isConnectorWriteTool keeps reads on UNKNOWN connector namespaces available", () => {
	const reads = [
		"mcp__claude_ai_Slack__search_messages",
		"mcp__claude_ai_Atlassian__get_issue",
		"mcp__claude_ai_Linear__list_issues",
	];
	for (const name of reads) assert.equal(isConnectorWriteTool(name), false, name);
});

// Fixtures below are REAL tool ids, enumerated live (ToolSearch) from a Claude
// account with the Slack and Atlassian connectors attached. They are the reason
// the classifier matches read verbs as words instead of as `verb_` prefixes:
// every one of these reads was denied by the old prefix test.
test("isConnectorWriteTool keeps LIVE Slack + Atlassian reads available", () => {
	const reads = [
		// Slack: server-prefixed snake_case
		"mcp__claude_ai_Slack__slack_read_channel",
		"mcp__claude_ai_Slack__slack_read_thread",
		"mcp__claude_ai_Slack__slack_read_canvas",
		"mcp__claude_ai_Slack__slack_read_user_profile",
		"mcp__claude_ai_Slack__slack_search_channels",
		"mcp__claude_ai_Slack__slack_search_public",
		"mcp__claude_ai_Slack__slack_search_public_and_private",
		"mcp__claude_ai_Slack__slack_search_users",
		// Atlassian: camelCase
		"mcp__claude_ai_Atlassian__getJiraIssue",
		"mcp__claude_ai_Atlassian__getJiraIssueRemoteIssueLinks",
		"mcp__claude_ai_Atlassian__getJiraIssueTypeMetaWithFields",
		"mcp__claude_ai_Atlassian__getJiraProjectIssueTypesMetadata",
		"mcp__claude_ai_Atlassian__getTransitionsForJiraIssue",
		"mcp__claude_ai_Atlassian__getVisibleJiraProjects",
		"mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql",
		"mcp__claude_ai_Atlassian__lookupJiraAccountId",
		"mcp__claude_ai_Atlassian__getConfluencePage",
		"mcp__claude_ai_Atlassian__getConfluencePageDescendants",
		"mcp__claude_ai_Atlassian__getConfluencePageFooterComments",
		"mcp__claude_ai_Atlassian__getConfluencePageInlineComments",
		"mcp__claude_ai_Atlassian__getConfluenceSpaces",
		"mcp__claude_ai_Atlassian__getPagesInConfluenceSpace",
		"mcp__claude_ai_Atlassian__searchConfluenceUsingCql",
		"mcp__claude_ai_Atlassian__getAccessibleAtlassianResources",
		"mcp__claude_ai_Atlassian__getIssueLinkTypes",
		"mcp__claude_ai_Atlassian__getTeamworkGraphContext",
		"mcp__claude_ai_Atlassian__getCompassComponents",
		// bare single-word tools
		"mcp__claude_ai_Atlassian__search",
		"mcp__claude_ai_Atlassian__fetch",
		// other connectors on the same account
		"mcp__claude_ai_Figma__get_metadata",
		"mcp__claude_ai_Figma__get_libraries",
		"mcp__claude_ai_Figma__whoami",
		"mcp__claude_ai_Google_Drive__list_recent_files",
		"mcp__claude_ai_Gmail__get_thread",
	];
	for (const name of reads) assert.equal(isConnectorWriteTool(name), false, name);
});

test("isConnectorWriteTool denies LIVE Slack + Atlassian writes", () => {
	const writes = [
		"mcp__claude_ai_Slack__slack_send_message",
		"mcp__claude_ai_Slack__slack_send_message_draft",
		"mcp__claude_ai_Slack__slack_schedule_message",
		"mcp__claude_ai_Slack__slack_create_canvas",
		"mcp__claude_ai_Slack__slack_update_canvas",
		"mcp__claude_ai_Atlassian__createJiraIssue",
		"mcp__claude_ai_Atlassian__editJiraIssue",
		"mcp__claude_ai_Atlassian__transitionJiraIssue",
		"mcp__claude_ai_Atlassian__addCommentToJiraIssue",
		"mcp__claude_ai_Atlassian__addWorklogToJiraIssue",
		"mcp__claude_ai_Atlassian__createIssueLink",
		"mcp__claude_ai_Atlassian__createConfluencePage",
		"mcp__claude_ai_Atlassian__updateConfluencePage",
		"mcp__claude_ai_Atlassian__createConfluenceFooterComment",
		"mcp__claude_ai_Atlassian__createConfluenceInlineComment",
		"mcp__claude_ai_Atlassian__createCompassComponent",
		"mcp__claude_ai_Atlassian__addTeamworkGraphContext",
		"mcp__claude_ai_Figma__upload_assets",
		"mcp__claude_ai_Figma__export_video",
	];
	for (const name of writes) assert.equal(isConnectorWriteTool(name), true, name);
});

test("isConnectorWriteTool: a read verb mixed with a mutation still denies", () => {
	// A name may open with a read verb and still mutate; deny wins over the
	// read exemption so the mixed case can never sneak through. The second
	// block uses mutating verbs BEYOND the obvious create/send/delete — the
	// mutation vocabulary must cover the verbs real APIs actually use, or a
	// compound name launders a mutation past the gate. `fetchAndLock` is a real
	// precedent (Camunda's external-task endpoint, which locks tasks).
	const writes = [
		"mcp__claude_ai_Slack__getOrCreateChannel",
		"mcp__claude_ai_Atlassian__findAndDeleteIssue",
		"mcp__claude_ai_Gmail__get_and_send_draft",
		"mcp__claude_ai_Camunda__fetchAndLock",
		"mcp__claude_ai_Github__getMergePullRequest",
		"mcp__claude_ai_Jira__getResolveIssue",
		"mcp__claude_ai_PagerDuty__get_incident_and_acknowledge",
		"mcp__claude_ai_AWS__describe_instance_and_terminate",
		"mcp__claude_ai_AWS__describe_instance_and_stop",
		"mcp__claude_ai_Calendly__get_next_slot_and_book",
		"mcp__claude_ai_Slack__slack_search_and_join_channel",
		"mcp__claude_ai_Slack__slack_get_channel_and_leave",
		"mcp__claude_ai_Slack__slack_search_and_star_message",
		"mcp__claude_ai_Slack__slack_get_message_and_forward",
	];
	for (const name of writes) assert.equal(isConnectorWriteTool(name), true, name);
});

test("isConnectorWriteTool: a verb-shaped SERVER name cannot launder its tool's verb", () => {
	// The server-prefix skip exists for Slack's `slack_`-prefixed tools. It must
	// never strip a leading word that is itself a mutation — otherwise a server
	// named after a verb turns its own writes into reads.
	const writes = [
		"mcp__claude_ai_Sync__sync_get_status",
		"mcp__claude_ai_Archive__archive_list_items",
		"mcp__claude_ai_Delete__delete_get_thing",
		"mcp__claude_ai_Merge__merge_read_branch",
	];
	for (const name of writes) assert.equal(isConnectorWriteTool(name), true, name);
});

test("isConnectorWriteTool skips only an exact server-name prefix", () => {
	// `Slack__slack_read_channel` is judged on `read channel`…
	assert.equal(isConnectorWriteTool("mcp__claude_ai_Slack__slack_read_channel"), false);
	// …but the skip must not swallow a real first word on a multi-word server,
	// and a tool named exactly after its server has no verb left → write.
	assert.equal(isConnectorWriteTool("mcp__claude_ai_Google_Drive__google_send_file"), true);
	assert.equal(isConnectorWriteTool("mcp__claude_ai_Google_Drive__google_drive_list_files"), false);
	assert.equal(isConnectorWriteTool("mcp__claude_ai_Slack__slack"), true);
});

test("isConnectorWriteTool ignores non-connector tools entirely", () => {
	const untouched = [
		"ToolSearch",
		"ListMcpResources",
		"ReadMcpResource",
		"mcp__some_other_server__do_thing",
		"mcp__some_other_server__create_thing",
		"memory_write", // bare Pi custom tool
	];
	for (const name of untouched) assert.equal(isConnectorWriteTool(name), false, name);
});

test("isConnectorWriteTool FAILS CLOSED on malformed names inside the connector space", () => {
	// Anything under mcp__claude_ai_ is a connector by construction, so a name we
	// cannot split into <server>__<tool> must classify as a write, never a read.
	const malformed = [
		"mcp__claude_ai_", // prefix only, no server, no tool
		"mcp__claude_ai_Slack", // server, no tool segment
		"mcp__claude_ai_Slack__", // empty tool segment
		"mcp__claude_ai___search_messages", // EMPTY server segment: read verb must not exempt it
		"mcp__claude_ai_____get_thing", // empty server + leading-underscore tool segment
		"mcp__claude_ai_Weird__Server__list_things", // extra segment → first word isn't a read verb
		"mcp__claude_ai_Slack__Send_Message", // `send` is not a read verb, in any casing
	];
	for (const name of malformed) assert.equal(isConnectorWriteTool(name), true, name);
});

test("PreToolUse hook denies connector writes (known + future) and allows reads", async () => {
	const hook = connectorWriteDenyHook();
	// future write: not a known read verb → deny
	assert.ok(isDeny(await runHook(hook, "mcp__claude_ai_Gmail__send_message")), "send_message denied");
	assert.ok(isDeny(await runHook(hook, "mcp__claude_ai_Gmail__create_draft")), "create_draft denied");
	assert.ok(isDeny(await runHook(hook, "mcp__claude_ai_Google_Drive__delete_file")), "delete_file denied");
	// reads pass through untouched
	assert.equal(isDeny(await runHook(hook, "mcp__claude_ai_Gmail__search_threads")), false, "search_threads allowed");
	assert.equal((await runHook(hook, "mcp__claude_ai_Gmail__search_threads")).continue, true, "search_threads continues");
	// non-connector tools pass through
	assert.equal((await runHook(hook, "ToolSearch")).continue, true, "ToolSearch continues");
	assert.equal((await runHook(hook, "mcp__custom-tools__foo")).continue, true, "custom tool continues");
});

test("PreToolUse hook denies writes on an UNKNOWN connector namespace", async () => {
	const hook = connectorWriteDenyHook();
	const out = await runHook(hook, "mcp__claude_ai_Slack__send_message");
	assert.ok(isDeny(out), "Slack send_message denied");
	assert.match(out.hookSpecificOutput.permissionDecisionReason, /mcp__claude_ai_Slack__send_message/);
	assert.ok(isDeny(await runHook(hook, "mcp__claude_ai_Atlassian__create_issue")), "Atlassian create_issue denied");
	// reads on the same unknown namespace still pass
	assert.equal((await runHook(hook, "mcp__claude_ai_Slack__search_messages")).continue, true, "Slack search continues");
	// other MCP servers are untouched
	assert.equal((await runHook(hook, "mcp__some_other_server__create_thing")).continue, true, "non-connector MCP continues");
});

test("connectorQueryOptions(true) [deny] wires disallowedTools ids AND both PreToolUse hooks", async () => {
	const opts = connectorQueryOptions(true); // default deny
	for (const w of CONNECTOR_WRITE_TOOLS) assert.ok(opts.disallowedTools.includes(w), `deny id ${w}`);
	for (const p of CLAUDE_AI_CONNECTOR_TOOL_PATTERNS) assert.ok(opts.allowedTools.includes(p), `allow ${p}`);
	assert.ok(Array.isArray(opts.hooks?.PreToolUse), "PreToolUse hooks registered");
	assert.equal(opts.hooks.PreToolUse.length, 1);
	// Builtin allowlist + write deny, in that order (C13).
	assert.equal(opts.hooks.PreToolUse[0].hooks.length, 2);
	const [allowlist, writeDeny] = opts.hooks.PreToolUse[0].hooks;
	assert.ok(isDeny(await runHook(allowlist, "SlashCommand")), "allowlist denies non-permitted builtins");
	assert.ok(isDeny(await runHook(writeDeny, "mcp__claude_ai_Gmail__create_draft")), "write hook denies connector writes");
});

test("connectorQueryOptions(true, 'allow') exposes writes but KEEPS the builtin allowlist", async () => {
	const opts = connectorQueryOptions(true, "allow");
	for (const w of CONNECTOR_WRITE_TOOLS) assert.ok(!opts.disallowedTools.includes(w), `not denied ${w}`);
	for (const p of CLAUDE_AI_CONNECTOR_TOOL_PATTERNS) assert.ok(opts.allowedTools.includes(p), `allow ${p}`);
	// The one-shot write executor is still a connectors session ingesting
	// third-party content: no write-deny hook, but the allowlist stays (C13).
	assert.equal(opts.hooks.PreToolUse[0].hooks.length, 1);
	const [allowlist] = opts.hooks.PreToolUse[0].hooks;
	assert.equal((await runHook(allowlist, "mcp__claude_ai_Gmail__create_draft")).continue, true, "writes pass the allowlist in allow mode");
	assert.ok(isDeny(await runHook(allowlist, "SlashCommand")), "unknown builtins still denied in allow mode");
});

test("connectorQueryOptions(false) [connectors off] is default isolation, no hook, no write denies", () => {
	const deny = connectorQueryOptions(false, "deny");
	const allow = connectorQueryOptions(false, "allow");
	assert.deepEqual(deny, allow); // write mode ignored when connectors off
	assert.deepEqual(deny.tools, []);
	assert.equal(deny.hooks, undefined);
	for (const w of CONNECTOR_WRITE_TOOLS) assert.ok(!deny.disallowedTools.includes(w), `no connector write in default isolation ${w}`);
});

test("toolIsolationForQuery still denies writes fail-closed (any non-allow mode)", () => {
	for (const mode of ["deny", undefined, "read-only"]) {
		const iso = toolIsolationForQuery(true, mode);
		for (const w of CONNECTOR_WRITE_TOOLS) assert.ok(iso.disallowedTools.includes(w), `mode ${mode} denies ${w}`);
	}
	const allow = toolIsolationForQuery(true, "allow");
	for (const w of CONNECTOR_WRITE_TOOLS) assert.ok(!allow.disallowedTools.includes(w), `allow exposes ${w}`);
});
