import type { ExtensionAPI, ExtensionContext, SessionInfo } from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme, SessionManager, SessionSelectorComponent } from "@mariozechner/pi-coding-agent";

import type { Focusable } from "@mariozechner/pi-tui";
import { Markdown, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";

export type SessionPickerDismissReason = "cancel" | "exit";

export type SessionPickerResult =
	| { kind: "selected"; sessionPath: string }
	| { kind: "dismissed"; reason: SessionPickerDismissReason };

export type SessionPickerContext = Pick<ExtensionContext, "hasUI" | "cwd" | "sessionManager" | "ui">;

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
const PREVIEW_PAGE_UP = "shift+pageup";
const PREVIEW_PAGE_DOWN = "shift+pagedown";

export const clampPreviewScrollFromBottom = (scrollFromBottom: number, totalLines: number, height: number): number => {
	const maxOffset = Math.max(0, totalLines - height);
	return Math.max(0, Math.min(scrollFromBottom, maxOffset));
};

export const buildPreviewLines = (session: SessionInfo): string[] => {
	const text = session.allMessagesText || session.firstMessage || "";
	if (!text.trim()) {
		return [];
	}

	const rawLines = text.split("\n");
	const maxLines = 1200;
	const slice = rawLines.length > maxLines ? rawLines.slice(rawLines.length - maxLines) : rawLines;

	return slice.map((line) => line.replace(/\s+$/g, ""));
};

class ResumeOverlay implements Focusable {
	private selector: SessionSelectorComponent;
	private sessionByPath: Map<string, SessionInfo>;
	private getTermHeight: () => number;
	private requestRender: () => void;
	private theme: any;
	private previewCache = new Map<string, PreviewCacheEntry>();
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

	private getPreview(path: string): PreviewCacheEntry {
		const cached = this.previewCache.get(path);
		if (cached) {
			return cached;
		}

		const session = this.sessionByPath.get(path);
		const entry = { lines: session ? buildPreviewLines(session) : [] };
		this.previewCache.set(path, entry);
		return entry;
	}

	private renderBackground(selectedPath: string | undefined, width: number, height: number): string[] {
		const blank = Array.from({ length: height }, () => "");
		if (!selectedPath) {
			return blank;
		}

		const preview = this.getPreview(selectedPath);
		if (preview.lines.length === 0) {
			const mid = Math.floor(height / 2);
			blank[mid] = truncateToWidth(
				" ".repeat(Math.max(0, Math.floor((width - 22) / 2))) + this.theme.fg("dim", "(no session preview)"),
				width,
			);
			return blank;
		}

		let renderedLines: string[];
		if (this.renderCache && this.renderCache.path === selectedPath && this.renderCache.width === width) {
			renderedLines = this.renderCache.renderedLines;
		} else {
			const markdown = new Markdown(preview.lines.join("\n"), 0, 0, getMarkdownTheme());
			renderedLines = markdown.render(width);
			this.renderCache = { path: selectedPath, width, renderedLines };
		}

		const clampedScroll = clampPreviewScrollFromBottom(this.previewScrollFromBottom, renderedLines.length, height);
		this.previewScrollFromBottom = clampedScroll;
		const maxOffset = Math.max(0, renderedLines.length - height);
		const start = Math.max(0, maxOffset - clampedScroll);
		const end = Math.min(renderedLines.length, start + height);

		let visible = renderedLines.slice(start, end);
		const above = start;
		const below = renderedLines.length - end;

		if (height > 0) {
			if (above > 0) {
				const indicator = truncateToWidth(this.theme.fg("muted", `… ${above} line(s) above`), width);
				visible = height === 1 ? [indicator] : [indicator, ...visible.slice(0, height - 1)];
			}
			if (below > 0) {
				const indicator = truncateToWidth(this.theme.fg("muted", `… ${below} line(s) below`), width);
				visible = height === 1 ? [indicator] : [...visible.slice(0, height - 1), indicator];
			}
		}

		while (visible.length < height) {
			visible.unshift("");
		}
		return visible;
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

		const selectorLines = this.selector.render(width);
		if (selectorLines.length >= height) {
			return selectorLines.slice(0, height);
		}

		const separator = truncateToWidth(this.theme.fg("dim", "─".repeat(width)), width);
		const helpLine = truncateToWidth(
			this.theme.fg("dim", "  Shift+Up/Down: scroll • Shift+PageUp/PageDown: page"),
			width,
		);

		const remainingHeight = height - selectorLines.length - 1;
		const showHelp = remainingHeight > 0;
		const previewHeight = Math.max(0, remainingHeight - (showHelp ? 1 : 0));
		this.lastPreviewHeight = previewHeight;

		const previewLines = previewHeight > 0 ? this.renderBackground(selectedPath, width, previewHeight) : [];
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
		this.previewCache.clear();
		this.renderCache = null;
		this.previewScrollFromBottom = 0;
		this.lastPreviewHeight = 0;
		this.selector.dispose();
	}
}

export async function openSessionSwitchPicker(
	pi: ExtensionAPI,
	ctx: SessionPickerContext,
): Promise<SessionPickerResult> {
	if (!ctx.hasUI) {
		return { kind: "dismissed", reason: "cancel" };
	}

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

	return ctx.ui.custom<SessionPickerResult>((tui, theme, _kb, done) => {
		const selector = new SessionSelectorComponent(
			currentSessionsLoader,
			allSessionsLoader,
			(sessionPath) => done({ kind: "selected", sessionPath }),
			() => done({ kind: "dismissed", reason: "cancel" }),
			() => done({ kind: "dismissed", reason: "exit" }),
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

					const manager = SessionManager.open(sessionPath);
					manager.appendSessionInfo(name);
				},
			},
			currentSessionFilePath,
		);

		tui.setFocus?.(selector.getSessionList());

		return new ResumeOverlay({
			selector,
			sessionByPath,
			getTermHeight: () => tui.terminal?.rows ?? 40,
			requestRender: () => tui.requestRender(),
			theme,
		});
	});
}
