import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import {
    describeNativeEpoch,
    fingerprintConversionNativeCheckpointDetails,
    isConversionNativeCheckpointCandidate,
    isConversionNativeCompactionDisplayEntry,
    parseConversionNativeCheckpointDetails,
} from "./native-checkpoint-source.ts";

const GOLDEN_FINGERPRINT = "4d4f29b98b95db05275f74f0f6b89b5a00a8b1abb2f0dc2c9f21c73700a28fd6";

function messageEntry(id: string, parentId: string | null = null): SessionEntry {
    return {
        type: "message",
        id,
        parentId,
        timestamp: "2026-08-17T00:00:00.000Z",
        message: { role: "user", content: "visible", timestamp: 1 },
    } as SessionEntry;
}

function nativeDetails(model = "gpt-5.4"): Record<string, unknown> {
    return {
        strategy: "openai-responses-compaction-v2",
        provider: "openai-codex",
        api: "openai-codex-responses",
        model,
        baseUrl: "https://chatgpt.com/backend-api",
        compactedWindow: [{ type: "compaction_summary", encrypted_content: "sealed" }],
        createdAt: "2026-08-17T00:00:00.000Z",
    };
}

function nativeEntry(
    id: string,
    parentId: string | null,
    options: {
        model?: string;
        details?: unknown;
        summary?: string;
        tokensBefore?: number;
    } = {},
): SessionEntry {
    return {
        type: "compaction",
        id,
        parentId,
        timestamp: "2026-08-17T00:00:01.000Z",
        summary: options.summary ?? "[OpenAI native compaction checkpoint]",
        firstKeptEntryId: parentId ?? id,
        tokensBefore: options.tokensBefore ?? 100,
        details: Object.hasOwn(options, "details") ? options.details : nativeDetails(options.model),
    } as SessionEntry;
}

function plaintextEntry(
    id: string,
    parentId: string,
    firstKeptEntryId: string,
    summary = "Portable plaintext baseline",
): SessionEntry {
    return {
        type: "compaction",
        id,
        parentId,
        timestamp: "2026-08-17T00:00:02.000Z",
        summary,
        firstKeptEntryId,
        tokensBefore: 200,
    } as SessionEntry;
}

function withObjectPrototypeProperties<T>(
    properties: Record<string, unknown>,
    action: () => T,
): T {
    const previous = new Map(
        Object.keys(properties).map((key) => [key, Object.getOwnPropertyDescriptor(Object.prototype, key)]),
    );
    try {
        for (const [key, value] of Object.entries(properties)) {
            Object.defineProperty(Object.prototype, key, {
                value,
                configurable: true,
                writable: true,
                enumerable: false,
            });
        }
        return action();
    } finally {
        for (const [key, descriptor] of previous) {
            if (descriptor) Object.defineProperty(Object.prototype, key, descriptor);
            else delete (Object.prototype as Record<string, unknown>)[key];
        }
    }
}

