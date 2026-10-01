// What loading the extension adds to Pi: the provider, its session hooks and
// the /pi-claude commands. It adds no Pi tool, so the tool list Claude gets is
// only the session's own tools.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import claudeBridge from "../src/index.ts";

function load() {
	const pi = {
		tools: [],
		commands: new Map(),
		on: () => {},
		registerCommand: (name, command) => pi.commands.set(name, command),
		registerProvider: () => {},
		registerTool: (tool) => pi.tools.push(tool.name),
		events: { emit: () => {} },
		appendEntry: () => {},
	};
	claudeBridge(pi);
	return pi;
}

describe("loading the extension", () => {
	it("registers no Pi tool", () => {
		assert.deepEqual(load().tools, []);
	});

	it("answers /pi-claude incidents as an unknown argument", async () => {
		const notices = [];
		await load().commands.get("pi-claude").handler("incidents", { ui: { notify: (message, level) => notices.push([message, level]) }, cwd: process.cwd() });
		assert.deepEqual(notices, [["Unknown /pi-claude argument.", "warning"]]);
	});
});
