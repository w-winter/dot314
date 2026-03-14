/**
 * File Picker Extension
 *
 * Replaces the built-in @ file picker with an enhanced file browser.
 * Selected files are attached to the prompt as context.
 *
 * Features:
 * - @ shortcut opens file browser (replaces built-in)
 * - Directory navigation with Enter
 * - Space to toggle selection
 * - Shift+Tab to toggle options panel (gitignore, hidden files)
	* - Tab completion in search input (one word-part at a time, closest alphanumeric prefix match)
 * - Fuzzy search and glob patterns
 * - Git-aware file listing (respects .gitignore)
 * - Selected files injected as context on prompt submit
 *
 * Based on codemap extension by @kcosr
 */

import type { ExtensionUIContext } from "@mariozechner/pi-coding-agent";
import { matchesKey, visibleWidth, type EditorTheme, type TUI } from "@mariozechner/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

interface FileEntry {
	name: string;
	isDirectory: boolean;
	relativePath: string;
}

interface PickerState {
	respectGitignore: boolean;
	skipHidden: boolean;
}

interface PickerConfig {
	respectGitignore?: boolean;
	skipHidden?: boolean;
	skipPatterns?: string[];
}

interface BrowserOption {
	id: string;
	label: string;
	enabled: boolean;
	visible: () => boolean;
}

interface SelectedPath {
	path: string;
	isDirectory: boolean;
}

type FileBrowserAction = 
	| { action: "confirm"; paths: SelectedPath[] }
	| { action: "cancel" }
	| { action: "select"; selected: SelectedPath; paths: SelectedPath[] };

// ═══════════════════════════════════════════════════════════════════════════
// Config
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT_CONFIG: PickerConfig = {
	respectGitignore: true,
	skipHidden: true,
	skipPatterns: ["node_modules"],
};

function loadConfig(): PickerConfig {
	const configPath = path.join(
		os.homedir(),
		".pi",
		"agent",
		"extensions",
		"file-picker",
		"config.json"
	);
	try {
		if (fs.existsSync(configPath)) {
			const content = fs.readFileSync(configPath, "utf-8");
			const custom = JSON.parse(content) as Partial<PickerConfig>;
			return { ...DEFAULT_CONFIG, ...custom };
		}
	} catch {
		// Ignore errors, use default
	}
	return DEFAULT_CONFIG;
}

const config = loadConfig();
const skipPatterns = config.skipPatterns ?? ["node_modules"];

// ═══════════════════════════════════════════════════════════════════════════
// State (per-session, reset on session switch)
// ═══════════════════════════════════════════════════════════════════════════

const state: PickerState = {
	respectGitignore: config.respectGitignore ?? true,
	skipHidden: config.skipHidden ?? true,
};

// ═══════════════════════════════════════════════════════════════════════════
// Theming
// ═══════════════════════════════════════════════════════════════════════════

interface PaletteTheme {
	border: string;
	title: string;
	selected: string;
	selectedText: string;
	directory: string;
	checked: string;
	searchIcon: string;
	placeholder: string;
	hint: string;
}

const DEFAULT_THEME: PaletteTheme = {
	border: "2",
	title: "2",
	selected: "36",
	selectedText: "36",
	directory: "34",
	checked: "32",
	searchIcon: "2",
	placeholder: "2;3",
	hint: "2",
};

function loadTheme(): PaletteTheme {
	const themePath = path.join(
		os.homedir(),
		".pi",
		"agent",
		"extensions",
		"file-picker",
		"theme.json"
	);
	try {
		if (fs.existsSync(themePath)) {
			const content = fs.readFileSync(themePath, "utf-8");
			const custom = JSON.parse(content) as Partial<PaletteTheme>;
			return { ...DEFAULT_THEME, ...custom };
		}
	} catch {
		// Ignore errors
	}
	return DEFAULT_THEME;
}

function fg(code: string, text: string): string {
	if (!code) return text;
	return `\x1b[${code}m${text}\x1b[0m`;
}

const paletteTheme = loadTheme();

// ═══════════════════════════════════════════════════════════════════════════
// File System Utilities
// ═══════════════════════════════════════════════════════════════════════════

function getCwdRoot(): string {
	return process.cwd();
}

