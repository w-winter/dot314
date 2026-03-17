// render.ts - Syntax highlighting and diff rendering for RepoPrompt output

import { highlightCode, type Theme } from "@mariozechner/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth, type Component } from "@mariozechner/pi-tui";

import {
  renderAdaptiveDiffBlockLines,
  renderLegacyDiffBlock,
  type AdaptiveDiffRenderConfig,
} from "./diff-renderer.js";
import { detectLanguageFromPath } from "./language-detection.js";

// ─────────────────────────────────────────────────────────────────────────────
// Fenced Code Block Parsing
// ─────────────────────────────────────────────────────────────────────────────

interface FencedBlock {
  lang: string | undefined;
  code: string;
  startIndex: number;
  endIndex: number;
}

interface TextSegment {
  kind: "text" | "code";
  component: Text;
}

interface DiffSegment {
  kind: "diff";
  diffText: string;
  filePath?: string;
  addRowBgMixRatio?: number;
  removeRowBgMixRatio?: number;
}

type OutputSegment = TextSegment | DiffSegment;

export interface RenderOptions {
  expanded?: boolean;
  maxCollapsedLines?: number;
}

export interface AdaptiveOutputRenderContext {
  toolName?: string;
  expanded: boolean;
  collapsedMaxLines: number;
  successPrefix: string;
  diffConfig: AdaptiveDiffRenderConfig;
  diffText?: string;
  diffFilePath?: string;
  disableCollapsedTruncation?: boolean;
}

/**
 * Parse fenced code blocks from text. Handles:
 * - Multiple blocks
 * - Various language identifiers
 * - Empty/missing language
 * - Unclosed fences (treated as extending to end)
 */
export function parseFencedBlocks(text: string): FencedBlock[] {
  const blocks: FencedBlock[] = [];

  const lineStartIndices: number[] = [0];
  for (let idx = 0; idx < text.length; idx++) {
    if (text[idx] === "\n") {
      lineStartIndices.push(idx + 1);
    }
  }

  const lines = text.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const fenceMatch = line.match(/^\s*```(\S*)\s*$/);

    if (!fenceMatch) {
      i++;
      continue;
    }

    const lang = fenceMatch[1] || undefined;
    const startLine = i;
    const codeLines: string[] = [];
    i++;

    while (i < lines.length) {
      const closingMatch = lines[i].match(/^\s*```\s*$/);
      if (closingMatch) {
        i++;
        break;
      }
      codeLines.push(lines[i]);
      i++;
    }

    const startIndex = lineStartIndices[startLine] ?? 0;
    const endIndex = i < lineStartIndices.length ? lineStartIndices[i] : text.length;

    blocks.push({
      lang,
      code: codeLines.join("\n"),
      startIndex,
      endIndex,
    });
  }

  return blocks;
}

export function containsFencedDiffBlock(text: string): boolean {
  return parseFencedBlocks(text).some((block) => block.lang?.toLowerCase() === "diff");
}

