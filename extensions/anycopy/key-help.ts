import { formatHelpRowKeys, type KeyHelpRow } from "./key-help-data.ts";

type WrapText = (text: string, width: number) => string[];

export function renderKeyHelpLines(
	rows: readonly KeyHelpRow[],
	width: number,
	wrapText: WrapText,
	decorate: (text: string) => string = (text) => text,
): string[] {
	const contentWidth = Math.max(1, width - 2);
	return rows.flatMap((row) =>
		wrapText(decorate(`${formatHelpRowKeys(row)}: ${row.label}`), contentWidth).map((line) => `  ${line}`),
	);
}

export function getKeyHelpWindow(totalLines: number, height: number, requestedOffset: number) {
	const pageSize = Math.max(1, height - 2);
	const offset = Math.max(0, Math.min(Math.floor(requestedOffset), Math.max(0, totalLines - pageSize)));
	return {
		offset,
		end: Math.min(totalLines, offset + pageSize),
		pageSize,
	};
}
