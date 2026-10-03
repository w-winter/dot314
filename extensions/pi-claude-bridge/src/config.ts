// User-facing extension config. Values are loaded from
// ~/.pi/agent/claude-bridge.json and a trusted project's
// .pi/claude-bridge.json.

import type { SettingSource } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve, sep } from "path";
import { debug, parseErrorShape } from "./debug.ts";

export type BridgeEffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

const VALID_EFFORT_LEVELS = new Set<BridgeEffortLevel>(["low", "medium", "high", "xhigh", "max"]);

/**
 * Per-session control over claude.ai connector WRITE tools when connectors are
 * enabled. `deny` (default) hides Gmail/Calendar/Drive mutating tools so
 * connector chat sessions are read-only; `allow` exposes them (used only by the
 * one-shot approved-write executor). Reads are always available.
 */
export type ConnectorWriteMode = "deny" | "allow";

/** Replaces Pi's default base in Pi's main agent prompt while retaining its
 * context suffix by default. A base the session supplies itself is kept. */
export interface SystemPromptConfig {
	replacement?: string;
	includeModelLine?: boolean;
	preservePiContext?: boolean;
}

export interface Config {
	enabled?: boolean;
	systemPrompt?: SystemPromptConfig;
	/** Low-level Claude Agent SDK plumbing. Most users won't need these. */
	provider?: {
		/** Enable Claude Code fast mode for bridge requests. */
		fastMode?: boolean;
		/** Force this Claude Code effort level for every bridge request. */
		forceEffort?: BridgeEffortLevel;
		/** Per-model Claude Code effort overrides keyed by model id (e.g. claude-opus-4-8). */
		modelEffortOverrides?: Record<string, BridgeEffortLevel>;
		/**
		 * Verbatim override for the child's filesystem setting sources.
		* By default, queries without connectors load no filesystem settings,
		* while queries with connectors load ["user"] only. Repo-controlled
		* `.claude/settings.json` files cannot inject `env`/`apiKeyHelper`
		* into the child. Listing "project"/"local" here reopens that surface —
		* only do so for checkouts you trust.
		 */
		settingSources?: SettingSource[];
		pathToClaudeCodeExecutable?: string;
		/**
		 * Expose the authenticated Claude account's claude.ai cloud MCP
		 * connectors (Gmail / Google Calendar / Google Drive, etc.) to the model.
		 * Off by default so Pi owns tool execution and tokens stay lean. Also
		 * settable via the CLAUDE_BRIDGE_ENABLE_CONNECTORS env var (env OR config
		 * enables it). Resolved from USER-scope config and env only — a project's
		 * checked-in settings cannot enable it (see USER_SCOPE_ONLY_PROVIDER_KEYS).
		 * See the Connectors section of this package's README.
		 */
		enableConnectors?: boolean;
		/**
		 * When connectors are enabled, whether their WRITE tools
		 * (create/update/delete/label/etc.) are exposed. Defaults to `deny`
		 * (read-only), enforced two ways: known write tools are removed from the
		 * model's context (disallowedTools by exact id), and a PreToolUse hook
		 * blocks any connector write tool by name prefix at call time (covers
		 * future write tools). `allow` disables both — intended ONLY for a
		 * one-shot approved-write executor process. Also settable via
		 * CLAUDE_BRIDGE_CONNECTOR_WRITE=deny|allow (env wins over config). Any
		 * value but exact `allow` is treated as `deny`. Ignored when connectors
		 * are disabled. Like enableConnectors, resolved from USER-scope config
		 * and env only (see USER_SCOPE_ONLY_PROVIDER_KEYS).
		 */
		connectorWriteMode?: ConnectorWriteMode;
		/**
		 * Let an unmanaged Claude Code child inherit ANTHROPIC_BASE_URL,
		 * ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN from the environment, for
		 * an intentional gateway or API-key setup. Off by default, and ignored
		 * for managed account profiles. Resolved from USER-scope config only
		 * (see USER_SCOPE_ONLY_PROVIDER_KEYS).
		 */
		inheritAnthropicEnv?: boolean;
	};
}

