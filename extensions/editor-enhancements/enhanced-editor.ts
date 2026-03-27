import { CustomEditor, type ExtensionUIContext, type KeybindingsManager } from "@mariozechner/pi-coding-agent";
import {
    type AutocompleteItem,
    type AutocompleteProvider,
    type AutocompleteSuggestions,
    type EditorTheme,
    type TUI,
} from "@mariozechner/pi-tui";
import * as Clipboard from "@mariozechner/clipboard";

import { openFilePicker } from "./file-picker.js";
import {
    findCompletionShell,
    getShellCompletions,
    type ShellInfo,
} from "./shell-completions.js";

type EnhancedEditorOptions = {
    doubleEscapeCommand: string | null;
    canTriggerDoubleEscapeCommand: () => boolean;
    commandRemap: Record<string, string>;
};

const DOUBLE_ESCAPE_WINDOW_MS = 500;

function isAtCompletionContext(lines: string[], cursorLine: number, cursorCol: number): boolean {
    const line = lines[cursorLine] ?? "";
    const beforeCursor = line.slice(0, cursorCol);
    return Boolean(beforeCursor.match(/(?:^|[\s])@[^\s]*$/));
}

function isBashMode(lines: string[]): boolean {
    const text = lines.join("\n").trimStart();
    return text.startsWith("!") || text.startsWith("!!");
}

function extractCompletionTextUpToCursor(lines: string[], cursorLine: number, cursorCol: number): string {
    const textLines = lines.slice(0, cursorLine + 1);
    if (textLines.length > 0) {
        textLines[textLines.length - 1] = (textLines[textLines.length - 1] ?? "").slice(0, cursorCol);
    }
    return textLines.join("\n");
}

function wrapProviderWithShellAndAtFiltering(provider: AutocompleteProvider, shell: ShellInfo): AutocompleteProvider {
    return {
        async getSuggestions(
            lines: string[],
            cursorLine: number,
            cursorCol: number,
            options: { signal: AbortSignal; force?: boolean },
        ): Promise<AutocompleteSuggestions | null> {
            // If user is typing an @ reference, suppress the native autocomplete
            // (we handle "@" ourselves by opening the picker)
            if (isAtCompletionContext(lines, cursorLine, cursorCol)) {
                return null;
            }

            if (isBashMode(lines)) {
                const text = extractCompletionTextUpToCursor(lines, cursorLine, cursorCol);
                const result = getShellCompletions(text, process.cwd(), shell);
                if (result && result.items.length > 0) {
                    return result;
                }
            }

            return provider.getSuggestions(lines, cursorLine, cursorCol, options);
        },

        applyCompletion(
            lines: string[],
            cursorLine: number,
            cursorCol: number,
            item: AutocompleteItem,
            prefix: string,
        ): { lines: string[]; cursorLine: number; cursorCol: number } {
            if (isBashMode(lines)) {
                const currentLine = lines[cursorLine] || "";
                const prefixStart = cursorCol - prefix.length;
                const beforePrefix = currentLine.slice(0, prefixStart);
                const afterCursor = currentLine.slice(cursorCol);

                // Don't add space after directories
                const isDirectory = item.value.endsWith("/");
                const suffix = isDirectory ? "" : " ";

                const newLine = beforePrefix + item.value + suffix + afterCursor;
                const newLines = [...lines];
                newLines[cursorLine] = newLine;

                return {
                    lines: newLines,
                    cursorLine,
                    cursorCol: prefixStart + item.value.length + suffix.length,
                };
            }

            return provider.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
        },

        // Forward optional methods (duck typed)
        getForceFileSuggestions(
            lines: string[],
            cursorLine: number,
            cursorCol: number,
        ): { items: AutocompleteItem[]; prefix: string } | null {
            if (isBashMode(lines)) {
                const text = extractCompletionTextUpToCursor(lines, cursorLine, cursorCol);
                return getShellCompletions(text, process.cwd(), shell);
            }
            if ("getForceFileSuggestions" in provider) {
                return (provider as any).getForceFileSuggestions(lines, cursorLine, cursorCol);
            }
            return this.getSuggestions(lines, cursorLine, cursorCol);
        },

        shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
            if (isBashMode(lines)) {
                return true;
            }
            if ("shouldTriggerFileCompletion" in provider) {
                return (provider as any).shouldTriggerFileCompletion(lines, cursorLine, cursorCol);
            }
            return true;
        },
    };
}

export class EnhancedEditor extends CustomEditor {
    private readonly tuiInstance: TUI;
    private openingPicker = false;
    private wrappedAutocompleteProvider = false;
    private lastEscapeTime = 0;
    private _onSubmitOriginal?: (text: string) => void;

