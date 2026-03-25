# Pi Markdown Export (`pi-md-export`)

Export the last N turns, or entirety of, your current Pi session to a readable Markdown transcript (either the current `/tree` branch or the full session file).

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

Tool calls and thinking blocks are excluded by default for a clean conversation-only export.

Options:
- `/md tc` — include tool calls (invocations + results)
- `/md t` — include thinking blocks (also accepts `think`, `thinking`)
- `/md <N>` exports only the last **N turns** (a turn is `[user message → assistant message]`), e.g. `/md 2`, `/md tc t 2`
- `/md all` (or `/md file`) — export the full session file instead of the current branch

Flags combine freely: `/md tc t all 3` exports the last 3 turns of the full session file with tool calls and thinking.

## Notes

- If you are running an ephemeral session (no session file), export is not available
