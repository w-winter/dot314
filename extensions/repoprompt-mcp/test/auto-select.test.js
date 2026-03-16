import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  applyFullReadToSelectionState,
  applySliceReadToSelectionState,
  computeSliceRangeFromReadArgs,
  countFileLines,
  inferSelectionStatus,
  inferSelectionSliceRanges,
  isWholeFileReadFromArgs,
} from "../dist/auto-select.js";


test("inferSelectionStatus detects full selection", () => {
  const text = [
    "### Selected Files",
    "agent/src/",
    "└── client.ts — 1,621 tokens (full)",
    "",
    "### Codemaps",
    "agent/src/",
    "└── types.ts — 731 tokens (auto)",
  ].join("\n");

  assert.deepEqual(inferSelectionStatus(text, "agent/src/client.ts"), { mode: "full" });
});


test("inferSelectionStatus detects slice selection", () => {
  const text = [
    "### Selected Files",
    "agent/src/",
    "└── client.ts — 141 tokens (lines 1-20)",
  ].join("\n");

  assert.deepEqual(inferSelectionStatus(text, "agent/src/client.ts"), { mode: "slices" });
});


test("inferSelectionSliceRanges parses the selected range", () => {
  const text = [
    "### Selected Files",
    "agent/src/",
    "└── client.ts — 141 tokens (lines 1-20)",
  ].join("\n");

  assert.deepEqual(inferSelectionSliceRanges(text, "agent/src/client.ts"), [
    { start_line: 1, end_line: 20 },
  ]);
});

test("inferSelectionSliceRanges parses unicode dashes", () => {
  const text = [
    "### Selected Files",
    "agent/src/",
    "└── client.ts — 141 tokens (lines 1–20)",
  ].join("\n");

  assert.deepEqual(inferSelectionSliceRanges(text, "agent/src/client.ts"), [
    { start_line: 1, end_line: 20 },
  ]);
});


test("inferSelectionSliceRanges parses multiple ranges", () => {
  const text = [
    "### Selected Files",
    "agent/src/",
    "└── client.ts — 141 tokens (lines 1-3, 10-12)",
  ].join("\n");

  assert.deepEqual(inferSelectionSliceRanges(text, "agent/src/client.ts"), [
    { start_line: 1, end_line: 3 },
    { start_line: 10, end_line: 12 },
  ]);
});


test("inferSelectionStatus detects codemap-only (manual)", () => {
  const text = [
    "### Codemaps",
    "agent/src/",
    "└── client.ts — 288 tokens (manual)",
  ].join("\n");

  assert.deepEqual(inferSelectionStatus(text, "agent/src/client.ts"), {
    mode: "codemap_only",
    codemapManual: true,
  });
});


test("inferSelectionStatus handles nested tree paths", () => {
  const text = [
    "### Selected Files",
    "agent/extensions/",
    "└── repoprompt-mcp/",
    "    └── src/",
    "        └── index.ts — 7,000 tokens (lines 120-220)",
  ].join("\n");

  assert.deepEqual(
    inferSelectionStatus(text, "agent/extensions/repoprompt-mcp/src/index.ts"),
    { mode: "slices" }
  );
});


test("inferSelectionStatus handles workspace-root trees without an explicit root line", () => {
  const text = [
    "### Selected Files",
    "├── src/",
    "│   └── background.ts — 2,219 tokens (lines 1-260)",
    "└── README.md — 775 tokens (full)",
  ].join("\n");

  assert.deepEqual(inferSelectionStatus(text, "src/background.ts"), { mode: "slices" });
  assert.deepEqual(inferSelectionStatus(text, "README.md"), { mode: "full" });
});


test("inferSelectionSliceRanges handles workspace-root trees without an explicit root line", () => {
  const text = [
    "### Selected Files",
    "├── src/",
    "│   └── background.ts — 2,219 tokens (lines 1-260, 1723–1727)",
    "└── README.md — 775 tokens (full)",
  ].join("\n");

  assert.deepEqual(inferSelectionSliceRanges(text, "src/background.ts"), [
    { start_line: 1, end_line: 260 },
    { start_line: 1723, end_line: 1727 },
  ]);
});


test("inferSelectionSliceRanges handles the exact conversation tree transcript shape", () => {
  const text = [
    "### Selected Files",
    "├── src/",
    "│   ├── components/",
    "│   │   └── ConversationTree.tsx — 831 tokens (lines 60-139)",
    "│   └── main.tsx — 63 tokens (full)",
    "├── .gitignore — 71 tokens (full)",
    "└── postcss.config.cjs — 21 tokens (full)",
  ].join("\n");

  assert.deepEqual(inferSelectionStatus(text, "src/components/ConversationTree.tsx"), { mode: "slices" });
  assert.deepEqual(inferSelectionSliceRanges(text, "src/components/ConversationTree.tsx"), [
    { start_line: 60, end_line: 139 },
  ]);
});


