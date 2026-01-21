// tool-names.ts - Helpers for normalizing and resolving MCP tool names
/**
 * Normalize tool name (strip common prefixes)
 */
export function normalizeToolName(name) {
    const lower = name.toLowerCase();
    // Strip RepoPrompt_ prefix if present
    if (lower.startsWith("repoprompt_")) {
        return name.slice(11);
    }
    // Strip rp_ prefix if present
    if (lower.startsWith("rp_")) {
        return name.slice(3);
    }
    return name;
}
/**
 * Resolve the actual tool name exposed by the MCP server
 *
 * The RepoPrompt server may expose prefixed names like "RepoPrompt_list_windows"
 * instead of "list_windows". This helper picks the correct concrete name
 */
export function resolveToolName(tools, desired) {
    const desiredLower = desired.toLowerCase();
    const match = tools.find((tool) => normalizeToolName(tool.name).toLowerCase() === desiredLower);
    return match ? match.name : null;
}
