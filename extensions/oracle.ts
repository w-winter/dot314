/**
 * Oracle Extension - Get a second opinion from another AI model
 *
 * Usage:
 *   /oracle <prompt>              - Opens model picker, then queries
 *   /oracle -m gpt-4o <prompt>    - Direct to specific model
 *   /oracle -f file.ts <prompt>   - Include file(s) in context
 *
 * Stay on your main model (e.g., Claude Opus) and get tie-breaker opinions!
 */

import { completeSimple, type UserMessage, type Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import { BorderedLoader, convertToLlm, serializeConversation } from "@mariozechner/pi-coding-agent";
import { Text, matchesKey, visibleWidth } from "@mariozechner/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";

// Models to try - provider and model ID as used by pi's modelRegistry.find()
const ORACLE_MODELS = [
	// OpenAI
	// { provider: "openai", model: "gpt-4o", name: "GPT-4o" },
	// { provider: "openai", model: "gpt-4o-mini", name: "GPT-4o Mini" },
	// { provider: "openai", model: "gpt-4.1", name: "GPT-4.1" },
	// { provider: "openai", model: "gpt-4.1-mini", name: "GPT-4.1 Mini" },
	// { provider: "openai", model: "gpt-4.1-nano", name: "GPT-4.1 Nano" },
	// { provider: "openai", model: "o1", name: "o1" },
	// { provider: "openai", model: "o1-mini", name: "o1-mini" },
	// { provider: "openai", model: "o1-pro", name: "o1-pro" },
	// { provider: "openai", model: "o3-mini", name: "o3-mini" },
	// OpenAI Codex
	{ provider: "openai-codex", model: "gpt-5.2-codex", name: "GPT-5.2 Codex" },
	{ provider: "openai-codex", model: "gpt-5.2", name: "GPT-5.2" },
	// { provider: "openai-codex", model: "codex-mini", name: "Codex Mini" },
	// Google
	// { provider: "google", model: "gemini-2.0-flash", name: "Gemini 2.0 Flash" },
	// { provider: "google", model: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
	// { provider: "google", model: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
	{ provider: "google", model: "gemini-3-pro", name: "Gemini 3 Pro" },
	// Anthropic
	// { provider: "anthropic", model: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
	{ provider: "anthropic", model: "claude-opus-4-5", name: "Claude Opus 4.5" },
	// { provider: "anthropic", model: "claude-haiku-3-5", name: "Claude Haiku 3.5" },
] as const;

interface AvailableModel {
	provider: string;
	modelId: string;
	name: string;
	model: Model;
	apiKey: string;
}

// Thinking levels supported by pi-ai
type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

const THINKING_LEVELS: { level: ThinkingLevel; name: string; description: string }[] = [
	{ level: "minimal", name: "Minimal", description: "Quick, minimal reasoning" },
	{ level: "low", name: "Low", description: "Light reasoning" },
	{ level: "medium", name: "Medium", description: "Balanced reasoning (default)" },
	{ level: "high", name: "High", description: "Deep reasoning" },
	{ level: "xhigh", name: "X-High", description: "Maximum reasoning depth" },
];

// ANSI helpers
const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const magenta = (s: string) => `\x1b[35m${s}\x1b[0m`;

/**
 * Oracle result display with add to context option
 */
class OracleResultComponent {
	private result: string;
	private modelName: string;
	private prompt: string;
	private selected: number = 0; // 0 = Yes, 1 = No
	private scrollOffset: number = 0;
	private onDone: (addToContext: boolean) => void;
	private tui: { requestRender: () => void };
	private cachedLines: string[] = [];
	private cachedWidth = 0;

	constructor(
		result: string,
		modelName: string,
		prompt: string,
		tui: { requestRender: () => void },
		onDone: (addToContext: boolean) => void
	) {
		this.result = result;
		this.modelName = modelName;
		this.prompt = prompt;
		this.tui = tui;
		this.onDone = onDone;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || data === "n" || data === "N") {
			this.onDone(false);
			return;
		}

		if (matchesKey(data, "return") || matchesKey(data, "enter")) {
			this.onDone(this.selected === 0);
			return;
		}

		if (data === "y" || data === "Y") {
			this.onDone(true);
			return;
		}

		if (matchesKey(data, "left") || matchesKey(data, "right") || data === "h" || data === "l" || matchesKey(data, "tab")) {
			this.selected = this.selected === 0 ? 1 : 0;
			this.cachedWidth = 0;
			this.tui.requestRender();
		}

		// Scroll through result
		if (matchesKey(data, "up") || data === "k") {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
			this.cachedWidth = 0;
			this.tui.requestRender();
		} else if (matchesKey(data, "down") || data === "j") {
			this.scrollOffset++;
			this.cachedWidth = 0;
			this.tui.requestRender();
		}
	}

	invalidate(): void {
		this.cachedWidth = 0;
	}

	render(width: number): string[] {
		if (this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const boxWidth = Math.min(80, width - 4);
		const contentWidth = boxWidth - 4;
		const maxResultLines = 15;

		const padLine = (line: string): string => {
			const len = visibleWidth(line);
			return line + " ".repeat(Math.max(0, width - len));
		};

		const boxLine = (content: string): string => {
			const len = visibleWidth(content);
			const padding = Math.max(0, boxWidth - 2 - len);
			return dim("│ ") + content + " ".repeat(padding) + dim(" │");
		};

		// Wrap text to fit in box
		const wrapText = (text: string, maxWidth: number): string[] => {
			const wrapped: string[] = [];
			for (const paragraph of text.split("\n")) {
				if (paragraph.length <= maxWidth) {
					wrapped.push(paragraph);
				} else {
					let remaining = paragraph;
					while (remaining.length > maxWidth) {
						let breakPoint = remaining.lastIndexOf(" ", maxWidth);
						if (breakPoint === -1) breakPoint = maxWidth;
						wrapped.push(remaining.slice(0, breakPoint));
						remaining = remaining.slice(breakPoint + 1);
					}
					if (remaining) wrapped.push(remaining);
				}
			}
			return wrapped;
		};

		lines.push("");
		lines.push(padLine(dim("╭" + "─".repeat(boxWidth) + "╮")));
		lines.push(padLine(boxLine(bold(magenta(`🔮 Oracle Response (${this.modelName})`)))));
		lines.push(padLine(dim("├" + "─".repeat(boxWidth) + "┤")));

		// Show prompt
		const promptPreview = this.prompt.length > contentWidth - 10
			? this.prompt.slice(0, contentWidth - 13) + "..."
			: this.prompt;
		lines.push(padLine(boxLine(dim("Q: ") + promptPreview)));
		lines.push(padLine(dim("├" + "─".repeat(boxWidth) + "┤")));

		// Show result with scrolling
		const resultLines = wrapText(this.result, contentWidth);
		const visibleLines = resultLines.slice(this.scrollOffset, this.scrollOffset + maxResultLines);

		for (const line of visibleLines) {
			lines.push(padLine(boxLine(line)));
		}

		// Padding if result is short
		for (let i = visibleLines.length; i < Math.min(maxResultLines, 5); i++) {
			lines.push(padLine(boxLine("")));
		}

		// Scroll indicator
		if (resultLines.length > maxResultLines) {
			const scrollInfo = dim(` ↑↓ scroll (${this.scrollOffset + 1}-${Math.min(this.scrollOffset + maxResultLines, resultLines.length)}/${resultLines.length})`);
			lines.push(padLine(boxLine(scrollInfo)));
		}

		lines.push(padLine(dim("├" + "─".repeat(boxWidth) + "┤")));

		// Add to context prompt
		lines.push(padLine(boxLine(bold("Add to current conversation context?"))));
		lines.push(padLine(boxLine("")));

		// Buttons
		const yesBtn = this.selected === 0
			? green(bold(" [ YES ] "))
			: dim("   YES   ");
		const noBtn = this.selected === 1
			? yellow(bold(" [ NO ] "))
			: dim("   NO   ");

		const buttonLine = `       ${yesBtn}          ${noBtn}`;
		lines.push(padLine(boxLine(buttonLine)));
		lines.push(padLine(boxLine("")));

		lines.push(padLine(dim("├" + "─".repeat(boxWidth) + "┤")));
		lines.push(padLine(boxLine(dim("←→/Tab") + " switch  " + dim("Enter") + " confirm  " + dim("Y/N") + " quick")));
		lines.push(padLine(dim("╰" + "─".repeat(boxWidth) + "╯")));
		lines.push("");

		this.cachedLines = lines;
		this.cachedWidth = width;
		return lines;
	}
}

/**
 * Thinking level picker component
 */
class ThinkingLevelPickerComponent {
	private selected: number = 2; // Default to "medium"
	private modelName: string;
	private prompt: string;
	private onSelect: (level: ThinkingLevel) => void;
	private onCancel: () => void;
	private tui: { requestRender: () => void };
	private cachedLines: string[] = [];
	private cachedWidth = 0;

	constructor(
		modelName: string,
		prompt: string,
		tui: { requestRender: () => void },
		onSelect: (level: ThinkingLevel) => void,
		onCancel: () => void
	) {
		this.modelName = modelName;
		this.prompt = prompt;
		this.tui = tui;
		this.onSelect = onSelect;
		this.onCancel = onCancel;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || data === "q" || data === "Q") {
			this.onCancel();
			return;
		}

		if (matchesKey(data, "up") || data === "k") {
			this.selected = Math.max(0, this.selected - 1);
			this.cachedWidth = 0;
			this.tui.requestRender();
		} else if (matchesKey(data, "down") || data === "j") {
			this.selected = Math.min(THINKING_LEVELS.length - 1, this.selected + 1);
			this.cachedWidth = 0;
			this.tui.requestRender();
		} else if (matchesKey(data, "return") || matchesKey(data, "enter")) {
			this.onSelect(THINKING_LEVELS[this.selected].level);
		} else if (data >= "1" && data <= "5") {
			const idx = parseInt(data) - 1;
			if (idx < THINKING_LEVELS.length) {
				this.onSelect(THINKING_LEVELS[idx].level);
			}
		}
	}

	invalidate(): void {
		this.cachedWidth = 0;
	}

	render(width: number): string[] {
		if (this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const boxWidth = Math.min(60, width - 4);

		const padLine = (line: string): string => {
			const len = visibleWidth(line);
			return line + " ".repeat(Math.max(0, width - len));
		};

		const boxLine = (content: string): string => {
			const len = visibleWidth(content);
			const padding = Math.max(0, boxWidth - 2 - len);
			return dim("│ ") + content + " ".repeat(padding) + dim(" │");
		};

		lines.push("");
		lines.push(padLine(dim("╭" + "─".repeat(boxWidth) + "╮")));
		lines.push(padLine(boxLine(bold(magenta("🔮 Oracle - Thinking Level")))));
		lines.push(padLine(dim("├" + "─".repeat(boxWidth) + "┤")));

		// Model info
		lines.push(padLine(boxLine(dim("Model: ") + cyan(this.modelName))));

		// Prompt preview
		const maxPromptLen = boxWidth - 12;
		const promptPreview = this.prompt.length > maxPromptLen
			? this.prompt.slice(0, maxPromptLen - 3) + "..."
			: this.prompt;
		lines.push(padLine(boxLine(dim("Prompt: ") + promptPreview)));

		lines.push(padLine(dim("├" + "─".repeat(boxWidth) + "┤")));
		lines.push(padLine(boxLine(dim("↑↓/jk navigate • 1-5 quick select • Enter send"))));
		lines.push(padLine(boxLine("")));

		// Thinking level list
		for (let i = 0; i < THINKING_LEVELS.length; i++) {
			const t = THINKING_LEVELS[i];
			const num = yellow(`${i + 1}`);
			const pointer = i === this.selected ? green("❯ ") : "  ";
			const name = i === this.selected ? green(bold(t.name)) : t.name;
			const desc = dim(` - ${t.description}`);
			lines.push(padLine(boxLine(`${pointer}${num}. ${name}${desc}`)));
		}

		lines.push(padLine(boxLine("")));
		lines.push(padLine(dim("├" + "─".repeat(boxWidth) + "┤")));
		lines.push(padLine(boxLine(dim("Esc") + " cancel")));
		lines.push(padLine(dim("╰" + "─".repeat(boxWidth) + "╯")));
		lines.push("");

		this.cachedLines = lines;
		this.cachedWidth = width;
		return lines;
	}
}

/**
 * Simple model picker component
 */
class ModelPickerComponent {
	private models: AvailableModel[];
	private selected: number = 0;
	private prompt: string;
	private files: string[];
	private onSelect: (model: AvailableModel) => void;
	private onCancel: () => void;
	private tui: { requestRender: () => void };
	private cachedLines: string[] = [];
	private cachedWidth = 0;

	constructor(
		models: AvailableModel[],
		prompt: string,
		files: string[],
		tui: { requestRender: () => void },
		onSelect: (model: AvailableModel) => void,
		onCancel: () => void
	) {
		this.models = models;
		this.prompt = prompt;
		this.files = files;
		this.tui = tui;
		this.onSelect = onSelect;
		this.onCancel = onCancel;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || data === "q" || data === "Q") {
			this.onCancel();
			return;
		}

		if (matchesKey(data, "up") || data === "k") {
			this.selected = Math.max(0, this.selected - 1);
			this.cachedWidth = 0;
			this.tui.requestRender();
		} else if (matchesKey(data, "down") || data === "j") {
			this.selected = Math.min(this.models.length - 1, this.selected + 1);
			this.cachedWidth = 0;
			this.tui.requestRender();
		} else if (matchesKey(data, "return") || matchesKey(data, "enter")) {
			this.onSelect(this.models[this.selected]);
		} else if (data >= "1" && data <= "9") {
			const idx = parseInt(data) - 1;
			if (idx < this.models.length) {
				this.onSelect(this.models[idx]);
			}
		}
	}

	invalidate(): void {
		this.cachedWidth = 0;
	}

	render(width: number): string[] {
		if (this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const boxWidth = Math.min(60, width - 4);

		const padLine = (line: string): string => {
			const len = visibleWidth(line);
			return line + " ".repeat(Math.max(0, width - len));
		};

		const boxLine = (content: string): string => {
			const len = visibleWidth(content);
			const padding = Math.max(0, boxWidth - 2 - len);
			return dim("│ ") + content + " ".repeat(padding) + dim(" │");
		};

		lines.push("");
		lines.push(padLine(dim("╭" + "─".repeat(boxWidth) + "╮")));
		lines.push(padLine(boxLine(bold(magenta("🔮 Oracle - Second Opinion")))));
		lines.push(padLine(dim("├" + "─".repeat(boxWidth) + "┤")));

		// Prompt preview
		const maxPromptLen = boxWidth - 12;
		const promptPreview = this.prompt.length > maxPromptLen
			? this.prompt.slice(0, maxPromptLen - 3) + "..."
			: this.prompt;
		lines.push(padLine(boxLine(dim("Prompt: ") + promptPreview)));

		// Files
		if (this.files.length > 0) {
			const filesStr = this.files.map(f => cyan("@" + path.basename(f))).join(" ");
			lines.push(padLine(boxLine(dim("Files:  ") + filesStr)));
		}

		lines.push(padLine(dim("├" + "─".repeat(boxWidth) + "┤")));
		lines.push(padLine(boxLine(dim("↑↓/jk navigate • 1-9 quick select • Enter send"))));
		lines.push(padLine(boxLine("")));

		// Model list
		for (let i = 0; i < this.models.length; i++) {
			const m = this.models[i];
			const num = i < 9 ? yellow(`${i + 1}`) : " ";
			const pointer = i === this.selected ? green("❯ ") : "  ";
			const name = i === this.selected ? green(bold(m.name)) : m.name;
			const provider = dim(` (${m.provider})`);
			lines.push(padLine(boxLine(`${pointer}${num}. ${name}${provider}`)));
		}

		lines.push(padLine(boxLine("")));
		lines.push(padLine(dim("├" + "─".repeat(boxWidth) + "┤")));
		lines.push(padLine(boxLine(dim("Esc") + " cancel")));
		lines.push(padLine(dim("╰" + "─".repeat(boxWidth) + "╯")));
		lines.push("");

		this.cachedLines = lines;
		this.cachedWidth = width;
		return lines;
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("oracle", {
		description: "Get a second opinion from another AI model",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("oracle requires interactive mode", "error");
				return;
			}

			// Find available models (with API keys, excluding current)
			const availableModels: AvailableModel[] = [];

			for (const m of ORACLE_MODELS) {
				const model = ctx.modelRegistry.find(m.provider, m.model);
				if (!model) continue;

				// Skip current model - we want a DIFFERENT opinion
				if (ctx.model && model.id === ctx.model.id) continue;

				const apiKey = await ctx.modelRegistry.getApiKey(model);
				if (!apiKey) continue;

				availableModels.push({
					provider: m.provider,
					modelId: m.model,
					name: m.name,
					model,
					apiKey,
				});
			}

			if (availableModels.length === 0) {
				ctx.ui.notify("No alternative models available. Check API keys.", "error");
				return;
			}

			// Parse args
			const trimmedArgs = args?.trim() || "";
			if (!trimmedArgs) {
				ctx.ui.notify("Usage: /oracle <prompt> or /oracle -f file.ts <prompt>", "error");
				return;
			}

			let modelArg: string | undefined;
			const files: string[] = [];
			const promptParts: string[] = [];

			const tokens = trimmedArgs.split(/\s+/);
			let i = 0;
			while (i < tokens.length) {
				const token = tokens[i];
				if (token === "-m" || token === "--model") {
					i++;
					if (i < tokens.length) modelArg = tokens[i];
				} else if (token === "-f" || token === "--file") {
					i++;
					if (i < tokens.length) files.push(tokens[i]);
				} else {
					promptParts.push(...tokens.slice(i));
					break;
				}
				i++;
			}

			const prompt = promptParts.join(" ");
			if (!prompt) {
				ctx.ui.notify("No prompt provided", "error");
				return;
			}

			// If model specified directly, skip model picker
			if (modelArg) {
				const found = availableModels.find(
					(m) => m.modelId === modelArg ||
					       m.modelId.includes(modelArg!) ||
					       m.name.toLowerCase().includes(modelArg!.toLowerCase())
				);
				if (!found) {
					ctx.ui.notify(`Model "${modelArg}" not available`, "error");
					return;
				}

				// Show thinking level picker
				const thinkingLevel = await ctx.ui.custom<ThinkingLevel | null>((tui, _theme, _kb, done) => {
					const picker = new ThinkingLevelPickerComponent(
						found.name,
						prompt,
						tui,
						(level) => done(level),
						() => done(null)
					);

					return {
						render: (w) => picker.render(w),
						invalidate: () => picker.invalidate(),
						handleInput: (data) => picker.handleInput(data),
					};
				});

				if (!thinkingLevel) {
					ctx.ui.notify("Cancelled", "info");
					return;
				}

				await executeOracle(pi, ctx, prompt, files, found, thinkingLevel);
				return;
			}

			// Show model picker
			const selectedModel = await ctx.ui.custom<AvailableModel | null>((tui, _theme, _kb, done) => {
				const picker = new ModelPickerComponent(
					availableModels,
					prompt,
					files,
					tui,
					(model) => done(model),
					() => done(null)
				);

				return {
					render: (w) => picker.render(w),
					invalidate: () => picker.invalidate(),
					handleInput: (data) => picker.handleInput(data),
				};
			});

			if (!selectedModel) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			// Show thinking level picker
			const thinkingLevel = await ctx.ui.custom<ThinkingLevel | null>((tui, _theme, _kb, done) => {
				const picker = new ThinkingLevelPickerComponent(
					selectedModel.name,
					prompt,
					tui,
					(level) => done(level),
					() => done(null)
				);

				return {
					render: (w) => picker.render(w),
					invalidate: () => picker.invalidate(),
					handleInput: (data) => picker.handleInput(data),
				};
			});

			if (!thinkingLevel) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			await executeOracle(pi, ctx, prompt, files, selectedModel, thinkingLevel);
		},
	});

	// Custom renderer for oracle responses
	pi.registerMessageRenderer("oracle-response", (message, options, theme) => {
		const { expanded } = options;
		const details = message.details || {};

		let text = theme.fg("accent", `🔮 Oracle (${details.modelName || "unknown"}):\n\n`);
		text += message.content;

		if (expanded && details.files?.length > 0) {
			text += "\n\n" + theme.fg("dim", `Files: ${details.files.join(", ")}`);
		}

		return new Text(text, 0, 0);
	});
}

