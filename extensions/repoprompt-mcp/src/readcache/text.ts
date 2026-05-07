// readcache/text.ts - line helpers + truncation

import { truncateHead, type TruncationOptions, type TruncationResult } from "@earendil-works/pi-coding-agent";

function validateRange(start: number, end: number): void {
  if (!Number.isInteger(start) || start <= 0) {
    throw new Error(`Invalid start line "${start}". Line numbers must be positive integers.`);
  }
  if (!Number.isInteger(end) || end <= 0) {
    throw new Error(`Invalid end line "${end}". Line numbers must be positive integers.`);
  }
  if (end < start) {
    throw new Error(`Invalid range ${start}-${end}. End line must be greater than or equal to start line.`);
  }
}

export function splitLines(text: string): string[] {
  // Match typical editor line counting semantics: a trailing newline does not create an extra empty line
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") {
    return lines.slice(0, -1);
  }
  return lines;
}

export function sliceByLineRange(text: string, start: number, end: number): string {
  validateRange(start, end);
  const lines = splitLines(text);
  if (start > lines.length) {
    return "";
  }

  const clampedEnd = Math.min(end, lines.length);
  return lines.slice(start - 1, clampedEnd).join("\n");
}

export function compareSlices(oldText: string, newText: string, start: number, end: number): boolean {
  return sliceByLineRange(oldText, start, end) === sliceByLineRange(newText, start, end);
}

export function estimateTokens(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  return Math.ceil(Buffer.byteLength(text, "utf-8") / 4);
}

export function truncateForReadcache(content: string, options?: TruncationOptions): TruncationResult {
  return truncateHead(content, options);
}
