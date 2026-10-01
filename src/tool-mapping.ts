import { createHash } from "node:crypto";
import { isMcpResourceTool } from "./connectors.ts";
import { MCP_SERVER_NAME, MCP_TOOL_PREFIX } from "./skills.ts";

// --- MCP aliases for Pi tool names ---
//
// Claude Code names a served tool `mcp__custom-tools__<name>` after replacing
// every character outside [A-Za-z0-9_-] with "_" (CC 2.1.283 `En`), and the
// Anthropic API rejects the whole request when any tool name exceeds 128
// characters ("tools.N.custom.name: String should have at most 128
// characters"). A Pi tool named `fake_name/with space` therefore came back as
// `..._name_with_space`, which no lookup map knew, so the call never reached
// Pi. Each Pi tool is served under an alias that CC leaves untouched and that
// fits the limit; every map back to Pi yields the original name.

/** Longest name the Anthropic API accepts for a tool (measured, CC 2.1.283). */
export const MAX_QUALIFIED_TOOL_NAME = 128;
const MAX_ALIAS_LENGTH = MAX_QUALIFIED_TOOL_NAME - MCP_TOOL_PREFIX.length;
const SAFE_TOOL_NAME = /^[A-Za-z0-9_-]+$/;
const HASH_LENGTH = 8;

function isServableAsIs(name: string): boolean {
	return SAFE_TOOL_NAME.test(name) && name.length <= MAX_ALIAS_LENGTH;
}

function derivedAlias(name: string, attempt: number): string {
	const hash = createHash("sha256").update(attempt === 0 ? name : `${name}\u0000${attempt}`).digest("hex").slice(0, HASH_LENGTH);
	const readable = name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, MAX_ALIAS_LENGTH - HASH_LENGTH - 1);
	return `${readable}_${hash}`;
}

/** The MCP tool name each Pi tool is served under. A name that is already
 *  safe and short enough is its own alias, so existing sessions and prompt
 *  caches are unaffected. Any other name becomes its sanitized, truncated
 *  spelling plus a hash of the original. Aliases are unique even when compared
 *  case-insensitively (the lookup maps also carry lowercase keys). They depend
 *  only on the set of names, never on order, so every query serves a tool
 *  under the same alias.
 *
 *  `owned` (Pi name -> alias) holds the aliases a running query has already
 *  registered, including withdrawn tools it keeps for late invocations. Within
 *  a query an owned alias stays with its tool: that tool keeps it, and no other
 *  name gets it or a case variant of it, not even a safe name equal to it (that
 *  name gets a hashed alias instead). Without `owned` this is the pure function
 *  of the name set that every query starts from. */
export function mcpToolAliases(names: Iterable<string>, owned: ReadonlyMap<string, string> = new Map()): Map<string, string> {
	const unique = [...new Set(names)];
	const aliases = new Map<string, string>();
	const reserved = new Set([...owned.values()].map((alias) => alias.toLowerCase()));
	const taken = new Set(reserved);
	for (const name of unique) {
		const alias = owned.get(name);
		if (alias !== undefined) aliases.set(name, alias);
	}
	for (const name of unique) {
		if (aliases.has(name) || !isServableAsIs(name) || reserved.has(name.toLowerCase())) continue;
		aliases.set(name, name);
		taken.add(name.toLowerCase());
	}
	for (const name of unique.filter((candidate) => !aliases.has(candidate)).sort()) {
		let attempt = 0;
		let alias = derivedAlias(name, attempt);
		while (taken.has(alias.toLowerCase())) alias = derivedAlias(name, ++attempt);
		aliases.set(name, alias);
		taken.add(alias.toLowerCase());
	}
	return aliases;
}

const SDK_TO_PI_TOOL_NAME: Record<string, string> = {
	read: "read", write: "write", edit: "edit", bash: "bash",
};

const BRIDGED_TOOL_PREFIXES = [
	MCP_TOOL_PREFIX,
	`mcp__${MCP_SERVER_NAME.replace(/-/g, "_")}__`,
	`mcp/${MCP_SERVER_NAME}/`,
	`mcp/${MCP_SERVER_NAME.replace(/-/g, "_")}/`,
];

