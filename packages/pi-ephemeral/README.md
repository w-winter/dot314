# Pi Ephemeral Mode (`pi-ephemeral`)

Toggle session persistence on/off mid-session.

When enabled, Pi deletes the current session file on exit (useful for throwaway sessions that you don't want cluttering `/resume`).

## Install

From npm:

```bash
pi install npm:pi-ephemeral
```

From the dot314 git bundle (filtered install):

Add to `~/.pi/agent/settings.json` (or replace an existing unfiltered `git:github.com/w-winter/dot314` entry):

```json
{
  "packages": [
    {
      "source": "git:github.com/w-winter/dot314",
      "extensions": ["extensions/ephemeral-mode.ts"],
      "skills": [],
      "themes": [],
      "prompts": []
    }
  ]
}
```

## Usage

- Command: `/ephemeral`
- Shortcut: `Alt+E`

## Notes

- If `trash` is available, it's used to remove the session file (safer). Otherwise it falls back to direct deletion
- If you're already running an in-memory/ephemeral session (no session file), there's nothing to delete
