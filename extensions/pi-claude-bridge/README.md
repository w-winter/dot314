# pi-claude-bridge

A Pi provider that uses a logged-in Claude Code account through the Claude Agent SDK. You keep Pi's terminal interface and tools while Claude Code handles model requests.

Requires Pi 0.86.0 or later.

This is a fork of [Eli Dickinson's `@vanillagreen/pi-claude-bridge`](https://github.com/vanillagreencom/kendex/tree/main/pi-extensions/pi-claude-bridge).

![Response from Claude through the bridge](assets/bridge-demo.png)

## Install

Pi auto-discovers the bridge when the dot314 checkout is your Pi agent directory. To load it explicitly for one run:

```bash
pi -e ./extensions/pi-claude-bridge/bundle/index.js
```

The committed bundle includes its runtime dependencies. A Claude Code login is required. Make `claude` available on `PATH` or set its executable path below.

Claude Opus 5.5 (`pi-claude/claude-opus-5-5`) requires [Claude Code 2.1.280 or later](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#21280). Fable 5.1 requires [Claude Code 2.1.255 or later](https://code.claude.com/docs/en/model-config#work-with-fable). These requirements apply to an executable chosen through `provider.pathToClaudeCodeExecutable` or found on `PATH`, which takes precedence over the SDK's bundled CLI. Account access and usage-credit requirements still apply.

## Features

- Select Claude models from Pi's model menu.
- Run Pi tool calls during Claude conversations.
- Resume the Claude conversation across Pi turns.
- Configure model effort and forwarded prompt context.
- Optionally use the Claude account's connectors.

## How it works

- You pick one of the `pi-claude` models in Pi's model menu, including `pi-claude/claude-opus-5-5` and `pi-claude/claude-fable-5-1`.
- The bridge starts Claude Code, or resumes it, through the Claude Agent SDK, Anthropic's library for driving Claude Code from another program.
- It sends your prompt to Claude Code and offers it Pi's tools.
- When Claude Code calls a tool, Pi runs the tool and sends the result back to Claude Code.
- Pi shows the reply and remembers which Claude Code conversation it belongs to, so your next message continues it.
- When Pi compacts or changes the conversation history during a Pi tool call, the bridge resumes from Pi's new history with completed tool results. A query that used Claude Code's own connector finishes first; the next turn uses Pi's new history.

## Settings

The bridge reads `claude-bridge.json` from `~/.pi/agent` and from a trusted project's `.pi/` directory. `PI_CODING_AGENT_DIR` changes the user directory. Run `/pi-claude` to show the provider's current status.

The bridge's `systemPrompt` configuration is independent of `anthropic-oauth-compat`, which continues to read `anthropicOAuthCompat` from `settings.json`.

- `enabled`: register the `pi-claude/*` models; reload required.
- `systemPrompt.replacement`: replace Pi's base instructions while retaining Pi-managed project context and skills.
- `systemPrompt.includeModelLine`: prepend `Active model: provider/modelId` to the replacement.
- `systemPrompt.preservePiContext`: retain Pi-managed context after the replacement; defaults to `true`.
- `provider.fastMode`, `provider.pathToClaudeCodeExecutable`: control how the Claude Code subprocess is launched.
- `provider.forceEffort`, `provider.modelEffortOverrides`: pin a Claude effort for every request or per model. Override keys are bare ids (`claude-opus-4-8`), `pi-claude/<id>` or `*`; values are `low`, `medium`, `high`, `xhigh` or `max`; a per-model entry beats the global force.
- `provider.settingSources`: explicitly load selected filesystem settings from Claude Code. By default, no settings load when connectors are disabled. When connectors are enabled, the bridge loads the user's settings.

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

- `CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT`: how long a turn may stay silent before its first output; bare numbers are seconds, `ms`, `s` and `m` suffixes are accepted, `0` disables.
- `CLAUDE_BRIDGE_DEBUG=1`: write the bridge log, the integrity diagnostics and per-query Claude Code CLI logs under the Pi agent directory; `CLAUDE_BRIDGE_DEBUG_PATH` and `CLAUDE_BRIDGE_DIAG_PATH` move the two log files. Nothing is written to disk without it.

Tool-result integrity problems always surface as a Pi error notification plus a metadata-only `claude-bridge-integrity` entry in the Pi session file, so a lost tool result can be analysed from the session alone.

Maintainer notes and the test suites are in [DEVELOPMENT.md](DEVELOPMENT.md).

## Differences from upstream

- Sends Pi's full system prompt, including project instructions, skills and extension context, on every request. Claude Code applies changes to that prompt on resumed turns.
- Reads the fork's `systemPrompt` settings from `claude-bridge.json`. A trusted project's settings override user settings and can replace the base prompt or add an active-model line.
- Registers Claude Opus 5.5 in Pi's model menu.
- Uses strict MCP configuration on every query. Connector sessions load the user's Claude Code settings by default; `provider.settingSources` overrides the setting sources.

Claude Code built-in tools are disabled by default, and Pi exposes its tools through MCP. The SDK may prepend its own identity text to the custom prompt.

## Connectors

Connectors are disabled by default. Set `provider.enableConnectors` in the user `claude-bridge.json`, or set the `CLAUDE_BRIDGE_ENABLE_CONNECTORS` environment variable. Project configuration cannot enable them.

Connector access is read-only by default. For a dedicated process running an approved write, set `CLAUDE_BRIDGE_CONNECTOR_WRITE=allow`; keep `allow` out of persistent `provider.connectorWriteMode` configuration. Use `/pi-claude:connectors` to list the account's connectors.

With connectors enabled, Claude Code loads user settings. An explicit `provider.settingSources` list in `claude-bridge.json` changes that selection. Including project or local settings lets those files affect the subprocess.
