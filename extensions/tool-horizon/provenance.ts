import {
	parseCompletedCodexFileActions,
	collectNestedFileActions,
	type CodexFileTrackingAction,
} from "../_shared/files-touched-core.ts";

import type { BoundaryMode, EventMessage, SessionEntry } from "./core.ts";

export const TOOL_HORIZON_CHECKPOINT_STATE_CUSTOM_TYPE = "tool-horizon-checkpoint-state";
export const TOOL_HORIZON_CHECKPOINT_MESSAGE_CUSTOM_TYPE = "tool-horizon-checkpoint";
export const DEFAULT_CHECKPOINT_USE_GUIDANCE = "Use the current request and retained conversation to identify only the listed paths needed for remaining work; inspect their current state before relying on prior observations. Do not inspect paths merely because they appear here.";

export type FileMove = {
	from: string;
	to: string;
};

export type FileProvenance = {
	read: string[];
	modified: string[];
	created: string[];
	deleted: string[];
	moved: FileMove[];
};

export const TOOL_HORIZON_CHECKPOINT_ABSENCE_STATE = { version: 1, state: "absent" } as const;

export type ToolHorizonCheckpointState = {
	version: 1;
	scope: "before-boundary";
	boundaryMode: Exclude<BoundaryMode, "pending">;
	boundarySignature: string;
	generatedAt: number;
	files: FileProvenance;
};

type PathBasis = "cwd" | "workspace" | "canonical";

type TrackedPath = {
	path: string;
	basis: PathBasis;
};

type TrackedMove = {
	from: TrackedPath;
	to: TrackedPath;
};

type TrackedFileProvenance = {
	read: TrackedPath[];
	modified: TrackedPath[];
	created: TrackedPath[];
	deleted: TrackedPath[];
	moved: TrackedMove[];
};

type FileAction =
	| { kind: "read"; path: string; basis: Exclude<PathBasis, "canonical"> }
	| { kind: "modified"; path: string; basis: Exclude<PathBasis, "canonical"> }
	| { kind: "created"; path: string; basis: Exclude<PathBasis, "canonical"> }
	| { kind: "deleted"; path: string; basis: Exclude<PathBasis, "canonical"> }
	| { kind: "moved"; from: string; to: string; basis: Exclude<PathBasis, "canonical"> };

type TrackedToolCall =
	| { kind: "existing"; actions: FileAction[] }
	| { kind: "codex"; toolName: string; toolArguments: Record<string, unknown> };

type ParsedRootPrefixedPath = {
	root: string;
	relativePath: string;
};

function uniqStrings(values: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const value of values) {
		const trimmed = value.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		out.push(trimmed);
	}
	return out;
}

function uniqMoves(values: FileMove[]): FileMove[] {
	const seen = new Set<string>();
	const out: FileMove[] = [];
	for (const value of values) {
		const from = value.from.trim();
		const to = value.to.trim();
		if (!from || !to) continue;
		const key = JSON.stringify([from, to]);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ from, to });
	}
	return out;
}

function normalizePathSeparators(value: string): string {
	return value.replace(/\\/g, "/");
}

function normalizeSegments(path: string): string {
	const normalized = normalizePathSeparators(path);
	const segments: string[] = [];
	for (const segment of normalized.split("/")) {
		if (!segment || segment === ".") continue;
		if (segment === "..") {
			if (segments.length > 0 && segments[segments.length - 1] !== "..") {
				segments.pop();
				continue;
			}
		}
		segments.push(segment);
	}
	return segments.join("/");
}

function normalizeRelativePath(path: string): string {
	return normalizeSegments(path.trim());
}

function normalizeAbsolutePath(path: string): string {
	const normalized = normalizePathSeparators(path.trim());
	const windowsMatch = normalized.match(/^([A-Za-z]:)(?:\/(.*))?$/);
	if (windowsMatch) {
		const drive = windowsMatch[1].toUpperCase();
		const segments = normalizeSegments(windowsMatch.slice(2).join(""));
		return segments ? `${drive}/${segments}` : `${drive}/`;
	}
	const segments = normalizeSegments(normalized);
	return segments ? `/${segments}` : "/";
}

function isAbsolutePath(path: string): boolean {
	const normalized = normalizePathSeparators(path.trim());
	return normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized);
}

function pathBasename(path: string): string {
	const normalized = normalizePathSeparators(path).replace(/\/+$/, "");
	const segments = normalized.split("/").filter(Boolean);
	return segments[segments.length - 1] ?? normalized;
}

