// Preloaded by `npm run test:unit` (and inherited by each test file's process).
// Every bridge default path hangs off piUserDir(), so pointing
// PI_CODING_AGENT_DIR at a scratch dir keeps unit tests off the real
// ~/.pi/agent: its claude-bridge.json cannot change results, and a log
// written after a test deleted its own path override (a query teardown that
// outlives afterEach) lands here instead of the user's diag log.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.PI_CODING_AGENT_DIR) {
	const dir = mkdtempSync(join(tmpdir(), "bridge-unit-agent-"));
	process.env.PI_CODING_AGENT_DIR = dir;
	process.on("exit", () => {
		try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
	});
}
