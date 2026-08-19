import fs from "node:fs";
import { fileURLToPath } from "node:url";

import type { DiffViewMode } from "./diff-presentation.js";

export interface ApplyPatchDiffConfig {
  diffViewMode: DiffViewMode;
  diffSplitMinWidth: number;
}

const DEFAULT_CONFIG: ApplyPatchDiffConfig = {
  diffViewMode: "auto",
  diffSplitMinWidth: 120,
};

const DIFF_VIEW_MODES = new Set<DiffViewMode>(["auto", "split", "unified"]);
const CONFIG_PATH = fileURLToPath(new URL("./config.json", import.meta.url));

function parseDiffViewMode(value: unknown): DiffViewMode {
  return DIFF_VIEW_MODES.has(value as DiffViewMode)
    ? value as DiffViewMode
    : DEFAULT_CONFIG.diffViewMode;
}

function parseSplitMinWidth(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_CONFIG.diffSplitMinWidth;
  }
  return Math.min(240, Math.max(70, Math.round(value)));
}

export function loadApplyPatchDiffConfig(): ApplyPatchDiffConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    return DEFAULT_CONFIG;
  }

  const value = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${CONFIG_PATH} must contain a JSON object`);
  }

  const config = value as Record<string, unknown>;
  return {
    diffViewMode: parseDiffViewMode(config.diffViewMode),
    diffSplitMinWidth: parseSplitMinWidth(config.diffSplitMinWidth),
  };
}
