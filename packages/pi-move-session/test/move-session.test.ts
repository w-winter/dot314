import { describe, expect, test } from "bun:test";

import {
    getMainWorktreeRootFromWorktreeList,
    isMainWorktreeTarget,
    MAIN_WORKTREE_TOKEN,
    normalizeTargetCwd,
} from "../../../extensions/_shared/normalize-target-cwd";

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
