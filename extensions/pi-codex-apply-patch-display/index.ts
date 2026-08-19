import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";
import {
  registerApplyPatchDisplay,
  type ApplyPatchDisplayData,
} from "@howaboua/pi-codex-conversion/apply-patch-display";

import { createAdaptiveDiffComponent } from "./adaptive-diff-component.js";
import { loadApplyPatchDiffConfig } from "./config.js";
import { applyPatchInputToFileDiffs } from "./patch-diff.js";

const ENTRY_TYPE = "pi-codex-apply-patch-diff";

function renderError(data: ApplyPatchDisplayData, theme: Theme): Text | undefined {
  const error = data.error ?? (data.isError ? data.content : undefined);
  return error ? new Text(theme.fg("error", error), 0, 0) : undefined;
}

function createResultBox(data: ApplyPatchDisplayData, theme: Theme): Box {
  const background = data.isError ? "toolErrorBg" : "toolSuccessBg";
  return new Box(1, 1, (text) => theme.bg(background, text));
}

export default function applyPatchDisplay(pi: ExtensionAPI): void {
  const config = loadApplyPatchDiffConfig();

  registerApplyPatchDisplay(pi, {
    customType: ENTRY_TYPE,
    render(entry, _options, theme) {
      const data = entry.data;
      const boxes = new Container();
      const error = renderError(data, theme);

      try {
        const fileDiffs = applyPatchInputToFileDiffs(data.input);
        for (const [index, diffText] of fileDiffs.entries()) {
          if (index > 0) {
            boxes.addChild(new Spacer(1));
          }

          const content = new Container();
          if (index === 0 && error) {
            content.addChild(error);
          }
          content.addChild(createAdaptiveDiffComponent(diffText, theme, {
            successPrefix: data.isError ? "" : theme.fg("success", "↳ "),
            diffConfig: {
              diffViewMode: config.diffViewMode,
              diffSplitMinWidth: config.diffSplitMinWidth,
            },
          }));

          const box = createResultBox(data, theme);
          box.addChild(content);
          boxes.addChild(box);
        }
      } catch (displayError) {
        const box = createResultBox(data, theme);
        box.addChild(error ?? new Text(
          theme.fg("error", displayError instanceof Error ? displayError.message : String(displayError)),
          0,
          0,
        ));
        boxes.addChild(box);
      }

      return boxes;
    },
  });
}
