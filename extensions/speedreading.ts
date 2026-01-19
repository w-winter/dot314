/**
 * Speed Reading Extension - RSVP (Rapid Serial Visual Presentation) reader
 *
 * Based on Spritz technique: displays words one at a time with a focal point
 * (ORP - Optimal Recognition Point) highlighted for faster reading.
 *
 * Usage:
 *   /speedread <text>           - Speed read the provided text
 *   /speedread @path/to/file    - Speed read a file (supports ~/path)
 *   /speedread -f path/to/file  - Speed read a file (alternative syntax)
 *   /speedread -c               - Speed read from clipboard
 *   /speedread -l               - Speed read the last assistant message
 *   /speedread -wpm 400 <text>  - Set words per minute (default: 400)
 *   /speedread                  - Speed read last assistant message (default)
 */

import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import { matchesKey, visibleWidth, truncateToWidth } from "@mariozechner/pi-tui";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

const execAsync = promisify(exec);

// ANSI helpers
const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

// Big letter font (3 lines tall, using block characters)
const BIG_FONT: Record<string, string[]> = {
	a: ["▄▀▄", "█▀█", "▀ ▀"],
	b: ["█▀▄", "█▀▄", "▀▀ "],
	c: ["▄▀▀", "█  ", "▀▀▀"],
	d: ["█▀▄", "█ █", "▀▀ "],
	e: ["█▀▀", "█▀▀", "▀▀▀"],
	f: ["█▀▀", "█▀ ", "▀  "],
	g: ["▄▀▀", "█ █", "▀▀▀"],
	h: ["█ █", "█▀█", "▀ ▀"],
	i: ["▀█▀", " █ ", "▀▀▀"],
	j: ["  █", "  █", "▀▀ "],
	k: ["█ █", "█▀▄", "▀ ▀"],
	l: ["█  ", "█  ", "▀▀▀"],
	m: ["█▄█", "█ █", "▀ ▀"],
	n: ["█▀█", "█ █", "▀ ▀"],
	o: ["▄▀▄", "█ █", "▀▀▀"],
	p: ["█▀▄", "█▀ ", "▀  "],
	q: ["▄▀▄", "█ █", "▀▀█"],
	r: ["█▀▄", "█▀▄", "▀ ▀"],
	s: ["▄▀▀", "▀▀▄", "▀▀ "],
	t: ["▀█▀", " █ ", " ▀ "],
	u: ["█ █", "█ █", "▀▀▀"],
	v: ["█ █", "█ █", " ▀ "],
	w: ["█ █", "█ █", "▀▄▀"],
	x: ["█ █", " ▀ ", "█ █"],
	y: ["█ █", " █ ", " ▀ "],
	z: ["▀▀█", " █ ", "█▀▀"],
	"0": ["▄▀▄", "█ █", "▀▀▀"],
	"1": ["▄█ ", " █ ", "▀▀▀"],
	"2": ["▀▀█", "▄▀ ", "▀▀▀"],
	"3": ["▀▀█", " ▀█", "▀▀ "],
	"4": ["█ █", "▀▀█", "  ▀"],
	"5": ["█▀▀", "▀▀▄", "▀▀ "],
	"6": ["▄▀▀", "█▀▄", "▀▀ "],
	"7": ["▀▀█", "  █", "  ▀"],
	"8": ["▄▀▄", "█▀█", "▀▀▀"],
	"9": ["▄▀█", "▀▀█", "▀▀ "],
	" ": ["   ", "   ", "   "],
	".": ["   ", "   ", " ▀ "],
	",": ["   ", "   ", " ▄ "],
	"!": [" █ ", " █ ", " ▀ "],
	"?": ["▀▀█", " ▄ ", " ▀ "],
	"'": [" ▀ ", "   ", "   "],
	'"': ["▀ ▀", "   ", "   "],
	"-": ["   ", "▀▀▀", "   "],
	":": ["   ", " ▀ ", " ▀ "],
	";": ["   ", " ▀ ", " ▄ "],
	"(": [" ▄ ", "█  ", " ▀ "],
	")": ["▄  ", " █ ", "▀  "],
};

