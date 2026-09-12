#!/usr/bin/env node
// The bridge must clear sharedSession when Pi starts a replacement session.

console.log("=== int-session-new.mjs ===");

import { readFileSync } from "node:fs";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const TIMEOUT = 180_000;
const BRIDGE_MODEL = "pi-claude/claude-haiku-4-5";

const harness = createRpcHarness({
	name: "session-new",
	args: ["--model", BRIDGE_MODEL],
	defaultTimeout: TIMEOUT,
});

const { start, stop, send, promptAndWait, DEBUG_LOG, RPC_LOG } = harness;

let finishing = false;
function finish(code, msg) {
	if (finishing) return;
	finishing = true;
	console.log(msg);
	if (code !== 0) {
		console.log(`  RPC log:    ${RPC_LOG}`);
		console.log(`  Debug log:  ${DEBUG_LOG}`);
	}
	stop().then(() => process.exit(code));
}

start();
await new Promise((r) => setTimeout(r, 2000));

try {
	console.log("Turn 1: seed history...");
	await promptAndWait("Pick a number between 1 and 100 and remember it. Reply with just the number.");
	console.log("Turn 2: more history...");
	await promptAndWait("Now pick a color. Reply with just the color.");

	const NEW_MARKER_LOG = readFileSync(DEBUG_LOG, "utf8").length;

	console.log("Triggering /new...");
	await send({ type: "new_session" });

	console.log("Turn 3: prompt after /new (should be a clean start)...");
	await promptAndWait("Hello fresh session. Reply with just 'hi'.");

	const fullLog = readFileSync(DEBUG_LOG, "utf8");
	const postNewLog = fullLog.slice(NEW_MARKER_LOG);

	// The bridge must log that it observed the session-start event.
	if (!/session_start:new: clearing session/.test(postNewLog)) {
		finish(1, "FAIL: no `session_start:new: clearing session` marker — bridge didn't observe /new");
	}

	// The first syncResult must be a clean start (sharedSession=null,
	// no prior messages on the fresh agent state).
	const syncResults = [...postNewLog.matchAll(/syncResult: path=(reuse|rebuild|clean-start)/g)].map((m) => m[1]);
	console.log(`  Post-/new syncResults: ${JSON.stringify(syncResults)}`);
	if (syncResults.length === 0) {
		finish(1, "FAIL: no syncResult markers after /new (Turn 3 didn't reach the provider?)");
	}
	if (syncResults[0] !== "clean-start") {
		finish(1,
			`FAIL: bridge took ${syncResults[0]} path after /new — expected clean-start.\n` +
			`       sharedSession should be cleared by the session_start:new handler.`);
	}

	finish(0, "PASS");
} catch (e) {
	finish(1, `FAIL: ${e.message}\n${e.stack}`);
}