type SettingsRecord = Record<string, unknown>;

function expandHome(input: string): string {
	if (input === "~") return homedir();
	if (input.startsWith("~/")) return join(homedir(), input.slice(2));
	return input;
}

/** Root-anchored as `crates/core/src/harness/pi.rs::pi_root_is_absolute_for`
 * means it, which `isAbsolute` is not: it calls a driveless `\root` absolute
 * where the renderer does not, putting the two on different roots. Hoisted, so
 * a circular import cannot reach it inside a temporal dead zone. */
function rootAnchored(path: string, windows: boolean): boolean { return windows ? /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/.test(path) : path.startsWith("/"); }

/**
 * The Pi agent config dir: `PI_CODING_AGENT_DIR` when it names a root-anchored
 * path, else `~/.pi/agent`. Every bridge default routes through this function
 * so a host app that owns the agent dir owns
 * those paths too.
 */
export function piUserDir(): string {
	const override = expandHome(process.env.PI_CODING_AGENT_DIR?.trim() || "");
	return resolve(rootAnchored(override, process.platform === "win32") ? override : expandHome("~/.pi/agent"));
}

/**
 * Isolated mode (`CLAUDE_BRIDGE_ISOLATED=1`) reads bridge configuration only
 * from `piUserDir()/claude-bridge.json` and disables project configuration and
 * the `PATH` search for the Claude executable.
 */
export function isolatedFromEnv(): boolean {
	const v = (process.env.CLAUDE_BRIDGE_ISOLATED ?? "").trim().toLowerCase();
	return v === "1" || v === "true" || v === "yes" || v === "on";
}

function asRecord(value: unknown): SettingsRecord | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as SettingsRecord : undefined;
}

function projectSettingsPath(cwd: string): string {
	let current = resolve(cwd);
	while (true) {
		const candidate = join(current, ".pi", "settings.json");
		if (existsSync(candidate)) return candidate;
		if (existsSync(join(current, ".pi")) || existsSync(join(current, ".git")) || existsSync(join(current, ".kendex-lock.json"))) return candidate;
		const parent = dirname(current);
		if (parent === current) return join(resolve(cwd), ".pi", "settings.json");
		current = parent;
	}
}

const PROJECT_TRUST_SYMBOL = Symbol.for("kendex.pi.project-trust");

interface ProjectTrustRegistry {
	projectSettings?: Map<string, boolean>;
}

function projectTrustRegistry(): ProjectTrustRegistry {
	const host = globalThis as unknown as Record<PropertyKey, ProjectTrustRegistry | undefined>;
	const existing = host[PROJECT_TRUST_SYMBOL];
	if (existing) return existing;
	const created: ProjectTrustRegistry = {};
	host[PROJECT_TRUST_SYMBOL] = created;
	return created;
}

export function recordProjectTrust(ctx: { cwd?: string; isProjectTrusted?: () => boolean }): void {
	if (!ctx.cwd) return;
	// Isolated mode never reads project config, so recording trust would only
	// run the cwd-ancestor `.pi/settings.json` walk (a filesystem probe outside
	// the host-owned dirs) for a result nothing consumes. Skip it entirely.
	if (isolatedFromEnv()) return;
	let trusted = true;
	try {
		trusted = ctx.isProjectTrusted?.() === true;
	} catch {
		trusted = false;
	}
	const registry = projectTrustRegistry();
	if (!registry.projectSettings) registry.projectSettings = new Map();
	registry.projectSettings.set(projectSettingsPath(ctx.cwd), trusted);
}

