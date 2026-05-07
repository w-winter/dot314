/**
 * Usage Bar Extension - Shows AI provider usage stats like CodexBar
 * Run /usage to see usage for Claude, Copilot, Gemini, and Codex
 *
 * Features:
 * - Usage stats with progress bars
 * - Provider status (outages/incidents)
 * - Reset countdowns
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";

// ============================================================================
// Types
// ============================================================================

interface RateWindow {
	label: string;
	usedPercent: number;
	resetDescription?: string;
	resetsAt?: Date;
}

interface ProviderStatus {
	indicator: "none" | "minor" | "major" | "critical" | "maintenance" | "unknown";
	description?: string;
}

interface UsageSnapshot {
	provider: string;
	displayName: string;
	windows: RateWindow[];
	plan?: string;
	error?: string;
	status?: ProviderStatus;
}

// ============================================================================
// Status Polling
// ============================================================================

const STATUS_URLS: Record<string, string> = {
	anthropic: "https://status.anthropic.com/api/v2/status.json",
	codex: "https://status.openai.com/api/v2/status.json",
	copilot: "https://www.githubstatus.com/api/v2/status.json",
};

async function fetchProviderStatus(provider: string): Promise<ProviderStatus> {
	const url = STATUS_URLS[provider];
	if (!url) return { indicator: "none" };

	try {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 5000);

		const res = await fetch(url, { signal: controller.signal });
		if (!res.ok) return { indicator: "unknown" };

		const data = await res.json() as any;
		const indicator = data.status?.indicator || "none";
		const description = data.status?.description;

		return {
			indicator: indicator as ProviderStatus["indicator"],
			description,
		};
	} catch {
		return { indicator: "unknown" };
	}
}

async function fetchGeminiStatus(): Promise<ProviderStatus> {
	try {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 5000);

		const res = await fetch("https://www.google.com/appsstatus/dashboard/incidents.json", {
			signal: controller.signal,
		});
		if (!res.ok) return { indicator: "unknown" };

		const incidents = await res.json() as any[];

		// Look for active Gemini incidents (product ID: npdyhgECDJ6tB66MxXyo)
		const geminiProductId = "npdyhgECDJ6tB66MxXyo";
		const activeIncidents = incidents.filter((inc: any) => {
			if (inc.end) return false; // Not active
			const affected = inc.currently_affected_products || inc.affected_products || [];
			return affected.some((p: any) => p.id === geminiProductId);
		});

		if (activeIncidents.length === 0) {
			return { indicator: "none" };
		}

		// Find most severe
		let worstIndicator: ProviderStatus["indicator"] = "minor";
		let description: string | undefined;

		for (const inc of activeIncidents) {
			const status = inc.most_recent_update?.status || inc.status_impact;
			if (status === "SERVICE_OUTAGE") {
				worstIndicator = "critical";
				description = inc.external_desc;
			} else if (status === "SERVICE_DISRUPTION" && worstIndicator !== "critical") {
				worstIndicator = "major";
				description = inc.external_desc;
			}
		}

		return { indicator: worstIndicator, description };
	} catch {
		return { indicator: "unknown" };
	}
}

// ============================================================================
// Claude Usage
// ============================================================================

function loadClaudeToken(): string | undefined {
	// Try pi's auth.json first (has user:profile scope)
	const piAuthPath = path.join(os.homedir(), ".pi", "agent", "auth.json");
	try {
		if (fs.existsSync(piAuthPath)) {
			const data = JSON.parse(fs.readFileSync(piAuthPath, "utf-8"));
			if (data.anthropic?.access) return data.anthropic.access;
		}
	} catch {}

	// Fallback to Claude CLI keychain (macOS)
	try {
		const keychainData = execSync(
			'security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null',
			{ encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
		).trim();
		if (keychainData) {
			const parsed = JSON.parse(keychainData);
			const scopes = parsed.claudeAiOauth?.scopes || [];
			if (scopes.includes("user:profile") && parsed.claudeAiOauth?.accessToken) {
				return parsed.claudeAiOauth.accessToken;
			}
		}
	} catch {}

	return undefined;
}

async function fetchClaudeUsage(): Promise<UsageSnapshot> {
	const token = loadClaudeToken();
	if (!token) {
		return { provider: "anthropic", displayName: "Claude", windows: [], error: "No credentials" };
	}

	try {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 5000);

		const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
			headers: {
				Authorization: `Bearer ${token}`,
				"anthropic-beta": "oauth-2025-04-20",
			},
			signal: controller.signal,
		});

		if (!res.ok) {
			return { provider: "anthropic", displayName: "Claude", windows: [], error: `HTTP ${res.status}` };
		}

		const data = await res.json() as any;
		const windows: RateWindow[] = [];

		if (data.five_hour?.utilization !== undefined) {
			windows.push({
				label: "5h",
				usedPercent: data.five_hour.utilization,
				resetDescription: data.five_hour.resets_at ? formatReset(new Date(data.five_hour.resets_at)) : undefined,
			});
		}

		if (data.seven_day?.utilization !== undefined) {
			windows.push({
				label: "Week",
				usedPercent: data.seven_day.utilization,
				resetDescription: data.seven_day.resets_at ? formatReset(new Date(data.seven_day.resets_at)) : undefined,
			});
		}

		const modelWindow = data.seven_day_sonnet || data.seven_day_opus;
		if (modelWindow?.utilization !== undefined) {
			windows.push({
				label: data.seven_day_sonnet ? "Sonnet" : "Opus",
				usedPercent: modelWindow.utilization,
			});
		}

		return { provider: "anthropic", displayName: "Claude", windows };
	} catch (e) {
		return { provider: "anthropic", displayName: "Claude", windows: [], error: String(e) };
	}
}

// ============================================================================
// Copilot Usage
// ============================================================================

function loadCopilotRefreshToken(): string | undefined {
	// The copilot_internal/user endpoint needs the GitHub OAuth token (ghu_*),
	// NOT the Copilot session token (tid=*). The refresh token IS the GitHub OAuth token.
	const authPath = path.join(os.homedir(), ".pi", "agent", "auth.json");
	try {
		if (fs.existsSync(authPath)) {
			const data = JSON.parse(fs.readFileSync(authPath, "utf-8"));
			// Use refresh token (GitHub OAuth token ghu_*) for the usage API
			if (data["github-copilot"]?.refresh) return data["github-copilot"].refresh;
		}
	} catch {}

	return undefined;
}

async function fetchCopilotUsage(_modelRegistry: any): Promise<UsageSnapshot> {
	const token = loadCopilotRefreshToken();
	if (!token) {
		return { provider: "copilot", displayName: "Copilot", windows: [], error: "No token" };
	}

	const headersBase = {
		"Editor-Version": "vscode/1.96.2",
		"User-Agent": "GitHubCopilotChat/0.26.7",
		"X-Github-Api-Version": "2025-04-01",
		Accept: "application/json",
	};

	const tryFetch = async (authHeader: string) => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 5000);

		const res = await fetch("https://api.github.com/copilot_internal/user", {
			headers: {
				...headersBase,
				Authorization: authHeader,
			},
			signal: controller.signal,
		});
		return res;
	};

	try {
		// Copilot access tokens (from /login github-copilot) expect Bearer. PATs accept "token".
		// GitHub OAuth token (ghu_*) requires "token" prefix, not Bearer
		const attempts = [`token ${token}`];
		let lastStatus: number | undefined;
		let res: Response | undefined;

		for (const auth of attempts) {
			res = await tryFetch(auth);
			lastStatus = res.status;
			if (res.ok) break;
			if (res.status === 401 || res.status === 403) continue; // try next scheme
			break;
		}

		if (!res || !res.ok) {
			const status = lastStatus ?? 0;
			return { provider: "copilot", displayName: "Copilot", windows: [], error: `HTTP ${status}` };
		}

		const data = await res.json() as any;
		const windows: RateWindow[] = [];

		// Parse reset date for display
		const resetDate = data.quota_reset_date_utc ? new Date(data.quota_reset_date_utc) : undefined;
		const resetDesc = resetDate ? formatReset(resetDate) : undefined;

		// Premium interactions (e.g., Claude, o1 models) - has a cap
		if (data.quota_snapshots?.premium_interactions) {
			const pi = data.quota_snapshots.premium_interactions;
			const remaining = pi.remaining ?? 0;
			const entitlement = pi.entitlement ?? 0;
			const usedPercent = Math.max(0, 100 - (pi.percent_remaining || 0));
			windows.push({
				label: `Premium`,
				usedPercent,
				resetDescription: resetDesc ? `${resetDesc} (${remaining}/${entitlement})` : `${remaining}/${entitlement}`,
			});
		}

		// Chat quota - often unlimited, only show if limited
		if (data.quota_snapshots?.chat && !data.quota_snapshots.chat.unlimited) {
			const chat = data.quota_snapshots.chat;
			windows.push({
				label: "Chat",
				usedPercent: Math.max(0, 100 - (chat.percent_remaining || 0)),
				resetDescription: resetDesc,
			});
		}

		return {
			provider: "copilot",
			displayName: "Copilot",
			windows,
			plan: data.copilot_plan,
		};
	} catch (e) {
		return { provider: "copilot", displayName: "Copilot", windows: [], error: String(e) };
	}
}

// ============================================================================
// Gemini Usage
// ============================================================================

async function fetchGeminiUsage(_modelRegistry: any): Promise<UsageSnapshot> {
	let token: string | undefined;

	// Read directly from pi's auth.json
	const piAuthPath = path.join(os.homedir(), ".pi", "agent", "auth.json");
	try {
		if (fs.existsSync(piAuthPath)) {
			const data = JSON.parse(fs.readFileSync(piAuthPath, "utf-8"));
			token = data["google-gemini-cli"]?.access;
		}
	} catch {}

	// Fallback to ~/.gemini/oauth_creds.json
	if (!token) {
		const credPath = path.join(os.homedir(), ".gemini", "oauth_creds.json");
		try {
			if (fs.existsSync(credPath)) {
				const data = JSON.parse(fs.readFileSync(credPath, "utf-8"));
				token = data.access_token;
			}
		} catch {}
	}

	if (!token) {
		return { provider: "gemini", displayName: "Gemini", windows: [], error: "No credentials" };
	}

	try {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 5000);

		const res = await fetch("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: "{}",
			signal: controller.signal,
		});

		if (!res.ok) {
			return { provider: "gemini", displayName: "Gemini", windows: [], error: `HTTP ${res.status}` };
		}

		const data = await res.json() as any;
		const quotas: Record<string, number> = {};

		for (const bucket of data.buckets || []) {
			const model = bucket.modelId || "unknown";
			const frac = bucket.remainingFraction ?? 1;
			if (!quotas[model] || frac < quotas[model]) quotas[model] = frac;
		}

		const windows: RateWindow[] = [];
		let proMin = 1, flashMin = 1;
		let hasProModel = false, hasFlashModel = false;

		for (const [model, frac] of Object.entries(quotas)) {
			if (model.toLowerCase().includes("pro")) {
				hasProModel = true;
				if (frac < proMin) proMin = frac;
			}
			if (model.toLowerCase().includes("flash")) {
				hasFlashModel = true;
				if (frac < flashMin) flashMin = frac;
			}
		}

		// Always show windows if model exists (even at 0% usage)
		if (hasProModel) windows.push({ label: "Pro", usedPercent: (1 - proMin) * 100 });
		if (hasFlashModel) windows.push({ label: "Flash", usedPercent: (1 - flashMin) * 100 });

		return { provider: "gemini", displayName: "Gemini", windows };
	} catch (e) {
		return { provider: "gemini", displayName: "Gemini", windows: [], error: String(e) };
	}
}

// ============================================================================
// Antigravity Usage
// ============================================================================

type AntigravityAuth = {
	accessToken: string;
	refreshToken?: string;
	expiresAt?: number;
	projectId?: string;
};

function loadAntigravityAuthFromPiAuthJson(): AntigravityAuth | undefined {
	const piAuthPath = path.join(os.homedir(), ".pi", "agent", "auth.json");
	try {
		if (!fs.existsSync(piAuthPath)) return undefined;
		const data = JSON.parse(fs.readFileSync(piAuthPath, "utf-8"));

		// Provider is called "google-antigravity" in pi.
		const cred = data["google-antigravity"] ?? data["antigravity"] ?? data["anti-gravity"];
		if (!cred) return undefined;

		const accessToken = typeof cred.access === "string" ? cred.access : undefined;
		if (!accessToken) return undefined;

		return {
			accessToken,
			refreshToken: typeof cred.refresh === "string" ? cred.refresh : undefined,
			expiresAt: typeof cred.expires === "number" ? cred.expires : undefined,
			projectId: typeof cred.projectId === "string" ? cred.projectId : typeof cred.project_id === "string" ? cred.project_id : undefined,
		};
	} catch {
		return undefined;
	}
}

async function loadAntigravityAuth(modelRegistry: any): Promise<AntigravityAuth | undefined> {
	// Prefer model registry auth storage first (may auto-refresh).
	try {
		const accessToken = await Promise.resolve(modelRegistry?.authStorage?.getApiKey?.("google-antigravity"));
		const raw = await Promise.resolve(modelRegistry?.authStorage?.get?.("google-antigravity"));

		const projectId = typeof raw?.projectId === "string" ? raw.projectId : undefined;
		const refreshToken = typeof raw?.refresh === "string" ? raw.refresh : undefined;
		const expiresAt = typeof raw?.expires === "number" ? raw.expires : undefined;

		if (typeof accessToken === "string" && accessToken.length > 0) {
			return { accessToken, projectId, refreshToken, expiresAt };
		}
	} catch {}

	// Fallback to pi auth.json
	const fromPi = loadAntigravityAuthFromPiAuthJson();
	if (fromPi) return fromPi;

	// Last resort: env var (won't have projectId; request will likely fail)
	if (process.env.ANTIGRAVITY_API_KEY) {
		return { accessToken: process.env.ANTIGRAVITY_API_KEY };
	}

	return undefined;
}

async function refreshAntigravityAccessToken(refreshToken: string): Promise<{ accessToken: string; expiresAt?: number } | null> {
	try {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 5000);

		const clientId = process.env.ANTIGRAVITY_OAUTH_CLIENT_ID;
		const clientSecret = process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET;
		if (!clientId || !clientSecret) return null;

		const res = await fetch("https://oauth2.googleapis.com/token", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: clientId,
				client_secret: clientSecret,
				refresh_token: refreshToken,
				grant_type: "refresh_token",
			}).toString(),
			signal: controller.signal,
		});

		if (!res.ok) return null;
		const data = (await res.json()) as any;
		const accessToken = typeof data.access_token === "string" ? data.access_token : undefined;
		if (!accessToken) return null;
		const expiresIn = typeof data.expires_in === "number" ? data.expires_in : undefined;
		return {
			accessToken,
			expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : undefined,
		};
	} catch {
		return null;
	}
}

async function fetchAntigravityUsage(modelRegistry: any): Promise<UsageSnapshot> {
	const auth = await loadAntigravityAuth(modelRegistry);
	if (!auth?.accessToken) {
		return { provider: "antigravity", displayName: "Antigravity", windows: [], error: "No credentials" };
	}

	if (!auth.projectId) {
		return { provider: "antigravity", displayName: "Antigravity", windows: [], error: "Missing projectId" };
	}

	let accessToken = auth.accessToken;

	// Refresh if likely expired.
	if (auth.refreshToken && auth.expiresAt && auth.expiresAt < Date.now() + 5 * 60 * 1000) {
		const refreshed = await refreshAntigravityAccessToken(auth.refreshToken);
		if (refreshed?.accessToken) accessToken = refreshed.accessToken;
	}

	const fetchModels = async (token: string): Promise<Response> => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 5000);

		return fetch("https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
				"User-Agent": "antigravity/1.12.4",
				"X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
				Accept: "application/json",
			},
			body: JSON.stringify({ project: auth.projectId }),
			signal: controller.signal,
		});
	};

	try {
		let res = await fetchModels(accessToken);

		if ((res.status === 401 || res.status === 403) && auth.refreshToken) {
			const refreshed = await refreshAntigravityAccessToken(auth.refreshToken);
			if (refreshed?.accessToken) {
				accessToken = refreshed.accessToken;
				res = await fetchModels(accessToken);
			}
		}

		if (res.status === 401 || res.status === 403) {
			return { provider: "antigravity", displayName: "Antigravity", windows: [], error: "Unauthorized" };
		}

		if (!res.ok) {
			return { provider: "antigravity", displayName: "Antigravity", windows: [], error: `HTTP ${res.status}` };
		}

		const data = (await res.json()) as any;
		const models: Record<string, any> = data.models || {};

		const getQuotaInfo = (modelKeys: string[]): { usedPercent: number; resetDescription?: string } | null => {
			for (const key of modelKeys) {
				const qi = models?.[key]?.quotaInfo;
				if (!qi) continue;
				// In practice (CodexBar issue #129), some models only provide resetTime.
				// Treat missing remainingFraction as 0% remaining (100% used), which matches Antigravity's behavior when quota is exhausted.
				const remainingFraction = typeof qi.remainingFraction === "number" ? qi.remainingFraction : 0;
				const usedPercent = Math.min(100, Math.max(0, (1 - remainingFraction) * 100));
				const resetTime = qi.resetTime ? new Date(qi.resetTime) : undefined;
				return { usedPercent, resetDescription: resetTime ? formatReset(resetTime) : undefined };
			}
			return null;
		};

		// Quota groups from the reference snippet in CodexBar issue #129.
		const windows: RateWindow[] = [];

		const claudeOrGptOss = getQuotaInfo([
			"claude-sonnet-4-5",
			"claude-sonnet-4-5-thinking",
			"claude-opus-4-5-thinking",
			"gpt-oss-120b-medium",
		]);
		if (claudeOrGptOss) {
			windows.push({ label: "Claude", usedPercent: claudeOrGptOss.usedPercent, resetDescription: claudeOrGptOss.resetDescription });
		}

		const gemini3Pro = getQuotaInfo(["gemini-3-pro-high", "gemini-3-pro-low", "gemini-3-pro-preview"]);
		if (gemini3Pro) {
			windows.push({ label: "G3 Pro", usedPercent: gemini3Pro.usedPercent, resetDescription: gemini3Pro.resetDescription });
		}

		const gemini3Flash = getQuotaInfo(["gemini-3-flash"]);
		if (gemini3Flash) {
			windows.push({ label: "G3 Flash", usedPercent: gemini3Flash.usedPercent, resetDescription: gemini3Flash.resetDescription });
		}

		if (windows.length === 0) {
			return { provider: "antigravity", displayName: "Antigravity", windows: [], error: "No quota data" };
		}

		return { provider: "antigravity", displayName: "Antigravity", windows };
	} catch (e) {
		return { provider: "antigravity", displayName: "Antigravity", windows: [], error: String(e) };
	}
}

// ============================================================================
// Codex (OpenAI) Usage
// ============================================================================

interface CodexCredential {
	accessToken: string;
	accountId?: string;
	source: string; // Label identifying credential origin (e.g., "pi", "pi:second", ".codex:work")
}

/**
 * Read all Codex tokens from ~/.pi/agent/auth.json
 * Finds all keys starting with "openai-codex" (e.g., openai-codex, openai-codex-second, etc.)
 */
