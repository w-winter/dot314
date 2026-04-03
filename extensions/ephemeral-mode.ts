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

import { SessionManager, type ExtensionAPI, type SessionEntry } from "@mariozechner/pi-coding-agent";
import { existsSync, unlinkSync } from "node:fs";

export default function (pi: ExtensionAPI) {
    let ephemeralMode = false;

    const isEphemeralEnabled = (entries: SessionEntry[]) => {
        let enabled = false;

        for (const entry of entries) {
            if (entry.type === "custom" && entry.customType === "ephemeral-mode") {
                enabled = entry.data?.enabled ?? false;
            }
        }

        return enabled;
    };

    // Reconstruct state from the *current branch* so /tree navigation properly restores branch-specific state
    const reconstructStateFromBranch = (ctx: any) => {
        ephemeralMode = isEphemeralEnabled(ctx.sessionManager.getBranch());

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

    const deletePreviousEphemeralSessionIfNeeded = async (previousSessionFile?: string, currentSessionFile?: string) => {
        if (!previousSessionFile || previousSessionFile === currentSessionFile) {
            return;
        }

        try {
            const previousSession = SessionManager.open(previousSessionFile);
            if (!isEphemeralEnabled(previousSession.getBranch())) {
                return;
            }
        } catch {
            return;
        }

        await deleteSessionFileBestEffort(previousSessionFile);
    };

    pi.on("session_start", async (event, ctx) => {
        if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") {
            await deletePreviousEphemeralSessionIfNeeded(
                event.previousSessionFile,
                ctx.sessionManager.getSessionFile() ?? undefined,
            );
        }

        reconstructStateFromBranch(ctx);
    });

    pi.on("session_before_switch", async (_event, ctx) => {
        // Clear the indicator immediately so it never visually leaks into the switcher UI or next session
        clearIndicator(ctx);
    });

    pi.on("session_tree", async (_event, ctx) => {
        reconstructStateFromBranch(ctx);
    });

    pi.on("session_before_fork", async (_event, ctx) => {
        // Clear the indicator immediately so it never visually leaks into the picker UI or next session
        clearIndicator(ctx);
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

        await deleteSessionFileBestEffort(sessionFile);
    });
}