function projectSettingsTrusted(settingsPath: string): boolean {
	return projectTrustRegistry().projectSettings?.get(settingsPath) === true;
}
// The last line of Pi's default base (system-prompt.ts, the docs section).
const PI_DOCS_LINE = "- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)";
// How Pi renders its tools and docs sections in the prompt: each opens with
// its tag after a blank line and ends with a fixed line and its closing tag
// (buildSystemPromptSections, getSystemMessageText).
const PI_TOOLS_BLOCK = { open: "\n\n<tools>\n", close: "\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.\n</tools>" };
const PI_DOCS_BLOCK = { open: "\n\n<docs>\n", close: `\n${PI_DOCS_LINE}\n</docs>` };

/** Where Pi's rendered block sits in the prompt, found by its closing text. */
function piBlockRange(prompt: string, block: { open: string; close: string }): [number, number] | undefined {
	const close = prompt.indexOf(block.close);
	const open = close === -1 ? -1 : prompt.lastIndexOf(block.open, close);
	return open === -1 ? undefined : [open, close + block.close.length];
}

/** The preamble buildSystemPromptSections sets when the session supplies no
 * base of its own. Pi does not export its builder from the package index, so
 * tests/unit-custom-base-prompt.mjs compares this copy with the builder's. */
export const PI_DEFAULT_PREAMBLE = "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";

/**
 * Whether the prompt's base is Pi's default one. Pi builds a custom base
 * (SYSTEM.md, --system-prompt, an SDK or pi-subagents systemPrompt) into the
 * `preamble` section and its default base only when there is none, so a
 * sectioned prompt is decided by that section alone: it always comes first
 * and a change of base patches it in place. Section names and positions are
 * no evidence, since a replayed patch keeps old positions and extensions may
 * name sections `tools`, `rules` or `docs`. A content-only prompt (a
 * before_agent_start forced prompt) is Pi's rendered prompt plus a hook's
 * text, so it has Pi's default base when it starts with that preamble.
 */
function hasPiDefaultBase(prompt: string, preamble: string | undefined): boolean {
	return preamble !== undefined ? preamble === PI_DEFAULT_PREAMBLE : prompt.startsWith(PI_DEFAULT_PREAMBLE);
}

/**
 * Applies a configured replacement to Pi's main agent prompt. The caller
 * decides which prompt that is (see pi-sessions.ts) and passes its replayed
 * `preamble` section, or undefined for a content-only prompt.
 *
 * The replacement substitutes Pi's default base only, exactly as it always
 * has. A base the session supplied itself is the session's own instructions,
 * not Pi context, so it is kept: the replacement is prepended to the complete
 * prompt, whatever preservePiContext says. The same holds for a content-only
 * prompt that does not open with Pi's default base.
 *
 * Over Pi's default base, the replacement takes the place of Pi's preamble,
 * tools and docs; every other section Pi rendered follows in Pi's order,
 * including its rules (its rules, the tool guidelines and the extensions'
 * promptGuidelines). Pi appends a section it re-adds, so a session that
 * switches to Pi's default base has its tools and docs after cwd.
 */
export function resolveSystemPrompt(prompt: string, modelKey: string, config: SystemPromptConfig = {}, preamble?: string): string {
	const replacement = `${config.includeModelLine ? `Active model: ${modelKey}\n\n` : ""}${config.replacement ?? ""}`.trim();
	if (!replacement) return prompt;
	if (!hasPiDefaultBase(prompt, preamble)) {
		if (prompt === replacement || prompt.startsWith(`${replacement}\n`)) return prompt;
		return prompt ? `${replacement}\n\n${prompt}` : replacement;
	}
	if (config.preservePiContext === false) return replacement;
	if (prompt === replacement || prompt.startsWith(`${replacement}\n`)) return prompt;
	const end = prompt.indexOf(PI_DOCS_LINE);
	if (end !== -1) {
		const docs = piBlockRange(prompt, PI_DOCS_BLOCK);
		if (!docs) return replacement + prompt.slice(end + PI_DOCS_LINE.length);
		const tools = piBlockRange(prompt, PI_TOOLS_BLOCK);
		// Pi renders its tools and docs as separate sections, in either order.
		const dropped = (tools && (tools[1] <= docs[0] || tools[0] >= docs[1]) ? [tools, docs] : [docs]).sort((a, b) => a[0] - b[0]);
		let kept = "";
		let from = prompt.startsWith(PI_DEFAULT_PREAMBLE) ? PI_DEFAULT_PREAMBLE.length : 0;
		for (const [start, stop] of dropped) {
			kept += prompt.slice(from, start);
			from = stop;
		}
		return replacement + kept + prompt.slice(from);
	}
	const starts = ["\n\n<project_context>", "\n\n# Project Context\n\n", "\nThe following skills provide specialized instructions for specific tasks.", "\nCurrent date:"]
		.map((marker) => prompt.indexOf(marker)).filter((index) => index !== -1);
	return replacement + (starts.length ? prompt.slice(Math.min(...starts)) : "");
}

