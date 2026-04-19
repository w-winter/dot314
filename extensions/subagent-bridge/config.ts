import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface SubagentBridgeConfig {
  autoReportToParentOnAgentEnd: boolean;
}

const DEFAULT_CONFIG: SubagentBridgeConfig = {
  autoReportToParentOnAgentEnd: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function loadConfig(): SubagentBridgeConfig {
  const configPath = join(dirname(fileURLToPath(import.meta.url)), "config.json");
  if (!existsSync(configPath)) {
    return DEFAULT_CONFIG;
  }

  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    if (!isRecord(parsed)) {
      return DEFAULT_CONFIG;
    }

    return {
      autoReportToParentOnAgentEnd:
        typeof parsed.autoReportToParentOnAgentEnd === "boolean"
          ? parsed.autoReportToParentOnAgentEnd
          : DEFAULT_CONFIG.autoReportToParentOnAgentEnd,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}
