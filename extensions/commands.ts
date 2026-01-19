/**
 * Commands Overview Extension - Compact command reference as overlay
 * Access via /commands, ctrl+/, or F1
 *
 * Shows as overlay so you can still type in the editor
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { matchesKey } from "@mariozechner/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ═══════════════════════════════════════════════════════════════════════════
// Discovery
// ═══════════════════════════════════════════════════════════════════════════

function discoverSkillNames(): string[] {
    const names: string[] = [];
    const seen = new Set<string>();

    const dirs = [
        path.join(os.homedir(), ".codex", "skills"),
        path.join(os.homedir(), ".claude", "skills"),
        path.join(os.homedir(), ".pi", "agent", "skills"),
        path.join(process.cwd(), ".pi", "skills"),
    ];

    for (const dir of dirs) {
        if (!fs.existsSync(dir)) continue;
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.name.startsWith(".")) continue;
                if (entry.isDirectory() || entry.isSymbolicLink()) {
                    const skillFile = path.join(dir, entry.name, "SKILL.md");
                    if (fs.existsSync(skillFile) && !seen.has(entry.name)) {
                        seen.add(entry.name);
                        names.push(entry.name);
                    }
                }
            }
        } catch { /* skip */ }
    }
    return names.sort();
}

function discoverTemplateNames(): string[] {
    const names: string[] = [];
    const seen = new Set<string>();

    const dirs = [
        path.join(os.homedir(), ".pi", "agent", "prompts"),
        path.join(os.homedir(), ".codex", "prompts"),
        path.join(process.cwd(), ".pi", "prompts"),
    ];

    for (const dir of dirs) {
        if (!fs.existsSync(dir)) continue;
        try {
            const files = fs.readdirSync(dir);
            for (const file of files) {
                if (file.endsWith(".md") && !file.startsWith(".")) {
                    const name = file.replace(/\.md$/, "");
                    if (!seen.has(name)) {
                        seen.add(name);
                        names.push(name);
                    }
                }
            }
        } catch { /* skip */ }
    }
    return names.sort();
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers - handle ANSI codes properly
// ═══════════════════════════════════════════════════════════════════════════

function visLen(s: string): number {
    return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function padRight(s: string, width: number): string {
    const visible = visLen(s);
    const padding = Math.max(0, width - visible);
    return s + " ".repeat(padding);
}

function makeColumns(items: string[], colWidth: number, maxCols: number): string[] {
    const lines: string[] = [];
    for (let i = 0; i < items.length; i += maxCols) {
        const row = items.slice(i, i + maxCols);
        lines.push(row.map(s => padRight(s, colWidth)).join(""));
    }
    return lines;
}

// ═══════════════════════════════════════════════════════════════════════════
// Build compact lines
// ═══════════════════════════════════════════════════════════════════════════

function buildAllLines(width: number): string[] {
    const lines: string[] = [];
    const g = (s: string) => `\x1b[32m${s}\x1b[0m`;  // green
    const c = (s: string) => `\x1b[36m${s}\x1b[0m`;  // cyan
    const y = (s: string) => `\x1b[33m${s}\x1b[0m`;  // yellow
    const b = (s: string) => `\x1b[1m${s}\x1b[0m`;   // bold
    const d = (s: string) => `\x1b[2m${s}\x1b[0m`;   // dim

    const usableWidth = Math.max(60, width - 6);

    // // KEYBINDINGS - compact format
    // lines.push(y(b("KEYBINDINGS")));
    // const keybindings = [
    //     "esc → interrupt", "ctrl+c → clear", "ctrl+d → exit",
    //     "ctrl+z → suspend", "ctrl+k → del-end", "shift+tab → think",
    //     "ctrl+p → model↑", "S-C-p → model↓", "ctrl+l → models",
    //     "ctrl+o → expand", "ctrl+t → thinking", "ctrl+g → editor",
    //     "ctrl+v → paste", "alt+ret → queue", "alt+↑ → edit-q",
    //     "/ → menu", "! → bash", "!! → bash-noctx"
    // ];
    // const kbCols = Math.min(6, Math.floor(usableWidth / 17));
    // for (const line of makeColumns(keybindings.map(d), 17, kbCols)) {
    //     lines.push("  " + line);
    // }
    // lines.push("");

    // BUILT-IN COMMANDS
    lines.push(y(b("BUILT-IN")));
    const builtins = [
        "/new", "/resume", "/tree", "/fork", "/compact",
        "/model", "/settings", "/export", "/share", "/sessions",
        "/labels", "/thinking", "/images", "/theme", "/keybindings"
    ];
    const builtinCols = Math.min(7, Math.floor(usableWidth / 14));
    for (const line of makeColumns(builtins.map(g), 14, builtinCols)) {
        lines.push("  " + line);
    }
    lines.push("");

    // EXTENSION COMMANDS
    lines.push(y(b("EXTENSIONS")));
    const extCmds = [
        "/commands", "/code", "/ephemeral", "/notify", "/oracle",
        "/paste", "/plan", "/preset", "/review", "/end-review",
        "/rpbind", "/savelog", "/skill", "/speedread", "/todos",
        "/tools", "/ultrathink", "/usage"
    ];
    const extCols = Math.min(6, Math.floor(usableWidth / 15));
    for (const line of makeColumns(extCmds.map(g), 15, extCols)) {
        lines.push("  " + line);
    }
    lines.push("");

    // PROMPT TEMPLATES
    const templates = discoverTemplateNames();
    lines.push(y(b(`PROMPTS (${templates.length})`)));
    if (templates.length > 0) {
        const tplCmds = templates.map(t => c(`/${t}`));
        const longestTpl = Math.max(...templates.map(t => t.length)) + 2;
        const tplCols = Math.max(3, Math.floor(usableWidth / (longestTpl + 2)));
        const tplColWidth = Math.floor(usableWidth / tplCols);
        for (const line of makeColumns(tplCmds, tplColWidth, tplCols)) {
            lines.push("  " + line);
        }
    }
    lines.push("");

    // SKILLS
    const skills = discoverSkillNames();
    lines.push(y(b(`SKILLS (${skills.length})`)));
    if (skills.length > 0) {
        const skillCmds = skills.map(s => " /" + c(`${s}`));
        const longestSkill = Math.max(...skills.map(s => s.length)) + 9;
        const skillCols = Math.max(2, Math.floor(usableWidth / (longestSkill + 2)));
        const skillColWidth = Math.floor(usableWidth / skillCols);
        for (const line of makeColumns(skillCmds, skillColWidth, skillCols)) {
            lines.push("  " + line);
        }
    }

    return lines;
}

// ═══════════════════════════════════════════════════════════════════════════
// Extension
// ═══════════════════════════════════════════════════════════════════════════

export default function commandsExtension(pi: ExtensionAPI): void {
    const showCommands = async (ctx: ExtensionContext) => {
        let scroll = 0;
        let cachedLines: string[] = [];
        let cachedWidth = 0;

        await ctx.ui.custom<void>(
            (tui, theme, _kb, done) => {
                return {
                    render(width: number) {
                        // Rebuild lines if width changed
                        if (width !== cachedWidth) {
                            cachedLines = buildAllLines(width);
                            cachedWidth = width;
                        }

                        const height = tui.height || 30;
                        const visibleHeight = Math.max(5, height - 6);
                        const maxScroll = Math.max(0, cachedLines.length - visibleHeight);
                        scroll = Math.max(0, Math.min(scroll, maxScroll));

                        const output: string[] = [];

                        // Header with border
                        output.push(theme.fg("dim", "┌" + "─".repeat(width - 2) + "┐"));
                        const headerContent = theme.fg("accent", theme.bold("COMMANDS")) + theme.fg("dim", "            ↑↓ → scroll      esc or ctrl+/ → exit");
                        const headerTextLen = 8 + 12 + 15 + 22;  // COMMANDS + spacing + arrows + exit text
                        const headerPad = Math.max(0, width - 4 - headerTextLen);
                        output.push(theme.fg("dim", "│ ") + headerContent + " ".repeat(headerPad) + theme.fg("dim", " │"));
                        output.push(theme.fg("dim", "├" + "─".repeat(width - 2) + "┤"));

                        const visible = cachedLines.slice(scroll, scroll + visibleHeight);
                        for (const line of visible) {
                            const paddedLine = line + " ".repeat(Math.max(0, width - 4 - visLen(line)));
                            output.push(theme.fg("dim", "│ ") + paddedLine + theme.fg("dim", " │"));
                        }

                        // Pad remaining space
                        for (let i = visible.length; i < visibleHeight; i++) {
                            output.push(theme.fg("dim", "│") + " ".repeat(width - 2) + theme.fg("dim", "│"));
                        }

                        // Footer with scroll info
                        const scrollInfo = maxScroll > 0
                            ? ` ${scroll + 1}-${scroll + visible.length}/${cachedLines.length} `
                            : "";
                        const footerPad = Math.max(0, width - 2 - scrollInfo.length);
                        output.push(theme.fg("dim", "└" + "─".repeat(Math.floor(footerPad/2)) + scrollInfo + "─".repeat(Math.ceil(footerPad/2)) + "┘"));

                        return output;
                    },
                    handleInput(data: string) {
                        const height = tui.height || 30;
                        const visibleHeight = Math.max(5, height - 6);
                        const maxScroll = Math.max(0, cachedLines.length - visibleHeight);

                        if (matchesKey(data, "escape") || matchesKey(data, "ctrl+/") || matchesKey(data, "ctrl+_")) {
                            done(undefined);
                            return;
                        }
                        if (matchesKey(data, "up") || data === "k") {
                            scroll = Math.max(0, scroll - 1);
                        } else if (matchesKey(data, "down") || data === "j") {
                            scroll = Math.min(maxScroll, scroll + 1);
                        } else if (matchesKey(data, "pageup")) {
                            scroll = Math.max(0, scroll - 10);
                        } else if (matchesKey(data, "pagedown")) {
                            scroll = Math.min(maxScroll, scroll + 10);
                        } else if (data === "g") {
                            scroll = 0;
                        } else if (data === "G") {
                            scroll = maxScroll;
                        }
                        tui.requestRender();
                    },
                    invalidate() {},
                };
            },
            { overlay: true }  // This keeps the editor visible!
        );
    };

    pi.registerCommand("commands", {
        description: "Show all commands (overlay)",
        handler: async (_args, ctx) => await showCommands(ctx),
    });

    pi.registerShortcut("ctrl+/", {
        description: "Show commands",
        handler: showCommands,
    });

    pi.registerShortcut("ctrl+_", {
        description: "Show commands",
        handler: showCommands,
    });

    pi.registerShortcut("f1", {
        description: "Show commands",
        handler: showCommands,
    });
}
