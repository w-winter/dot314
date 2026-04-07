import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import type { SessionInfo } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, test } from "bun:test";

import type { PiSpawnDeps } from "../../../extensions/_shared/pi-spawn.ts";
import { buildPreviewLines, clampPreviewScrollFromBottom } from "../../../extensions/session-switch/picker.ts";
import { resolveCommandPickerAction } from "../../../extensions/session-switch/index.ts";
import {
	buildStartupRelaunchArgs,
	resolveStartupAction,
	resolveStartupSessionTarget,
} from "../../../extensions/session-switch/relaunch.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const PREPACK_SCRIPT_PATH = path.join(REPO_ROOT, "scripts/pi-package-prepack.mjs");
const SESSION_SWITCH_PACKAGE_JSON_PATH = path.join(REPO_ROOT, "packages/pi-session-switch/package.json");

const tempDirs: string[] = [];

afterEach(async () => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (!dir) continue;
		await rm(dir, { recursive: true, force: true });
	}
});

function makeDeps(input: {
	execPath?: string;
	argv0?: string;
	argv1?: string;
	existing?: string[];
	packageJsonPath?: string;
	packageJsonContent?: string;
}): PiSpawnDeps {
	const existing = new Set(input.existing ?? []);
	const packageJsonPath = input.packageJsonPath;
	const packageJsonContent = input.packageJsonContent;
	return {
		execPath: input.execPath,
		argv0: input.argv0,
		argv1: input.argv1,
		existsSync: (filePath) => existing.has(filePath),
		readFileSync: (_filePath, _encoding) => {
			if (!packageJsonPath || !packageJsonContent) {
				throw new Error("package json not configured");
			}
			return packageJsonContent;
		},
		resolvePackageJson: () => {
			if (!packageJsonPath) throw new Error("package json path missing");
			return packageJsonPath;
		},
	};
}

async function writeTempFile(rootDir: string, relativePath: string, content: string): Promise<void> {
	const filePath = path.join(rootDir, relativePath);
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, content, "utf8");
}

describe("buildPreviewLines", () => {
	test("prefers allMessagesText and keeps only the last 1200 lines", () => {
		const allMessagesText = Array.from({ length: 1205 }, (_value, index) => `line ${index}   `).join("\n");
		const session = { allMessagesText, firstMessage: "first" } as SessionInfo;

		expect(buildPreviewLines(session)).toEqual([
			...Array.from({ length: 1200 }, (_value, index) => `line ${index + 5}`),
		]);
	});

	test("falls back to firstMessage when allMessagesText is absent", () => {
		const session = { firstMessage: "hello\nworld   " } as SessionInfo;
		expect(buildPreviewLines(session)).toEqual(["hello", "world"]);
	});
});

describe("clampPreviewScrollFromBottom", () => {
	test("clamps top overscroll so paging back down stays reversible", () => {
		expect(clampPreviewScrollFromBottom(999, 20, 5)).toBe(15);
	});

	test("does not underflow below zero", () => {
		expect(clampPreviewScrollFromBottom(-3, 20, 5)).toBe(0);
	});
});

describe("buildStartupRelaunchArgs", () => {
	test("preserves non-session arguments while stripping startup and session conflict flags", () => {
		const args = buildStartupRelaunchArgs(
			["--model", "anthropic/claude-sonnet-4", "--switch-session", "--session", "old.jsonl", "-c", "--no-session", "Review this"],
			"new.jsonl",
		);

		expect(args).toEqual([
			"--model",
			"anthropic/claude-sonnet-4",
			"Review this",
			"--session",
			"new.jsonl",
		]);
	});

	test("strips --fork before appending the selected session", () => {
		const args = buildStartupRelaunchArgs(
			["--switch-session", "--fork", "old.jsonl", "--model", "anthropic/claude-sonnet-4"],
			"new.jsonl",
		);

		expect(args).toEqual([
			"--model",
			"anthropic/claude-sonnet-4",
			"--session",
			"new.jsonl",
		]);
	});
});

