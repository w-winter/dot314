/**
 * pi-skill-palette
 *
 * A VS Code/Amp-style command palette for quickly selecting and applying skills.
 * Usage: /skill - Opens the skill picker overlay
 *
 * When a skill is selected, it's queued and the skill content is sent
 * alongside your next message automatically.
 *
 * https://github.com/nicobailon/pi-skill-palette
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { matchesKey, Container, Text } from "@mariozechner/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

interface Skill {
	name: string;
	description: string;
	filePath: string;
}

interface SkillPaletteState {
	queuedSkill: Skill | null;
}

// Shared state across the extension
const state: SkillPaletteState = {
	queuedSkill: null,
};

// ═══════════════════════════════════════════════════════════════════════════
// Theming
// ═══════════════════════════════════════════════════════════════════════════

interface PaletteTheme {
	border: string;        // Box borders
	title: string;         // Title text
	selected: string;      // Selected item highlight
	selectedText: string;  // Selected item text
	queued: string;        // Queued badge
	searchIcon: string;    // Search icon
	placeholder: string;   // Placeholder text
	description: string;   // Skill descriptions
	hint: string;          // Footer hints
	confirm: string;       // Confirm button (keep)
	cancel: string;        // Cancel button (remove)
}

const DEFAULT_THEME: PaletteTheme = {
	border: "2",           // dim
	title: "2",            // dim
	selected: "36",        // cyan
	selectedText: "36",    // cyan
	queued: "32",          // green
	searchIcon: "2",       // dim
	placeholder: "2;3",    // dim italic
	description: "2",      // dim
	hint: "2",             // dim
	confirm: "32",         // green
	cancel: "31",          // red
};

function loadTheme(): PaletteTheme {
	const configPath = path.join(os.homedir(), ".pi", "agent", "extensions", "pi-skill-palette", "theme.json");
	try {
		if (fs.existsSync(configPath)) {
			const content = fs.readFileSync(configPath, "utf-8");
			const custom = JSON.parse(content) as Partial<PaletteTheme>;
			return { ...DEFAULT_THEME, ...custom };
		}
	} catch {
		// Ignore errors, use default
	}
	return DEFAULT_THEME;
}

function fg(code: string, text: string): string {
	if (!code) return text;
	// Handle compound codes like "2;3" (dim + italic)
	return `\x1b[${code}m${text}\x1b[0m`;
}

// Rainbow colors (matching powerline-footer thinking:high)
const RAINBOW_COLORS = [
	"38;2;178;129;214",  // #b281d6 purple
	"38;2;215;135;175",  // #d787af pink
	"38;2;254;188;56",   // #febc38 orange
	"38;2;228;192;15",   // #e4c00f yellow
	"38;2;137;210;129",  // #89d281 green
	"38;2;0;175;175",    // #00afaf cyan
	"38;2;23;143;185",   // #178fb9 blue
];

// Render spaced rainbow progress dots
function rainbowProgress(filled: number, total: number): string {
	const dots: string[] = [];
	for (let i = 0; i < total; i++) {
		const color = RAINBOW_COLORS[i % RAINBOW_COLORS.length];
		const dot = i < filled ? "●" : "○";
		dots.push(fg(color, dot));
	}
	return dots.join(" ");
}

// Load theme once at startup
const paletteTheme = loadTheme();

type SkillFormat = "recursive" | "claude";

interface SkillDirConfig {
	dir: string;
	format: SkillFormat;
}

/**
 * Scan a directory for skills based on the format
 * - "recursive": scans directories recursively looking for SKILL.md files
 * - "claude": only scans one level deep (directories directly containing SKILL.md)
 */
