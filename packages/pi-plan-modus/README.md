# Plan Modus for Pi (`pi-plan-modus`)

Read-only exploration sandbox for Pi with RepoPrompt-aware write blocking. When enabled, the agent can only use read-only tools — native file tools, bash commands, and RepoPrompt operations (both MCP and CLI) are all restricted to safe, non-mutating access.

Designed to be compatible with the [pi-repoprompt-mcp](https://www.npmjs.com/package/pi-repoprompt-mcp) and [pi-repoprompt-cli](https://www.npmjs.com/package/pi-repoprompt-cli) extensions. When any of these are active, plan mode blocks their write-capable operations (`apply_edits`, `file_actions`, file create/delete/move) while keeping read operations available.

Based on the [plan-mode example](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/examples/extensions/plan-mode) from pi-mono, with additions for RepoPrompt integration and bash AST analysis.

## Install

From npm:

```bash
pi install npm:pi-plan-modus
```

From the dot314 git bundle (filtered install):

```json
{
  "packages": [
    {
      "source": "git:github.com/w-winter/dot314",
      "extensions": ["extensions/plan-mode.ts"],
      "skills": [],
      "themes": [],
      "prompts": []
    }
  ]
}
```

## Usage

- Command: `/plan`
- Shortcut: `Ctrl+Alt+P` (macOS: `Ctrl+Option+P`)
- CLI flag: `pi --plan` to start in plan mode

## What gets blocked

| Layer | Blocked operations |
|---|---|
| Native tools | `edit`, `write` |
| Bash | Destructive commands (rm, mv, cp, mkdir, git commit, ...), write redirects (`>`, `>>`), editors (vim, nano, code) |
| RepoPrompt MCP (`rp`) | `apply_edits`, `file_actions` |
| RepoPrompt CLI (`rp_exec`, `rp-cli`) | `edit`, `file create/delete/move`, interactive REPL (`-i`) |

Read-only operations remain available across all layers: `read_file`, `get_file_tree`, `file_search`, `get_code_structure`, `git status/log/diff/show`, etc.

## Bash command analysis

Uses [just-bash](https://www.npmjs.com/package/just-bash) AST parsing (v2+) for accurate command inspection, including nested command substitutions, pipelines, conditionals, and wrapper commands (`sudo`, `env`, `command`). Falls back to regex matching if the parser is unavailable.

## State persistence

Plan mode state is persisted per-branch via session entries and restored on session start, switch, tree navigation, and fork.
