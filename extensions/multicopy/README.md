# Multicopy

Multi-select copy picker for Pi session tree nodes.

Pi already has a native `/copy` for quickly copying the most recent assistant output. `multicopy` is for the case where you want to copy **multiple** nodes from the session tree, and you want a live preview so you can confirm you’re grabbing the right thing before copying.

## Usage

```text
/multicopy [safe|--no-preview]
```

- `safe` / `--no-preview`: disables the preview panel for a lower-latency fallback

## Keys

Defaults (customizable in `config.json`):

- `Space` — select/unselect focused node
- `Shift+C` — copy selected nodes (or focused node if nothing is selected)
- `Shift+X` — clear selection
- `Shift+L` — label node (native tree behavior)
- `Enter` / `Esc` — close

Notes:
- When copying multiple selected nodes, they are **auto-sorted chronologically** (relative to the currently visible session tree), not by selection order
- Label edits are persisted via `pi.setLabel(...)`

## Configuration

Edit:

- `~/.pi/agent/extensions/multicopy/config.json`

Schema:

```json
{
  "keys": {
    "toggleSelect": "space",
    "copy": "shift+c",
    "clear": "shift+x"
  }
}
```

For npm installation and package-specific docs, see [`packages/pi-multicopy/README.md`](../../packages/pi-multicopy/README.md)
