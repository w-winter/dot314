/**
 * Tests for syncSharedSession's REUSE path (and the disk-free clean start).
 *
 * The caller contract requires the same sessionId (no rebuild), promptStart
 * covering the WHOLE trailing user run by content, and the stored cursor.
 *
 * REUSE and clean start touch no disk or API, so no fixtures are needed; the
 * destructive REBUILD path is covered by the int-session-* integration tests.
 * The foreign-conversation guard tests that exercise REBUILD keep
 * its writes inside a throwaway CLAUDE_CONFIG_DIR (withTempClaudeDir).
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversationFingerprint, syncSharedSession } from "../src/session-persistence.js";
import { getSessionPath, parseJsonlFile } from "cc-session-io";
import { historyDigest } from "../src/history-digest.js";
import { __testGetBridgeIntegrityState, setSharedSession } from "../src/bridge-state.js";
import { findUnpairedToolUses } from "../src/tool-pairing-audit.js";

const user = (text) => ({ role: "user", content: text });
const assistant = () => ({ role: "assistant", content: [] });
const assistantText = (text) => ({ role: "assistant", content: [{ type: "text", text }] });
const CWD = "/repo";

// Runs `fn` with CLAUDE_CONFIG_DIR pointed at a throwaway dir so any REBUILD
// disk activity is both contained and observable (readdirSync).
const withTempClaudeDir = (fn) => {
	const claudeDir = mkdtempSync(join(tmpdir(), "bridge-sync-test-"));
	const previous = process.env.CLAUDE_CONFIG_DIR;
	process.env.CLAUDE_CONFIG_DIR = claudeDir;
	try {
		return fn(claudeDir);
	} finally {
		if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
		else process.env.CLAUDE_CONFIG_DIR = previous;
		rmSync(claudeDir, { recursive: true, force: true });
	}
};

const promptContents = (messages, promptStart) =>
	messages.slice(promptStart).map((message) => message.content);

afterEach(() => setSharedSession(null));

describe("syncSharedSession REUSE path", () => {
	it("keeps the session and prompts BOTH queued follow-ups, by content", () => {
		setSharedSession({ sessionId: "sess-reuse", cursor: 1, cwd: CWD });
		const messages = [user("u1"), assistant(), user("u2"), user("u3")];

		const result = syncSharedSession(messages, CWD);

		assert.equal(result.sessionId, "sess-reuse");
		assert.equal(result.promptStart, 2);
		// Content assertion, not length: promptStart = messages.length - 1 (the
		// old slice(-1) behavior) would still yield ONE user message here.
		assert.deepEqual(promptContents(messages, result.promptStart), ["u2", "u3"]);
		assert.deepEqual(__testGetBridgeIntegrityState().sharedSession, {
			sessionId: "sess-reuse",
			cursor: 2,
			// The history Claude now holds, [0, cursor); a pre-digest record is
			// accepted once and stamped.
			historyDigest: historyDigest(messages.slice(0, 2)),
			cwd: CWD,
			// A REUSE match proves identity, so a pre-fingerprint record adopts
			// the conversation anchor.
			conversationFingerprint: conversationFingerprint(messages),
		});
	});

	it("keeps the single-user reuse case: one new user after the trailing assistant", () => {
		setSharedSession({ sessionId: "sess-single", cursor: 1, cwd: CWD });
		const messages = [user("u1"), assistant(), user("u2")];

		const result = syncSharedSession(messages, CWD);

		assert.equal(result.sessionId, "sess-single");
		assert.equal(result.promptStart, 2);
		assert.deepEqual(promptContents(messages, result.promptStart), ["u2"]);
		assert.equal(__testGetBridgeIntegrityState().sharedSession.cursor, 2);
	});

	it("keeps the trailing-assistant reuse case: cursor already past the assistant", () => {
		setSharedSession({ sessionId: "sess-past", cursor: 2, cwd: CWD });
		const messages = [user("u1"), assistant(), user("u2"), user("u3")];

		const result = syncSharedSession(messages, CWD);

		assert.equal(result.sessionId, "sess-past");
		assert.equal(result.promptStart, 2);
		assert.deepEqual(promptContents(messages, result.promptStart), ["u2", "u3"]);
		assert.equal(__testGetBridgeIntegrityState().sharedSession.cursor, 2);
	});
});

describe("syncSharedSession clean start", () => {
	it("returns no resume id and prompts the sole user message", () => {
		const messages = [user("hello")];

		const result = syncSharedSession(messages, CWD);

		assert.equal(result.sessionId, null);
		assert.equal(result.promptStart, 0);
		assert.deepEqual(promptContents(messages, result.promptStart), ["hello"]);
	});
});

describe("conversationFingerprint", () => {
	it("hashes the FIRST user message's text, string or block form alike", () => {
		const fromString = conversationFingerprint([user("hello")]);
		assert.match(fromString, /^u:[0-9a-f]{12}$/);
		assert.equal(conversationFingerprint([{ role: "user", content: [{ type: "text", text: "hello" }] }]), fromString);
		// An assistant message with no text (tool-only / empty content) adds no
		// second component — same anchor as the bare opener.
		assert.equal(conversationFingerprint([user("hello"), assistant(), user("later turn")]), fromString);
		assert.notEqual(conversationFingerprint([user("other opener")]), fromString);
	});

	it("adds the FIRST assistant message's text as a second component once one exists", () => {
		const grown = conversationFingerprint([user("hello"), assistantText("first answer"), user("later turn")]);
		assert.match(grown, /^u:[0-9a-f]{12}\|a:[0-9a-f]{12}$/);
		// The user component is shared with the turn-1 form; the assistant text
		// is what discriminates two same-opener conversations.
		assert.equal(grown.startsWith(conversationFingerprint([user("hello")])), true);
		assert.equal(conversationFingerprint([user("hello"), assistantText("first answer")]), grown);
		assert.notEqual(conversationFingerprint([user("hello"), assistantText("other answer")]), grown);
	});

	it("returns undefined when identity is unknowable (no user message, image-only opener)", () => {
		assert.equal(conversationFingerprint([]), undefined);
		assert.equal(conversationFingerprint([assistant()]), undefined);
		assert.equal(conversationFingerprint([{ role: "user", content: [{ type: "image", data: "zzz", mimeType: "image/png" }] }]), undefined);
		assert.equal(conversationFingerprint([{ role: "user", content: "   " }]), undefined);
	});
});

describe("syncSharedSession foreign-conversation guard (#1001)", () => {
	const parentFp = conversationFingerprint([user("parent opener")]);

	it("runs a single-message foreign context as a clean one-shot and leaves the record untouched", () => {
		const record = { sessionId: "sess-parent", cursor: 40, cwd: CWD, conversationFingerprint: parentFp };
		setSharedSession({ ...record });
		const messages = [user("subagent task")];

		const result = syncSharedSession(messages, CWD);

		assert.equal(result.sessionId, null);
		assert.equal(result.promptStart, 0);
		assert.equal(result.foreignContext, true);
		assert.deepEqual(__testGetBridgeIntegrityState().sharedSession, record);
	});

	it("never deletes or rewrites the parent's session file for a rebuild-shaped foreign context", () => {
		withTempClaudeDir((claudeDir) => {
			const record = { sessionId: "sess-parent", cursor: 40, cwd: CWD, conversationFingerprint: parentFp };
			setSharedSession({ ...record });
			const messages = [user("subagent task"), assistant(), user("follow-up")];

			const result = syncSharedSession(messages, CWD);

			assert.equal(result.sessionId, null);
			assert.equal(result.promptStart, 2);
			assert.equal(result.foreignContext, true);
			assert.deepEqual(__testGetBridgeIntegrityState().sharedSession, record);
			assert.deepEqual(readdirSync(claudeDir), [], "foreign one-shot must not touch session storage");
		});
	});

	it("preempts a would-be REUSE splice when the foreign tail happens to align with the cursor", () => {
		// priors === cursor with a trailing user is exactly the shape the
		// incremental planner accepts — without the fingerprint check this
		// foreign turn would --resume the parent's session.
		const record = { sessionId: "sess-parent", cursor: 2, cwd: CWD, conversationFingerprint: parentFp };
		setSharedSession({ ...record });
		const messages = [user("subagent task"), assistant(), user("follow-up")];

		const result = syncSharedSession(messages, CWD);

		assert.equal(result.sessionId, null);
		assert.equal(result.foreignContext, true);
		assert.deepEqual(__testGetBridgeIntegrityState().sharedSession, record);
	});

	it("keeps REUSE identical for a matching fingerprint", () => {
		const fp = conversationFingerprint([user("u1")]);
		setSharedSession({ sessionId: "sess-reuse", cursor: 1, cwd: CWD, conversationFingerprint: fp });
		const messages = [user("u1"), assistant(), user("u2"), user("u3")];

		const result = syncSharedSession(messages, CWD);

		assert.equal(result.sessionId, "sess-reuse");
		assert.equal(result.promptStart, 2);
		assert.equal(result.foreignContext, undefined);
		assert.deepEqual(promptContents(messages, result.promptStart), ["u2", "u3"]);
		assert.deepEqual(__testGetBridgeIntegrityState().sharedSession, {
			sessionId: "sess-reuse",
			cursor: 2,
			historyDigest: historyDigest(messages.slice(0, 2)),
			cwd: CWD,
			conversationFingerprint: fp,
		});
	});

	it("keeps REBUILD identical for a matching fingerprint (needsRebuild honored, id preserved)", () => {
		withTempClaudeDir((claudeDir) => {
			const cwd = mkdtempSync(join(tmpdir(), "bridge-sync-cwd-"));
			try {
				const fp = conversationFingerprint([user("u1")]);
				const sessionId = "11111111-1111-4111-8111-111111111111";
				setSharedSession({ sessionId, cursor: 1, cwd, needsRebuild: true, conversationFingerprint: fp });
				const messages = [user("u1"), assistant(), user("u2")];

				const result = syncSharedSession(messages, cwd);

				assert.equal(result.sessionId, sessionId, "in-place rebuild preserves the session id");
				assert.equal(result.promptStart, 2);
				assert.equal(result.foreignContext, undefined);
				const record = __testGetBridgeIntegrityState().sharedSession;
				assert.equal(record.sessionId, sessionId);
				assert.equal(record.cursor, 2);
				assert.equal(record.conversationFingerprint, fp);
				assert.equal(record.needsRebuild, undefined, "a completed rebuild clears the flag");
				assert.ok(readdirSync(claudeDir).length > 0, "rebuild writes the session file");
			} finally {
				rmSync(cwd, { recursive: true, force: true });
			}
		});
	});

	it("lets a needsRebuild context through even when its anchor moved (compact/tree-nav carve-out)", () => {
		withTempClaudeDir(() => {
			const cwd = mkdtempSync(join(tmpdir(), "bridge-sync-cwd-"));
			try {
				const sessionId = "22222222-2222-4222-8222-222222222222";
				setSharedSession({ sessionId, cursor: 40, cwd, needsRebuild: true, conversationFingerprint: parentFp });
				const messages = [user("compacted summary opener"), assistant(), user("next turn")];

				const result = syncSharedSession(messages, cwd);

				assert.equal(result.sessionId, sessionId, "post-compact history must REBUILD, not degrade to a one-shot");
				assert.equal(result.foreignContext, undefined);
				const record = __testGetBridgeIntegrityState().sharedSession;
				assert.equal(record.conversationFingerprint, conversationFingerprint(messages), "rebuild adopts the moved anchor");
			} finally {
				rmSync(cwd, { recursive: true, force: true });
			}
		});
	});

	it("lets the real conversation reclaim a record captured under a foreign fingerprint (length monotonicity)", () => {
		withTempClaudeDir(() => {
			const cwd = mkdtempSync(join(tmpdir(), "bridge-sync-cwd-"));
			try {
				const sessionId = "33333333-3333-4333-8333-333333333333";
				const foreignFp = conversationFingerprint([user("subagent task")]);
				// A foreign rebuild through a legacy record left its fingerprint and a
				// short cursor behind. The parent's LONGER history must not be
				// misread as foreign — that would one-shot every parent turn forever.
				setSharedSession({ sessionId, cursor: 1, cwd, conversationFingerprint: foreignFp });
				const messages = [user("parent opener"), assistant(), user("p2"), assistant(), user("p3")];

				const result = syncSharedSession(messages, cwd);

				assert.equal(result.sessionId, sessionId, "longer mismatching history rebuilds and reclaims the record");
				assert.equal(result.foreignContext, undefined);
				const record = __testGetBridgeIntegrityState().sharedSession;
				assert.equal(record.conversationFingerprint, parentFp);
				assert.equal(record.cursor, 4);
			} finally {
				rmSync(cwd, { recursive: true, force: true });
			}
		});
	});

	it("treats a same-opener context with a DIFFERENT first assistant as foreign", () => {
		// Two unrelated conversations can open with identical text ("continue").
		// With a user-only anchor and an aligned cursor this shape REUSEs across
		// genuinely different histories — the assistant component is the
		// discriminator.
		const record = {
			sessionId: "sess-parent",
			cursor: 2,
			cwd: CWD,
			conversationFingerprint: conversationFingerprint([user("continue"), assistantText("parent first answer")]),
		};
		setSharedSession({ ...record });
		const messages = [user("continue"), assistantText("foreign first answer"), user("do the task")];

		const result = syncSharedSession(messages, CWD);

		assert.equal(result.sessionId, null);
		assert.equal(result.foreignContext, true);
		assert.equal(result.promptStart, 2, "foreign one-shot prompts only the trailing message");
		assert.deepEqual(__testGetBridgeIntegrityState().sharedSession, record);
	});

	it("still REUSEs a same-opener context whose first assistant matches", () => {
		const record = {
			sessionId: "sess-parent",
			cursor: 2,
			cwd: CWD,
			conversationFingerprint: conversationFingerprint([user("continue"), assistantText("parent first answer")]),
		};
		setSharedSession({ ...record });
		const messages = [user("continue"), assistantText("parent first answer"), user("next turn")];

		const result = syncSharedSession(messages, CWD);

		assert.equal(result.sessionId, "sess-parent");
		assert.equal(result.foreignContext, undefined);
	});

	it("matches a turn-1 (user-only) anchor against its grown conversation and upgrades it", () => {
		// A record stamped on turn 1 has no assistant component yet; the same
		// conversation grown past turn 1 is an upgrade, never a mismatch.
		const turn1Fp = conversationFingerprint([user("u1")]);
		setSharedSession({ sessionId: "sess-turn1", cursor: 1, cwd: CWD, conversationFingerprint: turn1Fp });
		const messages = [user("u1"), assistantText("first answer"), user("u2")];

		const result = syncSharedSession(messages, CWD);

		assert.equal(result.sessionId, "sess-turn1", "a fingerprint upgrade is not a mismatch");
		assert.equal(result.foreignContext, undefined);
		const stored = __testGetBridgeIntegrityState().sharedSession.conversationFingerprint;
		assert.equal(stored, conversationFingerprint(messages), "REUSE upgrades the stored anchor to the two-component form");
		assert.notEqual(stored, turn1Fp);
	});

	it("never weakens a two-component anchor back to user-only", () => {
		const fullFp = conversationFingerprint([user("u1"), assistantText("first answer")]);
		setSharedSession({ sessionId: "sess-full", cursor: 1, cwd: CWD, conversationFingerprint: fullFp });
		// Same conversation, but this context slice carries no assistant text —
		// e.g. an empty-content assistant. Anchor must stay two-component.
		const messages = [user("u1"), assistant(), user("u2")];

		const result = syncSharedSession(messages, CWD);

		assert.equal(result.sessionId, "sess-full");
		assert.equal(__testGetBridgeIntegrityState().sharedSession.conversationFingerprint, fullFp);
	});

	it("keeps today's behavior for a pre-fingerprint record, and REUSE adopts the anchor", () => {
		// Single-message foreign context against a legacy record: clean start,
		// record untouched — exactly today's Case 1.
		const legacy = { sessionId: "sess-legacy", cursor: 40, cwd: CWD };
		setSharedSession({ ...legacy });
		const foreignResult = syncSharedSession([user("subagent task")], CWD);
		assert.equal(foreignResult.sessionId, null);
		assert.equal(foreignResult.foreignContext, undefined);
		assert.deepEqual(__testGetBridgeIntegrityState().sharedSession, legacy);

		// The conversation the record demonstrably continues (REUSE match)
		// upgrades it with an identity anchor.
		setSharedSession({ sessionId: "sess-legacy", cursor: 1, cwd: CWD });
		const messages = [user("u1"), assistant(), user("u2")];
		const reuseResult = syncSharedSession(messages, CWD);
		assert.equal(reuseResult.sessionId, "sess-legacy");
		assert.equal(
			__testGetBridgeIntegrityState().sharedSession.conversationFingerprint,
			conversationFingerprint(messages),
		);
	});
});

// The API rejects a request whose latest assistant message carries thinking
// that differs from the original response, so a rebuild cannot import a
// Claude turn with an unsigned thinking block removed. It imports a note of
// what the turn said and did instead.
describe("syncSharedSession REBUILD import of a turn it cannot replay exactly", () => {
	/** The rebuilt session's user and assistant records, as [type, content]. */
	const importedRecords = (sessionId, cwd, claudeDir) => parseJsonlFile(getSessionPath(sessionId, cwd, claudeDir))
		.filter((record) => record.type === "user" || record.type === "assistant")
		.map((record) => [record.type, record.message.content]);
	const shape = (content) => typeof content === "string"
		? content
		: content.map((block) => block.type === "tool_result" ? `tool_result:${block.tool_use_id}` : block.type === "tool_use" ? `tool_use:${block.id}` : block.type);
	const noteText = (content) => typeof content === "string" ? content : content.map((block) => block.text ?? "").join("\n");

	it("keeps the write call and its result in a note, so the next prompt's reuse is legitimate", () => {
		withTempClaudeDir((claudeDir) => {
			const cwd = mkdtempSync(join(tmpdir(), "bridge-sync-cwd-"));
			try {
				const messages = [
					user("create notes.md"),
					{ role: "assistant", provider: "pi-claude", stopReason: "toolUse", content: [
						{ type: "thinking", thinking: "plan", thinkingSignature: "sig1" },
						{ type: "thinking", thinking: "cut off mid-thought" },
						{ type: "toolCall", id: "toolu_w", name: "write", arguments: { path: "notes.md", content: "x" } },
					] },
					{ role: "toolResult", toolCallId: "toolu_w", toolName: "write", content: "Wrote notes.md" },
					user("now add a second line"),
				];

				const first = syncSharedSession(messages, cwd);

				const imported = importedRecords(first.sessionId, cwd, claudeDir);
				assert.deepEqual(imported.map(([type]) => type), ["user", "user"], "no assistant message is left to replay");
				assert.equal(imported[0][1], "create notes.md");
				const note = noteText(imported[1][1]);
				assert.match(note, /could not be replayed as-is/);
				assert.ok(note.includes('write with arguments {"path":"notes.md","content":"x"}'), note);
				assert.ok(note.includes("Wrote notes.md"), note);
				assert.ok(!note.includes("cut off mid-thought"), "thinking is not carried");

				// Claude holds the turn's content, so the digest may vouch for it.
				const record = __testGetBridgeIntegrityState().sharedSession;
				assert.equal(record.historyDigest, historyDigest(messages.slice(0, 3)));
				const second = syncSharedSession([...messages, user("and a third")], cwd);
				assert.equal(second.sessionId, first.sessionId, "the next prompt reuses the rebuilt session");
				assert.equal(second.promptStart, 3);
			} finally {
				rmSync(cwd, { recursive: true, force: true });
			}
		});
	});

	it("leaves the previous turn as the latest assistant, with its thinking untouched and every tool call paired", () => {
		withTempClaudeDir((claudeDir) => {
			const cwd = mkdtempSync(join(tmpdir(), "bridge-sync-cwd-"));
			try {
				const messages = [
					user("start"),
					{ role: "assistant", provider: "pi-claude", stopReason: "toolUse", content: [
						{ type: "thinking", thinking: "step one", thinkingSignature: "sig1" },
						{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a" } },
					] },
					{ role: "toolResult", toolCallId: "t1", toolName: "read", content: "a body" },
					{ role: "assistant", provider: "pi-claude", stopReason: "toolUse", content: [
						{ type: "thinking", thinking: "settled", thinkingSignature: "sig2" },
						{ type: "thinking", thinking: "cut off mid-thought" },
						{ type: "toolCall", id: "t2", name: "read", arguments: { path: "b" } },
					] },
					{ role: "toolResult", toolCallId: "t2", toolName: "read", content: "b body" },
					user("next"),
				];

				const result = syncSharedSession(messages, cwd);

				const imported = importedRecords(result.sessionId, cwd, claudeDir);
				assert.deepEqual(imported.map(([type, content]) => [type, type === "user" && noteText(content).includes("could not be replayed as-is") ? "note" : shape(content)]), [
					["user", "start"],
					["assistant", ["thinking", "tool_use:t1"]],
					["user", ["tool_result:t1"]],
					["user", "note"],
				]);
				const latest = imported.filter(([type]) => type === "assistant").at(-1)[1];
				assert.deepEqual(latest[0], { type: "thinking", thinking: "step one", signature: "sig1" }, "its thinking is exactly as returned");
				assert.deepEqual(findUnpairedToolUses(imported.map(([type, content]) => ({ role: type, content }))), []);
				const note = noteText(imported[3][1]);
				assert.ok(note.includes('read with arguments {"path":"b"}') && note.includes("b body"), note);
			} finally {
				rmSync(cwd, { recursive: true, force: true });
			}
		});
	});
});
