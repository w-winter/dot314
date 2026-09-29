// The issue sanitizer. Every title, body and comment the incident filer
// publishes passes sanitizeForIssue, the repository's no-tagging rule at
// runtime: no handles, no references or links to other repositories, no
// co-author lines. Free text (an agent's summary) also passes the secret
// scan, sanitizeFreeText. Structured evidence is not scanned: it is validated
// by kind where it is recorded (unit-incident-evidence.mjs).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import { sanitizeForIssue, sanitizeFreeText } from "../src/incident-sanitizer.ts";

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

	it("redacts secret-looking tokens in free text and keeps short ids", () => {
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
		const out = sanitizeFreeText([...secrets, ...kept].join("\n"), REPO);
		for (const secret of secrets) assert.ok(!out.includes(secret), `redacted: ${secret.slice(0, 12)}`);
		for (const id of kept) assert.ok(out.includes(id), `kept: ${id}`);
	});

	// Synthetic tokens, built at run time: base64 of fixed text, never a credential.
	const standardBase64 = "T0k/".repeat(16);
	const alphabeticBase64 = Buffer.from("ABC".repeat(16)).toString("base64");
	const urlBytes = [0xfb, 0xef, 0xbe, 0xfb, 0xff, 0x7f, 0x69, 0xb7, 0x1d].flatMap((byte) => [byte, 0x3e, 0xd1]);
	const base64url = Buffer.from([...urlBytes, ...urlBytes]).toString("base64url");
	const padded = Buffer.from("x".repeat(40)).toString("base64");

	it("redacts long standard base64 and base64url tokens in free text, with or without digits", () => {
		assert.equal(Buffer.from(standardBase64, "base64").toString("base64"), standardBase64, "valid standard base64");
		assert.ok(!/[0-9]/.test(alphabeticBase64) && alphabeticBase64.length >= 40, "a long token without a digit");
		assert.ok(/[_-]/.test(base64url) && base64url.length >= 40, `base64url: ${base64url}`);
		assert.match(padded, /=$/, "padded");
		const withSeparators = `${"AbCdEfGhIj".repeat(2)}_${"KlMnOpQrSt".repeat(2)}-uV`;
		for (const token of [standardBase64, alphabeticBase64, base64url, padded, withSeparators, "+/".repeat(20), `${standardBase64.slice(0, 40)}==`]) {
			for (const text of [token, `id ${token} end`, JSON.stringify({ toolName: token }), `| Value | ${token} |`]) {
				const out = sanitizeFreeText(text, REPO);
				assert.ok(!out.includes(token), `redacted: ${token.slice(0, 16)} in ${text.slice(0, 24)}`);
				assert.ok(out.includes("[redacted]"));
			}
		}
	});

	it("redacts every 40-character run in free text, even one that reads as words", () => {
		// Synthetic: 30 bytes of a hash of fixed text, valid base64 and base64url.
		const key = createHash("sha256").update("synthetic-review-token-34135").digest().subarray(0, 30).toString("base64");
		for (const run of [key, "mcp__git__get_pr_by_id_from_repo_with_org_name", "mcp__github_enterprise_server__list_pull_request_review_comments", "ThisReadsLikeWordsButItIsFortyCharacters"]) {
			assert.ok(run.length >= 40);
			const out = sanitizeFreeText(`I saw ${run} fail`, REPO);
			assert.equal(out, "I saw [redacted] fail", run);
		}
	});

	it("redacts a 40-character run in free text whatever follows it", () => {
		// Synthetic: a valid base64 encoding of 30 bytes.
		const run = "abcdefghijklmnopqrstuvwxyzabcdefghijklmn";
		assert.equal(Buffer.from(run, "base64").toString("base64"), run);
		for (const text of [`${run}=trace`, `${run}===`, `${run}==suffix`, `key=${run}=`, `${run}=${run}`]) {
			const out = sanitizeFreeText(text, REPO);
			assert.ok(!out.includes(run), `redacted in ${JSON.stringify(text)}: ${out}`);
			assert.ok(out.includes("[redacted]"));
		}
		assert.equal(sanitizeFreeText(`${run}== then`, REPO), "[redacted] then", "the padding goes with the run");
	});

	it("redacts a 32-character hex run in free text whatever surrounds it", () => {
		const hex = "0123456789abcdef".repeat(2);
		for (const text of [`${hex}xyz`, `x${hex}`, `v${hex}z`]) {
			const out = sanitizeFreeText(text, REPO);
			assert.ok(!out.includes(hex), `redacted in ${text}: ${out}`);
		}
	});

	it("keeps ids under 40 characters in free text", () => {
		const kept = [
			"toolu_01D7FLrfh4GYq7yT1ULFeyMV",
			"srvtoolu_01WYG3ziw53XMcoyKL4XcZmE",
			"bi-7f3a",
			"8b2c4d6e-1f3a-4b5c-9d7e-0a1b2c3d4e5f",
			"723861528f44",
			"repair_tool_pairing_synthetic_results@convertAndImportMessages",
			"claude-sonnet-4-5-20250929",
		];
		for (const id of kept) assert.equal(sanitizeFreeText(`saw ${id} here`, REPO), `saw ${id} here`, id);
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