    private shell: ShellInfo;

    constructor(
        tui: TUI,
        theme: EditorTheme,
        keybindings: KeybindingsManager,
        private ui: ExtensionUIContext,
        private options: EnhancedEditorOptions,
        private keybindingsManager: KeybindingsManager = keybindings,
    ) {
        super(tui, theme, keybindings);
        this.tuiInstance = tui;
        this.shell = findCompletionShell();

        // Editor declares onSubmit as a class field, so super() creates an own data
        // property on the instance that shadows any prototype getter/setter. Replace
        // it with an instance accessor so remapCommand intercepts all submissions.
        Object.defineProperty(this, "onSubmit", {
            get: (): ((text: string) => void) | undefined => {
                const original = this._onSubmitOriginal;
                if (!original) return undefined;
                return (text: string) => original(this.remapCommand(text));
            },
            set: (fn: ((text: string) => void) | undefined) => {
                this._onSubmitOriginal = fn;
            },
            configurable: true,
            enumerable: true,
        });

        // You can disable this notify if it gets annoying
        this.ui.notify(`editor-enhancements loaded (shell: ${this.shell.type})`, "info");
    }

    private remapCommand(text: string): string {
        const trimmed = text.trimStart();
        if (!trimmed.startsWith("/")) return text;

        const match = trimmed.match(/^\/([^\s:]+)(.*)/s);
        if (!match) return text;

        const [, cmd, rest] = match;
        const target = this.options.commandRemap[cmd!];
        return target ? `/${target}${rest}` : text;
    }

    setAutocompleteProvider(provider: AutocompleteProvider): void {
        // Wrap once. If pi resets providers, we still want our wrapper.
        if (!this.wrappedAutocompleteProvider && provider) {
            const wrapped = wrapProviderWithShellAndAtFiltering(provider, this.shell);
            super.setAutocompleteProvider(wrapped);
            this.wrappedAutocompleteProvider = true;
            return;
        }

        super.setAutocompleteProvider(provider);
    }

    async openFilePickerAtCursor(): Promise<void> {
        const refs = await openFilePicker(this.ui);
        if (!refs) return;
        this.insertTextAtCursor(refs + " ");
        this.tuiInstance.requestRender();
    }

    async pasteClipboardRawAtCursor(): Promise<void> {
        let text: string | undefined;
        try {
            text = await Clipboard.getText();
        } catch {
            text = undefined;
        }

        if (!text) return;

        // Normalize line endings
        const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

        // Insert using editor primitive (NOT bracketed paste), so it won't turn into [paste #..]
        this.insertTextAtCursor(normalized);
        this.tuiInstance.requestRender();
    }

    handleInput(data: string): void {
        if (this.openingPicker) return;

        if (this.shouldHandleConfiguredDoubleEscape(data)) {
            this.handleConfiguredDoubleEscape();
            return;
        }

        if (!this.keybindingsManager.matches(data, "app.interrupt")) {
            this.lastEscapeTime = 0;
        }

        // Intercept @ at token start to open picker
        if (data === "@" && this.shouldTriggerFilePicker()) {
            this.openingPicker = true;
            if (this.isShowingAutocomplete()) {
                // Escape cancels autocomplete in the base editor
                super.handleInput("\x1b");
            }
            this.openFilePickerAtCursor().finally(() => {
                this.openingPicker = false;
            });
            return;
        }

        super.handleInput(data);
    }

    private shouldHandleConfiguredDoubleEscape(data: string): boolean {
        return Boolean(
            this.options.doubleEscapeCommand &&
                this.keybindingsManager.matches(data, "app.interrupt") &&
                !this.isShowingAutocomplete() &&
                !this.getText().trim() &&
                this.options.canTriggerDoubleEscapeCommand(),
        );
    }

    private handleConfiguredDoubleEscape(): void {
        const now = Date.now();
        if (now - this.lastEscapeTime >= DOUBLE_ESCAPE_WINDOW_MS) {
            this.lastEscapeTime = now;
            return;
        }

        this.lastEscapeTime = 0;
        const command = this.options.doubleEscapeCommand;
        if (!command || !this.onSubmit) return;

        this.onSubmit(`/${command}`);
    }

    private shouldTriggerFilePicker(): boolean {
        const cursor = this.getCursor();
        const line = this.getLines()[cursor.line] ?? "";

        if (cursor.col === 0) return true;

        const before = line[cursor.col - 1];
        return before === " " || before === "\t" || before === undefined;
    }
}
