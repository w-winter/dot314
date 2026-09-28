// A configured systemPrompt.replacement substitutes Pi's default base only.
// When a Pi session supplies its own base (SYSTEM.md, --system-prompt, an SDK
// systemPrompt, a pi-subagents replace-mode agent), that base is the
// session's instructions, so Claude receives the replacement followed by the
// complete prompt Pi built, under every replacement setting. Pi's default
// base keeps the output it had before (legacyResolve, byte for byte). Prompts
// come from Pi's own builder, section diff and forced-prompt projection.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { after, before, describe, it } from "node:test";

import { getCurrentSystemMessage, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
// Not in the package's exports map: Pi's session prompt builder, its section
// diff, and the AgentSession whose forced-prompt projection a
// before_agent_start prompt takes.
import { buildSystemPromptSections, diffSystemPromptSections } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";
import { AgentSession } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js";

import { recordStartedLane, takeStartedLane } from "../src/bridge-state.ts";
import * as bridgeConfig from "../src/config.ts";
import { buildClaudeQueryOptions } from "../src/query-options.ts";
import { legacyResolve } from "./lib/legacy-system-prompt.mjs";

// The Pi the owner runs, when installed here.
const INSTALLED_PI_BUILDER = "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";

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
const MODEL_KEY = "pi-claude/claude-haiku-4-5";

const REPLACEMENT = "You are Claude Code, Anthropic's official CLI for Claude.\nYou are an interactive CLI tool that helps users with software engineering tasks.";
// The three documented configurations, with the text each one leads with.
const CONFIGS = {
	preserve: { config: { replacement: REPLACEMENT, preservePiContext: true }, head: REPLACEMENT },
	modelLine: { config: { replacement: REPLACEMENT, includeModelLine: true }, head: `Active model: ${MODEL_KEY}\n\n${REPLACEMENT}` },
	replaceAll: { config: { replacement: REPLACEMENT, preservePiContext: false }, head: REPLACEMENT },
};

// The owner's main session, started the way session_start records it.
const mainManager = {};
const MAIN_ID = "019a0000-0000-7000-8000-00000000c0de";
before(() => recordStartedLane(mainManager, MAIN_ID));
after(() => takeStartedLane(mainManager));

// The request origin, built from the replayed sections the way index.ts builds it.
const originOf = (sections) => ({ preamble: sections && (sections.preamble ?? ""), sessionId: MAIN_ID });

// What the bridge sends Claude for the main agent's request.
function sent(messages, config) {
	const built = buildClaudeQueryOptions({
		cwd: "/tmp/project",
		requestedModel: model,
		queryModel: model,
		bridgeConfig: { systemPrompt: config },
		systemPrompt: getCurrentSystemPrompt(messages),
		systemPromptOrigin: originOf(getCurrentSystemMessage(messages)?.sections),
		resumeSessionId: null,
	});
	return built.queryOptions.systemPrompt.prompt;
}

const user = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });

function buildOptions(options) {
	return {
		cwd: "/tmp/project",
		selectedTools: ["read", "bash", "edit", "write"],
		toolSnippets: { read: "Read file contents", bash: "Execute bash commands" },
		...options,
	};
}

const build = (options) => buildSystemPromptSections(buildOptions(options));

// Pi's session prompt as AgentSession sends it: a sections-only system message.
function sessionMessages(options) {
	return [{ role: "system", content: "", sections: build(options), timestamp: 1 }, user("hello")];
}

// A session whose base changes mid-session: a before_agent_start handler edits
// customPrompt, and Pi patches the transcript with a section diff.
function switchedMessages(from, to) {
	const first = build(from);
	return [
		{ role: "system", content: "", sections: first, timestamp: 1 },
		user("hello"),
		{ role: "system", content: "", sections: diffSystemPromptSections(first, build(to)), timestamp: 2 },
		user("again"),
	];
}

