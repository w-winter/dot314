import { USAGE_LIMIT_ERROR_PREFIXES } from "@anthropic-ai/claude-agent-sdk";

export const RATE_LIMIT_AUTO_RESUME_EVENT = "pi-claude:rate-limit";
export const RATE_LIMIT_TOKEN = "\x1b[31m[rate-limit]\x1b[39m";

// The SDK export is @alpha — degrade to "no match" (pre-0.3.220 behavior) if a
// future release drops it, instead of crashing message classification.
const USAGE_LIMIT_PREFIXES: readonly string[] = Array.isArray(USAGE_LIMIT_ERROR_PREFIXES as unknown)
	? USAGE_LIMIT_ERROR_PREFIXES
	: [];

function coerceMessageText(value: unknown): string {
	if (typeof value === "string") return value;
	if (value instanceof Error) return value.message;
	try { return JSON.stringify(value ?? ""); }
	catch { return String(value); }
}

/** Broad test: any "a usage limit was genuinely reached" message, matched
 *  against the CLI's own copy (SDK `USAGE_LIMIT_ERROR_PREFIXES`, e.g. "You've
 *  hit your weekly limit…"). Substring rather than prefix match because the
 *  text usually arrives embedded in a result payload's errors array. */
export function isUsageLimitMessage(value: unknown): boolean {
	const text = coerceMessageText(value);
	return USAGE_LIMIT_PREFIXES.some((prefix) => text.includes(prefix));
}

export function uniqueNonEmptyLines(values: unknown[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const value of values) {
		const text = typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
		if (!text || seen.has(text)) continue;
		seen.add(text);
		out.push(text);
	}
	return out;
}

/** Epoch milliseconds from an SDK reset timestamp, or undefined.
 *  `SDKRateLimitInfo.resetsAt` is a bare number in epoch SECONDS (measured:
 *  treating it as ms rendered "resets Jan 21, 1970" for a Jul 2026 reset).
 *  The unit is undocumented, so detect by magnitude — epoch seconds stay below
 *  1e12 until the year 33658, epoch ms passed 1e12 in 2001. A numeric STRING
 *  gets the same magnitude treatment (rate_limit_event payloads have carried
 *  both), and anything else falls back to Date.parse for ISO strings. */
export function resetTimestampMs(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		return Math.abs(value) < 1e12 ? value * 1000 : value;
	}
	if (typeof value !== "string" || !value.trim()) return undefined;
	const numeric = Number(value);
	if (Number.isFinite(numeric)) return Math.abs(numeric) < 1e12 ? numeric * 1000 : numeric;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

export function formatResetTimestamp(value: unknown): string {
	const parsed = resetTimestampMs(value);
	if (parsed === undefined) return "unknown";
	return new Date(parsed).toLocaleString(undefined, {
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		month: "short",
		second: "2-digit",
		timeZoneName: "short",
		year: "numeric",
	});
}

export const ALLOWED_RATE_LIMIT_WARNING_UTILIZATION_THRESHOLD = 80;

export function normalizeRateLimitUtilization(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
	if (value === 0) return 0;
	// Claude SDK payloads have appeared as both fractions and percentages.
	// Exact 1 is unit-ambiguous (1% vs 100%); read it as the fractional form
	// (100%) because that is the fail-closed direction — under the fraction
	// convention 1 is the fully-consumed case the warning exists to surface,
	// while under the percent convention 1% sits below the threshold anyway,
	// so nothing is lost by warning.
	if (value > 0 && value <= 1) return value * 100;
	if (value > 1 && value <= 100) return value;
	return undefined;
}

function rateLimitTypeLabel(value: unknown): string {
	const text = typeof value === "string" ? value.trim() : "";
	return text || "unknown";
}

export function formatAllowedRateLimitWarning(info: { status?: unknown; utilization?: unknown; rateLimitType?: unknown } | null | undefined): string | undefined {
	if (info?.status !== "allowed_warning") return undefined;
	const utilization = normalizeRateLimitUtilization(info.utilization);
	if (utilization === undefined || utilization < ALLOWED_RATE_LIMIT_WARNING_UTILIZATION_THRESHOLD) return undefined;
	return `Claude rate limit warning: nearing ${rateLimitTypeLabel(info.rateLimitType)} limit; check Claude Code /usage for exact utilization.`;
}
