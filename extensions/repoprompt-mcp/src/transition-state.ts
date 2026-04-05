import type { AutoSelectionEntryData, RpBinding } from "./types.js";

export type PendingTransitionRetryMode = "startup" | "transition";

export interface PendingTransitionTargetIdentity {
  sessionFile: string | null;
  sessionId: string;
}

export interface PendingTransitionSelectionState {
  retryMode: PendingTransitionRetryMode | null;
  sourceState: AutoSelectionEntryData | null;
  targetIdentity: PendingTransitionTargetIdentity | null;
  targetBinding: RpBinding | null;
  targetState: AutoSelectionEntryData | null;
}

let pendingTransitionSelectionState: PendingTransitionSelectionState | null = null;

function cloneBinding(binding: RpBinding | null): RpBinding | null {
  if (!binding) {
    return null;
  }

  return {
    windowId: binding.windowId,
    tab: binding.tab,
    workspace: binding.workspace,
    autoDetected: binding.autoDetected,
  };
}

function cloneIdentity(identity: PendingTransitionTargetIdentity | null): PendingTransitionTargetIdentity | null {
  if (!identity) {
    return null;
  }

  return {
    sessionFile: identity.sessionFile,
    sessionId: identity.sessionId,
  };
}

function cloneRange(range: { start_line: number; end_line: number }) {
  return {
    start_line: range.start_line,
    end_line: range.end_line,
  };
}

function cloneState(state: AutoSelectionEntryData | null): AutoSelectionEntryData | null {
  if (!state) {
    return null;
  }

  return {
    windowId: state.windowId,
    tab: state.tab,
    workspace: state.workspace,
    fullPaths: [...state.fullPaths],
    slicePaths: state.slicePaths.map((slice) => ({
      path: slice.path,
      ranges: slice.ranges.map(cloneRange),
    })),
  };
}

function clonePendingState(
  state: PendingTransitionSelectionState | null
): PendingTransitionSelectionState | null {
  if (!state) {
    return null;
  }

  return {
    retryMode: state.retryMode,
    sourceState: cloneState(state.sourceState),
    targetIdentity: cloneIdentity(state.targetIdentity),
    targetBinding: cloneBinding(state.targetBinding),
    targetState: cloneState(state.targetState),
  };
}

function setPendingState(state: PendingTransitionSelectionState | null): void {
  const cloned = clonePendingState(state);
  if (!cloned) {
    pendingTransitionSelectionState = null;
    return;
  }

  if (!cloned.sourceState && !cloned.targetBinding && !cloned.targetState) {
    pendingTransitionSelectionState = null;
    return;
  }

  pendingTransitionSelectionState = cloned;
}

export function getPendingTransitionState(): PendingTransitionSelectionState | null {
  return clonePendingState(pendingTransitionSelectionState);
}

export function getPendingTransitionSelectionState(): AutoSelectionEntryData | null {
  return cloneState(pendingTransitionSelectionState?.sourceState ?? null);
}

export function setPendingTransitionSelectionState(
  state: AutoSelectionEntryData | null,
  retryMode: PendingTransitionRetryMode | null = state
    ? (pendingTransitionSelectionState?.retryMode ?? "transition")
    : pendingTransitionSelectionState?.retryMode ?? null
): void {
  setPendingState({
    retryMode,
    sourceState: state,
    targetIdentity: pendingTransitionSelectionState?.targetIdentity ?? null,
    targetBinding: pendingTransitionSelectionState?.targetBinding ?? null,
    targetState: pendingTransitionSelectionState?.targetState ?? null,
  });
}

export function setPendingTransitionTargetState(
  identity: PendingTransitionTargetIdentity | null,
  binding: RpBinding | null,
  state: AutoSelectionEntryData | null,
  retryMode: PendingTransitionRetryMode | null = pendingTransitionSelectionState?.retryMode ?? null
): void {
  setPendingState({
    retryMode,
    sourceState: pendingTransitionSelectionState?.sourceState ?? null,
    targetIdentity: identity,
    targetBinding: binding,
    targetState: state,
  });
}

export function clearPendingTransitionSelectionState(): void {
  pendingTransitionSelectionState = null;
}