async function executeOracle(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	prompt: string,
	files: string[],
	model: AvailableModel,
	thinkingLevel: ThinkingLevel
): Promise<void> {
	// Get conversation context from current session
	const branch = ctx.sessionManager.getBranch();
	const messages = branch
		.filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message")
		.map((entry) => entry.message);

	let conversationContext = "";
	if (messages.length > 0) {
		const llmMessages = convertToLlm(messages);
		conversationContext = serializeConversation(llmMessages);
	}

	// Build context from files
	let fileContext = "";
	for (const file of files) {
		try {
			const fullPath = path.resolve(ctx.cwd, file);
			const content = fs.readFileSync(fullPath, "utf-8");
			fileContext += `\n\n--- File: ${file} ---\n${content}`;
		} catch (err) {
			fileContext += `\n\n--- File: ${file} ---\n[Error reading file: ${err}]`;
		}
	}

	// Build full prompt with conversation context
	let fullPrompt = "";
	if (conversationContext) {
		fullPrompt += `## Current Conversation Context\n\n${conversationContext}\n\n`;
	}
	fullPrompt += `## Question for Second Opinion\n\n${prompt}`;
	if (fileContext) {
		fullPrompt += `\n\n## Additional Files${fileContext}`;
	}

	// Call the model
	const thinkingLabel = THINKING_LEVELS.find(t => t.level === thinkingLevel)?.name || thinkingLevel;
	const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(tui, theme, `🔮 Asking ${model.name} (${thinkingLabel})...`);
		loader.onAbort = () => done(null);

		const doQuery = async () => {
			const userMessage: UserMessage = {
				role: "user",
				content: [{ type: "text", text: fullPrompt }],
				timestamp: Date.now(),
			};

			console.log(`[Oracle] Model: ${model.model.id}, API: ${model.model.api}, Reasoning: ${thinkingLevel}`);
			const response = await completeSimple(
				model.model,
				{
					systemPrompt: `You are providing a second opinion on a coding conversation.
You have access to the full conversation context between the user and their primary AI assistant.
Your job is to:
1. Understand what they've been discussing
2. Answer the specific question they're asking you
3. Point out if you disagree with any decisions made
4. Be concise but thorough

Focus on being helpful and providing a fresh perspective.`,
					messages: [userMessage],
				},
				{ apiKey: model.apiKey, signal: loader.signal, reasoning: thinkingLevel }
			);

			if (response.stopReason === "aborted") {
				return null;
			}

			let result = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");

			// // Check for thinking blocks
			// const thinkingBlocks = response.content.filter((c): c is { type: "thinking"; thinking: string } => c.type === "thinking");
			// const thinkingTokensUsed = thinkingBlocks.reduce((sum, b) => sum + (b.thinking?.length || 0), 0);

			// // Append thinking info for verification
			// result += `\n\n---\n **Thinking info:** Level=${thinkingLevel}, Blocks=${thinkingBlocks.length}, ~${Math.round(thinkingTokensUsed / 4)} thinking tokens`;

			return result;
		};

		doQuery()
			.then(done)
			.catch((err) => {
				console.error("Oracle error:", err);
				done(null);
			});

		return loader;
	});

	if (result === null) {
		ctx.ui.notify("Cancelled or failed", "warning");
		return;
	}

	// Show result and ask if user wants to add to context
	const displayName = `${model.name} (${thinkingLabel})`;
	const addToContext = await ctx.ui.custom<boolean>((tui, _theme, _kb, done) => {
		const component = new OracleResultComponent(
			result,
			displayName,
			prompt,
			tui,
			(add) => done(add)
		);

		return {
			render: (w) => component.render(w),
			invalidate: () => component.invalidate(),
			handleInput: (data) => component.handleInput(data),
		};
	});

	if (addToContext) {
		// Add Oracle's response to the conversation
		pi.sendMessage({
			customType: "oracle-response",
			content: result,
			display: true,
			details: {
				model: model.modelId,
				modelName: displayName,
				thinkingLevel,
				files,
				prompt,
			},
		});
		ctx.ui.notify(`Oracle response added to context`, "success");
	} else {
		ctx.ui.notify(`Oracle response discarded`, "info");
	}
}
