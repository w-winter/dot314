# anycopy for Pi (`pi-anycopy`)

Browse session tree nodes with a live preview and copy any of them to the clipboard.

By comparison to Pi's native `/copy` (copies only the last assistant message) and `/md` (bulk-exports the entire branch as a Markdown transcript), `/anycopy` allows you to navigate the full session tree, preview each node's content with syntax highlighting, and copy to the clipboard any node(s) from the tree.

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
| `Space` | Select/unselect focused node |
| `Shift+C` | Copy selected nodes (or focused node if nothing is selected) |
| `Shift+X` | Clear selection |
| `Shift+L` | Label node (native tree behavior) |
| `Shift+Up` / `Shift+Down` | Scroll node preview by line |
| `Shift+Left` / `Shift+Right` | Page through node preview |
| `Esc` | Close |

Notes:
- If no nodes are selected, `Shift+C` copies the focused node
- When copying multiple selected nodes, they are auto-sorted chronologically (by position in the session tree), not by selection order
- Label edits are persisted via `pi.setLabel(...)`
- Despite reoffering node labeling (`/anycopy` is arguably a better UI than `/tree` to also perform this action in), this extension doesn't offer a full reproduction of `/tree`'s other features (e.g., branch switching and summarization are not included)

## Configuration

Edit `~/.pi/agent/extensions/anycopy/config.json`:

- `treeFilterMode`: initial tree filter mode when opening `/anycopy` (idea sourced from [lajarre](https://github.com/lajarre)'s [pi-mono/issues/1845](https://github.com/badlogic/pi-mono/issues/1845))
  - one of: `default` | `no-tools` | `user-only` | `labeled-only` | `all`
- `keys`: keybindings (see above)

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
