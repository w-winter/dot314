import type { DiffSummaryStats } from "./diff-presentation.js";
import { summarizeDiffText } from "./diff-renderer.js";
import { parseFencedBlocks } from "./render.js";

export interface ToolResultNormalization {
  contentText: string;
  details: {
    diff: string;
    diffStats: DiffSummaryStats;
  };
}

function pluralize(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

function buildApplyEditsSummaryText(stats: DiffSummaryStats): string {
  const parts = ["Applied edits"];

  if (stats.added > 0 || stats.removed > 0) {
    parts.push(`+${stats.added} -${stats.removed}`);
  }

  if (stats.hunks > 0) {
    parts.push(`${stats.hunks} ${pluralize(stats.hunks, "hunk")}`);
  }

  if (stats.files > 0) {
    parts.push(`${stats.files} ${pluralize(stats.files, "file")}`);
  }

  return parts.join(" • ");
}

function normalizeDiffBlockCode(code: string): string {
  return code.replace(/\r/g, "").replace(/\n+$/u, "");
}

export function normalizeToolResultText(args: {
  toolName: string | undefined;
  text: string;
  raw: boolean | undefined;
}): ToolResultNormalization | null {
  if (args.toolName !== "apply_edits" || args.raw === true || !args.text.includes("```diff")) {
    return null;
  }

  const diffBlocks = parseFencedBlocks(args.text)
    .filter((block) => block.lang?.toLowerCase() === "diff")
    .map((block) => normalizeDiffBlockCode(block.code));

  if (diffBlocks.length === 0) {
    return null;
  }

  const diff = diffBlocks.join("\n\n");
  if (!diff.trim()) {
    return null;
  }

  const diffStats = summarizeDiffText(diff);
  return {
    contentText: buildApplyEditsSummaryText(diffStats),
    details: {
      diff,
      diffStats,
    },
  };
}
