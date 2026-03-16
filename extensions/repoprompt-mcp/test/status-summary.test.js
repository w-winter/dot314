import assert from "node:assert/strict";
import test from "node:test";

import {
  parseSelectionSummaryFromJson,
  parseWorkspaceContextSelectionSummaryFromText,
} from "../dist/index.js";

test("parseWorkspaceContextSelectionSummaryFromText parses selected file count and selection tokens", () => {
  const text = [
    "## Prompt Context ✅",
    "- **Copy Preset**: Manual",
    "**26,690 total tokens**",
    "",
    "- **Selection**: 12,626",
    "  - Files: 12,626",
    "- File tree: 14,064",
    "- **Selected files**: 3 total (3 slice)",
    "- Token breakdown: slice 12626",
    "",
    "### Selection",
    "3 files • 12,626 tokens (Auto view)",
  ].join("\n");

  assert.deepEqual(parseWorkspaceContextSelectionSummaryFromText(text), {
    fileCount: 3,
    tokens: 12626,
  });
});

test("parseWorkspaceContextSelectionSummaryFromText does not misread manage_selection token rows as file counts", () => {
  const text = [
    "## Selection ✅",
    "**26,690 total tokens**",
    "",
    "Files: 12,626 (12,626 full)",
    "Other: tree 14,064",
  ].join("\n");

  assert.equal(parseWorkspaceContextSelectionSummaryFromText(text), null);
});

test("parseSelectionSummaryFromJson does not misread selection token totals as file counts", () => {
  const value = {
    selection: {
      files: 12626,
      tokens: 12626,
    },
    summary: {
      fileCount: 3,
      totalTokens: 12626,
    },
  };

  assert.deepEqual(parseSelectionSummaryFromJson(value), {
    fileCount: 3,
    tokens: 12626,
  });
});
