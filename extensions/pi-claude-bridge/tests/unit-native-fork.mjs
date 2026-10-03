/**
 * A same-account rebuild starts from Claude Code's own transcript: the prefix
 * of Pi's history that the old transcript holds with equal content is forked
 * as Claude Code wrote it (attachments included), and only Pi's messages
 * after it are imported. Every request Claude Code sends after the rebuild
 * then repeats the bytes of the requests before it, which the prompt cache
 * already holds. Also: what happens while a request waits for that fork.
 */
import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { forkSession, getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { getProjectDir, getSessionPath, parseJsonlFile } from "cc-session-io";

import { __testGetBridgeIntegrityState, __testSetBridgeIntegrityState, __testSetSdkQueryFactory, streamClaudeAgentSdk } from "../src/index.ts";
import { deleteSharedSessionLane, getSharedSession, setSharedSession } from "../src/bridge-state.ts";
import { historyDigest } from "../src/history-digest.ts";
import { __testSetForkSession } from "../src/native-fork.ts";
import { __testForkLaneCount, deleteQueryLane, laneInUse, resetStack } from "../src/query-state.ts";
import { runInRequestLane } from "../src/request-lane.ts";
import { syncSharedSession } from "../src/session-persistence.ts";
import { BASH_TOOL, PI_TOOL_NAMES, READ_TOOL, TOOL_NAMES, mainChain, nativeTranscript, piPriors, rendered, shape, user } from "./fixtures/native-transcript.mjs";

const OLD = "11111111-2222-4333-8444-555555555555";
// Two extension messages Pi held in a row, as the bridge joined them into one prompt.
const NOTICE_1 = "Background task 1 finished: build passed.";
const NOTICE_2 = "Background task 1 exited with code 0.";
const MODEL_ID = "claude-haiku-4-5";
const MODEL = { id: MODEL_ID, api: "claude-bridge", provider: "pi-claude", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };

let root;
let cwd;
let claudeDir;
let previousEnv;

/** Holds every fork until the test releases it. `started()` says whether one
 *  began; the rebuild starts it before its first await. */
function gateForks() {
	let started = false;
	let release;
	const released = new Promise((resolve) => { release = resolve; });
	__testSetForkSession(async (...args) => {
		started = true;
		await released;
		return forkSession(...args);
	});
	return { started: () => started, release: () => release() };
}

/** Writes the fixture as session OLD's transcript under `dir`. */
function writeOldTranscript(dir = claudeDir, options) {
	const transcript = nativeTranscript(OLD, cwd, options);
	const path = getSessionPath(OLD, cwd, dir);
	mkdirSync(dirname(path), { recursive: true });
	const text = transcript.records.map((record) => JSON.stringify(record)).join("\n") + "\n";
	writeFileSync(path, text);
	return { ...transcript, path, text };
}

/** The old transcript's main chain through `uuid`. */
const nativeThrough = (records, uuid) => {
	const chain = mainChain(records);
	return chain.slice(0, chain.findIndex((record) => record.uuid === uuid) + 1);
};

const sessionRecords = (sessionId, dir = claudeDir) => parseJsonlFile(getSessionPath(sessionId, cwd, dir));

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "bridge-native-fork-"));
	cwd = join(root, "project");
	claudeDir = join(root, "claude");
	mkdirSync(cwd, { recursive: true });
	const env = { CLAUDE_CONFIG_DIR: claudeDir, PI_CODING_AGENT_DIR: root, CLAUDE_CODE_OAUTH_TOKEN: "offline-test", CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT: "0" };
	previousEnv = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
	Object.assign(process.env, env);
	resetStack();
});

