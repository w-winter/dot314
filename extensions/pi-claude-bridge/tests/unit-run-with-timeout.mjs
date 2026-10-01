// The shell integration suites bound each pi run with run_with_timeout from
// tests/lib/bash-setup.sh. A descendant that inherits captured output must not
// hold the caller past the bound or outlive it.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

const setup = fileURLToPath(new URL("./lib/bash-setup.sh", import.meta.url));
let dir;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "bridge-timeout-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function alive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("run_with_timeout", () => {
	it("stops the whole command, descendants included, at the bound", () => {
		const pidFile = join(dir, "descendant.pid");
		const script = [
			`source ${JSON.stringify(setup)}`,
			`if out=$(run_with_timeout 1 sh -c 'sleep 3 & echo $! > "$0"; wait' ${JSON.stringify(pidFile)} 2>&1); then rc=0; else rc=$?; fi`,
			`echo "$rc"`,
		].join("\n");
		const started = Date.now();
		const result = spawnSync("bash", ["-c", script], { encoding: "utf8", timeout: 20_000 });
		const elapsed = Date.now() - started;

		assert.ok(elapsed < 2500, `returned after ${elapsed} ms`);
		assert.equal(result.stdout.trim(), "124");
		const pid = Number(readFileSync(pidFile, "utf8"));
		assert.equal(alive(pid), false, "descendant still running");
	});
});