describe("conversion native checkpoint details", () => {
    it("recognizes marker and strategy candidates independently from parsing", () => {
        const markerCandidate = nativeEntry("marker", null, { details: undefined });
        const strategyCandidate = nativeEntry("strategy", null, {
            summary: "different display text",
            details: nativeDetails(),
        });
        const legacyOnly = nativeEntry("legacy", null, {
            summary: "legacy",
            details: { ...nativeDetails(), strategy: "openai-native-compact-v1" },
        });

        assert.equal(isConversionNativeCheckpointCandidate(markerCandidate), true);
        assert.equal(isConversionNativeCheckpointCandidate(strategyCandidate), true);
        assert.equal(isConversionNativeCheckpointCandidate(legacyOnly), false);
    });

    it("strictly parses the current persisted v2 shape", () => {
        const parsed = parseConversionNativeCheckpointDetails({
            ...nativeDetails(),
            compactResponseId: "response-id",
            requestMeta: {
                tokensBefore: 123,
                previousSummaryPresent: false,
                compactedKeptWindow: true,
            },
            usage: {
                inputTokens: 10,
                cachedInputTokens: 8,
                cacheWriteInputTokens: 0,
                outputTokens: 2,
            },
        });

        assert.equal(parsed.strategy, "openai-responses-compaction-v2");
        assert.equal(parsed.model, "gpt-5.4");
        assert.equal(parsed.requestMeta?.compactedKeptWindow, true);
        assert.equal(parsed.usage?.cachedInputTokens, 8);
    });

    it("preserves the historical fingerprint bytes and JSON persistence semantics", () => {
        const details = nativeDetails();
        assert.equal(fingerprintConversionNativeCheckpointDetails(details), GOLDEN_FINGERPRINT);
        assert.equal(
            fingerprintConversionNativeCheckpointDetails({
                createdAt: details.createdAt,
                compactedWindow: details.compactedWindow,
                baseUrl: details.baseUrl,
                model: details.model,
                api: details.api,
                provider: details.provider,
                strategy: details.strategy,
            }),
            GOLDEN_FINGERPRINT,
        );
        assert.equal(
            fingerprintConversionNativeCheckpointDetails({
                ...details,
                compactResponseId: undefined,
                requestMeta: undefined,
                usage: undefined,
            }),
            GOLDEN_FINGERPRINT,
        );
        assert.notEqual(
            fingerprintConversionNativeCheckpointDetails({
                ...details,
                compactedWindow: [{ encrypted_content: "sealed", type: "different" }],
            }),
            GOLDEN_FINGERPRINT,
        );
    });

    it("preserves proto-named JSON properties in checkpoint identity", () => {
        const item = JSON.parse('{"__proto__":{"sentinel":true}}') as Record<string, unknown>;
        const details = { ...nativeDetails(), compactedWindow: [item] };
        const parsed = parseConversionNativeCheckpointDetails(details);

        assert.equal(Object.hasOwn(parsed.compactedWindow[0]!, "__proto__"), true);
        assert.notEqual(
            fingerprintConversionNativeCheckpointDetails(details),
            fingerprintConversionNativeCheckpointDetails({ ...nativeDetails(), compactedWindow: [{}] }),
        );
        assert.equal(({} as { sentinel?: boolean }).sentinel, undefined);
    });

    it("requires checkpoint detail fields to be own properties", () => {
        withObjectPrototypeProperties(nativeDetails(), () => {
            assert.throws(() => parseConversionNativeCheckpointDetails({}));
        });
    });

    it("ignores inherited optional checkpoint metadata", () => {
        withObjectPrototypeProperties({
            compactResponseId: "inherited-response",
            requestMeta: { tokensBefore: 999 },
            usage: {
                inputTokens: 999,
                cachedInputTokens: 999,
                cacheWriteInputTokens: 999,
                outputTokens: 999,
            },
        }, () => {
            const details = nativeDetails();
            const parsed = parseConversionNativeCheckpointDetails(details);
            assert.equal(Object.hasOwn(parsed, "compactResponseId"), false);
            assert.equal(Object.hasOwn(parsed, "requestMeta"), false);
            assert.equal(Object.hasOwn(parsed, "usage"), false);
            assert.equal(fingerprintConversionNativeCheckpointDetails(details), GOLDEN_FINGERPRINT);
        });
    });

    it("rejects marker checkpoints with inherited details or token counts", () => {
        withObjectPrototypeProperties({ details: nativeDetails(), tokensBefore: 100 }, () => {
            const missingDetails = nativeEntry("missing-details", null);
            delete (missingDetails as unknown as Record<string, unknown>).details;
            const missingDetailsResult = describeNativeEpoch([missingDetails]);
            assert.equal(missingDetailsResult.status, "error");
            if (missingDetailsResult.status === "error") {
                assert.equal(missingDetailsResult.reasonCode, "NATIVE_CHECKPOINT_MALFORMED");
            }

            const missingTokens = nativeEntry("missing-tokens", null);
            delete (missingTokens as unknown as Record<string, unknown>).tokensBefore;
            const missingTokensResult = describeNativeEpoch([missingTokens]);
            assert.equal(missingTokensResult.status, "error");
            if (missingTokensResult.status === "error") {
                assert.equal(missingTokensResult.reasonCode, "NATIVE_CHECKPOINT_TOKEN_COUNT_INVALID");
            }
        });
    });

    it("rejects unknown, incomplete, blank, and invalid metadata fields", () => {
        const hiddenTopLevel = nativeDetails();
        Object.defineProperty(hiddenTopLevel, "hidden", { value: "secret", enumerable: false });
        const hiddenRequestMeta = { tokensBefore: 1 };
        Object.defineProperty(hiddenRequestMeta, "hidden", { value: "secret", enumerable: false });
        const hiddenUsage = {
            inputTokens: 1,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            outputTokens: 1,
        };
        Object.defineProperty(hiddenUsage, "hidden", { value: "secret", enumerable: false });
        const hiddenRequired = nativeDetails();
        delete hiddenRequired.provider;
        Object.defineProperty(hiddenRequired, "provider", {
            value: "openai-codex",
            enumerable: false,
        });
        const invalidDetails = [
            { ...nativeDetails(), unknown: true },
            { ...nativeDetails(), model: " " },
            { ...nativeDetails(), strategy: "openai-native-compact-v1" },
            { ...nativeDetails(), compactResponseId: "" },
            { ...nativeDetails(), requestMeta: { unknown: true } },
            { ...nativeDetails(), requestMeta: { tokensBefore: -1 } },
            { ...nativeDetails(), usage: { inputTokens: 1 } },
            {
                ...nativeDetails(),
                usage: {
                    inputTokens: 1,
                    cachedInputTokens: 0,
                    cacheWriteInputTokens: 0,
                    outputTokens: Number.POSITIVE_INFINITY,
                },
            },
            hiddenTopLevel,
            { ...nativeDetails(), requestMeta: hiddenRequestMeta },
            { ...nativeDetails(), usage: hiddenUsage },
            hiddenRequired,
        ];

        for (const details of invalidDetails) {
            assert.throws(() => parseConversionNativeCheckpointDetails(details));
        }
    });

    it("rejects non-JSON compacted window values without exposing them", () => {
        const sparse: unknown[] = [];
        sparse[1] = { type: "item" };
        const symbolKey = Symbol("secret");
        const sparseOuter: unknown[] = [];
        sparseOuter[1] = { type: "item" };
        const decoratedOuter = [{ type: "item" }] as unknown[] & { extra?: unknown };
        decoratedOuter.extra = { secret: true };
        const symbolOuter: unknown[] = [{ type: "item" }];
        Object.defineProperty(symbolOuter, symbolKey, { value: true, enumerable: true });
        const hiddenOuter: unknown[] = [{ type: "item" }];
        Object.defineProperty(hiddenOuter, "hidden", { value: "secret", enumerable: false });
        const invalidWindows = [
            ["primitive"],
            [{ value: undefined }],
            [{ value: Number.NaN }],
            [{ value: new Date("2026-08-17T00:00:00.000Z") }],
            [{ nested: sparse }],
            [{ [symbolKey]: true }],
            sparseOuter,
            decoratedOuter,
            symbolOuter,
            hiddenOuter,
        ];

        for (const compactedWindow of invalidWindows) {
            let message = "";
            try {
                parseConversionNativeCheckpointDetails({ ...nativeDetails(), compactedWindow });
            } catch (error) {
                message = error instanceof Error ? error.message : String(error);
            }
            assert.equal(message.includes("sealed"), false);
            assert.notEqual(message, "");
        }
    });

    it("identifies conversion display entries only", () => {
        const display = {
            type: "custom",
            id: "display",
            parentId: null,
            timestamp: "2026-08-17T00:00:00.000Z",
            customType: "codex-native-compaction-display",
            data: { content: "display" },
        } as SessionEntry;
        assert.equal(isConversionNativeCompactionDisplayEntry(display), true);
        assert.equal(isConversionNativeCompactionDisplayEntry(messageEntry("message")), false);
    });
});

