# RepoPrompt MCP for Pi (`pi-repoprompt-mcp`)

This package provides a single tool (`rp`) that exposes the RepoPrompt MCP tools to Pi, includes branch-safe window and tab binding (automatically detecting the right window by `cwd`, provisioning a safe tab, persisting both across sessions and session tree nodes, and letting you pick windows and tabs interactively) and batches of read files (automatically selected as context in the RepoPrompt desktop app), renders RepoPrompt tool outputs (syntax + diff highlighting), and applies guardrails for destructive operations.

The package's window- and tab-related management features allow a workflow where new Pi sessions automatically attach to the required workspace and tab without clobbering your, or other agents', parallel usage of RepoPrompt.  Because it recovers the window, tab, and auto-selected read-files context when you rewind via `/tree` or restore a session, all the context the agent has built up (and automatically selected in the RepoPrompt app) by reading files and slices up to that point always remains available in the app for RP Chat (see `/rp oracle` below) or external "oracle" (e.g. GPT-x Pro) use cases.  **Note: this recovery currently requires the original workspace (but not necessarily its original tabs) to be open, not just any workspace containing the same required root(s).**

## Installation

From npm:

```bash
pi install npm:pi-repoprompt-mcp
```

From the dot314 git bundle (filtered install):

Add to `~/.pi/agent/settings.json` (or replace an existing unfiltered `git:github.com/w-winter/dot314` entry):

```json
{
  "packages": [
    {
      "source": "git:github.com/w-winter/dot314",
      "extensions": ["extensions/repoprompt-mcp/src/index.ts"],
      "skills": [],
      "themes": [],
      "prompts": []
    }
  ]
}
```

## Features

### Window and tab binding

- Auto-binds to the RepoPrompt window that matches `process.cwd()` (by workspace roots, resolving symlinks to their real paths before matching)
  - If multiple windows match, you're prompted to pick one
  - Window binding is (optionally) persisted across session reloads and session tree nodes
- If a bound window has a completely blank tab, the package binds to that tab; if the tab is dirty, then it provisions a new tab and binds to that
- Deterministically reconciles the session tree node's bound tab, and can restore the tab already associated with that node or provision a new safe tab when needed
- User-driven binding via `/rp bind` (windows) or `/rp tab` (tabs); agents can use `rp({ bind: ... })`
- In addition to window bindings, tab bindings and auto-selected read-files context is stored and automatically recovered across node rewinds via `/tree`, different sessions (e.g., created via `/fork`), and resumed sessions

Forked sessions inherit the parent session-plus-node's window, tab, and auto-selected context snapshot at the fork point (unless you rewind in the forked session and switch window/tab/etc.), then can diverge independently as later reads or manual tab switches are performed in the child session.  Binding is non-invasive, in that it doesn't change RepoPrompt's globally active window, and automatic tab provisioning uses background tabs (`focus=false`) without stealing UI focus.  This is to prevent interference when multiple agents (or your manual usage of RepoPrompt in parallel to a Pi session) are using this package and need to target different windows or tabs simultaneously.

### Output rendering