function parseRootPrefixedPath(path: string): ParsedRootPrefixedPath | null {
	const normalized = normalizePathSeparators(path.trim());
	if (!normalized || isAbsolutePath(normalized)) return null;
	const match = normalized.match(/^([^/:]+):(.*)$/);
	if (!match) return null;
	const relativePath = normalizeRelativePath(match[2]);
	if (!relativePath) return null;
	return {
		root: match[1],
		relativePath,
	};
}

function deriveRootFromAbsoluteAndRelative(absPath: string, relativePath: string): string | null {
	const normalizedAbsolutePath = normalizeAbsolutePath(absPath);
	const normalizedRelativePath = normalizeRelativePath(relativePath);
	if (!normalizedRelativePath) return null;
	const suffix = `/${normalizedRelativePath}`;
	if (!normalizedAbsolutePath.endsWith(suffix)) return null;
	const root = normalizedAbsolutePath.slice(0, -suffix.length);
	if (!root) return "/";
	return /^[A-Za-z]:$/.test(root) ? `${root}/` : root;
}

function inferRootMappings(paths: string[], cwd: string | null | undefined): Map<string, string> {
	const absolutePaths = uniqStrings(paths.filter((path) => isAbsolutePath(path)).map((path) => normalizeAbsolutePath(path)));
	const rootRefs = paths
		.map((path) => parseRootPrefixedPath(path))
		.filter((value): value is ParsedRootPrefixedPath => Boolean(value));
	const scoresByRoot = new Map<string, Map<string, number>>();
	for (const ref of rootRefs) {
		const rootScores = scoresByRoot.get(ref.root) ?? new Map<string, number>();
		for (const absPath of absolutePaths) {
			const candidateRoot = deriveRootFromAbsoluteAndRelative(absPath, ref.relativePath);
			if (!candidateRoot) continue;
			const bonus = pathBasename(candidateRoot) === ref.root ? 2 : 1;
			rootScores.set(candidateRoot, (rootScores.get(candidateRoot) ?? 0) + bonus);
		}
		scoresByRoot.set(ref.root, rootScores);
	}

	const out = new Map<string, string>();
	for (const [root, scores] of scoresByRoot) {
		const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
		if (ranked.length === 0) continue;
		if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) continue;
		out.set(root, ranked[0][0]);
	}

	if (cwd && isAbsolutePath(cwd)) {
		const normalizedCwd = normalizeAbsolutePath(cwd);
		const relativePaths = paths
			.filter((path) => !isAbsolutePath(path) && !parseRootPrefixedPath(path))
			.map(normalizeRelativePath)
			.filter(Boolean);
		const candidateScores = new Map<string, number>();
		for (const relativePath of relativePaths) {
			for (const absolutePath of absolutePaths) {
				const candidateRoot = deriveRootFromAbsoluteAndRelative(absolutePath, relativePath);
				if (
					!candidateRoot ||
					candidateRoot === normalizedCwd ||
					!isPathAtOrUnderRoot(normalizedCwd, candidateRoot)
				) continue;
				const rootName = pathBasename(candidateRoot);
				const rootNameEvidence = relativePaths.some((path) => path.startsWith(`${rootName}/`)) ? 10 : 0;
				candidateScores.set(candidateRoot, (candidateScores.get(candidateRoot) ?? 0) + 1 + rootNameEvidence);
			}
		}
		const ranked = [...candidateScores.entries()].sort((a, b) => b[1] - a[1]);
		if (ranked.length > 0 && (ranked.length === 1 || ranked[0][1] !== ranked[1][1])) {
			const rootPath = ranked[0][0];
			const rootName = pathBasename(rootPath);
			if (!out.has(rootName)) out.set(rootName, rootPath);
		}
	}
	return out;
}

function rootPrefix(rootPath: string): string {
	return rootPath.endsWith("/") ? rootPath : `${rootPath}/`;
}

function isPathAtOrUnderRoot(path: string, rootPath: string): boolean {
	return path === rootPath || path.startsWith(rootPrefix(rootPath));
}

function findRootForAbsolutePath(absPath: string, rootMappings: Map<string, string>): { root: string; relativePath: string } | null {
	const normalizedAbsPath = normalizeAbsolutePath(absPath);
	let bestMatch: { root: string; relativePath: string; rootPathLength: number } | null = null;
	for (const [root, rootPath] of rootMappings) {
		if (!isPathAtOrUnderRoot(normalizedAbsPath, rootPath)) continue;
		const relativePath = normalizedAbsPath === rootPath ? "" : normalizedAbsPath.slice(rootPrefix(rootPath).length);
		if (!relativePath) continue;
		if (!bestMatch || rootPath.length > bestMatch.rootPathLength) {
			bestMatch = { root, relativePath, rootPathLength: rootPath.length };
		}
	}
	return bestMatch ? { root: bestMatch.root, relativePath: bestMatch.relativePath } : null;
}

