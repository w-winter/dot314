import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import subagentBridgeExtension, { __test__ } from "../index.ts";
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
const originalAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;

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
  bridgeConfig?: { autoReportToParentOnAgentEnd: boolean };
  sendParentReport?: (input: any) => Promise<void> | void;
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

  subagentBridgeExtension(pi, {
    ...(options.bridgeConfig ? { config: options.bridgeConfig } : {}),
    ...(options.sendParentReport ? { sendParentReport: options.sendParentReport } : {}),
  });

  const ctx = () => ({
    cwd: state.sessionDir,
    model: { id: "claude-sonnet-4" },
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

  if (originalAutoExit === undefined) {
    delete process.env.PI_SUBAGENT_AUTO_EXIT;
  } else {
    process.env.PI_SUBAGENT_AUTO_EXIT = originalAutoExit;
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
  const childFile = writeSessionFile(dir, "child.jsonl", "session-child-handle-intercom", {
    sessionName: "Idle Worker Session",
  });

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

test("lastAssistantTurnRepliesToUser detects when the final assistant turn immediately follows a user turn", () => {
  assert.equal(
    __test__.lastAssistantTurnRepliesToUser([
      { role: "user", content: [{ type: "text", text: "What happened?" }] },
      { role: "assistant", content: [{ type: "text", text: "Done." }], stopReason: "stop" },
    ]),
    true,
  );
  assert.equal(
    __test__.lastAssistantTurnRepliesToUser([
      { role: "assistant", content: [{ type: "text", text: "Working." }], stopReason: "stop" },
      { role: "assistant", content: [{ type: "text", text: "Done." }], stopReason: "stop" },
    ]),
    false,
  );
});

test("buildParentReportTransportName marks fallback messages as forwarded", () => {
  assert.equal(__test__.buildParentReportTransportName("Idle Worker"), "Idle Worker via subagent-bridge");
});

test("buildForwardedReplyMessage preserves parent text and attachments", () => {
  const message = __test__.buildForwardedReplyMessage(
    { id: "parent-id", name: "Parent Session" },
    {
      id: "reply-id",
      timestamp: Date.now(),
      replyTo: "relay-id",
      content: {
        text: "Please keep digging.",
        attachments: [{ type: "snippet", name: "note.ts", content: "const x = 1;", language: "ts" }],
      },
    },
  );

  assert.match(message, /Forwarded reply from Parent Session via subagent-bridge relay:/);
  assert.match(message, /Please keep digging\./);
  assert.match(message, /📎 note\.ts/);
  assert.match(message, /~~~ts/);
});

test("isRelayReplyFromParent matches stable parent session id and ignores display-name changes", () => {
  assert.equal(
    __test__.isRelayReplyFromParent(
      { id: "parent-id", name: "Renamed Parent" },
      { id: "reply-id", timestamp: Date.now(), replyTo: "relay-id", content: { text: "Reply" } },
      "parent-id",
      "relay-id",
    ),
    true,
  );
  assert.equal(
    __test__.isRelayReplyFromParent(
      { id: "someone-else", name: "Parent Session" },
      { id: "reply-id", timestamp: Date.now(), replyTo: "relay-id", content: { text: "Reply" } },
      "parent-id",
      "relay-id",
    ),
    false,
  );
  assert.equal(
    __test__.isRelayReplyFromParent(
      { id: "parent-id", name: "Parent Session" },
      { id: "reply-id", timestamp: Date.now(), replyTo: "different-id", content: { text: "Reply" } },
      "parent-id",
      "relay-id",
    ),
    false,
  );
});

test("hasSessionBindingChanged detects when the child process moves to a different session", () => {
  const state = {
    currentSessionId: "session-child-a",
    currentSessionFile: "/tmp/child-a.jsonl",
  } as any;

  assert.equal(
    __test__.hasSessionBindingChanged(state, {
      sessionManager: {
        getSessionId: () => "session-child-a",
        getSessionFile: () => "/tmp/child-a.jsonl",
      },
    }),
    false,
  );
  assert.equal(
    __test__.hasSessionBindingChanged(state, {
      sessionManager: {
        getSessionId: () => "session-child-b",
        getSessionFile: () => "/tmp/child-b.jsonl",
      },
    }),
    true,
  );
});

test("isRelayBoundToCurrentSession rejects forwarding after the child session changes", () => {
  const state = {
    currentSessionId: "session-child-b",
    currentSessionFile: "/tmp/child-b.jsonl",
  } as any;

  assert.equal(__test__.isRelayBoundToCurrentSession(state, "session-child-a", "/tmp/child-a.jsonl"), false);
  assert.equal(__test__.isRelayBoundToCurrentSession(state, "session-child-b", "/tmp/child-b.jsonl"), true);
});

test("buildParentReportMessage appends a separated direct reply hint when the child handle is known", () => {
  const dir = createTempDir();
  const parentSessionId = "session-parent-report-message";
  const parentFile = writeSessionFile(dir, "parent.jsonl", parentSessionId, { sessionName: "Parent Session" });
  const childFile = writeSessionFile(dir, "child.jsonl", "session-child-report-message");

  saveParentRegistry(
    getParentRegistryPath(dir, parentSessionId),
    createRegistry(parentSessionId, "Parent Session", [
      {
        handle: "idle-worker",
        sessionFile: childFile,
        displayName: "Idle Worker",
        createdAt: "2026-04-16T00:00:00.000Z",
        lastAttachedAt: "2026-04-16T00:00:00.000Z",
      },
    ]),
  );
  saveChildLink(childFile, {
    version: 1,
    childSessionFile: childFile,
    displayName: "Idle Worker",
    parent: {
      sessionId: parentSessionId,
      target: "Parent Session",
      attachedAt: "2026-04-16T00:00:00.000Z",
      sessionFile: parentFile,
    },
  });

  assert.equal(
    __test__.buildParentReportMessage("Finished the task.", childFile),
    "Finished the task.\n\n---\nTo reply, message `@idle-worker` over intercom.",
  );
});

test("agent_end auto-reports the final assistant text to the parent when the child stayed alive", async () => {
  const dir = createTempDir();
  const parentSessionId = "session-parent-auto-report";
  const parentFile = writeSessionFile(dir, "parent.jsonl", parentSessionId, { sessionName: "Parent Session" });
  const childFile = writeSessionFile(dir, "child.jsonl", "session-child-auto-report", { sessionName: "Child Session" });
  saveParentRegistry(
    getParentRegistryPath(dir, parentSessionId),
    createRegistry(parentSessionId, "Parent Session", [
      {
        handle: "child-session",
        sessionFile: childFile,
        displayName: "Child Session",
        createdAt: "2026-04-16T00:00:00.000Z",
        lastAttachedAt: "2026-04-16T00:00:00.000Z",
      },
    ]),
  );
  saveChildLink(childFile, {
    version: 1,
    childSessionFile: childFile,
    displayName: "Child Session",
    parent: {
      sessionId: parentSessionId,
      target: "Parent Session",
      attachedAt: "2026-04-16T00:00:00.000Z",
      sessionFile: parentFile,
    },
  });

  const reports: any[] = [];
  const harness = createHarness({
    sessionId: "session-child-auto-report",
    sessionDir: dir,
    sessionFile: childFile,
    sessionName: "Child Session",
    sendParentReport: async (input) => {
      reports.push(input);
    },
  });
  await harness.emit("session_start");

  await harness.emit("agent_start");
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [
      {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "Finished the implementation and verified the new tests." }],
      },
    ],
  });

  assert.deepEqual(reports, [
    {
      senderName: "Child Session",
      transportName: "Child Session via subagent-bridge",
      cwd: dir,
      model: "claude-sonnet-4",
      startedAt: reports[0]?.startedAt,
      to: "Parent Session",
      parentSessionId: "session-parent-auto-report",
      message: "Finished the implementation and verified the new tests.\n\n---\nTo reply, message `@child-session` over intercom.",
      childSessionId: "session-child-auto-report",
      childSessionFile: childFile,
    },
  ]);
  assert.equal(typeof reports[0]?.startedAt, "number");
});

