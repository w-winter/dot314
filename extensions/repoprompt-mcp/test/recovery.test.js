import assert from "node:assert/strict";
import test from "node:test";

import { recoverAutoSelectionStateForTabRecovery } from "../dist/index.js";

test("recoverAutoSelectionStateForTabRecovery remaps prior selection onto a replacement tab", () => {
  const recovered = recoverAutoSelectionStateForTabRecovery(
    {
      app: "ce",
      windowId: 5,
      workspace: "pi-agent",
      tab: "TAB-OLD",
      fullPaths: ["extensions/repoprompt-mcp/src/tool-names.ts"],
      slicePaths: [
        {
          path: "extensions/repoprompt-mcp/src/index.ts",
          ranges: [{ start_line: 1458, end_line: 1497 }],
        },
      ],
    },
    { app: "ce", windowId: 5, workspace: "pi-agent", tab: "TAB-OLD" },
    { app: "ce", windowId: 5, workspace: "pi-agent", tab: "TAB-NEW" }
  );

  assert.deepEqual(recovered, {
    app: "ce",
    windowId: 5,
    workspace: "pi-agent",
    tab: "TAB-NEW",
    fullPaths: ["extensions/repoprompt-mcp/src/tool-names.ts"],
    slicePaths: [
      {
        path: "extensions/repoprompt-mcp/src/index.ts",
        ranges: [{ start_line: 1458, end_line: 1497 }],
      },
    ],
  });
});

test("recoverAutoSelectionStateForTabRecovery returns null when the tab did not change", () => {
  const recovered = recoverAutoSelectionStateForTabRecovery(
    {
      app: "ce",
      windowId: 5,
      workspace: "pi-agent",
      tab: "TAB-OLD",
      fullPaths: ["extensions/repoprompt-mcp/src/tool-names.ts"],
      slicePaths: [],
    },
    { app: "ce", windowId: 5, workspace: "pi-agent", tab: "TAB-OLD" },
    { app: "ce", windowId: 5, workspace: "pi-agent", tab: "TAB-OLD" }
  );

  assert.equal(recovered, null);
});

test("recoverAutoSelectionStateForTabRecovery returns null for empty prior state", () => {
  const recovered = recoverAutoSelectionStateForTabRecovery(
    {
      app: "ce",
      windowId: 5,
      workspace: "pi-agent",
      tab: "TAB-OLD",
      fullPaths: [],
      slicePaths: [],
    },
    { app: "ce", windowId: 5, workspace: "pi-agent", tab: "TAB-OLD" },
    { app: "ce", windowId: 5, workspace: "pi-agent", tab: "TAB-NEW" }
  );

  assert.equal(recovered, null);
});
