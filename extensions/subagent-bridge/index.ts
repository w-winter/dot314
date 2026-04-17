import { existsSync } from "node:fs";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import {
  SUBAGENT_BRIDGE_HINT_MARKER,
  buildHint,
  deleteChildLink,
  deriveIntercomTarget,
  getParentRegistryPath,
  loadChildLink,
  loadParentRegistry,
  deriveSessionIntercomTarget,
  saveChildLink,
  saveParentRegistry,
  allocateHandle,
  looksLikeSessionPath,
  type ChildLink,
  type ParentRegistry,
  type ParentRegistryEntry,
} from "./state.ts";

interface RuntimeState {
  currentSessionId?: string;
  currentSessionFile?: string;
  currentSessionDir?: string;
  registryPath?: string;
  registry: ParentRegistry | null;
  pendingResumeRollbacks: Map<string, PreviousChildLinkSnapshot>;
}

interface PreviousChildLinkSnapshot {
  childSessionFile: string;
  previous: ChildLink | null;
}

interface SubagentLaunchDetails {
  status?: string;
  sessionFile?: string;
  name?: string;
}

interface SubagentResumeDetails {
  status?: string;
  sessionPath?: string;
  name?: string;
}

interface SubagentResumeInput extends Record<string, unknown> {
  sessionPath: string;
  name?: string;
  message?: string;
}

interface SubagentInput extends Record<string, unknown> {
  name?: string;
}

interface IntercomInput extends Record<string, unknown> {
  action?: string;
  to?: string;
}

const DEFAULT_RESUME_NAME = "Resume";
const DEFAULT_DISPLAY_NAME = "subagent";

function isCustomToolCall<TInput extends Record<string, unknown>>(
  toolName: string,
  event: { toolName: string; input: Record<string, unknown>; toolCallId: string },
): event is { toolName: string; input: TInput; toolCallId: string } {
  return event.toolName === toolName;
}

function createRuntimeState(): RuntimeState {
  return {
    registry: null,
    pendingResumeRollbacks: new Map(),
  };
}

function resetRuntimeState(state: RuntimeState): void {
  state.currentSessionId = undefined;
  state.currentSessionFile = undefined;
  state.currentSessionDir = undefined;
  state.registryPath = undefined;
  state.registry = null;
  state.pendingResumeRollbacks.clear();
}

function refreshRuntimeState(
  state: RuntimeState,
  ctx: { sessionManager: { getSessionId(): string; getSessionDir(): string; getSessionFile?(): string | undefined } },
): void {
  state.currentSessionId = ctx.sessionManager.getSessionId();
  state.currentSessionDir = ctx.sessionManager.getSessionDir();
  state.currentSessionFile = ctx.sessionManager.getSessionFile?.() ?? process.env.PI_SUBAGENT_SESSION ?? undefined;
  state.registryPath = getParentRegistryPath(state.currentSessionDir, state.currentSessionId);

  const loadedRegistry = loadParentRegistry(state.registryPath);
  state.registry = loadedRegistry?.parentSessionId === state.currentSessionId ? loadedRegistry : null;
}

function getCurrentParentTarget(pi: ExtensionAPI, state: RuntimeState): string | undefined {
  if (!state.currentSessionId) return undefined;
  return deriveIntercomTarget(state.currentSessionId, pi.getSessionName());
}

function ensureRegistry(pi: ExtensionAPI, state: RuntimeState): ParentRegistry | null {
  if (!state.currentSessionId || !state.registryPath) return null;
  if (state.registry) return state.registry;

  const parentTarget = getCurrentParentTarget(pi, state);
  if (!parentTarget) return null;

  state.registry = {
    version: 1,
    parentSessionId: state.currentSessionId,
    parentTarget,
    entries: [],
  };
  return state.registry;
}

function saveRegistryIfAvailable(state: RuntimeState): void {
  if (!state.registryPath || !state.registry) return;
  saveParentRegistry(state.registryPath, state.registry);
}

