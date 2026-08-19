import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

import {
  renderAdaptiveDiffBlockLines,
  type AdaptiveDiffRenderConfig,
} from "./diff-renderer.js";

interface AdaptiveDiffComponentOptions {
  successPrefix: string;
  diffConfig: AdaptiveDiffRenderConfig;
}

export function createAdaptiveDiffComponent(
  diffText: string,
  theme: Theme,
  options: AdaptiveDiffComponentOptions,
): Component {
  const cache = new Map<number, string[]>();

  return {
    render(width: number): string[] {
      const safeWidth = Math.max(1, Math.floor(Number.isFinite(width) ? width : 0));
      const cached = cache.get(safeWidth);
      if (cached) {
        return cached;
      }

      const prefixWidth = visibleWidth(options.successPrefix);
      const bodyWidth = Math.max(1, safeWidth - prefixWidth);
      const body = renderAdaptiveDiffBlockLines(diffText, bodyWidth, theme, options.diffConfig);
      const rendered = body.length === 0
        ? [truncateToWidth(options.successPrefix.trimEnd(), safeWidth, "")]
        : body.map((line, index) => truncateToWidth(
            index === 0 ? `${options.successPrefix}${line}` : line,
            safeWidth,
            "",
          ));
      cache.set(safeWidth, rendered);
      return rendered;
    },
    invalidate(): void {
      cache.clear();
    },
    handleInput(): void {},
  };
}