function readAllPiCodexAuths(): Array<{ accessToken: string; accountId?: string; source: string }> {
	const piAuthPath = path.join(os.homedir(), ".pi", "agent", "auth.json");
	const results: Array<{ accessToken: string; accountId?: string; source: string }> = [];

	try {
		if (!fs.existsSync(piAuthPath)) return results;
		const data = JSON.parse(fs.readFileSync(piAuthPath, "utf-8"));

		// Find all keys that start with "openai-codex"
		const codexKeys = Object.keys(data).filter(k => k.startsWith("openai-codex")).sort();

		for (const key of codexKeys) {
			const source = data[key];
			if (!source) continue;

			let accessToken: string | undefined;
			let accountId: string | undefined;

			// Pi auth pattern: .access
			if (typeof source.access === "string") {
				accessToken = source.access;
				accountId = source.accountId;
			}
			// Fallback: codex schema
			else if (source.tokens?.access_token) {
				accessToken = source.tokens.access_token;
				accountId = source.tokens.account_id;
			}

			if (accessToken) {
				// Label with pi: prefix to distinguish from .codex/ files
				const label = key === "openai-codex" ? "pi" : `pi:${key.replace("openai-codex-", "")}`;
				results.push({ accessToken, accountId, source: label });
			}
		}
	} catch {}

	return results;
}

