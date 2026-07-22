import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, test } from "node:test";

import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";

import { buildTemplateCatalog } from "../catalog.ts";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "skill-templates-catalog-"));
  tempDirs.push(dir);
  return dir;
}

function createSkill(root: string, name: string, content?: string): string {
  const filePath = join(root, name, "SKILL.template.md");
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(
    filePath,
    content ?? `---\ndescription: ${name} template\n---\nBody for ${name}\n`,
    "utf8",
  );
  return filePath;
}

function createCommand(path: string): SlashCommandInfo {
  return {
    name: `skill:${path}`,
    description: "command",
    source: "skill",
    sourceInfo: {
      path,
      source: "local",
      scope: "project",
      origin: "top-level",
      baseDir: dirname(path),
    },
  };
}

function canonicalizePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

test("buildTemplateCatalog prefers roots inferred from loaded skills before fallback roots", () => {
  const homeDir = createTempDir();
  const agentDir = join(homeDir, ".pi", "agent");
  const cwd = join(homeDir, "workspace");
  const inferredRoot = join(homeDir, "package-skill-root", "skills");
  const fallbackRoot = join(agentDir, "skills");

  const inferredSkillPath = createSkill(inferredRoot, "review");
  createSkill(fallbackRoot, "review", "---\ndescription: fallback review\n---\nFallback body\n");

  const catalog = buildTemplateCatalog({
    cwd,
    commands: [createCommand(join(inferredRoot, "review", "SKILL.md"))],
    projectTrusted: true,
    agentDir,
    userHomeDir: homeDir,
  });

  assert.equal(catalog.orderedSkills.length, 1);
  assert.equal(catalog.orderedSkills[0]?.filePath, canonicalizePath(inferredSkillPath));
  assert.equal(catalog.diagnostics.at(-1)?.level, "collision");
});

test("buildTemplateCatalog infers root correctly for direct markdown core skill paths", () => {
  const homeDir = createTempDir();
  const agentDir = join(homeDir, ".pi", "agent");
  const cwd = join(homeDir, "workspace");
  const directRoot = join(homeDir, "package-skill-root", "review-root");

  mkdirSync(directRoot, { recursive: true });
  writeFileSync(join(directRoot, "review.md"), "---\ndescription: review\n---\nBody\n", "utf8");
  const inferredSkillPath = createSkill(directRoot, "review");
  createSkill(dirname(directRoot), "unrelated");

  const catalog = buildTemplateCatalog({
    cwd,
    commands: [createCommand(join(directRoot, "review.md"))],
    projectTrusted: true,
    agentDir,
    userHomeDir: homeDir,
  });

  assert.deepEqual(catalog.orderedSkills.map((skill) => skill.name), ["review"]);
  assert.equal(catalog.orderedSkills[0]?.filePath, canonicalizePath(inferredSkillPath));
});

test("buildTemplateCatalog respects ignore files and stops recursing below a template skill root", () => {
  const homeDir = createTempDir();
  const cwd = join(homeDir, "workspace");
  const projectRoot = join(cwd, ".pi", "skills");

  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(join(projectRoot, ".gitignore"), "ignored-skill/\n", "utf8");
  createSkill(projectRoot, "ignored-skill");
  createSkill(projectRoot, "parent", "---\ndescription: parent\n---\nParent body\n");
  createSkill(join(projectRoot, "parent"), "child", "---\ndescription: child\n---\nChild body\n");

  const catalog = buildTemplateCatalog({ cwd, commands: [], projectTrusted: true, userHomeDir: homeDir, agentDir: join(homeDir, ".pi", "agent") });
  const names = catalog.orderedSkills.map((skill) => skill.name);

  assert.deepEqual(names, ["parent"]);
});

test("buildTemplateCatalog warns when sibling SKILL.md frontmatter diverges without marking a mismatched sibling as shadowed", () => {
  const homeDir = createTempDir();
  const cwd = join(homeDir, "workspace");
  const projectRoot = join(cwd, ".pi", "skills");
  const skillDir = join(projectRoot, "code-review");

  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.template.md"),
    "---\ndescription: Template description\n---\nTemplate body\n",
    "utf8",
  );
  writeFileSync(
    join(skillDir, "SKILL.md"),
    "---\nname: review\ndescription: Fallback description\n---\nFallback body\n",
    "utf8",
  );

  const catalog = buildTemplateCatalog({ cwd, commands: [], projectTrusted: true, userHomeDir: homeDir, agentDir: join(homeDir, ".pi", "agent") });
  const warningMessages = catalog.diagnostics.map((diagnostic) => diagnostic.message);

  assert.equal(catalog.shadowedSkills.length, 0);
  assert.ok(warningMessages.some((message) => message.includes("does not match sibling SKILL.md name")));
  assert.ok(warningMessages.some((message) => message.includes("description")));
});

