// The issue sanitizer: every string the incident filer publishes passes it.
// It enforces the repository's no-tagging rule at runtime: no handles, no
// references or links to other repositories, no co-author lines, and no
// secret-looking tokens.
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

	it("redacts secret-looking tokens and keeps ids", () => {
		const secrets = [
			"sk-ant-" + "a1B2".repeat(10),
			"ghp_" + "Z9y8".repeat(9),
			"gho_" + "Q1w2".repeat(9),
			"xoxb-" + "1234-5678-abcdEFGH",
			"Bearer " + "eyJhbGciOi.abc123DEF456.ghi789",
			"0123456789abcdef".repeat(3),
			"QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo" + "xMjM0NTY3ODkw",
		];
		const kept = ["bi-7f3a", "toolu_01AbCdEfGhIjKlMnOpQrStUv", "3f0e8a4c-9b1d-4e2f-8a7b-6c5d4e3f2a1b", "723861528f44", "tool_handler_unmatched@mcpToolHandler"];
		const out = sanitizeForIssue([...secrets, ...kept].join("\n"), REPO);
		for (const secret of secrets) assert.ok(!out.includes(secret), `redacted: ${secret.slice(0, 12)}`);
		for (const id of kept) assert.ok(out.includes(id), `kept: ${id}`);
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
