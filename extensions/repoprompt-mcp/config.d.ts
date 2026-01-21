import type { RpConfig } from "./types.js";
/**
 * Load extension configuration
 */
export declare function loadConfig(overrides?: Partial<RpConfig>): RpConfig;
/**
 * Get the server command and args, or throw if not found
 */
export declare function getServerCommand(config: RpConfig): {
    command: string;
    args: string[];
};
