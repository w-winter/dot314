import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { loadConfig, recordProjectTrust } from "../src/config.ts";

function withTempDirs(fn) {
	const root = mkdtempSync(join(tmpdir(), "claude-bridge-config-"));
	const oldPiDir = process.env.PI_CODING_AGENT_DIR;
	try {
		const user = join(root, "user");
		const project = join(root, "project");
		mkdirSync(user, { recursive: true });
		mkdirSync(join(project, ".pi"), { recursive: true });
		process.env.PI_CODING_AGENT_DIR = user;
		return fn({ user, project });
	} finally {
		if (oldPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldPiDir;
		rmSync(root, { recursive: true, force: true });
	}
}

describe("loadConfig", () => {
	it("ignores project config until project trust is recorded", () => withTempDirs(({ user, project }) => {
		writeFileSync(join(user, "claude-bridge.json"), JSON.stringify({ provider: { fastMode: false } }));
		writeFileSync(join(project, ".pi", "claude-bridge.json"), JSON.stringify({ provider: { fastMode: true } }));

		assert.equal(loadConfig(project).provider?.fastMode, false);
	}));

	it("lets trusted project config override user config field by field", () => withTempDirs(({ user, project }) => {
		writeFileSync(join(user, "claude-bridge.json"), JSON.stringify({
			enabled: false,
			systemPrompt: { replacement: "User base", preservePiContext: true },
			provider: { fastMode: false },
		}));
		writeFileSync(join(project, ".pi", "claude-bridge.json"), JSON.stringify({
			enabled: true,
			systemPrompt: { replacement: "Project base", includeModelLine: true },
			provider: { fastMode: true },
		}));
		recordProjectTrust({ cwd: project, isProjectTrusted: () => true });

		assert.deepEqual(loadConfig(project), {
			enabled: true,
			systemPrompt: {
				replacement: "Project base",
				includeModelLine: true,
				preservePiContext: true,
			},
			provider: { fastMode: true },
		});
	}));

	it("normalizes effort overrides", () => withTempDirs(({ user, project }) => {
		writeFileSync(join(user, "claude-bridge.json"), JSON.stringify({
			provider: {
				forceEffort: "MAX",
				modelEffortOverrides: {
					"claude-opus-4-8": "xhigh",
					ignored: "bogus",
				},
			},
		}));

		assert.equal(loadConfig(project).provider?.forceEffort, "max");
		assert.deepEqual(loadConfig(project).provider?.modelEffortOverrides, {
			"claude-opus-4-8": "xhigh",
		});
	}));

	it("ignores connector controls from trusted project config", () => withTempDirs(({ project }) => {
		writeFileSync(join(project, ".pi", "claude-bridge.json"), JSON.stringify({
			provider: {
				fastMode: true,
				enableConnectors: true,
				connectorWriteMode: "allow",
			},
		}));
		recordProjectTrust({ cwd: project, isProjectTrusted: () => true });

		const config = loadConfig(project);
		assert.equal(config.provider?.fastMode, true);
		assert.equal(config.provider?.enableConnectors, undefined);
		assert.equal(config.provider?.connectorWriteMode, undefined);
	}));

	it("honors connector controls from user config", () => withTempDirs(({ user, project }) => {
		writeFileSync(join(user, "claude-bridge.json"), JSON.stringify({
			provider: {
				enableConnectors: true,
				connectorWriteMode: "allow",
			},
		}));

		assert.equal(loadConfig(project).provider?.enableConnectors, true);
		assert.equal(loadConfig(project).provider?.connectorWriteMode, "allow");
	}));

	it("drops malformed provider values", () => withTempDirs(({ user, project }) => {
		writeFileSync(join(user, "claude-bridge.json"), JSON.stringify({
			provider: {
				connectorWriteMode: "read-only",
				forceEffort: "ultracode",
				modelEffortOverrides: "not json",
			},
		}));

		const config = loadConfig(project);
		assert.equal(config.provider?.connectorWriteMode, undefined);
		assert.equal(config.provider?.forceEffort, undefined);
		assert.equal(config.provider?.modelEffortOverrides, undefined);
	}));
});
