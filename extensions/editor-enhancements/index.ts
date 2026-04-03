/**
 * editor-enhancements
 *
 * Composite custom editor that combines:
 * - shell-completions (autocomplete wrapping for !/!! mode)
 * - file-picker (@ opens overlay file browser)
 * - raw-paste alt+v (paste clipboard text "raw" into editor, bypassing large-paste markers)
 *
 * NOTE: This extension intentionally owns ctx.ui.setEditorComponent().
 * Disable other extensions that also call setEditorComponent (shell-completions/, file-picker.ts, raw-paste.ts)
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { loadConfig } from "./config.js";
import { EnhancedEditor } from "./enhanced-editor.js";

function resolveDoubleEscapeCommand(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    doubleEscapeCommand: string | null,
): string | null {
    if (!doubleEscapeCommand) return null;

    const hasMatchingExtensionCommand = pi.getCommands().some(
        (command) => command.source === "extension" && command.name === doubleEscapeCommand,
    );

    if (hasMatchingExtensionCommand) {
        return doubleEscapeCommand;
    }

    ctx.ui.notify(
        `editor-enhancements: configured doubleEscapeCommand '/${doubleEscapeCommand}' is not a registered extension command`,
        "warning",
    );
    return null;
}

export default function (pi: ExtensionAPI) {
    let activeContext: ExtensionContext | null = null;
    let activeEditor: EnhancedEditor | null = null;

    const attachEditor = (ctx: ExtensionContext) => {
        if (!ctx.hasUI) return;

        activeContext = ctx;
        const config = loadConfig();
        const doubleEscapeCommand = resolveDoubleEscapeCommand(pi, ctx, config.doubleEscapeCommand);

        ctx.ui.setEditorComponent((tui, theme, keybindings) => {
            activeEditor = new EnhancedEditor(tui, theme, keybindings, ctx.ui, {
                doubleEscapeCommand,
                canTriggerDoubleEscapeCommand: () => {
                    if (!activeContext) return false;
                    return activeContext.isIdle() && !activeContext.hasPendingMessages();
                },
                commandRemap: config.commandRemap,
            });
            return activeEditor;
        });
    };

    pi.on("session_start", (_event, ctx) => {
        attachEditor(ctx);
    });

    // Provide alt+v raw clipboard paste (the only raw-paste feature you wanted)
    pi.registerShortcut("alt+v", {
        description: "Paste clipboard text raw into editor (bypasses [paste #..] markers)",
        handler: async (ctx) => {
            if (!ctx.hasUI) return;
            if (!activeEditor) {
                ctx.ui.notify("Editor not ready", "warning");
                return;
            }
            await activeEditor.pasteClipboardRawAtCursor();
        },
    });
}
