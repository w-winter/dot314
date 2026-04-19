import {
  RESERVED_ARGUMENT_KEYS,
  TEMPLATE_REF_VARIABLE,
  type InvocationArgumentValue,
  type ParsedInvocationArgs,
  type TemplateVariableValue,
} from "./types.ts";

const OPTION_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;
const RESERVED_ARGUMENT_KEY_SET = new Set<string>(RESERVED_ARGUMENT_KEYS);

interface InvocationToken {
  value: string;
  quoted: boolean;
}

function tokenizeInvocationArgParts(argsString: string): InvocationToken[] {
  const args: InvocationToken[] = [];
  let current = "";
  let inQuote: string | null = null;
  let tokenQuoted = false;

  for (let index = 0; index < argsString.length; index += 1) {
    const character = argsString[index];

    if (inQuote) {
      if (character === inQuote) {
        inQuote = null;
      } else {
        current += character;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      inQuote = character;
      tokenQuoted = true;
      continue;
    }

    if (character === " " || character === "\t") {
      if (current) {
        args.push({ value: current, quoted: tokenQuoted });
        current = "";
        tokenQuoted = false;
      }
      continue;
    }

    current += character;
  }

  if (current) {
    args.push({ value: current, quoted: tokenQuoted });
  }

  return args;
}

export function tokenizeInvocationArgs(argsString: string): string[] {
  return tokenizeInvocationArgParts(argsString).map((token) => token.value);
}

export function normalizeOptionKey(key: string): string {
  return key.replaceAll("-", "_");
}

function validateRawOptionKey(key: string): void {
  if (!OPTION_KEY_PATTERN.test(key)) {
    throw new Error(`Invalid option key "${key}"`);
  }
}

function validateReservedKey(key: string): void {
  if (RESERVED_ARGUMENT_KEY_SET.has(key)) {
    throw new Error(`Option key "${key}" is reserved`);
  }
}

function setNamedArgument(
  named: Record<string, InvocationArgumentValue>,
  vars: Record<string, TemplateVariableValue>,
  key: string,
  value: InvocationArgumentValue,
): void {
  validateRawOptionKey(key);
  validateReservedKey(key);

  if (Object.hasOwn(named, key)) {
    throw new Error(`Duplicate option key "${key}"`);
  }

  const normalizedKey = normalizeOptionKey(key);
  if (normalizedKey === TEMPLATE_REF_VARIABLE) {
    throw new Error(`Option key "${key}" is reserved`);
  }
  validateReservedKey(normalizedKey);

  if (Object.hasOwn(vars, normalizedKey)) {
    throw new Error(`Duplicate normalized option key "${normalizedKey}"`);
  }

  named[key] = value;
  vars[normalizedKey] = value;
}

export function parseInvocationArgs(rawArgs: string): ParsedInvocationArgs {
  const raw = rawArgs.trim();
  const tokens = tokenizeInvocationArgParts(raw);
  const positionalArgs: string[] = [];
  const named: Record<string, InvocationArgumentValue> = {};
  const vars: Record<string, TemplateVariableValue> = {};

  let parsingOptions = true;
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index];

    if (parsingOptions && !token.quoted && token.value === "--") {
      parsingOptions = false;
      index += 1;
      continue;
    }

    if (parsingOptions && !token.quoted && token.value.startsWith("--") && token.value.length > 2) {
      const optionBody = token.value.slice(2);
      const equalsIndex = optionBody.indexOf("=");

      if (equalsIndex >= 0) {
        const key = optionBody.slice(0, equalsIndex);
        const value = optionBody.slice(equalsIndex + 1);
        setNamedArgument(named, vars, key, value);
        index += 1;
        continue;
      }

      const key = optionBody;
      const nextToken = tokens[index + 1];
      const hasValue = nextToken !== undefined && (nextToken.quoted || (nextToken.value !== "--" && !nextToken.value.startsWith("--")));

      if (hasValue) {
        setNamedArgument(named, vars, key, nextToken.value);
        index += 2;
        continue;
      }

      setNamedArgument(named, vars, key, true);
      index += 1;
      continue;
    }

    positionalArgs.push(token.value);
    index += 1;
  }

  return {
    raw,
    args: positionalArgs,
    named,
    vars,
  };
}