export function tryParseJson(path: string): Partial<Config> {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch (error) {
		// Malformed optional config should not write raw terminal diagnostics;
		// stdout/stderr output can corrupt active Pi TUI widgets. The debug log is
		// the one place a silently-ignored file explains itself.
		debug(`config: ignoring malformed ${path}: ${parseErrorShape(error)}`);
		return {};
	}
}

// Connector enablement and write mode decide whether the child claude gains
// access to the account's live connectors (mail, calendar, files) and whether
// their WRITE tools are exposed; inheritAnthropicEnv decides whether the
// child's traffic and credentials may follow an exported gateway. A
// repo-controlled channel (a checkout's
// `.pi/settings.json` or `.pi/claude-bridge.json`, even when the project is
// trusted for ordinary options) must not be able to flip them: these keys
// resolve from USER scope and the env vars only, mirroring the
// settingSourcesForQuery rationale — whoever writes user scope already owns
// the process.
const USER_SCOPE_ONLY_PROVIDER_KEYS = ["enableConnectors", "connectorWriteMode", "inheritAnthropicEnv"] as const;

function stripUserScopeOnlyProviderKeys(config: Partial<Config>): Partial<Config> {
	if (!config.provider) return config;
	const provider = { ...config.provider };
	for (const key of USER_SCOPE_ONLY_PROVIDER_KEYS) delete provider[key];
	return { ...config, provider };
}

function boolFrom(raw: SettingsRecord, key: string): boolean | undefined {
	return typeof raw[key] === "boolean" ? raw[key] as boolean : undefined;
}

function stringFrom(raw: SettingsRecord, key: string): string | undefined {
	const value = raw[key];
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeSystemPromptConfig(value: unknown): SystemPromptConfig {
	const raw = asRecord(value);
	if (!raw) return {};
	const replacement = stringFrom(raw, "replacement");
	const includeModelLine = boolFrom(raw, "includeModelLine");
	const preservePiContext = boolFrom(raw, "preservePiContext");
	return {
		...(replacement ? { replacement } : {}),
		...(includeModelLine !== undefined ? { includeModelLine } : {}),
		...(preservePiContext !== undefined ? { preservePiContext } : {}),
	};
}

export function normalizeConnectorWriteMode(value: unknown): ConnectorWriteMode | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	if (normalized === "deny" || normalized === "allow") return normalized;
	return undefined;
}

export function normalizeEffortLevel(value: unknown): BridgeEffortLevel | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	if (normalized === "" || normalized === "none" || normalized === "auto" || normalized === "default") return undefined;
	return VALID_EFFORT_LEVELS.has(normalized as BridgeEffortLevel) ? normalized as BridgeEffortLevel : undefined;
}