function scanSkillDir(
	dir: string,
	format: SkillFormat,
	skillsByName: Map<string, Skill>,
	visitedDirs?: Set<string>
): void {
	if (!fs.existsSync(dir)) return;

	// Track visited directories by realpath to detect symlink cycles
	const visited = visitedDirs ?? new Set<string>();
	let realDir: string;
	try {
		realDir = fs.realpathSync(dir);
	} catch {
		realDir = dir;
	}
	if (visited.has(realDir)) return;
	visited.add(realDir);

	try {
		const entries = fs.readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			if (entry.name === "node_modules") continue;

			const entryPath = path.join(dir, entry.name);

			// Handle symlinks
			let isDirectory = entry.isDirectory();
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					const stats = fs.statSync(entryPath);
					isDirectory = stats.isDirectory();
					isFile = stats.isFile();
				} catch {
					continue; // Broken symlink
				}
			}

			if (format === "recursive") {
				// Recursive format: scan directories, look for SKILL.md files anywhere
				if (isDirectory) {
					scanSkillDir(entryPath, format, skillsByName, visited);
				} else if (isFile && entry.name === "SKILL.md") {
					loadSkillFromFile(entryPath, skillsByName);
				}
			} else if (format === "claude") {
				// Claude format: only one level deep, each directory must contain SKILL.md
				if (!isDirectory) continue;

				const skillFile = path.join(entryPath, "SKILL.md");
				if (!fs.existsSync(skillFile)) continue;

				loadSkillFromFile(skillFile, skillsByName);
			}
		}
	} catch {
		// Skip inaccessible directories
	}
}

/**
 * Load a single skill from a SKILL.md file
 */
function loadSkillFromFile(filePath: string, skillsByName: Map<string, Skill>): void {
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		const skillDir = path.dirname(filePath);
		const parentDirName = path.basename(skillDir);
		const { name, description } = parseFrontmatter(content, parentDirName);
		
		if (description && !skillsByName.has(name)) {
			// First occurrence wins (earlier sources take precedence)
			skillsByName.set(name, {
				name,
				description,
				filePath,
			});
		}
	} catch {
		// Skip invalid skill files
	}
}

/**
 * Load skills from known directories
 * Matches pi's skill loading order:
 * 1. ~/.codex/skills (recursive)
 * 2. ~/.claude/skills (claude format - one level)
 * 3. ${cwd}/.claude/skills (claude format - one level)
 * 4. ~/.pi/agent/skills (recursive)
 * 5. ${cwd}/.pi/skills (recursive)
 */
