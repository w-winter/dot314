import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { SessionEntry } from "@mariozechner/pi-coding-agent";

import { collectFilesTouched } from "./files-touched-core.ts";

function toolCall(id: string, name: string, args: Record<string, unknown>): SessionEntry {
	return {
		id: `assistant-${id}`,
		type: "message",
		message: {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id,
					name,
					arguments: args,
				},
			],
		},
	} as SessionEntry;
}

function toolResult(id: string, timestamp: number, content = "ok"): SessionEntry {
	return {
		id: `result-${id}`,
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: id,
			timestamp,
			content,
		},
	} as SessionEntry;
}

async function createRepoHarness(): Promise<{ cwd: string; externalRoot: string; cleanup: () => Promise<void> }> {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "files-touched-core-"));
	const cwd = path.join(tempRoot, "agent");
	const externalRoot = path.join(tempRoot, "pi-mono");

	await mkdir(path.join(cwd, ".git"), { recursive: true });
	await mkdir(path.join(externalRoot, ".git"), { recursive: true });

	return {
		cwd,
		externalRoot,
		cleanup: async () => rm(tempRoot, { recursive: true, force: true }),
	};
}

test("collectFilesTouched coalesces current-root relative, prefixed, and absolute spellings", async () => {
	const harness = await createRepoHarness();

	try {
		const entries = [
			toolCall("1", "read", { path: "package.json" }),
			toolResult("1", 1),
			toolCall("2", "read", { path: "agent/package.json" }),
			toolResult("2", 2),
			toolCall("3", "rp", { call: "read_file", args: { path: `${harness.cwd}/package.json` } }),
			toolResult("3", 3),
			toolCall("4", "rp", { call: "apply_edits", args: { path: "agent:package.json" } }),
			toolResult("4", 4, "Applied 1 edit"),
		] as SessionEntry[];

		const files = collectFilesTouched(entries, harness.cwd);

		assert.equal(files.length, 1);
		assert.equal(files[0].path, `${harness.cwd}/package.json`);
		assert.equal(files[0].displayPath, "package.json");
		assert.deepEqual([...files[0].operations].sort(), ["edit", "read"]);
	} finally {
		await harness.cleanup();
	}
});

test("collectFilesTouched redirects touched paths through file moves", async () => {
	const harness = await createRepoHarness();

	try {
		const entries = [
			toolCall("1", "read", { path: "extensions/files-touched-core.ts" }),
			toolResult("1", 1),
			toolCall("2", "rp", {
				call: "file_actions",
				args: {
					action: "move",
					path: "extensions/files-touched-core.ts",
					new_path: "extensions/_shared/files-touched-core.ts",
				},
			}),
			toolResult("2", 2, "moved"),
			toolCall("3", "edit", { path: "extensions/_shared/files-touched-core.ts" }),
			toolResult("3", 3, "Applied 1 edit"),
		] as SessionEntry[];

		const files = collectFilesTouched(entries, harness.cwd);

		assert.equal(files.length, 1);
		assert.equal(files[0].path, `${harness.cwd}/extensions/_shared/files-touched-core.ts`);
		assert.equal(files[0].displayPath, "extensions/_shared/files-touched-core.ts");
		assert.deepEqual([...files[0].operations].sort(), ["edit", "move", "read"]);
	} finally {
		await harness.cleanup();
	}
});

test("collectFilesTouched tracks delete operations from rp file_actions", async () => {
	const harness = await createRepoHarness();

	try {
		const entries = [
			toolCall("1", "rp", {
				call: "file_actions",
				args: {
					action: "delete",
					path: "extensions/removed-by-rp.ts",
				},
			}),
			toolResult("1", 1, "deleted"),
		] as SessionEntry[];

		const files = collectFilesTouched(entries, harness.cwd);

		assert.equal(files.length, 1);
		assert.equal(files[0].path, `${harness.cwd}/extensions/removed-by-rp.ts`);
		assert.equal(files[0].displayPath, "extensions/removed-by-rp.ts");
		assert.deepEqual([...files[0].operations], ["delete"]);
	} finally {
		await harness.cleanup();
	}
});

test("collectFilesTouched tracks delete and move operations from rp_exec commands", async () => {
	const harness = await createRepoHarness();

	try {
		const entries = [
			toolCall("1", "rp_exec", { cmd: "file move extensions/old-name.ts extensions/new-name.ts" }),
			toolResult("1", 1, "moved"),
			toolCall("2", "rp_exec", { cmd: "file delete extensions/removed.ts" }),
			toolResult("2", 2, "deleted"),
		] as SessionEntry[];

		const files = collectFilesTouched(entries, harness.cwd);

		assert.equal(files.length, 2);
		assert.equal(files[0].path, `${harness.cwd}/extensions/removed.ts`);
		assert.equal(files[0].displayPath, "extensions/removed.ts");
		assert.deepEqual([...files[0].operations], ["delete"]);
		assert.equal(files[1].path, `${harness.cwd}/extensions/new-name.ts`);
		assert.equal(files[1].displayPath, "extensions/new-name.ts");
		assert.deepEqual([...files[1].operations], ["move"]);
	} finally {
		await harness.cleanup();
	}
});

test("collectFilesTouched tracks delete and move operations from bash commands", async () => {
	const harness = await createRepoHarness();

	try {
		const entries = [
			toolCall("1", "bash", {
				command: "mv extensions/from.ts extensions/to.ts && trash extensions/trashed.ts && git rm extensions/git-removed.ts",
			}),
			toolResult("1", 1, "ok"),
		] as SessionEntry[];

		const files = collectFilesTouched(entries, harness.cwd);
		const byDisplayPath = new Map(files.map((file) => [file.displayPath, file]));

		assert.equal(files.length, 3);
		assert.equal(byDisplayPath.get("extensions/to.ts")?.path, `${harness.cwd}/extensions/to.ts`);
		assert.deepEqual([...(byDisplayPath.get("extensions/to.ts")?.operations ?? [])], ["move"]);
		assert.equal(byDisplayPath.get("extensions/trashed.ts")?.path, `${harness.cwd}/extensions/trashed.ts`);
		assert.deepEqual([...(byDisplayPath.get("extensions/trashed.ts")?.operations ?? [])], ["delete"]);
		assert.equal(byDisplayPath.get("extensions/git-removed.ts")?.path, `${harness.cwd}/extensions/git-removed.ts`);
		assert.deepEqual([...(byDisplayPath.get("extensions/git-removed.ts")?.operations ?? [])], ["delete"]);
	} finally {
		await harness.cleanup();
	}
});

test("collectFilesTouched renders external absolute paths relative to their repo root", async () => {
	const harness = await createRepoHarness();

	try {
		const externalFile = path.join(
			harness.externalRoot,
			"packages",
			"coding-agent",
			"src",
			"core",
			"extensions",
			"loader.ts",
		);
		const entries = [
			toolCall("1", "rp", { call: "read_file", args: { path: externalFile } }),
			toolResult("1", 1),
		] as SessionEntry[];

		const files = collectFilesTouched(entries, harness.cwd);

		assert.equal(files.length, 1);
		assert.equal(files[0].path, externalFile);
		assert.equal(files[0].displayPath, "pi-mono/packages/coding-agent/src/core/extensions/loader.ts");
		assert.deepEqual([...files[0].operations], ["read"]);
	} finally {
		await harness.cleanup();
	}
});
