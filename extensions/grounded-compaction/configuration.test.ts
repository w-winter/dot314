import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
    DEFAULT_COMPACTION_PROMPT_CONTRACT,
    DEFAULT_CONFIG,
    loadBranchSummaryPromptContract,
    loadCompactionPromptContract,
    loadConfig,
    parseCompactInstructions,
    parseConfig,
    resolvePresetMatch,
    type GroundedCompactionConfig,
} from "./index.ts";

const tempDirs: string[] = [];

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("grounded-compaction parsing", () => {
    it("parses plain focus text without a preset", () => {
        assert.deepEqual(parseCompactInstructions("focus on parser regressions"), {
            usesPresetDirective: false,
            focusText: "focus on parser regressions",
        });
    });

    it("parses a preset and preserves trailing focus text", () => {
        assert.deepEqual(parseCompactInstructions("--preset cheap focus on parser regressions"), {
            usesPresetDirective: true,
            presetQuery: "cheap",
            focusText: "focus on parser regressions",
        });
    });

    it("parses the -p preset alias and preserves trailing focus text", () => {
        assert.deepEqual(parseCompactInstructions("-p cheap focus on parser regressions"), {
            usesPresetDirective: true,
            presetQuery: "cheap",
            focusText: "focus on parser regressions",
        });
    });

    it("treats malformed leading preset syntax as a consumed directive", () => {
        assert.deepEqual(parseCompactInstructions("--preset"), {
            usesPresetDirective: true,
        });
        assert.deepEqual(parseCompactInstructions("-p"), {
            usesPresetDirective: true,
        });
    });
});

