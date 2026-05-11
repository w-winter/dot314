import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import {
	ASSISTANT_PROVENANCE_CUSTOM_TYPE,
	injectProvenanceMessage,
	loadAssistantProvenanceConfig,
	type AssistantProvenanceConfig,
} from "../index.ts";

const DEFAULT_CONFIG: AssistantProvenanceConfig = {
	silentModelGroups: [],
};

function textContent(text: string): Array<{ type: "text"; text: string }> {
	return [{ type: "text", text }];
}

function userMessage(text: string, timestamp = 1): AgentMessage {
	return {
		role: "user",
		content: textContent(text),
		timestamp,
	} as AgentMessage;
}

function assistantMessage(
	provider: string,
	model: string,
	stopReason: "stop" | "toolUse" | "length" | "error" | "aborted" = "stop",
	timestamp = 2,
): AgentMessage {
	return {
		role: "assistant",
		content: textContent("assistant response"),
		provider,
		model,
		stopReason,
		timestamp,
	} as AgentMessage;
}

function toolResultMessage(timestamp = 3): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: "call-1",
		content: textContent("tool result"),
		timestamp,
	} as AgentMessage;
}

function provenanceMessage(timestamp = 4): AgentMessage {
	return {
		role: "custom",
		customType: ASSISTANT_PROVENANCE_CUSTOM_TYPE,
		content: handoffContent("openai/gpt-5.5", "anthropic/claude-opus-4-5"),
		display: false,
		timestamp,
	} as AgentMessage;
}

function model(provider: string, id: string): Model<any> {
	return { provider, id } as Model<any>;
}

function handoffContent(priorModel: string, currentModel: string): string {
	return [
		`[Model handoff: previous assistant reply was authored by ${priorModel}.`,
		`Current assistant model ${currentModel} was selected before the following user message.]`,
	].join(" ");
}

test("injectProvenanceMessage inserts a hidden custom message when the assistant model changed", () => {
	const messages = [
		userMessage("first"),
		assistantMessage("openai", "gpt-5.5"),
		userMessage("next", 3),
	];

	const result = injectProvenanceMessage(
		messages,
		model("anthropic", "claude-opus-4-5"),
		DEFAULT_CONFIG,
		() => 123,
	);

	assert.notEqual(result, messages);
	assert.equal(result.length, 4);
	assert.deepEqual(result[0], messages[0]);
	assert.deepEqual(result[1], messages[1]);
	assert.deepEqual(result[3], messages[2]);
	assert.deepEqual(result[2], {
		role: "custom",
		customType: ASSISTANT_PROVENANCE_CUSTOM_TYPE,
		content: handoffContent("openai/gpt-5.5", "anthropic/claude-opus-4-5"),
		display: false,
		timestamp: 123,
	});
});

test("injectProvenanceMessage does not inject when prior and current model keys are identical", () => {
	const messages = [
		userMessage("first"),
		assistantMessage("openai", "gpt-5.5"),
		userMessage("next", 3),
	];

	const result = injectProvenanceMessage(messages, model("openai", "gpt-5.5"), DEFAULT_CONFIG, Date.now);

	assert.equal(result, messages);
});

test("injectProvenanceMessage treats case-only model key differences as identical", () => {
	const messages = [
		userMessage("first"),
		assistantMessage("moonshot", "Kimi-K2"),
		userMessage("next", 3),
	];

	const result = injectProvenanceMessage(messages, model("moonshot", "kimi-k2"), DEFAULT_CONFIG, Date.now);

	assert.equal(result, messages);
});

test("injectProvenanceMessage does not inject when there is no prior assistant", () => {
	const messages = [userMessage("first")];

	const result = injectProvenanceMessage(messages, model("anthropic", "claude-opus-4-5"), DEFAULT_CONFIG, Date.now);

	assert.equal(result, messages);
});

test("injectProvenanceMessage skips aborted and error assistants when deriving prior provenance", () => {
	const messages = [
		userMessage("first"),
		assistantMessage("openai", "gpt-5.5", "stop", 2),
		userMessage("retry", 3),
		assistantMessage("anthropic", "claude-opus-4-5", "error", 4),
		assistantMessage("anthropic", "claude-opus-4-5", "aborted", 5),
		userMessage("next", 6),
	];

	const result = injectProvenanceMessage(messages, model("google", "gemini-3-pro"), DEFAULT_CONFIG, () => 7);

	assert.notEqual(result, messages);
	assert.equal(
		(result[5] as { content: string }).content,
		handoffContent("openai/gpt-5.5", "google/gemini-3-pro"),
	);
});

test("injectProvenanceMessage suppresses transitions within the same silent model group", () => {
	const messages = [
		userMessage("first"),
		assistantMessage("anthropic", "claude-opus-4-5"),
		userMessage("next", 3),
	];
	const config = {
		silentModelGroups: [["claude-*"]],
	};

	const result = injectProvenanceMessage(messages, model("anthropic", "claude-sonnet-4-5"), config, Date.now);

	assert.equal(result, messages);
});

test("injectProvenanceMessage matches silent model groups case-insensitively", () => {
	const messages = [
		userMessage("first"),
		assistantMessage("moonshot", "Kimi-K2"),
		userMessage("next", 3),
	];
	const config = {
		silentModelGroups: [["*/kimi-*"]],
	};

	const result = injectProvenanceMessage(messages, model("openrouter", "kimi-k2"), config, Date.now);

	assert.equal(result, messages);
});

