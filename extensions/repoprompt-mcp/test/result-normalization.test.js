import assert from "node:assert/strict";
import test from "node:test";

import { normalizeToolResultText } from "../dist/result-normalization.js";

const verboseApplyEditsOutput = [
  "## Apply Edits",
  "",
  "### Unified Diff",
  "```diff",
  "--- a/demo.txt",
  "+++ b/demo.txt",
  "@@ -1 +1 @@",
  "-old value",
  "+new value",
  "```",
].join("\n");

const extractedDiff = [
  "--- a/demo.txt",
  "+++ b/demo.txt",
  "@@ -1 +1 @@",
  "-old value",
  "+new value",
].join("\n");

test("normalizeToolResultText extracts verbose apply_edits diffs into details", () => {
  const normalized = normalizeToolResultText({
    toolName: "apply_edits",
    text: verboseApplyEditsOutput,
  });

  assert.ok(normalized);
  assert.equal(normalized.contentText, "Applied edits • +1 -1 • 1 hunk • 1 file");
  assert.equal(normalized.details.diff, extractedDiff);
  assert.deepEqual(normalized.details.diffStats, {
    added: 1,
    removed: 1,
    hunks: 1,
    files: 1,
  });
});

test("normalizeToolResultText leaves non-verbose apply_edits output untouched", () => {
  assert.equal(
    normalizeToolResultText({
      toolName: "apply_edits",
      text: "✅ Applied 1 edit",
    }),
    null
  );
});