function loadSkills(): Skill[] {
	const skillsByName = new Map<string, Skill>();
	
	const skillDirs: SkillDirConfig[] = [
		{ dir: path.join(os.homedir(), ".codex", "skills"), format: "recursive" },
		{ dir: path.join(os.homedir(), ".claude", "skills"), format: "claude" },
		{ dir: path.join(process.cwd(), ".claude", "skills"), format: "claude" },
		{ dir: path.join(os.homedir(), ".pi", "agent", "skills"), format: "recursive" },
		{ dir: path.join(os.homedir(), ".pi", "skills"), format: "recursive" },
		{ dir: path.join(process.cwd(), ".pi", "skills"), format: "recursive" },
	];

	for (const { dir, format } of skillDirs) {
		scanSkillDir(dir, format, skillsByName);
	}

	// Sort alphabetically by name
	return Array.from(skillsByName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Parse frontmatter from skill file
 */
function parseFrontmatter(content: string, fallbackName: string): { name: string; description: string } {
	if (!content.startsWith("---")) {
		return { name: fallbackName, description: "" };
	}

	const endIndex = content.indexOf("\n---", 3);
	if (endIndex === -1) {
		return { name: fallbackName, description: "" };
	}

	const frontmatter = content.slice(4, endIndex);
	let name = fallbackName;
	let description = "";

	for (const line of frontmatter.split("\n")) {
		const colonIndex = line.indexOf(":");
		if (colonIndex === -1) continue;

		const key = line.slice(0, colonIndex).trim();
		const value = line.slice(colonIndex + 1).trim();

		if (key === "name") name = value;
		if (key === "description") description = value;
	}

	return { name, description };
}

/**
 * Get skill content without frontmatter
 */
function getSkillContent(skill: Skill): string {
	const raw = fs.readFileSync(skill.filePath, "utf-8");
	if (!raw.startsWith("---")) return raw;

	const endIndex = raw.indexOf("\n---", 3);
	if (endIndex === -1) return raw;

	return raw.slice(endIndex + 4).trim();
}

/**
 * Simple fuzzy match scoring
 */
function fuzzyScore(query: string, text: string): number {
	const lowerQuery = query.toLowerCase();
	const lowerText = text.toLowerCase();

	if (lowerText.includes(lowerQuery)) {
		return 100 + (lowerQuery.length / lowerText.length) * 50;
	}

	let score = 0;
	let queryIndex = 0;
	let consecutiveBonus = 0;

	for (let i = 0; i < lowerText.length && queryIndex < lowerQuery.length; i++) {
		if (lowerText[i] === lowerQuery[queryIndex]) {
			score += 10 + consecutiveBonus;
			consecutiveBonus += 5;
			queryIndex++;
		} else {
			consecutiveBonus = 0;
		}
	}

	return queryIndex === lowerQuery.length ? score : 0;
}

/**
 * Filter and sort skills by fuzzy match
 */
function filterSkills(skills: Skill[], query: string): Skill[] {
	if (!query.trim()) return skills;

	const scored = skills
		.map((skill) => ({
			skill,
			score: Math.max(
				fuzzyScore(query, skill.name),
				fuzzyScore(query, skill.description) * 0.8
			),
		}))
		.filter((item) => item.score > 0)
		.sort((a, b) => b.score - a.score);

	return scored.map((item) => item.skill);
}

/**
 * Confirmation Dialog Component
 */
class ConfirmDialog {
	readonly width = 44;
	private selected = 1; // 0 = Remove, 1 = Keep (default to Keep)
	private timeoutId: ReturnType<typeof setTimeout> | null = null;
	private remainingSeconds = 30;
	private intervalId: ReturnType<typeof setInterval> | null = null;
	private requestRender: (() => void) | null = null;

	constructor(
		private skillName: string,
		private done: (confirmed: boolean) => void
	) {
		this.timeoutId = setTimeout(() => {
			this.cleanup();
			this.done(false);
		}, 30000);
	}

	/** Call after construction to start the countdown timer */
	setRequestRender(fn: () => void): void {
		this.requestRender = fn;
		// Start interval now that we can trigger re-renders
		this.intervalId = setInterval(() => {
			if (this.remainingSeconds > 0) {
				this.remainingSeconds--;
				this.requestRender?.();
			}
		}, 1000);
	}

	private cleanup(): void {
		if (this.timeoutId) clearTimeout(this.timeoutId);
		if (this.intervalId) clearInterval(this.intervalId);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.cleanup();
			this.done(false);
			return;
		}

		if (matchesKey(data, "return")) {
			this.cleanup();
			this.done(this.selected === 0);
			return;
		}

		if (matchesKey(data, "left") || matchesKey(data, "right") || matchesKey(data, "tab")) {
			this.selected = this.selected === 0 ? 1 : 0;
			return;
		}

		if (data === "y" || data === "Y") {
			this.cleanup();
			this.done(true);
			return;
		}

		if (data === "n" || data === "N") {
			this.cleanup();
			this.done(false);
			return;
		}
	}

	render(width: number): string[] {
		const w = Math.min(this.width, width - 4);
		const innerW = w - 2;
		const lines: string[] = [];

		// Theme-aware color helpers
		const t = paletteTheme;
		const border = (s: string) => fg(t.border, s);
		const title = (s: string) => fg(t.title, s);
		const selected = (s: string) => fg(t.selected, s);
		const confirm = (s: string) => fg(t.confirm, s);
		const cancel = (s: string) => fg(t.cancel, s);
		const hint = (s: string) => fg(t.hint, s);
		const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
		const italic = (s: string) => `\x1b[3m${s}\x1b[23m`;
		const inverse = (s: string) => `\x1b[7m${s}\x1b[27m`;

		const visLen = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;

		const pad = (s: string, len: number) => {
			return s + " ".repeat(Math.max(0, len - visLen(s)));
		};

		const center = (s: string, len: number) => {
			const padding = Math.max(0, len - visLen(s));
			const left = Math.floor(padding / 2);
			return " ".repeat(left) + s + " ".repeat(padding - left);
		};

		const row = (content: string) => border("│") + pad(" " + content, innerW) + border("│");
		const centerRow = (content: string) => border("│") + center(content, innerW) + border("│");
		const emptyRow = () => border("│") + " ".repeat(innerW) + border("│");

		// Top border with title
		const titleText = " Unqueue Skill ";
		const borderLen = innerW - visLen(titleText);
		const leftBorder = Math.floor(borderLen / 2);
		const rightBorder = borderLen - leftBorder;
		lines.push(border("╭" + "─".repeat(leftBorder)) + title(titleText) + border("─".repeat(rightBorder) + "╮"));

		lines.push(emptyRow());
		
		// Skill name with icon
		lines.push(centerRow(`${selected("◆")} ${bold(this.skillName)}`));
		
		lines.push(emptyRow());

		// Divider
		lines.push(border("├" + "─".repeat(innerW) + "┤"));
		
		lines.push(emptyRow());

		// Buttons - pill style with inverse for selection
		const removeLabel = "  Remove  ";
		const keepLabel = "  Keep  ";
		
		const removeBtn = this.selected === 0 
			? inverse(bold(cancel(removeLabel)))
			: hint(removeLabel);
		const keepBtn = this.selected === 1 
			? inverse(bold(confirm(keepLabel)))
			: hint(keepLabel);
		
		lines.push(centerRow(`${removeBtn}   ${keepBtn}`));

		lines.push(emptyRow());

		// Timeout - rainbow progress indicator
		const prog = Math.max(0, Math.min(10, Math.round((this.remainingSeconds / 30) * 10)));
		const progressBar = rainbowProgress(prog, 10);
		lines.push(centerRow(`${progressBar}  ${hint(`${this.remainingSeconds}s`)}`));

		lines.push(emptyRow());

		// Footer hints - minimal
		lines.push(centerRow(hint(italic("tab") + " switch  " + italic("enter") + " confirm  " + italic("esc") + " cancel")));

		// Bottom border
		lines.push(border(`╰${"─".repeat(innerW)}╯`));

		return lines;
	}

	invalidate(): void {}
	
	dispose(): void {
		this.cleanup();
	}
}

/**
 * Skill Palette Overlay Component
 */
class SkillPaletteComponent {
	readonly width = 70;
	private allSkills: Skill[];
	private filtered: Skill[];
	private selected = 0;
	private query = "";
	private queuedSkillName: string | null;
	private inactivityTimeout: ReturnType<typeof setTimeout> | null = null;
	private static readonly INACTIVITY_MS = 60000; // Auto-dismiss after 60s of no input

	constructor(
		skills: Skill[],
		queuedSkill: Skill | null,
		private done: (skill: Skill | null, action: "select" | "unqueue" | "cancel") => void
	) {
		this.allSkills = skills;
		this.filtered = skills;
		this.queuedSkillName = queuedSkill?.name ?? null;
		this.resetInactivityTimeout();
	}

	private resetInactivityTimeout(): void {
		if (this.inactivityTimeout) clearTimeout(this.inactivityTimeout);
		this.inactivityTimeout = setTimeout(() => {
			this.cleanup();
			this.done(null, "cancel");
		}, SkillPaletteComponent.INACTIVITY_MS);
	}

	handleInput(data: string): void {
		this.resetInactivityTimeout(); // Reset on any input

		if (matchesKey(data, "escape")) {
			this.cleanup();
			this.done(null, "cancel");
			return;
		}

		if (matchesKey(data, "return")) {
			const skill = this.filtered[this.selected];
			if (skill) {
				this.cleanup();
				// Toggle: if already queued, unqueue it
				if (skill.name === this.queuedSkillName) {
					this.done(skill, "unqueue");
				} else {
					this.done(skill, "select");
				}
			}
			return;
		}

		if (matchesKey(data, "up")) {
			if (this.filtered.length > 0) {
				this.selected = this.selected === 0 ? this.filtered.length - 1 : this.selected - 1;
			}
			return;
		}

		if (matchesKey(data, "down")) {
			if (this.filtered.length > 0) {
				this.selected = this.selected === this.filtered.length - 1 ? 0 : this.selected + 1;
			}
			return;
		}

		if (matchesKey(data, "backspace")) {
			if (this.query.length > 0) {
				this.query = this.query.slice(0, -1);
				this.updateFilter();
			}
			return;
		}

		// Printable character
		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.query += data;
			this.updateFilter();
		}
	}

	private updateFilter(): void {
		this.filtered = filterSkills(this.allSkills, this.query);
		this.selected = 0; // Always jump to top match when typing
	}

	render(width: number): string[] {
		const w = Math.min(this.width, width - 4);
		const innerW = w - 2;
		const lines: string[] = [];

		// Theme-aware color helpers
		const t = paletteTheme;
		const border = (s: string) => fg(t.border, s);
		const title = (s: string) => fg(t.title, s);
		const selected = (s: string) => fg(t.selected, s);
		const selectedText = (s: string) => fg(t.selectedText, s);
		const queued = (s: string) => fg(t.queued, s);
		const searchIcon = (s: string) => fg(t.searchIcon, s);
		const placeholder = (s: string) => fg(t.placeholder, s);
		const description = (s: string) => fg(t.description, s);
		const hint = (s: string) => fg(t.hint, s);
		const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
		const italic = (s: string) => `\x1b[3m${s}\x1b[23m`;

		const visLen = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;

		const pad = (s: string, len: number) => {
			return s + " ".repeat(Math.max(0, len - visLen(s)));
		};

		const truncate = (s: string, maxLen: number) => {
			if (s.length <= maxLen) return s;
			return s.slice(0, maxLen - 1) + "…";
		};

		const row = (content: string) => border("│") + pad(" " + content, innerW) + border("│");
		const emptyRow = () => border("│") + " ".repeat(innerW) + border("│");

		// Top border with title
		const titleText = " Skills ";
		const borderLen = innerW - visLen(titleText);
		const leftBorder = Math.floor(borderLen / 2);
		const rightBorder = borderLen - leftBorder;
		lines.push(border("╭" + "─".repeat(leftBorder)) + title(titleText) + border("─".repeat(rightBorder) + "╮"));

		lines.push(emptyRow());

		// Search input - clean underlined style
		const cursor = selected("│");
		const searchIconChar = searchIcon("◎");
		const queryDisplay = this.query || placeholder(italic("type to filter..."));
		lines.push(row(`${searchIconChar}  ${queryDisplay}${cursor}`));

		lines.push(emptyRow());

		// Divider
		lines.push(border("├" + "─".repeat(innerW) + "┤"));

		// Skills list
		const maxVisible = 8;
		const startIndex = Math.max(0, Math.min(this.selected - Math.floor(maxVisible / 2), this.filtered.length - maxVisible));
		const endIndex = Math.min(startIndex + maxVisible, this.filtered.length);

		if (this.filtered.length === 0) {
			lines.push(emptyRow());
			lines.push(row(hint(italic("No matching skills"))));
			lines.push(emptyRow());
		} else {
			lines.push(emptyRow());
			for (let i = startIndex; i < endIndex; i++) {
				const skill = this.filtered[i];
				const isSelected = i === this.selected;
				const isQueued = skill.name === this.queuedSkillName;
				
				// Build the skill line
				const prefix = isSelected ? selected("▸") : border("·");
				const queuedBadge = isQueued ? ` ${queued("●")}` : "";
				const nameStr = isSelected ? bold(selectedText(skill.name)) : skill.name;
				const maxDescLen = Math.max(0, innerW - visLen(skill.name) - 12);
				const descStr = maxDescLen > 3 ? description(truncate(skill.description, maxDescLen)) : "";
				
				const separator = descStr ? `  ${border("—")}  ` : "";
				const skillLine = `${prefix} ${nameStr}${queuedBadge}${separator}${descStr}`;
				lines.push(row(skillLine));
			}
			lines.push(emptyRow());

			// Scroll position indicator - rainbow dots
			if (this.filtered.length > maxVisible) {
				const prog = Math.round(((this.selected + 1) / this.filtered.length) * 10);
				const progressBar = rainbowProgress(prog, 10);
				const countStr = `${this.selected + 1}/${this.filtered.length}`;
				lines.push(row(`${progressBar}  ${hint(countStr)}`));
				lines.push(emptyRow());
			}
		}

		// Divider
		lines.push(border("├" + "─".repeat(innerW) + "┤"));

		lines.push(emptyRow());

		// Footer hints - minimal and elegant
		const hints = this.queuedSkillName 
			? `${italic("↑↓")} navigate  ${italic("enter")} select${hint("/")}unqueue  ${italic("esc")} cancel`
			: `${italic("↑↓")} navigate  ${italic("enter")} select  ${italic("esc")} cancel`;
		lines.push(row(hint(hints)));

		// Bottom border
		lines.push(border(`╰${"─".repeat(innerW)}╯`));

		return lines;
	}

	private cleanup(): void {
		if (this.inactivityTimeout) {
			clearTimeout(this.inactivityTimeout);
			this.inactivityTimeout = null;
		}
	}

	invalidate(): void {}
	
	dispose(): void {
		this.cleanup();
	}
}