describe("resolveCommandPickerAction", () => {
	test("maps exit dismissals to shutdown", () => {
		expect(resolveCommandPickerAction({ kind: "dismissed", reason: "exit" })).toEqual({ kind: "shutdown" });
	});

	test("maps cancel dismissals to noop", () => {
		expect(resolveCommandPickerAction({ kind: "dismissed", reason: "cancel" })).toEqual({ kind: "noop" });
	});
});

describe("resolveStartupSessionTarget", () => {
	test("returns the selected session cwd when it exists", () => {
		const target = resolveStartupSessionTarget("/tmp/selected.jsonl", {
			readFile: (() => JSON.stringify({ type: "session", cwd: "/tmp/selected-project" }) + "\n") as any,
			exists: () => true,
			stat: (() => ({ isDirectory: () => true })) as any,
		});

		expect(target).toEqual({ cwd: "/tmp/selected-project" });
	});

	test("warns when the selected session cwd is missing", () => {
		const target = resolveStartupSessionTarget("/tmp/selected.jsonl", {
			readFile: (() => JSON.stringify({ type: "session" }) + "\n") as any,
			exists: () => true,
			stat: (() => ({ isDirectory: () => true })) as any,
		});

		expect(target).toEqual({
			warning: "Selected session does not have a recorded cwd. Use `/switch-session` or native `pi --resume` instead.",
		});
	});

	test("warns when the selected session cwd path is missing", () => {
		const target = resolveStartupSessionTarget("/tmp/selected.jsonl", {
			readFile: (() => JSON.stringify({ type: "session", cwd: "/tmp/missing-project" }) + "\n") as any,
			exists: () => false,
			stat: (() => ({ isDirectory: () => false })) as any,
		});

		expect(target).toEqual({
			warning:
				"Selected session cwd no longer exists: /tmp/missing-project. `pi --switch-session` cannot recover missing cwd state because startup switching is implemented as a relaunch. Use `/switch-session` or native `pi --resume` instead.",
		});
	});
});

describe("resolveStartupAction", () => {
	test("returns native-like exit when the picker requests cancel", () => {
		const action = resolveStartupAction(
			{ kind: "dismissed", reason: "cancel" },
			{ cwd: "/tmp/project", argvTokens: ["--switch-session"] },
		);

		expect(action).toEqual({ kind: "exit", code: 0, message: "No session selected" });
	});

	test("returns shutdown when the picker requests exit", () => {
		const action = resolveStartupAction(
			{ kind: "dismissed", reason: "exit" },
			{ cwd: "/tmp/project", argvTokens: ["--switch-session"] },
		);

		expect(action).toEqual({ kind: "shutdown" });
	});

	test("preserves the original pi invocation when relaunching into the selected session", () => {
		const argv1 = "/tmp/pi-entry.mjs";
		const deps = makeDeps({
			execPath: "/usr/local/bin/node",
			argv1,
			existing: [argv1],
		});

		const action = resolveStartupAction(
			{ kind: "selected", sessionPath: "/tmp/selected.jsonl" },
			{
				cwd: "/tmp/project",
				argvTokens: ["--switch-session", "--model", "anthropic/claude-sonnet-4"],
				spawnDeps: deps,
			},
		);

		expect(action).toEqual({
			kind: "relaunch",
			cwd: "/tmp/project",
			command: "/usr/local/bin/node",
			args: [argv1, "--model", "anthropic/claude-sonnet-4", "--session", "/tmp/selected.jsonl"],
		});
	});

	test("falls back to the current pi executable when it is identifiable", () => {
		const action = resolveStartupAction(
			{ kind: "selected", sessionPath: "/tmp/selected.jsonl" },
			{
				cwd: "/tmp/project",
				argvTokens: ["--switch-session"],
				spawnDeps: makeDeps({ argv0: "/opt/custom/bin/pi" }),
			},
		);

		expect(action).toEqual({
			kind: "relaunch",
			cwd: "/tmp/project",
			command: "/opt/custom/bin/pi",
			args: ["--session", "/tmp/selected.jsonl"],
		});
	});

	test("falls back to the packaged pi CLI when argv1 is not runnable", () => {
		const packageJsonPath = "/opt/pi/package.json";
		const cliPath = path.resolve(path.dirname(packageJsonPath), "dist/cli/index.js");
		const deps = makeDeps({
			execPath: "/usr/local/bin/node",
			argv1: "/opt/pi/not-runnable.txt",
			packageJsonPath,
			packageJsonContent: JSON.stringify({ bin: { pi: "dist/cli/index.js" } }),
			existing: [cliPath],
		});

		const action = resolveStartupAction(
			{ kind: "selected", sessionPath: "/tmp/selected.jsonl" },
			{
				cwd: "/tmp/project",
				argvTokens: ["--switch-session", "--print"],
				spawnDeps: deps,
			},
		);

		expect(action).toEqual({
			kind: "relaunch",
			cwd: "/tmp/project",
			command: "/usr/local/bin/node",
			args: [cliPath, "--print", "--session", "/tmp/selected.jsonl"],
		});
	});
});