export function inferDiffFilePathFromText(text: string): string | undefined {
  const headingMatches = [...text.matchAll(/(?:^|\n)#{1,6}\s+`([^`]+)`\s*(?=\n|$)/g)];
  const headingPath = headingMatches[headingMatches.length - 1]?.[1]?.trim();
  if (headingPath) {
    return headingPath;
  }

  const bulletMatches = [...text.matchAll(/(?:^|\n)[-*•]\s+`([^`]+)`\s+[A-Z?]+\s+[+-]\d+/g)];
  return bulletMatches[bulletMatches.length - 1]?.[1]?.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Codemap Rendering
// ─────────────────────────────────────────────────────────────────────────────

function isCodemapContent(text: string): boolean {
  const lines = text.split("\n");
  let hasFileHeader = false;
  let hasSectionHeader = false;

  for (const line of lines.slice(0, 30)) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("File:")) hasFileHeader = true;
    if (trimmed.match(/^(Imports|Classes|Functions|Methods|Properties|Type-aliases|Interfaces|Exports|Constants):$/)) {
      hasSectionHeader = true;
    }
  }

  return hasFileHeader && hasSectionHeader;
}


function renderCodemapBlock(code: string, theme: Theme): string {
  const lines = code.split("\n");
  const result: string[] = [];

  let currentLang = "text";
  let inCodeSection = false;

  for (const line of lines) {
    const trimmed = line.trimStart();
    const indent = line.slice(0, line.length - trimmed.length);

    if (trimmed.startsWith("File:")) {
      const filePath = trimmed.slice(5).trim();
      currentLang = detectLanguageFromPath(filePath);
      result.push(indent + theme.fg("accent", theme.bold("File:")) + " " + theme.fg("warning", filePath));
      inCodeSection = false;
    } else if (trimmed === "---") {
      result.push(indent + theme.fg("muted", "---"));
      inCodeSection = false;
    } else if (trimmed.match(/^(Imports|Classes|Functions|Methods|Properties|Type-aliases|Interfaces|Exports|Constants):$/)) {
      const sectionName = trimmed.slice(0, -1);
      result.push(indent + theme.fg("success", theme.bold(sectionName + ":")));
      inCodeSection = ["Imports", "Methods", "Properties", "Functions", "Exports", "Constants"].includes(sectionName);
    } else if (trimmed.startsWith("- ")) {
      const content = trimmed.slice(2);

      if (content.match(/^[\w-]+$/) && !inCodeSection) {
        result.push(indent + theme.fg("muted", "- ") + theme.fg("accent", theme.bold(content)));
      } else {
        const highlightedLines = highlightCode(content, currentLang);
        const firstPrefix = indent + theme.fg("muted", "- ");
        const nextPrefix = indent + theme.fg("muted", "  ");
        result.push(...highlightedLines.map((highlighted, index) => (index === 0 ? firstPrefix : nextPrefix) + highlighted));
      }
    } else if (indent.length > 0 && trimmed.length > 0) {
      const highlightedLines = highlightCode(trimmed, currentLang);
      result.push(...highlightedLines.map((highlighted) => indent + highlighted));
    } else if (trimmed === "") {
      result.push("");
    } else {
      result.push(indent + theme.fg("dim", trimmed));
    }
  }

  return result.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Standard Rendering Path
// ─────────────────────────────────────────────────────────────────────────────

function renderMarkdownText(text: string, theme: Theme): string {
  const lines = text.split("\n");
  const result: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("## ")) {
      result.push(theme.fg("accent", theme.bold(trimmed)));
    } else if (trimmed.startsWith("# ")) {
      result.push(theme.fg("accent", theme.bold(trimmed)));
    } else if (trimmed.startsWith("### ")) {
      result.push(theme.fg("accent", trimmed));
    } else if (trimmed.includes("✅") || trimmed.includes("✓")) {
      result.push(theme.fg("success", line));
    } else if (trimmed.includes("❌") || trimmed.includes("✗") || trimmed.toLowerCase().includes("error")) {
      result.push(theme.fg("error", line));
    } else if (trimmed.includes("⚠") || trimmed.toLowerCase().includes("warning")) {
      result.push(theme.fg("warning", line));
    } else if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      const boldMatch = trimmed.match(/^[-*]\s+\*\*([^*]+)\*\*:\s*(.*)$/);
      if (boldMatch) {
        const label = boldMatch[1];
        const value = boldMatch[2];
        result.push(
          theme.fg("muted", "- ") +
          theme.fg("accent", theme.bold(label)) +
          theme.fg("muted", ": ") +
          theme.fg("dim", value)
        );
      } else {
        result.push(theme.fg("muted", line));
      }
    } else if (trimmed.startsWith("📄") || trimmed.startsWith("📂")) {
      result.push(theme.fg("accent", line));
    } else if (trimmed === "") {
      result.push("");
    } else {
      result.push(theme.fg("dim", line));
    }
  }

  return result.join("\n");
}

function renderNonDiffFence(block: FencedBlock, theme: Theme): string {
  if (block.lang?.toLowerCase() === "text" && isCodemapContent(block.code)) {
    return [
      theme.fg("muted", "```text"),
      renderCodemapBlock(block.code, theme),
      theme.fg("muted", "```"),
    ].join("\n");
  }

  if (block.lang) {
    return [
      theme.fg("muted", "```" + block.lang),
      highlightCode(block.code, block.lang).join("\n"),
      theme.fg("muted", "```"),
    ].join("\n");
  }

  if (isCodemapContent(block.code)) {
    return [
      theme.fg("muted", "```"),
      renderCodemapBlock(block.code, theme),
      theme.fg("muted", "```"),
    ].join("\n");
  }

  return [
    theme.fg("muted", "```"),
    theme.fg("dim", block.code),
    theme.fg("muted", "```"),
  ].join("\n");
}

