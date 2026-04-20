import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  InputEvent,
  InputEventResult,
} from "@mariozechner/pi-coding-agent";

import { buildTemplateCatalog } from "./catalog.ts";
import { renderTemplateInvocation } from "./render.ts";
import type { ExtensionState, TemplateCatalog } from "./types.ts";

interface SkillTemplatesExtensionOptions {
  initialCwd?: string;
  agentDir?: string;
  userHomeDir?: string;
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
}
