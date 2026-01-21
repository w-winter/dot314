import type { RpConfig } from "./types.js";
/**
 * Check if a tool call looks like a delete operation
 */
export declare function isDeleteOperation(toolName: string, args?: Record<string, unknown>): boolean;
/**
 * Get a human-readable description of what would be deleted
 */
export declare function describeDeleteTarget(toolName: string, args?: Record<string, unknown>): string;
/**
 * Check if a tool call is an edit operation
 */
export declare function isEditOperation(toolName: string): boolean;
/**
 * Check if edit output indicates no changes were made
 */
export declare function isNoopEdit(output: string): boolean;
/**
 * Check if a tool call would switch workspaces in-place (potentially disruptive)
 */
export declare function isWorkspaceSwitchInPlace(toolName: string, args?: Record<string, unknown>): boolean;
export interface GuardResult {
    allowed: boolean;
    reason?: string;
    warning?: string;
}
/**
 * Run all safety guards on a tool call
 */
export declare function checkGuards(toolName: string, args: Record<string, unknown> | undefined, config: RpConfig, overrides?: {
    allowDelete?: boolean;
    confirmEdits?: boolean;
}): GuardResult;
export { normalizeToolName } from "./tool-names.js";
