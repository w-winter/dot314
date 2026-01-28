# Pi Markdown Export (`pi-md-export`)

Export your current Pi session to a readable Markdown transcript (either the current `/tree` branch or the full session file).

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
- `/md thinking` — include thinking blocks (if present in your session log)
- `/md all` (or `/md file`) — export the full session file instead of the current branch

## Notes

- If you are running an ephemeral session (no session file), export is not available
