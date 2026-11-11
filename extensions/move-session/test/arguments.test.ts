import { describe, expect, test } from "bun:test";

import {
    getMainWorktreeRootFromWorktreeList,
    isMainWorktreeTarget,
    MAIN_WORKTREE_TOKEN,
    normalizeTargetCwd,
} from "../../_shared/normalize-target-cwd";
import { parseMoveArguments } from "../arguments.ts";

describe("move-session arguments", () => {
    test("parses family moves and retains spaces in the target path", () => {
        expect(parseMoveArguments(" --family /work/my project ")).toEqual({
            scope: "family", targetCwd: "/work/my project",
        });
        expect(parseMoveArguments("--family $main-worktree")).toEqual({
            scope: "family", targetCwd: "$main-worktree",
        });
    });

    test("keeps single-session paths intact", () => {
        expect(parseMoveArguments(" ~/my project ")).toEqual({ scope: "session", targetCwd: "~/my project" });
        expect(parseMoveArguments("./--family")).toEqual({ scope: "session", targetCwd: "./--family" });
    });

    test("requires a target", () => {
        expect(() => parseMoveArguments("")).toThrow("Usage");
        expect(() => parseMoveArguments("--family")).toThrow("Usage");
    });
});

describe("normalizeTargetCwd", () => {
    test("resolves relative target paths to absolute paths", () => {
        expect(normalizeTargetCwd("../foo", {}, "/tmp/work/project")).toBe("/tmp/work/foo");
    });

    test("expands ~ before resolving the target path", () => {
        expect(normalizeTargetCwd("~/code", { HOME: "/Users/tester" }, "/tmp/work/project")).toBe(
            "/Users/tester/code",
        );
    });

    test("identifies the main worktree token", () => {
        expect(isMainWorktreeTarget(MAIN_WORKTREE_TOKEN)).toBe(true);
        expect(isMainWorktreeTarget("$root")).toBe(false);
    });

    test("reads the main worktree root from the first worktree list entry", () => {
        const worktreeListOutput = [
            "worktree /Users/tester/project",
            "HEAD 1234567890abcdef",
            "branch refs/heads/main",
            "",
            "worktree /Users/tester/project-feature",
            "HEAD abcdef1234567890",
            "branch refs/heads/feature",
            "",
        ].join("\n");

        expect(getMainWorktreeRootFromWorktreeList(worktreeListOutput)).toBe("/Users/tester/project");
    });

    test("rejects bare repositories without a main worktree", () => {
        expect(() => getMainWorktreeRootFromWorktreeList("worktree /Users/tester/project.git\nbare\n")).toThrow(
            "Cannot determine main git worktree",
        );
    });
});
