import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";

import {
  getAppCliCommand,
  getAppLabel,
  getAppTargetConfig,
  getServerCommand,
  inferAppPath,
  loadConfig,
} from "../dist/config.js";

function withTempHome(name, fn) {
  return async () => {
    const originalHome = process.env.HOME;
    const tempHome = mkdtempSync(path.join(os.tmpdir(), name));
    process.env.HOME = tempHome;

    try {
      await fn(tempHome);
    } finally {
      process.env.HOME = originalHome;
      rmSync(tempHome, { recursive: true, force: true });
    }
  };
}

function writeExtensionConfig(home, config) {
  const configDir = path.join(home, ".pi", "agent", "extensions");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(path.join(configDir, "repoprompt-mcp.json"), JSON.stringify(config));
}

test("loadConfig defaults to RepoPrompt CE with CE and Classic targets", withTempHome("rp-config-default-home-", () => {
  const config = loadConfig();
  const ceTarget = getAppTargetConfig(config, "ce");
  const classicTarget = getAppTargetConfig(config, "classic");

  assert.equal(config.activeApp, "ce");
  assert.equal(getAppLabel(config), "RepoPrompt CE");
  assert.equal(getAppCliCommand("ce"), "rpce-cli");
  assert.equal(ceTarget.appPath, "/Applications/RepoPrompt CE.app");
  assert.equal(ceTarget.autoLaunchApp, true);
  assert.deepEqual(ceTarget.args, []);
  assert.equal(getAppLabel(config, "classic"), "RepoPrompt Classic");
  assert.equal(getAppCliCommand("classic"), "rp-cli");
  assert.equal(classicTarget.appPath, "/Applications/Repo Prompt.app");
  assert.equal(classicTarget.autoLaunchApp, true);
  assert.deepEqual(classicTarget.args, []);
}));

test("getServerCommand uses explicit per-target Classic command, args, and env", withTempHome("rp-config-classic-home-", (home) => {
  writeExtensionConfig(home, {
    activeApp: "classic",
    suppressHostDisconnectedLog: false,
    apps: {
      classic: {
        command: "classic-mcp",
        args: ["--stdio"],
        env: { REPOPROMPT_PROFILE: "classic" },
        appPath: "/Applications/Repo Prompt.app",
      },
    },
  });

  const config = loadConfig();

  assert.equal(config.activeApp, "classic");
  assert.deepEqual(getServerCommand(config), { command: "classic-mcp", args: ["--stdio"] });
  assert.deepEqual(getAppTargetConfig(config, "classic").env, { REPOPROMPT_PROFILE: "classic" });
}));

test("getServerCommand discovers app-specific MCP config names", withTempHome("rp-config-mcp-home-", (home) => {
  const agentDir = path.join(home, ".pi", "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    path.join(agentDir, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        "repoprompt-ce": {
          command: "ce-from-mcp-config",
          args: ["--proxy"],
        },
        "repoprompt-classic": {
          command: "classic-from-mcp-config",
          args: [],
        },
      },
    })
  );

  const config = loadConfig({ suppressHostDisconnectedLog: false });

  assert.deepEqual(getServerCommand(config, "ce"), { command: "ce-from-mcp-config", args: ["--proxy"] });
  assert.deepEqual(getServerCommand(config, "classic"), { command: "classic-from-mcp-config", args: [] });
}));

test("getServerCommand derives the target app bundle command without mcp-server assumptions", withTempHome("rp-config-bundle-home-", (home) => {
  const originalPath = process.env.PATH;
  process.env.PATH = home;

  try {
    const appPath = path.join(home, "RepoPrompt CE.app");
    const bundleCommand = path.join(appPath, "Contents", "MacOS", "repoprompt-mcp");
    mkdirSync(path.dirname(bundleCommand), { recursive: true });
    writeFileSync(bundleCommand, "#!/bin/sh\n");

    const config = loadConfig({
      suppressHostDisconnectedLog: false,
      apps: {
        ce: {
          appPath,
        },
      },
    });

    assert.deepEqual(getServerCommand(config, "ce"), { command: bundleCommand, args: [] });
    assert.equal(inferAppPath(config, "ce"), appPath);
  } finally {
    process.env.PATH = originalPath;
  }
}));

test("getServerCommand filters clean stdin-close ledger stderr from app bundle MCP command", withTempHome("rp-config-filter-home-", (home) => {
  const appPath = path.join(home, "RepoPrompt CE.app");
  const bundleCommand = path.join(appPath, "Contents", "MacOS", "repoprompt-mcp");
  mkdirSync(path.dirname(bundleCommand), { recursive: true });
  writeFileSync(bundleCommand, "#!/bin/sh\n");

  const config = loadConfig({
    apps: {
      ce: {
        appPath,
      },
    },
  });

  const server = getServerCommand(config, "ce");

  if (process.platform === "darwin") {
    assert.equal(server?.command, "/bin/bash");
    assert.equal(server?.args[0], "-lc");
    assert.match(server?.args[1] ?? "", /terminal_reason=stdin_closed/);
  } else {
    assert.deepEqual(server, { command: bundleCommand, args: [] });
  }
}));

test("inferAppPath prefers explicit per-target app path", withTempHome("rp-config-app-path-home-", () => {
  const config = loadConfig({
    apps: {
      ce: {
        appPath: "/tmp/Explicit CE.app",
      },
      classic: {
        appPath: "/tmp/Explicit Classic.app",
      },
    },
  });

  assert.equal(inferAppPath(config, "ce"), "/tmp/Explicit CE.app");
  assert.equal(inferAppPath(config, "classic"), "/tmp/Explicit Classic.app");
}));
