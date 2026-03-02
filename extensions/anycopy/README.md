# anycopy

Browse session tree nodes with a live preview and copy any of them to the clipboard.

By comparison to Pi's native `/copy` (copies only the last assistant message) and `/md` (bulk-exports the entire branch as a Markdown transcript), `/anycopy` allows you to navigate the full session tree, preview each node's content with syntax highlighting, and copy to the clipboard any node(s) from the tree.

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

```json
{
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

For npm installation and package-specific docs, see [`packages/pi-anycopy/README.md`](../../packages/pi-anycopy/README.md)