test("agent_end does not auto-report when the final assistant turn already messages @parent", async () => {
  const dir = createTempDir();
  const childFile = writeSessionFile(dir, "child.jsonl", "session-child-no-duplicate");
  saveChildLink(childFile, {
    version: 1,
    childSessionFile: childFile,
    displayName: "Child",
    parent: {
      sessionId: "session-parent-no-duplicate",
      target: "Parent Session",
      attachedAt: "2026-04-16T00:00:00.000Z",
    },
  });

  const reports: any[] = [];
  const harness = createHarness({
    sessionId: "session-child-no-duplicate",
    sessionDir: dir,
    sessionFile: childFile,
    sendParentReport: async (input) => {
      reports.push(input);
    },
  });
  await harness.emit("session_start");

  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [
      {
        role: "assistant",
        stopReason: "stop",
        content: [
          { type: "text", text: "Done." },
          {
            type: "toolCall",
            name: "intercom",
            arguments: { action: "send", to: "@parent", message: "Done." },
          },
        ],
      },
    ],
  });

  assert.equal(reports.length, 0);
});

test("agent_end does not auto-report when intercom arguments are stringified json for @parent", async () => {
  const dir = createTempDir();
  const childFile = writeSessionFile(dir, "child.jsonl", "session-child-stringified-intercom");
  saveChildLink(childFile, {
    version: 1,
    childSessionFile: childFile,
    displayName: "Child",
    parent: {
      sessionId: "session-parent-stringified-intercom",
      target: "Parent Session",
      attachedAt: "2026-04-16T00:00:00.000Z",
    },
  });

  const reports: any[] = [];
  const harness = createHarness({
    sessionId: "session-child-stringified-intercom",
    sessionDir: dir,
    sessionFile: childFile,
    sendParentReport: async (input) => {
      reports.push(input);
    },
  });
  await harness.emit("session_start");

  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [
      {
        role: "assistant",
        stopReason: "stop",
        content: [
          { type: "text", text: "Done." },
          {
            type: "toolCall",
            name: "intercom",
            arguments: JSON.stringify({ action: "send", to: "@parent", message: "Done." }),
          },
        ],
      },
    ],
  });

  assert.equal(reports.length, 0);
});

