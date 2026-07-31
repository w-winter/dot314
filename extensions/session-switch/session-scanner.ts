import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { getAgentDir, type SessionInfo } from "@earendil-works/pi-coding-agent";

export type SessionDiscoveryTarget =
	| { kind: "directory"; directoryPath: string }
	| { kind: "cwd-directory"; directoryPath: string; resolvedCwd: string }
	| { kind: "sessions-root"; sessionsRootPath: string };

export interface SessionFileCandidate {
	readonly path: string;
	readonly priorityMtimeMs: number;
}

export interface ScannedSession extends SessionInfo {
	readonly lastMessage: string;
}

export interface SessionDiscoveryTargets {
	readonly current: SessionDiscoveryTarget;
	readonly all: SessionDiscoveryTarget;
}

const TYPE_KEY_TOKEN = Buffer.from('"type"');
const MESSAGE_TYPE_VALUE = Buffer.from('"message"');
const SESSION_INFO_TYPE_VALUE = Buffer.from('"session_info"');
const MESSAGE_PAYLOAD_TOKEN = Buffer.from('"message"');
const USER_ROLE_TOKENS = [Buffer.from('"role":"user"'), Buffer.from('"role": "user"')];
const ASSISTANT_ROLE_TOKENS = [Buffer.from('"role":"assistant"'), Buffer.from('"role": "assistant"')];
const NEWLINE_BYTE = 0x0a;
const METADATA_CONCURRENCY = 32;
const SCAN_CONCURRENCY = 4;
const MAX_TYPE_KEY_OFFSET = 512;

interface SessionHeaderShape {
	type: "session";
	id: string;
	timestamp: string;
	cwd?: unknown;
	parentSession?: unknown;
}

interface MessageEntryShape {
	type?: unknown;
	timestamp?: unknown;
	message?: {
		role?: unknown;
		content?: unknown;
		timestamp?: unknown;
	};
}


function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	const error = new Error("Session scan cancelled");
	error.name = "AbortError";
	throw error;
}

