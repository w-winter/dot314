import { spawnSync } from "node:child_process";

import { highlightCode, type Theme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import * as Diff from "diff";

import {
  buildDiffSummaryText,
  normalizeDiffRenderWidth,
  resolveDiffPresentationMode,
  type DiffPresentationMode,
  type DiffSummaryStats,
} from "./diff-presentation.js";
import { detectLanguageFromPath } from "./language-detection.js";
import type { DiffViewMode } from "./types.js";

export interface AdaptiveDiffRenderConfig {
  diffViewMode: DiffViewMode;
  diffSplitMinWidth: number;
  addRowBgMixRatio?: number;
  removeRowBgMixRatio?: number;
}

type DiffLineKind = "add" | "remove" | "context";
type DiffEntryKind = "line" | "meta" | "hunk" | "file";

interface DiffLineEntry {
  kind: "line";
  lineKind: DiffLineKind;
  oldLineNumber: number | null;
  newLineNumber: number | null;
  fallbackLineNumber: string;
  content: string;
  raw: string;
  hunkIndex: number;
  language: string | undefined;
}

interface DiffMetaEntry {
  kind: Exclude<DiffEntryKind, "line">;
  raw: string;
  hunkIndex: number;
}

type ParsedDiffEntry = DiffLineEntry | DiffMetaEntry;

interface ParsedDiff {
  entries: ParsedDiffEntry[];
  stats: DiffStats;
}

interface SplitDiffRow {
  left?: DiffLineEntry;
  right?: DiffLineEntry;
  meta?: DiffMetaEntry;
}

interface DiffStats {
  added: number;
  removed: number;
  context: number;
  hunks: number;
  files: number;
}

interface DiffSpan {
  start: number;
  end: number;
}

interface RgbColor {
  r: number;
  g: number;
  b: number;
}

interface DiffPalette {
  addRowBgAnsi: string;
  removeRowBgAnsi: string;
  addEmphasisBgAnsi: string;
  removeEmphasisBgAnsi: string;
}

const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*m/g;
const ANSI_SGR_PATTERN = /\x1b\[([0-9;]*)m/g;
const ANSI_BG_RESET = "\x1b[49m";
const ANSI_BOLD_ON = "\x1b[1m";
const ANSI_BOLD_OFF = "\x1b[22m";
const STYLE_RESET_PARAMS = [39, 22, 23, 24, 25, 27, 28, 29, 59] as const;
const DELTA_TIMEOUT_MS = 5000;
const DELTA_MAX_BUFFER = 8 * 1024 * 1024;
const DELTA_CACHE_MAX_ENTRIES = 200;
const HUNK_HEADER_PATTERN = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)$/;
const MIN_LINE_NUMBER_WIDTH = 2;
const MIN_SPLIT_CONTENT_WIDTH = 12;
const SPLIT_DIVIDER = " │ ";
const UNIFIED_DIVIDER = " │ ";
const DEFAULT_ADD_ROW_BACKGROUND_MIX_RATIO = 0.24;
const DEFAULT_REMOVE_ROW_BACKGROUND_MIX_RATIO = 0.12;
const ADD_INLINE_EMPHASIS_MIX_RATIO = 0.54;
const REMOVE_INLINE_EMPHASIS_MIX_RATIO = 0.36;
const ADDITION_TINT_TARGET: RgbColor = { r: 84, g: 190, b: 118 };
const DELETION_TINT_TARGET: RgbColor = { r: 232, g: 95, b: 122 };

let deltaAvailable: boolean | null = null;
const deltaDiffCache = new Map<string, string | null>();

function toNumber(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeCodeWhitespace(text: string): string {
  return text.replace(/\t/g, "    ");
}

function fitAnsiToWidth(text: string, width: number): string {
  if (width <= 0) {
    return "";
  }

  const trimmed = truncateToWidth(text, width, "");
  const gap = Math.max(0, width - visibleWidth(trimmed));
  return gap > 0 ? `${trimmed}${" ".repeat(gap)}` : trimmed;
}

function wrapAnsiToWidth(text: string, width: number): string[] {
  if (width <= 0) {
    return [""];
  }

  const normalized = normalizeCodeWhitespace(text);
  const wrapped = wrapTextWithAnsi(normalized, width);
  if (wrapped.length === 0) {
    return [fitAnsiToWidth(normalized, width)];
  }

  return wrapped.map((line) => fitAnsiToWidth(line, width));
}

function renderDiffColor(kind: DiffLineKind, theme: Theme, text: string): string {
  if (kind === "add") {
    return theme.fg("toolDiffAdded", text);
  }

  if (kind === "remove") {
    return theme.fg("toolDiffRemoved", text);
  }

  return theme.fg("toolDiffContext", text);
}

function sanitizeSgrParams(params: number[]): number[] {
  const sanitized: number[] = [];

  for (let index = 0; index < params.length; index++) {
    const param = params[index] ?? 0;

    if (param === 0) {
      sanitized.push(...STYLE_RESET_PARAMS);
      continue;
    }

    if (param === 49) {
      continue;
    }

    if ((param >= 40 && param <= 47) || (param >= 100 && param <= 107)) {
      continue;
    }

    if (param === 48) {
      const colorMode = params[index + 1];
      if (colorMode === 5) {
        index += 2;
        continue;
      }
      if (colorMode === 2) {
        index += 4;
        continue;
      }
      continue;
    }

    sanitized.push(param);
  }

  return sanitized;
}

function sanitizeAnsiForThemedOutput(text: string): string {
  if (!text || !text.includes("\x1b[")) {
    return text;
  }

  return text.replace(ANSI_SGR_PATTERN, (_sequence, rawParams: string) => {
    const parsed = toSgrParams(rawParams);
    if (parsed.length === 0) {
      return "";
    }

    const sanitized = sanitizeSgrParams(parsed);
    if (sanitized.length === 0) {
      return "";
    }

    return `\x1b[${sanitized.join(";")}m`;
  });
}

function toSgrParams(rawParams: string): number[] {
  if (!rawParams.trim()) {
    return [0];
  }

  return rawParams
    .split(";")
    .map((token) => Number.parseInt(token, 10))
    .filter((value) => Number.isFinite(value));
}

function sequenceResetsBackground(params: number[]): boolean {
  for (let index = 0; index < params.length; index++) {
    const param = params[index] ?? 0;

    if (param === 0 || param === 49) {
      return true;
    }

    if (param === 48) {
      const colorMode = params[index + 1];
      if (colorMode === 5) {
        index += 2;
        continue;
      }
      if (colorMode === 2) {
        index += 4;
        continue;
      }
    }
  }

  return false;
}

function keepBackgroundAcrossResets(text: string, rowBg: string): string {
  if (!text) {
    return text;
  }

  return text.replace(ANSI_SGR_PATTERN, (sequence, rawParams: string) => {
    const params = toSgrParams(rawParams);
    if (params.length === 0 || !sequenceResetsBackground(params)) {
      return sequence;
    }
    return `${sequence}${rowBg}`;
  });
}

function colorizeSegment(
  theme: Theme,
  color: "dim" | "toolDiffAdded" | "toolDiffRemoved",
  text: string,
  rowBg: string | undefined
): string {
  const themedText = theme.fg(color, text);
  if (!rowBg) {
    return themedText;
  }

  return `${rowBg}${keepBackgroundAcrossResets(themedText, rowBg)}${rowBg}`;
}

function renderChangeMarker(kind: DiffLineKind, theme: Theme, rowBg: string | undefined): string {
  if (kind === "add") {
    return colorizeSegment(theme, "toolDiffAdded", "▌", rowBg);
  }
  if (kind === "remove") {
    return colorizeSegment(theme, "toolDiffRemoved", "▌", rowBg);
  }
  return rowBg ? `${rowBg} ${rowBg}` : " ";
}

function getLineNumberColor(kind: DiffLineKind): "dim" | "toolDiffAdded" | "toolDiffRemoved" {
  if (kind === "add") {
    return "toolDiffAdded";
  }
  if (kind === "remove") {
    return "toolDiffRemoved";
  }
  return "dim";
}

function renderLinePrefix(
  kind: DiffLineKind,
  lineNumber: string,
  theme: Theme,
  rowBg: string | undefined,
  divider: string
): string {
  const marker = renderChangeMarker(kind, theme, rowBg);
  const number = colorizeSegment(theme, getLineNumberColor(kind), lineNumber, rowBg);
  const spacer = rowBg ? `${rowBg} ` : " ";
  const dividerText = rowBg ? `${rowBg}${theme.fg("dim", divider)}${rowBg}` : theme.fg("dim", divider);
  return `${marker}${spacer}${number}${dividerText}`;
}

function readThemeAnsi(theme: Theme, kind: "fg" | "bg", slot: string): string | undefined {
  const typedTheme = theme as Theme & {
    getFgAnsi?: (color: string) => string;
    getBgAnsi?: (color: string) => string;
  };

  try {
    if (kind === "fg" && typeof typedTheme.getFgAnsi === "function") {
      return typedTheme.getFgAnsi(slot);
    }
    if (kind === "bg" && typeof typedTheme.getBgAnsi === "function") {
      return typedTheme.getBgAnsi(slot);
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function ansi256ToRgb(code: number): RgbColor {
  if (code < 16) {
    const table = [
      { r: 0, g: 0, b: 0 },
      { r: 128, g: 0, b: 0 },
      { r: 0, g: 128, b: 0 },
      { r: 128, g: 128, b: 0 },
      { r: 0, g: 0, b: 128 },
      { r: 128, g: 0, b: 128 },
      { r: 0, g: 128, b: 128 },
      { r: 192, g: 192, b: 192 },
      { r: 128, g: 128, b: 128 },
      { r: 255, g: 0, b: 0 },
      { r: 0, g: 255, b: 0 },
      { r: 255, g: 255, b: 0 },
      { r: 0, g: 0, b: 255 },
      { r: 255, g: 0, b: 255 },
      { r: 0, g: 255, b: 255 },
      { r: 255, g: 255, b: 255 },
    ];
    return table[code] ?? table[0];
  }

  if (code >= 232) {
    const level = 8 + ((code - 232) * 10);
    return { r: level, g: level, b: level };
  }

  const normalized = code - 16;
  const red = Math.floor(normalized / 36);
  const green = Math.floor((normalized % 36) / 6);
  const blue = normalized % 6;
  const levels = [0, 95, 135, 175, 215, 255];
  return { r: levels[red] ?? 0, g: levels[green] ?? 0, b: levels[blue] ?? 0 };
}

function parseAnsiColorCode(ansi: string | undefined): RgbColor | null {
  if (!ansi) {
    return null;
  }

  const rgbMatch = /\x1b\[(?:3|4)8;2;(\d{1,3});(\d{1,3});(\d{1,3})m/.exec(ansi);
  if (rgbMatch) {
    return {
      r: Math.max(0, Math.min(255, Number.parseInt(rgbMatch[1] ?? "0", 10))),
      g: Math.max(0, Math.min(255, Number.parseInt(rgbMatch[2] ?? "0", 10))),
      b: Math.max(0, Math.min(255, Number.parseInt(rgbMatch[3] ?? "0", 10))),
    };
  }

  const bitMatch = /\x1b\[(?:3|4)8;5;(\d{1,3})m/.exec(ansi);
  if (bitMatch) {
    return ansi256ToRgb(Number.parseInt(bitMatch[1] ?? "0", 10));
  }

  return null;
}

function rgbToBgAnsi(color: RgbColor): string {
  return `\x1b[48;2;${Math.round(color.r)};${Math.round(color.g)};${Math.round(color.b)}m`;
}

function mixRgb(base: RgbColor, tint: RgbColor, ratio: number): RgbColor {
  const clamped = Math.max(0, Math.min(1, ratio));
  return {
    r: base.r * (1 - clamped) + tint.r * clamped,
    g: base.g * (1 - clamped) + tint.g * clamped,
    b: base.b * (1 - clamped) + tint.b * clamped,
  };
}

function resolveDiffPalette(
  theme: Theme,
  overrides?: { addRowBgMixRatio?: number; removeRowBgMixRatio?: number }
): DiffPalette {
  const baseBg = parseAnsiColorCode(readThemeAnsi(theme, "bg", "toolSuccessBg"))
    ?? parseAnsiColorCode(readThemeAnsi(theme, "bg", "toolPendingBg"))
    ?? parseAnsiColorCode(readThemeAnsi(theme, "bg", "userMessageBg"))
    ?? { r: 32, g: 35, b: 42 };
  const addFg = parseAnsiColorCode(readThemeAnsi(theme, "fg", "toolDiffAdded")) ?? { r: 88, g: 173, b: 88 };
  const removeFg = parseAnsiColorCode(readThemeAnsi(theme, "fg", "toolDiffRemoved")) ?? { r: 196, g: 98, b: 98 };
  const addTint = mixRgb(addFg, ADDITION_TINT_TARGET, 0.35);
  const removeTint = mixRgb(removeFg, DELETION_TINT_TARGET, 0.65);

  const addRowBgMixRatio = overrides?.addRowBgMixRatio ?? DEFAULT_ADD_ROW_BACKGROUND_MIX_RATIO;
  const removeRowBgMixRatio = overrides?.removeRowBgMixRatio ?? DEFAULT_REMOVE_ROW_BACKGROUND_MIX_RATIO;

  return {
    addRowBgAnsi: rgbToBgAnsi(mixRgb(baseBg, addTint, addRowBgMixRatio)),
    removeRowBgAnsi: rgbToBgAnsi(mixRgb(baseBg, removeTint, removeRowBgMixRatio)),
    addEmphasisBgAnsi: rgbToBgAnsi(mixRgb(baseBg, addTint, ADD_INLINE_EMPHASIS_MIX_RATIO)),
    removeEmphasisBgAnsi: rgbToBgAnsi(mixRgb(baseBg, removeTint, REMOVE_INLINE_EMPHASIS_MIX_RATIO)),
  };
}

function getLineRowBackground(kind: DiffLineKind, palette: DiffPalette): string | undefined {
  return kind === "add" ? palette.addRowBgAnsi : kind === "remove" ? palette.removeRowBgAnsi : undefined;
}

function getLineEmphasisBackground(kind: DiffLineKind, palette: DiffPalette): string | undefined {
  return kind === "add" ? palette.addEmphasisBgAnsi : kind === "remove" ? palette.removeEmphasisBgAnsi : undefined;
}

function renderMetaColor(entry: DiffMetaEntry, theme: Theme, text: string): string {
  if (entry.kind === "hunk") {
    return theme.fg("accent", text);
  }

  if (entry.kind === "file") {
    return theme.fg("muted", text);
  }

  return theme.fg("toolDiffContext", text);
}

function classifyMetaLine(raw: string): DiffMetaEntry["kind"] {
  if (
    raw.startsWith("diff --git ") || raw.startsWith("--- ") || raw.startsWith("+++ ")
    || raw.startsWith("created file ") || raw.startsWith("deleted file ")
  ) {
    return "file";
  }

  if (raw.startsWith("@@ ")) {
    return "hunk";
  }

  return "meta";
}

function createMetaEntry(raw: string, hunkIndex: number): DiffMetaEntry {
  return {
    kind: classifyMetaLine(raw),
    raw,
    hunkIndex,
  };
}

function ensureImplicitHunk(currentHunk: number): number {
  return currentHunk > 0 ? currentHunk : 1;
}

function normalizeDiffPath(rawPath: string | undefined): string | undefined {
  if (!rawPath) {
    return undefined;
  }

  const trimmed = rawPath.trim().split("\t")[0]?.trim();
  if (!trimmed || trimmed === "/dev/null") {
    return undefined;
  }

  if (trimmed.startsWith("a/") || trimmed.startsWith("b/")) {
    return trimmed.slice(2);
  }

  return trimmed;
}

function inferDiffLanguage(rawLine: string): string | undefined {
  if (rawLine.startsWith("diff --git ")) {
    const match = rawLine.match(/^diff --git\s+"?a\/(.+?)"?\s+"?b\/(.+?)"?$/);
    const filePath = normalizeDiffPath(match?.[2]);
    return filePath ? detectLanguageFromPath(filePath) : undefined;
  }

  if (rawLine.startsWith("+++ ") || rawLine.startsWith("--- ")) {
    const filePath = normalizeDiffPath(rawLine.slice(4));
    return filePath ? detectLanguageFromPath(filePath) : undefined;
  }

  if (rawLine.startsWith("created file ") || rawLine.startsWith("deleted file ")) {
    const filePath = normalizeDiffPath(rawLine.replace(/^(?:created|deleted) file\s+/, ""));
    return filePath ? detectLanguageFromPath(filePath) : undefined;
  }

  return undefined;
}

function renderDiffContent(entry: DiffLineEntry, theme: Theme): string {
  if (!entry.content) {
    return renderDiffColor(entry.lineKind, theme, entry.content);
  }

  if (!entry.language || entry.language === "text") {
    return renderDiffColor(entry.lineKind, theme, entry.content);
  }

  const highlighted = sanitizeAnsiForThemedOutput(highlightCode(entry.content, entry.language).join("\n"));
  if (!highlighted || highlighted === entry.content) {
    return renderDiffColor(entry.lineKind, theme, entry.content);
  }

  return highlighted;
}

function parseDiff(diffText: string, fallbackFilePath?: string): ParsedDiff {
  const stats = {
    added: 0,
    removed: 0,
    context: 0,
    hunks: 0,
    files: 0,
  };
  const entries: ParsedDiffEntry[] = [];

  if (!diffText.trim()) {
    return { entries, stats };
  }

  let hunkIndex = 0;
  let oldLineCursor: number | null = null;
  let newLineCursor: number | null = null;
  let currentLanguage: string | undefined = fallbackFilePath ? detectLanguageFromPath(fallbackFilePath) : undefined;

  for (const rawLine of diffText.replace(/\r/g, "").split("\n")) {
    const hunkMatch = rawLine.match(HUNK_HEADER_PATTERN);
    if (hunkMatch) {
      hunkIndex += 1;
      stats.hunks = Math.max(stats.hunks, hunkIndex);
      oldLineCursor = toNumber(hunkMatch[1]);
      newLineCursor = toNumber(hunkMatch[3]);
      entries.push({ kind: "hunk", raw: rawLine, hunkIndex });
      continue;
    }

    if (rawLine.startsWith("diff --git ") || rawLine.startsWith("--- ") || rawLine.startsWith("+++ ")) {
      if (rawLine.startsWith("diff --git ")) {
        stats.files += 1;
      }
      currentLanguage = inferDiffLanguage(rawLine) ?? currentLanguage;
      entries.push({ kind: "file", raw: rawLine, hunkIndex });
      continue;
    }

    if (rawLine.startsWith("-") && !rawLine.startsWith("---")) {
      hunkIndex = ensureImplicitHunk(hunkIndex);
      stats.hunks = Math.max(stats.hunks, hunkIndex);
      stats.removed += 1;
      const oldLineNumber = oldLineCursor;
      if (oldLineCursor !== null) {
        oldLineCursor += 1;
      }
      entries.push({
        kind: "line",
        lineKind: "remove",
        oldLineNumber,
        newLineNumber: null,
        fallbackLineNumber: oldLineNumber !== null ? `${oldLineNumber}` : "",
        content: rawLine.slice(1),
        raw: rawLine,
        hunkIndex,
        language: currentLanguage,
      });
      continue;
    }

    if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
      hunkIndex = ensureImplicitHunk(hunkIndex);
      stats.hunks = Math.max(stats.hunks, hunkIndex);
      stats.added += 1;
      const newLineNumber = newLineCursor;
      if (newLineCursor !== null) {
        newLineCursor += 1;
      }
      entries.push({
        kind: "line",
        lineKind: "add",
        oldLineNumber: null,
        newLineNumber,
        fallbackLineNumber: newLineNumber !== null ? `${newLineNumber}` : "",
        content: rawLine.slice(1),
        raw: rawLine,
        hunkIndex,
        language: currentLanguage,
      });
      continue;
    }

    if (rawLine.startsWith(" ")) {
      hunkIndex = ensureImplicitHunk(hunkIndex);
      stats.hunks = Math.max(stats.hunks, hunkIndex);
      stats.context += 1;
      const oldLineNumber = oldLineCursor;
      const newLineNumber = newLineCursor;
      if (oldLineCursor !== null) {
        oldLineCursor += 1;
      }
      if (newLineCursor !== null) {
        newLineCursor += 1;
      }
      entries.push({
        kind: "line",
        lineKind: "context",
        oldLineNumber,
        newLineNumber,
        fallbackLineNumber: oldLineNumber !== null ? `${oldLineNumber}` : newLineNumber !== null ? `${newLineNumber}` : "",
        content: rawLine.slice(1),
        raw: rawLine,
        hunkIndex,
        language: currentLanguage,
      });
      continue;
    }

    entries.push(createMetaEntry(rawLine, hunkIndex));
  }

  if (stats.hunks === 0 && (stats.added > 0 || stats.removed > 0 || stats.context > 0)) {
    stats.hunks = 1;
  }

  if (stats.files === 0 && stats.hunks > 0) {
    stats.files = 1;
  }

  return { entries, stats };
}

export function summarizeDiffText(diffText: string): DiffSummaryStats {
  const { stats } = parseDiff(diffText);
  return {
    added: stats.added,
    removed: stats.removed,
    hunks: stats.hunks,
    files: stats.files,
  };
}

function getLineNumberWidth(entries: ParsedDiffEntry[]): number {
  let maxWidth = MIN_LINE_NUMBER_WIDTH;

  for (const entry of entries) {
    if (entry.kind !== "line") {
      continue;
    }

    for (const candidate of [entry.oldLineNumber, entry.newLineNumber]) {
      if (candidate === null) {
        continue;
      }
      maxWidth = Math.max(maxWidth, `${candidate}`.length);
    }
  }

  return maxWidth;
}

function formatLineNumber(value: number | null, fallback: string, width: number): string {
  if (value !== null) {
    return `${value}`.padStart(width, " ");
  }

  if (fallback.trim()) {
    return fallback.trim().slice(-width).padStart(width, " ");
  }

  return " ".repeat(width);
}

function renderIntraLineDiff(
  oldContent: string,
  newContent: string,
  theme: Theme
): { removedLine: string; addedLine: string } {
  const wordDiff = Diff.diffWords(oldContent, newContent);

  let removedLine = "";
  let addedLine = "";
  let isFirstRemoved = true;
  let isFirstAdded = true;

  for (const part of wordDiff) {
    if (part.removed) {
      let value = part.value;
      if (isFirstRemoved) {
        const leadingWs = value.match(/^(\s*)/)?.[1] || "";
        value = value.slice(leadingWs.length);
        removedLine += leadingWs;
        isFirstRemoved = false;
      }
      if (value) {
        removedLine += theme.inverse(value);
      }
      continue;
    }

    if (part.added) {
      let value = part.value;
      if (isFirstAdded) {
        const leadingWs = value.match(/^(\s*)/)?.[1] || "";
        value = value.slice(leadingWs.length);
        addedLine += leadingWs;
        isFirstAdded = false;
      }
      if (value) {
        addedLine += theme.inverse(value);
      }
      continue;
    }

    removedLine += part.value;
    addedLine += part.value;
  }

  return { removedLine, addedLine };
}

function buildSplitRows(entries: ParsedDiffEntry[]): SplitDiffRow[] {
  const rows: SplitDiffRow[] = [];

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];

    if (entry.kind !== "line") {
      rows.push({ meta: entry });
      continue;
    }

    if (entry.lineKind === "remove") {
      const removed: DiffLineEntry[] = [];
      while (index < entries.length) {
        const candidate = entries[index];
        if (candidate?.kind === "line" && candidate.lineKind === "remove") {
          removed.push(candidate);
          index += 1;
          continue;
        }
        break;
      }

      const added: DiffLineEntry[] = [];
      while (index < entries.length) {
        const candidate = entries[index];
        if (candidate?.kind === "line" && candidate.lineKind === "add") {
          added.push(candidate);
          index += 1;
          continue;
        }
        break;
      }

      const pairCount = Math.max(removed.length, added.length);
      for (let pairIndex = 0; pairIndex < pairCount; pairIndex++) {
        rows.push({ left: removed[pairIndex], right: added[pairIndex] });
      }

      index -= 1;
      continue;
    }

    if (entry.lineKind === "add") {
      rows.push({ right: entry });
      continue;
    }

    rows.push({ left: entry, right: entry });
  }

  return rows;
}

function mergeSpans(spans: DiffSpan[]): DiffSpan[] {
  if (spans.length === 0) {
    return [];
  }

  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: DiffSpan[] = [sorted[0]];
  for (let index = 1; index < sorted.length; index++) {
    const current = sorted[index];
    const last = merged[merged.length - 1];
    if (current.start <= last.end) {
      last.end = Math.max(last.end, current.end);
      continue;
    }
    merged.push({ ...current });
  }
  return merged;
}

function buildChangedSpans(source: string, target: string, kind: "source" | "target"): DiffSpan[] {
  const parts = Diff.diffWords(source, target);
  const spans: DiffSpan[] = [];
  let cursor = 0;

  for (const part of parts) {
    const value = part.value ?? "";
    if ((kind === "source" && part.removed) || (kind === "target" && part.added)) {
      spans.push({ start: cursor, end: cursor + value.length });
      cursor += value.length;
      continue;
    }

    if ((kind === "source" && part.added) || (kind === "target" && part.removed)) {
      continue;
    }

    cursor += value.length;
  }

  return mergeSpans(spans);
}

function buildInlineHighlightMap(rows: SplitDiffRow[]): WeakMap<DiffLineEntry, DiffSpan[]> {
  const highlights = new WeakMap<DiffLineEntry, DiffSpan[]>();

  for (const row of rows) {
    if (!row.left || !row.right) {
      continue;
    }
    if (row.left.lineKind !== "remove" || row.right.lineKind !== "add") {
      continue;
    }

    const removeSpans = buildChangedSpans(row.left.content, row.right.content, "source");
    const addSpans = buildChangedSpans(row.left.content, row.right.content, "target");

    if (removeSpans.length > 0) {
      highlights.set(row.left, removeSpans);
    }
    if (addSpans.length > 0) {
      highlights.set(row.right, addSpans);
    }
  }

  return highlights;
}

function applyBackgroundToVisibleRange(
  ansiText: string,
  start: number,
  end: number,
  backgroundAnsi: string,
  restoreBackgroundAnsi: string
): string {
  if (!ansiText || start >= end || end <= 0) {
    return ansiText;
  }

  const rangeStart = Math.max(0, start);
  const rangeEnd = Math.max(rangeStart, end);
  let output = "";
  let visibleIndex = 0;
  let index = 0;
  let inRange = false;

  while (index < ansiText.length) {
    if (ansiText[index] === "\x1b") {
      const sequenceEnd = ansiText.indexOf("m", index);
      if (sequenceEnd !== -1) {
        output += ansiText.slice(index, sequenceEnd + 1);
        index = sequenceEnd + 1;
        continue;
      }
    }

    if (visibleIndex === rangeStart && !inRange) {
      output += `${backgroundAnsi}${ANSI_BOLD_ON}`;
      inRange = true;
    }
    if (visibleIndex === rangeEnd && inRange) {
      output += `${ANSI_BOLD_OFF}${restoreBackgroundAnsi}`;
      inRange = false;
    }

    output += ansiText[index] ?? "";
    visibleIndex += 1;
    index += 1;
  }

  if (inRange) {
    output += `${ANSI_BOLD_OFF}${restoreBackgroundAnsi}`;
  }

  return output;
}

function applyInlineSpanHighlight(
  plainText: string,
  renderedText: string,
  spans: DiffSpan[],
  emphasisBgAnsi: string | undefined,
  rowBgAnsi: string | undefined
): string {
  if (!renderedText || !plainText || spans.length === 0 || !emphasisBgAnsi) {
    return renderedText;
  }

  const restoreBackgroundAnsi = rowBgAnsi ?? ANSI_BG_RESET;
  let highlighted = renderedText;
  for (let index = spans.length - 1; index >= 0; index--) {
    const span = spans[index];
    highlighted = applyBackgroundToVisibleRange(highlighted, span.start, span.end, emphasisBgAnsi, restoreBackgroundAnsi);
  }
  return highlighted;
}

function renderMetaEntryRows(entry: DiffMetaEntry, width: number, theme: Theme): string[] {
  const safeWidth = Math.max(1, width);
  return wrapAnsiToWidth(entry.raw, safeWidth).map((line) => renderMetaColor(entry, theme, line));
}

function renderCompactLine(
  entry: DiffLineEntry,
  width: number,
  theme: Theme,
  inlineHighlights: WeakMap<DiffLineEntry, DiffSpan[]>,
  palette: DiffPalette
): string[] {
  const safeWidth = Math.max(1, width);
  const lineNumber = formatLineNumber(
    entry.lineKind === "remove" ? entry.oldLineNumber : entry.newLineNumber,
    entry.fallbackLineNumber,
    1
  ).trim();
  const rowBg = getLineRowBackground(entry.lineKind, palette);
  const emphasisBg = getLineEmphasisBackground(entry.lineKind, palette);
  const marker = entry.lineKind === "add" ? "+" : entry.lineKind === "remove" ? "-" : "·";
  const prefix = rowBg
    ? `${colorizeSegment(theme, getLineNumberColor(entry.lineKind), marker, rowBg)}${rowBg} `
    : `${theme.fg(getLineNumberColor(entry.lineKind), marker)} `;
  const continuationPrefix = rowBg ? `${rowBg}  ` : "  ";
  const contentWidth = Math.max(1, safeWidth - 2);
  const baseContent = renderDiffContent(entry, theme);
  const highlightedContent = applyInlineSpanHighlight(entry.content, baseContent, inlineHighlights.get(entry) ?? [], emphasisBg, rowBg);
  const wrapped = wrapAnsiToWidth(highlightedContent, contentWidth);

  return wrapped.map((content, index) => {
    const prefixText = index === 0 ? prefix : continuationPrefix;
    const combined = `${prefixText}${rowBg ? `${rowBg}${keepBackgroundAcrossResets(content, rowBg)}${rowBg}` : content}`;
    return fitAnsiToWidth(combined, safeWidth);
  });
}

function renderUnifiedLine(
  entry: DiffLineEntry,
  width: number,
  lineNumberWidth: number,
  theme: Theme,
  inlineHighlights: WeakMap<DiffLineEntry, DiffSpan[]>,
  palette: DiffPalette
): string[] {
  const safeWidth = Math.max(1, width);
  const lineNumber = formatLineNumber(
    entry.lineKind === "remove" ? entry.oldLineNumber : entry.newLineNumber,
    entry.fallbackLineNumber,
    lineNumberWidth
  );
  const rowBg = getLineRowBackground(entry.lineKind, palette);
  const emphasisBg = getLineEmphasisBackground(entry.lineKind, palette);
  const prefix = renderLinePrefix(entry.lineKind, lineNumber, theme, rowBg, UNIFIED_DIVIDER);
  const continuationPrefix = rowBg
    ? `${rowBg} ${rowBg}${" ".repeat(lineNumberWidth)}${rowBg}${theme.fg("dim", UNIFIED_DIVIDER)}${rowBg}`
    : `  ${" ".repeat(lineNumberWidth)}${theme.fg("dim", UNIFIED_DIVIDER)}`;
  const contentWidth = Math.max(1, safeWidth - visibleWidth(`▌ ${lineNumber}${UNIFIED_DIVIDER}`));
  const baseContent = renderDiffContent(entry, theme);
  const highlightedContent = applyInlineSpanHighlight(entry.content, baseContent, inlineHighlights.get(entry) ?? [], emphasisBg, rowBg);
  const wrapped = wrapAnsiToWidth(highlightedContent, contentWidth);

  return wrapped.map((content, index) => {
    const prefixText = index === 0 ? prefix : continuationPrefix;
    const combined = `${prefixText}${rowBg ? `${rowBg}${keepBackgroundAcrossResets(content, rowBg)}${rowBg}` : content}`;
    return fitAnsiToWidth(combined, safeWidth);
  });
}

function renderSplitBlankCell(width: number): string[] {
  return [" ".repeat(Math.max(0, width))];
}

function renderSplitCell(
  entry: DiffLineEntry | undefined,
  columnWidth: number,
  lineNumberWidth: number,
  theme: Theme,
  inlineHighlights: WeakMap<DiffLineEntry, DiffSpan[]>,
  palette: DiffPalette
): string[] {
  const safeWidth = Math.max(1, columnWidth);
  if (!entry) {
    return renderSplitBlankCell(safeWidth);
  }

  const lineNumber = formatLineNumber(
    entry.lineKind === "remove" ? entry.oldLineNumber : entry.newLineNumber,
    entry.fallbackLineNumber,
    lineNumberWidth
  );
  const rowBg = getLineRowBackground(entry.lineKind, palette);
  const emphasisBg = getLineEmphasisBackground(entry.lineKind, palette);
  const prefix = renderLinePrefix(entry.lineKind, lineNumber, theme, rowBg, " ");
  const continuationPrefix = rowBg ? `${rowBg} ${rowBg}${" ".repeat(lineNumberWidth + 1)}${rowBg}` : `  ${" ".repeat(lineNumberWidth + 1)}`;
  const contentWidth = Math.max(1, safeWidth - visibleWidth(`▌ ${lineNumber} `));
  const baseContent = renderDiffContent(entry, theme);
  const highlightedContent = applyInlineSpanHighlight(entry.content, baseContent, inlineHighlights.get(entry) ?? [], emphasisBg, rowBg);
  const wrapped = wrapAnsiToWidth(highlightedContent, contentWidth);

  return wrapped.map((content, index) => {
    const prefixText = index === 0 ? prefix : continuationPrefix;
    const combined = `${prefixText}${rowBg ? `${rowBg}${keepBackgroundAcrossResets(content, rowBg)}${rowBg}` : content}`;
    return fitAnsiToWidth(combined, safeWidth);
  });
}

function renderDiffStatBar(stats: DiffStats, width: number, theme: Theme): string | null {
  const totalChanges = stats.added + stats.removed;
  if (totalChanges === 0 || width < 20) {
    return null;
  }

  const barSlots = Math.max(8, Math.min(24, Math.floor(width / 12)));
  let addedSlots = Math.max(0, Math.min(barSlots, Math.round((stats.added / totalChanges) * barSlots)));
  if (stats.added > 0 && addedSlots === 0) {
    addedSlots = 1;
  }
  if (stats.removed > 0 && addedSlots >= barSlots) {
    addedSlots = barSlots - 1;
  }

  const removedSlots = Math.max(0, barSlots - addedSlots);
  const addedBar = addedSlots > 0 ? theme.fg("toolDiffAdded", "━".repeat(addedSlots)) : "";
  const removedBar = removedSlots > 0 ? theme.fg("toolDiffRemoved", "━".repeat(removedSlots)) : "";
  return `${theme.fg("dim", "[")}${addedBar}${removedBar}${theme.fg("dim", "]")}`;
}

function renderHeaderRows(stats: DiffStats, mode: Exclude<DiffPresentationMode, "summary">, width: number, theme: Theme): string[] {
  if (mode === "compact") {
    const summary = [
      theme.fg("toolOutput", theme.bold("diff")),
      theme.fg("toolDiffAdded", `+${stats.added}`),
      theme.fg("toolDiffRemoved", `-${stats.removed}`),
    ].join(" ");
    return [truncateToWidth(summary, width, "")];
  }

  const summaryPieces = mode === "split"
    ? [
      theme.fg("toolOutput", theme.bold("diff")),
      theme.fg("toolDiffAdded", `+${stats.added}`),
      theme.fg("toolDiffRemoved", `-${stats.removed}`),
      theme.fg("muted", mode),
    ]
    : [
      theme.fg("toolOutput", theme.bold("diff")),
      theme.fg("toolDiffAdded", `+${stats.added}`),
      theme.fg("toolDiffRemoved", `-${stats.removed}`),
      theme.fg("muted", `${stats.hunks} ${stats.hunks === 1 ? "hunk" : "hunks"}`),
      theme.fg("muted", `${stats.files} ${stats.files === 1 ? "file" : "files"}`),
      theme.fg("muted", mode),
    ];

  const summary = summaryPieces.join(mode === "split" ? " " : theme.fg("muted", " • "));
  const meter = renderDiffStatBar(stats, width, theme);
  if (!meter) {
    return [truncateToWidth(summary, width, "")];
  }

  const meterSeparator = " ";
  const meterWidth = visibleWidth(meterSeparator) + visibleWidth(meter);
  if (meterWidth >= width) {
    return [truncateToWidth(summary, width, "")];
  }

  const summaryWidth = Math.max(0, width - meterWidth);
  return [`${truncateToWidth(summary, summaryWidth, "")}${meterSeparator}${meter}`];
}

function renderDiffFrameLine(width: number, theme: Theme): string {
  return width <= 0 ? "" : theme.fg("dim", "─".repeat(width));
}

function renderSummary(parsed: ParsedDiff, width: number, theme: Theme): string[] {
  const safeWidth = normalizeDiffRenderWidth(width);
  if (safeWidth <= 0) {
    return [""];
  }

  return [theme.fg("muted", buildDiffSummaryText(parsed.stats, safeWidth).replace(/^↳\s+/, ""))];
}

function renderCompact(
  parsed: ParsedDiff,
  width: number,
  theme: Theme,
  inlineHighlights: WeakMap<DiffLineEntry, DiffSpan[]>,
  palette: DiffPalette
): string[] {
  const lines: string[] = [];
  for (const entry of parsed.entries) {
    if (entry.kind === "line") {
      lines.push(...renderCompactLine(entry, width, theme, inlineHighlights, palette));
      continue;
    }

    lines.push(...renderMetaEntryRows(entry, width, theme));
  }

  return lines.length > 0 ? lines : renderSummary(parsed, width, theme);
}

function renderUnified(
  parsed: ParsedDiff,
  width: number,
  theme: Theme,
  inlineHighlights: WeakMap<DiffLineEntry, DiffSpan[]>,
  palette: DiffPalette
): string[] {
  const lineNumberWidth = getLineNumberWidth(parsed.entries);
  const lines: string[] = [];

  for (const entry of parsed.entries) {
    if (entry.kind === "line") {
      lines.push(...renderUnifiedLine(entry, width, lineNumberWidth, theme, inlineHighlights, palette));
      continue;
    }

    lines.push(...renderMetaEntryRows(entry, width, theme));
  }

  return lines.length > 0 ? lines : renderSummary(parsed, width, theme);
}

function renderSplit(
  parsed: ParsedDiff,
  width: number,
  theme: Theme,
  inlineHighlights: WeakMap<DiffLineEntry, DiffSpan[]>,
  palette: DiffPalette
): string[] {
  const safeWidth = Math.max(1, width);
  const dividerWidth = visibleWidth(SPLIT_DIVIDER);
  const leftWidth = Math.max(1, Math.floor((safeWidth - dividerWidth) / 2));
  const rightWidth = Math.max(1, safeWidth - dividerWidth - leftWidth);
  const lineNumberWidth = getLineNumberWidth(parsed.entries);
  const rows = buildSplitRows(parsed.entries);

  const result: string[] = [];
  const headerLeft = theme.fg("muted", fitAnsiToWidth("old", leftWidth));
  const headerRight = theme.fg("muted", fitAnsiToWidth("new", rightWidth));
  result.push(`${headerLeft}${theme.fg("dim", SPLIT_DIVIDER)}${headerRight}`);

  for (const row of rows) {
    if (row.meta) {
      result.push(...renderMetaEntryRows(row.meta, safeWidth, theme));
      continue;
    }

    const leftLines = renderSplitCell(row.left, leftWidth, lineNumberWidth, theme, inlineHighlights, palette);
    const rightLines = renderSplitCell(row.right, rightWidth, lineNumberWidth, theme, inlineHighlights, palette);
    const rowHeight = Math.max(leftLines.length, rightLines.length);

    for (let index = 0; index < rowHeight; index++) {
      const left = leftLines[index] ?? " ".repeat(leftWidth);
      const right = rightLines[index] ?? " ".repeat(rightWidth);
      result.push(`${fitAnsiToWidth(left, leftWidth)}${theme.fg("dim", SPLIT_DIVIDER)}${fitAnsiToWidth(right, rightWidth)}`);
    }
  }

  return result.length > 0 ? result : renderSummary(parsed, width, theme);
}

function canRenderSplitLayout(width: number, lineNumberWidth: number): boolean {
  const safeWidth = normalizeDiffRenderWidth(width);
  const requiredColumnWidth = lineNumberWidth + MIN_SPLIT_CONTENT_WIDTH + 3;
  const minimum = (requiredColumnWidth * 2) + visibleWidth(SPLIT_DIVIDER);
  return safeWidth >= minimum;
}

function renderAdaptiveDiffLinesByMode(
  parsed: ParsedDiff,
  width: number,
  theme: Theme,
  mode: DiffPresentationMode,
  config: Pick<AdaptiveDiffRenderConfig, "addRowBgMixRatio" | "removeRowBgMixRatio">
): string[] {
  if (mode === "summary") {
    return renderSummary(parsed, width, theme);
  }

  const splitRows = buildSplitRows(parsed.entries);
  const inlineHighlights = buildInlineHighlightMap(splitRows);
  const palette = resolveDiffPalette(theme, config);
  const headerRows = renderHeaderRows(parsed.stats, mode, width, theme);
  const bodyRows = mode === "compact"
    ? renderCompact(parsed, width, theme, inlineHighlights, palette)
    : mode === "split"
      ? renderSplit(parsed, width, theme, inlineHighlights, palette)
      : renderUnified(parsed, width, theme, inlineHighlights, palette);

  if (mode === "split") {
    return [...headerRows, ...bodyRows];
  }

  const frame = renderDiffFrameLine(width, theme);
  return [...headerRows, frame, ...bodyRows, frame];
}

function isDeltaInstalled(): boolean {
  if (deltaAvailable !== null) {
    return deltaAvailable;
  }

  const check = spawnSync("delta", ["--version"], {
    stdio: "ignore",
    timeout: 1000,
  });

  deltaAvailable = !check.error && check.status === 0;
  return deltaAvailable;
}

function runDelta(diffText: string): string | null {
  const result = spawnSync("delta", ["--color-only", "--paging=never"], {
    encoding: "utf-8",
    input: diffText,
    timeout: DELTA_TIMEOUT_MS,
    maxBuffer: DELTA_MAX_BUFFER,
  });

  if (result.error || result.status !== 0) {
    return null;
  }

  return typeof result.stdout === "string" ? result.stdout : null;
}

function stripSyntheticHeader(deltaOutput: string): string {
  const outputLines = deltaOutput.split("\n");
  const bodyStart = outputLines.findIndex((line) => line.replace(ANSI_ESCAPE_RE, "").startsWith("@@"));

  if (bodyStart >= 0) {
    return outputLines.slice(bodyStart + 1).join("\n");
  }

  return deltaOutput;
}

function renderDiffBlockWithDelta(code: string): string | null {
  if (!isDeltaInstalled()) {
    return null;
  }

  const cached = deltaDiffCache.get(code);
  if (cached !== undefined) {
    return cached;
  }

  let rendered = runDelta(code);

  if (!rendered) {
    const syntheticDiff = [
      "--- a/file",
      "+++ b/file",
      "@@ -1,1 +1,1 @@",
      code,
    ].join("\n");

    const syntheticRendered = runDelta(syntheticDiff);
    if (syntheticRendered) {
      rendered = stripSyntheticHeader(syntheticRendered);
    }
  }

  if (deltaDiffCache.size >= DELTA_CACHE_MAX_ENTRIES) {
    deltaDiffCache.clear();
  }

  deltaDiffCache.set(code, rendered);
  return rendered;
}

export function renderLegacyDiffBlock(code: string, theme: Theme): string {
  const deltaRendered = renderDiffBlockWithDelta(code);
  if (deltaRendered !== null) {
    return deltaRendered;
  }

  const lines = code.split("\n");
  const result: string[] = [];

  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const trimmed = line.trimStart();
    const indent = line.slice(0, line.length - trimmed.length);

    if (trimmed.match(/^---\s+\S/) || trimmed.match(/^\+\+\+\s+\S/)) {
      result.push(indent + theme.fg("accent", trimmed));
      index += 1;
      continue;
    }

    if (trimmed.match(/^@@\s+-\d+/)) {
      result.push(indent + theme.fg("muted", trimmed));
      index += 1;
      continue;
    }

    if (trimmed.startsWith("-") && !trimmed.match(/^---\s/)) {
      const removedLines: Array<{ indent: string; content: string }> = [];
      while (index < lines.length) {
        const currentLine = lines[index] ?? "";
        const currentTrimmed = currentLine.trimStart();
        const currentIndent = currentLine.slice(0, currentLine.length - currentTrimmed.length);
        if (currentTrimmed.startsWith("-") && !currentTrimmed.match(/^---\s/)) {
          removedLines.push({ indent: currentIndent, content: currentTrimmed.slice(1) });
          index += 1;
          continue;
        }
        break;
      }

      const addedLines: Array<{ indent: string; content: string }> = [];
      while (index < lines.length) {
        const currentLine = lines[index] ?? "";
        const currentTrimmed = currentLine.trimStart();
        const currentIndent = currentLine.slice(0, currentLine.length - currentTrimmed.length);
        if (currentTrimmed.startsWith("+") && !currentTrimmed.match(/^\+\+\+\s/)) {
          addedLines.push({ indent: currentIndent, content: currentTrimmed.slice(1) });
          index += 1;
          continue;
        }
        break;
      }

      if (removedLines.length === 1 && addedLines.length === 1) {
        const { removedLine, addedLine } = renderIntraLineDiff(removedLines[0].content, addedLines[0].content, theme);
        result.push(removedLines[0].indent + theme.fg("toolDiffRemoved", `-${removedLine}`));
        result.push(addedLines[0].indent + theme.fg("toolDiffAdded", `+${addedLine}`));
        continue;
      }

      for (const removed of removedLines) {
        result.push(removed.indent + theme.fg("toolDiffRemoved", `-${removed.content}`));
      }
      for (const added of addedLines) {
        result.push(added.indent + theme.fg("toolDiffAdded", `+${added.content}`));
      }
      continue;
    }

    if (trimmed.startsWith("+") && !trimmed.match(/^\+\+\+\s/)) {
      result.push(indent + theme.fg("toolDiffAdded", trimmed));
      index += 1;
      continue;
    }

    if (line.startsWith(" ")) {
      result.push(theme.fg("toolDiffContext", line));
      index += 1;
      continue;
    }

    result.push(indent + theme.fg("dim", trimmed));
    index += 1;
  }

  return result.join("\n");
}

export function renderAdaptiveDiffBlockLines(
  diffText: string,
  width: number,
  theme: Theme,
  config: AdaptiveDiffRenderConfig,
  options?: { filePath?: string }
): string[] {
  const safeWidth = normalizeDiffRenderWidth(width);
  if (safeWidth <= 0) {
    return [""];
  }

  try {
    const parsed = parseDiff(diffText, options?.filePath);
    const lineNumberWidth = getLineNumberWidth(parsed.entries);
    const mode = resolveDiffPresentationMode(
      config,
      safeWidth,
      canRenderSplitLayout(safeWidth, lineNumberWidth)
    );

    return renderAdaptiveDiffLinesByMode(parsed, safeWidth, theme, mode, config)
      .map((line) => truncateToWidth(line, safeWidth, ""));
  } catch {
    return renderLegacyDiffBlock(diffText, theme)
      .split("\n")
      .map((line) => truncateToWidth(line, safeWidth, ""));
  }
}
