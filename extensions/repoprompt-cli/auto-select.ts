// auto-select.ts - helpers for automatically selecting read_file context in RepoPrompt

import * as fs from "node:fs";
import { stat } from "node:fs/promises";

export type SelectionMode = "full" | "slices" | "codemap_only";

export interface SelectionStatus {
  mode: SelectionMode;

  // Only relevant for codemap-only selection entries
  codemapManual?: boolean;
}

export interface SliceRange {
  start_line: number;
  end_line: number;
}

export function toPosixPath(inputPath: string): string {
  return inputPath.replace(/\\/g, "/");
}

export function inferSelectionStatus(selectionText: string, selectionPath: string): SelectionStatus | null {
  if (!selectionText || !selectionPath) {
    return null;
  }

  const target = toPosixPath(selectionPath).replace(/\/+$/, "");

  const normalizeDir = (dir: string): string => {
    const normalized = toPosixPath(dir).trim();
    return normalized.endsWith("/") ? normalized : `${normalized}/`;
  };

  const joinPath = (dir: string, name: string): string => {
    if (!dir) {
      return name;
    }
    return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
  };

  const lines = selectionText.split("\n");

  let section: "selected" | "codemaps" | null = null;

  // Base directory for the current tree (RepoPrompt prints a root line like `agent/src/`)
  let baseDir: string | null = null;

  // Prefix stack for tree-indented directory lines
  const prefixes: string[] = [];

  const stripTrailingSelectionMetadata = (value: string): string => {
    let current = value.trim();

    // RepoPrompt usually separates metadata with an em dash, but not always
    // We normalize both forms:
    //   file.ts — 120 tokens (lines 1-20)
    //   file.ts (lines 1-20)
    const dashIndex = current.indexOf(" — ");
    if (dashIndex !== -1) {
      current = current.slice(0, dashIndex).trim();
    }

    const metadataPatterns = [
      // Slice metadata at end of line
      // Examples:
      //   file.ts (lines 1-20)
      //   file.ts (lines 1-20, 120-129)
      //   file.ts (line 5)
      /\s+\(lines?\s+\d+\s*-\s*\d+(?:\s*,\s*\d+\s*-\s*\d+)*\)\s*$/i,
      /\s+\(line\s+\d+\)\s*$/i,

      /\s+\((?:manual|auto|full)\)\s*$/i,

      // Token metadata at end of line
      /\s+\d[\d,]*\s+tokens(?:\s+\((?:manual|auto|full|lines?\s+\d+\s*-\s*\d+(?:\s*,\s*\d+\s*-\s*\d+)*)\))?\s*$/i,
    ];

    let changed = true;
    while (changed) {
      changed = false;

      for (const pattern of metadataPatterns) {
        const next = current.replace(pattern, "").trimEnd();
        if (next !== current) {
          current = next;
          changed = true;
        }
      }
    }

    return current.trim();
  };

  const considerMatch = (nodePath: string, rest: string): SelectionStatus | null => {
    const normalizedNode = toPosixPath(nodePath).replace(/\/+$/, "");
    if (normalizedNode !== target) {
      return null;
    }

    if (section === "selected") {
      // RepoPrompt may render multiple ranges as: (lines 1-20, 120-129)
      // We treat anything that looks like a line/lines annotation as slice selection
      if (/\(\s*lines?\s+\d+/i.test(rest) || /\(\s*line\s+\d+/i.test(rest)) {
        return { mode: "slices" };
      }

      return { mode: "full" };
    }

    if (section === "codemaps") {
      return {
        mode: "codemap_only",
        codemapManual: /\(manual\)/i.test(rest),
      };
    }

    return null;
  };

  for (const rawLine of lines) {
    const line = toPosixPath(rawLine).trimEnd();

    if (line.includes("### Selected Files")) {
      section = "selected";
      baseDir = null;
      prefixes.length = 0;
      continue;
    }

    if (line.includes("### Codemaps")) {
      section = "codemaps";
      baseDir = null;
      prefixes.length = 0;
      continue;
    }

    // Root directory line: `agent/extensions/.../`
    if (line.endsWith("/") && !line.includes("──") && !line.includes(" — ")) {
      baseDir = normalizeDir(line);
      prefixes.length = 0;
      prefixes.push(baseDir);
      continue;
    }

    const markerMatch = line.match(/(├──|└──)\s+(.*)$/);
    if (!markerMatch) {
      continue;
    }

    const marker = markerMatch[1] ?? "";
    const markerIdx = line.indexOf(marker);
    const indentPrefix = markerIdx >= 0 ? line.slice(0, markerIdx) : "";

    // Tree indentation uses 4-char groups: `│   ` or `    `
    const indentDepth = Math.floor(indentPrefix.length / 4);

    const rest = (markerMatch[2] ?? "").trim();
    const name = stripTrailingSelectionMetadata(rest);

    if (!name) {
      continue;
    }

    const parentPrefix = prefixes[indentDepth] ?? baseDir;
    if (!parentPrefix) {
      continue;
    }

    const nodePath = joinPath(parentPrefix, name);

    if (name.endsWith("/")) {
      prefixes[indentDepth + 1] = normalizeDir(nodePath);
      prefixes.length = indentDepth + 2;
      continue;
    }

    const match = considerMatch(nodePath, rest);
    if (match) {
      return match;
    }
  }

  return null;
}

const LINE_COUNT_CACHE = new Map<string, { mtimeMs: number; size: number; lines: number }>();
const LINE_COUNT_CACHE_MAX_ENTRIES = 512;

async function countFileLinesUncached(absolutePath: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    let newlineCount = 0;
    let sawData = false;
    let lastByte: number | null = null;

    const stream = fs.createReadStream(absolutePath);

    stream.on("data", (chunk: Buffer | string) => {
      const buf = (typeof chunk === "string") ? Buffer.from(chunk, "utf8") : chunk;

      sawData = true;

      for (let i = 0; i < buf.length; i++) {
        if (buf[i] === 10) {
          newlineCount += 1;
        }
      }

      if (buf.length > 0) {
        lastByte = buf[buf.length - 1] ?? lastByte;
      }
    });

    stream.on("error", (err) => reject(err));

    stream.on("end", () => {
      if (!sawData) {
        resolve(0);
        return;
      }

      const lines = (lastByte === 10) ? newlineCount : newlineCount + 1;
      resolve(lines);
    });
  });
}

