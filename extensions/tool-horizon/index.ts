/**
 * tool-horizon
 *
 * Removes stale tool chatter from model context while preserving the human conversation.
 * The boundary is stationary until the user moves it.
 *
 * Architecture: payload-grounded.
 * The picker and the pruning logic both operate on the same live payload universe,
 * so the displayed reclaim estimate matches what can actually be removed.
 */

import { DynamicBorder, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text, visibleWidth, type SelectItem } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import Value from "typebox/value";
import { registerFilesTouchedTracking } from "../_shared/files-touched-core.ts";
import {
	TOOL_HORIZON_STATE_CUSTOM_TYPE,
  TOOL_HORIZON_STATUS_KEY as STATUS_KEY,
	TOOL_HORIZON_DISABLED_STATE,
	alignContextMessageEntriesExactly,
  applyPruningAtBoundary,
  buildContextMessageEntries,
	collectCompactedAwayMessages,
  collectPayloadDiagnostics,
	computeBoundarySafeRawIndices,
	computeBoundaryFingerprint,
	describeContextPayloadAlignmentError,
  estimatePayloadTokens,
	formatContextTokenSavings,
  getPayloadNarrativeLabel,
  hasThinkingBlock,
	loadToolHorizonStateFromEntries,
	matchContextMessageEntryPrefix,
  messagesMatchForContextAlignment,
	resolveBoundaryIndex,
  setToolHorizonRuntimeSnapshot,
	type ResolvedToolHorizonState,
	type ToolHorizonState,
  type EventMessage,
  type SessionEntry,
} from "./core.ts";
import {
	buildBoundaryPickerModel,
	type BoundaryPickerSelection,
	type ToolHorizonTreeNode,
	type ResolvedBoundaryMode,
} from "./boundary-model.ts";
import { BoundaryPickerCompatibilityError, showToolHorizonBoundaryPicker } from "./boundary-picker.ts";
import {
	DEFAULT_CHECKPOINT_USE_GUIDANCE,
	TOOL_HORIZON_CHECKPOINT_ABSENCE_STATE,
  TOOL_HORIZON_CHECKPOINT_MESSAGE_CUSTOM_TYPE,
  TOOL_HORIZON_CHECKPOINT_STATE_CUSTOM_TYPE,
  buildCheckpointState,
	loadCheckpointDecisionForLatestBoundary,
  removeCheckpointMessages,
	removeCheckpointMessagesAndRemapIndex,
  renderCheckpointMessage,
  type ToolHorizonCheckpointState,
} from "./provenance.ts";

type DynamicPickerItem = {
	value: string;
	label: string;
	description?: string;
};

export type ToolHorizonConfig = {
	checkpointUseGuidance: string;
	warnBeforeRestoreAllThresholdPercent: number;
	restoreAllAfterCompaction: boolean;
};

type PendingBoundaryCommit = {
	nextState: ResolvedToolHorizonState;
	checkpoint: ToolHorizonCheckpointState | null;
	capturedMessage: EventMessage;
	capturedRawIndex: number;
};

type RestoreAllWarningProjection = {
	thresholdPercent: number;
	currentUsedTokens: number;
	currentPercent: number;
	projectedUsedTokens: number;
	projectedPercent: number;
	restoredTokens: number;
	contextWindow: number;
};

const DEFAULT_WARN_BEFORE_RESTORE_ALL_THRESHOLD_PERCENT = 85;
const DEFAULT_RESTORE_ALL_AFTER_COMPACTION = true;
const CheckpointUseGuidanceSchema = Type.String({ minLength: 1, pattern: "\\S" });

function normalizePercent(value: unknown, defaultValue: number): number {
	if (typeof value !== "number" || Number.isNaN(value)) return defaultValue;
	return Math.max(0, Math.min(100, Math.floor(value)));
}

function loadConfig(): ToolHorizonConfig {
	try {
		const extensionDir = dirname(fileURLToPath(import.meta.url));
		const configPath = join(extensionDir, "config.json");
		const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as {
			checkpointUseGuidance?: unknown;
			warnBeforeRestoreAllThresholdPercent?: unknown;
			restoreAllAfterCompaction?: unknown;
		};
		return {
			checkpointUseGuidance:
				Value.Check(CheckpointUseGuidanceSchema, parsed.checkpointUseGuidance)
					? parsed.checkpointUseGuidance.trim()
					: DEFAULT_CHECKPOINT_USE_GUIDANCE,
			warnBeforeRestoreAllThresholdPercent: normalizePercent(
				parsed.warnBeforeRestoreAllThresholdPercent,
				DEFAULT_WARN_BEFORE_RESTORE_ALL_THRESHOLD_PERCENT,
			),
			restoreAllAfterCompaction:
				typeof parsed.restoreAllAfterCompaction === "boolean"
					? parsed.restoreAllAfterCompaction
					: DEFAULT_RESTORE_ALL_AFTER_COMPACTION,
		};
	} catch {
		return {
			checkpointUseGuidance: DEFAULT_CHECKPOINT_USE_GUIDANCE,
			warnBeforeRestoreAllThresholdPercent: DEFAULT_WARN_BEFORE_RESTORE_ALL_THRESHOLD_PERCENT,
			restoreAllAfterCompaction: DEFAULT_RESTORE_ALL_AFTER_COMPACTION,
		};
	}
}

const CONFIG = loadConfig();

async function showDynamicPicker(
	ctx: ExtensionContext,
	baseTitle: string,
	items: DynamicPickerItem[],
	helpText: string,
	descriptionTone: "muted" | "error" = "muted",
	initialValue?: string,
): Promise<string | null> {
	return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		const pageSize = Math.min(items.length, 12);
		const initialIndex = Math.max(
			0,
			initialValue ? items.findIndex((item) => item.value === initialValue) : 0,
		);
		const titleWidget = new Text(theme.fg("accent", theme.bold(baseTitle)), 1, 0);
		container.addChild(titleWidget);

		const listItems: SelectItem[] = items.map((item) => ({
			value: item.value,
			label: item.label,
			description: item.description ?? "",
		}));
		const primaryColumnWidth = Math.max(...listItems.map((item) => visibleWidth(item.label))) + 2;

		const list = new SelectList(listItems, pageSize, {
			selectedPrefix: (t) => theme.fg("accent", theme.bold(t)),
			selectedText: (t) => theme.fg("accent", theme.bold(t)),
			description: (t) => theme.fg(descriptionTone, t),
			scrollInfo: (t) => theme.fg("dim", t),
			noMatch: (t) => theme.fg("warning", t),
		}, {
			minPrimaryColumnWidth: primaryColumnWidth,
			maxPrimaryColumnWidth: primaryColumnWidth,
		});
		const listAny = list as unknown as { selectedIndex?: number };
		listAny.selectedIndex = initialIndex;
		list.onSelect = (item) => done(item.value);
		list.onCancel = () => done(null);
		container.addChild(list);
		container.addChild(new Text(theme.fg("dim", helpText), 1, 0));
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (data === "\u001b[C" || data === "\u001b[D") {
					const current = listAny.selectedIndex ?? 0;
					const delta = data === "\u001b[C" ? pageSize : -pageSize;
					listAny.selectedIndex = Math.max(0, Math.min(items.length - 1, current + delta));
				} else {
					list.handleInput(data);
				}
				tui.requestRender();
			},
		};
	});
}

