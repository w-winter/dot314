import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveGetModels } from "../src/pi-ai-compat.js";

describe("pi-ai model catalog compatibility", () => {
	it("prefers the legacy root export without loading compat", async () => {
		const rootGetModels = () => ["root"];
		const resolved = await resolveGetModels({ getModels: rootGetModels }, async () => {
			throw new Error("compat should not load");
		});
		assert.equal(resolved, rootGetModels);
	});

	it("falls back to the compat entrypoint", async () => {
		const compatGetModels = () => ["compat"];
		const resolved = await resolveGetModels({}, async () => ({ getModels: compatGetModels }));
		assert.equal(resolved, compatGetModels);
	});
});