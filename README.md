# pi-claude-bridge

A Pi provider that uses a logged-in Claude Code account through the Claude Agent SDK. You keep Pi's terminal interface and tools while Claude Code handles model requests.

This is a fork of [Eli Dickinson's `@vanillagreen/pi-claude-bridge`](https://github.com/vanillagreencom/kendex/tree/main/pi-extensions/pi-claude-bridge).

![Response from Claude through the bridge](assets/bridge-demo.png)

## Install

Pi auto-discovers the bridge when the dot314 checkout is your Pi agent directory. To load it explicitly for one run:

```bash
pi -e ./extensions/pi-claude-bridge/bundle/index.js
```

The committed bundle includes its runtime dependencies. A Claude Code login is required. Make `claude` available on `PATH` or set its executable path below.

Fable 5.1 requires [Claude Code 2.1.255 or later](https://code.claude.com/docs/en/model-config#work-with-fable). This includes any executable chosen through `provider.pathToClaudeCodeExecutable` or found on `PATH`, which takes precedence over the SDK's bundled CLI. Account access and usage-credit requirements still apply.

## Features

- Select Claude models from Pi's model menu.
- Run Pi tool calls during Claude conversations.
- Resume the Claude conversation across Pi turns.
- Configure model effort and forwarded prompt context.
- Optionally use the Claude account's connectors.

## How it works

- You pick one of the `pi-claude` models in Pi's model menu; **Claude Fable 5.1** is `pi-claude/claude-fable-5-1`.
- The bridge starts Claude Code, or resumes it, through the Claude Agent SDK, Anthropic's library for driving Claude Code from another program.
- It sends your prompt to Claude Code and offers it Pi's tools.
- When Claude Code calls a tool, Pi runs the tool and sends the result back to Claude Code.
- Pi shows the reply and remembers which Claude Code conversation it belongs to, so your next message continues it.

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

- Sends Pi's complete effective system prompt as the custom prompt supplied to the Claude Agent SDK on every query, including resumed sessions, rather than appending selected context to Claude Code's preset prompt. Pi's assembled prompt already includes extension instructions, project context, and skills.
- Uses bridge-owned `systemPrompt` settings in `claude-bridge.json` for replacing the base prompt, adding the active model, and retaining the Pi context suffix. Values from trusted projects override user values.
- Removes upstream's selective `APPEND_SYSTEM.md` and extension-hook forwarding controls because the complete Pi prompt is forwarded.
- Enables strict MCP configuration on every query. Non-connector queries pass an empty list of filesystem setting sources by default; connector-enabled sessions use the separate policy below. An explicit `provider.settingSources` value overrides either default.

Claude Code built-in tools are disabled by default, and Pi exposes its tools through MCP. The SDK may prepend its own identity text to the custom prompt.

## Connectors

Connectors are disabled by default. Set `provider.enableConnectors` in the user `claude-bridge.json`, or set the `CLAUDE_BRIDGE_ENABLE_CONNECTORS` environment variable. Project configuration cannot enable them.

Connector access is read-only by default. For a dedicated process running an approved write, set `CLAUDE_BRIDGE_CONNECTOR_WRITE=allow`; keep `allow` out of persistent `provider.connectorWriteMode` configuration. Use `/pi-claude:connectors` to list the account's connectors.

With connectors enabled, Claude Code loads user settings. An explicit `provider.settingSources` list in `claude-bridge.json` changes that selection. Including project or local settings lets those files affect the subprocess.