// A before_agent_start prompt, projected by Pi's own AgentSession method.
async function forcedMessages(messages, forced) {
	const fixture = { agent: {}, _runSystemPromptOptions: { forceSystemPrompt: forced } };
	AgentSession.prototype._installAgentForcedPromptProjection.call(fixture);
	const projected = await fixture.agent.transformContext(messages);
	assert.equal(getCurrentSystemMessage(projected).sections, undefined, "a forced prompt carries no sections");
	return projected;
}

const contextFiles = [{ path: "/tmp/project/AGENTS.md", content: "Use tabs." }];
const skills = [{ name: "demo", description: "Demo skill", filePath: "/tmp/skills/demo/SKILL.md", baseDir: "/tmp/skills/demo", source: "user", disableModelInvocation: false }];

// pi-subagents replace mode (src/runs/shared/child-launch.ts): the child
// session's systemPrompt is the active_agent tag, the agent prompt and the
// Acceptance Contract section (src/runs/shared/acceptance.ts).
const WORKER_PROMPT = "You are a worker agent. Implement the task, run the checks you touched, and report what changed.";
const ACCEPTANCE_CONTRACT = [
	"## Acceptance Contract",
	"Acceptance level: checked",
	"Completion is not accepted from prose alone. End with a structured acceptance report.",
	"",
	"Finish with a fenced JSON block tagged `acceptance-report` in this shape:",
	"```acceptance-report",
	JSON.stringify({ criteriaSatisfied: [{ id: "", status: "satisfied", evidence: "" }], commandsRun: [{ command: "", result: "passed" }] }),
	"```",
].join("\n");
const SUBAGENT_PROMPT = `<active_agent name="worker"/>\n\n${WORKER_PROMPT}\n\n${ACCEPTANCE_CONTRACT}`;
const PI_DOCS_LINE = "- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)";
// Extension sections whose names collide with Pi's default-base sections.
const COLLIDING = { tools: "EXT TOOLS", rules: "EXT RULES", docs: "EXT DOCS" };

const SYSTEM_MD = "My own base from SYSTEM.md.";
const APPEND_MD = "Appended from APPEND_SYSTEM.md.";

const CUSTOM_BASES = {
	"a pi-subagents replace-mode worker with context files and skills": { customPrompt: SUBAGENT_PROMPT, contextFiles, skills },
	"SYSTEM.md": { customPrompt: SYSTEM_MD },
	"SYSTEM.md with context files and skills": { customPrompt: SYSTEM_MD, contextFiles, skills },
	"SYSTEM.md and APPEND_SYSTEM.md": { customPrompt: SYSTEM_MD, appendSystemPrompt: APPEND_MD, contextFiles },
	"--system-prompt": { customPrompt: "Reply with exactly ARRR_OK." },
	"a custom base quoting Pi's docs line, with extension sections named tools, rules and docs": { customPrompt: `${SUBAGENT_PROMPT}\n\nQuoted from Pi:\n${PI_DOCS_LINE}`, contextFiles, sections: COLLIDING },
};

// The replacement leads and the complete prompt follows.
function assertKeepsEverything(messages, expectedPrompt = getCurrentSystemPrompt(messages)) {
	for (const [label, { config, head }] of Object.entries(CONFIGS)) {
		assert.equal(sent(messages, config), `${head}\n\n${expectedPrompt}`, label);
	}
}

// Pi's default base: the output d603a2b sent, byte for byte.
function assertLegacyOutput(messages) {
	const prompt = getCurrentSystemPrompt(messages);
	for (const [label, { config }] of Object.entries(CONFIGS)) {
		assert.equal(sent(messages, config), legacyResolve(prompt, MODEL_KEY, config), label);
	}
}

describe("Pi's default preamble", () => {
	it("matches the preamble of the Pi build the tests import", () => {
		assert.equal(bridgeConfig.PI_DEFAULT_PREAMBLE, build({}).preamble);
		assert.equal(bridgeConfig.PI_DEFAULT_PREAMBLE, build({ contextFiles, skills, appendSystemPrompt: APPEND_MD, sections: COLLIDING }).preamble);
	});

	it("matches the preamble of the installed Pi build", { timeout: 10_000, skip: !existsSync(INSTALLED_PI_BUILDER) && "installed Pi not found" }, async () => {
		const installed = await import(INSTALLED_PI_BUILDER);
		assert.equal(bridgeConfig.PI_DEFAULT_PREAMBLE, installed.buildSystemPromptSections(buildOptions({})).preamble);
	});
});

