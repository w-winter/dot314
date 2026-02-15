/**
 * Ephemeral Mode Extension
 *
 * Toggle session persistence on/off mid-session.
 * When ephemeral mode is enabled, the session file is deleted on exit.
 *
 * Usage:
 *   /ephemeral  - Toggle ephemeral mode
 *   Alt+E      - Toggle ephemeral mode (shortcut)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { unlinkSync, existsSync } from "node:fs";

export default function (pi: ExtensionAPI) {
    let ephemeralMode = false;

    // When switching sessions, pi doesn't exit, so session_shutdown won't fire for the previous session.
    // Track the previous session file here so we can delete it after a successful switch when ephemeral mode was enabled
    let pendingDeleteSessionFile: string | null = null;

    // Reconstruct state from the *current branch* so /tree navigation properly restores branch-specific state
    const reconstructStateFromBranch = (ctx: any) => {
        ephemeralMode = false;

        for (const entry of ctx.sessionManager.getBranch()) {
            if (entry.type === "custom" && entry.customType === "ephemeral-mode") {
                ephemeralMode = entry.data?.enabled ?? false;
            }
        }

        if (!ctx.hasUI) {
            return;
        }

        if (ephemeralMode) {
            ctx.ui.setStatus("ephemeral", ctx.ui.theme.fg("warning", "儚"));
        } else {
            ctx.ui.setStatus("ephemeral", undefined);
        }
    };

    const toggleEphemeral = async (ctx: any) => {
        ephemeralMode = !ephemeralMode;

        // Persist the state in the session branch (for /tree navigation)
        pi.appendEntry("ephemeral-mode", { enabled: ephemeralMode });

        if (!ctx.hasUI) {
            return;
        }

        if (ephemeralMode) {
            ctx.ui.setStatus("ephemeral", ctx.ui.theme.fg("warning", "儚"));
            ctx.ui.notify("Ephemeral mode ON - session will be deleted on exit", "warning");
        } else {
            ctx.ui.setStatus("ephemeral", undefined);
            ctx.ui.notify("Ephemeral mode OFF - session will be preserved", "info");
        }
    };

    const clearIndicator = (ctx: any) => {
        ephemeralMode = false;
        if (ctx?.hasUI) {
            ctx.ui.setStatus("ephemeral", undefined);
        }
    };

    const deleteSessionFileBestEffort = async (sessionFile: string) => {
        try {
            const { code } = await pi.exec("trash", [sessionFile], { timeout: 5000 });
            if (code === 0) {
                return;
            }
        } catch {
            // ignore
        }

        // Fallback to direct deletion
        try {
            if (existsSync(sessionFile)) {
                unlinkSync(sessionFile);
            }
        } catch {
            // ignore
        }
    };

    pi.on("session_start", async (_event, ctx) => {
        reconstructStateFromBranch(ctx);
    });

    pi.on("session_before_switch", async (_event, ctx) => {
        // If we are leaving an ephemeral session, schedule its file for deletion after a successful switch
        if (ephemeralMode) {
            const sessionFile = ctx.sessionManager.getSessionFile();
            if (sessionFile) {
                pendingDeleteSessionFile = sessionFile;
            }
        }

        // Clear the indicator immediately so it never visually leaks into the switcher UI or next session
        clearIndicator(ctx);
    });

    pi.on("session_switch", async (_event, ctx) => {
        // Some pi versions update session state very close to this event; yield once to ensure ctx.sessionManager is current
        await new Promise((resolve) => setTimeout(resolve, 0));
        reconstructStateFromBranch(ctx);

        // Now that we've successfully switched away, delete the previous session if it was ephemeral
        if (pendingDeleteSessionFile) {
            const toDelete = pendingDeleteSessionFile;
            pendingDeleteSessionFile = null;
            await deleteSessionFileBestEffort(toDelete);
        }
    });

    pi.on("session_tree", async (_event, ctx) => {
        reconstructStateFromBranch(ctx);
    });

    pi.on("session_fork", async (_event, ctx) => {
        reconstructStateFromBranch(ctx);
    });

    pi.registerCommand("ephemeral", {
        description: "Toggle ephemeral mode (delete session file on exit)",
        handler: async (_args, ctx) => {
            await toggleEphemeral(ctx);
        },
    });

    pi.registerShortcut("alt+e", {
        description: "Toggle ephemeral mode",
        handler: async (ctx) => {
            await toggleEphemeral(ctx);
        },
    });

    pi.on("session_shutdown", async (_event, ctx) => {
        if (!ephemeralMode) return;

        const sessionFile = ctx.sessionManager.getSessionFile();
        if (!sessionFile) return; // Already in-memory mode

        try {
            // Try using trash first (safer)
            const { code } = await pi.exec("trash", [sessionFile], { timeout: 5000 });

            if (code !== 0) {
                // Fallback to direct deletion
                if (existsSync(sessionFile)) {
                    unlinkSync(sessionFile);
                }
            }
        } catch {
            // Last resort: direct deletion
            try {
                if (existsSync(sessionFile)) {
                    unlinkSync(sessionFile);
                }
            } catch {
                // Can't do much at shutdown, silently fail
            }
        }
    });
}
