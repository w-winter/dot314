import assert from "node:assert/strict";
import test from "node:test";

import type {
  EntryRenderer,
  ExtensionAPI,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { ApplyPatchDisplayData } from "@howaboua/pi-codex-conversion/apply-patch-display";

import applyPatchDisplay from "./index.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  strikethrough: (text: string) => text,
} as Theme;

test("extension registers an adaptive apply_patch entry renderer", () => {
  let renderer: EntryRenderer<ApplyPatchDisplayData> | undefined;
  const pi = {
    registerEntryRenderer(_customType: string, entryRenderer: EntryRenderer<ApplyPatchDisplayData>) {
      renderer = entryRenderer;
    },
    events: {
      on() {
        return () => {};
      },
      emit() {},
    },
    on() {},
  } as unknown as ExtensionAPI;

  applyPatchDisplay(pi);
  assert.ok(renderer);

  const data: ApplyPatchDisplayData = {
    toolCallId: "patch-1",
    input: "*** Begin Patch\n*** Update File: src/example.ts\n@@\n-const enabled = false;\n"
      + "+const enabled = true;\n*** Update File: src/other.ts\n@@\n-const count = 1;\n"
      + "+const count = 2;\n*** End Patch",
    isError: false,
    source: "direct",
  };
  const entry = { data } as Parameters<typeof renderer>[0];
  const component = renderer(entry, { expanded: false }, theme);
  const lines = component?.render(120) ?? [];

  assert.ok(lines.some((line) => line.includes("enabled") && line.includes("false")));
  assert.ok(lines.some((line) => line.includes("enabled") && line.includes("true")));
  assert.ok(lines.some((line) => line.includes("other.ts")));
  assert.ok(lines.includes(""));
});
