# RepoPrompt tools lock for Pi (`pi-repoprompt-tools-lock`)

Forces the agent to use RepoPrompt tools during repo-scoped work by disabling Pi's native tools `read`, `write`, `edit`, `ls`, `find`, `grep` when RepoPrompt tools are available (through either the `pi-repoprompt-cli` or `pi-repoprompt-mcp` Pi packages/extensions).

## Install

From npm:

```bash
pi install npm:pi-repoprompt-tools-lock
```

From the dot314 git bundle (filtered install):

Add to `~/.pi/agent/settings.json` (or replace an existing unfiltered `git:github.com/w-winter/dot314` entry):

```json
{
  "packages": [
    {
      "source": "git:github.com/w-winter/dot314",
      "extensions": ["extensions/rp-native-tools-lock/index.ts"],
      "skills": [],
      "themes": [],
      "prompts": []
    }
  ]
}
```

## Usage

- Command: `/rp-tools-lock off|auto`
- Shortcut: `Alt+L` (toggles `off` ↔ `auto`)

In `auto` mode, the lock is enforced only when one of these tools is active:
- `rp` (RepoPrompt MCP)
- `rp_exec` (RepoPrompt CLI)

When enforced, the footer shows: `RP 🔒`.

## Configuration (advanced)

Advanced modes can be set via:

- `~/.pi/agent/extensions/rp-native-tools-lock/rp-native-tools-lock.json`

Example:

```json
{ "mode": "rp-mcp" }
```
