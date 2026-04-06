import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";

import type { SessionPickerResult } from "./picker.ts";
import { openSessionSwitchPicker } from "./picker.ts";
import { executeStartupAction, resolveStartupAction, resolveStartupSessionTarget } from "./relaunch.ts";

export function resolveCommandPickerAction(
	result: SessionPickerResult,
): { kind: "noop" | "shutdown" } | { kind: "switch"; sessionPath: string } {
	if (result.kind === "dismissed") {
		return result.reason === "exit" ? { kind: "shutdown" } : { kind: "noop" };
	}

	return { kind: "switch", sessionPath: result.sessionPath };
}

async function runSessionSwitchCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const result = await openSessionSwitchPicker(pi, ctx);
	const action = resolveCommandPickerAction(result);
	if (action.kind === "noop") {
		return;
	}
	if (action.kind === "shutdown") {
		ctx.shutdown();
		return;
	}

	const switchResult = await ctx.switchSession(action.sessionPath);
	if (switchResult.cancelled) {
		ctx.ui.notify("Session switch cancelled", "info");
	}
}

async function runSessionSwitchStartup(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const result = await openSessionSwitchPicker(pi, ctx);
	if (result.kind === "selected") {
		const target = resolveStartupSessionTarget(result.sessionPath);
		if ("warning" in target) {
			ctx.ui.notify(target.warning, "warning");
			return;
		}

		const action = resolveStartupAction(result, { cwd: target.cwd });
		executeStartupAction(ctx, action);
		return;
	}

	const action = resolveStartupAction(result, { cwd: ctx.cwd });
	executeStartupAction(ctx, action);
}

export default function sessionSwitchExtension(pi: ExtensionAPI) {
	pi.registerFlag("switch-session", {
		description: "Open the session-switch picker after startup, then relaunch into the selected session",
		type: "boolean",
		default: false,
	});

	pi.on("session_start", async (event, ctx) => {
		if (event.reason !== "startup" || !ctx.hasUI || pi.getFlag("switch-session") !== true) {
			return;
		}

		await runSessionSwitchStartup(pi, ctx);
	});

	pi.registerCommand("switch-session", {
		description: "Session picker (mirrors /resume) with live preview",
		handler: async (_args, ctx) => {
			await runSessionSwitchCommand(pi, ctx);
		},
	});
}
