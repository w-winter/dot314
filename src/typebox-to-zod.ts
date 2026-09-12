// TypeBox (JSON Schema) → Zod conversion used by buildMcpServers.
//
// Pi tools declare their parameters as TypeBox objects (i.e. JSON Schema at
// runtime). The Agent SDK's createSdkMcpServer requires Zod — its internal
// `Z0()` detects Zod via the `~standard` marker or `_def`/`_zod` properties
// and silently downgrades unrecognized schemas to
// `{type: "object", properties: {}}`, which leaves the model with no
// parameter info. This module bridges the two so MCP-exposed pi tools retain
// their schemas. If this breaks after an SDK update, check whether `Z0()`
// detection changed or createSdkMcpServer now accepts raw JSON Schema.

import { z } from "zod";

export function jsonSchemaPropertyToZod(prop: Record<string, unknown>): z.ZodTypeAny {
	let base: z.ZodTypeAny;
	if (Array.isArray(prop.enum) && prop.enum.length > 0) base = z.enum(prop.enum as [string, ...string[]]);
	else switch (prop.type) {
		case "string": base = z.string(); break;
		case "number": case "integer": base = z.number(); break;
		case "boolean": base = z.boolean(); break;
		case "array": {
			base = prop.items
				? z.array(jsonSchemaPropertyToZod(prop.items as Record<string, unknown>))
				: z.array(z.unknown());
			const minItems = typeof prop.minItems === "number" ? prop.minItems : undefined;
			if (minItems !== undefined) base = (base as z.ZodArray<z.ZodTypeAny>).min(minItems);
			break;
		}
		case "object": {
			if (prop.properties && typeof prop.properties === "object" && !Array.isArray(prop.properties)) {
				const obj = z.object(jsonSchemaToZodShape(prop));
				// JSON Schema's default is PERMISSIVE (additionalProperties omitted
				// means allowed); zod's default is to silently STRIP unknown keys.
				// Stripping matters here: the MCP handler compares its validated
				// input against the raw streamed tool_use input to claim a call id,
				// so a silently dropped key made the two diverge and the claim fail
				// (stranding the call — see claimToolCall). Only an explicit
				// additionalProperties:false may reject/strip.
				base = prop.additionalProperties === false ? obj.strict() : obj.passthrough();
			} else {
				base = z.record(z.string(), z.unknown());
			}
			break;
		}
		default: base = z.unknown();
	}
	if (typeof prop.description === "string") base = base.describe(prop.description);
	return base;
}

export function jsonSchemaToZodShape(schema: unknown): Record<string, z.ZodTypeAny> {
	const s = schema as Record<string, unknown>;
	if (!s || s.type !== "object" || !s.properties) return {};
	const props = s.properties as Record<string, Record<string, unknown>>;
	const required = new Set(Array.isArray(s.required) ? s.required as string[] : []);
	const shape: Record<string, z.ZodTypeAny> = {};
	for (const [key, prop] of Object.entries(props)) {
		const zodProp = jsonSchemaPropertyToZod(prop);
		shape[key] = required.has(key) ? zodProp : zodProp.optional();
	}
	return shape;
}
