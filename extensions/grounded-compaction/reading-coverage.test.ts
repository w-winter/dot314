import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import fixture from "./reading-output.fixture.json" with { type: "json" };
import { outstandingReading } from "./reading-coverage.ts";

// Captured from PCC's commandOutputFormatterSource and toCodeModeToolResult, including unexposed trace contents.
it("credits only emitted PCC chunks, across plain and JSON command output", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "grounded-reading-pcc-"));
    const file = path.join(dir, "required.md");
    writeFileSync(file, fixture.contents);
    const message = (result: typeof fixture.partial): Extract<AgentMessage, { role: "toolResult" }> => ({
        role: "toolResult", toolName: "exec", toolCallId: "outer", timestamp: 0, isError: false,
        content: result.content.map((item) => ({ type: "text", text: item.text })), details: result.details,
    });
    try {
        const partial = message(fixture.partial);
        assert.deepEqual(outstandingReading([file], [partial], "", dir), [{ path: file, ranges: [{ start: 3, end: 4 }] }]);
        for (const remainder of fixture.remainders) {
            assert.deepEqual(outstandingReading([file], [partial, message(remainder)], "", dir), []);
            assert.notEqual(outstandingReading([file], [partial, { ...message(remainder), isError: true }], "", dir).length, 0);
            const hidden = { ...message(remainder), content: [{ type: "text" as const, text: "Call succeeded." }] };
            assert.notEqual(outstandingReading([file], [partial, hidden], "", dir).length, 0);
        }
    } finally {
        execFileSync("trash", [dir]);
    }
});