/**
 * Read Codex token from a ~/.codex/*auth*.json file
 * Codex files use the pattern: data.tokens.access_token
 */
function readCodexAuthFile(filePath: string): { accessToken?: string; accountId?: string } {
	try {
		if (!fs.existsSync(filePath)) return {};
		const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));

		// Codex file pattern: .tokens.access_token
		if (data.tokens?.access_token) {
			return { accessToken: data.tokens.access_token, accountId: data.tokens.account_id };
		}
		// Fallback: OPENAI_API_KEY
		if (typeof data.OPENAI_API_KEY === "string" && data.OPENAI_API_KEY) {
			return { accessToken: data.OPENAI_API_KEY };
		}
		return {};
	} catch {
		return {};
	}
}

/**
 * Discover all unique Codex credentials from multiple sources:
 * 1. ~/.pi/agent/auth.json (authoritative, all openai-codex* keys)
 * 2. modelRegistry.authStorage (runtime auth, may be fresher)
 * 3. ~/.codex/*auth*.json files
 * Deduplicates by access_token first, then by usage stats when fetched
 */
async function discoverCodexCredentials(modelRegistry: any): Promise<CodexCredential[]> {
	const credentials: CodexCredential[] = [];
	const seenTokens = new Set<string>();

	// 1. Primary: from ~/.pi/agent/auth.json (authoritative source)
	// Read ALL openai-codex* keys (e.g., openai-codex, openai-codex-second, etc.)
	const piAuths = readAllPiCodexAuths();
	for (const piAuth of piAuths) {
		if (!seenTokens.has(piAuth.accessToken)) {
			credentials.push({
				accessToken: piAuth.accessToken,
				accountId: piAuth.accountId,
				source: piAuth.source,
			});
			seenTokens.add(piAuth.accessToken);
		}
	}

	// 2. Fallback: modelRegistry.authStorage (may have fresher token or be only source)
	try {
		const registryToken = await modelRegistry?.authStorage?.getApiKey?.("openai-codex");
		if (registryToken && !seenTokens.has(registryToken)) {
			const cred = await modelRegistry?.authStorage?.get?.("openai-codex");
			const accountId = cred?.type === "oauth" ? cred.accountId : undefined;
			credentials.push({
				accessToken: registryToken,
				accountId,
				source: "registry",
			});
			seenTokens.add(registryToken);
		}
	} catch {}

	// 3. Additional: scan ~/.codex/ for *auth*.json files
	const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
	try {
		if (fs.existsSync(codexHome) && fs.statSync(codexHome).isDirectory()) {
			const files = fs.readdirSync(codexHome);
			// Only match files starting with "auth" (e.g., auth.json, auth-work.json) to avoid oauth.json etc.
			const authFiles = files.filter(f => /^auth([_-].+)?\.json$/i.test(f)).sort();

			for (const authFile of authFiles) {
				const authPath = path.join(codexHome, authFile);
				const auth = readCodexAuthFile(authPath);

				// Skip if no token or we've already seen this exact access_token
				if (!auth.accessToken || seenTokens.has(auth.accessToken)) {
					continue;
				}

				seenTokens.add(auth.accessToken);
				// Label with .codex: prefix (e.g., "auth-xyz.json" -> ".codex:xyz")
				const nameMatch = authFile.match(/auth[_-]?(.+)?\.json/i);
				const suffix = nameMatch?.[1] || "auth";
				const label = `.codex:${suffix}`;
				credentials.push({ accessToken: auth.accessToken, accountId: auth.accountId, source: label });
			}
		}
	} catch {}

	return credentials;
}