afterEach(() => {
	__testSetForkSession();
	__testSetSdkQueryFactory();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
	resetStack();
	for (const [key, value] of Object.entries(previousEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(root, { recursive: true, force: true });
});

describe("a same-account rebuild forks Claude Code's transcript", () => {
	it("after an abort, keeps Claude Code's records through the last request and imports only Pi's aborted turn", async () => {
		const old = writeOldTranscript();
		setSharedSession({ sessionId: OLD, cursor: 5, cwd, needsRebuild: true, rebuildReason: "abort", forceRotate: true });
		const priors = piPriors();

		const result = await syncSharedSession([...priors, user("next")], cwd, TOOL_NAMES, MODEL_ID, undefined, { customToolNameToPi: PI_TOOL_NAMES });

		assert.notEqual(result.sessionId, OLD, "a rebuild after an abort takes a new id");
		assert.equal(result.sync.forked, 7, "Pi's two prompts and three completed turns are Claude Code's own");
		const chain = mainChain(sessionRecords(result.sessionId));
		const kept = nativeThrough(old.records, old.coveredEnd);
		assert.deepEqual(chain.slice(0, kept.length).map(rendered), kept.map(rendered), "the prefix is Claude Code's records, attachments included");
		assert.deepEqual(chain.slice(kept.length).map(shape), [
			["assistant", ["thinking", "tool_use:toolu_fixture_3"]],
			["user", ["tool_result:toolu_fixture_3"]],
		], "then Pi's aborted turn, chained from the last attachment");
		assert.deepEqual(chain.at(-1).message.content[0], { type: "tool_result", tool_use_id: "toolu_fixture_3", content: "Command aborted", is_error: true });
		assert.equal(readFileSync(old.path, "utf8"), old.text, "the old transcript is never written: its child may still be");
		const record = getSharedSession();
		assert.equal(record.sessionId, result.sessionId);
		assert.equal(record.cursor, priors.length);
		assert.equal(record.historyDigest, historyDigest(priors));
		assert.equal(record.needsRebuild, undefined);
	});

	it("forks only up to the group before one whose content differs from Pi's", async () => {
		const old = writeOldTranscript();
		setSharedSession({ sessionId: OLD, cursor: 5, cwd, needsRebuild: true, rebuildReason: "abort", forceRotate: true });

		const result = await syncSharedSession([...piPriors({ result1: "uno\n" }), user("next")], cwd, TOOL_NAMES, MODEL_ID, undefined, { customToolNameToPi: PI_TOOL_NAMES });

		assert.equal(result.sync.forked, 1);
		const chain = mainChain(sessionRecords(result.sessionId));
		const kept = nativeThrough(old.records, old.firstPromptEnd);
		assert.deepEqual(chain.slice(0, kept.length).map(rendered), kept.map(rendered), "the first prompt and its attachments");
		assert.deepEqual(chain.slice(kept.length).map(shape), [
			["assistant", ["thinking", "tool_use:toolu_fixture_1"]],
			["user", ["tool_result:toolu_fixture_1"]],
			["assistant", ["tool_use:toolu_fixture_2"]],
			["user", ["tool_result:toolu_fixture_2"]],
			["assistant", ["thinking", "text"]],
			["user", "Run sleep 40."],
			["assistant", ["thinking", "tool_use:toolu_fixture_3"]],
			["user", ["tool_result:toolu_fixture_3"]],
		]);
		assert.equal(chain[kept.length + 1].message.content[0].content, "uno\n", "the differing result is Pi's");
	});

	it("forks past signed thinking whose trailing whitespace Pi's copy lacks, and carries Claude Code's text", async () => {
		const old = writeOldTranscript(claudeDir, { thinkingTail: "\n\n" });
		setSharedSession({ sessionId: OLD, cursor: 5, cwd, needsRebuild: true, rebuildReason: "abort", forceRotate: true });

		const result = await syncSharedSession([...piPriors(), user("next")], cwd, TOOL_NAMES, MODEL_ID, undefined, { customToolNameToPi: PI_TOOL_NAMES });

		assert.equal(result.sync.forked, 7, "each thinking block's signature names the one Pi holds");
		const chain = mainChain(sessionRecords(result.sessionId));
		const kept = nativeThrough(old.records, old.coveredEnd);
		assert.deepEqual(chain.slice(0, kept.length).map(rendered), kept.map(rendered), "the prefix is Claude Code's records, its thinking whitespace included");
	});

	for (const [what, nativeSignature, piSignature] of [["another signature", "sig-a1", "sig-other"], ["no signature", "", ""]]) {
		it(`ends the prefix before thinking that differs from Pi's only in trailing whitespace but has ${what}`, async () => {
			writeOldTranscript(claudeDir, { thinkingTail: "\n\n", signature1: nativeSignature });
			setSharedSession({ sessionId: OLD, cursor: 5, cwd, needsRebuild: true, rebuildReason: "abort", forceRotate: true });

			const result = await syncSharedSession([...piPriors({ signature1: piSignature }), user("next")], cwd, TOOL_NAMES, MODEL_ID, undefined, { customToolNameToPi: PI_TOOL_NAMES });

			assert.equal(result.sync.forked, 1, "only the first prompt is Claude Code's own");
		});
	}

	it("forks past a tool result Claude Code stored as its no-output note for Pi's whitespace-only output", async () => {
		const old = writeOldTranscript(claudeDir, { emptyResult1: "\n" });
		setSharedSession({ sessionId: OLD, cursor: 5, cwd, needsRebuild: true, rebuildReason: "abort", forceRotate: true });

		const result = await syncSharedSession([...piPriors({ result1: "\n" }), user("next")], cwd, TOOL_NAMES, MODEL_ID, undefined, { customToolNameToPi: PI_TOOL_NAMES });

		assert.equal(result.sync.forked, 7, "the note is what Claude Code made of Pi's result");
		const chain = mainChain(sessionRecords(result.sessionId));
		const kept = nativeThrough(old.records, old.coveredEnd);
		assert.deepEqual(chain.slice(0, kept.length).map(rendered), kept.map(rendered), "the prefix carries Claude Code's note");
	});

	it("ends the prefix before Claude Code's no-output note when Pi's result has output", async () => {
		writeOldTranscript(claudeDir, { emptyResult1: "\n" });
		setSharedSession({ sessionId: OLD, cursor: 5, cwd, needsRebuild: true, rebuildReason: "abort", forceRotate: true });

		const result = await syncSharedSession([...piPriors({ result1: "one\n" }), user("next")], cwd, TOOL_NAMES, MODEL_ID, undefined, { customToolNameToPi: PI_TOOL_NAMES });

		assert.equal(result.sync.forked, 1, "only the first prompt is Claude Code's own");
	});

	it("forks past a prompt the bridge joined from two of Pi's messages in a row", async () => {
		const old = writeOldTranscript(claudeDir, { prompt2: `${NOTICE_1}\n\n${NOTICE_2}` });
		setSharedSession({ sessionId: OLD, cursor: 5, cwd, needsRebuild: true, rebuildReason: "abort", forceRotate: true });

		const result = await syncSharedSession([...piPriors({ prompt2: [NOTICE_1, NOTICE_2] }), user("next")], cwd, TOOL_NAMES, MODEL_ID, undefined, { customToolNameToPi: PI_TOOL_NAMES });

		assert.equal(result.sync.forked, 8, "Claude Code's one prompt record covers both of Pi's messages");
		const chain = mainChain(sessionRecords(result.sessionId));
		const kept = nativeThrough(old.records, old.coveredEnd);
		assert.deepEqual(chain.slice(0, kept.length).map(rendered), kept.map(rendered), "the prefix carries Claude Code's joined prompt");
		assert.deepEqual(chain.slice(kept.length).map(shape), [
			["assistant", ["thinking", "tool_use:toolu_fixture_3"]],
			["user", ["tool_result:toolu_fixture_3"]],
		], "then only Pi's aborted turn");
	});

	for (const [what, priors] of [
		["in another order", piPriors({ prompt2: [NOTICE_2, NOTICE_1] })],
		["without one of them", piPriors({ prompt2: [NOTICE_1] })],
		["followed by another of Pi's messages", piPriors({ prompt2: [NOTICE_1, NOTICE_2, "A third notice."] })],
		["last, so the run goes on into the prompt", piPriors({ prompt2: [NOTICE_1, NOTICE_2] }).slice(0, -2)],
	]) {
		it(`ends the prefix before a joined prompt when Pi holds its messages ${what}`, async () => {
			writeOldTranscript(claudeDir, { prompt2: `${NOTICE_1}\n\n${NOTICE_2}` });
			setSharedSession({ sessionId: OLD, cursor: 5, cwd, needsRebuild: true, rebuildReason: "abort", forceRotate: true });

			const result = await syncSharedSession([...priors, user("next")], cwd, TOOL_NAMES, MODEL_ID, undefined, { customToolNameToPi: PI_TOOL_NAMES });

			assert.equal(result.sync.forked, 6, "the first prompt and its three turns are Claude Code's own");
		});
	}

	it("forks past a parallel batch, the results Claude Code wrote off the main chain included", async () => {
		const old = writeOldTranscript(claudeDir, { parallel: true });
		setSharedSession({ sessionId: OLD, cursor: 5, cwd, needsRebuild: true, rebuildReason: "abort", forceRotate: true });

		const result = await syncSharedSession([...piPriors({ parallel: true }), user("next")], cwd, TOOL_NAMES, MODEL_ID, undefined, { customToolNameToPi: PI_TOOL_NAMES });

		assert.equal(result.sync.forked, 10, "the batch and everything through the second prompt are Claude Code's own");
		const records = sessionRecords(result.sessionId);
		const kept = nativeThrough(old.records, old.coveredEnd);
		assert.deepEqual(mainChain(records).slice(0, kept.length).map(rendered), kept.map(rendered));
		const offChain = old.records.find((record) => record.message?.content?.[0]?.tool_use_id === "toolu_fixture_4");
		const carried = records.find((record) => record.forkedFrom?.messageUuid === offChain.uuid);
		assert.deepEqual(rendered(carried), rendered(offChain), "the off-chain result is carried as Claude Code wrote it");
		// What Claude Code's loader makes of the fork: both results follow the calls.
		const store = { load: async (key) => key.sessionId === result.sessionId && key.subpath === undefined ? records : null, append: async () => {} };
		const ids = (await getSessionMessages(result.sessionId, { dir: cwd, sessionStore: store }))
			.flatMap((entry) => Array.isArray(entry.message?.content) ? entry.message.content : [])
			.flatMap((block) => block.type === "tool_use" ? [`call ${block.id}`] : block.type === "tool_result" ? [`result ${block.tool_use_id}`] : []);
		assert.deepEqual(ids.slice(4, 8), ["call toolu_fixture_4", "call toolu_fixture_5", "result toolu_fixture_4", "result toolu_fixture_5"]);
	});

	it("forks only up to the group before a parallel batch whose off-chain result differs from Pi's", async () => {
		const old = writeOldTranscript(claudeDir, { parallel: true });
		setSharedSession({ sessionId: OLD, cursor: 5, cwd, needsRebuild: true, rebuildReason: "abort", forceRotate: true });

		const result = await syncSharedSession([...piPriors({ parallel: true, result4: "deux\n" }), user("next")], cwd, TOOL_NAMES, MODEL_ID, undefined, { customToolNameToPi: PI_TOOL_NAMES });

		assert.equal(result.sync.forked, 5, "the prefix ends after the failed read, before the batch");
		const records = sessionRecords(result.sessionId);
		assert.ok(!JSON.stringify(records).includes('"two\\n"'), "Claude Code's differing result is not carried");
		const chain = mainChain(records);
		const batch = chain.findIndex((record) => record.message?.content?.some?.((block) => block.id === "toolu_fixture_4"));
		assert.equal(chain[batch].forkedFrom, undefined, "the batch is Pi's");
		assert.ok(chain[batch - 1].forkedFrom, "the record before it is Claude Code's own");
		assert.deepEqual(chain.slice(batch, batch + 3).map(shape), [
			["assistant", ["thinking", "tool_use:toolu_fixture_4", "tool_use:toolu_fixture_5"]],
			["user", ["tool_result:toolu_fixture_4", "tool_result:toolu_fixture_5"]],
			["assistant", ["thinking", "text"]],
		]);
	});

	it("ends the prefix before a parallel batch whose off-chain result only its call's id ties to the turn", async () => {
		// Claude Code's own loader adds such a result only behind a feature
		// flag, so whether the fork's conversation holds it is not known.
		writeOldTranscript(claudeDir, { parallel: true, tiedResult: true });
		setSharedSession({ sessionId: OLD, cursor: 5, cwd, needsRebuild: true, rebuildReason: "abort", forceRotate: true });

		const result = await syncSharedSession([...piPriors({ parallel: true }), user("next")], cwd, TOOL_NAMES, MODEL_ID, undefined, { customToolNameToPi: PI_TOOL_NAMES });

		assert.equal(result.sync.forked, 5, "the prefix ends after the failed read, before the batch");
		const records = sessionRecords(result.sessionId);
		assert.ok(!records.some((record) => record.forkedFrom && record.message?.content?.[0]?.tool_use_id === "toolu_fixture_4"), "Claude Code's off-chain result is not carried");
	});

	for (const under of ["call", "result"]) {
		it(`ends the prefix before a turn whose steer Claude Code wrote off the main chain, beneath its ${under === "call" ? "last call" : "off-chain result"}`, async () => {
			// Claude Code's loader adds that queued_command back and renders it as
			// the user message; Pi holds the steer as a user message after the
			// turn's results, which the import writes.
			const steer = "steer sent while both calls ran";
			writeOldTranscript(claudeDir, { parallel: true, steer: { text: steer, under } });
			setSharedSession({ sessionId: OLD, cursor: 5, cwd, needsRebuild: true, rebuildReason: "abort", forceRotate: true });

			const result = await syncSharedSession([...piPriors({ parallel: true, steer }), user("next")], cwd, TOOL_NAMES, MODEL_ID, undefined, { customToolNameToPi: PI_TOOL_NAMES });

			assert.equal(result.sync.forked, 5, "the prefix ends after the failed read, before the batch");
			const records = sessionRecords(result.sessionId);
			assert.equal(records.filter((record) => record.forkedFrom && JSON.stringify(record).includes(steer)).length, 0, "no forked record carries the steer");
			const withSteer = records.filter((record) => JSON.stringify(record).includes(steer));
			assert.equal(withSteer.length, 1, "the steer is in the file once");
			assert.equal(withSteer[0].type, "user", "as Pi's imported user message");
			assert.equal(withSteer[0].forkedFrom, undefined);
			const chain = mainChain(records);
			const batch = chain.findIndex((record) => record.message?.content?.some?.((block) => block.id === "toolu_fixture_4"));
			assert.equal(chain[batch].forkedFrom, undefined, "the batch is Pi's");
			assert.ok(chain[batch - 1].forkedFrom, "the record before it is Claude Code's own");
		});
	}

	it("leaves a reply with cut-off thinking to the import's note once /tree makes it the latest", async () => {
		const claude = (content) => ({ role: "assistant", provider: "pi-claude", api: "anthropic", model: MODEL_ID, stopReason: "stop", content, timestamp: 0 });
		const cutOff = claude([{ type: "thinking", thinking: "Partial", thinkingSignature: "" }, { type: "text", text: "First answer." }]);
		// A rebuild imports the reply without its cut-off thinking while a later reply follows it.
		const imported = await syncSharedSession([user("one"), cutOff, user("two"), claude([{ type: "text", text: "Second answer." }]), user("three")], cwd, TOOL_NAMES, MODEL_ID, undefined, { customToolNameToPi: PI_TOOL_NAMES });
		assert.deepEqual(mainChain(sessionRecords(imported.sessionId)).map(shape).slice(0, 2), [["user", "one"], ["assistant", ["text"]]]);
		// /tree back to that reply: it is now the latest one Pi holds.
		setSharedSession({ sessionId: imported.sessionId, cursor: 4, cwd, needsRebuild: true, rebuildReason: "history-rewritten" });

		const result = await syncSharedSession([user("one"), cutOff, user("next")], cwd, TOOL_NAMES, MODEL_ID, undefined, { customToolNameToPi: PI_TOOL_NAMES });

		assert.equal(result.sync.forked, 1, "only the prompt before the reply is copied");
		const chain = mainChain(sessionRecords(result.sessionId));
		assert.equal(chain.some((record) => record.type === "assistant"), false, "the cut-off reply is not replayed");
		assert.match(JSON.stringify(chain.at(-1).message.content), /could not be replayed as-is/);
	});

	it("imports all of Pi's history when the transcript shares no prefix with it or is gone", async () => {
		const fullImport = (records) => {
			assert.ok(records.every((record) => (record.type === "user" || record.type === "assistant") && record.forkedFrom === undefined), "nothing of Claude Code's transcript is kept");
			assert.deepEqual(records.map(shape).map(([type]) => type), ["user", "assistant", "user", "assistant", "user", "assistant", "user", "assistant", "user"]);
		};
		writeOldTranscript();
		setSharedSession({ sessionId: OLD, cursor: 5, cwd, needsRebuild: true, rebuildReason: "abort", forceRotate: true });
		const unrelated = await syncSharedSession([...piPriors({ prompt1: "Run echo two." }), user("next")], cwd, TOOL_NAMES, MODEL_ID, undefined, { customToolNameToPi: PI_TOOL_NAMES });
		fullImport(sessionRecords(unrelated.sessionId));
		assert.equal(unrelated.sync.forked, undefined);

		setSharedSession({ sessionId: "99999999-2222-4333-8444-555555555555", cursor: 5, cwd, needsRebuild: true, rebuildReason: "abort", forceRotate: true });
		const missing = await syncSharedSession([...piPriors(), user("next")], cwd, TOOL_NAMES, MODEL_ID, undefined, { customToolNameToPi: PI_TOOL_NAMES });
		fullImport(sessionRecords(missing.sessionId));
	});

	it("without an abort, replaces the old transcript with the fork and deletes it only once the fork is written", async () => {
		const old = writeOldTranscript();
		setSharedSession({ sessionId: OLD, cursor: 3, cwd, needsRebuild: true, rebuildReason: "history-rewritten" });
		const forks = gateForks();

		const pending = syncSharedSession([...piPriors(), user("next")], cwd, TOOL_NAMES, MODEL_ID, undefined, { customToolNameToPi: PI_TOOL_NAMES });
		assert.equal(forks.started(), true, "the rebuild forks the old transcript");
		assert.equal(readFileSync(old.path, "utf8"), old.text, "the old transcript is intact while the fork runs");
		assert.deepEqual(readdirSync(getProjectDir(cwd, claudeDir)), [`${OLD}.jsonl`]);
		forks.release();
		const result = await pending;

		assert.notEqual(result.sessionId, OLD, "a fork has its own id");
		assert.equal(existsSync(old.path), false, "the old transcript is gone");
		assert.deepEqual(readdirSync(getProjectDir(cwd, claudeDir)), [`${result.sessionId}.jsonl`]);
		const kept = nativeThrough(old.records, old.coveredEnd);
		assert.deepEqual(mainChain(sessionRecords(result.sessionId)).slice(0, kept.length).map(rendered), kept.map(rendered));
	});

	it("reads and writes a managed account's config dir, never the process env's", async () => {
		const accountDir = join(root, "account-a");
		const old = writeOldTranscript(accountDir);
		const scope = { accountProfileId: "a", claudeConfigDir: accountDir };
		setSharedSession({ sessionId: OLD, cursor: 5, cwd, needsRebuild: true, rebuildReason: "abort", forceRotate: true, ...scope });

		const result = await syncSharedSession([...piPriors(), user("next")], cwd, TOOL_NAMES, MODEL_ID, scope, { customToolNameToPi: PI_TOOL_NAMES });

		assert.equal(result.sync.forked, 7);
		const kept = nativeThrough(old.records, old.coveredEnd);
		assert.deepEqual(mainChain(sessionRecords(result.sessionId, accountDir)).slice(0, kept.length).map(rendered), kept.map(rendered));
		assert.equal(existsSync(claudeDir), false, "nothing is read from or written under CLAUDE_CONFIG_DIR");
		assert.equal(getSharedSession().claudeConfigDir, accountDir);
	});

	it("imports all of Pi's history when the fork fails", async () => {
		writeOldTranscript();
		setSharedSession({ sessionId: OLD, cursor: 5, cwd, needsRebuild: true, rebuildReason: "abort", forceRotate: true });
		__testSetForkSession(async () => { throw new Error("fork refused"); });

		const result = await syncSharedSession([...piPriors(), user("next")], cwd, TOOL_NAMES, MODEL_ID, undefined, { customToolNameToPi: PI_TOOL_NAMES });

		assert.equal(result.sync.forked, undefined);
		const records = sessionRecords(result.sessionId);
		assert.ok(records.every((record) => record.forkedFrom === undefined && record.type !== "attachment"));
		assert.equal(records.length, 9);
		assert.equal(getSharedSession().sessionId, result.sessionId);
	});

	it("ends the prefix before a record off the main chain that Claude Code would stitch into the conversation", async () => {
		// A text chunk of the first assistant message, written as a sibling
		// record: Claude Code's loader adds it back to that message, and Pi's
		// copy of the message has no such text.
		const old = writeOldTranscript(claudeDir, { offChainText: "text Pi no longer has" });
		setSharedSession({ sessionId: OLD, cursor: 5, cwd, needsRebuild: true, rebuildReason: "abort", forceRotate: true });

		const result = await syncSharedSession([...piPriors(), user("next")], cwd, TOOL_NAMES, MODEL_ID, undefined, { customToolNameToPi: PI_TOOL_NAMES });

		assert.equal(result.sync.forked, 1, "only the first prompt, which ends before the off-chain record");
		const records = sessionRecords(result.sessionId);
		assert.ok(!JSON.stringify(records).includes("text Pi no longer has"), "the unverified chunk is not carried");
		const kept = nativeThrough(old.records, old.firstPromptEnd);
		assert.deepEqual(mainChain(records).slice(0, kept.length).map(rendered), kept.map(rendered));
	});

	it("removes the new session file when writing it fails, and leaves the record and the old file as they were", async () => {
		const old = writeOldTranscript();
		const record = { sessionId: OLD, cursor: 5, cwd, needsRebuild: true, rebuildReason: "abort", forceRotate: true };
		setSharedSession(record);
		// The disk fills up partway through the new transcript.
		const original = { openSync: fs.openSync, writeFileSync: fs.writeFileSync };
		const newFiles = new Set();
		fs.openSync = function (path, flags, ...rest) {
			const fd = original.openSync.call(this, path, flags, ...rest);
			if (flags === "wx" && String(path).endsWith(".jsonl")) newFiles.add(fd);
			return fd;
		};
		fs.writeFileSync = function (target, data, options) {
			const created = typeof target === "number" ? newFiles.has(target) : String(target).endsWith(".jsonl") && options?.flag === "wx";
			if (!created) return original.writeFileSync.call(this, target, data, options);
			original.writeFileSync.call(this, target, String(data).slice(0, 73), typeof target === "number" ? undefined : { flag: "wx" });
			throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
		};
		syncBuiltinESMExports();
		try {
			await assert.rejects(
				Promise.resolve(syncSharedSession([...piPriors(), user("next")], cwd, TOOL_NAMES, MODEL_ID, undefined, { customToolNameToPi: PI_TOOL_NAMES })),
				{ code: "ENOSPC" },
			);
		} finally {
			Object.assign(fs, original);
			syncBuiltinESMExports();
		}

		assert.deepEqual(readdirSync(getProjectDir(cwd, claudeDir)), [`${OLD}.jsonl`], "no partial transcript is left");
		assert.equal(readFileSync(old.path, "utf8"), old.text);
		assert.deepEqual(getSharedSession(), record);
	});

	it("never removes a file that already has the fork's id", async () => {
		writeOldTranscript();
		setSharedSession({ sessionId: OLD, cursor: 5, cwd, needsRebuild: true, rebuildReason: "abort", forceRotate: true });
		let existing;
		__testSetForkSession(async (...args) => {
			const forked = await forkSession(...args);
			existing = getSessionPath(forked.sessionId, cwd, claudeDir);
			writeFileSync(existing, "not ours\n");
			return forked;
		});

		await assert.rejects(
			Promise.resolve(syncSharedSession([...piPriors(), user("next")], cwd, TOOL_NAMES, MODEL_ID, undefined, { customToolNameToPi: PI_TOOL_NAMES })),
			{ code: "EEXIST" },
		);

		assert.equal(readFileSync(existing, "utf8"), "not ours\n");
	});
});

describe("a request waiting for its forked rebuild", () => {
	const system = { role: "system", content: "Pi instructions", toolsAdded: [BASH_TOOL, READ_TOOL], timestamp: 0 };
	const collect = async (stream) => { const events = []; for await (const event of stream) events.push(event); return events; };
	const answeringQuery = (session) => ({
		async *[Symbol.asyncIterator]() {
			yield { type: "system", subtype: "init", session_id: session };
			yield { type: "result", subtype: "success", result: "ok" };
		},
		close() {},
		async interrupt() {},
	});
	let calls;
	beforeEach(() => {
		calls = [];
		__testSetSdkQueryFactory(({ prompt, options }) => {
			calls.push({ prompt, options });
			return answeringQuery(options.resume);
		});
	});

	it("starts its query on the forked session once the fork settles, its lane in use meanwhile", async () => {
		writeOldTranscript();
		__testSetBridgeIntegrityState({ sharedSession: { sessionId: OLD, cursor: 6, cwd, needsRebuild: true, rebuildReason: "abort", forceRotate: true }, ui: { notify() {} } });
		const forks = gateForks();

		const stream = streamClaudeAgentSdk(MODEL, { messages: [system, ...piPriors(), user("next")] }, { cwd });
		assert.equal(forks.started(), true, "the rebuild forks the old transcript");
		assert.equal(laneInUse(undefined), true, "the lane is in use while the fork runs");
		assert.equal(calls.length, 0);
		forks.release();
		const events = await collect(stream);

		assert.equal(events.at(-1).type, "done");
		assert.equal(calls.length, 1);
		const forkedId = calls[0].options.resume;
		assert.notEqual(forkedId, OLD);
		assert.ok(sessionRecords(forkedId).some((record) => record.type === "attachment"), "it resumes the forked transcript");
	});

	it("cancelled meanwhile, starts no query, writes nothing, and marks the record as an abort does", async () => {
		const old = writeOldTranscript();
		__testSetBridgeIntegrityState({ sharedSession: { sessionId: OLD, cursor: 4, cwd, needsRebuild: true, rebuildReason: "history-rewritten" }, ui: { notify() {} } });
		const forks = gateForks();
		const abort = new AbortController();

		const stream = streamClaudeAgentSdk(MODEL, { messages: [system, ...piPriors(), user("next")] }, { cwd, signal: abort.signal });
		assert.equal(forks.started(), true, "the rebuild forks the old transcript");
		abort.abort();
		forks.release();
		const events = await collect(stream);

		assert.equal(events.at(-1).type, "error");
		assert.equal(events.at(-1).reason, "aborted");
		assert.equal(calls.length, 0, "no query starts");
		assert.equal(laneInUse(undefined), false);
		assert.deepEqual(readdirSync(getProjectDir(cwd, claudeDir)), [`${OLD}.jsonl`]);
		assert.equal(readFileSync(old.path, "utf8"), old.text);
		const record = __testGetBridgeIntegrityState().sharedSession;
		assert.equal(record.sessionId, OLD);
		assert.equal(record.needsRebuild, true);
		assert.equal(record.forceRotate, true, "the next rebuild rotates, as after an abort");
	});

	it("whose record changed meanwhile, drops the fork and syncs again against the new record", async () => {
		writeOldTranscript();
		__testSetBridgeIntegrityState({ sharedSession: { sessionId: OLD, cursor: 4, cwd, needsRebuild: true, rebuildReason: "history-rewritten" }, ui: { notify() {} } });
		const forks = gateForks();

		const stream = streamClaudeAgentSdk(MODEL, { messages: [system, ...piPriors(), user("next")] }, { cwd });
		assert.equal(forks.started(), true, "the rebuild forks the old transcript");
		// A late mark replaces the record while the SDK runs.
		setSharedSession({ ...getSharedSession(), rebuildReason: "steering-failed" });
		forks.release();
		const events = await collect(stream);

		assert.equal(events.at(-1).type, "done");
		assert.equal(calls.length, 1);
		assert.equal(calls[0].options.resume, OLD, "the new plan imports in place, as a rebuild without a fork does");
		assert.deepEqual(readdirSync(getProjectDir(cwd, claudeDir)), [`${OLD}.jsonl`], "the dropped fork left no file");
		assert.ok(sessionRecords(OLD).every((record) => record.forkedFrom === undefined && record.type !== "attachment"));
	});

	it("whose lane a session shutdown ends after the fork was written, starts no query and ends the request", async () => {
		const old = writeOldTranscript();
		__testSetBridgeIntegrityState({ sharedSession: { sessionId: OLD, cursor: 6, cwd, needsRebuild: true, rebuildReason: "abort", forceRotate: true }, ui: { notify() {} } });
		// The shutdown lands once the forked session is on disk: after the
		// sync's own cancellation check, before the request's continuation.
		let shutDown;
		const shutdown = new Promise((resolve) => { shutDown = resolve; });
		__testSetForkSession(async (...args) => {
			const forked = await forkSession(...args);
			const path = getSessionPath(forked.sessionId, cwd, claudeDir);
			const poll = (tries) => {
				if (!existsSync(path) && tries > 0) return queueMicrotask(() => poll(tries - 1));
				// What session_shutdown does to the lane (index.ts).
				deleteSharedSessionLane(undefined);
				deleteQueryLane(undefined);
				shutDown(existsSync(path));
			};
			queueMicrotask(() => poll(1000));
			return forked;
		});

		const stream = streamClaudeAgentSdk(MODEL, { messages: [system, ...piPriors(), user("next")] }, { cwd });
		assert.equal(await shutdown, true, "the shutdown came after the fork was written");
		assert.equal(calls.length, 0, "no query starts in the ended lane");
		const events = await collect(stream);

		assert.equal(events.at(-1).type, "error", "the request ends");
		assert.equal(laneInUse(undefined), false);
		assert.equal(__testGetBridgeIntegrityState().sharedSession, null, "the ended lane gets no record back");
		assert.equal(readFileSync(old.path, "utf8"), old.text, "the old transcript is untouched");
	});

	it("routes another fresh request on the same lane to a lane of its own while the fork runs", async () => {
		const lane = "shared-key";
		writeOldTranscript();
		runInRequestLane(lane, () => setSharedSession({ sessionId: OLD, cursor: 6, cwd, needsRebuild: true, rebuildReason: "abort", forceRotate: true }));
		const forks = gateForks();
		try {
			const first = streamClaudeAgentSdk(MODEL, { messages: [system, ...piPriors(), user("next")] }, { cwd, sessionId: lane });
			assert.equal(forks.started(), true, "the rebuild forks the old transcript");

			const second = streamClaudeAgentSdk(MODEL, { messages: [system, user("unrelated second request")] }, { cwd, sessionId: lane });
			assert.equal(__testForkLaneCount(), 1, "the second request runs in a fork lane");
			assert.equal((await collect(second)).at(-1).type, "done");
			forks.release();
			const events = await collect(first);

			assert.equal(events.at(-1).type, "done");
			assert.deepEqual(calls.map((call) => call.prompt), ["unrelated second request", "next"]);
			assert.notEqual(calls[1].options.resume, OLD);
			assert.equal(runInRequestLane(lane, () => getSharedSession()).sessionId, calls[1].options.resume, "the lane's record is the first request's fork");
		} finally {
			deleteQueryLane(lane);
			deleteSharedSessionLane(lane);
		}
	});
});
