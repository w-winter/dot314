/**
 * Normalize tool name (strip common prefixes)
 */
export declare function normalizeToolName(name: string): string;
/**
 * Resolve the actual tool name exposed by the MCP server
 *
 * The RepoPrompt server may expose prefixed names like "RepoPrompt_list_windows"
 * instead of "list_windows". This helper picks the correct concrete name
 */
export declare function resolveToolName(tools: Array<{
    name: string;
}>, desired: string): string | null;
