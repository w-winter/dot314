// diagDump is gated on CLAUDE_BRIDGE_DEBUG, same as debug(). Test
// files that assert on diag entries import this module BEFORE any bridge
// module, so the flag is already set when src/debug.ts captures it at module
// load. The debug log itself is routed to a scratch dir so enabling the flag
// never appends to the real user log; the diag path is per-test state and
// stays owned by each test file's own beforeEach.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ONE tracked temp dir for BOTH disk logs: with the flag set at module
// evaluation, src/debug.ts resolves its paths eagerly, so the diag default
// must be redirected too or importing a suite could touch the real
// ~/.pi/agent before any beforeEach runs. Removed on process exit.
const debugTmpDir = mkdtempSync(join(tmpdir(), "bridge-debug-log-"));
process.on("exit", () => {
	try { rmSync(debugTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});
process.env.CLAUDE_BRIDGE_DEBUG = "1";
process.env.CLAUDE_BRIDGE_DEBUG_PATH = join(debugTmpDir, "claude-bridge.log");
process.env.CLAUDE_BRIDGE_DIAG_PATH = join(debugTmpDir, "claude-bridge-diag.log");
