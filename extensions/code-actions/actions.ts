import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Container, Text, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
let justBash: { Bash?: any; OverlayFs?: any } | null = null;
let justBashLoadPromise: Promise<void> | null = null;
let justBashLoadDone = false;

async function ensureJustBashLoaded(): Promise<void> {
	if (justBashLoadDone) return;

	if (!justBashLoadPromise) {
		justBashLoadPromise = import("just-bash")
			.then((mod: any) => {
				justBash = mod;
			})
			.catch(() => {
				justBash = null;
			})
			.finally(() => {
				justBashLoadDone = true;
			});
	}

	await justBashLoadPromise;
}

export async function copyToClipboard(pi: ExtensionAPI, content: string): Promise<boolean> {
	const tmpPath = path.join(os.tmpdir(), `pi-code-${Date.now()}.txt`);
	fs.writeFileSync(tmpPath, content, "utf8");

	const commands: Array<{ command: string; args: string[] }> = [];
	if (process.platform === "darwin") {
		commands.push({ command: "sh", args: ["-c", `cat "${tmpPath}" | pbcopy`] });
	} else if (process.platform === "win32") {
		commands.push({ command: "powershell", args: ["-NoProfile", "-Command", `Get-Content -Raw "${tmpPath}" | Set-Clipboard`] });
	} else {
		commands.push({ command: "sh", args: ["-c", `cat "${tmpPath}" | wl-copy`] });
		commands.push({ command: "sh", args: ["-c", `cat "${tmpPath}" | xclip -selection clipboard`] });
		commands.push({ command: "sh", args: ["-c", `cat "${tmpPath}" | xsel --clipboard --input`] });
	}

	let success = false;
	for (const cmd of commands) {
		try {
			const result = await pi.exec(cmd.command, cmd.args);
			if (result.code === 0) {
				success = true;
				break;
			}
		} catch {
			// Try next command
		}
	}

	try {
		fs.unlinkSync(tmpPath);
	} catch {
		// Ignore cleanup errors
	}

	return success;
}

export function insertIntoEditor(ctx: ExtensionCommandContext, content: string): void {
	const existing = ctx.ui.getEditorText();
	const next = existing ? `${existing}\n${content}` : content;
	ctx.ui.setEditorText(next);
}

function formatOutput(command: string, result: { stdout: string; stderr: string; code: number }): string {
	const lines: string[] = [];
	lines.push(`Command: ${command}`);
	lines.push(`Exit code: ${result.code}`);

	if (result.stdout.trim().length > 0) {
		lines.push("");
		lines.push("STDOUT:");
		lines.push(result.stdout.trimEnd());
	}

	if (result.stderr.trim().length > 0) {
		lines.push("");
		lines.push("STDERR:");
		lines.push(result.stderr.trimEnd());
	}

	return lines.join("\n");
}

function truncateLines(text: string, maxLines: number): string {
	const lines = text.split(/\r?\n/);
	if (lines.length <= maxLines) return text;
	const truncated = lines.slice(0, maxLines).join("\n");
	return `${truncated}\n\n[Output truncated to ${maxLines} lines]`;
}

type CommandRunResult = {
	stdout: string;
	stderr: string;
	code: number;
	commandLabel: string;
};

function looksLikeMissingCommand(stderr: string): boolean {
	const normalized = stderr.toLowerCase();
	return normalized.includes("command not found") || normalized.includes("unknown command") || normalized.includes("not recognized");
}

function normalizeShellSnippetForExecution(snippet: string): string {
	const trimmed = snippet.trim();

	// If the snippet is a tool-call style JSON object, extract the command field
	if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
		try {
			const parsed = JSON.parse(trimmed) as any;
			const cmd = typeof parsed?.command === "string"
				? parsed.command
				: typeof parsed?.cmd === "string"
					? parsed.cmd
					: null;
			if (cmd && cmd.trim().length > 0) return cmd.trim();
		} catch {
			// ignore
		}
	}

	const lines = snippet.split(/\r?\n/);
	const hasPromptLines = lines.some(
		(line) => /^\s*\$\s+/.test(line) || /^\s*>\s+/.test(line) || /^\s*!\s*/.test(line),
	);

	// Common Pi convention: snippets sometimes include a leading `!` to indicate “run in shell”
	// If there are no prompt-like transcript lines, just strip a single leading `!`
	if (!hasPromptLines) {
		return trimmed.startsWith("!")
			? trimmed.replace(/^!\s*/, "")
			: trimmed;
	}

	const extracted = lines
		.map((line) => {
			if (/^\s*\$\s+/.test(line)) return line.replace(/^\s*\$\s+/, "");
			if (/^\s*>\s+/.test(line)) return line.replace(/^\s*>\s+/, "");
			if (/^\s*!\s*/.test(line)) return line.replace(/^\s*!\s*/, "");
			return "";
		})
		.filter((line) => line.trim().length > 0)
		.join("\n")
		.trim();

	return extracted.length > 0 ? extracted : trimmed;
}