test("agent_end does not auto-report when the final assistant turn intercoms the parent session id", async () => {
  const dir = createTempDir();
  const childFile = writeSessionFile(dir, "child.jsonl", "session-child-parent-id-target");
  saveChildLink(childFile, {
    version: 1,
    childSessionFile: childFile,
    displayName: "Child",
    parent: {
      sessionId: "session-parent-id-target",
      target: "Parent Session",
      attachedAt: "2026-04-16T00:00:00.000Z",
    },
  });

  const reports: any[] = [];
  const harness = createHarness({
    sessionId: "session-child-parent-id-target",
    sessionDir: dir,
    sessionFile: childFile,
    sendParentReport: async (input) => {
      reports.push(input);
    },
  });
  await harness.emit("session_start");

  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [
      {
        role: "assistant",
        stopReason: "stop",
        content: [
          { type: "text", text: "Done." },
          {
            type: "toolCall",
            name: "intercom",
            arguments: { action: "send", to: "session-parent-id-target", message: "Done." },
          },
        ],
      },
    ],
  });

  assert.equal(reports.length, 0);
});

test("agent_end does not auto-report when the final assistant turn is replying directly to a user", async () => {
  const dir = createTempDir();
  const childFile = writeSessionFile(dir, "child.jsonl", "session-child-user-reply");
  saveChildLink(childFile, {
    version: 1,
    childSessionFile: childFile,
    displayName: "Child",
    parent: {
      sessionId: "session-parent-user-reply",
      target: "Parent Session",
      attachedAt: "2026-04-16T00:00:00.000Z",
    },
  });

  const reports: any[] = [];
  const harness = createHarness({
    sessionId: "session-child-user-reply",
    sessionDir: dir,
    sessionFile: childFile,
    sendParentReport: async (input) => {
      reports.push(input);
    },
  });
  await harness.emit("session_start");

  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "Can you summarize what changed?" }],
      },
      {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "I updated the relay logic and tests." }],
      },
    ],
  });

  assert.equal(reports.length, 0);
});

test("agent_end still auto-reports when the final assistant turn intercoms someone else", async () => {
  const dir = createTempDir();
  const childFile = writeSessionFile(dir, "child.jsonl", "session-child-other-target");
  saveChildLink(childFile, {
    version: 1,
    childSessionFile: childFile,
    displayName: "Child",
    parent: {
      sessionId: "session-parent-other-target",
      target: "Parent Session",
      attachedAt: "2026-04-16T00:00:00.000Z",
    },
  });

  const reports: any[] = [];
  const harness = createHarness({
    sessionId: "session-child-other-target",
    sessionDir: dir,
    sessionFile: childFile,
    sendParentReport: async (input) => {
      reports.push(input);
    },
  });
  await harness.emit("session_start");

  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [
      {
        role: "assistant",
        stopReason: "stop",
        content: [
          { type: "text", text: "Wrapped up the task." },
          {
            type: "toolCall",
            name: "intercom",
            arguments: { action: "send", to: "@other-child", message: "FYI" },
          },
        ],
      },
    ],
  });

  assert.equal(reports.length, 1);
  assert.equal(reports[0].message, "Wrapped up the task.");
});