function normalizeDisplayName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeResumeDisplayName(value: unknown): string | undefined {
  const trimmed = normalizeDisplayName(value);
  if (!trimmed || trimmed === DEFAULT_RESUME_NAME) return undefined;
  return trimmed;
}

function createCurrentChildLink(
  pi: ExtensionAPI,
  state: RuntimeState,
  childSessionFile: string,
  displayName: string,
  attachedAt: string,
): ChildLink | null {
  if (!state.currentSessionId) return null;

  const parentTarget = getCurrentParentTarget(pi, state);
  if (!parentTarget) return null;

  return {
    version: 1,
    childSessionFile,
    displayName,
    parent: {
      sessionId: state.currentSessionId,
      target: parentTarget,
      attachedAt,
      ...(state.currentSessionFile ? { sessionFile: state.currentSessionFile } : {}),
    },
  };
}

function findRegistryEntryBySessionFile(state: RuntimeState, sessionFile: string): ParentRegistryEntry | undefined {
  return state.registry?.entries.find((entry) => entry.sessionFile === sessionFile);
}

function findRegistryEntryByHandle(state: RuntimeState, handle: string): ParentRegistryEntry | undefined {
  const lookup = handle.trim().toLowerCase();
  return state.registry?.entries.find((entry) => entry.handle.toLowerCase() === lookup);
}

function upsertRegistryEntry(
  pi: ExtensionAPI,
  state: RuntimeState,
  childSessionFile: string,
  displayName: string,
  attachedAt: string,
): void {
  const registry = ensureRegistry(pi, state);
  if (!registry) return;

  const parentTarget = getCurrentParentTarget(pi, state);
  if (!parentTarget) return;

  const existingEntry = registry.entries.find((entry) => entry.sessionFile === childSessionFile);
  if (existingEntry) {
    existingEntry.lastAttachedAt = attachedAt;
    registry.parentTarget = parentTarget;
    saveRegistryIfAvailable(state);
    return;
  }

  registry.entries.push({
    handle: allocateHandle(displayName, registry.entries.map((entry) => entry.handle)),
    sessionFile: childSessionFile,
    displayName,
    createdAt: attachedAt,
    lastAttachedAt: attachedAt,
  });
  registry.parentTarget = parentTarget;
  saveRegistryIfAvailable(state);
}

function resolveResumeDisplayName(
  existingEntry: ParentRegistryEntry | undefined,
  existingChildLink: ChildLink | null,
  fallbackName: unknown,
): string {
  return existingEntry?.displayName ?? existingChildLink?.displayName ?? normalizeResumeDisplayName(fallbackName) ?? DEFAULT_DISPLAY_NAME;
}

function resolveLaunchDisplayName(existingEntry: ParentRegistryEntry | undefined, fallbackName: unknown): string {
  return existingEntry?.displayName ?? normalizeDisplayName(fallbackName) ?? DEFAULT_DISPLAY_NAME;
}

function resolveCurrentChildSessionFile(state: RuntimeState): string | undefined {
  return state.currentSessionFile ?? process.env.PI_SUBAGENT_SESSION ?? undefined;
}

function resolveParentTargetForChild(childSessionFile: string): { target?: string; reason?: string } {
  const childLink = loadChildLink(childSessionFile);
  if (!childLink) {
    return { reason: 'subagent-bridge: @parent is unavailable because this session has no parent binding' };
  }

  const target = childLink.parent.target.trim();
  if (target) {
    return { target };
  }

  const parentSessionFile = childLink.parent.sessionFile;
  if (!parentSessionFile) {
    return { reason: 'subagent-bridge: @parent is unavailable because the stored parent binding is incomplete' };
  }

  const derivedTarget = deriveSessionIntercomTarget(parentSessionFile);
  if (!derivedTarget) {
    return { reason: 'subagent-bridge: @parent is unavailable because the stored parent session metadata is unreadable' };
  }

  return { target: derivedTarget };
}

