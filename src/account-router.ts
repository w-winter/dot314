// Optional multi-account subscription routing contract.
//
// A companion extension may publish a router on `globalThis` under the
// versioned symbol below to supply a subscription profile for each fresh
// Claude request. The bridge passes only an opaque profile id, a display
// label, and an optional CLAUDE_CONFIG_DIR; credentials remain owned by the
// official Claude CLI. An incompatible shape must use a separate
// symbol or version instead of mutating this contract in place.

import type { AssistantMessageEvent, AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { homedir } from "node:os";
import { join } from "node:path";
import { debug } from "./debug.js";
import { resetTimestampMs } from "./rate-limit.js";

export const CLAUDE_ACCOUNT_ROUTER_SYMBOL = Symbol.for("kendex.pi.claude-account-router.v1");
export const CLAUDE_BRIDGE_ACCOUNT_HOST_SYMBOL = Symbol.for("kendex.pi.claude-bridge.account-host.v1");

export interface ClaudeAccountRoute {
	profileId: string;
	label: string;
	configDir?: string;
	/** Effective model selected by the companion after model-scoped quota exhaustion. */
	modelId?: string;
	fallbackReason?: "fable-quota";
}

export type ClaudeAccountFailureKind = "auth" | "billing" | "rate-limit" | "overloaded" | "server" | "network";

export interface ClaudeAccountRouterV1 {
	version: 1;
	acquire(input: {
		modelId: string;
		sessionId?: string;
		excludedProfileIds?: string[];
		forceRerank?: boolean;
		reason?: string;
	}): ClaudeAccountRoute;
	recordIdentity(profileId: string, identity: {
		email?: string;
		organization?: string;
		organizationId?: string;
		subscriptionType?: string;
		authMethod?: string;
	}): void;
	recordUsage(profileId: string, usage: unknown): void;
	recordRateLimit(profileId: string, info: Record<string, unknown> | undefined, modelId: string): number;
	recordFailure(profileId: string, kind: ClaudeAccountFailureKind, modelId: string): void;
	recordSuccess(profileId: string, sessionId?: string): void;
	current(modelId: string, sessionId?: string): ClaudeAccountRoute | undefined;
	/** Resolve an issued profile id back to its route. The bridge
	 *  persists ONLY the opaque profile id into Pi session entries (config-dir
	 *  paths are account-identifying and travel with shared session archives),
	 *  so restoring a session re-derives the config dir here. A missing router
	 *  or unknown id degrades to the default-profile rule. */
	resolveProfile?(profileId: string): Pick<ClaudeAccountRoute, "profileId" | "configDir"> | undefined;
}

export interface ClaudeBridgeAccountHostV1 {
	version: 1;
	probeProfile(input: {
		profile: ClaudeAccountRoute;
		cwd: string;
		signal?: AbortSignal;
	}): Promise<{
		identity?: {
			email?: string;
			organization?: string;
			subscriptionType?: string;
			authMethod?: string;
		};
		usage?: unknown;
	}>;
}

export function resolveClaudeAccountRouter(): ClaudeAccountRouterV1 | undefined {
	const host = globalThis as unknown as Record<PropertyKey, unknown>;
	const candidate = host[CLAUDE_ACCOUNT_ROUTER_SYMBOL] as ClaudeAccountRouterV1 | undefined;
	return candidate?.version === 1 ? candidate : undefined;
}

/** Run a companion-router telemetry callback without letting it fail the turn.
 *  The router is third-party code reached from delivery paths (a throwing
 *  recordSuccess would otherwise error a turn whose answer already rendered). */
export function safeRouterCall(label: string, call: () => void): void {
	try {
		call();
	} catch (error) {
		debug(`router callback ${label} threw:`, error);
	}
}

export function subscriberProfileEnv(
	profile: Pick<ClaudeAccountRoute, "configDir">,
	base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...base };
	// Managed profiles are subscription identities. Inherited API/provider
	// credentials and endpoint overrides would silently bypass the profile and
	// create separate billing or route its OAuth token through a gateway.
	const directOverrides = new Set([
		"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN",
		"ANTHROPIC_BASE_URL", "ANTHROPIC_CUSTOM_HEADERS", "ANTHROPIC_AWS_API_KEY",
		"ANTHROPIC_FOUNDRY_AUTH_TOKEN", "ANTHROPIC_BEDROCK_BASE_URL",
		"ANTHROPIC_VERTEX_BASE_URL", "ANTHROPIC_FOUNDRY_BASE_URL", "AWS_BEARER_TOKEN_BEDROCK",
	]);
	for (const key of Object.keys(env)) {
		if (directOverrides.has(key) || key.startsWith("CLAUDE_CODE_USE_")) delete env[key];
	}
	if (profile.configDir) env.CLAUDE_CONFIG_DIR = profile.configDir;
	else delete env.CLAUDE_CONFIG_DIR;
	return env;
}

