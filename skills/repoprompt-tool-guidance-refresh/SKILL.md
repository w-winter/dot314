---
name: repoprompt-tool-guidance-refresh
description: Update RepoPrompt tool guidance based empirically on the latest MCP server and CLI. MCP docs live in `agent/skills/repoprompt-tool-guidance-refresh/rp-prompts/mcp/`; CLI docs and the pi extension live in `agent/` (functional locations outside this skill folder). Invoke after determining that a new RepoPrompt version might have changed MCP/CLI tooling.
---

# Workflow

## Phase 1 — MCP

1. Read `changelog-latest.md` (at the Skill folder root) to see what the developer reported as changed in this new version.

2. The MCP files live in `agent/skills/repoprompt-tool-guidance-refresh/rp-prompts/mcp/`:
   - `AGENTS-mcp-preface.md`
   - `followup-from-review.md`
   - `rp-review.md`

3. Run `rp-cli -l` to get the full list of MCP tools and their definitions. Review them and then examine `AGENTS-mcp-preface.md` for any outdated definitions or missing key tools. If there are any, make surgical updates to bring it into alignment with the latest state of the RepoPrompt MCP server.

4. Do the same for the other MCP files listed above.

## Phase 2 — CLI

1. Retain `changelog-latest.md` in context (re-read if no longer available).

2. The CLI-related files live outside this skill folder in their functional locations:
   - `agent/AGENTS-rp-cli-prefix.md`
   - `agent/prompts/rp-address-review-cli.md`
   - `agent/prompts/rp-review-cli.md`
   - `agent/extensions/repoprompt.ts`

3. Retain `rp-cli -l` in context (re-run if no longer available). Run `rp-cli --help` to understand how the CLI relates to the tool definitions provided by `rp-cli -l`. Review them and then examine `AGENTS-rp-cli-prefix.md` for outdated definitions or missing key tools. If there are any, make surgical updates to bring it into alignment with the latest state of the RepoPrompt CLI.

4. Do the same for the other CLI-related files:
   - `rp-address-review-cli.md`
   - `rp-review-cli.md`

5. Confirm whether `repoprompt.ts` encodes any assumptions about the CLI that are now invalidated by the latest state of `rp-cli`. If so, make surgical patches to that file (only patches directly entailed by what the `rp-cli` change broke).

## Phase 3 — Git

Stage the changed files.

# Scope of Relevant Changes

Do not add anything to these files that doesn't concern a lever that you would directly have available to you. New/changed/removed MCP tools, new/changed/removed CLI tools or interface points are relevant changes for these documents to be updated on. Changes that concern the RepoPrompt desktop app (without accompanying changes to the MCP or CLI tools) are not relevant to this documentation refresh, nor are changes that concern RepoPrompt's support for or integration with other applications/TUIs/harnesses (provided that those changes are not accompanied by changes to the MCP or CLI tools), nor are any other changes noted in the Changelog that you do not find an accompanying signature of in the MCP tool descriptions or CLI outputs.
