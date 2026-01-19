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

    // Reconstruct state from session (survives /tree navigation, session restore)
    const reconstructState = (entries: any[]) => {
        ephemeralMode = false;
        for (const entry of entries) {
            if (entry.type === "custom" && entry.customType === "ephemeral-mode") {
                ephemeralMode = entry.data?.enabled ?? false;
            }
        }
    };

    const toggleEphemeral = async (ctx: any) => {
        ephemeralMode = !ephemeralMode;

        // Persist the state in session (for branch navigation)
        pi.appendEntry("ephemeral-mode", { enabled: ephemeralMode });

        if (ephemeralMode) {
            ctx.ui.setStatus("ephemeral", ctx.ui.theme.fg("warning", "儚"));
            ctx.ui.notify("Ephemeral mode ON - session will be deleted on exit", "warning");
        } else {
            ctx.ui.setStatus("ephemeral", undefined);
            ctx.ui.notify("Ephemeral mode OFF - session will be preserved", "info");
        }
    };

    pi.on("session_start", async (_event, ctx) => {
        reconstructState(ctx.sessionManager.getEntries());
        if (ephemeralMode) {
            ctx.ui.setStatus("ephemeral", ctx.ui.theme.fg("warning", "儚"));
        }
    });

    pi.on("session_tree", async (_event, ctx) => {
        reconstructState(ctx.sessionManager.getEntries());
        if (ephemeralMode) {
            ctx.ui.setStatus("ephemeral", ctx.ui.theme.fg("warning", "儚"));
        } else {
            ctx.ui.setStatus("ephemeral", undefined);
        }
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
