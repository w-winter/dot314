import assert from "node:assert/strict";
import test from "node:test";

import { buildForwardedUserArgs } from "../dist/tool-forwarding-policy.js";

test("buildForwardedUserArgs forces verbose apply_edits", () => {
  assert.deepEqual(
    buildForwardedUserArgs({
      toolName: "apply_edits",
      userArgs: { path: "demo.txt", search: "old", replace: "new" },
    }),
    { path: "demo.txt", search: "old", replace: "new", verbose: true }
  );

  assert.deepEqual(
    buildForwardedUserArgs({
      toolName: "apply_edits",
      userArgs: { path: "demo.txt", search: "old", replace: "new", verbose: false },
    }),
    { path: "demo.txt", search: "old", replace: "new", verbose: true }
  );
});

test("buildForwardedUserArgs preserves other tool args and strips read_file bypass_cache", () => {
  assert.deepEqual(
    buildForwardedUserArgs({
      toolName: "read_file",
      userArgs: { path: "demo.txt", start_line: 1, bypass_cache: true },
    }),
    { path: "demo.txt", start_line: 1 }
  );

  assert.deepEqual(
    buildForwardedUserArgs({
      toolName: "git",
      userArgs: { op: "diff", detail: "patches" },
    }),
    { op: "diff", detail: "patches" }
  );
});
