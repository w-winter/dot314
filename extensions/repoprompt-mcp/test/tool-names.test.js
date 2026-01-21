import assert from "node:assert/strict";
import test from "node:test";

import { normalizeToolName, resolveToolName } from "../tool-names.js";

test("normalizeToolName strips common prefixes", () => {
  assert.equal(normalizeToolName("RepoPrompt_list_windows"), "list_windows");
  assert.equal(normalizeToolName("rp_list_windows"), "list_windows");
  assert.equal(normalizeToolName("list_windows"), "list_windows");
});

test("resolveToolName finds prefixed tool names", () => {
  const tools = [{ name: "RepoPrompt_list_windows" }];
  assert.equal(resolveToolName(tools, "list_windows"), "RepoPrompt_list_windows");
});

test("resolveToolName finds exact tool names", () => {
  const tools = [{ name: "list_windows" }];
  assert.equal(resolveToolName(tools, "list_windows"), "list_windows");
});

test("resolveToolName returns null when tool is missing", () => {
  const tools = [{ name: "RepoPrompt_list_windows" }];
  assert.equal(resolveToolName(tools, "get_file_tree"), null);
});
