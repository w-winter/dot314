# RepoPrompt MCP for Pi (`pi-repoprompt-mcp`)

A token-efficient RepoPrompt MCP integration for Pi.

Exposes a single `rp` tool (RepoPrompt MCP proxy) plus `/rp …` commands, with:
- window/tab binding (auto-detect by `cwd`, optional persistence); these are branch-safe across navigation of the session DAG via `/tree` and across `/fork`ed sessions
- output rendering (syntax + diff highlighting; uses `delta` when installed, honoring the user's global git/delta color config, with graceful fallback)
- safety guardrails (deletes blocked unless explicitly allowed; optional edit confirmation)
- optional [Gurpartap/pi-readcache](https://github.com/Gurpartap/pi-readcache)-like caching for RepoPrompt `read_file` results (unchanged markers + diffs) to save on tokens
- optional auto-selection in the RP UI (e.g. for use in RP Chat) of slices/files the agent has read; these selections are also branch-safe across `/tree` navigation and `/fork`ed session

## Install

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

## Requirements

- RepoPrompt installed
- RepoPrompt MCP server reachable (stdio transport)
  - If the server is not configured/auto-detected, the package will still load, but `rp(...)` will error until you configure it
- `rp-cli` on `PATH` is recommended (used as a fallback for window discovery)

## Usage

Commands:
- `/rp status`
- `/rp windows`
- `/rp bind`
- `/rp reconnect`
- `/rp readcache-status`
- `/rp readcache-refresh <path> [start-end]`

Tool:
```ts
rp({ windows: true })
rp({ bind: { window: 3 } })
rp({ call: "read_file", args: { path: "src/main.ts" } })
```

## Configuration

Create `~/.pi/agent/extensions/repoprompt-mcp.json`:

```json
{
  "autoBindOnStart": true,
  "persistBinding": true,
  "confirmDeletes": true,
  "confirmEdits": false,
  "readcacheReadFile": true,
  "collapsedMaxLines": 3
}
```

`collapsedMaxLines` controls how many lines of RepoPrompt tool output Pi shows in collapsed view before you expand the result. It applies across `rp(...)` calls, so it is the main knob for keeping window listings, reads, and other RepoPrompt responses compact in the TUI. `3` is the best default if you want maximally compressed but still informative output.

If the MCP server is not auto-detected, set `command` explicitly:

```json
{
  "command": "/Applications/Repo Prompt.app/Contents/MacOS/repoprompt-mcp",
  "args": []
}
```

(Alternatively, configure RepoPrompt in `~/.pi/agent/mcp.json`)

For more detail, see: `extensions/repoprompt-mcp/README.md` in the dot314 repo.

## Readcache gotchas

- `raw: true` disables readcache (and rendering). Don't use unless debugging
- Need full content? use `bypass_cache: true` in `read_file` args
- Multi-root: use absolute or specific relative paths (MCP `read_file` has no `RootName:` disambiguation)
