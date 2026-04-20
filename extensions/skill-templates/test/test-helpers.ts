import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  InputEvent,
} from "@mariozechner/pi-coding-agent";

import skillTemplatesExtension from "../index.ts";

type Handler = (event: any, ctx: any) => Promise<unknown> | unknown;

type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;

export interface Harness {
  cwd: string;
  userHomeDir: string;
  agentDir: string;
  notifications: Array<{ message: string; level: string }>;
  commands: Map<string, CommandHandler>;
  sentUserMessages: Array<{ content: unknown; options?: { deliverAs?: "steer" | "followUp" } }>;
  emitInput(event: Partial<InputEvent>): Promise<unknown>;
  emit(eventName: string, event?: Record<string, unknown>): Promise<unknown>;
  invokeCommand(name: string, args?: string, overrides?: Partial<ExtensionCommandContext>): Promise<void>;
  cleanup(): void;
}

export function writeTextFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

export function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), "skill-templates-index-"));
}

export function createHarness(options?: {
  cwd?: string;
  commands?: Array<{ name: string; description?: string; source: "skill" | "extension" | "prompt"; path: string }>;
  isIdle?: boolean;
}): Harness {
  const handlers = new Map<string, Handler[]>();
  const commandHandlers = new Map<string, CommandHandler>();
  const notifications: Array<{ message: string; level: string }> = [];
  const sentUserMessages: Array<{ content: unknown; options?: { deliverAs?: "steer" | "followUp" } }> = [];
  const cwd = options?.cwd ?? createTempDir();
  const userHomeDir = join(cwd, "home");
  const agentDir = join(userHomeDir, ".pi", "agent");
  mkdirSync(agentDir, { recursive: true });
  let idle = options?.isIdle ?? true;

  const ui = {
    notify(message: string, level: string) {
      notifications.push({ message, level });
    },
  };

  const baseContext: ExtensionContext = {
    ui: ui as ExtensionContext["ui"],
    hasUI: true,
    cwd,
    sessionManager: {
      getSessionId: () => "session-id",
      getSessionDir: () => cwd,
      getSessionFile: () => undefined,
    } as ExtensionContext["sessionManager"],
    modelRegistry: {} as ExtensionContext["modelRegistry"],
    model: { id: "claude-sonnet-4" } as ExtensionContext["model"],
    isIdle: () => idle,
    signal: undefined,
    abort() {},
    hasPendingMessages: () => false,
    shutdown() {},
    getContextUsage: () => undefined,
    compact() {},
    getSystemPrompt: () => "SYSTEM",
  };

  const commandContext: ExtensionCommandContext = {
    ...baseContext,
    waitForIdle: async () => {
      idle = true;
    },
    newSession: async () => ({ cancelled: false }),
    fork: async () => ({ cancelled: false }),
    navigateTree: async () => ({ cancelled: false }),
    switchSession: async () => ({ cancelled: false }),
    reload: async () => {},
  };

  const api: ExtensionAPI = {
    on(eventName: string, handler: Handler) {
      const registered = handlers.get(eventName) ?? [];
      registered.push(handler);
      handlers.set(eventName, registered);
    },
    registerTool() {},
    registerCommand(name: string, options: { handler: CommandHandler }) {
      commandHandlers.set(name, options.handler);
    },
    registerShortcut() {},
    registerFlag() {},
    getFlag() {
      return undefined;
    },
    registerMessageRenderer() {},
    sendMessage() {},
    sendUserMessage(content: unknown, options?: { deliverAs?: "steer" | "followUp" }) {
      sentUserMessages.push({ content, options });
      idle = false;
    },
    appendEntry() {},
    setSessionName() {},
    getSessionName() {
      return undefined;
    },
    setLabel() {},
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0, success: true }),
    getActiveTools() {
      return [];
    },
    getAllTools() {
      return [];
    },
    setActiveTools() {},
    getCommands() {
      return (
        options?.commands?.map((command) => ({
          name: command.name,
          description: command.description,
          source: command.source,
          sourceInfo: {
            path: command.path,
            source: "local",
            scope: "project",
            origin: "top-level",
            baseDir: dirname(command.path),
          },
        })) ?? []
      );
    },
    setModel: async () => true,
    getThinkingLevel() {
      return "medium" as never;
    },
    setThinkingLevel() {},
    registerProvider() {},
    unregisterProvider() {},
  } as ExtensionAPI;

  skillTemplatesExtension(api, {
    initialCwd: cwd,
    userHomeDir,
    agentDir,
  });

  return {
    cwd,
    userHomeDir,
    agentDir,
    notifications,
    commands: commandHandlers,
    sentUserMessages,
    async emit(eventName: string, event: Record<string, unknown> = {}) {
      let result: unknown;
      for (const handler of handlers.get(eventName) ?? []) {
        const handlerResult = await handler(event, baseContext);
        if (handlerResult !== undefined) {
          result = handlerResult;
        }
      }
      return result;
    },
    emitInput(event: Partial<InputEvent>) {
      return this.emit("input", {
        type: "input",
        text: "",
        source: "interactive",
        ...event,
      });
    },
    async invokeCommand(name: string, args = "", overrides: Partial<ExtensionCommandContext> = {}) {
      const handler = commandHandlers.get(name);
      if (!handler) {
        throw new Error(`Unknown command ${name}`);
      }
      await handler(args, { ...commandContext, ...overrides });
    },
    cleanup() {
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}