describe("conversion native epoch discovery", () => {
    it("returns an empty branch-root epoch without native checkpoints", () => {
        assert.deepEqual(describeNativeEpoch([]), {
            status: "available",
            baseline: { kind: "branch-root" },
            checkpoints: [],
        });
        assert.deepEqual(describeNativeEpoch([messageEntry("message")]), {
            status: "available",
            baseline: { kind: "branch-root" },
            checkpoints: [],
        });
    });

    it("keeps different creation models and identities in one chronological epoch", () => {
        const first = messageEntry("first");
        const checkpointA = nativeEntry("checkpoint-a", "first", { model: "gpt-5.4" });
        const checkpointB = nativeEntry("checkpoint-b", "checkpoint-a", {
            details: {
                ...nativeDetails("gpt-5.6-sol"),
                provider: "other-codex-provider",
                api: "other-responses-api",
                baseUrl: "https://example.test/responses",
            },
        });
        const result = describeNativeEpoch([first, checkpointA, checkpointB]);

        assert.equal(result.status, "available");
        if (result.status !== "available") return;
        assert.deepEqual(result.checkpoints.map((checkpoint) => checkpoint.entryId), ["checkpoint-a", "checkpoint-b"]);
        assert.deepEqual(result.checkpoints.map((checkpoint) => checkpoint.modelKey), [
            "openai-codex:openai-codex-responses:gpt-5.4",
            "other-codex-provider:other-responses-api:gpt-5.6-sol",
        ]);
    });

    it("rejects missing, blank, non-string, and inherited checkpoint IDs", () => {
        const entries = [
            nativeEntry("missing", null),
            nativeEntry("", null),
            nativeEntry(" ", null),
            nativeEntry("number", null),
        ];
        delete (entries[0] as unknown as Record<string, unknown>).id;
        (entries[3] as unknown as Record<string, unknown>).id = 42;

        for (const entry of entries) {
            const result = describeNativeEpoch([entry]);
            assert.equal(result.status, "error");
            if (result.status !== "error") continue;
            assert.equal(result.reasonCode, "NATIVE_CHECKPOINT_MALFORMED");
            assert.equal(result.nativeEntryIndex, 0);
            assert.equal(Object.hasOwn(result, "nativeEntryId"), false);
        }

        withObjectPrototypeProperties({ id: "inherited-checkpoint" }, () => {
            const entry = nativeEntry("own", null);
            delete (entry as unknown as Record<string, unknown>).id;
            const result = describeNativeEpoch([entry]);
            assert.equal(result.status, "error");
            if (result.status !== "error") {
                return;
            }
            assert.equal(result.nativeEntryIndex, 0);
            assert.equal(Object.hasOwn(result, "nativeEntryId"), false);
        });
    });

    it("rejects missing, blank, and inherited plaintext baseline IDs", () => {
        const source = messageEntry("source");
        for (const invalidId of [undefined, "", " "] as const) {
            const baseline = plaintextEntry("baseline", source.id, source.id);
            if (invalidId === undefined) delete (baseline as unknown as Record<string, unknown>).id;
            else (baseline as unknown as Record<string, unknown>).id = invalidId;
            const checkpoint = nativeEntry("native", "baseline");
            const result = describeNativeEpoch([source, baseline, checkpoint]);
            assert.equal(result.status, "error");
            if (result.status !== "error") continue;
            assert.equal(result.reasonCode, "NATIVE_BASELINE_MALFORMED");
            assert.equal(result.nativeEntryIndex, 1);
            assert.equal(Object.hasOwn(result, "nativeEntryId"), false);
        }

        withObjectPrototypeProperties({ id: "inherited-baseline" }, () => {
            const baseline = plaintextEntry("baseline", source.id, source.id);
            delete (baseline as unknown as Record<string, unknown>).id;
            const checkpoint = nativeEntry("native", "baseline");
            const result = describeNativeEpoch([source, baseline, checkpoint]);
            assert.equal(result.status, "error");
            if (result.status === "error") assert.equal(result.nativeEntryIndex, 1);
        });
    });

    it("uses the latest plaintext compaction as the active baseline", () => {
        const first = messageEntry("first");
        const malformedOld = nativeEntry("old-native", "first", { details: { broken: true } });
        const kept = messageEntry("kept", "old-native");
        const plaintext = plaintextEntry("plaintext", "kept", "kept");
        const current = nativeEntry("current-native", "plaintext", { model: "gpt-5.6-sol" });
        const result = describeNativeEpoch([first, malformedOld, kept, plaintext, current]);

        assert.equal(result.status, "available");
        if (result.status !== "available") return;
        assert.deepEqual(result.baseline, {
            kind: "plaintext-compaction",
            entryId: "plaintext",
            entryIndex: 3,
            firstKeptEntryId: "kept",
        });
        assert.deepEqual(result.checkpoints.map((checkpoint) => checkpoint.entryId), ["current-native"]);
    });

    it("fails closed for active malformed candidates and legacy marker entries", () => {
        for (const details of [
            undefined,
            { ...nativeDetails(), strategy: "openai-native-compact-v1" },
        ]) {
            const result = describeNativeEpoch([nativeEntry("native", null, { details })]);
            assert.equal(result.status, "error");
            if (result.status !== "error") continue;
            assert.equal(result.reasonCode, "NATIVE_CHECKPOINT_MALFORMED");
            assert.equal(result.nativeEntryId, "native");
            assert.equal(result.message.includes("sealed"), false);
        }
    });

    it("fails closed for invalid entry token counts", () => {
        for (const tokensBefore of [-1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
            const result = describeNativeEpoch([nativeEntry("native", null, { tokensBefore })]);
            assert.equal(result.status, "error");
            if (result.status !== "error") continue;
            assert.equal(result.reasonCode, "NATIVE_CHECKPOINT_TOKEN_COUNT_INVALID");
        }
    });

    it("fails closed for an invalid active plaintext baseline", () => {
        const first = messageEntry("first");
        const plaintext = plaintextEntry("plaintext", "first", "missing");
        const checkpoint = nativeEntry("native", "plaintext");
        const result = describeNativeEpoch([first, plaintext, checkpoint]);

        assert.equal(result.status, "error");
        if (result.status !== "error") return;
        assert.equal(result.reasonCode, "NATIVE_BASELINE_MALFORMED");
        assert.equal(result.nativeEntryId, "plaintext");
    });
});