function inferCurrentRoot(rootMappings: Map<string, string>, cwd: string | null | undefined): string | null {
	if (!cwd || !isAbsolutePath(cwd)) return null;
	const normalizedCwd = normalizeAbsolutePath(cwd);
	let bestMatch: { root: string; rootPathLength: number } | null = null;
	for (const [root, rootPath] of rootMappings) {
		if (!isPathAtOrUnderRoot(normalizedCwd, rootPath)) continue;
		if (!bestMatch || rootPath.length > bestMatch.rootPathLength) {
			bestMatch = { root, rootPathLength: rootPath.length };
		}
	}
	return bestMatch?.root ?? null;
}

/**
	* Express an absolute path relative to the working directory when it lies inside it
	*
	* Tools spell the same file both ways — absolute from some file tools, working-directory relative
	* from others — so both spellings must collapse to one form before bucket precedence is applied.
	* The working directory remains the canonical basis when no workspace-root mapping is available.
	*
	* Args:
	*     absolutePath (string): Normalized absolute path
	*     cwd (string | null | undefined): Session working directory
	*
	* Returns:
	*     The working-directory relative path, or null when the file lies outside it
	*/
function relativizeToCwd(absolutePath: string, cwd: string | null | undefined): string | null {
	if (!cwd || !isAbsolutePath(cwd)) return null;
	const normalizedCwd = normalizeAbsolutePath(cwd);
	// A filesystem-root cwd (`/`, or `C:/` on Windows) already ends in a separator; appending another
	// would test for `//` and leave every descendant absolute.
	const prefix = normalizedCwd.endsWith("/") ? normalizedCwd : `${normalizedCwd}/`;
	if (!absolutePath.startsWith(prefix)) return null;
	return absolutePath.slice(prefix.length) || null;
}

function normalizeTrackedPath(
	trackedPath: TrackedPath,
	rootMappings: Map<string, string>,
	cwd: string | null | undefined,
): string {
	const strippedPath = stripReadSliceSuffix(trackedPath.path.trim());
	if (!strippedPath) return "";
	const rootPrefixed = parseRootPrefixedPath(strippedPath);
	if (rootPrefixed) return `${rootPrefixed.root}:${rootPrefixed.relativePath}`;
	if (isAbsolutePath(strippedPath)) {
		const rooted = findRootForAbsolutePath(strippedPath, rootMappings);
		if (rooted) return `${rooted.root}:${rooted.relativePath}`;
		const normalizedAbsolutePath = normalizeAbsolutePath(strippedPath);
		return relativizeToCwd(normalizedAbsolutePath, cwd) ?? normalizedAbsolutePath;
	}
	const normalizedRelativePath = normalizeRelativePath(strippedPath);
	if (!normalizedRelativePath) return "";
	const rootedRelative = [...rootMappings.keys()]
		.sort((a, b) => b.length - a.length)
		.find((root) => normalizedRelativePath.startsWith(`${root}/`));
	if (rootedRelative) return `${rootedRelative}:${normalizedRelativePath.slice(rootedRelative.length + 1)}`;
	if (trackedPath.basis === "workspace") {
		const currentRoot = inferCurrentRoot(rootMappings, cwd);
		return currentRoot ? `${currentRoot}:${normalizedRelativePath}` : normalizedRelativePath;
	}
	if (trackedPath.basis === "cwd" && cwd && isAbsolutePath(cwd)) {
		const rooted = findRootForAbsolutePath(`${normalizeAbsolutePath(cwd)}/${normalizedRelativePath}`, rootMappings);
		if (rooted) return `${rooted.root}:${rooted.relativePath}`;
	}
	return normalizedRelativePath;
}

