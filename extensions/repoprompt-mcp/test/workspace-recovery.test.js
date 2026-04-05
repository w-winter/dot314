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

function renderRoots(roots) {
  return roots.map((rootPath) => `- ${rootPath}`).join("\n");
}

function createMockPi(entries) {
  const handlers = new Map();

  return {
    on(event, handler) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
    registerCommand() {},
    registerTool() {},
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

test("session_start recovers selection into a different live workspace that contains the required roots", async () => {
  const originalHome = process.env.HOME;
  const tempHome = mkdtempSync(path.join(os.tmpdir(), "rp-workspace-recovery-home-"));
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "rp-workspace-recovery-root-"));
  const repoRoot = path.join(tempRoot, "chat-tree");
  const otherRoot = path.join(tempRoot, "other-repo");
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

    mkdirSync(path.join(repoRoot, "src"), { recursive: true });
    mkdirSync(otherRoot, { recursive: true });
    writeFileSync(path.join(repoRoot, "src", "App.tsx"), "export default function App() {}\n");
    writeFileSync(path.join(repoRoot, "src", "main.tsx"), "console.log('main')\n");

    await resetRpClient();
    clearBinding();

    const branchEntries = [
      {
        type: "custom",
        customType: BINDING_ENTRY_TYPE,
        data: { windowId: 5, workspace: "old-chat-tree-workspace", tab: "TAB-OLD" },
      },
      {
        type: "custom",
        customType: AUTO_SELECTION_ENTRY_TYPE,
        data: {
          windowId: 5,
          workspace: "old-chat-tree-workspace",
          tab: "TAB-OLD",
          fullPaths: ["chat-tree/src/App.tsx", "chat-tree/src/main.tsx"],
          slicePaths: [],
        },
      },
    ];

    const pi = createMockPi(branchEntries);
    repopromptMcp(pi);

    const calls = [];
    const tabsByWindow = new Map([
      [11, [{ id: "TAB-BLANK", name: "T1", active: true, bound: false, files: 0 }]],
      [12, [{ id: "TAB-OTHER", name: "T1", active: true, bound: false, files: 0 }]],
    ]);

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
        { name: "get_file_tree", description: "" },
        { name: "chats", description: "" },
      ];
    };
    client.close = async () => {
      client.client = null;
      client.transport = null;
      client._status = "disconnected";
      client._tools = [];
    };
    client.callTool = async (name, args = {}) => {
      calls.push({ name, args });

      if (name === "list_windows") {
        return makeTextResult([
          "- Window `11` • WS: curated-chat-tree • Roots: 1",
          "- Window `12` • WS: unrelated-workspace • Roots: 1",
        ].join("\n"));
      }

      if (name === "get_file_tree" && args.type === "roots") {
        if (args._windowID === 11) {
          return makeTextResult(renderRoots([repoRoot]));
        }
        if (args._windowID === 12) {
          return makeTextResult(renderRoots([otherRoot]));
        }
      }

      if (name === "chats") {
        return makeTextResult([
          "## Chats ✅",
          "- **Count**: 0",
          "- **Scope**: tab",
          `- **Tab**: \`${args.tab_id}\``,
        ].join("\n"));
      }

      if (name === "manage_selection") {
        return makeTextResult("Selection updated");
      }

      if (name === "bind_context" && args.op === "list") {
        return makeTextResult(renderContexts(tabsByWindow.get(args.window_id) ?? []));
      }

      if (name === "bind_context" && args.op === "bind") {
        return makeTextResult(`Bound context \`${args.context_id}\``);
      }

      if (name === "manage_workspaces" && args.action === "list_tabs") {
        return makeTextResult(renderTabs(tabsByWindow.get(args._windowID) ?? []));
      }

      if (name === "manage_workspaces" && args.action === "create_tab") {
        const tabs = tabsByWindow.get(args._windowID) ?? [];
        tabs.push({ id: "TAB-NEW", name: "Pi Session", active: false, bound: true, files: 0 });
        tabsByWindow.set(args._windowID, tabs);
        return makeTextResult("Created tab `TAB-NEW` • Pi Session [bound]");
      }

      if (name === "manage_workspaces" && args.action === "select_tab") {
        const tabs = tabsByWindow.get(args._windowID) ?? [];
        for (const tab of tabs) {
          tab.active = tab.id === args.tab;
          if (tab.id === args.tab) {
            tab.bound = true;
          }
        }
        return makeTextResult(`Selected tab \`${args.tab}\``);
      }

      throw new Error(`Unexpected tool call: ${name} ${JSON.stringify(args)}`);
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

    const selectionAdds = calls.filter(
      (call) => call.name === "manage_selection" && call.args.op === "add" && call.args.mode === "full"
    );

    assert.equal(selectionAdds.length, 1);
    assert.equal(selectionAdds[0].args._windowID, 11);
    assert.notEqual(selectionAdds[0].args._tabID, "TAB-OLD");
    assert.deepEqual(selectionAdds[0].args.paths, ["chat-tree/src/App.tsx", "chat-tree/src/main.tsx"]);

    const bindingEntries = branchEntries.filter(
      (entry) => entry.type === "custom" && entry.customType === BINDING_ENTRY_TYPE
    );
    assert.deepEqual(bindingEntries.at(-1)?.data, {
      windowId: 11,
      workspace: "curated-chat-tree",
      tab: "TAB-NEW",
    });
  } finally {
    process.env.HOME = originalHome;
    await resetRpClient();
    clearBinding();
    rmSync(tempHome, { recursive: true, force: true });
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