function isExpectedFilesystemError(error: unknown): boolean {
	if (!(error instanceof Error) || !("code" in error)) return false;
	return ["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(String(error.code));
}

export function isSessionScanCancellation(error: unknown): boolean {
	return error instanceof Error && (error.name === "AbortError" || ("code" in error && error.code === "ABORT_ERR"));
}

export function getSessionsRoot(agentDir: string = getAgentDir()): string {
	return join(agentDir, "sessions");
}

export function getSessionDiscoveryTargets(
	sessionDirectory: string,
	cwd: string,
	agentDir: string = getAgentDir(),
): SessionDiscoveryTargets {
	const resolvedCwd = resolve(cwd);
	const resolvedAgentDir = resolve(agentDir);
	const sessionsRootPath = getSessionsRoot(resolvedAgentDir);
	const safeCwd = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	const defaultDirectory = join(sessionsRootPath, safeCwd);
	const currentDirectory = sessionDirectory === "" ? defaultDirectory : resolve(sessionDirectory);
	if (currentDirectory === defaultDirectory) {
		return {
			current: { kind: "directory", directoryPath: currentDirectory },
			all: { kind: "sessions-root", sessionsRootPath },
		};
	}
	return {
		current: { kind: "cwd-directory", directoryPath: currentDirectory, resolvedCwd },
		all: { kind: "directory", directoryPath: currentDirectory },
	};
}

export function sessionMatchesDiscoveryTarget(
	session: ScannedSession,
	target: SessionDiscoveryTarget,
): boolean {
	return target.kind !== "cwd-directory" ||
		(session.cwd !== "" && resolve(session.cwd) === target.resolvedCwd);
}

export async function mapWithConcurrency<T, R>(
	items: readonly T[],
	concurrency: number,
	mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let nextIndex = 0;
	let failure: { error: unknown } | undefined;

	const worker = async (): Promise<void> => {
		while (!failure && nextIndex < items.length) {
			const index = nextIndex;
			nextIndex += 1;
			try {
				results[index] = await mapper(items[index]!, index);
			} catch (error) {
				failure ??= { error };
			}
		}
	};

	await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
	if (failure) throw failure.error;
	return results;
}

async function discoverDirectoryPaths(directoryPath: string, signal?: AbortSignal): Promise<string[]> {
	throwIfAborted(signal);
	try {
		const names = await readdir(directoryPath);
		throwIfAborted(signal);
		return names.filter((name) => name.endsWith(".jsonl")).map((name) => join(directoryPath, name));
	} catch (error) {
		if (isExpectedFilesystemError(error)) return [];
		throw error;
	}
}

async function buildSessionFileCandidates(
	paths: readonly string[],
	signal?: AbortSignal,
): Promise<SessionFileCandidate[]> {
	const candidates = await mapWithConcurrency(paths, METADATA_CONCURRENCY, async (path) => {
		throwIfAborted(signal);
		try {
			const fileStat = await stat(path);
			throwIfAborted(signal);
			return fileStat.isFile() ? { path, priorityMtimeMs: fileStat.mtimeMs } : null;
		} catch (error) {
			if (isExpectedFilesystemError(error)) return null;
			throw error;
		}
	});
	return candidates
		.filter((candidate): candidate is SessionFileCandidate => candidate !== null)
		.sort((left, right) => right.priorityMtimeMs - left.priorityMtimeMs || left.path.localeCompare(right.path));
}

export async function discoverSessionFiles(
	target: SessionDiscoveryTarget,
	signal?: AbortSignal,
): Promise<SessionFileCandidate[]> {
	if (target.kind === "directory" || target.kind === "cwd-directory") {
		return buildSessionFileCandidates(await discoverDirectoryPaths(target.directoryPath, signal), signal);
	}

	throwIfAborted(signal);
	let directoryNames: string[];
	try {
		const entries = await readdir(target.sessionsRootPath, { withFileTypes: true });
		directoryNames = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
	} catch (error) {
		if (isExpectedFilesystemError(error)) return [];
		throw error;
	}
	throwIfAborted(signal);

	const pathGroups = await mapWithConcurrency(directoryNames, METADATA_CONCURRENCY, (name) =>
		discoverDirectoryPaths(join(target.sessionsRootPath, name), signal),
	);
	return buildSessionFileCandidates(pathGroups.flat(), signal);
}

function lineEnd(buffer: Buffer, lineStart: number): number {
	const newline = buffer.indexOf(NEWLINE_BYTE, lineStart);
	return newline === -1 ? buffer.length : newline;
}

type ParsedJsonLine<T> =
	| { kind: "parsed"; value: T }
	| { kind: "malformed"; error: unknown };

function parseLine<T>(buffer: Buffer, lineStart: number): ParsedJsonLine<T> {
	try {
		return { kind: "parsed", value: JSON.parse(buffer.toString("utf8", lineStart, lineEnd(buffer, lineStart))) as T };
	} catch (error) {
		return { kind: "malformed", error };
	}
}

interface ParsedSessionHeader {
	header: SessionHeaderShape;
	entriesOffset: number;
}

function parseHeader(buffer: Buffer): ParsedSessionHeader | null {
	let lineStart = 0;
	while (lineStart < buffer.length) {
		const end = lineEnd(buffer, lineStart);
		const parsed = parseLine<Partial<SessionHeaderShape> | null>(buffer, lineStart);
		if (parsed.kind === "parsed" && parsed.value) {
			const entry = parsed.value;
			if (entry.type !== "session") return null;
			if (typeof entry.id !== "string" || typeof entry.timestamp !== "string") return null;
			return {
				header: entry as SessionHeaderShape,
				entriesOffset: end === buffer.length ? buffer.length : end + 1,
			};
		}
		if (end === buffer.length) break;
		lineStart = end + 1;
	}
	return null;
}

interface EntryLineStarts {
	message: number[];
	sessionInfo: number[];
}

function tokenOffsetInLine(buffer: Buffer, start: number, token: Buffer): number {
	const relativeOffset = buffer.subarray(start, lineEnd(buffer, start)).indexOf(token);
	return relativeOffset === -1 ? -1 : start + relativeOffset;
}

function isTopLevelObjectKey(buffer: Buffer, lineStart: number, keyOffset: number, token: Buffer): boolean {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let cursor = lineStart; cursor < keyOffset; cursor += 1) {
		const byte = buffer[cursor];
		if (inString) {
			if (escaped) escaped = false;
			else if (byte === 0x5c) escaped = true;
			else if (byte === 0x22) inString = false;
			continue;
		}
		if (byte === 0x22) inString = true;
		else if (byte === 0x7b || byte === 0x5b) depth += 1;
		else if (byte === 0x7d || byte === 0x5d) depth -= 1;
	}
	if (inString || depth !== 1 || !buffer.subarray(keyOffset, keyOffset + token.length).equals(token)) return false;
	let cursor = keyOffset + token.length;
	while (buffer[cursor] === 0x20 || buffer[cursor] === 0x09) cursor += 1;
	return buffer[cursor] === 0x3a;
}

