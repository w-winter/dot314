export type HintMode = "full" | "compact";

type WrapText = (text: string, width: number) => string[];

export function buildStatusTextLines(
	mode: HintMode,
	status: string,
	hintLines: readonly string[],
): string[] {
	return mode === "compact" ? [`  ${status}`] : [`  ${status}`, ...hintLines];
}

export function renderStatusHints(
	segments: readonly string[],
	width: number,
	wrapText: WrapText,
	decorate: (text: string) => string = (text) => text,
): string[] {
	const padding = "  ";
	return wrapText(decorate(segments.join(" · ")), Math.max(1, width - padding.length)).map(
		(line) => `${padding}${line}`,
	);
}
