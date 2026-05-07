/**
 * Bash shell completion provider.
 *
 * Uses bash's native completion system by running a script that sets up
 * COMP_* environment variables and calls the registered completion function.
 *
 * Philosophy: Only provide completions if the user has bash-completion available.
 */

import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { CompletionResult, ShellCompletionProvider } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMPLETE_SCRIPT = path.join(__dirname, "scripts", "bash-complete.bash");

/**
 * Check if bash-completion is available.
 * We check for the presence of completion scripts in standard locations.
 */
let completionCheckCache: boolean | null = null;

function userHasBashCompletions(bashPath: string): boolean {
	if (completionCheckCache !== null) {
		return completionCheckCache;
	}

	try {
		// Check if bash-completion framework or git completion exists
		const result = spawnSync(
			bashPath,
			[
				"-c",
				`
				for f in /usr/share/bash-completion/bash_completion /etc/bash_completion /opt/homebrew/etc/bash_completion /opt/homebrew/share/bash-completion/bash_completion; do
					[[ -f "$f" ]] && { echo yes; exit 0; }
				done
				# Also check for individual completion files
				for f in /opt/homebrew/etc/bash_completion.d/git* /usr/share/bash-completion/completions/git; do
					[[ -f "$f" ]] && { echo yes; exit 0; }
				done
				echo no
			`,
			],
			{
				encoding: "utf-8",
				timeout: 500,
			}
		);

		completionCheckCache = result.stdout?.trim() === "yes";
		return completionCheckCache;
	} catch {
		completionCheckCache = false;
		return false;
	}
}

/**
 * Get completions using bash's native completion system.
 */
export function getBashCompletions(
	commandLine: string,
	cwd: string,
	bashPath: string
): CompletionResult | null {
	// Check if bash completions are available
	if (!userHasBashCompletions(bashPath)) {
		return null;
	}

	// Check if completion script exists
	if (!fs.existsSync(COMPLETE_SCRIPT)) {
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
		const result = spawnSync(bashPath, [COMPLETE_SCRIPT, commandLine, cwd], {
			encoding: "utf-8",
			timeout: 500,
			maxBuffer: 1024 * 100,
			cwd,
		});

		if (result.error || !result.stdout) {
			return null;
		}

		const items: AutocompleteItem[] = result.stdout
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				// Remove trailing space that bash completion adds
				const value = line.trimEnd();
				return { value, label: value };
			});

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

export const bashCompletionProvider: ShellCompletionProvider = {
	getCompletions: getBashCompletions,
};
