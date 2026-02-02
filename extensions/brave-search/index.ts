/**
 * Brave Search extension
 *
 * This extension provides a token-efficient "search + clip" workflow:
 * - A manual `/ws` command (no LLM turn) for interactive browsing
 * - A `brave_search` tool for the model (optionally fetches readable page content)
 * - A `brave_grounding` tool for grounded answers with citations
 *
 * See README.md for usage and design notes
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";
// turndown-plugin-gfm has awkward typings
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { gfm } from "turndown-plugin-gfm";

type BraveFreshness = "pd" | "pw" | "pm" | "py";

type BraveFormat = "one_line" | "short" | "raw_json";

type BraveResult = {
    title: string;
    url: string;
    snippet: string;
    age?: string;

    // Preview only (kept small for chat rendering)
    content?: string;

    // Full markdown saved to disk (only present when fetchContent=true and saveToFiles=true)
    contentFilePath?: string;
};

const WS_RESULT_CUSTOM_TYPE = "brave-search:result";
const WS_GROUNDING_CUSTOM_TYPE = "brave-search:grounding";

// Custom message types (persisted for humans, filtered out of LLM context)
// NOTE: brave-search-lite:result retained for backwards compatibility with old sessions
const WS_CUSTOM_TYPES = [
    WS_RESULT_CUSTOM_TYPE,
    WS_GROUNDING_CUSTOM_TYPE,
    "brave-search-lite:result",
] as const;

const BRAVE_FRESHNESS_VALUES = new Set<BraveFreshness>(["pd", "pw", "pm", "py"]);
const BRAVE_FORMAT_VALUES = new Set<BraveFormat>(["one_line", "short", "raw_json"]);

const DEFAULT_COUNTRY = "US";

const MAX_CONTENT_CHARS = 5000;
const MAX_SAVED_CONTENT_CHARS = 250_000;
const MAX_FETCH_CONTENT_RESULTS = 3;

// Optional behavior: allow the agent to request a search via a marker in its own output
const ENABLE_WS_MARKER =
    process.env.BRAVE_SEARCH_MARKERS === "1" ||
    process.env.BRAVE_SEARCH_LITE_MARKERS === "1";
const WS_MARKER_DEDUP_WINDOW_MS = 60_000;
const recentMarkerQueries = new Map<string, number>();

function clampNumber(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}

function capText(text: string, maxChars: number): { text: string; truncated: boolean } {
    if (text.length <= maxChars) return { text, truncated: false };
    return { text: text.slice(0, maxChars), truncated: true };
}

function capSavedContent(text: string): string {
    const capped = capText(text, MAX_SAVED_CONTENT_CHARS);
    return capped.truncated ? `${capped.text}\n\n(Truncated to ${MAX_SAVED_CONTENT_CHARS} chars)` : capped.text;
}

function truncateText(text: string, maxChars: number): string {
    const normalized = text.replace(/\s+$/g, "").trim();
    if (normalized.length <= maxChars) return normalized;
    return normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd() + "…";
}

// Brave treats quoted queries strictly and can return empty results
function normalizeBraveQuery(query: string): string {
    const trimmed = query.trim();
    const hasDoubleQuotes = trimmed.startsWith("\"") && trimmed.endsWith("\"") && trimmed.length >= 2;
    const hasSingleQuotes = trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2;
    const unwrapped = (hasDoubleQuotes || hasSingleQuotes) ? trimmed.slice(1, -1) : trimmed;

    return unwrapped.trim().replace(/\s+/g, " ");
}

function extractMarkdownLinks(text: string): { label: string; url: string }[] {
    const links: { label: string; url: string }[] = [];
    const re = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;

    for (;;) {
        const match = re.exec(text);
        if (!match) break;
        links.push({ label: match[1], url: match[2] });
    }

    const seen = new Set<string>();
    return links.filter((link) => {
        if (seen.has(link.url)) return false;
        seen.add(link.url);
        return true;
    });
}

function getClipsDir(): string {
    return join(homedir(), ".pi", "agent", "extensions", "brave-search", ".clips");
}

function writeClipToFile(params: {
    title: string;
    sourceUrl: string;
    content: string;
}): string {
    const dir = getClipsDir();
    mkdirSync(dir, { recursive: true });

    const iso = new Date().toISOString().replace(/[:.]/g, "-");
    const hash = createHash("sha1").update(params.sourceUrl).digest("hex").slice(0, 10);

    const safeTitle = params.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+/, "")
        .replace(/-+$/, "")
        .slice(0, 60);

    const filename = `${iso}_${safeTitle || "clip"}_${hash}.md`;
    const filePath = join(dir, filename);

    const capped = capText(params.content, MAX_SAVED_CONTENT_CHARS);
    const header = `Source: ${params.sourceUrl}\nClipped: ${new Date().toISOString()}\n\n---\n\n`;
    const footer = capped.truncated ? `\n\n---\n\n(Truncated to ${MAX_SAVED_CONTENT_CHARS} chars)` : "";

    writeFileSync(filePath, header + capped.text + footer, "utf-8");

    return filePath;
}

function getBraveApiKey(): string {
    const key = process.env.BRAVE_API_KEY;
    if (!key) {
        throw new Error(
            "No Brave Search API key found. Set BRAVE_API_KEY. Get a key at https://api-dashboard.search.brave.com/app/keys",
        );
    }

    return key;
}

function getBraveGroundingApiKey(): string {
    const key = process.env.BRAVE_API_KEY_AI_GROUNDING;
    if (!key) {
        throw new Error(
            "No Brave AI Grounding API key found. Set BRAVE_API_KEY_AI_GROUNDING. Get a key at https://api-dashboard.search.brave.com/app/keys",
        );
    }

    return key;
}

function stripInlineUsageTag(text: string): { text: string; usage: Record<string, unknown> | null } {
    const match = text.match(/<usage>([\s\S]*?)<\/usage>/);
    if (!match) return { text, usage: null };

    const without = text.replace(match[0], "").trim();
    try {
        const parsed = JSON.parse(match[1]);
        if (parsed && typeof parsed === "object") return { text: without, usage: parsed as Record<string, unknown> };
    } catch {
        // ignore
    }

    return { text: without, usage: null };
}

async function braveGroundingChatCompletion(params: {
    question: string;
    enableResearch: boolean;
    enableCitations: boolean;
    enableEntities: boolean;
    signal: AbortSignal;
}): Promise<{ answer: string; usageInline: Record<string, unknown> | null; usageFinal: unknown | null; links: { label: string; url: string }[] }> {
    const apiKey = getBraveGroundingApiKey();

    const response = await fetch("https://api.search.brave.com/res/v1/chat/completions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-subscription-token": apiKey,
        },
        body: JSON.stringify({
            model: "brave",
            stream: true,
            messages: [{ role: "user", content: params.question }],
            extra_body: {
                enable_research: params.enableResearch,
                enable_citations: params.enableCitations,
                enable_entities: params.enableEntities,
            },
        }),
        signal: params.signal,
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${response.statusText}\n${errorText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body from Brave AI Grounding");

    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let usageFinal: unknown | null = null;

    const MAX_STREAM_CHARS = 30_000;

    const handlePayload = (payload: string) => {
        if (payload === "[DONE]") return;

        let obj: any;
        try {
            obj = JSON.parse(payload);
        } catch {
            return;
        }

        const choice = obj?.choices?.[0];
        const delta = choice?.delta;
        if (typeof delta?.content === "string") content += delta.content;
        if (obj?.usage) usageFinal = obj.usage;
    };

    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newlineIndex).trimEnd();
            buffer = buffer.slice(newlineIndex + 1);

            if (!line.startsWith("data: ")) continue;

            const payload = line.slice(6).trim();
            if (!payload) continue;

            handlePayload(payload);
        }

        if (content.length > MAX_STREAM_CHARS) break;
    }

    const stripped = stripInlineUsageTag(content);
    const answer = stripped.text.trim();

    return {
        answer,
        usageInline: stripped.usage,
        usageFinal,
        links: extractMarkdownLinks(answer),
    };
}

function isGithubBlobUrl(url: string): boolean {
    return /^https?:\/\/github\.com\/.+\/blob\//.test(url);
}

function toRawGithubUrl(url: string): string {
    const match = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/);
    if (!match) return url;

    const [, owner, repo, ref, path] = match;
    return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`;
}

function makeTurndownService(): TurndownService {
    const turndownService = new TurndownService({
        headingStyle: "atx",
        hr: "---",
        bulletListMarker: "-",
        codeBlockStyle: "fenced",
    });

    turndownService.use(gfm);

    const getExt = (node: any): string => {
        const firstTag = (element: Element) => element.outerHTML.split(">", 1)[0] + ">";

        const match = node?.outerHTML?.match(/(highlight-source-|language-)[a-z]+/);
        if (match) return match[0].split("-").pop() ?? "";

        const parent = node?.parentNode
            ? firstTag(node.parentNode as Element).match(/(highlight-source-|language-)[a-z]+/)
            : null;
        if (parent) return parent[0].split("-").pop() ?? "";

        const inner = node?.innerHTML
            ? (node.innerHTML.split(">", 1)[0] + ">")
                .match(/(highlight-source-|language-)[a-z]+/)
            : null;
        if (inner) return inner[0].split("-").pop() ?? "";

        return "";
    };

    turndownService.addRule("fenceAllPreformattedText", {
        filter: ["pre"],
        replacement: (_content, node) => {
            const ext = getExt(node);
            const code = [...(node as any).childNodes].map((c: any) => c.textContent).join("");
            return `\n\`\`\`${ext}\n${code}\n\`\`\`\n\n`;
        },
    });

    turndownService.addRule("strikethrough", {
        filter: ["del", "s"],
        replacement: (content) => `~${content}~`,
    });

    return turndownService;
}

const TURNDOWN = makeTurndownService();

function extractMarkdownFromHtml(html: string, url: string): string {
    const dom = new JSDOM(html, { url });

    const article = new Readability(dom.window.document, {
        keepClasses: true,
        debug: false,
        charThreshold: 100,
    }).parse();

    if (!article) throw new Error("Failed to parse article");

    article.content = article.content.replace(/(\<!--.*?-->)/g, "");

    if (article.title.length > 0) {
        const h2Regex = /<h2[^>]*>(.*?)<\/h2>/;
        const match = article.content.match(h2Regex);

        if (match?.[0]?.includes(article.title)) {
            article.content = article.content.replace("<h2", "<h1").replace("</h2", "</h1");
        } else {
            article.content = `<h1>${article.title}</h1>\n${article.content}`;
        }
    }

    let markdown = TURNDOWN.turndown(article.content);
    markdown = markdown.replace(/\[\]\(#[^)]*\)/g, "");

    return markdown.trim();
}

function getGithubRepoFromUrl(url: string): { owner: string; repo: string } | undefined {
    try {
        const parsed = new URL(url);
        if (parsed.hostname !== "github.com") return undefined;

        const parts = parsed.pathname.split("/").filter(Boolean);
        if (parts.length !== 2) return undefined;

        return { owner: parts[0], repo: parts[1] };
    } catch {
        return undefined;
    }
}

async function tryFetchGithubRawReadme(params: {
    owner: string;
    repo: string;
    signal: AbortSignal;
}): Promise<string | undefined> {
    // Prefer HEAD to avoid guessing default branch; fall back to common branch names
    const branches = ["HEAD", "main", "master"];

    // GitHub recognizes many README variants; try a small, common set
    const names = [
        "README.md",
        "README",
        "README.txt",
        "README.rst",
        "Readme.md",
        "readme.md",
        "readme",
        "readme.txt",
        "readme.rst",
    ];

    for (const branch of branches) {
        for (const name of names) {
            const rawUrl = `https://raw.githubusercontent.com/${params.owner}/${params.repo}/${branch}/${name}`;
            const resp = await fetch(rawUrl, { headers: { Accept: "text/plain" }, signal: params.signal });
            if (!resp.ok) continue;

            const text = await resp.text();
            if (text.trim().length === 0) continue;

            return capSavedContent(text);
        }
    }

    return undefined;
}

function extractGithubRenderedMarkdown(html: string, url: string): string | undefined {
    const dom = new JSDOM(html, { url });
    const doc = dom.window.document;

    const element =
        doc.querySelector("#readme article.markdown-body") ??
        doc.querySelector("#readme .markdown-body") ??
        doc.querySelector("article.markdown-body") ??
        doc.querySelector(".markdown-body");

    if (!element) return undefined;

    const md = TURNDOWN.turndown((element as Element).innerHTML).trim();
    return md.length > 0 ? md : undefined;
}

async function fetchPageContent(url: string, signal: AbortSignal): Promise<string> {
    const githubRepo = getGithubRepoFromUrl(url);
    if (githubRepo) {
        try {
            const raw = await tryFetchGithubRawReadme({ ...githubRepo, signal });
            if (raw) return raw;
        } catch {
            // fall through
        }
    }

    const actualUrl = isGithubBlobUrl(url) ? toRawGithubUrl(url) : url;

    const response = await fetch(actualUrl, {
        headers: {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain,*/*;q=0.8",
        },
        signal,
    });

    if (!response.ok) return `(HTTP ${response.status})`;

    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    const isProbablyText =
        contentType.includes("text/plain") ||
        contentType.includes("text/markdown") ||
        actualUrl.includes("raw.githubusercontent.com") ||
        actualUrl.toLowerCase().endsWith(".md");

    const body = await response.text();

    if (isProbablyText) return capSavedContent(body);

    if (actualUrl.includes("github.com/")) {
        const githubMarkdown = extractGithubRenderedMarkdown(body, actualUrl);
        if (githubMarkdown) return capSavedContent(githubMarkdown);
    }

    return capSavedContent(extractMarkdownFromHtml(body, actualUrl));
}

