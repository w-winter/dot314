// Test extension: a tool shaped like a pi-mcp-adapter direct tool. Its name
// has a slash and a space (Claude Code rewrites both), and its parameters are
// a raw MCP JSON Schema with $defs/$ref and oneOf, which Pi validates itself.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PARAMETERS = {
	type: "object",
	$defs: {
		Point: {
			type: "object",
			properties: { x: { type: "integer" }, y: { type: "integer" } },
			required: ["x", "y"],
			additionalProperties: false,
		},
	},
	properties: {
		at: { $ref: "#/$defs/Point", description: "Where to plot" },
		shape: {
			description: "What to plot",
			oneOf: [
				{ type: "object", properties: { kind: { const: "circle" }, r: { type: "number", minimum: 0 } }, required: ["kind", "r"], additionalProperties: false },
				{ type: "object", properties: { kind: { const: "square" }, side: { type: "number", minimum: 0 } }, required: ["kind", "side"], additionalProperties: false },
			],
		},
		label: { type: ["string", "null"], description: "Optional label, or null" },
	},
	required: ["at", "shape"],
};

interface Point { x: number; y: number }
type Shape = { kind: "circle"; r: number } | { kind: "square"; side: number };

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "plot/point tool",
		label: "Plot",
		description: "Plots a shape at a point and returns a confirmation line.",
		parameters: PARAMETERS as never,
		async execute(_id, params: { at: Point; shape: Shape; label?: string | null }) {
			const size = params.shape.kind === "circle" ? `r=${params.shape.r}` : `side=${params.shape.side}`;
			return {
				content: [{ type: "text" as const, text: `PLOTTED ${params.shape.kind} ${size} at ${params.at.x},${params.at.y}` }],
				details: {},
			};
		},
	});
}
