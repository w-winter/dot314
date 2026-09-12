import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { loadConfig, recordProjectTrust, resolveSystemPrompt } from "../src/config.ts";
import { buildClaudeQueryOptions } from "../src/query-options.ts";

const originalPiDir = process.env.PI_CODING_AGENT_DIR;
const roots = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	if (originalPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalPiDir;
});

function testRoot() {
	const root = mkdtempSync(join(tmpdir(), "pi-claude-bridge-fork-"));
	roots.push(root);
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
	return root;
}

const model = {
	id: "claude-sonnet-5",
	name: "Claude Sonnet",
	api: "claude-bridge",
	provider: "pi-claude",
	baseUrl: "claude-bridge",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8192,
};

describe("fork prompt behavior", () => {
	it("uses trusted project replacement settings and preserves Pi's context suffix", () => {
		const project = join(testRoot(), "project");
		mkdirSync(join(project, ".pi"), { recursive: true });
		writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "claude-bridge.json"), JSON.stringify({
			systemPrompt: { replacement: "User base", includeModelLine: true },
		}));
		writeFileSync(join(project, ".pi", "settings.json"), "{}");
		writeFileSync(join(project, ".pi", "claude-bridge.json"), JSON.stringify({
			systemPrompt: { replacement: "Project base", preservePiContext: true },
		}));
		recordProjectTrust({ cwd: project, isProjectTrusted: () => true });

		const marker = "- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)";
		const prompt = `Default base\n${marker}\n\n<project_context>\nProject instructions`;

		assert.equal(
			resolveSystemPrompt(prompt, "pi-claude/claude-sonnet-5", loadConfig(project).systemPrompt),
			"Active model: pi-claude/claude-sonnet-5\n\nProject base\n\n<project_context>\nProject instructions",
		);
		assert.equal(
			resolveSystemPrompt(prompt, "pi-claude/claude-sonnet-5", {
				replacement: "Replacement only",
				preservePiContext: false,
			}),
			"Replacement only",
		);
	});

	it("ignores the separate OAuth compatibility extension's prompt settings", () => {
		const cwd = testRoot();
		writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "settings.json"), JSON.stringify({
			anthropicOAuthCompat: {
				systemPrompt: "OAuth-only base",
				includeModelLine: true,
				preserveSuffix: false,
			},
		}));

		const config = loadConfig(cwd);
		assert.deepEqual(config.systemPrompt, {});
		assert.equal(resolveSystemPrompt("Pi prompt", "pi-claude/claude-sonnet-5", config.systemPrompt), "Pi prompt");
	});

	it("forwards the full Pi prompt with explicit setting isolation and strict MCP configuration", () => {
		const cwd = testRoot();
		const built = buildClaudeQueryOptions({
			cwd,
			requestedModel: model,
			queryModel: model,
			bridgeConfig: {},
			systemPrompt: "Complete Pi system prompt",
			resumeSessionId: null,
		});

		assert.equal(built.queryOptions.systemPrompt, "Complete Pi system prompt");
		assert.deepEqual(built.queryOptions.settingSources, []);
		assert.equal(built.queryOptions.strictMcpConfig, true);
	});

	it("rejects a request that omits Pi's system prompt", () => {
		const cwd = testRoot();
		assert.throws(
			() => buildClaudeQueryOptions({
				cwd,
				requestedModel: model,
				queryModel: model,
				bridgeConfig: {},
				resumeSessionId: null,
			}),
			/missing Pi system prompt/,
		);
	});
});
