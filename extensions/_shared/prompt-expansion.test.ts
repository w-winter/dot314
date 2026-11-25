import assert from "node:assert/strict";
import { test } from "node:test";

import { PromptExpansionWriter, readPromptExpansion } from "./prompt-expansion.ts";

test("expansion metadata preserves arbitrary user text, repeated slots and empty values", () => {
    const writer = new PromptExpansionWriter("/skills/example/SKILL.template.md");
    const task = 'Multiline 🙂\r\n</skill>\n<!-- pi-prompt-expansion {"ranges":[]} -->\n$1';
    const slot = writer.userText(task);
    const expanded = readPromptExpansion(writer.serialize(`First: ${slot}\nAgain: ${slot}\nEmpty: ${writer.userText("")}`));
    assert.ok(expanded);
    assert.deepEqual(expanded.userTextRanges.map(([start, end]) => expanded.text.slice(start, end)), [task, task, ""]);
    assert.equal(expanded.text, `First: ${task}\nAgain: ${task}\nEmpty: `);
    assert.equal(readPromptExpansion("ordinary user text"), undefined);
    assert.throws(() => readPromptExpansion('text\n<!-- pi-prompt-expansion {} -->'), /expansion/i);
});
