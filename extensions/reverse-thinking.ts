import { supportsXhigh } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const LEVELS = ["off", "minimal", "low", "medium", "high"] as const;
const LEVELS_XHIGH = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

type ThinkingLevel = (typeof LEVELS_XHIGH)[number];

export default function reverseThinkingShortcut(pi: ExtensionAPI) {
  pi.registerShortcut("shift+alt+tab", {
    description: "Cycle thinking level backward",
    handler: (ctx) => {
      const model = ctx.model;
      const levels: ThinkingLevel[] = !model?.reasoning
        ? ["off"]
        : supportsXhigh(model)
          ? [...LEVELS_XHIGH]
          : [...LEVELS];

      const current = pi.getThinkingLevel() as ThinkingLevel;
      const currentIndex = Math.max(0, levels.indexOf(current));
      const previousIndex = (currentIndex - 1 + levels.length) % levels.length;

      pi.setThinkingLevel(levels[previousIndex]);
      ctx.ui.notify(`Thinking: ${levels[previousIndex]}`);
    },
  });
}
