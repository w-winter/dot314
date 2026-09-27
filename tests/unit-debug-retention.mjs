// Debug artifacts are capped: the two append logs rotate by size and the
// per-query CLI logs are pruned by age and count, touching only bridge files.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

delete process.env.CLAUDE_BRIDGE_DEBUG;
const {
	CLI_LOG_MAX_AGE_MS,
	CLI_LOG_MAX_FILES,
	DEBUG_LOG_MAX_BYTES,
	DEBUG_LOG_ROTATED_FILES,
	pruneCliDebugLogs,
	rotateDebugLog,
} = await import("../src/debug.ts");

const pkgRoot = fileURLToPath(new URL("..", import.meta.url));
let dir;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "bridge-retention-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function writePrivate(path, content) {
	writeFileSync(path, content, { mode: 0o600 });
	chmodSync(path, 0o600);
}

function cliLogName(ms, seq) {
	return `${new Date(ms).toISOString().replace(/[:.]/g, "-")}-provider-${seq}.log`;
}

describe("debug log rotation", () => {
	it("rotates an oversized log and keeps a bounded number of old ones", () => {
		const log = join(dir, "claude-bridge.log");
		writePrivate(log, "current");
		truncateSync(log, DEBUG_LOG_MAX_BYTES);
		for (let i = 1; i <= DEBUG_LOG_ROTATED_FILES; i++) writePrivate(`${log}.${i}`, `old-${i}`);

		rotateDebugLog(log);

		assert.equal(existsSync(log), false);
		assert.equal(statSync(`${log}.1`).size, DEBUG_LOG_MAX_BYTES);
		assert.equal(statSync(`${log}.1`).mode & 0o777, 0o600);
		for (let i = 2; i <= DEBUG_LOG_ROTATED_FILES; i++) assert.equal(readFileSync(`${log}.${i}`, "utf8"), `old-${i - 1}`);
		assert.equal(existsSync(`${log}.${DEBUG_LOG_ROTATED_FILES + 1}`), false);
	});

	it("leaves a log under the limit alone", () => {
		const log = join(dir, "claude-bridge.log");
		writePrivate(log, "small");
		rotateDebugLog(log);
		assert.equal(readFileSync(log, "utf8"), "small");
		assert.equal(existsSync(`${log}.1`), false);
	});

	it("rotates an oversized log when debugging starts", () => {
		const log = join(dir, "debug.log");
		const diag = join(dir, "diag.log");
		for (const path of [log, diag]) {
			writePrivate(path, "");
			truncateSync(path, DEBUG_LOG_MAX_BYTES);
		}
		const script = join(dir, "probe.mjs");
		writeFileSync(script, `import { debug } from ${JSON.stringify(pathToFileURL(join(pkgRoot, "src/debug.ts")).href)};\ndebug("after start");\n`);
		execFileSync(process.execPath, ["--import", "tsx", script], {
			cwd: pkgRoot,
			env: { ...process.env, CLAUDE_BRIDGE_DEBUG: "1", CLAUDE_BRIDGE_DEBUG_PATH: log, CLAUDE_BRIDGE_DIAG_PATH: diag, PI_CODING_AGENT_DIR: join(dir, "agent") },
		});

		assert.equal(statSync(`${log}.1`).size, DEBUG_LOG_MAX_BYTES);
		assert.equal(statSync(`${diag}.1`).size, DEBUG_LOG_MAX_BYTES);
		assert.match(readFileSync(log, "utf8"), /after start/);
		assert.equal(statSync(log).mode & 0o777, 0o600);
	});
});

describe("CLI debug log pruning", () => {
	it("drops expired and excess bridge CLI logs, oldest first, and nothing else", () => {
		const logDir = join(dir, "cc-cli-logs");
		mkdirSync(logDir, { mode: 0o700 });
		const now = Date.now();
		const recent = [];
		for (let i = 0; i < CLI_LOG_MAX_FILES + 5; i++) {
			const ms = now - (i + 1) * 60_000;
			const name = cliLogName(ms, i);
			writePrivate(join(logDir, name), "x");
			utimesSync(join(logDir, name), ms / 1000, ms / 1000);
			recent.push(name);
		}
		const expiredMs = now - CLI_LOG_MAX_AGE_MS - 60_000;
		const expired = cliLogName(expiredMs, 999);
		writePrivate(join(logDir, expired), "x");
		utimesSync(join(logDir, expired), expiredMs / 1000, expiredMs / 1000);
		const unrelated = ["notes.txt", `${cliLogName(expiredMs, 1)}.bak`];
		for (const name of unrelated) {
			writePrivate(join(logDir, name), "keep");
			utimesSync(join(logDir, name), expiredMs / 1000, expiredMs / 1000);
		}

		pruneCliDebugLogs(logDir);

		const left = new Set(readdirSync(logDir));
		assert.equal(left.has(expired), false, "expired log removed");
		for (const name of recent.slice(0, CLI_LOG_MAX_FILES)) assert.ok(left.has(name), `newest kept: ${name}`);
		for (const name of recent.slice(CLI_LOG_MAX_FILES)) assert.equal(left.has(name), false, `excess removed: ${name}`);
		for (const name of unrelated) assert.ok(left.has(name), `unrelated file untouched: ${name}`);
		assert.equal(statSync(logDir).mode & 0o777, 0o700);
	});

	it("tolerates a missing directory", () => {
		assert.doesNotThrow(() => pruneCliDebugLogs(join(dir, "absent")));
	});
});
