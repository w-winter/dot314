# RepoPrompt CLI bridge for Pi (`pi-repoprompt-cli`)

Integrates RepoPrompt with Pi via RepoPrompt's `rp-cli` executable.

Provides two tools:
- `rp_bind` — bind a RepoPrompt window + compose tab (routing)
- `rp_exec` — run `rp-cli -e <cmd>` against that binding (quiet defaults + output truncation)

Optional:
- Diff blocks in `rp_exec` output use `delta` when installed (honoring the user's global git/delta color config), with graceful fallback otherwise
- [Gurpartap/pi-readcache](https://github.com/Gurpartap/pi-readcache)-like caching for `rp_exec` calls that read files (`read` / `cat` / `read_file`) to save on tokens
  - returns unchanged markers and diffs on repeat reads
- Auto-selection (in the RP app, e.g. for use in RP Chat) of slices/files the agent has read; these selections are also branch-safe across `/tree` navigation and `/fork`ed session

Also provides convenience commands:
- `/rpbind <window_id> <tab>`
- `/rpcli-readcache-status`
- `/rpcli-readcache-refresh <path> [start-end]`

## Install

From npm:

```bash
pi install npm:pi-repoprompt-cli
```

From the dot314 git bundle (filtered install):

Add to `~/.pi/agent/settings.json` (or replace an existing unfiltered `git:github.com/w-winter/dot314` entry):

```json
{
  "packages": [
    {
      "source": "git:github.com/w-winter/dot314",
      "extensions": ["extensions/repoprompt-cli/index.ts"],
      "skills": [],
      "themes": [],
      "prompts": []
    }
  ]
}
```

## Requirements

- `rp-cli` must be installed and available on `PATH`

## Configuration

Enable readcache (optional):

Create `~/.pi/agent/extensions/repoprompt-cli/config.json`:

```json
{
  "readcacheReadFile": true,
  "autoSelectReadSlices": true
}
```

## Quick start

1) Find your RepoPrompt window + tab (from a terminal):

```bash
rp-cli -e windows
rp-cli -e "workspace tabs"
```

2) Bind inside Pi:

```text
/rpbind 3 Compose
```

3) Instruct the agent to use RepoPrompt via the `rp_exec` tool, for example:

```text
Use rp_exec with cmd: "get_file_tree type=files max_depth=4".
```

If `readcacheReadFile` is enabled, repeat reads can be token-optimized:

```text
Use rp_exec with cmd: "read path=src/main.ts start_line=1 limit=120".
```

To force baseline output for a specific read:

```text
Use rp_exec with cmd: "read path=src/main.ts start_line=1 limit=120 bypass_cache=true".
```

Notes:
- Readcache only triggers for **single-command** reads. Compound commands (`&&`, `;`, `|`) fail open to baseline output
- When `just-bash` AST parsing is unavailable, caching only applies to unquoted/unescaped single-command reads; quoted/escaped forms fail open
- `rawJson=true` disables caching
- Read-driven selection replay is enabled by default (`autoSelectReadSlices: true`); set it to `false` to disable
- Manual selection is always preserved for paths not managed by this feature; for managed paths, branch replay may restore the branch snapshot

## Readcache gotchas

- `rawJson=true` disables readcache. Don't use unless debugging
- Need full content? rerun with `bypass_cache=true`
- Single-command reads only (no `&&` / `;` / `|`)
- Multi-root: use absolute or specific relative paths

## Safety behavior (by default)

- Blocks delete-like commands unless `allowDelete: true`
- Blocks in-place workspace switching unless `allowWorkspaceSwitchInPlace: true`
- Blocks non-trivial commands when unbound (to avoid operating on the wrong window/tab)
- Treats "0 edits applied" as an error by default (`failOnNoopEdits: true`)
