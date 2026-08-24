# anycopy

This extension mirrors all the behaviors of Pi's native `/tree` while adding a live, syntax-highlighting preview of each node's content, the ability to copy any node(s) to the clipboard, and optional node creation timestamps.

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
| `Shift+C` | Copy selected nodes, or the focused node if nothing is selected. Tool results include the originating call |
| `Shift+X` | Clear selection |
| `Shift+R` | Start or finish inclusive range selection |
| `Tab` | Toggle between tree-focused and preview-focused layouts |
| `Shift+L` | Label node (native tree behavior) |
| `Shift+T` | Toggle label timestamps for labeled nodes |
| `Shift+Ctrl+T` | Toggle node creation timestamps |
| `Shift+Up` / `Shift+Down` | Scroll node preview by line |
| `Shift+PageUp` / `Shift+PageDown` | Page through node preview |
| `?` | Show every effective native tree and anycopy action |
| `Esc` | Close |

Notes:
- `Enter` always navigates the focused node, not the marked set
- After `Enter`, `/anycopy` offers the same summary choices as `/tree`: `No summary`, `Summarize`, and `Summarize with custom prompt`
- If `branchSummary.skipPrompt` is `true` in Pi settings, `/anycopy` matches native `/tree` and skips the summary chooser, defaulting to no summary
- Escaping the summary chooser reopens `/anycopy` with focus restored to the node you tried to select
- Cancelling the custom summarization editor returns to the summary chooser
- If no nodes are selected, `Shift+C` copies the focused node
- Tool-result previews always show the originating tool name and arguments above the result. Copying the node includes both the call and result
- `Shift+R` anchors a range at the focused node. Tree movement extends or shrinks the inclusive range and adds every node in that range to the existing selection
- Search, filter, and fold changes finish an active range while preserving its selected nodes
- `Tab` switches directly between the tree-focused and preview-focused layouts. Both panes remain visible according to their configured ratios
- `?` lists every effective native tree and anycopy binding. It omits native actions that anycopy does not implement
- An optional global shortcut opens anycopy without clearing the editor draft. This copy-only mode keeps `Shift+C` unchanged, while `Enter` explains that navigation requires command-opened `/anycopy`
- Custom session entries use readable labeled content in previews and clipboard output. Numeric timestamp fields ending in `At` use the local time zone
- Single-node copies use just that node's content; role prefixes like `user:` or `assistant:` are only added when copying 2 or more nodes
- When copying multiple selected nodes, they are auto-sorted chronologically by position in the session tree, not by selection order
- `Shift+A`/`Shift+C` multi-select copy behavior is unchanged by navigation support, while plain space remains available for search queries
- `/anycopy` opens over the session view, so widgets above the editor do not reduce the space available to its preview
- `Shift+T` is configurable via `keys.toggleLabelTimestamps` in `config.json`
- `Shift+T` shows timestamps for labeled nodes only, using the latest label-change time for each label
- `Shift+Ctrl+T` is configurable via `keys.toggleEntryTimestamps` in `config.json`
- `Shift+Ctrl+T` shows each node's creation time right-aligned at the far right of each visible tree row
- Nodes without a creation time show no timestamp
- Timestamps use a compact format: same-day `HH:MM`, same-year `M/D HH:MM`, cross-year `YY/M/D HH:MM`
- Label edits are persisted via `pi.setLabel(...)`
- [Folded](https://github.com/badlogic/pi-mono/blob/09e9de5749193beab234f30ed220a77f3d91cfad/packages/coding-agent/docs/tree.md#controls) branches are persisted by default in hidden `/anycopy` session entries, so closing/reopening `/anycopy`, switching to a sibling branch, or revisiting the session later restores the same folded view until you explicitly unfold it again
- Search and filter changes still reset the live overlay's fold state temporarily; reopening `/anycopy` restores the persisted folded branches

## Configuration

Edit `~/.pi/agent/extensions/anycopy/config.json`:

- `treeFilterMode`: initial tree filter mode when opening `/anycopy`; defaults to `default` to match `/tree`
  - one of: `default` | `no-tools` | `user-only` | `labeled-only` | `all`
- `persistFoldState`: whether `/anycopy` persists folded branches across reopenings and later sessions; defaults to `true`; when disabled, `/anycopy` does not read or write hidden fold-state session entries
- `shortcut`: optional global shortcut that opens copy-only anycopy without clearing the current editor draft. Set it to a key such as `ctrl+shift+c`, or leave it as `null`
- `hints.mode`: `full` shows every inline action, while `compact` keeps one status row with the help and Enter actions
- `layout.treeFocusTreeRatio`: fraction of pane rows used by the tree in tree-focused mode
- `layout.previewFocusTreeRatio`: fraction of pane rows used by the tree in preview-focused mode
- `keys`: keybindings used inside the `/anycopy` overlay

```json
{
  "treeFilterMode": "default",
  "persistFoldState": true,
  "shortcut": null,
  "hints": {
    "mode": "full"
  },
  "layout": {
    "treeFocusTreeRatio": 0.85,
    "previewFocusTreeRatio": 0.15
  },
  "keys": {
    "toggleSelect": "shift+a",
    "copy": "shift+c",
    "clear": "shift+x",
    "toggleLabelTimestamps": "shift+t",
    "toggleEntryTimestamps": "shift+ctrl+t",
    "scrollUp": "shift+up",
    "scrollDown": "shift+down",
    "pageUp": "shift+pageup",
    "pageDown": "shift+pagedown",
    "togglePaneFocus": "tab",
    "toggleRangeSelection": "shift+r",
    "help": "?"
  }
}
```

For npm installation and package-specific docs, see [`packages/pi-anycopy/README.md`](../../packages/pi-anycopy/README.md)
