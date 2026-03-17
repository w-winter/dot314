import assert from "node:assert/strict";
import test from "node:test";

import {
  createAdaptiveDiffAwareOutputComponent,
  inferDiffFilePathFromText,
  parseFencedBlocks,
} from "../dist/render.js";


test("parseFencedBlocks returns correct indices for multiple blocks", () => {
  const text = [
    "before",
    "```diff",
    "-old",
    "+new",
    "```",
    "between",
    "```",
    "plain",
    "```",
    "after",
  ].join("\n");

  const blocks = parseFencedBlocks(text);
  assert.equal(blocks.length, 2);

  // Block 1 is the diff block
  assert.equal(blocks[0].lang, "diff");
  assert.equal(blocks[0].code, "-old\n+new");

  // Indices should select a substring that includes the fences
  const block1Text = text.slice(blocks[0].startIndex, blocks[0].endIndex);
  assert.match(block1Text, /```diff/);
  assert.match(block1Text, /-old/);
  assert.ok(block1Text.includes("\n```\n"));

  // Block 2 is the unlabeled fence
  assert.equal(blocks[1].lang, undefined);
  assert.equal(blocks[1].code, "plain");
});


test("parseFencedBlocks treats unclosed fence as extending to end", () => {
  const text = [
    "before",
    "```ts",
    "const x = 1;",
  ].join("\n");

  const blocks = parseFencedBlocks(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].lang, "ts");
  assert.equal(blocks[0].code, "const x = 1;");
  assert.equal(blocks[0].endIndex, text.length);
});


test("inferDiffFilePathFromText reads the nearest git patch heading path", () => {
  const text = [
    "### Patches",
    "",
    "#### `extensions/repoprompt-mcp/src/diff-renderer.ts`",
    "",
  ].join("\n");

  assert.equal(
    inferDiffFilePathFromText(text),
    "extensions/repoprompt-mcp/src/diff-renderer.ts"
  );
});


test("createAdaptiveDiffAwareOutputComponent prefers details diff over summary text", () => {
  const theme = {
    fg: (_color, text) => text,
    bold: (text) => text,
    inverse: (text) => text,
  };

  const diffText = [
    "--- a/demo.txt",
    "+++ b/demo.txt",
    "@@ -1 +1 @@",
    "-old value",
    "+new value",
  ].join("\n");

  const component = createAdaptiveDiffAwareOutputComponent(
    "Applied edits • +1 -1 • 1 hunk • 1 file",
    theme,
    {
      toolName: "apply_edits",
      expanded: true,
      collapsedMaxLines: 15,
      successPrefix: "↳ ",
      diffText,
      diffConfig: {
        diffViewMode: "auto",
        diffSplitMinWidth: 80,
      },
    }
  );

  const rendered = component.render(120).join("\n");
  assert.match(rendered, /--- a\/demo\.txt/);
  assert.match(rendered, /\+\+\+ b\/demo\.txt/);
  assert.match(rendered, /@@ -1 \+1 @@/);
  assert.doesNotMatch(rendered, /Applied edits/);
});


test("createAdaptiveDiffAwareOutputComponent can bypass collapsed truncation for verbose apply_edits", () => {
  const theme = {
    fg: (_color, text) => text,
    bold: (text) => text,
    inverse: (text) => text,
  };

  const diffText = [
    "--- a/demo.txt",
    "+++ b/demo.txt",
    "@@ -1,3 +1,3 @@",
    "-old value one",
    "+new value one",
    " unchanged line",
    "-old value two",
    "+new value two",
  ].join("\n");

  const component = createAdaptiveDiffAwareOutputComponent(
    "Applied edits • +2 -2 • 2 hunks • 1 file",
    theme,
    {
      toolName: "apply_edits",
      expanded: false,
      collapsedMaxLines: 0,
      successPrefix: "↳ ",
      diffText,
      disableCollapsedTruncation: true,
      diffConfig: {
        diffViewMode: "auto",
        diffSplitMinWidth: 80,
      },
    }
  );

  const rendered = component.render(120).join("\n");
  assert.match(rendered, /--- a\/demo\.txt/);
  assert.match(rendered, /\+\+\+ b\/demo\.txt/);
  assert.doesNotMatch(rendered, /output hidden/);
  assert.doesNotMatch(rendered, /more lines/);
});


test("createAdaptiveDiffAwareOutputComponent can bypass collapsed truncation for file_actions diffs", () => {
  const theme = {
    fg: (_color, text) => text,
    bold: (text) => text,
    inverse: (text) => text,
  };

  const diffText = [
    "created file src/demo.ts",
    "@@ -0,0 +1,4 @@",
    "+export const demoValue = 1;",
    "+",
    "+export function square(value: number): number {",
    "+  return value * value;",
  ].join("\n");

  const component = createAdaptiveDiffAwareOutputComponent(
    "Created file • 4 lines",
    theme,
    {
      toolName: "file_actions",
      expanded: false,
      collapsedMaxLines: 0,
      successPrefix: "↳ ",
      diffText,
      disableCollapsedTruncation: true,
      diffConfig: {
        diffViewMode: "auto",
        diffSplitMinWidth: 80,
      },
    }
  );

  const rendered = component.render(120).join("\n");
  assert.match(rendered, /created file src\/demo\.ts/);
  assert.match(rendered, /square\(value: number\)/);
  assert.doesNotMatch(rendered, /output hidden/);
  assert.doesNotMatch(rendered, /more lines/);
});


test("createAdaptiveDiffAwareOutputComponent keeps mixed non-diff output when no details diff override is provided", () => {
  const theme = {
    fg: (_color, text) => text,
    bold: (text) => text,
    inverse: (text) => text,
  };

  const mixedOutput = [
    "## Title",
    "",
    "```js",
    "const value = 1;",
    "```",
    "",
    "```diff",
    "--- a/demo.txt",
    "+++ b/demo.txt",
    "@@ -1 +1 @@",
    "-old value",
    "+new value",
    "```",
  ].join("\n");

  const component = createAdaptiveDiffAwareOutputComponent(
    mixedOutput,
    theme,
    {
      toolName: "git",
      expanded: true,
      collapsedMaxLines: 15,
      successPrefix: "↳ ",
      diffConfig: {
        diffViewMode: "auto",
        diffSplitMinWidth: 80,
      },
    }
  );

  const rendered = component.render(120).join("\n");
  assert.match(rendered, /Title/);
  assert.match(rendered, /const value = 1;/);
  assert.match(rendered, /--- a\/demo\.txt/);
});
