# RepoPrompt MCP integration for Pi

This extension provides a single tool (`rp`) that exposes RepoPrompt MCP tools to Pi (using the token-efficient proxy pattern of [nicobailon's pi-mcp-adapter](https://github.com/nicobailon/)), adds window binding (auto-detect by `cwd`, persist/restore, and interactive selection), renders RepoPrompt tool outputs (syntax + diff highlighting), and applies guardrails for destructive operations.

## Features

### Window binding

- Auto-bind to the RepoPrompt window that matches `process.cwd()` (by workspace roots)
- If multiple windows match, prompt you to pick one (interactive mode):
- Persist binding across Pi session reloads (optional)
- Manual binding via `/rp bind` or `rp({ bind: ... })`

Binding is **non-invasive**: it does not change RepoPrompt’s globally active window. This matters when multiple clients (or you manually using RepoPrompt) share the same RepoPrompt instance and need to target different workspaces/windows without interference. Tool calls are scoped by injecting `_windowID` / `_tabID`.

### Output rendering

- Syntax highlighting for read files' code blocks and for codemaps
- Diff highlighting for diff blocks
- Markdown-aware styling for headings and lists
- Collapsed output by default (expand using Pi’s standard UI controls)

### Safety checks

- Delete operations are blocked unless you pass `allowDelete: true`
- Optional edit confirmation gate for edit-like operations (`confirmEdits`)
- Warn on in-place workspace switches (when applicable)

## Requirements

- RepoPrompt MCP server configured and reachable (stdio transport)
- `rp-cli` available in `PATH` is recommended (used as a fallback for window discovery)

### Compatibility notes (capability assumptions)

This extension tries to be tolerant of **tool name prefixing** (e.g. `RepoPrompt_list_windows` vs `list_windows`), but it is still dependent on a small set of “capability” tools and their semantics remaining reasonably stable across RepoPrompt versions:

- **Window discovery**: `list_windows`
  - If `list_windows` is not exposed by the MCP server, the extension falls back to `rp-cli -e 'windows'`
  - If neither is available, window listing/binding features will be limited
- **Workspace root discovery (auto-bind by cwd)**: `get_file_tree` with `{ type: "roots" }` (scoped by `_windowID`)
  - If unavailable (or if parameters/semantics change), auto-binding may be disabled or less accurate
- **Selection summary (optional status enrichment)**: `manage_selection` with `{ op: "get", view: "summary" }`
  - If unavailable (or if parameters/semantics change), the status output will omit file/token counts

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

- `/rp status` — show status (connection + binding)

<p align="center">
  <img width="120" alt="status" src="https://github.com/user-attachments/assets/b44caebd-a514-4e81-9761-fe2fd32cd557" />
</p>

- `/rp windows` — list available RepoPrompt windows

<p align="center">
  <img width="200" alt="windows" src="https://github.com/user-attachments/assets/38510cff-4aa2-4250-83b0-fe7d5daa101d" />
</p>

- `/rp bind` — pick a window to bind (interactive)

<p align="center">
  <img width="250" alt="bind popup" src="https://github.com/user-attachments/assets/2aa712ba-f989-4e22-97c3-a595f40a087a" />
</p>

- `/rp bind <id> [tab]` — bind directly
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

  "collapsedMaxLines": 15,
  "suppressHostDisconnectedLog": true
}
```

Options:

| Option | Default | Description |
|---|---:|---|
| `command` | auto-detect | MCP server command |
| `args` | `[]` | MCP server args |
| `env` | unset | Extra environment variables for the MCP server |
| `autoBindOnStart` | `true` | Auto-detect and bind on session start |
| `persistBinding` | `true` | Persist binding in Pi session history |
| `confirmDeletes` | `true` | Block delete operations unless `allowDelete: true` |
| `confirmEdits` | `false` | Block edit-like operations unless `confirmEdits: true` |
| `collapsedMaxLines` | `15` | Lines shown in collapsed view |
| `suppressHostDisconnectedLog` | `true` | Filter noisy stderr from macOS `repoprompt-mcp` (disconnect/retry bootstrap logs) |

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