function describeState(state: ToolHorizonState): string {
	if (!state.enabled) return "ALL TOOL HISTORY";
	if (state.boundaryMode === "pending") return "HORIZON PENDING";
	return "HORIZON ACTIVE";
}

function buildTitle(state: ToolHorizonState): string {
	return `Tool Horizon — ${describeState(state)}`;
}

function updateStatus(ctx: ExtensionContext, state: ToolHorizonState, messages?: EventMessage[] | null): void {
	if (!ctx.hasUI) return;
	if (!state.enabled) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	const theme = ctx.ui.theme;
	if (state.boundaryMode === "pending") {
		ctx.ui.setStatus(STATUS_KEY, theme.fg("accent", "horizon: pending"));
		return;
	}
	if (!messages || messages.length === 0) {
		ctx.ui.setStatus(STATUS_KEY, theme.fg("accent", "horizon: restoring"));
		return;
	}
	const resolvedBoundaryIndex = resolveBoundaryIndex(messages, state.boundaryFingerprint);
	const statusText =
		resolvedBoundaryIndex === null
			? "horizon: ?"
			: `horizon: ${resolvedBoundaryIndex + 1}/${messages.length}`;
	ctx.ui.setStatus(STATUS_KEY, theme.fg("accent", statusText));
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" = "info"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, level);
		return;
	}
	console.log(message);
}

function debugLog(message: string): void {
	if (process.env.TOOL_HORIZON_DEBUG) console.error(message);
}

const TOOL_HORIZON_WRITE_FAILURE_KEY = Symbol.for("pi.extensions.tool-horizon.write-failures.v1");

type SessionWriteFailureStore = WeakMap<object, string>;

function getSessionWriteFailureStore(): SessionWriteFailureStore {
	const globalStore = globalThis as typeof globalThis & {
		[TOOL_HORIZON_WRITE_FAILURE_KEY]?: SessionWriteFailureStore;
	};
	globalStore[TOOL_HORIZON_WRITE_FAILURE_KEY] ??= new WeakMap<object, string>();
	return globalStore[TOOL_HORIZON_WRITE_FAILURE_KEY];
}

function getSessionWriteFailure(ctx: ExtensionContext): string | null {
	return getSessionWriteFailureStore().get(ctx.sessionManager as object) ?? null;
}

function formatPercent(value: number): string {
	return `${value.toFixed(1)}%`;
}

/** Identity of a resolved boundary, used to bind one checkpoint to one pruning boundary */
function getBoundarySignature(candidate: ResolvedToolHorizonState): string {
	return JSON.stringify({
		boundaryMode: candidate.boundaryMode,
		boundaryFingerprint: candidate.boundaryFingerprint,
	});
}

function getActiveCheckpointForState(
	state: ToolHorizonState,
	checkpoint: ToolHorizonCheckpointState | null,
): ToolHorizonCheckpointState | null {
	if (!state.enabled || state.boundaryMode === "pending" || !checkpoint) return null;
	const boundarySignature = getBoundarySignature(state);
	if (
		checkpoint.boundaryMode !== state.boundaryMode ||
		checkpoint.boundarySignature !== boundarySignature
	) {
		return null;
	}
	return checkpoint;
}

function isAfterEntryBoundarySafe(
	payload: readonly EventMessage[],
	boundaryIndex: number,
	safeFromEntryIndices: Set<number> = computeBoundarySafeRawIndices(payload),
): boolean {
	const splitIndex = boundaryIndex + 1;
	return splitIndex >= payload.length || safeFromEntryIndices.has(splitIndex);
}

function isCheckpointMessage(message: EventMessage | null | undefined): boolean {
	return Boolean(message && message.role === "custom" && message.customType === TOOL_HORIZON_CHECKPOINT_MESSAGE_CUSTOM_TYPE);
}

