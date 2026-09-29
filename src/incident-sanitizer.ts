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
// Secret-looking tokens. A long run needs 40 characters of base64 (with a
// digit and a letter) or 32 of hex, so tool-use ids, UUIDs, short commit
// hashes, labels and URL paths stay readable.
const SECRETS: RegExp[] = [
	/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
	/\bsk-[A-Za-z0-9_-]{8,}/g,
	/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/g,
	/\bgithub_pat_[A-Za-z0-9_]{20,}/g,
	/\bxox[a-z]-[A-Za-z0-9-]{8,}/gi,
	/\b[0-9a-fA-F]{32,}\b/g,
	/(?<![A-Za-z0-9+_-])(?=[A-Za-z+_-]*[0-9])(?=[0-9+_-]*[A-Za-z])[A-Za-z0-9+_-]{40,}={0,2}(?![A-Za-z0-9+_-])/g,
];

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
	out = out.replace(GITHUB_LINK, (link, linkOwner: string, name: string) => sameRepo(linkOwner, name, repo) ? link : "[link removed]");
	out = out.replace(CROSS_REFERENCE, (reference, refOwner: string) => refOwner.toLowerCase() === owner ? reference : "[reference removed]");
	out = out.replace(MENTION, "[handle removed]");
	return out;
}
