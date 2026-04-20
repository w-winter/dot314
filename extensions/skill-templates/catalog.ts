import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { SlashCommandInfo } from "@mariozechner/pi-coding-agent";
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";
import ignore from "ignore";

import {
  FALLBACK_SKILL_FILE,
  IGNORE_FILE_NAMES,
  MAX_DESCRIPTION_LENGTH,
  MAX_NAME_LENGTH,
  TEMPLATE_SKILL_FILE,
  type DiscoveryDiagnostic,
  type TemplateCatalog,
  type TemplateSkill,
} from "./types.ts";

interface SkillFrontmatter {
  name?: string;
  description?: string;
  "disable-model-invocation"?: boolean;
  [key: string]: unknown;
}

export interface BuildTemplateCatalogInput {
  cwd: string;
  commands: SlashCommandInfo[];
  agentDir?: string;
  userHomeDir?: string;
}

type IgnoreMatcher = ReturnType<typeof ignore>;

function toPosixPath(value: string): string {
  return value.split(sep).join("/");
}

function prefixIgnorePattern(line: string, prefix: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith("#") && !trimmed.startsWith("\\#")) {
    return null;
  }

  let pattern = line;
  let negated = false;

  if (pattern.startsWith("!")) {
    negated = true;
    pattern = pattern.slice(1);
  } else if (pattern.startsWith("\\!")) {
    pattern = pattern.slice(1);
  }

  if (pattern.startsWith("/")) {
    pattern = pattern.slice(1);
  }

  const prefixed = prefix ? `${prefix}${pattern}` : pattern;
  return negated ? `!${prefixed}` : prefixed;
}

function addIgnoreRules(ignoreMatcher: IgnoreMatcher, dir: string, rootDir: string): void {
  const relativeDir = relative(rootDir, dir);
  const prefix = relativeDir ? `${toPosixPath(relativeDir)}/` : "";

  for (const fileName of IGNORE_FILE_NAMES) {
    const ignorePath = join(dir, fileName);
    if (!existsSync(ignorePath)) {
      continue;
    }

    try {
      const content = readFileSync(ignorePath, "utf8");
      const patterns = content
        .split(/\r?\n/)
        .map((line) => prefixIgnorePattern(line, prefix))
        .filter((line): line is string => Boolean(line));
      if (patterns.length > 0) {
        ignoreMatcher.add(patterns);
      }
    } catch {
      // Ignore unreadable ignore files
    }
  }
}

function normalizePath(input: string, userHomeDir: string): string {
  const trimmed = input.trim();
  if (trimmed === "~") {
    return userHomeDir;
  }
  if (trimmed.startsWith("~/")) {
    return join(userHomeDir, trimmed.slice(2));
  }
  if (trimmed.startsWith("~")) {
    return join(userHomeDir, trimmed.slice(1));
  }
  return trimmed;
}

function resolveMaybeRelativePath(input: string, baseDir: string, userHomeDir: string): string {
  const normalized = normalizePath(input, userHomeDir);
  return isAbsolute(normalized) ? normalized : resolve(baseDir, normalized);
}

function canonicalizePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isIgnorableFilesystemError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return false;
  }

  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "EACCES" || code === "EPERM" || code === "ELOOP";
}

