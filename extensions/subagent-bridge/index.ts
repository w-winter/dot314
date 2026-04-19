import { existsSync } from "node:fs";
import { dirname } from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import type { IntercomClient } from "../pi-intercom/broker/client.ts";
import type { Attachment as IntercomAttachment, Message as IntercomMessage, SessionInfo } from "../pi-intercom/types.ts";

import { loadConfig, type SubagentBridgeConfig } from "./config.ts";
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
  currentCwd?: string;
  currentModel: string;
  sessionStartedAt?: number;
  registryPath?: string;
  registry: ParentRegistry | null;
  pendingResumeRollbacks: Map<string, PreviousChildLinkSnapshot>;
  relayDisconnectors: Set<() => Promise<void>>;
  agentStarted: boolean;
  userTookOver: boolean;
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

interface AssistantToolCall {
  name: string;
  arguments?: unknown;
}

interface AssistantTurn {
  role: "assistant";
  content: unknown[];
  stopReason?: unknown;
}

interface AutoReportDecision {
  finalMessage: string;
  parentTarget: string;
}

interface ParentReportInput {
  senderName: string;
  cwd: string;
  model: string;
  startedAt: number;
  to: string;
  parentSessionId?: string;
  message: string;
  childSessionId?: string;
  childSessionFile?: string;
}

interface BridgeOverrides {
  config?: SubagentBridgeConfig;
  sendParentReport?: (input: ParentReportInput) => Promise<void>;
}

const DEFAULT_RESUME_NAME = "Resume";
const DEFAULT_DISPLAY_NAME = "subagent";
const RELAY_REPLY_WINDOW_MS = 10 * 60 * 1000;