describe("systemPrompt replacement over a custom base", () => {
	for (const [name, options] of Object.entries(CUSTOM_BASES)) {
		it(`sends the replacement and then the complete prompt for ${name}, under every setting`, () => {
			const messages = sessionMessages(options);
			const prompt = getCurrentSystemPrompt(messages);
			assertKeepsEverything(messages);
			assert.ok(prompt.includes(options.customPrompt));
			assert.ok(prompt.includes("<cwd>\n/tmp/project\n</cwd>"));
			if (options.appendSystemPrompt) assert.ok(prompt.includes(`<addendum>\n${APPEND_MD}\n</addendum>`));
			if (options.contextFiles) assert.ok(prompt.includes("<project_context>"));
			if (options.skills) assert.ok(prompt.includes("<skills>"));
		});
	}

	it("delivers the worker's instructions and the acceptance-report schema to a pi-subagents child", () => {
		const out = sent(sessionMessages(CUSTOM_BASES["a pi-subagents replace-mode worker with context files and skills"]), CONFIGS.preserve.config);
		assert.ok(out.startsWith(`${REPLACEMENT}\n\n<active_agent name="worker"/>\n\n${WORKER_PROMPT}`));
		assert.ok(out.includes("## Acceptance Contract"));
		assert.ok(out.includes("```acceptance-report"));
		assert.ok(out.includes('"criteriaSatisfied"'));
	});

	it("sends a custom base that already leads with the replacement unchanged", () => {
		for (const customPrompt of [REPLACEMENT, `${REPLACEMENT}\nMore of my own base.`]) {
			const messages = sessionMessages({ customPrompt, contextFiles });
			const prompt = getCurrentSystemPrompt(messages);
			for (const [label, { config }] of Object.entries(CONFIGS)) {
				if (label === "modelLine") continue;
				assert.equal(sent(messages, config), prompt, label);
			}
		}
	});

	it("keeps a custom base that a before_agent_start prompt extends or replaces", { timeout: 10_000 }, async () => {
		for (const options of [CUSTOM_BASES["a pi-subagents replace-mode worker with context files and skills"], CUSTOM_BASES["SYSTEM.md and APPEND_SYSTEM.md"]]) {
			const base = sessionMessages(options);
			for (const forced of [`${getCurrentSystemPrompt(base)}\n\nPinned skill instructions.`, "You are a pirate. Reply with exactly ARRR_OK."]) {
				const messages = await forcedMessages(base, forced);
				assert.equal(getCurrentSystemPrompt(messages), forced);
				assertKeepsEverything(messages, forced);
			}
		}
	});

	// Review finding 1: a replayed patch keeps a section's old position, so
	// extension sections named tools, rules and docs sit where Pi's were.
	it("keeps the custom base a session switches to from Pi's default, extension names colliding (review P2-1)", () => {
		const messages = switchedMessages({ contextFiles }, { customPrompt: SUBAGENT_PROMPT, contextFiles, sections: COLLIDING });
		assert.deepEqual(Object.keys(getCurrentSystemMessage(messages).sections), ["preamble", "tools", "rules", "docs", "project_context", "cwd"]);
		const prompt = getCurrentSystemPrompt(messages);
		assert.ok(prompt.startsWith(SUBAGENT_PROMPT));
		assertKeepsEverything(messages);
	});

	it("keeps the custom base a session switches to from Pi's default", () => {
		const messages = switchedMessages({ contextFiles }, { customPrompt: SUBAGENT_PROMPT, contextFiles });
		assert.ok(getCurrentSystemPrompt(messages).startsWith(SUBAGENT_PROMPT));
		assertKeepsEverything(messages);
	});

	// Review finding 2A: a custom base may quote Pi's docs line.
	it("keeps a hook-extended custom base that quotes Pi's docs line (review P2-2A)", { timeout: 10_000 }, async () => {
		const base = sessionMessages({ customPrompt: `${SUBAGENT_PROMPT}\n\nQuoted from Pi:\n${PI_DOCS_LINE}`, contextFiles });
		const forced = `${getCurrentSystemPrompt(base)}\n\nPinned skill instructions.`;
		const messages = await forcedMessages(base, forced);
		assertKeepsEverything(messages, forced);
		assert.ok(sent(messages, CONFIGS.replaceAll.config).includes(ACCEPTANCE_CONTRACT));
	});
});

