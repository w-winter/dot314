# pi-claude-bridge

A Pi provider that uses a logged-in Claude Code account through the Claude Agent SDK. You keep Pi's terminal interface and tools while Claude Code handles model requests.

Requires Pi 0.86.0 or later.

This is a fork of the bridge in [w-winter/dot314](https://github.com/w-winter/dot314/tree/main/extensions/pi-claude-bridge), which forks [vanillagreen's `@vanillagreen/pi-claude-bridge`](https://github.com/vanillagreencom/kendex/tree/main/pi-extensions/pi-claude-bridge), itself a fork of [Eli Dickinson's `pi-claude-bridge`](https://github.com/elidickinson/pi-claude-bridge). See [Differences from upstream](#differences-from-upstream) for what it adds.

## How it works

Pi keeps the terminal, the tools and the conversation history. Claude Code does the thinking. The bridge sits between them as a Pi model provider: it turns each Pi model request into a Claude Code query, and turns Claude Code's reply back into Pi's text, thinking and tool calls.

### The pieces

```
┌─ Pi ──────────────────────────────────────────────────────────────────┐
│                                                                       │
│   Pi's agent loop                  ┌────────────────────────────────┐ │
│   (TUI, tools, history)            │ pi-claude-bridge               │ │
│                                    │ a Pi model provider            │ │
│        model request ─────────────►│                                │ │
│                                    │ · builds the system prompt     │ │
│        text, tool calls ◄──────────│ · pairs each Pi session with   │ │
│                                    │   a Claude Code session        │ │
│                                    │ · offers Pi's tools to Claude  │ │
│                                    │   Code over MCP                │ │
│                                    └───────────────┬────────────────┘ │
└────────────────────────────────────────────────────┼──────────────────┘
                                                     │ Claude Agent SDK
┌─ claude  (Claude Code, a child process) ───────────▼──────────────────┐
│  signed in with your Claude account · its built-in tools are off      │
│  sees Pi's tools as mcp__custom-tools__read, …__bash, …               │
│  keeps its transcript under ~/.claude/projects/                       │
└────────────────────────────────────────────────────┬──────────────────┘
                                                     ▼
                                               Anthropic API
```

### One turn, with a tool call

```
                  Pi                      bridge                 Claude Code
                  │                         │                         │
 your prompt      ├── prompt ──────────────►│                         │
                  │                         ├── start or resume ─────►│
                  │◄── text, thinking ──────┤◄── streamed reply ──────┤
                  │◄── tool call: bash ─────┤◄── MCP call: bash ──────┤ waits
 Pi runs bash     │                         │                         │   ⋮
 (you may steer)  │                         │                         │   ⋮
                  ├── result (+ steer) ────►├── steer, then result ──►│ goes on
                  │◄── final text ──────────┤◄── rest of the reply ───┤
 reply done       │                         │                         │
```

One Claude Code query spans the whole turn. While Pi runs a tool, Claude Code is waiting on that MCP call, so nothing restarts between tool calls. A steering message you send meanwhile goes into the same query just before the tool result, and Claude's very next response sees both.

### How Pi's tools reach Claude

Claude Code's own tools (its Bash, Read, Edit, web tools and so on) are turned off. Claude sees only the tools active in Pi, which the bridge serves from an MCP server named `custom-tools` inside the Pi process. Pi runs every call, so Claude Code never reads or writes your files itself.

```
 Pi tool             served to Claude as                              back in Pi
 ─────────────────   ──────────────────────────────────────────────   ──────────────
 read                mcp__custom-tools__read                          read
 my_tool             mcp__custom-tools__my_tool                       my_tool
 web/fetch page      mcp__custom-tools__web_fetch_page_1a2b3c4d       web/fetch page
                                         └─ unsafe characters → "_", plus a hash
```

- **Names.** A tool whose name uses only letters, digits, `_` and `-`, and fits the API's 128-character limit for the full name, keeps its name. Any other name is served as a cleaned-up, shortened spelling plus an 8-character hash of the original, because Claude Code would rewrite it and the call could never be traced back. Each call maps back to the exact Pi name. A tool keeps its served name for the whole query.
- **Arguments.** Claude sees each tool's own JSON Schema, not a simplified copy. Pi checks the arguments, and a check failure goes back to Claude as the tool result. Argument names Claude Code habitually uses are mapped to Pi's (`file_path` becomes `path`, `old_string`/`new_string` become `oldText`/`newText`), and `bash` gets a 120-second timeout when Claude gives none.
- **Results.** Claude Code tags every call with its tool_use id, and the bridge answers each call with that call's result only. A call whose arguments were cut off mid-stream is never run.
- **Tools that change mid-turn.** When an extension turns tools on or off during a tool call, the served list changes with it. The tool result is held until Claude Code has re-read the list (at most 2 seconds), so Claude's next request already sees the new tools. A tool that is turned off disappears from the list but still answers a call Claude made before.
- **Slow tools.** Claude Code's per-call timeout and its moving of long calls to the background are both off for Pi's tools. A Pi tool runs until it finishes, you abort it, or its own timeout fires.
- **Tools Claude Code runs itself.** With connectors on, claude.ai connector tools (`mcp__claude_ai_*`) run inside Claude Code. They are not shown as Pi tool calls and are never offered twice under the `custom-tools` prefix. Each connector call is recorded in the Pi session as an audit entry.

### The next turn: resume or rebuild

```
                          your next prompt
                                 │
                                 ▼
          does Claude Code's copy of the conversation still
          match Pi's history?   (checked with a digest)
                                 │
              ┌────── yes ───────┴─────── no ───────┐
              ▼                                     ▼
   ┌──────────────────────┐        ┌───────────────────────────────┐
   │ RESUME               │        │ REBUILD                       │
   │ send only the new    │        │ write Pi's history out as a   │
   │ messages; the prompt │        │ Claude Code transcript, then  │
   │ cache stays warm     │        │ resume from it                │
   └──────────────────────┘        └───────────────────────────────┘
                                    e.g. after /compact or /tree, or
                                    when another model took turns
```

The bridge saves which Claude Code session belongs to the Pi session in the Pi session file, so reopening a Pi session resumes the same Claude Code conversation. When Pi compacts or rewrites the history during a Pi tool call, the bridge restarts from Pi's new history with the completed tool results. A query that used one of Claude Code's own connectors finishes first, and the next turn uses Pi's new history.

## Install

Let Pi clone the repository and install its dependencies:

```bash
pi install git:github.com/nicobailon/pi-claude-bridge
```

To work on the bridge, clone it, run `npm install`, and add the folder's path to `packages` in `~/.pi/agent/settings.json`. Pi loads `src/index.ts` directly, so `/reload` picks up edits. To load it for one run, use `pi -e ./src/index.ts`.

A Claude Code login is required. Make `claude` available on `PATH` or set its executable path below.

Set `systemPrompt.replacement` in `claude-bridge.json` (see [Settings](#settings)) before the first request. Without it, the bridge refuses Pi's default main prompt.

Claude Sonnet 5.5 (`pi-claude/claude-sonnet-5-5`) requires [Claude Code 2.1.284 or later](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#21284). Claude Opus 5.5 (`pi-claude/claude-opus-5-5`) requires [Claude Code 2.1.280 or later](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#21280). Fable 5.1 requires [Claude Code 2.1.255 or later](https://code.claude.com/docs/en/model-config#work-with-fable). These requirements apply to an executable chosen through `provider.pathToClaudeCodeExecutable` or found on `PATH`, which takes precedence over the SDK's bundled CLI. Account access and usage-credit requirements still apply.

## Features

- Select Claude models from Pi's model menu, including `pi-claude/claude-opus-5-5` and `pi-claude/claude-fable-5-1`.
- Run Pi tool calls during Claude conversations.
- Steer Claude while a Pi tool runs.
- Resume the Claude conversation across Pi turns.
- Configure model effort and forwarded prompt context.
- Optionally use the Claude account's connectors.

## Settings

The bridge reads `claude-bridge.json` from `~/.pi/agent` and from a trusted project's `.pi/` directory. `PI_CODING_AGENT_DIR` changes the user directory. Run `/pi-claude` to show the provider's current status.

The bridge's `systemPrompt` configuration is independent of `anthropic-oauth-compat`, which continues to read `anthropicOAuthCompat` from `settings.json`.

- `enabled`: register the `pi-claude/*` models; reload required.
- `systemPrompt.replacement`: replace Pi's default base instructions in Pi's main agent prompt while retaining Pi's rules and guidelines (Pi's own rules, the selected tools' guidelines and extensions' `promptGuidelines`) and Pi-managed project context and skills. Pi's opening sentence, tool list and documentation pointers are dropped; Claude gets the tools as MCP definitions. When the session supplies its own base (`SYSTEM.md`, `--system-prompt`, an SDK `systemPrompt`, or a pi-subagents agent with `systemPromptMode: replace`), that base is kept: Claude receives the replacement, a blank line, then the complete prompt Pi built. Pi's default base is recognized by its fixed opening sentence ("You are an expert coding assistant operating inside pi, …"); a `before_agent_start` prompt that does not open with it is kept whole the same way. Other system prompts reach Claude unchanged, whatever they contain, including those of Pi's compaction and branch summaries and extensions' own model calls.
- `systemPrompt.includeModelLine`: prepend `Active model: provider/modelId` to the replacement.
- `systemPrompt.preservePiContext`: retain Pi-managed context after the replacement; defaults to `true`. `false` sends only the replacement in place of Pi's main agent prompt when that prompt has Pi's default base. A session's own base is never dropped, so with `false` it still arrives after the replacement together with its context.
- `provider.fastMode`, `provider.pathToClaudeCodeExecutable`: control how the Claude Code subprocess is launched.
- `provider.forceEffort`, `provider.modelEffortOverrides`: pin a Claude effort for every request or per model. Override keys are bare ids (`claude-opus-4-8`), `pi-claude/<id>` or `*`; values are `low`, `medium`, `high`, `xhigh` or `max`; a per-model entry beats the global force.
- `provider.settingSources`: explicitly load selected filesystem settings from Claude Code. By default, no settings load when connectors are disabled. When connectors are enabled, the bridge loads the user's settings.
- `provider.inheritAnthropicEnv`: `true` passes `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from the environment to Claude Code, for an intentional gateway or API-key setup. By default the bridge removes them, so an exported variable cannot route subscription requests through another endpoint or credential, and it does not count them as credentials when deciding whether the provider is connected. Only the user `claude-bridge.json` can set it, and managed account profiles never inherit these variables.
- `incidents.repo`: a GitHub `owner/name` that bridge incidents belong to. Setting it lets the bridge write its incidents to `claude-bridge-incidents.jsonl` in the Pi agent directory (metadata only, mode 0600), and lets the agent file an incident with the `claude_bridge_incident` tool. The bridge never files one on its own. The agent files an incident when it looks like a bridge bug, as an issue in that repository with the `gh` CLI (which must be installed and logged in), or as a comment on the open issue already filed for it. The issue carries only the evidence the bridge recorded: ids, versions, the model, counts, labels, the order of events and the diag metadata. Nothing the agent writes is published; it tells you the issue number and gives you its own analysis in the chat. Only the user `claude-bridge.json` can set it; a project's value is ignored, and a value that is not `owner/name` is dropped. Unset, nothing about incidents is written to disk or filed; the tool still lists and shows incidents, and refuses to file.

Without a `systemPrompt.replacement`, Pi's default main prompt is refused with a Pi error, and no Claude request is made. Its documentation section names both `docs/custom-provider.md` and `docs/packages.md`. Anthropic treats a subscription request whose system prompt contains both as a third-party app: it is billed to Extra Usage, or rejected with HTTP 400 when the account has no Extra Usage credit. The bridge refuses any request whose system prompt contains both paths. That covers pi-subagents children in append mode and extension calls that copy Pi's full system prompt. A replacement drops Pi's documentation section from the main prompt.

Example `claude-bridge.json`:

```json
{
  "systemPrompt": {
    "replacement": "You are Claude Code, Anthropic's official CLI for Claude.",
    "includeModelLine": true,
    "preservePiContext": true
  }
}
```

Environment variables:

- `CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT` (default 90s): how long Claude Code may stay silent during a turn, before or after its first output, while no Pi tool call is outstanding; bare numbers are seconds, `ms`, `s` and `m` suffixes are accepted, `0` disables.
- `CLAUDE_BRIDGE_DEBUG=1`: write the bridge log, the integrity diagnostics and per-query Claude Code CLI logs under the Pi agent directory; `CLAUDE_BRIDGE_DEBUG_PATH` and `CLAUDE_BRIDGE_DIAG_PATH` move the two log files. Without it, only the incidents file of `incidents.repo` is ever written.

Tool-result integrity problems always surface as a Pi error notification plus a metadata-only `claude-bridge-integrity` entry in the Pi session file, so a lost tool result can be analysed from the session alone.

Every anomaly the bridge detects becomes an incident with a short id such as `bi-7f3a`. An error text the bridge writes for Claude or Pi ends with ` (incident bi-7f3a)`. `/pi-claude incidents` lists this process's incidents, and `/pi-claude incidents <id>` shows one with its versions, metadata and the event order that led to it. When a session's requests hit an incident where the bridge showed an error or had to recover, the agent is told once per kind of incident, in one short message that goes with your next prompt, and can inspect it with the `claude_bridge_incident` tool. Plain API errors and normal cleanup are not reported to it.

Maintainer notes and the test suites are in [DEVELOPMENT.md](DEVELOPMENT.md).

## Differences from upstream

Upstream here is the bridge in dot314, whose changes this fork merges. Everything below is what this fork does and dot314's bridge does not.

**Tool calls**
- Each MCP tool call is claimed by the tool_use id Claude Code tags it with, so a call can never receive another call's result, including across Claude Code's stream retries.
- A tool call cut off mid-stream no longer ends Pi's turn with nothing to run: Claude Code's re-issued call runs in the same turn. A call whose arguments never finished is never executed.
- A stalled stream attempt is replaced by Claude Code's retry instead of mixing into it.
- Every Pi tool is served under a name Claude can call, with its real JSON Schema, and tools an extension activates mid-turn are served too.
- Claude Code does not background or give up on a slow Pi tool call.

**Keeping Claude's session in sync with Pi**
- Before reusing Claude's session, the bridge checks with a digest that it still matches Pi's history, and rebuilds it when Pi rewrote history Claude already holds.
- A rebuild replays redacted thinking correctly, and imports a latest Claude turn whose thinking cannot be replayed as a note of what it said and did.
- Claude Code never resumes a rebuilt session as an interrupted turn, so no "Continue from where you left off." prompt is injected.

**System prompt**
- A system prompt that Anthropic would bill as a third-party app (one naming both `docs/custom-provider.md` and `docs/packages.md`) is refused before any request is sent (see Settings).
- Under a `systemPrompt.replacement`, Pi's rules and guidelines are kept, and so is a session's own base prompt (`SYSTEM.md`, `--system-prompt`, a pi-subagents agent in replace mode).

**Models**
- Pi's thinking level "off" sends Claude Code disabled thinking; for models that reject it, the option is hidden.
- Opus 5.5 falls back to Opus 4.8 when its safety classifier declines, and every model switch Claude Code makes for safety reasons is announced.

**Incidents**
- Every anomaly the bridge detects becomes an incident with an id. The agent is told about new ones with your next prompt, and can inspect or file them with the `claude_bridge_incident` tool (see Settings).

**Operation**
- Pi loads the TypeScript source directly; there is no bundle to rebuild, and `/reload` picks up edits. CI runs the typecheck and unit tests on every push.
- Claude Code children do not inherit `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` unless `provider.inheritAnthropicEnv` is set.
- The debug log rotates, and old Claude Code CLI logs are pruned.

The Claude Agent SDK may prepend its own identity text to the system prompt.

## Connectors

Connectors are disabled by default. Set `provider.enableConnectors` in the user `claude-bridge.json`, or set the `CLAUDE_BRIDGE_ENABLE_CONNECTORS` environment variable. Project configuration cannot enable them.

Connector access is read-only by default. For a dedicated process running an approved write, set `CLAUDE_BRIDGE_CONNECTOR_WRITE=allow`; keep `allow` out of persistent `provider.connectorWriteMode` configuration. Use `/pi-claude:connectors` to list the account's connectors.

With connectors enabled, Claude Code loads user settings. An explicit `provider.settingSources` list in `claude-bridge.json` changes that selection. Including project or local settings lets those files affect the subprocess.
