import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSelectionPathFromResolved,
  deriveRepoRelativePathFromInput,
  planAutoSelectSliceUpdate,
} from "../dist/index.js";

test("buildSelectionPathFromResolved returns root-scoped paths for selection state", () => {
  assert.equal(
    buildSelectionPathFromResolved("src/background.ts", {
      absolutePath: "/Users/ww/chat-tree/src/background.ts",
      repoRoot: "/Users/ww/chat-tree",
    }),
    "chat-tree/src/background.ts"
  );
});

test("buildSelectionPathFromResolved normalizes absolute input fallback to posix", () => {
  assert.equal(
    buildSelectionPathFromResolved("C:\\repo\\src\\background.ts", {
      absolutePath: null,
      repoRoot: null,
    }),
    "C:/repo/src/background.ts"
  );
});

test("deriveRepoRelativePathFromInput strips workspace prefix when resolution is unavailable", () => {
  assert.equal(
    deriveRepoRelativePathFromInput(
      "chat-tree/src/components/ConversationTree.tsx",
      { windowId: 1, tab: "T1", workspace: "chat-tree" },
      { repoRoot: null }
    ),
    "src/components/ConversationTree.tsx"
  );
});

test("deriveRepoRelativePathFromInput handles colon-prefixed root hints", () => {
  assert.equal(
    deriveRepoRelativePathFromInput(
      "chat-tree:src/components/ConversationTree.tsx",
      { windowId: 1, tab: "T1", workspace: "chat-tree" },
      { repoRoot: null }
    ),
    "src/components/ConversationTree.tsx"
  );
});

test("planAutoSelectSliceUpdate uses UI-observed ranges instead of stale local slice state", () => {
  const selectionText = [
    "### Selected Files",
    "├── src/",
    "│   ├── components/",
    "│   │   └── ConversationTree.tsx — 831 tokens (lines 60-139)",
    "│   └── main.tsx — 63 tokens (full)",
    "├── .gitignore — 71 tokens (full)",
    "└── postcss.config.cjs — 21 tokens (full)",
  ].join("\n");

  const plan = planAutoSelectSliceUpdate({
    selectionText,
    inputPath: "chat-tree/src/components/ConversationTree.tsx",
    selectionPath: "chat-tree/src/components/ConversationTree.tsx",
    binding: { windowId: 1, tab: "T1", workspace: "chat-tree" },
    resolved: { absolutePath: null, repoRoot: null },
    baseState: {
      windowId: 1,
      tab: "T1",
      workspace: "chat-tree",
      fullPaths: ["src/main.tsx", ".gitignore", "postcss.config.cjs"],
      slicePaths: [
        {
          path: "chat-tree/src/components/ConversationTree.tsx",
          ranges: [{ start_line: 60, end_line: 142 }],
        },
      ],
    },
    sliceRange: { start_line: 140, end_line: 142 },
  });

  assert.equal(plan.selectionMode, "slices");
  assert.deepEqual(plan.observedRanges, [{ start_line: 60, end_line: 139 }]);
  assert.equal(plan.uiAlreadyCoversNewSlice, false);
  assert.deepEqual(plan.desiredSlice, {
    path: "chat-tree/src/components/ConversationTree.tsx",
    ranges: [{ start_line: 60, end_line: 142 }],
  });
  assert.ok(plan.removeVariants.includes("chat-tree/src/components/ConversationTree.tsx"));
  assert.ok(plan.removeVariants.includes("src/components/ConversationTree.tsx"));
});

test("planAutoSelectSliceUpdate merges a dirty 1-120 UI slice with a new 121-123 read", () => {
  const selectionText = [
    "### Selected Files",
    "├── src/",
    "│   ├── components/",
    "│   │   └── ConversationTree.tsx — 1,166 tokens (lines 1-120)",
    "│   └── App.tsx — 516 tokens (full)",
    "└── README.md — 775 tokens (full)",
  ].join("\n");

  const plan = planAutoSelectSliceUpdate({
    selectionText,
    inputPath: "chat-tree/src/components/ConversationTree.tsx",
    selectionPath: "chat-tree/src/components/ConversationTree.tsx",
    binding: { windowId: 1, tab: "T1", workspace: "chat-tree" },
    resolved: { absolutePath: null, repoRoot: null },
    baseState: {
      windowId: 1,
      tab: "T1",
      workspace: "chat-tree",
      fullPaths: ["README.md", "src/App.tsx"],
      slicePaths: [
        {
          path: "chat-tree/src/components/ConversationTree.tsx",
          ranges: [{ start_line: 1, end_line: 120 }],
        },
      ],
    },
    sliceRange: { start_line: 121, end_line: 123 },
  });

  assert.equal(plan.selectionMode, "slices");
  assert.deepEqual(plan.observedRanges, [{ start_line: 1, end_line: 120 }]);
  assert.equal(plan.uiAlreadyCoversNewSlice, false);
  assert.deepEqual(plan.desiredSlice, {
    path: "chat-tree/src/components/ConversationTree.tsx",
    ranges: [{ start_line: 1, end_line: 123 }],
  });
  assert.ok(plan.removeVariants.includes("chat-tree/src/components/ConversationTree.tsx"));
  assert.ok(plan.removeVariants.includes("src/components/ConversationTree.tsx"));
});

test("planAutoSelectSliceUpdate trusts the visible UI slice even when local state missed the file", () => {
  const selectionText = [
    "### Selected Files",
    "├── src/",
    "│   ├── components/",
    "│   │   └── ConversationTree.tsx — 1,166 tokens (lines 1-120)",
    "│   └── main.tsx — 63 tokens (full)",
    "├── .gitignore — 71 tokens (full)",
    "└── postcss.config.cjs — 21 tokens (full)",
  ].join("\n");

  const plan = planAutoSelectSliceUpdate({
    selectionText,
    inputPath: "chat-tree/src/components/ConversationTree.tsx",
    selectionPath: "chat-tree/src/components/ConversationTree.tsx",
    binding: { windowId: 1, tab: "T3", workspace: "chat-tree" },
    resolved: { absolutePath: null, repoRoot: null },
    baseState: {
      windowId: 1,
      tab: "T3",
      workspace: "chat-tree",
      fullPaths: ["src/main.tsx", ".gitignore", "postcss.config.cjs"],
      slicePaths: [],
    },
    sliceRange: { start_line: 121, end_line: 123 },
  });

  assert.equal(plan.selectionMode, "slices");
  assert.equal(plan.baseStateTracksSelectionPath, false);
  assert.deepEqual(plan.observedRanges, [{ start_line: 1, end_line: 120 }]);
  assert.equal(plan.uiAlreadyCoversNewSlice, false);
  assert.deepEqual(plan.desiredSlice, {
    path: "chat-tree/src/components/ConversationTree.tsx",
    ranges: [{ start_line: 1, end_line: 123 }],
  });
});
