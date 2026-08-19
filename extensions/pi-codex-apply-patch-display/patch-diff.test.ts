import assert from "node:assert/strict";
import test from "node:test";

import { summarizeDiffText } from "./diff-renderer.js";
import { applyPatchInputToDiff, applyPatchInputToFileDiffs } from "./patch-diff.js";

test("applyPatchInputToDiff converts add and update sections", () => {
  const diff = applyPatchInputToDiff(`*** Begin Patch
*** Add File: src/new.ts
+export const value = 1;
*** Update File: src/existing.ts
@@ function example
-return false;
+return true;
*** End Patch`);

  assert.equal(diff, `created file src/new.ts
@@
+export const value = 1;

edited file src/existing.ts
@@ function example
-return false;
+return true;`);
});

test("applyPatchInputToFileDiffs keeps file sections separate", () => {
  const input = "*** Begin Patch\n*** Add File: src/new.ts\n+export const value = 1;\n"
    + "*** Delete File: src/dead.ts\n*** End Patch";

  assert.deepEqual(applyPatchInputToFileDiffs(input), [
    "created file src/new.ts\n@@\n+export const value = 1;",
    "deleted file src/dead.ts",
  ]);
});

test("applyPatchInputToDiff represents moves and deletes", () => {
  const diff = applyPatchInputToDiff(`*** Begin Patch
*** Update File: src/old.ts
*** Move to: src/new.ts
@@
 unchanged
*** Delete File: src/dead.ts
*** End Patch`);

  assert.match(diff, /moved file src\/old\.ts → src\/new\.ts/);
  assert.match(diff, /deleted file src\/dead\.ts/);
});

test("vendored renderer recognizes unnumbered apply_patch hunks", () => {
  const diff = applyPatchInputToDiff(`*** Begin Patch
*** Update File: src/example.ts
@@ first
-const first = false;
+const first = true;
@@ second
-const second = false;
+const second = true;
*** End Patch`);

  assert.deepEqual(summarizeDiffText(diff), {
    added: 2,
    removed: 2,
    hunks: 2,
    files: 1,
  });
});

test("applyPatchInputToDiff rejects input without file sections", () => {
  assert.throws(
    () => applyPatchInputToDiff("*** Begin Patch\n*** End Patch"),
    /contains no file sections/,
  );
});