function isWithinCwd(targetPath: string, cwdRoot: string): boolean {
	const resolved = path.resolve(targetPath);
	const normalizedCwd = path.resolve(cwdRoot);
	return (
		resolved === normalizedCwd ||
		resolved.startsWith(normalizedCwd + path.sep)
	);
}

function shouldSkipPattern(name: string): boolean {
	return skipPatterns.some((pattern) => {
		if (pattern.includes("*")) {
			const regex = globToRegex(pattern);
			return regex.test(name);
		}
		return name === pattern;
	});
}

function listDirectoryWithGit(
	dirPath: string,
	cwdRoot: string,
	gitFiles: Set<string> | null,
	skipHidden: boolean
): FileEntry[] {
	const entries: FileEntry[] = [];

	try {
		const items = fs.readdirSync(dirPath, { withFileTypes: true });
		const relDir = path.relative(cwdRoot, dirPath);

		for (const item of items) {
			if (skipHidden && item.name.startsWith(".")) continue;
			if (shouldSkipPattern(item.name)) continue;

			const fullPath = path.join(dirPath, item.name);
			const relativePath = relDir ? path.join(relDir, item.name) : item.name;

			let isDirectory = item.isDirectory();
			if (item.isSymbolicLink()) {
				try {
					const stats = fs.statSync(fullPath);
					isDirectory = stats.isDirectory();
				} catch {
					continue;
				}
			}

			if (gitFiles !== null) {
				if (isDirectory) {
					let hasGitFiles = false;
					const prefix = relativePath + "/";
					for (const gitFile of gitFiles) {
						if (gitFile.startsWith(prefix) || gitFile === relativePath) {
							hasGitFiles = true;
							break;
						}
					}
					if (!hasGitFiles) continue;
				} else {
					if (!gitFiles.has(relativePath)) continue;
				}
			}

			entries.push({
				name: item.name,
				isDirectory,
				relativePath,
			});
		}

		entries.sort((a, b) => {
			if (a.isDirectory && !b.isDirectory) return -1;
			if (!a.isDirectory && b.isDirectory) return 1;
			return a.name.localeCompare(b.name);
		});
	} catch {
		// Return empty on error
	}

	return entries;
}

function listAllFiles(
	dirPath: string,
	cwdRoot: string,
	results: FileEntry[],
	skipHidden: boolean
): FileEntry[] {
	try {
		const items = fs.readdirSync(dirPath, { withFileTypes: true });

		for (const item of items) {
			if (skipHidden && item.name.startsWith(".")) continue;
			if (shouldSkipPattern(item.name)) continue;

			const fullPath = path.join(dirPath, item.name);
			const relativePath = path.relative(cwdRoot, fullPath);

			let isDirectory = item.isDirectory();
			if (item.isSymbolicLink()) {
				try {
					const stats = fs.statSync(fullPath);
					isDirectory = stats.isDirectory();
				} catch {
					continue;
				}
			}

			results.push({
				name: item.name,
				isDirectory,
				relativePath,
			});

			if (isDirectory) {
				listAllFiles(fullPath, cwdRoot, results, skipHidden);
			}
		}
	} catch {
		// Skip inaccessible directories
	}

	return results;
}

function isGitRepo(cwdRoot: string): boolean {
	try {
		execSync("git rev-parse --is-inside-work-tree", {
			cwd: cwdRoot,
			encoding: "utf-8",
			stdio: "pipe",
		});
		return true;
	} catch {
		return false;
	}
}

function listGitFiles(cwdRoot: string): FileEntry[] {
	const entries: FileEntry[] = [];

	try {
		const output = execSync(
			"git ls-files --cached --others --exclude-standard",
			{
				cwd: cwdRoot,
				encoding: "utf-8",
				stdio: "pipe",
				maxBuffer: 10 * 1024 * 1024,
			}
		);

		const files = output
			.trim()
			.split("\n")
			.filter((f) => f);

		for (const relativePath of files) {
			const fullPath = path.join(cwdRoot, relativePath);
			const name = path.basename(relativePath);

			let isDirectory = false;
			try {
				const stats = fs.statSync(fullPath);
				isDirectory = stats.isDirectory();
			} catch {
				continue;
			}

			entries.push({
				name,
				isDirectory,
				relativePath,
			});
		}

		const dirs = new Set<string>();
		for (const entry of entries) {
			let dir = path.dirname(entry.relativePath);
			while (dir && dir !== ".") {
				dirs.add(dir);
				dir = path.dirname(dir);
			}
		}

		for (const dir of dirs) {
			entries.push({
				name: path.basename(dir),
				isDirectory: true,
				relativePath: dir,
			});
		}
	} catch {
		// Fall back to empty
	}

	return entries;
}

