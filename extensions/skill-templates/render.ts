import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { stripFrontmatter } from "@mariozechner/pi-coding-agent";
import nunjucks from "nunjucks";

import { parseInvocationArgs } from "./args.ts";
import {
  FALLBACK_SKILL_FILE,
  TEMPLATE_REF_VARIABLE,
  TEMPLATE_SKILL_FILE,
  type ParsedInvocationArgs,
  type TemplateRef,
  type TemplateSkill,
} from "./types.ts";

const TEMPLATE_REF_SENTINEL = "::pi-skill-templates::";

function expandHomePath(input: string): string {
  if (input === "~") {
    return homedir();
  }
  if (input.startsWith("~/")) {
    return join(homedir(), input.slice(2));
  }
  if (input.startsWith("~")) {
    return join(homedir(), input.slice(1));
  }
  return input;
}

function resolveInputPath(input: string, baseDir: string): string {
  const expanded = expandHomePath(input);
  return isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
}

function canonicalizePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function buildRefAssignment(encodedRef: string): string {
  return `{% set ${TEMPLATE_REF_VARIABLE} = ${JSON.stringify(encodedRef)} %}`;
}

function throwCycleError(chain: string[]): never {
  throw new Error(`Circular template inclusion detected: ${chain.join(" -> ")}`);
}

function isEncodedTemplateRef(value: string): boolean {
  return value.includes(TEMPLATE_REF_SENTINEL);
}

function isAbsoluteLike(value: string): boolean {
  return isAbsolute(value) || value === "~" || value.startsWith("~/");
}

export function encodeTemplateRef(ref: TemplateRef): string {
  const payload = Buffer.from(JSON.stringify({ ancestry: ref.ancestry }), "utf8").toString("base64url");
  return `${ref.filePath}${TEMPLATE_REF_SENTINEL}${payload}`;
}

export function decodeTemplateRef(value: string): TemplateRef {
  const sentinelIndex = value.lastIndexOf(TEMPLATE_REF_SENTINEL);
  if (sentinelIndex === -1) {
    throw new Error(`Invalid template reference: ${value}`);
  }

  const filePath = value.slice(0, sentinelIndex);
  const payload = value.slice(sentinelIndex + TEMPLATE_REF_SENTINEL.length);
  const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { ancestry?: unknown };

  if (!Array.isArray(parsed.ancestry) || parsed.ancestry.some((entry) => typeof entry !== "string")) {
    throw new Error(`Invalid template ancestry for ${filePath}`);
  }

  return {
    filePath,
    ancestry: parsed.ancestry,
  };
}

export function resolveTemplateRef(from: TemplateRef, requested: string): TemplateRef {
  const resolvedPath = canonicalizePath(resolveInputPath(requested, dirname(from.filePath)));
  if (from.ancestry.includes(resolvedPath)) {
    throwCycleError([...from.ancestry, resolvedPath]);
  }

  return {
    filePath: resolvedPath,
    ancestry: [...from.ancestry, resolvedPath],
  };
}

export function resolveSkillTargetPath(fromFilePath: string, requested: string): string {
  const resolvedTarget = resolveInputPath(requested, dirname(fromFilePath));

  if (existsSync(resolvedTarget)) {
    const stats = statSync(resolvedTarget);
    if (stats.isDirectory()) {
      const nestedSkill = join(resolvedTarget, FALLBACK_SKILL_FILE);
      if (existsSync(nestedSkill)) {
        return canonicalizePath(nestedSkill);
      }
      throw new Error(`Missing SKILL.md in directory include target: ${requested}`);
    }

    if (stats.isFile()) {
      if (basename(resolvedTarget) === FALLBACK_SKILL_FILE) {
        return canonicalizePath(resolvedTarget);
      }
      throw new Error(`{% skill %} target must be a directory or SKILL.md: ${requested}`);
    }
  }

  const nestedSkill = join(resolvedTarget, FALLBACK_SKILL_FILE);
  if (existsSync(nestedSkill)) {
    return canonicalizePath(nestedSkill);
  }

  throw new Error(`Skill include target not found: ${requested}`);
}

