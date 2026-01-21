import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { findMatchingWindow, parseRootList, parseWindowList } from "../binding.js";

const HOME = os.homedir();

test("parseWindowList parses workspaces with suffixes and instances", () => {
  const input = [
    "- Window `1` • WS: chat-tree (5) • Roots: 1 • instance=1",
    "- Window `3` • WS: dot314 • Roots: 2 • instance=4",
    "- Window `4` • WS: wave-metrics (4) • Roots: 1",
  ].join("\n");

  const windows = parseWindowList(input);

  assert.equal(windows.length, 3);
  assert.deepEqual(
    windows.map((w) => ({ id: w.id, workspace: w.workspace, instance: w.instance })),
    [
      { id: 1, workspace: "chat-tree (5)", instance: 1 },
      { id: 3, workspace: "dot314", instance: 4 },
      { id: 4, workspace: "wave-metrics (4)", instance: undefined },
    ]
  );
});

test("parseRootList handles bullets, file:// URIs, and ~", () => {
  const absPath = path.join(HOME, "dot314");
  const fileUriPath = path.join(HOME, "pi-mono");
  const fileUri = pathToFileURL(fileUriPath).toString();

  const input = [
    `- ${absPath}`,
    `• ${fileUri}`,
    "~/.config",
  ].join("\n");

  const roots = parseRootList(input);

  assert.ok(roots.includes(absPath));
  assert.ok(roots.includes(fileUriPath));
  assert.ok(roots.includes(path.join(HOME, ".config")));
});

test("findMatchingWindow prefers the most specific matching root per window", () => {
  const dot314Root = path.join(HOME, "dot314");
  const piMonoRoot = path.join(HOME, "pi-mono");

  const windows = [
    {
      id: 1,
      workspace: "A",
      roots: [HOME, dot314Root],
    },
    {
      id: 2,
      workspace: "B",
      roots: [piMonoRoot],
    },
  ];

  const result = findMatchingWindow(windows, path.join(dot314Root, "agent", "extensions"));

  assert.equal(result.ambiguous, false);
  assert.equal(result.window?.id, 1);
  assert.equal(result.root, dot314Root);
});

test("findMatchingWindow matches when cwd equals the root", () => {
  const dot314Root = path.join(HOME, "dot314");

  const windows = [
    {
      id: 1,
      workspace: "A",
      roots: [dot314Root],
    },
  ];

  const result = findMatchingWindow(windows, dot314Root);

  assert.equal(result.ambiguous, false);
  assert.equal(result.window?.id, 1);
  assert.equal(result.root, dot314Root);
});

test("findMatchingWindow returns null when cwd is outside all roots", () => {
  const dot314Root = path.join(HOME, "dot314");

  const windows = [
    {
      id: 1,
      workspace: "A",
      roots: [dot314Root],
    },
  ];

  const result = findMatchingWindow(windows, path.join(HOME, "somewhere-else"));

  assert.equal(result.ambiguous, false);
  assert.equal(result.window, null);
  assert.equal(result.root, null);
  assert.equal(result.matches.length, 0);
});

test("findMatchingWindow returns ambiguous when best match is tied across windows", () => {
  const dot314Root = path.join(HOME, "dot314");

  const windows = [
    {
      id: 1,
      workspace: "A",
      roots: [dot314Root],
    },
    {
      id: 2,
      workspace: "B",
      roots: [dot314Root],
    },
  ];

  const result = findMatchingWindow(windows, path.join(dot314Root, "agent"));

  assert.equal(result.ambiguous, true);
  assert.equal(result.window, null);
  assert.equal(result.root, null);
  assert.equal(result.matches.length, 2);
});
