/**
 * Sandbox Extension - OS-level sandboxing for bash commands
 *
 * Uses @anthropic-ai/sandbox-runtime to enforce filesystem and network
 * restrictions on bash commands at the OS level (sandbox-exec on macOS,
 * bubblewrap on Linux).
 *
 * Config files (merged, project takes precedence):
 * - ~/.pi/agent/extensions/sandbox/sandbox.json (global)
 * - <cwd>/.pi/sandbox.json (project-local)
 *
 * Example .pi/sandbox.json:
 * ```json
 * {
 *   "enabled": true,
 *   "network": {
 *     "allowedDomains": ["github.com", "*.github.com"],
 *     "deniedDomains": []
 *   },
 *   "filesystem": {
 *     "denyRead": ["~/.ssh", "~/.aws"],
 *     "allowWrite": [".", "/tmp"],
 *     "denyWrite": [".env"]
 *   }
 * }
 * ```
 *
 * Usage:
 * - `pi -e ./sandbox` - sandbox enabled with default/config settings
 * - `pi -e ./sandbox --no-sandbox` - disable sandboxing
 * - `/sandbox` - interactive menu to toggle on/off (shows current sandbox config above the options)
 * - `/sandbox on` - enable sandbox
 * - `/sandbox off` - disable sandbox
 *
 * Setup:
 * 1. Copy sandbox/ directory to ~/.pi/agent/extensions/
 * 2. Run `npm install` in ~/.pi/agent/extensions/sandbox/
 *
 * Linux also requires: bubblewrap, socat, ripgrep
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { type BashOperations, createBashTool } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";

interface SandboxConfig extends SandboxRuntimeConfig {
	enabled?: boolean;
}

class SandboxMenu implements Component {
	private currentState: "on" | "off";
	private configLines: string[];
	private selectedIndex: number;
	private onDone: (value: "on" | "off" | null) => void;

	constructor(params: {
		currentState: "on" | "off";
		configLines: string[];
		onDone: (value: "on" | "off" | null) => void;
	}) {
		this.currentState = params.currentState;
		this.configLines = params.configLines;
		this.selectedIndex = params.currentState === "on" ? 0 : 1;
		this.onDone = params.onDone;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.up) || matchesKey(data, Key.left)) {
			this.selectedIndex = this.selectedIndex === 0 ? 1 : 0;
		} else if (matchesKey(data, Key.down) || matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
			this.selectedIndex = this.selectedIndex === 0 ? 1 : 0;
		} else if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
			this.onDone(this.selectedIndex === 0 ? "on" : "off");
		} else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.onDone(null);
		}
	}

	render(width: number): string[] {
		const lines: string[] = [];

		// Config summary (legacy formatting) at the top
		for (const line of this.configLines) {
			if (line.length === 0) {
				lines.push("");
				continue;
			}

			lines.push(...wrapTextWithAnsi(line, width));
		}

		lines.push("");
		lines.push(truncateToWidth(`Toggle sandbox (currently ${this.currentState})`, width));

		const optionLines = ["on", "off"].map((opt, i) => {
			const prefix = i === this.selectedIndex ? " → " : "   ";
			return truncateToWidth(prefix + opt, width);
		});
		lines.push(...optionLines);

		return lines;
	}

	invalidate(): void {
		// No cached state
	}
}

const DEFAULT_CONFIG: SandboxConfig = {
	enabled: true,
	network: {
		allowedDomains: [
			"npmjs.org",
			"*.npmjs.org",
			"registry.npmjs.org",
			"registry.yarnpkg.com",
			"pypi.org",
			"*.pypi.org",
			"github.com",
			"*.github.com",
			"api.github.com",
			"raw.githubusercontent.com",
		],
		deniedDomains: [],
	},
	filesystem: {
		denyRead: ["~/.ssh", "~/.aws", "~/.gnupg"],
		allowWrite: [".", "/tmp"],
		denyWrite: [".env", ".env.*", "*.pem", "*.key"],
	},
};

function loadConfig(cwd: string): SandboxConfig {
	const projectConfigPath = join(cwd, ".pi", "sandbox.json");

	const preferredGlobalConfigPath = join(homedir(), ".pi", "agent", "extensions", "sandbox", "sandbox.json");
	const legacyGlobalConfigPaths = [
		join(homedir(), ".pi", "agent", "extensions", "sandbox.json"),
		join(homedir(), ".pi", "agent", "sandbox.json"),
	];

	const globalConfigPath =
		(preferredGlobalConfigPath && existsSync(preferredGlobalConfigPath) && preferredGlobalConfigPath) ||
		legacyGlobalConfigPaths.find((p) => existsSync(p));

	let globalConfig: Partial<SandboxConfig> = {};
	let projectConfig: Partial<SandboxConfig> = {};

	if (globalConfigPath) {
		try {
			globalConfig = JSON.parse(readFileSync(globalConfigPath, "utf-8"));
		} catch (e) {
			console.error(`Warning: Could not parse ${globalConfigPath}: ${e}`);
		}
	}

	if (existsSync(projectConfigPath)) {
		try {
			projectConfig = JSON.parse(readFileSync(projectConfigPath, "utf-8"));
		} catch (e) {
			console.error(`Warning: Could not parse ${projectConfigPath}: ${e}`);
		}
	}

	return deepMerge(deepMerge(DEFAULT_CONFIG, globalConfig), projectConfig);
}

function deepMerge(base: SandboxConfig, overrides: Partial<SandboxConfig>): SandboxConfig {
	const result: SandboxConfig = { ...base };

	if (overrides.enabled !== undefined) result.enabled = overrides.enabled;
	if (overrides.network) {
		result.network = { ...base.network, ...overrides.network };
	}
	if (overrides.filesystem) {
		result.filesystem = { ...base.filesystem, ...overrides.filesystem };
	}

	const extOverrides = overrides as {
		ignoreViolations?: Record<string, string[]>;
		enableWeakerNestedSandbox?: boolean;
	};
	const extResult = result as { ignoreViolations?: Record<string, string[]>; enableWeakerNestedSandbox?: boolean };

	if (extOverrides.ignoreViolations) {
		extResult.ignoreViolations = extOverrides.ignoreViolations;
	}
	if (extOverrides.enableWeakerNestedSandbox !== undefined) {
		extResult.enableWeakerNestedSandbox = extOverrides.enableWeakerNestedSandbox;
	}

	return result;
}

function createSandboxedBashOps(): BashOperations {
	return {
		async exec(command, cwd, { onData, signal, timeout }) {
			if (!existsSync(cwd)) {
				throw new Error(`Working directory does not exist: ${cwd}`);
			}

			const wrappedCommand = await SandboxManager.wrapWithSandbox(command);

			return new Promise((resolve, reject) => {
				const child = spawn("bash", ["-c", wrappedCommand], {
					cwd,
					detached: true,
					stdio: ["ignore", "pipe", "pipe"],
				});

				let timedOut = false;
				let timeoutHandle: NodeJS.Timeout | undefined;

				if (timeout !== undefined && timeout > 0) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						if (child.pid) {
							try {
								process.kill(-child.pid, "SIGKILL");
							} catch {
								child.kill("SIGKILL");
							}
						}
					}, timeout * 1000);
				}

				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);

				child.on("error", (err) => {
					if (timeoutHandle) clearTimeout(timeoutHandle);
					reject(err);
				});

				const onAbort = () => {
					if (child.pid) {
						try {
							process.kill(-child.pid, "SIGKILL");
						} catch {
							child.kill("SIGKILL");
						}
					}
				};

				signal?.addEventListener("abort", onAbort, { once: true });

				child.on("close", (code) => {
					if (timeoutHandle) clearTimeout(timeoutHandle);
					signal?.removeEventListener("abort", onAbort);

					if (signal?.aborted) {
						reject(new Error("aborted"));
					} else if (timedOut) {
						reject(new Error(`timeout:${timeout}`));
					} else {
						resolve({ exitCode: code });
					}
				});
			});
		},
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("no-sandbox", {
		description: "Disable OS-level sandboxing for bash commands",
		type: "boolean",
		default: false,
	});

	const localCwd = process.cwd();
	const localBash = createBashTool(localCwd);

	let sandboxEnabled = false;
	let sandboxInitialized = false;

	const getSandboxConfigLines = (ctx: ExtensionContext): string[] => {
		const config = loadConfig(ctx.cwd);

		return [
			"Sandbox Configuration:",
			"",
			"Network:",
			`  Allowed: ${config.network?.allowedDomains?.join(", ") || "(none)"}`,
			`  Denied: ${config.network?.deniedDomains?.join(", ") || "(none)"}`,
			"",
			"Filesystem:",
			`  Deny Read: ${config.filesystem?.denyRead?.join(", ") || "(none)"}`,
			`  Allow Write: ${config.filesystem?.allowWrite?.join(", ") || "(none)"}`,
			`  Deny Write: ${config.filesystem?.denyWrite?.join(", ") || "(none)"}`,
		];
	};


	const enableSandbox = async (ctx: ExtensionContext): Promise<void> => {
		const noSandbox = pi.getFlag("no-sandbox") as boolean;
		if (noSandbox) {
			ctx.ui.notify("Sandbox disabled via --no-sandbox (restart without it to enable)", "warning");
			return;
		}

		if (sandboxEnabled) {
			ctx.ui.notify("Sandbox is already enabled", "info");
			return;
		}

		const platform = process.platform;
		if (platform !== "darwin" && platform !== "linux") {
			ctx.ui.notify(`Sandbox not supported on ${platform}`, "warning");
			return;
		}

		const config = loadConfig(ctx.cwd);
		const configExt = config as unknown as {
			ignoreViolations?: Record<string, string[]>;
			enableWeakerNestedSandbox?: boolean;
		};

		try {
			// If we were previously initialized, reset first so changes in config are applied cleanly
			if (sandboxInitialized) {
				await SandboxManager.reset();
				sandboxInitialized = false;
			}

			await SandboxManager.initialize({
				network: config.network,
				filesystem: config.filesystem,
				ignoreViolations: configExt.ignoreViolations,
				enableWeakerNestedSandbox: configExt.enableWeakerNestedSandbox,
			});

			sandboxInitialized = true;
			sandboxEnabled = true;
			ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("accent", "sandbox ✓"));
			ctx.ui.notify("Sandbox enabled", "info");
		} catch (err) {
			sandboxEnabled = false;
			ctx.ui.setStatus("sandbox", undefined);
			ctx.ui.notify(`Sandbox initialization failed: ${err instanceof Error ? err.message : err}`, "error");
		}
	};

	const disableSandbox = async (ctx: ExtensionContext): Promise<void> => {
		if (!sandboxEnabled) {
			ctx.ui.notify("Sandbox is already disabled", "info");
			return;
		}

		sandboxEnabled = false;
		ctx.ui.setStatus("sandbox", undefined);

		if (sandboxInitialized) {
			try {
				await SandboxManager.reset();
			} catch {
				// Ignore cleanup errors
			} finally {
				sandboxInitialized = false;
			}
		}

		ctx.ui.notify("Sandbox disabled", "warning");
	};

	const toggleSandbox = async (ctx: ExtensionContext): Promise<void> => {
		if (sandboxEnabled) {
			await disableSandbox(ctx);
			return;
		}

		await enableSandbox(ctx);
	};

	pi.registerTool({
		...localBash,
		label: "bash (sandboxed)",
		async execute(id, params, onUpdate, _ctx, signal) {
			if (!sandboxEnabled || !sandboxInitialized) {
				return localBash.execute(id, params, signal, onUpdate);
			}

			const sandboxedBash = createBashTool(localCwd, {
				operations: createSandboxedBashOps(),
			});
			return sandboxedBash.execute(id, params, signal, onUpdate);
		},
	});

	pi.on("user_bash", () => {
		if (!sandboxEnabled || !sandboxInitialized) return;
		return { operations: createSandboxedBashOps() };
	});

	pi.on("session_start", async (_event, ctx) => {
		const noSandbox = pi.getFlag("no-sandbox") as boolean;

		if (noSandbox) {
			sandboxEnabled = false;
			ctx.ui.notify("Sandbox disabled via --no-sandbox", "warning");
			return;
		}

		const config = loadConfig(ctx.cwd);

		if (!config.enabled) {
			sandboxEnabled = false;
			ctx.ui.notify("Sandbox disabled via config", "info");
			return;
		}

		const platform = process.platform;
		if (platform !== "darwin" && platform !== "linux") {
			sandboxEnabled = false;
			ctx.ui.notify(`Sandbox not supported on ${platform}`, "warning");
			return;
		}

		try {
			const configExt = config as unknown as {
				ignoreViolations?: Record<string, string[]>;
				enableWeakerNestedSandbox?: boolean;
			};

			await SandboxManager.initialize({
				network: config.network,
				filesystem: config.filesystem,
				ignoreViolations: configExt.ignoreViolations,
				enableWeakerNestedSandbox: configExt.enableWeakerNestedSandbox,
			});

			sandboxEnabled = true;
			sandboxInitialized = true;

			ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("accent", "sandbox ✓"));
		} catch (err) {
			sandboxEnabled = false;
			ctx.ui.notify(`Sandbox initialization failed: ${err instanceof Error ? err.message : err}`, "error");
		}
	});

	pi.on("session_shutdown", async () => {
		if (sandboxInitialized) {
			try {
				await SandboxManager.reset();
			} catch {
				// Ignore cleanup errors
			}
		}
	});

	pi.registerShortcut(Key.alt("s"), {
		description: "Toggle sandbox on/off",
		handler: async (ctx) => toggleSandbox(ctx),
	});

	pi.registerCommand("sandbox", {
		description: "Toggle OS-level sandboxing for bash commands",
		handler: async (args, ctx) => {
			const subcommand = args?.trim().toLowerCase();

			if (subcommand === "on") {
				await enableSandbox(ctx);
				return;
			}

			if (subcommand === "off") {
				await disableSandbox(ctx);
				return;
			}

			if (subcommand && subcommand.length > 0) {
				ctx.ui.notify("Usage: /sandbox [on|off]", "info");
				return;
			}

			// No args: interactive 2-option menu
			if (!ctx.hasUI) {
				// No UI available (print/RPC mode). Use explicit on/off subcommands instead
				return;
			}

			const currentState = sandboxEnabled ? "on" : "off";
			const choice = await ctx.ui.custom<"on" | "off" | null>((_tui, _theme, _keybindings, done) => {
				return new SandboxMenu({
					currentState,
					configLines: getSandboxConfigLines(ctx),
					onDone: done,
				});
			});

			if (!choice) return;

			if (choice === "on") {
				await enableSandbox(ctx);
			} else {
				await disableSandbox(ctx);
			}
		},
	});
}
