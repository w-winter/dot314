# anycopy for Pi (`pi-anycopy`)

This extension mirrors all the behaviors of Pi's native `/tree` while adding a live, syntax-highlighting preview of each node's content, the ability to copy any node(s) to the clipboard, and optional display of the timestamps of labeled nodes' last labelings.

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
| `Shift+A` | Select/unselect focused node for copy |
| `Shift+C` | Copy selected nodes, or the focused node if nothing is selected |
| `Shift+X` | Clear selection |
| `Shift+L` | Label node (native tree behavior) |
| `Shift+T` | Toggle label timestamps for labeled nodes |
| `Shift+Up` / `Shift+Down` | Scroll node preview by line |
| `Shift+PageUp` / `Shift+PageDown` | Page through node preview |
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
- `Shift+A`/`Shift+C` multi-select copy behavior is unchanged by navigation support, while plain space remains available for search queries
- `Shift+T` is configurable via `keys.toggleLabelTimestamps` in `config.json`
- `Shift+T` shows timestamps for labeled nodes only, using the latest label-change time for each label
- Same-day labels show `HH:MM`; older labels show `M/D HH:MM`; cross-year labels show `YY/M/D HH:MM`
- Label edits are persisted via `pi.setLabel(...)`
- [Folded](https://github.com/badlogic/pi-mono/blob/09e9de5749193beab234f30ed220a77f3d91cfad/packages/coding-agent/docs/tree.md#controls) branches are persisted by default in hidden `/anycopy` session entries, so closing/reopening `/anycopy`, switching to a sibling branch, or revisiting the session later restores the same folded view until you explicitly unfold it again
- Search and filter changes still reset the live overlay's fold state temporarily; reopening `/anycopy` restores the persisted folded branches

## Configuration

Edit `~/.pi/agent/extensions/anycopy/config.json`:

- `treeFilterMode`: initial tree filter mode when opening `/anycopy`; defaults to `default` to match `/tree`
  - one of: `default` | `no-tools` | `user-only` | `labeled-only` | `all`
- `persistFoldState`: whether `/anycopy` persists folded branches across reopenings and later sessions; defaults to `true`; when disabled, `/anycopy` does not read or write hidden fold-state session entries
- `keys`: keybindings used inside the `/anycopy` overlay for copy/preview actions, including the label timestamp toggle

```json
{
  "treeFilterMode": "default",
  "persistFoldState": true,
  "keys": {
    "toggleSelect": "shift+a",
    "copy": "shift+c",
    "clear": "shift+x",
    "toggleLabelTimestamps": "shift+t",
    "scrollUp": "shift+up",
    "scrollDown": "shift+down",
    "pageUp": "shift+pageup",
    "pageDown": "shift+pagedown"
  }
}
```