// --- Provider helpers: tool name mapping ---

function bridgedToolSuffix(normalized: string): string | undefined {
	const prefix = BRIDGED_TOOL_PREFIXES.find((candidate) => normalized.startsWith(candidate));
	return prefix ? normalized.slice(prefix.length) : undefined;
}

export function isForeignMcpTool(name: unknown): boolean {
	if (typeof name !== "string") return false;
	const normalized = name.toLowerCase();
	return (normalized.startsWith("mcp__") || normalized.startsWith("mcp/")) && bridgedToolSuffix(normalized) === undefined;
}

// Maps of a query that serves Pi tools stay authoritative when a mid-turn
// deactivation empties them; an empty map otherwise means "no manifest".
const authoritativeManifests = new WeakSet<Map<string, string>>();

export function markAuthoritativeManifest(customToolNameToPi: Map<string, string>): void {
	authoritativeManifests.add(customToolNameToPi);
}

export function isPiDispatchable(name: unknown, customToolNameToPi?: Map<string, string>): boolean {
	if (typeof name !== "string" || !name) return false;
	const normalized = name.toLowerCase();
	const hasManifest = Boolean(customToolNameToPi?.size) || (customToolNameToPi !== undefined && authoritativeManifests.has(customToolNameToPi));
	if (customToolNameToPi?.has(name) || customToolNameToPi?.has(normalized)) return true;
	const bridgedSuffix = bridgedToolSuffix(normalized);
	if (bridgedSuffix !== undefined) {
		if (!hasManifest) return true;
		return customToolNameToPi?.has(`${MCP_TOOL_PREFIX}${bridgedSuffix}`) ?? false;
	}
	// A foreign MCP namespace belongs to a child-loaded server, not Pi's bridge.
	if (isForeignMcpTool(name)) return false;
	// Resource discovery is deliberately mirrored as Pi's account-access audit.
	if (isMcpResourceTool(name)) return true;
	// A populated manifest is authoritative: every other bare name is a naming slip.
	return !hasManifest;
}

export function mapToolName(name: string, customToolNameToPi?: Map<string, string>): string {
	const normalized = name.toLowerCase();
	const builtin = SDK_TO_PI_TOOL_NAME[normalized];
	if (builtin) return builtin;
	if (customToolNameToPi) {
		const mapped = customToolNameToPi.get(name) ?? customToolNameToPi.get(normalized);
		if (mapped) return mapped;
	}
	const bridgedSuffix = bridgedToolSuffix(normalized);
	if (bridgedSuffix !== undefined) {
		return customToolNameToPi?.get(`${MCP_TOOL_PREFIX}${bridgedSuffix}`) ?? bridgedSuffix;
	}
	return name;
}

// Renames for Claude Code SDK param names that differ from pi's native names.
// Keys not listed here pass through unchanged, so additional Pi parameters work automatically.
const SDK_KEY_RENAMES: Record<string, Record<string, string>> = {
	read:  { file_path: "path" },
	write: { file_path: "path" },
	edit:  { file_path: "path", old_string: "oldText", new_string: "newText", old_text: "oldText", new_text: "newText" },
};

// Maps SDK tool args to pi tool args via key renaming + pass-through.
// Pi's own prepareArguments hooks handle any structural transforms (e.g. edit oldText/newText → edits[]).
export function mapToolArgs(
	toolName: string, args: Record<string, unknown> | undefined,
): Record<string, unknown> {
	const input = args ?? {};
	const renames = SDK_KEY_RENAMES[toolName.toLowerCase()];
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input)) {
		const piKey = renames?.[key] ?? key;
		if (!(piKey in result)) result[piKey] = value; // first alias wins
	}
	// Pi bash has no default timeout; add a safety default
	if (toolName.toLowerCase() === "bash" && result.timeout == null) {
		result.timeout = 120;
	}
	return result;
}