function parseWsArgs(args: string): {
    query: string;
    count: number;
    country: string;
    freshness?: BraveFreshness;
    fetchContent: boolean;
} {
    const tokens = args.trim().split(/\s+/).filter(Boolean);

    let count = 3;
    let country = DEFAULT_COUNTRY;
    let freshness: BraveFreshness | undefined;
    let fetchContent = false;

    const queryParts: string[] = [];

    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];

        if (token === "-n" && tokens[i + 1]) {
            const parsed = Number.parseInt(tokens[i + 1], 10);
            if (!Number.isNaN(parsed)) count = parsed;
            i++;
            continue;
        }

        if (token === "--country" && tokens[i + 1]) {
            country = tokens[i + 1].toUpperCase();
            i++;
            continue;
        }

        if (token === "--freshness" && tokens[i + 1]) {
            const candidate = tokens[i + 1] as BraveFreshness;
            if (BRAVE_FRESHNESS_VALUES.has(candidate)) freshness = candidate;
            i++;
            continue;
        }

        if (token === "--content") {
            fetchContent = true;
            continue;
        }

        queryParts.push(token);
    }

    return {
        query: normalizeBraveQuery(queryParts.join(" ")),
        count: clampNumber(count, 1, 10),
        country,
        freshness,
        fetchContent,
    };
}