export function normalizeModelEffortOverrides(value: unknown): Record<string, BridgeEffortLevel> | undefined {
	let source: unknown = value;
	if (typeof source === "string") {
		const trimmed = source.trim();
		if (!trimmed || trimmed === "{}") return undefined;
		try {
			source = JSON.parse(trimmed);
		} catch {
			return undefined;
		}
	}
	const record = asRecord(source);
	if (!record) return undefined;

	const out: Record<string, BridgeEffortLevel> = {};
	for (const [modelId, rawEffort] of Object.entries(record)) {
		const key = modelId.trim();
		const effort = normalizeEffortLevel(rawEffort);
		if (key && effort) out[key] = effort;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeProviderConfig(provider: Config["provider"] | undefined): Config["provider"] {
	if (!provider) return {};
	const raw = provider as SettingsRecord;
	const out: Config["provider"] = { ...provider };
	const forceEffort = normalizeEffortLevel(raw.forceEffort);
	if (forceEffort) out.forceEffort = forceEffort;
	else delete out.forceEffort;
	const modelEffortOverrides = normalizeModelEffortOverrides(raw.modelEffortOverrides);
	if (modelEffortOverrides) out.modelEffortOverrides = modelEffortOverrides;
	else delete out.modelEffortOverrides;
	// Fail closed: legacy config files are merged raw, so an unvalidated
	// connectorWriteMode (e.g. "Deny", "read-only", true) must not slip through as
	// a truthy non-"allow" value. Drop anything that isn't exactly deny/allow so
	// the resolver falls back to the default deny.
	const connectorWriteMode = normalizeConnectorWriteMode(raw.connectorWriteMode);
	if (connectorWriteMode) out.connectorWriteMode = connectorWriteMode;
	else delete out.connectorWriteMode;
	if (typeof raw.inheritAnthropicEnv !== "boolean") delete out.inheritAnthropicEnv;
	return out;
}

function configFile(path: string): Partial<Config> {
	const raw = asRecord(tryParseJson(path)) ?? {};
	const enabled = boolFrom(raw, "enabled");
	const provider = asRecord(raw.provider) as Config["provider"];
	const systemPrompt = normalizeSystemPromptConfig(raw.systemPrompt);
	return {
		...(enabled !== undefined ? { enabled } : {}),
		...(Object.keys(systemPrompt).length ? { systemPrompt } : {}),
		...(provider ? { provider } : {}),
	};
}

/** Configuration layers, lowest precedence first. */
function configLayers(cwd: string): Partial<Config>[] {
	const layers: Partial<Config>[] = [configFile(join(piUserDir(), "claude-bridge.json"))];
	if (isolatedFromEnv()) return layers;
	const projectSettings = projectSettingsPath(cwd);
	if (!projectSettingsTrusted(projectSettings)) return layers;
	const projectPath = join(dirname(projectSettings), "claude-bridge.json");
	return [...layers, stripUserScopeOnlyProviderKeys(configFile(projectPath))];
}

function mergeLayers(layers: Partial<Config>[]): Partial<Config> {
	const merged: Partial<Config> = { provider: {}, systemPrompt: {} };
	for (const layer of layers) {
		if (layer.enabled !== undefined) merged.enabled = layer.enabled;
		merged.systemPrompt = { ...merged.systemPrompt, ...layer.systemPrompt };
		merged.provider = { ...merged.provider, ...layer.provider };
	}
	return merged;
}

export function loadConfig(cwd: string): Config {
	const config = mergeLayers(configLayers(cwd));
	return {
		enabled: config.enabled ?? true,
		systemPrompt: config.systemPrompt,
		provider: normalizeProviderConfig(config.provider),
	};
}

/** Whether bridge anomalies are told to the agent: `agentNotices: true` in the
 *  user claude-bridge.json. A project's file cannot add messages to the
 *  conversation, so its key is never read. Read at every call, so every loaded
 *  copy of the bridge agrees and an edit applies without /reload. */
export function agentNoticesEnabled(): boolean {
	return asRecord(tryParseJson(join(piUserDir(), "claude-bridge.json")))?.agentNotices === true;
}

/** Home-relative when possible — for user-facing path mentions (what to edit,
 *  what to paste into an issue) where an absolute path would leak the username. */
export function displayPath(path: string): string {
	const home = homedir();
	return home && path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}
