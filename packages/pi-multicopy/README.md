# Multicopy for Pi (`pi-multicopy`)

Multi-select copy picker for Pi session tree nodes (with live preview + inline labels).

This complements Pi’s native `/copy` command:
- `/copy` is great for grabbing the most recent output quickly
- `/multicopy` is for selecting *multiple* nodes across the session tree, with preview to verify each node before copying

## Install

From npm:

```bash
pi install npm:pi-multicopy
```

From the dot314 git bundle (filtered install):

Add to `~/.pi/agent/settings.json` (or replace an existing unfiltered `git:github.com/w-winter/dot314` entry):

```json
{
  "packages": [
    {
      "source": "git:github.com/w-winter/dot314",
      "extensions": ["extensions/multicopy/index.ts"],
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
/multicopy [safe|--no-preview]
```

- `safe` / `--no-preview`: disables the preview panel for a lower-latency fallback

## Keys

Defaults (customizable in config):

- `Space` — select/unselect focused node
- `Shift+C` — copy selected nodes (or focused node if none selected)
- `Shift+X` — clear selection
- `Shift+L` — label node (native tree behavior)
- `Enter` / `Esc` — close

Copy semantics:
- If **no nodes are selected**, copy acts on the **focused node**
- If **one or more nodes are selected**, copy acts on the **selection set only**
- When copying multiple nodes, nodes are **auto-sorted chronologically** (relative to the session tree), not by selection order

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

Notes:
- Config parsing is intentionally forgiving; invalid/missing config falls back to defaults
- Labels are persisted via `pi.setLabel(...)` entries