// ═══════════════════════════════════════════════════════════════════════════
// Search Utilities
// ═══════════════════════════════════════════════════════════════════════════

function isGlobPattern(query: string): boolean {
	return /[*?[\]]/.test(query);
}

function globToRegex(pattern: string): RegExp {
	let regex = "";
	let i = 0;

	while (i < pattern.length) {
		const char = pattern[i];

		if (char === "*") {
			if (pattern[i + 1] === "*") {
				regex += ".*";
				i += 2;
				if (pattern[i] === "/") i++;
			} else {
				regex += "[^/]*";
				i++;
			}
		} else if (char === "?") {
			regex += "[^/]";
			i++;
		} else if (char === "[") {
			const end = pattern.indexOf("]", i);
			if (end !== -1) {
				regex += pattern.slice(i, end + 1);
				i = end + 1;
			} else {
				regex += "\\[";
				i++;
			}
		} else if (".+^${}()|\\".includes(char)) {
			regex += "\\" + char;
			i++;
		} else {
			regex += char;
			i++;
		}
	}

	return new RegExp("^" + regex + "$", "i");
}

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

function filterEntries(entries: FileEntry[], query: string): FileEntry[] {
	if (!query.trim()) return entries;

	if (isGlobPattern(query)) {
		const regex = globToRegex(query);
		const filtered = entries.filter(
			(entry) => regex.test(entry.name) || regex.test(entry.relativePath)
		);
		// Sort: files first, then directories
		return filtered.sort((a, b) => {
			if (a.isDirectory && !b.isDirectory) return 1;
			if (!a.isDirectory && b.isDirectory) return -1;
			return a.relativePath.localeCompare(b.relativePath);
		});
	}

	const scored = entries
		.map((entry) => ({
			entry,
			score: Math.max(
				fuzzyScore(query, entry.name),
				fuzzyScore(query, entry.relativePath) * 0.9
			),
		}))
		.filter((item) => item.score > 0)
		.sort((a, b) => {
			// Primary: files before directories
			if (a.entry.isDirectory && !b.entry.isDirectory) return 1;
			if (!a.entry.isDirectory && b.entry.isDirectory) return -1;
			// Secondary: by score
			return b.score - a.score;
		});

	return scored.map((item) => item.entry);
}

// ═══════════════════════════════════════════════════════════════════════════
// File Browser Component
// ═══════════════════════════════════════════════════════════════════════════

class FileBrowserComponent {
	readonly width = 100;
	private readonly maxVisible = 10;
	private cwdRoot: string;
	private currentDir: string;
	private allEntries: FileEntry[];
	private allFilesRecursive: FileEntry[];
	private filtered: FileEntry[];
	private selected = 0;
	private query = "";
	private isSearchMode = false;
	private selectedPaths: Map<string, boolean>; // path -> isDirectory
	private rootParentView = false;
	private inGitRepo: boolean;
	private gitFiles: Set<string> | null = null;
	private focusOnOptions = false;
	private selectedOption = 0;
	private options: BrowserOption[];
	private done: (action: FileBrowserAction) => void;

	constructor(done: (action: FileBrowserAction) => void) {
		this.done = done;
		this.cwdRoot = getCwdRoot();
		this.currentDir = this.cwdRoot;
		this.selectedPaths = new Map();
		this.inGitRepo = isGitRepo(this.cwdRoot);

		this.options = [
			{
				id: "gitignore",
				label: "Respect .gitignore",
				enabled: state.respectGitignore,
				visible: () => this.inGitRepo,
			},
			{
				id: "skipHidden",
				label: "Skip hidden files",
				enabled: state.skipHidden,
				visible: () => true,
			},
		];

		this.rebuildFileLists();
	}

	private getOption(id: string): BrowserOption | undefined {
		return this.options.find((o) => o.id === id);
	}

	private getVisibleOptions(): BrowserOption[] {
		return this.options.filter((o) => o.visible());
	}

