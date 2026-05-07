/**
 * Zsh completion support
 *
 * Unfortunately, zsh's completion system is tightly coupled to its line editor
 * (ZLE) and cannot be easily queried programmatically without a pseudo-terminal.
 * The zpty approach is complex and fragile.
 *
 * This implementation uses a simple fallback script that handles common cases
 * (git, ssh, make, npm, docker) but does NOT tap into the user's full zsh
 * completion configuration.
 *
 * For the best experience, install fish (even as a secondary shell) - its
 * `complete -C` command provides excellent completions without complexity.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { CompletionResult } from "./types.js";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CAPTURE_SCRIPT = path.join(__dirname, "scripts", "zsh-capture.zsh");

/**
 * Parse completion output (tab-separated: value\tdescription)
 */
function parseOutput(output: string): AutocompleteItem[] {
	const lines = output.trim().split("\n").filter(Boolean);
	const items: AutocompleteItem[] = [];
	const seen = new Set<string>();

	for (const line of lines) {
		const tabIndex = line.indexOf("\t");
		let value: string;
		let description: string | undefined;

		if (tabIndex >= 0) {
			value = line.slice(0, tabIndex).trim();
			description = line.slice(tabIndex + 1).trim() || undefined;
		} else {
			value = line.trim();
		}

		if (!value || seen.has(value)) continue;
		seen.add(value);

		// Skip internal refs
		if (value.startsWith("refs/jj/keep/")) continue;

		items.push({ value, label: value, description });
	}

	return items;
}

/**
 * Get completions using zsh fallback script.
 * Note: This does NOT use the user's full zsh completion config.
 */
export function getZshCompletions(
	commandLine: string,
	cwd: string,
	zshPath: string
): CompletionResult | null {
	// Check if capture script exists
	if (!fs.existsSync(CAPTURE_SCRIPT)) {
		return null;
	}

	// Extract prefix
	const trimmed = commandLine.trimStart();
	let prefix = "";
	if (!trimmed.endsWith(" ")) {
		const words = trimmed.split(/\s+/);
		prefix = words[words.length - 1] || "";
	}

	try {
		const result = spawnSync(zshPath, [CAPTURE_SCRIPT, commandLine, cwd], {
			encoding: "utf-8",
			timeout: 500,
			maxBuffer: 1024 * 100,
			cwd,
		});

		if (result.error || !result.stdout) {
			return null;
		}

		const items = parseOutput(result.stdout);

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

export const zshCompletionProvider = {
	name: "zsh" as const,
	getCompletions: getZshCompletions,
};
