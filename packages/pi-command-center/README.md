# Command Center for Pi (`pi-command-center`)

A scrollable overview of available /commands (from extensions, prompts, skills) shown as a widget above the editor.  The editor stays fully interactive; you can keep the widget open while typing and submitting commands.  By default, `Ctrl+/` toggles it and `Shift+Up` / `Shift+Down` scroll it.

See source repo for more documentation.

<p align="center">
  <img width="333" alt="command center demo" src="https://raw.githubusercontent.com/w-winter/dot314/main/assets/command-center-demo.gif" />
</p>

## Install

From npm:

```bash
pi install npm:pi-command-center
```

From the dot314 git bundle (filtered install):

Add to `~/.pi/agent/settings.json` (or replace an existing unfiltered `git:github.com/w-winter/dot314` entry):

```json
{
  "packages": [
    {
      "source": "git:github.com/w-winter/dot314",
      "extensions": ["extensions/command-center/index.ts"],
      "skills": [],
      "themes": [],
      "prompts": []
    }
  ]
}
```

## Configuration

This package ships a template at:

- `extensions/command-center/config.json.example`

Copy it to `config.json`, edit, then run `/reload`.

See `extensions/command-center/README.md` for the full config options.
