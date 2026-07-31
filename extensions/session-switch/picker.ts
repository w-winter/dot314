import { resolve } from "node:path";

import type { ExtensionAPI, ExtensionContext, SessionInfo } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, SessionManager, SessionSelectorComponent } from "@earendil-works/pi-coding-agent";

import type { Focusable } from "@earendil-works/pi-tui";
import { Markdown, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import {
	getSessionDiscoveryTargets,
	isSessionScanCancellation,
	loadSessionPreviewText,
	type ScannedSession,
} from "./session-scanner.ts";
import { SessionStreamController } from "./session-stream.ts";

export type SessionPickerDismissReason = "cancel" | "exit";

export type SessionPickerResult =
	| { kind: "selected"; sessionPath: string }
	| { kind: "dismissed"; reason: SessionPickerDismissReason };

export type SessionPickerContext = Pick<ExtensionContext, "hasUI" | "sessionManager" | "ui">;

export function normalizeSessionPath(sessionPath: string | undefined): string | undefined {
	return sessionPath ? resolve(sessionPath) : undefined;
}

export type SessionPreviewSnapshot =
	| { kind: "loading"; lines: readonly string[]; revision: number }
	| { kind: "ready"; lines: readonly string[]; revision: number }
	| { kind: "error"; lines: readonly string[]; revision: number; message: string };

type PreviewCacheEntry =
	| { kind: "loading"; revision: number }
	| { kind: "ready"; lines: readonly string[]; revision: number }
	| { kind: "empty"; revision: number }
	| { kind: "error"; revision: number; message: string };

type RenderCacheEntry = {
	path: string;
	width: number;
	previewRevision: number;
	renderedLines: string[];
};

const PREVIEW_SCROLL_UP = "shift+up";
const PREVIEW_SCROLL_DOWN = "shift+down";
const PREVIEW_PAGE_UP = "shift+pageup";
const PREVIEW_PAGE_DOWN = "shift+pagedown";
const SESSION_PREVIEW_HELP_TEXT = "  Shift+Up/Down: scroll • Shift+PageUp/PageDown: page";
const DEFAULT_PREVIEW_CACHE_ENTRIES = 4;
const DEFAULT_PREVIEW_DEBOUNCE_MS = 75;

type SessionModified = NonNullable<SessionInfo["modified"]>;

const padTimestampPart = (value: number): string => String(value).padStart(2, "0");

export const formatSessionModifiedTimestamp = (modified: SessionModified): string => {
	const dateText = [
		modified.getFullYear(),
		padTimestampPart(modified.getMonth() + 1),
		padTimestampPart(modified.getDate()),
	].join("-");
	const timeText = [modified.getHours(), modified.getMinutes(), modified.getSeconds()].map(padTimestampPart).join(":");
	return `${dateText} ${timeText}`;
};

export const buildSessionPreviewHelpLine = (
	helpText: string,
	timestampText: string | undefined,
	width: number,
): string => {
	if (width <= 0) return "";
	if (!timestampText) return truncateToWidth(helpText, width, "");

	const timestampWidth = visibleWidth(timestampText);
	if (timestampWidth === width) return timestampText;
	if (timestampWidth > width) return truncateToWidth(timestampText, width);

	const availableHelpWidth = width - timestampWidth - 1;
	const truncatedHelpText = truncateToWidth(helpText, availableHelpWidth, "");
	const paddingWidth = width - visibleWidth(truncatedHelpText) - timestampWidth;
	return `${truncatedHelpText}${" ".repeat(paddingWidth)}${timestampText}`;
};

export const clampPreviewScrollFromBottom = (scrollFromBottom: number, totalLines: number, height: number): number => {
	const maxOffset = Math.max(0, totalLines - height);
	return Math.max(0, Math.min(scrollFromBottom, maxOffset));
};

export const buildPreviewLinesFromText = (text: string): string[] => {
	if (!text.trim()) return [];
	const rawLines = text.split("\n");
	const maxLines = 1200;
	const slice = rawLines.length > maxLines ? rawLines.slice(rawLines.length - maxLines) : rawLines;
	return slice.map((line) => line.replace(/\s+$/g, ""));
};

export class LazySessionPreviewCache {
	private readonly loadText: (sessionPath: string, signal: AbortSignal) => Promise<string>;
	private readonly onChange: (sessionPath: string) => void;
	private readonly onError: (sessionPath: string, error: Error) => void;
	private readonly maxEntries: number;
	private readonly debounceMs: number;
	private readonly entries = new Map<string, PreviewCacheEntry>();
	private readonly terminalErrors = new Map<string, Extract<PreviewCacheEntry, { kind: "error" }>>();
	private selectedPath: string | undefined;
	private sequence = 0;
	private revision = 0;
	private activeController: AbortController | null = null;
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;
	private disposed = false;

	constructor(options: {
		loadText: (sessionPath: string, signal: AbortSignal) => Promise<string>;
		onChange: (sessionPath: string) => void;
		onError: (sessionPath: string, error: Error) => void;
		maxEntries?: number;
		debounceMs?: number;
	}) {
		this.loadText = options.loadText;
		this.onChange = options.onChange;
		this.onError = options.onError;
		this.maxEntries = options.maxEntries ?? DEFAULT_PREVIEW_CACHE_ENTRIES;
		this.debounceMs = options.debounceMs ?? DEFAULT_PREVIEW_DEBOUNCE_MS;
	}

	select(sessionPath: string | undefined): void {
		if (this.disposed || sessionPath === this.selectedPath) return;
		this.sequence += 1;
		const sequence = this.sequence;
		const previousPath = this.selectedPath;
		this.selectedPath = sessionPath;
		this.clearPendingWork(previousPath);
		if (!sessionPath || this.terminalErrors.has(sessionPath)) return;
		if (this.touchEntry(sessionPath)) return;
		this.entries.set(sessionPath, { kind: "loading", revision: this.revision });
		this.evictOldest();

		this.debounceTimer = setTimeout(() => {
			this.debounceTimer = null;
			if (this.disposed || this.sequence !== sequence || this.selectedPath !== sessionPath) return;
			const controller = new AbortController();
			this.activeController = controller;
			void this.loadText(sessionPath, controller.signal)
				.then((text) => this.acceptText(sessionPath, sequence, controller, text))
				.catch((error) => this.acceptError(sessionPath, sequence, controller, error));
		}, this.debounceMs);
	}

	getSnapshot(sessionPath: string | undefined, fallbackLines: readonly string[]): SessionPreviewSnapshot {
		if (!sessionPath) return { kind: "ready", lines: [], revision: this.revision };
		const entry = this.terminalErrors.get(sessionPath) ?? this.entries.get(sessionPath);
		if (!entry) throw new Error(`Preview cache has no state for selected session: ${sessionPath}`);
		switch (entry.kind) {
			case "loading":
				return { kind: "loading", lines: fallbackLines, revision: entry.revision };
			case "ready":
				return { kind: "ready", lines: entry.lines, revision: entry.revision };
			case "empty":
				return { kind: "ready", lines: fallbackLines, revision: entry.revision };
			case "error":
				return { kind: "error", lines: fallbackLines, revision: entry.revision, message: entry.message };
		}

	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.sequence += 1;
		this.clearPendingWork();
		this.entries.clear();
		this.terminalErrors.clear();
	}

	private clearPendingWork(previousPath?: string): void {
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		this.debounceTimer = null;
		this.activeController?.abort();
		this.activeController = null;
		if (previousPath && this.entries.get(previousPath)?.kind === "loading") this.entries.delete(previousPath);
	}

	private touchEntry(path: string): boolean {
		const entry = this.entries.get(path);
		if (!entry) return false;
		this.entries.delete(path);
		this.entries.set(path, entry);
		return true;
	}

	private acceptText(path: string, sequence: number, controller: AbortController, text: string): void {
		if (!this.isCurrent(path, sequence, controller)) return;
		this.activeController = null;
		this.revision += 1;
		const lines = buildPreviewLinesFromText(text);
		this.entries.set(path, lines.length > 0
			? { kind: "ready", lines, revision: this.revision }
			: { kind: "empty", revision: this.revision });
		this.evictOldest();
		this.onChange(path);
	}

	private acceptError(path: string, sequence: number, controller: AbortController, error: unknown): void {
		if (!this.isCurrent(path, sequence, controller) || isSessionScanCancellation(error)) return;
		this.activeController = null;
		const normalized = error instanceof Error ? error : new Error(String(error));
		this.revision += 1;
		this.entries.delete(path);
		this.terminalErrors.set(path, { kind: "error", revision: this.revision, message: normalized.message });
		this.onError(path, normalized);
		this.onChange(path);
	}

	private isCurrent(path: string, sequence: number, controller: AbortController): boolean {
		return !this.disposed && !controller.signal.aborted && this.sequence === sequence && this.selectedPath === path &&
			this.activeController === controller;
	}

	private evictOldest(): void {
		while (this.entries.size > this.maxEntries) {
			const oldest = this.entries.keys().next().value as string | undefined;
			if (!oldest) break;
			this.entries.delete(oldest);
		}
	}
}

class ResumeOverlay implements Focusable {
	private readonly selector: SessionSelectorComponent;
	private readonly sessionByPath: Map<string, ScannedSession>;
	private readonly streamController: SessionStreamController;
	private readonly getTermHeight: () => number;
	private readonly requestRender: () => void;
	private readonly theme: any;
	private readonly previewCache: LazySessionPreviewCache;
	private renderCache: RenderCacheEntry | null = null;
	private previewScrollFromBottom = 0;
	private lastPreviewHeight = 0;
	private lastSelectedPath: string | undefined = undefined;

	_focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.selector.focused = value;
	}

	constructor(options: {
		selector: SessionSelectorComponent;
		sessionByPath: Map<string, ScannedSession>;
		streamController: SessionStreamController;
		getTermHeight: () => number;
		requestRender: () => void;
		theme: any;
	}) {
		this.selector = options.selector;
		this.sessionByPath = options.sessionByPath;
		this.streamController = options.streamController;
		this.getTermHeight = options.getTermHeight;
		this.requestRender = options.requestRender;
		this.theme = options.theme;
		this.previewCache = new LazySessionPreviewCache({
			loadText: loadSessionPreviewText,
			onChange: (path) => this.handlePreviewChange(path),
			onError: () => {},
		});
	}

	private handlePreviewChange(path: string): void {
		if (this.streamController.isDisposed() || path !== this.lastSelectedPath) return;
		this.renderCache = null;
		this.previewScrollFromBottom = 0;
		this.lastPreviewHeight = 0;
		this.requestRender();
	}

	private renderBackground(
		selectedPath: string | undefined,
		snapshot: SessionPreviewSnapshot | undefined,
		width: number,
		height: number,
	): string[] {
		const blank = Array.from({ length: height }, () => "");
		if (!selectedPath) return blank;
		if (!snapshot) throw new Error(`Selected session is missing preview state: ${selectedPath}`);
		if (snapshot.lines.length === 0) {
			const message = snapshot.kind === "loading"
				? "(loading session preview…)"
				: snapshot.kind === "error"
					? "(session preview unavailable)"
					: "(no session preview)";
			const mid = Math.floor(height / 2);
			blank[mid] = truncateToWidth(
				" ".repeat(Math.max(0, Math.floor((width - visibleWidth(message)) / 2))) + this.theme.fg("dim", message),
				width,
			);
			return blank;
		}

		let renderedLines: string[];
		if (
			this.renderCache &&
			this.renderCache.path === selectedPath &&
			this.renderCache.width === width &&
			this.renderCache.previewRevision === snapshot.revision
		) {
			renderedLines = this.renderCache.renderedLines;
		} else {
			const markdown = new Markdown(snapshot.lines.join("\n"), 0, 0, getMarkdownTheme());
			renderedLines = markdown.render(width);
			this.renderCache = { path: selectedPath, width, previewRevision: snapshot.revision, renderedLines };
		}

		const clampedScroll = clampPreviewScrollFromBottom(this.previewScrollFromBottom, renderedLines.length, height);
		this.previewScrollFromBottom = clampedScroll;
		const maxOffset = Math.max(0, renderedLines.length - height);
		const start = Math.max(0, maxOffset - clampedScroll);
		const end = Math.min(renderedLines.length, start + height);
		let visible = renderedLines.slice(start, end);
		const above = start;
		const below = renderedLines.length - end;

		if (height > 0 && above > 0) {
			const indicator = truncateToWidth(this.theme.fg("muted", `… ${above} line(s) above`), width);
			visible = height === 1 ? [indicator] : [indicator, ...visible.slice(0, height - 1)];
		}
		if (height > 0 && below > 0) {
			const indicator = truncateToWidth(this.theme.fg("muted", `… ${below} line(s) below`), width);
			visible = height === 1 ? [indicator] : [...visible.slice(0, height - 1), indicator];
		}
		while (visible.length < height) visible.unshift("");
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
			this.previewCache.select(selectedPath);
		}

		const selectorLines = this.selector.render(width);
		if (selectorLines.length >= height) return selectorLines.slice(0, height);
		const separator = truncateToWidth(this.theme.fg("dim", "─".repeat(width)), width);
		const selectedSession = selectedPath ? this.sessionByPath.get(selectedPath) : undefined;
		if (selectedPath && !selectedSession) throw new Error(`Selected session is missing scanner metadata: ${selectedPath}`);
		const previewSnapshot = selectedSession
			? this.previewCache.getSnapshot(selectedSession.path, buildPreviewLinesFromText(selectedSession.lastMessage))
			: undefined;
		const previewError = previewSnapshot?.kind === "error" ? `Preview unavailable: ${previewSnapshot.message}` : null;
		const selectedTimestamp = selectedSession ? formatSessionModifiedTimestamp(selectedSession.modified) : undefined;
		const streamStatus = this.streamController.getVisibleStatus();
		const progress = this.streamController.getVisibleProgress();
		const helpText = streamStatus ?? previewError ??
			`${SESSION_PREVIEW_HELP_TEXT}${progress ? ` • scanning ${progress.loaded}/${progress.total}` : ""}`;
		const helpLine = buildSessionPreviewHelpLine(
			this.theme.fg(streamStatus || previewError ? "warning" : "dim", helpText),
			selectedTimestamp ? this.theme.fg("muted", selectedTimestamp) : undefined,
			width,
		);

		const remainingHeight = height - selectorLines.length - 1;
		const showHelp = remainingHeight > 0;
		const previewHeight = Math.max(0, remainingHeight - (showHelp ? 1 : 0));
		this.lastPreviewHeight = previewHeight;
		const previewLines = previewHeight > 0
			? this.renderBackground(selectedPath, previewSnapshot, width, previewHeight)
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
		this.previewCache.dispose();
		this.streamController.dispose();
		this.renderCache = null;
		this.previewScrollFromBottom = 0;
		this.lastPreviewHeight = 0;
		this.sessionByPath.clear();
		this.selector.dispose();
	}
}

