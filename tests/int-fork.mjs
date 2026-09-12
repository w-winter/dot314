#!/usr/bin/env node
/**
 * Fork context-isolation test.
 *
 * A fork must not inherit its parent's Claude session.
 *
 * createBranchedSession copies persisted claude-bridge-session markers from the
 * parent into the fork pi.jsonl. The session_start handler must reject them.
 * The fork's first turn calls the SDK with
 * --resume parentClaudeId, which (same cwd) opened the parent's full Claude jsonl
 * on disk and exposed conversation past the fork point.
 *
 * The test establishes three secret words across three turns, forks at the
 * second user message (so fork inherits only word_A), and asks the fork what
 * words it knows. word_A must appear; word_B and word_C must NOT.
 *
 * Run with:
 *   FORK_TEST_MODEL=pi-claude/claude-haiku-4-5 node --import tsx --test tests/int-fork.mjs
 *   FORK_TEST_MODEL=openai-codex/gpt-6-astra:medium    node --import tsx --test tests/int-fork.mjs
 */

import { createRpcHarness } from "./lib/rpc-harness.mjs";

const MODEL = process.env.FORK_TEST_MODEL || "pi-claude/claude-haiku-4-5";
const [PROVIDER, MODEL_ID] = MODEL.split("/");
if (!PROVIDER || !MODEL_ID) {
	console.error(`ERROR: FORK_TEST_MODEL must be 'provider/modelId[:thinking]', got ${MODEL}`);
	process.exit(1);
}

const TIMEOUT = 240_000;

// Random per-run so the model can't memorize across runs and tests don't
// collide if multiple instances run concurrently.
const SUFFIX = Math.random().toString(36).slice(2, 6);
const WORD_A = `alpha${SUFFIX}`;
const WORD_B = `beta${SUFFIX}`;
const WORD_C = `gamma${SUFFIX}`;

const PROMPT_1 = `Remember: word_A=${WORD_A}. Reply only "ok".`;
const PROMPT_2 = `Remember: word_B=${WORD_B}. Reply only "ok".`;
const PROMPT_3 = `Remember: word_C=${WORD_C}. Reply only "ok".`;
const FORK_PROBE = `List every secret word I have asked you to remember in this conversation, separated by commas. Just the values, no labels.`;

function logStep(n, msg) {
	console.log(`\n[${n}] ${msg}`);
}

function fail(msg, harness, debugTail) {
	console.log(`\nFAIL: ${msg}`);
	console.log(`  RPC log:    ${harness.RPC_LOG}`);
	console.log(`  Debug log:  ${harness.DEBUG_LOG}`);
	if (debugTail) console.log(`  Debug tail:\n${debugTail}`);
	harness.stop().then(() => process.exit(1));
}

async function main() {
	const harness = createRpcHarness({
		name: `fork-${PROVIDER.replace(/[^a-z0-9]/gi, "-")}-${MODEL_ID.replace(/[^a-z0-9]/gi, "-")}`,
		args: ["--model", MODEL],
		defaultTimeout: TIMEOUT,
	});
	const { send, promptAndWait, waitForEvent } = harness;

	console.log(`=== int-fork.mjs (${MODEL}) ===`);
	console.log(`Words: ${WORD_A} / ${WORD_B} / ${WORD_C}`);

	harness.start();
	await new Promise((r) => setTimeout(r, 2000));
	await waitForEvent("agent_idle", 30_000).catch(() => {});

	// --- Establish parent ---
	logStep(1, "Parent turn 1 (introduce word_A)");
	const t1 = await promptAndWait(PROMPT_1);
	console.log(`    response: ${t1.slice(0, 80)}`);

	logStep(2, "Parent turn 2 (introduce word_B)");
	const t2 = await promptAndWait(PROMPT_2);
	console.log(`    response: ${t2.slice(0, 80)}`);

	logStep(3, "Parent turn 3 (introduce word_C)");
	const t3 = await promptAndWait(PROMPT_3);
	console.log(`    response: ${t3.slice(0, 80)}`);

	// --- Fork before turn 2 ---
	logStep(4, "Listing fork-eligible user messages");
	const forkList = await send({ type: "get_fork_messages" });
	console.log(`    ${forkList.messages.length} eligible message(s):`);
	for (const m of forkList.messages) console.log(`      ${m.entryId}  ${m.text.slice(0, 60)}`);

	const targetMsg = forkList.messages.find((m) => m.text.includes(WORD_B));
	if (!targetMsg) fail(`Could not find user message containing ${WORD_B} in fork list`, harness);

	logStep(5, `Forking at message containing word_B (entryId=${targetMsg.entryId})`);
	const forkResult = await send({ type: "fork", entryId: targetMsg.entryId });
	if (forkResult.cancelled) fail("Fork was cancelled by an extension", harness);
	console.log(`    fork OK; editor prefilled with: ${(forkResult.text || "").slice(0, 60)}`);

	// --- Probe fork: must see word_A only ---
	logStep(6, "Fork probe: ask what words I taught it");
	const tFork = await promptAndWait(FORK_PROBE);
	console.log(`    response: ${tFork.slice(0, 200)}`);
	const lower = tFork.toLowerCase();
	const sawA = lower.includes(WORD_A);
	const sawB = lower.includes(WORD_B);
	const sawC = lower.includes(WORD_C);

	console.log(`    saw word_A=${sawA} word_B=${sawB} word_C=${sawC}`);

	if (!sawA) fail(`Fork lost ${WORD_A} from inherited history (response: ${tFork})`, harness);
	if (sawB) fail(`LEAK: Fork response contains ${WORD_B} which was the fork point — should not be inherited`, harness);
	if (sawC) fail(`LEAK: Fork response contains ${WORD_C} which is past the fork point — pre-fix bug regression`, harness);

	console.log(`\nPASS (${MODEL}): fork inherited word_A only; ${WORD_B}/${WORD_C} correctly absent.`);
	await harness.stop();
	process.exit(0);
}

main().catch((e) => {
	console.error(`\nFAIL: unexpected error: ${e.message}`);
	console.error(e.stack);
	process.exit(1);
});
