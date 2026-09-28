import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

test("unit tests run with a scratch Pi agent dir, never the user's", () => {
	const dir = process.env.PI_CODING_AGENT_DIR;
	assert.ok(dir, "PI_CODING_AGENT_DIR is unset: run `npm run test:unit`, or add `--import ./tests/lib/test-env.mjs` after `--import tsx`");
	assert.notEqual(resolve(dir), resolve(join(homedir(), ".pi", "agent")), "unit tests must not use the real ~/.pi/agent");
});
