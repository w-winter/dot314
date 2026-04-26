import { resolve } from "node:path";

export const MAIN_WORKTREE_TOKEN = "$main-worktree";

export function isMainWorktreeTarget(rawTargetCwd: string): boolean {
    return rawTargetCwd === MAIN_WORKTREE_TOKEN;
}

export function getMainWorktreeRootFromWorktreeList(worktreeListOutput: string): string {
    const firstEntry = worktreeListOutput.trim().split(/\n\n+/)[0];
    if (!firstEntry) {
        throw new Error("Cannot determine main git worktree from empty worktree list");
    }

    const lines = firstEntry.split("\n");
    if (lines.includes("bare")) {
        throw new Error("Cannot determine main git worktree from bare repository");
    }

    const worktreeLine = lines.find((line) => line.startsWith("worktree "));
    if (!worktreeLine) {
        throw new Error("Cannot determine main git worktree from worktree list");
    }

    return resolve(worktreeLine.slice("worktree ".length));
}

export function normalizeTargetCwd(
    rawTargetCwd: string,
    env: NodeJS.ProcessEnv = process.env,
    cwd: string = process.cwd(),
): string {
    let targetCwd = rawTargetCwd;
    if (/^~(?=$|\/)/.test(rawTargetCwd)) {
        const home = env.HOME || env.USERPROFILE;
        if (!home) {
            throw new Error("Cannot expand '~': $HOME is not set");
        }
        targetCwd = rawTargetCwd.replace(/^~(?=$|\/)/, home);
    }
    return resolve(cwd, targetCwd);
}
