import assert from "node:assert/strict";
import test from "node:test";

import { visibleWidth } from "@mariozechner/pi-tui";

import { renderAdaptiveDiffBlockLines } from "../dist/diff-renderer.js";

const theme = {
  fg: (_color, text) => text,
  bold: (text) => text,
  inverse: (text) => text,
};

const diffConfig = {
  diffViewMode: "auto",
  diffSplitMinWidth: 80,
};

const diffText = [
  "diff --git a/demo.txt b/demo.txt",
  "--- a/demo.txt",
  "+++ b/demo.txt",
  "@@ -1,2 +1,2 @@",
  "-old value",
  "+new value",
  " unchanged line with enough content to wrap in narrow views",
].join("\n");

function assertLinesFitWidth(lines, width) {
  for (const line of lines) {
    assert.ok(
      visibleWidth(line) <= width,
      `rendered line exceeded width ${width}: ${visibleWidth(line)} :: ${JSON.stringify(line)}`
    );
  }
}

test("adaptive diff renderer respects requested width across layouts", () => {
  for (const width of [120, 24, 12, 7]) {
    const lines = renderAdaptiveDiffBlockLines(diffText, width, theme, diffConfig);
    assert.ok(lines.length > 0);
    assertLinesFitWidth(lines, width);
  }
});

test("adaptive diff renderer emits split headers when width allows it", () => {
  const lines = renderAdaptiveDiffBlockLines(diffText, 120, theme, diffConfig);
  assert.ok(lines.some((line) => line.includes("old") && line.includes("new")));
});

test("adaptive diff renderer degrades to compact and summary output", () => {
  const compactLines = renderAdaptiveDiffBlockLines(diffText, 12, theme, diffConfig);
  assert.ok(compactLines.some((line) => line.trimStart().startsWith("+") || line.trimStart().startsWith("-") || line.trimStart().startsWith("·")));

  const summaryLines = renderAdaptiveDiffBlockLines(diffText, 7, theme, diffConfig);
  assert.equal(summaryLines.length, 1);
  assert.ok(visibleWidth(summaryLines[0]) <= 7);
});

