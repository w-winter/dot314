// The issue sanitizer. Every title, body and comment the incident filer
// publishes passes sanitizeForIssue, the repository's no-tagging rule at
// runtime: no handles, no references or links to other repositories, no
// co-author lines. Nothing is scanned for secrets: what the filer publishes
// is validated by kind where it is recorded (unit-incident-evidence.mjs).
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { sanitizeForIssue } from "../src/incident-sanitizer.ts";

const REPO = "nicobailon/bridge-incidents";
// Built at run time: these are exactly what the sanitizer must keep out.
const mention = (name) => `@${name}`;
const otherRef = ["someone-else", "their-repo"].join("/") + "#12";
const otherLink = ["https://github.com", "someone-else", "their-repo", "issues", "3"].join("/");
const coAuthor = ["Co", "authored", "by"].join("-") + ": Someone <someone@example.com>";

describe("issue sanitizer", () => {
	it("strips handles but keeps email addresses and npm scopes", () => {
		const out = sanitizeForIssue(`ping ${mention("someone")}, ${mention("other-user")}. mail someone@example.com; uses @earendil-works/pi-ai`, REPO);
		assert.ok(!out.includes(mention("someone")) && !out.includes(mention("other-user")));
		assert.ok(out.includes("someone@example.com"));
		assert.ok(out.includes("@earendil-works/pi-ai"));
	});

	it("strips references and links to other repositories, keeping the configured one", () => {
		const ownRef = `${REPO}#4`;
		const ownLink = `https://github.com/${REPO}/issues/4`;
		const sameOwnerLink = "https://github.com/nicobailon/other-repo/pull/9";
		const out = sanitizeForIssue(`${otherRef} ${otherLink} ${ownRef} ${ownLink} ${sameOwnerLink}`, REPO);
		assert.ok(!out.includes(otherRef));
		assert.ok(!out.includes(otherLink));
		assert.ok(!out.includes(sameOwnerLink), "a link to any repo but the configured one goes");
		assert.ok(out.includes(ownRef));
		assert.ok(out.includes(ownLink));
	});

	it("drops co-author lines", () => {
		const out = sanitizeForIssue(`first line\n${coAuthor}\nlast line`, REPO);
		assert.equal(out, "first line\nlast line");
	});

	it("applies only the no-tagging rule to what the filer composes from validated evidence", () => {
		const body = [
			"| Tool | mcp__github_enterprise_server__list_pull_request_review_comments |",
			"| Tool | mcp__git__get_pr_by_id_from_repo_with_org_name |",
			`| Link | https://github.com/${REPO}/issues/1234 |`,
			"| Signature | `repair_tool_pairing_synthetic_results@convertAndImportMessages` |",
			mention("someone"),
			otherLink,
		].join("\n");
		const out = sanitizeForIssue(body, REPO);
		assert.ok(out.includes("mcp__github_enterprise_server__list_pull_request_review_comments"), "a long registered tool name stays");
		assert.ok(out.includes("mcp__git__get_pr_by_id_from_repo_with_org_name"), "a long tool name of short words stays");
		assert.ok(out.includes(`https://github.com/${REPO}/issues/1234`));
		assert.ok(out.includes("repair_tool_pairing_synthetic_results@convertAndImportMessages"));
		assert.ok(!out.includes(mention("someone")));
		assert.ok(!out.includes(otherLink));
	});

	it("leaves nothing the repository's no-tagging rules block", () => {
		// The rules of the repository's commit-msg hook, for the configured owner.
		const rules = [
			[/(?<![\w.+-])@[A-Za-z0-9][A-Za-z0-9-]*(?![\w/@-]|\.\w)/g, () => true],
			[/\b([\w.-]+)\/[\w.-]+#\d+/g, (m) => m[1] !== "nicobailon"],
			[/github\.com\/([\w.-]+)\/[\w.-]+\/(?:issues|pull|commit|discussions)\//g, (m) => m[1] !== "nicobailon"],
			[/^co-authored-by:.*$/gim, () => true],
		];
		const out = sanitizeForIssue([mention("a"), `(${mention("b")})`, `${mention("c")}.`, otherRef, otherLink, coAuthor, "x" + otherRef].join("\n"), REPO);
		for (const [pattern, blocked] of rules) {
			for (const match of out.matchAll(pattern)) assert.ok(!blocked(match), `blocked text left: ${match[0]}`);
		}
	});
});
