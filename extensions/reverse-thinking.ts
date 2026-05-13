import { getSupportedThinkingLevels, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function reverseThinkingShortcut(pi: ExtensionAPI) {
  pi.registerShortcut("shift+alt+tab", {
    description: "Cycle thinking level backward",
    handler: (ctx) => {
      const model = ctx.model;
      const levels: ModelThinkingLevel[] = model ? getSupportedThinkingLevels(model) : ["off"];

      const current = pi.getThinkingLevel() as ModelThinkingLevel;
      const currentIndex = Math.max(0, levels.indexOf(current));
      const previousIndex = (currentIndex - 1 + levels.length) % levels.length;

      pi.setThinkingLevel(levels[previousIndex]);
      ctx.ui.notify(`Thinking: ${levels[previousIndex]}`);
    },
  });
}
