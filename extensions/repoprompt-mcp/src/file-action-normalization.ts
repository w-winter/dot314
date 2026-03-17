export interface FileActionDiffDetails {
  diff: string;
  filePath: string;
  contentText?: string;
  addRowBgMixRatio?: number;
  removeRowBgMixRatio?: number;
}

const FILE_ACTION_CREATE_ADD_BG_MIX_RATIO = 0.16;
const FILE_ACTION_DELETE_REMOVE_BG_MIX_RATIO = 0.08;

function normalizeDiffPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\/+/, "");
}

function normalizeLines(content: string): string[] {
  if (content.length === 0) {
    return [];
  }

  const normalized = content.replace(/\r/g, "");
  const lines = normalized.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function pluralize(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

function buildCreateSummaryText(lineCount: number): string {
  if (lineCount === 0) {
    return "Created empty file";
  }

  return `Created file • ${lineCount} ${pluralize(lineCount, "line")}`;
}

function buildCreateDiff(filePath: string, content: string): string {
  const normalizedPath = normalizeDiffPath(filePath);
  const lines = normalizeLines(content);
  const diffLines = [`created file ${normalizedPath}`];

  if (lines.length > 0) {
    diffLines.push(`@@ -0,0 +1,${lines.length} @@`);
    diffLines.push(...lines.map((line) => `+${line}`));
  }

  return diffLines.join("\n");
}

function buildDeleteDiff(filePath: string, content: string): string {
  const normalizedPath = normalizeDiffPath(filePath);
  const lines = normalizeLines(content);
  const diffLines = [`deleted file ${normalizedPath}`];

  if (lines.length > 0) {
    diffLines.push(`@@ -1,${lines.length} +0,0 @@`);
    diffLines.push(...lines.map((line) => `-${line}`));
  }

  return diffLines.join("\n");
}

export function normalizeFileActionResult(args: {
  action: unknown;
  path: unknown;
  content: unknown;
  deletedContent?: string;
}): FileActionDiffDetails | null {
  if (typeof args.path !== "string" || args.path.trim().length === 0) {
    return null;
  }

  if (args.action === "create" && typeof args.content === "string") {
    const lineCount = normalizeLines(args.content).length;
    return {
      diff: buildCreateDiff(args.path, args.content),
      filePath: args.path,
      contentText: buildCreateSummaryText(lineCount),
      addRowBgMixRatio: FILE_ACTION_CREATE_ADD_BG_MIX_RATIO,
    };
  }

  if (args.action === "delete" && typeof args.deletedContent === "string") {
    return {
      diff: buildDeleteDiff(args.path, args.deletedContent),
      filePath: args.path,
      removeRowBgMixRatio: FILE_ACTION_DELETE_REMOVE_BG_MIX_RATIO,
    };
  }

  return null;
}