function topLevelKeyOffsetInLine(buffer: Buffer, lineStart: number, token: Buffer): number {
	const end = lineEnd(buffer, lineStart);
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let cursor = lineStart; cursor < end; cursor += 1) {
		const byte = buffer[cursor];
		if (inString) {
			if (escaped) escaped = false;
			else if (byte === 0x5c) escaped = true;
			else if (byte === 0x22) inString = false;
			continue;
		}
		if (byte === 0x22) {
			if (depth === 1 && buffer.subarray(cursor, cursor + token.length).equals(token)) {
				let valueOffset = cursor + token.length;
				while (buffer[valueOffset] === 0x20 || buffer[valueOffset] === 0x09) valueOffset += 1;
				if (buffer[valueOffset] === 0x3a) return cursor;
			}
			inString = true;
		} else if (byte === 0x7b || byte === 0x5b) depth += 1;
		else if (byte === 0x7d || byte === 0x5d) depth -= 1;
	}
	return -1;
}

function findEntryLineStarts(buffer: Buffer, entriesOffset: number): EntryLineStarts {
	const message: number[] = [];
	const sessionInfo: number[] = [];
	let start = entriesOffset;
	while (start < buffer.length) {
		const end = lineEnd(buffer, start);
		const envelopeEnd = Math.min(end, start + MAX_TYPE_KEY_OFFSET + TYPE_KEY_TOKEN.length);
		const envelope = buffer.subarray(start, envelopeEnd);
		let relativeTypeOffset = envelope.indexOf(TYPE_KEY_TOKEN);
		while (relativeTypeOffset !== -1) {
			const typeOffset = start + relativeTypeOffset;
			if (isTopLevelObjectKey(buffer, start, typeOffset, TYPE_KEY_TOKEN)) {
				let cursor = typeOffset + TYPE_KEY_TOKEN.length;
				while (buffer[cursor] === 0x20 || buffer[cursor] === 0x09) cursor += 1;
				cursor += 1;
				while (buffer[cursor] === 0x20 || buffer[cursor] === 0x09) cursor += 1;
				if (buffer.subarray(cursor, cursor + MESSAGE_TYPE_VALUE.length).equals(MESSAGE_TYPE_VALUE)) {
					if (topLevelKeyOffsetInLine(buffer, start, MESSAGE_PAYLOAD_TOKEN) !== -1) message.push(start);
				} else if (buffer.subarray(cursor, cursor + SESSION_INFO_TYPE_VALUE.length).equals(SESSION_INFO_TYPE_VALUE)) {
					sessionInfo.push(start);
				}
				break;
			}
			relativeTypeOffset = envelope.indexOf(TYPE_KEY_TOKEN, relativeTypeOffset + TYPE_KEY_TOKEN.length);
		}
		if (end === buffer.length) break;
		start = end + 1;
	}
	return { message, sessionInfo };
}