export function renderRpOutput(
  text: string,
  theme: Theme,
  _options: RenderOptions = {}
): string {
  const blocks = parseFencedBlocks(text);

  if (blocks.length === 0) {
    return renderMarkdownText(text, theme);
  }

  const result: string[] = [];
  let lastEnd = 0;

  for (const block of blocks) {
    if (block.startIndex > lastEnd) {
      const before = text.slice(lastEnd, block.startIndex);
      result.push(renderMarkdownText(before, theme));
    }

    if (block.lang?.toLowerCase() === "diff") {
      result.push(theme.fg("muted", "```diff"));
      result.push(renderLegacyDiffBlock(block.code, theme));
      result.push(theme.fg("muted", "```"));
    } else {
      result.push(renderNonDiffFence(block, theme));
    }

    lastEnd = block.endIndex;
  }

  if (lastEnd < text.length) {
    const after = text.slice(lastEnd);
    result.push(renderMarkdownText(after, theme));
  }

  return result.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Adaptive Mixed Rendering Path
// ─────────────────────────────────────────────────────────────────────────────

function buildOutputSegments(text: string, theme: Theme): OutputSegment[] {
  const blocks = parseFencedBlocks(text);
  if (blocks.length === 0) {
    return [{ kind: "text", component: new Text(renderMarkdownText(text, theme), 0, 0) }];
  }

  const segments: OutputSegment[] = [];
  let lastEnd = 0;

  for (const block of blocks) {
    if (block.startIndex > lastEnd) {
      const before = text.slice(lastEnd, block.startIndex);
      segments.push({ kind: "text", component: new Text(renderMarkdownText(before, theme), 0, 0) });
    }

    if (block.lang?.toLowerCase() === "diff") {
      const before = text.slice(0, block.startIndex);
      segments.push({ kind: "diff", diffText: block.code, filePath: inferDiffFilePathFromText(before) });
    } else {
      segments.push({ kind: "code", component: new Text(renderNonDiffFence(block, theme), 0, 0) });
    }

    lastEnd = block.endIndex;
  }

  if (lastEnd < text.length) {
    const after = text.slice(lastEnd);
    segments.push({ kind: "text", component: new Text(renderMarkdownText(after, theme), 0, 0) });
  }

  return segments;
}

function buildPreferredAdaptiveSegments(text: string, toolName: string | undefined, theme: Theme): OutputSegment[] {
  const segments = buildOutputSegments(text, theme);
  if (toolName !== "apply_edits") {
    return segments;
  }

  const diffSegments = segments.filter((segment): segment is DiffSegment => segment.kind === "diff");
  if (diffSegments.length !== 1) {
    return segments;
  }

  const nonDiffText = text.replace(/```diff[\s\S]*?```/g, "").trim();
  const applyEditsBoilerplate = /^(##\s+Apply Edits.*)?[\s\S]*?(###\s+Unified Diff)?$/m;
  if (!applyEditsBoilerplate.test(nonDiffText)) {
    return segments;
  }

  return diffSegments;
}

function buildAdaptiveSegments(text: string, theme: Theme, context: AdaptiveOutputRenderContext): OutputSegment[] {
  if (typeof context.diffText === "string" && context.diffText.trim().length > 0) {
    return [{
      kind: "diff",
      diffText: context.diffText,
      filePath: context.diffFilePath,
      addRowBgMixRatio: context.diffConfig.addRowBgMixRatio,
      removeRowBgMixRatio: context.diffConfig.removeRowBgMixRatio,
    }];
  }

  return buildPreferredAdaptiveSegments(text, context.toolName, theme);
}

function renderSegmentsAtWidth(
  segments: OutputSegment[],
  width: number,
  theme: Theme,
  diffConfig: AdaptiveDiffRenderConfig
): string[] {
  const safeWidth = Math.max(0, width);
  if (safeWidth <= 0) {
    return [""];
  }

  const result: string[] = [];
  for (const segment of segments) {
    if (segment.kind === "diff") {
      result.push(...renderAdaptiveDiffBlockLines(segment.diffText, safeWidth, theme, diffConfig, {
        filePath: segment.filePath,
      }));
      continue;
    }

    result.push(...segment.component.render(safeWidth));
  }

  return result.map((line) => truncateToWidth(line, safeWidth, ""));
}

// ─────────────────────────────────────────────────────────────────────────────
// Collapsed View Helpers
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_COLLAPSED_MAX_LINES = 15;
const DEFAULT_COLLAPSED_MAX_CHARS = 2000;

function stripNoiseForCollapsedView(lines: string[]): string[] {
  const filtered: string[] = [];
  let consecutiveEmpty = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      continue;
    }

    if (trimmed.length === 0) {
      consecutiveEmpty += 1;
      if (consecutiveEmpty > 1) {
        continue;
      }
      filtered.push("");
      continue;
    }

    consecutiveEmpty = 0;
    filtered.push(line);
  }

  while (filtered.length > 0 && filtered[filtered.length - 1]?.trim().length === 0) {
    filtered.pop();
  }

  return filtered;
}