async function runSnippetInSystemShell(pi: ExtensionAPI, ctx: ExtensionCommandContext, snippet: string): Promise<CommandRunResult> {
	const isWindows = process.platform === "win32";
	const command = isWindows ? "powershell" : "bash";
	const args = isWindows ? ["-NoProfile", "-Command", snippet] : ["-lc", snippet];
	const result = await pi.exec(command, args, { cwd: ctx.cwd });

	return {
		stdout: result.stdout,
		stderr: result.stderr,
		code: result.code,
		commandLabel: `${command} ${args.join(" ")}`,
	};
}

async function runSnippetInSandbox(snippet: string, cwd: string): Promise<CommandRunResult> {
	await ensureJustBashLoaded();
	const OverlayFsCtor = justBash?.OverlayFs;
	const BashCtor = justBash?.Bash;
	if (typeof OverlayFsCtor !== "function" || typeof BashCtor !== "function") {
		throw new Error("just-bash is not available");
	}

	const overlay = new OverlayFsCtor({ root: cwd });
	const bash = new BashCtor({
		fs: overlay,
		cwd: overlay.getMountPoint(),
		executionLimits: {
			maxCallDepth: 32,
			maxCommandCount: 1000,
			maxLoopIterations: 3000,
			maxAwkIterations: 8000,
			maxSedIterations: 8000,
		},
	});

	const result = await bash.exec(snippet);
	return {
		stdout: result.stdout,
		stderr: result.stderr,
		code: result.exitCode,
		commandLabel: `just-bash (overlayfs, read-only) -c ${JSON.stringify(snippet)}`,
	};
}

export async function runSnippet(pi: ExtensionAPI, ctx: ExtensionCommandContext, snippet: string): Promise<void> {
	let runResult: CommandRunResult;

	const normalizedSnippet = normalizeShellSnippetForExecution(snippet);

	if (process.platform === "win32") {
		runResult = await runSnippetInSystemShell(pi, ctx, normalizedSnippet);
	} else {
		let sandboxResult: CommandRunResult | null = null;
		try {
			sandboxResult = await runSnippetInSandbox(normalizedSnippet, ctx.cwd);
		} catch {
			sandboxResult = null;
		}

		if (!sandboxResult) {
			runResult = await runSnippetInSystemShell(pi, ctx, normalizedSnippet);
		} else if (sandboxResult.code !== 0 && looksLikeMissingCommand(sandboxResult.stderr)) {
			const stderrPreview = (sandboxResult.stderr ?? "").trim().slice(0, 500);
			const proceed = await ctx.ui.confirm(
				"Sandbox missing command",
				"The just-bash sandbox could not run this snippet because one or more commands are unsupported.\n\n" +
					`Snippet:\n${normalizedSnippet}\n\n` +
					(stderrPreview.length > 0 ? `Sandbox error:\n${stderrPreview}\n\n` : "") +
					"Run it in your real shell instead?",
			);

			if (proceed) {
				runResult = await runSnippetInSystemShell(pi, ctx, normalizedSnippet);
			} else {
				runResult = sandboxResult;
			}
		} else {
			runResult = sandboxResult;
		}
	}

	const output = truncateLines(
		formatOutput(runResult.commandLabel, {
			stdout: runResult.stdout,
			stderr: runResult.stderr,
			code: runResult.code,
		}),
		200,
	);

	await ctx.ui.custom<void>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Command Output")), 1, 0));

		const text = new Text(output, 1, 0);
		container.addChild(text);

		container.addChild(new Text(theme.fg("dim", "Enter/Esc to close"), 1, 0));
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		return {
			render: (width: number) => container.render(width).map((line) => truncateToWidth(line, width)),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (matchesKey(data, "escape") || matchesKey(data, "enter")) {
					done();
				}
			},
		};
	});
}