function renderBigWord(word: string, orpIndex: number): string[] {
	const lines = ["", "", ""];
	const chars = word.toLowerCase().split("");

	for (let i = 0; i < chars.length; i++) {
		const char = chars[i];
		const glyph = BIG_FONT[char] || ["???", "???", "???"];

		for (let row = 0; row < 3; row++) {
			if (i === orpIndex) {
				lines[row] += red(bold(glyph[row]));
			} else {
				lines[row] += bold(glyph[row]);
			}
		}
		// Space between characters
		for (let row = 0; row < 3; row++) {
			lines[row] += " ";
		}
	}

	return lines;
}

/**
 * Calculate the ORP (Optimal Recognition Point) for a word
 * This is the position where the eye should fixate for fastest recognition
 * Based on Spritz algorithm - roughly 1/3 into the word
 */
function getORP(word: string): number {
	// Strip punctuation for length calculation
	const cleanWord = word.replace(/[^\w]/g, "");
	const len = cleanWord.length;

	if (len <= 1) return 0;  // Single char: first
	if (len <= 2) return 0;  // 2 chars: first (e.g., "is" -> 'i')
	if (len <= 5) return 1;  // 3-5 chars: second (e.g., "the" -> 'h', "hello" -> 'e')
	if (len <= 9) return 2;  // 6-9 chars: third (e.g., "reading" -> 'a')
	if (len <= 13) return 3; // 10-13 chars: fourth
	return 4;                // 14+ chars: fifth
}

/**
 * Calculate display delay for a word based on complexity
 * Longer words and words with punctuation get more time
 */
function getWordDelay(word: string, baseDelay: number): number {
	let multiplier = 1.0;

	// Longer words need more time
	if (word.length > 8) multiplier += 0.3;
	if (word.length > 12) multiplier += 0.3;

	// Punctuation at end means pause
	if (/[.!?]$/.test(word)) multiplier += 0.8;
	if (/[,;:]$/.test(word)) multiplier += 0.4;

	// Numbers need more processing
	if (/\d/.test(word)) multiplier += 0.2;

	return Math.round(baseDelay * multiplier);
}

/**
 * Tokenize text into words, preserving punctuation
 */
function tokenizeText(text: string): string[] {
	// Clean up the text
	const cleaned = text
		.replace(/\s+/g, " ")
		.replace(/\n+/g, " ")
		.trim();

	return cleaned.split(" ").filter((w) => w.length > 0);
}

/**
 * Speed Reader TUI Component
 */
class SpeedReaderComponent {
	private words: string[];
	private currentIndex: number = 0;
	private isPaused: boolean = true;
	private wpm: number;
	private baseDelay: number;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private tui: { requestRender: () => void };
	private onDone: () => void;
	private cachedLines: string[] = [];
	private cachedWidth: number = 0;
	private startTime: number = 0;
	private wordsRead: number = 0;
	private bigFont: boolean = false;

	constructor(
		text: string,
		wpm: number,
		tui: { requestRender: () => void },
		onDone: () => void
	) {
		this.words = tokenizeText(text);
		this.wpm = wpm;
		this.baseDelay = Math.round(60000 / wpm);
		this.tui = tui;
		this.onDone = onDone;
	}

	start(): void {
		this.isPaused = false;
		this.startTime = Date.now();
		this.scheduleNext();
	}

	private scheduleNext(): void {
		if (this.isPaused || this.currentIndex >= this.words.length) {
			return;
		}

		const word = this.words[this.currentIndex];
		const delay = getWordDelay(word, this.baseDelay);

		this.timer = setTimeout(() => {
			this.currentIndex++;
			this.wordsRead++;
			this.cachedWidth = 0;
			this.tui.requestRender();

			if (this.currentIndex < this.words.length) {
				this.scheduleNext();
			}
		}, delay);
	}

	private togglePause(): void {
		this.isPaused = !this.isPaused;
		if (!this.isPaused) {
			this.scheduleNext();
		} else if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		this.cachedWidth = 0;
		this.tui.requestRender();
	}

	private adjustSpeed(delta: number): void {
		this.wpm = Math.max(50, Math.min(1000, this.wpm + delta));
		this.baseDelay = Math.round(60000 / this.wpm);
		this.cachedWidth = 0;
		this.tui.requestRender();
	}

