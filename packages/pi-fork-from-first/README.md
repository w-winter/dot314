# Fork From First for Pi (`pi-fork-from-first`)

Fork the current Pi session from its first user message and switch into the new fork immediately. Useful especially in combination with npm:pi-session-ask and handoff/pickup prompt patterns.

## Install

From npm:

```bash
pi install npm:pi-fork-from-first
```

From the dot314 git bundle (filtered install):

```json
{
  "packages": [
    {
      "source": "git:github.com/w-winter/dot314",
      "extensions": ["extensions/fork-from-first.ts"],
      "skills": [],
      "themes": [],
      "prompts": []
    }
  ]
}
```

## Usage

```
/fork-from-first
```

## Rewind integration

If [pi-rewind-hook](https://www.npmjs.com/package/pi-rewind-hook) is installed, `/fork-from-first` automatically requests a conversation-only fork ("keep current files"), so filesystem state is preserved while the conversation resets.
