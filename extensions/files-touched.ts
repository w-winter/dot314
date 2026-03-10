/**
 * Files Touched
 *
 * /files-touched command lists all files the model has read/written/edited in the active session branch by
 * native Pi tools and/or the tools of repopprompt-cli and repoprompt-mcp, coalesced by path and sorted newest
 * first. Selecting a file opens it in VS Code.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, Key, matchesKey, type SelectItem, SelectList, Text } from "@mariozechner/pi-tui";

interface FileEntry {
	path: string;
	operations: Set<"read" | "write" | "edit">;
	lastTimestamp: number;
}

type FileToolName = "read" | "write" | "edit";

type TrackedToolCall = {
	path: string;
	name: FileToolName;
};

function stripReadSliceSuffix(path: string): string {
	return path.replace(/:(\d+)-(\d+)$/, "");
}

function firstDefinedString(...values: Array<unknown>): string | null {
	for (const value of values) {
		if (typeof value === "string" && value.length > 0) {
			return value;
		}
	}

	return null;
}

function extractJsonObject(text: string, prefix: string): Record<string, unknown> | null {
	const trimmed = text.trim();
	if (!trimmed.startsWith(prefix)) {
		return null;
	}

	const jsonText = trimmed.slice(prefix.length).trim();
	if (!jsonText.startsWith("{")) {
		return null;
	}

	try {
		const parsed = JSON.parse(jsonText);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
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

function getTrackedToolCall(name: string, args: Record<string, unknown>): TrackedToolCall | null {
	if (name === "read" || name === "write" || name === "edit") {
		const path = typeof args.path === "string" ? args.path : null;
		if (!path) {
			return null;
		}

		return { path, name };
	}

	if (name === "rp") {
		const rpCall = typeof args.call === "string" ? args.call : null;
		const rpArgs = args.args && typeof args.args === "object" && !Array.isArray(args.args)
			? (args.args as Record<string, unknown>)
			: null;
		if (!rpCall || !rpArgs) {
			return null;
		}

		if (rpCall === "read_file" && typeof rpArgs.path === "string") {
			return { path: rpArgs.path, name: "read" };
		}

		if (rpCall === "apply_edits" && typeof rpArgs.path === "string") {
			return { path: rpArgs.path, name: "edit" };
		}

		if (rpCall === "file_actions" && rpArgs.action === "create" && typeof rpArgs.path === "string") {
			return { path: rpArgs.path, name: "write" };
		}
	}

	if (name === "rp_exec") {
		const cmd = typeof args.cmd === "string" ? args.cmd.trim() : null;
		if (!cmd) {
			return null;
		}

		const readFileArgs = extractJsonObject(cmd, "call read_file");
		if (readFileArgs && typeof readFileArgs.path === "string") {
			return { path: stripReadSliceSuffix(readFileArgs.path), name: "read" };
		}

		const applyEditsArgs = extractJsonObject(cmd, "call apply_edits");
		if (applyEditsArgs && typeof applyEditsArgs.path === "string") {
			return { path: applyEditsArgs.path, name: "edit" };
		}

		if (commandStartsWith(cmd, "apply_edits")) {
			const path = extractCliNamedArg(cmd, "path");
			if (path) {
				return { path, name: "edit" };
			}
		}

		const fileActionsArgs = extractJsonObject(cmd, "call file_actions");
		if (fileActionsArgs && fileActionsArgs.action === "create" && typeof fileActionsArgs.path === "string") {
			return { path: fileActionsArgs.path, name: "write" };
		}

		if (commandStartsWith(cmd, "file_actions")) {
			const action = extractCliNamedArg(cmd, "action");
			const path = extractCliNamedArg(cmd, "path");
			if (action === "create" && path) {
				return { path, name: "write" };
			}
		}

		const readPath = extractReadPathFromCliCommand(cmd);
		if (readPath) {
			return { path: readPath, name: "read" };
		}
	}

	return null;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("files-touched", {
		description: "Show files read/written/edited in this session",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("No UI available", "error");
				return;
			}

			// Get the current branch (path from leaf to root)
			const branch = ctx.sessionManager.getBranch();

			// First pass: collect file-touching tool calls by toolCallId from assistant messages
			const toolCalls = new Map<string, TrackedToolCall>();

			for (const entry of branch) {
				if (entry.type !== "message") continue;
				const msg = entry.message;

				if (msg.role === "assistant" && Array.isArray(msg.content)) {
					for (const block of msg.content) {
						if (block.type !== "toolCall") {
							continue;
						}

						const tracked = getTrackedToolCall(
							block.name,
							block.arguments && typeof block.arguments === "object" && !Array.isArray(block.arguments)
								? (block.arguments as Record<string, unknown>)
								: {},
						);
						if (!tracked) {
							continue;
						}

						toolCalls.set(block.id, tracked);
					}
				}
			}

			// Second pass: match tool results to get the actual execution timestamp
			const fileMap = new Map<string, FileEntry>();

			for (const entry of branch) {
				if (entry.type !== "message") continue;
				const msg = entry.message;

				if (msg.role === "toolResult") {
					const toolCall = toolCalls.get(msg.toolCallId);
					if (!toolCall) continue;

					const { path, name } = toolCall;
					const timestamp = msg.timestamp;

					const existing = fileMap.get(path);
					if (existing) {
						existing.operations.add(name);
						if (timestamp > existing.lastTimestamp) {
							existing.lastTimestamp = timestamp;
						}
					} else {
						fileMap.set(path, {
							path,
							operations: new Set([name]),
							lastTimestamp: timestamp,
						});
					}
				}
			}

			if (fileMap.size === 0) {
				ctx.ui.notify("No files read/written/edited in this session", "info");
				return;
			}

			// Sort by most recent first
			const files = Array.from(fileMap.values()).sort((a, b) => b.lastTimestamp - a.lastTimestamp);

			const openSelected = async (file: FileEntry): Promise<void> => {
				try {
					await pi.exec("code", ["-g", file.path], { cwd: ctx.cwd });
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Failed to open ${file.path}: ${message}`, "error");
				}
			};

			// Show file picker with SelectList
			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				const container = new Container();

				// Top border
				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

				// Title
				container.addChild(new Text(theme.fg("accent", theme.bold(" Select file to open")), 0, 0));

				// Build select items with colored operations
				const items: SelectItem[] = files.map((f) => {
					const ops: string[] = [];
					if (f.operations.has("read")) ops.push(theme.fg("muted", "R"));
					if (f.operations.has("write")) ops.push(theme.fg("success", "W"));
					if (f.operations.has("edit")) ops.push(theme.fg("warning", "E"));
					const opsLabel = ops.join("");
					return {
						value: f,
						label: `${opsLabel} ${f.path}`,
					};
				});

				const visibleRows = Math.min(files.length, 15);
				let currentIndex = 0;

				const selectList = new SelectList(items, visibleRows, {
					selectedPrefix: (t) => theme.fg("accent", t),
					selectedText: (t) => t, // Keep existing colors
					description: (t) => theme.fg("muted", t),
					scrollInfo: (t) => theme.fg("dim", t),
					noMatch: (t) => theme.fg("warning", t),
				});
				selectList.onSelect = (item) => {
					void openSelected(item.value as FileEntry);
				};
				selectList.onCancel = () => done();
				selectList.onSelectionChange = (item) => {
					currentIndex = items.indexOf(item);
				};
				container.addChild(selectList);

				// Help text
				container.addChild(
					new Text(theme.fg("dim", " ↑↓ navigate • ←→ page • enter open • esc close"), 0, 0),
				);

				// Bottom border
				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

				return {
					render: (w) => container.render(w),
					invalidate: () => container.invalidate(),
					handleInput: (data) => {
						// Add paging with left/right
						if (matchesKey(data, Key.left)) {
							// Page up - clamp to 0
							currentIndex = Math.max(0, currentIndex - visibleRows);
							selectList.setSelectedIndex(currentIndex);
						} else if (matchesKey(data, Key.right)) {
							// Page down - clamp to last
							currentIndex = Math.min(items.length - 1, currentIndex + visibleRows);
							selectList.setSelectedIndex(currentIndex);
						} else {
							selectList.handleInput(data);
						}
						tui.requestRender();
					},
				};
			});
		},
	});
}
