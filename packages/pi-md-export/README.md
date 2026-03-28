# Pi Markdown Export (`pi-md-export`)

Export your current Pi session to a readable Markdown transcript. The command can export either the current `/tree` branch or the full session file, and it can limit the output to the last N turns.

Outputs can be copied to clipboard or saved under `~/.pi/agent/pi-sessions-extracted/`.

## Install

From npm:

```bash
pi install npm:pi-md-export
```

From the dot314 git bundle (filtered install):

Add to `~/.pi/agent/settings.json` (or replace an existing unfiltered `git:github.com/w-winter/dot314` entry):

```json
{
  "packages": [
    {
      "source": "git:github.com/w-winter/dot314",
      "extensions": ["extensions/md.ts"],
      "skills": [],
      "themes": [],
      "prompts": []
    }
  ]
}
```

## Usage

- Command: `/md`

Tool calls and thinking blocks are excluded by default for a clean conversation-focused export.

Options:
- `/md` — export the current `/tree` branch
- `/md all` or `/md file` — export the full session file instead of the current branch
- `/md <N>` — export only the last **N turns** (a turn is `[user message → assistant message]`), e.g. `/md 2`
- `/md t` — include thinking blocks (also accepts `think`, `thinking`)
- `/md tc` — include tool calls (invocations + results)
- `/md tc -<toolname>` — exclude exact tool name(s), e.g. `/md tc -bash -read`
- `/md tc +<toolname>` — exclude all tool names except the whitelisted exact tool name(s), e.g. `/md tc +ask`

Tool filtering:
- tool-name matching is exact and case-insensitive
- tool filters require `tc`; `/md +ask` is invalid, but `/md tc +ask` is valid
- `+all` and `-all` are not supported; use `/md tc` for all tools or `/md tc +tool` for whitelisting
- a tool filter applies to both the assistant-side tool call line and the matching tool-result block

Flags combine freely: `/md tc t all 3` exports the last 3 turns of the full session file with tool calls and thinking.

## Notes

- If you are running an ephemeral session (no session file), export is not available
