/**
 * Roam Extension
 *
 * Move the current Pi session into a tmux window for remote access
 *
 * Usage:
 *   /roam [window-name]    (default: cwd basename)
 *
 * Optional config (~/.pi/agent/extensions/roam/config.json):
 *   - copy from extensions/roam/config.json.example
 *   {
 *     "tailscale": {
 *       "account": "you@example.com",
 *       "binary": "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
 *     }
 *   }
 *
 * All Pi sessions share a single tmux session ("pi") on a dedicated socket (-L pi),
 * each in its own window. Uses a custom tmux config with dual prefix keys:
 *   - Ctrl+S (available on iOS Termius toolbar)
 *   - Ctrl+B (tmux default, for local use on Mac)
 *
 * The dedicated socket ensures the custom config is always applied, regardless
 * of other tmux servers that may be running.
 *
 * From Termius:
 *   - Attach: tmux -L pi -f ~/.config/pi-tmux/tmux.conf -u attach -t pi
 *   - Window list: Ctrl+S, then w
 *   - Next/prev window: Ctrl+S, then n/p
 *   - Detach: Ctrl+S, then d
 *   - No time limit between prefix and command key
 *
 * Flow:
 *   1. Pre-flight: TTY check, not already in tmux, session exists, tmux installed
 *   2. Optionally switch Tailscale account, then ensure Tailscale is up (non-fatal, macOS only)
 *   3. Fork the current Pi session to a new file (parentSession cleared)
 *   4. Create a tmux window (or session if first time) running the fork
 *   5. Tear down parent terminal, attach to tmux
 *   6. Trash original session file if in standard sessions dir (no duplicates)
 *   7. Parent becomes inert, forwarding exit code
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";
import {
    writeFileSync, existsSync, mkdirSync, realpathSync, readFileSync,
    openSync, readSync, writeSync, closeSync, renameSync, unlinkSync,
} from "node:fs";

const TMUX_SESSION = "pi";
const TMUX_SOCKET = "pi";
const TAILSCALE_BIN = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const TAILSCALE_TIMEOUT_MS = 10_000;
const TRASH_TIMEOUT_MS = 5_000;
const HEADER_READ_MAX = 8192;
const COPY_CHUNK_SIZE = 65_536;

const TMUX_CONFIG_CONTENT = [
    "# Pi roam config — only used by /roam sessions (dedicated socket: -L pi)",
    "# Does not affect your global ~/.tmux.conf or other tmux servers",
    "",
    "# Dual prefix: Ctrl+S (iOS Termius toolbar) and Ctrl+B (default, for local use)",
    "set -g prefix C-s",
    "set -g prefix2 C-b",
    "bind C-s send-prefix",
    "bind C-b send-prefix -2",
    "",
    "# UTF-8 and modern terminal support",
    "set -g default-terminal 'screen-256color'",
    "set -ga terminal-overrides ',xterm-256color:Tc'",
    "",
    "# Mouse support (useful for Termius touch scrolling)",
    "set -g mouse on",
    "",
    "# Start window numbering at 1 (easier to reach on mobile)",
    "set -g base-index 1",
    "setw -g pane-base-index 1",
    "",
    "# Window status shows the name clearly",
    "set -g status-left '[pi] '",
    "set -g status-right ''",
    "",
].join("\n");

type RoamConfig = {
    tailscale?: {
        account?: string;
        binary?: string;
    };
};

type ResolvedRoamConfig = {
    tailscaleAccount: string | null;
    tailscaleBinary: string;
};

function getAgentDir(): string {
    return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function getRoamConfigPath(): string {
    return join(getAgentDir(), "extensions", "roam", "config.json");
}

/**
 * Load optional /roam config and validate shape.
 * Missing config is treated as defaults.
 */
function loadRoamConfig(configPath: string): ResolvedRoamConfig {
    const defaults: ResolvedRoamConfig = {
        tailscaleAccount: null,
        tailscaleBinary: TAILSCALE_BIN,
    };

    if (!existsSync(configPath)) {
        return defaults;
    }

    let parsed: RoamConfig;
    try {
        parsed = JSON.parse(readFileSync(configPath, "utf-8")) as RoamConfig;
    } catch (error: any) {
        throw new Error(`Invalid JSON in ${configPath}: ${error?.message ?? String(error)}`);
    }

    const rawAccount = parsed.tailscale?.account;
    if (rawAccount !== undefined && typeof rawAccount !== "string") {
        throw new Error(`Invalid tailscale.account in ${configPath}; expected a string`);
    }

    const rawBinary = parsed.tailscale?.binary;
    if (rawBinary !== undefined && typeof rawBinary !== "string") {
        throw new Error(`Invalid tailscale.binary in ${configPath}; expected a string`);
    }

    return {
        tailscaleAccount: rawAccount?.trim() || null,
        tailscaleBinary: rawBinary?.trim() || TAILSCALE_BIN,
    };
}

