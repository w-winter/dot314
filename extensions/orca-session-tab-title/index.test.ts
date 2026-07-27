import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Event = { name?: string };
type Context = {
	ui: {
		notify(message: string, level: "warning"): void;
	};
};
type Handler = (event: Event, ctx: Context) => Promise<void>;

const ORIGINAL_ORCA_PANE_KEY = process.env.ORCA_PANE_KEY;

function createHarness(sessionName: string | undefined) {
	const handlers = new Map<string, Handler>();
	const execCalls: Array<{ command: string; args: string[] }> = [];
	const notifications: string[] = [];
	const pi = {
		on(event: string, handler: Handler): void {
			handlers.set(event, handler);
		},
		getSessionName: () => sessionName,
		exec: async (command: string, args: string[]) => {
			execCalls.push({ command, args });
			if (args[1] === "list") {
				return {
					code: 0,
					stdout: JSON.stringify({
						result: {
							terminals: [
								{ handle: "other-handle", leafId: "other-leaf", tabId: "other-tab" },
								{ handle: "target-handle", leafId: "target-leaf", tabId: "reminted-tab" },
							],
						},
					}),
					stderr: "",
				};
			}
			return { code: 0, stdout: "{}", stderr: "" };
		},
	} as unknown as ExtensionAPI;
	const ctx: Context = {
		ui: {
			notify(message: string): void {
				notifications.push(message);
			},
		},
	};

	return { ctx, execCalls, handlers, notifications, pi };
}

async function loadExtension() {
	process.env.ORCA_PANE_KEY = "stale-tab:target-leaf";
	const moduleUrl = new URL(`./index.ts?test=${Date.now()}`, import.meta.url);
	return (await import(moduleUrl.href)).default as (pi: ExtensionAPI) => void;
}

afterEach(() => {
	if (ORIGINAL_ORCA_PANE_KEY === undefined) {
		delete process.env.ORCA_PANE_KEY;
	} else {
		process.env.ORCA_PANE_KEY = ORIGINAL_ORCA_PANE_KEY;
	}
});

test("session start renames the containing Orca tab after its tab id is reminted", async () => {
	const extension = await loadExtension();
	const harness = createHarness(" active session ");
	extension(harness.pi);

	await harness.handlers.get("session_start")?.({}, harness.ctx);

	assert.deepEqual(harness.execCalls.at(-1), {
		command: "orca",
		args: ["terminal", "rename", "--terminal", "target-handle", "--title", "active session", "--json"],
	});
	assert.deepEqual(harness.notifications, []);
});

test("session name changes rename the tab only when the new name is non-empty", async () => {
	const extension = await loadExtension();
	const harness = createHarness("initial");
	extension(harness.pi);
	const handler = harness.handlers.get("session_info_changed");
	assert.ok(handler);

	await handler({ name: "renamed" }, harness.ctx);
	const callsAfterRename = harness.execCalls.length;
	await handler({ name: "  " }, harness.ctx);

	assert.equal(harness.execCalls.length, callsAfterRename);
	assert.equal(harness.execCalls.at(-1)?.args.includes("renamed"), true);
});
