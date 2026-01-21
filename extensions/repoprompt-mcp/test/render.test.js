import assert from "node:assert/strict";
import test from "node:test";

import { parseFencedBlocks } from "../render.js";


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
