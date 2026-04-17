import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const HANDLE_MAX_LENGTH = 40;
const DEFAULT_HANDLE = "subagent";
const DEFAULT_UNNAMED_SESSION_ALIAS_PREFIX = "subagent-chat";
const DEFAULT_PARENT_HINT_MAX_LENGTH = 200;

export const SUBAGENT_BRIDGE_HINT_MARKER = "# Subagent bridge (extension hint)";
export const CHILD_PARENT_HINT =
  'intercom({ action: "send"|"ask", to: "@parent", ... }) reaches the orchestrating parent of this session.';

export interface ParentRegistryEntry {
  handle: string;
  sessionFile: string;
  displayName: string;
  createdAt: string;
  lastAttachedAt: string;
}

export interface ParentRegistry {
  version: 1;
  parentSessionId: string;
  parentTarget: string;
  entries: ParentRegistryEntry[];
}

export interface ChildLink {
  version: 1;
  childSessionFile: string;
  displayName: string;
  parent: {
    sessionId: string;
    target: string;
    sessionFile?: string;
    attachedAt: string;
  };
}

export interface HintInputs {
  parentEntries?: ParentRegistryEntry[];
  childParentAvailable?: boolean;
  parentHintMaxLength?: number;
  parentSupportsHandleResume?: boolean;
  parentSupportsHandleIntercom?: boolean;
}

type SessionHeaderInfo = {
  id?: string;
  parentSession?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonFile(path: string): unknown | null {
  if (!existsSync(path)) return null;

  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });

  const tempPath = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  const content = `${JSON.stringify(value, null, 2)}\n`;

  try {
    writeFileSync(tempPath, content, "utf8");
    renameSync(tempPath, path);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Ignore temp cleanup failures
    }
    throw error;
  }
}

function normalizeHandleBase(displayName: string): string {
  const normalized = displayName
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || DEFAULT_HANDLE;
}

function fitHandleBase(base: string, maxLength: number): string {
  const trimmed = base.slice(0, maxLength).replace(/-+$/g, "");
  if (trimmed) return trimmed;

  const fallback = DEFAULT_HANDLE.slice(0, maxLength).replace(/-+$/g, "");
  return fallback || DEFAULT_HANDLE;
}

function validateParentRegistryEntry(value: unknown): ParentRegistryEntry | null {
  if (!isRecord(value)) return null;
  if (typeof value.handle !== "string" || !value.handle.trim()) return null;
  if (typeof value.sessionFile !== "string" || !value.sessionFile.trim()) return null;
  if (typeof value.displayName !== "string") return null;
  if (typeof value.createdAt !== "string" || !value.createdAt.trim()) return null;
  if (typeof value.lastAttachedAt !== "string" || !value.lastAttachedAt.trim()) return null;

  return {
    handle: value.handle.trim().toLowerCase(),
    sessionFile: value.sessionFile,
    displayName: value.displayName,
    createdAt: value.createdAt,
    lastAttachedAt: value.lastAttachedAt,
  };
}

function validateParentRegistry(value: unknown): ParentRegistry | null {
  if (!isRecord(value)) return null;
  if (value.version !== 1) return null;
  if (typeof value.parentSessionId !== "string" || !value.parentSessionId.trim()) return null;
  if (typeof value.parentTarget !== "string") return null;
  if (!Array.isArray(value.entries)) return null;

  const entries = value.entries
    .map(validateParentRegistryEntry)
    .filter((entry): entry is ParentRegistryEntry => entry !== null);

  if (entries.length !== value.entries.length) return null;

  const seenHandles = new Set<string>();
  const seenSessionFiles = new Set<string>();
  for (const entry of entries) {
    if (seenHandles.has(entry.handle) || seenSessionFiles.has(entry.sessionFile)) {
      return null;
    }
    seenHandles.add(entry.handle);
    seenSessionFiles.add(entry.sessionFile);
  }

  return {
    version: 1,
    parentSessionId: value.parentSessionId,
    parentTarget: value.parentTarget,
    entries,
  };
}

function validateChildLink(value: unknown, childSessionFile: string): ChildLink | null {
  if (!isRecord(value)) return null;
  if (value.version !== 1) return null;
  if (typeof value.childSessionFile !== "string" || value.childSessionFile !== childSessionFile) return null;
  if (typeof value.displayName !== "string") return null;
  if (!isRecord(value.parent)) return null;
  if (typeof value.parent.sessionId !== "string" || !value.parent.sessionId.trim()) return null;
  if (typeof value.parent.target !== "string") return null;
  if (typeof value.parent.attachedAt !== "string" || !value.parent.attachedAt.trim()) return null;
  if (value.parent.sessionFile !== undefined && typeof value.parent.sessionFile !== "string") return null;

  return {
    version: 1,
    childSessionFile,
    displayName: value.displayName,
    parent: {
      sessionId: value.parent.sessionId,
      target: value.parent.target,
      attachedAt: value.parent.attachedAt,
      ...(typeof value.parent.sessionFile === "string" ? { sessionFile: value.parent.sessionFile } : {}),
    },
  };
}

