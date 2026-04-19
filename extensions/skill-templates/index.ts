import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  InputEvent,
  InputEventResult,
} from "@mariozechner/pi-coding-agent";

import { buildTemplateCatalog } from "./catalog.ts";
import { renderTemplateInvocation } from "./render.ts";
import type { ExtensionState, TemplateCatalog, TemplateSkill } from "./types.ts";

interface SkillTemplatesExtensionOptions {
  initialCwd?: string;
  agentDir?: string;
  userHomeDir?: string;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function createEmptyCatalog(): TemplateCatalog {
  return {
    orderedSkills: [],
    skillsByName: new Map(),
    diagnostics: [],
    shadowedSkills: [],
  };
}

function createInitialState(options?: SkillTemplatesExtensionOptions): ExtensionState {
  return {
    cwd: options?.initialCwd ?? process.cwd(),
    catalog: createEmptyCatalog(),
    catalogInitialized: false,
    refreshPending: false,
    promptAppend: undefined,
    shadowNoticeShown: false,
  };
}

function reportError(ctx: Pick<ExtensionContext, "hasUI" | "ui"> | undefined, message: string, error?: unknown): void {
  if (error instanceof Error) {
    console.error(`[pi-skill-templates] ${message}`, error);
  } else {
    console.error(`[pi-skill-templates] ${message}`);
  }

  if (ctx?.hasUI) {
    ctx.ui.notify(message, "error");
  }
}

function logDiagnostics(catalog: TemplateCatalog): void {
  for (const diagnostic of catalog.diagnostics) {
    const suffix = diagnostic.relatedPath ? ` (related: ${diagnostic.relatedPath})` : "";
    console.warn(`[pi-skill-templates] ${diagnostic.level}: ${diagnostic.message} [${diagnostic.path}]${suffix}`);
  }
}

function buildPromptAppend(skills: TemplateSkill[]): string | undefined {
  const visibleSkills = skills.filter((skill) => !skill.disableModelInvocation);
  if (visibleSkills.length === 0) {
    return undefined;
  }

  const lines = [
    "Template-backed skill invocations:",
    "- Explicit user `/skill:<name>` commands may be backed by SKILL.template.md files.",
    "- When both SKILL.template.md and SKILL.md exist for the same skill name, the template-backed version wins for explicit user invocation.",
    "<template_skill_commands>",
  ];

  for (const skill of visibleSkills) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
    lines.push("  </skill>");
  }

  lines.push("</template_skill_commands>");
  return lines.join("\n");
}

function parseSkillInvocation(text: string): { skillName: string; rawArgs: string } | null {
  if (!text.startsWith("/skill:")) {
    return null;
  }

  const trailing = text.slice("/skill:".length);
  if (!trailing) {
    return null;
  }

  const firstWhitespaceIndex = trailing.search(/\s/);
  if (firstWhitespaceIndex === -1) {
    return { skillName: trailing, rawArgs: "" };
  }

  return {
    skillName: trailing.slice(0, firstWhitespaceIndex),
    rawArgs: trailing.slice(firstWhitespaceIndex + 1).trim(),
  };
}

function registerAliasCommands(
  state: ExtensionState,
  pi: ExtensionAPI,
  options?: SkillTemplatesExtensionOptions,
): void {
  for (const skill of state.catalog.orderedSkills) {
    const aliasName = `skill-template:${skill.name}`;

    pi.registerCommand(aliasName, {
      description: `${skill.description} [template alias]`,
      handler: async (args: string, ctx: ExtensionCommandContext) => {
        ensureCatalogCurrent(state, pi, ctx.cwd, options);

        const currentSkill = state.catalog.skillsByName.get(skill.name);
        if (!currentSkill) {
          reportError(ctx, `Template skill alias "/${aliasName}" is stale; reload the session to refresh commands`);
          return;
        }

        try {
          const { invocationText } = renderTemplateInvocation({
            skill: currentSkill,
            rawArgs: args,
          });

          pi.sendUserMessage(invocationText, ctx.isIdle() ? undefined : { deliverAs: "steer" });
        } catch (error) {
          reportError(ctx, `Failed to render template skill "${skill.name}"`, error);
        }
      },
    });
  }
}