/** The claude config dir the CHILD actually uses under this profile: the
 *  profile's own configDir, else the real default (`~/.claude`). NEVER the
 *  parent's CLAUDE_CONFIG_DIR — subscriberProfileEnv scrubs that from managed
 *  children, so any bridge-side session IO that resolved through the process
 *  env would write JSONLs where the child never looks and break resume. */
export function claudeDirForProfile(profile: Pick<ClaudeAccountRoute, "configDir">): string {
	return profile.configDir?.trim() || join(homedir(), ".claude");
}

export interface AccountSessionScope {
	accountProfileId?: string;
	claudeConfigDir?: string;
}

/** Session scope for a managed request: the opaque profile id plus the FULLY
 *  RESOLVED claude dir (see claudeDirForProfile). Empty for legacy requests,
 *  which keep reading CLAUDE_CONFIG_DIR from the process env as before. */
export function accountSessionScope(profile: ClaudeAccountRoute | undefined): AccountSessionScope {
	return profile
		? { accountProfileId: profile.profileId, claudeConfigDir: claudeDirForProfile(profile) }
		: {};
}

export function commitsVisibleOutput(event: AssistantMessageEvent): boolean {
	if (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta") {
		return event.delta.length > 0;
	}
	if (event.type === "text_end" || event.type === "thinking_end") return event.content.length > 0;
	return event.type === "toolcall_end";
}

/**
 * Holds protocol setup events until the first visible delta/tool call. A failed
 * account can then be discarded and retried without leaking a duplicate `start`
 * frame into Pi. Terminal success/error commits the buffered frames.
 */
export class RetryEventBuffer {
	private readonly pending: AssistantMessageEvent[] = [];
	private committed = false;
	private ended = false;
	private discarded = false;
	private readonly target: AssistantMessageEventStream;
	private readonly onCommit?: () => void;

	constructor(target: AssistantMessageEventStream, onCommit?: () => void) {
		this.target = target;
		this.onCommit = onCommit;
	}

	push(event: AssistantMessageEvent): void {
		if (this.discarded) return;
		if (this.committed) {
			this.target.push(event);
			return;
		}
		this.pending.push(event);
		if (commitsVisibleOutput(event) || event.type === "done" || event.type === "error") this.commit();
	}

	end(): void {
		if (this.discarded) return;
		this.ended = true;
		if (this.committed) this.target.end();
	}

	commit(): void {
		if (this.discarded || this.committed) return;
		this.committed = true;
		this.onCommit?.();
		for (const event of this.pending) this.target.push(event);
		this.pending.length = 0;
		if (this.ended) this.target.end();
	}

	discard(): void {
		if (this.committed) return;
		this.discarded = true;
		this.pending.length = 0;
	}

	get hasCommittedOutput(): boolean { return this.committed; }
}

export function rateLimitTypeFromInfo(info: Record<string, unknown> | undefined): unknown {
	return info?.rateLimitType ?? info?.rate_limit_type ?? info?.type;
}

export function rateLimitResetFromInfo(info: Record<string, unknown> | undefined): unknown {
	return info?.resetsAt ?? info?.resets_at ?? info?.resetAt ?? info?.reset_at;
}

