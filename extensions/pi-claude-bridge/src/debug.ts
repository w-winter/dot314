import { appendFileSync, chmodSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import { piUserDir } from "./config.ts";

// --- Debug logging ---
// CLAUDE_BRIDGE_DEBUG=1 enables debug logging to <piUserDir>/claude-bridge.log
// (~/.pi/agent/claude-bridge.log unless PI_CODING_AGENT_DIR points elsewhere).

export const DEBUG = process.env.CLAUDE_BRIDGE_DEBUG === "1";
export const DEBUG_LOG_PATH = process.env.CLAUDE_BRIDGE_DEBUG_PATH || join(piUserDir(), "claude-bridge.log");

export function diagLogPath(): string {
	return process.env.CLAUDE_BRIDGE_DIAG_PATH || join(piUserDir(), "claude-bridge-diag.log");
}

function cliLogDir(): string {
	return join(dirname(DEBUG_LOG_PATH), "cc-cli-logs");
}

// --- Retention ---
// Debug artifacts otherwise grow for as long as debugging stays on. Every step
// is best effort: a failure leaves files as they are and never reaches a turn.

export const DEBUG_LOG_MAX_BYTES = 10 * 1024 * 1024;
export const DEBUG_LOG_ROTATED_FILES = 3;
export const CLI_LOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const CLI_LOG_MAX_FILES = 100;
// debug() re-checks the log size after roughly this much output, so the hot
// path does not stat on every line.
const DEBUG_LOG_CHECK_BYTES = 1024 * 1024;
// Only the names makeCliDebugOptions writes: <ISO time, ":." as "-">-<tag>-<seq>.log
const CLI_LOG_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-z-]+-\d+\.log$/;

/** Rotate `path` to `path.1` (shifting older ones up to `path.3`, dropping the
 *  oldest) once it reaches DEBUG_LOG_MAX_BYTES. Renames keep the 0o600 mode. */
export function rotateDebugLog(path: string): void {
	try {
		if (statSync(path).size < DEBUG_LOG_MAX_BYTES) return;
		for (let i = DEBUG_LOG_ROTATED_FILES - 1; i >= 1; i--) {
			try { renameSync(`${path}.${i}`, `${path}.${i + 1}`); } catch { /* gap in the sequence */ }
		}
		renameSync(path, `${path}.1`);
	} catch { /* missing log, or another process rotated it first */ }
}

/** Delete the bridge's own per-query CLI logs in `dir` that are older than
 *  CLI_LOG_MAX_AGE_MS or beyond the newest CLI_LOG_MAX_FILES. */
export function pruneCliDebugLogs(dir: string): void {
	try {
		const now = Date.now();
		const logs: Array<{ path: string; mtimeMs: number }> = [];
		for (const name of readdirSync(dir)) {
			if (!CLI_LOG_NAME.test(name)) continue;
			const path = join(dir, name);
			try {
				const stat = statSync(path);
				if (stat.isFile()) logs.push({ path, mtimeMs: stat.mtimeMs });
			} catch { /* removed meanwhile */ }
		}
		logs.sort((a, b) => b.mtimeMs - a.mtimeMs);
		logs.forEach((log, i) => {
			if (i < CLI_LOG_MAX_FILES && now - log.mtimeMs <= CLI_LOG_MAX_AGE_MS) return;
			try { unlinkSync(log.path); } catch { /* removed meanwhile */ }
		});
	} catch { /* no log dir yet */ }
}

/** Trailing clause for user-facing integrity notifications. With DEBUG on the
 *  diag log exists and is worth pointing at; without it the file was never
 *  written (diagDump early-returns), so point at the switch that would have
 *  captured a dump instead of at a path that does not exist. */
export function diagGuidance(): string {
	return DEBUG
		? `see ${diagLogPath()}`
		: "re-run with CLAUDE_BRIDGE_DEBUG=1 to capture a diagnostic dump";
}

