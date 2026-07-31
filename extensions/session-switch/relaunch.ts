import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { constants as osConstants } from "node:os";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

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
const FIRST_LINE_CHUNK_SIZE = 4 * 1024;
const MAX_FIRST_LINE_BYTES = 1024 * 1024;

export interface BoundedFirstLineReaderDependencies {
	open: (filePath: string, flags: "r") => number;
	read: (fileDescriptor: number, buffer: Buffer, offset: number, length: number, position: null) => number;
	close: (fileDescriptor: number) => void;
}

export function readBoundedFirstLine(
	filePath: string,
	dependencies: Partial<BoundedFirstLineReaderDependencies> = {},
): string {
	const openFile = dependencies.open ?? openSync;
	const readFile = dependencies.read ?? readSync;
	const closeFile = dependencies.close ?? closeSync;
	const fileDescriptor = openFile(filePath, "r");
	const chunks: Buffer[] = [];
	let retainedBytes = 0;

	try {
		while (retainedBytes < MAX_FIRST_LINE_BYTES) {
			const readSize = Math.min(FIRST_LINE_CHUNK_SIZE, MAX_FIRST_LINE_BYTES - retainedBytes);
			const buffer = Buffer.allocUnsafe(readSize);
			const bytesRead = readFile(fileDescriptor, buffer, 0, readSize, null);
			if (bytesRead === 0) return Buffer.concat(chunks, retainedBytes).toString("utf8");
			const newlineIndex = buffer.subarray(0, bytesRead).indexOf(0x0a);
			if (newlineIndex !== -1) {
				chunks.push(buffer.subarray(0, newlineIndex));
				return Buffer.concat(chunks, retainedBytes + newlineIndex).toString("utf8");
			}
			chunks.push(buffer.subarray(0, bytesRead));
			retainedBytes += bytesRead;
		}

		const probe = Buffer.allocUnsafe(1);
		const probeBytes = readFile(fileDescriptor, probe, 0, 1, null);
		if (probeBytes > 0 && probe[0] !== 0x0a) {
			throw new Error(`Session header exceeds ${MAX_FIRST_LINE_BYTES} bytes`);
		}
		return Buffer.concat(chunks, retainedBytes).toString("utf8");
	} finally {
		closeFile(fileDescriptor);
	}
}

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
	readFirstLine: (path: string) => string,
): string | undefined {
	const firstLine = readFirstLine(sessionPath);
	if (!firstLine) {
		return undefined;
	}

	const header = JSON.parse(firstLine) as { type?: string; cwd?: unknown };
	return header.type === "session" && typeof header.cwd === "string" && header.cwd.trim() ? header.cwd : undefined;
}

export function resolveStartupSessionTarget(
	sessionPath: string,
	deps: {
		readFirstLine?: (path: string) => string;
		exists?: typeof existsSync;
		stat?: typeof statSync;
	} = {},
): { cwd: string } | { warning: string } {
	const readFirstLine = deps.readFirstLine ?? readBoundedFirstLine;
	const pathExists = deps.exists ?? existsSync;
	const pathStat = deps.stat ?? statSync;

	try {
		const sessionCwd = readRecordedSessionCwd(sessionPath, readFirstLine);
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

	if (process.stdin.isTTY) process.stdin.setRawMode(false);
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
