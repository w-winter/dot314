// render.ts - Syntax highlighting and diff rendering for RepoPrompt output

import { spawnSync } from "node:child_process";

import { highlightCode, type Theme } from "@mariozechner/pi-coding-agent";
import * as Diff from "diff";

// ─────────────────────────────────────────────────────────────────────────────
// Fenced Code Block Parsing
// ─────────────────────────────────────────────────────────────────────────────

interface FencedBlock {
  lang: string | undefined;
  code: string;
  startIndex: number;
  endIndex: number;
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

    // Find closing fence
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

// ─────────────────────────────────────────────────────────────────────────────
// Delta Diff Rendering
// ─────────────────────────────────────────────────────────────────────────────

const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*m/g;
const DELTA_TIMEOUT_MS = 5000;
const DELTA_MAX_BUFFER = 8 * 1024 * 1024;
const DELTA_CACHE_MAX_ENTRIES = 200;

let deltaAvailable: boolean | null = null;
const deltaDiffCache = new Map<string, string | null>();

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

// ─────────────────────────────────────────────────────────────────────────────
// Word-Level Diff Highlighting
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute word-level diff with inverse highlighting on changed parts
 */
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
    } else if (part.added) {
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
    } else {
      removedLine += part.value;
      addedLine += part.value;
    }
  }

  return { removedLine, addedLine };
}

/**
 * Render diff lines with syntax highlighting (red/green, word-level inverse)
 */
export function renderDiffBlock(code: string, theme: Theme): string {
  const deltaRendered = renderDiffBlockWithDelta(code);
  if (deltaRendered !== null) {
    return deltaRendered;
  }

  const lines = code.split("\n");
  const result: string[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trimStart();
    const indent = line.slice(0, line.length - trimmed.length);

    // File headers: --- a/file or +++ b/file
    if (trimmed.match(/^---\s+\S/) || trimmed.match(/^\+\+\+\s+\S/)) {
      result.push(indent + theme.fg("accent", trimmed));
      i++;
    }
    // Hunk headers: @@ -1,5 +1,6 @@
    else if (trimmed.match(/^@@\s+-\d+/)) {
      result.push(indent + theme.fg("muted", trimmed));
      i++;
    }
    // Removed lines (not file headers)
    else if (trimmed.startsWith("-") && !trimmed.match(/^---\s/)) {
      // Collect consecutive removed lines
      const removedLines: Array<{ indent: string; content: string }> = [];
      while (i < lines.length) {
        const l = lines[i];
        const t = l.trimStart();
        const ind = l.slice(0, l.length - t.length);
        if (t.startsWith("-") && !t.match(/^---\s/)) {
          removedLines.push({ indent: ind, content: t.slice(1) });
          i++;
        } else {
          break;
        }
      }

      // Collect consecutive added lines
      const addedLines: Array<{ indent: string; content: string }> = [];
      while (i < lines.length) {
        const l = lines[i];
        const t = l.trimStart();
        const ind = l.slice(0, l.length - t.length);
        if (t.startsWith("+") && !t.match(/^\+\+\+\s/)) {
          addedLines.push({ indent: ind, content: t.slice(1) });
          i++;
        } else {
          break;
        }
      }

      // Word-level highlighting for 1:1 line changes
      if (removedLines.length === 1 && addedLines.length === 1) {
        const { removedLine, addedLine } = renderIntraLineDiff(
          removedLines[0].content,
          addedLines[0].content,
          theme
        );
        result.push(removedLines[0].indent + theme.fg("toolDiffRemoved", "-" + removedLine));
        result.push(addedLines[0].indent + theme.fg("toolDiffAdded", "+" + addedLine));
      } else {
        for (const r of removedLines) {
          result.push(r.indent + theme.fg("toolDiffRemoved", "-" + r.content));
        }
        for (const a of addedLines) {
          result.push(a.indent + theme.fg("toolDiffAdded", "+" + a.content));
        }
      }
    }
    // Added lines (not file headers)
    else if (trimmed.startsWith("+") && !trimmed.match(/^\+\+\+\s/)) {
      result.push(indent + theme.fg("toolDiffAdded", trimmed));
      i++;
    }
    // Context lines (start with space in unified diff)
    else if (line.startsWith(" ")) {
      result.push(theme.fg("toolDiffContext", line));
      i++;
    }
    // Empty or other lines
    else {
      result.push(indent + theme.fg("dim", trimmed));
      i++;
    }
  }

  return result.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Codemap Rendering
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect if content appears to be a codemap from get_code_structure
 */
function isCodemapContent(text: string): boolean {
  // Check for codemap markers: "File:" at line start and section headers
  const lines = text.split("\n");
  let hasFileHeader = false;
  let hasSectionHeader = false;
  
  for (const line of lines.slice(0, 30)) { // Check first 30 lines
    const trimmed = line.trimStart();
    if (trimmed.startsWith("File:")) hasFileHeader = true;
    if (trimmed.match(/^(Imports|Classes|Functions|Methods|Properties|Type-aliases|Interfaces|Exports|Constants):$/)) {
      hasSectionHeader = true;
    }
  }
  
  return hasFileHeader && hasSectionHeader;
}

/**
 * Render codemap output with syntax highlighting for structure
 */
/**
 * Map file extensions to language identifiers for syntax highlighting
 */
const EXT_TO_LANG: Record<string, string> = {
  // JavaScript/TypeScript
  ".ts": "typescript", ".tsx": "tsx", ".js": "javascript", ".jsx": "jsx",
  ".mjs": "javascript", ".cjs": "javascript",
  // Python
  ".py": "python", ".pyw": "python", ".pyi": "python",
  // Rust
  ".rs": "rust",
  // Go
  ".go": "go",
  // C/C++
  ".c": "c", ".h": "c", ".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp",
  ".hpp": "cpp", ".hxx": "cpp",
  // Java/Kotlin
  ".java": "java", ".kt": "kotlin", ".kts": "kotlin",
  // C#
  ".cs": "csharp",
  // Ruby
  ".rb": "ruby", ".rake": "ruby",
  // PHP
  ".php": "php",
  // Swift
  ".swift": "swift",
  // Shell
  ".sh": "bash", ".bash": "bash", ".zsh": "bash",
  // Markup/Config
  ".json": "json", ".yaml": "yaml", ".yml": "yaml", ".toml": "toml",
  ".xml": "xml", ".html": "html", ".css": "css", ".scss": "scss",
  // SQL
  ".sql": "sql",
  // Lua
  ".lua": "lua",
  // Zig
  ".zig": "zig",
  // Markdown
  ".md": "markdown",
};

/**
 * Detect language from file path
 */
function detectLanguage(filePath: string): string {
  const lastDot = filePath.lastIndexOf(".");
  const lastSep = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));

  if (lastDot === -1 || lastDot < lastSep) {
    return "text";
  }

  const ext = filePath.slice(lastDot).toLowerCase();
  return EXT_TO_LANG[ext] || "text";
}