/**
 * Write the tmux config file; throws on FS errors (caller must handle)
 */
function ensureTmuxConfig(): string {
    const configDir = join(
        process.env.HOME || process.env.USERPROFILE || "/tmp",
        ".config", "pi-tmux"
    );
    const configPath = join(configDir, "tmux.conf");

    if (!existsSync(configDir)) {
        mkdirSync(configDir, { recursive: true });
    }
    writeFileSync(configPath, TMUX_CONFIG_CONTENT);

    return configPath;
}

/**
 * Remove the parentSession field from a forked session's JSONL header
 * without reading the entire file into memory. Reads only the first line
 * (header), and if modification is needed, rewrites the file via a temp
 * file using chunked streaming for the remaining content.
 *
 * Throws on FS errors (caller must handle).
 */
function clearParentSession(sessionFile: string): void {
    const fd = openSync(sessionFile, "r");
    const buf = Buffer.alloc(HEADER_READ_MAX);
    const bytesRead = readSync(fd, buf, 0, HEADER_READ_MAX, 0);
    const headerChunk = buf.toString("utf-8", 0, bytesRead);
    const newlineIdx = headerChunk.indexOf("\n");

    if (newlineIdx === -1) {
        closeSync(fd);
        return;
    }

    const header = JSON.parse(headerChunk.slice(0, newlineIdx));
    if (!header.parentSession) {
        closeSync(fd);
        return;
    }

    // parentSession exists — stream-rewrite with modified header
    delete header.parentSession;
    const newHeaderLine = JSON.stringify(header) + "\n";
    const originalHeaderBytes = Buffer.byteLength(
        headerChunk.slice(0, newlineIdx + 1), "utf-8"
    );

    const tmpPath = sessionFile + ".roam-tmp";
    let wfd: number | undefined;
    try {
        wfd = openSync(tmpPath, "w");
        const headerBuf = Buffer.from(newHeaderLine, "utf-8");
        writeSync(wfd, headerBuf, 0, headerBuf.length);

        // Copy rest of file in chunks (avoids loading full session into memory)
        const copyBuf = Buffer.alloc(COPY_CHUNK_SIZE);
        let pos = originalHeaderBytes;
        while (true) {
            const n = readSync(fd, copyBuf, 0, COPY_CHUNK_SIZE, pos);
            if (n === 0) break;
            writeSync(wfd, copyBuf, 0, n);
            pos += n;
        }
        closeSync(wfd);
        wfd = undefined;
        closeSync(fd);
        renameSync(tmpPath, sessionFile);
    } catch (error) {
        // Clean up temp file on failure
        if (wfd !== undefined) try { closeSync(wfd); } catch {}
        closeSync(fd);
        try { unlinkSync(tmpPath); } catch {}
        throw error;
    }
}

/**
 * Strip control characters from a window name to prevent tmux breakage
 * and stdout parsing issues. Returns null if the result is empty.
 */
function sanitizeWindowName(name: string): string | null {
    const cleaned = name.replace(/[\x00-\x1f\x7f]/g, "").trim();
    return cleaned || null;
}

/**
 * Check if a session file is inside the standard Pi sessions directory (~/.pi/).
 * Custom --session paths (e.g. /some/custom/path.jsonl) should not be trashed.
 * Handles symlinks (e.g. ~/.pi/agent -> ~/dot314/agent) via realpathSync.
 */
function isInStandardSessionsDir(sessionFile: string): boolean {
    const home = process.env.HOME || process.env.USERPROFILE;
    if (!home) return false;
    const piDir = join(home, ".pi");
    try {
        const resolvedFile = realpathSync(sessionFile);
        const resolvedPiDir = realpathSync(piDir);
        return resolvedFile.startsWith(resolvedPiDir + "/");
    } catch {
        // realpathSync can fail if file/dir doesn't exist; fall back to resolve()
        return resolve(sessionFile).startsWith(resolve(piDir) + "/");
    }
}

