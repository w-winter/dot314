// What may go into an issue or comment the bridge files. The owner's rule for
// this repository (its commit-msg hook, which is not present at runtime):
// published text names no other GitHub user and links no other repository.
// That rule applies to every title, body and comment. Nothing is scanned for
// secrets: every string they are built from was validated by kind when it
// was recorded, and no text the agent writes is published.

// A handle: an at sign and a name, not preceded by a word, `.`, `+` or `-` (an email address)
// and not followed by `/` (an npm scope such as `@scope/pkg`) or by a domain.
const MENTION = /(?<![\w.+-])@[A-Za-z0-9][A-Za-z0-9-]*(?![\w/@-]|\.\w)/g;
const CROSS_REFERENCE = /\b([\w.-]+)\/([\w.-]+)#\d+/g;
const GITHUB_LINK = /(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull|commit|discussions)\/[^\s)\]>"'`]*/g;
const CO_AUTHOR_LINE = /^co-authored-by:.*(?:\r?\n|$)/gim;

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