- Syntax highlighting for read files' code blocks and for codemaps
- Diff highlighting for diff blocks (`delta` when installed, honoring the user's global git/delta color config, graceful fallback otherwise)
- Markdown-aware styling for headings and lists
- Collapsed output by default (expand using Pi's standard UI controls)

### Safety checks

- Delete operations are blocked unless you pass `allowDelete: true`
- Optional edit confirmation gate for edit-like operations (`confirmEdits`)
- Warn on in-place workspace switches (when applicable)

## Requirements

- RepoPrompt MCP server configured and reachable (stdio transport)
  - If the server is not configured/auto-detected, the package will still load, but `rp(...)` will error until you configure it
- `rp-cli` available in `PATH` is recommended (used as a fallback for window discovery)

### Compatibility notes

This package tries to be tolerant of **tool name prefixing** (e.g. `RepoPrompt_list_windows` vs `list_windows`), but it is still dependent on a small set of capabilities and their semantics remaining reasonably stable across RepoPrompt versions:

- **Window discovery**: `list_windows`
  - If `list_windows` is not exposed by the MCP server, the package falls back to `rp-cli -e 'windows'`
  - If neither is available, window listing/binding features will be limited
- **Workspace root discovery (auto-bind by cwd)**: `get_file_tree` with `{ type: "roots" }` (scoped by `_windowID`)
  - If unavailable (or if parameters/semantics change), auto-binding may be disabled or less accurate
- Selection summary: `manage_selection` with `{ op: "get", view: "files" }` and `{ op: "get", view: "summary" }`
  - If these are unavailable (or if parameters/semantics change), the status output may omit file/token counts

If RepoPrompt renames/removes these tools or changes their required parameters/output formats, this package may need updates

## Usage

### Commands

- `/rp status` — show status (connection + binding), including the currently bound tab name and a label like `[bound, in-focus]` or `[bound, out-of-focus]`, plus current selected file counts and estimated token counts
- `/rp windows` — list available RepoPrompt windows
- `/rp bind` — interactive workflow for choosing the RepoPrompt window
- `/rp bind <id> [tab]` — direct option if you already know the target window id (and optionally an exact tab name or tab id); when `[tab]` is omitted, the package restores the branch's tab for that window or provisions a fresh background tab once
- `/rp tab` — interactive tab picker for the current bound window, with `Create new tab` as the first option followed by existing tab names
- `/rp tab new` — create and bind a fresh tab on the current bound window
- `/rp tab <name-or-id>` — bind an existing tab on the current bound window by name or id
- `/rp oracle [--mode <chat|plan|edit|review>] [--name <chat name>] [--continue|--chat-id <id>] <message>` — ask RepoPrompt chat with current selection context.  If `--mode` not specified, uses `oracleDefaultMode` config.
- `/rp reconnect` — reconnect to RepoPrompt

### Tool: `rp`

Examples:

```ts
// Status (connection + binding)
rp({ })

// List windows (best-effort; uses MCP tool if available, otherwise rp-cli)
rp({ windows: true })

// Bind to a specific window (does not change RepoPrompt active window)
rp({ bind: { window: 3 } })

// Bind to an exact tab in that window
rp({ bind: { window: 3, tab: "T2" } })

// Search or describe tools
rp({ search: "file" })
rp({ describe: "apply_edits" })

// Call a RepoPrompt tool (binding args are injected automatically)
rp({ call: "read_file", args: { path: "src/main.ts" } })

// Edit confirmation gate (only required if confirmEdits=true in config)
rp({
  call: "apply_edits",
  args: { path: "file.ts", search: "old", replace: "new" },
  confirmEdits: true
})

// Delete guard override
rp({
  call: "file_actions",
  args: { action: "delete", path: "temp.txt" },
  allowDelete: true
})
```

## Configuration

Create `~/.pi/agent/extensions/repoprompt-mcp.json`:

```json
{
  "command": "rp-mcp-server",
  "args": [],

  "autoBindOnStart": true,
  "persistBinding": true,

  "confirmDeletes": true,
  "confirmEdits": false,

  "readcacheReadFile": true,
  "autoSelectReadSlices": true,
  "oracleDefaultMode": "chat",

  "collapsedMaxLines": 3,
  "suppressHostDisconnectedLog": true
}
```

`collapsedMaxLines` controls how many lines of RepoPrompt tool output Pi shows before the result is expanded. This applies to the collapsed preview for all `rp(...)` calls, including commands like window listings and file reads.  **Recommended setting for maximally compressed** but still informative output: `3`.

Options:

| Option | Default | Description |
|---|---:|---|
| `command` | auto-detect | MCP server command |
| `args` | `[]` | MCP server args |
| `env` | unset | Extra environment variables for the MCP server |
| `autoBindOnStart` | `true` | Auto-detect and bind on session start, then reconcile the branch-safe tab for the chosen window |
| `persistBinding` | `true` | Persist window and tab bindings in Pi session history for branch-safe replay |
| `confirmDeletes` | `true` | Block delete operations unless `allowDelete: true` |
| `confirmEdits` | `false` | Block edit-like operations unless `confirmEdits: true` |
| `readcacheReadFile` | `false` | Enable [pi-readcache](https://github.com/Gurpartap/pi-readcache)-like caching for RepoPrompt `read_file` calls (returns unchanged markers/diffs on repeat reads to save on tokens and prevent context bloat) |
| `autoSelectReadSlices` | `true` | Automatically track `read_file` calls by adding slices/full-file selection via `manage_selection`, so `chat_send` (or a manually created chat in the RP app) uses everything the agent has read as context; these file/slice selections are **branch-safe** across `/tree` rewinds and `/fork`ed session branches via package-owned snapshot replay |
| `oracleDefaultMode` | `"chat"` | Default mode for `/rp oracle` when `--mode` is omitted (`chat`, `plan`, `edit`, or `review`) |
| `collapsedMaxLines` | `15` | Lines shown in collapsed view |
| `suppressHostDisconnectedLog` | `true` | Filter noisy stderr from macOS `repoprompt-mcp` (disconnect/retry bootstrap logs) |

Automatic tab restoration and provisioning is driven by `autoBindOnStart` and `persistBinding`; there is no separate tab-only configuration surface.

Note: when `readcacheReadFile` is enabled, the package may persist UTF-8 file snapshots to an on-disk content-addressed store under
`<repo-root>/.pi/readcache/objects` to compute diffs/unchanged markers across calls. Common secret filenames (e.g. `.env*`, `*.pem`) are excluded,
but this is best-effort

## Readcache gotchas

- `raw: true` disables readcache (and rendering). Don't use unless debugging
- Need full content? use `bypass_cache: true` in `read_file` args
- Multi-root: use absolute or specific relative paths (MCP `read_file` has no `RootName:` disambiguation)

## Troubleshooting

### "Not connected to RepoPrompt"
- Ensure RepoPrompt is running
- Verify the MCP server command in config
- Run `/rp reconnect`

### Pi becomes unresponsive after closing/restarting RepoPrompt
If the RepoPrompt MCP server stops responding (for example, if the RepoPrompt app is closed while Pi stays open), tool calls may time out. When that happens, the package will drop the connection and you can recover with `/rp reconnect`.

### "No matching window found"
- Your `cwd` may not match any RepoPrompt workspace root
- Use `/rp windows` to list windows
- Use `/rp bind` to pick one

### Window listing doesn't work
- If the MCP server does not expose a `list_windows` tool, this package uses `rp-cli -e 'windows'`
- Make sure `rp-cli` is installed and on your `PATH`
- If RepoPrompt is in single-window mode, `rp-cli -e 'windows'` may report single-window mode

### Delete operation blocked
- Pass `allowDelete: true` on the `rp` call

## License

MIT
