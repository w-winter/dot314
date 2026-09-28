// resolveSystemPrompt as of d603a2b (unchanged since d79094d), verbatim. The
// output for Pi's default base is pinned to it byte for byte.
export function legacyResolve(prompt, modelKey, config = {}) {
	const replacement = `${config.includeModelLine ? `Active model: ${modelKey}\n\n` : ""}${config.replacement ?? ""}`.trim();
	if (!replacement) return prompt;
	if (config.preservePiContext === false) return replacement;
	if (prompt === replacement || prompt.startsWith(`${replacement}\n`)) return prompt;
	const endMarker = "- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)";
	const end = prompt.indexOf(endMarker);
	if (end !== -1) return replacement + prompt.slice(end + endMarker.length);
	const starts = ["\n\n<project_context>", "\n\n# Project Context\n\n", "\nThe following skills provide specialized instructions for specific tasks.", "\nCurrent date:"]
		.map((marker) => prompt.indexOf(marker)).filter((index) => index !== -1);
	return replacement + (starts.length ? prompt.slice(Math.min(...starts)) : "");
}
