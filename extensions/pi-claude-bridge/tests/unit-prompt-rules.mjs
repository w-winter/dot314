// Under a configured systemPrompt.replacement, Claude receives the replacement,
// then every section Pi rendered except its preamble, <tools> and <docs>, in
// Pi's order: its <rules> exactly as rendered (Pi's rules, the selected tools'
// guidelines, every extension's promptGuidelines) and everything else. Pi's
// preamble, <tools> and <docs> are dropped whole, wherever they sit. The
// prompt comes from Pi's own builder and is captured at a fake SDK.
import "./lib/debug-env.mjs";

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

// Not in the package's exports map: Pi's session prompt builder and section diff.
import { buildSystemPromptSections, diffSystemPromptSections } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";

import { __testSetBridgeIntegrityState, __testSetSdkQueryFactory, streamClaudeAgentSdk } from "../src/index.ts";
import { setExtensionApi } from "../src/bridge-state.ts";
import { resetStack } from "../src/query-state.ts";

const model = {
	id: "claude-haiku-4-5",
	name: "Claude Haiku",
	api: "claude-bridge",
	provider: "pi-claude",
	baseUrl: "claude-bridge",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8192,
};

// The owner's configuration.
const REPLACEMENT = "You are Claude Code, Anthropic's official CLI for Claude.\nYou are an interactive CLI tool that helps users with software engineering tasks. Use the instructions below and the tools available to you to assist the user.";
const TOOL_GUIDELINE = "Read a file before editing it";
const EXTENSION_GUIDELINE = "Use the todo tool to track multi-step work";
const ENV_KEYS = ["PI_CODING_AGENT_DIR", "CLAUDE_BRIDGE_ISOLATED", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT"];

let root;
before(() => {
	root = mkdtempSync(join(tmpdir(), "bridge-prompt-rules-"));
	process.env.PI_CODING_AGENT_DIR = root;
	process.env.CLAUDE_BRIDGE_ISOLATED = "1";
	process.env.CLAUDE_CONFIG_DIR = root;
	process.env.CLAUDE_CODE_OAUTH_TOKEN = "offline-test";
	process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT = "0";
	writeFileSync(join(root, "claude-bridge.json"), JSON.stringify({ systemPrompt: { replacement: REPLACEMENT, preservePiContext: true } }));
	setExtensionApi({ events: { emit: () => {} }, appendEntry: () => {} });
});
after(() => {
	__testSetSdkQueryFactory();
	setExtensionApi(undefined);
	resetStack();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
	for (const key of ENV_KEYS) delete process.env[key];
	rmSync(root, { recursive: true, force: true });
});

const streamEvent = (event) => ({ type: "stream_event", event });

// Streams Pi's main request through the bridge and returns the system prompt
// the SDK query received.
async function capturedSystemPrompt(messages) {
	const captured = [];
	__testSetSdkQueryFactory(({ options }) => {
		captured.push(options.systemPrompt.prompt);
		return {
			async *[Symbol.asyncIterator]() {
				yield { type: "system", subtype: "init", session_id: "fake-prompt-rules" };
				yield streamEvent({ type: "message_start", message: { id: "m1", model: model.id, usage: { input_tokens: 1 } } });
				yield streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
				yield streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } });
				yield streamEvent({ type: "content_block_stop", index: 0 });
				yield streamEvent({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } });
				yield streamEvent({ type: "message_stop" });
				yield { type: "result", subtype: "success", result: "ok" };
			},
			close() {},
			async interrupt() {},
		};
	});
	__testSetBridgeIntegrityState({ sharedSession: null, ui: { notify: () => {} } });
	resetStack();
	for await (const _event of streamClaudeAgentSdk(model, { messages }, { cwd: "/tmp/project" })) { /* drain */ }
	assert.equal(captured.length, 1);
	return captured[0];
}

describe("systemPrompt replacement keeps Pi's rules", () => {
	it("sends the replacement, Pi's rules with tool and extension guidelines, and what follows <docs>", { timeout: 10_000 }, async () => {
		const sections = buildSystemPromptSections({
			cwd: "/tmp/project",
			selectedTools: ["read", "bash", "edit", "write"],
			toolSnippets: { read: "Read file contents", bash: "Execute bash commands" },
			toolGuidelines: { read: [TOOL_GUIDELINE] },
			promptGuidelines: [EXTENSION_GUIDELINE],
			appendSystemPrompt: "Appended from APPEND_SYSTEM.md.",
			contextFiles: [{ path: "/tmp/project/AGENTS.md", content: "Use tabs." }],
		});
		const prompt = await capturedSystemPrompt([
			{ role: "system", content: "", sections, timestamp: 1 },
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 2 },
		]);

		assert.ok(prompt.includes(`- ${TOOL_GUIDELINE}`));
		assert.ok(prompt.includes(`- ${EXTENSION_GUIDELINE}`));
		assert.equal(prompt, [REPLACEMENT, sections.rules, sections.addendum, sections.project_context, sections.cwd].join("\n\n"));
		for (const docsText of ["<docs>", "</docs>", "Pi documentation", "docs/", sections.preamble, "<tools>"]) {
			assert.ok(!prompt.includes(docsText), `sent ${JSON.stringify(docsText)}`);
		}
	});

	// Pi replays a section patch by name and appends a section it re-adds, so a
	// session that starts on its own base and switches to Pi's default renders
	// preamble, project_context, cwd, tools, rules, docs.
	it("keeps the sections Pi rendered before <tools> once a session switches to Pi's default base", { timeout: 10_000 }, async () => {
		const contextFiles = [{ path: "/tmp/project/AGENTS.md", content: "Use tabs." }];
		const options = { cwd: "/tmp/project", selectedTools: ["read", "bash"], toolSnippets: { read: "Read file contents", bash: "Execute bash commands" }, contextFiles };
		const first = buildSystemPromptSections({ ...options, customPrompt: "My own base." });
		const second = buildSystemPromptSections({ ...options, promptGuidelines: [EXTENSION_GUIDELINE] });
		const prompt = await capturedSystemPrompt([
			{ role: "system", content: "", sections: first, timestamp: 1 },
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 2 },
			{ role: "system", content: "", sections: diffSystemPromptSections(first, second), timestamp: 3 },
			{ role: "user", content: [{ type: "text", text: "again" }], timestamp: 4 },
		]);

		assert.equal(prompt, [REPLACEMENT, second.project_context, second.cwd, second.rules].join("\n\n"));
		for (const dropped of ["<docs>", "</docs>", "<tools>", "</tools>", second.preamble, "My own base."]) {
			assert.ok(!prompt.includes(dropped), `sent ${JSON.stringify(dropped)}`);
		}
	});
});