export default function skillPaletteExtension(pi: ExtensionAPI): void {
	// Register custom renderer for skill-context messages
	pi.registerMessageRenderer("skill-context", (message, options, theme) => {
		// Extract skill name and content (handle both string and array content)
		const rawContent = typeof message.content === "string"
			? message.content
			: Array.isArray(message.content)
				? message.content.map((c: { type: string; text?: string }) => c.type === "text" ? c.text || "" : "").join("")
				: "";
		const nameMatch = rawContent.match(/<skill name="([^"]+)">/);
		const skillName = nameMatch?.[1] || "Unknown Skill";
		
		// Extract skill content (between <skill> tags)
		const contentMatch = rawContent.match(/<skill[^>]*>\n?([\s\S]*?)\n?<\/skill>/);
		const skillContent = contentMatch?.[1]?.trim() || rawContent;
		
		const container = new Container();
		
		// Header with file icon and skill name (like read tool)
		const header = new Text(
			theme.fg("accent", "◆ ") + 
			theme.fg("customMessageLabel", theme.bold("Skill: ")) + 
			theme.fg("accent", skillName),
			1, 0
		);
		container.addChild(header);
		
		// Content preview (collapsible like read tool)
		const lines = skillContent.split("\n");
		const PREVIEW_LINES = 8;
		const isLong = lines.length > PREVIEW_LINES;
		const showLines = options.expanded ? lines : lines.slice(0, PREVIEW_LINES);
		
		// Add content lines with dim styling
		for (const line of showLines) {
			container.addChild(new Text(theme.fg("dim", line), 1, 0));
		}
		
		// Show truncation indicator if collapsed and content is long
		if (!options.expanded && isLong) {
			const hiddenCount = lines.length - PREVIEW_LINES;
			container.addChild(new Text(
				theme.fg("muted", `... ${hiddenCount} more lines (click to expand)`),
				1, 0
			));
		}
		
		return container;
	});

	// Register the /skill command
	pi.registerCommand("skill", {
		description: "Open skill palette to select a skill for the next message",
		handler: async (_args: string, ctx: ExtensionContext) => {
			const skills = loadSkills();

			if (skills.length === 0) {
				ctx.ui.setStatus("skill", "No skills found");
				setTimeout(() => ctx.ui.setStatus("skill", undefined), 3000);
				return;
			}

			// Show the overlay and wait for result
			const result = await ctx.ui.custom<{ skill: Skill | null; action: "select" | "unqueue" | "cancel" }>(
				(_tui, _theme, _keybindings, done) => new SkillPaletteComponent(
					skills,
					state.queuedSkill,
					(skill, action) => done({ skill, action })
				),
				{ overlay: true }
			);

			if (result.action === "select" && result.skill) {
				state.queuedSkill = result.skill;
				ctx.ui.setStatus("skill", `📚 ${result.skill.name}`);
				ctx.ui.setWidget("skill", [`\x1b[2m📚 Skill: \x1b[0m\x1b[36m${result.skill.name}\x1b[0m\x1b[2m — will be applied to next message\x1b[0m`]);
				ctx.ui.notify(`Skill queued: ${result.skill.name}`, "info");
			} else if (result.action === "unqueue" && result.skill) {
				// Show confirmation dialog
				const confirmed = await ctx.ui.custom<boolean>(
					(tui, _theme, _keybindings, done) => {
						const dialog = new ConfirmDialog(result.skill!.name, done);
						dialog.setRequestRender(() => tui.requestRender());
						return dialog;
					},
					{ overlay: true }
				);

				if (confirmed) {
					state.queuedSkill = null;
					ctx.ui.setStatus("skill", undefined);
					ctx.ui.setWidget("skill", undefined);
					ctx.ui.notify("Skill unqueued", "info");
				}
			}
		},
	});

	// Handle the before_agent_start event to send skill content as custom message
	pi.on("before_agent_start", async (_event, ctx) => {
		if (!state.queuedSkill) {
			return {};
		}

		const skill = state.queuedSkill;
		state.queuedSkill = null;

		// Clear the visual indicators (use optional chaining for non-UI contexts)
		ctx.ui?.setStatus("skill", undefined);
		ctx.ui?.setWidget("skill", undefined);

		try {
			const skillContent = getSkillContent(skill);

			return {
				message: {
					customType: "skill-context",
					content: `<skill name="${skill.name}">\n${skillContent}\n</skill>`,
					display: true,  // Show the skill injection in chat
				},
			};
		} catch {
			ctx.ui?.setWidget("skill", undefined);
			ctx.ui?.notify(`Failed to load skill: ${skill.name}`, "warning");
			return {};
		}
	});
}
