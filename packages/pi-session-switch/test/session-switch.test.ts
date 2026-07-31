import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import type { PiSpawnDeps } from "../../../extensions/_shared/pi-spawn.ts";
import {
	buildPreviewLinesFromText,
	LazySessionPreviewCache,
	buildSessionPreviewHelpLine,
	clampPreviewScrollFromBottom,
	formatSessionModifiedTimestamp,
	normalizeSessionPath,
} from "../../../extensions/session-switch/picker.ts";
import { resolveCommandPickerAction } from "../../../extensions/session-switch/index.ts";
import {
	buildStartupRelaunchArgs,
	readBoundedFirstLine,
	resolveStartupAction,
	resolveStartupSessionTarget,
} from "../../../extensions/session-switch/relaunch.ts";
import {
	discoverSessionFiles,
	getSessionDiscoveryTargets,
	listScannedSessions,
	loadSessionPreviewText,
	mapWithConcurrency,
	type ScannedSession,
	type SessionFileCandidate,
} from "../../../extensions/session-switch/session-scanner.ts";
import {
	SessionStreamController,
	type SessionListPort,
	type SessionStreamBackend,
} from "../../../extensions/session-switch/session-stream.ts";

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

describe("buildPreviewLinesFromText", () => {
	test("keeps only the last 1200 lines", () => {
		const text = Array.from({ length: 1205 }, (_value, index) => `line ${index}   `).join("\n");
		expect(buildPreviewLinesFromText(text)).toEqual([
			...Array.from({ length: 1200 }, (_value, index) => `line ${index + 5}`),
		]);
	});

	test("trims trailing whitespace", () => {
		expect(buildPreviewLinesFromText("hello\nworld   ")).toEqual(["hello", "world"]);
	});
});

describe("formatSessionModifiedTimestamp", () => {
	test("formats modified time with zero-padded local date and time fields", () => {
		const modified = new Date(2024, 0, 2, 3, 4, 5);

		expect(formatSessionModifiedTimestamp(modified)).toBe("2024-01-02 03:04:05");
	});
});