// Ensure log directories exist when debug is enabled. 0o700/0o600 throughout:
// these logs carry session metadata, ids and paths and belong to the user
// alone — same discipline as diagDump.
if (DEBUG) {
	try {
		mkdirSync(dirname(DEBUG_LOG_PATH), { recursive: true, mode: 0o700 });
		mkdirSync(dirname(diagLogPath()), { recursive: true, mode: 0o700 });
		// mode on mkdir/append applies only at CREATION — repair permissions on
		// dirs and logs that predate the 0o700/0o600 hardening.
		chmodSync(dirname(DEBUG_LOG_PATH), 0o700);
		chmodSync(DEBUG_LOG_PATH, 0o600);
	} catch {
		// If directory creation fails, debug functions will throw on first use
	}
	rotateDebugLog(DEBUG_LOG_PATH);
	rotateDebugLog(diagLogPath());
	pruneCliDebugLogs(cliLogDir());
}

// Unique per module evaluation — confirms whether subagents share module state
export const moduleInstanceId = Math.random().toString(36).slice(2, 8);

/** The shape of message or tool-result content for a log line: block count,
 *  block types, text length and whether it holds only images. Never the
 *  content itself: no log line carries a tool payload or user-authored text. */
export function contentShape(content: unknown): string {
	if (typeof content === "string") return `${content.length} chars`;
	if (!Array.isArray(content)) return content == null ? "no content" : `${typeof content} content`;
	let chars = 0;
	let images = 0;
	let hasText = false;
	const types = content.map((block) => {
		const { type, text } = (block ?? {}) as { type?: unknown; text?: unknown };
		if (typeof text === "string") {
			chars += text.length;
			if (text.trim()) hasText = true;
		}
		if (type === "image") images += 1;
		return typeof type === "string" && /^[a-z_]{1,32}$/.test(type) ? type : "?";
	});
	return `${content.length} block(s) [${types.join(",")}], ${chars} chars${images > 0 && !hasText ? ", image-only" : ""}`;
}

/** A failed read or JSON parse for a log line: the error's name, its code
 *  when it has one, and the character position the parser reports. Never the
 *  message: JSON.parse quotes the input around the error. */
export function parseErrorShape(error: unknown): string {
	if (!(error instanceof Error)) return "non-Error thrown";
	const code = (error as { code?: unknown }).code;
	const position = /\bposition (\d+)/.exec(error.message)?.[1];
	return `${error.name}${typeof code === "string" ? ` ${code}` : ""}${position === undefined ? "" : ` at position ${position}`}`;
}

let debugBytesSinceCheck = 0;
// Lines debug() wrote and the time it spent on them, process-wide, for the
// request timing lines (request-timing.ts). Counted only with DEBUG on. On
// globalThis under a versioned symbol so every loaded copy of this module
// adds to the same totals.
const DEBUG_WRITES_SYMBOL = Symbol.for("kendex.pi.claude-bridge.debug-writes.v1");

function debugWrites(): { lines: number; ms: number } {
	const host = globalThis as Record<symbol, unknown>;
	let store = host[DEBUG_WRITES_SYMBOL] as { lines: number; ms: number } | undefined;
	if (!store) {
		store = { lines: 0, ms: 0 };
		host[DEBUG_WRITES_SYMBOL] = store;
	}
	return store;
}

export function debugWriteTotals(): { lines: number; ms: number } {
	const { lines, ms } = debugWrites();
	return { lines, ms };
}