async function fetchCodexUsageForCredential(cred: CodexCredential): Promise<UsageSnapshot> {
	const displayName = `Codex (${cred.source})`;

	try {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 5000);

		const headers: Record<string, string> = {
			Authorization: `Bearer ${cred.accessToken}`,
			"User-Agent": "CodexBar",
			Accept: "application/json",
		};

		if (cred.accountId) {
			headers["ChatGPT-Account-Id"] = cred.accountId;
		}

		const res = await fetch("https://chatgpt.com/backend-api/wham/usage", {
			method: "GET",
			headers,
			signal: controller.signal,
		});

		if (res.status === 401 || res.status === 403) {
			return { provider: "codex", displayName, windows: [], error: "Token expired" };
		}

		if (!res.ok) {
			return { provider: "codex", displayName, windows: [], error: `HTTP ${res.status}` };
		}

		const data = await res.json() as any;
		const windows: RateWindow[] = [];

		// Primary window (usually 3-hour)
		if (data.rate_limit?.primary_window) {
			const pw = data.rate_limit.primary_window;
			const resetDate = pw.reset_at ? new Date(pw.reset_at * 1000) : undefined;
			const windowHours = Math.round((pw.limit_window_seconds || 10800) / 3600);
			const usedPercent = typeof pw.used_percent === "number" ? pw.used_percent : Number(pw.used_percent) || 0;
			windows.push({
				label: `${windowHours}h`,
				usedPercent,
				resetDescription: resetDate ? formatReset(resetDate) : undefined,
				resetsAt: resetDate,
			});
		}

		// Secondary window (usually weekly)
		if (data.rate_limit?.secondary_window) {
			const sw = data.rate_limit.secondary_window;
			const resetDate = sw.reset_at ? new Date(sw.reset_at * 1000) : undefined;
			const windowHours = Math.round((sw.limit_window_seconds || 86400) / 3600);
			const label = windowHours >= 24 ? "Week" : `${windowHours}h`;
			const usedPercent = typeof sw.used_percent === "number" ? sw.used_percent : Number(sw.used_percent) || 0;
			windows.push({
				label,
				usedPercent,
				resetDescription: resetDate ? formatReset(resetDate) : undefined,
				resetsAt: resetDate,
			});
		}

		// Credits info
		let plan = data.plan_type;
		if (data.credits?.balance !== undefined && data.credits.balance !== null) {
			const balance = typeof data.credits.balance === 'number'
				? data.credits.balance
				: parseFloat(data.credits.balance) || 0;
			plan = plan ? `${plan} ($${balance.toFixed(2)})` : `$${balance.toFixed(2)}`;
		}

		return { provider: "codex", displayName, windows, plan };
	} catch (e) {
		return { provider: "codex", displayName, windows: [], error: String(e) };
	}
}