	private seek(delta: number): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		this.currentIndex = Math.max(0, Math.min(this.words.length - 1, this.currentIndex + delta));
		this.cachedWidth = 0;
		this.tui.requestRender();
		if (!this.isPaused) {
			this.scheduleNext();
		}
	}

	private restart(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		this.currentIndex = 0;
		this.wordsRead = 0;
		this.startTime = Date.now();
		this.cachedWidth = 0;
		this.tui.requestRender();
		if (!this.isPaused) {
			this.scheduleNext();
		}
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || data === "q" || data === "Q") {
			if (this.timer) clearTimeout(this.timer);
			this.onDone();
			return;
		}

		if (matchesKey(data, "space") || data === " ") {
			this.togglePause();
			return;
		}

		// Speed controls
		if (matchesKey(data, "up") || data === "k" || data === "+") {
			this.adjustSpeed(25);
			return;
		}
		if (matchesKey(data, "down") || data === "j" || data === "-") {
			this.adjustSpeed(-25);
			return;
		}

		// Seek controls
		if (matchesKey(data, "left") || data === "h") {
			this.seek(-1);
			return;
		}
		if (matchesKey(data, "right") || data === "l") {
			this.seek(1);
			return;
		}

		// Jump controls
		if (data === "[") {
			this.seek(-10);
			return;
		}
		if (data === "]") {
			this.seek(10);
			return;
		}

		// Restart
		if (data === "r" || data === "R") {
			this.restart();
			return;
		}

		// Toggle big font
		if (data === "b" || data === "B") {
			this.bigFont = !this.bigFont;
			this.cachedWidth = 0;
			this.tui.requestRender();
			return;
		}

		// Start on enter if not started
		if ((matchesKey(data, "return") || matchesKey(data, "enter")) && this.isPaused && this.currentIndex === 0) {
			this.start();
			return;
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
		const boxWidth = Math.min(90, width - 4);

		// Truncate and pad line to exactly fit width
		const fitLine = (line: string): string => {
			const len = visibleWidth(line);
			if (len > width) {
				return truncateToWidth(line, width, "");
			}
			return line + " ".repeat(width - len);
		};

		// Get current word and format with ORP
		const currentWord = this.words[this.currentIndex] || "";
		const orp = getORP(currentWord);
		const boxCenter = Math.floor(boxWidth / 2);

		// Prepare word display lines (either big font or regular text)
		let wordLines: string[];

		if (this.bigFont) {
			// Render in big font (3 lines tall)
			const bigLines = currentWord ? renderBigWord(currentWord, orp) : ["", "", ""];

			// Each character in big font is 4 units wide (3 char + 1 space)
			const bigOrpCenter = orp * 4 + 1;
			const bigLeftPad = Math.max(0, boxCenter - bigOrpCenter);

			wordLines = bigLines.map(line => " ".repeat(bigLeftPad) + line);
		} else {
			// Regular text display
			let wordDisplay = "";
			if (currentWord) {
				const leftPadding = Math.max(0, boxCenter - orp);

				for (let i = 0; i < currentWord.length; i++) {
					if (i === orp) {
						wordDisplay += red(bold(currentWord[i]));
					} else {
						wordDisplay += bold(currentWord[i]);
					}
				}

				wordDisplay = " ".repeat(leftPadding) + wordDisplay;
			}
			wordLines = [wordDisplay];
		}

		// Progress calculation
		const progress = this.words.length > 0 ? this.currentIndex / this.words.length : 0;
		const progressBarWidth = boxWidth - 4;
		const filledWidth = Math.round(progress * progressBarWidth);

		// Guide lines point to the center (where ORP aligns)
		const guideOffset = boxCenter;

		// Build the Spritz-style UI
		lines.push("");
		lines.push("");

		// Top border with rounded corners
		lines.push(fitLine(dim("  ╭" + "─".repeat(boxWidth) + "╮")));

		// Empty space above
		lines.push(fitLine(dim("  │") + " ".repeat(boxWidth) + dim("│")));
		lines.push(fitLine(dim("  │") + " ".repeat(boxWidth) + dim("│")));

		// Upper guide line - vertical tick at ORP
		const upperGuide = " ".repeat(guideOffset) + dim("│");
		const upperGuidePadded = upperGuide + " ".repeat(Math.max(0, boxWidth - visibleWidth(upperGuide)));
		lines.push(fitLine(dim("  │") + upperGuidePadded + dim("│")));

		// Horizontal separator with gap at ORP pivot
		const leftSep = "─".repeat(guideOffset);
		const rightSep = "─".repeat(Math.max(0, boxWidth - guideOffset - 1));
		lines.push(fitLine(dim("  ├" + leftSep + "┼" + rightSep + "┤")));

		// The word display (1 or 3 lines depending on mode)
		for (const wordLine of wordLines) {
			// Truncate word line if it exceeds box width
			const truncatedWord = visibleWidth(wordLine) > boxWidth
				? truncateToWidth(wordLine, boxWidth, "")
				: wordLine;
			const linePadded = truncatedWord + " ".repeat(Math.max(0, boxWidth - visibleWidth(truncatedWord)));
			lines.push(fitLine(dim("  │") + linePadded + dim("│")));
		}

		// Lower horizontal separator
		lines.push(fitLine(dim("  ├" + leftSep + "┼" + rightSep + "┤")));

		// Lower guide line
		const lowerGuide = " ".repeat(guideOffset) + dim("│");
		const lowerGuidePadded = lowerGuide + " ".repeat(Math.max(0, boxWidth - visibleWidth(lowerGuide)));
		lines.push(fitLine(dim("  │") + lowerGuidePadded + dim("│")));

		// Empty space below
		lines.push(fitLine(dim("  │") + " ".repeat(boxWidth) + dim("│")));

		// Progress bar line
		const progressBar = "─".repeat(filledWidth) + dim("─".repeat(progressBarWidth - filledWidth));
		const wpmDisplay = dim(`${this.wpm} wpm`);
		const progressLine = "  " + progressBar + "  " + wpmDisplay;
		const truncatedProgress = visibleWidth(progressLine) > boxWidth
			? truncateToWidth(progressLine, boxWidth, "")
			: progressLine;
		const progressLinePadded = truncatedProgress + " ".repeat(Math.max(0, boxWidth - visibleWidth(truncatedProgress)));
		lines.push(fitLine(dim("  │") + progressLinePadded + dim("│")));

		// Bottom border
		lines.push(fitLine(dim("  ╰" + "─".repeat(boxWidth) + "╯")));

		// Status and controls below the box
		lines.push("");

		const status = this.isPaused
			? this.currentIndex === 0
				? yellow("  ▶ Press SPACE to start")
				: yellow("  ⏸ PAUSED") + dim(` - ${this.currentIndex + 1}/${this.words.length}`)
			: dim(`  ▶ ${this.currentIndex + 1}/${this.words.length}`);
		lines.push(fitLine(status));

		lines.push("");
		// Use shorter help text for narrow terminals
		const helpFull = dim("  SPACE") + " play/pause  " +
			dim("←→") + " ±1  " +
			dim("[]") + " ±10  " +
			dim("↑↓") + " speed  " +
			dim("B") + " big font  " +
			dim("R") + " restart  " +
			dim("Q") + " quit";
		const helpShort = dim("  SPC") + " play  " +
			dim("←→") + " seek  " +
			dim("↑↓") + " speed  " +
			dim("Q") + " quit";
		const helpText = width > 80 ? helpFull : helpShort;
		lines.push(fitLine(helpText));
		lines.push("");

		this.cachedLines = lines;
		this.cachedWidth = width;
		return lines;
	}
}

