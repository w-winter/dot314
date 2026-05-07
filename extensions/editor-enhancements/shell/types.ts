/**
 * Shared types for shell completions extension.
 */

import type { AutocompleteItem } from "@earendil-works/pi-tui";

export type ShellType = "fish" | "zsh" | "bash";

export interface ShellInfo {
	path: string;
	type: ShellType;
}

export interface CompletionContext {
	commandLine: string;
	prefix: string;
}

export interface CompletionResult {
	items: AutocompleteItem[];
	prefix: string;
}

/**
 * Interface for shell-specific completion providers.
 * Returns null if the user hasn't configured completions for this shell.
 */
export interface ShellCompletionProvider {
	getCompletions(commandLine: string, cwd: string, shellPath: string): CompletionResult | null;
}
