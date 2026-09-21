import { randomUUID } from "node:crypto";

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
	CustomEditor,
	keyText,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { extractInlineEditorLines } from "./editor-render.ts";
import {
	DeliveryQueue,
	QueueEditSession,
	type QueuedMessage,
	type QueueLane,
} from "./queue-state.ts";

export const QUEUE_STEER_ACCEPTED_EVENT = "pi-queue-steer:accepted-steer:v1";
export const QUEUE_STEER_ATTACHMENTS_EVENT = "pi-queue-steer:attachments:v1";

export interface QueueSteerAcceptedEventV1 {
	readonly version: 1;
	readonly producer: "pi-queue-steer";
	readonly producerEpochId: string;
	readonly sessionId: string;
	readonly sequence: number;
}

export interface QueueSteerAttachmentsEventV1 {
	readonly version: 1;
	attach(images: readonly ImageContent[]): void;
}

const WIDGET_ID = "queue-steer.timeline";
const EDITOR_FEATURES = Symbol.for("@tmustier/pi-editor-features");
const QUEUE_STEER_FEATURE = "queue-steer";
const NEXT_ROW_KEY = "alt+down";

type QueueMode = "all" | "one-at-a-time";
type FinishEditAction = "cancel" | "save" | "toggleLane";
type LaneCommand = "/followup" | "/steer";
type EditedLaneCommand =
	| { kind: "none" }
	| { kind: "empty"; command: LaneCommand }
	| { kind: "message"; targetLane: QueueLane; text: string };
type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
type ComposedEditorFactory = EditorFactory & { [EDITOR_FEATURES]?: ReadonlySet<string> };
type InlineEditorRenderer = (width: number) => string[];

function editorFeatures(factory: EditorFactory | undefined): ReadonlySet<string> {
	return (factory as ComposedEditorFactory | undefined)?.[EDITOR_FEATURES] ?? new Set();
}

function laneLabel(lane: QueueLane): string {
	return lane === "steer" ? "steer" : "follow-up";
}

function laneColor(lane: QueueLane): ThemeColor {
	return lane === "steer" ? "accent" : "warning";
}

function compactText(item: QueuedMessage<ImageContent>): string {
	const text = item.text.replace(/\s+/g, " ").trim();
	const imageNote = item.images.length > 0 ? ` [${item.images.length} image${item.images.length === 1 ? "" : "s"}]` : "";
	return `${text || `[image ${laneLabel(item.lane)}]`}${imageNote}`;
}