describe("grounded-compaction config", () => {
    it("accepts only positive safe retention budgets and flag thresholds", () => {
        assert.equal(parseConfig({}).verbatimUserMessageTokens, null);
        assert.equal(parseConfig({}).verbatimUserMessageFlagChars, 8000);
        assert.equal(parseConfig({ verbatimUserMessageTokens: 64000 }).verbatimUserMessageTokens, 64000);
        for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "8000", false]) {
            assert.throws(() => parseConfig({ verbatimUserMessageTokens: value }), /verbatimUserMessageTokens/);
            assert.throws(() => parseConfig({ verbatimUserMessageFlagChars: value }), /verbatimUserMessageFlagChars/);
        }
        assert.throws(() => parseConfig({ verbatimUserMessageFlagChars: null }), /verbatimUserMessageFlagChars/);
    });
    it("parses valid config and preserves defaults when optional fields are omitted", () => {
        assert.deepEqual(parseConfig({}), DEFAULT_CONFIG);
        assert.deepEqual(parseConfig({}).includeFilesTouched, { inCompactionSummary: "writer", inBranchSummary: "writer" });
    });

    it("applies a single includeFilesTouched mode to both features", () => {
        assert.deepEqual(parseConfig({ includeFilesTouched: "writerAndReader" }).includeFilesTouched, {
            inCompactionSummary: "writerAndReader",
            inBranchSummary: "writerAndReader",
        });
    });

    it("rejects boolean and unknown includeFilesTouched values", () => {
        const validValues = /must be "off", "writer", or "writerAndReader"/;
        assert.throws(() => parseConfig({ includeFilesTouched: true }), validValues);
        assert.throws(() => parseConfig({ includeFilesTouched: false }), validValues);
        assert.throws(() => parseConfig({ includeFilesTouched: "reader" }), validValues);
        assert.throws(
            () => parseConfig({ includeFilesTouched: { inCompactionSummary: true, inBranchSummary: "writer" } }),
            /includeFilesTouched\.inCompactionSummary must be "off", "writer", or "writerAndReader"/,
        );
    });

    it("accepts explicit per-feature includeFilesTouched settings", () => {
        assert.deepEqual(
            parseConfig({
                includeFilesTouched: {
                    inCompactionSummary: "writerAndReader",
                    inBranchSummary: "off",
                },
            }).includeFilesTouched,
            {
                inCompactionSummary: "writerAndReader",
                inBranchSummary: "off",
            },
        );
    });

    it("rejects partial includeFilesTouched objects", () => {
        assert.throws(() => {
            parseConfig({
                includeFilesTouched: {
                    inCompactionSummary: "writerAndReader",
                },
            });
        }, /includeFilesTouched\.inBranchSummary must be "off", "writer", or "writerAndReader"/);
    });

    it("rejects a defaultPreset that is neither current nor a declared preset", () => {
        assert.throws(() => {
            parseConfig({
                defaultPreset: "fast",
                presets: {},
            });
        }, /defaultPreset 'fast' was not found in presets/);
    });

    it("rejects malformed preset entries", () => {
        assert.throws(() => {
            parseConfig({
                presets: {
                    cheap: {
                        model: "",
                    },
                },
            });
        }, /preset 'cheap' must define model/);
    });

    it("loads missing config and prompt files from embedded defaults", async () => {
        const tempDir = await mkdtemp(path.join(os.tmpdir(), "grounded-compaction-test-"));
        tempDirs.push(tempDir);

        await assert.doesNotReject(async () => {
            const loadedConfig = await loadConfig(tempDir);
            const compactionPrompt = await loadCompactionPromptContract(tempDir);
            const branchSummaryPrompt = await loadBranchSummaryPromptContract(tempDir);
            assert.deepEqual(loadedConfig, DEFAULT_CONFIG);
            assert.equal(compactionPrompt, DEFAULT_COMPACTION_PROMPT_CONTRACT);
            assert.equal(branchSummaryPrompt, undefined);
        });
    });

    it("loads compaction prompt overrides but falls back when the file is blank", async () => {
        const tempDir = await mkdtemp(path.join(os.tmpdir(), "grounded-compaction-test-"));
        tempDirs.push(tempDir);

        await writeFile(path.join(tempDir, "compaction-prompt.md"), "\n\n", "utf8");
        assert.equal(await loadCompactionPromptContract(tempDir), DEFAULT_COMPACTION_PROMPT_CONTRACT);

        await writeFile(path.join(tempDir, "compaction-prompt.md"), "Use bullet points", "utf8");
        assert.equal(await loadCompactionPromptContract(tempDir), "Use bullet points");
    });

    it("treats missing or blank branch-summary prompts as absent", async () => {
        const tempDir = await mkdtemp(path.join(os.tmpdir(), "grounded-compaction-test-"));
        tempDirs.push(tempDir);

        assert.equal(await loadBranchSummaryPromptContract(tempDir), undefined);

        await writeFile(path.join(tempDir, "branch-summary-prompt.md"), "\n\n", "utf8");
        assert.equal(await loadBranchSummaryPromptContract(tempDir), undefined);

        await writeFile(path.join(tempDir, "branch-summary-prompt.md"), "Use this contract", "utf8");
        assert.equal(await loadBranchSummaryPromptContract(tempDir), "Use this contract");
    });

    it("accepts a declared defaultPreset", () => {
        const config = parseConfig({
            defaultPreset: "fast",
            presets: {
                fast: {
                    model: "openai-codex/gpt-5.4-mini",
                    thinkingLevel: "medium",
                },
            },
        });

        assert.equal(config.defaultPreset, "fast");
    });

    it("accepts an exact declared largeContextPreset", () => {
        const config = parseConfig({
            defaultPreset: "fast",
            largeContextPreset: "large",
            presets: {
                fast: { model: "openai-codex/gpt-5.4-mini" },
                large: { model: "openai-codex/gpt-5.4" },
            },
        });

        assert.equal(config.largeContextPreset, "large");
    });

    it("uses full tool results by default and accepts a positive character limit", () => {
        assert.equal(parseConfig({}).toolResultChars, null);
        assert.equal(parseConfig({ toolResultChars: null }).toolResultChars, null);
        assert.equal(parseConfig({ toolResultChars: 8_000 }).toolResultChars, 8_000);
    });

    it("rejects invalid toolResultChars values", () => {
        for (const toolResultChars of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "2000"]) {
            assert.throws(
                () => parseConfig({ toolResultChars }),
                /toolResultChars must be null or a positive integer/,
            );
        }
    });

    it("rejects invalid largeContextPreset references", () => {
        const presets = {
            fast: { model: "openai-codex/gpt-5.4-mini" },
            large: { model: "openai-codex/gpt-5.4" },
        };

        assert.throws(
            () => parseConfig({ defaultPreset: "fast", largeContextPreset: " ", presets }),
            /largeContextPreset must be a non-empty string/,
        );
        assert.throws(
            () => parseConfig({ defaultPreset: "fast", largeContextPreset: "Large", presets }),
            /largeContextPreset 'Large' was not found in presets/,
        );
        assert.throws(
            () => parseConfig({ defaultPreset: "fast", largeContextPreset: "fast", presets }),
            /largeContextPreset must differ from defaultPreset/,
        );
        assert.throws(
            () => parseConfig({ defaultPreset: "fast", largeContextPreset: 5, presets }),
            /largeContextPreset must be a non-empty string/,
        );
    });
});

describe("grounded-compaction preset resolution", () => {
    const presets: GroundedCompactionConfig["presets"] = {
        cheap: { model: "google/gemini-2.5-flash" },
        CheapCase: { model: "google/gemini-2.5-pro" },
        expensive: { model: "anthropic/claude-sonnet-4" },
        "fast-debug": { model: "openrouter/deepseek" },
    };

    it("matches exact case-sensitive names first", () => {
        const result = resolvePresetMatch(presets, "cheap");
        assert.equal(result.kind, "matched");
        assert.equal(result.name, "cheap");
    });

    it("supports deterministic prefix and normalized substring matching", () => {
        assert.equal(resolvePresetMatch(presets, "exp").name, "expensive");
        assert.equal(resolvePresetMatch(presets, "debug").name, "fast-debug");
    });

    it("treats ambiguous matches as ambiguous", () => {
        const result = resolvePresetMatch(presets, "cheapcase");
        assert.equal(result.kind, "matched");
        assert.equal(result.name, "CheapCase");

        const ambiguous = resolvePresetMatch(
            {
                alpha: { model: "a/b" },
                alpine: { model: "c/d" },
            },
            "alp",
        );
        assert.equal(ambiguous.kind, "ambiguous");
    });
});
