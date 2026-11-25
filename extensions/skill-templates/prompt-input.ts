import { readFileSync } from "node:fs";

import { stripFrontmatter } from "@earendil-works/pi-coding-agent";

import { PromptExpansionWriter } from "../_shared/prompt-expansion.ts";

// ponytail: Pi's prompt parser is private; use its public API when it exposes substitutions with user-text ranges.
interface QuotedArgument { text: string; end: number }

function readQuotedArgument(raw: string, start: number): QuotedArgument | undefined {
  const quote = raw[start];
  let text = "";
  for (let index = start + 1; index < raw.length; index++) {
    const char = raw[index];
    if (char === "\\" && raw[index + 1] === quote) {
      text += quote;
      index++;
    } else if (char === quote) return { text, end: index };
    else text += char;
  }
  return undefined;
}

function parsePromptArgs(raw: string): string[] {
  const args: string[] = [];
  let current = "";
  let hasToken = false;
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index];
    if ((char === '"' || char === "'") && !hasToken) {
      const quoted = readQuotedArgument(raw, index);
      if (quoted) {
        current = quoted.text;
        index = quoted.end;
        hasToken = true;
        continue;
      }
    }
    if (/\s/.test(char)) {
      if (hasToken) args.push(current);
      current = "";
      hasToken = false;
    } else {
      current += char;
      hasToken = true;
    }
  }
  if (hasToken) args.push(current);
  return args;
}

/** Expands Pi's prompt argument syntax and records each substitution, including defaults, as invocation text. */
export function renderPromptTemplate(filePath: string, rawArgs: string): string {
  const content = stripFrontmatter(readFileSync(filePath, "utf8"));
  const args = parsePromptArgs(rawArgs);
  const allArgs = args.join(" ");
  const writer = new PromptExpansionWriter(filePath);
  const placeholders = /\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g;
  const rendered = content.replace(placeholders, (
    _match: string, defaultTarget: string | undefined, defaultValue: string | undefined,
    sliceStart: string | undefined, sliceLength: string | undefined, simple: string | undefined,
  ) => {
    let value: string;
    if (defaultValue !== undefined) {
      const supplied = defaultTarget === "@" || defaultTarget === "ARGUMENTS" ? allArgs : args[Number(defaultTarget) - 1];
      value = supplied || defaultValue;
    } else if (sliceStart !== undefined) {
      const start = Math.max(0, Number(sliceStart) - 1);
      value = args.slice(start, sliceLength === undefined ? undefined : start + Number(sliceLength)).join(" ");
    } else if (simple === "ARGUMENTS" || simple === "@") value = allArgs;
    else value = args[Number(simple) - 1] ?? "";
    return writer.userText(value);
  });
  return writer.serialize(`${rendered}\n\nRaw invocation arguments:\n${writer.userText(rawArgs)}`);
}