function sanitizeFreshness(value: unknown): BraveFreshness | undefined {
    const candidate = String(value ?? "").trim().slice(0, 2) as BraveFreshness;
    return BRAVE_FRESHNESS_VALUES.has(candidate) ? candidate : undefined;
}

function sanitizeFormat(value: unknown): BraveFormat {
    const candidate = String(value ?? "short").trim() as BraveFormat;
    return BRAVE_FORMAT_VALUES.has(candidate) ? candidate : "short";
}

function normalizeCountry(value: unknown): string {
    return String(value ?? DEFAULT_COUNTRY).toUpperCase();
}

function getEffectiveCount(count: number, fetchContent: boolean): number {
    return fetchContent ? Math.min(count, MAX_FETCH_CONTENT_RESULTS) : count;
}

async function fetchBraveResults(params: {
    query: string;
    count: number;
    country: string;
    freshness?: BraveFreshness;
    fetchContent: boolean;
    saveToFiles: boolean;
    signal: AbortSignal;
}): Promise<BraveResult[]> {
    const apiKey = getBraveApiKey();
    const normalizedQuery = normalizeBraveQuery(params.query);

    const searchParams = new URLSearchParams({
        q: normalizedQuery,
        count: Math.min(params.count, 20).toString(),
        country: params.country,
    });

    if (params.freshness) searchParams.append("freshness", params.freshness);

    const response = await fetch(`https://api.search.brave.com/res/v1/web/search?${searchParams.toString()}`, {
        headers: {
            Accept: "application/json",
            "Accept-Encoding": "gzip",
            "X-Subscription-Token": apiKey,
        },
        signal: params.signal,
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${response.statusText}\n${errorText}`);
    }

    const data = (await response.json()) as any;
    const results: BraveResult[] = [];

    const pushResults = (items: any[], mapUrl: (r: any) => string) => {
        for (const r of items) {
            if (results.length >= params.count) break;
            results.push({
                title: String(r?.title ?? ""),
                url: String(mapUrl(r) ?? ""),
                snippet: String(r?.description ?? ""),
                age: r?.age ?? r?.page_age,
            });
        }
    };

    const webResults = data?.web?.results;
    if (Array.isArray(webResults)) pushResults(webResults, (r) => r?.url);

    if (results.length === 0) {
        const newsResults = data?.news?.results;
        if (Array.isArray(newsResults)) pushResults(newsResults, (r) => r?.url ?? r?.url_source ?? "");
    }

    if (params.fetchContent) {
        for (const result of results) {
            if (!result.url) continue;

            try {
                const fullContent = await fetchPageContent(result.url, params.signal);
                result.content = truncateText(fullContent, MAX_CONTENT_CHARS);

                if (params.saveToFiles) {
                    result.contentFilePath = writeClipToFile({
                        title: result.title || "clip",
                        sourceUrl: result.url,
                        content: fullContent,
                    });
                }
            } catch (e: any) {
                result.content = `(Error: ${e?.message ?? String(e)})`;
            }
        }
    }

    return results;
}

function formatResultsAsText(results: BraveResult[]): string {
    const blocks = results.map((r, index) => {
        const age = r.age ? ` (${r.age})` : "";
        const saved = r.contentFilePath ? `\nSaved: ${r.contentFilePath}` : "";
        const snippet = r.snippet ? `\nSnippet: ${truncateText(r.snippet, 400)}` : "";
        const content = r.content ? `\n\nContent (preview):\n${r.content}` : "";

        return `--- Result ${index + 1} ---${saved}\nURL: ${r.url}\nTitle: ${r.title}${age}${snippet}${content}`;
    });

    return blocks.join("\n\n");
}

function extractTextFromAgentMessage(message: any): string {
    if (!message || typeof message !== "object") return "";
    if (message.role !== "assistant") return "";

    const content = (message as any).content;
    if (!Array.isArray(content)) return "";

    return content
        .filter((c) => c && typeof c === "object" && c.type === "text" && typeof c.text === "string")
        .map((c) => c.text)
        .join("\n");
}

function extractWsMarkerQueries(text: string): string[] {
    const queries: string[] = [];
    const re = /\[\[ws:(.*?)\]\]/g;

    for (;;) {
        const match = re.exec(text);
        if (!match) break;
        const query = match[1]?.trim();
        if (query) queries.push(query);
    }

    return queries;
}

function normalizeDirectUrlQuery(query: string): string | undefined {
    const trimmed = normalizeBraveQuery(query);

    if (/^https?:\/\//i.test(trimmed)) return trimmed;

    const siteRaw = trimmed.match(/^site:(raw\.githubusercontent\.com\/\S+)$/i);
    if (siteRaw?.[1]) return `https://${siteRaw[1]}`;

    const rawNoScheme = trimmed.match(/^(raw\.githubusercontent\.com\/\S+)$/i);
    if (rawNoScheme?.[1]) return `https://${rawNoScheme[1]}`;

    return undefined;
}

async function fetchDirectUrlResult(params: {
    url: string;
    saveToFiles: boolean;
    signal: AbortSignal;
}): Promise<BraveResult> {
    const fullContent = await fetchPageContent(params.url, params.signal);

    return {
        title: params.url,
        url: params.url,
        snippet: "(Direct fetch)",
        content: truncateText(fullContent, MAX_CONTENT_CHARS),
        contentFilePath: params.saveToFiles
            ? writeClipToFile({
                title: "clip",
                sourceUrl: params.url,
                content: fullContent,
            })
            : undefined,
    };
}

function shouldAddWebDocWorkflowNudge(prompt: string): boolean {
    const p = String(prompt ?? "").toLowerCase();

    const hasUrl = /\bhttps?:\/\/\S+/i.test(p) || /\bwww\./i.test(p);
    const hasSiteOperator = /\bsite:\S+/i.test(p);
    const mentionsWebContext = /\b(web|online|website|url|link)\b/i.test(p);
    const mentionsCommonHosts = /\b(github|gitlab|bitbucket)\b/i.test(p);
    const mentionsDocs = /\b(readme|docs?|documentation|changelog|release notes|spec|api reference)\b/i.test(p);

    // Be conservative: avoid nudging on "docs"/"README" alone, since it may refer to local files
    return hasUrl || hasSiteOperator || ((mentionsWebContext || mentionsCommonHosts) && mentionsDocs);
}

function wantsCitations(prompt: string): boolean {
    // Avoid triggering on "source code"; focus on common citation language
    return /\b(cite|citation|citations|sources?|grounded)\b/i.test(prompt);
}

function buildWebDocWorkflowNudge(baseSystemPrompt: string, includeGroundingHint: boolean): string {
    return (
        baseSystemPrompt +
        "\n\n[Web search workflow]\n" +
        "If the user asks about a specific web page or online documentation, use brave_search with fetchContent=true (do this on the first call). " +
        "When fetchContent=true, the tool output includes a Saved: /path/to/file.md line containing the full markdown. " +
        "Read that file and answer from it. Do not paste large markdown blocks into the chat. " +
        "If the user provides a specific URL (including raw.githubusercontent.com), pass the URL directly as the query with fetchContent=true; the tool will fetch and clip it." +
        (includeGroundingHint
            ? " If the user explicitly asks for citations/sources, you may use brave_grounding to produce a grounded answer."
            : "")
    );
}

function shouldProcessMarkerQuery(query: string, now: number): boolean {
    const last = recentMarkerQueries.get(query);
    if (last !== undefined && now - last < WS_MARKER_DEDUP_WINDOW_MS) return false;

    recentMarkerQueries.set(query, now);

    for (const [q, ts] of recentMarkerQueries.entries()) {
        if (now - ts > WS_MARKER_DEDUP_WINDOW_MS) recentMarkerQueries.delete(q);
    }

    return true;
}

export default function (pi: ExtensionAPI) {
    pi.on("before_agent_start", async (event) => {
        if (!shouldAddWebDocWorkflowNudge(event.prompt ?? "")) return;

        return {
            systemPrompt: buildWebDocWorkflowNudge(
                event.systemPrompt,
                wantsCitations(event.prompt ?? ""),
            ),
        };
    });

    pi.on("context", async (event) => {
        const filtered = event.messages.filter(
            (m: any) => !(m?.role === "custom" && WS_CUSTOM_TYPES.includes(m?.customType)),
        );

        return filtered.length === event.messages.length ? undefined : { messages: filtered };
    });

    pi.registerCommand("ws", {
        description: "Brave web search",
        handler: async (args, ctx) => {
            const { query, count, country, freshness, fetchContent } = parseWsArgs(args);
            if (!query) {
                ctx.ui.notify(
                    "Usage: /ws <query> [--freshness pd|pw|pm|py] [-n N] [--country US] [--content]",
                    "warning",
                );
                return;
            }

            const effectiveCount = getEffectiveCount(count, fetchContent);
            const signal = AbortSignal.timeout(fetchContent ? 30_000 : 12_000);

            let results: BraveResult[];
            try {
                results = await fetchBraveResults({
                    query,
                    count: effectiveCount,
                    country,
                    freshness,
                    fetchContent,
                    saveToFiles: fetchContent,
                    signal,
                });
            } catch (e: any) {
                ctx.ui.notify(`Brave Search failed: ${e?.message ?? String(e)}`, "error");
                return;
            }

            const header = `Brave Search (count=${results.length}${freshness ? `, freshness=${freshness}` : ""}${fetchContent ? ", content" : ""}) for: ${query}`;
            const body = results.length > 0 ? formatResultsAsText(results) : "No results";

            pi.sendMessage({
                customType: WS_RESULT_CUSTOM_TYPE,
                content: `${header}\n\n${body}`,
                display: true,
                details: { query, count: effectiveCount, country, freshness, fetchContent, results },
            });
        },
    });

    pi.registerTool({
        name: "brave_search",
        label: "Brave Search",
        description: "Web search via Brave Search API. Returns compact results with citations.",
        parameters: Type.Object({
            query: Type.String({ description: "Search query" }),
            count: Type.Optional(Type.Integer({ description: "Number of results (1-10)", minimum: 1, maximum: 10 })),
            country: Type.Optional(Type.String({ description: "Country code (default US)" })),
            freshness: Type.Optional(
                Type.String({
                    description: "Optional time filter: pd (day), pw (week), pm (month), py (year)",
                }),
            ),
            fetchContent: Type.Optional(Type.Boolean({ description: "If true, fetch and extract readable page content (slower)" })),
            format: Type.Optional(
                Type.String({
                    description: "Response format: one_line | short | raw_json",
                    default: "short",
                }),
            ),
        }),
        async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
            const query = normalizeBraveQuery(String((params as any).query ?? ""));
            const fetchContent = Boolean((params as any).fetchContent ?? false);
            const count = clampNumber(Number((params as any).count ?? 3), 1, 10);
            const effectiveCount = getEffectiveCount(count, fetchContent);

            const country = normalizeCountry((params as any).country);
            const freshness = sanitizeFreshness((params as any).freshness);
            const format = sanitizeFormat((params as any).format);

            if (!query) {
                return {
                    content: [{ type: "text", text: "Error: query is required" }],
                    details: { isError: true },
                    isError: true,
                };
            }

            let results: BraveResult[] | undefined;

            // Brave Search is great for discovery, but it won't reliably return results for raw file URLs.
            // If the caller wants content and provides a direct URL (or a raw.githubusercontent.com site: query), fetch it directly.
            if (fetchContent) {
                const directUrl = normalizeDirectUrlQuery(query);
                if (directUrl) {
                    try {
                        results = [
                            await fetchDirectUrlResult({
                                url: directUrl,
                                saveToFiles: true,
                                signal,
                            }),
                        ];
                    } catch (e: any) {
                        return {
                            content: [{ type: "text", text: `Direct fetch failed: ${e?.message ?? String(e)}` }],
                            details: { query: directUrl, fetchContent: true },
                            isError: true,
                        };
                    }
                }
            }

            if (!results) {
                try {
                    results = await fetchBraveResults({
                        query,
                        count: effectiveCount,
                        country,
                        freshness,
                        fetchContent,
                        saveToFiles: fetchContent,
                        signal,
                    });
                } catch (e: any) {
                    return {
                        content: [{ type: "text", text: `Brave Search failed: ${e?.message ?? String(e)}` }],
                        details: { query, count: effectiveCount, country, freshness, fetchContent },
                        isError: true,
                    };
                }
            }

            const resultsFinal = results ?? [];

            if (format === "raw_json") {
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({ query, count: effectiveCount, country, freshness, fetchContent, results: resultsFinal }, null, 2),
                        },
                    ],
                    details: { query, count: effectiveCount, country, freshness, fetchContent, results: resultsFinal },
                };
            }

            if (format === "one_line") {
                const top = resultsFinal[0];
                const line = top ? `${top.title} — ${top.url}${top.age ? ` (${top.age})` : ""}` : "No results";

                return {
                    content: [{ type: "text", text: line }],
                    details: { query, count: effectiveCount, country, freshness, fetchContent, results: resultsFinal },
                };
            }

            const text = resultsFinal.length > 0 ? formatResultsAsText(resultsFinal) : "No results";
            return {
                content: [{ type: "text", text }],
                details: { query, count: effectiveCount, country, freshness, fetchContent, results: resultsFinal },
            };
        },
    });

    pi.registerTool({
        name: "brave_grounding",
        label: "Brave Grounding",
        description: "Grounded answer via Brave AI Grounding (chat/completions) with optional citations",
        parameters: Type.Object({
            question: Type.String({ description: "Question to answer" }),
            enableResearch: Type.Optional(Type.Boolean({ description: "Enable research mode (default true)" })),
            enableCitations: Type.Optional(Type.Boolean({ description: "Ask for citations (default true)" })),
            enableEntities: Type.Optional(Type.Boolean({ description: "Ask for entity extraction (default false)" })),
            maxAnswerChars: Type.Optional(Type.Integer({ description: "Max characters of answer to return", minimum: 200, maximum: 10000 })),
        }),
        async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
            const question = String((params as any).question ?? "").trim();
            if (!question) {
                return {
                    content: [{ type: "text", text: "Error: question is required" }],
                    details: { isError: true },
                    isError: true,
                };
            }

            const enableResearch = Boolean((params as any).enableResearch ?? true);
            const enableCitations = Boolean((params as any).enableCitations ?? true);
            const enableEntities = Boolean((params as any).enableEntities ?? false);
            const maxAnswerChars = clampNumber(Number((params as any).maxAnswerChars ?? 2500), 200, 10000);

            let result;
            try {
                result = await braveGroundingChatCompletion({
                    question,
                    enableResearch,
                    enableCitations,
                    enableEntities,
                    signal,
                });
            } catch (e: any) {
                return {
                    content: [{ type: "text", text: `Brave Grounding failed: ${e?.message ?? String(e)}` }],
                    details: { question, enableResearch, enableCitations, enableEntities },
                    isError: true,
                };
            }

            const answer = truncateText(result.answer, maxAnswerChars);

            return {
                content: [{ type: "text", text: answer }],
                details: {
                    question,
                    enableResearch,
                    enableCitations,
                    enableEntities,
                    citations: result.links,
                    usageInline: result.usageInline,
                    usageFinal: result.usageFinal,
                },
            };
        },
    });

    pi.on("turn_end", async (event, ctx) => {
        if (!ENABLE_WS_MARKER) return;

        const text = extractTextFromAgentMessage(event.message);
        const queries = extractWsMarkerQueries(text);
        if (queries.length === 0) return;

        const query = queries[0];
        const now = Date.now();

        if (!shouldProcessMarkerQuery(query, now)) return;

        let results: BraveResult[];
        try {
            results = await fetchBraveResults({
                query,
                count: 3,
                country: DEFAULT_COUNTRY,
                freshness: "pd",
                fetchContent: false,
                saveToFiles: false,
                signal: AbortSignal.timeout(12_000),
            });
        } catch (e: any) {
            if (ctx.hasUI) ctx.ui.notify(`Marker ws search failed: ${e?.message ?? String(e)}`, "error");
            return;
        }

        const payload = results.length > 0 ? formatResultsAsText(results) : "No results";
        const userMessage = `Web search results for: ${query}\n\n${payload}\n\nPlease answer the user using only these citations.`;

        if (ctx.isIdle()) {
            pi.sendUserMessage(userMessage);
        } else {
            pi.sendUserMessage(userMessage, { deliverAs: "followUp" });
        }
    });
}
