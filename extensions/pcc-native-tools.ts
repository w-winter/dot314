import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", (event) => {
    const nativeTools = pi.getAllTools()
      .filter((tool) =>
        (tool.name === "codemode" && tool.sourceInfo.path === "builtin:codemode") ||
        (tool.name === "tool_search" && tool.sourceInfo.path === "builtin:tool-search"),
      )
      .map((tool) => tool.name);
    if (nativeTools.length === 0) return;

    // PCC selects exec/wait during input for both Code and Notebook modes.
    const active = pi.getActiveTools();
    const pccActive = active.includes("exec") && active.includes("wait");
    const selectTools = (names: string[]) => {
      const selected = names.filter((name) => !nativeTools.includes(name));
      if (!pccActive) selected.push(...nativeTools);
      return selected;
    };
    const selected = selectTools(active);
    if (selected.length !== active.length || selected.some((name, index) => name !== active[index])) {
      pi.setActiveTools(selected);
    }

    // Pi gives explicit prompt selections precedence over setActiveTools().
    const promptTools = event.systemPromptOptions.selectedTools;
    if (promptTools) event.systemPromptOptions.selectedTools = selectTools(promptTools);
  });
}
