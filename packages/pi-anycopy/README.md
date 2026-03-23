# anycopy for Pi (`pi-anycopy`)

This extension mirrors all the behaviors of Pi's native `/tree` while adding a live, syntax-highlighting preview of each node's content and the ability to copy any node(s) to the clipboard.

<p align="center">
  <img width="450" alt="anycopy demo" src="https://raw.githubusercontent.com/w-winter/dot314/main/assets/anycopy-demo.gif" />
</p>

## Install

From npm:

```bash
pi install npm:pi-anycopy
```

From the dot314 git bundle (filtered install):

Add to `~/.pi/agent/settings.json` (or replace an existing unfiltered `git:github.com/w-winter/dot314` entry):

```json
{
  "packages": [
    {
      "source": "git:github.com/w-winter/dot314",
      "extensions": ["extensions/anycopy/index.ts"],
      "skills": [],
      "themes": [],
      "prompts": []
    }
  ]
}
```

Restart Pi after installation.

## Usage

```text
/anycopy
```

## Keys

Defaults (customizable in `config.json`):

| Key | Action |
|-----|--------|
| `Enter` | Navigate to the focused node (same semantics as `/tree`) |
| `Space` | Select/unselect focused node for copy |
| `Shift+C` | Copy selected nodes, or the focused node if nothing is selected |
| `Shift+X` | Clear selection |
| `Shift+L` | Label node (native tree behavior) |
| `Shift+Up` / `Shift+Down` | Scroll node preview by line |
| `Shift+Left` / `Shift+Right` | Page through node preview |
| `Esc` | Close |

Notes:
- `Enter` always navigates the focused node, not the marked set
- After `Enter`, `/anycopy` offers the same summary choices as `/tree`: `No summary`, `Summarize`, and `Summarize with custom prompt`
- If `branchSummary.skipPrompt` is `true` in Pi settings, `/anycopy` matches native `/tree` and skips the summary chooser, defaulting to no summary
- Escaping the summary chooser reopens `/anycopy` with focus restored to the node you tried to select
- Cancelling the custom summarization editor returns to the summary chooser
- If no nodes are selected, `Shift+C` copies the focused node
- Single-node copies use just that node's content; role prefixes like `user:` or `assistant:` are only added when copying 2 or more nodes
- When copying multiple selected nodes, they are auto-sorted chronologically by position in the session tree, not by selection order
- Space/`Shift+C` multi-select copy behavior is unchanged by navigation support
- Label edits are persisted via `pi.setLabel(...)`

## Configuration

Edit `~/.pi/agent/extensions/anycopy/config.json`:

- `treeFilterMode`: initial tree filter mode when opening `/anycopy`; defaults to `default` to match `/tree`
  - one of: `default` | `no-tools` | `user-only` | `labeled-only` | `all`
- `keys`: keybindings used inside the `/anycopy` overlay for copy/preview actions

```json
{
  "treeFilterMode": "default",
  "keys": {
    "toggleSelect": "space",
    "copy": "shift+c",
    "clear": "shift+x",
    "scrollUp": "shift+up",
    "scrollDown": "shift+down",
    "pageUp": "shift+left",
    "pageDown": "shift+right"
  }
}
```
