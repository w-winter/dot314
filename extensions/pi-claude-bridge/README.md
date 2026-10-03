# pi-claude-bridge

A Pi provider that uses a logged-in Claude Code account through the Claude Agent SDK. You keep Pi's terminal interface and tools while Claude Code handles model requests.

Requires Pi 0.86.0 or later and Node.js 22.19.0 or later.

This is a fork of [vanillagreen's `@vanillagreen/pi-claude-bridge` in Kendex](https://github.com/vanillagreencom/kendex/tree/main/pi-extensions/pi-claude-bridge), which descends from [Eli Dickinson's `pi-claude-bridge`](https://github.com/elidickinson/pi-claude-bridge). [nicobailon](https://github.com/nicobailon/) has contributed several tool, stream and session fixes described below. See [Differences from Kendex upstream](#differences-from-kendex-upstream) for the comparison.

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

Claude Code's own file, shell and web tools are turned off. The bridge serves Pi's active tools from an MCP server named `custom-tools` inside the Pi process, and Pi executes those calls. Optional claude.ai connectors run inside Claude Code, as described below.

```
 Pi tool             served to Claude as                              back in Pi
 ─────────────────   ──────────────────────────────────────────────   ──────────────
 read                mcp__custom-tools__read                          read
 my_tool             mcp__custom-tools__my_tool                       my_tool
 web/fetch page      mcp__custom-tools__web_fetch_page_1a2b3c4d       web/fetch page
                                         └─ unsafe characters → "_", plus a hash
```

- **Names.** A tool whose name uses only letters, digits, `_` and `-`, and fits the API's 128-character limit for the full name, keeps its name. Any other name is served as a cleaned-up, shortened spelling plus an 8-character hash of the original, because Claude Code would rewrite it and the call could never be traced back. Each call maps back to the exact Pi name. A tool keeps its served name for the whole query.
- **Arguments.** Claude receives Pi's JSON Schema definitions, including references and constraints; schema fragments incompatible with JSON Schema 2020-12 are omitted. Pi checks the arguments, and a check failure goes back to Claude as the tool result. Argument names Claude Code habitually uses are mapped to Pi's (`file_path` becomes `path`, `old_string`/`new_string` become `oldText`/`newText`), and `bash` gets a 120-second timeout when Claude gives none.
- **Results.** Claude Code tags every call with its tool_use id, and the bridge answers each call with that call's result only. A call whose arguments were cut off mid-stream is never run.
- **Tools that change mid-turn.** When an extension turns tools on or off during a tool call, the served list changes with it. The bridge waits up to 2 seconds for Claude Code to re-read the list before releasing the tool result. A tool that is turned off disappears from the list but still answers a call Claude made before.
- **Slow tools.** The bridge advertises Claude Code's maximum MCP timeout and disables automatic backgrounding for Pi's tools. Pi's own tool timeouts and cancellation still apply. If Claude Code stops waiting for a call, the bridge warns that Claude will not receive its result.
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

A rebuild keeps as much of Claude Code's own transcript as it can. When that transcript still holds the start of Pi's history with the same content, as it does after you press Esc, the bridge copies those records as they are into the new session and writes only the rest from Pi's history. Claude Code then sends the same request bytes as before, and the prompt cache still covers that part.

The bridge saves which Claude Code session belongs to the Pi session in the Pi session file, so reopening a Pi session resumes the same Claude Code conversation. When Pi compacts or rewrites the history during a Pi tool call, the bridge restarts from Pi's new history with the completed tool results. A query that used one of Claude Code's own connectors finishes first, and the next turn uses Pi's new history.

## Install

Pi discovers the extension when this dot314 checkout is your Pi agent directory. To load it explicitly for one run, from the checkout root:

```bash
pi -e ./extensions/pi-claude-bridge/bundle/index.js
```

Pi loads the committed bundle, which includes the JavaScript runtime dependencies. To develop the bridge, run `npm ci` and `npm run build` in `extensions/pi-claude-bridge`, then `/reload` in Pi. Claude Code itself must be installed separately.

A Claude Code login is required. Make `claude` available on `PATH` or set its executable path below.

System prompt replacement is optional; [Settings](#settings) explains how to configure it.

Claude Sonnet 5.5 (`pi-claude/claude-sonnet-5-5`) requires [Claude Code 2.1.284 or later](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#21284). Claude Opus 5.5 (`pi-claude/claude-opus-5-5`) requires [Claude Code 2.1.280 or later](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#21280). Fable 5.1 requires [Claude Code 2.1.255 or later](https://code.claude.com/docs/en/model-config#work-with-fable). These requirements apply to an executable chosen through `provider.pathToClaudeCodeExecutable` or found on `PATH`, which takes precedence over the SDK's bundled CLI. Account access and usage-credit requirements still apply.

## Features

- Select Claude models from Pi's model menu, including `pi-claude/claude-sonnet-5-5`, `pi-claude/claude-opus-5-5` and `pi-claude/claude-fable-5-1`.
- Run Pi tool calls during Claude conversations.
- Steer Claude while a Pi tool runs.
- Resume the Claude conversation across Pi turns.
- Configure model effort and forwarded prompt context.
- Optionally use the Claude account's connectors.

## Settings

The bridge reads `claude-bridge.json` from `~/.pi/agent` and from a trusted project's `.pi/` directory. `PI_CODING_AGENT_DIR` changes the user directory. Run `/pi-claude` to show the provider's current status.

The bridge's `systemPrompt` configuration is independent of `anthropic-oauth-compat`, which continues to read `anthropicOAuthCompat` from `settings.json`.

- `enabled`: register the `pi-claude/*` models; reload required.
- `agentNotices`: `true` tells the agent about each kind of bridge anomaly (an error the bridge wrote, or a problem it recovered from), once per kind per session. The bridge adds the notice to the conversation as a message with your next prompt, and the TUI shows it. Off by default, and only the user `claude-bridge.json` can turn it on; a project's file cannot. The details are in the bridge logs only when `CLAUDE_BRIDGE_DEBUG=1` is set too.
- `systemPrompt.replacement`: replace Pi's default base instructions in Pi's main agent prompt while retaining Pi's rules and guidelines (Pi's own rules, the selected tools' guidelines and extensions' `promptGuidelines`) and Pi-managed project context and skills. Pi's opening sentence, tool list and documentation pointers are dropped; Claude gets the tools as MCP definitions. When the session supplies its own base (`SYSTEM.md`, `--system-prompt`, an SDK `systemPrompt`, or a pi-subagents agent with `systemPromptMode: replace`), that base is kept: Claude receives the replacement, a blank line, then the complete prompt Pi built. Pi's default base is recognized by its fixed opening sentence ("You are an expert coding assistant operating inside pi, …"); a `before_agent_start` prompt that does not open with it is kept whole the same way. Other system prompts reach Claude unchanged, whatever they contain, including those of Pi's compaction and branch summaries and extensions' own model calls.
- `systemPrompt.includeModelLine`: prepend `Active model: provider/modelId` to the replacement.
- `systemPrompt.preservePiContext`: retain Pi-managed context after the replacement; defaults to `true`. `false` sends only the replacement in place of Pi's main agent prompt when that prompt has Pi's default base. A session's own base is never dropped, so with `false` it still arrives after the replacement together with its context.
- `provider.fastMode`, `provider.pathToClaudeCodeExecutable`: control how the Claude Code subprocess is launched.
- `provider.forceEffort`, `provider.modelEffortOverrides`: pin a Claude effort for every request or per model. Override keys are bare ids (`claude-opus-4-8`), `pi-claude/<id>` or `*`; values are `low`, `medium`, `high`, `xhigh` or `max`; a per-model entry beats the global force.
- `provider.settingSources`: explicitly load selected filesystem settings from Claude Code. By default, no settings load when connectors are disabled. When connectors are enabled, the bridge loads the user's settings.
- `provider.inheritAnthropicEnv`: `true` passes `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from the environment to Claude Code, for an intentional gateway or API-key setup. By default the bridge removes them, so an exported variable cannot route subscription requests through another endpoint or credential, and it does not count them as credentials when deciding whether the provider is connected. Only the user `claude-bridge.json` can set it, and managed account profiles never inherit these variables.

The bridge sends the configured prompt to Claude Code. If Anthropic returns its "Third-party apps now draw from your extra usage" error, the bridge displays that error with a troubleshooting hint about `systemPrompt.replacement`. The hint identifies Pi's documentation clauses `custom providers (docs/custom-provider.md)` and `pi packages (docs/packages.md)` as a possible prompt issue. Setups that manage the prompt elsewhere can leave the replacement unset.

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
- `CLAUDE_BRIDGE_DEBUG=1`: write the bridge log, the integrity diagnostics and per-query Claude Code CLI logs under the Pi agent directory; `CLAUDE_BRIDGE_DEBUG_PATH` and `CLAUDE_BRIDGE_DIAG_PATH` move the two log files. The bridge log ends each request with one `timing:` JSON line: where the request spent its time, and why it rebuilt the Claude session when it did. Without it, the bridge writes no log and measures nothing. It still writes what it needs to run: the Claude Code session files it builds from Pi history, its own entries in the Pi session file, and, with connectors on, the connector inventory cache in the Pi agent directory.

Tool-result integrity problems add a metadata-only `claude-bridge-integrity` entry to the Pi session file, so a lost tool result can be analysed from the session alone. Only some also show a TUI warning: a repaired or interrupted tool result, a tool call Claude Code stopped waiting for, and a failed answer to a mid-turn message.

Maintainer notes and the test suites are in [DEVELOPMENT.md](DEVELOPMENT.md).

## Differences from Kendex upstream

This comparison uses [Kendex's `@vanillagreen/pi-claude-bridge` 4.0.8](https://github.com/vanillagreencom/kendex/tree/fb55afe5cd4593b69939c7a53de56ea298a9b994/pi-extensions/pi-claude-bridge) as its reference. Session resumption, restarts after mid-tool compaction, managed account routing, read-only connectors and Opus 5.5 support are present in both.

### Prompts and configuration

- Forwards Pi's system prompt, including its project instructions, skills and extension context, with an optional base replacement. Kendex builds on Claude Code's preset prompt and selectively appends context files, skills and recognized extension hooks. The Claude Agent SDK may still prepend its own identity text.
- Offers `systemPrompt.replacement`, `includeModelLine` and `preservePiContext` for Pi's main agent prompt. A replacement retains Pi's rules and project context by default, and a session's own base instructions remain intact. Compaction, branch summaries and extensions' independent model calls keep their own prompts.
- Uses user and trusted-project `claude-bridge.json` files directly, with subprocess options under `provider`. Kendex also reads its extension-manager namespace in `settings.json` and exposes a settings panel; here `/pi-claude` shows status.
- Always uses strict MCP configuration. Claude Code loads no filesystem settings by default outside connector mode, and user settings only in connector mode; `provider.settingSources` explicitly overrides that choice.
- Removes inherited `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from unmanaged Claude Code children unless the user enables `provider.inheritAnthropicEnv`. These variables also follow that setting when checking whether the provider has credentials.
- Adds troubleshooting text after an actual third-party-app rejection from Anthropic. Such a rejection ends the request on the current account instead of being treated as a rate limit that rotates through other profiles.

### Tools and streamed replies

- Matches tagged MCP calls by Claude Code's tool-use id. Duplicate invocations share the original wait, and an id belonging to another tool or an already-ended call receives an error rather than another call's result.
- Gives tools with long names or unsupported characters stable MCP aliases, and maps replies back to their exact Pi names.
- Forwards Pi's JSON Schema definitions and referenced definitions, where Kendex converts them through Zod. Pi validates the arguments; fragments incompatible with JSON Schema 2020-12 are omitted from the advertised schema.
- Updates tools during a running query when Pi enables, disables or redefines them. Calls already issued retain the handler and definition they need until their results are delivered.
- Sets the maximum MCP timeout and disables Claude Code's automatic backgrounding for Pi tools. A warning identifies calls Claude Code stopped waiting for.
- Replaces abandoned response attempts with their retries and withdraws calls belonging to the abandoned attempt. Incomplete tool calls are excluded on completion, failure and abort paths; late siblings are delivered in a new turn rather than appended to one Pi already consumed.
- Keeps the in-progress stream intact when producing the completed or failed message. It extends the wait for tool arguments while they are still arriving, rather than ending a call mid-stream.
- Keeps Claude Code's file, shell and web built-ins disabled even when Pi provides no tools. Kendex 4.0.8 can restore those built-ins for an ordinary non-connector request whose Pi tools did not reach the child.

### Steering, cancellation and concurrent requests

- Writes steering and other user input received alongside tool results to the running query before releasing those results, so Claude's next response can use both. When live delivery is unavailable, the input is queued for a continuation.
- Tracks which user messages the query has accepted, including messages interleaved with tool results. Repeated callbacks do not resend them; ambiguous history changes are handled by rebuilding from Pi's history.
- Retains completed replies when a deferred continuation fails, warns about the unanswered message, and keeps legitimate repeated text from successive replies.
- Reports a failure that arrives after Pi received a tool turn through the following tool-result callback, rather than changing the delivered turn or treating it as success.
- Starts a fresh query for a prompt submitted just after Esc. Cancellation stops waiting for an unresponsive Claude Code query after a five-second grace period.
- Watches for silence throughout the response, including after the first output, while allowing for Pi tool execution and retry backoff announced by Claude Code.
- Runs reviewers, summarizers and MCP sampling requests as their own Claude queries, even when they share the main conversation's Pi session id. They cannot take over a main query that is waiting for a tool result.

### History and models

- Checks a content hash before reusing Claude's session, detecting edits that leave the message count unchanged. Tool-result bodies are excluded from that check so pruning old results does not force a rebuild.
- A reopened Pi session still rebuilds when Claude's copy was left out of date. Rebuilds omit failed or aborted assistant turns and their associated tool results.
- Replays redacted thinking in its correct format. A trailing Claude reply with incomplete thinking becomes a note containing its text, calls and results in order, including result images.
- Suppresses Claude Code's automatic continuation of an interrupted stored turn; Pi supplies the next prompt.
- Adds Sonnet 5.5 to the supported model list. Thinking "off" sends disabled thinking where supported; Pi hides that choice for Fable 5.1, Opus 5.5 and Sonnet 5.5.
- Reports thinking-token usage separately. The reply retains the model id Pi requested and records a different serving model as `responseModel`; Claude Code's safety-related model switches are announced.

### Diagnostics and distribution

- Agent notices require `agentNotices: true` in user configuration, independently of `CLAUDE_BRIDGE_DEBUG=1`. Errors and warnings that need attention still appear in Pi by default.
- Rotates debug and diagnostic logs, prunes old Claude Code CLI logs, and records the versions of Node, Pi and Claude Code when debugging is enabled. Log messages summarize payloads using counts, types and lengths; malformed JSON diagnostics omit the input text quoted by the parser.
- Keeps provider registration and shared module state usable across `/new`, fork, resume and `/reload`, including when Pi loads TypeScript source directly.
- Ships as dot314's local extension with a committed provider bundle. `npm run test:ci` builds it, checks types and exported state, and runs the offline tests. Includes `package-lock.json` for reproducible installation and requires Claude Agent SDK `0.3.284`.

### Changes developed separately in Kendex

Kendex 4.0.8 also has capabilities and optimizations that this fork has not incorporated:

- Integration with Kendex's settings editor, a service that publishes the authenticated billing identity to other extensions, and a separately exported connector-inventory module.
- Cached settings reads, memoized hashes for session restoration, cached executable-header checks and broader lazy formatting of debug messages.
- End-of-query cleanup that releases stored tool arguments and parked results while the session is idle, plus a broader clean-start check for Pi history that converts to no Claude records.

## Connectors

Connectors are disabled by default. Set `provider.enableConnectors` in the user `claude-bridge.json`, or set the `CLAUDE_BRIDGE_ENABLE_CONNECTORS` environment variable. Project configuration cannot enable them.

Connector access is read-only by default. For a dedicated process running an approved write, set `CLAUDE_BRIDGE_CONNECTOR_WRITE=allow`; keep `allow` out of persistent `provider.connectorWriteMode` configuration. Use `/pi-claude:connectors` to list the account's connectors.

With connectors enabled, Claude Code loads user settings. An explicit `provider.settingSources` list in `claude-bridge.json` changes that selection. Including project or local settings lets those files affect the subprocess.
