import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";

import repopromptMcp from "../dist/index.js";
import { clearBinding } from "../dist/binding.js";
import { getRpClient, resetRpClient } from "../dist/client.js";
import { AUTO_SELECTION_ENTRY_TYPE, BINDING_ENTRY_TYPE } from "../dist/types.js";

function makeTextResult(text) {
  return {
    isError: false,
    content: [{ type: "text", text }],
  };
}

function renderTabs(tabs) {
  return [
    "## Tabs ✅",
    "",
    ...tabs.flatMap((tab) => {
      const states = [];
      if (tab.active) states.push("active");
      if (tab.bound) states.push("bound");
      const stateText = states.length > 0 ? ` [${states.join(", ")}]` : "";
      return [
        `- \`${tab.id}\` • ${tab.name}${stateText}`,
        `  • ${tab.files} files`,
      ];
    }),
  ].join("\n");
}

function renderContexts(tabs) {
  return tabs
    .map((tab) => {
      const states = [];
      if (tab.active) states.push("active");
      if (tab.bound) states.push("bound");
      const stateText = states.length > 0 ? ` [${states.join(", ")}]` : "";
      return `- ${tab.name}${stateText} — context_id: \`${tab.id}\``;
    })
    .join("\n");
}

function createDeferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createMockPi(entries) {
  const handlers = new Map();
  const tools = new Map();

  return {
    on(event, handler) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
    registerCommand() {},
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    getTool(name) {
      return tools.get(name);
    },
    appendEntry(customType, data) {
      entries.push({ type: "custom", customType, data });
    },
    async emit(event, ctx, eventData = {}) {
      for (const handler of handlers.get(event) ?? []) {
        await handler({ type: event, ...eventData }, ctx);
      }
    },
  };
}