export default function (pi: ExtensionAPI) {
    const trashFileBestEffort = async (filePath: string): Promise<boolean> => {
        try {
            const { code } = await pi.exec("trash", [filePath], { timeout: TRASH_TIMEOUT_MS });
            return code === 0;
        } catch {
            return false;
        }
    };

    pi.registerCommand("roam", {
        description: "Move session into a tmux window for remote access via Tailscale",
        handler: async (args, ctx) => {
            await ctx.waitForIdle();

            // --- Pre-flight checks ---

            if (!ctx.hasUI || !process.stdin.isTTY || !process.stdout.isTTY) {
                if (ctx.hasUI) {
                    ctx.ui.notify("/roam requires an interactive terminal", "error");
                }
                return;
            }

            if (process.env.TMUX) {
                ctx.ui.notify("Already inside tmux. Use Ctrl+S d (or Ctrl+B d) to detach.", "error");
                return;
            }

            const tmuxCheck = await pi.exec("which", ["tmux"]);
            if (tmuxCheck.code !== 0) {
                ctx.ui.notify("tmux is not installed", "error");
                return;
            }

            const sourceSessionFile = ctx.sessionManager.getSessionFile();
            if (!sourceSessionFile) {
                ctx.ui.notify("No persistent session (started with --no-session?)", "error");
                return;
            }

            const leafId = ctx.sessionManager.getLeafId();
            if (!leafId) {
                ctx.ui.notify("No messages yet — nothing to roam", "error");
                return;
            }

            const cwd = ctx.cwd;

            // Window name: from args or cwd basename, sanitized for tmux safety
            const rawName = args.trim() || basename(cwd);
            const windowName = sanitizeWindowName(rawName);
            if (!windowName) {
                ctx.ui.notify("Invalid window name (empty after sanitization)", "error");
                return;
            }

            let tailscaleAccount: string | null = null;
            let tailscaleBinary = TAILSCALE_BIN;
            const roamConfigPath = getRoamConfigPath();
            try {
                const roamConfig = loadRoamConfig(roamConfigPath);
                tailscaleAccount = roamConfig.tailscaleAccount;
                tailscaleBinary = roamConfig.tailscaleBinary;
            } catch (error: any) {
                ctx.ui.notify(
                    `Ignoring invalid /roam config (${roamConfigPath}): ${error?.message ?? String(error)}`,
                    "warning"
                );
            }

            // Ensure dedicated tmux config exists and is up to date
            let tmuxConfig: string;
            try {
                tmuxConfig = ensureTmuxConfig();
            } catch (error: any) {
                ctx.ui.notify(`Failed to write tmux config: ${error?.message ?? String(error)}`, "error");
                return;
            }

            // Common tmux flags: dedicated socket + config file
            const tmuxBase = ["-L", TMUX_SOCKET, "-f", tmuxConfig];

            // Check tmux state on our dedicated socket
            let sessionExists = false;
            try {
                const { code } = await pi.exec("tmux", [...tmuxBase, "has-session", "-t", TMUX_SESSION]);
                sessionExists = code === 0;
            } catch {
                // tmux server not running on this socket — we'll create a new session
            }

            // Source the latest config unconditionally — covers the case where the
            // server is running but our session doesn't exist yet. If the server
            // isn't running, this fails harmlessly. If the config has errors, we warn.
            {
                const { code: srcCode, stderr: srcStderr } = await pi.exec(
                    "tmux", [...tmuxBase, "source-file", tmuxConfig]
                );
                if (srcCode !== 0 && sessionExists) {
                    // Only warn if we know the server is running (otherwise failure
                    // just means "no server" which is expected and fine)
                    ctx.ui.notify(
                        `tmux config warning: ${srcStderr || "source-file failed"}`,
                        "warning"
                    );
                }
            }

            if (sessionExists) {
                // Check for duplicate window name
                const { code, stdout } = await pi.exec("tmux", [
                    ...tmuxBase,
                    "list-windows", "-t", TMUX_SESSION, "-F", "#{window_name}",
                ]);
                if (code !== 0) {
                    ctx.ui.notify("Failed to list tmux windows — tmux may be in an unexpected state", "error");
                    return;
                }
                const existingWindows = stdout.trim().split("\n").filter(Boolean);
                if (existingWindows.includes(windowName)) {
                    ctx.ui.notify(
                        `Window "${windowName}" already exists in tmux session "${TMUX_SESSION}". ` +
                            `Use: /roam <different-name>`,
                        "error"
                    );
                    return;
                }
            }

            // --- Tailscale (non-fatal, macOS only) ---

            if (process.platform === "darwin") {
                if (tailscaleAccount) {
                    ctx.ui.notify(`Switching Tailscale account: ${tailscaleAccount}`, "info");
                    try {
                        const { code, stderr } = await pi.exec(
                            tailscaleBinary,
                            ["switch", tailscaleAccount],
                            { timeout: TAILSCALE_TIMEOUT_MS }
                        );
                        if (code !== 0) {
                            ctx.ui.notify(
                                `Tailscale switch warning: ${stderr || "switch command failed"}`,
                                "warning"
                            );
                        }
                    } catch {
                        ctx.ui.notify("Tailscale switch unavailable — continuing", "warning");
                    }
                }

                ctx.ui.notify("Bringing up Tailscale...", "info");
                try {
                    const { code, stderr } = await pi.exec(tailscaleBinary, ["up"], {
                        timeout: TAILSCALE_TIMEOUT_MS,
                    });
                    if (code !== 0) {
                        ctx.ui.notify(`Tailscale warning: ${stderr || "failed to start"}`, "warning");
                    }
                } catch {
                    ctx.ui.notify("Tailscale not available — continuing without it", "warning");
                }
            }

            // --- Fork session ---
            // waitForIdle() above ensures the agent has finished streaming. Pi persists
            // entries via synchronous appendFileSync, so by the time waitForIdle() resolves
            // and the command handler runs, all entries should be flushed to disk.

            let destSessionFile: string;
            try {
                const forked = SessionManager.forkFrom(sourceSessionFile, cwd);
                const dest = forked.getSessionFile();
                if (!dest) {
                    ctx.ui.notify("Fork produced no session file", "error");
                    return;
                }
                destSessionFile = dest;
            } catch (error: any) {
                ctx.ui.notify(`Failed to fork session: ${error?.message ?? String(error)}`, "error");
                return;
            }

            // Remove parentSession pointer since we intend to trash the original.
            // A dangling parentSession would break session_lineage and session_ask.
            try {
                clearParentSession(destSessionFile);
            } catch (error: any) {
                // Non-fatal: the session still works, just has a dangling parentSession
                ctx.ui.notify(
                    `Warning: could not clear parent session reference: ${error?.message ?? String(error)}`,
                    "warning"
                );
            }

            // --- Create tmux window if session already exists ---
            // (must happen before terminal teardown so pi.exec still works)

            let tmuxArgs: string[];

            if (sessionExists) {
                // Add a new window to the existing "pi" session
                const { code, stderr, stdout } = await pi.exec("tmux", [
                    ...tmuxBase,
                    "new-window", "-t", TMUX_SESSION, "-n", windowName, "-c", cwd,
                    "pi", "--session", destSessionFile,
                ]);
                if (code !== 0) {
                    ctx.ui.notify(
                        `Failed to create tmux window: ${stderr || stdout || "unknown error"}`,
                        "error"
                    );
                    return;
                }
                // Attach to the session (new window is now current)
                tmuxArgs = [...tmuxBase, "-u", "attach", "-t", TMUX_SESSION];
            } else {
                // Create new session with first window (attaches automatically)
                tmuxArgs = [
                    ...tmuxBase, "-u", "new-session",
                    "-s", TMUX_SESSION, "-n", windowName, "-c", cwd,
                    "--", "pi", "--session", destSessionFile,
                ];
            }

            // --- Tear down parent terminal ---

            process.stdout.write("\x1b[<u");      // Pop kitty keyboard protocol
            process.stdout.write("\x1b[?2004l");  // Disable bracketed paste
            process.stdout.write("\x1b[?25h");    // Show cursor
            process.stdout.write("\r\n");

            if (process.stdin.isTTY && process.stdin.setRawMode) {
                process.stdin.setRawMode(false);
            }

            // --- Spawn tmux ---

            const child = spawn("tmux", tmuxArgs, { stdio: "inherit" });

            child.once("spawn", () => {
                // Trash the original session file to prevent duplicates in /resume,
                // but only if it's in the standard Pi sessions directory. Custom
                // --session paths should not be trashed as that would be surprising.
                if (isInStandardSessionsDir(sourceSessionFile)) {
                    void trashFileBestEffort(sourceSessionFile).then((trashed) => {
                        if (!trashed) {
                            process.stderr.write(
                                `\nNote: Could not trash original session file. Remove manually:\n  ${sourceSessionFile}\n`
                            );
                        }
                    });
                } else {
                    process.stderr.write(
                        `\nNote: Session file is at a custom path and was not trashed:\n  ${sourceSessionFile}\n` +
                            `The roamed session in tmux is independent. You may see duplicates in /resume.\n`
                    );
                }

                // Stop the parent from stealing keypresses
                process.stdin.removeAllListeners();
                process.stdin.destroy();

                // Parent should not react to signals
                process.removeAllListeners("SIGINT");
                process.removeAllListeners("SIGTERM");
                process.on("SIGINT", () => {});
                process.on("SIGTERM", () => {});
            });

            child.on("exit", (code) => process.exit(code ?? 0));
            child.on("error", (err) => {
                process.stderr.write(`Failed to launch tmux: ${err.message}\n`);
                process.exit(1);
            });
        },
    });
}