/**
 * Generate a fingerprint from usage stats for deduplication.
 * Two credentials accessing the same workspace will have identical stats.
 * Uses absolute timestamps (not relative formatReset strings) for stability.
 */
function usageFingerprint(snapshot: UsageSnapshot): string | null {
	if (snapshot.error || snapshot.windows.length === 0) {
		return null; // Can't fingerprint errors or empty results
	}
	// Create a strict fingerprint from all window data using stable values
	const parts = snapshot.windows.map(w => {
		const pct = Number.isFinite(w.usedPercent) ? w.usedPercent.toFixed(2) : "NaN";
		const resetTs = w.resetsAt ? w.resetsAt.getTime() : "";
		return `${w.label}:${pct}:${resetTs}`;
	});
	return parts.sort().join("|");
}

async function fetchAllCodexUsages(modelRegistry: any): Promise<UsageSnapshot[]> {
	const credentials = await discoverCodexCredentials(modelRegistry);

	if (credentials.length === 0) {
		return [{ provider: "codex", displayName: "Codex", windows: [], error: "No credentials" }];
	}

	// Fetch usage for all credentials in parallel
	const results = await Promise.all(
		credentials.map(cred => fetchCodexUsageForCredential(cred))
	);

	// Deduplicate by usage stats - if two credentials return identical stats,
	// they access the same workspace and we only show the first one
	const seenFingerprints = new Set<string>();
	const deduplicated: UsageSnapshot[] = [];

	for (const result of results) {
		const fingerprint = usageFingerprint(result);
		if (fingerprint === null) {
			// Keep errors/empty results (they might be transient)
			deduplicated.push(result);
		} else if (!seenFingerprints.has(fingerprint)) {
			seenFingerprints.add(fingerprint);
			deduplicated.push(result);
		}
		// Skip if fingerprint already seen (duplicate workspace)
	}

	return deduplicated;
}

