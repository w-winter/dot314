# Voice of God for Pi (`pi-voice-of-god`)

Adds a user-controlled message to Pi's system prompt, inserted right before the `# Project Context` section.

Useful if you want, mid-session, to add/edit/disable an extra persistent "operator instruction" across turns.

## Install

From npm:

```bash
pi install npm:pi-voice-of-god
```

From the dot314 git bundle (filtered install):

Add to `~/.pi/agent/settings.json` (or replace an existing unfiltered `git:github.com/w-winter/dot314` entry):

```json
{
  "packages": [
    {
      "source": "git:github.com/w-winter/dot314",
      "extensions": ["extensions/vog/index.ts"],
      "skills": [],
      "themes": [],
      "prompts": []
    }
  ]
}
```

## Usage

- Command: `/vog`

Forms:
- `/vog` — open interactive menu (toggle + multi-line editor)
- `/vog on` / `/vog off` — toggle
- `/vog <message>` — set the message and enable immediately

## Configuration

Config is persisted next to the extension as:

- `~/.pi/agent/extensions/vog/vog.json`