	private rebuildFileLists(): void {
		const respectGitignore = this.getOption("gitignore")?.enabled ?? false;
		const skipHidden = this.getOption("skipHidden")?.enabled ?? true;

		if (this.inGitRepo && respectGitignore) {
			const gitEntries = listGitFiles(this.cwdRoot);
			this.gitFiles = new Set(gitEntries.map((e) => e.relativePath));
			this.allFilesRecursive = gitEntries;
		} else {
			this.gitFiles = null;
			this.allFilesRecursive = listAllFiles(this.cwdRoot, this.cwdRoot, [], skipHidden);
		}

		this.allEntries = this.listCurrentDirectory();
		this.updateFilter();
	}

	private listCurrentDirectory(): FileEntry[] {
		if (this.rootParentView) {
			return [{
				name: path.basename(this.cwdRoot),
				isDirectory: true,
				relativePath: ".",
			}];
		}

		const skipHidden = this.getOption("skipHidden")?.enabled ?? true;
		const entries = listDirectoryWithGit(
			this.currentDir,
			this.cwdRoot,
			this.gitFiles,
			skipHidden
		);

		entries.unshift({
			name: "..",
			isDirectory: true,
			relativePath: "..",
		});

		return entries;
	}

	private isUpEntry(entry: FileEntry): boolean {
		return entry.name === ".." && entry.relativePath === "..";
	}

	private navigateTo(dir: string): void {
		if (!isWithinCwd(dir, this.cwdRoot)) return;

		this.rootParentView = false;
		this.currentDir = dir;
		this.allEntries = this.listCurrentDirectory();
		this.query = "";
		this.isSearchMode = false;
		this.filtered = this.allEntries;
		this.selected = 0;
	}