describe("buildSessionPreviewHelpLine", () => {
	const timestamp = "2024-01-02 03:04:05";

	test("right-aligns the timestamp when the help text fits", () => {
		expect(buildSessionPreviewHelpLine("help", timestamp, 26)).toBe("help   2024-01-02 03:04:05");
	});

	test("truncates help text before the timestamp", () => {
		const line = buildSessionPreviewHelpLine("scroll preview help", timestamp, timestamp.length + 3);

		expect(visibleWidth(line)).toBe(timestamp.length + 3);
		expect(line.endsWith(timestamp)).toBe(true);
		expect(line.includes("scroll preview help")).toBe(false);
	});

	test("shows only the full timestamp when width exactly fits it", () => {
		expect(buildSessionPreviewHelpLine("help", timestamp, timestamp.length)).toBe(timestamp);
	});

	test("truncates help text when no timestamp is available", () => {
		expect(buildSessionPreviewHelpLine("scroll preview help", undefined, 6).replaceAll("\x1b[0m", "")).toBe("scroll");
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

describe("normalizeSessionPath", () => {
	test("normalizes a relative active-session path into scanner path identity", () => {
		expect(normalizeSessionPath("relative-sessions/active.jsonl")).toBe(
			path.resolve("relative-sessions/active.jsonl"),
		);
		expect(normalizeSessionPath(undefined)).toBeUndefined();
	});
});

function sessionHeader(id: string, cwd: string, timestamp: string, parentSession?: string): Record<string, unknown> {
	return { type: "session", version: 3, id, timestamp, cwd, ...(parentSession ? { parentSession } : {}) };
}

function messageEntry(
	id: string,
	role: string,
	content: unknown,
	timestamp: string,
	messageTimestamp?: number,
): Record<string, unknown> {
	return {
		id,
		parentId: null,
		timestamp,
		type: "message",
		message: { role, content, ...(messageTimestamp === undefined ? {} : { timestamp: messageTimestamp }) },
	};
}

async function writeSessionFile(filePath: string, entries: readonly Record<string, unknown>[]): Promise<void> {
	await writeFile(filePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

function comparableSession(session: SessionInfo): Record<string, unknown> {
	return {
		path: session.path,
		id: session.id,
		cwd: session.cwd,
		name: session.name,
		parentSessionPath: session.parentSessionPath,
		created: Number.isNaN(session.created.getTime()) ? "invalid" : session.created.getTime(),
		modified: session.modified.getTime(),
		messageCount: session.messageCount,
		firstMessage: session.firstMessage,
	};
}

function makeScannedSession(pathname: string, modified: number): ScannedSession {
	return {
		path: pathname,
		id: pathname,
		cwd: "/project",
		created: new Date(modified),
		modified: new Date(modified),
		messageCount: 1,
		firstMessage: `first ${pathname}`,
		lastMessage: `last ${pathname}`,
		allMessagesText: `first ${pathname} last ${pathname}`,
	};
}

function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
} {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

async function settleBackgroundWork(): Promise<void> {
	await Bun.sleep(10);
}

describe("mapWithConcurrency", () => {
	test("waits for in-flight workers before rejecting and starts no new work", async () => {
		const failedWorker = deferred<void>();
		const survivingWorker = deferred<void>();
		const started: number[] = [];
		const result = mapWithConcurrency([0, 1, 2], 2, async (item) => {
			started.push(item);
			if (item === 0) await failedWorker.promise;
			if (item === 1) await survivingWorker.promise;
			return item;
		}).then(
			() => ({ kind: "resolved" as const }),
			(error: unknown) => ({ kind: "rejected" as const, error }),
		);
		let settled = false;
		void result.then(() => { settled = true; });
		failedWorker.reject(new Error("worker failed"));
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(started).toEqual([0, 1]);
		survivingWorker.resolve();
		const outcome = await result;
		expect(outcome.kind).toBe("rejected");
		if (outcome.kind === "rejected") expect(outcome.error).toEqual(new Error("worker failed"));
		expect(started).toEqual([0, 1]);
	});
});

describe("session scanner", () => {
	test("matches SessionManager metadata while keeping only first and last searchable text", async () => {
		const tempRoot = await mkdtemp(path.join(tmpdir(), "session-scanner-"));
		tempDirs.push(tempRoot);
		const projectDir = path.join(tempRoot, "project");
		const sessionDir = path.join(tempRoot, "sessions");
		await mkdir(projectDir, { recursive: true });
		await mkdir(sessionDir, { recursive: true });

		const activePath = path.join(sessionDir, "active.jsonl");
		const idlePath = path.join(sessionDir, "idle.jsonl");
		const invalidTimePath = path.join(sessionDir, "invalid-time.jsonl");
		const spacedImportPath = path.join(sessionDir, "spaced-import.jsonl");
		const customEntryPath = path.join(sessionDir, "custom-entry.jsonl");
		const malformedPrefixPath = path.join(sessionDir, "malformed-prefix.jsonl");
		const repeatedTypePath = path.join(sessionDir, "repeated-type.jsonl");
		await writeSessionFile(activePath, [
			sessionHeader("active", projectDir, "2024-01-01T00:00:00.000Z"),
			messageEntry("u1", "user", "first request", "2024-01-01T00:00:01.000Z", 1_000),
			messageEntry("a1", "assistant", "middle answer", "2024-01-01T00:00:02.000Z", 2_000),
			messageEntry("a2", "assistant", [{ type: "text", text: "final text" }], "2024-01-01T00:00:03.000Z", 3_000),
			messageEntry("a3", "assistant", [{ type: "tool_use", id: "tool", name: "read", input: {} }], "2024-01-01T00:00:04.000Z", 4_000),
			messageEntry("u2", "user", [{ type: "tool_result", tool_use_id: "tool", content: "ok" }], "2024-01-01T00:00:05.000Z", 5_000),
			{ type: "session_info", id: "i1", parentId: null, timestamp: "2024-01-01T00:00:06.000Z", name: "Named" },
			{ type: "session_info", id: "i2", parentId: null, timestamp: "2024-01-01T00:00:07.000Z", name: " " },
		]);
		await writeSessionFile(idlePath, [
			sessionHeader("idle", projectDir, "2024-02-01T00:00:00.000Z", activePath),
		]);
		await writeSessionFile(invalidTimePath, [sessionHeader("invalid", projectDir, "not-a-date")]);
		await writeSessionFile(customEntryPath, [
			sessionHeader("custom", projectDir, "2024-02-02T00:00:00.000Z"),
			{
				type: "custom",
				id: "custom-1",
				parentId: null,
				timestamp: "2024-02-02T00:00:01.000Z",
				customType: "fixture",
				data: {
					type: "message",
					message: { role: "user", content: "nested text", timestamp: 99_000 },
					session_info: { name: "Nested name" },
				},
			},
		]);
		await writeFile(
			malformedPrefixPath,
			`${JSON.stringify({ type: "message", message: { role: "user", content: "prefix" } })} trailing\n` +
				`${JSON.stringify(sessionHeader("prefixed", projectDir, "2024-02-03T00:00:00.000Z"))}\n`,
			"utf8",
		);
		const repeatedTypeText = Array.from({ length: 2_000 }, () => '{"type":"nested"}').join(" ");
		await writeSessionFile(repeatedTypePath, [
			sessionHeader("repeated-type", projectDir, "2024-02-04T00:00:00.000Z"),
			messageEntry("repeated-user", "user", repeatedTypeText, "2024-02-04T00:00:01.000Z", 7_000),
		]);
		const spacedEntries = [
			sessionHeader("spaced", projectDir, "2024-03-01T00:00:00.000Z"),
			messageEntry("su1", "user", "spaced request", "2024-03-01T00:00:01.000Z", 6_000),
			{ id: "si1", parentId: null, timestamp: "2024-03-01T00:00:02.000Z", type: "session_info", name: "Spaced" },
		];
		await writeFile(
			spacedImportPath,
			`${spacedEntries.map((entry) => JSON.stringify(entry).replaceAll("\":", "\": ")).join("\n")}\n`,
			"utf8",
		);
		await utimes(invalidTimePath, new Date(10_000), new Date(10_000));

		const upstream = await SessionManager.list(projectDir, sessionDir);
		const scanned = await listScannedSessions({ kind: "directory", directoryPath: sessionDir });
		expect(scanned.map(comparableSession).sort((left, right) => String(left.path).localeCompare(String(right.path))))
			.toEqual(upstream.map(comparableSession).sort((left, right) => String(left.path).localeCompare(String(right.path))));

		const active = scanned.find((session) => session.path === activePath)!;
		expect(active.modified.getTime()).toBe(5_000);
		expect(active.lastMessage).toBe("final text");
		expect(active.allMessagesText).toBe("first request final text");
		expect(upstream.find((session) => session.path === activePath)?.allMessagesText).toBe(
			"first request middle answer final text",
		);
		expect(active.name).toBeUndefined();
		expect(active.messageCount).toBe(5);
		const spacedImport = scanned.find((session) => session.path === spacedImportPath)!;
		expect(spacedImport).toMatchObject({ name: "Spaced", messageCount: 1, firstMessage: "spaced request" });
		const customEntry = scanned.find((session) => session.path === customEntryPath)!;
		expect(customEntry).toMatchObject({ messageCount: 0, firstMessage: "(no messages)", lastMessage: "", name: undefined });
		const malformedPrefix = scanned.find((session) => session.path === malformedPrefixPath)!;
		expect(malformedPrefix).toMatchObject({ messageCount: 0, firstMessage: "(no messages)", lastMessage: "" });
		const repeatedType = scanned.find((session) => session.path === repeatedTypePath)!;
		expect(repeatedType).toMatchObject({ messageCount: 1, firstMessage: repeatedTypeText, lastMessage: repeatedTypeText });
		expect(await loadSessionPreviewText(malformedPrefixPath)).toBe("");
		expect(await loadSessionPreviewText(activePath)).toBe("first request middle answer final text");
	});

	test("pairs current and all targets for default and custom session directories", () => {
		const agentDir = "/tmp/pi-agent";
		const cwd = "/project";
		const defaultDir = "/tmp/pi-agent/sessions/--project--";
		expect(getSessionDiscoveryTargets(defaultDir, cwd, agentDir)).toEqual({
			current: { kind: "directory", directoryPath: defaultDir },
			all: { kind: "sessions-root", sessionsRootPath: "/tmp/pi-agent/sessions" },
		});
		expect(getSessionDiscoveryTargets("", cwd, agentDir)).toEqual({
			current: { kind: "directory", directoryPath: defaultDir },
			all: { kind: "sessions-root", sessionsRootPath: "/tmp/pi-agent/sessions" },
		});
		const customDir = "/tmp/custom-sessions";
		expect(getSessionDiscoveryTargets(customDir, cwd, agentDir)).toEqual({
			current: { kind: "cwd-directory", directoryPath: customDir, resolvedCwd: cwd },
			all: { kind: "directory", directoryPath: customDir },
		});
		const directChildCustomDir = "/tmp/pi-agent/sessions/shared";
		expect(getSessionDiscoveryTargets(directChildCustomDir, cwd, agentDir)).toEqual({
			current: { kind: "cwd-directory", directoryPath: directChildCustomDir, resolvedCwd: cwd },
			all: { kind: "directory", directoryPath: directChildCustomDir },
		});
	});

	test("filters current scope but not all scope in a shared custom directory", async () => {
		const tempRoot = await mkdtemp(path.join(tmpdir(), "pi-custom-session-dir-"));
		tempDirs.push(tempRoot);
		const currentCwd = path.join(tempRoot, "project-a");
		const otherCwd = path.join(tempRoot, "project-b");
		const sessionDir = path.join(tempRoot, "shared-sessions");
		await mkdir(sessionDir, { recursive: true });
		await writeSessionFile(path.join(sessionDir, "a.jsonl"), [
			sessionHeader("a", currentCwd, "2024-01-01T00:00:00.000Z"),
		]);
		await writeSessionFile(path.join(sessionDir, "b.jsonl"), [
			sessionHeader("b", otherCwd, "2024-01-02T00:00:00.000Z"),
		]);
		const targets = getSessionDiscoveryTargets(sessionDir, currentCwd, path.join(tempRoot, "agent"));

		const current = await listScannedSessions(targets.current);
		const all = await listScannedSessions(targets.all);
		expect(current.map((session) => session.id)).toEqual(["a"]);
		expect(all.map((session) => session.id).sort()).toEqual(["a", "b"]);
	});

	test("discovers only immediate project session files in all scope", async () => {
		const sessionsRoot = await mkdtemp(path.join(tmpdir(), "pi-session-root-"));
		tempDirs.push(sessionsRoot);
		await writeTempFile(sessionsRoot, "project-a/a.jsonl", "a");
		await writeTempFile(sessionsRoot, "project-b/b.jsonl", "b");
		await writeTempFile(sessionsRoot, "stray.jsonl", "stray");
		await writeTempFile(sessionsRoot, "project-a/nested/nested.jsonl", "nested");
		await utimes(path.join(sessionsRoot, "project-a/a.jsonl"), new Date(1_000), new Date(1_000));
		await utimes(path.join(sessionsRoot, "project-b/b.jsonl"), new Date(2_000), new Date(2_000));

		const candidates = await discoverSessionFiles({ kind: "sessions-root", sessionsRootPath: sessionsRoot });
		expect(candidates.map((candidate) => path.relative(sessionsRoot, candidate.path))).toEqual([
			path.join("project-b", "b.jsonl"),
			path.join("project-a", "a.jsonl"),
		]);
	});
});

describe("readBoundedFirstLine", () => {
	test("stops after the first chunk containing a newline and closes once", () => {
		const source = Buffer.from(`${JSON.stringify({ type: "session", cwd: "/tmp/project" })}\n${"x".repeat(20_000)}`);
		let position = 0;
		let reads = 0;
		let closes = 0;
		const firstLine = readBoundedFirstLine("session.jsonl", {
			open: () => 1,
			read: (_fd, buffer, offset, length) => {
				reads += 1;
				const bytes = source.subarray(position, position + length);
				bytes.copy(buffer, offset);
				position += bytes.length;
				return bytes.length;
			},
			close: () => {
				closes += 1;
			},
		});
		expect(JSON.parse(firstLine)).toEqual({ type: "session", cwd: "/tmp/project" });
		expect(reads).toBe(1);
		expect(closes).toBe(1);
	});

	test("accepts EOF without a newline and rejects an oversized line", () => {
		const readFrom = (source: Buffer) => {
			let position = 0;
			return readBoundedFirstLine("session.jsonl", {
				open: () => 1,
				read: (_fd, buffer, offset, length) => {
					const bytes = source.subarray(position, position + length);
					bytes.copy(buffer, offset);
					position += bytes.length;
					return bytes.length;
				},
				close: () => {},
			});
		};
		expect(readFrom(Buffer.from("header"))).toBe("header");
		expect(readFrom(Buffer.concat([Buffer.alloc(1024 * 1024, 0x78), Buffer.from("\n")]))).toHaveLength(1024 * 1024);
		expect(() => readFrom(Buffer.alloc(1024 * 1024 + 1, 0x78))).toThrow("Session header exceeds");
	});
});

describe("LazySessionPreviewCache", () => {
	test("debounces selection and reuses cached text", async () => {
		const calls: string[] = [];
		const cache = new LazySessionPreviewCache({
			loadText: async (sessionPath) => {
				calls.push(sessionPath);
				return `preview ${sessionPath}`;
			},
			onChange: () => {},
			onError: () => {},
			debounceMs: 15,
		});
		cache.select("a");
		cache.select("b");
		await Bun.sleep(25);
		expect(calls).toEqual(["b"]);
		expect(cache.getSnapshot("b", []).lines).toEqual(["preview b"]);
		cache.select("a");
		await Bun.sleep(20);
		cache.select("b");
		expect(calls).toEqual(["b", "a"]);
		cache.dispose();
	});

	test("ignores stale and post-disposal completions", async () => {
		const pendingA = deferred<string>();
		const pendingB = deferred<string>();
		const changes: string[] = [];
		const signals = new Map<string, AbortSignal>();
		const cache = new LazySessionPreviewCache({
			loadText: (sessionPath, signal) => {
				signals.set(sessionPath, signal);
				return sessionPath === "a" ? pendingA.promise : pendingB.promise;
			},
			onChange: (sessionPath) => changes.push(sessionPath),
			onError: () => {},
			debounceMs: 0,
		});
		cache.select("a");
		await Bun.sleep(1);
		cache.select("b");
		expect(signals.get("a")?.aborted).toBe(true);
		pendingA.resolve("stale");
		await Bun.sleep(1);
		expect(changes).toEqual([]);
		cache.dispose();
		pendingB.resolve("late");
		await Bun.sleep(1);
		expect(changes).toEqual([]);
	});

	test("caches a current error and reports it only once", async () => {
		let calls = 0;
		const errors: string[] = [];
		const cache = new LazySessionPreviewCache({
			loadText: async (sessionPath) => {
				calls += 1;
				if (sessionPath === "broken") throw new Error("cannot read preview");
				return sessionPath;
			},
			onChange: () => {},
			onError: (_path, error) => errors.push(error.message),
			maxEntries: 2,
			debounceMs: 0,
		});
		cache.select("broken");
		await Bun.sleep(2);
		expect(cache.getSnapshot("broken", ["fallback"])).toMatchObject({
			kind: "error",
			lines: ["fallback"],
			message: "cannot read preview",
		});
		for (const path of ["other-a", "other-b", "other-c"]) {
			cache.select(path);
			await Bun.sleep(2);
		}
		cache.select("broken");
		expect(cache.getSnapshot("broken", ["fallback"])).toMatchObject({
			kind: "error",
			message: "cannot read preview",
		});
		expect(calls).toBe(4);
		expect(errors).toEqual(["cannot read preview"]);
		cache.dispose();
	});

	test("uses the scanned last message while full preview hydration is pending", () => {
		const cache = new LazySessionPreviewCache({
			loadText: () => new Promise(() => {}),
			onChange: () => {},
			onError: () => {},
			debounceMs: 1_000,
		});
		const session = makeScannedSession("a", 1);
		session.firstMessage = "first message";
		session.lastMessage = "last message";
		cache.select(session.path);
		expect(cache.getSnapshot(session.path, buildPreviewLinesFromText(session.lastMessage)).lines).toEqual(["last message"]);
		cache.dispose();
	});

	test("evicts the least recently used preview", async () => {
		const calls: string[] = [];
		const cache = new LazySessionPreviewCache({
			loadText: async (sessionPath) => {
				calls.push(sessionPath);
				return sessionPath;
			},
			onChange: () => {},
			onError: () => {},
			maxEntries: 2,
			debounceMs: 0,
		});
		for (const sessionPath of ["a", "b", "a", "c", "b"]) {
			cache.select(sessionPath);
			await Bun.sleep(2);
		}
		expect(calls).toEqual(["a", "b", "c", "b"]);
		cache.dispose();
	});
});

describe("SessionStreamController", () => {
	test("aborts the initial generation when scanning fails", async () => {
		let scanSignal: AbortSignal | undefined;
		const controller = new SessionStreamController({
			targets: {
				current: { kind: "directory", directoryPath: "/current" },
				all: { kind: "directory", directoryPath: "/current" },
			},
			syncSessions: () => {},
			requestRender: () => {},
			backend: {
				discover: async () => [{ path: "broken", priorityMtimeMs: 1 }],
				scan: async (_batch, options) => {
					scanSignal = options.signal;
					throw new Error("initial scan failed");
				},
				yieldControl: () => Promise.resolve(),
			},
		});
		await expect(controller.load("current")).rejects.toThrow("initial scan failed");
		expect(scanSignal?.aborted).toBe(true);
		controller.dispose();
	});

	test("serializes scan batches across current and all scopes", async () => {
		const currentCandidates = Array.from({ length: 31 }, (_value, index) => ({
			path: `current-${index}`,
			priorityMtimeMs: 31 - index,
		}));
		const allCandidates = [{ path: "all-0", priorityMtimeMs: 1 }];
		const currentBackgroundStarted = deferred<void>();
		const currentBackgroundGate = deferred<void>();
		let activeScans = 0;
		let maxActiveScans = 0;
		let allScanStarted = false;
		const controller = new SessionStreamController({
			targets: {
				current: { kind: "directory", directoryPath: "/current" },
				all: { kind: "sessions-root", sessionsRootPath: "/all" },
			},
			syncSessions: () => {},
			requestRender: () => {},
			backend: {
				discover: async (target) => target.kind === "sessions-root" ? allCandidates : currentCandidates,
				scan: async (batch) => {
					activeScans += 1;
					maxActiveScans = Math.max(maxActiveScans, activeScans);
					try {
						if (batch[0]?.path === "current-30") {
							currentBackgroundStarted.resolve();
							await currentBackgroundGate.promise;
						}
						if (batch[0]?.path === "all-0") allScanStarted = true;
						return batch.map((candidate) => makeScannedSession(candidate.path, candidate.priorityMtimeMs));
					} finally {
						activeScans -= 1;
					}
				},
				yieldControl: () => Promise.resolve(),
			},
		});
		await controller.load("current");
		await currentBackgroundStarted.promise;
		const allLoad = controller.load("all");
		await Promise.resolve();
		expect(allScanStarted).toBe(false);
		expect(maxActiveScans).toBe(1);
		currentBackgroundGate.resolve();
		await allLoad;
		expect(allScanStarted).toBe(true);
		expect(maxActiveScans).toBe(1);
		controller.dispose();
	});

	test("skips a queued cross-scope scan after disposal", async () => {
		const currentCandidates = Array.from({ length: 31 }, (_value, index) => ({
			path: `current-${index}`,
			priorityMtimeMs: 31 - index,
		}));
		const currentBackgroundStarted = deferred<void>();
		const currentBackgroundGate = deferred<void>();
		let allScanStarted = false;
		const controller = new SessionStreamController({
			targets: {
				current: { kind: "directory", directoryPath: "/current" },
				all: { kind: "sessions-root", sessionsRootPath: "/all" },
			},
			syncSessions: () => {},
			requestRender: () => {},
			backend: {
				discover: async (target) => target.kind === "sessions-root"
					? [{ path: "all-0", priorityMtimeMs: 1 }]
					: currentCandidates,
				scan: async (batch) => {
					if (batch[0]?.path === "current-30") {
						currentBackgroundStarted.resolve();
						await currentBackgroundGate.promise;
					}
					if (batch[0]?.path === "all-0") allScanStarted = true;
					return batch.map((candidate) => makeScannedSession(candidate.path, candidate.priorityMtimeMs));
				},
				yieldControl: () => Promise.resolve(),
			},
		});
		await controller.load("current");
		await currentBackgroundStarted.promise;
		const allLoad = controller.load("all");
		await Promise.resolve();
		controller.dispose();
		currentBackgroundGate.resolve();
		await expect(allLoad).rejects.toThrow("Session stream cancelled");
		expect(allScanStarted).toBe(false);
	});

	test("returns the initial array before background completion and mutates that same array", async () => {
		const candidates = Array.from({ length: 32 }, (_value, index) => ({
			path: `session-${index}`,
			priorityMtimeMs: 32 - index,
		}));
		const gate = deferred<void>();
		let firstYield = true;
		const backend: SessionStreamBackend = {
			discover: async () => candidates,
			scan: async (batch) => batch.map((candidate) => makeScannedSession(candidate.path, candidate.priorityMtimeMs)),
			yieldControl: () => {
				if (!firstYield) return Promise.resolve();
				firstYield = false;
				return gate.promise;
			},
		};
		const publications: SessionInfo[][] = [];
		const sessionList: SessionListPort = {
			setSessions(sessions) {
				publications.push(sessions);
			},
		};
		const controller = new SessionStreamController({
			targets: {
				current: { kind: "directory", directoryPath: "/current" },
				all: { kind: "sessions-root", sessionsRootPath: "/all" },
			},
			syncSessions: () => {},
			requestRender: () => {},
			backend,
		});
		controller.attach(sessionList);
		const sessions = await controller.load("current");
		sessionList.setSessions(sessions, false);
		expect(sessions).toHaveLength(30);
		gate.resolve();
		await settleBackgroundWork();
		expect(sessions).toHaveLength(32);
		expect(publications.at(-1)).toBe(sessions);
		controller.dispose();
	});

	test("keeps every streamed publication sorted by exact modified time", async () => {
		const candidates = Array.from({ length: 62 }, (_value, index) => ({
			path: `session-${index}`,
			priorityMtimeMs: 62 - index,
		}));
		const backgroundGate = deferred<void>();
		const backgroundComplete = deferred<void>();
		const publicationTimes: number[][] = [];
		let firstYield = true;
		let renderCount = 0;
		const sessionList: SessionListPort = {
			setSessions(sessions) {
				publicationTimes.push(sessions.map((session) => session.modified.getTime()));
			},
		};
		const controller = new SessionStreamController({
			targets: {
				current: { kind: "directory", directoryPath: "/current" },
				all: { kind: "directory", directoryPath: "/current" },
			},
			syncSessions: () => {},
			requestRender: () => {
				renderCount += 1;
				if (renderCount === 2) backgroundComplete.resolve();
			},
			backend: {
				discover: async () => candidates,
				scan: async (batch) => batch.map((candidate) => {
					const index = Number(candidate.path.slice("session-".length));
					return makeScannedSession(candidate.path, index);
				}),
				yieldControl: () => {
					if (!firstYield) return Promise.resolve();
					firstYield = false;
					return backgroundGate.promise;
				},
			},
		});
		controller.attach(sessionList);
		const sessions = await controller.load("current");
		sessionList.setSessions(sessions, false);
		backgroundGate.resolve();
		await backgroundComplete.promise;
		for (const times of publicationTimes) {
			expect(times).toEqual([...times].sort((left, right) => right - left));
		}
		controller.dispose();
	});

	test("stops a stale generation after warm refresh", async () => {
		const candidates = Array.from({ length: 62 }, (_value, index) => ({
			path: `session-${index}`,
			priorityMtimeMs: 62 - index,
		}));
		const staleGenerationGate = deferred<void>();
		const completedGeneration = deferred<void>();
		const scannedBatches: string[][] = [];
		let yieldCount = 0;
		let renderCount = 0;
		const backend: SessionStreamBackend = {
			discover: async () => candidates,
			scan: async (batch) => {
				scannedBatches.push(batch.map((candidate) => candidate.path));
				return batch.map((candidate) => makeScannedSession(candidate.path, candidate.priorityMtimeMs));
			},
			yieldControl: () => {
				yieldCount += 1;
				return yieldCount === 1 ? staleGenerationGate.promise : Promise.resolve();
			},
		};
		const sessionList: SessionListPort = { setSessions: () => {} };
		const controller = new SessionStreamController({
			targets: {
				current: { kind: "directory", directoryPath: "/current" },
				all: { kind: "directory", directoryPath: "/current" },
			},
			syncSessions: () => {},
			requestRender: () => {
				renderCount += 1;
				if (renderCount === 2) completedGeneration.resolve();
			},
			backend,
		});
		controller.attach(sessionList);
		const sessions = await controller.load("current");
		sessionList.setSessions(sessions, false);
		await controller.load("current");
		staleGenerationGate.resolve();
		await completedGeneration.promise;
		expect(scannedBatches.map((batch) => batch.length)).toEqual([30, 30, 2]);
		expect(sessions).toHaveLength(62);
		controller.dispose();
	});

	test("uses visible-scope metadata when scopes contain the same path", async () => {
		let synchronized: ScannedSession[] = [];
		const backend: SessionStreamBackend = {
			discover: async (target) => [{
				path: "shared",
				priorityMtimeMs: target.kind === "sessions-root" ? 2 : 1,
			}],
			scan: async (batch) => batch.map((candidate) => makeScannedSession(candidate.path, candidate.priorityMtimeMs)),
			yieldControl: () => Promise.resolve(),
		};
		const sessionList: SessionListPort = { setSessions: () => {} };
		const controller = new SessionStreamController({
			targets: {
				current: { kind: "directory", directoryPath: "/current" },
				all: { kind: "sessions-root", sessionsRootPath: "/all" },
			},
			syncSessions: (sessions) => { synchronized = [...sessions]; },
			requestRender: () => {},
			backend,
		});
		controller.attach(sessionList);
		const current = await controller.load("current");
		sessionList.setSessions(current, false);
		const all = await controller.load("all");
		expect(synchronized.find((session) => session.path === "shared")?.modified.getTime()).toBe(1);
		sessionList.setSessions(all, true);
		expect(synchronized.find((session) => session.path === "shared")?.modified.getTime()).toBe(2);
		sessionList.setSessions(current, false);
		expect(synchronized.find((session) => session.path === "shared")?.modified.getTime()).toBe(1);
		controller.dispose();
	});

	test("continues custom-directory scanning until initial current-cwd rows are filled or exhausted", async () => {
		const candidates = Array.from({ length: 35 }, (_value, index) => ({
			path: `${index < 30 ? "other" : "current"}-${index}`,
			priorityMtimeMs: 35 - index,
		}));
		const batchSizes: number[] = [];
		const controller = new SessionStreamController({
			targets: {
				current: { kind: "cwd-directory", directoryPath: "/shared", resolvedCwd: "/current" },
				all: { kind: "directory", directoryPath: "/shared" },
			},
			syncSessions: () => {},
			requestRender: () => {},
			backend: {
				discover: async () => candidates,
				scan: async (batch) => {
					batchSizes.push(batch.length);
					return batch.map((candidate) => ({
						...makeScannedSession(candidate.path, candidate.priorityMtimeMs),
						cwd: candidate.path.startsWith("current-") ? "/current" : "/other",
					}));
				},
				yieldControl: () => Promise.resolve(),
			},
		});
		const sessions = await controller.load("current");
		expect(batchSizes).toEqual([30, 5]);
		expect(sessions.map((session) => session.path)).toEqual([
			"current-30",
			"current-31",
			"current-32",
			"current-33",
			"current-34",
		]);
		controller.dispose();
	});

	test("keeps fixed-size foreground batches near the custom-cwd threshold", async () => {
		const candidates = Array.from({ length: 95 }, (_value, index) => ({
			path: `${index < 29 ? "current" : "other"}-${index}`,
			priorityMtimeMs: 95 - index,
		}));
		const batchSizes: number[] = [];
		const controller = new SessionStreamController({
			targets: {
				current: { kind: "cwd-directory", directoryPath: "/shared", resolvedCwd: "/current" },
				all: { kind: "directory", directoryPath: "/shared" },
			},
			syncSessions: () => {},
			requestRender: () => {},
			backend: {
				discover: async () => candidates,
				scan: async (batch) => {
					batchSizes.push(batch.length);
					return batch.map((candidate) => ({
						...makeScannedSession(candidate.path, candidate.priorityMtimeMs),
						cwd: candidate.path.startsWith("current-") ? "/current" : "/other",
					}));
				},
				yieldControl: () => Promise.resolve(),
			},
		});
		const sessions = await controller.load("current");
		expect(batchSizes).toEqual([30, 30, 30, 5]);
		expect(sessions).toHaveLength(29);
		controller.dispose();
	});

	test("reuses unchanged sessions excluded by a custom cwd filter", async () => {
		const candidates = [
			{ path: "current", priorityMtimeMs: 2 },
			{ path: "other", priorityMtimeMs: 1 },
		];
		const scannedBatches: string[][] = [];
		const reconciled = deferred<void>();
		const controller = new SessionStreamController({
			targets: {
				current: { kind: "cwd-directory", directoryPath: "/shared", resolvedCwd: "/current" },
				all: { kind: "directory", directoryPath: "/shared" },
			},
			syncSessions: () => {},
			requestRender: () => reconciled.resolve(),
			backend: {
				discover: async () => candidates,
				scan: async (batch) => {
					scannedBatches.push(batch.map((candidate) => candidate.path));
					return batch.map((candidate) => ({
						...makeScannedSession(candidate.path, candidate.priorityMtimeMs),
						cwd: candidate.path === "current" ? "/current" : "/other",
					}));
				},
				yieldControl: () => Promise.resolve(),
			},
		});
		controller.attach({ setSessions: () => {} });
		const sessions = await controller.load("current");
		expect(sessions.map((session) => session.path)).toEqual(["current"]);
		await controller.load("current");
		await reconciled.promise;
		expect(scannedBatches).toEqual([["current", "other"]]);
		controller.dispose();
	});

	test("retains cwd-excluded cache entries across selector adoption", async () => {
		const candidates = [
			{ path: "current", priorityMtimeMs: 2 },
			{ path: "other", priorityMtimeMs: 1 },
		];
		const scannedBatches: string[][] = [];
		const reconciled = deferred<void>();
		const sessionList: SessionListPort = { setSessions: () => {} };
		const controller = new SessionStreamController({
			targets: {
				current: { kind: "cwd-directory", directoryPath: "/shared", resolvedCwd: "/current" },
				all: { kind: "directory", directoryPath: "/shared" },
			},
			syncSessions: () => {},
			requestRender: () => reconciled.resolve(),
			backend: {
				discover: async () => candidates,
				scan: async (batch) => {
					scannedBatches.push(batch.map((candidate) => candidate.path));
					return batch.map((candidate) => ({
						...makeScannedSession(candidate.path, candidate.priorityMtimeMs),
						cwd: candidate.path === "current" ? "/current" : "/other",
					}));
				},
				yieldControl: () => Promise.resolve(),
			},
		});
		controller.attach(sessionList);
		const sessions = await controller.load("current");
		sessionList.setSessions(sessions, false);
		sessionList.setSessions([...sessions], false);
		await reconciled.promise;
		expect(scannedBatches).toEqual([["current", "other"]]);
		controller.dispose();
	});

	test("does not retry a skipped initial candidate in the same generation", async () => {
		const candidates = Array.from({ length: 31 }, (_value, index) => ({
			path: `session-${index}`,
			priorityMtimeMs: 31 - index,
		}));
		const attempts: string[] = [];
		const controller = new SessionStreamController({
			targets: {
				current: { kind: "directory", directoryPath: "/current" },
				all: { kind: "directory", directoryPath: "/current" },
			},
			syncSessions: () => {},
			requestRender: () => {},
			backend: {
				discover: async () => candidates,
				scan: async (batch) => {
					attempts.push(...batch.map((candidate) => candidate.path));
					return batch
						.filter((candidate) => candidate.path !== "session-0")
						.map((candidate) => makeScannedSession(candidate.path, candidate.priorityMtimeMs));
				},
				yieldControl: () => Promise.resolve(),
			},
		});
		const sessions = await controller.load("current");
		expect(attempts.filter((path) => path === "session-0")).toHaveLength(1);
		expect(sessions.some((session) => session.path === "session-0")).toBe(false);
		controller.dispose();
	});

	test("warm reconciliation adopts a filtered cache and scans only changed or new paths", async () => {
		let candidates: SessionFileCandidate[] = [
			{ path: "a", priorityMtimeMs: 1 },
			{ path: "b", priorityMtimeMs: 1 },
		];
		const scannedBatches: string[][] = [];
		const backend: SessionStreamBackend = {
			discover: async () => candidates,
			scan: async (batch) => {
				scannedBatches.push(batch.map((candidate) => candidate.path));
				return batch.map((candidate) => makeScannedSession(candidate.path, candidate.priorityMtimeMs));
			},
			yieldControl: () => Promise.resolve(),
		};
		const sessionList: SessionListPort = { setSessions: () => {} };
		const controller = new SessionStreamController({
			targets: {
				current: { kind: "directory", directoryPath: "/current" },
				all: { kind: "directory", directoryPath: "/current" },
			},
			syncSessions: () => {},
			requestRender: () => {},
			backend,
		});
		controller.attach(sessionList);
		const initial = await controller.load("current");
		sessionList.setSessions(initial, false);
		expect(initial.map((session) => session.path)).toEqual(["a", "b"]);
		candidates = [
			{ path: "b", priorityMtimeMs: 2 },
			{ path: "c", priorityMtimeMs: 1 },
		];
		const filtered = initial.filter((session) => session.path !== "a");
		sessionList.setSessions(filtered, false);
		await settleBackgroundWork();
		expect(filtered.map((session) => session.path).sort()).toEqual(["b", "c"]);
		expect(scannedBatches.at(-1)?.sort()).toEqual(["b", "c"]);
		controller.dispose();
	});

	test("keeps published rows until warm reconciliation can publish its replacement", async () => {
		let candidates: SessionFileCandidate[] = [
			{ path: "a", priorityMtimeMs: 1 },
			{ path: "b", priorityMtimeMs: 1 },
		];
		const replacementScanStarted = deferred<void>();
		const replacementScanGate = deferred<void>();
		const replacementPublished = deferred<void>();
		let scanCount = 0;
		const backend: SessionStreamBackend = {
			discover: async () => candidates,
			scan: async (batch) => {
				scanCount += 1;
				if (scanCount > 1) {
					replacementScanStarted.resolve();
					await replacementScanGate.promise;
				}
				return batch.map((candidate) => makeScannedSession(candidate.path, candidate.priorityMtimeMs));
			},
			yieldControl: () => Promise.resolve(),
		};
		const sessionList: SessionListPort = { setSessions: () => {} };
		const controller = new SessionStreamController({
			targets: {
				current: { kind: "directory", directoryPath: "/current" },
				all: { kind: "directory", directoryPath: "/current" },
			},
			syncSessions: () => {},
			requestRender: () => replacementPublished.resolve(),
			backend,
		});
		controller.attach(sessionList);
		const sessions = await controller.load("current");
		sessionList.setSessions(sessions, false);
		candidates = [{ path: "b", priorityMtimeMs: 2 }];
		await controller.load("current");
		await replacementScanStarted.promise;
		expect(sessions.map((session) => session.path)).toEqual(["a", "b"]);
		replacementScanGate.resolve();
		await replacementPublished.promise;
		expect(sessions.map((session) => session.path)).toEqual(["b"]);
		controller.dispose();
	});

	test("prunes vanished rows when warm reconciliation terminates with an error", async () => {
		let candidates: SessionFileCandidate[] = [
			{ path: "a", priorityMtimeMs: 1 },
			{ path: "b", priorityMtimeMs: 1 },
		];
		const terminalPublished = deferred<void>();
		let scanCount = 0;
		const sessionList: SessionListPort = { setSessions: () => {} };
		const controller = new SessionStreamController({
			targets: {
				current: { kind: "directory", directoryPath: "/current" },
				all: { kind: "directory", directoryPath: "/current" },
			},
			syncSessions: () => {},
			requestRender: () => terminalPublished.resolve(),
			backend: {
				discover: async () => candidates,
				scan: async (batch) => {
					scanCount += 1;
					if (scanCount > 1) throw new Error("refresh failed");
					return batch.map((candidate) => makeScannedSession(candidate.path, candidate.priorityMtimeMs));
				},
				yieldControl: () => Promise.resolve(),
			},
		});
		controller.attach(sessionList);
		const sessions = await controller.load("current");
		sessionList.setSessions(sessions, false);
		candidates = [{ path: "b", priorityMtimeMs: 2 }];
		await controller.load("current");
		await terminalPublished.promise;
		expect(sessions.map((session) => session.path)).toEqual(["b"]);
		expect(controller.getVisibleStatus()).toBe("Session scan stopped: refresh failed");
		controller.dispose();
	});

	test("ignores selector identity changes before a scope owns an array", async () => {
		const sessionList: SessionListPort = { setSessions: () => {} };
		const controller = new SessionStreamController({
			targets: {
				current: { kind: "directory", directoryPath: "/current" },
				all: { kind: "directory", directoryPath: "/current" },
			},
			syncSessions: () => {},
			requestRender: () => {},
			backend: {
				discover: async () => [{ path: "a", priorityMtimeMs: 1 }],
				scan: async () => [makeScannedSession("a", 1)],
				yieldControl: () => Promise.resolve(),
			},
		});
		controller.attach(sessionList);
		sessionList.setSessions([], false);
		const sessions = await controller.load("current");
		expect(sessions.map((session) => session.path)).toEqual(["a"]);
		controller.dispose();
	});

	test("adopts and reconciles a hidden all-scope cache after deletion", async () => {
		let candidates = Array.from({ length: 35 }, (_value, index) => ({
			path: `session-${index}`,
			priorityMtimeMs: 35 - index,
		}));
		const gate = deferred<void>();
		let paused = true;
		const backend: SessionStreamBackend = {
			discover: async () => candidates,
			scan: async (batch) => batch.map((candidate) => makeScannedSession(candidate.path, candidate.priorityMtimeMs)),
			yieldControl: () => paused ? gate.promise : Promise.resolve(),
		};
		const sessionList: SessionListPort = { setSessions: () => {} };
		const controller = new SessionStreamController({
			targets: {
				current: { kind: "directory", directoryPath: "/current" },
				all: { kind: "sessions-root", sessionsRootPath: "/all" },
			},
			syncSessions: () => {},
			requestRender: () => {},
			backend,
		});
		controller.attach(sessionList);
		const allSessions = await controller.load("all");
		sessionList.setSessions(allSessions, true);
		sessionList.setSessions([], false);
		candidates = candidates.filter((candidate) => candidate.path !== "session-0");
		const hiddenFilteredCache = allSessions.filter((session) => session.path !== "session-0");
		sessionList.setSessions(hiddenFilteredCache, true);
		paused = false;
		gate.resolve();
		await settleBackgroundWork();
		expect(hiddenFilteredCache).toHaveLength(34);
		expect(hiddenFilteredCache.some((session) => session.path === "session-0")).toBe(false);
		controller.dispose();
	});

	test("does not publish background updates for a hidden scope", async () => {
		const candidates = Array.from({ length: 31 }, (_value, index) => ({
			path: `session-${index}`,
			priorityMtimeMs: 31 - index,
		}));
		const backgroundGate = deferred<void>();
		const backgroundComplete = deferred<void>();
		let firstYield = true;
		let publications = 0;
		const sessionList: SessionListPort = { setSessions: () => { publications += 1; } };
		const controller = new SessionStreamController({
			targets: {
				current: { kind: "directory", directoryPath: "/current" },
				all: { kind: "sessions-root", sessionsRootPath: "/all" },
			},
			syncSessions: (sessions) => {
				if (sessions.length === 31) backgroundComplete.resolve();
			},
			requestRender: () => {},
			backend: {
				discover: async () => candidates,
				scan: async (batch) => batch.map((candidate) => makeScannedSession(candidate.path, candidate.priorityMtimeMs)),
				yieldControl: () => {
					if (!firstYield) return Promise.resolve();
					firstYield = false;
					return backgroundGate.promise;
				},
			},
		});
		controller.attach(sessionList);
		const allSessions = await controller.load("all");
		sessionList.setSessions(allSessions, true);
		sessionList.setSessions([], false);
		backgroundGate.resolve();
		await backgroundComplete.promise;
		expect(publications).toBe(2);
		controller.dispose();
	});

	test("keeps partial rows and reports a background scan error", async () => {
		const candidates = Array.from({ length: 31 }, (_value, index) => ({
			path: `session-${index}`,
			priorityMtimeMs: 31 - index,
		}));
		const errorPublished = deferred<void>();
		let scanCount = 0;
		let backgroundSignal: AbortSignal | undefined;
		const sessionList: SessionListPort = { setSessions: () => {} };
		const controller = new SessionStreamController({
			targets: {
				current: { kind: "directory", directoryPath: "/current" },
				all: { kind: "directory", directoryPath: "/current" },
			},
			syncSessions: () => {},
			requestRender: () => errorPublished.resolve(),
			backend: {
				discover: async () => candidates,
				scan: async (batch, options) => {
					scanCount += 1;
					if (scanCount > 1) {
						backgroundSignal = options.signal;
						throw new Error("disk unavailable");
					}
					return batch.map((candidate) => makeScannedSession(candidate.path, candidate.priorityMtimeMs));
				},
				yieldControl: () => Promise.resolve(),
			},
		});
		controller.attach(sessionList);
		const sessions = await controller.load("current");
		await errorPublished.promise;
		expect(sessions).toHaveLength(30);
		expect(backgroundSignal?.aborted).toBe(true);
		expect(controller.getVisibleStatus()).toBe("Session scan stopped: disk unavailable");
		controller.dispose();
	});

	test("restores the wrapped selector method and suppresses late errors on dispose", async () => {
		const originalSetSessions = () => {};
		const sessionList: SessionListPort = { setSessions: originalSetSessions };
		const controller = new SessionStreamController({
			targets: {
				current: { kind: "directory", directoryPath: "/current" },
				all: { kind: "directory", directoryPath: "/current" },
			},
			syncSessions: () => {},
			requestRender: () => {},
			backend: {
				discover: async () => [],
				scan: async () => [],
				yieldControl: () => Promise.resolve(),
			},
		});
		controller.attach(sessionList);
		expect(sessionList.setSessions).not.toBe(originalSetSessions);
		controller.dispose();
		expect(sessionList.setSessions).toBe(originalSetSessions);
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
			readFirstLine: () => JSON.stringify({ type: "session", cwd: "/tmp/selected-project" }),
			exists: () => true,
			stat: (() => ({ isDirectory: () => true })) as any,
		});

		expect(target).toEqual({ cwd: "/tmp/selected-project" });
	});

	test("warns when the selected session cwd is missing", () => {
		const target = resolveStartupSessionTarget("/tmp/selected.jsonl", {
			readFirstLine: () => JSON.stringify({ type: "session" }),
			exists: () => true,
			stat: (() => ({ isDirectory: () => true })) as any,
		});

		expect(target).toEqual({
			warning: "Selected session does not have a recorded cwd. Use `/switch-session` or native `pi --resume` instead.",
		});
	});

	test("warns when the selected session cwd path is missing", () => {
		const target = resolveStartupSessionTarget("/tmp/selected.jsonl", {
			readFirstLine: () => JSON.stringify({ type: "session", cwd: "/tmp/missing-project" }),
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
		await writeTempFile(tempRoot, "extensions/session-switch/session-scanner.ts", "export const scanner = true;\n");
		await writeTempFile(tempRoot, "extensions/session-switch/session-stream.ts", "export const stream = true;\n");
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
		expect(await Bun.file(path.join(packageDir, "extensions/session-switch/session-scanner.ts")).exists()).toBe(true);
		expect(await Bun.file(path.join(packageDir, "extensions/session-switch/session-stream.ts")).exists()).toBe(true);
		expect(await Bun.file(path.join(packageDir, "extensions/session-switch/session-switch.LICENSE")).exists()).toBe(true);
		expect(await Bun.file(path.join(packageDir, "extensions/_shared/pi-spawn.ts")).exists()).toBe(true);
		expect(await Bun.file(path.join(packageDir, "extensions/session-switch/stale.ts")).exists()).toBe(false);
		expect(await Bun.file(path.join(packageDir, "extensions/session-switch.ts")).exists()).toBe(false);
		expect(await Bun.file(path.join(packageDir, "extensions/session-switch.LICENSE")).exists()).toBe(false);
	});
});
