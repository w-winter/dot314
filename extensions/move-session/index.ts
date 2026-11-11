/** Move the current session or its entire family to another working directory and relaunch Pi. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import {
    statSync,
    openSync,
    readSync,
    writeSync,
    closeSync,
    renameSync,
    unlinkSync,
} from "node:fs";

import {
    getMainWorktreeRootFromWorktreeList,
    isMainWorktreeTarget,
    MAIN_WORKTREE_TOKEN,
    normalizeTargetCwd,
} from "../_shared/normalize-target-cwd";
import { FAMILY_FLAG, parseMoveArguments } from "./arguments.ts";
import { moveSessionFamily } from "./family.ts";

const TRASH_TIMEOUT_MS = 5000;
const HEADER_READ_MAX = 8192;
const COPY_CHUNK_SIZE = 65_536;

interface Relaunch {
    state: { kind: "idle" } | { kind: "terminal-released" } | { kind: "running"; exit: Promise<number> };
}

function getBranchSelectionWarning(
    sourceSessionFile: string,
    currentLeafId: string | null,
    commandName: string,
    actionName: string,
): string | null {
    try {
        const persistedSession = SessionManager.open(sourceSessionFile);
        const hasPersistedEntries = persistedSession.getEntries().length > 0;
        if (!hasPersistedEntries) {
            return null;
        }

        const persistedLeafId = persistedSession.getLeafId() as string | null;
        if (currentLeafId === null) {
            return `${commandName} will not preserve the current /tree root selection. It reopens at the session file's default branch tip. Consider /fork first or continue from the branch tip before ${actionName}.`;
        }

        if (currentLeafId !== persistedLeafId) {
            return `${commandName} will not preserve the current /tree selection. It reopens at the session file's default branch tip. Consider /fork first or continue from the branch tip before ${actionName}.`;
        }
    } catch {
        // Ignore warning-detection failures
    }

    return null;
}

/**
 * Remove parentSession from the first JSONL header line without loading
 * the entire file into memory
 */
function clearParentSession(sessionFile: string): void {
    const fd = openSync(sessionFile, "r");
    const headerBuffer = Buffer.alloc(HEADER_READ_MAX);
    const bytesRead = readSync(fd, headerBuffer, 0, HEADER_READ_MAX, 0);
    const headerChunk = headerBuffer.toString("utf-8", 0, bytesRead);
    const newlineIndex = headerChunk.indexOf("\n");

    if (newlineIndex === -1) {
        closeSync(fd);
        return;
    }

    const header = JSON.parse(headerChunk.slice(0, newlineIndex));
    if (!header.parentSession) {
        closeSync(fd);
        return;
    }

    delete header.parentSession;
    const newHeaderLine = JSON.stringify(header) + "\n";
    const originalHeaderBytes = Buffer.byteLength(headerChunk.slice(0, newlineIndex + 1), "utf-8");

    const temporaryPath = sessionFile + ".move-session-tmp";
    let writeFd: number | undefined;
    try {
        writeFd = openSync(temporaryPath, "w");
        const newHeaderBuffer = Buffer.from(newHeaderLine, "utf-8");
        writeSync(writeFd, newHeaderBuffer, 0, newHeaderBuffer.length);

        const copyBuffer = Buffer.alloc(COPY_CHUNK_SIZE);
        let position = originalHeaderBytes;
        for (;;) {
            const readCount = readSync(fd, copyBuffer, 0, COPY_CHUNK_SIZE, position);
            if (readCount === 0) break;
            writeSync(writeFd, copyBuffer, 0, readCount);
            position += readCount;
        }

        closeSync(writeFd);
        writeFd = undefined;
        closeSync(fd);
        renameSync(temporaryPath, sessionFile);
    } catch (error) {
        if (writeFd !== undefined) {
            try {
                closeSync(writeFd);
            } catch {
                // ignore cleanup close errors
            }
        }

        closeSync(fd);
        try {
            unlinkSync(temporaryPath);
        } catch {
            // ignore cleanup unlink errors
        }
        throw error;
    }
}