function resolveChildTargetForHandle(state: RuntimeState, handle: string): { target?: string; reason?: string } {
  const registryEntry = findRegistryEntryByHandle(state, handle);
  if (!registryEntry) return {};

  if (!existsSync(registryEntry.sessionFile)) {
    return {
      reason: `subagent-bridge: handle "${registryEntry.handle}" resolves to a missing session file: ${registryEntry.sessionFile}`,
    };
  }

  const target = deriveSessionIntercomTarget(registryEntry.sessionFile);
  if (!target) {
    return {
      reason: `subagent-bridge: handle "${registryEntry.handle}" does not resolve to a readable child session target`,
    };
  }

  return { target };
}

function syncOwnedChildLinks(pi: ExtensionAPI, state: RuntimeState): void {
  if (!state.currentSessionId || !state.registry) return;

  const currentTarget = getCurrentParentTarget(pi, state);
  if (!currentTarget || state.registry.parentTarget === currentTarget) return;

  for (const entry of state.registry.entries) {
    const childLink = loadChildLink(entry.sessionFile);
    if (!childLink) continue;
    if (childLink.parent.sessionId !== state.currentSessionId) continue;

    childLink.parent.target = currentTarget;
    if (state.currentSessionFile) {
      childLink.parent.sessionFile = state.currentSessionFile;
    } else {
      delete childLink.parent.sessionFile;
    }

    saveChildLink(entry.sessionFile, childLink);
  }

  state.registry.parentTarget = currentTarget;
  saveRegistryIfAvailable(state);
}

