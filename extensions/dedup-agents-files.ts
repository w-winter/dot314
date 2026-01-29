/**
 * Dedup AGENTS.md Files Extension
 *
 * Removes duplicate AGENTS.md content from the system prompt when the same file
 * is loaded through different paths (e.g., via symlinks).
 *
 * Problem: If ~/.pi/agent is symlinked to ~/dot314/agent, Pi loads AGENTS.md twice:
 *   1. From agentDir (~/.pi/agent/AGENTS.md)
 *   2. From cwd walk (~/dot314/agent/AGENTS.md)
 * These are different paths but resolve to the same file.
 *
 * Solution: Parse the system prompt's "# Project Context" section, resolve paths
 * with realpathSync, and remove duplicate content blocks.
 */

import { realpathSync } from "node:fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function dedupAgentsFilesExtension(pi: ExtensionAPI) {
    pi.on("before_agent_start", async (event, ctx) => {
        const { systemPrompt } = event;

        // Find the Project Context section
        const contextMarker = "# Project Context";
        const contextStart = systemPrompt.indexOf(contextMarker);
        if (contextStart === -1) {
            return; // No project context section
        }

        // Split into before-context and context sections
        const beforeContext = systemPrompt.slice(0, contextStart);
        const contextSection = systemPrompt.slice(contextStart);

        // Parse individual file blocks: ## /path/to/file\n\ncontent\n\n
        const fileBlockRegex = /## (\/[^\n]+)\n\n([\s\S]*?)(?=\n## \/|$)/g;
        const blocks: Array<{ path: string; realPath: string; fullMatch: string }> = [];

        let match;
        while ((match = fileBlockRegex.exec(contextSection)) !== null) {
            const filePath = match[1];
            let realPath: string;
            try {
                realPath = realpathSync(filePath);
            } catch {
                realPath = filePath; // Keep original if realpath fails
            }
            blocks.push({
                path: filePath,
                realPath,
                fullMatch: match[0],
            });
        }

        // Check for duplicates by realPath
        const seenRealPaths = new Set<string>();
        const uniqueBlocks: string[] = [];
        let removedCount = 0;

        for (const block of blocks) {
            if (seenRealPaths.has(block.realPath)) {
                removedCount++;
                continue; // Skip duplicate
            }
            seenRealPaths.add(block.realPath);
            uniqueBlocks.push(block.fullMatch);
        }

        if (removedCount === 0) {
            return; // No duplicates found
        }

        // Rebuild system prompt with deduplicated context
        const newContextSection =
            contextMarker +
            "\n\nProject-specific instructions and guidelines:\n\n" +
            uniqueBlocks.join("\n");

        const newSystemPrompt = beforeContext + newContextSection;

        ctx.ui.notify(
            `Removed ${removedCount} duplicate AGENTS.md file(s) (symlink dedup)`,
            "info"
        );

        return { systemPrompt: newSystemPrompt };
    });
}
