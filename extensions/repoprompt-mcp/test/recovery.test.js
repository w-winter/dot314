import assert from "node:assert/strict";
import test from "node:test";

import { recoverAutoSelectionStateForTabRecovery } from "../dist/index.js";

test("recoverAutoSelectionStateForTabRecovery remaps prior selection onto a replacement tab", () => {
  const recovered = recoverAutoSelectionStateForTabRecovery(
    {
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
    { windowId: 5, workspace: "pi-agent", tab: "TAB-OLD" },
    { windowId: 5, workspace: "pi-agent", tab: "TAB-NEW" }
  );

  assert.deepEqual(recovered, {
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
      windowId: 5,
      workspace: "pi-agent",
      tab: "TAB-OLD",
      fullPaths: ["extensions/repoprompt-mcp/src/tool-names.ts"],
      slicePaths: [],
    },
    { windowId: 5, workspace: "pi-agent", tab: "TAB-OLD" },
    { windowId: 5, workspace: "pi-agent", tab: "TAB-OLD" }
  );

  assert.equal(recovered, null);
});

test("recoverAutoSelectionStateForTabRecovery returns null for empty prior state", () => {
  const recovered = recoverAutoSelectionStateForTabRecovery(
    {
      windowId: 5,
      workspace: "pi-agent",
      tab: "TAB-OLD",
      fullPaths: [],
      slicePaths: [],
    },
    { windowId: 5, workspace: "pi-agent", tab: "TAB-OLD" },
    { windowId: 5, workspace: "pi-agent", tab: "TAB-NEW" }
  );

  assert.equal(recovered, null);
});