test("agent_end does not auto-report when the final assistant turn calls subagent_done", async () => {
  const dir = createTempDir();
  const childFile = writeSessionFile(dir, "child.jsonl", "session-child-done");
  saveChildLink(childFile, {
    version: 1,
    childSessionFile: childFile,
    displayName: "Child",
    parent: {
      sessionId: "session-parent-done",
      target: "Parent Session",
      attachedAt: "2026-04-16T00:00:00.000Z",
    },
  });

  const reports: any[] = [];
  const harness = createHarness({
    sessionId: "session-child-done",
    sessionDir: dir,
    sessionFile: childFile,
    sendParentReport: async (input) => {
      reports.push(input);
    },
  });
  await harness.emit("session_start");

  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [
      {
        role: "assistant",
        stopReason: "tool_use",
        content: [
          { type: "text", text: "All set." },
          { type: "toolCall", name: "subagent_done", arguments: {} },
        ],
      },
    ],
  });

  assert.equal(reports.length, 0);
});

test("agent_end does not auto-report when the final assistant turn calls subagent_done after a user turn", async () => {
  const dir = createTempDir();
  const childFile = writeSessionFile(dir, "child.jsonl", "session-child-done-after-user");
  saveChildLink(childFile, {
    version: 1,
    childSessionFile: childFile,
    displayName: "Child",
    parent: {
      sessionId: "session-parent-done-after-user",
      target: "Parent Session",
      attachedAt: "2026-04-16T00:00:00.000Z",
    },
  });

  const reports: any[] = [];
  const harness = createHarness({
    sessionId: "session-child-done-after-user",
    sessionDir: dir,
    sessionFile: childFile,
    sendParentReport: async (input) => {
      reports.push(input);
    },
  });
  await harness.emit("session_start");

  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "Please wrap up when you're done" }],
      },
      {
        role: "assistant",
        stopReason: "tool_use",
        content: [
          { type: "text", text: "All set." },
          { type: "toolCall", name: "subagent_done", arguments: {} },
        ],
      },
    ],
  });

  assert.equal(reports.length, 0);
});

test("agent_end does not auto-report when the final assistant turn calls caller_ping", async () => {
  const dir = createTempDir();
  const childFile = writeSessionFile(dir, "child.jsonl", "session-child-caller-ping");
  saveChildLink(childFile, {
    version: 1,
    childSessionFile: childFile,
    displayName: "Child",
    parent: {
      sessionId: "session-parent-caller-ping",
      target: "Parent Session",
      attachedAt: "2026-04-16T00:00:00.000Z",
    },
  });

  const reports: any[] = [];
  const harness = createHarness({
    sessionId: "session-child-caller-ping",
    sessionDir: dir,
    sessionFile: childFile,
    sendParentReport: async (input) => {
      reports.push(input);
    },
  });
  await harness.emit("session_start");

  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [
      {
        role: "assistant",
        stopReason: "tool_use",
        content: [
          { type: "text", text: "Need help." },
          { type: "toolCall", name: "caller_ping", arguments: { message: "Need help." } },
        ],
      },
    ],
  });

  assert.equal(reports.length, 0);
});

test("agent_end does not auto-report after user takeover", async () => {
  const dir = createTempDir();
  const childFile = writeSessionFile(dir, "child.jsonl", "session-child-takeover");
  saveChildLink(childFile, {
    version: 1,
    childSessionFile: childFile,
    displayName: "Child",
    parent: {
      sessionId: "session-parent-takeover",
      target: "Parent Session",
      attachedAt: "2026-04-16T00:00:00.000Z",
    },
  });

  const reports: any[] = [];
  const harness = createHarness({
    sessionId: "session-child-takeover",
    sessionDir: dir,
    sessionFile: childFile,
    sendParentReport: async (input) => {
      reports.push(input);
    },
  });
  await harness.emit("session_start");

  await harness.emit("agent_start");
  await harness.emit("input", { type: "input", source: "interactive", text: "Need one more tweak" });
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [
      {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "Finished." }],
      },
    ],
  });

  assert.equal(reports.length, 0);
});

