import { readFileSync } from "node:fs";
import { join, matchesGlob } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

const configPath = join(getAgentDir(), "extensions", "native-mcp-approvals", "config.json");
const configSchema = Type.Object({
  approveTools: Type.Array(Type.String()),
  exemptServers: Type.Array(Type.String({ pattern: "^[A-Za-z0-9_-]+$" })),
}, { additionalProperties: false });

function readConfig() {
  const config: unknown = JSON.parse(readFileSync(configPath, "utf8"));
  if (!Value.Check(configSchema, config)) {
    throw new Error(
      `Invalid ${configPath}: expected approveTools and exemptServers string arrays; ` +
      "server names may contain letters, digits, underscores and hyphens; extra fields are not allowed",
    );
  }
  return config;
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    const tool = pi.getAllTools().find((candidate) => candidate.name === event.toolName);
    if (tool?.sourceInfo.path !== "builtin:mcp" || !tool.namespace) return;

    // Reading inside the hook makes configuration errors block calls rather than unload the guard.
    const config = readConfig();
    const namespace = tool.namespace.name;
    if (config.exemptServers.some((server) => namespace === `mcp__${server.replace(/-/g, "_")}`)) return;

    const name = event.toolName.slice(namespace.length + "__".length);
    if (!config.approveTools.some((pattern) => matchesGlob(name, pattern.replace(/[^A-Za-z0-9_*]/g, "_")))) return;

    if (!ctx.hasUI) {
      return { block: true, reason: `${event.toolName} requires interactive approval` };
    }
    ctx.signal?.throwIfAborted();
    const approved = await ctx.ui.confirm(
      `Allow ${event.toolName}?`,
      JSON.stringify(event.input, null, 2),
      { signal: ctx.signal },
    );
    ctx.signal?.throwIfAborted();
    if (!approved) return { block: true, reason: `${event.toolName} was not approved` };
  });
}
