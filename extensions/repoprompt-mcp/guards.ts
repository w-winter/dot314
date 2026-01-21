// guards.ts - Safety checks for destructive operations

import type { RpConfig } from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Delete Detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if a tool call looks like a delete operation
 */
export function isDeleteOperation(
  toolName: string,
  args?: Record<string, unknown>
): boolean {
  const normalizedName = toolName.toLowerCase();
  
  // Direct delete tool
  if (normalizedName === "file_actions") {
    const action = args?.action;
    if (typeof action === "string" && action.toLowerCase() === "delete") {
      return true;
    }
  }
  
  // Check for delete in tool name
  if (normalizedName.includes("delete") || normalizedName.includes("remove")) {
    return true;
  }
  
  return false;
}

/**
 * Get a human-readable description of what would be deleted
 */
export function describeDeleteTarget(
  toolName: string,
  args?: Record<string, unknown>
): string {
  if (toolName.toLowerCase() === "file_actions" && args?.path) {
    return `file: ${args.path}`;
  }
  
  if (args?.path) {
    return `path: ${args.path}`;
  }
  
  if (args?.paths && Array.isArray(args.paths)) {
    return `paths: ${args.paths.join(", ")}`;
  }
  
  return "unknown target";
}

// ─────────────────────────────────────────────────────────────────────────────
// Edit Detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if a tool call is an edit operation
 */
export function isEditOperation(toolName: string): boolean {
  const normalizedName = toolName.toLowerCase();
  
  return (
    normalizedName === "apply_edits" ||
    normalizedName.includes("edit") ||
    normalizedName.includes("write") ||
    normalizedName.includes("create")
  );
}

/**
 * Check if edit output indicates no changes were made
 */
export function isNoopEdit(output: string): boolean {
  const lower = output.toLowerCase();
  
  // Explicit indicators
  if (lower.includes("search block not found")) return true;
  if (lower.includes("no changes")) return true;
  if (lower.includes("0 edits applied")) return true;
  
  // Check for "applied: 0" pattern
  const appliedMatch = lower.match(/applied[:\s]+(\d+)/);
  if (appliedMatch && parseInt(appliedMatch[1], 10) === 0) {
    return true;
  }
  
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Workspace Switch Detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if a tool call would switch workspaces in-place (potentially disruptive)
 */
export function isWorkspaceSwitchInPlace(
  toolName: string,
  args?: Record<string, unknown>
): boolean {
  const normalizedName = toolName.toLowerCase();
  
  if (normalizedName === "manage_workspaces") {
    const action = args?.action;
    
    // Switch action without new_window flag
    if (action === "switch" && !args?.new_window) {
      return true;
    }
    
    // Create with switch flag but no new_window
    if (action === "create" && args?.switch && !args?.new_window) {
      return true;
    }
  }
  
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Guard Result Types
// ─────────────────────────────────────────────────────────────────────────────

export interface GuardResult {
  allowed: boolean;
  reason?: string;
  warning?: string;
}

/**
 * Run all safety guards on a tool call
 */
export function checkGuards(
  toolName: string,
  args: Record<string, unknown> | undefined,
  config: RpConfig,
  overrides: { allowDelete?: boolean; confirmEdits?: boolean } = {}
): GuardResult {
  // Delete guard
  if (isDeleteOperation(toolName, args)) {
    if (config.confirmDeletes && !overrides.allowDelete) {
      const target = describeDeleteTarget(toolName, args);
      return {
        allowed: false,
        reason: `Delete operation blocked (${target}). Set allowDelete: true to proceed.`,
      };
    }
    return {
      allowed: true,
      warning: `Deleting ${describeDeleteTarget(toolName, args)}`,
    };
  }
  
  // Workspace switch guard
  if (isWorkspaceSwitchInPlace(toolName, args)) {
    return {
      allowed: true,
      warning: "In-place workspace switch may disrupt context. Consider using new_window: true.",
    };
  }
  
  // Edit confirmation (optional): require explicit confirmEdits=true for edit-like operations
  // Note: We cannot reliably implement a true dry-run/preview for server-side edits, so this is a safety gate
  if (config.confirmEdits && isEditOperation(toolName) && !overrides.confirmEdits) {
    return {
      allowed: false,
      reason:
        "Edit confirmation enabled. Re-run with confirmEdits: true to apply this edit (or disable confirmEdits).",
    };
  }
  
  return { allowed: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool Name Validation
// ─────────────────────────────────────────────────────────────────────────────

export { normalizeToolName } from "./tool-names.js";

