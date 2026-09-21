/**
 * Screenshots Extension
 *
 * Shows recent screenshots in a panel for quick selection and attachment.
 * Works on macOS and Linux. Much faster than dragging files - just select and stage!
 *
 * Features:
 * - Shows all recent screenshots with scrollable list
 * - Multiple source directories with tabs (Ctrl+T to cycle)
 * - Supports glob patterns for flexible file matching
 * - Displays relative timestamps (e.g., "2 minutes ago")
 * - Shows thumbnail preview of selected screenshot
 * - Press 'o' to open in default image viewer
 * - Stage multiple screenshots with s/space (checkmark indicator)
 * - Shows widget indicator when screenshots are staged
 * - Type your message after staging, images attach on send
 *
 * Usage:
 *   /ss              - Show screenshot selector (stages images)
 *   /ss-clear        - Clear staged screenshots
 *   Ctrl+`           - Quick access shortcut
 *   Ctrl+1           - Clear all staged screenshots
 *
 * Keys:
 *   Up/Down          - Navigate screenshots
 *   Ctrl+T           - Cycle through source tabs
 *   z                - Toggle zoomed inspector mode
 *   +/-              - Zoom in/out in inspector mode
 *   Arrow keys       - Pan image in inspector mode (or navigate if not zoomed)
 *   [ / ]            - Previous/next screenshot in inspector mode
 *   0                - Reset inspector zoom + pan
 *   s / space        - Stage/unstage current screenshot
 *   x                - Clear all staged screenshots
 *   o                - Open in default viewer
 *   d                - Delete screenshot from disk
 *   enter            - Close selector
 *   esc              - Cancel
 *
 * Workflow:
 *   1. Press Ctrl+` or /ss to open selector
 *   2. Use Ctrl+T to switch between source tabs (if multiple configured)
 *   3. Navigate with Up/Down, press s/space to stage screenshots (checkmark appears)
 *   4. Press Enter to close selector
 *   5. Type your message in the prompt
 *   6. Press Enter to send - staged images are automatically attached
 *
 * Configuration (in ~/.pi/agent/settings.json):
 *   {
 *     "pi-screenshots": {
 *       "sources": [
 *         "~/Pictures/Screenshots",
 *         "/path/to/images/*.png"
 *       ]
 *     }
 *   }
 *
 *   Sources can be:
 *   - Plain directories: scans for screenshot-named PNGs
 *   - Glob patterns: matches any file matching the pattern
 *
 *   Environment variable PI_SCREENSHOTS_DIR is also supported as fallback.
 *
 * Default screenshot locations (when no config):
 *   macOS: reads from screencapture preferences, falls back to ~/Desktop
 *   Linux: ~/Pictures/Screenshots, ~/Pictures, ~/Screenshots, or ~/Desktop
 *
 * Remote Development:
 *   For remote development via SSH, use external sync tools:
 *   - SSHFS: Mount remote folder locally (simplest)
 *   - Syncthing: Continuous file sync (most robust)
 *   See README for details.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Image,
	Key,
	Spacer,
	Text,
	deleteKittyImage,
	getCapabilities,
	getCellDimensions,
	getImageDimensions as getTerminalImageDimensions,
	matchesKey,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { globSync } from "glob";
import { Type } from "typebox";
import { Check } from "typebox/value";

interface ScreenshotInfo {
	path: string;
	name: string;
	mtime: Date;
	size: number;
}

interface SourceTab {
	label: string;
	pattern: string;
	screenshots: ScreenshotInfo[];
}

interface Config {
	sources?: string[];
}

interface PiImageSettings {
	showImages: boolean;
	autoResizeImages: boolean;
}

const SCREENSHOT_PATTERNS = [
	// macOS patterns
	/^Screenshot\s/i, // English: "Screenshot 2024-01-30..."
	/^Capture\s/i, // French: "Capture d'ecran..."
	/^Scherm/i, // Dutch: "Schermafbeelding..."
	/^Bildschirmfoto/i, // German
	/^Captura\s/i, // Spanish
	/^Istantanea/i, // Italian
	// Linux patterns (various screenshot tools)
	/^screenshot/i, // Generic
	/^\d{4}-\d{2}-\d{2}[_-]\d{2}[_-]\d{2}/i, // GNOME: "2024-01-30_12-30-45.png"
	/^flameshot/i, // Flameshot
	/^spectacle/i, // KDE Spectacle
	/^scrot/i, // Scrot
	/^maim/i, // Maim
	/^grim/i, // Grim (Wayland)
];

const QUEUE_STEER_ATTACHMENTS_EVENT = "pi-queue-steer:attachments:v1";
const QueueSteerAttachmentsEventSchema = Type.Object({
	version: Type.Literal(1),
	attach: Type.Function([Type.Array(Type.Unknown())], Type.Void()),
});

/**
 * Detect the platform.
 */
const isMacOS = process.platform === "darwin";
const isLinux = process.platform === "linux";
const isOrcaTerminal = [process.env.TERM_PROGRAM, process.env.ORCA_TERM_PROGRAM]
	.some((program) => program?.toLowerCase() === "orca");

/**
 * Expand ~ to home directory.
 */
function expandPath(path: string): string {
	if (path.startsWith("~/")) {
		return join(homedir(), path.slice(2));
	}
	return path;
}

/**
 * Check if a pattern contains glob characters.
 */
function isGlobPattern(pattern: string): boolean {
	return /[*?[\]{}!]/.test(pattern);
}

/**
 * Get the default screenshot directory based on platform.
 */
function getDefaultScreenshotDir(): string {
	if (isMacOS) {
		// Try to read macOS screenshot preferences
		try {
			const result = execSync("defaults read com.apple.screencapture location 2>/dev/null", {
				encoding: "utf-8",
			}).trim();
			if (result && existsSync(result)) {
				return result;
			}
		} catch {
			// Ignore errors, use fallback
		}
		return join(homedir(), "Desktop");
	}

	if (isLinux) {
		// Common Linux screenshot directories
		const linuxDirs = [
			join(homedir(), "Pictures", "Screenshots"),
			join(homedir(), "Pictures"),
			join(homedir(), "Screenshots"),
			join(homedir(), "Desktop"),
		];
		for (const dir of linuxDirs) {
			if (existsSync(dir)) {
				return dir;
			}
		}
	}

	// Fallback for any platform
	return join(homedir(), "Desktop");
}

/**
 * Open a file with the default system viewer.
 */
function openFile(path: string): void {
	try {
		if (isMacOS) {
			execSync(`open "${path}"`);
		} else if (isLinux) {
			execSync(`xdg-open "${path}" &`);
		}
	} catch {
		// Ignore errors
	}
}

/**
 * Load extension config from settings.json.
 */
function readSettings(): Record<string, unknown> {
	const settingsPath = join(homedir(), ".pi", "agent", "settings.json");
	if (!existsSync(settingsPath)) {
		return {};
	}

	try {
		return JSON.parse(readFileSync(settingsPath, "utf-8"));
	} catch {
		return {};
	}
}

function loadConfig(): Config {
	const settings = readSettings();
	const screenshotsConfig = settings["pi-screenshots"];
	return screenshotsConfig && typeof screenshotsConfig === "object" ? (screenshotsConfig as Config) : {};
}

function loadPiImageSettings(): PiImageSettings {
	const settings = readSettings();
	const terminal = settings.terminal;
	const images = settings.images;

	return {
		showImages: terminal && typeof terminal === "object" && "showImages" in terminal
			? (terminal.showImages as boolean)
			: true,
		autoResizeImages: images && typeof images === "object" && "autoResize" in images
			? (images.autoResize as boolean)
			: true,
	};
}

/**
 * Check if a filename looks like a screenshot.
 */
