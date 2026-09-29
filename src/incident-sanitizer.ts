// What may go into an issue or comment the bridge files. The owner's rule for
// this repository (its commit-msg hook, which is not present at runtime):
// published text names no other GitHub user and links no other repository.
// That rule applies to every title, body and comment. Free text also passes
// the secret scan; the evidence an issue body is built from does not, since
// every string in it was validated by kind when it was recorded.

// A handle: an at sign and a name, not preceded by a word, `.`, `+` or `-` (an email address)
// and not followed by `/` (an npm scope such as `@scope/pkg`) or by a domain.
const MENTION = /(?<![\w.+-])@[A-Za-z0-9][A-Za-z0-9-]*(?![\w/@-]|\.\w)/g;
const CROSS_REFERENCE = /\b([\w.-]+)\/([\w.-]+)#\d+/g;
const GITHUB_LINK = /(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull|commit|discussions)\/[^\s)\]>"'`]*/g;
const CO_AUTHOR_LINE = /^co-authored-by:.*(?:\r?\n|$)/gim;
// The secret scan, for free text only (an agent's summary): tokens with a
// known prefix, hex runs of 32 or more, and every run of 40 or more base64 or
// base64url characters (A-Z a-z 0-9 + / - _, with its = padding), digits or
// not, words or not, whatever precedes or follows the run. 40 is where key material starts: 30 random bytes encode
// to 40 characters, a 32-byte key to 43 or 44, an AWS secret key is 40. No
// text rule tells a long identifier from a key, so free text keeps neither;
// structured evidence is never scanned, it is validated by kind where it is
// recorded (incidents.ts, projectDiagMetadata).
const SECRETS: RegExp[] = [
	/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
	/\bsk-[A-Za-z0-9_-]{8,}/g,
	/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/g,
	/\bgithub_pat_[A-Za-z0-9_]{20,}/g,
	/\bxox[a-z]-[A-Za-z0-9-]{8,}/gi,
	/[0-9a-fA-F]{32,}/g,
	/[A-Za-z0-9+/_-]{40,}={0,2}/g,
];

function sameRepo(owner: string, name: string, repo: string): boolean {
	return `${owner}/${name}`.toLowerCase() === repo.toLowerCase();
}

/** `text` with handles, references and links to other repositories and
 *  co-author lines removed: the repository's no-tagging rule, applied to
 *  every title, body and comment the filer publishes. `repo` is the
 *  configured `incidents.repo`: references to its owner and links to it stay. */
export function sanitizeForIssue(text: string, repo: string): string {
	const owner = repo.split("/")[0]?.toLowerCase();
	let out = text.replace(CO_AUTHOR_LINE, "");
	out = out.replace(GITHUB_LINK, (link, linkOwner: string, name: string) => sameRepo(linkOwner, name, repo) ? link : "[link removed]");
	out = out.replace(CROSS_REFERENCE, (reference, refOwner: string) => refOwner.toLowerCase() === owner ? reference : "[reference removed]");
	out = out.replace(MENTION, "[handle removed]");
	return out;
}

/** Free text (not validated evidence) as it may be published: secret-looking
 *  tokens redacted, then the no-tagging rule. */
export function sanitizeFreeText(text: string, repo: string): string {
	let out = text;
	for (const pattern of SECRETS) out = out.replace(pattern, "[redacted]");
	return sanitizeForIssue(out, repo);
}
