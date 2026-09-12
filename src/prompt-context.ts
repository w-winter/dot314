import { existsSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { isolatedFromEnv, piUserDir } from "./config.js";
import { debug } from "./debug.js";

export interface PromptContextSettings {
	includeAppendSystemPromptMd?: boolean;
	includeProjectAgentsHook?: boolean;
	includeTaskPanelHook?: boolean;
	includeCavemanHook?: boolean;
}

export interface PromptContextAppend {
	text?: string;
	labels: string[];
}

function readTrimmed(path: string): string | undefined {
	try {
		if (!existsSync(path)) return undefined;
		const content = readFileSync(path, "utf8").trim();
		return content.length > 0 ? content : undefined;
	} catch (error) {
		// The file exists but could not be read: the user opted into forwarding
		// it, so a silent drop looks like the setting being ignored.
		debug(`prompt-context: failed to read ${path}:`, error instanceof Error ? error.message : String(error));
		return undefined;
	}
}

function findProjectAppendSystem(startDir: string): string | undefined {
	let current = resolve(startDir);
	while (true) {
		const candidate = join(current, ".pi", "APPEND_SYSTEM.md");
		if (existsSync(candidate)) return candidate;
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return undefined;
}

export function readAppendSystemPromptFiles(cwd: string): Array<{ label: string; content: string }> {
	const files: Array<{ label: string; path: string }> = [
		{ label: "global APPEND_SYSTEM.md", path: join(piUserDir(), "APPEND_SYSTEM.md") },
	];
	// Isolated mode: no cwd-ancestor discovery — the host app owns the prompt surface.
	const projectPath = isolatedFromEnv() ? undefined : findProjectAppendSystem(cwd);
	if (projectPath) files.push({ label: "project .pi/APPEND_SYSTEM.md", path: projectPath });

	const seen = new Set<string>();
	const output: Array<{ label: string; content: string }> = [];
	for (const file of files) {
		if (seen.has(file.path)) continue;
		seen.add(file.path);
		const content = readTrimmed(file.path);
		if (content) output.push({ label: file.label, content });
	}
	return output;
}

function splitPromptBlocks(systemPrompt?: string): string[] {
	return (systemPrompt ?? "")
		.split(/\n{2,}/)
		.map((block) => block.trim())
		.filter(Boolean);
}

function extractHeadingSection(systemPrompt: string | undefined, headings: string[]): string | undefined {
	if (!systemPrompt) return undefined;
	let start = -1;
	for (const heading of headings) {
		const index = systemPrompt.indexOf(heading);
		if (index >= 0 && (start < 0 || index < start)) start = index;
	}
	if (start < 0) return undefined;
	const rest = systemPrompt.slice(start).trim();
	const endCandidates = [
		rest.slice(1).search(/\n##\s+/),
		rest.search(/\n<\/project_instructions>/),
		rest.search(/\n<\/project_context>/),
	]
		.map((index, offset) => (index >= 0 && offset === 0 ? index + 1 : index))
		.filter((index) => index >= 0);
	const end = endCandidates.length > 0 ? Math.min(...endCandidates) : -1;
	return (end >= 0 ? rest.slice(0, end) : rest).trim();
}

function extractBlockByMarkers(systemPrompt: string | undefined, markers: RegExp[]): string | undefined {
	for (const block of splitPromptBlocks(systemPrompt)) {
		if (markers.some((marker) => marker.test(block))) return block;
	}
	return undefined;
}

export function buildPromptContextAppend(systemPrompt: string | undefined, cwd: string, settings: PromptContextSettings): PromptContextAppend {
	const parts: string[] = [];
	const labels: string[] = [];

	if (settings.includeAppendSystemPromptMd) {
		for (const file of readAppendSystemPromptFiles(cwd)) {
			parts.push(xmlBlock("append_system_prompt", { label: file.label }, file.content));
			labels.push(file.label);
		}
	}

	if (settings.includeProjectAgentsHook) {
		const projectAgents = extractHeadingSection(systemPrompt, ["## Project Agents", "## Project Subagents"]);
		if (projectAgents) {
			parts.push(xmlBlock("before_agent_start", { source: "project-agents" }, projectAgents));
			labels.push("project agents hook");
		}
	}

	if (settings.includeTaskPanelHook) {
		const taskReminder = extractBlockByMarkers(systemPrompt, [/^Task workflow reminder:/]);
		if (taskReminder) {
			parts.push(xmlBlock("before_agent_start", { source: "task-panel" }, taskReminder));
			labels.push("task panel hook");
		}
	}

	if (settings.includeCavemanHook) {
		const caveman = extractBlockByMarkers(systemPrompt, [/^You MUST respond in caveman /m]);
		if (caveman) {
			parts.push(xmlBlock("before_agent_start", { source: "caveman" }, caveman));
			labels.push("caveman hook");
		}
	}

	if (parts.length === 0) return { labels };
	return {
		labels,
		text: xmlBlock(
			"forwarded_pi_context",
			{},
			[
				"The following content was explicitly enabled in pi-claude-bridge settings and comes from Pi prompt files or before_agent_start prompt hooks.",
				...parts,
			].join("\n\n"),
			false,
		),
	};
}

function escapeXmlAttr(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function escapeXmlText(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function xmlBlock(tag: string, attrs: Record<string, string>, content: string, escapeContent = true): string {
	const attrText = Object.entries(attrs)
		.map(([key, value]) => ` ${key}="${escapeXmlAttr(value)}"`)
		.join("");
	const body = escapeContent ? escapeXmlText(content.trim()) : content.trim();
	return `<${tag}${attrText}>\n${body}\n</${tag}>`;
}