// ============================================================================
// Kiro (AWS)
// ============================================================================

function stripAnsi(text: string): string {
	return text.replace(/\x1B\[[0-9;?]*[A-Za-z]|\x1B\].*?\x07/g, "");
}

function whichSync(cmd: string): string | null {
	try {
		return execSync(`which ${cmd}`, { encoding: "utf-8" }).trim();
	} catch {
		return null;
	}
}

async function fetchKiroUsage(): Promise<UsageSnapshot> {
	const kiroBinary = whichSync("kiro-cli");
	if (!kiroBinary) {
		return { provider: "kiro", displayName: "Kiro", windows: [], error: "kiro-cli not found" };
	}

	try {
		// Check if logged in
		try {
			execSync("kiro-cli whoami", { encoding: "utf-8", timeout: 5000 });
		} catch {
			return { provider: "kiro", displayName: "Kiro", windows: [], error: "Not logged in" };
		}

		// Get usage
		const output = execSync("kiro-cli chat --no-interactive /usage", {
			encoding: "utf-8",
			timeout: 10000,
			env: { ...process.env, TERM: "xterm-256color" }
		});

		const stripped = stripAnsi(output);
		const windows: RateWindow[] = [];

		// Parse plan name from "| KIRO FREE" or similar
		let planName = "Kiro";
		const planMatch = stripped.match(/\|\s*(KIRO\s+\w+)/i);
		if (planMatch) {
			planName = planMatch[1].trim();
		}

		// Parse credits percentage from "████...█ X%"
		let creditsPercent = 0;
		const percentMatch = stripped.match(/█+\s*(\d+)%/);
		if (percentMatch) {
			creditsPercent = parseInt(percentMatch[1], 10);
		}

		// Parse credits used/total from "(X.XX of Y covered in plan)"
		let creditsUsed = 0;
		let creditsTotal = 50;
		const creditsMatch = stripped.match(/\((\d+\.?\d*)\s+of\s+(\d+)\s+covered/);
		if (creditsMatch) {
			creditsUsed = parseFloat(creditsMatch[1]);
			creditsTotal = parseFloat(creditsMatch[2]);
			if (!percentMatch && creditsTotal > 0) {
				creditsPercent = (creditsUsed / creditsTotal) * 100;
			}
		}

		// Parse reset date from "resets on 01/01"
		let resetsAt: Date | undefined;
		const resetMatch = stripped.match(/resets on (\d{2}\/\d{2})/);
		if (resetMatch) {
			const [month, day] = resetMatch[1].split("/").map(Number);
			const now = new Date();
			const year = now.getFullYear();
			resetsAt = new Date(year, month - 1, day);
			if (resetsAt < now) resetsAt.setFullYear(year + 1);
		}

		windows.push({
			label: "Credits",
			usedPercent: creditsPercent,
			resetDescription: resetsAt ? formatReset(resetsAt) : undefined,
		});

		// Parse bonus credits
		const bonusMatch = stripped.match(/Bonus credits:\s*(\d+\.?\d*)\/(\d+)/);
		if (bonusMatch) {
			const bonusUsed = parseFloat(bonusMatch[1]);
			const bonusTotal = parseFloat(bonusMatch[2]);
			const bonusPercent = bonusTotal > 0 ? (bonusUsed / bonusTotal) * 100 : 0;
			const expiryMatch = stripped.match(/expires in (\d+) days?/);
			windows.push({
				label: "Bonus",
				usedPercent: bonusPercent,
				resetDescription: expiryMatch ? `${expiryMatch[1]}d left` : undefined,
			});
		}

		return { provider: "kiro", displayName: "Kiro", windows, plan: planName };
	} catch (e) {
		return { provider: "kiro", displayName: "Kiro", windows: [], error: String(e) };
	}
}

// ============================================================================
// z.ai
// ============================================================================

async function fetchZaiUsage(): Promise<UsageSnapshot> {
	// Check for API key in environment or pi auth
	let apiKey = process.env.Z_AI_API_KEY;

	if (!apiKey) {
		// Try pi auth storage
		try {
			const authPath = path.join(os.homedir(), ".pi", "agent", "auth.json");
			if (fs.existsSync(authPath)) {
				const auth = JSON.parse(fs.readFileSync(authPath, "utf-8"));
				apiKey = auth["z-ai"]?.access || auth["zai"]?.access;
			}
		} catch {}
	}

	if (!apiKey) {
		return { provider: "zai", displayName: "z.ai", windows: [], error: "No API key" };
	}

	try {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 5000);

		const res = await fetch("https://api.z.ai/api/monitor/usage/quota/limit", {
			method: "GET",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				Accept: "application/json",
			},
			signal: controller.signal,
		});

		if (!res.ok) {
			return { provider: "zai", displayName: "z.ai", windows: [], error: `HTTP ${res.status}` };
		}

		const data = await res.json() as any;
		if (!data.success || data.code !== 200) {
			return { provider: "zai", displayName: "z.ai", windows: [], error: data.msg || "API error" };
		}

		const windows: RateWindow[] = [];
		const limits = data.data?.limits || [];

		for (const limit of limits) {
			const type = limit.type;
			const usage = limit.usage || 0;
			const remaining = limit.remaining || 0;
			const percent = limit.percentage || 0;
			const nextReset = limit.nextResetTime ? new Date(limit.nextResetTime) : undefined;

			// Unit: 1=days, 3=hours, 5=minutes
			let windowLabel = "Limit";
			if (limit.unit === 1) windowLabel = `${limit.number}d`;
			else if (limit.unit === 3) windowLabel = `${limit.number}h`;
			else if (limit.unit === 5) windowLabel = `${limit.number}m`;

			if (type === "TOKENS_LIMIT") {
				windows.push({
					label: `Tokens (${windowLabel})`,
					usedPercent: percent,
					resetDescription: nextReset ? formatReset(nextReset) : undefined,
				});
			} else if (type === "TIME_LIMIT") {
				windows.push({
					label: "Monthly",
					usedPercent: percent,
					resetDescription: nextReset ? formatReset(nextReset) : undefined,
				});
			}
		}

		const planName = data.data?.planName || data.data?.plan || undefined;
		return { provider: "zai", displayName: "z.ai", windows, plan: planName };
	} catch (e) {
		return { provider: "zai", displayName: "z.ai", windows: [], error: String(e) };
	}
}

