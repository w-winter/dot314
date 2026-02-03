/**
 * Desktop Notification Extension
 *
 * Sends a native desktop notification (with optional sound) when the agent finishes,
 * but only if the response took longer than a configurable threshold.
 *
 * Features:
 * - /notify command to configure (or quick: /notify on|off|popup|pushover|<seconds>|<sound>|volume)
 * - Configurable hotkey (default Alt+N) to toggle on/off
 * - Only notifies if agent turn took >= minDurationSeconds
 * - Configurable sounds: system sounds, custom paths, silent, or random
 * - "silent" reserved alias: no sound plays (popup only if enabled)
 * - "random" reserved alias: randomly picks from all sounds with paths
 * - Popup and sound can be toggled independently
 * - Volume modes: "constant" (always max) or "timeScaled" (louder for longer responses)
 * - Pushover integration for Apple Watch / iOS notifications
 * - Status indicator in footer (♫ sound, ↥ popup, ⚡︎ pushover)
 *
 * Configuration file: ~/.pi/agent/extensions/notify/notify.json
 * - If missing, the extension will create it on first run with safe defaults
 *
 * Volume modes:
 * - "constant": Always plays at volume.max
 * - "timeScaled": Linear interpolation from volume.min (at threshold) to volume.max (at 4× threshold)
 *
 * Usage:
 * - Alt+N (or configured hotkey) to toggle notifications on/off
 * - /notify - open configuration menu
 * - /notify on|off - toggle directly
 * - /notify popup - toggle popup on/off
 * - /notify pushover - toggle Pushover on/off
 * - /notify volume - toggle between constant/timeScaled
 * - /notify 10 - set minimum duration to 10 seconds
 * - /notify glass - set sound to Glass (case-insensitive alias match)
 * - /notify silent - disable sound (popup only)
 * - /notify random - randomly select sound each notification
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync, spawn } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key, type KeyId } from "@mariozechner/pi-tui";

// =============================================================================
// Configuration
// =============================================================================

// Configurable hotkey - change this to your preference
// Examples: Key.ctrl("n"), Key.alt("n"), Key.ctrlShift("n")
const TOGGLE_HOTKEY: KeyId = Key.alt("n");

// =============================================================================
// Types
// =============================================================================

interface SoundEntry {
	alias: string;
	path?: string; // undefined for reserved aliases like "silent" and "random"
}

interface VolumeConfig {
	mode: "constant" | "timeScaled";
	max: number; // 0.0 to 1.0+
	min: number; // 0.0 to 1.0+ (only used in timeScaled mode)
}

interface PushoverConfig {
	enabled: boolean;
	userKey: string;
	apiToken: string;
}

interface NotifyConfig {
	enabled: boolean;
	minDurationSeconds: number;
	sound: string; // alias reference
	showPopup: boolean;
	sounds: SoundEntry[];
	volume: VolumeConfig;
	pushover: PushoverConfig;
}

// =============================================================================
// Config File Management
// =============================================================================

function getConfigPath(): string {
	return join(homedir(), ".pi", "agent", "extensions", "notify", "notify.json");
}

const DEFAULT_CONFIG: NotifyConfig = {
	enabled: false,
	minDurationSeconds: 10,
	sound: "silent",
	showPopup: false,
	sounds: [
		{ alias: "silent" },
		{ alias: "random" },
		{ alias: "Funk", path: "/System/Library/Sounds/Funk.aiff" },
		{ alias: "Glass", path: "/System/Library/Sounds/Glass.aiff" },
		{ alias: "Hero", path: "/System/Library/Sounds/Hero.aiff" },
		{ alias: "Submarine", path: "/System/Library/Sounds/Submarine.aiff" },
	],
	volume: {
		mode: "timeScaled",
		max: 1.0,
		min: 0.1,
	},
	pushover: {
		enabled: false,
		userKey: "",
		apiToken: "",
	},
};

function loadConfig(): NotifyConfig {
	const configPath = getConfigPath();

	if (!existsSync(configPath)) {
		// First-run UX: create a usable default config so pi doesn't error on startup
		try {
			saveConfig(DEFAULT_CONFIG);
		} catch (err) {
			console.error(`Notify extension: failed to write default config to ${configPath}: ${err}`);
		}
		return DEFAULT_CONFIG;
	}

	let parsed: Partial<NotifyConfig> | undefined;
	try {
		const content = readFileSync(configPath, "utf-8");
		parsed = JSON.parse(content) as Partial<NotifyConfig>;
	} catch (err) {
		console.error(`Notify extension: failed to parse ${configPath}: ${err}`);
		return DEFAULT_CONFIG;
	}

	return {
		...DEFAULT_CONFIG,
		...parsed,
		volume: {
			...DEFAULT_CONFIG.volume,
			...(parsed.volume ?? {}),
		},
		pushover: {
			...DEFAULT_CONFIG.pushover,
			...(parsed.pushover ?? {}),
		},
	} as NotifyConfig;
}

function saveConfig(config: NotifyConfig): void {
	const configPath = getConfigPath();
	const dir = dirname(configPath);

	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}

// =============================================================================
// Volume Calculation
// =============================================================================

function calculateVolume(config: NotifyConfig, elapsedSeconds: number): number {
	if (config.volume.mode === "constant") {
		return config.volume.max;
	}

	// timeScaled mode: linear interpolation from min to max
	// At 1× threshold: min volume
	// At 4× threshold: max volume
	const threshold = config.minDurationSeconds;
	const minTime = threshold;
	const maxTime = threshold * 4;

	if (elapsedSeconds <= minTime) {
		return config.volume.min;
	}
	if (elapsedSeconds >= maxTime) {
		return config.volume.max;
	}

	// Linear interpolation
	const t = (elapsedSeconds - minTime) / (maxTime - minTime);
	return config.volume.min + t * (config.volume.max - config.volume.min);
}

// =============================================================================
// Sound Playback
// =============================================================================

function findSound(config: NotifyConfig, alias: string): SoundEntry | undefined {
	return config.sounds.find((s) => s.alias.toLowerCase() === alias.toLowerCase());
}

function getPlayableSound(config: NotifyConfig, alias: string): SoundEntry | undefined {
	const lowerAlias = alias.toLowerCase();

	// Handle "random" - pick a random sound (excluding silent and random)
	if (lowerAlias === "random") {
		const playableSounds = config.sounds.filter(
			(s) => s.path && s.alias.toLowerCase() !== "silent" && s.alias.toLowerCase() !== "random"
		);
		if (playableSounds.length === 0) return undefined;
		return playableSounds[Math.floor(Math.random() * playableSounds.length)];
	}

	return findSound(config, alias);
}

function playSound(soundEntry: SoundEntry | undefined, volume: number): void {
	if (!soundEntry || !soundEntry.path) {
		// silent or not found
		return;
	}

	// Spawn detached so sound plays without blocking input
	const child = spawn("afplay", ["-v", String(volume), soundEntry.path], {
		detached: true,
		stdio: "ignore",
	});
	child.unref();
}

// =============================================================================
// Pushover Integration
// =============================================================================

function sendPushover(config: NotifyConfig, title: string, message: string): void {
	if (!config.pushover.enabled || !config.pushover.userKey || !config.pushover.apiToken) {
		return;
	}

	// Spawn curl detached so it doesn't block
	const child = spawn("curl", [
		"-s",
		"-X", "POST",
		"https://api.pushover.net/1/messages.json",
		"--data-urlencode", `token=${config.pushover.apiToken}`,
		"--data-urlencode", `user=${config.pushover.userKey}`,
		"--data-urlencode", `title=${title}`,
		"--data-urlencode", `message=${message}`,
	], {
		detached: true,
		stdio: "ignore",
	});
	child.unref();
}

// =============================================================================
// Notification
// =============================================================================

function notify(title: string, body: string, config: NotifyConfig, elapsedSeconds: number): void {
	// Show popup notification if enabled
	if (config.showPopup) {
		try {
			execSync(`osascript -e 'display notification "${body}" with title "${title}"'`);
		} catch {
			// Silently fail
		}
	}

	// Play sound with calculated volume
	const soundEntry = getPlayableSound(config, config.sound);
	const volume = calculateVolume(config, elapsedSeconds);
	playSound(soundEntry, volume);

	// Send Pushover notification
	sendPushover(config, title, body);
}

// =============================================================================
// Extension
// =============================================================================

export default function notifyExtension(pi: ExtensionAPI) {
	let config: NotifyConfig;
	let agentStartTime: number | null = null;

	// =========================================================================
	// Status Display
	// =========================================================================

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;

		if (config.enabled) {
			const lowerSound = config.sound.toLowerCase();
			const soundIndicator = lowerSound === "silent" ? "" : "♫";
			const popupIndicator = config.showPopup ? "↑" : "";
			const pushoverIndicator = config.pushover.enabled ? "⚡︎" : "";
			ctx.ui.setStatus(
				"notify",
				ctx.ui.theme.fg("success", `${soundIndicator}${popupIndicator}${pushoverIndicator} ${config.minDurationSeconds}s`)
			);
		} else {
			ctx.ui.setStatus("notify", ctx.ui.theme.fg("muted", ""));
		}
	}

	// =========================================================================
	// Toggle Functions
	// =========================================================================

	function toggleEnabled(ctx: ExtensionContext): void {
		config.enabled = !config.enabled;
		saveConfig(config);

		if (ctx.hasUI) {
			ctx.ui.notify(
				config.enabled
					? `Notifications enabled (≥${config.minDurationSeconds}s)`
					: "Notifications disabled",
				"info"
			);
		}

		updateStatus(ctx);
	}

	function togglePopup(ctx: ExtensionContext): void {
		config.showPopup = !config.showPopup;
		saveConfig(config);

		if (ctx.hasUI) {
			ctx.ui.notify(
				config.showPopup ? "Popup notifications enabled" : "Popup notifications disabled",
				"info"
			);
		}

		updateStatus(ctx);
	}

	function togglePushover(ctx: ExtensionContext): void {
		config.pushover.enabled = !config.pushover.enabled;
		saveConfig(config);

		if (ctx.hasUI) {
			ctx.ui.notify(
				config.pushover.enabled ? "Pushover notifications enabled" : "Pushover notifications disabled",
				"info"
			);
		}

		updateStatus(ctx);
	}

	function toggleVolumeMode(ctx: ExtensionContext): void {
		config.volume.mode = config.volume.mode === "constant" ? "timeScaled" : "constant";
		saveConfig(config);

		if (ctx.hasUI) {
			ctx.ui.notify(
				config.volume.mode === "constant"
					? `Volume mode: constant (${config.volume.max})`
					: `Volume mode: timeScaled (${config.volume.min} → ${config.volume.max})`,
				"info"
			);
		}
	}

	// =========================================================================
	// Hotkey Registration
	// =========================================================================

	pi.registerShortcut(TOGGLE_HOTKEY, {
		description: "Toggle notifications",
		handler: async (ctx) => {
			toggleEnabled(ctx);
		},
	});

	// =========================================================================
	// Command Registration
	// =========================================================================

	pi.registerCommand("notify", {
		description: "Configure desktop notifications",
		handler: async (args, ctx) => {
			// Quick subcommands
			if (args) {
				const arg = args.trim().toLowerCase();

				// /notify on
				if (arg === "on") {
					config.enabled = true;
					saveConfig(config);
					ctx.ui.notify("Notifications enabled", "info");
					updateStatus(ctx);
					return;
				}

				// /notify off
				if (arg === "off") {
					config.enabled = false;
					saveConfig(config);
					ctx.ui.notify("Notifications disabled", "info");
					updateStatus(ctx);
					return;
				}

				// /notify popup
				if (arg === "popup") {
					togglePopup(ctx);
					return;
				}

				// /notify pushover
				if (arg === "pushover") {
					togglePushover(ctx);
					return;
				}

				// /notify volume
				if (arg === "volume") {
					toggleVolumeMode(ctx);
					return;
				}

				// /notify <number> - set duration
				const num = parseInt(arg, 10);
				if (!isNaN(num) && num >= 0) {
					config.minDurationSeconds = num;
					saveConfig(config);
					ctx.ui.notify(`Notification threshold set to ${num} seconds`, "info");
					updateStatus(ctx);
					return;
				}

				// /notify <sound alias> - set sound (case-insensitive match)
				const matchedSound = findSound(config, arg);
				if (matchedSound) {
					config.sound = matchedSound.alias;
					saveConfig(config);
					if (matchedSound.path) {
						playSound(matchedSound, config.volume.max); // Preview at max volume
					}
					ctx.ui.notify(`Notification sound set to ${matchedSound.alias}`, "info");
					updateStatus(ctx);
					return;
				}

				// Unknown arg - show help
				ctx.ui.notify(
					`Unknown argument: ${args}\nUse: on, off, popup, pushover, volume, <seconds>, or <sound alias>`,
					"warning"
				);
				return;
			}

			// No args - show interactive menu
			const menuItems = [
				`${config.enabled ? "Disable" : "Enable"} notifications`,
				`${config.showPopup ? "Disable" : "Enable"} popup`,
				`${config.pushover.enabled ? "Disable" : "Enable"} Pushover (watch)`,
				`Volume mode: ${config.volume.mode} (tap to toggle)`,
				`Set max volume (current: ${config.volume.max})`,
				...(config.volume.mode === "timeScaled" ? [`Set min volume (current: ${config.volume.min})`] : []),
				`Set duration threshold (current: ${config.minDurationSeconds}s)`,
				`Change sound (current: ${config.sound})`,
				"Test notification",
			];

			const choice = await ctx.ui.select("Notification Settings", menuItems);

			if (choice === null) return;

			// Toggle notifications
			if (choice === menuItems[0]) {
				toggleEnabled(ctx);
				return;
			}

			// Toggle popup
			if (choice === menuItems[1]) {
				togglePopup(ctx);
				return;
			}

			// Toggle Pushover
			if (choice === menuItems[2]) {
				togglePushover(ctx);
				return;
			}

			// Toggle volume mode
			if (choice === menuItems[3]) {
				toggleVolumeMode(ctx);
				return;
			}

			// Set max volume
			if (choice === menuItems[4]) {
				const input = await ctx.ui.input("Max volume (0.0 - 1.0+)", String(config.volume.max));
				if (input !== null) {
					const vol = parseFloat(input);
					if (!isNaN(vol) && vol >= 0) {
						config.volume.max = vol;
						saveConfig(config);
						ctx.ui.notify(`Max volume set to ${vol}`, "info");
					} else {
						ctx.ui.notify("Invalid volume", "error");
					}
				}
				return;
			}

			// Set min volume (only in timeScaled mode)
			if (config.volume.mode === "timeScaled" && choice === menuItems[5]) {
				const input = await ctx.ui.input("Min volume (0.0 - 1.0+)", String(config.volume.min));
				if (input !== null) {
					const vol = parseFloat(input);
					if (!isNaN(vol) && vol >= 0) {
						config.volume.min = vol;
						saveConfig(config);
						ctx.ui.notify(`Min volume set to ${vol}`, "info");
					} else {
						ctx.ui.notify("Invalid volume", "error");
					}
				}
				return;
			}

			// Set duration - index shifts based on whether min volume is shown
			const durationIndex = config.volume.mode === "timeScaled" ? 6 : 5;
			if (choice === menuItems[durationIndex]) {
				const input = await ctx.ui.input(
					"Minimum duration (seconds)",
					String(config.minDurationSeconds)
				);
				if (input !== null) {
					const num = parseInt(input, 10);
					if (!isNaN(num) && num >= 0) {
						config.minDurationSeconds = num;
						saveConfig(config);
						ctx.ui.notify(`Threshold set to ${num} seconds`, "info");
						updateStatus(ctx);
					} else {
						ctx.ui.notify("Invalid number", "error");
					}
				}
				return;
			}

			// Change sound
			const soundIndex = config.volume.mode === "timeScaled" ? 7 : 6;
			if (choice === menuItems[soundIndex]) {
				const soundAliases = config.sounds.map((s) => s.alias);
				const soundChoice = await ctx.ui.select("Select sound", soundAliases);
				if (soundChoice !== null) {
					config.sound = soundChoice;
					saveConfig(config);
					const soundEntry = findSound(config, soundChoice);
					if (soundEntry?.path) {
						playSound(soundEntry, config.volume.max); // Preview at max volume
					}
					ctx.ui.notify(`Sound set to ${soundChoice}`, "info");
					updateStatus(ctx);
				}
				return;
			}

			// Test notification
			const testIndex = config.volume.mode === "timeScaled" ? 8 : 7;
			if (choice === menuItems[testIndex]) {
				// Test at 4x threshold to demonstrate max volume
				notify("𝞹", "⟳", config, config.minDurationSeconds * 4);
				return;
			}
		},
	});

	// =========================================================================
	// Agent Lifecycle Events
	// =========================================================================

	pi.on("agent_start", async () => {
		agentStartTime = Date.now();
	});

	pi.on("agent_end", async () => {
		if (!config.enabled || agentStartTime === null) {
			agentStartTime = null;
			return;
		}

		const elapsedSeconds = (Date.now() - agentStartTime) / 1000;
		agentStartTime = null;

		if (elapsedSeconds >= config.minDurationSeconds) {
			notify("𝞹", "⟳", config, elapsedSeconds);
		}
	});

	// =========================================================================
	// Session Initialization
	// =========================================================================

	pi.on("session_start", async (_event, ctx) => {
		config = loadConfig();
		updateStatus(ctx);
	});
}