export async function openSessionSwitchPicker(
	pi: ExtensionAPI,
	ctx: SessionPickerContext,
): Promise<SessionPickerResult> {
	if (!ctx.hasUI) return { kind: "dismissed", reason: "cancel" };
	const currentSessionFilePath = ctx.sessionManager.getSessionFile();
	const currentSessionPath = normalizeSessionPath(currentSessionFilePath);

	return ctx.ui.custom<SessionPickerResult>((tui, theme, _kb, done) => {
		const sessionByPath = new Map<string, ScannedSession>();
		const targets = getSessionDiscoveryTargets(ctx.sessionManager.getSessionDir(), ctx.sessionManager.getCwd());
		let streamController: SessionStreamController;
		const guardedRender = () => {
			if (!streamController.isDisposed()) tui.requestRender();
		};
		streamController = new SessionStreamController({
			targets,
			syncSessions: (sessions) => {
				sessionByPath.clear();
				for (const session of sessions) sessionByPath.set(session.path, session);
			},
			requestRender: guardedRender,
		});
		const currentSessionsLoader = (onProgress?: (loaded: number, total: number) => void) =>
			streamController.load("current", onProgress);
		const allSessionsLoader = (onProgress?: (loaded: number, total: number) => void) =>
			streamController.load("all", onProgress);

		const selector = new SessionSelectorComponent(
			currentSessionsLoader,
			allSessionsLoader,
			(sessionPath) => done({ kind: "selected", sessionPath }),
			() => done({ kind: "dismissed", reason: "cancel" }),
			() => done({ kind: "dismissed", reason: "exit" }),
			guardedRender,
			{
				showRenameHint: true,
				renameSession: async (sessionPath: string, newName: string | undefined) => {
					const name = (newName ?? "").trim();
					if (!name) return;
					if (currentSessionPath && sessionPath === currentSessionPath) {
						pi.setSessionName(name);
						return;
					}
					const manager = SessionManager.open(sessionPath);
					manager.appendSessionInfo(name);
				},
			},
			currentSessionPath,
		);
		streamController.attach(selector.getSessionList());
		tui.setFocus(selector.getSessionList());

		return new ResumeOverlay({
			selector,
			sessionByPath,
			streamController,
			getTermHeight: () => tui.terminal.rows,
			requestRender: guardedRender,
			theme,
		});
	});
}
