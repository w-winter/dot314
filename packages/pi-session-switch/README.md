# Session Switch for Pi (`pi-session-switch`)

Switch between Pi sessions with `/switch-session`, or open the same picker after interactive startup with `pi --switch-session`, using the same layout and affordances as Pi's native `/resume` picker plus a live preview of the currently highlighted session beneath the picker.

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
      "extensions": ["extensions/session-switch/index.ts"],
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

## Startup flag

```bash
pi --switch-session
```

Opens the same picker after interactive startup, then relaunches Pi into the selected session.

This is an extension-only workaround for startup switching. Unlike native `pi --resume`, it does not provide missing-cwd recovery for sessions whose recorded cwd no longer exists, and it does not reuse Pi's normal in-process session-switch lifecycle or guarantee the same shutdown-hook cleanup semantics.

## Behavior

- `/switch-session` stays on Pi's native in-process session switch path
- `pi --switch-session` reuses the same picker UI, then relaunches Pi into the selected session
- Mirrors the native `/resume` picker layout, behaviors, and keybindings for the command path
- Shows a live preview of the highlighted session below the picker
- `Shift+Up` / `Shift+Down` scroll the preview by line
- `Shift+PageUp` / `Shift+PageDown` page the preview
- Preserves the native inline rename and delete-confirmation flows

## Optionally replacing native `--resume`

If you want `pi -r` and `pi --resume` to use this extension's picker instead of Pi's built-in resume, add this wrapper to your `.bashrc` or `.zshrc`:

```sh
pi() {
  local -a args=()

  while (($#)); do
    case "$1" in
      --)
        args+=("$@")
        break
        ;;
      -r|--resume)
        if (($# > 1)) && [[ "$2" != -* ]]; then
          args+=(--session "$2")
          shift 2
        else
          args+=(--switch-session)
          shift
        fi
        ;;
      --resume=*)
        args+=(--session "${1#--resume=}")
        shift
        ;;
      *)
        args+=("$1")
        shift
        ;;
    esac
  done

  command pi "${args[@]}"
}
```

This rewrites:
- `pi -r` / `pi --resume` to `pi --switch-session` (opens the picker)
- `pi -r <path>` / `pi --resume <path>` to `pi --session <path>` (opens that session directly)

## Compared with upstream

Derived from Damian Pedroza's [`pi-thread-switcher`](https://github.com/damianpdr/pi-thread-switcher).  This version has a few additions that I found helpful for readability: the session preview lives in a dedicated pane below the picker with syntax-highlighted Markdown rendering, and `Shift+PageUp` / `Shift+PageDown` are also offered for paging through the preview.  The picker itself uses Pi's native `SessionSelectorComponent`, matching the `/resume` interaction model.

See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for full attribution.
