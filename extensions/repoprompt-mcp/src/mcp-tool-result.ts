import type { McpContent, McpToolResult } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMcpContent(content: unknown): content is McpContent {
  if (!isRecord(content) || typeof content.type !== "string") {
    return false;
  }
  if (content.type === "text") {
    return typeof content.text === "string";
  }
  if (content.type === "image") {
    return typeof content.data === "string" && typeof content.mimeType === "string";
  }
  if (content.type !== "resource" || !isRecord(content.resource)) {
    return false;
  }
  if (typeof content.resource.uri !== "string") {
    return false;
  }
  const hasText = typeof content.resource.text === "string";
  const hasBlob = typeof content.resource.blob === "string";
  if (!hasText && !hasBlob) {
    return false;
  }
  if ("text" in content.resource && !hasText) {
    return false;
  }
  if ("blob" in content.resource && !hasBlob) {
    return false;
  }
  return !("mimeType" in content.resource) || typeof content.resource.mimeType === "string";
}

function hasValidContentEntries(content: unknown[]): boolean {
  for (let index = 0; index < content.length; index += 1) {
    if (!(index in content) || !isMcpContent(content[index])) {
      return false;
    }
  }
  return true;
}

export function assertMcpToolResult(result: unknown, invalidResultMessage: string): asserts result is McpToolResult {
  if (
    !isRecord(result) ||
    !Array.isArray(result.content) ||
    !hasValidContentEntries(result.content) ||
    (
      "isError" in result &&
      typeof result.isError !== "boolean" &&
      result.isError !== undefined
    )
  ) {
    throw new Error(invalidResultMessage);
  }
}
