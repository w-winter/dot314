# Session Ask & Session Lineage

A Pi extension that lets the agent or user ask questions about a Pi session JSONL file without loading that history into the current model context.

Defaults to the **current session** (including the full pre-compaction history), but you can target any `.jsonl` session file.

`--path` and `sessionPath` support `~` and `~/...` (expanded to `$HOME`).

It implements a small, isolated subagent loop directly in the extension and has no dependencies on other extensions or libraries.

## Usage (defaults to current session)

### Slash command

```text
/session-ask <question>                                # current session
/session-ask <question> --path /path/to/session.jsonl  # any session file (e.g. find the path in /resume -> Ctrl+P)
```

If you run the `/session-ask ...` slash command yourself, the output is shown to you but filtered from the agent's ongoing context; copy/paste the relevant parts into a normal message if you want the agent to incorporate it in follow-ups

### LLM tools (agent-invocable)

If the extension is enabled, the agent can invoke:

```ts
// Check whether this session is a fork (and get parent session path(s))
session_lineage({ maxDepth: 50 })  // authoritative: do not guess

// Ask about current session (default)
session_ask({ question: "What did we decide about X?" })

// Ask about a parent/other session
session_ask({ question: "...", sessionPath: "/path/to/session.jsonl" })
```

If the agent invokes the `session_ask(...)` tool, they see the tool output in that turn and can use it immediately.

## Fork-awareness

If a session was created by forking (`/branch`, handoff flows, etc.), Pi records `parentSession` in the session header.

When `injectForkHintSystemPrompt` is enabled (default), the extension injects a token-minimal fork note into the agent's system prompt. This is useful if:
- your work often spans multiple forks and you want the model to reliably discover relevant prior context
- you want the model to be nudged toward calling `session_lineage` → `session_ask` rather than guessing

You may want to disable it otherwise.

## How it works

The extension:
1. Determines the session file (default: current session via `ctx.sessionManager.getSessionFile()`)
2. Parses the JSONL and renders a stable, human-readable transcript with entry indices (`[#123] ...`)
3. Runs an isolated model call with internal tools (for best `session_shell` policy enforcement, install `just-bash` >= 2):
   - `session_meta` — session path / id / entry count
   - `session_search` — substring / regex search over the rendered transcript
   - `session_read` — read windows of entries by index
   - `session_shell` — read-only just-bash analysis over virtual files:
     - `/conversation.json` (structured rendered entries)
     - `/transcript.txt` (plain rendered transcript)
     - `/session.meta.json` (session metadata)
4. Returns only the final answer (plus a few citations) to the user

## Configuration

Create `config.json` next to `index.ts` (see `config.json.example`).

Relevant fork-lineage option:
- `injectForkHintSystemPrompt`: inject a minimal fork note into the system prompt so the agent is nudged to use `session_lineage`

Customizing the subagent:

1) Configure models and thinking level directly in `config.json` (`sessionAskModels`, `thinkingLevel`)

2) Point at an agent definition in `~/.pi/agent/agents/` (recommended if you want to tune prompts without touching the ts file):
- `agentName`: loads `~/.pi/agent/agents/<agentName>.md`
- `agentPath`: absolute path, or relative to `~/.pi/agent/agents/`

Agent files can optionally include frontmatter keys like:
- `model: <provider>:<id>` (e.g. `openai-codex:gpt-5.1-codex-mini`)
- `thinking level: medium`

If the agent file is missing/unreadable, the extension falls back to a built-in default system prompt.