	private goUp(): boolean {
		if (this.rootParentView) return false;

		if (this.currentDir === this.cwdRoot) {
			this.rootParentView = true;
			this.allEntries = this.listCurrentDirectory();
			this.query = "";
			this.isSearchMode = false;
			this.filtered = this.allEntries;
			this.selected = 0;
			return true;
		}

		const parentDir = path.dirname(this.currentDir);
		if (isWithinCwd(parentDir, this.cwdRoot)) {
			this.navigateTo(parentDir);
			return true;
		}
		return false;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "shift+tab")) {
			const visibleOptions = this.getVisibleOptions();
			if (visibleOptions.length > 0) {
				this.focusOnOptions = !this.focusOnOptions;
				if (this.focusOnOptions) this.selectedOption = 0;
			}
			return;
		}

		if (this.focusOnOptions) {
			this.handleOptionsInput(data);
		} else {
			this.handleBrowserInput(data);
		}
	}

	private handleOptionsInput(data: string): void {
		const visibleOptions = this.getVisibleOptions();
		const currentOption = visibleOptions[this.selectedOption];

		if (matchesKey(data, "escape")) {
			this.focusOnOptions = false;
			return;
		}

		if (matchesKey(data, "up") || matchesKey(data, "left")) {
			if (visibleOptions.length > 0) {
				this.selectedOption = this.selectedOption === 0
					? visibleOptions.length - 1
					: this.selectedOption - 1;
			}
			return;
		}

		if (matchesKey(data, "down") || matchesKey(data, "right")) {
			if (visibleOptions.length > 0) {
				this.selectedOption = this.selectedOption === visibleOptions.length - 1
					? 0
					: this.selectedOption + 1;
			}
			return;
		}

		if (data === " " || matchesKey(data, "return")) {
			if (currentOption) {
				currentOption.enabled = !currentOption.enabled;
				// Sync to global state
				if (currentOption.id === "gitignore") {
					state.respectGitignore = currentOption.enabled;
				} else if (currentOption.id === "skipHidden") {
					state.skipHidden = currentOption.enabled;
				}
				this.rebuildFileLists();
			}
		}
	}

	private getSelectedPathsArray(): SelectedPath[] {
		return Array.from(this.selectedPaths.entries()).map(([p, isDir]) => ({ path: p, isDirectory: isDir }));
	}

	private handleBrowserInput(data: string): void {
		if (matchesKey(data, "escape")) {
			if (!this.goUp()) {
				this.done({ action: "confirm", paths: this.getSelectedPathsArray() });
			}
			return;
		}

		// Enter = select and insert (files or directories)
		if (matchesKey(data, "return")) {
			const entry = this.filtered[this.selected];
			if (entry) {
				if (entry.name === "..") {
					this.goUp();
				} else {
					// Select and close (works for both files and directories)
					const paths = this.getSelectedPathsArray();
					const selected = { path: entry.relativePath, isDirectory: entry.isDirectory };
					if (!this.selectedPaths.has(entry.relativePath)) {
						paths.push(selected);
					}
					this.done({ action: "select", selected, paths });
				}
			}
			return;
		}

		// Space or Right arrow = navigate directories, toggle files
		if (data === " " || matchesKey(data, "right")) {
			const entry = this.filtered[this.selected];
			if (entry && !this.isUpEntry(entry)) {
				if (entry.isDirectory) {
					// Navigate into directory
					this.navigateTo(path.join(this.cwdRoot, entry.relativePath));
				} else {
					// Toggle selection for multi-select (files only)
					if (this.selectedPaths.has(entry.relativePath)) {
						this.selectedPaths.delete(entry.relativePath);
					} else {
						this.selectedPaths.set(entry.relativePath, entry.isDirectory);
					}
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

		// Left arrow = go up directory
		if (matchesKey(data, "left")) {
			this.goUp();
			return;
		}

		if (matchesKey(data, "tab")) {
			this.completeQueryToClosestMatch();
			return;
		}

		if (matchesKey(data, "backspace")) {
			if (this.query.length > 0) {
				this.query = this.query.slice(0, -1);
				this.updateFilter();
			} else {
				this.goUp();
			}
			return;
		}

		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.query += data;
			this.updateFilter();
		}
	}

	private completeQueryToClosestMatch(): void {
		if (!this.query.trim()) return;

		const closestMatch = this.findClosestCompletionMatch(this.query);
		if (!closestMatch) return;

		const completedQuery = this.completeOneWordPart(this.query, closestMatch.path);
		if (!completedQuery || completedQuery === this.query) return;

		this.query = completedQuery;
		this.updateFilter();
	}

	private findClosestCompletionMatch(query: string): { path: string; isDirectory: boolean } | null {
		const queryLower = query.toLowerCase();
		const withSlash = this.allFilesRecursive.map((entry) => ({
			path: entry.isDirectory ? `${entry.relativePath}/` : entry.relativePath,
			isDirectory: entry.isDirectory,
		}));

		const directPrefixMatches = withSlash
			.filter((entry) => entry.path.toLowerCase().startsWith(queryLower))
			.sort((a, b) => this.compareCompletionEntries(a, b));
		if (directPrefixMatches.length > 0) return directPrefixMatches[0];

		const normalizedQuery = this.normalizeAlnum(query);
		if (!normalizedQuery) return null;

		const normalizedPrefixMatches = withSlash
			.filter((entry) => this.normalizeAlnum(entry.path).startsWith(normalizedQuery))
			.sort((a, b) => this.compareCompletionEntries(a, b));
		return normalizedPrefixMatches[0] ?? null;
	}

	private compareCompletionEntries(
		a: { path: string; isDirectory: boolean },
		b: { path: string; isDirectory: boolean }
	): number {
		if (a.path.length !== b.path.length) return a.path.length - b.path.length;
		if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
		return a.path.localeCompare(b.path);
	}

	private completeOneWordPart(query: string, completionPath: string): string {
		const queryLower = query.toLowerCase();
		const completionLower = completionPath.toLowerCase();

		if (completionLower.startsWith(queryLower)) {
			const end = this.nextWordPartBoundary(completionPath, query.length);
			return completionPath.slice(0, end);
		}

		const longestCommonPrefix = this.commonPrefixLength(queryLower, completionLower);
		if (longestCommonPrefix === 0) return query;

		const end = this.nextWordPartBoundary(completionPath, longestCommonPrefix);
		return completionPath.slice(0, end);
	}

	private nextWordPartBoundary(text: string, start: number): number {
		if (start >= text.length) return text.length;

		let index = start;
		if (this.isAlphaNumeric(text[index])) {
			while (index < text.length && this.isAlphaNumeric(text[index])) {
				index += 1;
			}
			if (index < text.length && this.isWordSeparator(text[index])) {
				index += 1;
			}
			return index;
		}

		while (index < text.length && this.isWordSeparator(text[index])) {
			index += 1;
		}
		while (index < text.length && this.isAlphaNumeric(text[index])) {
			index += 1;
		}
		if (index < text.length && this.isWordSeparator(text[index])) {
			index += 1;
		}
		return index;
	}

	private isAlphaNumeric(char: string | undefined): boolean {
		return char !== undefined && /[a-zA-Z0-9]/.test(char);
	}

	private isWordSeparator(char: string | undefined): boolean {
		return char !== undefined && /[\/_.\-]/.test(char);
	}

	private normalizeAlnum(value: string): string {
		return value.toLowerCase().replace(/[^a-z0-9]/g, "");
	}

	private commonPrefixLength(left: string, right: string): number {
		let index = 0;
		const maxLength = Math.min(left.length, right.length);
		while (index < maxLength && left[index] === right[index]) {
			index += 1;
		}
		return index;
	}

	private updateFilter(): void {
		if (this.query.trim()) {
			this.isSearchMode = true;
			this.filtered = filterEntries(this.allFilesRecursive, this.query);
		} else {
			this.isSearchMode = false;
			this.filtered = this.allEntries;
		}
		this.selected = 0;
	}

	render(_width: number): string[] {
		const w = this.width;
		const innerW = w - 2;
		const lines: string[] = [];

		const t = paletteTheme;
		const border = (s: string) => fg(t.border, s);
		const title = (s: string) => fg(t.title, s);
		const selected = (s: string) => fg(t.selected, s);
		const selectedText = (s: string) => fg(t.selectedText, s);
		const directory = (s: string) => fg(t.directory, s);
		const checked = (s: string) => fg(t.checked, s);
		const hint = (s: string) => fg(t.hint, s);
		const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;

		const pad = (s: string, len: number) => s + " ".repeat(Math.max(0, len - visibleWidth(s)));

		const truncate = (s: string, maxW: number) => {
			if (visibleWidth(s) <= maxW) return s;
			let result = "";
			let width = 0;
			for (const char of s) {
				const charWidth = visibleWidth(char);
				if (width + charWidth > maxW - 1) break;
				result += char;
				width += charWidth;
			}
			return result + "…";
		};

		const row = (content: string) => border("│") + pad(content, innerW) + border("│");

		// Top border with title
		let titleText: string;
		if (this.isSearchMode) {
			titleText = " Search ";
		} else if (this.rootParentView) {
			titleText = " Files ";
		} else {
			const relDir = path.relative(this.cwdRoot, this.currentDir);
			titleText = relDir ? ` ${truncate(relDir, 40)} ` : " Files ";
		}
		const borderLen = Math.max(0, innerW - visibleWidth(titleText));
		const leftBorder = Math.floor(borderLen / 2);
		const rightBorder = borderLen - leftBorder;
		lines.push(
			border("╭" + "─".repeat(leftBorder)) +
				title(titleText) +
				border("─".repeat(rightBorder) + "╮")
		);

		// Search input
		const searchPrompt = selected("❯ ");
		const queryDisplay = this.query || hint("Search files...");
		const modeIndicator = this.query && isGlobPattern(this.query) ? hint(" [glob]") : "";
		lines.push(row(` ${searchPrompt}${queryDisplay}${modeIndicator}`));

		// Options row
		const visibleOptions = this.getVisibleOptions();
		if (visibleOptions.length > 0) {
			const optParts: string[] = [];
			for (let i = 0; i < visibleOptions.length; i++) {
				const opt = visibleOptions[i];
				const isSelectedOpt = this.focusOnOptions && i === this.selectedOption;
				const checkbox = opt.enabled ? checked("☑") : hint("☐");
				const label = isSelectedOpt
					? selected(opt.label)
					: opt.enabled
						? opt.label
						: hint(opt.label);
				const prefix = isSelectedOpt ? selected("▸") : " ";
				optParts.push(`${prefix}${checkbox} ${label}`);
			}
			const optionsStr = optParts.join(" ");
			const tabHint = this.focusOnOptions
				? hint(" (←→/↑↓ move, space toggle, esc exit, shift+tab)")
				: hint(" (shift+tab options)");
			lines.push(row(` ${optionsStr}${tabHint}`));
		} else {
			lines.push(row(""));
		}

		// Divider
		lines.push(border(`├${"─".repeat(innerW)}┤`));

		// File list - always render exactly maxVisible rows
		const startIndex = Math.max(
			0,
			Math.min(this.selected - Math.floor(this.maxVisible / 2), this.filtered.length - this.maxVisible)
		);

		for (let i = 0; i < this.maxVisible; i++) {
			const actualIndex = startIndex + i;
			if (actualIndex < this.filtered.length) {
				const entry = this.filtered[actualIndex];
				const isSelectedEntry = actualIndex === this.selected;
				const isUpDir = this.isUpEntry(entry);
				const isChecked = !isUpDir && this.selectedPaths.has(entry.relativePath);

				const prefix = isSelectedEntry ? selected(" ▶ ") : "   ";

				let displayName: string;
				if (isUpDir) {
					displayName = "..";
				} else if (this.isSearchMode) {
					displayName = entry.relativePath + (entry.isDirectory ? "/" : "");
				} else {
					displayName = entry.name + (entry.isDirectory ? "/" : "");
				}

				const maxNameLen = innerW - 8;
				const truncatedName = truncate(displayName, maxNameLen);

				let nameStr: string;
				if (isUpDir) {
					nameStr = isSelectedEntry ? bold(selectedText(truncatedName)) : hint(truncatedName);
				} else if (entry.isDirectory) {
					nameStr = isSelectedEntry ? bold(selectedText(truncatedName)) : directory(truncatedName);
				} else {
					nameStr = isSelectedEntry ? bold(selectedText(truncatedName)) : truncatedName;
				}

				if (isUpDir) {
					lines.push(row(`${prefix}   ${nameStr}`));
				} else {
					const checkMark = isChecked ? checked("☑ ") : hint("☐ ");
					lines.push(row(`${prefix}${checkMark}${nameStr}`));
				}
			} else if (i === 0 && this.filtered.length === 0) {
				lines.push(row(hint("   No matching files")));
			} else {
				lines.push(row(""));
			}
		}

		// Scroll/count indicator row
		if (this.filtered.length > this.maxVisible) {
			const shown = `${startIndex + 1}-${Math.min(startIndex + this.maxVisible, this.filtered.length)}`;
			lines.push(row(hint(` (${shown} of ${this.filtered.length})`)));
		} else if (this.filtered.length > 0) {
			lines.push(row(hint(` (${this.filtered.length} file${this.filtered.length === 1 ? "" : "s"})`)));
		} else {
			lines.push(row(""));
		}

		// Selection summary section
		lines.push(border(`├${"─".repeat(innerW)}┤`));
		if (this.selectedPaths.size > 0) {
			const selectedList = Array.from(this.selectedPaths.keys()).slice(0, 3);
			const preview = selectedList.join(", ") + (this.selectedPaths.size > 3 ? ", ..." : "");
			lines.push(row(` ${checked(`Selected (${this.selectedPaths.size}):`)} ${truncate(preview, innerW - 18)}`));
		} else {
			lines.push(row(hint(" No files selected")));
		}

		// Footer
		lines.push(border(`├${"─".repeat(innerW)}┤`));
		lines.push(row(hint(" ↑↓ navigate  ←→ dirs  tab complete  shift+tab options  space toggle  enter select  esc done")));

		// Bottom border
		lines.push(border(`╰${"─".repeat(innerW)}╯`));

		return lines;
	}

	invalidate(): void {}
	dispose(): void {}
}

// ═══════════════════════════════════════════════════════════════════════════
// Shared File Picker Logic
// ═══════════════════════════════════════════════════════════════════════════

export async function openFilePicker(ui: ExtensionUIContext): Promise<string> {
	const result = await ui.custom<FileBrowserAction>(
		(_tui, _theme, _kb, done) => new FileBrowserComponent(done),
		{ overlay: true }
	);

	if (!result || result.action === "cancel") return "";
	const paths = result.paths ?? [];
	if (paths.length == 0) return "";

	// Add trailing / for directories to make it clear
	const refs = paths.map((p) => `@${p.path}${p.isDirectory ? "/" : ""}`).join(" ");
	ui.notify(`Added ${paths.length} file${paths.length > 1 ? "s" : ""}`, "info");
	return refs;
}