function isCustomToolCall<TInput extends Record<string, unknown>>(
  toolName: string,
  event: { toolName: string; input: Record<string, unknown>; toolCallId: string },
): event is { toolName: string; input: TInput; toolCallId: string } {
  return event.toolName === toolName;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createRuntimeState(): RuntimeState {
  return {
    currentModel: "unknown",
    registry: null,
    pendingResumeRollbacks: new Map(),
    relayDisconnectors: new Set(),
    agentStarted: false,
    userTookOver: false,
  };
}

async function disconnectRelayClients(state: RuntimeState): Promise<void> {
  const disconnectors = [...state.relayDisconnectors];
  state.relayDisconnectors.clear();
  await Promise.all(disconnectors.map((disconnect) => disconnect().catch(() => {
    // Ignore relay cleanup failures during shutdown
  })));
}

function resetRuntimeState(state: RuntimeState): void {
  state.currentSessionId = undefined;
  state.currentSessionFile = undefined;
  state.currentSessionDir = undefined;
  state.currentCwd = undefined;
  state.currentModel = "unknown";
  state.sessionStartedAt = undefined;
  state.registryPath = undefined;
  state.registry = null;
  state.pendingResumeRollbacks.clear();
  state.relayDisconnectors.clear();
  state.agentStarted = false;
  state.userTookOver = false;
}

function hasSessionBindingChanged(
  state: RuntimeState,
  ctx: {
    sessionManager: { getSessionId(): string; getSessionFile?(): string | undefined };
  },
): boolean {
  const nextSessionId = ctx.sessionManager.getSessionId();
  const nextSessionFile = ctx.sessionManager.getSessionFile?.() ?? process.env.PI_SUBAGENT_SESSION ?? undefined;

  if (!state.currentSessionId && !state.currentSessionFile) {
    return false;
  }

  return state.currentSessionId !== nextSessionId || state.currentSessionFile !== nextSessionFile;
}

function refreshRuntimeState(
  state: RuntimeState,
  ctx: {
    cwd?: string;
    model?: { id?: string };
    sessionManager: { getSessionId(): string; getSessionDir(): string; getSessionFile?(): string | undefined };
  },
): void {
  state.currentSessionId = ctx.sessionManager.getSessionId();
  state.currentSessionDir = ctx.sessionManager.getSessionDir();
  state.currentSessionFile = ctx.sessionManager.getSessionFile?.() ?? process.env.PI_SUBAGENT_SESSION ?? undefined;
  state.currentCwd = ctx.cwd ?? state.currentCwd ?? state.currentSessionDir;
  if (typeof ctx.model?.id === "string" && ctx.model.id.trim()) {
    state.currentModel = ctx.model.id;
  }
  state.sessionStartedAt ??= Date.now();
  state.registryPath = getParentRegistryPath(state.currentSessionDir, state.currentSessionId);

  const loadedRegistry = loadParentRegistry(state.registryPath);
  state.registry = loadedRegistry?.parentSessionId === state.currentSessionId ? loadedRegistry : null;
}

function getCurrentSessionTarget(pi: ExtensionAPI, state: RuntimeState): string | undefined {
  if (!state.currentSessionId) return undefined;
  return deriveIntercomTarget(state.currentSessionId, pi.getSessionName());
}

function ensureRegistry(pi: ExtensionAPI, state: RuntimeState): ParentRegistry | null {
  if (!state.currentSessionId || !state.registryPath) return null;
  if (state.registry) return state.registry;

  const parentTarget = getCurrentSessionTarget(pi, state);
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

  const parentTarget = getCurrentSessionTarget(pi, state);
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

  const parentTarget = getCurrentSessionTarget(pi, state);
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
  return existingEntry?.displayName
    ?? existingChildLink?.displayName
    ?? normalizeResumeDisplayName(fallbackName)
    ?? DEFAULT_DISPLAY_NAME;
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

  const currentTarget = getCurrentSessionTarget(pi, state);
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

function findLastAssistantTurnEntry(
  messages: unknown[] | undefined,
): { index: number; message: AssistantTurn } | null {
  if (!Array.isArray(messages)) return null;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (!isRecord(candidate)) continue;
    if (candidate.role !== "assistant") continue;
    if (!Array.isArray(candidate.content)) continue;

    return {
      index,
      message: {
        role: "assistant",
        content: candidate.content,
        stopReason: candidate.stopReason,
      },
    };
  }

  return null;
}

function findLastAssistantTurn(messages: unknown[] | undefined): AssistantTurn | null {
  return findLastAssistantTurnEntry(messages)?.message ?? null;
}

function lastAssistantTurnRepliesToUser(messages: unknown[] | undefined): boolean {
  const lastAssistantTurn = findLastAssistantTurnEntry(messages);
  if (!lastAssistantTurn || !Array.isArray(messages) || lastAssistantTurn.index === 0) {
    return false;
  }

  const previousMessage = messages[lastAssistantTurn.index - 1];
  return isRecord(previousMessage) && previousMessage.role === "user";
}

function extractAssistantTextContent(message: AssistantTurn): string | null {
  const texts = message.content
    .filter(
      (block): block is { type: "text"; text: string } =>
        isRecord(block)
        && block.type === "text"
        && typeof block.text === "string"
        && block.text.trim() !== "",
    )
    .map((block) => block.text);

  if (texts.length === 0) {
    return null;
  }

  const joined = texts.join("\n").trim();
  return joined || null;
}

function getAssistantToolCalls(message: AssistantTurn): AssistantToolCall[] {
  return message.content
    .filter(
      (block): block is { type: "toolCall"; name: string; arguments?: unknown } =>
        isRecord(block) && block.type === "toolCall" && typeof block.name === "string",
    )
    .map((block) => ({ name: block.name, arguments: block.arguments }));
}

function parseToolArguments(rawValue: unknown): Record<string, unknown> | null {
  if (isRecord(rawValue)) {
    return rawValue;
  }

  if (typeof rawValue !== "string") {
    return null;
  }

  try {
    const parsed = JSON.parse(rawValue);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function finalAssistantTurnReportedToParent(
  message: AssistantTurn,
  parentTarget: string,
  parentSessionId?: string,
): boolean {
  const normalizedParentTarget = parentTarget.trim().toLowerCase();
  const normalizedParentSessionId = parentSessionId?.trim().toLowerCase();

  return getAssistantToolCalls(message).some((toolCall) => {
    if (toolCall.name === "subagent_done" || toolCall.name === "caller_ping") {
      return true;
    }

    if (toolCall.name !== "intercom") {
      return false;
    }

    const args = parseToolArguments(toolCall.arguments);
    const action = typeof args?.action === "string" ? args.action.trim().toLowerCase() : "";
    if (action !== "send" && action !== "ask") {
      return false;
    }

    const rawTarget = typeof args?.to === "string" ? args.to.trim() : "";
    if (!rawTarget) {
      return false;
    }

    const normalizedTarget = rawTarget.toLowerCase();
    return normalizedTarget === "@parent"
      || normalizedTarget === normalizedParentTarget
      || (normalizedParentSessionId !== undefined && normalizedTarget === normalizedParentSessionId);
  });
}

function shouldAutoReportOnAgentEnd(params: {
  autoReportEnabled: boolean;
  autoExit: boolean;
  userTookOver: boolean;
  parentTarget?: string;
  parentSessionId?: string;
  messages: unknown[] | undefined;
}): AutoReportDecision | null {
  if (!params.autoReportEnabled || params.autoExit || params.userTookOver || !params.parentTarget) {
    return null;
  }

  const lastAssistantTurn = findLastAssistantTurn(params.messages);
  if (!lastAssistantTurn) {
    return null;
  }

  if (finalAssistantTurnReportedToParent(lastAssistantTurn, params.parentTarget, params.parentSessionId)) {
    return null;
  }

  if (lastAssistantTurnRepliesToUser(params.messages) || lastAssistantTurn.stopReason === "aborted") {
    return null;
  }

  const finalMessage = extractAssistantTextContent(lastAssistantTurn);
  if (!finalMessage) {
    return null;
  }

  return {
    finalMessage,
    parentTarget: params.parentTarget,
  };
}

function findParentLocalHandleForChild(childSessionFile: string | undefined): string | null {
  if (!childSessionFile) {
    return null;
  }

  const childLink = loadChildLink(childSessionFile);
  if (!childLink?.parent.sessionFile) {
    return null;
  }

  const parentRegistry = loadParentRegistry(
    getParentRegistryPath(dirname(childLink.parent.sessionFile), childLink.parent.sessionId),
  );
  return parentRegistry?.entries.find((entry) => entry.sessionFile === childSessionFile)?.handle ?? null;
}

function formatRelayedReplyAttachment(attachment: IntercomAttachment): string {
  return attachment.language
    ? `\n\n---\n📎 ${attachment.name}\n~~~${attachment.language}\n${attachment.content}\n~~~`
    : `\n\n---\n📎 ${attachment.name}\n${attachment.content}`;
}

function buildForwardedReplyMessage(from: SessionInfo, message: IntercomMessage): string {
  const sender = from.name?.trim() || from.id;
  const attachmentText = message.content.attachments?.map(formatRelayedReplyAttachment).join("") ?? "";
  return `Forwarded reply from ${sender} via subagent-bridge relay:\n\n${message.content.text}${attachmentText}`;
}

function isRelayReplyFromParent(
  from: SessionInfo,
  message: IntercomMessage,
  parentSessionId: string,
  relayMessageId: string,
): boolean {
  return message.replyTo === relayMessageId && from.id === parentSessionId;
}

function buildRelayedParentReportMessage(input: ParentReportInput): string {
  const replyHandle = findParentLocalHandleForChild(input.childSessionFile);
  const directReplyLine = replyHandle
    ? `Or message the live child directly with intercom({ action: "send", to: "@${replyHandle}", message: "..." })`
    : `If you prefer not to use the relay reply hint, message the live child session name shown above directly.`;

  return [
    `Relayed final message from ${input.senderName}.`,
    `Replying to this relay message within 10 minutes will be forwarded into the live child session.`,
    directReplyLine,
    "",
    input.message,
  ].join("\n");
}

function isRelayBoundToCurrentSession(
  state: RuntimeState,
  childSessionId: string | undefined,
  childSessionFile: string | undefined,
): boolean {
  return state.currentSessionId === childSessionId && state.currentSessionFile === childSessionFile;
}

function startRelayReplyForwarder(params: {
  pi: ExtensionAPI;
  state: RuntimeState;
  client: IntercomClient;
  parentSessionId: string;
  relayMessageId: string;
  childSessionId?: string;
  childSessionFile?: string;
}): void {
  let disconnected = false;

  const disconnect = async () => {
    if (disconnected) {
      return;
    }
    disconnected = true;
    clearTimeout(timeout);
    params.client.off("message", onMessage);
    params.client.off("disconnected", onDisconnected);
    params.state.relayDisconnectors.delete(disconnect);
    await params.client.disconnect().catch(() => {
      // Ignore relay disconnect cleanup failures
    });
  };

  const onMessage = (from: SessionInfo, message: IntercomMessage) => {
    if (!isRelayReplyFromParent(from, message, params.parentSessionId, params.relayMessageId)) {
      return;
    }
    if (!isRelayBoundToCurrentSession(params.state, params.childSessionId, params.childSessionFile)) {
      void disconnect();
      return;
    }

    params.pi.sendUserMessage(buildForwardedReplyMessage(from, message), { deliverAs: "followUp" });
  };

  const onDisconnected = () => {
    void disconnect();
  };

  const timeout = setTimeout(() => {
    void disconnect();
  }, RELAY_REPLY_WINDOW_MS);

  params.client.on("message", onMessage);
  params.client.on("disconnected", onDisconnected);
  params.state.relayDisconnectors.add(disconnect);
}

async function defaultSendParentReport(pi: ExtensionAPI, state: RuntimeState, input: ParentReportInput): Promise<void> {
  const [{ IntercomClient }, { spawnBrokerIfNeeded }] = await Promise.all([
    import("../pi-intercom/broker/client.ts"),
    import("../pi-intercom/broker/spawn.ts"),
  ]);

  await spawnBrokerIfNeeded();

  const client = new IntercomClient();
  client.on("error", () => {
    // Ignore passive transport errors here; delivery success is checked explicitly below
  });

  await client.connect({
    name: `${input.senderName} [relay]`,
    cwd: input.cwd,
    model: input.model,
    pid: process.pid,
    startedAt: input.startedAt,
    lastActivity: Date.now(),
  });

  const result = await client.send(input.to, { text: buildRelayedParentReportMessage(input) });
  if (!result.delivered) {
    await client.disconnect().catch(() => {
      // Ignore disconnect cleanup failures after failed delivery
    });
    throw new Error(result.reason ?? "Failed to deliver parent report");
  }

  if (!input.parentSessionId) {
    await client.disconnect().catch(() => {
      // Ignore disconnect cleanup failures when parent identity is unavailable
    });
    return;
  }

  startRelayReplyForwarder({
    pi,
    state,
    client,
    parentSessionId: input.parentSessionId,
    relayMessageId: result.id,
    childSessionId: input.childSessionId,
    childSessionFile: input.childSessionFile,
  });
}

export const __test__ = {
  findLastAssistantTurn,
  extractAssistantTextContent,
  finalAssistantTurnReportedToParent,
  shouldAutoReportOnAgentEnd,
  findParentLocalHandleForChild,
  buildRelayedParentReportMessage,
  buildForwardedReplyMessage,
  isRelayReplyFromParent,
  hasSessionBindingChanged,
  isRelayBoundToCurrentSession,
  lastAssistantTurnRepliesToUser,
};

export default function subagentBridgeExtension(pi: ExtensionAPI, overrides: BridgeOverrides = {}) {
  const state = createRuntimeState();
  const config = overrides.config ?? loadConfig();
  const sendParentReport = overrides.sendParentReport ?? ((input) => defaultSendParentReport(pi, state, input));
  const autoExit = process.env.PI_SUBAGENT_AUTO_EXIT === "1";

  pi.on("session_start", async (_event, ctx) => {
    try {
      if (hasSessionBindingChanged(state, ctx)) {
        await disconnectRelayClients(state);
      }
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

  pi.on("model_select", (event) => {
    state.currentModel = event.model.id;
  });

  pi.on("agent_start", () => {
    state.agentStarted = true;
    state.userTookOver = false;
  });

  pi.on("input", (event) => {
    if (!state.agentStarted || event.source !== "interactive") {
      return;
    }
    state.userTookOver = true;
  });

  pi.on("agent_end", async (event) => {
    try {
      const childSessionFile = resolveCurrentChildSessionFile(state);
      const resolvedParent = childSessionFile ? resolveParentTargetForChild(childSessionFile) : {};
      const childLink = childSessionFile ? loadChildLink(childSessionFile) : null;
      const report = shouldAutoReportOnAgentEnd({
        autoReportEnabled: config.autoReportToParentOnAgentEnd,
        autoExit,
        userTookOver: state.userTookOver,
        parentTarget: resolvedParent.target,
        parentSessionId: childLink?.parent.sessionId,
        messages: event.messages,
      });
      if (!report) {
        return;
      }

      const senderName = getCurrentSessionTarget(pi, state);
      if (!senderName) {
        return;
      }

      await sendParentReport({
        senderName,
        cwd: state.currentCwd ?? state.currentSessionDir ?? process.cwd(),
        model: state.currentModel,
        startedAt: state.sessionStartedAt ?? Date.now(),
        to: report.parentTarget,
        parentSessionId: childLink?.parent.sessionId,
        message: report.finalMessage,
        childSessionId: state.currentSessionId,
        childSessionFile,
      });
    } catch {
      // Passive bridge failures must never break child session completion
    } finally {
      state.agentStarted = false;
      state.userTookOver = false;
    }
  });

  pi.on("session_shutdown", async () => {
    await disconnectRelayClients(state);
    resetRuntimeState(state);
  });

  pi.on("before_agent_start", (event) => {
    const allToolNames = new Set(pi.getAllTools().map((tool) => tool.name));
    const childSessionFile = resolveCurrentChildSessionFile(state);
    const childParentAvailable =
      allToolNames.has("intercom") && !!childSessionFile && !!resolveParentTargetForChild(childSessionFile).target;
    const hintBlock = buildHint({
      parentEntries: allToolNames.has("subagent_resume") || allToolNames.has("intercom")
        ? state.registry?.entries ?? []
        : [],
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