export default function toolHorizonExtension(pi: ExtensionAPI, config: ToolHorizonConfig = CONFIG) {
	registerFilesTouchedTracking(pi);
	let state: ToolHorizonState = TOOL_HORIZON_DISABLED_STATE;
	let latestCheckpointState: ToolHorizonCheckpointState | null = null;
	let pendingBoundaryCommit: PendingBoundaryCommit | null = null;
	let pendingRestoreAllAfterCompaction = false;

	const getSessionId = (ctx: ExtensionContext): string | null => ctx.sessionManager.getSessionId();

	class PayloadCache {
		private cachedRawPayload: EventMessage[] | null = null;
		private cachedLivePayload: EventMessage[] | null = null;
		private cachedVisibleToRawIndices: number[] = [];
		private previousPayloadIds: Set<string> | null = null;
		private rawPayloadIsCanonical = false;
		private pickerRevision = 0;

		get isCanonical(): boolean {
			return this.rawPayloadIsCanonical;
		}

		get rawPayload(): EventMessage[] | null {
			return this.cachedRawPayload;
		}

		get livePayload(): EventMessage[] | null {
			return this.cachedLivePayload;
		}

		get visibleToRawIndices(): number[] {
			return this.cachedVisibleToRawIndices;
		}

		get revision(): number {
			return this.pickerRevision;
		}

		seedFromBranch(
			ctx: ExtensionContext,
			branchPayload: EventMessage[] | null,
			snapshotState: ToolHorizonState,
		): void {
			this.cachedRawPayload = branchPayload;
			this.rawPayloadIsCanonical = true;
			this.previousPayloadIds = null;
			this.reproject(ctx, snapshotState);
		}

		installCanonicalPayload(
			ctx: ExtensionContext,
			canonicalPayload: EventMessage[] | null,
			snapshotState: ToolHorizonState,
		): void {
			this.cachedRawPayload = canonicalPayload;
			this.reproject(ctx, snapshotState);
		}

		reprojectForState(ctx: ExtensionContext, snapshotState: ToolHorizonState): void {
			this.reproject(ctx, snapshotState);
		}

		appendSettledAssistant(
			ctx: ExtensionContext,
			message: EventMessage,
			snapshotState: ToolHorizonState,
		): void {
			const clonedMessage: EventMessage = {
				...message,
				content: Array.isArray(message.content) ? message.content.map((block) => ({ ...block })) : message.content,
			};
			this.cachedRawPayload = [...this.cachedRawPayload!, clonedMessage];
			this.reproject(ctx, snapshotState);
			if (this.cachedLivePayload) {
				this.previousPayloadIds = collectPayloadDiagnostics(this.cachedLivePayload).payloadToolIds;
			}
		}

		replaceFromContext(
			ctx: ExtensionContext,
			rawMessages: EventMessage[],
			filteredMessages: EventMessage[],
			keptRawIndices: number[],
			snapshotState: ToolHorizonState,
			resolvedBoundaryIndex: number | null,
			rawPayloadIsCanonical: boolean,
		): void {
			this.cachedRawPayload = rawMessages.map((message) => ({ ...message }));
			this.rawPayloadIsCanonical = rawPayloadIsCanonical;
			this.cachedVisibleToRawIndices = keptRawIndices;
			this.cachedLivePayload = filteredMessages.map((message) => ({ ...message }));
			this.pickerRevision += 1;
			setToolHorizonRuntimeSnapshot(getSessionId(ctx), {
				state: snapshotState,
				rawMessages: this.cachedRawPayload,
				filteredMessages: this.cachedLivePayload,
				filteredToRawIndices: [...this.cachedVisibleToRawIndices],
				resolvedBoundaryIndex,
			});
		}

		finishContextReplacementDiagnostics(): void {
			const currentDiagnostics = collectPayloadDiagnostics(this.cachedLivePayload!);
			if (this.previousPayloadIds) {
				let stable = 0;
				for (const id of this.previousPayloadIds) {
					if (currentDiagnostics.payloadToolIds.has(id)) stable += 1;
				}
				debugLog(
					`[tool-horizon.stability] prev=${this.previousPayloadIds.size} curr=${currentDiagnostics.payloadToolIds.size} stable=${stable}`,
				);
			}
			this.previousPayloadIds = currentDiagnostics.payloadToolIds;
		}

		showUnprunedForPendingCompactionRestore(ctx: ExtensionContext): void {
			if (!this.cachedRawPayload) return;
			this.cachedLivePayload = this.cachedRawPayload.map((message) => ({ ...message }));
			this.cachedVisibleToRawIndices = this.cachedRawPayload.map((_, index) => index);
			setToolHorizonRuntimeSnapshot(getSessionId(ctx), {
				state: TOOL_HORIZON_DISABLED_STATE,
				rawMessages: this.cachedRawPayload,
				filteredMessages: this.cachedLivePayload,
				filteredToRawIndices: [...this.cachedVisibleToRawIndices],
				resolvedBoundaryIndex: null,
			});
		}

		clear(ctx: ExtensionContext): void {
			this.cachedLivePayload = null;
			this.cachedRawPayload = null;
			this.cachedVisibleToRawIndices = [];
			this.previousPayloadIds = null;
			this.rawPayloadIsCanonical = false;
			this.pickerRevision += 1;
			setToolHorizonRuntimeSnapshot(getSessionId(ctx), null);
		}

		private reproject(ctx: ExtensionContext, snapshotState: ToolHorizonState): void {
			this.pickerRevision += 1;
			if (!this.cachedRawPayload) {
				this.cachedLivePayload = null;
				this.cachedVisibleToRawIndices = [];
				this.previousPayloadIds = null;
				setToolHorizonRuntimeSnapshot(getSessionId(ctx), null);
				return;
			}
			const checkpointFiltered = removeCheckpointMessages(this.cachedRawPayload);
			this.cachedRawPayload = checkpointFiltered.messages;
			let filteredMessages = this.cachedRawPayload;
			let keptRawIndices = this.cachedRawPayload.map((_, index) => index);
			const resolvedBoundaryIndex = snapshotState.enabled
				? resolveBoundaryIndex(this.cachedRawPayload, snapshotState.boundaryFingerprint)
				: null;
			if (snapshotState.enabled && resolvedBoundaryIndex !== null) {
				const pruneResult = applyPruningAtBoundary(
					this.cachedRawPayload,
					resolvedBoundaryIndex,
					snapshotState.boundaryMode,
				);
				filteredMessages = pruneResult.filteredMessages;
				keptRawIndices = pruneResult.keptRawIndices;
			}
			this.cachedVisibleToRawIndices = keptRawIndices;
			this.cachedLivePayload = filteredMessages.map((message) => ({ ...message }));
			setToolHorizonRuntimeSnapshot(getSessionId(ctx), {
				state: snapshotState,
				rawMessages: this.cachedRawPayload,
				filteredMessages: this.cachedLivePayload,
				filteredToRawIndices: [...this.cachedVisibleToRawIndices],
				resolvedBoundaryIndex,
			});
		}
	}

	const payloadCache = new PayloadCache();
	const createCheckpointMessage = (
		checkpoint: ToolHorizonCheckpointState,
		content: string,
	): EventMessage => ({
		role: "custom",
		customType: TOOL_HORIZON_CHECKPOINT_MESSAGE_CUSTOM_TYPE,
		content,
		display: false,
		details: checkpoint,
	} as EventMessage);

	const insertCheckpointAtBoundary = (
		filteredMessages: EventMessage[],
		keptRawIndices: number[],
		resolvedBoundaryIndex: number,
		boundaryMode: ResolvedBoundaryMode,
		checkpointMessage: EventMessage,
	): EventMessage[] => {
		const splitRawIndex = boundaryMode === "after-entry"
			? resolvedBoundaryIndex + 1
			: resolvedBoundaryIndex;
		const firstSuffixIndex = keptRawIndices.findIndex((rawIndex) => rawIndex >= splitRawIndex);
		const insertionIndex = firstSuffixIndex === -1 ? filteredMessages.length : firstSuffixIndex;
		return [
			...filteredMessages.slice(0, insertionIndex),
			checkpointMessage,
			...filteredMessages.slice(insertionIndex),
		];
	};
	/**
	 * Derive the provenance checkpoint for the prefix a boundary is about to hide
	*
	* The payload is passed in rather than read from module state so the checkpoint is always sliced
	* from the exact array the boundary index was validated against. Reading `cachedRawPayload` here
	* instead would make correctness depend on call ordering, because persisting a boundary reassigns
	* that cache through the checkpoint filter.
	*
	* Args:
		*     ctx (ExtensionContext): active extension context, for cwd resolution
		*     messages (readonly EventMessage[]): the payload the boundary index refers to
		*     boundaryState (ToolHorizonState): the boundary this checkpoint describes — the prospective state,
		*         not the one still installed, since the checkpoint is built before persistence
		*     resolvedRawIndex (number): boundary index into `messages`
		*
		* Returns:
		*     Checkpoint state for the hidden prefix, or null when nothing precedes the boundary
		*/
	const buildCheckpointFromRawBoundary = (
		ctx: ExtensionContext,
		messages: readonly EventMessage[] | null,
		boundaryState: ToolHorizonState,
		resolvedRawIndex: number,
	): ToolHorizonCheckpointState | null => {
		if (!messages || !boundaryState.enabled || boundaryState.boundaryMode === "pending") return null;
		const boundaryMode = boundaryState.boundaryMode;
		const boundarySignature = getBoundarySignature(boundaryState);
		const exclusiveEnd = boundaryMode === "after-entry" ? resolvedRawIndex + 1 : resolvedRawIndex;
		const leafId = ctx.sessionManager.getLeafId();
		return buildCheckpointState({
			messages: messages.slice(0, exclusiveEnd),
			compactedAwayMessages: collectCompactedAwayMessages(getBranchEntries(ctx, leafId), leafId),
			boundaryMode,
			boundarySignature,
			cwd: ctx.cwd,
		});
	};

	const getBranchEntries = (ctx: ExtensionContext, leafId?: string | null): SessionEntry[] => {
		if (leafId === null) return [];
		if (typeof leafId === "string") {
			return ctx.sessionManager.getBranch(leafId) as SessionEntry[];
		}
		return ctx.sessionManager.getBranch() as SessionEntry[];
	};

	const buildCanonicalContextEntries = (branchEntries: SessionEntry[], leafId: string | null) => (
		buildContextMessageEntries(branchEntries, leafId).filter((entry) => !isCheckpointMessage(entry.message))
	);

	const assertSessionWritable = (ctx: ExtensionContext): void => {
		const failure = getSessionWriteFailure(ctx);
		if (!failure) return;
		notify(ctx, failure, "warning");
		throw new Error(failure);
	};

	const requireIdleMutation = (ctx: ExtensionContext): boolean => {
		if (ctx.isIdle()) return true;
		notify(ctx, "tool-horizon: horizon changes require an idle agent", "warning");
		return false;
	};

	const appendExtensionEntry = (ctx: ExtensionContext, customType: string, data: unknown): void => {
		assertSessionWritable(ctx);
		const leafBefore = ctx.sessionManager.getLeafId();
		try {
			pi.appendEntry(customType, data);
		} catch (error) {
			const leafAfter = ctx.sessionManager.getLeafId();
			if (leafAfter !== leafBefore) {
				const message =
					"tool-horizon: session persistence failed after advancing the branch; Pi will shut down to prevent writes beneath an unpersisted entry";
				getSessionWriteFailureStore().set(ctx.sessionManager as object, message);
				notify(ctx, message, "warning");
				ctx.abort();
				ctx.shutdown();
			}
			throw error;
		}
	};

	const commitBoundary = (
		ctx: ExtensionContext,
		nextState: ToolHorizonState,
		checkpoint: ToolHorizonCheckpointState | null,
		canonicalPayload: EventMessage[] | null,
	): void => {
		assertSessionWritable(ctx);
		// Checkpoint state is written before the boundary state that activates it. Either intermediate tree entry
		// is therefore safe: the old boundary ignores the prospective checkpoint, while the new boundary is
		// installed only after its checkpoint (or explicit absence) has persisted.
		appendExtensionEntry(
			ctx,
			TOOL_HORIZON_CHECKPOINT_STATE_CUSTOM_TYPE,
			checkpoint ?? TOOL_HORIZON_CHECKPOINT_ABSENCE_STATE,
		);
		appendExtensionEntry(ctx, TOOL_HORIZON_STATE_CUSTOM_TYPE, nextState);
		latestCheckpointState = checkpoint;
		state = nextState;
		payloadCache.installCanonicalPayload(
			ctx,
			canonicalPayload,
			pendingRestoreAllAfterCompaction ? TOOL_HORIZON_DISABLED_STATE : state,
		);
		updateStatus(ctx, state, payloadCache.rawPayload);
	};

	const flushPendingBoundaryCommit = (ctx: ExtensionContext): boolean => {
		if (!pendingBoundaryCommit) return true;
		if (!requireIdleMutation(ctx)) return false;
		const pending = pendingBoundaryCommit;
		const leafId = ctx.sessionManager.getLeafId();
		const settledPayload = buildCanonicalContextEntries(getBranchEntries(ctx, leafId), leafId)
			.map((entry) => entry.message as EventMessage);
		const resolvedIndex = resolveBoundaryIndex(settledPayload, pending.nextState.boundaryFingerprint);
		const safeFromEntryIndices = computeBoundarySafeRawIndices(settledPayload);
		if (
			resolvedIndex === null ||
			!isAfterEntryBoundarySafe(settledPayload, pending.capturedRawIndex, safeFromEntryIndices) ||
			resolvedIndex !== pending.capturedRawIndex ||
			!settledPayload[resolvedIndex] ||
			!messagesMatchForContextAlignment(settledPayload[resolvedIndex], pending.capturedMessage)
		) {
			pendingBoundaryCommit = null;
			debugLog("[tool-horizon] pending capture invalidated before agent_settled; remaining pending");
			return true;
		}
		commitBoundary(ctx, pending.nextState, pending.checkpoint, settledPayload);
		pendingBoundaryCommit = null;
		// The transaction entries are excluded from the model payload, but reconstructing from the settled
		// branch guarantees every cache includes the completed assistant/tool suffix.
		reconstruct(ctx);
		return true;
	};

	const clearRuntimeState = (
		ctx: ExtensionContext,
		preservePendingRestoreAllAfterCompaction = false,
	): void => {
		payloadCache.clear(ctx);
		pendingBoundaryCommit = null;
		if (!preservePendingRestoreAllAfterCompaction) pendingRestoreAllAfterCompaction = false;
		if (ctx.hasUI) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
	};

	const reconstruct = (ctx: ExtensionContext, leafId?: string | null): void => {
		const failure = getSessionWriteFailure(ctx);
		if (failure) {
			clearRuntimeState(ctx);
			notify(ctx, failure, "warning");
			return;
		}
		const targetLeafId = leafId === undefined ? ctx.sessionManager.getLeafId() : leafId;
		const branchEntries = getBranchEntries(ctx, targetLeafId);
		state = loadToolHorizonStateFromEntries(branchEntries, config.restoreAllAfterCompaction);
		latestCheckpointState = null;
		if (state.enabled) {
			const decision = loadCheckpointDecisionForLatestBoundary(
				branchEntries,
				TOOL_HORIZON_STATE_CUSTOM_TYPE,
				ctx.cwd,
			);
			if (decision.kind === "present") {
				latestCheckpointState = getActiveCheckpointForState(state, decision.checkpoint);
				if (!latestCheckpointState) {
					state = TOOL_HORIZON_DISABLED_STATE;
					notify(ctx, "tool-horizon: checkpoint does not match the current horizon; all tool history was left visible", "warning");
				}
			} else if (decision.kind === "invalid") {
				state = TOOL_HORIZON_DISABLED_STATE;
				notify(
					ctx,
					"tool-horizon: horizon uses an unsupported saved layout; all tool history was left visible — run /tool-horizon pick",
					"warning",
				);
			}
		}
		// Rebuild the payload cache from the new branch so the boundary picker, status, and `here`
		// work immediately after navigation, fork, or session start without waiting for the next model
		// call. Pi's public projection produces the compaction-aware payload, while the stored boundary is
		// re-resolved structurally against the live payload at prune time.
		const contextEntries = buildCanonicalContextEntries(branchEntries, targetLeafId);
		const branchPayload = contextEntries.map((entry) => entry.message as EventMessage);
		payloadCache.seedFromBranch(
			ctx,
			branchPayload.length > 0 ? branchPayload : null,
			pendingRestoreAllAfterCompaction ? TOOL_HORIZON_DISABLED_STATE : state,
		);
		updateStatus(ctx, state, payloadCache.rawPayload);
	};

	const refreshCanonicalCacheFromBranchIfStale = (ctx: ExtensionContext): void => {
		const rawPayload = payloadCache.rawPayload;
		if (!rawPayload || !payloadCache.isCanonical) return;
		const leafId = ctx.sessionManager.getLeafId();
		const contextEntries = buildCanonicalContextEntries(getBranchEntries(ctx, leafId), leafId);
		const prefix = matchContextMessageEntryPrefix(contextEntries, rawPayload);
		if ("kind" in prefix || prefix.nextRawPayloadIndex !== rawPayload.length) return;
		const remainingRequired = contextEntries
			.slice(prefix.remainingContextEntryIndex)
			.filter((entry) => entry.sourceType !== "custom_message");
		if (remainingRequired.length === 0) return;
		const branchPayload = contextEntries.map((entry) => entry.message as EventMessage);
		payloadCache.seedFromBranch(
			ctx,
			branchPayload,
			pendingRestoreAllAfterCompaction ? TOOL_HORIZON_DISABLED_STATE : state,
		);
		updateStatus(ctx, state, payloadCache.rawPayload);
	};

	const reconcileTurnEndSnapshot = (ctx: ExtensionContext, message: EventMessage): void => {
		const rawPayload = payloadCache.rawPayload;
		if (!rawPayload) return;
		if (message.role !== "assistant") return;
		const leafId = ctx.sessionManager.getLeafId();
		const branchEntries = getBranchEntries(ctx, leafId);
		const contextEntries = buildCanonicalContextEntries(branchEntries, leafId);
		const prefix = matchContextMessageEntryPrefix(contextEntries, rawPayload);
		if ("kind" in prefix) {
			debugLog(`[tool-horizon.turn_end] skip: ${describeContextPayloadAlignmentError(prefix)}`);
			return;
		}
		if (prefix.nextRawPayloadIndex !== rawPayload.length) {
			debugLog(
				`[tool-horizon.turn_end] skip: matched=${prefix.nextRawPayloadIndex} cached=${rawPayload.length}`,
			);
			return;
		}
		const remainingEntries = contextEntries.slice(prefix.remainingContextEntryIndex);
		const remainingRequired = remainingEntries.filter((entry) => entry.sourceType !== "custom_message");
		if (remainingRequired.length !== 1) {
			debugLog(
				`[tool-horizon.turn_end] skip: remainingRequired=${remainingRequired.length} remainingTotal=${remainingEntries.length}`,
			);
			return;
		}
		const [finalRequired] = remainingRequired;
		if (finalRequired.message.role !== "assistant" || !messagesMatchForContextAlignment(finalRequired.message, message)) {
			debugLog("[tool-horizon.turn_end] skip: final assistant mismatch");
			return;
		}
		const snapshotState = pendingRestoreAllAfterCompaction ? TOOL_HORIZON_DISABLED_STATE : state;
		payloadCache.appendSettledAssistant(ctx, message, snapshotState);
		updateStatus(ctx, snapshotState, payloadCache.rawPayload);
	};

	const persist = (ctx: ExtensionContext, nextState: ToolHorizonState): void => {
		appendExtensionEntry(ctx, TOOL_HORIZON_STATE_CUSTOM_TYPE, nextState);
		state = nextState;
		payloadCache.reprojectForState(
			ctx,
			pendingRestoreAllAfterCompaction ? TOOL_HORIZON_DISABLED_STATE : state,
		);
		updateStatus(ctx, state, payloadCache.rawPayload);
	};

	const flushPendingRestoreAllAfterCompaction = (ctx: ExtensionContext): boolean => {
		if (!pendingRestoreAllAfterCompaction) return true;
		if (!ctx.isIdle()) return false;
		persist(ctx, TOOL_HORIZON_DISABLED_STATE);
		pendingRestoreAllAfterCompaction = false;
		notify(ctx, "tool-horizon: restored all tool history after compaction", "info");
		return true;
	};

	const setBoundaryAfterCurrentPayload = (ctx: ExtensionContext): boolean => {
		if (!requireIdleMutation(ctx) || !flushPendingBoundaryCommit(ctx)) return false;
		assertSessionWritable(ctx);
		refreshCanonicalCacheFromBranchIfStale(ctx);
		const livePayload = payloadCache.livePayload;
		const lastVisibleIndex = livePayload
			? (() => {
				for (let i = livePayload.length - 1; i >= 0; i--) {
					if (!isCheckpointMessage(livePayload[i])) return i;
				}
				return -1;
			})()
			: -1;
		const candidateRawIndex = lastVisibleIndex >= 0 ? payloadCache.visibleToRawIndices[lastVisibleIndex] : undefined;
		const payload = payloadCache.rawPayload;
		const resolvedTail =
			typeof candidateRawIndex === "number" && payload && payload[candidateRawIndex]
				? { rawIndex: candidateRawIndex, message: payload[candidateRawIndex] }
				: null;
		if (!resolvedTail || !livePayload || !payload) {
			const nextState: ToolHorizonState = {
				enabled: true,
				boundaryMode: "pending",
				boundaryFingerprint: null,
			};
			commitBoundary(ctx, nextState, null, payload);
			return true;
		}
		const canonical = removeCheckpointMessagesAndRemapIndex(payload, resolvedTail.rawIndex);
		if (!canonical || !canonical.messages[canonical.rawIndex]) return false;
		const boundaryFingerprint = computeBoundaryFingerprint(canonical.messages[canonical.rawIndex], canonical.rawIndex);
		if (
			!isAfterEntryBoundarySafe(canonical.messages, canonical.rawIndex) ||
			resolveBoundaryIndex(canonical.messages, boundaryFingerprint) !== canonical.rawIndex
		) {
			const pendingState: ToolHorizonState = {
				enabled: true,
				boundaryMode: "pending",
				boundaryFingerprint: null,
			};
			commitBoundary(ctx, pendingState, null, canonical.messages);
			return true;
		}
		const nextState: ResolvedToolHorizonState = {
			enabled: true,
			boundaryMode: "after-entry",
			boundaryFingerprint,
		};
		const checkpoint = buildCheckpointFromRawBoundary(ctx, canonical.messages, nextState, canonical.rawIndex);
		commitBoundary(ctx, nextState, checkpoint, canonical.messages);
		return true;
	};

	/**
	* Set the pruning boundary at a raw payload index chosen in the session-tree picker
	*
	* The picker resolves tree rows straight to raw payload indices, so no visible-to-raw remap is
	* involved here — remapping an already-raw index would silently land on the wrong message.
	*/
	const setBoundaryFromRawPayloadIndex = (ctx: ExtensionContext, rawPayloadIndex: number): boolean => {
		if (!requireIdleMutation(ctx) || !flushPendingBoundaryCommit(ctx)) return false;
		const payload = payloadCache.rawPayload;
		if (!payload || !payload[rawPayloadIndex]) {
			notify(ctx, "tool-horizon: selected entry is no longer present in the cached model context", "warning");
			return false;
		}
		const canonical = removeCheckpointMessagesAndRemapIndex(payload, rawPayloadIndex);
		if (!canonical || !canonical.messages[canonical.rawIndex]) {
			notify(ctx, "tool-horizon: this checkpoint entry cannot begin a horizon", "warning");
			return false;
		}
		const nextState: ToolHorizonState = {
			enabled: true,
			boundaryMode: "from-entry",
			boundaryFingerprint: computeBoundaryFingerprint(canonical.messages[canonical.rawIndex], canonical.rawIndex),
		};
		const checkpoint = buildCheckpointFromRawBoundary(ctx, canonical.messages, nextState, canonical.rawIndex);
		commitBoundary(ctx, nextState, checkpoint, canonical.messages);
		return true;
	};

	const getRestoreAllWarningProjection = (ctx: ExtensionContext): RestoreAllWarningProjection | null => {
		const rawPayload = payloadCache.rawPayload;
		const livePayload = payloadCache.livePayload;
		if (!state.enabled || !rawPayload || !livePayload) return null;
		const contextWindow = ctx.model.contextWindow;
		if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) return null;
		const usage = ctx.getContextUsage();
		const currentUsedTokens = usage?.tokens;
		if (typeof currentUsedTokens !== "number" || !Number.isFinite(currentUsedTokens) || currentUsedTokens < 0) {
			return null;
		}
		const restoredTokens = Math.max(0, estimatePayloadTokens(rawPayload) - estimatePayloadTokens(livePayload));
		if (restoredTokens <= 0) return null;
		const projectedUsedTokens = currentUsedTokens + restoredTokens;
		const currentPercent = (currentUsedTokens / contextWindow) * 100;
		const projectedPercent = (projectedUsedTokens / contextWindow) * 100;
		if (projectedPercent < config.warnBeforeRestoreAllThresholdPercent) return null;
		return {
			thresholdPercent: config.warnBeforeRestoreAllThresholdPercent,
			currentUsedTokens,
			currentPercent,
			projectedUsedTokens,
			projectedPercent,
			restoredTokens,
			contextWindow,
		};
	};

	const confirmRestoreAllToolHistoryIfNeeded = async (ctx: ExtensionContext): Promise<boolean> => {
		const projection = getRestoreAllWarningProjection(ctx);
		if (!projection) return true;
		const restoredContextTokens = formatContextTokenSavings(projection.restoredTokens).slice(1);
		const description =
			`${formatPercent(projection.currentPercent)} → ${formatPercent(projection.projectedPercent)} used ` +
			`(+${restoredContextTokens} restored, threshold ${projection.thresholdPercent}%)`;
		if (!ctx.hasUI) {
			notify(ctx, `tool-horizon: restoring all tool history is projected to raise context usage to ${description}`, "warning");
			return true;
		}
		const choice = await showDynamicPicker(
			ctx,
			"Restore all tool history?",
			[
				{
					value: "all",
					label: "Restore all tool history",
					description,
				},
				{
					value: "cancel",
					label: "Cancel",
					description: "Keep the current horizon",
				},
			],
			"Enter confirm   Esc cancel",
			"error",
			"cancel",
		);
		return choice === "all";
	};

	const restoreAllToolHistory = (ctx: ExtensionContext): boolean => {
		if (!requireIdleMutation(ctx) || !flushPendingBoundaryCommit(ctx)) return false;
		assertSessionWritable(ctx);
		appendExtensionEntry(ctx, TOOL_HORIZON_STATE_CUSTOM_TYPE, TOOL_HORIZON_DISABLED_STATE);
		state = TOOL_HORIZON_DISABLED_STATE;
		// Rebuild from the branch so an earlier context transform cannot leave the picker aligned against
		// a filtered payload. This is the same canonical cache universe installed on session start.
		reconstruct(ctx);
		return true;
	};

	const restoreAllToolHistoryWithWarning = async (ctx: ExtensionContext): Promise<boolean> => {
		if (!await confirmRestoreAllToolHistoryIfNeeded(ctx)) return false;
		if (!restoreAllToolHistory(ctx)) return false;
		notify(ctx, "tool-horizon: restored all tool history", "info");
		return true;
	};

	/**
	* Open the session-tree boundary picker and commit the chosen boundary
	*
	* The tree is a browsing surface only. Every row is resolved to an exact raw payload index by
	* aligning freshly rebuilt branch context entries against the cached raw payload; if that alignment
	* is not exact, the picker refuses to open rather than guessing at a boundary.
	*
	* Args:
	*     ctx (ExtensionContext): active extension context
	*
	* Returns:
	*     True when a boundary was committed, false on refusal or cancellation
	*/
	const pickBoundaryFromSessionTree = async (ctx: ExtensionContext): Promise<boolean> => {
		if (!requireIdleMutation(ctx) || !flushPendingBoundaryCommit(ctx)) return false;
		assertSessionWritable(ctx);
		if (!ctx.hasUI) {
			notify(ctx, "tool-horizon: pick requires an interactive UI", "warning");
			return false;
		}
		refreshCanonicalCacheFromBranchIfStale(ctx);
		const rawPayload = payloadCache.rawPayload;
		if (!rawPayload || rawPayload.length === 0) {
			notify(ctx, "tool-horizon: no cached model context for this branch yet", "warning");
			return false;
		}

		// Capture everything the model is derived from before the first await, so a turn completing while
		// the overlay is open cannot silently change the basis of the user's selection.
		const openedAtRevision = payloadCache.revision;
		const openedSessionId = getSessionId(ctx);
		const openedLeafId = ctx.sessionManager.getLeafId();
		const rawSnapshot = [...rawPayload];
		const branchEntries = getBranchEntries(ctx, openedLeafId);
		const fullTree = ctx.sessionManager.getTree() as unknown as ToolHorizonTreeNode[];
		if (fullTree.length === 0) {
			notify(ctx, "tool-horizon: no session entries to pick from", "warning");
			return false;
		}

		const contextEntries = buildCanonicalContextEntries(branchEntries, openedLeafId);
		const alignment = alignContextMessageEntriesExactly(contextEntries, rawSnapshot);
		if (!(alignment instanceof Map)) {
			debugLog(`[tool-horizon.pick] alignment failed: ${describeContextPayloadAlignmentError(alignment)}`);
			notify(
				ctx,
				"tool-horizon: the session tree no longer matches the cached model context, so no horizon can be resolved",
				"warning",
			);
			return false;
		}

		const currentBoundaryRawIndex = state.enabled ? resolveBoundaryIndex(rawSnapshot, state.boundaryFingerprint) : null;
		const currentBoundaryMode: ResolvedBoundaryMode | null =
			state.enabled && state.boundaryMode !== "pending" ? state.boundaryMode : null;

		const model = buildBoundaryPickerModel({
			fullTree,
			currentBranchEntryIds: new Set(
				branchEntries
					.map((entry) => (entry as { id?: unknown }).id)
					.filter((id): id is string => typeof id === "string"),
			),
			entryIdToRawPayloadIndex: alignment,
			rawPayload: rawSnapshot,
			currentBoundaryRawPayloadIndex: currentBoundaryRawIndex,
			currentBoundaryMode,
		});
		if ("kind" in model) {
			notify(
				ctx,
				model.kind === "empty-tree"
					? "tool-horizon: no session entries to pick from"
					: "tool-horizon: no entry on this branch can safely begin the current tool horizon",
				"warning",
			);
			return false;
		}

		let selection: BoundaryPickerSelection | null;
		try {
			selection = await showToolHorizonBoundaryPicker(ctx, {
				fullTree,
				currentLeafId: openedLeafId,
				model,
			});
		} catch (error) {
			if (error instanceof BoundaryPickerCompatibilityError) {
				notify(ctx, error.message, "warning");
				return false;
			}
			throw error;
		}
		if (!selection) return false;

		if (
			payloadCache.revision !== openedAtRevision ||
			getSessionId(ctx) !== openedSessionId ||
			ctx.sessionManager.getLeafId() !== openedLeafId
		) {
			debugLog(`[tool-horizon.pick] stale selection: opened=${openedAtRevision} current=${payloadCache.revision}`);
			notify(ctx, "tool-horizon: context changed while the picker was open — horizon not set", "warning");
			return false;
		}

		if (!setBoundaryFromRawPayloadIndex(ctx, selection.rawPayloadIndex)) return false;
		const tokenInfo = selection.reclaimedTokens > 0
			? ` (${formatContextTokenSavings(selection.reclaimedTokens)})`
			: "";
		notify(ctx, `tool-horizon: horizon set from session tree${tokenInfo}`, "info");
		return true;
	};

	const showMenu = async (ctx: ExtensionContext): Promise<void> => {
		if (!ctx.hasUI) {
			notify(ctx, `tool-horizon: ${describeState(state)}. Usage: /tool-horizon [here|pick|all]`, "info");
			return;
		}

		const menuItems: DynamicPickerItem[] = [
			{ value: "here", label: "Set horizon here", description: "(/tool-horizon here)" },
			{ value: "pick", label: "Choose horizon from session tree", description: "(/tool-horizon pick)" },
		];
		if (state.enabled) {
			menuItems.push({ value: "all", label: "Restore all tool history", description: "(/tool-horizon all)" });
		}
		menuItems.push({ value: "cancel", label: "Cancel", description: "" });

		const choice = await showDynamicPicker(
			ctx,
			buildTitle(state),
			menuItems,
			"↑/↓ navigate   Enter select   Esc cancel",
			"muted",
		);
		if (!choice || choice === "cancel") return;
		if (choice === "here") {
			if (setBoundaryAfterCurrentPayload(ctx)) {
				notify(
					ctx,
					state.boundaryMode === "pending"
						? "tool-horizon: horizon pending — will activate on the next model call"
						: "tool-horizon: horizon set here",
					"info",
				);
			}
			return;
		}
		if (choice === "pick") {
			await pickBoundaryFromSessionTree(ctx);
			return;
		}
		if (choice === "all") {
			await restoreAllToolHistoryWithWarning(ctx);
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		pendingRestoreAllAfterCompaction = false;
		reconstruct(ctx);
	});

	pi.on("session_before_fork", async (_event, ctx) => {
		clearRuntimeState(ctx, true);
	});

	pi.on("session_before_tree", async (_event, ctx) => {
		clearRuntimeState(ctx, true);
	});

	pi.on("session_tree", async (event, ctx) => {
		pendingRestoreAllAfterCompaction = false;
		reconstruct(ctx, event.newLeafId);
	});

	pi.on("session_before_switch", async (_event, ctx) => {
		clearRuntimeState(ctx, true);
	});

	pi.on("session_compact", async (_event, ctx) => {
		// A captured pending index belongs to the pre-compaction payload universe.
		pendingBoundaryCommit = null;
		const wasEnabledBeforeCompaction = state.enabled;
		// Upstream has already replaced the agent payload with its compaction-aware projection before
		// this event fires. Reconstruct unconditionally so every cache moves to that same universe.
		reconstruct(ctx);
		if (!config.restoreAllAfterCompaction || !wasEnabledBeforeCompaction || getSessionWriteFailure(ctx)) return;

		// Automatic compaction may occur inside an active run, where extension state writes are unsafe.
		// Suppress pruning and checkpoint injection immediately, then persist the disabled state once the run settles.
		pendingRestoreAllAfterCompaction = true;
		payloadCache.showUnprunedForPendingCompactionRestore(ctx);
		updateStatus(ctx, TOOL_HORIZON_DISABLED_STATE, payloadCache.rawPayload);
		flushPendingRestoreAllAfterCompaction(ctx);
	});

	pi.on("turn_end", async (event, ctx) => {
		reconcileTurnEndSnapshot(ctx, event.message as EventMessage);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (!flushPendingRestoreAllAfterCompaction(ctx)) return;
		flushPendingBoundaryCommit(ctx);
	});

	pi.on("input", (_event, ctx) => {
		const failure = getSessionWriteFailure(ctx);
		if (!failure) return { action: "continue" as const };
		notify(ctx, failure, "warning");
		return { action: "handled" as const };
	});

	pi.registerCommand("tool-horizon", {
		description: "Control how much historical tool activity remains in model context. Usage: /tool-horizon [here|pick|all]",
		handler: async (args, ctx) => {
			if (pendingRestoreAllAfterCompaction && !ctx.isIdle()) {
				notify(
					ctx,
					"tool-horizon: automatic history restoration is pending; command not applied during the active agent run",
					"warning",
				);
				return;
			}
			if (!flushPendingRestoreAllAfterCompaction(ctx)) return;
			const trimmed = args.trim();
			if (!trimmed) {
				await showMenu(ctx);
				return;
			}
			if (trimmed === "here") {
				if (setBoundaryAfterCurrentPayload(ctx)) {
					notify(
						ctx,
						state.boundaryMode === "pending"
							? "tool-horizon: horizon pending — will activate on the next model call"
							: "tool-horizon: horizon set here",
						"info",
					);
				}
				return;
			}
			if (trimmed === "pick") {
				await pickBoundaryFromSessionTree(ctx);
				return;
			}
			if (trimmed === "all") {
				await restoreAllToolHistoryWithWarning(ctx);
				return;
			}
			notify(ctx, "Usage: /tool-horizon [here|pick|all]", "warning");
		},
	});

	pi.on("context", async (event, ctx) => {
		const writeFailure = getSessionWriteFailure(ctx);
		if (writeFailure) throw new Error(writeFailure);
		const checkpointFiltered = removeCheckpointMessages(event.messages as EventMessage[]);
		const rawMessages = checkpointFiltered.messages;
		const leafId = ctx.sessionManager.getLeafId();
		const canonicalContextEntries = buildCanonicalContextEntries(getBranchEntries(ctx, leafId), leafId);
		const rawPayloadIsCanonical = alignContextMessageEntriesExactly(canonicalContextEntries, rawMessages) instanceof Map;
		let changed = checkpointFiltered.changed;
		const effectiveState = pendingRestoreAllAfterCompaction ? TOOL_HORIZON_DISABLED_STATE : state;
		if (effectiveState.enabled && effectiveState.boundaryMode === "pending") {
			let materializeIndex = -1;
			const safeFromEntryIndices = computeBoundarySafeRawIndices(rawMessages);
			for (let i = rawMessages.length - 1; i >= 0; i--) {
				if (
					getPayloadNarrativeLabel(rawMessages[i]) !== null &&
					isAfterEntryBoundarySafe(rawMessages, i, safeFromEntryIndices)
				) {
					materializeIndex = i;
					break;
				}
			}
			const materializeMessage = materializeIndex >= 0 ? rawMessages[materializeIndex] : null;
			if (materializeMessage && !pendingBoundaryCommit) {
				const nextState: ResolvedToolHorizonState = {
					enabled: true,
					boundaryMode: "after-entry",
					boundaryFingerprint: computeBoundaryFingerprint(materializeMessage, materializeIndex),
				};
				const leafId = ctx.sessionManager.getLeafId();
				const checkpoint = buildCheckpointState({
					messages: rawMessages.slice(0, materializeIndex + 1),
					compactedAwayMessages: collectCompactedAwayMessages(getBranchEntries(ctx, leafId), leafId),
					boundaryMode: "after-entry",
					boundarySignature: getBoundarySignature(nextState),
					cwd: ctx.cwd,
				});
				pendingBoundaryCommit = {
					nextState,
					checkpoint,
					capturedMessage: materializeMessage,
					capturedRawIndex: materializeIndex,
				};
				debugLog(`[tool-horizon] pending captured at index ${materializeIndex}; commit deferred until agent_settled`);
			} else if (!materializeMessage) {
				debugLog("[tool-horizon] pending: no stable live payload narrative entry yet, staying pending");
			}
		}
		let filteredMessages = rawMessages;
		let keptRawIndices = rawMessages.map((_, index) => index);
		let actualReclaimedTokens = 0;
		const resolvedBoundaryIndex = effectiveState.enabled
			? resolveBoundaryIndex(rawMessages, effectiveState.boundaryFingerprint)
			: null;

		if (effectiveState.enabled) {
			if (resolvedBoundaryIndex === null) {
				if (effectiveState.boundaryMode !== "pending") {
					debugLog("[tool-horizon] boundary not found in live payload — skipping pruning (likely compacted away)");
				}
			} else {
				const pruneResult = applyPruningAtBoundary(
					rawMessages,
					resolvedBoundaryIndex,
					effectiveState.boundaryMode,
				);
				filteredMessages = pruneResult.filteredMessages;
				keptRawIndices = pruneResult.keptRawIndices;
				changed = pruneResult.changed || changed;
				actualReclaimedTokens = pruneResult.reclaimedTokens;
				debugLog(
					`[tool-horizon.debug] mode=${effectiveState.boundaryMode} resolvedBoundary=${resolvedBoundaryIndex} payloadPruneIds=${pruneResult.payloadPruneIds.size} protected=${pruneResult.protectedIds.size} before≈${estimatePayloadTokens(rawMessages)} after≈${estimatePayloadTokens(filteredMessages)} reclaimed≈${actualReclaimedTokens} changed=${changed}`,
				);
				// Invariant canary: no modified assistant message may retain a signed thinking block after
				// pruning. This should always be zero; a nonzero count means the payload will be rejected.
				let modifiedAssistants = 0;
				let thinkingLeaks = 0;
				for (let fi = 0; fi < filteredMessages.length; fi++) {
					const fm = filteredMessages[fi];
					if (fm.role !== "assistant" || !Array.isArray(fm.content)) continue;
					const rawIndex = keptRawIndices[fi];
					if (rawIndex < 0 || rawIndex >= rawMessages.length) continue;
					const rm = rawMessages[rawIndex];
					if (!Array.isArray(rm.content) || fm.content.length === rm.content.length) continue;
					modifiedAssistants++;
					if (hasThinkingBlock(fm.content)) thinkingLeaks++;
				}
				if (thinkingLeaks > 0) {
					console.warn(
						`[tool-horizon] WARNING: ${thinkingLeaks}/${modifiedAssistants} pruned assistant message(s) still carry a signed thinking block; Anthropic will reject this payload (pruning regression).`,
					);
				} else {
					debugLog(`[tool-horizon.invariant] modifiedAssistants=${modifiedAssistants} verdict=CLEAN`);
				}
			}
		}

		const activeCheckpoint = getActiveCheckpointForState(effectiveState, latestCheckpointState);
		const outgoingMessages = (() => {
			if (!activeCheckpoint) return filteredMessages;
			const checkpointMessage = createCheckpointMessage(
				activeCheckpoint,
				renderCheckpointMessage(activeCheckpoint, config.checkpointUseGuidance),
			);
			if (resolvedBoundaryIndex === null) return [...filteredMessages, checkpointMessage];
			return insertCheckpointAtBoundary(
				filteredMessages,
				keptRawIndices,
				resolvedBoundaryIndex,
				activeCheckpoint.boundaryMode,
				checkpointMessage,
			);
		})();
		if (activeCheckpoint) changed = true;

		payloadCache.replaceFromContext(
			ctx,
			rawMessages,
			filteredMessages,
			keptRawIndices,
			effectiveState,
			resolvedBoundaryIndex,
			rawPayloadIsCanonical,
		);
		updateStatus(ctx, effectiveState, payloadCache.rawPayload);
		payloadCache.finishContextReplacementDiagnostics();

		return changed ? { messages: outgoingMessages } : undefined;
	});
}
