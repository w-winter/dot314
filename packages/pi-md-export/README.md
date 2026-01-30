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

Options:
- `/md t*` — include thinking blocks (any arg starting with `t`, e.g. `/md t`, `/md think`, `/md thinking`)
- `/md <N>` exports only the last **N turns** (a turn is `[user message → assistant message]`), e.g. `/md 2`, `/md t 2`, `/md think 1`
- `/md all` (or `/md file`) — export the full session file instead of the current branch

## Notes

- If you are running an ephemeral session (no session file), export is not available
