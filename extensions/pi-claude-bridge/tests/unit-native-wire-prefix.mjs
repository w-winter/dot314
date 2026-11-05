import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { getSessionPath } from "cc-session-io";
import { setSharedSession } from "../src/bridge-state.ts";
import { resetStack } from "../src/query-state.ts";
import { syncSharedSession } from "../src/session-persistence.ts";
import { nativeTranscript, piPriors, PI_TOOL_NAMES, TOOL_NAMES, user } from "./fixtures/native-transcript.mjs";

const OLD = "11111111-2222-4333-8444-555555555555";
const original = { command: "echo \\u200b" };
const normalized = { command: "echo \u200b" };
const prompts = [
	"The conversation above was rewritten by Pi (compaction or history navigation). It is the complete current history, including the results of every tool call that has already run. Continue the turn from there, and do not repeat a tool call whose result is already above.",
	"[Claude bridge: your previous reply failed before it finished, and Pi is retrying it. The tool results above are complete. Continue from them, and do not repeat a tool call whose result is already above.]",
	"Continue the turn using the current system instructions and the tool results above. Do not repeat a tool call whose result is already above.",
	"Continue from the completed tool results above; do not repeat completed tool calls.",
];
let root;
let cwd;
let claudeDir;
let previous;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "bridge-native-wire-"));
	cwd = join(root, "project");
	claudeDir = join(root, "claude");
	mkdirSync(cwd);
	const env = { PI_CODING_AGENT_DIR: root, CLAUDE_CONFIG_DIR: claudeDir, CLAUDE_CODE_OAUTH_TOKEN: "offline-test", CLAUDE_BRIDGE_ISOLATED: "1" };
	previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
	Object.assign(process.env, env);
	resetStack();
});
afterEach(() => {
	setSharedSession(null);
	resetStack();
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	execFileSync("trash", [root]);
});
function save(records) {
	const path = getSessionPath(OLD, cwd, claudeDir);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, records.map(JSON.stringify).join("\n") + "\n");
}
const rebuild = priors => syncSharedSession([...priors, user("next")], cwd, TOOL_NAMES, "claude-haiku-4-5", undefined, { customToolNameToPi: PI_TOOL_NAMES });
const read = id => readFileSync(getSessionPath(id, cwd, claudeDir), "utf8").trim().split("\n").map(JSON.parse);
const ownRecord = records => records.find(r => r.message?.content?.some(b => b.id === "toolu_fixture_1"));

for (const navigation of ["fork", "tree"]) {
	for (const edited of [false, true]) {
		it(`${navigation} ${edited ? "imports an edit to normalized arguments despite contradictory originals" : "keeps native normalized records when Pi holds the original wire arguments"}`, async () => {
			const { records } = nativeTranscript(OLD, cwd);
			const call = ownRecord(records);
			call.message.content[0].input = normalized;
			call.wireToolInputs = { toolu_fixture_1: original };
			save(records);
			const priors = piPriors();
			priors[1].content[1].arguments = edited ? normalized : original;
			const shared = { sessionId: OLD, cursor: priors.length, cwd, needsRebuild: true, rebuildReason: navigation === "fork" ? "inherited" : "history-rewritten" };
			if (navigation === "fork") shared.inherited = true;
			setSharedSession(shared);
			const result = await rebuild(priors);
			assert.equal(result.sync.forked, edited ? 1 : 7);
			const copied = ownRecord(read(result.sessionId));
			assert.deepEqual(copied.message.content.find(b => b.type === "tool_use").input, normalized);
			assert.equal(copied.wireToolInputs !== undefined, !edited);
		});
	}
}

it("uses the transcript input contract when original metadata is absent", async () => {
	const { records } = nativeTranscript(OLD, cwd);
	save(records);
	setSharedSession({ sessionId: OLD, cursor: 9, cwd, needsRebuild: true, rebuildReason: "history-rewritten" });
	assert.equal((await rebuild(piPriors())).sync.forked, 7);
});

it("rejects malformed original metadata at the transcript boundary", async () => {
	const { records } = nativeTranscript(OLD, cwd);
	ownRecord(records).wireToolInputs = { toolu_fixture_1: [original] };
	save(records);
	setSharedSession({ sessionId: OLD, cursor: 9, cwd, needsRebuild: true, rebuildReason: "history-rewritten" });
	assert.equal((await rebuild(piPriors())).sync.forked, undefined);
});

for (const [index, prompt] of prompts.entries()) {
	it(`keeps exact continuation prompt ${index + 1} only before a verified next group`, async () => {
		const { records } = nativeTranscript(OLD, cwd);
		const at = records.findIndex(r => r.message?.id === "msg_fixture_a2");
		const continuation = { ...records[0], type: "user", uuid: "continuation", parentUuid: records[at].parentUuid, message: { role: "user", content: [{ type: "text", text: prompt }] } };
		records[at].parentUuid = continuation.uuid;
		records.splice(at, 0, continuation);
		save(records);
		setSharedSession({ sessionId: OLD, cursor: 9, cwd, needsRebuild: true, rebuildReason: "history-rewritten" });
		const result = await rebuild(piPriors());
		assert.equal(result.sync.forked, 7);
		assert.ok(read(result.sessionId).some(r => r.message?.content?.some(b => b.text === prompt)));
	});
}

for (const content of [
	[{ type: "text", text: prompts[0] + " Changed." }],
	[{ type: "text", text: prompts[0] }, { type: "text", text: "user text" }],
]) {
	it("does not ignore changed or mixed continuation text", async () => {
		const { records } = nativeTranscript(OLD, cwd);
		const at = records.findIndex(r => r.message?.id === "msg_fixture_a2");
		const continuation = { type: "user", uuid: "continuation", parentUuid: records[at].parentUuid, sessionId: OLD, message: { role: "user", content } };
		records[at].parentUuid = continuation.uuid;
		records.splice(at, 0, continuation);
		save(records);
		setSharedSession({ sessionId: OLD, cursor: 9, cwd, needsRebuild: true, rebuildReason: "history-rewritten" });
		const result = await rebuild(piPriors());
		assert.equal(result.sync.forked, 5);
		assert.ok(!read(result.sessionId).some(r => r.uuid === continuation.uuid));
	});
}