export default function subagentBridgeExtension(pi: ExtensionAPI) {
  const state = createRuntimeState();

  pi.on("session_start", (_event, ctx) => {
    try {
      refreshRuntimeState(state, ctx);
      syncOwnedChildLinks(pi, state);
    } catch {
      // Passive bridge failures must not break session startup
    }
  });

  pi.on("turn_start", (_event, ctx) => {
    try {
      refreshRuntimeState(state, ctx);
      syncOwnedChildLinks(pi, state);
    } catch {
      // Passive bridge failures must not break turns
    }
  });

  pi.on("session_shutdown", () => {
    resetRuntimeState(state);
  });

  pi.on("before_agent_start", (event) => {
    const allToolNames = new Set(pi.getAllTools().map((tool) => tool.name));
    const childSessionFile = resolveCurrentChildSessionFile(state);
    const childParentAvailable = allToolNames.has("intercom") && !!childSessionFile && !!resolveParentTargetForChild(childSessionFile).target;
    const hintBlock = buildHint({
      parentEntries: allToolNames.has("subagent_resume") || allToolNames.has("intercom") ? state.registry?.entries ?? [] : [],
      parentSupportsHandleResume: allToolNames.has("subagent_resume"),
      parentSupportsHandleIntercom: allToolNames.has("intercom"),
      childParentAvailable,
    });

    if (!hintBlock) return;

    const base = event.systemPrompt ?? "";
    if (base.includes(SUBAGENT_BRIDGE_HINT_MARKER)) return;

    return {
      systemPrompt: base ? `${base}\n\n${hintBlock}` : hintBlock,
    };
  });

  pi.on("tool_call", (event) => {
    if (isCustomToolCall<SubagentResumeInput>("subagent_resume", event)) {
      const requestedPath = typeof event.input.sessionPath === "string" ? event.input.sessionPath.trim() : "";
      const registryEntry = requestedPath && !looksLikeSessionPath(requestedPath)
        ? findRegistryEntryByHandle(state, requestedPath)
        : undefined;

      if (registryEntry) {
        if (!existsSync(registryEntry.sessionFile)) {
          return {
            block: true,
            reason: `subagent-bridge: handle "${registryEntry.handle}" resolves to a missing session file: ${registryEntry.sessionFile}`,
          };
        }

        event.input.sessionPath = registryEntry.sessionFile;
      }

      const childSessionFile = typeof event.input.sessionPath === "string" ? event.input.sessionPath.trim() : "";
      if (!childSessionFile || !existsSync(childSessionFile)) {
        return;
      }

      try {
        const previous = loadChildLink(childSessionFile);
        state.pendingResumeRollbacks.set(event.toolCallId, { childSessionFile, previous });

        const nextDisplayName = resolveResumeDisplayName(
          findRegistryEntryBySessionFile(state, childSessionFile),
          previous,
          event.input.name,
        );
        const nextLink = createCurrentChildLink(pi, state, childSessionFile, nextDisplayName, new Date().toISOString());
        if (nextLink) saveChildLink(childSessionFile, nextLink);
      } catch {
        // Passive bridge failures must not block upstream resume
      }

      return;
    }

    if (!isCustomToolCall<IntercomInput>("intercom", event)) return;
    if (event.input.action !== "send" && event.input.action !== "ask") return;
    if (typeof event.input.to !== "string") return;

    const requestedTarget = event.input.to.trim();
    if (requestedTarget.toLowerCase() === "@parent") {
      const childSessionFile = resolveCurrentChildSessionFile(state);
      if (!childSessionFile) {
        return {
          block: true,
          reason: 'subagent-bridge: @parent is unavailable because this session has no persisted child session file',
        };
      }

      const resolved = resolveParentTargetForChild(childSessionFile);
      if (!resolved.target) {
        return {
          block: true,
          reason: resolved.reason ?? 'subagent-bridge: @parent is unavailable',
        };
      }

      event.input.to = resolved.target;
      return;
    }

    if (!requestedTarget.startsWith("@") || requestedTarget.length <= 1) return;

    const resolved = resolveChildTargetForHandle(state, requestedTarget.slice(1));
    if (!resolved.target) {
      if (!resolved.reason) return;
      return {
        block: true,
        reason: resolved.reason,
      };
    }

    event.input.to = resolved.target;
  });

  pi.on("tool_result", (event) => {
    if (event.toolName === "subagent") {
      try {
        const details = event.details as SubagentLaunchDetails | undefined;
        if (event.isError || details?.status !== "started" || typeof details.sessionFile !== "string") {
          return;
        }

        const attachedAt = new Date().toISOString();
        const existingEntry = findRegistryEntryBySessionFile(state, details.sessionFile);
        const displayName = resolveLaunchDisplayName(existingEntry, details.name ?? (event.input as SubagentInput).name);
        upsertRegistryEntry(pi, state, details.sessionFile, displayName, attachedAt);

        const childLink = createCurrentChildLink(pi, state, details.sessionFile, displayName, attachedAt);
        if (childLink) saveChildLink(details.sessionFile, childLink);
      } catch {
        // Passive bridge failures must not affect upstream tool success
      }

      return;
    }

    if (event.toolName !== "subagent_resume") return;

    const pending = state.pendingResumeRollbacks.get(event.toolCallId);

    try {
      const details = event.details as SubagentResumeDetails | undefined;
      const isStarted = !event.isError && details?.status === "started" && typeof details.sessionPath === "string";

      if (!isStarted) {
        if (!pending) return;

        if (pending.previous) {
          saveChildLink(pending.childSessionFile, pending.previous);
        } else {
          deleteChildLink(pending.childSessionFile);
        }
        return;
      }

      const childSessionFile = details.sessionPath;
      const attachedAt = new Date().toISOString();
      const currentChildLink = loadChildLink(childSessionFile);
      const existingEntry = findRegistryEntryBySessionFile(state, childSessionFile);
      const displayName = resolveResumeDisplayName(existingEntry, currentChildLink, details.name);

      upsertRegistryEntry(pi, state, childSessionFile, displayName, attachedAt);

      const nextChildLink = createCurrentChildLink(
        pi,
        state,
        childSessionFile,
        displayName,
        currentChildLink?.parent.attachedAt ?? attachedAt,
      );
      if (nextChildLink) saveChildLink(childSessionFile, nextChildLink);
    } catch {
      if (pending) {
        try {
          if (pending.previous) {
            saveChildLink(pending.childSessionFile, pending.previous);
          } else {
            deleteChildLink(pending.childSessionFile);
          }
        } catch {
          // Ignore rollback cleanup failures
        }
      }
    } finally {
      state.pendingResumeRollbacks.delete(event.toolCallId);
    }
  });
}
