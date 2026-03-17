import assert from "node:assert/strict";
import test from "node:test";

import { detectLanguageFromPath } from "../dist/language-detection.js";

test("detectLanguageFromPath infers common source languages for diff highlighting", () => {
  assert.equal(detectLanguageFromPath("src/demo.ts"), "typescript");
  assert.equal(detectLanguageFromPath("scripts/demo.js"), "javascript");
  assert.equal(detectLanguageFromPath("lib/demo.py"), "python");
  assert.equal(detectLanguageFromPath("README.md"), "markdown");
  assert.equal(detectLanguageFromPath("notes/no-extension"), "text");
});
