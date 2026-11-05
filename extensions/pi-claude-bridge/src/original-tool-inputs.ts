import { z } from "zod";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { mapToolArgs } from "./tool-mapping.ts";

const toolInputSchema = z.record(z.string(), z.unknown());
export type OriginalToolInput = z.infer<typeof toolInputSchema>;
export const wireToolInputsSchema = z.record(z.string(), toolInputSchema);
export type WireToolInputs = z.infer<typeof wireToolInputsSchema>;
const sdkWireInputsSchema = z.object({ wire_tool_inputs: wireToolInputsSchema.optional() });

/** Claude Code's ID-keyed API inputs, before its tool-argument normalization. */
export function sdkWireToolInputs(message: SDKMessage): WireToolInputs | undefined {
	return sdkWireInputsSchema.parse(message).wire_tool_inputs;
}

/** A complete streamed JSON object, or absence while its JSON is unfinished. */
function completeToolInput(json: string): OriginalToolInput | undefined {
	let parsed: unknown;
	try { parsed = JSON.parse(json); } catch (error) {
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
	return toolInputSchema.parse(parsed);
}

/** Keep original mapped arguments by ID across completed-message re-yields. */
export function rememberOriginalToolInput(
	originals: Map<string, OriginalToolInput>,
	id: string,
	name: string,
	wire: WireToolInputs | undefined,
	partialJson: string | undefined,
): OriginalToolInput | undefined {
	const input = wire === undefined ? undefined : wire[id];
	if (input !== undefined) originals.set(id, mapToolArgs(name, input));
	else if (!originals.has(id) && partialJson !== undefined) {
		const complete = completeToolInput(partialJson);
		if (complete !== undefined) originals.set(id, mapToolArgs(name, complete));
	}
	return originals.get(id);
}