test("buildTemplateCatalog marks a sibling SKILL.md as shadowed only when the effective names match", () => {
  const homeDir = createTempDir();
  const cwd = join(homeDir, "workspace");
  const projectRoot = join(cwd, ".pi", "skills");
  const skillDir = join(projectRoot, "review");

  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.template.md"),
    "---\ndescription: Template description\n---\nTemplate body\n",
    "utf8",
  );
  writeFileSync(
    join(skillDir, "SKILL.md"),
    "---\ndescription: Template description\n---\nFallback body\n",
    "utf8",
  );

  const catalog = buildTemplateCatalog({ cwd, commands: [], projectTrusted: true, userHomeDir: homeDir, agentDir: join(homeDir, ".pi", "agent") });

  assert.equal(catalog.shadowedSkills.length, 1);
  assert.equal(catalog.shadowedSkills[0]?.name, "review");
});

test("buildTemplateCatalog does not inspect project sources while untrusted", () => {
  const homeDir = createTempDir();
  const agentDir = join(homeDir, ".pi", "agent");
  const repoRoot = join(homeDir, "workspace");
  const cwd = join(repoRoot, "nested");
  const commandRoot = join(homeDir, "command-package", "skills");
  const configuredRoot = join(homeDir, "configured-skills");
  const projectSettingsPath = join(cwd, ".pi", "settings.json");
  const brokenProjectTemplate = join(cwd, ".pi", "skills", "broken-project", "SKILL.template.md");

  mkdirSync(join(repoRoot, ".git"), { recursive: true });
  mkdirSync(dirname(brokenProjectTemplate), { recursive: true });
  createSkill(commandRoot, "command-review");
  createSkill(join(agentDir, "skills"), "global-review");
  createSkill(configuredRoot, "configured-review");
  createSkill(join(repoRoot, ".agents", "skills"), "ancestor-review");
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ skills: [configuredRoot] }), "utf8");
  writeFileSync(projectSettingsPath, "{ invalid json", "utf8");
  writeFileSync(brokenProjectTemplate, "---\nname: broken-project\n---\nBody\n", "utf8");

  const input = {
    cwd,
    commands: [createCommand(join(commandRoot, "command-review", "SKILL.md"))],
    agentDir,
    userHomeDir: homeDir,
  };
  const untrustedCatalog = buildTemplateCatalog({ ...input, projectTrusted: false });

  assert.deepEqual(
    untrustedCatalog.orderedSkills.map((skill) => skill.name),
    ["command-review", "global-review", "configured-review"],
  );
  assert.equal(untrustedCatalog.diagnostics.some((diagnostic) => diagnostic.path === projectSettingsPath), false);
  const canonicalBrokenProjectTemplate = realpathSync(brokenProjectTemplate);
  assert.equal(
    untrustedCatalog.diagnostics.some((diagnostic) => diagnostic.path === canonicalBrokenProjectTemplate),
    false,
  );

  const trustedCatalog = buildTemplateCatalog({ ...input, projectTrusted: true });

  assert.ok(trustedCatalog.orderedSkills.some((skill) => skill.name === "ancestor-review"));
  assert.ok(trustedCatalog.diagnostics.some((diagnostic) => diagnostic.path === projectSettingsPath));
  assert.ok(trustedCatalog.diagnostics.some((diagnostic) => diagnostic.path === canonicalBrokenProjectTemplate));
});

test("buildTemplateCatalog classifies configured paths by their settings source", () => {
  const homeDir = createTempDir();
  const agentDir = join(homeDir, ".pi", "agent");
  const cwd = join(homeDir, "workspace");
  const globalConfiguredRoot = join(cwd, "global-configured-skills");
  const projectConfiguredRoot = join(cwd, "project-configured-skills");
  const projectSettingsPath = join(cwd, ".pi", "settings.json");

  createSkill(globalConfiguredRoot, "global-in-project");
  createSkill(projectConfiguredRoot, "project-configured");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(dirname(projectSettingsPath), { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ skills: [globalConfiguredRoot] }), "utf8");
  writeFileSync(projectSettingsPath, JSON.stringify({ skills: ["../project-configured-skills"] }), "utf8");

  const input = { cwd, commands: [], agentDir, userHomeDir: homeDir };
  const untrustedCatalog = buildTemplateCatalog({ ...input, projectTrusted: false });
  const trustedCatalog = buildTemplateCatalog({ ...input, projectTrusted: true });

  assert.deepEqual(untrustedCatalog.orderedSkills.map((skill) => skill.name), ["global-in-project"]);
  assert.deepEqual(
    trustedCatalog.orderedSkills.map((skill) => skill.name),
    ["global-in-project", "project-configured"],
  );
});