export async function countFileLines(absolutePath: string): Promise<number> {
  const st = await stat(absolutePath);

  const cached = LINE_COUNT_CACHE.get(absolutePath);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return cached.lines;
  }

  const lines = await countFileLinesUncached(absolutePath);
  LINE_COUNT_CACHE.set(absolutePath, { mtimeMs: st.mtimeMs, size: st.size, lines });

  while (LINE_COUNT_CACHE.size > LINE_COUNT_CACHE_MAX_ENTRIES) {
    const oldestKey = LINE_COUNT_CACHE.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    LINE_COUNT_CACHE.delete(oldestKey);
  }

  return lines;
}

export function computeSliceRangeFromReadArgs(
  startLine: number | undefined,
  limit: number | undefined,
  totalLines: number | undefined
): SliceRange | null {
  if (typeof startLine !== "number") {
    return null;
  }

  // Positive range reads
  if (startLine > 0) {
    if (typeof limit !== "number" || limit <= 0) {
      return null;
    }

    return {
      start_line: startLine,
      end_line: startLine + limit - 1,
    };
  }

  // Tail reads (-N)
  if (startLine < 0) {
    if (typeof totalLines !== "number" || totalLines <= 0) {
      return null;
    }

    const n = Math.abs(startLine);
    const start = Math.max(1, totalLines - n + 1);

    return {
      start_line: start,
      end_line: totalLines,
    };
  }

  return null;
}
