/**
 * Files Touched
 *
	* /files-touched command lists all files the model has read/written/edited/moved/deleted in the active
	* session branch by native Pi tools and/or the tools of repopprompt-cli and repoprompt-mcp, coalesced by
	* normalized path and sorted newest first. Selecting a file opens it in VS Code.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, Key, matchesKey, type SelectItem, SelectList, Text } from "@mariozechner/pi-tui";

import { collectFilesTouched, type FilesTouchedEntry } from "./_shared/files-touched-core.ts";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("files-touched", {
		description: "Show files read/written/edited/moved/deleted in this session",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("No UI available", "error");
				return;
			}

			const files = collectFilesTouched(ctx.sessionManager.getBranch(), ctx.cwd);
			if (files.length === 0) {
				ctx.ui.notify("No files read/written/edited/moved/deleted in this session", "info");
				return;
			}

			const openSelected = async (file: FilesTouchedEntry): Promise<void> => {
				try {
					await pi.exec("code", ["-g", file.path], { cwd: ctx.cwd });
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Failed to open ${file.path}: ${message}`, "error");
				}
			};

			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				const container = new Container();
				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
				container.addChild(new Text(theme.fg("accent", theme.bold(" Select file to open")), 0, 0));

				const items: SelectItem[] = files.map((file) => {
					const ops: string[] = [];
					if (file.operations.has("read")) ops.push(theme.fg("muted", "R"));
					if (file.operations.has("write")) ops.push(theme.fg("success", "W"));
					if (file.operations.has("edit")) ops.push(theme.fg("warning", "E"));
					if (file.operations.has("move")) ops.push(theme.fg("accent", "M"));
					if (file.operations.has("delete")) ops.push(theme.fg("error", "D"));

					return {
						value: file,
						label: `${ops.join("")} ${file.displayPath}`,
					};
				});

				const visibleRows = Math.min(files.length, 15);
				let currentIndex = 0;

				const selectList = new SelectList(items, visibleRows, {
					selectedPrefix: (t) => theme.fg("accent", t),
					selectedText: (t) => t,
					description: (t) => theme.fg("muted", t),
					scrollInfo: (t) => theme.fg("dim", t),
					noMatch: (t) => theme.fg("warning", t),
				});
				selectList.onSelect = (item) => {
					void openSelected(item.value as FilesTouchedEntry);
				};
				selectList.onCancel = () => done();
				selectList.onSelectionChange = (item) => {
					currentIndex = items.indexOf(item);
				};
				container.addChild(selectList);

				container.addChild(
					new Text(theme.fg("dim", " ↑↓ navigate • ←→ page • enter open • esc close"), 0, 0),
				);
				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

				return {
					render: (w) => container.render(w),
					invalidate: () => container.invalidate(),
					handleInput: (data) => {
						if (matchesKey(data, Key.left)) {
							currentIndex = Math.max(0, currentIndex - visibleRows);
							selectList.setSelectedIndex(currentIndex);
						} else if (matchesKey(data, Key.right)) {
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