function normalizeTrackedFileProvenance(
	files: TrackedFileProvenance,
	cwd: string | null | undefined,
): FileProvenance {
	const allPaths = [
		...files.read.map((entry) => entry.path),
		...files.modified.map((entry) => entry.path),
		...files.created.map((entry) => entry.path),
		...files.deleted.map((entry) => entry.path),
		...files.moved.flatMap((move) => [move.from.path, move.to.path]),
	];
	const rootMappings = inferRootMappings(allPaths, cwd);
	const normalizePath = (path: TrackedPath): string => normalizeTrackedPath(path, rootMappings, cwd);
	const created = uniqStrings(files.created.map(normalizePath));
	const deleted = uniqStrings(files.deleted.map(normalizePath));
	const moved = uniqMoves(files.moved.map((move) => ({ from: normalizePath(move.from), to: normalizePath(move.to) })));
	const movedPaths = new Set<string>(moved.flatMap((move) => [move.from, move.to]));
	const createdSet = new Set(created);
	const deletedSet = new Set(deleted);
	const modified = uniqStrings(files.modified.map(normalizePath)).filter(
		(path) => path && !createdSet.has(path) && !deletedSet.has(path) && !movedPaths.has(path),
	);
	const modifiedSet = new Set(modified);
	const read = uniqStrings(files.read.map(normalizePath)).filter(
		(path) => path && !modifiedSet.has(path) && !createdSet.has(path) && !deletedSet.has(path) && !movedPaths.has(path),
	);
	return { read, modified, created, deleted, moved };
}

function normalizeFileProvenance(files: FileProvenance, cwd: string | null | undefined): FileProvenance {
	const canonicalPath = (path: string): TrackedPath => ({ path, basis: "canonical" });
	return normalizeTrackedFileProvenance({
		read: files.read.map(canonicalPath),
		modified: files.modified.map(canonicalPath),
		created: files.created.map(canonicalPath),
		deleted: files.deleted.map(canonicalPath),
		moved: files.moved.map((move) => ({ from: canonicalPath(move.from), to: canonicalPath(move.to) })),
	}, cwd);
}

function stripReadSliceSuffix(path: string): string {
	return path.replace(/:(\d+)-(\d+)$/, "");
}

function firstDefinedString(...values: Array<unknown>): string | null {
	for (const value of values) {
		if (typeof value === "string" && value.length > 0) return value;
	}
	return null;
}

function extractTextFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (!block || typeof block !== "object") return "";
			if ((block as { type?: unknown }).type === "text") {
				return String((block as { text?: unknown }).text ?? "");
			}
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function extractJsonObject(text: string, prefix: string): Record<string, unknown> | null {
	const trimmed = text.trim();
	if (!trimmed.startsWith(prefix)) return null;
	const jsonText = trimmed.slice(prefix.length).trim();
	if (!jsonText.startsWith("{")) return null;
	try {
		const parsed = JSON.parse(jsonText);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? parsed as Record<string, unknown>
			: null;
	} catch (error) {
		if (error instanceof SyntaxError) return null;
		throw error;
	}
}

function extractCliNamedArg(cmd: string, key: string): string | null {
	const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = cmd.match(new RegExp(`(?:^|\\s)${escapedKey}=(?:"([^"]+)"|'([^']+)'|(\\S+))`));
	return firstDefinedString(...(match?.slice(1) ?? []));
}

function commandStartsWith(cmd: string, name: string): boolean {
	const trimmed = cmd.trim();
	return trimmed === name || trimmed.startsWith(`${name} `);
}

function extractReadPathFromCliCommand(cmd: string): string | null {
	const readFileMatch = cmd.match(/(?:^|\s)read_file\s+.*?\bpath=(?:"([^"]+)"|'([^']+)'|(\S+))/);
	if (readFileMatch) {
		return stripReadSliceSuffix(firstDefinedString(...readFileMatch.slice(1)) ?? "");
	}
	const simpleReadMatch = cmd.match(/^(?:read|cat)\s+(?:"([^"]+)"|'([^']+)'|(\S+))/);
	if (simpleReadMatch) {
		return stripReadSliceSuffix(firstDefinedString(...simpleReadMatch.slice(1)) ?? "");
	}
	return null;
}

