import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import {
    PORTABILITY_COMMAND_USAGE,
    PORTABILITY_MODE_CUSTOM_TYPE,
    createPortabilityModeRecord,
    isCoordinatorMetadataEntry,
    parsePortabilityCommand,
    parsePortabilityModeRecord,
    resolveSessionPortabilityMode,
} from "./portability-mode.ts";
import { PORTABLE_SUMMARY_CUSTOM_TYPE } from "./portable-record.ts";

function customEntry(id: string, customType: string, data: unknown): SessionEntry {
    return {
        type: "custom",
        id,
        parentId: null,
        timestamp: "2026-07-25T00:00:00.000Z",
        customType,
        data,
    } as SessionEntry;
}

describe("portability mode persistence", () => {
    it("parses and creates only exact v1 records", () => {
        const record = createPortabilityModeRecord("prewarm");
        assert.deepEqual(parsePortabilityModeRecord(record), record);
        for (const value of [
            { ...record, extra: true },
            { ...record, version: 2 },
            { ...record, mode: "fast" },
            Object.assign(Object.create({ kind: PORTABILITY_MODE_CUSTOM_TYPE }), { version: 1, mode: "lazy" }),
        ]) {
            assert.throws(() => parsePortabilityModeRecord(value), /Invalid portability mode record/);
        }
    });

    it("uses the latest session-wide mode entry and permits a later repair", () => {
        const entries = [
            customEntry("mode-1", PORTABILITY_MODE_CUSTOM_TYPE, createPortabilityModeRecord("prewarm")),
            customEntry("branch-fact", "other", {}),
            customEntry("mode-2", PORTABILITY_MODE_CUSTOM_TYPE, createPortabilityModeRecord("lazy")),
        ];
        assert.deepEqual(resolveSessionPortabilityMode(entries), { mode: "lazy", entryId: "mode-2" });
        assert.throws(
            () => resolveSessionPortabilityMode([...entries, customEntry("bad", PORTABILITY_MODE_CUSTOM_TYPE, {})]),
            /bad/,
        );
        assert.deepEqual(resolveSessionPortabilityMode([
            ...entries,
            customEntry("bad", PORTABILITY_MODE_CUSTOM_TYPE, {}),
            customEntry("repair", PORTABILITY_MODE_CUSTOM_TYPE, createPortabilityModeRecord("prewarm")),
        ]), { mode: "prewarm", entryId: "repair" });
    });

    it("defaults sessions without a mode entry to lazy", () => {
        assert.deepEqual(resolveSessionPortabilityMode([]), { mode: "lazy", entryId: null });
    });

    it("accepts only the three exact command arguments", () => {
        assert.equal(parsePortabilityCommand(" prewarm "), "prewarm");
        assert.equal(parsePortabilityCommand("lazy"), "lazy");
        assert.equal(parsePortabilityCommand("status"), "status");
        for (const value of ["", "PREWARM", "prewarm now", "fast"]) {
            assert.throws(() => parsePortabilityCommand(value), new RegExp(PORTABILITY_COMMAND_USAGE.replaceAll("/", "\\/")));
        }
    });

    it("classifies both coordinator custom entry types as metadata", () => {
        assert.equal(isCoordinatorMetadataEntry(customEntry("mode", PORTABILITY_MODE_CUSTOM_TYPE, {})), true);
        assert.equal(isCoordinatorMetadataEntry(customEntry("summary", PORTABLE_SUMMARY_CUSTOM_TYPE, {})), true);
        assert.equal(isCoordinatorMetadataEntry(customEntry("other", "other", {})), false);
    });
});
