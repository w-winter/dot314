import { readFileSync } from "node:fs";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const AGENT_DIR = path.join(os.homedir(), ".pi", "agent");

const REWIND_EXTENSION_DIR = path.join(AGENT_DIR, "extensions", "rewind");
const REWIND_EXTENSION_CANDIDATES = [
  "index.ts",
  "index.js",
  path.join("dist", "index.js"),
  path.join("build", "index.js"),
  "package.json",
];

interface RewindForkPendingData {
  v: 2;
  current: string;
  undo?: string;
}

async function isRewindInstalled(): Promise<boolean> {
  try {
    await access(REWIND_EXTENSION_DIR);
  } catch {
    return false;
  }

  for (const relPath of REWIND_EXTENSION_CANDIDATES) {
    try {
      await access(path.join(REWIND_EXTENSION_DIR, relPath));
      return true;
    } catch {
      // keep looking
    }
  }

  return false;
}

function extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") {
    return content;
  }

  return content
    .filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function isRewindForkPendingData(value: unknown): value is RewindForkPendingData {
  if (!value || typeof value !== "object") {
    return false;
  }

  const data = value as Partial<RewindForkPendingData>;
  return data.v === 2 && typeof data.current === "string" && data.current.length > 0;
}

function loadLatestRewindForkPending(sessionFile: string): RewindForkPendingData | null {
  const raw = readFileSync(sessionFile, "utf8");
  const lines = raw.split("\n");

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) {
      continue;
    }

    try {
      const entry = JSON.parse(line) as {
        type?: string;
        customType?: string;
        data?: unknown;
      };

      if (
        entry.type === "custom" &&
        entry.customType === "rewind-fork-pending" &&
        isRewindForkPendingData(entry.data)
      ) {
        return entry.data;
      }
    } catch {
      // ignore malformed lines and keep scanning backward
    }
  }

  return null;
}

function seedChildRewindStateFromParent(
  parentSessionFile: string,
  sessionManager: { appendCustomEntry(customType: string, data?: unknown): string },
): void {
  let pending: RewindForkPendingData | null = null;

  try {
    pending = loadLatestRewindForkPending(parentSessionFile);
  } catch {
    return;
  }

  if (!pending) {
    return;
  }

  const snapshots = [pending.current];
  const data: { v: 2; snapshots: string[]; current: number; undo?: number } = {
    v: 2,
    snapshots,
    current: 0,
  };

  if (typeof pending.undo === "string" && pending.undo.length > 0) {
    data.snapshots.push(pending.undo);
    data.undo = 1;
  }

  sessionManager.appendCustomEntry("rewind-op", data);
}

async function requestConversationOnlyForkWhenRewindIsInstalled(pi: ExtensionAPI): Promise<boolean> {
  if (!(await isRewindInstalled())) {
    return false;
  }

  pi.events.emit("rewind:fork-preference", {
    mode: "conversation-only",
    source: "fork-from-first",
  });

  return true;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("fork-from-first", {
    description: "Fork current session from its first user message",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();

      const previousSessionFile = ctx.sessionManager.getSessionFile();
      if (!previousSessionFile) {
        if (ctx.hasUI) {
          ctx.ui.notify("/fork-from-first requires a persisted session file", "error");
        }
        return;
      }

      const firstUserEntry = ctx.sessionManager
        .getEntries()
        .find(
          (entry) =>
            entry.type === "message" &&
            entry.message?.role === "user"
        );

      if (!firstUserEntry) {
        if (ctx.hasUI) {
          ctx.ui.notify("No user message found to fork from", "warning");
        }
        return;
      }

      const selectedText = extractUserMessageText(firstUserEntry.message.content);
      const rewindInstalled = await requestConversationOnlyForkWhenRewindIsInstalled(pi);
      if (ctx.hasUI && rewindInstalled) {
        ctx.ui.notify("Rewind detected: forcing conversation-only fork", "info");
      }

      const result = await ctx.newSession({
        parentSession: previousSessionFile,
        setup: async (sessionManager) => {
          if (!rewindInstalled) {
            return;
          }

          seedChildRewindStateFromParent(previousSessionFile, sessionManager);
        },
        withSession: async (replacementCtx) => {
          if (!replacementCtx.hasUI) {
            return;
          }

          replacementCtx.ui.setEditorText(selectedText);
          replacementCtx.ui.notify("Forked from first message and switched to new session", "info");
        },
      });

      if (result.cancelled) {
        if (ctx.hasUI) {
          ctx.ui.notify("Fork cancelled", "warning");
        }
        return;
      }

    },
  });
}
