import assert from "node:assert/strict";
import test from "node:test";

import { extractJsonContent } from "../mcp-json.js";

function textContent(text) {
  return [{ type: "text", text }];
}

test("extractJsonContent parses ```json fenced blocks", () => {
  const parsed = extractJsonContent(textContent("```json\n{\"a\": 1}\n```"));
  assert.deepEqual(parsed, { a: 1 });
});

test("extractJsonContent does not parse non-json fenced blocks", () => {
  const parsed = extractJsonContent(textContent("```ts\n{\"a\": 1}\n```"));
  assert.equal(parsed, null);
});

test("extractJsonContent parses plain fenced blocks with JSON", () => {
  const parsed = extractJsonContent(textContent("```\n{\"a\": 1}\n```"));
  assert.deepEqual(parsed, { a: 1 });
});
