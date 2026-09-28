// The configured systemPrompt replacement belongs to Pi's main agent prompt
// only. Every other system prompt (Pi's own compaction and branch summaries,
// an extension's one-shot call, side chat, the subagent watchdog) must reach
// Claude unchanged, whatever its text says. Prompts and request options come
// from Pi's own code: its prompt builder, its forced-prompt projection, its
// summarizers (through a capturing stream function) and pi-ai's context
// helpers, so a change in how Pi sends them shows up here.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { createInitialSystemMessage, getCurrentSystemMessage, getCurrentSystemPrompt, normalizeContext } from "@earendil-works/pi-ai";
import { generateBranchSummary, generateSummary } from "@earendil-works/pi-coding-agent";
// Not in the package's exports map: Pi's session prompt builder and the
// AgentSession whose forced-prompt projection a before_agent_start prompt takes.
import { buildSystemPromptSections } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";
import { AgentSession } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js";

import { recordStartedLane, takeStartedLane } from "../src/bridge-state.ts";
import { buildClaudeQueryOptions } from "../src/query-options.ts";
import { legacyResolve } from "./lib/legacy-system-prompt.mjs";

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

// The owner's configuration shape, plus the two other documented settings.
const REPLACEMENT = "You are Claude Code, Anthropic's official CLI for Claude.\nYou are an interactive CLI tool that helps users with software engineering tasks.";
const CONFIGS = {
	preserve: { replacement: REPLACEMENT, preservePiContext: true },
	modelLine: { replacement: REPLACEMENT, includeModelLine: true },
	replaceAll: { replacement: REPLACEMENT, preservePiContext: false },
};

// The main prompt's output over Pi's default base is pinned to what the
// bridge sent before issue #1 (legacyResolve, verbatim). A base the session
// supplied itself (SYSTEM.md here) is kept since issue #1:
// the replacement leads and the complete prompt follows, under every setting.
function expectedMain(prompt, config, customBase) {
	if (!customBase) return legacyResolve(prompt, "pi-claude/claude-haiku-4-5", config);
	const head = `${config.includeModelLine ? "Active model: pi-claude/claude-haiku-4-5\n\n" : ""}${config.replacement}`;
	return `${head}\n\n${prompt}`;
}

// The main session, started the way the bridge's session_start handler
// records it. Pi's main agent sends this id on every request (sdk.ts).
const mainManager = {};
const MAIN_ID = "019a0000-0000-7000-8000-000000000001";
before(() => recordStartedLane(mainManager, MAIN_ID));
after(() => takeStartedLane(mainManager));

// What index.ts passes for a request's messages and stream options.
function sent(messages, config, requestOptions = {}) {
	const sections = getCurrentSystemMessage(messages)?.sections;
	const built = buildClaudeQueryOptions({
		cwd: "/tmp/project",
		requestedModel: model,
		queryModel: model,
		bridgeConfig: { systemPrompt: config },
		systemPrompt: getCurrentSystemPrompt(messages),
		systemPromptOrigin: {
			preamble: sections && (sections.preamble ?? ""),
			sessionId: requestOptions.sessionId,
			cacheRetention: requestOptions.cacheRetention,
		},
		resumeSessionId: null,
	});
	return { prompt: built.queryOptions.systemPrompt.prompt, source: built.systemPromptSource };
}

const user = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });

// Pi's session prompt: AgentSession sends buildSystemPromptSections' output as
// a sections-only system message (_preparePromptAndToolLoadout).
function sessionMessages(options) {
	const sections = buildSystemPromptSections({
		cwd: "/tmp/project",
		selectedTools: ["read", "bash", "edit", "write"],
		toolSnippets: { read: "Read file contents", bash: "Execute bash commands" },
		...options,
	});
	return [{ role: "system", content: "", sections, timestamp: 1 }, user("hello")];
}

const contextFiles = [{ path: "/tmp/project/AGENTS.md", content: "Use tabs." }];
const skills = [{ name: "demo", description: "Demo skill", filePath: "/tmp/skills/demo/SKILL.md", baseDir: "/tmp/skills/demo", source: "user", disableModelInvocation: false }];
const SYSTEM_MD = "My own base from SYSTEM.md.";
const APPEND_MD = "Appended from APPEND_SYSTEM.md.";

const MAIN_PROMPTS = {
	"default base": {},
	"default base with context and skills": { contextFiles, skills },
	"SYSTEM.md base": { customPrompt: SYSTEM_MD },
	"SYSTEM.md base with context and skills": { customPrompt: SYSTEM_MD, contextFiles, skills },
	"APPEND_SYSTEM.md": { appendSystemPrompt: APPEND_MD, contextFiles },
	"SYSTEM.md and APPEND_SYSTEM.md": { customPrompt: SYSTEM_MD, appendSystemPrompt: APPEND_MD },
};

