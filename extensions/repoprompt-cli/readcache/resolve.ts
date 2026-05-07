// readcache/resolve.ts - resolve rp-cli read_file paths to local absolute paths

import { access } from "node:fs/promises";
import * as path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface ResolvePathResult {
    absolutePath: string | null;
    repoRoot: string | null;
    pathDisplay: string;
}

async function fileExists(absolutePath: string): Promise<boolean> {
    try {
        await access(absolutePath);
        return true;
    } catch {
        return false;
    }
}

function normalizeRootLine(line: string): string | null {
    let trimmed = line.trim();

    if (!trimmed) {
        return null;
    }

    // Handle bullet lists like "- /path" or "• /path"
    trimmed = trimmed.replace(/^[-*•]\s+/, "");

    // Expand home
    if (trimmed.startsWith("~")) {
        // We intentionally don't expand here; rp-cli roots should be absolute already
        return null;
    }

    if (path.isAbsolute(trimmed)) {
        return trimmed;
    }

    return null;
}

function parseRootList(text: string): string[] {
    const roots = new Set<string>();

    for (const line of text.split("\n")) {
        const root = normalizeRootLine(line);
        if (root) {
            roots.add(root);
        }
    }

    return [...roots];
}

const ROOTS_CACHE = new Map<number, string[]>();

export function clearRootsCache(windowId?: number): void {
    if (windowId !== undefined) {
        ROOTS_CACHE.delete(windowId);
        return;
    }
    ROOTS_CACHE.clear();
}

async function fetchWindowRootsViaCli(pi: ExtensionAPI, windowId: number, tab?: string): Promise<string[]> {
    const args: string[] = ["-w", String(windowId)];
    if (tab) {
        args.push("-t", tab);
    }

    // Use rp-cli exec mode to call the underlying MCP tool. This reliably returns one absolute root per line.
    // (Using `tree type=roots` is NOT supported by rp-cli and can return an error string instead of roots.)
    args.push("-q", "-e", 'call get_file_tree {"type":"roots"}');

    const result = await pi.exec("rp-cli", args, { timeout: 10_000 });
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    const output = [stdout, stderr].filter(Boolean).join("\n");

    return parseRootList(output);
}

async function getWindowRootsCached(pi: ExtensionAPI, windowId: number, tab?: string): Promise<string[]> {
    const cached = ROOTS_CACHE.get(windowId);
    if (cached) {
        return cached;
    }

    const roots = await fetchWindowRootsViaCli(pi, windowId, tab);
    ROOTS_CACHE.set(windowId, roots);
    return roots;
}

function parseRootPrefixedPath(rawPath: string): { rootHint: string; relPath: string } | null {
    // rootHint:rel/path
    const colonIdx = rawPath.indexOf(":");
    if (colonIdx > 0) {
        const rootHint = rawPath.slice(0, colonIdx).trim();
        const relPath = rawPath.slice(colonIdx + 1).replace(/^\/+/, "");
        if (rootHint && relPath) {
            return { rootHint, relPath };
        }
    }

    // rootHint/rel/path (common in RP outputs)
    const parts = rawPath.split(/[\\/]+/).filter(Boolean);
    if (parts.length >= 2) {
        return { rootHint: parts[0] ?? "", relPath: parts.slice(1).join("/") };
    }

    return null;
}

function pickRepoRootForFile(absolutePath: string, roots: string[]): string | null {
    const normalized = path.resolve(absolutePath);

    let best: string | null = null;
    let bestDepth = -1;

    for (const root of roots) {
        const resolvedRoot = path.resolve(root);

        if (normalized === resolvedRoot) {
            const depth = resolvedRoot.split(path.sep).filter(Boolean).length;
            if (depth > bestDepth) {
                best = resolvedRoot;
                bestDepth = depth;
            }
            continue;
        }

        const rel = path.relative(resolvedRoot, normalized);
        if (rel.startsWith("..") || path.isAbsolute(rel)) {
            continue;
        }

        const depth = resolvedRoot.split(path.sep).filter(Boolean).length;
        if (depth > bestDepth) {
            best = resolvedRoot;
            bestDepth = depth;
        }
    }

    return best;
}

export async function resolveReadFilePath(
    pi: ExtensionAPI,
    inputPath: string,
    cwd: string,
    windowId: number,
    tab?: string,
): Promise<ResolvePathResult> {
    const pathDisplay = inputPath;

    const roots = await getWindowRootsCached(pi, windowId, tab);

    if (path.isAbsolute(inputPath)) {
        const absolutePath = (await fileExists(inputPath)) ? inputPath : null;
        if (!absolutePath) {
            return { absolutePath: null, repoRoot: null, pathDisplay };
        }

        return {
            absolutePath,
            repoRoot: pickRepoRootForFile(absolutePath, roots),
            pathDisplay,
        };
    }

    // rootHint:relPath or rootHint/relPath
    const rootPrefixed = parseRootPrefixedPath(inputPath);
    if (rootPrefixed) {
        const { rootHint, relPath } = rootPrefixed;

        const matches: Array<{ abs: string; root: string }> = [];

        for (const root of roots) {
            const baseName = path.basename(root);
            if (baseName !== rootHint) {
                continue;
            }

            const abs = path.join(root, relPath);
            if (await fileExists(abs)) {
                matches.push({ abs, root });
            }
        }

        if (matches.length === 1) {
            const match = matches[0];
            return {
                absolutePath: match?.abs ?? null,
                repoRoot: match?.root ?? null,
                pathDisplay,
            };
        }

        if (matches.length > 1) {
            // Ambiguous: same rootHint resolves to multiple roots
            return { absolutePath: null, repoRoot: null, pathDisplay };
        }
    }

    // Try path under each root
    const matches: Array<{ abs: string; root: string }> = [];
    for (const root of roots) {
        const abs = path.join(root, inputPath);
        if (await fileExists(abs)) {
            matches.push({ abs, root });
        }
    }

    if (matches.length === 1) {
        const match = matches[0];
        return {
            absolutePath: match?.abs ?? null,
            repoRoot: match?.root ?? null,
            pathDisplay,
        };
    }

    if (matches.length > 1) {
        // Ambiguous: multiple roots contain this relative path
        // Fail open: do NOT fall back to Pi's process cwd, as that can mismatch RepoPrompt's own path resolution
        return { absolutePath: null, repoRoot: null, pathDisplay };
    }

    // No match under any root
    return { absolutePath: null, repoRoot: null, pathDisplay };
}