// ============================================================================
// Helpers
// ============================================================================

function formatReset(date: Date): string {
	const diffMs = date.getTime() - Date.now();
	if (diffMs < 0) return "now";

	const diffMins = Math.floor(diffMs / 60000);
	if (diffMins < 60) return `${diffMins}m`;

	const hours = Math.floor(diffMins / 60);
	const mins = diffMins % 60;
	if (hours < 24) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;

	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}d ${hours % 24}h`;

	return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(date);
}

function getStatusEmoji(status?: ProviderStatus): string {
	if (!status) return "";
	switch (status.indicator) {
		case "none": return "✅";
		case "minor": return "⚠️";
		case "major": return "🟠";
		case "critical": return "🔴";
		case "maintenance": return "🔧";
		default: return "";
	}
}

// ============================================================================
// UI Component
// ============================================================================

class UsageComponent {
	private usages: UsageSnapshot[] = [];
	private loading = true;
	private tui: { requestRender: () => void };
	private theme: any;
	private onClose: () => void;
	private modelRegistry: any;

	constructor(tui: { requestRender: () => void }, theme: any, onClose: () => void, modelRegistry: any) {
		this.tui = tui;
		this.theme = theme;
		this.onClose = onClose;
		this.modelRegistry = modelRegistry;
		this.load();
	}

	private async load() {
		const timeout = <T>(p: Promise<T>, ms: number, fallback: T) =>
			Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);

		// Fetch usage and status in parallel
		const [claude, copilot, gemini, codexResults, antigravity, kiro, zai, claudeStatus, copilotStatus, geminiStatus, codexStatus] = await Promise.all([
			timeout(fetchClaudeUsage(), 6000, { provider: "anthropic", displayName: "Claude", windows: [], error: "Timeout" }),
			timeout(fetchCopilotUsage(this.modelRegistry), 6000, { provider: "copilot", displayName: "Copilot", windows: [], error: "Timeout" }),
			timeout(fetchGeminiUsage(this.modelRegistry), 6000, { provider: "gemini", displayName: "Gemini", windows: [], error: "Timeout" }),
			timeout(fetchAllCodexUsages(this.modelRegistry), 6000, [{ provider: "codex", displayName: "Codex", windows: [], error: "Timeout" }]),
			timeout(fetchAntigravityUsage(this.modelRegistry), 6000, { provider: "antigravity", displayName: "Antigravity", windows: [], error: "Timeout" }),
			timeout(fetchKiroUsage(), 6000, { provider: "kiro", displayName: "Kiro", windows: [], error: "Timeout" }),
			timeout(fetchZaiUsage(), 6000, { provider: "zai", displayName: "z.ai", windows: [], error: "Timeout" }),
			timeout(fetchProviderStatus("anthropic"), 3000, { indicator: "unknown" as const }),
			timeout(fetchProviderStatus("copilot"), 3000, { indicator: "unknown" as const }),
			timeout(fetchGeminiStatus(), 3000, { indicator: "unknown" as const }),
			timeout(fetchProviderStatus("codex"), 3000, { indicator: "unknown" as const }),
		]);

		// Attach status to usage
		claude.status = claudeStatus;
		copilot.status = copilotStatus;
		gemini.status = geminiStatus;
		// Attach codex status to all codex accounts
		for (const codex of codexResults) {
			codex.status = codexStatus;
		}

		// Filter out providers with no data and no error (not configured)
		const allUsages = [claude, copilot, gemini, ...codexResults, antigravity, kiro, zai];
		this.usages = allUsages.filter(u => u.windows.length > 0 || u.error !== "No credentials" && u.error !== "kiro-cli not found" && u.error !== "No API key");
		this.loading = false;
		this.tui.requestRender();
	}

	handleInput(_data: string): void {
		this.onClose();
	}

	invalidate(): void {}

	render(width: number): string[] {
		const t = this.theme;
		const dim = (s: string) => t.fg("muted", s);
		const bold = (s: string) => t.bold(s);
		const accent = (s: string) => t.fg("accent", s);

		// Box dimensions: total width includes borders
		const totalW = Math.min(55, width - 4);
		const innerW = totalW - 4; // subtract "│ " and " │"
		const hLine = "─".repeat(totalW - 2); // subtract corners

		const box = (content: string) => {
			const contentW = visibleWidth(content);
			const pad = Math.max(0, innerW - contentW);
			return dim("│ ") + content + " ".repeat(pad) + dim(" │");
		};

		const lines: string[] = [];
		lines.push(dim(`╭${hLine}╮`));
		lines.push(box(bold(accent("Quota Usage"))));
		lines.push(dim(`├${hLine}┤`));

		if (this.loading) {
			lines.push(box("Loading..."));
		} else {
			for (const u of this.usages) {
				// Provider header with status emoji and plan
				const statusEmoji = getStatusEmoji(u.status);
				const planStr = u.plan ? dim(` (${u.plan})`) : "";
				const statusStr = (statusEmoji && !u.error) ? ` ${statusEmoji}` : "";
				lines.push(box(bold(u.displayName) + planStr + statusStr));

				// Show incident description if any
				if (u.status?.indicator && u.status.indicator !== "none" && u.status.indicator !== "unknown" && u.status.description) {
					const desc = u.status.description.length > 40
						? u.status.description.substring(0, 37) + "..."
						: u.status.description;
					lines.push(box(t.fg("warning", `  ⚡ ${desc}`)));
				}

				if (u.error) {
					lines.push(box(dim(`  ${u.error}`)));
				} else if (u.windows.length === 0) {
					lines.push(box(dim("  No data")));
				} else {
					for (const w of u.windows) {
						const used = Math.min(100, Math.max(0, w.usedPercent));
						const barW = 12;
						const filled = Math.round((used / 100) * barW);
						const empty = barW - filled;
						const color = used >= 95 ? "error" : used >= 85 ? "warning" : used >= 70 ? "accent" : used >= 50 ? "muted" : "success";
						const bar = t.fg(color, "█".repeat(filled)) + dim("░".repeat(empty));
						const reset = w.resetDescription ? dim(`  ⏱ ${w.resetDescription}`) : "";
						lines.push(box(`  ${w.label.padEnd(8)} ${bar} ${used.toFixed(0).padStart(3)}%${reset}`));
					}
				}
				lines.push(box(""));
			}
		}

		lines.push(dim(`├${hLine}┤`));
		lines.push(box(dim("Press any key to close")));
		lines.push(dim(`╰${hLine}╯`));

		return lines;
	}

	dispose(): void {}
}

// ============================================================================
// Hook
// ============================================================================

export default function (pi: ExtensionAPI) {
	pi.registerCommand("usage", {
		description: "Show AI provider usage statistics",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("Usage requires interactive mode", "error");
				return;
			}

			const modelRegistry = ctx.modelRegistry;
			await ctx.ui.custom((tui, theme, _kb, done) => {
				return new UsageComponent(tui, theme, () => done(), modelRegistry);
			});
		},
	});

	pi.registerShortcut("alt+u", {
		description: "Show AI provider usage statistics",
		handler: async (ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("Usage requires interactive mode", "error");
				return;
			}

			const modelRegistry = ctx.modelRegistry;
			await ctx.ui.custom((tui, theme, _kb, done) => {
				return new UsageComponent(tui, theme, () => done(), modelRegistry);
			});
		},
	});
}
