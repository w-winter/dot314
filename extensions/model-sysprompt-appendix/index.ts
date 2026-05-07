import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type SysPromptAppendixConfig = {
  exact?: Record<string, string>;
  default?: string;
  // only includes "Active model: ..." line when there's an exact match
  includeModelLine?: boolean;
};

function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

function loadConfig(configPath: string): SysPromptAppendixConfig {
  if (!fs.existsSync(configPath)) return {};
  const raw = fs.readFileSync(configPath, "utf-8");
  return JSON.parse(raw) as SysPromptAppendixConfig;
}

const PROJECT_CONTEXT_MARKER = "\n# Project Context";

function injectIntoSystemPrompt(systemPrompt: string, content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return systemPrompt;

  const markerIndex = systemPrompt.indexOf(PROJECT_CONTEXT_MARKER);
  if (markerIndex !== -1) {
    // Insert immediately before "# Project Context" with trailing newline
    return systemPrompt.slice(0, markerIndex) + "\n" + trimmed + "\n" + systemPrompt.slice(markerIndex);
  }

  if (systemPrompt.startsWith("# Project Context")) {
    return trimmed + "\n" + systemPrompt;
  }

  // Fallback: append at end if marker isn't present
  return systemPrompt + "\n" + trimmed;
}

export default function (pi: ExtensionAPI) {
  const configPath = path.join(getAgentDir(), "extensions", "model-sysprompt-appendix", "model-sysprompt-appendix.json");
  let config: SysPromptAppendixConfig = loadConfig(configPath);

  pi.registerCommand("model-sysprompt-appendix", {
    description: "Model-aware system prompt appendix (reload/status)",
    handler: async (args, ctx) => {
      const cmd = args.trim();
      if (cmd === "reload") {
        config = loadConfig(configPath);
        ctx.ui.notify(`Reloaded ${configPath}`, "info");
        return;
      }
      if (cmd === "status") {
        const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(no model)";
        const hasExact = !!(ctx.model && config.exact?.[`${ctx.model.provider}/${ctx.model.id}`]);
        ctx.ui.notify(`Model: ${model} | exact match: ${hasExact}`, "info");
        return;
      }
      ctx.ui.notify("Usage: /model-sysprompt-appendix reload | /model-sysprompt-appendix status", "info");
    },
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const modelKey = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
    const hasExactMatch = !!(modelKey && config.exact?.[modelKey]);

    const syspromptAppendix = hasExactMatch
      ? config.exact![modelKey]
      : (config.default || "");

    const modelLine =
      config.includeModelLine && hasExactMatch
        ? `Active model: ${modelKey}\n`
        : "";

    if (!syspromptAppendix && !modelLine) return;

    const content = `# Model Context\n${modelLine}${syspromptAppendix}`.trimEnd();
    return {
      systemPrompt: injectIntoSystemPrompt(event.systemPrompt, content),
    };
  });
}