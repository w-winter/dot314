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

	// Synthetic tokens, built at run time: base64 of fixed text, never a credential.
	const standardBase64 = "T0k/".repeat(16);
	const alphabeticBase64 = Buffer.from("ABC".repeat(16)).toString("base64");
	const urlBytes = [0xfb, 0xef, 0xbe, 0xfb, 0xff, 0x7f, 0x69, 0xb7, 0x1d].flatMap((byte) => [byte, 0x3e, 0xd1]);
	const base64url = Buffer.from([...urlBytes, ...urlBytes]).toString("base64url");
	const padded = Buffer.from("x".repeat(40)).toString("base64");

	it("redacts long standard base64 and base64url tokens, with or without digits", () => {
		assert.equal(Buffer.from(standardBase64, "base64").toString("base64"), standardBase64, "valid standard base64");
		assert.ok(!/[0-9]/.test(alphabeticBase64) && alphabeticBase64.length >= 40, "a long token without a digit");
		assert.ok(/[_-]/.test(base64url) && base64url.length >= 40, `base64url: ${base64url}`);
		assert.match(padded, /=$/, "padded");
		const withSeparators = `${"AbCdEfGhIj".repeat(2)}_${"KlMnOpQrSt".repeat(2)}-uV`;
		for (const token of [standardBase64, alphabeticBase64, base64url, padded, withSeparators, "+/".repeat(20), `${standardBase64.slice(0, 40)}==`]) {
			for (const text of [token, `id ${token} end`, JSON.stringify({ toolName: token }), `| Value | ${token} |`]) {
				const out = sanitizeForIssue(text, REPO);
				assert.ok(!out.includes(token), `redacted: ${token.slice(0, 16)} in ${text.slice(0, 24)}`);
				assert.ok(out.includes("[redacted]"));
			}
		}
	});

	it("keeps the evidence identifiers an issue carries", () => {
		const kept = {
			"a Claude tool_use id": "toolu_01D7FLrfh4GYq7yT1ULFeyMV",
			"a server tool_use id": "srvtoolu_01ABCDEFghijklmnopqrstuv",
			"an incident id": "bi-7f3a",
			"a longer incident id": "bi-x9k2qz",
			"a session UUID": "8b2c4d6e-1f3a-4b5c-9d7e-0a1b2c3d4e5f",
			"the 12-character bridge commit": "723861528f44",
			"a signature": "tool_handler_unmatched@mcpToolHandler",
			"the longest signature": "repair_tool_pairing_synthetic_results@convertAndImportMessages",
			"a short tool name": "echo",
			"a Pi tool name": "claude_bridge_incident_note",
			"an MCP tool name over 40 characters": "mcp__claude_ai_Google_Drive__search_files",
			"a 64-character MCP tool name": "mcp__github_enterprise_server__list_pull_request_review_comments",
			"a camel-case MCP tool name": "mcp__workspace__getRepositoryContentsForHTTPRequest",
			"a Claude model id": "claude-sonnet-4-5-20250929",
			"a test file": "tests/unit-served-tools-stream.mjs",
			"the configured repo's issue link": `https://github.com/${REPO}/issues/1234`,
		};
		for (const [what, id] of Object.entries(kept)) {
			for (const text of [id, `| Value | ${id} |`, JSON.stringify({ id, toolName: id }), `\`${id}\``]) {
				assert.equal(sanitizeForIssue(text, REPO), text, `${what} stays: ${id}`);
			}
		}
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
