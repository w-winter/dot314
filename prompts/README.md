# Prompts

## For [RepoPrompt](https://repoprompt.com/docs) CLI (rp-cli)

- ◐ [`rp-build-cli.md`](rp-build-cli.md) (source: RepoPrompt app)
  - Runs `builder` to select files and draft a plan, `chat` to refine it, then implement with `edit`/`file`
  - Modified: prefers `rp_exec` in Pi

- ◐ [`rp-investigate-cli.md`](rp-investigate-cli.md) (source: RepoPrompt app)
  - Uses `builder` and `chat` to explore a bug or question, documents findings in a report file
  - Modified: prefers `rp_exec` in Pi

- ● [`rp-review-cli.md`](rp-review-cli.md)
  - Sends a `review` chat to RepoPrompt with inferred diff scope (staged/unstaged/range) and optional context files
  - Token-efficient: lets RepoPrompt supply diffs rather than reading them

- ● [`rp-address-review-cli.md`](rp-address-review-cli.md)
  - Reads review feedback files, addresses all issues, appends completed work to a plan/log/todos file
  - Uses `builder`/`chat` when reviewer suggestions need clarification

- ◐ [`rp-oracle-export-cli.md`](rp-oracle-export-cli.md) (source: RepoPrompt app)
  - Uses `builder` to select files, then `prompt export` to write context to a file for pasting into an external model
  - Modified: prefers `rp_exec` in Pi

- ◐ [`rp-reminder-cli.md`](rp-reminder-cli.md) (source: RepoPrompt app)
  - Quick reference card reminding the agent to use rp-cli tools instead of built-ins (search not grep, read not cat, etc.)
  - Modified: prefers `rp_exec` in Pi

Related: `skills/repoprompt-tool-guidance-refresh/rp-prompts/` contains prompt variants for RepoPrompt MCP usage, if desired, in other harnesses and for maintaining this guidance over time.

## Other

- ○ [`handoff.md`](handoff.md) (upstream: [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff))
  - Write a handoff summary to a file under `~/.pi/agent/handoffs/`

- ○ [`pickup.md`](pickup.md) (upstream: [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff))
  - Resume from a handoff file