export function debug(...args: unknown[]) {
	if (!DEBUG) return;
	const started = performance.now();
	const ts = new Date().toISOString();
	const fmt = (a: unknown): string => {
		if (typeof a === "string") return a;
		if (a instanceof Error) return `${a.name}: ${a.message}${a.stack ? "\n" + a.stack : ""}`;
		// A function argument is a lazy payload: hot-path call sites (per-token
		// stream events) pass a thunk so the expensive formatting only runs when
		// DEBUG is on — fmt is only reached past the early return.
		if (typeof a === "function") return fmt((a as () => unknown)());
		return JSON.stringify(a);
	};
	// A throwing thunk or JSON.stringify (circular structure, BigInt) must not
	// escape debug() — one call site sits inside the SDK stream loop, where a
	// formatting failure would abort the user's turn exactly when they enabled
	// debugging. A failed arg degrades to a placeholder; the rest still log.
	const safeFmt = (a: unknown): string => {
		let out: string | undefined;
		try {
			out = fmt(a);
		} catch (error) {
			// The caught value's own conversion can throw too (a thrown
			// null-prototype object, a throwing toString, an Error whose
			// message is a Symbol — template interpolation would rethrow) —
			// degrade to a constant rather than let the placeholder escape.
			let reason = "formatting failed";
			try {
				reason = String(error instanceof Error ? error.message : error);
			} catch { /* keep the constant */ }
			return `[unprintable: ${reason}]`;
		}
		// JSON.stringify returns undefined (not a string) for undefined,
		// Symbol, AND objects whose toJSON returns undefined — render the
		// slot explicitly instead of letting join() silently drop it. That
		// last shape means `a` can be an arbitrary object here, and its
		// toString can throw, so this conversion needs the same guard as the
		// catch path. (A thunk that returned one of these renders as plain
		// "undefined".)
		if (out !== undefined) return out;
		if (typeof a === "function") return "undefined";
		try {
			return String(a);
		} catch {
			return "[unprintable: formatting failed]";
		}
	};
	const msg = args.map(safeFmt).join(" ");
	const line = `[${ts}] [${moduleInstanceId}] ${msg}\n`;
	debugBytesSinceCheck += line.length;
	if (debugBytesSinceCheck >= DEBUG_LOG_CHECK_BYTES) {
		debugBytesSinceCheck = 0;
		rotateDebugLog(DEBUG_LOG_PATH);
	}
	try { appendFileSync(DEBUG_LOG_PATH, line, { mode: 0o600 }); } catch { /* debug is best effort */ }
	const writes = debugWrites();
	writes.lines += 1;
	writes.ms += performance.now() - started;
}

// Per-query CLI debug capture. When CLAUDE_BRIDGE_DEBUG=1, ask the Claude Code
// CLI subprocess to write its own debug log to a file we choose, and also
// forward its stderr into our debug stream. Drops straight into the real SDK's
// Options — see @anthropic-ai/claude-agent-sdk sdk.d.ts:1245 (debug, debugFile,
// stderr). Without this, CC's internal view of the world is invisible to us
// and "No conversation found" / empty-error reports are unactionable.
let nextCliDebugSeq = 1;
export function makeCliDebugOptions(tag: string): { debug?: boolean; debugFile?: string; stderr?: (data: string) => void } {
	if (!DEBUG) return {};
	const seq = nextCliDebugSeq++;
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const logDir = cliLogDir();
	try { mkdirSync(logDir, { recursive: true, mode: 0o700 }); chmodSync(logDir, 0o700); } catch { /* ignore */ }
	pruneCliDebugLogs(logDir);
	const debugFile = join(logDir, `${ts}-${tag}-${seq}.log`);
	debug(`cli-debug: ${tag} #${seq} → ${debugFile}`);
	return {
		debug: true,
		debugFile,
		stderr: (data: string) => {
			for (const line of data.split(/\r?\n/)) {
				if (line) debug(`[cli-stderr ${tag}#${seq}] ${line}`);
			}
		},
	};
}

/** Diagnostic dump — for "should never happen" paths. Gated on the same
 *  CLAUDE_BRIDGE_DEBUG flag as debug(): the entries carry session metadata
 *  and land in a log outside any host app's retention/cleanup boundary, so
 *  a host that has not opted into debugging must get no disk write. */
export function diagDump(label: string, data: Record<string, unknown>) {
	if (!DEBUG) return;
	try {
		const ts = new Date().toISOString();
		const entry = { ts, moduleInstanceId, label, ...data };
		const path = diagLogPath();
		try { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); } catch { /* best effort */ }
		rotateDebugLog(path);
		appendFileSync(path, JSON.stringify(entry) + "\n", { mode: 0o600 });
		try { chmodSync(path, 0o600); } catch { /* best effort */ }
		debug(`DIAG: ${label} (see ${path})`);
	} catch (error) {
		debug(`DIAG FAILED: ${label}`, error);
	}
}
