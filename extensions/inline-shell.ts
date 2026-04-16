/**
 * Inline Shell Extension - expands inline shell commands in user prompts.
 *
 * Start pi with this extension:
 *   pi -e ./extensions/inline-shell.ts
 *
 * Then type prompts with inline shell:
 *   What's in !{pwd}?
 *   The current branch is !{git branch --show-current} and status: !{git status --short}
 *   My node version is !{node --version}
 *
 * The !{command} patterns are executed and replaced with their output before
 * the prompt is sent to the agent.
 *
 * Shell selection:
 * - If the current shell is zsh and $PI_CODING_AGENT_DIR/shell/pi-inline.zsh exists,
 *   source that file in a fresh zsh before running the command
 * - Otherwise, if the current shell is zsh, run a fresh interactive zsh so aliases
 *   and functions from .zshrc are available
 * - If the current shell is not zsh, fall back to bash
 *
 * The spawned shell always gets PI_INLINE_SHELL=1 so your shell config can skip
 * noisy prompt/plugin setup while still loading aliases/functions.
 *
 * Note: Regular !command syntax (whole-line bash) is preserved and works as before.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type ShellType = "zsh" | "bash";
type ShellMode = "shared-zsh-config" | "interactive-zsh" | "interactive-bash" | "bash-fallback";

type ResolvedShell = {
	path: string;
	type: ShellType;
	mode: ShellMode;
	sharedConfigPath?: string;
};

const PATTERN = /!\{([^}]+)\}/g;
const TIMEOUT_MS = 30_000;
const COMMON_BASH_PATHS = [
	"/bin/bash",
	"/usr/bin/bash",
	"/usr/local/bin/bash",
	"/opt/homebrew/bin/bash",
];

function getAgentDir(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR;
	if (envDir) {
		if (envDir === "~") {
			return os.homedir();
		}
		if (envDir.startsWith("~/")) {
			return path.join(os.homedir(), envDir.slice(2));
		}
		return envDir;
	}
	return path.join(os.homedir(), ".pi", "agent");
}

function detectShellType(shellPath: string | undefined): ShellType | null {
	if (!shellPath) {
		return null;
	}

	const baseName = path.basename(shellPath).toLowerCase();
	if (baseName === "zsh" || baseName.startsWith("zsh")) {
		return "zsh";
	}
	if (baseName === "bash" || baseName.startsWith("bash")) {
		return "bash";
	}
	return null;
}

function findFirstExistingPath(paths: string[]): string | null {
	for (const candidate of paths) {
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}
	return null;
}

function getSharedInlineZshConfigPath(): string | null {
	const candidate = path.join(getAgentDir(), "shell", "pi-inline.zsh");
	return fs.existsSync(candidate) ? candidate : null;
}

function resolveExecutionShell(): ResolvedShell {
	const userShellPath = process.env.SHELL;
	const userShellType = detectShellType(userShellPath);
	const hasUserShell = Boolean(userShellPath && fs.existsSync(userShellPath));

	if (hasUserShell && userShellType === "zsh") {
		const sharedConfigPath = getSharedInlineZshConfigPath();
		if (sharedConfigPath) {
			return {
				path: userShellPath as string,
				type: "zsh",
				mode: "shared-zsh-config",
				sharedConfigPath,
			};
		}

		return {
			path: userShellPath as string,
			type: "zsh",
			mode: "interactive-zsh",
		};
	}

	if (hasUserShell && userShellType === "bash") {
		return {
			path: userShellPath as string,
			type: "bash",
			mode: "interactive-bash",
		};
	}

	return {
		path: findFirstExistingPath(COMMON_BASH_PATHS) ?? "/bin/bash",
		type: "bash",
		mode: "bash-fallback",
	};
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function unwrapBraceWrappedCommand(command: string): string | null {
	const trimmed = command.trim();
	if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
		return null;
	}

	const inner = trimmed.slice(1, -1).trim();
	return inner.length > 0 ? inner : null;
}

function buildShellScript(
	command: string,
	shell: ResolvedShell,
	options?: { startMarker?: string; endMarker?: string },
): string {
	const scriptLines: string[] = ["export PI_INLINE_SHELL=1"];

	if (options?.startMarker) {
		scriptLines.push(`printf '%s\\n' ${shellQuote(options.startMarker)}`);
		scriptLines.push(`printf '%s\\n' ${shellQuote(options.startMarker)} >&2`);
	}

	if (shell.mode === "shared-zsh-config" && shell.sharedConfigPath) {
		scriptLines.push(`source ${shellQuote(shell.sharedConfigPath)}`);
	}

	scriptLines.push("set +e");
	scriptLines.push(`eval -- ${shellQuote(command)}`);
	scriptLines.push("__pi_inline_status=$?");

	if (options?.endMarker) {
		scriptLines.push(`printf '\\n%s\\n' ${shellQuote(options.endMarker)}`);
		scriptLines.push(`printf '\\n%s\\n' ${shellQuote(options.endMarker)} >&2`);
	}

	scriptLines.push("exit $__pi_inline_status");
	return scriptLines.join("\n");
}

function buildShellArgs(script: string, shell: ResolvedShell): string[] {
	return shell.mode === "shared-zsh-config"
		? ["-c", script]
		: ["-i", "-c", script];
}

function createShellBackedBashOperations(shell: ResolvedShell, originalCommand?: string) {
	return {
		exec: async (
			command: string,
			cwd: string,
			options: {
				onData: (data: Buffer) => void;
				signal?: AbortSignal;
				timeout?: number;
				env?: NodeJS.ProcessEnv;
			},
		): Promise<{ exitCode: number | null }> => {
			const commandToRun = originalCommand ?? command;
			const effectiveCommand = unwrapBraceWrappedCommand(commandToRun) ?? commandToRun;
			const script = buildShellScript(effectiveCommand, shell);
			const child = spawn(shell.path, buildShellArgs(script, shell), {
				cwd,
				env: {
					...process.env,
					...options.env,
					PI_INLINE_SHELL: "1",
				},
				stdio: ["ignore", "pipe", "pipe"],
			});

			child.stdout?.on("data", options.onData);
			child.stderr?.on("data", options.onData);

			let timeoutHandle: NodeJS.Timeout | undefined;
			let settled = false;

			const terminate = () => {
				if (child.killed) {
					return;
				}
				child.kill("SIGTERM");
				setTimeout(() => {
					if (!child.killed) {
						child.kill("SIGKILL");
					}
				}, 5000);
			};

			const abortHandler = () => terminate();
			if (options.signal) {
				if (options.signal.aborted) {
					terminate();
				} else {
					options.signal.addEventListener("abort", abortHandler, { once: true });
				}
			}

			if (options.timeout && options.timeout > 0) {
				timeoutHandle = setTimeout(() => terminate(), options.timeout * 1000);
			}

			return await new Promise<{ exitCode: number | null }>((resolve, reject) => {
				const cleanup = () => {
					if (settled) {
						return;
					}
					settled = true;
					if (timeoutHandle) {
						clearTimeout(timeoutHandle);
					}
					options.signal?.removeEventListener("abort", abortHandler);
				};

				child.on("error", (error) => {
					cleanup();
					reject(error);
				});
				child.on("close", (code) => {
					cleanup();
					resolve({ exitCode: code });
				});
			});
		},
	};
}

function buildShellInvocation(command: string, shell: ResolvedShell): {
	args: string[];
	startMarker: string;
	endMarker: string;
} {
	const startMarker = `__PI_INLINE_START_${randomUUID()}__`;
	const endMarker = `__PI_INLINE_END_${randomUUID()}__`;
	const scriptLines = [
		"export PI_INLINE_SHELL=1",
		`printf '%s\\n' ${shellQuote(startMarker)}`,
		`printf '%s\\n' ${shellQuote(startMarker)} >&2`,
	];

	if (shell.mode === "shared-zsh-config" && shell.sharedConfigPath) {
		scriptLines.push(`source ${shellQuote(shell.sharedConfigPath)}`);
	}

	scriptLines.push("set +e");
	scriptLines.push(`eval -- ${shellQuote(command)}`);
	scriptLines.push("__pi_inline_status=$?");
	scriptLines.push(`printf '\\n%s\\n' ${shellQuote(endMarker)}`);
	scriptLines.push(`printf '\\n%s\\n' ${shellQuote(endMarker)} >&2`);
	scriptLines.push("exit $__pi_inline_status");

	const args = shell.mode === "shared-zsh-config"
		? ["-c", scriptLines.join("\n")]
		: ["-i", "-c", scriptLines.join("\n")];

	return { args, startMarker, endMarker };
}

function extractMarkedOutput(text: string, startMarker: string, endMarker: string): string {
	const normalized = text.replace(/\r\n/g, "\n");
	const startIndex = normalized.indexOf(startMarker);
	if (startIndex === -1) {
		return normalized.trim();
	}

	let contentStart = startIndex + startMarker.length;
	if (normalized[contentStart] === "\n") {
		contentStart += 1;
	}

	const endIndex = normalized.lastIndexOf(`\n${endMarker}`);
	if (endIndex === -1 || endIndex < contentStart) {
		return normalized.slice(contentStart).trim();
	}

	return normalized.slice(contentStart, endIndex).trim();
}

function getReplacementText(stdout: string, stderr: string, exitCode: number): string {
	const trimmedStdout = stdout.trim();
	const trimmedStderr = stderr.trim();
	if (trimmedStdout.length > 0) {
		return trimmedStdout;
	}
	if (trimmedStderr.length > 0) {
		return trimmedStderr;
	}
	if (exitCode !== 0) {
		return `[error: exit code ${exitCode}]`;
	}
	return "";
}

function describeShell(shell: ResolvedShell): string {
	switch (shell.mode) {
		case "shared-zsh-config":
			return "zsh (shell/pi-inline.zsh)";
		case "interactive-zsh":
			return "zsh (.zshrc)";
		case "interactive-bash":
			return "bash (.bashrc)";
		case "bash-fallback":
			return "bash fallback";
		default:
			return shell.type;
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("user_bash", async (event) => {
		const shell = resolveExecutionShell();
		return {
			operations: createShellBackedBashOperations(shell, event.command),
		};
	});

	pi.on("input", async (event, ctx) => {
		const text = event.text;

		if (text.trimStart().startsWith("!") && !text.trimStart().startsWith("!{")) {
			return { action: "continue" };
		}

		if (!PATTERN.test(text)) {
			return { action: "continue" };
		}

		PATTERN.lastIndex = 0;

		let result = text;
		const shell = resolveExecutionShell();
		const expansions: Array<{ command: string; output: string; error?: string }> = [];
		const matches: Array<{ full: string; command: string }> = [];

		let match = PATTERN.exec(text);
		while (match) {
			matches.push({ full: match[0], command: match[1] });
			match = PATTERN.exec(text);
		}
		PATTERN.lastIndex = 0;

		for (const { full, command } of matches) {
			try {
				const invocation = buildShellInvocation(command, shell);
				const shellResult = await pi.exec(shell.path, invocation.args, {
					cwd: ctx.cwd,
					timeout: TIMEOUT_MS,
				});

				const filteredStdout = extractMarkedOutput(shellResult.stdout, invocation.startMarker, invocation.endMarker);
				const filteredStderr = extractMarkedOutput(shellResult.stderr, invocation.startMarker, invocation.endMarker);
				const replacementText = getReplacementText(filteredStdout, filteredStderr, shellResult.code);
				const error = shellResult.code === 0 ? undefined : `exit code ${shellResult.code}`;

				expansions.push({ command, output: replacementText, error });
				result = result.replace(full, () => replacementText);
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : String(err);
				expansions.push({ command, output: "", error: errorMsg });
				result = result.replace(full, () => `[error: ${errorMsg}]`);
			}
		}

		if (ctx.hasUI && expansions.length > 0) {
			const summary = expansions
				.map((expansion) => {
					const status = expansion.error ? ` (${expansion.error})` : "";
					const preview = expansion.output.length > 50
						? `${expansion.output.slice(0, 50)}...`
						: expansion.output;
					return `!{${expansion.command}}${status} -> "${preview}"`;
				})
				.join("\n");

			ctx.ui.notify(`Expanded ${expansions.length} inline command(s) via ${describeShell(shell)}:\n${summary}`, "info");
		}

		return { action: "transform", text: result, images: event.images };
	});
}