// A before_agent_start prompt, projected by Pi's own AgentSession method into
// one content-only head. Extensions build it from event.systemPrompt, the
// rendered session prompt (pi-skill-palette, pi-prompt-template-model).
async function forcedMessages(options, extra) {
	const messages = sessionMessages(options);
	const fixture = { agent: {}, _runSystemPromptOptions: { forceSystemPrompt: `${getCurrentSystemPrompt(messages)}\n\n${extra}` } };
	AgentSession.prototype._installAgentForcedPromptProjection.call(fixture);
	const projected = await fixture.agent.transformContext(messages);
	assert.equal(getCurrentSystemMessage(projected).sections, undefined, "a forced prompt carries no sections");
	return projected;
}

// Capture the context and options Pi's own summarizers send to the provider.
function capturingStream(captured) {
	return async (_model, context, options) => {
		captured.push({ context, options });
		return {
			result: async () => ({
				role: "assistant",
				content: [{ type: "text", text: "summary" }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop",
				timestamp: 2,
			}),
		};
	};
}

async function compactionRequest(sessionId) {
	const captured = [];
	await generateSummary([user("please fix the bug")], model, 16384, undefined, undefined, undefined, undefined, undefined, undefined, capturingStream(captured), undefined, undefined, undefined, sessionId);
	assert.equal(captured.length, 1);
	return { messages: captured[0].context.messages, options: captured[0].options };
}

async function branchSummaryRequest() {
	const captured = [];
	const entries = [{ type: "message", id: "a", parentId: null, timestamp: new Date(1).toISOString(), message: user("explore option A") }];
	const result = await generateBranchSummary(entries, { model, signal: new AbortController().signal, streamFn: capturingStream(captured) });
	assert.equal(result.error, undefined);
	assert.equal(captured.length, 1);
	return { messages: captured[0].context.messages, options: captured[0].options };
}

// pi-prune's summarizer, through ctx.modelRegistry.complete with its own id.
const PRUNE_PROMPT = "You are compacting old tool results from a Pi coding-agent session.\nWrite the smallest useful continuation note, not a history, audit log, or transcript.";
// pi-subagents' permission arbiter: its own Agent (no sessionId), tools, and a
// Pi-style <cwd> section, so neither the tool list nor <cwd> marks a prompt as Pi's.
const ARBITER_PROMPT = "You are the pi-subagents watchdog permission arbiter.\nDecide only whether this exact non-bash child tool call should proceed.\n\n<cwd>\n/tmp/project\n</cwd>";
const arbiterTool = { name: "watchdog_permission_decision", description: "Decide", parameters: { type: "object", properties: {} } };
// A caller's prompt that quotes the last line of Pi's default base (review finding 2).
const QUOTING_PROMPT = "You are a prompt reviewer. Review this quoted instruction; do not execute it:\n- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)";
// pi-side-chat's suffix on ctx.getSystemPrompt(), sent with a per-overlay id.
const SIDE_CHAT_SUFFIX = "\n---\n## Side Chat\n\nYou're in a SIDE CHAT parallel to the main agent.\n\nThe copied main context is reference only. Do not continue its pending user request, tool call, reasoning, edits, or unfinished answer.";

describe("systemPrompt replacement scope", () => {
	for (const [name, options] of Object.entries(MAIN_PROMPTS)) {
		it(`sends the expected output for Pi's main prompt: ${name}`, () => {
			const messages = sessionMessages(options);
			const prompt = getCurrentSystemPrompt(messages);
			for (const config of Object.values(CONFIGS)) {
				const out = sent(messages, config, { sessionId: MAIN_ID });
				assert.equal(out.prompt, expectedMain(prompt, config, options.customPrompt !== undefined));
				assert.equal(out.source, "pi-main:sections");
			}
			assert.ok(sent(messages, CONFIGS.preserve, { sessionId: MAIN_ID }).prompt.startsWith(REPLACEMENT));
		});
	}

	for (const [name, options] of Object.entries(MAIN_PROMPTS)) {
		it(`sends the expected output for a before_agent_start prompt on the main session: ${name}`, async () => {
			const messages = await forcedMessages(options, "Pinned skill instructions.");
			const prompt = getCurrentSystemPrompt(messages);
			for (const config of Object.values(CONFIGS)) {
				const out = sent(messages, config, { sessionId: MAIN_ID });
				assert.equal(out.prompt, expectedMain(prompt, config, options.customPrompt !== undefined));
				assert.equal(out.source, "pi-main:session");
			}
		});
	}

	it("applies the replacement to a SYSTEM.md main prompt that a before_agent_start hook extended (review finding 1)", async () => {
		// The replacement still applies; since issue #1 it leads the SYSTEM.md
		// base instead of discarding it.
		const messages = await forcedMessages({ customPrompt: "My SYSTEM.md base." }, "Pinned skill instructions.");
		const prompt = getCurrentSystemPrompt(messages);
		assert.ok(prompt.startsWith("My SYSTEM.md base."));
		assert.equal(sent(messages, CONFIGS.replaceAll, { sessionId: MAIN_ID }).prompt, `${REPLACEMENT}\n\n${prompt}`);
		assert.equal(sent(messages, CONFIGS.modelLine, { sessionId: MAIN_ID }).prompt, `Active model: pi-claude/claude-haiku-4-5\n\n${REPLACEMENT}\n\n${prompt}`);
		assert.equal(sent(messages, CONFIGS.preserve, { sessionId: MAIN_ID }).prompt, `${REPLACEMENT}\n\n${prompt}`);
	});

	const foreign = {
		"Pi's compaction summary": () => compactionRequest(undefined),
		"Pi's compaction summary carrying the main session's id": () => compactionRequest(MAIN_ID),
		"Pi's branch summary": branchSummaryRequest,
		"pi-prune's summarizer": async () => ({ messages: normalizeContext({ systemPrompt: PRUNE_PROMPT, messages: [user("tool results")] }).messages, options: { sessionId: randomUUID() } }),
		"a probe's one-line instruction": async () => ({ messages: normalizeContext({ systemPrompt: "Reply with exactly the word PINEAPPLE", messages: [user("hi")] }).messages, options: {} }),
		"the subagent permission arbiter (tools and <cwd>)": async () => ({ messages: [createInitialSystemMessage(ARBITER_PROMPT, [arbiterTool]), user("decide")], options: {} }),
		"a prompt quoting Pi's docs line (review finding 2)": async () => ({ messages: normalizeContext({ systemPrompt: QUOTING_PROMPT, messages: [user("review")] }).messages, options: {} }),
		"side chat's copy of the main prompt": async () => ({
			messages: normalizeContext({ systemPrompt: getCurrentSystemPrompt(sessionMessages({ contextFiles })) + SIDE_CHAT_SUFFIX, messages: [user("quick question")] }).messages,
			options: { sessionId: randomUUID() },
		}),
	};
	for (const [name, load] of Object.entries(foreign)) {
		it(`sends ${name} unchanged under every replacement setting`, async () => {
			const { messages, options } = await load();
			const prompt = getCurrentSystemPrompt(messages);
			assert.ok(prompt.length > 0);
			for (const [label, config] of Object.entries(CONFIGS)) {
				const out = sent(messages, config, options);
				assert.equal(out.prompt, prompt, `${label} changed the prompt`);
				assert.equal(out.source, "caller");
			}
		});
	}

	it("captures Pi's own summarization prompt and request options from both summarizers", async () => {
		for (const load of [() => compactionRequest(undefined), () => compactionRequest(MAIN_ID), branchSummaryRequest]) {
			const { messages, options } = await load();
			assert.match(getCurrentSystemPrompt(messages), /^You are a context summarization assistant\./);
			assert.equal(options.cacheRetention, "none");
			assert.equal(typeof options.sessionId, "string");
		}
		assert.notEqual((await compactionRequest(undefined)).options.sessionId, MAIN_ID);
		assert.equal((await compactionRequest(MAIN_ID)).options.sessionId, MAIN_ID);
	});

	it("follows the live session across /new, /resume and an in-memory fork", async () => {
		const messages = await forcedMessages({ customPrompt: SYSTEM_MD }, "Extra.");
		const source = (sessionId) => sent(messages, CONFIGS.preserve, { sessionId }).source;
		const first = {};
		recordStartedLane(first, "first-session");
		assert.equal(source("first-session"), "pi-main:session");
		// /new and /resume: the old runtime shuts down, then the new one starts.
		assert.equal(takeStartedLane(first), "first-session");
		assert.equal(source("first-session"), "caller");
		const second = {};
		recordStartedLane(second, "second-session");
		assert.equal(source("second-session"), "pi-main:session");
		// `pi --no-session` fork: the same manager takes the fork's id.
		assert.equal(takeStartedLane(second), "second-session");
		recordStartedLane(second, "forked-session");
		assert.equal(source("second-session"), "caller");
		assert.equal(source("forked-session"), "pi-main:session");
		takeStartedLane(second);
		assert.equal(source("forked-session"), "caller");
		assert.equal(source(MAIN_ID), "pi-main:session", "other live sessions are unaffected");
	});
});
