import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { buildSystemPromptSections } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";
import appendixModule from "../../model-sysprompt-appendix/index.ts";
import { buildClaudeQueryOptions } from "../src/query-options.ts";

const appendText = "Follow the instructions supplied by APPEND_SYSTEM.md.";
const modelText = "Follow the model-specific appendix instructions.";
const replacement = "A replacement for the default coding-assistant base.";
const model = { provider: "pi-claude", id: "claude-opus-5-5", reasoning: true };
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const root = mkdtempSync(join(tmpdir(), "bridge-prompt-appendages-"));
let sections;
let prompt;

before(async () => {
	process.env.PI_CODING_AGENT_DIR = root;
	const configDir = join(root, "extensions", "model-sysprompt-appendix");
	mkdirSync(configDir, { recursive: true });
	writeFileSync(join(configDir, "model-sysprompt-appendix.json"), JSON.stringify({
		exact: { "pi-claude/claude-opus-5-5": modelText }, includeModelLine: true,
	}));
	const handlers = new Map();
	appendixModule.default({ registerCommand() {}, on(name, handler) { handlers.set(name, handler); } });
	const systemPromptOptions = {
		cwd: root, selectedTools: ["bash"], toolSnippets: { bash: "Run a command" },
		appendSystemPrompt: appendText, sections: {},
	};
	await handlers.get("before_agent_start")({ systemPromptOptions }, { model });
	sections = buildSystemPromptSections(systemPromptOptions);
	prompt = getCurrentSystemPrompt([{ role: "system", content: "", sections, timestamp: 1 }]);
});

after(() => {
	process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	execFileSync("trash", [root]);
});

function sent(systemPrompt) {
	return buildClaudeQueryOptions({
		cwd: root, requestedModel: model, queryModel: model, bridgeConfig: { systemPrompt },
		systemPrompt: prompt, systemPromptOrigin: { preamble: sections.preamble }, resumeSessionId: null,
	}).queryOptions.systemPrompt.prompt;
}

describe("Pi prompt appendages through the bridge", () => {
	it("keeps the entire prompt when no replacement is configured", () => {
		const output = sent(undefined);
		assert.equal(output, prompt);
		assert.ok(output.includes(appendText));
		assert.ok(output.includes(modelText));
	});

	for (const preservePiContext of [undefined, true]) {
		it(`replaces only Pi's base and preserves both appendages with preservePiContext=${preservePiContext}`, () => {
			const config = { replacement };
			if (preservePiContext !== undefined) config.preservePiContext = preservePiContext;
			const output = sent(config);
			assert.ok(output.startsWith(replacement));
			assert.ok(!output.includes(sections.preamble));
			assert.ok(!output.includes(sections.docs));
			assert.ok(output.includes(appendText));
			assert.ok(output.includes(modelText));
			assert.ok(output.includes("Active model: pi-claude/claude-opus-5-5"));
		});
	}

	it("honors an explicit request to discard Pi context", () => {
		assert.equal(sent({ replacement, preservePiContext: false }), replacement);
	});
});
