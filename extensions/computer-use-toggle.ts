import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PACKAGE_SOURCE = "npm:@injaneity/pi-computer-use";
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const SETTINGS_PATH = join(AGENT_DIR, "settings.json");

type Settings = Record<string, unknown> & {
  packages: unknown[];
};

function parseSettings(content: string): Settings {
  const settings = JSON.parse(content) as unknown;
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    throw new Error(`${SETTINGS_PATH} must contain a JSON object`);
  }

  const packages = (settings as Record<string, unknown>).packages;
  if (!Array.isArray(packages)) {
    throw new Error(`${SETTINGS_PATH} must contain a packages array`);
  }

  return settings as Settings;
}

export default function computerUseToggleExtension(pi: ExtensionAPI) {
  pi.registerCommand("computer-use-toggle", {
    description: "Enable or disable the pi-computer-use package (usage: /computer-use-toggle <on|off>)",
    getArgumentCompletions: (prefix) => {
      const options = ["on", "off"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value }));
      return options.length > 0 ? options : null;
    },
    handler: async (args, ctx) => {
      const mode = args.trim();
      if (mode !== "on" && mode !== "off") {
        ctx.ui.notify("Usage: /computer-use-toggle <on|off>", "error");
        return;
      }

      try {
        const settings = parseSettings(await readFile(SETTINGS_PATH, "utf8"));
        const isEnabled = settings.packages.includes(PACKAGE_SOURCE);
        const shouldEnable = mode === "on";

        if (isEnabled === shouldEnable) {
          ctx.ui.notify(`Computer-use tools are already ${mode}.`, "info");
          return;
        }

        settings.packages = shouldEnable
          ? [...settings.packages, PACKAGE_SOURCE]
          : settings.packages.filter((entry) => entry !== PACKAGE_SOURCE);

        await writeFile(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
        ctx.ui.notify(`Computer-use tools turned ${mode}. Reloading Pi resources...`, "info");
        await ctx.reload();
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Could not update ${SETTINGS_PATH}: ${message}`, "error");
      }
    },
  });
}
