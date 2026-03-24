# Command Center

A scrollable overview of available /commands (from extensions, prompts, skills, and optionally† built-ins) shown as a widget above the editor.  The editor stays fully interactive; you can keep the widget open while typing and submitting commands.

<p align="center">
  <img width="333" alt="command center demo" src="https://github.com/user-attachments/assets/f9ed3649-ac5b-4658-836b-86091e4985a1" />
</p>

## Usage

- Command: `/command-center` (toggle)
- Default shortcuts: `Ctrl+/` toggles, `Shift+Up` / `Shift+Down` scroll
- Shortcut bindings are configurable in `config.json`

## Configuration

1. Copy `config.json.example` → `config.json`
2. Edit `config.json` to your preferences
3. Run `/reload`

### Recommended defaults

#### Hide built-ins (†)

By default, this extension excludes built-in interactive commands because:
- Built-ins are already discoverable via the editor’s native `/` autocomplete (with descriptions)
- Keeping a built-in list inside this extension requires manual maintenance as pi evolves

If you still want them, set:

```json
{
  "display": { "includeBuiltins": true }
}
```

#### Widget height

You can force a fixed widget height (rows):

```json
{
  "layout": { "height": 14 }
}
```

Suggested values:
- Small terminals: **20–30** rows
- Larger terminals: increase as you like

Notes:
- The widget height is clamped so the editor always has some space
- If pi can’t determine terminal height, Command Center assumes a fallback terminal height of **54** rows
  (so the effective maximum widget height is typically **48** rows due to reserved editor space)

If `layout.height` is `null` or omitted, the widget auto-sizes based on terminal height.

### Keybindings

All shortcuts are configured here (strings are pi key ids):

```json
{
  "keybindings": {
    "toggle": "ctrl+/",
    "scrollUp": "shift+up",
    "scrollDown": "shift+down",
    "scrollPageUp": null,
    "scrollPageDown": null
  }
}
```

Set any binding to `null` to disable it.
