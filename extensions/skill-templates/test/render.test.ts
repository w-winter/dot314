import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, test } from "node:test";

import { buildSkillInvocationText, renderTemplateInvocation } from "../render.ts";
import type { TemplateSkill } from "../types.ts";

const tempDirs: string[] = [];

function canonicalizePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "skill-templates-render-"));
  tempDirs.push(dir);
  return dir;
}

function createTemplateSkill(skillDir: string, content: string): TemplateSkill {
  mkdirSync(skillDir, { recursive: true });
  const filePath = join(skillDir, "SKILL.template.md");
  writeFileSync(filePath, content, "utf8");
  return {
    name: basename(skillDir),
    description: "template",
    filePath,
    baseDir: skillDir,
    hasFallbackSkill: false,
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

test("renderTemplateInvocation populates args context and wraps output like a Pi skill invocation", () => {
  const dir = createTempDir();
  const skill = createTemplateSkill(
    join(dir, "code-review"),
    "---\ndescription: review\n---\nMode={{ args[0] }} strict={{ strict }} lang={{ lang }} foo={{ foo_bar }}",
  );

  const result = renderTemplateInvocation({
    skill,
    rawArgs: "security --strict --lang python --foo-bar=baz",
  });

  assert.equal(result.renderedBody, "Mode=security strict=true lang=python foo=baz");
  assert.ok(
    result.invocationText.startsWith(`<skill name=\"code-review\" location=\"${canonicalizePath(skill.filePath)}\">`),
  );
  assert.ok(result.invocationText.endsWith("security --strict --lang python --foo-bar=baz"));
});

test("renderTemplateInvocation supports native relative includes", () => {
  const dir = createTempDir();
  const skillDir = join(dir, "review");
  mkdirSync(join(skillDir, "partials"), { recursive: true });
  writeFileSync(join(skillDir, "partials", "extra.md"), "Included {{ args[0] }}", "utf8");
  const skill = createTemplateSkill(
    skillDir,
    "---\ndescription: review\n---\nStart\n{% include \"./partials/extra.md\" %}\nEnd",
  );

  const result = renderTemplateInvocation({ skill, rawArgs: "security" });

  assert.equal(result.renderedBody, "Start\nIncluded security\nEnd");
});

test("renderTemplateInvocation supports {% skill %} inclusion and strips frontmatter", () => {
  const dir = createTempDir();
  const skillDir = join(dir, "review");
  const includedDir = join(dir, "shared-guide");
  mkdirSync(includedDir, { recursive: true });
  writeFileSync(
    join(includedDir, "SKILL.md"),
    "---\ndescription: guide\n---\nGuide for {{ skill_name }} in {{ lang }}",
    "utf8",
  );
  const skill = createTemplateSkill(
    skillDir,
    "---\ndescription: review\n---\nIntro\n{% skill \"../shared-guide\" %}\nOutro",
  );

  const result = renderTemplateInvocation({ skill, rawArgs: "--lang python" });

  assert.equal(result.renderedBody, "Intro\nGuide for review in python\nOutro");
});

test("renderTemplateInvocation reports circular native includes", () => {
  const dir = createTempDir();
  const skillDir = join(dir, "review");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "loop.md"), "{% include \"./loop.md\" %}", "utf8");
  const skill = createTemplateSkill(skillDir, "---\ndescription: review\n---\n{% include \"./loop.md\" %}");

  assert.throws(() => renderTemplateInvocation({ skill, rawArgs: "" }), /Circular template inclusion detected/);
});

test("renderTemplateInvocation reports circular {% skill %} inclusion", () => {
  const dir = createTempDir();
  const skillDir = join(dir, "review");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    "---\ndescription: fallback\n---\n{% skill \"./SKILL.md\" %}",
    "utf8",
  );
  const skill = createTemplateSkill(skillDir, "---\ndescription: review\n---\n{% skill \"./SKILL.md\" %}");

  assert.throws(() => renderTemplateInvocation({ skill, rawArgs: "" }), /Circular template inclusion detected/);
});

test("buildSkillInvocationText omits trailing raw args section when no args are present", () => {
  const skill: TemplateSkill = {
    name: "review",
    description: "review",
    filePath: "/tmp/review/SKILL.template.md",
    baseDir: "/tmp/review",
    hasFallbackSkill: false,
  };

  assert.equal(
    buildSkillInvocationText(skill, "Body", ""),
    [
      '<skill name="review" location="/tmp/review/SKILL.template.md">',
      "References are relative to /tmp/review.",
      "",
      "Body",
      "</skill>",
    ].join("\n"),
  );
});
