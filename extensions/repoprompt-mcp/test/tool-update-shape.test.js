import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";

import repopromptMcp from "../dist/index.js";
import { clearBinding } from "../dist/binding.js";
import { RpClient, resetRpClient } from "../dist/client.js";

function makeTextResult(text) {
  return {
    isError: false,
    content: [{ type: "text", text }],
  };
}

function createMockPi() {
  const tools = new Map();

  return {
    on() {},
    registerCommand() {},
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    getTool(name) {
      return tools.get(name);
    },
    appendEntry() {},
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
      JSON.stringify({ command: "fake-rp", args: [], suppressHostDisconnectedLog: false })
    );

    await resetRpClient();
    clearBinding();

    RpClient.prototype.connect = async function connect() {
      this.client = {};
      this.transport = {};
      this._status = "connected";
      this._tools = [{ name: "read_file", description: "" }];
    };

    RpClient.prototype.close = async function close() {
      this.client = null;
      this.transport = null;
      this._status = "disconnected";
      this._tools = [];
    };

    RpClient.prototype.callTool = async function callTool(name, args = {}) {
      if (name === "read_file") {
        return makeTextResult(`## File Read ✅\n- **Path**: \`${args.path}\``);
      }

      throw new Error(`Unexpected tool call: ${name} ${JSON.stringify(args)}`);
    };

    const pi = createMockPi();
    repopromptMcp(pi);

    const rpTool = pi.getTool("rp");
    assert.ok(rpTool, "rp tool should be registered");

    const updates = [];
    await rpTool.execute(
      "call-1",
      { call: "read_file", args: { path: "src/App.tsx", start_line: 1, limit: 40 } },
      undefined,
      (update) => updates.push(update),
      {
        hasUI: false,
        cwd: repoRoot,
        sessionManager: {
          getBranch() {
            return [];
          },
        },
      }
    );

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
