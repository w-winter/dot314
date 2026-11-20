import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initTheme, SessionManager, TreeSelectorComponent } from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";

import anycopyExtension from "../index.ts";

test("Anycopy renders without mutating the native selector's output", async (t) => {
	const cwd = join(tmpdir(), `anycopy-render-${randomUUID()}`);
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = cwd;
	t.after(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	});
	initTheme("dark", false);
	const sessionManager = SessionManager.inMemory(cwd);
	sessionManager.appendMessage({ role: "user", content: "Render this session message", timestamp: 1 });
	const commands = new Map();
	anycopyExtension({
		registerCommand: (name, command) => commands.set(name, command),
		registerShortcut() {},
	});
	const command = commands.get("anycopy");
	assert.ok(command);

	const render = TreeSelectorComponent.prototype.render;
	t.mock.method(TreeSelectorComponent.prototype, "render", function (width) {
		return Object.freeze(render.call(this, width));
	});
	await command.handler("", {
		cwd,
		hasUI: true,
		sessionManager,
		ui: {
			custom: async (factory) => {
				const overlay = factory(
					{ terminal: { rows: 40 }, requestRender() {} },
					{ fg: (_color, text) => text, bold: (text) => text },
					getKeybindings(),
					() => {},
				);
				try {
					const lines = overlay.render(100);
					assert.ok(lines.some((line) => line.includes("Render this session message")));
					assert.deepEqual(overlay.render(100), lines);
				} finally {
					overlay.dispose();
				}
			},
		},
	});
});
