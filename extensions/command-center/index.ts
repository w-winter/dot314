/**
 * Command Center Extension
 *
 * A scrollable commands cheat sheet shown as a widget above the editor.
 *
 * Keybindings are configured in ./config.json (relative to this file).
 */

import type { ExtensionAPI, ExtensionContext, SlashCommandInfo } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Note: pi.getCommands() does NOT include built-in interactive commands (e.g. /model, /settings)
// because those do not execute when sent via prompt. Until the extension API exposes built-ins,
// we keep a small local list in case includeBuiltins is configured true
const BUILTIN_COMMANDS: string[] = [
    "/settings",
    "/model",
    "/scoped-models",
    "/name",
    "/session",
    "/reload",
    "/compact",
    "/tree",
    "/fork",
    "/new",
    "/resume",
    "/export",
    "/copy",
    "/share",
    "/hotkeys",
    "/changelog",
    "/login",
    "/logout",
];

type ExtensionKeybindingsConfig = {
    toggle?: string | null;
    scrollUp?: string | null;
    scrollDown?: string | null;
    scrollPageUp?: string | null;
    scrollPageDown?: string | null;
};

type ExtensionLayoutConfig = {
    /**
     * Fixed widget height in rows.
     *
     * If omitted, height is computed from terminal height.
     */
    height?: number | null;
};

type ExtensionDisplayConfig = {
    /**
     * Whether to include built-in interactive commands in the widget output
     *
     * Recommended default: false
     * - Built-ins are already discoverable via the editor's native `/` autocomplete
     * - Keeping built-ins here requires manually maintaining a list as pi evolves
     */
    includeBuiltins?: boolean;
};

type ExtensionConfig = {
    keybindings?: ExtensionKeybindingsConfig;
    layout?: ExtensionLayoutConfig;
    display?: ExtensionDisplayConfig;
};

const DEFAULT_CONFIG: Required<ExtensionConfig> = {
    keybindings: {
        toggle: "ctrl+shift+/",
        scrollUp: "ctrl+shift+up",
        scrollDown: "ctrl+shift+down",
        scrollPageUp: null,
        scrollPageDown: null,
    },
    layout: {
        height: null,
    },
    display: {
        includeBuiltins: false,
    },
};

function loadConfig(): Required<ExtensionConfig> {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const configPath = path.join(dir, "config.json");

    if (!fs.existsSync(configPath)) {
        return DEFAULT_CONFIG;
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as ExtensionConfig;
        const keybindings = {
            ...DEFAULT_CONFIG.keybindings,
            ...(parsed.keybindings ?? {}),
        };
        const layout = {
            ...DEFAULT_CONFIG.layout,
            ...(parsed.layout ?? {}),
        };
        const display = {
            ...DEFAULT_CONFIG.display,
            ...(parsed.display ?? {}),
        };
        return { keybindings, layout, display };
    } catch {
        // If config is invalid, fall back to defaults rather than breaking the session
        return DEFAULT_CONFIG;
    }
}

function visLen(s: string): number {
    return visibleWidth(s);
}

function padRight(s: string, width: number): string {
    const visible = visLen(s);
    const padding = Math.max(0, width - visible);
    return s + " ".repeat(padding);
}

function makeColumns(items: string[], colWidth: number, maxCols: number): string[] {
    const lines: string[] = [];

    // Fill columns vertically (column-major) so alphabetical lists read top-to-bottom
    // within each column:
    // col1 col2 col3
    // a    e    i
    // b    f    j
    // ...
    const rows = Math.ceil(items.length / maxCols);

    for (let rowIndex = 0; rowIndex < rows; rowIndex++) {
        const row: string[] = [];
        for (let colIndex = 0; colIndex < maxCols; colIndex++) {
            const itemIndex = colIndex * rows + rowIndex;
            row.push(itemIndex < items.length ? items[itemIndex] : "");
        }
        lines.push(row.map((s) => padRight(s, colWidth)).join(""));
    }

    return lines;
}

function clamp(n: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, n));
}

function truncatePlain(s: string, maxVisibleChars: number): string {
    if (s.length <= maxVisibleChars) return s;
    if (maxVisibleChars <= 1) return "…";
    return s.slice(0, maxVisibleChars - 1) + "…";
}