function parseRpExecActions(cmd: string): FileAction[] {
	const normalized = cmd.trim();
	if (!normalized) return [];

	const actions: FileAction[] = [];
	const pushPathAction = (kind: Extract<FileAction, { path: string }>["kind"], path: string | null): void => {
		if (!path) return;
		actions.push({ kind, path, basis: "workspace" });
	};

	const readFileArgs = extractJsonObject(normalized, "call read_file");
	if (readFileArgs && typeof readFileArgs.path === "string") {
		actions.push({ kind: "read", path: stripReadSliceSuffix(readFileArgs.path), basis: "workspace" });
	}

	const applyEditsArgs = extractJsonObject(normalized, "call apply_edits");
	if (applyEditsArgs && typeof applyEditsArgs.path === "string") {
		actions.push({ kind: "modified", path: applyEditsArgs.path, basis: "workspace" });
	}

	const fileActionsArgs = extractJsonObject(normalized, "call file_actions");
	if (fileActionsArgs) {
		const action = typeof fileActionsArgs.action === "string" ? fileActionsArgs.action : "";
		const targetPath = typeof fileActionsArgs.path === "string" ? fileActionsArgs.path : null;
		const newPath = typeof fileActionsArgs.new_path === "string" ? fileActionsArgs.new_path : null;
		if (action === "create" && targetPath) actions.push({ kind: "created", path: targetPath, basis: "workspace" });
		if (action === "delete" && targetPath) actions.push({ kind: "deleted", path: targetPath, basis: "workspace" });
		if (action === "move" && targetPath && newPath) {
			actions.push({ kind: "moved", from: targetPath, to: newPath, basis: "workspace" });
		}
	}

	if (commandStartsWith(normalized, "apply_edits")) {
		pushPathAction("modified", extractCliNamedArg(normalized, "path"));
	}

	if (commandStartsWith(normalized, "file_actions")) {
		const action = extractCliNamedArg(normalized, "action");
		const targetPath = extractCliNamedArg(normalized, "path");
		const newPath = extractCliNamedArg(normalized, "new_path");
		if (action === "create" && targetPath) actions.push({ kind: "created", path: targetPath, basis: "workspace" });
		if (action === "delete" && targetPath) actions.push({ kind: "deleted", path: targetPath, basis: "workspace" });
		if (action === "move" && targetPath && newPath) {
			actions.push({ kind: "moved", from: targetPath, to: newPath, basis: "workspace" });
		}
	}

	const createOrDeleteMatch = normalized.match(/\bfile\s+(create|delete)\s+([^\s]+)/);
	if (createOrDeleteMatch) {
		actions.push({
			kind: createOrDeleteMatch[1] === "create" ? "created" : "deleted",
			path: createOrDeleteMatch[2],
			basis: "workspace",
		});
	}

	const moveMatch = normalized.match(/\bfile\s+move\s+([^\s]+)\s+([^\s]+)/);
	if (moveMatch) actions.push({ kind: "moved", from: moveMatch[1], to: moveMatch[2], basis: "workspace" });

	const readPath = extractReadPathFromCliCommand(normalized);
	if (readPath) actions.push({ kind: "read", path: readPath, basis: "workspace" });

	return actions;
}

function recordAction(fileOps: TrackedFileProvenance, action: FileAction): void {
	if (action.kind === "moved") {
		fileOps.moved.push({
			from: { path: action.from, basis: action.basis },
			to: { path: action.to, basis: action.basis },
		});
		return;
	}
	fileOps[action.kind].push({ path: action.path, basis: action.basis });
}

function toFileAction(action: CodexFileTrackingAction): FileAction {
	if (action.kind === "move") {
		return { kind: "moved", from: action.from, to: action.to, basis: "cwd" };
	}

	switch (action.operation) {
		case "read":
			return { kind: "read", path: action.path, basis: "cwd" };
		case "create":
			return { kind: "created", path: action.path, basis: "cwd" };
		case "delete":
			return { kind: "deleted", path: action.path, basis: "cwd" };
		default:
			return { kind: "modified", path: action.path, basis: "cwd" };
	}
}