function fitCell(content: string, width: number): string {
	const clipped = truncateToWidth(content, Math.max(0, width), "");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function nextRowKeyText(): string {
	const previous = keyText("app.message.dequeue");
	return /up$/i.test(previous) ? previous.replace(/up$/i, "down") : "alt+down";
}

function parseEditedLaneCommand(text: string, lane: QueueLane): EditedLaneCommand {
	const command: LaneCommand = lane === "steer" ? "/followup" : "/steer";
	const targetLane: QueueLane = lane === "steer" ? "followUp" : "steer";
	if (text !== command && !text.startsWith(`${command} `)) return { kind: "none" };
	const message = text.slice(command.length).trim();
	return message ? { kind: "message", targetLane, text: message } : { kind: "empty", command };
}

interface QueueModes {
	steer: QueueMode;
	followUp: QueueMode;
}

class QueueTimelineWidget implements Component {
	private readonly items: QueuedMessage<ImageContent>[];
	private readonly editingId: string | undefined;
	private readonly touchedIds: ReadonlySet<string>;
	private readonly renderInlineEditor: InlineEditorRenderer | undefined;
	private readonly paused: boolean;
	private readonly modes: QueueModes;
	private readonly theme: Theme;

	constructor(options: {
		items: QueuedMessage<ImageContent>[];
		editingId: string | undefined;
		touchedIds: ReadonlySet<string>;
		renderInlineEditor: InlineEditorRenderer | undefined;
		paused: boolean;
		modes: QueueModes;
		theme: Theme;
	}) {
		this.items = options.items;
		this.editingId = options.editingId;
		this.touchedIds = options.touchedIds;
		this.renderInlineEditor = options.renderInlineEditor;
		this.paused = options.paused;
		this.modes = options.modes;
		this.theme = options.theme;
	}

	render(width: number): string[] {
		const steering = this.items.filter((item) => item.lane === "steer");
		const followUps = this.items.filter((item) => item.lane === "followUp");
		if (width < 28) {
			const counts = [
				this.theme.fg("accent", `S${steering.length}`),
				this.theme.fg("warning", `F${followUps.length}`),
			].join(" ");
			const summary = `queued ${counts}${this.paused ? " paused" : ""}`;
			return [truncateToWidth(summary, width, "")];
		}

		const lines: string[] = [];
		if (steering.length > 0) this.renderLaneBox(lines, "steer", steering, width);
		if (followUps.length > 0) this.renderLaneBox(lines, "followUp", followUps, width);
		return lines;
	}

	private renderLaneBox(
		lines: string[],
		lane: QueueLane,
		items: QueuedMessage<ImageContent>[],
		width: number,
	): void {
		const color = laneColor(lane);
		const border = (text: string) => this.theme.fg(color, text);
		const laneTouched = items.some((item) => this.touchedIds.has(item.id));
		const laneHeld = this.modes[lane] === "all"
			? laneTouched
			: !!items[0] && this.touchedIds.has(items[0].id);
		const stage = lane === "steer" ? "next turn" : "after this run";
		const state = this.paused ? "paused" : laneHeld ? "held while editing" : stage;
		const name = lane === "steer" ? "steering queue" : "follow-ups";
		const fullTitle = ` ${name} (${items.length}) · ${state} `;
		const shortTitle = ` ${name} (${items.length}) `;
		const title = visibleWidth(fullTitle) + 2 <= width ? fullTitle : shortTitle;
		const topFill = "─".repeat(Math.max(0, width - visibleWidth(title) - 2));
		lines.push(border(`┌${title}${topFill}┐`));
		const cellWidth = width - 4;

		for (const item of items) this.renderItem(lines, item, items, cellWidth, border);

		const dequeue = keyText("app.message.dequeue");
		const followUp = keyText("app.message.followUp");
		const submit = keyText("tui.input.submit");
		const interrupt = keyText("app.interrupt");
		const selected = items.find((item) => item.id === this.editingId);
		const help = this.editingId
				? selected
					? selected.lane === "steer"
						? `${dequeue}/${nextRowKeyText()} move · ${submit} save · ${followUp} make follow-up · ${interrupt} cancel`
						: `${dequeue}/${nextRowKeyText()} move · ${submit} save · ${followUp} make steer · ${interrupt} cancel`
				: `${dequeue}/${nextRowKeyText()} move here · ${interrupt} cancel`
			: this.paused
				? `${submit} resume · ${dequeue} edit · ${interrupt} keep paused`
				: lane === "steer"
					? `${submit} steer/send next · ${dequeue} edit`
					: `${followUp} add follow-up · ${submit} send next · ${dequeue} edit`;
		lines.push(`${border("│")} ${fitCell(this.theme.fg("dim", help), cellWidth)} ${border("│")}`);
		lines.push(border(`└${"─".repeat(width - 2)}┘`));
	}

	private renderItem(
		lines: string[],
		item: QueuedMessage<ImageContent>,
		laneItems: QueuedMessage<ImageContent>[],
		cellWidth: number,
		border: (text: string) => string,
	): void {
		const selected = item.id === this.editingId;
		const head = laneItems[0]?.id === item.id;
		const laneTouched = laneItems.some((candidate) => this.touchedIds.has(candidate.id));
		const held = this.modes[item.lane] === "all" ? laneTouched : head && this.touchedIds.has(item.id);
		const armed = this.modes[item.lane] === "all" || head;
		const color = laneColor(item.lane);

		if (!selected) {
			const marker = held || (this.paused && armed)
				? "⏸"
				: item.lane === "followUp"
					? "○"
					: armed
						? "▶"
						: "»";
			const prefix = this.theme.fg(color, `${marker} `);
			const body = this.theme.fg("muted", compactText(item));
			lines.push(`${border("│")} ${fitCell(`${prefix}${body}`, cellWidth)} ${border("│")}`);
			return;
		}

		const prefixText = "› ";
		const prefixWidth = visibleWidth(prefixText);
		const editorWidth = Math.max(1, cellWidth - prefixWidth);
		const editorLines = this.renderInlineEditor?.(editorWidth) ?? [item.text];
		for (const [index, editorLine] of editorLines.entries()) {
			const prefix = index === 0 ? this.theme.fg(color, prefixText) : " ".repeat(prefixWidth);
			lines.push(`${border("│")} ${fitCell(`${prefix}${editorLine}`, cellWidth)} ${border("│")}`);
		}
		if (item.images.length > 0) {
			const imageNote = `${item.images.length} image${item.images.length === 1 ? "" : "s"}`;
			lines.push(`${border("│")} ${fitCell(this.theme.fg("dim", `${" ".repeat(prefixWidth)}↳ ${imageNote}`), cellWidth)} ${border("│")}`);
		}
	}

	invalidate(): void {}
}

function userContent(item: QueuedMessage<ImageContent>): string | (TextContent | ImageContent)[] {
	if (item.images.length === 0) return item.text;
	return [{ type: "text", text: item.text }, ...item.images];
}

export default function queueSteerExtension(pi: ExtensionAPI) {
	const queue = new DeliveryQueue<ImageContent>();
	let producerEpochId = randomUUID();
	let acceptedSteerSequence = 0;
	let editSession: QueueEditSession<ImageContent> | undefined;
	let activeContext: ExtensionContext | undefined;
	let renderInlineEditor: InlineEditorRenderer | undefined;
	let editorInstallTimer: ReturnType<typeof setTimeout> | undefined;
	let renderingInline = false;
	let paused = false;
	let settingsManager: SettingsManager | undefined;

	const queueModes = (): QueueModes => ({
		steer: settingsManager?.getSteeringMode() ?? "one-at-a-time",
		followUp: settingsManager?.getFollowUpMode() ?? "one-at-a-time",
	});

	const collectInputImages = (images: readonly ImageContent[] | undefined): ImageContent[] => {
		const collected = [...(images ?? [])];
		const request: QueueSteerAttachmentsEventV1 = {
			version: 1,
			attach(additionalImages) {
				collected.push(...additionalImages);
			},
		};
		pi.events.emit(QUEUE_STEER_ATTACHMENTS_EVENT, request);
		return collected;
	};

	const laneIsHeld = (lane: QueueLane): boolean => {
		if (!editSession) return false;
		const mode = queueModes()[lane];
		if (mode === "all") return editSession.touchesLane(queue, lane);
		const head = queue.peek(lane);
		return !!head && editSession.touches(head.id);
	};

	const renderQueue = (ctx: ExtensionContext): void => {
		activeContext = ctx;
		if (queue.length === 0) paused = false;
		if (ctx.mode !== "tui" || queue.length === 0) {
			ctx.ui.setWidget(WIDGET_ID, undefined);
			return;
		}

		const items = queue.snapshot().map((item) => {
			const draftText = editSession?.textFor(item.id);
			const draftImages = editSession?.imagesFor(item.id);
			return {
				...item,
				text: draftText ?? item.text,
				images: draftImages ?? item.images,
			};
		});
		const touchedIds = new Set(items.filter((item) => editSession?.touches(item.id)).map((item) => item.id));
		ctx.ui.setWidget(
			WIDGET_ID,
			(_tui, theme) => new QueueTimelineWidget({
				items,
				editingId: editSession?.selectedId,
				touchedIds,
				renderInlineEditor,
				paused,
				modes: queueModes(),
				theme,
			}),
		);
	};

	const takeLaneBatch = (lane: QueueLane): QueuedMessage<ImageContent>[] => {
		if (paused || queue.laneLength(lane) === 0 || laneIsHeld(lane)) return [];
		if (queueModes()[lane] === "all") return queue.shiftAll(lane);
		const item = queue.shift(lane);
		return item ? [item] : [];
	};

	const deliverBatchToNativeQueue = async (
		ctx: ExtensionContext,
		lane: QueueLane,
		items: QueuedMessage<ImageContent>[],
	): Promise<boolean> => {
		if (items.length === 0) return false;
		const pendingBefore = ctx.hasPendingMessages();
		renderQueue(ctx);
		try {
			for (const item of items) {
				pi.sendUserMessage(userContent(item), { deliverAs: lane });
			}
			// sendUserMessage is fire-and-forget. Keep the awaited boundary
			// handler open until async input preflight reaches Pi's native queue.
			for (let attempt = 0; attempt < 5 && !ctx.hasPendingMessages(); attempt += 1) {
				await new Promise<void>((resolve) => setTimeout(resolve, 0));
			}
			if (!pendingBefore && !ctx.hasPendingMessages()) {
				throw new Error("Pi did not accept the queued message at this delivery boundary");
			}
			return true;
		} catch (error) {
			queue.prependMany(items);
			renderQueue(ctx);
			ctx.ui.notify(
				`Could not deliver queued ${laneLabel(lane)}: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			return false;
		}
	};

	const dispatchLaneAtBoundary = async (ctx: ExtensionContext, lane: QueueLane): Promise<boolean> => {
		activeContext = ctx;
		const items = takeLaneBatch(lane);
		if (items.length === 0) {
			renderQueue(ctx);
			return false;
		}
		return deliverBatchToNativeQueue(ctx, lane, items);
	};

	const dispatchFromIdle = (ctx: ExtensionContext): boolean => {
		activeContext = ctx;
		const lane: QueueLane | undefined = queue.laneLength("steer") > 0
			? "steer"
			: queue.laneLength("followUp") > 0
				? "followUp"
				: undefined;
		if (!lane || laneIsHeld(lane)) {
			renderQueue(ctx);
			return false;
		}
		const next = queue.shift(lane);
		if (!next) return false;
		paused = false;
		renderQueue(ctx);
		try {
			pi.sendUserMessage(userContent(next));
			return true;
		} catch (error) {
			queue.prepend(next);
			renderQueue(ctx);
			ctx.ui.notify(
				`Could not send queued ${laneLabel(lane)}: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			return false;
		}
	};

	const finishEditing = (
		ctx: ExtensionContext,
		action: FinishEditAction,
		text = ctx.ui.getEditorText(),
		images?: readonly ImageContent[],
	): void => {
		const session = editSession;
		if (!session) return;
		let effectiveText = text;
		const selected = queue.get(session.selectedId);
		let targetLane: QueueLane | undefined;
		if (action === "toggleLane" && selected) {
			targetLane = selected.lane === "steer" ? "followUp" : "steer";
		}
		if (action === "save" && selected) {
			const command = parseEditedLaneCommand(text, selected.lane);
			if (command.kind === "empty") {
				ctx.ui.notify(`Usage: ${command.command} <message>`, "warning");
				return;
			}
			if (command.kind === "message") {
				targetLane = command.targetLane;
				effectiveText = command.text;
			}
		}
		const result = action === "cancel" ? undefined : session.commit(queue, effectiveText, images);
		if (targetLane) queue.moveToLane(session.selectedId, targetLane);

		editSession = undefined;
		ctx.ui.setEditorText(session.composerDraft);
		if (result?.removed) {
			ctx.ui.notify(`Removed ${result.removed} empty queued message${result.removed === 1 ? "" : "s"}`, "info");
		}
		renderQueue(ctx);

		// A pinned head may have let the agent settle while it was edited.
		if (ctx.isIdle() && !paused) dispatchFromIdle(ctx);
	};

	const selectQueueItem = (ctx: ExtensionContext, direction: "previous" | "next"): void => {
		activeContext = ctx;
		if (queue.length === 0) {
			ctx.ui.notify("No queued messages to edit", "info");
			return;
		}

		if (!editSession) {
			const composerDraft = ctx.ui.getEditorText();
			const selectedId = queue.mostRecentId();
			const selected = selectedId ? queue.get(selectedId) : undefined;
			if (!selected) return;
			editSession = new QueueEditSession(selected, composerDraft);
			ctx.ui.setEditorText(selected.text);
			renderQueue(ctx);
			return;
		}

		const currentText = ctx.ui.getEditorText();
		const selectedId = direction === "previous"
			? queue.previousId(editSession.selectedId)
			: queue.nextId(editSession.selectedId);
		const selected = selectedId ? queue.get(selectedId) : undefined;
		if (!selected) return;
		const selectedText = editSession.select(selected, currentText);
		ctx.ui.setEditorText(selectedText);
		renderQueue(ctx);
	};

	const installEditor = (ctx: ExtensionContext): void => {
		if (ctx.mode !== "tui") return;

		const previousFactory = ctx.ui.getEditorComponent();
		const features = editorFeatures(previousFactory);
		if (features.has(QUEUE_STEER_FEATURE)) return;

		const factory = ((tui, theme, keybindings) => {
			const editor = previousFactory?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
			const handleInput = editor.handleInput.bind(editor);
			const renderEditor = editor.render.bind(editor);
			const isShowingAutocomplete = (): boolean => {
				const candidate = editor as typeof editor & { isShowingAutocomplete?: () => boolean };
				return candidate.isShowingAutocomplete?.() ?? false;
			};

			renderInlineEditor = (width: number): string[] => {
				renderingInline = true;
				try {
					const candidate = editor as typeof editor & { getPaddingX?: () => number };
					const paddingX = candidate.getPaddingX?.() ?? 0;
					return extractInlineEditorLines(renderEditor(width), paddingX);
				} finally {
					renderingInline = false;
				}
			};

			editor.render = (width: number): string[] => {
				if (editSession && !renderingInline) return [];
				return renderEditor(width);
			};

			editor.handleInput = (data: string): void => {
				if (editSession) {
					if (keybindings.matches(data, "app.message.dequeue")) {
						selectQueueItem(ctx, "previous");
						return;
					}
					if (matchesKey(data, NEXT_ROW_KEY)) {
						selectQueueItem(ctx, "next");
						return;
					}
					if (keybindings.matches(data, "app.interrupt") && !isShowingAutocomplete()) {
						finishEditing(ctx, "cancel");
						return;
					}
					if (keybindings.matches(data, "app.message.followUp")) {
						finishEditing(ctx, "toggleLane");
						return;
					}
					if (keybindings.matches(data, "tui.input.submit") && !isShowingAutocomplete()) {
						finishEditing(ctx, "save");
						return;
					}
				}

				if (queue.length > 0 && keybindings.matches(data, "app.message.dequeue")) {
					selectQueueItem(ctx, "previous");
					return;
				}
				if (
					queue.length > 0 &&
					!ctx.isIdle() &&
					keybindings.matches(data, "app.interrupt") &&
					!isShowingAutocomplete()
				) {
					paused = true;
					ctx.abort();
					renderQueue(ctx);
					return;
				}
				if (
					queue.length > 0 &&
					!editor.getText().trim() &&
					keybindings.matches(data, "tui.input.submit")
				) {
					if (paused) {
						paused = false;
						if (ctx.isIdle()) dispatchFromIdle(ctx);
						else renderQueue(ctx);
						return;
					}
					}
				handleInput(data);
			};
			return editor;
		}) as ComposedEditorFactory;
		factory[EDITOR_FEATURES] = new Set([...features, QUEUE_STEER_FEATURE]);
		ctx.ui.setEditorComponent(factory);
		renderQueue(ctx);
	};

	const scheduleEditorInstall = (ctx: ExtensionContext): void => {
		if (editorInstallTimer) clearTimeout(editorInstallTimer);
		editorInstallTimer = setTimeout(() => {
			editorInstallTimer = undefined;
			installEditor(ctx);
		}, 0);
	};

	pi.registerCommand("followup", {
		description: "Queue a message for after the current run",
		handler: async (args, ctx) => {
			const text = args.trim();
			if (!text) {
				ctx.ui.notify("Usage: /followup <message>", "warning");
				return;
			}

			queue.enqueue("followUp", text, collectInputImages(undefined));
			paused = false;
			renderQueue(ctx);
			if (ctx.isIdle()) dispatchFromIdle(ctx);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		producerEpochId = randomUUID();
		acceptedSteerSequence = 0;
		activeContext = ctx;
		settingsManager = SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() });
		ctx.ui.setWidget(WIDGET_ID, undefined);
		installEditor(ctx);
		scheduleEditorInstall(ctx);
		renderQueue(ctx);
	});

	// Recompose after late-installed editor chrome, such as pi-session-hud.
	pi.on("agent_start", async (_event, ctx) => {
		installEditor(ctx);
		scheduleEditorInstall(ctx);
		await settingsManager?.reload();
		renderQueue(ctx);
	});

	pi.on("input", (event, ctx) => {
		if (event.source !== "interactive") return { action: "continue" };
		activeContext = ctx;

		// Late editor wrappers may submit through this event instead of the wrapped key handler.
		if (editSession) {
			const action = event.streamingBehavior === "followUp" ? "toggleLane" : "save";
			finishEditing(ctx, action, event.text, event.images);
			return { action: "handled" };
		}

		if (event.streamingBehavior === "steer") {
			queue.enqueue("steer", event.text, collectInputImages(event.images));
			acceptedSteerSequence += 1;
			const acceptedEvent: QueueSteerAcceptedEventV1 = {
				version: 1,
				producer: "pi-queue-steer",
				producerEpochId,
				sessionId: ctx.sessionManager.getSessionId(),
				sequence: acceptedSteerSequence,
			};
			pi.events.emit(QUEUE_STEER_ACCEPTED_EVENT, acceptedEvent);
			paused = false;
			renderQueue(ctx);
			return { action: "handled" };
		}

		if (event.streamingBehavior === "followUp") {
			queue.enqueue("followUp", event.text, collectInputImages(event.images));
			paused = false;
			renderQueue(ctx);
			return { action: "handled" };
		}

		return { action: "continue" };
	});

	pi.on("turn_end", async (event, ctx) => {
		activeContext = ctx;
		if (event.message.role === "assistant" && event.message.stopReason === "aborted") {
			if (queue.length > 0) paused = true;
			renderQueue(ctx);
			return;
		}
		if (paused) return;
		await dispatchLaneAtBoundary(ctx, "steer");
	});

	// Pi checks its native queues again after extension agent_end handlers.
	// Feeding one item (or an all-mode batch) here preserves native follow-up
	// continuation semantics without relinquishing later editable rows early.
	pi.on("agent_end", async (_event, ctx) => {
		activeContext = ctx;
		if (paused) return;
		if (queue.laneLength("steer") > 0) {
			await dispatchLaneAtBoundary(ctx, "steer");
			return;
		}
		await dispatchLaneAtBoundary(ctx, "followUp");
	});

	pi.on("agent_settled", (_event, ctx) => {
		activeContext = ctx;
		renderQueue(ctx);
		if (!paused && !editSession && queue.length > 0 && ctx.isIdle()) dispatchFromIdle(ctx);
	});

	pi.on("session_shutdown", () => {
		if (editorInstallTimer) clearTimeout(editorInstallTimer);
		if (activeContext?.hasUI) activeContext.ui.setWidget(WIDGET_ID, undefined);
		activeContext = undefined;
		renderInlineEditor = undefined;
		editorInstallTimer = undefined;
		editSession = undefined;
		settingsManager = undefined;
		paused = false;
		queue.clear();
	});
}