async function getClipboardContent(): Promise<string> {
	try {
		const { stdout } = await execAsync("pbpaste");
		return stdout;
	} catch {
		throw new Error("Failed to read clipboard");
	}
}

/**
 * Expand ~ to home directory and resolve path
 */
function expandPath(filepath: string): string {
	if (filepath.startsWith("~/")) {
		return resolve(homedir(), filepath.slice(2));
	}
	if (filepath.startsWith("~")) {
		return resolve(homedir(), filepath.slice(1));
	}
	return resolve(filepath);
}

/**
 * Read file content, supporting @ prefix and ~ expansion
 */
async function readFileContent(filepath: string): Promise<string> {
	// Remove @ prefix if present
	const cleanPath = filepath.startsWith("@") ? filepath.slice(1) : filepath;
	const fullPath = expandPath(cleanPath);

	if (!existsSync(fullPath)) {
		throw new Error(`File not found: ${fullPath}`);
	}

	const content = await readFile(fullPath, "utf-8");
	return content;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("speedread", {
		description: "Speed read text using RSVP (Spritz-style)",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("speedread requires interactive mode", "error");
				return;
			}

			let text = "";
			let wpm = 400;

			// Parse arguments
			const tokens = (args?.trim() || "").split(/\s+/);
			const textParts: string[] = [];
			let i = 0;

			while (i < tokens.length) {
				const token = tokens[i];

				if (token === "-c" || token === "--clipboard") {
					try {
						text = await getClipboardContent();
					} catch (err) {
						ctx.ui.notify("Failed to read clipboard", "error");
						return;
					}
					i++;
					continue;
				}

				if (token === "-l" || token === "--last") {
					// Get last assistant message
					const branch = ctx.sessionManager.getBranch();
					const messages = branch.filter(
						(entry): entry is SessionEntry & { type: "message" } =>
							entry.type === "message" && entry.message.role === "assistant"
					);
					const lastMsg = messages[messages.length - 1];
					if (lastMsg) {
						const content = lastMsg.message.content;
						if (typeof content === "string") {
							text = content;
						} else if (Array.isArray(content)) {
							text = content
								.filter((c): c is { type: "text"; text: string } => c.type === "text")
								.map((c) => c.text)
								.join("\n");
						}
					}
					if (!text) {
						ctx.ui.notify("No assistant message found", "error");
						return;
					}
					i++;
					continue;
				}

				if (token === "-f" || token === "--file") {
					i++;
					if (i < tokens.length) {
						try {
							text = await readFileContent(tokens[i]);
						} catch (err) {
							ctx.ui.notify(`Failed to read file: ${err instanceof Error ? err.message : String(err)}`, "error");
							return;
						}
					}
					i++;
					continue;
				}

				// Handle @filepath syntax (e.g., @./file.md or @~/file.md)
				if (token.startsWith("@") && token.length > 1) {
					try {
						text = await readFileContent(token);
					} catch (err) {
						ctx.ui.notify(`Failed to read file: ${err instanceof Error ? err.message : String(err)}`, "error");
						return;
					}
					i++;
					continue;
				}

				if (token === "-wpm" || token === "--wpm") {
					i++;
					if (i < tokens.length) {
						const parsed = parseInt(tokens[i], 10);
						if (!isNaN(parsed) && parsed > 0) {
							wpm = Math.max(50, Math.min(1000, parsed));
						}
					}
					i++;
					continue;
				}

				// Everything else is text
				textParts.push(...tokens.slice(i));
				break;
			}

			// If text not from flags, use arguments
			if (!text && textParts.length > 0) {
				text = textParts.join(" ");
			}

			// Default: use last assistant message if no text provided
			if (!text) {
				const branch = ctx.sessionManager.getBranch();
				const messages = branch.filter(
					(entry): entry is SessionEntry & { type: "message" } =>
						entry.type === "message" && entry.message.role === "assistant"
				);
				const lastMsg = messages[messages.length - 1];
				if (lastMsg) {
					const content = lastMsg.message.content;
					if (typeof content === "string") {
						text = content;
					} else if (Array.isArray(content)) {
						text = content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text)
							.join("\n");
					}
				}
				if (!text) {
					ctx.ui.notify("No assistant message found", "error");
					return;
				}
			}

			const words = tokenizeText(text);
			if (words.length === 0) {
				ctx.ui.notify("No words to display", "error");
				return;
			}

			// Show speed reader TUI
			await ctx.ui.custom<void>((tui, _theme, _kb, done) => {
				const reader = new SpeedReaderComponent(text, wpm, tui, () => done());

				return {
					render: (w) => reader.render(w),
					invalidate: () => reader.invalidate(),
					handleInput: (data) => reader.handleInput(data),
				};
			});

			ctx.ui.notify(`Speed reading complete (${words.length} words)`, "success");
		},
	});

	pi.registerShortcut("ctrl+r", {
		description: "Speed read last assistant message",
		handler: async (ctx) => {
			// Trigger the command with -l flag
			const handler = pi.getCommand("speedread")?.handler;
			if (handler) {
				await handler("-l", ctx);
			}
		},
	});
}