export function detectFileProvenance(messages: EventMessage[], cwd?: string | null): FileProvenance {
	const toolCallsById = new Map<string, TrackedToolCall>();
	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (typeof block !== "object" || (block as { type?: unknown }).type !== "toolCall") continue;
			const blockId = typeof (block as { id?: unknown }).id === "string"
				? (block as { id: string }).id
				: null;
			const toolName = typeof (block as { name?: unknown }).name === "string"
				? (block as { name: string }).name
				: "";
			const args = (block as { arguments?: unknown }).arguments;
			const argObject = args && typeof args === "object" && !Array.isArray(args)
				? args as Record<string, unknown>
				: {};
			if (!blockId || !toolName) continue;

			const actions: FileAction[] = [];
			if (toolName === "read" && typeof argObject.path === "string") {
				actions.push({ kind: "read", path: argObject.path, basis: "cwd" });
			}
			if (toolName === "write" && typeof argObject.path === "string") {
				actions.push({ kind: "modified", path: argObject.path, basis: "cwd" });
			}
			if (toolName === "edit" && typeof argObject.path === "string") {
				actions.push({ kind: "modified", path: argObject.path, basis: "cwd" });
			}
			if (toolName === "rp") {
				const call = typeof argObject.call === "string" ? argObject.call : "";
				const callArgs = argObject.args && typeof argObject.args === "object" && !Array.isArray(argObject.args)
					? argObject.args as Record<string, unknown>
					: {};
				if (call === "read_file" && typeof callArgs.path === "string") {
					actions.push({ kind: "read", path: stripReadSliceSuffix(callArgs.path), basis: "workspace" });
				}
				if (call === "apply_edits" && typeof callArgs.path === "string") {
					actions.push({ kind: "modified", path: callArgs.path, basis: "workspace" });
				}
				if (call === "file_actions") {
					const action = typeof callArgs.action === "string" ? callArgs.action : "";
					if (action === "create" && typeof callArgs.path === "string") {
						actions.push({ kind: "created", path: callArgs.path, basis: "workspace" });
					}
					if (action === "delete" && typeof callArgs.path === "string") {
						actions.push({ kind: "deleted", path: callArgs.path, basis: "workspace" });
					}
					if (
						action === "move" &&
						typeof callArgs.path === "string" &&
						typeof callArgs.new_path === "string"
					) {
						actions.push({
							kind: "moved",
							from: callArgs.path,
							to: callArgs.new_path,
							basis: "workspace",
						});
					}
				}
			}
			if (toolName === "rp_exec" && typeof argObject.cmd === "string") {
				actions.push(...parseRpExecActions(argObject.cmd));
			}
			if (actions.length > 0) {
				toolCallsById.set(blockId, { kind: "existing", actions });
			} else if (toolName === "exec_command" || toolName === "apply_patch") {
				toolCallsById.set(blockId, { kind: "codex", toolName, toolArguments: argObject });
			}
		}
	}

	const fileOps: TrackedFileProvenance = {
		read: [],
		modified: [],
		created: [],
		deleted: [],
		moved: [],
	};

	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : null;
		if (!toolCallId) continue;
		const trackedCall = toolCallsById.get(toolCallId);
		if (!trackedCall) continue;
		const toolResultText = extractTextFromContent(message.content).toLowerCase();
		const isNoOp = /applied:\s*0|no changes applied|nothing to (do|change)/i.test(toolResultText);

		if (trackedCall.kind === "existing") {
			if (message.isError) continue;
			for (const action of trackedCall.actions) {
				if (isNoOp && action.kind === "modified") continue;
				recordAction(fileOps, action);
			}
			continue;
		}

		const actions = parseCompletedCodexFileActions({
			toolName: trackedCall.toolName,
			toolArguments: trackedCall.toolArguments,
			toolResult: { details: message.details, isError: message.isError },
			cwd,
		});
		for (const action of actions.map(toFileAction)) {
			if (trackedCall.toolName === "exec_command" && isNoOp && action.kind === "modified") continue;
			recordAction(fileOps, action);
		}
	}

	for (const { action } of collectNestedFileActions(messages, cwd)) {
		recordAction(fileOps, toFileAction(action));
	}
	return normalizeTrackedFileProvenance(fileOps, cwd);
}

function hasAnyFileProvenance(files: FileProvenance): boolean {
	return files.read.length > 0 || files.modified.length > 0 || files.created.length > 0 || files.deleted.length > 0 || files.moved.length > 0;
}


/**
	* Build the provenance checkpoint describing the prefix a boundary hides
	*
	* `compactedAwayMessages` are the branch messages an earlier compaction removed from the payload.
	* They are concatenated with the payload prefix and detected in a single pass so path identity is
	* resolved across both: root mappings are inferred from every spelling present, and a file read
	* before a compaction and modified after it resolves to `modified` alone.
	*
	* Args:
	*     args.messages (EventMessage[]): Payload prefix the boundary will hide
	*     args.compactedAwayMessages (EventMessage[]): Branch messages already hidden by compaction
	*     args.boundaryMode (BoundaryMode): Whether the boundary entry itself is hidden or kept
	*     args.boundarySignature (string | null): Signature of the boundary this checkpoint describes
	*     args.generatedAt (number): Creation timestamp, defaulting to now
	*     args.cwd (string | null): Session working directory used to canonicalize paths
	*
	* Returns:
	*     The checkpoint state, or null when no file provenance exists to report
	*/
