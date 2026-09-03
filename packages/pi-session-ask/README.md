# Session Ask for Pi (`pi-session-ask`)

Ask questions about a Pi session JSONL file (including pre-compaction history) without loading that history into your current model context.

Provides:
- `session_ask({ question, sessionPath? })`
- `session_lineage({ sessionPath?, maxDepth? })`
- Slash command wrapper: `/session-ask ...`

## Install

From npm:

```bash
pi install npm:pi-session-ask
```

From the dot314 git bundle (filtered install):

Add to `~/.pi/agent/settings.json` (or replace an existing unfiltered `git:github.com/w-winter/dot314` entry):

```json
{
  "packages": [
    {
      "source": "git:github.com/w-winter/dot314",
      "extensions": ["extensions/session-ask/index.ts"],
      "skills": [],
      "themes": [],
      "prompts": []
    }
  ]
}
```

## Code and Notebook modes

[pi-codex-conversion](https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/main/packages/pi-codex-conversion) exposes both tools inside `exec` when Code or Notebook Mode is active:

```javascript
const lineage = await tools.session_lineage({ maxDepth: 50 });
const answer = await tools.session_ask({ question: "What did we decide about X?" });
```

`pi-codex-conversion` is optional. Both tools remain available as ordinary top-level Pi tools.

## Notes

- If the *agent* invokes the `session_ask(...)` tool, the model sees the tool output in that turn
- If you run the `/session-ask ...` command yourself, the output is shown to you but is not kept in the agent's context; copy/paste relevant parts if you want the agent to use them in follow-ups