export function prepareCollapsedView(
  text: string,
  theme: Theme,
  maxLines: number = DEFAULT_COLLAPSED_MAX_LINES
): { content: string; truncated: boolean; totalLines: number } {
  const rawLines = text.split("\n");
  const lines = stripNoiseForCollapsedView(rawLines);
  const totalLines = lines.length;

  if (maxLines <= 0) {
    return {
      content: "",
      truncated: totalLines > 0,
      totalLines,
    };
  }

  const normalizedText = lines.join("\n");

  if (lines.length <= maxLines && normalizedText.length <= DEFAULT_COLLAPSED_MAX_CHARS) {
    return {
      content: renderRpOutput(normalizedText, theme),
      truncated: false,
      totalLines,
    };
  }

  const truncatedText = lines.slice(0, maxLines).join("\n");
  const content = renderRpOutput(truncatedText, theme);

  return {
    content,
    truncated: true,
    totalLines,
  };
}

export function createAdaptiveDiffAwareOutputComponent(
  text: string,
  theme: Theme,
  context: AdaptiveOutputRenderContext
): Component {
  const segments = buildAdaptiveSegments(text, theme, context);
  const cache = new Map<number, string[]>();

  const renderCollapsed = (width: number): string[] => {
    const prefixWidth = visibleWidth(context.successPrefix);
    const bodyWidth = Math.max(1, width - prefixWidth);
    const renderedLines = renderSegmentsAtWidth(segments, bodyWidth, theme, context.diffConfig);
    const filteredLines = stripNoiseForCollapsedView(renderedLines);
    const totalLines = filteredLines.length;
    const maxLines = context.collapsedMaxLines;

    const renderVisibleLines = (visibleLines: string[]): string[] => {
      if (visibleLines.length === 0) {
        return [truncateToWidth(context.successPrefix.trimEnd(), width, "")];
      }

      return visibleLines.map((line, index) => {
        if (index === 0) {
          return truncateToWidth(`${context.successPrefix}${line}`, width, "");
        }
        return truncateToWidth(line, width, "");
      });
    };

    if (context.disableCollapsedTruncation === true) {
      return renderVisibleLines(filteredLines);
    }

    if (maxLines <= 0) {
      const hidden = `${context.successPrefix}${theme.fg("muted", "(output hidden)")}`;
      const result = [truncateToWidth(hidden, width, "")];
      if (totalLines > 0) {
        result.push(truncateToWidth(theme.fg("muted", `… (${totalLines} more lines)`), width, ""));
      }
      return result;
    }

    const filteredText = filteredLines.join("\n");
    const truncated = filteredLines.length > maxLines || filteredText.length > DEFAULT_COLLAPSED_MAX_CHARS;
    const visibleLines = truncated ? filteredLines.slice(0, maxLines) : filteredLines;
    const result = renderVisibleLines(visibleLines);

    if (truncated) {
      result.push(truncateToWidth(theme.fg("muted", `… (${Math.max(0, totalLines - maxLines)} more lines)`), width, ""));
    }

    return result;
  };

  const renderExpanded = (width: number): string[] => {
    const renderedBody = renderSegmentsAtWidth(segments, width, theme, context.diffConfig)
      .map((line) => truncateToWidth(line, width, ""));

    if (renderedBody.length === 0) {
      return [truncateToWidth(context.successPrefix.trimEnd(), width, "")];
    }

    return [
      truncateToWidth(`${context.successPrefix}${renderedBody[0]}`, width, ""),
      ...renderedBody.slice(1),
    ];
  };

  return {
    render(width: number): string[] {
      const safeWidth = Math.max(1, Math.floor(Number.isFinite(width) ? width : 0));
      const cached = cache.get(safeWidth);
      if (cached) {
        return cached;
      }

      const rendered = context.expanded ? renderExpanded(safeWidth) : renderCollapsed(safeWidth);
      cache.set(safeWidth, rendered);
      return rendered;
    },
    invalidate(): void {
      cache.clear();
    },
    handleInput(): void {
      // Passive display component
    },
  };
}