describe("systemPrompt replacement over Pi's default base", () => {
	const DEFAULT_BASES = {
		"default base": {},
		"default base with context files and skills": { contextFiles, skills },
		"APPEND_SYSTEM.md": { appendSystemPrompt: APPEND_MD, contextFiles },
		"a pi-subagents append-mode agent (the addendum)": { appendSystemPrompt: SUBAGENT_PROMPT, contextFiles, skills },
		"extension sections overriding tools, rules and docs": { contextFiles, sections: COLLIDING },
		"an extension section overriding docs only": { contextFiles, skills, sections: { docs: "EXT DOCS" } },
	};

	for (const [name, options] of Object.entries(DEFAULT_BASES)) {
		it(`sends d603a2b's output for ${name}`, () => assertLegacyOutput(sessionMessages(options)));
		it(`sends d603a2b's output for a before_agent_start prompt over ${name}`, { timeout: 10_000 }, async () => {
			const base = sessionMessages(options);
			assertLegacyOutput(await forcedMessages(base, `${getCurrentSystemPrompt(base)}\n\nPinned skill instructions.`));
		});
	}

	it("still replaces the default base under an append-mode agent", () => {
		const out = sent(sessionMessages(DEFAULT_BASES["a pi-subagents append-mode agent (the addendum)"]), CONFIGS.preserve.config);
		assert.ok(out.startsWith(`${REPLACEMENT}\n</docs>\n\n<addendum>\n${SUBAGENT_PROMPT}\n</addendum>`));
		assert.ok(!out.includes("expert coding assistant operating inside pi"));
	});

	// Review finding 2B: without Pi's docs line the forced prompt still renders Pi's default base.
	it("sends d603a2b's output for a forced default base whose docs section an extension overrode (review P2-2B)", { timeout: 10_000 }, async () => {
		const base = sessionMessages({ contextFiles, sections: { docs: "EXT DOCS" } });
		const messages = await forcedMessages(base, `${getCurrentSystemPrompt(base)}\n\nPinned skill instructions.`);
		assert.ok(!getCurrentSystemPrompt(messages).includes(PI_DOCS_LINE));
		assertLegacyOutput(messages);
		assert.equal(sent(messages, CONFIGS.replaceAll.config), REPLACEMENT);
	});

	// Review finding 1, inverse: Pi's re-added tools, rules and docs replay after cwd.
	it("sends d603a2b's output once a session switches from a custom base back to Pi's default (review P2-1)", () => {
		const messages = switchedMessages({ customPrompt: SUBAGENT_PROMPT, contextFiles }, { contextFiles });
		assert.deepEqual(Object.keys(getCurrentSystemMessage(messages).sections), ["preamble", "project_context", "cwd", "tools", "rules", "docs"]);
		assertLegacyOutput(messages);
		assert.equal(sent(messages, CONFIGS.replaceAll.config), REPLACEMENT);
	});

	// The documented limit: a custom base is told from Pi's by its preamble
	// alone. A sectioned preamble must equal Pi's sentence; one that only
	// starts with it is the session's own.
	it("takes a custom base that is exactly Pi's default sentence as Pi's default base", () => {
		assertLegacyOutput(sessionMessages({ customPrompt: bridgeConfig.PI_DEFAULT_PREAMBLE, contextFiles }));
		assertKeepsEverything(sessionMessages({ customPrompt: `${bridgeConfig.PI_DEFAULT_PREAMBLE}\nMore of my own.`, contextFiles }));
	});
});
