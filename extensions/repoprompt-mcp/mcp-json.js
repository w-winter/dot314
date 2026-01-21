// mcp-json.ts - Helpers for extracting structured data from MCP tool content
function tryParseJson(text) {
    const trimmed = text.trim();
    if (!trimmed) {
        return null;
    }
    // Direct JSON
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
            return JSON.parse(trimmed);
        }
        catch {
            return null;
        }
    }
    // JSON fenced block inside markdown
    // Only accept ```json or a plain ``` fence (no language)
    const fencedMatch = trimmed.match(/```(\S*)\s*([\s\S]*?)```/i);
    if (fencedMatch) {
        const lang = fencedMatch[1].trim().toLowerCase();
        if (lang && lang !== "json") {
            return null;
        }
        const fencedBody = fencedMatch[2].trim();
        if (fencedBody.startsWith("{") || fencedBody.startsWith("[")) {
            try {
                return JSON.parse(fencedBody);
            }
            catch {
                return null;
            }
        }
    }
    return null;
}
export function extractTextContent(content) {
    return content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
}
export function extractJsonContent(content) {
    // Prefer explicit resource payloads
    for (const item of content) {
        if (item.type !== "resource") {
            continue;
        }
        if (typeof item.resource?.text === "string") {
            const parsed = tryParseJson(item.resource.text);
            if (parsed !== null) {
                return parsed;
            }
        }
    }
    // Fall back to text payloads
    const text = extractTextContent(content);
    const parsed = tryParseJson(text);
    if (parsed !== null) {
        return parsed;
    }
    return null;
}
