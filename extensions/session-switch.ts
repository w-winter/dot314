/**
 * Session Switcher — session picker with live session preview
 *
 * Goal: mirror Pi's native /resume picker behaviors + keybindings, while adding
 * a scrollable preview of the currently highlighted session below the picker.
 *
 * Notes:
 * - The foreground UI is Pi's native SessionSelectorComponent
 * - Delete uses the native inline confirmation gate (Enter confirms, Esc/Ctrl+C cancels)
 */

import type { ExtensionAPI, ExtensionCommandContext, SessionInfo } from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme, SessionManager, SessionSelectorComponent } from "@mariozechner/pi-coding-agent";

import type { Focusable } from "@mariozechner/pi-tui";
import { Markdown, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";

type PreviewCacheEntry = {
	lines: string[];
};

type RenderCacheEntry = {
	path: string;
	width: number;
	renderedLines: string[];
};

const PREVIEW_SCROLL_UP = "shift+up";
const PREVIEW_SCROLL_DOWN = "shift+down";
const PREVIEW_PAGE_UP = "shift+left";
const PREVIEW_PAGE_DOWN = "shift+right";

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
	renderCache: RenderCacheEntry | null,
	setRenderCache: (next: RenderCacheEntry | null) => void,
	scrollFromBottom: number,
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

	let renderedLines: string[];
	if (renderCache && renderCache.path === selectedPath && renderCache.width === width) {
		renderedLines = renderCache.renderedLines;
	} else {
		const markdown = new Markdown(preview.lines.join("\n"), 0, 0, getMarkdownTheme());
		renderedLines = markdown.render(width);
		setRenderCache({ path: selectedPath, width, renderedLines });
	}

	// Scrolling: scrollFromBottom=0 means "follow tail" (default)
	const maxOffset = Math.max(0, renderedLines.length - height);
	const clampedScroll = Math.max(0, Math.min(scrollFromBottom, maxOffset));
	const start = Math.max(0, maxOffset - clampedScroll);
	const end = Math.min(renderedLines.length, start + height);

	let visible = renderedLines.slice(start, end);
	const above = start;
	const below = renderedLines.length - end;

	if (height > 0) {
		if (above > 0) {
			const indicator = truncateToWidth(theme.fg("muted", `… ${above} line(s) above`), width);
			visible = height === 1 ? [indicator] : [indicator, ...visible.slice(0, height - 1)];
		}
		if (below > 0) {
			const indicator = truncateToWidth(theme.fg("muted", `… ${below} line(s) below`), width);
			visible = height === 1 ? [indicator] : [...visible.slice(0, height - 1), indicator];
		}
	}

	while (visible.length < height) {
		visible.unshift("");
	}
	return visible;
};

class ResumeOverlay implements Focusable {
	private selector: SessionSelectorComponent;
	private sessionByPath: Map<string, SessionInfo>;
	private getTermHeight: () => number;
	private requestRender: () => void;
	private theme: any;
	private renderCache: RenderCacheEntry | null = null;
	private previewScrollFromBottom = 0;
	private lastPreviewHeight = 0;
	private lastSelectedPath: string | undefined = undefined;

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
		if (matchesKey(data, PREVIEW_SCROLL_UP)) {
			this.previewScrollFromBottom += 1;
			this.requestRender();
			return;
		}
		if (matchesKey(data, PREVIEW_SCROLL_DOWN)) {
			this.previewScrollFromBottom = Math.max(0, this.previewScrollFromBottom - 1);
			this.requestRender();
			return;
		}
		if (matchesKey(data, PREVIEW_PAGE_UP)) {
			const step = Math.max(1, (this.lastPreviewHeight > 0 ? this.lastPreviewHeight : 10) - 1);
			this.previewScrollFromBottom += step;
			this.requestRender();
			return;
		}
		if (matchesKey(data, PREVIEW_PAGE_DOWN)) {
			const step = Math.max(1, (this.lastPreviewHeight > 0 ? this.lastPreviewHeight : 10) - 1);
			this.previewScrollFromBottom = Math.max(0, this.previewScrollFromBottom - step);
			this.requestRender();
			return;
		}

		this.selector.handleInput(data);
		this.requestRender();
	}

	render(width: number): string[] {
		const height = this.getTermHeight();
		const selectedPath = this.selector.getSessionList().getSelectedSessionPath();

		if (selectedPath !== this.lastSelectedPath) {
			this.lastSelectedPath = selectedPath;
			this.previewScrollFromBottom = 0;
			this.lastPreviewHeight = 0;
			this.renderCache = null;
		}

		// Render the native /resume UI at full terminal width, but pin it to the top
		// so the session preview can use the remaining terminal space below.
		const selectorLines = this.selector.render(width);
		if (selectorLines.length >= height) {
			return selectorLines.slice(0, height);
		}

		const separator = truncateToWidth(this.theme.fg("dim", "─".repeat(width)), width);
		const helpLine = truncateToWidth(
			this.theme.fg(
				"dim",
				"  Shift+Up/Down: scroll • Shift+Left/Right: page",
			),
			width,
		);

		const remainingHeight = height - selectorLines.length - 1;
		const showHelp = remainingHeight > 0;
		const previewHeight = Math.max(0, remainingHeight - (showHelp ? 1 : 0));
		this.lastPreviewHeight = previewHeight;

		const previewLines =
			previewHeight > 0
				? renderBackground(
					selectedPath,
					this.sessionByPath,
					width,
					previewHeight,
					this.theme,
					this.renderCache,
					(next) => {
						this.renderCache = next;
					},
					this.previewScrollFromBottom,
				)
				: [];

		const lines = showHelp
			? [...selectorLines, separator, helpLine, ...previewLines]
			: [...selectorLines, separator, ...previewLines];
		while (lines.length < height) lines.push("");
		if (lines.length > height) lines.length = height;
		return lines;
	}

	invalidate(): void {
		this.renderCache = null;
		this.previewScrollFromBottom = 0;
		this.lastPreviewHeight = 0;
		this.selector.invalidate();
	}

	dispose(): void {
		previewCache.clear();
		this.renderCache = null;
		this.previewScrollFromBottom = 0;
		this.lastPreviewHeight = 0;
		this.selector.dispose();
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("switch-session", {
		description: "Session picker (mirrors /resume) with live preview",
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