test("agent_end still auto-reports after non-interactive input sources", async () => {
  const dir = createTempDir();
  const childFile = writeSessionFile(dir, "child.jsonl", "session-child-noninteractive-input");
  saveChildLink(childFile, {
    version: 1,
    childSessionFile: childFile,
    displayName: "Child",
    parent: {
      sessionId: "session-parent-noninteractive-input",
      target: "Parent Session",
      attachedAt: "2026-04-16T00:00:00.000Z",
    },
  });

  const reports: any[] = [];
  const harness = createHarness({
    sessionId: "session-child-noninteractive-input",
    sessionDir: dir,
    sessionFile: childFile,
    sendParentReport: async (input) => {
      reports.push(input);
    },
  });
  await harness.emit("session_start");

  await harness.emit("agent_start");
  await harness.emit("input", { type: "input", source: "rpc", text: "Follow-up automation" });
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [
      {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "Finished." }],
      },
    ],
  });

  assert.equal(reports.length, 1);
  assert.equal(reports[0].message, "Finished.");
});

test("interactive input between runs does not suppress the next run's fallback report", async () => {
  const dir = createTempDir();
  const childFile = writeSessionFile(dir, "child.jsonl", "session-child-two-runs");
  saveChildLink(childFile, {
    version: 1,
    childSessionFile: childFile,
    displayName: "Child",
    parent: {
      sessionId: "session-parent-two-runs",
      target: "Parent Session",
      attachedAt: "2026-04-16T00:00:00.000Z",
    },
  });

  const reports: any[] = [];
  const harness = createHarness({
    sessionId: "session-child-two-runs",
    sessionDir: dir,
    sessionFile: childFile,
    sendParentReport: async (input) => {
      reports.push(input);
    },
  });
  await harness.emit("session_start");

  await harness.emit("agent_start");
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [
      {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "First run done." }],
      },
    ],
  });

  await harness.emit("input", { type: "input", source: "interactive", text: "Do one more thing" });

  await harness.emit("agent_start");
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [
      {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "Second run done." }],
      },
    ],
  });

  assert.equal(reports.length, 2);
  assert.equal(reports[0].message, "First run done.");
  assert.equal(reports[1].message, "Second run done.");
});

test("agent_end does not auto-report aborted runs", async () => {
  const dir = createTempDir();
  const childFile = writeSessionFile(dir, "child.jsonl", "session-child-aborted");
  saveChildLink(childFile, {
    version: 1,
    childSessionFile: childFile,
    displayName: "Child",
    parent: {
      sessionId: "session-parent-aborted",
      target: "Parent Session",
      attachedAt: "2026-04-16T00:00:00.000Z",
    },
  });

  const reports: any[] = [];
  const harness = createHarness({
    sessionId: "session-child-aborted",
    sessionDir: dir,
    sessionFile: childFile,
    sendParentReport: async (input) => {
      reports.push(input);
    },
  });
  await harness.emit("session_start");

  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [
      {
        role: "assistant",
        stopReason: "aborted",
        content: [{ type: "text", text: "Partial draft." }],
      },
    ],
  });

  assert.equal(reports.length, 0);
});

test("agent_end does not auto-report when auto-exit mode is enabled", async () => {
  process.env.PI_SUBAGENT_AUTO_EXIT = "1";

  const dir = createTempDir();
  const childFile = writeSessionFile(dir, "child.jsonl", "session-child-auto-exit");
  saveChildLink(childFile, {
    version: 1,
    childSessionFile: childFile,
    displayName: "Child",
    parent: {
      sessionId: "session-parent-auto-exit",
      target: "Parent Session",
      attachedAt: "2026-04-16T00:00:00.000Z",
    },
  });

  const reports: any[] = [];
  const harness = createHarness({
    sessionId: "session-child-auto-exit",
    sessionDir: dir,
    sessionFile: childFile,
    sendParentReport: async (input) => {
      reports.push(input);
    },
  });
  await harness.emit("session_start");

  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [
      {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "Finished." }],
      },
    ],
  });

  assert.equal(reports.length, 0);
});

test("agent_end respects config opt-out", async () => {
  const dir = createTempDir();
  const childFile = writeSessionFile(dir, "child.jsonl", "session-child-config-opt-out");
  saveChildLink(childFile, {
    version: 1,
    childSessionFile: childFile,
    displayName: "Child",
    parent: {
      sessionId: "session-parent-config-opt-out",
      target: "Parent Session",
      attachedAt: "2026-04-16T00:00:00.000Z",
    },
  });

  const reports: any[] = [];
  const harness = createHarness({
    sessionId: "session-child-config-opt-out",
    sessionDir: dir,
    sessionFile: childFile,
    bridgeConfig: { autoReportToParentOnAgentEnd: false },
    sendParentReport: async (input) => {
      reports.push(input);
    },
  });
  await harness.emit("session_start");

  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [
      {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "Finished." }],
      },
    ],
  });

  assert.equal(reports.length, 0);
});