function lineContainsAny(buffer: Buffer, start: number, tokens: readonly Buffer[]): boolean {
	return tokens.some((token) => tokenOffsetInLine(buffer, start, token) !== -1);
}

function hasRelevantRole(buffer: Buffer, start: number): boolean {
	return lineContainsAny(buffer, start, USER_ROLE_TOKENS) || lineContainsAny(buffer, start, ASSISTANT_ROLE_TOKENS);
}

function extractTextContent(message: MessageEntryShape["message"]): string {
	if (!message || !("content" in message)) return "";
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter(
			(block): block is { type: "text"; text: string } =>
				typeof block === "object" && block !== null && block.type === "text" && typeof block.text === "string",
		)
		.map((block) => block.text)
		.join(" ");
}

function getActivityTime(entry: MessageEntryShape): number | undefined {
	const message = entry.message;
	if (!message || typeof message.role !== "string" || !("content" in message)) return undefined;
	if (message.role !== "user" && message.role !== "assistant") return undefined;
	if (typeof message.timestamp === "number") return message.timestamp;
	if (typeof entry.timestamp !== "string") return undefined;
	const parsed = Date.parse(entry.timestamp);
	return Number.isNaN(parsed) ? undefined : parsed;
}

function findFirstUserText(buffer: Buffer, messageStarts: readonly number[], signal?: AbortSignal): string {
	for (let index = 0; index < messageStarts.length; index += 1) {
		if (index % 256 === 0) throwIfAborted(signal);
		const start = messageStarts[index]!;
		if (!lineContainsAny(buffer, start, USER_ROLE_TOKENS)) continue;
		const parsed = parseLine<MessageEntryShape>(buffer, start);
		if (parsed.kind === "malformed" || parsed.value.message?.role !== "user") continue;
		const text = extractTextContent(parsed.value.message);
		if (text) return text;
	}
	return "";
}

function findLastActivityAndText(
	buffer: Buffer,
	messageStarts: readonly number[],
	signal?: AbortSignal,
): { activityTime?: number; lastMessage: string } {
	let activityTime: number | undefined;
	let lastMessage = "";
	for (let index = messageStarts.length - 1; index >= 0; index -= 1) {
		if (index % 256 === 0) throwIfAborted(signal);
		const start = messageStarts[index]!;
		if (!hasRelevantRole(buffer, start)) continue;
		const parsed = parseLine<MessageEntryShape>(buffer, start);
		if (parsed.kind === "malformed") continue;
		const entry = parsed.value;
		if (activityTime === undefined) {
			const candidateTime = getActivityTime(entry);
			if (candidateTime !== undefined && candidateTime > 0) activityTime = candidateTime;
		}
		if (!lastMessage && (entry.message?.role === "user" || entry.message?.role === "assistant")) {
			lastMessage = extractTextContent(entry.message);
		}
		if (activityTime !== undefined && lastMessage) break;
	}
	return { activityTime, lastMessage };
}

function findLatestName(buffer: Buffer, starts: readonly number[], signal?: AbortSignal): string | undefined {
	let name: string | undefined;
	for (let index = 0; index < starts.length; index += 1) {
		if (index % 256 === 0) throwIfAborted(signal);
		const parsed = parseLine<{ type?: unknown; name?: unknown }>(buffer, starts[index]!);
		if (parsed.kind === "parsed" && parsed.value.type === "session_info") {
			name = typeof parsed.value.name === "string" ? parsed.value.name.trim() || undefined : undefined;
		}
	}
	return name;
}

function buildSearchText(firstMessage: string, lastMessage: string): string {
	if (!firstMessage) return lastMessage;
	if (!lastMessage || lastMessage === firstMessage) return firstMessage;
	return `${firstMessage} ${lastMessage}`;
}