export function rateLimitResetMs(info: Record<string, unknown> | undefined): number | undefined {
	// The seconds-vs-ms magnitude heuristic lives in resetTimestampMs; this is
	// just field extraction over it.
	return resetTimestampMs(rateLimitResetFromInfo(info));
}

// An HTTP status code counts only in an http-ish context ("status 429",
// "HTTP 500", "API Error: 529", "code: 401") — a bare 3-digit number in prose
// ("took 500ms", "line 502") must not classify (S5).
function httpStatusInText(normalized: string): number | undefined {
	const match = /\b(?:http|https|status(?: code)?|error|code)\b[^a-z0-9]{0,4}([45]\d\d)\b/.exec(normalized);
	return match ? Number(match[1]) : undefined;
}

function classifyStatusCode(status: number): ClaudeAccountFailureKind | undefined {
	if (status === 401) return "auth";
	// Anthropic maps 403 to permission_error (org restrictions,
	// oauth_org_not_allowed): this credential cannot serve the request, so
	// another profile might — same rotation posture as 401.
	if (status === 403) return "auth";
	if (status === 402) return "billing";
	if (status === 429) return "rate-limit";
	if (status === 529) return "overloaded";
	if (status >= 500 && status <= 599) return "server";
	return undefined;
}

export function classifyClaudeFailure(value: unknown): ClaudeAccountFailureKind | undefined {
	const details: unknown[] = [value];
	let numericStatus: number | undefined;
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		details.push(record.name, record.type, record.message, record.code, record.status, record.statusCode, record.body, record.error);
		for (const field of [record.status, record.statusCode]) {
			if (typeof field === "number" && Number.isInteger(field)) { numericStatus = field; break; }
		}
	}
	const text = details.map((detail) => {
		if (typeof detail === "string" || typeof detail === "number") return String(detail);
		try { return JSON.stringify(detail ?? ""); } catch { return String(detail); }
	}).join(" ");
	const normalized = text.toLowerCase().replace(/[_-]+/g, " ");
	// Structured status fields are unambiguous — classify them before prose.
	const statusKind = numericStatus !== undefined ? classifyStatusCode(numericStatus) : undefined;
	if (statusKind) return statusKind;
	// `permission error` covers the API's permission_error type (403); the bare
	// words "permission denied" alone stay unclassified — they are just as likely
	// a filesystem EACCES, which no other account can fix.
	if (/authentication (?:failed|error)|permission error|oauth org not allowed|oauth token.*expired|token.*expired|unauthorized|invalid token|login required|please run .*login|not logged in/.test(normalized)
		|| httpStatusInText(normalized) === 401 || httpStatusInText(normalized) === 403) return "auth";
	// Extra Usage is controlled by Claude account settings. A request asking for
	// it means the current model allowance was rejected, not that Pi should make
	// a billing-policy decision or globally disable the profile.
	if (/extra usage|overage/.test(normalized)) return "rate-limit";
	if (/billing error|payment|required.*billing|credit balance.*(?:low|insufficient|empty)|insufficient credits/.test(normalized)) return "billing";
	// `quota` alone is ambiguous ("disk quota exceeded") — require rate/usage
	// context words alongside it.
	const quotaInUsageContext = /\bquota\b/.test(normalized) && /\b(?:rate|usage|limits?|requests?|tokens?|messages?|api)\b/.test(normalized);
	if (/\brate limit|usage limit|session limit|weekly limit|monthly limit|limit reached|you(?:'|’)ve hit your .* limit|too many requests|resets? (?:at )?\d/.test(normalized)
		|| quotaInUsageContext
		|| httpStatusInText(normalized) === 429) return "rate-limit";
	if (/overloaded|capacity/.test(normalized) || httpStatusInText(normalized) === 529) return "overloaded";
	const statusInText = httpStatusInText(normalized);
	if (/server error|internal server/.test(normalized) || (statusInText !== undefined && statusInText >= 500)) return "server";
	if (/network|timeout|timed out|socket|econn|connection closed|fetch failed|unexpected end|\beof\b/.test(normalized)) return "network";
	return undefined;
}