async function drainStartupReplay() {
  for (let i = 0; i < 4; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("concurrent rp read_file calls persist cumulative auto-selection state", async () => {
  const originalHome = process.env.HOME;
  const tempHome = mkdtempSync(path.join(os.tmpdir(), "rp-concurrent-auto-select-home-"));
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "rp-concurrent-auto-select-root-"));
  const repoRoot = path.join(tempRoot, "chat-tree");
  process.env.HOME = tempHome;

  try {
    mkdirSync(path.join(tempHome, ".pi", "agent", "extensions"), { recursive: true });
    writeFileSync(
      path.join(tempHome, ".pi", "agent", "extensions", "repoprompt-mcp.json"),
      JSON.stringify({
        command: "fake-rp",
        args: [],
        suppressHostDisconnectedLog: false,
      })
    );

    mkdirSync(path.join(repoRoot, "src", "components"), { recursive: true });
    mkdirSync(path.join(repoRoot, "src", "hooks"), { recursive: true });
    writeFileSync(path.join(repoRoot, "src", "App.tsx"), "export default function App() {}\n");
    writeFileSync(path.join(repoRoot, "src", "main.tsx"), "console.log('main')\n");
    writeFileSync(path.join(repoRoot, "src", "hooks", "useConversationTree.ts"), "export const useConversationTree = () => null\n");
    writeFileSync(
      path.join(repoRoot, "src", "components", "ConversationTree.tsx"),
      `${Array.from({ length: 220 }, (_, index) => `line ${index + 1}`).join("\n")}\n`
    );

    await resetRpClient();
    clearBinding();

    const branchEntries = [
      {
        type: "custom",
        customType: BINDING_ENTRY_TYPE,
        data: { windowId: 19, workspace: "chat-tree" },
      },
      {
        type: "custom",
        customType: BINDING_ENTRY_TYPE,
        data: { windowId: 19, tab: "TAB-1", workspace: "chat-tree" },
      },
    ];

    const pi = createMockPi(branchEntries);
    repopromptMcp(pi);

    const selectionState = {
      fullPaths: new Set(),
      slicePaths: new Map(),
    };
    const pendingReadResults = createDeferred();
    let readResultCount = 0;

    const client = getRpClient();
    client.connect = async () => {
      client.client = {};
      client.transport = {};
      client._status = "connected";
      client._tools = [
        { name: "list_windows", description: "" },
        { name: "manage_workspaces", description: "" },
        { name: "bind_context", description: "" },
        { name: "manage_selection", description: "" },
        { name: "read_file", description: "" },
      ];
    };
    client.close = async () => {
      client.client = null;
      client.transport = null;
      client._status = "disconnected";
      client._tools = [];
    };
    client.callTool = async (name, args = {}) => {
      if (name === "list_windows") {
        return makeTextResult("- Window `19` • WS: chat-tree • Roots: 1");
      }

      if (name === "bind_context" && args.op === "list") {
        return makeTextResult(renderContexts([
          { id: "TAB-1", name: "T1", active: true, bound: true, files: selectionState.fullPaths.size + selectionState.slicePaths.size },
        ]));
      }

      if (name === "bind_context" && args.op === "bind") {
        return makeTextResult(`Bound context \`${args.context_id}\``);
      }

      if (name === "manage_workspaces" && args.action === "list_tabs") {
        return makeTextResult(renderTabs([
          { id: "TAB-1", name: "T1", active: true, bound: true, files: selectionState.fullPaths.size + selectionState.slicePaths.size },
        ]));
      }

      if (name === "read_file") {
        readResultCount += 1;
        if (readResultCount === 4) {
          pendingReadResults.resolve();
        }
        await pendingReadResults.promise;
        return makeTextResult(`## File Read ✅\n- **Path**: \`chat-tree/${args.path}\``);
      }

      if (name !== "manage_selection") {
        throw new Error(`Unexpected tool: ${name} ${JSON.stringify(args)}`);
      }

      if (args.op === "get") {
        await new Promise((resolve) => setImmediate(resolve));
        return makeTextResult("");
      }

      if (args.op === "remove") {
        for (const pathKey of args.paths ?? []) {
          selectionState.fullPaths.delete(pathKey);
          selectionState.slicePaths.delete(pathKey);
        }
        return makeTextResult("Selection updated");
      }

      if (args.op === "add" && args.mode === "full") {
        for (const pathKey of args.paths ?? []) {
          selectionState.slicePaths.delete(pathKey);
          selectionState.fullPaths.add(pathKey);
        }
        return makeTextResult("Selection updated");
      }

      if (args.op === "add" && Array.isArray(args.slices)) {
        for (const slice of args.slices) {
          selectionState.fullPaths.delete(slice.path);
          selectionState.slicePaths.set(slice.path, slice.ranges);
        }
        return makeTextResult("Selection updated");
      }

      throw new Error(`Unexpected manage_selection args: ${JSON.stringify(args)}`);
    };

    const ctx = {
      hasUI: false,
      cwd: repoRoot,
      sessionManager: {
        getBranch() {
          return branchEntries;
        },
        getSessionFile() {
          return path.join(tempRoot, "session.jsonl");
        },
        getSessionId() {
          return "session-id";
        },
        getLeafId() {
          return "leaf-id";
        },
      },
    };

    await pi.emit("session_start", ctx, { reason: "startup" });
    await drainStartupReplay();

    const rpTool = pi.getTool("rp");
    assert.ok(rpTool, "rp tool should be registered");

    await Promise.all([
      rpTool.execute("call-1", { call: "read_file", args: { path: "src/App.tsx", start_line: 1, limit: 160 } }, undefined, () => {}, ctx),
      rpTool.execute("call-2", { call: "read_file", args: { path: "src/main.tsx", start_line: 1, limit: 120 } }, undefined, () => {}, ctx),
      rpTool.execute("call-3", { call: "read_file", args: { path: "src/hooks/useConversationTree.ts", start_line: 1, limit: 180 } }, undefined, () => {}, ctx),
      rpTool.execute("call-4", { call: "read_file", args: { path: "src/components/ConversationTree.tsx", start_line: 1, limit: 180 } }, undefined, () => {}, ctx),
    ]);

    const autoSelectionEntries = branchEntries.filter(
      (entry) => entry.type === "custom" && entry.customType === AUTO_SELECTION_ENTRY_TYPE
    );

    assert.equal(autoSelectionEntries.length, 4);
    assert.deepEqual(autoSelectionEntries.map((entry) => entry.data), [
      {
        windowId: 19,
        tab: "TAB-1",
        workspace: "chat-tree",
        fullPaths: ["src/App.tsx"],
        slicePaths: [],
      },
      {
        windowId: 19,
        tab: "TAB-1",
        workspace: "chat-tree",
        fullPaths: ["src/App.tsx", "src/main.tsx"],
        slicePaths: [],
      },
      {
        windowId: 19,
        tab: "TAB-1",
        workspace: "chat-tree",
        fullPaths: [
          "src/App.tsx",
          "src/hooks/useConversationTree.ts",
          "src/main.tsx",
        ],
        slicePaths: [],
      },
      {
        windowId: 19,
        tab: "TAB-1",
        workspace: "chat-tree",
        fullPaths: [
          "src/App.tsx",
          "src/hooks/useConversationTree.ts",
          "src/main.tsx",
        ],
        slicePaths: [
          {
            path: "src/components/ConversationTree.tsx",
            ranges: [{ start_line: 1, end_line: 180 }],
          },
        ],
      },
    ]);
  } finally {
    process.env.HOME = originalHome;
    await resetRpClient();
    clearBinding();
    rmSync(tempHome, { recursive: true, force: true });
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