function findGitRepoRoot(startDir: string): string | null {
  let currentDir = resolve(startDir);

  while (true) {
    if (existsSync(join(currentDir, ".git"))) {
      return currentDir;
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

function collectAncestorAgentsSkillDirs(startDir: string): string[] {
  const skillDirs: string[] = [];
  const resolvedStartDir = resolve(startDir);
  const gitRepoRoot = findGitRepoRoot(resolvedStartDir);

  let currentDir = resolvedStartDir;
  while (true) {
    skillDirs.push(join(currentDir, ".agents", "skills"));
    if (gitRepoRoot && currentDir === gitRepoRoot) {
      break;
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  return skillDirs;
}

function inferRootFromSkillPath(skillPath: string): string {
  const resolvedSkillPath = resolve(skillPath);
  const containingDir = dirname(resolvedSkillPath);

  let currentDir = containingDir;
  while (true) {
    if (basename(currentDir) === "skills") {
      return currentDir;
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  if (basename(resolvedSkillPath) !== FALLBACK_SKILL_FILE) {
    return containingDir;
  }

  return dirname(containingDir);
}

function collectRootCandidates(input: BuildTemplateCatalogInput): {
  roots: string[];
  diagnostics: DiscoveryDiagnostic[];
} {
  const userHomeDir = input.userHomeDir ?? homedir();
  const agentDir = input.agentDir ?? join(userHomeDir, ".pi", "agent");
  const roots: string[] = [];
  const diagnostics: DiscoveryDiagnostic[] = [];
  const seen = new Set<string>();

  const addRoot = (rootPath: string): void => {
    const canonicalPath = canonicalizePath(rootPath);
    if (seen.has(canonicalPath)) {
      return;
    }
    seen.add(canonicalPath);
    roots.push(canonicalPath);
  };

  for (const command of input.commands) {
    if (command.source !== "skill") {
      continue;
    }
    addRoot(inferRootFromSkillPath(command.sourceInfo.path));
  }

  addRoot(join(agentDir, "skills"));
  addRoot(join(userHomeDir, ".agents", "skills"));
  addRoot(resolve(input.cwd, ".pi", "skills"));

  for (const projectAgentsSkillsDir of collectAncestorAgentsSkillDirs(input.cwd)) {
    addRoot(projectAgentsSkillsDir);
  }

  const settingsPaths = [join(agentDir, "settings.json"), resolve(input.cwd, ".pi", "settings.json")];
  for (const settingsPath of settingsPaths) {
    if (!existsSync(settingsPath)) {
      continue;
    }

    try {
      const raw = readFileSync(settingsPath, "utf8");
      const parsed = JSON.parse(raw) as { skills?: unknown };
      if (!Array.isArray(parsed.skills)) {
        continue;
      }

      for (const configuredPath of parsed.skills) {
        if (typeof configuredPath !== "string") {
          continue;
        }

        const resolvedConfiguredPath = resolveMaybeRelativePath(configuredPath, dirname(settingsPath), userHomeDir);
        if (!existsSync(resolvedConfiguredPath)) {
          diagnostics.push({
            level: "warning",
            path: settingsPath,
            message: `Configured skill path does not exist: ${configuredPath}`,
          });
          continue;
        }
        addRoot(resolvedConfiguredPath);
      }
    } catch (error) {
      diagnostics.push({
        level: "warning",
        path: settingsPath,
        message: error instanceof Error ? error.message : "Failed to read settings file",
      });
    }
  }

  return { roots, diagnostics };
}

function validateName(name: string, parentDirName: string): string[] {
  const errors: string[] = [];

  if (name !== parentDirName) {
    errors.push(`name "${name}" does not match parent directory "${parentDirName}"`);
  }
  if (name.length > MAX_NAME_LENGTH) {
    errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
  }
  if (!/^[a-z0-9-]+$/.test(name)) {
    errors.push("name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)");
  }
  if (name.startsWith("-") || name.endsWith("-")) {
    errors.push("name must not start or end with a hyphen");
  }
  if (name.includes("--")) {
    errors.push("name must not contain consecutive hyphens");
  }

  return errors;
}

function validateDescription(description: string | undefined): string[] {
  const errors: string[] = [];

  if (!description || description.trim() === "") {
    errors.push("description is required");
  } else if (description.length > MAX_DESCRIPTION_LENGTH) {
    errors.push(`description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`);
  }

  return errors;
}

function scanTemplateSkillFiles(rootPath: string): string[] {
  if (!existsSync(rootPath)) {
    return [];
  }

  try {
    const rootStats = statSync(rootPath);
    if (rootStats.isFile()) {
      return basename(rootPath) === TEMPLATE_SKILL_FILE ? [canonicalizePath(rootPath)] : [];
    }
  } catch (error) {
    if (isIgnorableFilesystemError(error)) {
      return [];
    }
    throw error;
  }

  const scanDirectory = (dir: string, rootDir: string, ignoreMatcher: IgnoreMatcher): string[] => {
    addIgnoreRules(ignoreMatcher, dir, rootDir);

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
    } catch (error) {
      if (isIgnorableFilesystemError(error)) {
        return [];
      }
      throw error;
    }

    for (const entry of entries) {
      if (entry.name !== TEMPLATE_SKILL_FILE) {
        continue;
      }

      const fullPath = join(dir, entry.name);
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          isFile = statSync(fullPath).isFile();
        } catch (error) {
          if (isIgnorableFilesystemError(error)) {
            continue;
          }
          throw error;
        }
      }

      const relativePath = toPosixPath(relative(rootDir, fullPath));
      if (isFile && !ignoreMatcher.ignores(relativePath)) {
        return [canonicalizePath(fullPath)];
      }
    }

    const discovered: string[] = [];

    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      if (entry.name === "node_modules") {
        continue;
      }

      const fullPath = join(dir, entry.name);
      let isDirectory = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          isDirectory = statSync(fullPath).isDirectory();
        } catch (error) {
          if (isIgnorableFilesystemError(error)) {
            continue;
          }
          throw error;
        }
      }

      const relativePath = toPosixPath(relative(rootDir, fullPath));
      const ignorePath = isDirectory ? `${relativePath}/` : relativePath;
      if (ignoreMatcher.ignores(ignorePath)) {
        continue;
      }

      if (isDirectory) {
        discovered.push(...scanDirectory(fullPath, rootDir, ignoreMatcher));
      }
    }

    return discovered;
  };

  return scanDirectory(rootPath, rootPath, ignore());
}

function analyzeSiblingFallback(
  filePath: string,
  templateName: string,
  templateDescription: string | undefined,
): { diagnostics: DiscoveryDiagnostic[]; shadowsTemplate: boolean } {
  const fallbackSkillPath = join(dirname(filePath), FALLBACK_SKILL_FILE);
  if (!existsSync(fallbackSkillPath)) {
    return { diagnostics: [], shadowsTemplate: false };
  }

  try {
    const fallbackContent = readFileSync(fallbackSkillPath, "utf8");
    const fallbackFrontmatter = parseFrontmatter<SkillFrontmatter>(fallbackContent).frontmatter;
    const parentDirName = basename(dirname(filePath));
    const fallbackName = fallbackFrontmatter.name ?? parentDirName;
    const diagnostics: DiscoveryDiagnostic[] = [];

    if (templateName !== fallbackName) {
      diagnostics.push({
        level: "warning",
        path: filePath,
        relatedPath: fallbackSkillPath,
        message: `Template skill name "${templateName}" does not match sibling SKILL.md name "${fallbackName}"`,
      });
    }

    const normalizedTemplateDescription = templateDescription?.trim() ?? "";
    const fallbackDescription = fallbackFrontmatter.description?.trim() ?? "";
    if (normalizedTemplateDescription !== fallbackDescription) {
      diagnostics.push({
        level: "warning",
        path: filePath,
        relatedPath: fallbackSkillPath,
        message: "Template skill description does not match sibling SKILL.md description",
      });
    }

    return {
      diagnostics,
      shadowsTemplate: fallbackName === templateName,
    };
  } catch (error) {
    return {
      diagnostics: [
        {
          level: "warning",
          path: filePath,
          relatedPath: fallbackSkillPath,
          message: error instanceof Error ? error.message : "Failed to compare sibling SKILL.md frontmatter",
        },
      ],
      shadowsTemplate: false,
    };
  }
}

function loadTemplateSkill(
  filePath: string,
): { skill: TemplateSkill | null; diagnostics: DiscoveryDiagnostic[]; shadowsFallbackSkill: boolean } {
  try {
    const rawContent = readFileSync(filePath, "utf8");
    const { frontmatter } = parseFrontmatter<SkillFrontmatter>(rawContent);
    const baseDir = dirname(filePath);
    const parentDirName = basename(baseDir);
    const name = frontmatter.name ?? parentDirName;
    const description = frontmatter.description;
    const diagnostics: DiscoveryDiagnostic[] = [];

    for (const error of validateDescription(description)) {
      diagnostics.push({ level: "warning", path: filePath, message: error });
    }
    for (const error of validateName(name, parentDirName)) {
      diagnostics.push({ level: "warning", path: filePath, message: error });
    }

    const siblingFallback = analyzeSiblingFallback(filePath, name, description);
    diagnostics.push(...siblingFallback.diagnostics);

    if (!description || description.trim() === "") {
      return { skill: null, diagnostics, shadowsFallbackSkill: false };
    }

    return {
      skill: {
        name,
        description,
        filePath,
        baseDir,
        hasFallbackSkill: existsSync(join(baseDir, FALLBACK_SKILL_FILE)),
      },
      diagnostics,
      shadowsFallbackSkill: siblingFallback.shadowsTemplate,
    };
  } catch (error) {
    return {
      skill: null,
      diagnostics: [
        {
          level: "warning",
          path: filePath,
          message: error instanceof Error ? error.message : "Failed to parse template skill",
        },
      ],
      shadowsFallbackSkill: false,
    };
  }
}

export function buildTemplateCatalog(input: BuildTemplateCatalogInput): TemplateCatalog {
  const { roots, diagnostics } = collectRootCandidates(input);
  const orderedSkills: TemplateSkill[] = [];
  const skillsByName = new Map<string, TemplateSkill>();
  const shadowedSkills: TemplateSkill[] = [];
  const seenRealPaths = new Set<string>();
  const allDiagnostics: DiscoveryDiagnostic[] = [...diagnostics];

  for (const root of roots) {
    for (const filePath of scanTemplateSkillFiles(root)) {
      const canonicalFilePath = canonicalizePath(filePath);
      if (seenRealPaths.has(canonicalFilePath)) {
        continue;
      }
      seenRealPaths.add(canonicalFilePath);

      const result = loadTemplateSkill(canonicalFilePath);
      allDiagnostics.push(...result.diagnostics);
      if (!result.skill) {
        continue;
      }

      const existing = skillsByName.get(result.skill.name);
      if (existing) {
        allDiagnostics.push({
          level: "collision",
          path: result.skill.filePath,
          relatedPath: existing.filePath,
          message: `name "${result.skill.name}" collision`,
        });
        continue;
      }

      skillsByName.set(result.skill.name, result.skill);
      orderedSkills.push(result.skill);
      if (result.shadowsFallbackSkill) {
        shadowedSkills.push(result.skill);
      }
    }
  }

  return {
    orderedSkills,
    skillsByName,
    diagnostics: allDiagnostics,
    shadowedSkills,
  };
}
