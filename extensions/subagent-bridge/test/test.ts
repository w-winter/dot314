import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import subagentBridgeExtension from "../index.ts";
import {
  CHILD_PARENT_HINT,
  SUBAGENT_BRIDGE_HINT_MARKER,
  allocateHandle,
  deriveIntercomTarget,
  getChildLinkPath,
  getParentRegistryPath,
  loadChildLink,
  loadParentRegistry,
  saveChildLink,
  saveParentRegistry,
  type ChildLink,
  type ParentRegistry,
} from "../state.ts";

type Handler = (event: any, ctx: any) => Promise<unknown> | unknown;

type HarnessState = {
  sessionId: string;
  sessionDir: string;
  sessionFile?: string;
  sessionName?: string;
  toolNames: string[];
};

type Harness = {
  state: HarnessState;
  emit(eventName: string, event?: any): Promise<unknown>;
};

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "subagent-bridge-"));
  tempDirs.push(dir);
  return dir;
}

function writeSessionFile(
  dir: string,
  fileName: string,
  sessionId: string,
  options?: { sessionName?: string; parentSession?: string },
): string {
  const path = join(dir, fileName);
  const entries: object[] = [
    {
      type: "session",
      id: sessionId,
      version: 3,
      ...(options?.parentSession ? { parentSession: options.parentSession } : {}),
    },
  ];

  if (options?.sessionName !== undefined) {
    entries.push({
      type: "session_info",
      id: `${sessionId}-info`,
      parentId: sessionId,
      timestamp: new Date().toISOString(),
      name: options.sessionName,
    });
  }

  writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  return path;
}

function createHarness(options: {
  sessionId: string;
  sessionDir: string;
  sessionFile?: string;
  sessionName?: string;
  toolNames?: string[];
}): Harness {
  const handlers = new Map<string, Handler[]>();
  const state: HarnessState = {
    sessionId: options.sessionId,
    sessionDir: options.sessionDir,
    sessionFile: options.sessionFile,
    sessionName: options.sessionName,
    toolNames: options.toolNames ?? [],
  };

  const pi = {
    on(eventName: string, handler: Handler) {
      const registered = handlers.get(eventName) ?? [];
      registered.push(handler);
      handlers.set(eventName, registered);
    },
    getSessionName() {
      return state.sessionName;
    },
    getAllTools() {
      return state.toolNames.map((name) => ({ name }));
    },
    getActiveTools() {
      throw new Error("getActiveTools should not be called by subagent-bridge tests");
    },
  } as unknown as ExtensionAPI;

  subagentBridgeExtension(pi);

  const ctx = () => ({
    cwd: state.sessionDir,
    sessionManager: {
      getSessionId: () => state.sessionId,
      getSessionDir: () => state.sessionDir,
      getSessionFile: () => state.sessionFile,
    },
  });

  return {
    state,
    async emit(eventName: string, event: any = {}) {
      let result: unknown;
      for (const handler of handlers.get(eventName) ?? []) {
        const handlerResult = await handler(event, ctx());
        if (handlerResult !== undefined) {
          result = handlerResult;
        }
      }
      return result;
    },
  };
}