export function buildCheckpointState(args: {
	messages: EventMessage[];
	compactedAwayMessages?: EventMessage[];
	boundaryMode: Exclude<BoundaryMode, "pending">;
	boundarySignature: string;
	generatedAt?: number;
	cwd?: string | null;
}): ToolHorizonCheckpointState | null {
	const hiddenMessages = args.compactedAwayMessages?.length
		? [...args.compactedAwayMessages, ...args.messages]
		: args.messages;
	const files = detectFileProvenance(hiddenMessages, args.cwd ?? null);
	if (!hasAnyFileProvenance(files)) return null;
	return {
		version: 1,
		scope: "before-boundary",
		boundaryMode: args.boundaryMode,
		boundarySignature: args.boundarySignature,
		generatedAt: args.generatedAt ?? Date.now(),
		files,
	};
}

function escapeCheckpointXmlText(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll("\r", "&#13;")
		.replaceAll("\n", "&#10;");
}

export function renderCheckpointMessage(
	state: ToolHorizonCheckpointState,
	useGuidance = DEFAULT_CHECKPOINT_USE_GUIDANCE,
): string {
	const lines = [
		"<checkpoint v=\"1\" scope=\"before-boundary\" fmt=\"known-root:relative-path, else cwd-relative, else absolute\">",
		`<use>${escapeCheckpointXmlText(useGuidance)}</use>`,
		"<files>",
	];
	const pushSection = (name: string, values: string[], attributes = ""): void => {
		if (values.length === 0) return;
		lines.push(`<${name}${attributes}>`);
		for (const value of values) lines.push(escapeCheckpointXmlText(value));
		lines.push(`</${name}>`);
	};
	pushSection("read", state.files.read, " state=\"unmodified\"");
	pushSection("modified", state.files.modified);
	pushSection("created", state.files.created);
	pushSection("deleted", state.files.deleted);
	if (state.files.moved.length > 0) {
		lines.push("<moved>");
		for (const move of state.files.moved) {
			lines.push(`${escapeCheckpointXmlText(move.from)} => ${escapeCheckpointXmlText(move.to)}`);
		}
		lines.push("</moved>");
	}
	lines.push("</files>", "</checkpoint>");
	return lines.join("\n");
}

function hasExactRecordKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
	const actualKeys = Object.keys(value);
	return actualKeys.length === expectedKeys.length && expectedKeys.every((key) => Object.hasOwn(value, key));
}

function parseCanonicalFileList(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	if (!value.every((entry) => typeof entry === "string" && entry.trim().length > 0)) return null;
	return [...value] as string[];
}

function parseCanonicalMoves(value: unknown): FileMove[] | null {
	if (!Array.isArray(value)) return null;
	const moves: FileMove[] = [];
	for (const entry of value) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
		const move = entry as Record<string, unknown>;
		if (!hasExactRecordKeys(move, ["from", "to"])) return null;
		const from = move.from;
		const to = move.to;
		if (typeof from !== "string" || from.trim().length === 0) return null;
		if (typeof to !== "string" || to.trim().length === 0) return null;
		moves.push({ from, to });
	}
	return moves;
}

export function normalizeCheckpointState(value: unknown, cwd?: string | null): ToolHorizonCheckpointState | null {
	if (!value || typeof value !== "object") return null;
	const raw = value as Record<string, unknown>;
	if (!hasExactRecordKeys(raw, ["version", "scope", "boundaryMode", "boundarySignature", "generatedAt", "files"])) {
		return null;
	}
	const version = raw.version === 1 ? 1 : null;
	const scope = raw.scope === "before-boundary" ? "before-boundary" : null;
	const boundaryMode = raw.boundaryMode === "from-entry" || raw.boundaryMode === "after-entry" ? raw.boundaryMode : null;
	const boundarySignature = typeof raw.boundarySignature === "string" && raw.boundarySignature.length > 0
		? raw.boundarySignature
		: null;
	if (!version || !scope || !boundaryMode || !boundarySignature) return null;
	if (typeof raw.generatedAt !== "number" || !Number.isFinite(raw.generatedAt)) return null;
	if (!raw.files || typeof raw.files !== "object" || Array.isArray(raw.files)) return null;
	const filesRaw = raw.files as Record<string, unknown>;
	if (!hasExactRecordKeys(filesRaw, ["read", "modified", "created", "deleted", "moved"])) return null;
	const read = parseCanonicalFileList(filesRaw.read);
	const modified = parseCanonicalFileList(filesRaw.modified);
	const created = parseCanonicalFileList(filesRaw.created);
	const deleted = parseCanonicalFileList(filesRaw.deleted);
	const moved = parseCanonicalMoves(filesRaw.moved);
	if (!read || !modified || !created || !deleted || !moved) return null;
	// Reapply idempotent path normalization before each deterministic rendering
	const files = normalizeFileProvenance({ read, modified, created, deleted, moved }, cwd);
	if (!hasAnyFileProvenance(files)) return null;
	return {
		version,
		scope,
		boundaryMode,
		boundarySignature,
		generatedAt: raw.generatedAt,
		files,
	};
}

