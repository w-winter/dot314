import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";

import repopromptMcp from "../dist/index.js";
import { clearBinding } from "../dist/binding.js";
import { RpClient, resetRpClient } from "../dist/client.js";
import { BINDING_ENTRY_TYPE } from "../dist/types.js";
import { catalog as ceCatalog } from "./fixtures/ce-1.2/evidence.js";

function makeTextResult(text) {
  return {
    isError: false,
    content: [{ type: "text", text }],
  };
}

function createMockPi() {
  const tools = new Map();
  const entries = [];

  return {
    events: { on() {}, emit() {} },
    on() {},
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
    entries,
  };
}

test("rp streamed partial updates always include a text content block", async () => {
  const originalHome = process.env.HOME;
  const tempHome = mkdtempSync(path.join(os.tmpdir(), "rp-update-shape-home-"));
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "rp-update-shape-root-"));
  process.env.HOME = tempHome;

  const originalConnect = RpClient.prototype.connect;
  const originalClose = RpClient.prototype.close;
  const originalCallTool = RpClient.prototype.callTool;

  try {
    mkdirSync(path.join(tempHome, ".pi", "agent", "extensions"), { recursive: true });
    writeFileSync(
      path.join(tempHome, ".pi", "agent", "extensions", "repoprompt-mcp.json"),
      JSON.stringify({
        activeApp: "ce",
        apps: {
          ce: {
            command: "fake-rp",
            args: [],
          },
        },
        suppressHostDisconnectedLog: false,
      })
    );

    await resetRpClient();
    clearBinding();

    RpClient.prototype.connect = async function connect() {
      this.client = {};
      this.transport = {};
      this._status = "connected";
      this._tools = [
        ...ceCatalog.tools
          .filter((tool) => tool.name === "bind_context" || tool.name === "manage_workspaces")
          .map((tool) => structuredClone(tool)),
        { name: "read_file", description: "", inputSchema: { type: "object" } },
      ];
      this.publishedToolListGeneration = this.toolListInvalidationGeneration;
    };

    RpClient.prototype.close = async function close() {
      this.client = null;
      this.transport = null;
      this._status = "disconnected";
      this._tools = [];
    };

    RpClient.prototype.callTool = async function callTool(name, args = {}) {
      if (name === "bind_context" && args.op === "list") {
        return makeTextResult(JSON.stringify({
          windows: [{
            window_id: 7,
            workspace: { id: "workspace-7", name: "repo" },
            active_context_id: "TAB-1",
            tabs: [{
              context_id: "TAB-1",
              name: "Pi Session",
              is_active: true,
              is_bound: true,
              selected_file_count: 0,
              repo_paths: [repoRoot],
            }],
          }],
          binding: { binding_kind: "tab_context", window_id: 7, context_id: "TAB-1" },
        }));
      }
      if (name === "read_file") {
        return makeTextResult(`## File Read ✅\n- **Path**: \`${args.path}\``);
      }

      throw new Error(`Unexpected tool call: ${name} ${JSON.stringify(args)}`);
    };

    const pi = createMockPi();
    pi.entries.push({
      type: "custom",
      customType: BINDING_ENTRY_TYPE,
      data: { app: "ce", windowId: 7, workspace: "repo", tab: "TAB-1" },
    });
    repopromptMcp(pi);

    const rpTool = pi.getTool("rp");
    assert.ok(rpTool, "rp tool should be registered");

    const updates = [];
    const result = await rpTool.execute(
      "call-1",
      { call: "read_file", args: { path: "src/App.tsx", start_line: 1, limit: 40 } },
      undefined,
      (update) => updates.push(update),
      {
        hasUI: false,
        cwd: repoRoot,
        sessionManager: {
          getBranch() {
            return pi.entries;
          },
          getSessionFile() {
            return path.join(repoRoot, "session.jsonl");
          },
          getSessionId() {
            return "session-id";
          },
          getLeafId() {
            return "leaf-id";
          },
        },
      }
    );

    assert.equal(result.isError, false, result.content[0]?.text);
    assert.equal(updates.length, 1);
    assert.ok(Array.isArray(updates[0].content));
    assert.equal(updates[0].content[0]?.type, "text");
    assert.match(updates[0].content[0]?.text ?? "", /Calling read_file/u);
  } finally {
    RpClient.prototype.connect = originalConnect;
    RpClient.prototype.close = originalClose;
    RpClient.prototype.callTool = originalCallTool;
    process.env.HOME = originalHome;
    await resetRpClient();
    clearBinding();
    rmSync(tempHome, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
