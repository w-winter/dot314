import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { constants as osConstants } from "node:os";

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import { getPiSpawnCommand, type PiSpawnDeps } from "../_shared/pi-spawn.ts";
import type { SessionPickerResult } from "./picker.ts";

export type StartupAction =
	| { kind: "noop" }
	| { kind: "shutdown" }
	| { kind: "exit"; code: number; message?: string }
	| { kind: "relaunch"; command: string; args: string[]; cwd: string };

const SESSION_FLAG = "--session";
const CONSUMED_BOOL_FLAGS = new Set(["--switch-session", "--resume", "-r", "--continue", "-c", "--no-session"]);
const CONSUMED_VALUE_FLAGS = new Set(["--session", "--fork"]);

export function buildStartupRelaunchArgs(argvTokens: string[], sessionPath: string): string[] {
	const preserved: string[] = [];

	for (let index = 0; index < argvTokens.length; index += 1) {
		const token = argvTokens[index];
		if (CONSUMED_BOOL_FLAGS.has(token)) {
			continue;
		}
		if (CONSUMED_VALUE_FLAGS.has(token)) {
			index += 1;
			continue;
		}
		preserved.push(token);
	}

	return [...preserved, SESSION_FLAG, sessionPath];
}

function readRecordedSessionCwd(
	sessionPath: string,
	readFile: (path: string, encoding: "utf8") => string,
): string | undefined {
	const firstLine = readFile(sessionPath, "utf8").split("\n", 1)[0];
	if (!firstLine) {
		return undefined;
	}

	const header = JSON.parse(firstLine) as { type?: string; cwd?: unknown };
	return header.type === "session" && typeof header.cwd === "string" && header.cwd.trim() ? header.cwd : undefined;
}

export function resolveStartupSessionTarget(
	sessionPath: string,
	deps: {
		readFile?: typeof readFileSync;
		exists?: typeof existsSync;
		stat?: typeof statSync;
	} = {},
): { cwd: string } | { warning: string } {
	const readFile = deps.readFile ?? readFileSync;
	const pathExists = deps.exists ?? existsSync;
	const pathStat = deps.stat ?? statSync;

	try {
		const sessionCwd = readRecordedSessionCwd(sessionPath, readFile);
		if (!sessionCwd) {
			return {
				warning: "Selected session does not have a recorded cwd. Use `/switch-session` or native `pi --resume` instead.",
			};
		}
		if (!pathExists(sessionCwd) || !pathStat(sessionCwd).isDirectory()) {
			return {
				warning:
					`Selected session cwd no longer exists: ${sessionCwd}. ` +
					"`pi --switch-session` cannot recover missing cwd state because startup switching is implemented as a relaunch. " +
					"Use `/switch-session` or native `pi --resume` instead.",
			};
		}
		return { cwd: sessionCwd };
	} catch (error) {
		return {
			warning: `Failed to inspect selected session: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

export function resolveStartupAction(
	result: SessionPickerResult,
	options: {
		cwd: string;
		argvTokens?: string[];
		spawnDeps?: PiSpawnDeps;
	},
): StartupAction {
	if (result.kind === "dismissed") {
		return result.reason === "exit"
			? { kind: "shutdown" }
			: { kind: "exit", code: 0, message: "No session selected" };
	}

	const args = buildStartupRelaunchArgs(options.argvTokens ?? process.argv.slice(2), result.sessionPath);
	const command = getPiSpawnCommand(args, options.spawnDeps);
	return {
		kind: "relaunch",
		command: command.command,
		args: command.args,
		cwd: options.cwd,
	};
}

function teardownTerminalForExit(): void {
	process.stdout.write("\x1b[<u");
	process.stdout.write("\x1b[?2004l");
	process.stdout.write("\x1b[?25h");
	process.stdout.write("\r\n");

	if (process.stdin.isTTY && process.stdin.setRawMode) {
		process.stdin.setRawMode(false);
	}
}

export function executeStartupAction(
	ctx: Pick<ExtensionContext, "shutdown">,
	action: StartupAction,
): void {
	if (action.kind === "noop") {
		return;
	}
	if (action.kind === "shutdown") {
		ctx.shutdown();
		return;
	}
	if (action.kind === "exit") {
		teardownTerminalForExit();
		if (action.message) {
			process.stdout.write(`${action.message}\n`);
		}
		process.exit(action.code);
	}

	teardownTerminalForExit();

	const result = spawnSync(action.command, action.args, {
		cwd: action.cwd,
		stdio: "inherit",
	});

	if (result.error) {
		process.stderr.write(`Failed to launch pi: ${result.error.message}\n`);
		process.exit(1);
	}

	if (result.signal) {
		const signalNumber = osConstants.signals[result.signal as keyof typeof osConstants.signals];
		process.exit(typeof signalNumber === "number" ? 128 + signalNumber : 1);
	}

	process.exit(result.status ?? 0);
}
