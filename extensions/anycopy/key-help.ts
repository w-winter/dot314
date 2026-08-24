import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { formatConfiguredKey, formatHelpRowKeys, type KeyHelpRow } from "./key-help-data.ts";

export class AnycopyKeyHelp implements Component {
	private offset = 0;

	constructor(
		private readonly theme: Theme,
		private readonly rows: readonly KeyHelpRow[],
		private readonly helpKey: string,
		private readonly getViewportHeight: () => number,
		private readonly requestRender: () => void,
		private readonly done: () => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, this.helpKey as Parameters<typeof matchesKey>[1])) {
			this.done();
			return;
		}
		const pageSize = Math.max(1, this.getViewportHeight() - 7);
		if (matchesKey(data, "up")) this.offset -= 1;
		else if (matchesKey(data, "down")) this.offset += 1;
		else if (matchesKey(data, "pageup" as Parameters<typeof matchesKey>[1])) this.offset -= pageSize;
		else if (matchesKey(data, "pagedown" as Parameters<typeof matchesKey>[1])) this.offset += pageSize;
		else return;
		this.offset = Math.max(0, Math.min(this.offset, Math.max(0, this.rows.length - pageSize)));
		this.requestRender();
	}

	private fit(text: string, width: number): string {
		const clipped = truncateToWidth(text, width, this.theme.fg("dim", "..."));
		return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
	}

	render(width: number): string[] {
		const safeWidth = Math.max(32, width);
		const height = Math.max(8, this.getViewportHeight());
		const bodyHeight = Math.max(1, height - 7);
		this.offset = Math.min(this.offset, Math.max(0, this.rows.length - bodyHeight));
		const keyWidth = Math.min(28, Math.max(12, ...this.rows.map((row) => visibleWidth(formatHelpRowKeys(row)))));
		const actionWidth = Math.max(1, safeWidth - keyWidth - 7);
		const rule = "─".repeat(safeWidth - 2);
		const row = (key: string, action: string): string =>
			`${this.theme.fg("dim", "│")} ${this.theme.fg("accent", this.fit(key, keyWidth))} ${this.theme.fg("dim", "│")} ${this.fit(action, actionWidth)} ${this.theme.fg("dim", "│")}`;
		const visibleRows = this.rows.slice(this.offset, this.offset + bodyHeight);
		const lines = [
			this.theme.fg("dim", `┌${rule}┐`),
			row("Key", "Action"),
			this.theme.fg("dim", `├${"─".repeat(keyWidth + 2)}┼${"─".repeat(actionWidth + 2)}┤`),
			...visibleRows.map((item) => row(formatHelpRowKeys(item), item.label)),
		];
		while (lines.length < height - 2) lines.push(row("", ""));
		const range = this.rows.length > bodyHeight
			? `${this.offset + 1}-${this.offset + visibleRows.length} of ${this.rows.length} · Up/Down scroll · `
			: "";
		lines.push(row("", `${range}${formatConfiguredKey(this.helpKey)}/Esc close`));
		lines.push(this.theme.fg("dim", `└${rule}┘`));
		return lines.slice(0, height);
	}

	invalidate(): void {}
}
