// A failed connector prime must NOT be cached for the process lifetime.
// A transient failure at provider registration must not pin `{}` for the scope,
// leave later turns undeclared, or make the disk-cache fallback
// unreachable until restart. Failures now leave the key unset and the next
// prime retries — but only after a per-scope cooldown: removing the
// the cooldown there is NOTHING between "cached forever" and "one HTTPS
// request per turn", so a persistently failing account re-primed every turn.
// The inventory call also now carries an abort deadline, so a hung request
// cannot hold the pending flag open indefinitely.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readCachedConnectors } from "../src/connector-cache.ts";
import { primeConnectorServers } from "../src/connector-runtime.ts";

const realFetch = globalThis.fetch;
let root;
let configDir;
let savedPiDir;

function writeCredentials(dir) {
	writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "prime-test-token" } }));
	writeFileSync(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { organizationUuid: "org-prime" } }));
}

function okInventoryFetch() {
	return async () => ({
		ok: true,
		status: 200,
		text: async () => JSON.stringify({
			results: [{ name: "Gmail", installedServerId: "srv-1", installState: "connected" }],
		}),
	});
}

async function waitFor(predicate, timeoutMs = 1000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return predicate();
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "bridge-prime-"));
	configDir = join(root, "claude-config");
	savedPiDir = process.env.PI_CODING_AGENT_DIR;
	// Isolate the on-disk connector cache from the real user dir.
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	mkdirSync(configDir, { recursive: true });
});

afterEach(() => {
	globalThis.fetch = realFetch;
	if (savedPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedPiDir;
	rmSync(root, { recursive: true, force: true });
});

describe("primeConnectorServers failure caching (C6)", () => {
	it("retries after a transport failure instead of pinning an empty snapshot", async () => {
		writeCredentials(configDir);

		// First prime: the inventory call fails (network blip).
		let fetchCalls = 0;
		globalThis.fetch = async () => {
			fetchCalls += 1;
			throw new Error("network blip");
		};
		primeConnectorServers(configDir);
		await waitFor(() => fetchCalls >= 1);
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(readCachedConnectors(configDir), undefined, "a failed prime writes no disk cache");

		// Second prime for the SAME scope, past the failure cooldown: must
		// actually retry (the failure was not cached for the process lifetime)
		// and succeed end to end, including the disk cache write.
		globalThis.fetch = okInventoryFetch();
		primeConnectorServers(configDir, { now: () => Date.now() + 120_000 });
		const cached = await waitFor(() => readCachedConnectors(configDir) !== undefined);
		assert.ok(cached, "the retry primes and persists the inventory");
		assert.deepEqual(readCachedConnectors(configDir)?.map((entry) => entry.name), ["Gmail"]);
	});

	it("cools down after a failed inventory instead of re-priming every turn (VST-14)", async () => {
		writeCredentials(configDir);

		let fetchCalls = 0;
		globalThis.fetch = async () => {
			fetchCalls += 1;
			throw new Error("persistently down");
		};
		const t0 = 1_000_000;
		primeConnectorServers(configDir, { now: () => t0 });
		await waitFor(() => fetchCalls >= 1);
		await new Promise((resolve) => setTimeout(resolve, 20));

		// Inside the 60s cooldown window: the per-turn snapshot path calls prime
		// again, but no inventory request may go out.
		primeConnectorServers(configDir, { now: () => t0 + 30_000 });
		primeConnectorServers(configDir, { now: () => t0 + 59_999 });
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(fetchCalls, 1, "a prime inside the cooldown issues no request");

		// Cooldown elapsed: the retry goes out (and fails again, re-arming it).
		primeConnectorServers(configDir, { now: () => t0 + 60_000 });
		await waitFor(() => fetchCalls >= 2);
		assert.equal(fetchCalls, 2, "a prime after the cooldown retries");
	});

	it("bounds the inventory request with an abort deadline (VST-14)", async () => {
		writeCredentials(configDir);

		let sawSignal = false;
		let abortedAt = 0;
		let fetchCalls = 0;
		// A hung request: never settles except through the abort signal.
		globalThis.fetch = (_url, init) => {
			fetchCalls += 1;
			sawSignal = init?.signal instanceof AbortSignal;
			return new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => {
					abortedAt = Date.now();
					reject(init.signal.reason);
				});
			});
		};
		const startedAt = Date.now();
		primeConnectorServers(configDir, { timeoutMs: 50 });
		assert.ok(await waitFor(() => abortedAt > 0), "the deadline aborts a hung inventory request");
		assert.ok(sawSignal, "the inventory fetch carries an abort signal");
		assert.ok(abortedAt - startedAt >= 40, "the abort waits for the deadline");

		// The abort is a failure: the pending flag is released AND the cooldown is
		// armed, so an immediate re-prime issues no request.
		await new Promise((resolve) => setTimeout(resolve, 20));
		primeConnectorServers(configDir, { timeoutMs: 50 });
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(fetchCalls, 1, "a timed-out prime cools down like any failure");
	});

	it("retries after a missing-credentials prime once credentials appear", async () => {
		globalThis.fetch = okInventoryFetch();

		// No credential files yet: prime resolves nothing and caches nothing.
		primeConnectorServers(configDir);
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal(readCachedConnectors(configDir), undefined);

		// Credentials appear (e.g. `claude login` finished): the next prime works.
		writeCredentials(configDir);
		primeConnectorServers(configDir);
		const cached = await waitFor(() => readCachedConnectors(configDir) !== undefined);
		assert.ok(cached, "the post-login prime is not blocked by the earlier failure");
	});
});