describe("pi-package-prepack", () => {
	test("packages the foldered session-switch layout and removes stale flat artifacts", async () => {
		const tempRoot = await mkdtemp(path.join(tmpdir(), "pi-session-switch-prepack-"));
		tempDirs.push(tempRoot);

		const packageDir = path.join(tempRoot, "packages/pi-session-switch");
		await mkdir(packageDir, { recursive: true });
		await writeFile(
			path.join(packageDir, "package.json"),
			await readFile(SESSION_SWITCH_PACKAGE_JSON_PATH, "utf8"),
			"utf8",
		);

		await writeTempFile(tempRoot, "extensions/session-switch/index.ts", "export default function () {}\n");
		await writeTempFile(tempRoot, "extensions/session-switch/picker.ts", "export const picker = true;\n");
		await writeTempFile(tempRoot, "extensions/session-switch/relaunch.ts", "export const relaunch = true;\n");
		await writeTempFile(tempRoot, "extensions/session-switch/session-switch.LICENSE", "MIT\n");
		await writeTempFile(tempRoot, "extensions/_shared/pi-spawn.ts", "export const spawn = true;\n");
		await writeTempFile(tempRoot, "LICENSE", "MIT\n");
		await writeTempFile(tempRoot, "packages/pi-session-switch/extensions/session-switch.ts", "legacy flat artifact\n");
		await writeTempFile(tempRoot, "packages/pi-session-switch/extensions/session-switch.LICENSE", "legacy license\n");
		await writeTempFile(tempRoot, "packages/pi-session-switch/extensions/session-switch/stale.ts", "stale nested artifact\n");

		const result = spawnSync(process.execPath, [PREPACK_SCRIPT_PATH], {
			cwd: packageDir,
			encoding: "utf8",
		});

		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		expect(await Bun.file(path.join(packageDir, "extensions/session-switch/index.ts")).exists()).toBe(true);
		expect(await Bun.file(path.join(packageDir, "extensions/session-switch/picker.ts")).exists()).toBe(true);
		expect(await Bun.file(path.join(packageDir, "extensions/session-switch/relaunch.ts")).exists()).toBe(true);
		expect(await Bun.file(path.join(packageDir, "extensions/session-switch/session-switch.LICENSE")).exists()).toBe(true);
		expect(await Bun.file(path.join(packageDir, "extensions/_shared/pi-spawn.ts")).exists()).toBe(true);
		expect(await Bun.file(path.join(packageDir, "extensions/session-switch/stale.ts")).exists()).toBe(false);
		expect(await Bun.file(path.join(packageDir, "extensions/session-switch.ts")).exists()).toBe(false);
		expect(await Bun.file(path.join(packageDir, "extensions/session-switch.LICENSE")).exists()).toBe(false);
	});
});
