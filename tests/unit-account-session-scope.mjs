import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { openSession } from "cc-session-io";

import {
	__testGetBridgeIntegrityState,
	__testSetBridgeIntegrityState,
} from "../src/bridge-state.ts";
import { syncSharedSession } from "../src/session-persistence.ts";

const root = mkdtempSync(join(tmpdir(), "claude-account-session-"));
const cwd = join(root, "project");
const accountA = join(root, "account-a");
const accountB = join(root, "account-b");
// The legacy (`{}` scope) path resolves its claude dir from
// process.env.CLAUDE_CONFIG_DIR — left unset, that falls through to the
// developer's REAL ~/.claude. Pin it under the temp root so no test write can
// ever escape.
const legacyDir = join(root, "legacy-claude");
const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
process.env.CLAUDE_CONFIG_DIR = legacyDir;

beforeEach(() => {
	rmSync(cwd, { recursive: true, force: true });
	rmSync(accountA, { recursive: true, force: true });
	rmSync(accountB, { recursive: true, force: true });
	rmSync(legacyDir, { recursive: true, force: true });
	mkdirSync(cwd, { recursive: true });
	process.env.CLAUDE_CONFIG_DIR = legacyDir;
	__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
});
after(() => {
	if (previousClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
	else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
	rmSync(root, { recursive: true, force: true });
});

describe("account-scoped Claude sessions", () => {
	it("never resumes or deletes account A's session while switching to account B", () => {
		const messages = [
			{ role: "user", content: "prior context", timestamp: Date.now() },
			{ role: "user", content: "current prompt", timestamp: Date.now() },
		];
		const first = syncSharedSession(
			messages,
			cwd,
			undefined,
			"claude-opus-5",
			{ accountProfileId: "a", claudeConfigDir: accountA },
		);
		assert.ok(first.sessionId);
		const firstPath = openSession({
			sessionId: first.sessionId,
			projectPath: cwd,
			claudeDir: accountA,
		}).jsonlPath;
		assert.equal(existsSync(firstPath), true);

		const second = syncSharedSession(
			messages,
			cwd,
			undefined,
			"claude-opus-5",
			{ accountProfileId: "b", claudeConfigDir: accountB },
		);
		assert.ok(second.sessionId);
		assert.notEqual(second.sessionId, first.sessionId);
		assert.equal(existsSync(firstPath), true, "switching accounts must not delete A's transcript");
		const state = __testGetBridgeIntegrityState().sharedSession;
		assert.equal(state?.accountProfileId, "b");
		assert.equal(state?.claudeConfigDir, accountB);

		const reused = syncSharedSession(
			messages,
			cwd,
			undefined,
			"claude-opus-5",
			{ accountProfileId: "b", claudeConfigDir: accountB },
		);
		assert.equal(reused.sessionId, second.sessionId);
	});

	it("a legacy session never reuses a managed session record", () => {
		const messages = [
			{ role: "user", content: "prior context", timestamp: Date.now() },
			{ role: "user", content: "current prompt", timestamp: Date.now() },
		];
		const managed = syncSharedSession(
			messages,
			cwd,
			undefined,
			"claude-opus-5",
			{ accountProfileId: "a", claudeConfigDir: accountA },
		);
		assert.ok(managed.sessionId);
		// Router gone next turn: same messages, no scope → must rebuild, not
		// resume account A's transcript.
		const legacy = syncSharedSession(messages, cwd, undefined, "claude-opus-5", {});
		assert.ok(legacy.sessionId);
		assert.notEqual(legacy.sessionId, managed.sessionId);
		const legacyPath = openSession({
			sessionId: legacy.sessionId,
			projectPath: cwd,
			claudeDir: legacyDir,
		}).jsonlPath;
		assert.equal(existsSync(legacyPath), true, "legacy rebuild writes under the pinned test config dir");
		const state = __testGetBridgeIntegrityState().sharedSession;
		assert.equal(state?.accountProfileId, undefined);
	});
});
