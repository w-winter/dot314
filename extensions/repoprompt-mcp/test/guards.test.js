import assert from "node:assert/strict";
import test from "node:test";

import { checkGuards, isDeleteOperation } from "../guards.js";


test("isDeleteOperation detects file_actions delete", () => {
  assert.equal(isDeleteOperation("file_actions", { action: "delete", path: "x" }), true);
  assert.equal(isDeleteOperation("file_actions", { action: "create", path: "x" }), false);
});


test("checkGuards blocks deletes unless allowDelete is set", () => {
  const config = {
    confirmDeletes: true,
    confirmEdits: false,
  };

  const blocked = checkGuards("file_actions", { action: "delete", path: "/tmp/x" }, config, {});
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason ?? "", /allowDelete/i);

  const allowed = checkGuards("file_actions", { action: "delete", path: "/tmp/x" }, config, { allowDelete: true });
  assert.equal(allowed.allowed, true);
});


test("checkGuards edit confirmation gate: blocks unless confirmEdits is true", () => {
  const config = {
    confirmDeletes: true,
    confirmEdits: true,
  };

  const blocked = checkGuards("apply_edits", { path: "x", search: "a", replace: "b" }, config, {});
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason ?? "", /confirmEdits/i);

  const allowed = checkGuards("apply_edits", { path: "x", search: "a", replace: "b" }, config, { confirmEdits: true });
  assert.equal(allowed.allowed, true);
});
