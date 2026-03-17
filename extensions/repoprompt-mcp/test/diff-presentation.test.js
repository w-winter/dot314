import assert from "node:assert/strict";
import test from "node:test";

import { visibleWidth } from "@mariozechner/pi-tui";

import { buildDiffSummaryText, resolveDiffPresentationMode } from "../dist/diff-presentation.js";

const diffConfig = {
  diffViewMode: "auto",
  diffSplitMinWidth: 80,
};

test("diff presentation mode progressively degrades for narrow widths", () => {
  assert.equal(resolveDiffPresentationMode(diffConfig, 120, true), "split");
  assert.equal(resolveDiffPresentationMode(diffConfig, 24, false), "unified");
  assert.equal(resolveDiffPresentationMode(diffConfig, 12, false), "compact");
  assert.equal(resolveDiffPresentationMode(diffConfig, 7, false), "summary");
});

test("diff summary text always fits the available width", () => {
  for (const width of [1, 4, 7, 12, 24]) {
    const summary = buildDiffSummaryText(
      { added: 12, removed: 3, hunks: 2, files: 1 },
      width
    );
    assert.ok(visibleWidth(summary) <= width);
  }
});
