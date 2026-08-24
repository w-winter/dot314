type WrapText = (text: string, width: number) => string[];

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
