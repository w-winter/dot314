export const TEMPLATE_SKILL_FILE = "SKILL.template.md";
export const FALLBACK_SKILL_FILE = "SKILL.md";
export const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"] as const;
export const MAX_NAME_LENGTH = 64;
export const MAX_DESCRIPTION_LENGTH = 1024;
export const TEMPLATE_REF_VARIABLE = "__pi_skill_templates_ref";
export const RESERVED_ARGUMENT_KEYS = [
  "args",
  "all_args",
  "skill_name",
  "named",
  TEMPLATE_REF_VARIABLE,
] as const;

export type DiscoveryDiagnosticLevel = "warning" | "collision";
export type InvocationArgumentValue = string | true;
export type TemplateVariableValue = string | boolean;

export interface TemplateSkill {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  hasFallbackSkill: boolean;
}

export interface DiscoveryDiagnostic {
  level: DiscoveryDiagnosticLevel;
  path: string;
  message: string;
  relatedPath?: string;
}

export interface TemplateCatalog {
  orderedSkills: TemplateSkill[];
  skillsByName: Map<string, TemplateSkill>;
  diagnostics: DiscoveryDiagnostic[];
  shadowedSkills: TemplateSkill[];
}

export interface ParsedInvocationArgs {
  raw: string;
  args: string[];
  named: Record<string, InvocationArgumentValue>;
  vars: Record<string, TemplateVariableValue>;
}

export interface ExtensionState {
  cwd: string;
  catalog: TemplateCatalog;
  catalogInitialized: boolean;
  refreshPending: boolean;
  shadowNoticeShown: boolean;
}

export interface TemplateRef {
  filePath: string;
  ancestry: string[];
}