function createRegistry(sessionId: string, parentTarget: string, entries: ParentRegistry["entries"]): ParentRegistry {
  return {
    version: 1,
    parentSessionId: sessionId,
    parentTarget,
    entries,
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

test("allocateHandle normalizes to lowercase and suffixes collisions deterministically", () => {
  assert.equal(allocateHandle("Idle Worker", []), "idle-worker");
  assert.equal(allocateHandle("Scout: DB", ["idle-worker"]), "scout-db");
  assert.equal(allocateHandle("Scout: DB", ["scout-db"]), "scout-db-2");
});

test("subagent_resume rewrites a case-insensitive handle before upstream validation", async () => {
  const dir = createTempDir();
  const sessionId = "session-parent-12345678";
  const parentFile = writeSessionFile(dir, "parent.jsonl", sessionId, { sessionName: "Parent Session" });
  const childFile = writeSessionFile(dir, "child.jsonl", "session-child-abcdef01");

  saveParentRegistry(
    getParentRegistryPath(dir, sessionId),
    createRegistry(sessionId, "Parent Session", [
      {
        handle: "idle-worker",
        sessionFile: childFile,
        displayName: "Idle Worker",
        createdAt: "2026-04-16T00:00:00.000Z",
        lastAttachedAt: "2026-04-16T00:00:00.000Z",
      },
    ]),
  );

  const harness = createHarness({ sessionId, sessionDir: dir, sessionFile: parentFile, sessionName: "Parent Session" });
  await harness.emit("session_start");

  const event = {
    type: "tool_call",
    toolCallId: "tc-1",
    toolName: "subagent_resume",
    input: { sessionPath: "Idle-Worker", name: "Resume" },
  };

  const result = await harness.emit("tool_call", event);
  assert.equal(result, undefined);
  assert.equal(event.input.sessionPath, childFile);
  assert.equal(loadChildLink(childFile)?.parent.target, "Parent Session");
});

test("path-like subagent_resume values are not treated as handles", async () => {
  const dir = createTempDir();
  const sessionId = "session-parent-87654321";
  const parentFile = writeSessionFile(dir, "parent.jsonl", sessionId, { sessionName: "Parent Session" });

  saveParentRegistry(
    getParentRegistryPath(dir, sessionId),
    createRegistry(sessionId, "Parent Session", [
      {
        handle: "idle-worker",
        sessionFile: join(dir, "child.jsonl"),
        displayName: "Idle Worker",
        createdAt: "2026-04-16T00:00:00.000Z",
        lastAttachedAt: "2026-04-16T00:00:00.000Z",
      },
    ]),
  );

  const harness = createHarness({ sessionId, sessionDir: dir, sessionFile: parentFile, sessionName: "Parent Session" });
  await harness.emit("session_start");

  const event = {
    type: "tool_call",
    toolCallId: "tc-2",
    toolName: "subagent_resume",
    input: { sessionPath: "./idle-worker.jsonl", name: "Resume" },
  };

  const result = await harness.emit("tool_call", event);
  assert.equal(result, undefined);
  assert.equal(event.input.sessionPath, "./idle-worker.jsonl");
});

test("missing registered child paths block handle-based resume with an explicit reason", async () => {
  const dir = createTempDir();
  const sessionId = "session-parent-missing";
  const parentFile = writeSessionFile(dir, "parent.jsonl", sessionId, { sessionName: "Parent Session" });
  const missingChild = join(dir, "missing-child.jsonl");

  saveParentRegistry(
    getParentRegistryPath(dir, sessionId),
    createRegistry(sessionId, "Parent Session", [
      {
        handle: "idle-worker",
        sessionFile: missingChild,
        displayName: "Idle Worker",
        createdAt: "2026-04-16T00:00:00.000Z",
        lastAttachedAt: "2026-04-16T00:00:00.000Z",
      },
    ]),
  );

  const harness = createHarness({ sessionId, sessionDir: dir, sessionFile: parentFile, sessionName: "Parent Session" });
  await harness.emit("session_start");

  const event = {
    type: "tool_call",
    toolCallId: "tc-3",
    toolName: "subagent_resume",
    input: { sessionPath: "idle-worker", name: "Resume" },
  };

  const result = await harness.emit("tool_call", event);
  assert.deepEqual(result, {
    block: true,
    reason: `subagent-bridge: handle "idle-worker" resolves to a missing session file: ${missingChild}`,
  });
});

test("successful subagent launches register a handle and write a child link", async () => {
  const dir = createTempDir();
  const sessionId = "session-parent-launch";
  const parentFile = writeSessionFile(dir, "parent.jsonl", sessionId, { sessionName: "Parent Session" });
  const childFile = writeSessionFile(dir, "child.jsonl", "session-child-launch");

  const harness = createHarness({ sessionId, sessionDir: dir, sessionFile: parentFile, sessionName: "Parent Session" });
  await harness.emit("session_start");

  await harness.emit("tool_result", {
    type: "tool_result",
    toolCallId: "tc-launch",
    toolName: "subagent",
    input: { name: "Idle Worker" },
    content: [],
    isError: false,
    details: { status: "started", sessionFile: childFile, name: "Idle Worker" },
  });

  const registry = loadParentRegistry(getParentRegistryPath(dir, sessionId));
  assert.equal(registry?.entries[0]?.handle, "idle-worker");
  assert.equal(loadChildLink(childFile)?.parent.target, "Parent Session");
});

test("resume pre-write is kept on successful subagent_resume", async () => {
  const dir = createTempDir();
  const sessionId = "session-parent-success";
  const parentFile = writeSessionFile(dir, "parent.jsonl", sessionId, { sessionName: "Parent Session" });
  const childFile = writeSessionFile(dir, "child.jsonl", "session-child-success");

  const harness = createHarness({ sessionId, sessionDir: dir, sessionFile: parentFile, sessionName: "Parent Session" });
  await harness.emit("session_start");

  const toolCall = {
    type: "tool_call",
    toolCallId: "tc-success",
    toolName: "subagent_resume",
    input: { sessionPath: childFile, name: "Scout DB" },
  };
  await harness.emit("tool_call", toolCall);

  const prewritten = loadChildLink(childFile);
  assert.equal(prewritten?.displayName, "Scout DB");
  assert.equal(prewritten?.parent.target, "Parent Session");

  await harness.emit("tool_result", {
    type: "tool_result",
    toolCallId: "tc-success",
    toolName: "subagent_resume",
    input: { sessionPath: childFile, name: "Scout DB" },
    content: [],
    isError: false,
    details: { status: "started", sessionPath: childFile, name: "Scout DB" },
  });

  const childLink = loadChildLink(childFile);
  const registry = loadParentRegistry(getParentRegistryPath(dir, sessionId));
  assert.equal(childLink?.parent.target, "Parent Session");
  assert.equal(registry?.entries[0]?.handle, "scout-db");
});

test("resume pre-write is rolled back on failed subagent_resume", async () => {
  const dir = createTempDir();
  const sessionId = "session-parent-failure";
  const parentFile = writeSessionFile(dir, "parent.jsonl", sessionId, { sessionName: "Parent Session" });
  const childFile = writeSessionFile(dir, "child.jsonl", "session-child-failure");

  const previousLink: ChildLink = {
    version: 1,
    childSessionFile: childFile,
    displayName: "Original Child",
    parent: {
      sessionId: "session-old-parent",
      target: "Old Parent",
      attachedAt: "2026-04-16T00:00:00.000Z",
      sessionFile: parentFile,
    },
  };
  saveChildLink(childFile, previousLink);

  const harness = createHarness({ sessionId, sessionDir: dir, sessionFile: parentFile, sessionName: "Parent Session" });
  await harness.emit("session_start");

  await harness.emit("tool_call", {
    type: "tool_call",
    toolCallId: "tc-failure",
    toolName: "subagent_resume",
    input: { sessionPath: childFile, name: "Resume" },
  });
  assert.equal(loadChildLink(childFile)?.parent.target, "Parent Session");

  await harness.emit("tool_result", {
    type: "tool_result",
    toolCallId: "tc-failure",
    toolName: "subagent_resume",
    input: { sessionPath: childFile, name: "Resume" },
    content: [],
    isError: true,
    details: undefined,
  });

  assert.deepEqual(loadChildLink(childFile), previousLink);
});

test("parent intercom calls to @handle rewrite to the child target", async () => {
  const dir = createTempDir();
  const sessionId = "session-parent-handle-intercom";
  const parentFile = writeSessionFile(dir, "parent.jsonl", sessionId, { sessionName: "Parent Session" });
  const childFile = writeSessionFile(dir, "child.jsonl", "session-child-handle-intercom", { sessionName: "Idle Worker Session" });

  saveParentRegistry(
    getParentRegistryPath(dir, sessionId),
    createRegistry(sessionId, "Parent Session", [
      {
        handle: "idle-worker",
        sessionFile: childFile,
        displayName: "Idle Worker",
        createdAt: "2026-04-16T00:00:00.000Z",
        lastAttachedAt: "2026-04-16T00:00:00.000Z",
      },
    ]),
  );

  const harness = createHarness({ sessionId, sessionDir: dir, sessionFile: parentFile, sessionName: "Parent Session" });
  await harness.emit("session_start");

  const event = {
    type: "tool_call",
    toolCallId: "tc-parent-handle",
    toolName: "intercom",
    input: { action: "send", to: "@Idle-Worker", message: "Status?" },
  };

  const result = await harness.emit("tool_call", event);
  assert.equal(result, undefined);
  assert.equal(event.input.to, "Idle Worker Session");
});

test("child intercom calls to @parent rewrite to the stored parent target", async () => {
  const dir = createTempDir();
  const childFile = writeSessionFile(dir, "child.jsonl", "session-child-ask");
  saveChildLink(childFile, {
    version: 1,
    childSessionFile: childFile,
    displayName: "Child",
    parent: {
      sessionId: "session-parent-ask",
      target: "Parent Session",
      attachedAt: "2026-04-16T00:00:00.000Z",
    },
  });

  const harness = createHarness({ sessionId: "session-child-ask", sessionDir: dir, sessionFile: childFile });
  await harness.emit("session_start");

  const event = {
    type: "tool_call",
    toolCallId: "tc-ask",
    toolName: "intercom",
    input: { action: "ask", to: "@parent", message: "Need input" },
  };

  const result = await harness.emit("tool_call", event);
  assert.equal(result, undefined);
  assert.equal(event.input.to, "Parent Session");
});

test("parent @handle calls block when the registered child path is missing", async () => {
  const dir = createTempDir();
  const sessionId = "session-parent-missing-handle-intercom";
  const parentFile = writeSessionFile(dir, "parent.jsonl", sessionId, { sessionName: "Parent Session" });
  const missingChild = join(dir, "missing-child.jsonl");

  saveParentRegistry(
    getParentRegistryPath(dir, sessionId),
    createRegistry(sessionId, "Parent Session", [
      {
        handle: "idle-worker",
        sessionFile: missingChild,
        displayName: "Idle Worker",
        createdAt: "2026-04-16T00:00:00.000Z",
        lastAttachedAt: "2026-04-16T00:00:00.000Z",
      },
    ]),
  );

  const harness = createHarness({ sessionId, sessionDir: dir, sessionFile: parentFile, sessionName: "Parent Session" });
  await harness.emit("session_start");

  const event = {
    type: "tool_call",
    toolCallId: "tc-missing-parent-handle",
    toolName: "intercom",
    input: { action: "send", to: "@idle-worker", message: "Status?" },
  };

  const result = await harness.emit("tool_call", event);
  assert.deepEqual(result, {
    block: true,
    reason: `subagent-bridge: handle "idle-worker" resolves to a missing session file: ${missingChild}`,
  });
});

test("child @parent calls block when no valid binding exists", async () => {
  const dir = createTempDir();
  const childFile = writeSessionFile(dir, "child.jsonl", "session-child-blocked");
  const harness = createHarness({ sessionId: "session-child-blocked", sessionDir: dir, sessionFile: childFile });
  await harness.emit("session_start");

  const event = {
    type: "tool_call",
    toolCallId: "tc-blocked",
    toolName: "intercom",
    input: { action: "send", to: "@parent", message: "status" },
  };

  const result = await harness.emit("tool_call", event);
  assert.deepEqual(result, {
    block: true,
    reason: "subagent-bridge: @parent is unavailable because this session has no parent binding",
  });
});

test("ownership-safe parent-target sync updates only child links owned by the active parent", async () => {
  const dir = createTempDir();
  const sessionId = "session-parent-owner";
  const parentFile = writeSessionFile(dir, "parent.jsonl", sessionId, { sessionName: "Old Parent" });
  const ownedChild = writeSessionFile(dir, "owned-child.jsonl", "session-owned-child");
  const foreignChild = writeSessionFile(dir, "foreign-child.jsonl", "session-foreign-child");

  saveParentRegistry(
    getParentRegistryPath(dir, sessionId),
    createRegistry(sessionId, "Old Parent", [
      {
        handle: "owned-child",
        sessionFile: ownedChild,
        displayName: "Owned Child",
        createdAt: "2026-04-16T00:00:00.000Z",
        lastAttachedAt: "2026-04-16T00:00:00.000Z",
      },
      {
        handle: "foreign-child",
        sessionFile: foreignChild,
        displayName: "Foreign Child",
        createdAt: "2026-04-15T00:00:00.000Z",
        lastAttachedAt: "2026-04-15T00:00:00.000Z",
      },
    ]),
  );

  saveChildLink(ownedChild, {
    version: 1,
    childSessionFile: ownedChild,
    displayName: "Owned Child",
    parent: {
      sessionId,
      target: "Old Parent",
      attachedAt: "2026-04-16T00:00:00.000Z",
      sessionFile: parentFile,
    },
  });
  saveChildLink(foreignChild, {
    version: 1,
    childSessionFile: foreignChild,
    displayName: "Foreign Child",
    parent: {
      sessionId: "session-other-parent",
      target: "Other Parent",
      attachedAt: "2026-04-16T00:00:00.000Z",
      sessionFile: parentFile,
    },
  });

  const harness = createHarness({
    sessionId,
    sessionDir: dir,
    sessionFile: parentFile,
    sessionName: "Old Parent",
  });
  await harness.emit("session_start");

  harness.state.sessionName = "Renamed Parent";
  await harness.emit("turn_start");

  assert.equal(loadChildLink(ownedChild)?.parent.target, "Renamed Parent");
  assert.equal(loadChildLink(foreignChild)?.parent.target, "Other Parent");
  assert.equal(loadParentRegistry(getParentRegistryPath(dir, sessionId))?.parentTarget, "Renamed Parent");
});

test("before_agent_start emits no child hint until @parent is resolvable", async () => {
  const dir = createTempDir();
  const parentFile = writeSessionFile(dir, "parent.jsonl", "session-parent-hints", { sessionName: "Parent Session" });
  const childFile = writeSessionFile(dir, "child.jsonl", "session-child-hints");
  const harness = createHarness({
    sessionId: "session-child-hints",
    sessionDir: dir,
    sessionFile: childFile,
    toolNames: ["intercom"],
  });
  await harness.emit("session_start");

  assert.equal(await harness.emit("before_agent_start", { systemPrompt: "Base prompt" }), undefined);

  saveChildLink(childFile, {
    version: 1,
    childSessionFile: childFile,
    displayName: "Child",
    parent: {
      sessionId: "session-parent-hints",
      target: "",
      attachedAt: "2026-04-16T00:00:00.000Z",
      sessionFile: parentFile,
    },
  });

  const result = await harness.emit("before_agent_start", { systemPrompt: "Base prompt" }) as { systemPrompt: string };
  assert.match(result.systemPrompt, new RegExp(SUBAGENT_BRIDGE_HINT_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(result.systemPrompt, new RegExp(CHILD_PARENT_HINT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("parent hint truncates, omits missing children, and appends a +N more suffix", async () => {
  const dir = createTempDir();
  const sessionId = "session-parent-truncate";
  const parentFile = writeSessionFile(dir, "parent.jsonl", sessionId, { sessionName: "Parent Session" });

  const entries: ParentRegistry["entries"] = [];
  for (let index = 0; index < 8; index += 1) {
    const childFile = writeSessionFile(dir, `child-${index}.jsonl`, `session-child-${index}`);
    entries.push({
      handle: `worker-${index}-extremely-descriptive`,
      sessionFile: childFile,
      displayName: `Worker ${index}`,
      createdAt: `2026-04-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
      lastAttachedAt: `2026-04-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
    });
  }
  entries.push({
    handle: "missing-child",
    sessionFile: join(dir, "missing-child.jsonl"),
    displayName: "Missing Child",
    createdAt: "2026-04-20T00:00:00.000Z",
    lastAttachedAt: "2026-04-20T00:00:00.000Z",
  });

  saveParentRegistry(getParentRegistryPath(dir, sessionId), createRegistry(sessionId, "Parent Session", entries));

  const harness = createHarness({
    sessionId,
    sessionDir: dir,
    sessionFile: parentFile,
    sessionName: "Parent Session",
    toolNames: ["subagent_resume", "intercom"],
  });
  await harness.emit("session_start");

  const result = await harness.emit("before_agent_start", { systemPrompt: "Base prompt" }) as { systemPrompt: string };
  assert.match(result.systemPrompt, /Known subagent handles:/);
  assert.match(result.systemPrompt, /\(\+\d+ more\)\./);
  assert.match(result.systemPrompt, /intercom\.to as @<handle>/);
  assert.equal(result.systemPrompt.includes("missing-child"), false);
});

test("deriveIntercomTarget matches intercom's unnamed-session alias rule", () => {
  assert.equal(deriveIntercomTarget("session-1234567890", undefined), "subagent-chat-12345678");
  assert.equal(deriveIntercomTarget("abcdef1234567890", undefined), "subagent-chat-abcdef12");
  assert.equal(deriveIntercomTarget("session-1234567890", " Named Parent "), "Named Parent");
});

test("child link fallback derives @parent from the exact stored parent session file", () => {
  const dir = createTempDir();
  const parentFile = writeSessionFile(dir, "parent.jsonl", "session-parent-fallback", { sessionName: "Parent Session" });
  const childFile = writeSessionFile(dir, "child.jsonl", "session-child-fallback");

  saveChildLink(childFile, {
    version: 1,
    childSessionFile: childFile,
    displayName: "Child",
    parent: {
      sessionId: "session-parent-fallback",
      target: "",
      attachedAt: "2026-04-16T00:00:00.000Z",
      sessionFile: parentFile,
    },
  });

  const childLinkRaw = JSON.parse(readFileSync(getChildLinkPath(childFile), "utf8")) as ChildLink;
  assert.equal(childLinkRaw.parent.target, "");
});
