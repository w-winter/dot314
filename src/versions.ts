// The versions a debug log was written by: the bridge commit, the host Pi and
// Node at extension load, and Claude Code's version as its queries report it.
// Versions and a commit only, never a path or any other payload.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEBUG, debug } from "./debug.ts";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readGitFile(path: string): string | undefined {
	try { return readFileSync(path, "utf8").trim(); } catch { return undefined; }
}

/** The commit the bridge was loaded from, read once from its clone's `.git`
 *  (a directory, or a worktree's `gitdir:` file). Undefined outside a clone. */
function readBridgeCommit(root: string): string | undefined {
	try {
		let gitDir = join(root, ".git");
		const pointer = readGitFile(gitDir);
		if (pointer?.startsWith("gitdir:")) gitDir = resolve(root, pointer.slice("gitdir:".length).trim());
		else if (!existsSync(join(gitDir, "HEAD"))) return undefined;
		const commonDirRef = readGitFile(join(gitDir, "commondir"));
		const commonDir = commonDirRef ? resolve(gitDir, commonDirRef) : gitDir;
		const head = readGitFile(join(gitDir, "HEAD"));
		if (!head) return undefined;
		if (!head.startsWith("ref:")) return /^[0-9a-f]{40}$/.test(head) ? head.slice(0, 12) : undefined;
		const ref = head.slice("ref:".length).trim();
		const loose = readGitFile(join(gitDir, ref)) ?? readGitFile(join(commonDir, ref));
		if (loose && /^[0-9a-f]{40}$/.test(loose)) return loose.slice(0, 12);
		const packed = readGitFile(join(commonDir, "packed-refs"));
		const line = packed?.split("\n").find((entry) => entry.endsWith(` ${ref}`));
		const sha = line?.split(" ")[0];
		return sha && /^[0-9a-f]{40}$/.test(sha) ? sha.slice(0, 12) : undefined;
	} catch {
		return undefined;
	}
}

/** The host Pi's version, from the package its CLI entry belongs to. Read
 *  from disk: importing the host package from here would evaluate it again. */
function readPiVersion(): string | undefined {
	try {
		const entry = process.argv[1];
		if (!entry) return undefined;
		let dir = dirname(realpathSync(entry));
		for (let i = 0; i < 6; i++) {
			const pkg = readGitFile(join(dir, "package.json"));
			if (pkg) {
				const parsed = JSON.parse(pkg) as { name?: unknown; version?: unknown };
				if ((parsed.name === "@earendil-works/pi-coding-agent" || parsed.name === "@mariozechner/pi-coding-agent") && typeof parsed.version === "string") return parsed.version;
			}
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	} catch { /* not a Pi process */ }
	return undefined;
}

const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z]{1,20}(?:\.[0-9A-Za-z]{1,20}){0,3})?$/;

/** One debug line naming the bridge commit, Pi and Node. The commit and the
 *  Pi version are read from disk, so nothing is read with DEBUG off. */
export function logVersions(): void {
	if (!DEBUG) return;
	const pi = readPiVersion();
	debug(`versions: bridge=${readBridgeCommit(PACKAGE_ROOT) ?? "unknown"} pi=${pi && VERSION.test(pi) ? pi : "unknown"} node=${process.version}`);
}

// Process-global, so a second copy of the bridge (a subagent's, or one loaded
// by /reload) does not log a version this process already logged.
const CLAUDE_CODE_VERSION_KEY = Symbol.for("pi-claude-bridge.claude-code-version.v1");

/** One debug line for the Claude Code version a query's init message reports,
 *  the first time this process sees a version and whenever it changes. A value
 *  that is not a plain version is not logged. */
export function logClaudeCodeVersion(version: unknown): void {
	if (!DEBUG || typeof version !== "string" || !VERSION.test(version)) return;
	const host = globalThis as Record<symbol, unknown>;
	if (host[CLAUDE_CODE_VERSION_KEY] === version) return;
	host[CLAUDE_CODE_VERSION_KEY] = version;
	debug(`versions: claude-code=${version}`);
}