function sortCommandStrings(values: string[]): string[] {
    return [...values].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

function buildAllLines(width: number, commands: SlashCommandInfo[], options: { includeBuiltins: boolean }): string[] {
    const lines: string[] = [];
    const g = (s: string) => `\x1b[32m${s}\x1b[0m`; // green
    const c = (s: string) => `\x1b[36m${s}\x1b[0m`; // cyan
    const y = (s: string) => `\x1b[33m${s}\x1b[0m`; // yellow
    const b = (s: string) => `\x1b[1m${s}\x1b[0m`; // bold

    const usableWidth = Math.max(60, width - 6);

    const builtins = BUILTIN_COMMANDS;
    const extensions = sortCommandStrings(
        commands.filter((command) => command.source === "extension").map((command) => `/${command.name}`),
    );
    const prompts = sortCommandStrings(
        commands.filter((command) => command.source === "prompt").map((command) => `/${command.name}`),
    );
    const skills = sortCommandStrings(
        commands.filter((command) => command.source === "skill").map((command) => `/${command.name}`),
    );

    // Order: extensions -> prompts -> skills -> builtins (optional)

    lines.push(y(b(`EXTENSIONS (${extensions.length})`)));
    {
        const maxItemLen = extensions.length > 0 ? Math.max(...extensions.map((s) => s.length)) : 0;
        const colWidth = clamp(maxItemLen + 2, 15, 34);
        const cols = Math.min(6, Math.max(1, Math.floor(usableWidth / colWidth)));
        const items = extensions.map((s) => g(truncatePlain(s, colWidth - 1)));
        for (const line of makeColumns(items, colWidth, cols)) {
            lines.push("  " + line);
        }
    }
    lines.push("");

    lines.push(y(b(`PROMPTS (${prompts.length})`)));
    if (prompts.length > 0) {
        const maxItemLen = Math.max(...prompts.map((s) => s.length));
        const colWidth = clamp(maxItemLen + 2, 18, 40);
        const cols = Math.max(1, Math.floor(usableWidth / colWidth));
        const items = prompts.map((s) => c(truncatePlain(s, colWidth - 1)));
        for (const line of makeColumns(items, colWidth, cols)) {
            lines.push("  " + line);
        }
    }
    lines.push("");

    lines.push(y(b(`SKILLS (${skills.length})`)));
    if (skills.length > 0) {
        const maxItemLen = Math.max(...skills.map((s) => s.length));
        const colWidth = clamp(maxItemLen + 2, 18, 40);
        const cols = Math.max(1, Math.floor(usableWidth / colWidth));
        const items = skills.map((s) => c(truncatePlain(s, colWidth - 1)));
        for (const line of makeColumns(items, colWidth, cols)) {
            lines.push("  " + line);
        }
    }
    if (options.includeBuiltins) {
        lines.push("");

        lines.push(y(b(`BUILT-IN (${builtins.length})`)));
        {
            const maxItemLen = builtins.length > 0 ? Math.max(...builtins.map((s) => s.length)) : 0;
            const colWidth = clamp(maxItemLen + 2, 14, 24);
            const cols = Math.min(7, Math.max(1, Math.floor(usableWidth / colWidth)));
            const items = builtins.map((s) => g(truncatePlain(s, colWidth - 1)));
            for (const line of makeColumns(items, colWidth, cols)) {
                lines.push("  " + line);
            }
        }
    }

    return lines;
}

type WidgetTheme = {
    fg: (style: string, text: string) => string;
    bold: (text: string) => string;
};

type WidgetTui = {
    height?: number;
    requestRender: () => void;
};

function prettyKeybinding(key: string | null | undefined): string {
    if (!key) return "(unbound)";

    // make a few things more readable
    return key
        .replaceAll("pageUp", "PgUp")
        .replaceAll("pageDown", "PgDn")
        .replaceAll("shift+", "Shift+")
        .replaceAll("alt+", "Alt+")
        .replaceAll("ctrl+", "Ctrl+")
        .replaceAll("up", "↑")
        .replaceAll("down", "↓")
        .replaceAll("left", "←")
        .replaceAll("right", "→");
}

class CommandCenterWidget {
    private tui: WidgetTui;
    private theme: WidgetTheme;
    private pi: ExtensionAPI;
    private config: Required<ExtensionConfig>;

    private scroll: number = 0;
    private cachedWidth: number = 0;
    private cachedLines: string[] = [];

    constructor(tui: WidgetTui, theme: WidgetTheme, pi: ExtensionAPI, config: Required<ExtensionConfig>) {
        this.tui = tui;
        this.theme = theme;
        this.pi = pi;
        this.config = config;
    }

    updateTheme(theme: WidgetTheme): void {
        this.theme = theme;
        this.invalidate();
    }

    updateConfig(config: Required<ExtensionConfig>): void {
        this.config = config;
        this.invalidate();
    }

    invalidate(): void {
        this.cachedWidth = 0;
        this.cachedLines = [];
    }

    scrollBy(delta: number): void {
        this.scroll += delta;
        this.tui.requestRender();
    }

    render(width: number): string[] {
        const terminalHeight = this.tui.height ?? 54;

        // Keep at least a few rows for the editor
        const maxAllowedHeight = Math.max(10, terminalHeight - 6);

        const configuredHeight = this.config.layout.height;
        const height = configuredHeight
            ? clamp(Math.floor(configuredHeight), 6, maxAllowedHeight)
            : clamp(Math.floor(terminalHeight * 0.35) + 2, 10, Math.min(18, maxAllowedHeight));
        const innerHeight = Math.max(3, height - 4);

        if (width !== this.cachedWidth) {
            this.cachedLines = buildAllLines(width, this.pi.getCommands(), {
                includeBuiltins: this.config.display.includeBuiltins,
            });
            this.cachedWidth = width;
        }

        const maxScroll = Math.max(0, this.cachedLines.length - innerHeight);
        this.scroll = clamp(this.scroll, 0, maxScroll);

        const output: string[] = [];

        const toggleKey = prettyKeybinding(this.config.keybindings.toggle);
        const scrollUpKey = prettyKeybinding(this.config.keybindings.scrollUp);
        const scrollDownKey = prettyKeybinding(this.config.keybindings.scrollDown);

        const builtinHint = this.config.display.includeBuiltins
            ? "built-ins included"
            : "built-ins: type / in editor";

        const header =
            this.theme.fg("accent", this.theme.bold("COMMAND CENTER")) +
            this.theme.fg("dim", `  (toggle ${toggleKey}, scroll ${scrollUpKey}/${scrollDownKey}; ${builtinHint})`);

        output.push(this.theme.fg("dim", "┌" + "─".repeat(width - 2) + "┐"));
        output.push(
            this.theme.fg("dim", "│ ") +
                truncateToWidth(header, width - 4, "…", true) +
                this.theme.fg("dim", " │"),
        );
        output.push(this.theme.fg("dim", "├" + "─".repeat(width - 2) + "┤"));

        const visible = this.cachedLines.slice(this.scroll, this.scroll + innerHeight);
        for (const line of visible) {
            const content = truncateToWidth(line, width - 4, "…", true);
            output.push(this.theme.fg("dim", "│ ") + content + this.theme.fg("dim", " │"));
        }

        for (let i = visible.length; i < innerHeight; i++) {
            output.push(this.theme.fg("dim", "│") + " ".repeat(width - 2) + this.theme.fg("dim", "│"));
        }

        const scrollInfo =
            maxScroll > 0 ? ` ${this.scroll + 1}-${this.scroll + visible.length}/${this.cachedLines.length} ` : "";
        const footerPad = Math.max(0, width - 2 - scrollInfo.length);
        output.push(
            this.theme.fg(
                "dim",
                "└" +
                    "─".repeat(Math.floor(footerPad / 2)) +
                    scrollInfo +
                    "─".repeat(Math.ceil(footerPad / 2)) +
                    "┘",
            ),
        );

        return output.slice(0, height);
    }
}

export default function commandCenterExtension(pi: ExtensionAPI): void {
    const WIDGET_ID = "command-center";

    let widget: CommandCenterWidget | undefined;
    let visible = false;

    const readConfigAndUpdateWidget = () => {
        const config = loadConfig();
        if (widget) {
            widget.updateConfig(config);
        }
        return config;
    };

    const show = (ctx: ExtensionContext) => {
        const config = readConfigAndUpdateWidget();

        ctx.ui.setWidget(
            WIDGET_ID,
            (tui, theme) => {
                if (!widget) {
                    widget = new CommandCenterWidget(
                        tui as unknown as WidgetTui,
                        theme as unknown as WidgetTheme,
                        pi,
                        config,
                    );
                } else {
                    widget.updateTheme(theme as unknown as WidgetTheme);
                    widget.updateConfig(config);
                }
                return widget as any;
            },
            { placement: "aboveEditor" },
        );
        visible = true;
    };

    const hide = (ctx: ExtensionContext) => {
        ctx.ui.setWidget(WIDGET_ID, undefined);
        visible = false;
        widget = undefined;
    };

    const toggle = (ctx: ExtensionContext) => {
        if (visible) {
            hide(ctx);
        } else {
            show(ctx);
        }
    };

    pi.registerCommand("command-center", {
        description: "Toggle command center widget",
        handler: async (_args, ctx) => {
            toggle(ctx);
        },
    });

    // Shortcut bindings from config.json
    const config = loadConfig();

    const registerIfSet = (
        key: string | null | undefined,
        description: string,
        handler: (ctx: ExtensionContext) => void,
    ) => {
        if (!key) return;
        pi.registerShortcut(key as any, { description, handler });
    };

    registerIfSet(config.keybindings.toggle, "Toggle command center widget", toggle);

    registerIfSet(config.keybindings.scrollUp, "Scroll command center up", () => {
        if (!visible || !widget) return;
        widget.scrollBy(-1);
    });

    registerIfSet(config.keybindings.scrollDown, "Scroll command center down", () => {
        if (!visible || !widget) return;
        widget.scrollBy(1);
    });

    registerIfSet(config.keybindings.scrollPageUp, "Scroll command center up (page)", () => {
        if (!visible || !widget) return;
        widget.scrollBy(-10);
    });

    registerIfSet(config.keybindings.scrollPageDown, "Scroll command center down (page)", () => {
        if (!visible || !widget) return;
        widget.scrollBy(10);
    });
}
