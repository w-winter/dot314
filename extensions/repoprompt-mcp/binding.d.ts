import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { RpBinding, RpConfig, RpWindow } from "./types.js";
/**
 * Get the current binding
 */
export declare function getBinding(): RpBinding | null;
export declare function clearBinding(): void;
/**
 * Persist the binding to session storage (survives session reload)
 */
export declare function persistBinding(pi: ExtensionAPI, binding: RpBinding, config: RpConfig): void;
/**
 * Restore binding from session history
 */
export declare function restoreBinding(ctx: ExtensionContext, config: RpConfig): RpBinding | null;
/**
 * Parse window list response from RepoPrompt
 */
export declare function parseWindowList(text: string): RpWindow[];
/**
 * Fetch list of RepoPrompt windows (without roots)
 */
export declare function fetchWindows(): Promise<RpWindow[]>;
export declare function parseRootList(text: string): string[];
/**
 * Get workspace roots for a specific window
 */
export declare function fetchWindowRoots(windowId: number): Promise<string[]>;
export interface WindowMatch {
    window: RpWindow;
    root: string;
    rootDepth: number;
}
export interface FindMatchingWindowResult {
    window: RpWindow | null;
    root: string | null;
    ambiguous: boolean;
    matches: WindowMatch[];
}
/**
 * Find the best matching window for the current working directory
 */
export declare function findMatchingWindow(windows: RpWindow[], cwd: string): FindMatchingWindowResult;
export interface AutoDetectAndBindResult {
    binding: RpBinding | null;
    windows: RpWindow[];
    ambiguity?: {
        candidates: RpWindow[];
    };
}
/**
 * Auto-detect and bind to the best matching window
 * Returns the binding if successful, null if no match or multiple ambiguous matches
 */
export declare function autoDetectAndBind(pi: ExtensionAPI, config: RpConfig): Promise<AutoDetectAndBindResult>;
/**
 * Manually bind to a specific window and optionally tab
 */
export declare function bindToWindow(pi: ExtensionAPI, windowId: number, tab: string | undefined, config: RpConfig): Promise<RpBinding>;
/**
 * Get binding args to include in tool calls
 */
export declare function getBindingArgs(): Record<string, unknown>;