export type CheckpointDecision =
	| { kind: "present"; checkpoint: ToolHorizonCheckpointState }
	| { kind: "absent" }
	| { kind: "invalid" };

function parseCheckpointDecision(value: unknown, cwd?: string | null): CheckpointDecision {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const raw = value as Record<string, unknown>;
		if (hasExactRecordKeys(raw, ["version", "state"]) && raw.version === 1 && raw.state === "absent") {
			return { kind: "absent" };
		}
	}
	const checkpoint = normalizeCheckpointState(value, cwd);
	return checkpoint ? { kind: "present", checkpoint } : { kind: "invalid" };
}

/**
	* Load the checkpoint decision paired directly with the latest boundary-state entry
	*
	* Boundary commits persist their checkpoint decision immediately before the boundary state that activates
	* it. Reading the pair as one transaction prevents a later prospective checkpoint entry from
	* shadowing the checkpoint that belongs to the still-active preceding boundary.
	*
	* Args:
	*     entries (SessionEntry[] | undefined): Current branch entries, oldest first
	*     boundaryCustomType (string): Custom type used for Tool Horizon boundary state
	*     cwd (string | null | undefined): Session working directory for path normalization
	*
	* Returns:
	*     Present or explicit-absence decision, otherwise invalid when the pair is missing or malformed
	*/
export function loadCheckpointDecisionForLatestBoundary(
	entries: SessionEntry[] | undefined,
	boundaryCustomType: string,
	cwd?: string | null,
): CheckpointDecision {
	const branch = entries ?? [];
	let boundaryIndex = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "custom" && entry.customType === boundaryCustomType) {
			boundaryIndex = i;
			break;
		}
	}
	if (boundaryIndex <= 0) return { kind: "invalid" };
	const decisionEntry = branch[boundaryIndex - 1];
	if (decisionEntry.type !== "custom" || decisionEntry.customType !== TOOL_HORIZON_CHECKPOINT_STATE_CUSTOM_TYPE) {
		return { kind: "invalid" };
	}
	return parseCheckpointDecision(decisionEntry.data, cwd);
}

function isCheckpointCustomMessage(message: EventMessage | null | undefined): boolean {
	return Boolean(
		message &&
		message.role === "custom" &&
		message.customType === TOOL_HORIZON_CHECKPOINT_MESSAGE_CUSTOM_TYPE
	);
}

function filterCheckpointMessages(
	messages: EventMessage[],
	shouldKeep: (index: number, lastIndex: number) => boolean,
): { messages: EventMessage[]; changed: boolean } {
	let lastIndex = -1;
	for (let i = 0; i < messages.length; i++) {
		if (isCheckpointCustomMessage(messages[i])) lastIndex = i;
	}
	if (lastIndex < 0) return { messages, changed: false };
	let changed = false;
	const filtered = messages.filter((message, index) => {
		if (!isCheckpointCustomMessage(message)) return true;
		if (shouldKeep(index, lastIndex)) return true;
		changed = true;
		return false;
	});
	return { messages: filtered, changed };
}

export function removeCheckpointMessages(messages: EventMessage[]): { messages: EventMessage[]; changed: boolean } {
	return filterCheckpointMessages(messages, () => false);
}

/**
	* Remove checkpoint messages and remap an index into the resulting canonical payload
	*
	* Args:
	*     messages (EventMessage[]): Payload that may contain checkpoint messages
	*     rawIndex (number): Index selected in that payload
	*
	* Returns:
	*     The checkpoint-free payload and corresponding index, or null when the selected entry itself
	*     is a checkpoint message
	*/
export function removeCheckpointMessagesAndRemapIndex(
	messages: EventMessage[],
	rawIndex: number,
): { messages: EventMessage[]; rawIndex: number } | null {
	if (isCheckpointCustomMessage(messages[rawIndex])) return null;
	let removedBefore = 0;
	const filtered = messages.filter((message, index) => {
		if (!isCheckpointCustomMessage(message)) return true;
		if (index < rawIndex) removedBefore += 1;
		return false;
	});
	return { messages: filtered, rawIndex: rawIndex - removedBefore };
}
