import assert from "node:assert/strict";
import test from "node:test";

import { normalizeToolName, resolveToolName } from "../dist/tool-names.js";

test("normalizeToolName strips common prefixes", () => {
  assert.equal(normalizeToolName("RepoPrompt_read_file"), "read_file");
  assert.equal(normalizeToolName("rp_read_file"), "read_file");
  assert.equal(normalizeToolName("read_file"), "read_file");
});

test("resolveToolName finds prefixed tool names", () => {
  const tools = [{ name: "RepoPrompt_read_file" }];
  assert.equal(resolveToolName(tools, "read_file"), "RepoPrompt_read_file");
});

test("resolveToolName finds exact tool names", () => {
  const tools = [{ name: "read_file" }];
  assert.equal(resolveToolName(tools, "read_file"), "read_file");
});

test("resolveToolName returns null when tool is missing", () => {
  const tools = [{ name: "RepoPrompt_read_file" }];
  assert.equal(resolveToolName(tools, "get_file_tree"), null);
});
