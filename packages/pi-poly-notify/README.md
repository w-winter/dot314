# Notifications for Pi (`pi-poly-notify`)

Sends notifications when an agent turn finishes and took longer than a configurable threshold.

Supports:
- desktop popups (macOS)
- sounds (macOS `afplay`), with plenty of customization options
- optional Pushover notifications (useful for Apple Watch / iOS)

## Install

From npm:

```bash
pi install npm:pi-poly-notify
```

From the dot314 git bundle (filtered install):

Add to `~/.pi/agent/settings.json` (or replace an existing unfiltered `git:github.com/w-winter/dot314` entry):

```json
{
  "packages": [
    {
      "source": "git:github.com/w-winter/dot314",
      "extensions": ["extensions/poly-notify/index.ts"],
      "skills": [],
      "themes": [],
      "prompts": []
    }
  ]
}
```

## Setup

Create your config file:

- copy `notify.json.example` → `notify.json`

Location:

- `~/.pi/agent/extensions/poly-notify/notify.json`

## Usage

- Command: `/notify`
- Shortcut: `Alt+N` (toggle on/off)

Quick forms:
- `/notify on|off`
- `/notify popup` (toggle popup)
- `/notify pushover` (toggle Pushover)
- `/notify volume` (toggle constant ↔ timeScaled)
- `/notify <seconds>` (set minimum duration threshold)
- `/notify <sound-alias>` (set sound)

## Notes

- macOS-only out of the box (uses `osascript` + `afplay`)
- Pushover requires `curl` and valid `userKey` + `apiToken` in config