function isScreenshotName(name: string): boolean {
	return SCREENSHOT_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * Get screenshots from a plain directory (with screenshot name filtering).
 */
function getScreenshotsFromDirectory(directory: string): ScreenshotInfo[] {
	if (!existsSync(directory)) {
		return [];
	}

	const files = readdirSync(directory)
		.filter((name) => {
			// Must be PNG (screenshots are PNG by default)
			if (!name.toLowerCase().endsWith(".png")) return false;
			// Must match screenshot naming pattern
			return isScreenshotName(name);
		})
		.map((name) => {
			const path = join(directory, name);
			try {
				const stats = statSync(path);
				return {
					path,
					name,
					mtime: stats.mtime,
					size: stats.size,
				};
			} catch {
				return null;
			}
		})
		.filter((f): f is ScreenshotInfo => f !== null);

	return files;
}

/**
 * Get screenshots from a glob pattern (no name filtering - pattern defines what to match).
 */
function getScreenshotsFromGlob(pattern: string): ScreenshotInfo[] {
	try {
		const expandedPattern = expandPath(pattern);
		const files = globSync(expandedPattern, { nodir: true });

		return files
			.filter((path) => {
				// Only include image files
				const ext = path.toLowerCase();
				return ext.endsWith(".png") || ext.endsWith(".jpg") || ext.endsWith(".jpeg") || ext.endsWith(".webp");
			})
			.map((path) => {
				try {
					const stats = statSync(path);
					return {
						path: resolve(path),
						name: basename(path),
						mtime: stats.mtime,
						size: stats.size,
					};
				} catch {
					return null;
				}
			})
			.filter((f): f is ScreenshotInfo => f !== null);
	} catch {
		return [];
	}
}

/**
 * Get screenshots from a source (handles both directories and glob patterns).
 */
function getScreenshotsFromSource(source: string): ScreenshotInfo[] {
	const expanded = expandPath(source);

	if (isGlobPattern(expanded)) {
		return getScreenshotsFromGlob(expanded);
	}

	// Plain directory - use screenshot name filtering
	return getScreenshotsFromDirectory(expanded);
}

/**
 * Create a short label from a source pattern.
 */
function createSourceLabel(source: string): string {
	const expanded = expandPath(source);

	if (isGlobPattern(expanded)) {
		// For globs, use the directory part + pattern hint
		const dir = dirname(expanded.split("*")[0]);
		const dirName = basename(dir) || dir;
		return dirName.slice(0, 15);
	}

	// For directories, use the last component
	return basename(expanded).slice(0, 15);
}

/**
 * Format relative time (e.g., "2 minutes ago").
 */
function formatRelativeTime(date: Date): string {
	const now = Date.now();
	const diff = now - date.getTime();

	const seconds = Math.floor(diff / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	const days = Math.floor(hours / 24);

	if (days > 0) return days === 1 ? "yesterday" : `${days} days ago`;
	if (hours > 0) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
	if (minutes > 0) return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
	return "just now";
}

/**
 * Format file size.
 */
function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Load image as base64.
 */
function loadImageBase64(path: string): { data: string; mimeType: string } {
	const buffer = readFileSync(path);
	const ext = path.toLowerCase();
	let mimeType = "image/png";
	if (ext.endsWith(".jpg") || ext.endsWith(".jpeg")) mimeType = "image/jpeg";
	else if (ext.endsWith(".webp")) mimeType = "image/webp";

	return {
		data: buffer.toString("base64"),
		mimeType,
	};
}

async function loadImageBase64Async(path: string): Promise<{ data: string; mimeType: string }> {
	const buffer = await readFile(path);
	const ext = path.toLowerCase();
	let mimeType = "image/png";
	if (ext.endsWith(".jpg") || ext.endsWith(".jpeg")) mimeType = "image/jpeg";
	else if (ext.endsWith(".webp")) mimeType = "image/webp";

	return {
		data: buffer.toString("base64"),
		mimeType,
	};
}

interface SentScreenshotPreviewDetails {
	paths?: string[];
	totalCount?: number;
}

const SENT_PREVIEW_CUSTOM_TYPE = "screenshots-sent";
const SENT_PREVIEW_CACHE_LIMIT = 12;
const SENT_PREVIEW_MAX_VISIBLE_COLLAPSED = 2;
const SENT_PREVIEW_MAX_VISIBLE_EXPANDED = 6;
const SENT_PREVIEW_WIDTH_COLLAPSED = 60;
const SENT_PREVIEW_WIDTH_EXPANDED = 60;
const sentPreviewImageCache = new Map<string, { data: string; mimeType: string } | null>();
const require = createRequire(import.meta.url);
let nativeResizeImagePromise: Promise<
	| ((img: ImageContent) => Promise<{ data: string; mimeType: string } | null>)
	| null
> | null = null;

function getCachedSentPreviewImage(path: string): { data: string; mimeType: string } | null {
	if (!sentPreviewImageCache.has(path)) {
		return null;
	}

	const cached = sentPreviewImageCache.get(path) || null;
	sentPreviewImageCache.delete(path);
	sentPreviewImageCache.set(path, cached);
	return cached;
}

function setCachedSentPreviewImage(path: string, image: { data: string; mimeType: string } | null): void {
	sentPreviewImageCache.set(path, image);
	while (sentPreviewImageCache.size > SENT_PREVIEW_CACHE_LIMIT) {
		const oldestKey = sentPreviewImageCache.keys().next().value;
		if (!oldestKey) break;
		sentPreviewImageCache.delete(oldestKey);
	}
}

async function getNativeResizeImage(): Promise<
	| ((img: ImageContent) => Promise<{ data: string; mimeType: string } | null>)
	| null
> {
	if (!nativeResizeImagePromise) {
		nativeResizeImagePromise = (async () => {
			try {
				const packageEntry = require.resolve("@earendil-works/pi-coding-agent");
				const resizeModuleUrl = pathToFileURL(join(dirname(packageEntry), "utils", "image-resize.js")).href;
				const resizeModule = await import(resizeModuleUrl);
				if (typeof resizeModule.resizeImage !== "function") {
					return null;
				}
				return async (img: ImageContent) => {
					const resized = await resizeModule.resizeImage(img);
					if (!resized) {
						return null;
					}
					return { data: resized.data, mimeType: resized.mimeType };
				};
			} catch {
				return null;
			}
		})();
	}

	return nativeResizeImagePromise;
}

async function prepareSentPreviewImage(path: string): Promise<{ data: string; mimeType: string } | null> {
	const cached = getCachedSentPreviewImage(path);
	if (cached || sentPreviewImageCache.has(path)) {
		return cached;
	}

	try {
		const image = loadImageBase64(path);
		const { autoResizeImages } = loadPiImageSettings();
		if (!autoResizeImages) {
			setCachedSentPreviewImage(path, image);
			return image;
		}

		const resizeImage = await getNativeResizeImage();
		const prepared = resizeImage ? await resizeImage({ type: "image", data: image.data, mimeType: image.mimeType }) : image;
		setCachedSentPreviewImage(path, prepared);
		return prepared;
	} catch {
		setCachedSentPreviewImage(path, null);
		return null;
	}
}

export default function screenshotsExtension(pi: ExtensionAPI) {
	const config = loadConfig();

	// Staged images waiting to be sent with the next user message
	let stagedImages: ImageContent[] = [];
	// Track staged paths at module level so picker can show ✓ on reopening
	let stagedPaths = new Set<string>();
	// Track the paths that were just sent so we can show a display-only preview in chat
	let pendingSentPreviewPaths: string[] = [];
	let activeContext: ExtensionContext | undefined;

	function takeStagedImages(ctx: ExtensionContext): ImageContent[] {
		const images = [...stagedImages];
		pendingSentPreviewPaths = [...stagedPaths];
		stagedImages = [];
		stagedPaths.clear();
		ctx.ui.setWidget("screenshots-staged", undefined);
		return images;
	}

	pi.on("session_start", async (_event, ctx) => {
		activeContext = ctx;
		if (isOrcaTerminal) return;

		const previewPaths = new Set<string>();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom_message") continue;
			if (entry.customType !== SENT_PREVIEW_CUSTOM_TYPE) continue;
			const details = entry.details as SentScreenshotPreviewDetails | undefined;
			for (const path of details?.paths || []) {
				if (typeof path === "string") {
					previewPaths.add(path);
				}
			}
		}

		await Promise.all(Array.from(previewPaths, (path) => prepareSentPreviewImage(path)));
	});

	const stopQueueSteerAttachments = pi.events.on(QUEUE_STEER_ATTACHMENTS_EVENT, (value) => {
		if (!Check(QueueSteerAttachmentsEventSchema, value) || stagedImages.length === 0 || !activeContext) return;
		value.attach(takeStagedImages(activeContext));
	});

	pi.on("session_shutdown", () => {
		stopQueueSteerAttachments();
		activeContext = undefined;
	});

	pi.registerMessageRenderer<SentScreenshotPreviewDetails>(SENT_PREVIEW_CUSTOM_TYPE, (message, options, theme) => {
		const details = message.details || {};
		const allPaths = (details.paths || []).filter((path): path is string => typeof path === "string");
		const totalCount = details.totalCount ?? allPaths.length;
		const visibleLimit = options.expanded ? SENT_PREVIEW_MAX_VISIBLE_EXPANDED : SENT_PREVIEW_MAX_VISIBLE_COLLAPSED;
		const visiblePaths = allPaths.slice(0, visibleLimit);
		const hiddenCount = Math.max(0, totalCount - visiblePaths.length);
		const { showImages } = loadPiImageSettings();
		const container = new Container();

		if (visiblePaths.length === 0) {
			container.addChild(new Text(theme.fg("dim", "No screenshot previews available"), 0, 0));
			return container;
		}

		for (let index = 0; index < visiblePaths.length; index++) {
			const path = visiblePaths[index]!;
			if (index > 0) {
				container.addChild(new Spacer(1));
			}
			const image = getCachedSentPreviewImage(path);
			if (showImages && image) {
				const dimensions = getTerminalImageDimensions(image.data, image.mimeType);
				const cellDimensions = getCellDimensions();
				const naturalWidthCells = dimensions
					? Math.max(1, Math.ceil(dimensions.widthPx / Math.max(1, cellDimensions.widthPx)))
					: SENT_PREVIEW_WIDTH_COLLAPSED;
				const maxWidthCells = Math.min(
					options.expanded ? SENT_PREVIEW_WIDTH_EXPANDED : SENT_PREVIEW_WIDTH_COLLAPSED,
					naturalWidthCells,
				);
				container.addChild(
					new Image(
						image.data,
						image.mimeType,
						{ fallbackColor: (text: string) => theme.fg("customMessageText", text) },
						{ maxWidthCells },
					),
				);
			} else {
				container.addChild(new Text(theme.fg("dim", basename(path)), 0, 0));
			}
		}

		if (hiddenCount > 0) {
			container.addChild(new Spacer(1));
			container.addChild(
				new Text(theme.fg("dim", `+${hiddenCount} more screenshot${hiddenCount === 1 ? "" : "s"}`), 0, 0),
			);
		}

		return container;
	});

	pi.on("context", (event) => {
		return {
			messages: event.messages.filter(
				(message) => !(message.role === "custom" && message.customType === SENT_PREVIEW_CUSTOM_TYPE),
			),
		};
	});

	pi.on("before_agent_start", async () => {
		if (pendingSentPreviewPaths.length === 0) {
			return undefined;
		}

		const sentPaths = [...pendingSentPreviewPaths];
		pendingSentPreviewPaths = [];
		if (!isOrcaTerminal) {
			await Promise.all(sentPaths.map((path) => prepareSentPreviewImage(path)));
		}
		return {
			message: {
				customType: SENT_PREVIEW_CUSTOM_TYPE,
				content: `Sent ${sentPaths.length} screenshot${sentPaths.length === 1 ? "" : "s"}`,
				display: true,
				details: {
					paths: sentPaths,
					totalCount: sentPaths.length,
				},
			},
		};
	});

	/**
	 * Get source tabs based on configuration.
	 */
	function getSourceTabs(): SourceTab[] {
		const sources = config.sources && config.sources.length > 0
			? [...config.sources]
			: [process.env.PI_SCREENSHOTS_DIR || getDefaultScreenshotDir()];

		return sources.map((source) => {
			const screenshots = getScreenshotsFromSource(source);
			// Sort by mtime descending (most recent first)
			screenshots.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

			return {
				label: createSourceLabel(source),
				pattern: source,
				screenshots,
			};
		});
	}

	// Intercept input events to attach staged images
	pi.on("input", (event, ctx) => {
		activeContext = ctx;
		if (event.source !== "interactive" || stagedImages.length === 0) {
			return { action: "continue" as const };
		}

		// Attach staged images to the user's message
		const imagesToAttach = takeStagedImages(ctx);

		return {
			action: "transform" as const,
			text: event.text,
			images: [...(event.images || []), ...imagesToAttach],
		};
	});

	// Helper to get image dimensions (for PNG/JPEG/WebP/GIF when available)
	function getImageDimensions(base64Data: string, mimeType: string): { width: number; height: number } | null {
		const dims = getTerminalImageDimensions(base64Data, mimeType);
		return dims ? { width: dims.widthPx, height: dims.heightPx } : null;
	}

	/**
	 * Show screenshot selector UI with tabs.
	 */
	async function showScreenshotSelector(ctx: ExtensionContext): Promise<void> {
		let tabs = getSourceTabs();

		// Filter out empty tabs
		const nonEmptyTabs = tabs.filter((t) => t.screenshots.length > 0);

		if (nonEmptyTabs.length === 0) {
			const sources = config.sources?.join(", ") || getDefaultScreenshotDir();
			ctx.ui.notify(`No screenshots found in: ${sources}`, "warning");
			return;
		}

		tabs = nonEmptyTabs;

		// Detect SSH session - inline images don't work over SSH
		const isSSH = !!(process.env.SSH_CONNECTION || process.env.SSH_CLIENT);

		// Lazy-load thumbnails (load on demand, skip files > 5MB)
		const MAX_THUMB_SIZE = 5 * 1024 * 1024; // 5MB
		const SYNC_THUMB_SIZE = 300 * 1024; // Keep small previews snappy
		const thumbnails: Map<string, { data: string; mimeType: string } | null> = new Map();
		const thumbnailLoads: Map<string, Promise<void>> = new Map();
		const imageDimensionsCache: Map<string, { width: number; height: number } | null> = new Map();
		let requestPreviewRender: (() => void) | null = null;

		function isThumbnailLoading(path: string): boolean {
			return thumbnailLoads.has(path);
		}

		function startThumbnailLoad(screenshot: ScreenshotInfo): void {
			if (thumbnails.has(screenshot.path) || thumbnailLoads.has(screenshot.path)) {
				return;
			}

			if (screenshot.size > MAX_THUMB_SIZE) {
				thumbnails.set(screenshot.path, null);
				return;
			}

			const loadPromise = loadImageBase64Async(screenshot.path)
				.then((img) => {
					thumbnails.set(screenshot.path, img);
					imageDimensionsCache.delete(screenshot.path);
				})
				.catch(() => {
					thumbnails.set(screenshot.path, null);
					imageDimensionsCache.delete(screenshot.path);
				})
				.finally(() => {
					thumbnailLoads.delete(screenshot.path);
					requestPreviewRender?.();
				});

			thumbnailLoads.set(screenshot.path, loadPromise);
		}

		function loadThumbnail(screenshot: ScreenshotInfo): { data: string; mimeType: string } | null {
			if (thumbnails.has(screenshot.path)) {
				return thumbnails.get(screenshot.path) || null;
			}
			if (screenshot.size > MAX_THUMB_SIZE) {
				thumbnails.set(screenshot.path, null);
				return null;
			}

			// Small files are loaded synchronously for immediate preview.
			if (screenshot.size <= SYNC_THUMB_SIZE) {
				try {
					const img = loadImageBase64(screenshot.path);
					thumbnails.set(screenshot.path, img);
					return img;
				} catch {
					thumbnails.set(screenshot.path, null);
					return null;
				}
			}

			// Larger files are loaded asynchronously to avoid UI stalls.
			startThumbnailLoad(screenshot);

			if (thumbnails.has(screenshot.path)) {
				return thumbnails.get(screenshot.path) || null;
			}

			return null;
		}

		function getScreenshotDimensions(screenshot: ScreenshotInfo): { width: number; height: number } | null {
			if (imageDimensionsCache.has(screenshot.path)) {
				return imageDimensionsCache.get(screenshot.path) || null;
			}

			const thumb = loadThumbnail(screenshot);
			if (!thumb) {
				// Cache null only when loading finished and no preview is available.
				if (thumbnails.has(screenshot.path) && !isThumbnailLoading(screenshot.path)) {
					imageDimensionsCache.set(screenshot.path, null);
				}
				return null;
			}

			const dims = getImageDimensions(thumb.data, thumb.mimeType);
			imageDimensionsCache.set(screenshot.path, dims);
			return dims;
		}

		// Track which screenshots have been staged during this session (by path)
		// Initialize from module-level stagedPaths so reopening shows previously staged items
		const alreadyStaged = new Set<string>(stagedPaths);
		let clearedStagedCount = 0;

		let result: string[] | null;
		try {
			result = await ctx.ui.custom<string[] | null>((tui, theme, _kb, done) => {
				requestPreviewRender = () => tui.requestRender();

			let activeTab = 0;
			let cursor = 0;
			let scrollOffset = 0;
			const LIST_WIDTH = 45;
			const LIST_VISIBLE_ITEMS = 10;
			const PREVIEW_LINES = 14;
			const PREVIEW_WIDTH_CAP = 70;
			const ZOOM_PREVIEW_MIN_LINES = 18;
			const ZOOM_PREVIEW_MAX_LINES = 28;
			const ZOOM_PREVIEW_WIDTH_CAP = 120;
			const ZOOM_LEVEL_MIN = 1;
			const ZOOM_LEVEL_MAX = 6;
			const ZOOM_LEVEL_STEP = 0.25;
			const ZOOM_PAN_STEP_RATIO = 0.12;
			const KITTY_IMAGE_ID = 9000;
			const terminalCapabilities = getCapabilities();
			const supportsKittyInspector = terminalCapabilities.images === "kitty";

			let previewZoom = false;
			let zoomLevel = 1;
			let panX = 0;
			let panY = 0;
			let lastRenderWidth = process.stdout.columns || 120;

			// Track double-n for nuke
			let nukeWarning = false;

			const imageTheme = {
				fallbackColor: (s: string) => theme.fg("dim", s),
			};

			// Get current tab's screenshots
			function getCurrentScreenshots(): ScreenshotInfo[] {
				return tabs[activeTab]?.screenshots || [];
			}

			function warmThumbnailsAroundCursor(distance = 5): void {
				const screenshots = getCurrentScreenshots();
				if (screenshots.length === 0) {
					return;
				}

				const start = Math.max(0, cursor - distance);
				const end = Math.min(screenshots.length - 1, cursor + distance);

				for (let i = start; i <= end; i++) {
					const screenshot = screenshots[i];
					if (!screenshot) continue;
					loadThumbnail(screenshot);
				}
			}

			function clamp(value: number, min: number, max: number): number {
				if (value < min) return min;
				if (value > max) return max;
				return value;
			}

			function resetZoomViewport(): void {
				zoomLevel = 1;
				panX = 0;
				panY = 0;
			}

			function moveCursor(delta: number): boolean {
				const screenshots = getCurrentScreenshots();
				if (screenshots.length === 0) {
					return false;
				}

				const nextCursor = clamp(cursor + delta, 0, screenshots.length - 1);
				if (nextCursor === cursor) {
					return false;
				}

				cursor = nextCursor;
				if (cursor < scrollOffset) {
					scrollOffset = cursor;
				}
				if (cursor >= scrollOffset + LIST_VISIBLE_ITEMS) {
					scrollOffset = cursor - LIST_VISIBLE_ITEMS + 1;
				}

				resetZoomViewport();
				return true;
			}

			// Helper to toggle stage/unstage a screenshot
			function toggleStageScreenshot(screenshot: ScreenshotInfo): void {
				if (alreadyStaged.has(screenshot.path)) {
					// Unstage - remove from stagedImages, alreadyStaged, and stagedPaths
					const pathsArray = [...alreadyStaged];
					const pathIndex = pathsArray.indexOf(screenshot.path);
					if (pathIndex !== -1) {
						stagedImages.splice(pathIndex, 1);
					}
					alreadyStaged.delete(screenshot.path);
					stagedPaths.delete(screenshot.path);
					return;
				}

				// Stage - add to stagedImages and track path
				try {
					const img = loadImageBase64(screenshot.path);
					stagedImages.push({
						type: "image",
						mimeType: img.mimeType,
						data: img.data,
					});
					alreadyStaged.add(screenshot.path);
					stagedPaths.add(screenshot.path);
				} catch {
					// Silently fail for individual staging
				}
			}

			// Helper to clear all staged screenshots
			function clearAllStaged(): void {
				stagedImages = [];
				alreadyStaged.clear();
				stagedPaths.clear();
			}

			// Typical terminal cell dimensions (pixels)
			const CELL_WIDTH_PX = 9;
			const CELL_HEIGHT_PX = 18;

			// Calculate max width cells so that image height fits in maxRows
			function calculateConstrainedWidth(
				dims: { width: number; height: number },
				maxRows: number,
				maxWidthCells: number
			): number {
				const safeMaxWidthCells = Math.max(1, maxWidthCells);
				const scaledWidthPx = safeMaxWidthCells * CELL_WIDTH_PX;
				const scale = scaledWidthPx / dims.width;
				const scaledHeightPx = dims.height * scale;
				const rows = Math.ceil(scaledHeightPx / CELL_HEIGHT_PX);

				if (rows <= maxRows) {
					return safeMaxWidthCells;
				}

				const targetHeightPx = maxRows * CELL_HEIGHT_PX;
				const targetScale = targetHeightPx / dims.height;
				const targetWidthPx = dims.width * targetScale;
				return Math.max(1, Math.min(safeMaxWidthCells, Math.floor(targetWidthPx / CELL_WIDTH_PX)));
			}

			function getZoomPreviewLines(): number {
				const terminalRows = process.stdout.rows || 40;
				const availableRows = Math.max(PREVIEW_LINES, terminalRows - 14);
				return Math.max(ZOOM_PREVIEW_MIN_LINES, Math.min(ZOOM_PREVIEW_MAX_LINES, availableRows));
			}

			function getMaxPreviewWidthCells(width: number, isZoomMode: boolean): number {
				const listWidth = isZoomMode ? 0 : LIST_WIDTH;
				const previewWidthCap = isZoomMode ? ZOOM_PREVIEW_WIDTH_CAP : PREVIEW_WIDTH_CAP;
				return Math.max(1, Math.min(previewWidthCap, width - listWidth - (isZoomMode ? 2 : 3)));
			}

			function padToWidth(str: string, targetWidth: number): string {
				const currentWidth = visibleWidth(str);
				if (currentWidth >= targetWidth) return str;
				return str + " ".repeat(targetWidth - currentWidth);
			}

			interface ZoomViewportGeometry {
				cropX: number;
				cropY: number;
				cropWidth: number;
				cropHeight: number;
				maxPanX: number;
				maxPanY: number;
				renderWidthCells: number;
				renderRows: number;
			}

			function encodeKittyWithCrop(
				base64Data: string,
				options: {
					columns: number;
					rows: number;
					imageId: number;
					cropX: number;
					cropY: number;
					cropWidth: number;
					cropHeight: number;
				}
			): string {
				const CHUNK_SIZE = 4096;
				const params = [
					"a=T",
					"f=100",
					"q=2",
					`c=${Math.max(1, Math.floor(options.columns))}`,
					`r=${Math.max(1, Math.floor(options.rows))}`,
					`i=${options.imageId}`,
					`x=${Math.max(0, Math.floor(options.cropX))}`,
					`y=${Math.max(0, Math.floor(options.cropY))}`,
					`w=${Math.max(1, Math.floor(options.cropWidth))}`,
					`h=${Math.max(1, Math.floor(options.cropHeight))}`,
				];

				if (base64Data.length <= CHUNK_SIZE) {
					return `\x1b_G${params.join(",")};${base64Data}\x1b\\`;
				}

				const chunks: string[] = [];
				let offset = 0;
				let firstChunk = true;

				while (offset < base64Data.length) {
					const chunk = base64Data.slice(offset, offset + CHUNK_SIZE);
					const isLast = offset + CHUNK_SIZE >= base64Data.length;

					if (firstChunk) {
						chunks.push(`\x1b_G${params.join(",")},m=1;${chunk}\x1b\\`);
						firstChunk = false;
					} else if (isLast) {
						chunks.push(`\x1b_Gm=0;${chunk}\x1b\\`);
					} else {
						chunks.push(`\x1b_Gm=1;${chunk}\x1b\\`);
					}

					offset += CHUNK_SIZE;
				}

				return chunks.join("");
			}

			function getZoomViewportGeometry(
				screenshot: ScreenshotInfo,
				maxPreviewWidthCells: number,
				previewLines: number
			): ZoomViewportGeometry | null {
				const dims = getScreenshotDimensions(screenshot);
				if (!dims) {
					return null;
				}

				const viewportWidthPx = Math.max(1, maxPreviewWidthCells * CELL_WIDTH_PX);
				const viewportHeightPx = Math.max(1, previewLines * CELL_HEIGHT_PX);
				const fitScale = Math.min(viewportWidthPx / dims.width, viewportHeightPx / dims.height);
				const safeFitScale = fitScale > 0 && Number.isFinite(fitScale) ? fitScale : 1;
				const scale = safeFitScale * zoomLevel;

				const cropWidth = Math.max(1, Math.min(dims.width, Math.floor(viewportWidthPx / scale)));
				const cropHeight = Math.max(1, Math.min(dims.height, Math.floor(viewportHeightPx / scale)));
				const maxPanX = Math.max(0, dims.width - cropWidth);
				const maxPanY = Math.max(0, dims.height - cropHeight);

				panX = clamp(panX, 0, maxPanX);
				panY = clamp(panY, 0, maxPanY);

				const renderWidthPx = cropWidth * scale;
				const renderHeightPx = cropHeight * scale;
				const renderWidthCells = Math.max(1, Math.min(maxPreviewWidthCells, Math.floor(renderWidthPx / CELL_WIDTH_PX)));
				const renderRows = Math.max(1, Math.min(previewLines, Math.ceil(renderHeightPx / CELL_HEIGHT_PX)));

				return {
					cropX: Math.round(panX),
					cropY: Math.round(panY),
					cropWidth,
					cropHeight,
					maxPanX,
					maxPanY,
					renderWidthCells,
					renderRows,
				};
			}

			function panViewport(horizontal: number, vertical: number): boolean {
				if (!previewZoom || !supportsKittyInspector) {
					return false;
				}

				const screenshots = getCurrentScreenshots();
				const currentScreenshot = screenshots[cursor];
				if (!currentScreenshot) {
					return false;
				}

				const previewLines = getZoomPreviewLines();
				const maxPreviewWidthCells = getMaxPreviewWidthCells(lastRenderWidth, true);
				const geometry = getZoomViewportGeometry(currentScreenshot, maxPreviewWidthCells, previewLines);
				if (!geometry) {
					return false;
				}

				const stepX = Math.max(12, Math.floor(geometry.cropWidth * ZOOM_PAN_STEP_RATIO));
				const stepY = Math.max(12, Math.floor(geometry.cropHeight * ZOOM_PAN_STEP_RATIO));

				const nextPanX = clamp(panX + horizontal * stepX, 0, geometry.maxPanX);
				const nextPanY = clamp(panY + vertical * stepY, 0, geometry.maxPanY);

				if (nextPanX === panX && nextPanY === panY) {
					return false;
				}

				panX = nextPanX;
				panY = nextPanY;
				return true;
			}

			function setZoomLevel(nextZoomLevel: number): boolean {
				const clampedZoom = clamp(nextZoomLevel, ZOOM_LEVEL_MIN, ZOOM_LEVEL_MAX);
				if (clampedZoom === zoomLevel) {
					return false;
				}

				zoomLevel = clampedZoom;
				const currentScreenshot = getCurrentScreenshots()[cursor];
				if (!currentScreenshot) {
					panX = 0;
					panY = 0;
					return true;
				}

				const previewLines = getZoomPreviewLines();
				const maxPreviewWidthCells = getMaxPreviewWidthCells(lastRenderWidth, true);
				const geometry = getZoomViewportGeometry(currentScreenshot, maxPreviewWidthCells, previewLines);
				if (!geometry) {
					panX = 0;
					panY = 0;
				}

				return true;
			}

			let lastRenderedPath = "";
			let lastRenderedFrameKey = "";

			function renderThumbnail(
				screenshot: ScreenshotInfo,
				maxPreviewWidthCells: number,
				previewLines: number
			): string[] {
				const name = screenshot.name.slice(-20);
				if (isOrcaTerminal) {
					const lines = [
						theme.fg("accent", "  Orca terminal"),
						"",
						theme.fg("text", `  ${name}`),
						theme.fg("dim", `  ${formatSize(screenshot.size)} • ${formatRelativeTime(screenshot.mtime)}`),
						"",
						theme.fg("dim", "  Press o to open this screenshot"),
						theme.fg("dim", "  Stage with s/space, then send your prompt"),
					];
					for (let i = lines.length; i < previewLines; i++) lines.push("");
					return lines;
				}

				const thumb = loadThumbnail(screenshot);
				const frameKey = `${screenshot.path}:${maxPreviewWidthCells}:${previewLines}`;

				// Delete previous image when switching to a different screenshot.
				// Inspector mode has its own renderer that deletes every frame.
				let deleteCmd = "";
				if (lastRenderedFrameKey && lastRenderedFrameKey !== frameKey) {
					deleteCmd = deleteKittyImage(KITTY_IMAGE_ID);
				}
				lastRenderedPath = screenshot.path;
				lastRenderedFrameKey = frameKey;

				if (!thumb) {
					const lines: string[] = [];
					const loading = isThumbnailLoading(screenshot.path);
					lines.push(deleteCmd + theme.fg("dim", loading ? `  [Loading preview: ${name}]` : `  [No preview: ${name}]`));
					for (let i = 1; i < previewLines; i++) lines.push("");
					return lines;
				}

				try {
					// Get dimensions and calculate constrained width so height fits
					const dims = getScreenshotDimensions(screenshot);
					const maxWidth = dims
						? calculateConstrainedWidth(dims, previewLines, maxPreviewWidthCells)
						: Math.max(1, maxPreviewWidthCells);

					const img = new Image(thumb.data, thumb.mimeType, imageTheme, {
						maxWidthCells: maxWidth,
						imageId: KITTY_IMAGE_ID,
					});
					const rendered = img.render(maxWidth + 2);

					// Check if this is a text fallback (no image support)
					const firstLine = rendered[0] || "";
					if (firstLine.includes("[Image:") || firstLine.includes("[image/")) {
						// Terminal doesn't support inline images - show helpful message
						const lines: string[] = [];
						const sizeInfo = dims ? `${dims.width}x${dims.height}` : "";
						lines.push(deleteCmd + theme.fg("dim", `  ${name} ${sizeInfo}`));
						lines.push("");
						if (isSSH) {
							lines.push(theme.fg("dim", "  Add to remote ~/.bashrc or ~/.zshrc:"));
							lines.push(theme.fg("dim", "  export TERM_PROGRAM=ghostty|kitty|WezTerm|iTerm.app"));
						} else {
							lines.push(theme.fg("dim", "  Thumbnails require Kitty, iTerm2,"));
							lines.push(theme.fg("dim", "  WezTerm, or Ghostty terminal"));
						}
						for (let i = lines.length; i < previewLines; i++) lines.push("");
						return lines;
					}

					// Image component returns (rows-1) empty lines, then cursor-up + image on last line.
					const lines: string[] = [];
					for (let i = 0; i < previewLines; i++) {
						const line = rendered[i] || "";
						lines.push(i === 0 ? deleteCmd + line : line);
					}
					return lines;
				} catch {
					const lines: string[] = [];
					lines.push(deleteCmd + theme.fg("error", `  [Error: ${name}]`));
					for (let i = 1; i < previewLines; i++) lines.push("");
					return lines;
				}
			}

			function renderZoomInspectorThumbnail(
				screenshot: ScreenshotInfo,
				maxPreviewWidthCells: number,
				previewLines: number
			): { lines: string[]; geometry: ZoomViewportGeometry | null } {
				if (!supportsKittyInspector) {
					const zoomedWidth = Math.max(1, Math.min(ZOOM_PREVIEW_WIDTH_CAP, Math.floor(maxPreviewWidthCells * zoomLevel)));
					return {
						lines: renderThumbnail(screenshot, zoomedWidth, previewLines),
						geometry: null,
					};
				}

				const thumb = loadThumbnail(screenshot);
				const name = screenshot.name.slice(-20);

				let deleteCmd = "";
				// In inspector mode, delete the previous Kitty image on every render.
				// Otherwise zoom/pan updates of the same screenshot can stack images.
				if (lastRenderedPath) {
					deleteCmd = deleteKittyImage(KITTY_IMAGE_ID);
				}
				lastRenderedPath = screenshot.path;
				lastRenderedFrameKey = `${screenshot.path}:${maxPreviewWidthCells}:${previewLines}:zoom`;

				if (!thumb) {
					const lines: string[] = [];
					const loading = isThumbnailLoading(screenshot.path);
					lines.push(deleteCmd + theme.fg("dim", loading ? `  [Loading preview: ${name}]` : `  [No preview: ${name}]`));
					for (let i = 1; i < previewLines; i++) lines.push("");
					return { lines, geometry: null };
				}

				const geometry = getZoomViewportGeometry(screenshot, maxPreviewWidthCells, previewLines);
				if (!geometry) {
					const lines: string[] = [];
					lines.push(deleteCmd + theme.fg("dim", `  [No inspect preview: ${name}]`));
					for (let i = 1; i < previewLines; i++) lines.push("");
					return { lines, geometry: null };
				}

				try {
					const sequence = encodeKittyWithCrop(thumb.data, {
						columns: geometry.renderWidthCells,
						rows: geometry.renderRows,
						imageId: KITTY_IMAGE_ID,
						cropX: geometry.cropX,
						cropY: geometry.cropY,
						cropWidth: geometry.cropWidth,
						cropHeight: geometry.cropHeight,
					});

					const lines: string[] = [];
					const moveUp = geometry.renderRows > 1 ? `\x1b[${geometry.renderRows - 1}A` : "";
					for (let i = 0; i < geometry.renderRows - 1; i++) {
						lines.push("");
					}
					lines.push(deleteCmd + moveUp + sequence);
					for (let i = geometry.renderRows; i < previewLines; i++) {
						lines.push("");
					}

					return { lines, geometry };
				} catch {
					const lines: string[] = [];
					lines.push(deleteCmd + theme.fg("error", `  [Inspect error: ${name}]`));
					for (let i = 1; i < previewLines; i++) lines.push("");
					return { lines, geometry: null };
				}
			}

			return {
				render(width: number) {
					lastRenderWidth = width;
					const lines: string[] = [];
					const border = theme.fg("accent", "\u2500".repeat(width));
					const screenshots = getCurrentScreenshots();
					if (!isOrcaTerminal) {
						warmThumbnailsAroundCursor();
					}
					const previewLines = previewZoom ? getZoomPreviewLines() : PREVIEW_LINES;
					const listVisibleItems = previewZoom ? 0 : LIST_VISIBLE_ITEMS;
					const contentRows = Math.max(listVisibleItems, previewLines);
					const maxPreviewWidthCells = getMaxPreviewWidthCells(width, previewZoom);

					// Header
					lines.push(border);

					// Tabs (if multiple sources)
					if (tabs.length > 1) {
						let tabLine = " ";
						for (let i = 0; i < tabs.length; i++) {
							const tab = tabs[i];
							const count = tab.screenshots.length;
							const label = `${tab.label} (${count})`;

							if (i === activeTab) {
								tabLine += theme.fg("accent", theme.bold(`[${label}]`));
							} else {
								tabLine += theme.fg("dim", ` ${label} `);
							}
							tabLine += " ";
						}
						tabLine += theme.fg("dim", previewZoom ? "  Ctrl+T: switch \u2022 z: split" : "  Ctrl+T: switch \u2022 z: zoom");
						if (previewZoom) {
							lines.push(tabLine);
							lines.push("");
						} else {
							lines.push(padToWidth(tabLine, LIST_WIDTH) + "\u2502");
							lines.push(padToWidth("", LIST_WIDTH) + "\u2502");
						}
					}

					if (previewZoom) {
						const countInfo = screenshots.length > 0 ? ` (${cursor + 1}/${screenshots.length})` : "";
						lines.push(" " + theme.fg("accent", theme.bold("Screenshot Inspector")) + theme.fg("dim", countInfo));

						const sourcePath = expandPath(tabs[activeTab].pattern).slice(-80);
						lines.push(" " + theme.fg("dim", sourcePath));

						const currentScreenshot = screenshots[cursor];
						const zoomRender = currentScreenshot
							? renderZoomInspectorThumbnail(currentScreenshot, maxPreviewWidthCells, previewLines)
							: { lines: Array(previewLines).fill(""), geometry: null as ZoomViewportGeometry | null };

						if (currentScreenshot) {
							const relTime = formatRelativeTime(currentScreenshot.mtime);
							const size = formatSize(currentScreenshot.size);
							const panInfo = zoomRender.geometry
								? ` \u2022 pan ${Math.round(panX)}/${zoomRender.geometry.maxPanX}, ${Math.round(panY)}/${zoomRender.geometry.maxPanY}`
								: "";
							lines.push(
								" " +
									theme.fg(
										"dim",
										`${currentScreenshot.name} \u2022 ${relTime} \u2022 ${size} \u2022 zoom ${zoomLevel.toFixed(2)}x${panInfo}`
									)
							);
							if (!supportsKittyInspector) {
								lines.push(" " + theme.fg("dim", "Pan inspection works in Kitty/Ghostty/WezTerm terminals"));
							}
						} else {
							lines.push(" " + theme.fg("dim", "No screenshot selected"));
						}
						lines.push("");

						const imageLines = zoomRender.lines;

						for (let i = 0; i < contentRows; i++) {
							const imageLine = imageLines[i] || "";
							lines.push(" " + imageLine);
						}
					} else {
						// Title
						const countInfo = screenshots.length > LIST_VISIBLE_ITEMS ? ` (${cursor + 1}/${screenshots.length})` : "";
						lines.push(
							padToWidth(" " + theme.fg("accent", theme.bold("Recent Screenshots")) + theme.fg("dim", countInfo), LIST_WIDTH) +
								"\u2502"
						);

						// Source path hint
						const sourcePath = expandPath(tabs[activeTab].pattern).slice(-40);
						lines.push(padToWidth(" " + theme.fg("dim", sourcePath), LIST_WIDTH) + "\u2502");
						lines.push(padToWidth("", LIST_WIDTH) + "\u2502");

						// Render thumbnail for current selection
						const currentScreenshot = screenshots[cursor];
						const imageLines = currentScreenshot
							? renderThumbnail(currentScreenshot, maxPreviewWidthCells, previewLines)
							: Array(previewLines).fill("");

						// Content area: list keeps a compact height while preview gets extra rows
						for (let i = 0; i < contentRows; i++) {
							let listLine = "";

							if (i < listVisibleItems) {
								const itemIndex = scrollOffset + i;
								if (itemIndex < screenshots.length) {
									const screenshot = screenshots[itemIndex];
									const isStaged = alreadyStaged.has(screenshot.path);
									const isCursor = itemIndex === cursor;

									// Show different indicators
									const checkbox = isStaged ? "\u2713" : "\u25CB";
									const cursorIndicator = isCursor ? "\u25B8" : " ";

									const relTime = formatRelativeTime(screenshot.mtime);
									const size = formatSize(screenshot.size);
									const timeStr = screenshot.mtime.toLocaleTimeString("en-US", {
										hour: "2-digit",
										minute: "2-digit",
									});

									listLine = ` ${cursorIndicator} ${checkbox} ${timeStr} (${relTime}) - ${size}`;

									if (isStaged) {
										listLine = theme.fg("success", listLine);
									} else if (isCursor) {
										listLine = theme.fg("accent", listLine);
									} else {
										listLine = theme.fg("text", listLine);
									}
								}
							}

							const paddedLine = padToWidth(listLine, LIST_WIDTH);
							const imageLine = imageLines[i] || "";
							lines.push(paddedLine + "\u2502 " + imageLine);
						}
					}

					// Footer
					const stagedCount = alreadyStaged.size;
					const zoomSelectionLocked = previewZoom && supportsKittyInspector && zoomLevel > ZOOM_LEVEL_MIN;
					lines.push("");
					if (nukeWarning) {
						lines.push(" " + theme.fg("error", "\u26A0 Press n again to DELETE ALL screenshots in this source!"));
						lines.push(" " + theme.fg("dim", "Any other key to cancel"));
					} else if (stagedCount === 0) {
						lines.push(" " + theme.fg("warning", "\u26A0 Press s/space to stage screenshots before closing"));
						if (zoomSelectionLocked) {
							lines.push(" " + theme.fg("warning", "Zoom lock: press 0 to reset before using \u2191\u2193 to select other screenshots"));
						}
						lines.push(
							" " +
								theme.fg(
									"dim",
									previewZoom
										? supportsKittyInspector
											? "\u2191\u2193\u2190\u2192 pan \u2022 +/- zoom \u2022 [ ] nav \u2022 0 reset \u2022 z split \u2022 s/space toggle \u2022 enter done"
											: "\u2191\u2193 nav \u2022 +/- zoom \u2022 z split \u2022 s/space toggle \u2022 enter done"
										: "\u2191\u2193 nav \u2022 z zoom \u2022 s/space toggle \u2022 o open \u2022 d delete \u2022 nn delete all \u2022 enter done"
								)
						);
					} else {
						lines.push(" " + theme.fg("success", `\u2713 ${stagedCount} staged`));
						if (zoomSelectionLocked) {
							lines.push(" " + theme.fg("warning", "Zoom lock: press 0 to reset before using \u2191\u2193 to select other screenshots"));
						}
						lines.push(
							" " +
								theme.fg(
									"dim",
									previewZoom
										? supportsKittyInspector
											? "\u2191\u2193\u2190\u2192 pan \u2022 +/- zoom \u2022 [ ] nav \u2022 0 reset \u2022 z split \u2022 x clear all \u2022 enter done"
											: "\u2191\u2193 nav \u2022 +/- zoom \u2022 z split \u2022 x clear all \u2022 enter done"
										: "z zoom \u2022 s/space toggle \u2022 x clear all \u2022 d delete \u2022 nn nuke \u2022 enter done"
								)
						);
					}
					lines.push(border);

					return lines;
				},
				invalidate() {
					// Nothing to invalidate
				},
				handleInput(data: string) {
					const screenshots = getCurrentScreenshots();

					// Helper to clean up displayed image before exiting
					function cleanupImage() {
						if (lastRenderedPath) {
							process.stdout.write(deleteKittyImage(KITTY_IMAGE_ID));
							lastRenderedPath = "";
							lastRenderedFrameKey = "";
						}
					}

					// Handle nuke confirmation
					if (nukeWarning) {
						if (data === "n" || data === "N") {
							// Double-n confirmed - nuke all files in current source
							const tabScreenshots = tabs[activeTab].screenshots;
							for (const screenshot of [...tabScreenshots]) {
								try {
									unlinkSync(screenshot.path);
									thumbnails.delete(screenshot.path);
									imageDimensionsCache.delete(screenshot.path);
									if (alreadyStaged.has(screenshot.path)) {
										const pathsArray = [...alreadyStaged];
										const pathIndex = pathsArray.indexOf(screenshot.path);
										if (pathIndex !== -1) {
											stagedImages.splice(pathIndex, 1);
										}
										alreadyStaged.delete(screenshot.path);
										stagedPaths.delete(screenshot.path);
									}
								} catch {
									// Silently fail for individual files
								}
							}
							tabScreenshots.length = 0; // Clear the array

							// Check if there are other non-empty tabs
							const nonEmptyTabIndex = tabs.findIndex((t, i) => i !== activeTab && t.screenshots.length > 0);
							if (nonEmptyTabIndex !== -1) {
								activeTab = nonEmptyTabIndex;
								cursor = 0;
								scrollOffset = 0;
								resetZoomViewport();
							} else {
								cleanupImage();
								done(null); // No more screenshots anywhere
								return;
							}

							nukeWarning = false;
							cursor = 0;
							scrollOffset = 0;
							resetZoomViewport();
							tui.requestRender();
						} else {
							// Any other key cancels nuke
							nukeWarning = false;
							tui.requestRender();
						}
						return;
					}

					// Ctrl+T to cycle tabs
					if (matchesKey(data, Key.ctrl("t"))) {
						if (tabs.length > 1) {
							activeTab = (activeTab + 1) % tabs.length;
							cursor = 0;
							scrollOffset = 0;
							resetZoomViewport();
							tui.requestRender();
						}
						return;
					}

					// First n press - show warning
					if (data === "n" || data === "N") {
						nukeWarning = true;
						tui.requestRender();
						return;
					}

					if (data === "z" || data === "Z") {
						cleanupImage();
						previewZoom = !previewZoom;
						resetZoomViewport();
						tui.requestRender();
						return;
					}

					if (previewZoom) {
						if (data === "+" || data === "=") {
							if (setZoomLevel(zoomLevel + ZOOM_LEVEL_STEP)) {
								tui.requestRender();
							}
							return;
						}

						if (data === "-" || data === "_") {
							if (setZoomLevel(zoomLevel - ZOOM_LEVEL_STEP)) {
								tui.requestRender();
							}
							return;
						}

						if (data === "0") {
							if (zoomLevel !== 1 || panX !== 0 || panY !== 0) {
								resetZoomViewport();
								tui.requestRender();
							}
							return;
						}

						if (data === "[" || data === "{") {
							if (moveCursor(-1)) {
								tui.requestRender();
							}
							return;
						}

						if (data === "]" || data === "}") {
							if (moveCursor(1)) {
								tui.requestRender();
							}
							return;
						}

						if (matchesKey(data, Key.left)) {
							if (panViewport(-1, 0)) {
								tui.requestRender();
							}
							return;
						}

						if (matchesKey(data, Key.right)) {
							if (panViewport(1, 0)) {
								tui.requestRender();
							}
							return;
						}

						if (matchesKey(data, Key.up)) {
							const didPan = panViewport(0, -1);
							if (didPan) {
								tui.requestRender();
								return;
							}

							if (supportsKittyInspector && zoomLevel > ZOOM_LEVEL_MIN) {
								return;
							}

							if (moveCursor(-1)) {
								tui.requestRender();
							}
							return;
						}

						if (matchesKey(data, Key.down)) {
							const didPan = panViewport(0, 1);
							if (didPan) {
								tui.requestRender();
								return;
							}

							if (supportsKittyInspector && zoomLevel > ZOOM_LEVEL_MIN) {
								return;
							}

							if (moveCursor(1)) {
								tui.requestRender();
							}
							return;
						}
					}

					if (matchesKey(data, Key.up)) {
						if (moveCursor(-1)) {
							tui.requestRender();
						}
					} else if (matchesKey(data, Key.down)) {
						if (moveCursor(1)) {
							tui.requestRender();
						}
					} else if (matchesKey(data, Key.space) || data === "s" || data === "S") {
						// Toggle stage/unstage current screenshot
						if (screenshots[cursor]) {
							toggleStageScreenshot(screenshots[cursor]);
							tui.requestRender();
						}
					} else if (matchesKey(data, Key.enter)) {
						// Close selector (images already staged via s/space)
						cleanupImage();
						done([]);
					} else if (matchesKey(data, Key.escape)) {
						cleanupImage();
						done(null);
					} else if (data === "o") {
						// Open in default image viewer
						if (screenshots[cursor]) {
							openFile(screenshots[cursor].path);
						}
					} else if (data === "x" || data === "X") {
						// Clear all staged screenshots
						if (alreadyStaged.size > 0) {
							clearedStagedCount = alreadyStaged.size;
							clearAllStaged();
							tui.requestRender();
						}
					} else if (data === "d" || data === "D") {
						// Delete the screenshot file from disk
						if (screenshots.length === 0) return;

						const screenshot = screenshots[cursor];
						try {
							unlinkSync(screenshot.path);

							// Remove from thumbnails cache
							thumbnails.delete(screenshot.path);
							imageDimensionsCache.delete(screenshot.path);

							// Remove from alreadyStaged if it was staged
							if (alreadyStaged.has(screenshot.path)) {
								const pathsArray = [...alreadyStaged];
								const pathIndex = pathsArray.indexOf(screenshot.path);
								if (pathIndex !== -1) {
									stagedImages.splice(pathIndex, 1);
								}
								alreadyStaged.delete(screenshot.path);
								stagedPaths.delete(screenshot.path);
							}

							// Remove from current tab's screenshots
							const tabScreenshots = tabs[activeTab].screenshots;
							const idx = tabScreenshots.findIndex((s) => s.path === screenshot.path);
							if (idx !== -1) {
								tabScreenshots.splice(idx, 1);
							}

							// Adjust cursor if needed
							if (tabScreenshots.length === 0) {
								// Check if there are other non-empty tabs
								const nonEmptyTabIndex = tabs.findIndex((t, i) => i !== activeTab && t.screenshots.length > 0);
								if (nonEmptyTabIndex !== -1) {
									activeTab = nonEmptyTabIndex;
									cursor = 0;
									scrollOffset = 0;
									resetZoomViewport();
								} else {
									cleanupImage();
									done(null); // No more screenshots, close
									return;
								}
							} else {
								if (cursor >= tabScreenshots.length) {
									cursor = tabScreenshots.length - 1;
								}
								if (scrollOffset > 0 && scrollOffset >= tabScreenshots.length - LIST_VISIBLE_ITEMS + 1) {
									scrollOffset = Math.max(0, tabScreenshots.length - LIST_VISIBLE_ITEMS);
								}
								resetZoomViewport();
							}

							tui.requestRender();
						} catch {
							// Silently fail if deletion fails
						}
					}
				},
			};
			});
		} finally {
			requestPreviewRender = null;
		}

		if (alreadyStaged.size === 0 && clearedStagedCount > 0) {
			ctx.ui.notify(
				`Cleared ${clearedStagedCount} staged screenshot${clearedStagedCount === 1 ? "" : "s"}`,
				"info"
			);
		}

		// User cancelled
		if (result === null) {
			return;
		}

		// Show notification if anything was staged
		if (alreadyStaged.size > 0) {
			const count = alreadyStaged.size;
			const totalStaged = stagedImages.length;
			const label = count === 1 ? "screenshot" : "screenshots";

			if (totalStaged > count) {
				ctx.ui.notify(`Added ${count} ${label} (${totalStaged} total). Type your message and send.`, "info");
			} else {
				ctx.ui.notify(`${count} ${label} staged. Type your message and send.`, "info");
			}
		}
	}

	// Helper to update the staged images widget
	function updateStagedWidget(ctx: ExtensionContext) {
		if (stagedImages.length > 0) {
			const label = stagedImages.length === 1 ? "screenshot" : "screenshots";
			ctx.ui.setWidget(
				"screenshots-staged",
				[`\uD83D\uDCF7 ${stagedImages.length} ${label} staged (Ctrl+1 to clear)`],
				{ placement: "belowEditor" }
			);
		} else {
			ctx.ui.setWidget("screenshots-staged", undefined);
		}
	}

	// Register command
	pi.registerCommand("ss", {
		description: "Show recent screenshots for quick attachment",
		handler: async (_args, ctx) => {
			await showScreenshotSelector(ctx);
			updateStagedWidget(ctx);
		},
	});

	// Register command to clear staged screenshots
	pi.registerCommand("ss-clear", {
		description: "Clear staged screenshots",
		handler: async (_args, ctx) => {
			const count = stagedImages.length;
			stagedImages = [];
			stagedPaths.clear();
			updateStagedWidget(ctx);
			if (count > 0) {
				ctx.ui.notify(`Cleared ${count} staged screenshot${count === 1 ? "" : "s"}`, "info");
			} else {
				ctx.ui.notify("No staged screenshots to clear", "info");
			}
		},
	});

	// Register keyboard shortcut
	pi.registerShortcut(Key.ctrl("`"), {
		description: "Show recent screenshots",
		handler: async (ctx) => {
			await showScreenshotSelector(ctx);
			updateStagedWidget(ctx);
		},
	});

	// Register shortcut to clear staged screenshots
	pi.registerShortcut(Key.ctrl("1"), {
		description: "Clear staged screenshots",
		handler: async (ctx) => {
			const count = stagedImages.length;
			stagedImages = [];
			stagedPaths.clear();
			updateStagedWidget(ctx);
			if (count > 0) {
				ctx.ui.notify(`Cleared ${count} staged screenshot${count === 1 ? "" : "s"}`, "info");
			}
		},
	});
}
