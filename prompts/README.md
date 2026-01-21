# Prompts

## For [RepoPrompt](https://repoprompt.com/docs) MCP tools

- ● [`rp-review-chat.md`](rp-review-chat.md)
  - Sends a RepoPrompt `chat_send` with `mode="review"` to review diffs
  - Token-efficient: infers diff scope (staged/unstaged/range) via name-only commands, lets RepoPrompt supply diffs automatically

- ● [`rp-address-review.md`](rp-address-review.md)
  - Reads review feedback files, addresses all issues, appends completed work to a plan/log/todos file
  - Uses `context_builder` when reviewer suggestions need clarification

Related: `skills/repoprompt-tool-guidance-refresh/rp-cli-prompts/` contains CLI-specific prompt variants for use with the `repoprompt-cli` extension.

## Other

- ○ [`handoff.md`](handoff.md) (upstream: [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff))
  - Write a handoff summary to a file under `~/.pi/agent/handoffs/`

- ○ [`pickup.md`](pickup.md) (upstream: [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff))
  - Resume from a handoff file
