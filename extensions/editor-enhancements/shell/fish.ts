/**
 * Fish shell completion provider.
 *
 * Uses fish's native `complete -C` command which provides excellent completions
 * for most tools automatically.
 * 
 * Fish always has completions available (it's a core feature), so this never
 * returns null for "user hasn't configured completions".
 */

import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { spawnSync } from "node:child_process";
import type { CompletionResult, ShellCompletionProvider } from "./types.js";

/**
 * Get completions using fish's native `complete -C` command.
 * Fish completions are excellent and cover most tools automatically.
 */
export function getFishCompletions(
	commandLine: string,
	cwd: string,
	fishPath: string
): CompletionResult | null {
	// Extract prefix
	const trimmed = commandLine.trimStart();
	let prefix = "";
	if (!trimmed.endsWith(" ")) {
		const words = trimmed.split(/\s+/);
		prefix = words[words.length - 1] || "";
	}

	try {
		// Fish's complete -C gives us completions directly
		const result = spawnSync(
			fishPath,
			["-c", `complete -C ${JSON.stringify(commandLine)}`],
			{
				encoding: "utf-8",
				timeout: 500,
				maxBuffer: 1024 * 100,
				cwd,
			}
		);

		if (result.error || !result.stdout) {
			return null;
		}

		// Fish output format: "completion\tdescription" (tab-separated)
		const lines = result.stdout.trim().split("\n").filter(Boolean);
		const items: AutocompleteItem[] = [];

		for (const line of lines) {
			const tabIndex = line.indexOf("\t");
			if (tabIndex >= 0) {
				const value = line.slice(0, tabIndex).trim();
				const description = line.slice(tabIndex + 1).trim();
				if (value) {
					items.push({ value, label: value, description });
				}
			} else {
				const value = line.trim();
				if (value) {
					items.push({ value, label: value });
				}
			}
		}

		if (items.length === 0) {
			return null;
		}

		return {
			items: items.slice(0, 30),
			prefix,
		};
	} catch {
		return null;
	}
}

export const fishCompletionProvider: ShellCompletionProvider = {
	getCompletions: getFishCompletions,
};