function createNunjucksEnvironment(): any {
  let environment: any;

  const LoaderBase = (nunjucks as any).Loader.extend({
    isRelative(name: string): boolean {
      return !isEncodedTemplateRef(name) && !isAbsoluteLike(name);
    },

    resolve(fromEncoded: string, toRaw: string): string {
      const currentRef = decodeTemplateRef(fromEncoded);
      return encodeTemplateRef(resolveTemplateRef(currentRef, toRaw));
    },

    getSource(encodedName: string): { src: string; path: string; noCache: true } {
      const templateRef = decodeTemplateRef(encodedName);
      const rawContent = readFileSync(templateRef.filePath, "utf8");
      const source = basename(templateRef.filePath) === TEMPLATE_SKILL_FILE ? stripFrontmatter(rawContent) : rawContent;
      return {
        src: `${buildRefAssignment(encodedName)}${source}`,
        path: encodedName,
        noCache: true,
      };
    },
  });

  const loader = new LoaderBase();
  environment = new (nunjucks as any).Environment(loader, { autoescape: false });

  class SkillTagExtension {
    tags = ["skill"];

    parse(parser: any, nodes: any): any {
      const token = parser.nextToken();
      const args = parser.parseSignature(null, true);
      parser.advanceAfterBlockEnd(token.value);
      return new nodes.CallExtension(this, "run", args);
    }

    run(context: any, requestedPath: unknown): any {
      if (typeof requestedPath !== "string") {
        throw new Error("{% skill %} expects a string path argument");
      }

      const currentEncodedRef = context?.ctx?.[TEMPLATE_REF_VARIABLE];
      if (typeof currentEncodedRef !== "string") {
        throw new Error("Missing current template reference in {% skill %} tag");
      }

      const currentRef = decodeTemplateRef(currentEncodedRef);
      const targetPath = resolveSkillTargetPath(currentRef.filePath, requestedPath);
      if (currentRef.ancestry.includes(targetPath)) {
        throwCycleError([...currentRef.ancestry, targetPath]);
      }

      const nextRef: TemplateRef = {
        filePath: targetPath,
        ancestry: [...currentRef.ancestry, targetPath],
      };
      const encodedTargetRef = encodeTemplateRef(nextRef);
      const rawContent = readFileSync(targetPath, "utf8");
      const templateSource = `${buildRefAssignment(encodedTargetRef)}${stripFrontmatter(rawContent)}`;
      const nestedTemplate = new (nunjucks as any).Template(templateSource, environment, encodedTargetRef, true);
      const rendered = nestedTemplate.render(context.ctx);

      return new (nunjucks as any).runtime.SafeString(rendered);
    }
  }

  environment.addExtension("pi-skill-templates-skill-tag", new SkillTagExtension());
  return environment;
}

export function buildSkillInvocationText(skill: TemplateSkill, renderedBody: string, rawArgs: string): string {
  const trimmedBody = renderedBody.trim();
  const lines = [
    `<skill name="${escapeXml(skill.name)}" location="${escapeXml(skill.filePath)}">`,
    `References are relative to ${escapeXml(skill.baseDir)}.`,
    "",
    trimmedBody,
    "</skill>",
  ];

  if (rawArgs.trim()) {
    lines.push("", rawArgs.trim());
  }

  return lines.join("\n");
}

function buildRenderContext(skill: TemplateSkill, parsedArgs: ParsedInvocationArgs): Record<string, unknown> {
  return {
    args: parsedArgs.args,
    all_args: parsedArgs.raw,
    skill_name: skill.name,
    named: parsedArgs.named,
    ...parsedArgs.vars,
  };
}

export function renderTemplateInvocation(input: {
  skill: TemplateSkill;
  rawArgs: string;
}): {
  parsedArgs: ParsedInvocationArgs;
  renderedBody: string;
  invocationText: string;
} {
  const parsedArgs = parseInvocationArgs(input.rawArgs);
  const canonicalSkill: TemplateSkill = {
    ...input.skill,
    filePath: canonicalizePath(input.skill.filePath),
    baseDir: canonicalizePath(input.skill.baseDir),
  };
  const environment = createNunjucksEnvironment();
  const rootRef: TemplateRef = {
    filePath: canonicalSkill.filePath,
    ancestry: [canonicalSkill.filePath],
  };
  const renderedBody = environment.render(encodeTemplateRef(rootRef), buildRenderContext(canonicalSkill, parsedArgs)).trim();

  return {
    parsedArgs,
    renderedBody,
    invocationText: buildSkillInvocationText(canonicalSkill, renderedBody, parsedArgs.raw),
  };
}