test("applySliceReadToSelectionState merges adjacent ranges for incremental reads", () => {
  const state = {
    windowId: 3,
    tab: "T2",
    workspace: "chat-tree",
    fullPaths: ["src/main.tsx", ".gitignore", "postcss.config.cjs"],
    slicePaths: [
      {
        path: "src/components/ConversationTree.tsx",
        ranges: [{ start_line: 60, end_line: 139 }],
      },
    ],
  };

  const nextState = applySliceReadToSelectionState(
    state,
    "src/components/ConversationTree.tsx",
    { start_line: 140, end_line: 142 }
  );

  assert.deepEqual(nextState.slicePaths, [
    {
      path: "src/components/ConversationTree.tsx",
      ranges: [{ start_line: 60, end_line: 142 }],
    },
  ]);
});


test("inferSelectionStatus tolerates irregular spacing around metadata", () => {
  const text = [
    "### Codemaps",
    "agent/src/",
    "└── client.ts  —   288 tokens   (manual)",
  ].join("\n");

  assert.deepEqual(inferSelectionStatus(text, "agent/src/client.ts"), {
    mode: "codemap_only",
    codemapManual: true,
  });
});


test("computeSliceRangeFromReadArgs handles positive ranges", () => {
  assert.deepEqual(computeSliceRangeFromReadArgs(10, 5, undefined), { start_line: 10, end_line: 14 });
  assert.equal(computeSliceRangeFromReadArgs(10, undefined, 100), null);
});


test("computeSliceRangeFromReadArgs handles tail ranges", () => {
  assert.deepEqual(computeSliceRangeFromReadArgs(-10, undefined, 100), { start_line: 91, end_line: 100 });
  assert.equal(computeSliceRangeFromReadArgs(-10, undefined, 5), null);
  assert.equal(computeSliceRangeFromReadArgs(-10, undefined, undefined), null);
});

test("isWholeFileReadFromArgs detects short files read in one chunk", () => {
  assert.equal(isWholeFileReadFromArgs(1, 400, 17), true);
  assert.equal(isWholeFileReadFromArgs(-400, undefined, 17), true);
  assert.equal(isWholeFileReadFromArgs(20, 400, 100), false);
  assert.equal(isWholeFileReadFromArgs(1, 20, 400), false);
});


test("countFileLines counts lines with and without trailing newline", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rp-auto-select-"));
  const filePath = path.join(dir, "x.txt");

  await fs.writeFile(filePath, "a\nb\nc\n", "utf8");
  assert.equal(await countFileLines(filePath), 3);

  await fs.writeFile(filePath, "a\nb\nc", "utf8");
  assert.equal(await countFileLines(filePath), 3);

  await fs.writeFile(filePath, "", "utf8");
  assert.equal(await countFileLines(filePath), 0);
});

test("applySliceReadToSelectionState preserves previously selected files", () => {
  const state = {
    windowId: 5,
    tab: "T1",
    workspace: "pi-agent",
    fullPaths: ["extensions/repoprompt-mcp/src/types.ts"],
    slicePaths: [
      {
        path: "extensions/repoprompt-mcp/src/index.ts",
        ranges: [{ start_line: 10, end_line: 20 }],
      },
    ],
  };

  const nextState = applySliceReadToSelectionState(
    state,
    "extensions/repoprompt-mcp/src/tool-names.ts",
    { start_line: 1, end_line: 20 }
  );

  assert.deepEqual(nextState.fullPaths, ["extensions/repoprompt-mcp/src/types.ts"]);
  assert.deepEqual(nextState.slicePaths, [
    {
      path: "extensions/repoprompt-mcp/src/index.ts",
      ranges: [{ start_line: 10, end_line: 20 }],
    },
    {
      path: "extensions/repoprompt-mcp/src/tool-names.ts",
      ranges: [{ start_line: 1, end_line: 20 }],
    },
  ]);
});

test("applyFullReadToSelectionState upgrades one file without dropping others", () => {
  const state = {
    windowId: 5,
    tab: "T1",
    workspace: "pi-agent",
    fullPaths: ["extensions/repoprompt-mcp/src/types.ts"],
    slicePaths: [
      {
        path: "extensions/repoprompt-mcp/src/index.ts",
        ranges: [{ start_line: 10, end_line: 20 }],
      },
      {
        path: "extensions/repoprompt-mcp/src/tool-names.ts",
        ranges: [{ start_line: 1, end_line: 20 }],
      },
    ],
  };

  const nextState = applyFullReadToSelectionState(state, "extensions/repoprompt-mcp/src/tool-names.ts");

  assert.deepEqual(nextState.fullPaths, [
    "extensions/repoprompt-mcp/src/types.ts",
    "extensions/repoprompt-mcp/src/tool-names.ts",
  ]);
  assert.deepEqual(nextState.slicePaths, [
    {
      path: "extensions/repoprompt-mcp/src/index.ts",
      ranges: [{ start_line: 10, end_line: 20 }],
    },
  ]);
});
