import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const ASSISTANT_PROVENANCE_CUSTOM_TYPE = "assistant-model-provenance";

export interface ModelRef {
	provider: string;
	modelId: string;
}

export interface AssistantProvenanceConfig {
	silentModelGroups: string[][];
}

interface AssistantProvenanceOptions {
	configPath?: string;
	nowMs?: () => number;
}

interface AssistantMessageRef {
	index: number;
	model: ModelRef;
}

interface ProvenanceInsertion {
	index: number;
	priorModel: ModelRef;
	currentModel: ModelRef;
}

const DEFAULT_CONFIG: AssistantProvenanceConfig = {
	silentModelGroups: [],
};

const CONFIG_FILE_NAME = "config.json";

function getDefaultConfigPath(): string {
	return join(dirname(fileURLToPath(import.meta.url)), CONFIG_FILE_NAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getMessageRole(message: AgentMessage): string | undefined {
	return (message as { role?: unknown }).role as string | undefined;
}

function getAssistantModelRef(message: AgentMessage): ModelRef | undefined {
	const candidate = message as { provider?: unknown; model?: unknown };
	if (typeof candidate.provider !== "string" || typeof candidate.model !== "string") {
		return undefined;
	}

	return {
		provider: candidate.provider,
		modelId: candidate.model,
	};
}

function getCurrentModelRef(model: Model<any> | undefined): ModelRef | undefined {
	if (!model) {
		return undefined;
	}

	return {
		provider: model.provider,
		modelId: model.id,
	};
}

function getSuccessfulAssistantModelRef(message: AgentMessage): ModelRef | undefined {
	if (getMessageRole(message) !== "assistant") {
		return undefined;
	}

	const stopReason = (message as { stopReason?: unknown }).stopReason;
	if (stopReason === "error" || stopReason === "aborted") {
		return undefined;
	}

	return getAssistantModelRef(message);
}

function findReplyModelForUser(
	messages: AgentMessage[],
	userMessageIndex: number,
	currentModel: ModelRef,
): ModelRef | undefined {
	for (let index = userMessageIndex + 1; index < messages.length; index += 1) {
		if (getMessageRole(messages[index]) === "user") {
			return undefined;
		}

		const model = getSuccessfulAssistantModelRef(messages[index]);
		if (model) {
			return model;
		}
	}

	return currentModel;
}

function isToolResultContinuation(messages: AgentMessage[]): boolean {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const role = getMessageRole(messages[index]);
		if (role !== "custom") {
			return role === "toolResult";
		}
	}

	return false;
}

function hasExistingProvenanceMessage(messages: AgentMessage[], startIndex: number, endIndex: number): boolean {
	for (let index = startIndex; index < endIndex; index += 1) {
		const message = messages[index] as { role?: unknown; customType?: unknown };
		if (message.role === "custom" && message.customType === ASSISTANT_PROVENANCE_CUSTOM_TYPE) {
			return true;
		}
	}

	return false;
}

export function formatModelKey(model: ModelRef): string {
	return `${model.provider}/${model.modelId}`;
}

function areSameModel(modelA: ModelRef, modelB: ModelRef): boolean {
	return formatModelKey(modelA).toLowerCase() === formatModelKey(modelB).toLowerCase();
}

function escapeRegExp(value: string): string {
	return value.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

export function matchesModelPattern(pattern: string, model: ModelRef): boolean {
	const target = pattern.includes("/") ? formatModelKey(model) : model.modelId;
	const normalizedPattern = pattern.toLowerCase();
	const normalizedTarget = target.toLowerCase();
	const regex = new RegExp(`^${normalizedPattern.split("*").map(escapeRegExp).join(".*")}$`);
	return regex.test(normalizedTarget);
}

export function isSuppressedTransition(
	priorModel: ModelRef,
	currentModel: ModelRef,
	config: AssistantProvenanceConfig,
): boolean {
	return config.silentModelGroups.some((group) => {
		const priorMatches = group.some((pattern) => matchesModelPattern(pattern, priorModel));
		const currentMatches = group.some((pattern) => matchesModelPattern(pattern, currentModel));
		return priorMatches && currentMatches;
	});
}

function isMeaningfulTransition(
	priorModel: ModelRef,
	currentModel: ModelRef,
	config: AssistantProvenanceConfig,
): boolean {
	return !areSameModel(priorModel, currentModel) && !isSuppressedTransition(priorModel, currentModel, config);
}

function formatProvenanceContent(priorModel: ModelRef, currentModel: ModelRef): string {
	return [
		`[Model handoff: previous assistant reply was authored by ${formatModelKey(priorModel)}.`,
		`Current assistant model ${formatModelKey(currentModel)} was selected before the following user message.]`,
	].join(" ");
}

function findProvenanceInsertions(
	messages: AgentMessage[],
	currentModel: ModelRef,
	config: AssistantProvenanceConfig,
): ProvenanceInsertion[] {
	const insertions: ProvenanceInsertion[] = [];
	let priorAssistant: AssistantMessageRef | undefined;

	for (let index = 0; index < messages.length; index += 1) {
		if (getMessageRole(messages[index]) === "user" && priorAssistant) {
			const replyModel = findReplyModelForUser(messages, index, currentModel);
			const hasExistingNote = hasExistingProvenanceMessage(messages, priorAssistant.index + 1, index);
			if (replyModel && !hasExistingNote && isMeaningfulTransition(priorAssistant.model, replyModel, config)) {
				insertions.push({ index, priorModel: priorAssistant.model, currentModel: replyModel });
			}
		}

		const assistantModel = getSuccessfulAssistantModelRef(messages[index]);
		if (assistantModel) {
			priorAssistant = { index, model: assistantModel };
		}
	}

	return insertions;
}

function insertProvenanceMessages(
	messages: AgentMessage[],
	insertions: ProvenanceInsertion[],
	nowMs: () => number,
): AgentMessage[] {
	const messagesWithProvenance: AgentMessage[] = [];
	let insertionIndex = 0;

	for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
		if (insertionIndex < insertions.length && insertions[insertionIndex].index === messageIndex) {
			const insertion = insertions[insertionIndex];
			messagesWithProvenance.push({
				role: "custom",
				customType: ASSISTANT_PROVENANCE_CUSTOM_TYPE,
				content: formatProvenanceContent(insertion.priorModel, insertion.currentModel),
				display: false,
				timestamp: nowMs(),
			} as AgentMessage);
			insertionIndex += 1;
		}

		messagesWithProvenance.push(messages[messageIndex]);
	}

	return messagesWithProvenance;
}

function validateSilentModelGroups(value: unknown): string[][] {
	if (!Array.isArray(value)) {
		throw new Error("silentModelGroups must be an array of string arrays");
	}

	return value.map((group, groupIndex) => {
		if (!Array.isArray(group)) {
			throw new Error(`silentModelGroups[${groupIndex}] must be an array of patterns`);
		}
		if (group.length === 0) {
			throw new Error(`silentModelGroups[${groupIndex}] must contain at least one pattern`);
		}

		return group.map((pattern, patternIndex) => {
			if (typeof pattern !== "string" || pattern.length === 0) {
				throw new Error(`silentModelGroups[${groupIndex}][${patternIndex}] must be a non-empty string`);
			}

			return pattern;
		});
	});
}

export function validateAssistantProvenanceConfig(rawConfig: unknown): AssistantProvenanceConfig {
	if (!isRecord(rawConfig)) {
		throw new Error("config root must be an object");
	}

	for (const key of Object.keys(rawConfig)) {
		if (key !== "silentModelGroups") {
			throw new Error(`unsupported field: ${key}`);
		}
	}

	if (rawConfig.silentModelGroups === undefined) {
		return DEFAULT_CONFIG;
	}

	return {
		silentModelGroups: validateSilentModelGroups(rawConfig.silentModelGroups),
	};
}

export function loadAssistantProvenanceConfig(configPath: string = getDefaultConfigPath()): AssistantProvenanceConfig {
	if (!existsSync(configPath)) {
		return DEFAULT_CONFIG;
	}

	let parsedConfig: unknown;
	try {
		parsedConfig = JSON.parse(readFileSync(configPath, "utf8"));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to parse assistant-provenance config at ${configPath}: ${message}`);
	}

	try {
		return validateAssistantProvenanceConfig(parsedConfig);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid assistant-provenance config at ${configPath}: ${message}`);
	}
}

export function injectProvenanceMessage(
	messages: AgentMessage[],
	currentModel: Model<any> | undefined,
	config: AssistantProvenanceConfig,
	nowMs: () => number,
): AgentMessage[] {
	const currentModelRef = getCurrentModelRef(currentModel);
	if (!currentModelRef || isToolResultContinuation(messages)) {
		return messages;
	}

	const insertions = findProvenanceInsertions(messages, currentModelRef, config);
	if (insertions.length === 0) {
		return messages;
	}

	return insertProvenanceMessages(messages, insertions, nowMs);
}

export function registerAssistantProvenanceExtension(
	pi: ExtensionAPI,
	options: AssistantProvenanceOptions = {},
): void {
	const config = loadAssistantProvenanceConfig(options.configPath);
	const nowMs = options.nowMs ?? Date.now;

	pi.on("context", (event, ctx) => {
		const messages = injectProvenanceMessage(event.messages, ctx.model, config, nowMs);
		if (messages === event.messages) {
			return undefined;
		}

		return { messages };
	});
}

export default function assistantModelProvenanceExtension(pi: ExtensionAPI): void {
	registerAssistantProvenanceExtension(pi);
}