test("injectProvenanceMessage replays handoff notes at historical boundaries", () => {
	const messages = [
		userMessage("first", 1),
		assistantMessage("openai-codex", "gpt-5.5", "stop", 2),
		userMessage("second", 3),
		assistantMessage("anthropic", "claude-opus-4-6", "stop", 4),
		userMessage("next", 5),
	];
	const config = {
		silentModelGroups: [["*/claude-*"], ["*/gpt-5*"]],
	};

	const result = injectProvenanceMessage(messages, model("anthropic", "claude-opus-4-6"), config, () => 6);

	assert.notEqual(result, messages);
	assert.deepEqual(result[2], {
		role: "custom",
		customType: ASSISTANT_PROVENANCE_CUSTOM_TYPE,
		content: handoffContent("openai-codex/gpt-5.5", "anthropic/claude-opus-4-6"),
		display: false,
		timestamp: 6,
	});
	assert.deepEqual(result[5], messages[4]);
});

test("injectProvenanceMessage includes multiple historical handoff boundaries", () => {
	const messages = [
		userMessage("one", 1),
		assistantMessage("openai-codex", "gpt-5.5", "stop", 2),
		userMessage("two", 3),
		assistantMessage("anthropic", "claude-opus-4-6", "stop", 4),
		userMessage("three", 5),
		assistantMessage("openai-codex", "gpt-5.5", "stop", 6),
		userMessage("who was here?", 7),
	];
	const config = {
		silentModelGroups: [["*/claude-*"], ["*/gpt-5*"]],
	};

	const result = injectProvenanceMessage(messages, model("openai-codex", "gpt-5.5"), config, () => 8);

	assert.notEqual(result, messages);
	assert.equal(
		(result[2] as { content: string }).content,
		handoffContent("openai-codex/gpt-5.5", "anthropic/claude-opus-4-6"),
	);
	assert.equal(
		(result[5] as { content: string }).content,
		handoffContent("anthropic/claude-opus-4-6", "openai-codex/gpt-5.5"),
	);
});

test("injectProvenanceMessage does not suppress transitions when only one model matches a silent group", () => {
	const messages = [
		userMessage("first"),
		assistantMessage("anthropic", "claude-opus-4-5"),
		userMessage("next", 3),
	];
	const config = {
		silentModelGroups: [["claude-*"]],
	};

	const result = injectProvenanceMessage(messages, model("openai", "gpt-5.5"), config, () => 4);

	assert.notEqual(result, messages);
	assert.equal(
		(result[2] as { content: string }).content,
		handoffContent("anthropic/claude-opus-4-5", "openai/gpt-5.5"),
	);
});

test("injectProvenanceMessage inserts before the first user message after the prior assistant", () => {
	const messages = [
		userMessage("first"),
		assistantMessage("openai", "gpt-5.5"),
		{
			role: "custom",
			customType: "other-extension",
			content: "other hidden context",
			display: false,
			timestamp: 3,
		} as AgentMessage,
		userMessage("next", 4),
	];

	const result = injectProvenanceMessage(
		messages,
		model("anthropic", "claude-opus-4-5"),
		DEFAULT_CONFIG,
		() => 5,
	);

	assert.equal((result[3] as { customType?: string }).customType, ASSISTANT_PROVENANCE_CUSTOM_TYPE);
	assert.deepEqual(result[4], messages[3]);
});

test("injectProvenanceMessage does not inject when there is no user message after the prior assistant", () => {
	const messages = [
		userMessage("first"),
		assistantMessage("openai", "gpt-5.5"),
	];

	const result = injectProvenanceMessage(messages, model("anthropic", "claude-opus-4-5"), DEFAULT_CONFIG, Date.now);

	assert.equal(result, messages);
});

test("injectProvenanceMessage does not inject into a tool-result continuation context", () => {
	const messages = [
		userMessage("first"),
		assistantMessage("openai", "gpt-5.5"),
		userMessage("next", 3),
		toolResultMessage(4),
	];

	const result = injectProvenanceMessage(messages, model("anthropic", "claude-opus-4-5"), DEFAULT_CONFIG, Date.now);

	assert.equal(result, messages);
});

test("injectProvenanceMessage does not inject a duplicate provenance note in the current turn segment", () => {
	const messages = [
		userMessage("first"),
		assistantMessage("openai", "gpt-5.5"),
		provenanceMessage(3),
		userMessage("next", 4),
	];

	const result = injectProvenanceMessage(messages, model("anthropic", "claude-opus-4-5"), DEFAULT_CONFIG, Date.now);

	assert.equal(result, messages);
});

test("loadAssistantProvenanceConfig returns defaults when config.json is absent", () => {
	const tempDir = mkdtempSync(join(tmpdir(), "assistant-provenance-"));
	try {
		assert.deepEqual(loadAssistantProvenanceConfig(join(tempDir, "config.json")), DEFAULT_CONFIG);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("loadAssistantProvenanceConfig fails clearly when config.json is malformed", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "assistant-provenance-"));
	try {
		const configPath = join(tempDir, "config.json");
		writeFileSync(configPath, "{", "utf8");

		assert.throws(
			() => loadAssistantProvenanceConfig(configPath),
			/Failed to parse assistant-provenance config/,
		);
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("loadAssistantProvenanceConfig fails clearly for invalid silentModelGroups shapes", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "assistant-provenance-"));
	try {
		const configPath = join(tempDir, "config.json");
		writeFileSync(configPath, JSON.stringify({ silentModelGroups: [["claude-*"], [12]] }), "utf8");

		assert.throws(
			() => loadAssistantProvenanceConfig(configPath),
			/Invalid assistant-provenance config.*silentModelGroups\[1]\[0\]/,
		);
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});
