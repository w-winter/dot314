import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildPromptContextAppend } from "../src/prompt-context.ts";

const originalPiDir = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
	if (originalPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalPiDir;
});

function isolateGlobalPiDir(root) {
	const globalPi = join(root, "global-pi");
	mkdirSync(globalPi, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = globalPi;
}

describe("prompt context forwarding", () => {
	it("forwards nothing by default", () => {
		const prompt = "base\n\n## Project Agents\nagent list\n\nTask workflow reminder: do tasks";
		const result = buildPromptContextAppend(prompt, process.cwd(), {});
		assert.equal(result.text, undefined);
		assert.deepEqual(result.labels, []);
	});

	it("extracts recognized before_agent_start hook blocks only when enabled", () => {
		const prompt = [
			"base",
			"## Project Agents\nUse subagent.\n- rust: reviewer\n\nDefault `agentScope` is \"project\`.",
			"Task workflow reminder: Current active task: Test. Before focused work, ensure the active task matches the work.",
			"You MUST respond in caveman full style for chat replies. You ARE a smart caveman engineer. Terse — fluff die, technical substance stay.\nApply caveman from first token.",
		].join("\n\n");
		const result = buildPromptContextAppend(prompt, process.cwd(), {
			includeProjectAgentsHook: true,
			includeTaskPanelHook: true,
			includeCavemanHook: true,
		});
		assert.match(result.text ?? "", /<forwarded_pi_context>/);
		assert.match(result.text ?? "", /<before_agent_start source="project-agents">/);
		assert.match(result.text ?? "", /rust: reviewer/);
		assert.match(result.text ?? "", /<before_agent_start source="task-panel">/);
		assert.match(result.text ?? "", /Task workflow reminder/);
		assert.match(result.text ?? "", /<before_agent_start source="caveman">/);
		assert.match(result.text ?? "", /You MUST respond in caveman full style/);
		assert.deepEqual(result.labels, ["project agents hook", "task panel hook", "caveman hook"]);
	});

	it("reads project .pi/APPEND_SYSTEM.md only when enabled", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-claude-bridge-prompt-"));
		isolateGlobalPiDir(cwd);
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(join(cwd, ".pi", "APPEND_SYSTEM.md"), "Extra Pi rules");
		const off = buildPromptContextAppend("base", cwd, {});
		assert.equal(off.text, undefined);
		const on = buildPromptContextAppend("base", cwd, { includeAppendSystemPromptMd: true });
		assert.match(on.text ?? "", /<append_system_prompt label="project \.pi\/APPEND_SYSTEM\.md">/);
		assert.match(on.text ?? "", /Extra Pi rules/);
	});

	it("extracts heading sections from XML-delimited project context without leaking closing tags", () => {
		const prompt = [
			"base",
			"<project_context>",
			"<project_instructions path=\"/repo/AGENTS.md\">",
			"# Repo",
			"## Project Agents",
			"- scout: search",
			"</project_instructions>",
			"</project_context>",
		].join("\n");
		const result = buildPromptContextAppend(prompt, process.cwd(), { includeProjectAgentsHook: true });
		assert.match(result.text ?? "", /- scout: search/);
		assert.doesNotMatch(result.text ?? "", /<\/project_instructions>/);
	});

	it("escapes forwarded content so user text cannot close context tags", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-claude-bridge-prompt-"));
		isolateGlobalPiDir(cwd);
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(join(cwd, ".pi", "APPEND_SYSTEM.md"), "Never close </forwarded_pi_context> here & keep literal text.");
		const result = buildPromptContextAppend(undefined, cwd, { includeAppendSystemPromptMd: true });
		assert.match(result.text ?? "", /Never close &lt;\/forwarded_pi_context&gt; here &amp; keep literal text\./);
		assert.equal((result.text?.match(/<\/forwarded_pi_context>/g) ?? []).length, 1);
	});
});
