// What may go into an issue or comment the bridge files. The owner's rule for
// this repository (its commit-msg hook, which is not present at runtime):
// published text names no other GitHub user and links no other repository.
// Incidents are metadata only already; this is the last check at the
// boundary, applied to every title, body and comment the filer sends.

// A handle: an at sign and a name, not preceded by a word, `.`, `+` or `-` (an email address)
// and not followed by `/` (an npm scope such as `@scope/pkg`) or by a domain.
const MENTION = /(?<![\w.+-])@[A-Za-z0-9][A-Za-z0-9-]*(?![\w/@-]|\.\w)/g;
const CROSS_REFERENCE = /\b([\w.-]+)\/([\w.-]+)#\d+/g;
const GITHUB_LINK = /(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull|commit|discussions)\/[^\s)\]>"'`]*/g;
const CO_AUTHOR_LINE = /^co-authored-by:.*(?:\r?\n|$)/gim;
// Secret-looking tokens with a known shape, and hex runs of 32 or more.
const SECRETS: RegExp[] = [
	/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
	/\bsk-[A-Za-z0-9_-]{8,}/g,
	/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/g,
	/\bgithub_pat_[A-Za-z0-9_]{20,}/g,
	/\bxox[a-z]-[A-Za-z0-9-]{8,}/gi,
	/\b[0-9a-fA-F]{32,}\b/g,
];

// Any other run of 40 or more base64 or base64url characters (A-Z a-z 0-9
// + / - _, optional = padding), digits or not. 40 is where key material
// starts: 30 random bytes encode to 40 characters, a 32-byte key to 43 or 44,
// an AWS secret key is 40. Every evidence id the bridge files is shorter:
// tool_use ids (about 30), session UUIDs (36), incident ids, the 12-character
// commit, and each half of a `label@site` signature (the longest label is 37).
const BASE64_RUN = /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{40,}={0,2}(?![A-Za-z0-9+/_=-])/g;

/** Whether a long run reads as words (an MCP tool name such as
 *  mcp__server__list_pull_request_review_comments, or a path) rather than
 *  encoded bytes. Words are split at _ - / and case and digit changes:
 *  identifiers average 4 or more letters a word and never run past 16, while
 *  random base64 averages about 2 (1 in 100,000 random 30-byte tokens passes,
 *  none from 48 bytes up). + and = never occur in identifiers. */
function readsAsWords(run: string): boolean {
	if (/[+=]/.test(run)) return false;
	const words = run.split(/[_/-]+/).flatMap((part) => part.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g) ?? []);
	if (words.length === 0 || words.some((word) => word.length > 16)) return false;
	const digits = run.replace(/[^0-9]/g, "").length;
	return words.join("").length / words.length >= 4 && digits <= run.length / 4;
}

function sameRepo(owner: string, name: string, repo: string): boolean {
	return `${owner}/${name}`.toLowerCase() === repo.toLowerCase();
}

/** `text` with handles, references and links to other repositories,
 *  co-author lines and secret-looking tokens removed. `repo` is the
 *  configured `incidents.repo`: references to its owner and links to it stay. */
export function sanitizeForIssue(text: string, repo: string): string {
	const owner = repo.split("/")[0]?.toLowerCase();
	let out = text.replace(CO_AUTHOR_LINE, "");
	for (const pattern of SECRETS) out = out.replace(pattern, "[redacted]");
	out = out.replace(BASE64_RUN, (run) => readsAsWords(run) ? run : "[redacted]");
	out = out.replace(GITHUB_LINK, (link, linkOwner: string, name: string) => sameRepo(linkOwner, name, repo) ? link : "[link removed]");
	out = out.replace(CROSS_REFERENCE, (reference, refOwner: string) => refOwner.toLowerCase() === owner ? reference : "[reference removed]");
	out = out.replace(MENTION, "[handle removed]");
	return out;
}
