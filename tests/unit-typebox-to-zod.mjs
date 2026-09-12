import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { jsonSchemaToZodShape } from "../src/typebox-to-zod.ts";

const schemaForShape = (shape) => z.toJSONSchema(z.object(shape));

describe("jsonSchemaToZodShape", () => {
	it("preserves nested object schemas inside arrays", () => {
		const shape = jsonSchemaToZodShape({
			type: "object",
			additionalProperties: false,
			properties: {
				questions: {
					type: "array",
					minItems: 1,
					items: {
						type: "object",
						additionalProperties: false,
						properties: {
							header: { type: "string", description: "Tab/category title." },
							question: { type: "string" },
							options: {
								type: "array",
								minItems: 1,
								items: {
									type: "object",
									additionalProperties: false,
									properties: {
										label: { type: "string" },
										description: { type: "string" },
									},
									required: ["label"],
								},
							},
						},
						required: ["header", "question", "options"],
					},
				},
			},
			required: ["questions"],
		});

		const json = schemaForShape(shape);
		assert.equal(json.properties.questions.type, "array");
		assert.equal(json.properties.questions.minItems, 1);
		assert.equal(json.properties.questions.items.type, "object");
		assert.deepEqual(json.properties.questions.items.required, ["header", "question", "options"]);
		assert.equal(json.properties.questions.items.additionalProperties, false);
		assert.equal(json.properties.questions.items.properties.options.type, "array");
		assert.equal(json.properties.questions.items.properties.options.items.type, "object");
		assert.deepEqual(json.properties.questions.items.properties.options.items.required, ["label"]);
		assert.equal(json.properties.questions.items.properties.options.items.additionalProperties, false);
	});

	it("keeps optional nested fields optional", () => {
		const shape = jsonSchemaToZodShape({
			type: "object",
			properties: {
				item: {
					type: "object",
					properties: {
						requiredName: { type: "string" },
						optionalNote: { type: "string" },
					},
					required: ["requiredName"],
				},
			},
			required: ["item"],
		});

		const json = schemaForShape(shape);
		assert.deepEqual(json.properties.item.required, ["requiredName"]);
		assert.ok(json.properties.item.properties.optionalNote);
	});

	it("keeps unknown keys on objects without additionalProperties:false (JSON Schema default)", () => {
		// zod's default is to silently STRIP unknown keys; JSON Schema's default is
		// to allow them. Stripping made the handler's validated input diverge from
		// the raw streamed tool_use input, which broke tool-call id claiming.
		const shape = jsonSchemaToZodShape({
			type: "object",
			properties: {
				edits: {
					type: "array",
					items: { type: "object", properties: { oldText: { type: "string" } }, required: ["oldText"] },
				},
			},
			required: ["edits"],
		});

		const parsed = z.object(shape).parse({ edits: [{ oldText: "a", stray: 1 }] });
		assert.equal(parsed.edits[0].stray, 1, "unknown nested key must survive validation");
	});

	it("still rejects unknown keys when additionalProperties is explicitly false", () => {
		const shape = jsonSchemaToZodShape({
			type: "object",
			properties: {
				item: {
					type: "object",
					additionalProperties: false,
					properties: { name: { type: "string" } },
					required: ["name"],
				},
			},
			required: ["item"],
		});

		assert.throws(() => z.object(shape).parse({ item: { name: "a", stray: 1 } }));
	});
});
