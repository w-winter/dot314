import assert from "node:assert/strict";
import test from "node:test";

import { normalizeOptionKey, parseInvocationArgs, tokenizeInvocationArgs } from "../args.ts";

test("tokenizeInvocationArgs matches Pi-style quoted splitting", () => {
  assert.deepEqual(tokenizeInvocationArgs("one 'two words' \"three words\" four"), [
    "one",
    "two words",
    "three words",
    "four",
  ]);
});

test("parseInvocationArgs supports positional args and both option value forms", () => {
  const parsed = parseInvocationArgs("security --strict --lang python --foo-bar=baz");

  assert.equal(parsed.raw, "security --strict --lang python --foo-bar=baz");
  assert.deepEqual(parsed.args, ["security"]);
  assert.deepEqual(parsed.named, {
    strict: true,
    lang: "python",
    "foo-bar": "baz",
  });
  assert.deepEqual(parsed.vars, {
    strict: true,
    lang: "python",
    foo_bar: "baz",
  });
});

test("parseInvocationArgs stops option parsing after sentinel", () => {
  const parsed = parseInvocationArgs("--lang python -- report --not-a-flag");

  assert.deepEqual(parsed.args, ["report", "--not-a-flag"]);
  assert.deepEqual(parsed.named, { lang: "python" });
});

test("parseInvocationArgs allows empty values with equals syntax", () => {
  const parsed = parseInvocationArgs("--note=");

  assert.deepEqual(parsed.named, { note: "" });
  assert.deepEqual(parsed.vars, { note: "" });
});

test("parseInvocationArgs preserves quoted values that begin with dashes", () => {
  const parsed = parseInvocationArgs('--note "--flag" --label "--value with spaces"');

  assert.deepEqual(parsed.named, {
    note: "--flag",
    label: "--value with spaces",
  });
  assert.deepEqual(parsed.vars, {
    note: "--flag",
    label: "--value with spaces",
  });
});

test("parseInvocationArgs rejects duplicate raw option keys", () => {
  assert.throws(() => parseInvocationArgs("--lang python --lang typescript"), /Duplicate option key/);
});

test("parseInvocationArgs rejects normalized key collisions", () => {
  assert.throws(() => parseInvocationArgs("--foo-bar one --foo_bar two"), /Duplicate normalized option key/);
});

test("parseInvocationArgs rejects reserved keys in raw or normalized form", () => {
  assert.throws(() => parseInvocationArgs("--args value"), /reserved/);
  assert.throws(() => parseInvocationArgs("--skill-name review"), /reserved/);
});

test("normalizeOptionKey converts hyphens to underscores", () => {
  assert.equal(normalizeOptionKey("foo-bar-baz"), "foo_bar_baz");
});
