# RepoPrompt CLI bridge for Pi (`pi-repoprompt-cli`)

Integrates RepoPrompt with Pi via RepoPrompt's `rp-cli` executable.

Provides two tools:
- `rp_bind` — bind a RepoPrompt window + compose tab (routing)
- `rp_exec` — run `rp-cli -e <cmd>` against that binding (quiet defaults + output truncation)

Also provides a convenience command:
- `/rpbind <window_id> <tab>`

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
      "extensions": ["extensions/repoprompt-cli.ts"],
      "skills": [],
      "themes": [],
      "prompts": []
    }
  ]
}
```

## Requirements

- `rp-cli` must be installed and available on `PATH`

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

## Safety behavior (by default)

- Blocks delete-like commands unless `allowDelete: true`
- Blocks in-place workspace switching unless `allowWorkspaceSwitchInPlace: true`
- Blocks non-trivial commands when unbound (to avoid operating on the wrong window/tab)
- Treats "0 edits applied" as an error by default (`failOnNoopEdits: true`)
