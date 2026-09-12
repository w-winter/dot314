/**
 * Account-scoped session persistence: the persisted bridge-session marker must
 * carry ONLY the opaque accountProfileId — config-dir paths are
 * account-identifying and travel with shared session archives, so the resolved
 * claudeConfigDir stays in memory and is re-derived through the router's
 * resolveProfile on restore (see PersistedBridgeSessionState in
 * session-persistence.ts).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { createSession } from "cc-session-io";

import { CLAUDE_ACCOUNT_ROUTER_SYMBOL } from "../src/account-router.ts";
import {
	__testGetBridgeIntegrityState,
	__testSetBridgeIntegrityState,
	setExtensionApi,
} from "../src/bridge-state.ts";
import {
	__testCancelAllScheduledSessionPersistence,
	restoreSharedSessionFromPi,
	schedulePersistSharedSession,
} from "../src/session-persistence.ts";

const root = mkdtempSync(join(tmpdir(), "claude-account-persistence-"));
const cwd = join(root, "project");
const profileDir = join(root, "profile-a");

function fingerprint(messages) {
	return createHash("sha256").update(JSON.stringify(messages)).digest("hex");
}

beforeEach(() => {
	mkdirSync(cwd, { recursive: true });
	mkdirSync(profileDir, { recursive: true });
	__testCancelAllScheduledSessionPersistence();
	setExtensionApi(undefined);
	__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
	delete globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL];
});

afterEach(() => {
	__testCancelAllScheduledSessionPersistence();
	setExtensionApi(undefined);
	__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
	delete globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL];
});

after(() => rmSync(root, { recursive: true, force: true }));

describe("account-scoped session persistence", () => {
	it("persists only the opaque profile id, never the identifying config dir", async () => {
		const entries = [];
		setExtensionApi({ appendEntry(type, data) { entries.push({ type, data }); } });
		__testSetBridgeIntegrityState({
			sharedSession: {
				sessionId: "child-session",
				cursor: 1,
				cwd,
				accountProfileId: "profile-a",
				claudeConfigDir: profileDir,
			},
		});
		const messages = [{ role: "user", content: "hello", timestamp: 1 }];
		schedulePersistSharedSession({
			sessionManager: {
				buildSessionContext: () => ({ messages }),
				getSessionId: () => "pi-session",
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 10));

		assert.equal(entries.length, 1);
		assert.equal(entries[0].type, "claude-bridge-session");
		assert.equal(entries[0].data.sessionId, "child-session");
		assert.equal(entries[0].data.accountProfileId, "profile-a");
		assert.equal(entries[0].data.piSessionId, "pi-session");
		assert.equal(entries[0].data.fingerprint, fingerprint(messages));
		// The privacy invariant this file exists for: nothing but the type
		// system otherwise stops the resolved config-dir path from being written.
		assert.equal("claudeConfigDir" in entries[0].data, false);
	});

	it("re-resolves an opaque persisted profile through the account router", () => {
		const messages = [{ role: "user", content: "hello", timestamp: 1 }];
		const child = createSession({ projectPath: cwd, claudeDir: profileDir });
		child.addUserMessage("hello");
		child.save();
		const resolved = [];
		globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL] = {
			version: 1,
			resolveProfile(profileId) {
				resolved.push(profileId);
				return { profileId: "profile-a", configDir: profileDir };
			},
		};
		const marker = {
			type: "custom",
			customType: "claude-bridge-session",
			data: {
				sessionId: child.sessionId,
				cursor: 1,
				cwd,
				accountProfileId: "profile-a",
				fingerprint: fingerprint(messages),
				piSessionId: "pi-session",
				updatedAt: new Date().toISOString(),
			},
		};

		restoreSharedSessionFromPi({
			cwd,
			sessionManager: {
				getEntries: () => [marker],
				getSessionId: () => "pi-session",
				getCwd: () => cwd,
				buildSessionContext: () => ({ messages }),
			},
		});

		assert.deepEqual(resolved, ["profile-a"]);
		assert.deepEqual(__testGetBridgeIntegrityState().sharedSession, {
			sessionId: child.sessionId,
			cursor: 1,
			cwd,
			accountProfileId: "profile-a",
			claudeConfigDir: profileDir,
		});
	});
});
