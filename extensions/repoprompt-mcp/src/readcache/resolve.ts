// readcache/resolve.ts - best-effort local path resolution for RepoPrompt read_file

import { access } from "node:fs/promises";
import * as path from "node:path";

import type { RpBinding } from "../types.js";
import { fetchWindowRoots } from "../binding.js";

const ROOTS_CACHE = new Map<string, string[]>();

export function clearRootsCache(): void {
  ROOTS_CACHE.clear();
}

async function getWindowRootsCached(binding: RpBinding): Promise<string[]> {
  const cacheKey = `${binding.app}:${binding.windowId}`;
  const cached = ROOTS_CACHE.get(cacheKey);
  if (cached) {
    return cached;
  }

  const roots = await fetchWindowRoots(binding.windowId, { activeApp: binding.app });
  ROOTS_CACHE.set(cacheKey, roots);
  return roots;
}

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
    return { rootHint: parts[0], relPath: parts.slice(1).join("/") };
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
  inputPath: string,
  cwd: string,
  binding: RpBinding | null
): Promise<ResolvePathResult> {
  const pathDisplay = inputPath;

  // Absolute paths
  if (path.isAbsolute(inputPath)) {
    return {
      absolutePath: (await fileExists(inputPath)) ? inputPath : null,
      repoRoot: null,
      pathDisplay,
    };
  }

  const roots = binding ? await getWindowRootsCached(binding) : [];

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
    return { absolutePath: null, repoRoot: null, pathDisplay };
  }

  // Try cwd-relative
  const cwdAbs = path.resolve(cwd, inputPath);
  if (await fileExists(cwdAbs)) {
    return {
      absolutePath: cwdAbs,
      repoRoot: pickRepoRootForFile(cwdAbs, roots),
      pathDisplay,
    };
  }

  return { absolutePath: null, repoRoot: null, pathDisplay };
}
