import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { collectFilesTouched, parseCompletedCodexFileActions } from "./files-touched-core.ts";

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

function toolResult(
	id: string,
	timestamp: number,
	content: unknown = "ok",
	options: { details?: unknown; isError?: boolean } = {},
): SessionEntry {
	return {
		id: `result-${id}`,
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: id,
			timestamp,
			content,
			...(options.details === undefined ? {} : { details: options.details }),
			...(options.isError === undefined ? {} : { isError: options.isError }),
		},
	} as SessionEntry;
}

function applyPatchDetails(
	status: "success" | "partial_failure",
	result: Partial<{
		changedFiles: string[];
		createdFiles: string[];
		deletedFiles: string[];
		movedFiles: string[];
	}> = {},
): Record<string, unknown> {
	return {
		status,
		result: {
			changedFiles: [],
			createdFiles: [],
			deletedFiles: [],
			movedFiles: [],
			fuzz: 0,
			...result,
		},
	};
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

test("collectFilesTouched tracks sed -i as edit (GNU form)", async () => {
	const harness = await createRepoHarness();

	try {
		const entries = [
			toolCall("1", "bash", { command: "sed -i 's/old/new/g' src/config.ts" }),
			toolResult("1", 1, "ok"),
		] as SessionEntry[];

		const files = collectFilesTouched(entries, harness.cwd);

		assert.equal(files.length, 1);
		assert.equal(files[0].displayPath, "src/config.ts");
		assert.deepEqual([...files[0].operations], ["edit"]);
	} finally {
		await harness.cleanup();
	}
});

test("collectFilesTouched tracks sed -i as edit (BSD form with empty backup)", async () => {
	const harness = await createRepoHarness();

	try {
		const entries = [
			toolCall("1", "bash", { command: "sed -i '' 's/old/new/g' src/config.ts" }),
			toolResult("1", 1, "ok"),
		] as SessionEntry[];

		const files = collectFilesTouched(entries, harness.cwd);

		assert.equal(files.length, 1);
		assert.equal(files[0].displayPath, "src/config.ts");
		assert.deepEqual([...files[0].operations], ["edit"]);
	} finally {
		await harness.cleanup();
	}
});

test("collectFilesTouched tracks sed -i with -e flag", async () => {
	const harness = await createRepoHarness();

	try {
		const entries = [
			toolCall("1", "bash", { command: "sed -i -e 's/old/new/' -e 's/foo/bar/' src/config.ts src/utils.ts" }),
			toolResult("1", 1, "ok"),
		] as SessionEntry[];

		const files = collectFilesTouched(entries, harness.cwd);
		const byDisplay = new Map(files.map((f) => [f.displayPath, f]));

		assert.equal(files.length, 2);
		assert.ok(byDisplay.has("src/config.ts"));
		assert.ok(byDisplay.has("src/utils.ts"));
		assert.deepEqual([...(byDisplay.get("src/config.ts")?.operations ?? [])], ["edit"]);
	} finally {
		await harness.cleanup();
	}
});

test("collectFilesTouched tracks cp destination as write", async () => {
	const harness = await createRepoHarness();

	try {
		const entries = [
			toolCall("1", "bash", { command: "cp src/template.ts src/config.ts" }),
			toolResult("1", 1, "ok"),
		] as SessionEntry[];

		const files = collectFilesTouched(entries, harness.cwd);

		assert.equal(files.length, 1);
		assert.equal(files[0].displayPath, "src/config.ts");
		assert.deepEqual([...files[0].operations], ["write"]);
	} finally {
		await harness.cleanup();
	}
});

test("collectFilesTouched tracks tee as write", async () => {
	const harness = await createRepoHarness();

	try {
		const entries = [
			toolCall("1", "bash", { command: "echo hello | tee src/output.txt src/log.txt" }),
			toolResult("1", 1, "ok"),
		] as SessionEntry[];

		const files = collectFilesTouched(entries, harness.cwd);
		const byDisplay = new Map(files.map((f) => [f.displayPath, f]));

		assert.equal(files.length, 2);
		assert.ok(byDisplay.has("src/output.txt"));
		assert.ok(byDisplay.has("src/log.txt"));
		assert.deepEqual([...(byDisplay.get("src/output.txt")?.operations ?? [])], ["write"]);
	} finally {
		await harness.cleanup();
	}
});

test("collectFilesTouched tracks shell output redirections", async () => {
	const harness = await createRepoHarness();

	try {
		const entries = [
			toolCall("1", "bash", { command: 'echo "content" > src/new.ts && cat header.txt >> src/new.ts' }),
			toolResult("1", 1, "ok"),
		] as SessionEntry[];

		const files = collectFilesTouched(entries, harness.cwd);
		const byDisplay = new Map(files.map((f) => [f.displayPath, f]));

		assert.equal(files.length, 2);
		assert.deepEqual([...(byDisplay.get("src/new.ts")?.operations ?? [])], ["write"]);
		assert.deepEqual([...(byDisplay.get("header.txt")?.operations ?? [])], ["read"]);
	} finally {
		await harness.cleanup();
	}
});

test("collectFilesTouched tracks glued redirections like >file and >>file", async () => {
	const harness = await createRepoHarness();

	try {
		const entries = [
			toolCall("1", "bash", { command: "echo hello >src/a.txt && echo world >>src/b.txt" }),
			toolResult("1", 1, "ok"),
		] as SessionEntry[];

		const files = collectFilesTouched(entries, harness.cwd);
		const byDisplay = new Map(files.map((f) => [f.displayPath, f]));

		assert.equal(files.length, 2);
		assert.ok(byDisplay.has("src/a.txt"));
		assert.ok(byDisplay.has("src/b.txt"));
	} finally {
		await harness.cleanup();
	}
});

test("collectFilesTouched ignores redirections to /dev/null", async () => {
	const harness = await createRepoHarness();

	try {
		const entries = [
			toolCall("1", "bash", { command: "some-command > /dev/null" }),
			toolResult("1", 1, "ok"),
		] as SessionEntry[];

		const files = collectFilesTouched(entries, harness.cwd);

		assert.equal(files.length, 0);
	} finally {
		await harness.cleanup();
	}
});

test("collectFilesTouched tracks touch as write", async () => {
	const harness = await createRepoHarness();

	try {
		const entries = [
			toolCall("1", "bash", { command: "touch src/new-file.ts" }),
			toolResult("1", 1, "ok"),
		] as SessionEntry[];

		const files = collectFilesTouched(entries, harness.cwd);

		assert.equal(files.length, 1);
		assert.equal(files[0].displayPath, "src/new-file.ts");
		assert.deepEqual([...files[0].operations], ["write"]);
	} finally {
		await harness.cleanup();
	}
});

test("collectFilesTouched tracks patch as edit", async () => {
	const harness = await createRepoHarness();

	try {
		const entries = [
			toolCall("1", "bash", { command: "patch -p1 src/config.ts < fix.patch" }),
			toolResult("1", 1, "ok"),
		] as SessionEntry[];

		const files = collectFilesTouched(entries, harness.cwd);

		assert.equal(files.length, 1);
		assert.equal(files[0].displayPath, "src/config.ts");
		assert.deepEqual([...files[0].operations], ["edit"]);
	} finally {
		await harness.cleanup();
	}
});

test("collectFilesTouched tracks curl -o and wget -O as write", async () => {
	const harness = await createRepoHarness();

	try {
		const entries = [
			toolCall("1", "bash", {
				command: "curl -o src/schema.json https://example.com/schema.json && wget -O src/data.csv https://example.com/data.csv",
			}),
			toolResult("1", 1, "ok"),
		] as SessionEntry[];

		const files = collectFilesTouched(entries, harness.cwd);
		const byDisplay = new Map(files.map((f) => [f.displayPath, f]));

		assert.equal(files.length, 2);
		assert.ok(byDisplay.has("src/schema.json"));
		assert.ok(byDisplay.has("src/data.csv"));
		assert.deepEqual([...(byDisplay.get("src/schema.json")?.operations ?? [])], ["write"]);
		assert.deepEqual([...(byDisplay.get("src/data.csv")?.operations ?? [])], ["write"]);
	} finally {
		await harness.cleanup();
	}
});

test("collectFilesTouched tracks rsync destination as write", async () => {
	const harness = await createRepoHarness();

	try {
		const entries = [
			toolCall("1", "bash", { command: "rsync -av src/template/ src/output/" }),
			toolResult("1", 1, "ok"),
		] as SessionEntry[];

		const files = collectFilesTouched(entries, harness.cwd);

		assert.equal(files.length, 1);
		assert.equal(files[0].displayPath, "src/output");
		assert.deepEqual([...files[0].operations], ["write"]);
	} finally {
		await harness.cleanup();
	}
});

test("collectFilesTouched tracks cat, head, and tail as read", async () => {
	const harness = await createRepoHarness();

	try {
		const entries = [
			toolCall("1", "bash", { command: "cat src/config.ts" }),
			toolResult("1", 1, "const foo = 'old';"),
			toolCall("2", "bash", { command: "head -20 src/utils.ts" }),
			toolResult("2", 2, "const bar = 'original';"),
			toolCall("3", "bash", { command: "tail -5 src/header.txt" }),
			toolResult("3", 3, "line one"),
			toolCall("4", "bash", { command: "tail -n 80 src/log.txt" }),
			toolResult("4", 4, "log line"),
		] as SessionEntry[];

		const files = collectFilesTouched(entries, harness.cwd);
		const byDisplay = new Map(files.map((f) => [f.displayPath, f]));

		assert.equal(files.length, 4);
		assert.ok(byDisplay.has("src/config.ts"));
		assert.ok(byDisplay.has("src/utils.ts"));
		assert.ok(byDisplay.has("src/header.txt"));
		assert.ok(byDisplay.has("src/log.txt"));
		assert.ok(!byDisplay.has("80"));
		assert.deepEqual([...(byDisplay.get("src/config.ts")?.operations ?? [])], ["read"]);
		assert.deepEqual([...(byDisplay.get("src/utils.ts")?.operations ?? [])], ["read"]);
		assert.deepEqual([...(byDisplay.get("src/header.txt")?.operations ?? [])], ["read"]);
		assert.deepEqual([...(byDisplay.get("src/log.txt")?.operations ?? [])], ["read"]);
	} finally {
		await harness.cleanup();
	}
});

test("collectFilesTouched treats shell newlines as command separators", async () => {
	const harness = await createRepoHarness();

	try {
		const entries = [
			toolCall("1", "bash", {
				command: [
					"HOOK=src/hook-events.ndjson",
					"if [ -f \"$HOOK\" ]; then",
					"  grep -nE 'EVENT|turn_end' \"$HOOK\" | tail -n 80",
					"else",
					"  echo \"missing $HOOK\"",
					"fi",
				].join("\n"),
			}),
			toolResult("1", 1, "ok"),
		] as SessionEntry[];

		const files = collectFilesTouched(entries, harness.cwd);
		const byDisplay = new Map(files.map((f) => [f.displayPath, f]));

		assert.equal(files.length, 0);
		assert.ok(!byDisplay.has("80"));
		assert.ok(!byDisplay.has("else"));
		assert.ok(!byDisplay.has("echo"));
		assert.ok(!byDisplay.has("missing $HOOK"));
		assert.ok(!byDisplay.has("fi"));
		assert.ok(!byDisplay.has("$HOOK"));
	} finally {
		await harness.cleanup();
	}
});

test("collectFilesTouched ignores shell variable path operands", async () => {
	const harness = await createRepoHarness();

	try {
		const entries = [
			toolCall("1", "bash", {
				command: "tmp=src/generated.txt && echo content > $tmp && cat $tmp && cp src/template.ts src/$name.ts",
			}),
			toolResult("1", 1, "content"),
		] as SessionEntry[];

		const files = collectFilesTouched(entries, harness.cwd);

		assert.equal(files.length, 0);
	} finally {
		await harness.cleanup();
	}
});

test("collectFilesTouched handles heredocs without false reads from body content", async () => {
	const harness = await createRepoHarness();

	try {
		const entries = [
			toolCall("1", "bash", {
				command: [
					"cat <<'PATCH' > /tmp/demo.patch",
					"--- src/config.ts",
					"+++ src/config.ts",
					"@@ -1 +1 @@",
					'-const foo = "old";',
					'+const foo = "new";',
					"PATCH",
					"patch src/config.ts /tmp/demo.patch",
				].join("\n"),
			}),
			toolResult("1", 1, "patching file src/config.ts"),
		] as SessionEntry[];

		const files = collectFilesTouched(entries, harness.cwd);
		const byDisplay = new Map(files.map((f) => [f.displayPath, f]));

		assert.ok(byDisplay.has("src/config.ts"), "should track patch target");
		assert.deepEqual([...(byDisplay.get("src/config.ts")?.operations ?? [])], ["edit"]);
		assert.ok(!byDisplay.has("+++"), "should not track heredoc body tokens");
		assert.ok(!byDisplay.has("@@"), "should not track heredoc body tokens");
		assert.ok(!byDisplay.has("foo"), "should not track heredoc body tokens");
	} finally {
		await harness.cleanup();
	}
});

test("collectFilesTouched coalesces edit + read on the same file from mixed bash commands", async () => {
	const harness = await createRepoHarness();

	try {
		const entries = [
			toolCall("1", "bash", { command: "cat src/config.ts" }),
			toolResult("1", 1, "const foo = 'old';"),
			toolCall("2", "bash", { command: "sed -i 's/old/new/g' src/config.ts" }),
			toolResult("2", 2, "ok"),
			toolCall("3", "bash", { command: "patch -p0 src/utils.ts < fix.patch" }),
			toolResult("3", 3, "patching file src/utils.ts"),
		] as SessionEntry[];

		const files = collectFilesTouched(entries, harness.cwd);
		const byDisplay = new Map(files.map((f) => [f.displayPath, f]));

		assert.equal(files.length, 2);
		assert.deepEqual([...(byDisplay.get("src/config.ts")?.operations ?? [])].sort(), ["edit", "read"]);
		assert.deepEqual([...(byDisplay.get("src/utils.ts")?.operations ?? [])], ["edit"]);
	} finally {
		await harness.cleanup();
	}
});

test("parseCompletedCodexFileActions resolves Windows relative workdir deterministically", () => {
	const actions = parseCompletedCodexFileActions({
		toolName: "exec_command",
		toolArguments: { cmd: "cat src/index.ts", workdir: "packages/api" },
		toolResult: { isError: false },
		cwd: "C:/work",
	});

	assert.deepEqual(actions, [
		{ kind: "touch", path: "C:/work/packages/api/src/index.ts", operation: "read" },
	]);
});

test("parseCompletedCodexFileActions preserves cwd for dot-equivalent workdirs", () => {
	const dotActions = parseCompletedCodexFileActions({
		toolName: "exec_command",
		toolArguments: { cmd: "cat src/index.ts", workdir: "." },
		toolResult: { isError: false },
		cwd: "/repo",
	});
	const parentActions = parseCompletedCodexFileActions({
		toolName: "exec_command",
		toolArguments: { cmd: "cat src/index.ts", workdir: "packages/app/.." },
		toolResult: { isError: false },
		cwd: "/repo",
	});

	assert.deepEqual(dotActions, [
		{ kind: "touch", path: "/repo/src/index.ts", operation: "read" },
	]);
	assert.deepEqual(parentActions, [
		{ kind: "touch", path: "/repo/packages/src/index.ts", operation: "read" },
	]);
});

test("parseCompletedCodexFileActions clamps parent traversal at filesystem roots", () => {
	const posixActions = parseCompletedCodexFileActions({
		toolName: "exec_command",
		toolArguments: { cmd: "cat etc/hosts", workdir: ".." },
		toolResult: { isError: false },
		cwd: "/",
	});
	const windowsActions = parseCompletedCodexFileActions({
		toolName: "exec_command",
		toolArguments: { cmd: "cat Windows/System32/drivers/etc/hosts", workdir: "../.." },
		toolResult: { isError: false },
		cwd: "C:/",
	});

	assert.deepEqual(posixActions, [
		{ kind: "touch", path: "/etc/hosts", operation: "read" },
	]);
	assert.deepEqual(windowsActions, [
		{ kind: "touch", path: "C:/Windows/System32/drivers/etc/hosts", operation: "read" },
	]);
});

test("parseCompletedCodexFileActions separates patch header syntax from result paths", () => {
	const patch = [
		"*** Begin Patch",
		"*** Update File: @@scope/file.ts",
		"@@",
		"-old",
		"+new",
		"*** Update File: @@scope/old.ts",
		"*** Move to: @@scope/new.ts",
		"@@",
		" unchanged",
		"*** End Patch",
	].join("\n");
	const actions = parseCompletedCodexFileActions({
		toolName: "apply_patch",
		toolArguments: { input: patch },
		toolResult: {
			details: applyPatchDetails("success", {
				changedFiles: ["@scope/file.ts", "@scope/old.ts", "@scope/new.ts"],
				createdFiles: ["@scope/new.ts"],
				deletedFiles: ["@scope/old.ts"],
				movedFiles: ["@scope/old.ts -> @scope/new.ts"],
			}),
		},
		cwd: "/repo",
	});

	assert.deepEqual(actions, [
		{ kind: "touch", path: "/repo/@scope/file.ts", operation: "edit" },
		{ kind: "move", from: "/repo/@scope/old.ts", to: "/repo/@scope/new.ts" },
	]);
});

test("parseCompletedCodexFileActions canonicalizes Windows drive identity", () => {
	const patch = [
		"*** Begin Patch",
		"*** Update File: c:/work/src/model.ts",
		"@@",
		"-old",
		"+new",
		"*** End Patch",
	].join("\n");
	const actions = parseCompletedCodexFileActions({
		toolName: "apply_patch",
		toolArguments: { input: patch },
		toolResult: {
			details: applyPatchDetails("success", { changedFiles: ["src\\model.ts"] }),
		},
		cwd: "C:/work",
	});

	assert.deepEqual(actions, [
		{ kind: "touch", path: "C:/work/src/model.ts", operation: "edit" },
	]);
});

test("parseCompletedCodexFileActions clamps patch paths and rejects dot targets", () => {
	const clampedPatch = [
		"*** Begin Patch",
		"*** Update File: ../../target.ts",
		"@@",
		"-old",
		"+new",
		"*** End Patch",
	].join("\n");
	const dotPatch = [
		"*** Begin Patch",
		"*** Update File: .",
		"@@",
		"-old",
		"+new",
		"*** End Patch",
	].join("\n");

	assert.deepEqual(parseCompletedCodexFileActions({
		toolName: "apply_patch",
		toolArguments: { input: clampedPatch },
		toolResult: { details: applyPatchDetails("success", { changedFiles: ["/target.ts"] }) },
		cwd: "/repo",
	}), [
		{ kind: "touch", path: "/target.ts", operation: "edit" },
	]);
	assert.deepEqual(parseCompletedCodexFileActions({
		toolName: "apply_patch",
		toolArguments: { input: dotPatch },
		toolResult: { details: applyPatchDetails("success", { changedFiles: ["."] }) },
		cwd: "/repo",
	}), []);
});

test("collectFilesTouched tracks exec_command shell actions", async () => {
	const harness = await createRepoHarness();

	try {
		const entries = [
			toolCall("1", "exec_command", {
				cmd: [
					"cat docs/reference.md",
					"sed -i 's/old/new/' src/config.ts",
					"touch src/generated.ts",
					"rm src/removed.ts",
					"mv src/old.ts src/moved.ts",
				].join(" && "),
			}),
			toolResult("1", 1),
		] as SessionEntry[];

		const files = collectFilesTouched(entries, harness.cwd);
		const byDisplay = new Map(files.map((file) => [file.displayPath, file]));

		assert.deepEqual([...(byDisplay.get("docs/reference.md")?.operations ?? [])], ["read"]);
		assert.deepEqual([...(byDisplay.get("src/config.ts")?.operations ?? [])], ["edit"]);
		assert.deepEqual([...(byDisplay.get("src/generated.ts")?.operations ?? [])], ["write"]);
		assert.deepEqual([...(byDisplay.get("src/removed.ts")?.operations ?? [])], ["delete"]);
		assert.deepEqual([...(byDisplay.get("src/moved.ts")?.operations ?? [])], ["move"]);
		assert.ok(!byDisplay.has("src/old.ts"));
	} finally {
		await harness.cleanup();
	}
});

test("collectFilesTouched honors exec_command workdirs and result semantics", async () => {
	const harness = await createRepoHarness();

	try {
		const entries = [
			toolCall("1", "exec_command", { cmd: "cat src/index.ts", workdir: "packages/app" }),
			toolResult("1", 1, "exit 7", { details: { exit_code: 7 } }),
			toolCall("2", "exec_command", { cmd: "cat docs/reference.md", workdir: harness.externalRoot }),
			toolResult("2", 2),
			toolCall("3", "exec_command", { cmd: "cat docs/failed.md" }),
			toolResult("3", 3, "failed", { isError: true }),
			toolCall("4", "exec_command", {
				cmd: "cat docs/kept.md && sed -i 's/old/new/' src/noop.ts",
			}),
			toolResult("4", 4, "No changes applied"),
		] as SessionEntry[];

		const files = collectFilesTouched(entries, harness.cwd);
		const byDisplay = new Map(files.map((file) => [file.displayPath, file]));

		assert.equal(byDisplay.get("packages/app/src/index.ts")?.path, `${harness.cwd}/packages/app/src/index.ts`);
		assert.equal(
			byDisplay.get("pi-mono/docs/reference.md")?.path,
			`${harness.externalRoot}/docs/reference.md`,
		);
		assert.ok(byDisplay.has("docs/kept.md"));
		assert.ok(!byDisplay.has("docs/failed.md"));
		assert.ok(!byDisplay.has("src/noop.ts"));
	} finally {
		await harness.cleanup();
	}
});

test("collectFilesTouched tracks structured apply_patch actions", async () => {
	const harness = await createRepoHarness();

	try {
		const patch = [
			"*** Begin Patch",
			"*** Add File: @\"src/new.ts\"",
			"+new",
			"*** Add File: src/overwritten.ts",
			"+replacement",
			`*** Update File: ${harness.cwd}/src/config.ts`,
			"@@",
			"-old",
			"+new",
			"*** Delete File: src/removed.ts",
			`*** Update File: ${harness.cwd}/src/old.ts`,
			`*** Move to: ${harness.cwd}/src/moved.ts`,
			"@@",
			" unchanged",
			"*** End Patch",
		].join("\n");
		const entries = [
			toolCall("1", "apply_patch", { input: patch }),
			toolResult("1", 1, "Applied patch successfully", {
				details: applyPatchDetails("success", {
					changedFiles: [
						"src/new.ts",
						"src/overwritten.ts",
						"src/config.ts",
						"src/removed.ts",
						"src/old.ts",
						"src/moved.ts",
					],
					createdFiles: ["src/new.ts", "src/moved.ts"],
					deletedFiles: ["src/removed.ts", "src/old.ts"],
					movedFiles: ["src\\old.ts -> src\\moved.ts"],
				}),
			}),
		] as SessionEntry[];

		const files = collectFilesTouched(entries, harness.cwd);
		const byDisplay = new Map(files.map((file) => [file.displayPath, file]));

		assert.deepEqual([...(byDisplay.get("src/new.ts")?.operations ?? [])], ["write"]);
		assert.deepEqual([...(byDisplay.get("src/overwritten.ts")?.operations ?? [])], ["write"]);
		assert.deepEqual([...(byDisplay.get("src/config.ts")?.operations ?? [])], ["edit"]);
		assert.deepEqual([...(byDisplay.get("src/removed.ts")?.operations ?? [])], ["delete"]);
		assert.deepEqual([...(byDisplay.get("src/moved.ts")?.operations ?? [])], ["move"]);
		assert.ok(!byDisplay.has("src/old.ts"));
	} finally {
		await harness.cleanup();
	}
});

test("collectFilesTouched retains only completed effects from partial apply_patch failure", async () => {
	const harness = await createRepoHarness();

	try {
		const patch = [
			"*** Begin Patch",
			"*** Update File: src/applied.ts",
			"@@",
			"-old",
			"+new",
			"*** Update File: src/failed.ts",
			"@@",
			"-old",
			"+new",
			"*** Update File: src/old.ts",
			"*** Move to: src/moved.ts",
			"@@",
			" unchanged",
			"*** End Patch",
		].join("\n");
		const entries = [
			toolCall("1", "apply_patch", { input: patch }),
			toolResult("1", 1, "No changes applied", {
				isError: true,
				details: applyPatchDetails("partial_failure", {
					changedFiles: ["src/applied.ts", "src/old.ts", "src/moved.ts"],
					createdFiles: ["src/moved.ts"],
					deletedFiles: ["src/old.ts"],
					movedFiles: ["src/old.ts -> src/moved.ts"],
				}),
			}),
			toolCall("2", "apply_patch", { input: patch }),
			toolResult("2", 2, "failed", { isError: true }),
		] as SessionEntry[];

		const files = collectFilesTouched(entries, harness.cwd);

		const byDisplay = new Map(files.map((file) => [file.displayPath, file]));
		assert.equal(files.length, 2);
		assert.deepEqual([...(byDisplay.get("src/applied.ts")?.operations ?? [])], ["edit"]);
		assert.deepEqual([...(byDisplay.get("src/moved.ts")?.operations ?? [])], ["move"]);
		assert.ok(!byDisplay.has("src/failed.ts"));
	} finally {
		await harness.cleanup();
	}
});

test("parseCompletedCodexFileActions fails closed on malformed canonical records", () => {
	assert.deepEqual(parseCompletedCodexFileActions({
		toolName: "exec_command",
		toolArguments: { cmd: "cat src/index.ts", workdir: 42 },
		toolResult: { isError: false },
		cwd: "/repo",
	}), []);
	assert.deepEqual(parseCompletedCodexFileActions({
		toolName: "apply_patch",
		toolArguments: {
			input: "*** Begin Patch\n*** Update File: src/index.ts\n@@\n-old\n+new\n*** End Patch",
		},
		toolResult: {
			details: {
				status: "success",
				result: { changedFiles: ["src/index.ts"], createdFiles: [], deletedFiles: [], movedFiles: [42] },
			},
		},
		cwd: "/repo",
	}), []);
});

test("collectFilesTouched coalesces Codex and root-prefixed paths", async () => {
	const harness = await createRepoHarness();

	try {
		const entries = [
			toolCall("1", "rp", { call: "read_file", args: { path: "Project:src/model.ts" } }),
			toolResult("1", 1),
			toolCall("2", "exec_command", { cmd: "sed -i 's/old/new/' src/model.ts", workdir: "." }),
			toolResult("2", 2),
		] as SessionEntry[];

		const files = collectFilesTouched(entries, harness.cwd);

		assert.equal(files.length, 1);
		assert.equal(files[0].displayPath, "src/model.ts");
		assert.deepEqual([...files[0].operations].sort(), ["edit", "read"]);
	} finally {
		await harness.cleanup();
	}
});

test("collectFilesTouched coalesces Windows drive-letter case for Codex paths", () => {
	const entries = [
		toolCall("1", "read", { path: "C:/work/src/model.ts" }),
		toolResult("1", 1),
		toolCall("2", "exec_command", { cmd: "cat c:/work/src/model.ts" }),
		toolResult("2", 2),
	] as SessionEntry[];

	const files = collectFilesTouched(entries, "C:/work");

	assert.equal(files.length, 1);
	assert.equal(files[0].displayPath, "src/model.ts");
	assert.deepEqual([...files[0].operations], ["read"]);
});

test("collectFilesTouched coalesces Windows named-root and Codex absolute paths", () => {
	const entries = [
		toolCall("1", "rp", { call: "read_file", args: { path: "Project:src/model.ts" } }),
		toolResult("1", 1),
		toolCall("2", "exec_command", { cmd: "sed -i 's/old/new/' c:/work/src/model.ts" }),
		toolResult("2", 2),
	] as SessionEntry[];

	const files = collectFilesTouched(entries, "C:/work");

	assert.equal(files.length, 1);
	assert.equal(files[0].displayPath, "src/model.ts");
	assert.deepEqual([...files[0].operations].sort(), ["edit", "read"]);
});
