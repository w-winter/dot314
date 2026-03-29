# Session Switch for Pi (`pi-session-switch`)

Switch between Pi sessions with `/switch-session`, using the same layout and affordances as Pi's native `/resume` picker plus a live preview of the currently highlighted session beneath the picker.

![`/switch-session` demo](https://raw.githubusercontent.com/w-winter/dot314/main/assets/switch-session-demo.gif)

## Install

From npm:

```bash
pi install npm:pi-session-switch
```

From the dot314 git bundle (filtered install):

```json
{
  "packages": [
    {
      "source": "git:github.com/w-winter/dot314",
      "extensions": ["extensions/session-switch.ts"],
      "skills": [],
      "themes": [],
      "prompts": []
    }
  ]
}
```

## Command

```text
/switch-session
```

## Behavior

- Mirrors the native `/resume` picker layout, behaviors, and keybindings
- Shows a live preview of the highlighted session below the picker
- `Shift+Up` / `Shift+Down` scroll the preview by line
- `Shift+Left` / `Shift+Right` page the preview
- Preserves the native inline rename and delete-confirmation flows

## Compared with upstream

Derived from Damian Pedroza's [`pi-thread-switcher`](https://github.com/damianpdr/pi-thread-switcher).  This version has a few additions that I found helpful for readability: the session preview lives in a dedicated pane below the picker with syntax-highlighted Markdown rendering, and `Shift+Left` / `Shift+Right` are also offered for paging through the preview.  The picker itself uses Pi's native `SessionSelectorComponent`, matching the `/resume` interaction model.

See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for full attribution.
