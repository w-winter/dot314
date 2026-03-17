import assert from "node:assert/strict";
import test from "node:test";

import { normalizeFileActionResult } from "../dist/file-action-normalization.js";

test("normalizeFileActionResult synthesizes a compact create diff with softer add highlight ratio", () => {
  const normalized = normalizeFileActionResult({
    action: "create",
    path: "src/demo.ts",
    content: "export const value = 1;\n",
  });

  assert.ok(normalized);
  assert.equal(normalized.filePath, "src/demo.ts");
  assert.equal(normalized.contentText, "Created file • 1 line");
  assert.equal(normalized.addRowBgMixRatio, 0.16);
  assert.equal(normalized.removeRowBgMixRatio, undefined);
  assert.match(normalized.diff, /^created file src\/demo\.ts$/m);
  assert.doesNotMatch(normalized.diff, /^diff --git /m);
  assert.doesNotMatch(normalized.diff, /^--- /m);
  assert.doesNotMatch(normalized.diff, /^\+\+\+ /m);
  assert.match(normalized.diff, /^\+export const value = 1;$/m);
});

test("normalizeFileActionResult synthesizes a compact delete diff with softer remove highlight ratio", () => {
  const normalized = normalizeFileActionResult({
    action: "delete",
    path: "/Users/example/project/src/demo.ts",
    content: undefined,
    deletedContent: "export const value = 1;\n",
  });

  assert.ok(normalized);
  assert.equal(normalized.filePath, "/Users/example/project/src/demo.ts");
  assert.equal(normalized.contentText, undefined);
  assert.equal(normalized.addRowBgMixRatio, undefined);
  assert.equal(normalized.removeRowBgMixRatio, 0.08);
  assert.match(normalized.diff, /^deleted file Users\/example\/project\/src\/demo\.ts$/m);
  assert.doesNotMatch(normalized.diff, /^diff --git /m);
  assert.doesNotMatch(normalized.diff, /^--- /m);
  assert.doesNotMatch(normalized.diff, /^\+\+\+ /m);
  assert.match(normalized.diff, /^-export const value = 1;$/m);
});
