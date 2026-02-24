/**
 * iTerm2 tab color with two-state behavior:
 * - runningColor: while Pi agent is running
 * - notRunningColor: when Pi agent is not running
 *
 * Uses agent_start/agent_end (same lifecycle as titlebar-spinner), not turn events
 */
import type {
	AgentEndEvent,
	AgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
	SessionShutdownEvent,
	SessionStartEvent,
	SessionSwitchEvent,
} from "@mariozechner/pi-coding-agent";

const OSC = "\x1b]";
const BEL = "\x07";

const CONFIG = {
	runningColor: "71c1e3",
	notRunningColor: "6f5e7d",
} as const;

const normalizeHexColor = (value: string): string => {
	const normalized = value.trim().replace(/^#/, "").toUpperCase();
	if (!/^[0-9A-F]{6}$/.test(normalized)) {
		throw new Error(`Invalid hex color: ${value}`);
	}
	return normalized;
};

const parseChannel = (hexColor: string, start: number): number =>
	Number.parseInt(hexColor.slice(start, start + 2), 16);

const buildSetTabColorSequence = (hexColor: string): string => {
	const red = parseChannel(hexColor, 0);
	const green = parseChannel(hexColor, 2);
	const blue = parseChannel(hexColor, 4);

	return [
		`${OSC}6;1;bg;red;brightness;${red}${BEL}`,
		`${OSC}6;1;bg;green;brightness;${green}${BEL}`,
		`${OSC}6;1;bg;blue;brightness;${blue}${BEL}`,
	].join("");
};

const isIterm2 = (): boolean => process.env.TERM_PROGRAM === "iTerm.app";

const writeOsc = (sequence: string): void => {
	process.stdout.write(sequence);
};

export default function (pi: ExtensionAPI) {
	const runningColor = normalizeHexColor(CONFIG.runningColor);
	const notRunningColor = normalizeHexColor(CONFIG.notRunningColor);

	const setColor = (ctx: ExtensionContext, color: string): void => {
		if (!ctx.hasUI || !isIterm2()) return;
		writeOsc(buildSetTabColorSequence(color));
	};

	const setRunning = (ctx: ExtensionContext): void => {
		setColor(ctx, runningColor);
	};

	const setNotRunning = (ctx: ExtensionContext): void => {
		setColor(ctx, notRunningColor);
	};

	pi.on("session_start", async (_event: SessionStartEvent, ctx: ExtensionContext) => {
		setNotRunning(ctx);
	});

	pi.on("session_switch", async (_event: SessionSwitchEvent, ctx: ExtensionContext) => {
		setNotRunning(ctx);
	});

	pi.on("agent_start", async (_event: AgentStartEvent, ctx: ExtensionContext) => {
		setRunning(ctx);
	});

	pi.on("agent_end", async (_event: AgentEndEvent, ctx: ExtensionContext) => {
		setNotRunning(ctx);
	});

	pi.on("session_shutdown", async (_event: SessionShutdownEvent, ctx: ExtensionContext) => {
		setNotRunning(ctx);
	});
}
