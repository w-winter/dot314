/**
 * Raw Paste Extension - preserves newlines and special characters when pasting
 *
 * Usage: pi --extension ./extensions/raw-paste.ts
 *
 * Features:
 * - `/paste` command: arms raw paste mode for the next paste operation
 * - `alt+v` shortcut: pastes directly from clipboard, preserving newlines
 */

import { CustomEditor, type ExtensionAPI, type ExtensionContext, type KeybindingsManager } from "@mariozechner/pi-coding-agent";
import type { EditorTheme, TUI } from "@mariozechner/pi-tui";
import * as Clipboard from "@mariozechner/clipboard";

// Bracketed paste mode escape sequences
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const PASTE_END_LEN = PASTE_END.length;

class RawPasteEditor extends CustomEditor {
	private rawPasteArmed = false;
	private rawPasteBuffer = "";
	private isInRawPaste = false;
	private onArm?: () => void;
	private tui: TUI;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, onArm?: () => void) {
		super(tui, theme, keybindings);
		this.tui = tui;
		this.onArm = onArm;
	}

	armRawPaste(): void {
		this.rawPasteArmed = true;
		this.onArm?.();
	}

	async pasteFromClipboard(): Promise<void> {
		try {
			const text = await Clipboard.getText();
			if (text) {
				this.flushRawPaste(text);
				this.tui.requestRender();
			}
		} catch {
			// Clipboard access failed, ignore
		}
	}

	private flushRawPaste(content: string): void {
		const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		for (const char of normalized) {
			super.handleInput(char);
		}
	}

	private handleRawPasteInput(data: string): boolean {
		let handled = false;

		if (data.includes(PASTE_START)) {
			this.isInRawPaste = true;
			this.rawPasteBuffer = "";
			data = data.replace(PASTE_START, "");
			handled = true;
		}

		if (this.isInRawPaste) {
			this.rawPasteBuffer += data;
			const endIndex = this.rawPasteBuffer.indexOf(PASTE_END);
			if (endIndex !== -1) {
				const pasteContent = this.rawPasteBuffer.substring(0, endIndex);
				const remaining = this.rawPasteBuffer.substring(endIndex + PASTE_END_LEN);
				this.rawPasteBuffer = "";
				this.isInRawPaste = false;
				this.rawPasteArmed = false;

				if (pasteContent.length > 0) {
					this.flushRawPaste(pasteContent);
				}
				if (remaining.length > 0) {
					this.handleInput(remaining);
				}
			}
			return true;
		}

		return handled;
	}

	handleInput(data: string): void {
		if (this.rawPasteArmed || this.isInRawPaste) {
			if (this.handleRawPasteInput(data)) {
				return;
			}
		}

		super.handleInput(data);
	}
}

export default function (pi: ExtensionAPI) {
	let editor: RawPasteEditor | null = null;

	const notifyArmed = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) return;
		ctx.ui.notify("Raw paste armed. Paste now.", "info");
	};

	const armRawPaste = (ctx: ExtensionContext): void => {
		if (!editor) {
			if (ctx.hasUI) ctx.ui.notify("Raw paste editor not ready.", "warning");
			return;
		}
		editor.armRawPaste();
	};

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setEditorComponent((tui, theme, kb) => {
			editor = new RawPasteEditor(tui, theme, kb, () => notifyArmed(ctx));
			return editor;
		});
	});

	pi.registerCommand("paste", {
		description: "Arm raw paste for the next paste operation",
		handler: async (_args, ctx) => {
			armRawPaste(ctx);
		},
	});

	pi.registerShortcut("alt+v", {
		description: "Paste from clipboard (raw, preserving newlines)",
		handler: async (ctx) => {
			if (!editor) {
				if (ctx.hasUI) ctx.ui.notify("Editor not ready.", "warning");
				return;
			}
			await editor.pasteFromClipboard();
		},
	});
}