export default function (pi: ExtensionAPI) {
    const resolveTargetCwd = async (rawTargetCwd: string, cwd: string): Promise<string> => {
        if (!isMainWorktreeTarget(rawTargetCwd)) {
            return normalizeTargetCwd(rawTargetCwd, process.env, cwd);
        }

        const result = await pi.exec("git", ["worktree", "list", "--porcelain"], { cwd, timeout: 5000 });
        if (result.code !== 0) {
            const stderr = result.stderr.trim();
            throw new Error(stderr || `git worktree list --porcelain failed with code ${result.code}`);
        }

        return getMainWorktreeRootFromWorktreeList(result.stdout);
    };

    const trash = async (paths: string[]) => {
        const result = await pi.exec("trash", paths, { timeout: TRASH_TIMEOUT_MS });
        if (result.code !== 0) throw new Error(`trash failed: ${result.stderr.trim() || result.code}`);
    };

    pi.registerCommand("move-session", {
        description: "Move session to another directory; --family includes all related sessions",
        getArgumentCompletions: (argumentPrefix: string) => {
            const trimmedPrefix = argumentPrefix.trimStart();
            const familyPrefix = /^--family\s+/.exec(trimmedPrefix)?.[0] ?? "";
            const targetPrefix = trimmedPrefix.slice(familyPrefix.length);
            const completions = [
                ...(!familyPrefix && FAMILY_FLAG.startsWith(trimmedPrefix) ? [{
                    value: FAMILY_FLAG,
                    label: FAMILY_FLAG,
                    description: "Move the oldest ancestor and every descendant together",
                }] : []),
                ...(MAIN_WORKTREE_TOKEN.startsWith(targetPrefix) ? [{
                    value: familyPrefix + MAIN_WORKTREE_TOKEN,
                    label: MAIN_WORKTREE_TOKEN,
                    description: "Move to this repository's main git worktree",
                }] : []),
            ];
            return completions.length ? completions : null;
        },
        handler: async (args, ctx) => {
            await ctx.waitForIdle();

            let parsed: ReturnType<typeof parseMoveArguments>;
            try {
                parsed = parseMoveArguments(args);
            } catch (error) {
                ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
                return;
            }

            let targetCwd: string;
            try {
                targetCwd = await resolveTargetCwd(parsed.targetCwd, ctx.cwd);
            } catch (error) {
                ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
                return;
            }

            let targetCwdStat;
            try {
                targetCwdStat = statSync(targetCwd);
            } catch (error) {
                const code = error instanceof Error && "code" in error ? error.code : undefined;
                if (code === "ENOENT") {
                    ctx.ui.notify(`Path does not exist: ${targetCwd}`, "error");
                } else {
                    ctx.ui.notify(`Cannot access path: ${targetCwd}`, "error");
                }
                return;
            }

            if (!targetCwdStat.isDirectory()) {
                ctx.ui.notify(`Not a directory: ${targetCwd}`, "error");
                return;
            }

            const sourceSessionFile = ctx.sessionManager.getSessionFile();
            if (!sourceSessionFile) {
                ctx.ui.notify("No persistent session file (maybe started with --no-session)", "error");
                return;
            }

            const branchSelectionWarning = getBranchSelectionWarning(
                sourceSessionFile,
                ctx.sessionManager.getLeafId() as string | null,
                "/move-session",
                "moving",
            );
            if (branchSelectionWarning) {
                ctx.ui.notify(branchSelectionWarning, "warning");
            }

            const relaunch: Relaunch = { state: { kind: "idle" } };
            const launch = async (destSessionFile: string): Promise<void> => {
                // Reset before spawning to avoid nesting Kitty protocol flags.
                process.stdout.write("\x1b[<u");      // Pop kitty keyboard protocol
                process.stdout.write("\x1b[?2004l");  // Disable bracketed paste
                process.stdout.write("\x1b[?25h");    // Show cursor
                process.stdout.write("\r\n");         // Ensure child starts on a clean line

                if (process.stdin.isTTY) {
                    process.stdin.setRawMode(false);
                }
                relaunch.state = { kind: "terminal-released" };

                // Spawn new pi in the target directory
                const child = spawn("pi", ["--session", destSessionFile], {
                    cwd: targetCwd,
                    stdio: "inherit",
                });

                const exit = new Promise<number>((resolve) => child.once("exit", (code) => resolve(code ?? 0)));
                await once(child, "spawn");
                relaunch.state = { kind: "running", exit };

                // Use destroy() because pause() still lets the parent steal keypresses.
                process.stdin.removeAllListeners();
                process.stdin.destroy();
                process.removeAllListeners("SIGINT");
                process.removeAllListeners("SIGTERM");
                process.on("SIGINT", () => {});
                process.on("SIGTERM", () => {});
            };

            try {
                if (parsed.scope === "family") {
                    if (!ctx.hasUI) throw new Error("Family moves require interactive confirmation.");
                    await moveSessionFamily({
                        sourceSessionFile,
                        targetCwd,
                        sessionsRoot: join(getAgentDir(), "sessions"),
                        targetSessionDir: SessionManager.create(targetCwd).getSessionDir(),
                        confirm: (sources) => ctx.ui.confirm(
                            `Move ${sources.length} sessions to ${targetCwd}?`,
                            "Close any other Pi process using the sessions listed below. After verifying the copies, " +
                            "Pi will reopen the current session in the target directory and move the originals to Trash.\n\n" +
                            sources.join("\n"),
                        ),
                        launch,
                        trash,
                    });
                } else {
                    const forked = SessionManager.forkFrom(sourceSessionFile, targetCwd);
                    const destSessionFile = forked.getSessionFile();
                    if (!destSessionFile) throw new Error("Internal error: forkFrom() produced no session file");
                    clearParentSession(destSessionFile);
                    await launch(destSessionFile);
                    await trash([sourceSessionFile]);
                }
            } catch (error) {
                const message = `Failed to move session: ${error instanceof Error ? error.message : String(error)}`;
                if (relaunch.state.kind !== "idle") process.stderr.write(message + "\n");
                else ctx.ui.notify(message, "error");
            }
            // Wait for cleanup even if the child exits immediately after spawning.
            if (relaunch.state.kind === "running") process.exit(await relaunch.state.exit);
            if (relaunch.state.kind === "terminal-released") process.exit(1);
        },
    });
}