function renderCodemapBlock(code: string, theme: Theme): string {
  const lines = code.split("\n");
  const result: string[] = [];
  
  // Track context for highlighting
  let currentLang = "text";
  let inCodeSection = false; // True when inside Imports/Methods/Properties/etc with code content
  
  for (const line of lines) {
    const trimmed = line.trimStart();
    const indent = line.slice(0, line.length - trimmed.length);
    
    // File headers: "File: path/to/file.ts"
    if (trimmed.startsWith("File:")) {
      const filePath = trimmed.slice(5).trim();
      currentLang = detectLanguage(filePath);
      result.push(indent + theme.fg("accent", theme.bold("File:")) + " " + theme.fg("warning", filePath));
      inCodeSection = false;
    }
    // Section separators
    else if (trimmed === "---") {
      result.push(indent + theme.fg("muted", "---"));
      inCodeSection = false;
    }
    // Section headers
    else if (trimmed.match(/^(Imports|Classes|Functions|Methods|Properties|Type-aliases|Interfaces|Exports|Constants):$/)) {
      const sectionName = trimmed.slice(0, -1); // Remove colon
      result.push(indent + theme.fg("success", theme.bold(sectionName + ":")));
      // These sections contain code content
      inCodeSection = ["Imports", "Methods", "Properties", "Functions", "Exports", "Constants"].includes(sectionName);
    }
    // Bullet items: "- something"
    else if (trimmed.startsWith("- ")) {
      const content = trimmed.slice(2);
      
      // Check if this looks like a simple identifier (class/type name) vs code
      if (content.match(/^[\w-]+$/) && !inCodeSection) {
        // Simple identifier - likely a class or type name
        result.push(indent + theme.fg("muted", "- ") + theme.fg("accent", theme.bold(content)));
      } else {
        // Code content - use syntax highlighting
        const highlightedLines = highlightCode(content, currentLang);

        const firstPrefix = indent + theme.fg("muted", "- ");
        const nextPrefix = indent + theme.fg("muted", "  ");

        result.push(
          ...highlightedLines.map((line, idx) => (idx === 0 ? firstPrefix : nextPrefix) + line)
        );
      }
    }
    // Code continuation lines (indented code in method bodies, etc.)
    else if (indent.length > 0 && trimmed.length > 0) {
      const highlightedLines = highlightCode(trimmed, currentLang);
      result.push(...highlightedLines.map((line) => indent + line));
    }
    // Empty lines
    else if (trimmed === "") {
      result.push("");
    }
    // Default: dim
    else {
      result.push(indent + theme.fg("dim", trimmed));
    }
  }
  
  return result.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Rendering Function
// ─────────────────────────────────────────────────────────────────────────────

export interface RenderOptions {
  expanded?: boolean;
  maxCollapsedLines?: number;
}

/**
 * Render RepoPrompt output with syntax highlighting for fenced code blocks.
 * - ```diff blocks use delta when available, with word-level fallback
 * - Other fenced blocks get syntax highlighting via Pi's highlightCode
 * - Non-fenced content is rendered with markdown-aware styling
 */
export function renderRpOutput(
  text: string,
  theme: Theme,
  options: RenderOptions = {}
): string {
  const blocks = parseFencedBlocks(text);

  if (blocks.length === 0) {
    // No code fences - render with markdown-aware styling
    return renderMarkdownText(text, theme);
  }

  const result: string[] = [];
  let lastEnd = 0;

  for (const block of blocks) {
    // Render text before this block
    if (block.startIndex > lastEnd) {
      const before = text.slice(lastEnd, block.startIndex);
      result.push(renderMarkdownText(before, theme));
    }

    // Render the fenced block
    if (block.lang?.toLowerCase() === "diff") {
      // Diff block: use word-level diff highlighting
      result.push(theme.fg("muted", "```diff"));
      result.push(renderDiffBlock(block.code, theme));
      result.push(theme.fg("muted", "```"));
    } else if (block.lang?.toLowerCase() === "text" && isCodemapContent(block.code)) {
      // Codemap block: use codemap highlighting
      result.push(theme.fg("muted", "```text"));
      result.push(renderCodemapBlock(block.code, theme));
      result.push(theme.fg("muted", "```"));
    } else if (block.lang) {
      // Other language: use Pi's syntax highlighting
      result.push(theme.fg("muted", "```" + block.lang));
      const highlighted = highlightCode(block.code, block.lang);
      result.push(highlighted.join("\n"));
      result.push(theme.fg("muted", "```"));
    } else {
      // No language specified: check if it's a codemap
      if (isCodemapContent(block.code)) {
        result.push(theme.fg("muted", "```"));
        result.push(renderCodemapBlock(block.code, theme));
        result.push(theme.fg("muted", "```"));
      } else {
        result.push(theme.fg("muted", "```"));
        result.push(theme.fg("dim", block.code));
        result.push(theme.fg("muted", "```"));
      }
    }

    lastEnd = block.endIndex;
  }

  // Render text after last block
  if (lastEnd < text.length) {
    const after = text.slice(lastEnd);
    result.push(renderMarkdownText(after, theme));
  }

  return result.join("\n");
}

/**
 * Render markdown-formatted text with styling
 */
function renderMarkdownText(text: string, theme: Theme): string {
  const lines = text.split("\n");
  const result: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Headers
    if (trimmed.startsWith("## ")) {
      result.push(theme.fg("accent", theme.bold(trimmed)));
    } else if (trimmed.startsWith("# ")) {
      result.push(theme.fg("accent", theme.bold(trimmed)));
    } else if (trimmed.startsWith("### ")) {
      result.push(theme.fg("accent", trimmed));
    }
    // Success indicators
    else if (trimmed.includes("✅") || trimmed.includes("✓")) {
      result.push(theme.fg("success", line));
    }
    // Error indicators
    else if (trimmed.includes("❌") || trimmed.includes("✗") || trimmed.toLowerCase().includes("error")) {
      result.push(theme.fg("error", line));
    }
    // Warning indicators
    else if (trimmed.includes("⚠") || trimmed.toLowerCase().includes("warning")) {
      result.push(theme.fg("warning", line));
    }
    // Bullet points
    else if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      // Check for bold items like "- **Path**: value"
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
    }
    // File/path references
    else if (trimmed.startsWith("📄") || trimmed.startsWith("📂")) {
      result.push(theme.fg("accent", line));
    }
    // Empty lines
    else if (trimmed === "") {
      result.push("");
    }
    // Default: dim
    else {
      result.push(theme.fg("dim", line));
    }
  }

  return result.join("\n");
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

    // Drop markdown fence lines like ``` or ```ts or ```diff
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

  // Trim trailing empties
  while (filtered.length > 0 && filtered[filtered.length - 1]?.trim().length === 0) {
    filtered.pop();
  }

  return filtered;
}

/**
 * Prepare output for collapsed view (truncate if needed)
 */
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

  // Truncate to maxLines
  const truncatedText = lines.slice(0, maxLines).join("\n");
  const content = renderRpOutput(truncatedText, theme);

  return {
    content,
    truncated: true,
    totalLines,
  };
}
