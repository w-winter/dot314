/**
 * Session Switcher — session picker with live background preview
 *
 * Goal: mirror Pi's native /resume picker behaviors + keybindings, while adding
 * a dimmed background preview of the currently highlighted session.
 *
 * Notes:
 * - The foreground UI is Pi's native SessionSelectorComponent
 * - Delete uses the native inline confirmation gate (Enter confirms, Esc/Ctrl+C cancels)
 */

import type { ExtensionAPI, ExtensionCommandContext, SessionInfo } from "@mariozechner/pi-coding-agent";
import { SessionManager, SessionSelectorComponent } from "@mariozechner/pi-coding-agent";

import type { Focusable } from "@mariozechner/pi-tui";
import { truncateToWidth } from "@mariozechner/pi-tui";

type PreviewCacheEntry = {
	lines: string[];
};

const previewCache = new Map<string, PreviewCacheEntry>();

const buildPreviewLines = (session: SessionInfo): string[] => {
	// SessionInfo.allMessagesText is already computed by SessionManager.list/listAll.
	// Using it avoids re-reading/parsing JSONL files on every cursor move.
	const text = session.allMessagesText || session.firstMessage || "";
	if (!text.trim()) {
		return [];
	}

	// Keep *some* history so the background can fill the terminal, but don't explode memory
	// for massive sessions
	const rawLines = text.split("\n");
	const maxLines = 1200;
	const slice = rawLines.length > maxLines ? rawLines.slice(rawLines.length - maxLines) : rawLines;

	return slice.map((line) => line.replace(/\s+$/g, ""));
};

const getPreview = (path: string, sessionByPath: Map<string, SessionInfo>): PreviewCacheEntry => {
	const cached = previewCache.get(path);
	if (cached) {
		return cached;
	}

	const session = sessionByPath.get(path);
	const entry = { lines: session ? buildPreviewLines(session) : [] };
	previewCache.set(path, entry);
	return entry;
};

const renderBackground = (
	selectedPath: string | undefined,
	sessionByPath: Map<string, SessionInfo>,
	width: number,
	height: number,
	theme: any,
): string[] => {
	const blank = Array.from({ length: height }, () => "");
	if (!selectedPath) {
		return blank;
	}

	const preview = getPreview(selectedPath, sessionByPath);
	if (preview.lines.length === 0) {
		const mid = Math.floor(height / 2);
		blank[mid] = truncateToWidth(
			" ".repeat(Math.max(0, Math.floor((width - 22) / 2))) + theme.fg("dim", "(no session preview)"),
			width,
		);
		return blank;
	}

	// Only format the visible slice (avoid O(n) formatting on every cursor move)
	const start = Math.max(0, preview.lines.length - height);
	const visible = preview.lines.slice(start);

	const styled = visible.map((line) => truncateToWidth(theme.fg("dim", line), width));
	while (styled.length < height) {
		styled.unshift("");
	}
	return styled;
};

class ResumeOverlay implements Focusable {
	private selector: SessionSelectorComponent;
	private sessionByPath: Map<string, SessionInfo>;
	private getTermHeight: () => number;
	private requestRender: () => void;
	private theme: any;

	_focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(v: boolean) {
		this._focused = v;
		this.selector.focused = v;
	}

	constructor(opts: {
		selector: SessionSelectorComponent;
		sessionByPath: Map<string, SessionInfo>;
		getTermHeight: () => number;
		requestRender: () => void;
		theme: any;
	}) {
		this.selector = opts.selector;
		this.sessionByPath = opts.sessionByPath;
		this.getTermHeight = opts.getTermHeight;
		this.requestRender = opts.requestRender;
		this.theme = opts.theme;
	}

	handleInput(data: string): void {
		this.selector.handleInput(data);
		this.requestRender();
	}

	render(width: number): string[] {
		const height = this.getTermHeight();
		const selectedPath = this.selector.getSessionList().getSelectedSessionPath();
		const bg = renderBackground(selectedPath, this.sessionByPath, width, height, this.theme);

		// Render the native /resume UI at full terminal width.
		// This matches the native /resume picker width (no centered narrow panel).
		const boxW = width;
		const boxLines = this.selector.render(boxW);

		const boxStartRow = Math.max(0, Math.floor((height - boxLines.length) / 2));
		const leftPad = "";

		for (let i = 0; i < boxLines.length; i++) {
			const row = boxStartRow + i;
			if (row < 0 || row >= bg.length) {
				continue;
			}
			bg[row] = truncateToWidth(leftPad + boxLines[i], width);
		}

		return bg;
	}

	invalidate(): void {
		this.selector.invalidate();
	}

	dispose(): void {
		previewCache.clear();
		this.selector.dispose();
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("switch", {
		description: "Session picker (mirrors /resume) with live background preview",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			if (!ctx.hasUI) {
				return;
			}

			previewCache.clear();

			const currentCwd = ctx.cwd;
			const currentSessionFilePath = ctx.sessionManager.getSessionFile();

			const sessionByPath = new Map<string, SessionInfo>();
			const recordSessions = (sessions: SessionInfo[]) => {
				for (const session of sessions) {
					sessionByPath.set(session.path, session);
				}
			};

			const currentSessionsLoader = async (onProgress?: (loaded: number, total: number) => void) => {
				const sessions = await SessionManager.list(currentCwd, undefined, onProgress);
				recordSessions(sessions);
				return sessions;
			};

			const allSessionsLoader = async (onProgress?: (loaded: number, total: number) => void) => {
				const sessions = await SessionManager.listAll(onProgress);
				recordSessions(sessions);
				return sessions;
			};

			const selectedPath = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				const selector = new SessionSelectorComponent(
					currentSessionsLoader,
					allSessionsLoader,
					(path) => done(path),
					() => done(null),
					() => done(null),
					() => tui.requestRender(),
					{
						showRenameHint: true,
						renameSession: async (sessionPath: string, newName: string | undefined) => {
							const name = (newName ?? "").trim();
							if (!name) {
								return;
							}

							if (currentSessionFilePath && sessionPath === currentSessionFilePath) {
								pi.setSessionName(name);
								return;
							}

							const mgr = SessionManager.open(sessionPath);
							mgr.appendSessionInfo(name);
						},
					},
					currentSessionFilePath,
				);

				// Match native behavior: focus the list/search input
				tui.setFocus?.(selector.getSessionList());

				const overlay = new ResumeOverlay({
					selector,
					sessionByPath,
					getTermHeight: () => tui.terminal?.rows ?? 40,
					requestRender: () => tui.requestRender(),
					theme,
				});

				return overlay;
			});

			if (!selectedPath) {
				return;
			}

			const result = await ctx.switchSession(selectedPath);
			if (result.cancelled) {
				ctx.ui.notify("Session switch cancelled", "info");
			}
		},
	});
}
