# RepoPrompt MCP integration for Pi

This extension provides a single tool (`rp`) that exposes RepoPrompt MCP tools to Pi (using the token-efficient proxy pattern of [nicobailon's pi-mcp-adapter](https://github.com/nicobailon/)), includes branch-safe window and tab binding (auto-detect and bind to window by `cwd`, auto-bind to safe tab, persist and restore across sessions and session tree nodes, and interactive selection of windows and tabs) and batches of read files (automatically selected as context in the RepoPrompt desktop app), renders RepoPrompt tool outputs (syntax + diff highlighting), and applies guardrails for destructive operations.

The extension's window- and tab-related management features allow a workflow where new Pi sessions automatically attach to the required workspace and tab without clobbering your, or other agents', parallel usage of RepoPrompt.  Because it recovers the window, tab, and auto-selected read-files context when you rewind via `/tree` or restore a session, all the context the agent has built up (and automatically selected in the RepoPrompt app) by reading files and slices up to that point always remains available in the app for RP Chat (see `/rp oracle` below) or external "oracle" (e.g. GPT-x Pro) use cases.  **Note: this recovery currently requires the original workspace (but not necessarily its original tabs) to be open, not just any workspace containing the same required root(s).**

## Features

### Window and tab binding

- Auto-binds to the RepoPrompt window that matches `process.cwd()` (by workspace roots, resolving symlinks to their real paths before matching)
  - If multiple windows match, you're prompted to pick one
  - Window binding is (optionally) persisted across session reloads and session tree nodes
- If a bound window has a completely blank tab, the extension binds to that tab; if the tab is dirty, then it provisions a new tab and binds to that
- Deterministically reconciles the session tree node's bound tab, and can restore the tab already associated with that node or provision a new safe tab when needed
- User-driven binding via `/rp bind` (windows) or `/rp tab` (tabs); agents can use `rp({ bind: ... })`
- In addition to window bindings, tab bindings and auto-selected read-files context is stored and automatically recovered across node rewinds via `/tree`, different sessions (e.g., created via `/fork`), and resumed sessions

Forked sessions inherit the parent session-plus-node's window, tab, and auto-selected context snapshot at the fork point (unless you rewind in the forked session and switch window/tab/etc.), then can diverge independently as later reads or manual tab switches are performed in the child session.  Binding is non-invasive, in that it doesn't change RepoPrompt's globally active window, and automatic tab provisioning uses background tabs (`focus=false`) without stealing UI focus.  This is to prevent interference when multiple agents (or your manual usage of RepoPrompt in parallel to a Pi session) are using this extension and need to target different windows or tabs simultaneously.

### Output rendering

- Syntax highlighting for code blocks and codemaps in `read_file`, and for code blocks in outputs of `apply_edits`, `file_actions create/delete`, and `git`
- Common non-mutating RepoPrompt actions (`read_file`, `file_search`, `get_file_tree`, `get_code_structure`, `workspace_context`, routing helpers like `manage_workspaces`, and control/discovery actions like `windows`/`bind`/`status`/`search`/`describe`) get concise request-driven call/result summaries in collapsed mode.  The call line carries intent while the result line carries outcome, so the transcript stays compact without echoing the same label twice.  These summaries are derived from the arguments Pi sent, not by parsing RepoPrompt's prose output, and unknown tools fall back to normal collapsed rendering
<img width="270" height="936" alt="Image" src="https://github.com/user-attachments/assets/142ca6c2-c1cf-4f0b-b41b-3d52d623c78c" />
- RepoPrompt `apply_edits` calls are forwarded with `verbose: true` by default (unless `raw: true`), while the returned diff is normalized into `details.diff` and presented to the agent as a terse summary.  The same is done for `file_actions create/delete` outputs, so you see all edited/created/deleted LOC with rich rendering but the extension prevents the context window from getting bloated by round-tripping tool I/O tokens
- Adaptive diff rendering for RepoPrompt `git` and `apply_edits` outputs by default (`diffViewMode: "auto"` picks split, unified, compact, or summary at render time based on pane width).  This uses the active Pi theme’s `toolDiffAdded`, `toolDiffRemoved`, and `toolDiffContext` colors (typically mapped to chosen hues for green and red), and its visual design and rendering logic are indebted to [MasuRii/pi-tool-display](https://github.com/MasuRii/pi-tool-display).  Two different examples at different pane widths:
<img width="1027" height="256" alt="horizontal" src="https://github.com/user-attachments/assets/31943d5b-475c-4254-813b-18bf9bd79d60" />
<img width="629" height="302" alt="vertical" src="https://github.com/user-attachments/assets/fe4fc253-6bda-49e3-a37e-918244eb9e05" />
- Generic fenced diff blocks, and adaptive-diff parse failures, fall back to a simpler diff renderer, which uses `delta` if installed or otherwise the built-in highlighter
- Markdown-aware styling for headings and lists

### Safety checks

- Delete operations are blocked unless you pass `allowDelete: true`
- Optional edit confirmation gate for edit-like operations (`confirmEdits`)
- Warn on in-place workspace switches (when applicable)

## Requirements

- RepoPrompt MCP server configured and reachable (stdio transport)
  - If the server is not configured/auto-detected, the extension will still load, but `rp(...)` will error until you configure it
- `rp-cli` available in `PATH` is recommended (used as a fallback for window discovery)

### Compatibility notes

This extension tries to be tolerant of **tool name prefixing** (e.g. `RepoPrompt_list_windows` vs `list_windows`), but it is still dependent on a small set of capabilities and their semantics remaining reasonably stable across RepoPrompt versions:

- **Window discovery**: `list_windows`
  - If `list_windows` is not exposed by the MCP server, the extension falls back to `rp-cli -e 'windows'`
  - If neither is available, window listing/binding features will be limited
- **Workspace root discovery (auto-bind by cwd)**: `get_file_tree` with `{ type: "roots" }` (scoped by `_windowID`)
  - If unavailable (or if parameters/semantics change), auto-binding may be disabled or less accurate
- Selection summary: `manage_selection` with `{ op: "get", view: "files" }` and `{ op: "get", view: "summary" }`
  - If these are unavailable (or if parameters/semantics change), the status output may omit file/token counts

If RepoPrompt renames/removes these tools or changes their required parameters/output formats, this extension may need updates

## Installation

1. Copy this extension into Pi’s extensions directory:
   - `~/.pi/agent/extensions/repoprompt-mcp/`

2. Install dependencies:

   ```bash
   cd ~/.pi/agent/extensions/repoprompt-mcp
   npm install
   ```

   This extension is loaded from `./src/index.ts` via Pi's TypeScript loader, so a build step is not required for normal usage.

   Optional (useful for running tests or publishing):

   ```bash
   npm run build
   ```

3. Configure the RepoPrompt MCP server (if not auto-detected):

   Create `~/.pi/agent/extensions/repoprompt-mcp.json`:

   ```json
   {
     "command": "/Applications/Repo Prompt.app/Contents/MacOS/repoprompt-mcp",
     "args": []
   }
   ```

   Or add to `~/.pi/agent/mcp.json`:

   ```json
   {
     "mcpServers": {
       "RepoPrompt": {
         "command": "/Applications/Repo Prompt.app/Contents/MacOS/repoprompt-mcp"
       }
     }
   }
   ```

4. If you already connect to RepoPrompt through another extension (e.g. a generic MCP adapter), avoid double-connecting.

## Usage

### Commands

- `/rp status` — show status (connection + binding), including the currently bound tab name and a label like `[bound, in-focus]` or `[bound, out-of-focus]`, plus current selected file counts and estimated token counts

<p align="center">
  <img width="210" alt="status" src="https://github.com/user-attachments/assets/bd59af9e-7df1-4572-8baf-edb6f8f7a0df" />
</p>

- `/rp windows` — list available RepoPrompt windows

<p align="center">
  <img width="200" alt="windows" src="https://github.com/user-attachments/assets/38510cff-4aa2-4250-83b0-fe7d5daa101d" />
</p>

- `/rp bind` — interactive workflow for choosing the RepoPrompt window

<p align="center">
  <img width="250" alt="bind popup" src="https://github.com/user-attachments/assets/2aa712ba-f989-4e22-97c3-a595f40a087a" />
</p>

- `/rp bind <id> [tab]` — direct option if you already know the target window id (and optionally an exact tab name or tab id); when `[tab]` is omitted, the extension restores the branch's tab for that window or provisions a fresh background tab once
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
  "diffViewMode": "auto",
  "diffSplitMinWidth": 120,
  "suppressHostDisconnectedLog": true
}
```

`collapsedMaxLines` controls how many rendered lines of RepoPrompt tool output Pi shows before the result is expanded for the generic fallback path.  In addition, the extension now emits hand-authored one-line or two-line collapsed summaries for common non-mutating actions like `read_file`, `file_search`, `get_file_tree`, `get_code_structure`, `workspace_context`, `windows`, `bind`, and `status`; these are derived from Pi's own request metadata rather than RepoPrompt's returned prose.  Unknown or unsupported tools still fall back to the normal `collapsedMaxLines` behavior.  LOC-changing operations are the other exception: verbose RepoPrompt `apply_edits` and rendered `file_actions create/delete` results ignore `collapsedMaxLines` once normalized into `details.diff`, so the full rendered code changes remain visible.

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
| `autoSelectReadSlices` | `true` | Automatically track `read_file` calls by adding slices/full-file selection via `manage_selection`, so `chat_send` (or a manually created chat in the RP app) uses everything the agent has read as context; these file/slice selections are **branch-safe** across `/tree` rewinds and `/fork`ed session branches via extension-owned snapshot replay |
| `oracleDefaultMode` | `"chat"` | Default mode for `/rp oracle` when `--mode` is omitted (`chat`, `plan`, `edit`, or `review`) |
| `collapsedMaxLines` | `3` | Lines shown in collapsed view |
| `diffViewMode` | `"auto"` | Diff layout for RepoPrompt `git` / `apply_edits` fenced diff output (`auto`, `split`, `unified`) |
| `diffSplitMinWidth` | `120` | Minimum render width before `diffViewMode: "auto"` uses split diff layout |
| `suppressHostDisconnectedLog` | `true` | Filter noisy stderr from macOS `repoprompt-mcp` (disconnect/retry bootstrap logs) |

Automatic tab restoration and provisioning is driven by `autoBindOnStart` and `persistBinding`; there is no separate tab-only configuration surface. Adaptive diff layout applies only to RepoPrompt `git` and `apply_edits` outputs that arrive as fenced `diff` blocks; other rendered output stays on the existing text-based path.

Note: when `readcacheReadFile` is enabled, the extension may persist UTF-8 file snapshots to an on-disk content-addressed store under
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
If the RepoPrompt MCP server stops responding (for example, if the RepoPrompt app is closed while Pi stays open), tool calls may time out. When that happens, the extension will drop the connection and you can recover with `/rp reconnect`.

### "No matching window found"
- Your `cwd` may not match any RepoPrompt workspace root
- Use `/rp windows` to list windows
- Use `/rp bind` to pick one

### Window listing doesn’t work
- If the MCP server does not expose a `list_windows` tool, this extension uses `rp-cli -e 'windows'`
- Make sure `rp-cli` is installed and on your `PATH`
- If RepoPrompt is in single-window mode, `rp-cli -e 'windows'` may report single-window mode

### Delete operation blocked
- Pass `allowDelete: true` on the `rp` call

## License

MIT
