// Test extension: `extra_echo` starts inactive, and `enable_extra` activates it
// from inside its own tool call via pi.setActiveTools — the same shape as
// subagents_enable / pi-web-access's web_enable.
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "enable_extra",
		label: "Enable extra tools",
		description: "Enables the extra_echo tool. It becomes available right after this call returns.",
		parameters: Type.Object({}),
		async execute() {
			const active = pi.getActiveTools();
			if (!active.includes("extra_echo")) pi.setActiveTools([...active, "extra_echo"]);
			return { content: [{ type: "text" as const, text: "Enabled." }], details: {} };
		},
	});
	pi.registerTool({
		name: "extra_echo",
		label: "Echo",
		description: "Echoes the given text back, prefixed with ECHO:.",
		parameters: Type.Object({ text: Type.String({ description: "Text to echo" }) }),
		async execute(_id, params) {
			return { content: [{ type: "text" as const, text: `ECHO: ${params.text}` }], details: {} };
		},
	});
	pi.on("session_start", () => {
		pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "extra_echo"));
	});
}
