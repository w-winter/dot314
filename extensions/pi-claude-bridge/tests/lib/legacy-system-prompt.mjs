// The original replacement algorithm with Pi 1.5's docs delimiter, for
// comparing outputs when the prompt has no tagged docs section.
export function legacyResolve(prompt, modelKey, config = {}) {
	const replacement = `${config.includeModelLine ? `Active model: ${modelKey}\n\n` : ""}${config.replacement ?? ""}`.trim();
	if (!replacement) return prompt;
	if (config.preservePiContext === false) return replacement;
	if (prompt === replacement || prompt.startsWith(`${replacement}\n`)) return prompt;
	const endMarker = "- Before implementing harness changes, read the relevant docs and examples in full, following related cross-references.";
	const end = prompt.indexOf(endMarker);
	if (end !== -1) return replacement + prompt.slice(end + endMarker.length);
	const starts = ["\n\n<project_context>", "\n\n# Project Context\n\n", "\nThe following skills provide specialized instructions for specific tasks.", "\nCurrent date:"]
		.map((marker) => prompt.indexOf(marker)).filter((index) => index !== -1);
	return replacement + (starts.length ? prompt.slice(Math.min(...starts)) : "");
}