function notifyShadowedSkills(state: ExtensionState, ctx: ExtensionContext): void {
  if (state.shadowNoticeShown || !ctx.hasUI || state.catalog.shadowedSkills.length === 0) {
    return;
  }

  const shadowedNames = state.catalog.shadowedSkills.map((skill) => `/skill:${skill.name}`).join(", ");
  ctx.ui.notify(
    `Template-backed skills active: ${shadowedNames} now use SKILL.template.md; autocomplete metadata may still reflect sibling SKILL.md`,
    "info",
  );
  state.shadowNoticeShown = true;
}

function applyCatalog(
  state: ExtensionState,
  pi: ExtensionAPI,
  cwd: string,
  catalog: TemplateCatalog,
  options?: SkillTemplatesExtensionOptions,
): void {
  state.cwd = cwd;
  state.catalog = catalog;
  state.catalogInitialized = true;
  state.refreshPending = false;
  state.promptAppend = buildPromptAppend(catalog.orderedSkills);
  logDiagnostics(catalog);
  registerAliasCommands(state, pi, options);
}

function initializeFallbackCatalog(
  state: ExtensionState,
  pi: ExtensionAPI,
  options?: SkillTemplatesExtensionOptions,
): void {
  const catalog = buildTemplateCatalog({
    cwd: state.cwd,
    commands: [],
    agentDir: options?.agentDir,
    userHomeDir: options?.userHomeDir,
  });
  applyCatalog(state, pi, state.cwd, catalog, options);
}

function refreshCatalog(
  state: ExtensionState,
  pi: ExtensionAPI,
  cwd: string,
  options?: SkillTemplatesExtensionOptions,
): void {
  const catalog = buildTemplateCatalog({
    cwd,
    commands: pi.getCommands(),
    agentDir: options?.agentDir,
    userHomeDir: options?.userHomeDir,
  });
  applyCatalog(state, pi, cwd, catalog, options);
}

function ensureCatalogCurrent(
  state: ExtensionState,
  pi: ExtensionAPI,
  cwd: string,
  options?: SkillTemplatesExtensionOptions,
): void {
  if (state.catalogInitialized && !state.refreshPending && state.cwd === cwd) {
    return;
  }
  refreshCatalog(state, pi, cwd, options);
}

function handleTemplateSkillInput(
  state: ExtensionState,
  pi: ExtensionAPI,
  event: InputEvent,
  ctx: ExtensionContext,
  options?: SkillTemplatesExtensionOptions,
): InputEventResult {
  if (event.source === "extension") {
    return { action: "continue" };
  }

  const invocation = parseSkillInvocation(event.text);
  if (!invocation) {
    return { action: "continue" };
  }

  ensureCatalogCurrent(state, pi, ctx.cwd, options);
  const skill = state.catalog.skillsByName.get(invocation.skillName);
  if (!skill) {
    return { action: "continue" };
  }

  try {
    const { invocationText } = renderTemplateInvocation({
      skill,
      rawArgs: invocation.rawArgs,
    });

    return {
      action: "transform",
      text: invocationText,
      images: event.images,
    };
  } catch (error) {
    reportError(ctx, `Failed to render template skill "${invocation.skillName}"`, error);
    return { action: "handled" };
  }
}

function handleBeforeAgentStart(
  state: ExtensionState,
  pi: ExtensionAPI,
  event: BeforeAgentStartEvent,
  ctx: ExtensionContext,
  options?: SkillTemplatesExtensionOptions,
): { systemPrompt?: string } | undefined {
  ensureCatalogCurrent(state, pi, ctx.cwd, options);
  if (!state.promptAppend) {
    return undefined;
  }

  return {
    systemPrompt: `${event.systemPrompt}\n\n${state.promptAppend}`,
  };
}

export default function skillTemplatesExtension(pi: ExtensionAPI, options?: SkillTemplatesExtensionOptions): void {
  const state = createInitialState(options);
  initializeFallbackCatalog(state, pi, options);

  pi.on("session_start", (_event, ctx) => {
    refreshCatalog(state, pi, ctx.cwd, options);
    notifyShadowedSkills(state, ctx);
  });

  pi.on("resources_discover", () => {
    state.refreshPending = true;
  });

  pi.on("input", (event, ctx) => handleTemplateSkillInput(state, pi, event, ctx, options));
  pi.on("before_agent_start", (event, ctx) => handleBeforeAgentStart(state, pi, event, ctx, options));
}
