// Agent notices are on only with `agentNotices: true` in the user
// claude-bridge.json. This turns them on for the agent directory the tests run
// under (PI_CODING_AGENT_DIR, which tests/lib/test-env.mjs always sets) while
// `run` runs, then removes the file.
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export async function withAgentNotices(run) {
	const path = join(process.env.PI_CODING_AGENT_DIR, "claude-bridge.json");
	writeFileSync(path, JSON.stringify({ agentNotices: true }));
	try {
		return await run();
	} finally {
		rmSync(path, { force: true });
	}
}