export async function scanSessionFile(
	candidate: SessionFileCandidate,
	signal?: AbortSignal,
): Promise<ScannedSession | null> {
	try {
		throwIfAborted(signal);
		const fileStat = await stat(candidate.path);
		throwIfAborted(signal);
		const buffer = await readFile(candidate.path, { signal });
		throwIfAborted(signal);
		const parsedHeader = parseHeader(buffer);
		if (!parsedHeader) return null;
		const { header, entriesOffset } = parsedHeader;
		const entryStarts = findEntryLineStarts(buffer, entriesOffset);
		const messageStarts = entryStarts.message;
		const firstUserText = findFirstUserText(buffer, messageStarts, signal);
		const { activityTime, lastMessage } = findLastActivityAndText(buffer, messageStarts, signal);
		const headerTime = Date.parse(header.timestamp);
		const modified = activityTime !== undefined
			? new Date(activityTime)
			: !Number.isNaN(headerTime)
				? new Date(headerTime)
				: fileStat.mtime;
		const firstMessage = firstUserText || "(no messages)";

		return {
			path: candidate.path,
			id: header.id,
			cwd: typeof header.cwd === "string" ? header.cwd : "",
			name: findLatestName(buffer, entryStarts.sessionInfo, signal),
			parentSessionPath: typeof header.parentSession === "string" ? header.parentSession : undefined,
			created: new Date(header.timestamp),
			modified,
			messageCount: messageStarts.length,
			firstMessage,
			allMessagesText: buildSearchText(firstUserText, lastMessage),
			lastMessage,
		};
	} catch (error) {
		if (isSessionScanCancellation(error)) throw error;
		if (isExpectedFilesystemError(error)) return null;
		throw error;
	}
}

export async function scanSessionFiles(
	candidates: readonly SessionFileCandidate[],
	options: {
		signal?: AbortSignal;
		onFileScanned?: (loaded: number, total: number) => void;
	} = {},
): Promise<ScannedSession[]> {
	let loaded = 0;
	const results = await mapWithConcurrency(candidates, SCAN_CONCURRENCY, async (candidate) => {
		const result = await scanSessionFile(candidate, options.signal);
		loaded += 1;
		options.onFileScanned?.(loaded, candidates.length);
		return result;
	});
	return results.filter((session): session is ScannedSession => session !== null);
}

export async function listScannedSessions(
	target: SessionDiscoveryTarget,
	options: {
		signal?: AbortSignal;
		onProgress?: (loaded: number, total: number) => void;
	} = {},
): Promise<ScannedSession[]> {
	const candidates = await discoverSessionFiles(target, options.signal);
	const sessions = await scanSessionFiles(candidates, {
		signal: options.signal,
		onFileScanned: options.onProgress,
	});
	return sessions
		.filter((session) => sessionMatchesDiscoveryTarget(session, target))
		.sort((left, right) => right.modified.getTime() - left.modified.getTime());
}

export async function loadSessionPreviewText(sessionPath: string, signal?: AbortSignal): Promise<string> {
	throwIfAborted(signal);
	const buffer = await readFile(sessionPath, { signal });
	throwIfAborted(signal);
	const parsedHeader = parseHeader(buffer);
	if (!parsedHeader) throw new Error(`Invalid session header: ${sessionPath}`);
	const messageStarts = findEntryLineStarts(buffer, parsedHeader.entriesOffset).message;
	const messages: string[] = [];
	for (let index = 0; index < messageStarts.length; index += 1) {
		if (index % 256 === 0) throwIfAborted(signal);
		const start = messageStarts[index]!;
		if (!hasRelevantRole(buffer, start)) continue;
		const parsed = parseLine<MessageEntryShape>(buffer, start);
		if (parsed.kind === "malformed") continue;
		const entry = parsed.value;
		if (entry.message?.role !== "user" && entry.message?.role !== "assistant") continue;
		const text = extractTextContent(entry.message);
		if (text) messages.push(text);
	}
	return messages.join(" ");
}