function parseJsonlLines(sessionFile: string): unknown[] {
  try {
    return readFileSync(sessionFile, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((value): value is unknown => value !== null);
  } catch {
    return [];
  }
}

function buildParentHandleHintLine(
  entries: ParentRegistryEntry[],
  maxLength: number,
  options: { canResume?: boolean; canIntercom?: boolean },
): string | undefined {
  const handles = entries
    .filter((entry) => existsSync(entry.sessionFile))
    .sort((left, right) => Date.parse(right.lastAttachedAt) - Date.parse(left.lastAttachedAt))
    .map((entry) => entry.handle);

  if (handles.length === 0) return undefined;

  const capabilitySuffix = options.canResume && options.canIntercom
    ? " Use in subagent_resume.sessionPath or intercom.to as @<handle>."
    : options.canResume
      ? " Use in subagent_resume.sessionPath."
      : options.canIntercom
        ? " Use in intercom.to as @<handle>."
        : "";
  if (!capabilitySuffix) return undefined;

  const prefix = "Known subagent handles: ";
  const visible: string[] = [];
  for (const handle of handles) {
    const candidateVisible = [...visible, handle];
    const hiddenCount = handles.length - candidateVisible.length;
    const hiddenSuffix = hiddenCount > 0 ? ` (+${hiddenCount} more).` : ".";
    const line = `${prefix}${candidateVisible.join(", ")}${hiddenSuffix}${capabilitySuffix}`;

    if (line.length <= maxLength) {
      visible.push(handle);
      continue;
    }

    break;
  }

  if (visible.length === 0) return undefined;

  const hiddenCount = handles.length - visible.length;
  const hiddenSuffix = hiddenCount > 0 ? ` (+${hiddenCount} more).` : ".";
  return `${prefix}${visible.join(", ")}${hiddenSuffix}${capabilitySuffix}`;
}

export function getParentRegistryPath(sessionDir: string, sessionId: string): string {
  return join(sessionDir, "subagent-bridge", sessionId, "registry.json");
}

export function getChildLinkPath(childSessionFile: string): string {
  return `${childSessionFile}.subagent-bridge.json`;
}

export function loadParentRegistry(path: string): ParentRegistry | null {
  return validateParentRegistry(readJsonFile(path));
}

export function saveParentRegistry(path: string, state: ParentRegistry): void {
  writeJsonAtomic(path, state);
}

export function loadChildLink(childSessionFile: string): ChildLink | null {
  return validateChildLink(readJsonFile(getChildLinkPath(childSessionFile)), childSessionFile);
}

export function saveChildLink(childSessionFile: string, link: ChildLink): void {
  writeJsonAtomic(getChildLinkPath(childSessionFile), link);
}

export function deleteChildLink(childSessionFile: string): void {
  try {
    unlinkSync(getChildLinkPath(childSessionFile));
  } catch {
    // Treat missing link as already deleted
  }
}

export function deriveIntercomTarget(sessionId: string, sessionName: string | undefined): string {
  const trimmed = sessionName?.trim();
  if (trimmed) return trimmed;

  const normalizedSessionId = sessionId.startsWith("session-") ? sessionId.slice("session-".length) : sessionId;
  return `${DEFAULT_UNNAMED_SESSION_ALIAS_PREFIX}-${normalizedSessionId.slice(0, 8)}`;
}

export function allocateHandle(displayName: string, existingHandles: Iterable<string>): string {
  const collisions = new Set(Array.from(existingHandles, (handle) => handle.trim().toLowerCase()));
  const base = fitHandleBase(normalizeHandleBase(displayName), HANDLE_MAX_LENGTH);

  if (!collisions.has(base)) return base;

  for (let index = 2; ; index += 1) {
    const suffix = `-${index}`;
    const fittedBase = fitHandleBase(base, HANDLE_MAX_LENGTH - suffix.length);
    const candidate = `${fittedBase}${suffix}`;
    if (!collisions.has(candidate)) return candidate;
  }
}

export function looksLikeSessionPath(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    trimmed.startsWith("~") ||
    trimmed.endsWith(".jsonl")
  );
}

export function deriveSessionIntercomTarget(sessionFile: string): string | undefined {
  const header = readSessionHeader(sessionFile);
  if (!header?.id) return undefined;
  return deriveIntercomTarget(header.id, readLatestSessionName(sessionFile));
}

export function buildHint(inputs: HintInputs): string | undefined {
  const lines: string[] = [];
  const parentLine = buildParentHandleHintLine(
    inputs.parentEntries ?? [],
    inputs.parentHintMaxLength ?? DEFAULT_PARENT_HINT_MAX_LENGTH,
    {
      canResume: inputs.parentSupportsHandleResume,
      canIntercom: inputs.parentSupportsHandleIntercom,
    },
  );
  if (parentLine) lines.push(parentLine);
  if (inputs.childParentAvailable) lines.push(CHILD_PARENT_HINT);
  if (lines.length === 0) return undefined;
  return `${SUBAGENT_BRIDGE_HINT_MARKER}\n${lines.join("\n")}`;
}

export function readSessionHeader(sessionFile: string): SessionHeaderInfo | null {
  for (const entry of parseJsonlLines(sessionFile)) {
    if (!isRecord(entry) || entry.type !== "session") continue;

    return {
      id: typeof entry.id === "string" ? entry.id : undefined,
      parentSession: typeof entry.parentSession === "string" ? entry.parentSession : undefined,
    };
  }

  return null;
}

export function readLatestSessionName(sessionFile: string): string | undefined {
  const entries = parseJsonlLines(sessionFile);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!isRecord(entry) || entry.type !== "session_info") continue;
    if (typeof entry.name !== "string") return undefined;
    return entry.name.trim() || undefined;
  }

  return undefined;
}
