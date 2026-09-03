# RepoPrompt MCP for Pi (`pi-repoprompt-mcp`)
> **Supported versions:** Pi 0.83.0 or newer; RepoPrompt CE 1.2.0 or newer with the required routing tools; RepoPrompt Classic 2.1.32.

Classic support targets RepoPrompt Classic 2.1.32. Before forwarding tools that act on a workspace or tab, the extension verifies that Classic can report live windows, tabs, and the current connection binding. If that check fails, those tools remain blocked and `/rp status` reports the problem.

This extension provides a single tool (`rp`) that exposes RepoPrompt MCP tools to Pi, includes branch-safe window and tab binding (auto-detect and bind to window by `cwd`, auto-bind to safe tab, persist and restore across sessions and session tree nodes, and interactive selection of windows and tabs) and batches of read files (automatically selected as context in the RepoPrompt desktop app), renders RepoPrompt tool outputs (syntax + diff highlighting), and applies guardrails for destructive operations.

The extension's window- and tab-related management features allow a workflow where new Pi sessions automatically attach to the required workspace and tab without clobbering your, or other agents', parallel usage of RepoPrompt.  Because it recovers the window, tab, and auto-selected read-files context when you rewind via `/tree` or restore a session, all the context the agent has built up (and automatically selected in the RepoPrompt app) by reading files and slices up to that point always remains available in the app for RP Chat (see `/rp oracle` below) or external "oracle" (e.g. GPT-x Pro) use cases.  Recovery is based on the required root(s) of the saved selection state, so it can reattach to any open workspace that already contains those roots rather than requiring the original workspace name; if multiple open workspaces satisfy that requirement and `cwd` does not disambiguate them, then you should re-bind with `/rp bind`.

RepoPrompt Classic and RepoPrompt CE are supported targets. Classic's Compose UI affords visibility over and user-guided refinement of Context Builder's selections, while CE is better suited to parallel agents, implementation execution, and closed-loop planning and review. You can switch targets mid-session with `/rp app` (for example, curate context and obtain a plan in Classic, then execute the plan in CE).

## Installation

From npm:

```bash
pi install npm:pi-repoprompt-mcp
```

From the dot314 git bundle (filtered install):

Add to `~/.pi/agent/settings.json` (or replace an existing unfiltered `git:github.com/w-winter/dot314` entry):

```json
{
  "packages": [
    {
      "source": "git:github.com/w-winter/dot314",
      "extensions": ["extensions/repoprompt-mcp/src/index.ts"],
      "skills": [],
      "themes": [],
      "prompts": []
    }
  ]
}
```

## Features

### Window and tab binding

- Auto-binds to the RepoPrompt window that matches `process.cwd()` (by workspace roots, resolving symlinks to their real paths before matching)
  - If multiple windows match, you're prompted to pick one
  - Window binding is (optionally) persisted across session reloads and session tree nodes
- If a bound window has an existing tab with zero selected files and no chats, the extension binds to that tab; otherwise it provisions a new tab and binds to that
- Deterministically reconciles the session tree node's bound tab, and can restore the tab already associated with that node or provision a new safe tab when needed
- User-driven binding via `/rp bind` (windows) or `/rp tab` (tabs); agents can use `rp({ bind: ... })`
- In addition to window bindings, tab bindings and auto-selected read-files context is stored and automatically recovered across node rewinds via `/tree`, different sessions (e.g., created via `/fork`), and resumed sessions

Forked sessions inherit the parent session-plus-node's window, tab, and auto-selected context snapshot at the fork point (unless you rewind in the forked session and switch window/tab/etc.), then can diverge independently as later reads or manual tab switches are performed in the child session.  Binding is non-invasive, in that it doesn't change RepoPrompt's globally active window, and automatic tab provisioning uses background tabs (`focus=false`) without stealing UI focus.  This is to prevent interference when multiple agents (or your manual usage of RepoPrompt in parallel to a Pi session) are using this extension and need to target different windows or tabs simultaneously.

### Output rendering

- Syntax highlighting for code blocks and codemaps in `read_file`, and for code blocks in outputs of `apply_edits`, `file_actions create/delete`, and `git`
- Common non-mutating RepoPrompt actions (`read_file`, `file_search`, `get_file_tree`, `get_code_structure`, `workspace_context`, routing helpers like `manage_workspaces`, and control/discovery actions like `windows`/`bind`/`status`/`search`/`describe`) get concise request-driven call/result summaries in collapsed mode.  The call line carries intent while the result line carries outcome, so the transcript stays compact without echoing the same label twice.  These summaries are derived from the arguments Pi sent, not by parsing RepoPrompt's prose output, and unknown tools fall back to normal collapsed rendering

<p align="center">
  <img width="270" height="936" alt="Collapsed call/result summaries" src="https://raw.githubusercontent.com/w-winter/dot314/main/packages/pi-repoprompt-mcp/docs/images/collapsed-summaries.png" />
</p>

- RepoPrompt `apply_edits` calls are forwarded with `verbose: true` by default, while the returned diff is normalized into `details.diff` and presented to the agent as a terse summary.  The same is done for `file_actions create/delete` outputs, so you see all edited/created/deleted LOC with rich rendering but the extension prevents the context window from getting bloated by round-tripping tool I/O tokens
- Adaptive diff rendering for RepoPrompt `git` and `apply_edits` outputs by default (`diffViewMode: "auto"` picks split, unified, compact, or summary at render time based on pane width).  This uses the active Pi theme's `toolDiffAdded`, `toolDiffRemoved`, and `toolDiffContext` colors (typically mapped to chosen hues for green and red), and its visual design and rendering logic are indebted to [MasuRii/pi-tool-display](https://github.com/MasuRii/pi-tool-display).  Two different examples at different pane widths:

<p align="center">
  <img width="1027" height="256" alt="Split diff rendering" src="https://raw.githubusercontent.com/w-winter/dot314/main/packages/pi-repoprompt-mcp/docs/images/diff-split.png" />
</p>
<p align="center">
  <img width="629" height="302" alt="Unified diff rendering" src="https://raw.githubusercontent.com/w-winter/dot314/main/packages/pi-repoprompt-mcp/docs/images/diff-unified.png" />
</p>

- Generic fenced diff blocks, and adaptive-diff parse failures, fall back to a simpler diff renderer, which uses `delta` if installed or otherwise the built-in highlighter
- Markdown-aware styling for headings and lists

### Pi Codex Code and Notebook Mode

When [pi-codex-conversion](https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/main/packages/pi-codex-conversion) 3.0.24 or newer is installed, the same `rp` tool is available inside Code and Notebook Mode as `tools.rp`. Await each call so cancellation and progress remain attached to the active `exec` cell:

```js
const result = await tools.rp({
  call: "read_file",
  args: { path: "README.md" },
});
text(result);
```

The top-level `rp` tool also works when `pi-codex-conversion` is not installed.

### Asynchronous Context Builder and Oracle jobs

- Calls to `context_builder` and `oracle_send` through `rp` start in the background and immediately return opaque job IDs
- Use `context_builder_wait` for Context Builder jobs and `oracle_send_wait` for Oracle jobs. A wait normally remains pending until the job finishes or fails. With heartbeats enabled and a known or configured prompt-cache time-to-live (TTL), it may instead return `running` shortly before the cache expires
- When a wait returns `running`, repeat it with the same job ID as the next action. This gives the next Pi model request an opportunity to reuse or refresh its prompt cache, but does not guarantee a provider cache hit
- Heartbeats are scheduled late in each known cache window rather than at a fixed polling interval. This aims to avoid the higher cost of reprocessing the full prompt after cache expiration while avoiding unnecessary intermediate model turns and cache reads; provider cache behavior and billing remain authoritative, so the schedule is a cost-saving heuristic rather than a guarantee
- Starting a job sends exactly one request to RepoPrompt; wait calls observe that same background request and never resend it. A `running` response or cancelled wait leaves the job running and its eventual result available
- Typing a message while a wait is in flight (steering) ends that wait early, so you can redirect the agent without losing the job; it picks the same job back up afterwards
- A wait is interrupted only when your message arrives while nothing else is queued; if a message was already pending, the wait continues until the job settles or a heartbeat returns `running`
- A finished job's result or failure can be retrieved only once. The RepoPrompt request remains bounded by `toolCallTimeoutMs`, independently of cache-aware wait scheduling
- Pending and ordinary `running` heartbeat waits render no rows, so repeated waits do not crowd the transcript; they still appear in the session record and in HTML exports, and only the settled result is displayed. A wait ended by steering does render a row, since its job is still running
- A bound RepoPrompt tab can run one Context Builder job and one Oracle job at the same time; different tabs can also run jobs concurrently
- Reconnecting, switching RepoPrompt apps, reloading the extension, or ending the Pi session cancels outstanding Context Builder and Oracle jobs and invalidates their IDs
- `/rp oracle` runs synchronously and other RepoPrompt tool calls return their results directly

### Steerable RepoPrompt CE Agent Mode waits

RepoPrompt CE can run sub-agent sessions of its own. A blocking wait for a sub-agent stays open until the sub-agent has something to report, you steer, or the extension reaches the cache-aware heartbeat horizon for the Pi model handling the current turn.

- Steering never cancels a sub-agent; it ends only your agent's wait. Nothing you type costs you work in progress, and the session can be picked back up afterwards
- These waits use the same provider-aware scheduling as Context Builder and Oracle waits
- A `Running` heartbeat leaves the sub-agent active and can be followed by another wait
- A single sub-agent or a whole batch can be waited on at once, in which case the wait ends as soon as any one of them has something to report
- Launching a sub-agent inline and sending a follow-up while waiting for its reply hold the turn until RepoPrompt returns

### Safety checks

- Delete operations are blocked unless you pass `allowDelete: true`
- Optional edit confirmation gate for edit-like operations (`confirmEdits`)
- Warn on in-place workspace switches (when applicable)

## Requirements

- Pi 0.83.0 or newer
- RepoPrompt CE 1.2.0 or newer with the MCP operations needed for window and tab routing, or RepoPrompt Classic 2.1.32
- The selected target's bundled `repoprompt-mcp` server reachable over stdio; CE is the default target and Classic is selectable with `/rp app classic`

### Compatibility and routing contract

When it connects, the extension checks that the selected target provides the MCP operations needed for window and tab routing. If a required operation is missing or incompatible, tools that act on a workspace or tab remain blocked and `/rp status` explains what is unavailable. `/rp status`, `/rp app`, `/rp reconnect`, tool search, and tool descriptions remain available for diagnosis. Other tools advertised by the selected target appear automatically.

Auto-binding matches the Pi working directory against the roots of open RepoPrompt workspaces. Saved window and tab bindings are checked against the current connection before they are used. If a routing operation may have succeeded but its result cannot be confirmed, the route is quarantined until `/rp reconnect` or an explicit `/rp bind` establishes it again.

`/rp status` reports `verified tab`, `stale/missing`, `restored but unverified`, `quarantined`, `unverified (observation failed)`, `unsupported contract`, or `unbound`. Only a verified tab can receive tools that act on a workspace or tab. A matched window or restored selection remains unverified until the extension binds and confirms a tab. If the live tab is verified but its binding cannot be saved to Pi session history, status reports the persistence problem while keeping the live tab usable.

### Target-specific tools

- RepoPrompt CE Oracle supports `chat`, `plan`, and `review`. RepoPrompt Classic Oracle also supports `edit`. `/rp oracle` help and validation follow the selected target.
- RepoPrompt CE `get_code_structure` uses optional `paths` plus `expand`, `depth`, `signatures`, and `size`; omitting `paths` uses the current selection. RepoPrompt Classic uses `scope`, `paths`, and `max_results`. Call summaries reflect the arguments sent to the selected target.
- Selection summaries use `manage_selection` with `op: "get"`; unavailable selection-summary capabilities affect counts in status rather than routing authority.

## Usage

### Commands

- `/rp status` — observe connection, catalog freshness, and route state; verified tabs include window, workspace, tab, focus, and context identity

<p align="center">
  <img width="210" alt="Status display" src="https://raw.githubusercontent.com/w-winter/dot314/main/packages/pi-repoprompt-mcp/docs/images/status.png" />
</p>

- `/rp windows` — list available RepoPrompt windows
- `/rp app` — show a two-option selector for the active RepoPrompt target; `/rp app ce` and `/rp app classic` switch directly
- `/rp bind` — interactive workflow for choosing the RepoPrompt window
- `/rp bind <id> [tab]` — direct option if you already know the target window id (and optionally an exact tab name or tab id); when `[tab]` is omitted, the extension restores the branch's tab for that window or provisions a fresh background tab once
- `/rp tab` — interactive tab picker for the current bound window, with `Create new tab` as the first option followed by existing tab names
- `/rp tab new` — create and bind a fresh tab on the current bound window
- `/rp tab <name-or-id>` — bind an existing tab on the current bound window by name or id
- `/rp oracle [--mode <mode>] [--name <chat name>] [--continue|--chat-id <id>] <message>` — ask RepoPrompt Oracle with current selection context. `<mode>` is `chat|plan|review` for CE and `chat|plan|edit|review` for Classic; omitting it uses `oracleDefaultMode` after target-specific validation.
- `/rp reconnect` — reconnect to RepoPrompt

### Tool: `rp`

Your agent drives everything above through a single `rp` tool; you never call it yourself. These shapes are listed so you can recognize the calls in your transcript and see what the extension exposes.

```ts
// Status (connection + binding)
rp({ })

// List windows for the selected RepoPrompt target
rp({ windows: true })

// Bind to a specific window (does not change RepoPrompt active window)
rp({ bind: { window: 3 } })

// Bind to an exact tab in that window
rp({ bind: { window: 3, tab: "T2" } })

// Search or describe tools
rp({ search: "file" })
rp({ describe: "apply_edits" })

// Call a RepoPrompt tool (binding args are injected automatically)
rp({ call: "read_file", args: { path: "src/main.ts" } })

// Start Context Builder asynchronously and save the returned job ID
rp({
  call: "context_builder",
  args: { instructions: "Explore the implementation and produce a plan", response_type: "plan" }
})

// Wait for the result; if it returns running, repeat this as the next action
rp({ call: "context_builder_wait", args: { job_id: "cb_..." } })

// Start an Oracle request asynchronously
rp({
  call: "oracle_send",
  args: { message: "Review the selected changes", mode: "review", export_response: true }
})

// Wait for the same Oracle request; if it returns running, repeat this as the next action
rp({ call: "oracle_send_wait", args: { job_id: "oracle_..." } })

// Edit confirmation gate (only required if confirmEdits=true in config)
rp({
  call: "apply_edits",
  args: { path: "file.ts", search: "old", replace: "new" },
  confirmEdits: true
})

// Delete guard override
rp({
  call: "file_actions",
  args: { action: "delete", path: "temp.txt" },
  allowDelete: true
})
```

## Configuration

Create `~/.pi/agent/extensions/repoprompt-mcp.json`:

```json
{
  "activeApp": "ce",
  "apps": {
    "ce": {
      "appPath": "/Applications/RepoPrompt CE.app",
      "autoLaunchApp": true
    },
    "classic": {
      "appPath": "/Applications/Repo Prompt.app",
      "autoLaunchApp": true
    }
  },

  "autoBindOnStart": true,
  "persistBinding": true,
  "backgroundWaitHeartbeatEnabled": true,
  "backgroundWaitCacheTtlMsByModel": {
    "my-provider/my-model": 1800000,
    "openrouter/*": null
  },

  "confirmDeletes": true,
  "confirmEdits": false,
  "toolCallTimeoutMs": 5400000,

  "readcacheReadFile": true,
  "autoSelectReadSlices": true,
  "oracleDefaultMode": "chat",

  "collapsedMaxLines": 3,
  "diffViewMode": "auto",
  "diffSplitMinWidth": 120,
  "suppressHostDisconnectedLog": true
}
```

`autoLaunchApp` applies only when that target is selected. With `"activeApp": "ce"`, the extension launches CE; Classic is launchable only after switching to it with `/rp app classic`.

`collapsedMaxLines` controls how many rendered lines of RepoPrompt tool output Pi shows before the result is expanded for the generic fallback path.  In addition, the extension now emits hand-authored one-line or two-line collapsed summaries for common non-mutating actions like `read_file`, `file_search`, `get_file_tree`, `get_code_structure`, `workspace_context`, `windows`, `bind`, and `status`; these are derived from Pi's own request metadata rather than RepoPrompt's returned prose.  Unknown or unsupported tools still fall back to the normal `collapsedMaxLines` behavior.  LOC-changing operations are the other exception: verbose RepoPrompt `apply_edits` and rendered `file_actions create/delete` results ignore `collapsedMaxLines` once normalized into `details.diff`, so the full rendered code changes remain visible.

Options:

| Option | Default | Description |
|---|---:|---|
| `activeApp` | `"ce"` | Startup RepoPrompt target (`"ce"` or `"classic"`); `/rp app` changes the current session target |
| `apps.ce` | CE defaults | RepoPrompt CE target definition |
| `apps.classic` | Classic defaults | RepoPrompt Classic target definition |
| `apps.<target>.command` | auto-detect | Explicit MCP server command for that target |
| `apps.<target>.args` | `[]` | MCP server args for that target |
| `apps.<target>.env` | unset | Extra environment variables for that target's MCP server |
| `apps.<target>.appPath` | app default | App bundle path; the MCP binary is derived as `<appPath>/Contents/MacOS/repoprompt-mcp` |
| `apps.<target>.autoLaunchApp` | `true` | Auto-launch this app only when this target is selected and the MCP server is unreachable at startup |
| `toolCallTimeoutMs` | `5400000` | MCP tool-call deadline in milliseconds for RepoPrompt operations, including Context Builder, Oracle, and CE Agent Mode waits (90 minutes by default) |
| `autoBindOnStart` | `true` | Auto-detect and bind on session start, then reconcile the branch-safe tab for the chosen window |
| `persistBinding` | `true` | Persist window and tab bindings in Pi session history for branch-safe replay |
| `backgroundWaitHeartbeatEnabled` | `true` | Allow Context Builder, Oracle, and blocking CE Agent Mode waits to return `running` near known or configured prompt-cache deadlines; `false` keeps Context Builder and Oracle waits pending until the job finishes or fails, while CE waits can remain open until shortly before `toolCallTimeoutMs` |
| `backgroundWaitCacheTtlMsByModel` | `{}` | Cache TTL assumptions in milliseconds keyed by exact `provider/model`, provider-wide `provider/*`, or global `*`; `null` keeps matching Context Builder and Oracle waits pending until the job finishes or fails, while matching CE waits can remain open until shortly before `toolCallTimeoutMs` |
| `confirmDeletes` | `true` | Block delete operations unless `allowDelete: true` |
| `confirmEdits` | `false` | Block edit-like operations unless `confirmEdits: true` |
| `readcacheReadFile` | `false` | Enable [pi-readcache](https://github.com/Gurpartap/pi-readcache)-like caching for RepoPrompt `read_file` calls (returns unchanged markers/diffs on repeat reads to save on tokens and prevent context bloat) |
| `autoSelectReadSlices` | `true` | Automatically track `read_file` calls by adding slices/full-file selection via `manage_selection`, so `oracle_send` (or a manually created Oracle chat in the RepoPrompt app) uses everything the agent has read as context; these file/slice selections are **branch-safe** across `/tree` rewinds and `/fork`ed session branches via extension-owned snapshot replay |
| `oracleDefaultMode` | `"chat"` | Default mode for `/rp oracle` when `--mode` is omitted; CE accepts `chat`, `plan`, or `review`, while Classic also accepts `edit` |
| `collapsedMaxLines` | `3` | Lines shown in collapsed view |
| `diffViewMode` | `"auto"` | Diff layout for RepoPrompt `git` / `apply_edits` fenced diff output (`auto`, `split`, `unified`) |
| `diffSplitMinWidth` | `120` | Minimum render width before `diffViewMode: "auto"` uses split diff layout |
| `suppressHostDisconnectedLog` | `true` | Filter noisy stderr from macOS `repoprompt-mcp` (disconnect/retry bootstrap logs) |

Override keys use the provider and model ID reported by Pi. An exact `provider/model` entry takes precedence over `provider/*`, which takes precedence over the global `*` entry. Model IDs may contain `/`; for example, `openrouter/anthropic/claude-sonnet-4.5` is an exact OpenRouter key, while `openrouter/*` covers every OpenRouter model. Numeric TTLs are floored and clamped from two minutes to 24 hours, then reduced by a safety margin of 10% or at least 60 seconds. A `null` override keeps matching Context Builder and Oracle waits pending until the job finishes or fails, while matching CE Agent Mode waits can remain open until shortly before `toolCallTimeoutMs`.

Built-in scheduling uses 4-minute heartbeats for supported 5-minute cache routes (including Anthropic's default cache retention), an 18-minute empirical heartbeat for GPT-5.6 variants on Pi's OpenAI Codex route, 27-minute heartbeats for GPT-5.6+ on supported OpenAI, OpenRouter, and Bedrock routes, and 54-minute heartbeats for supported one-hour Anthropic caching. GPT-5.5, long-retention OpenAI families before GPT-5.6, and routes without a known cache lifetime use no cache heartbeat: Context Builder and Oracle waits stay pending until the job finishes or fails, while CE Agent Mode waits can remain open until shortly before `toolCallTimeoutMs`.

The policy is recalculated from the Pi model handling the current agent turn on every wait. Explicit overrides are authoritative for proxies, private deployments, and newly released models. With `backgroundWaitHeartbeatEnabled` set to `false`, Context Builder and Oracle waits remain pending until the job finishes or fails, while CE Agent Mode waits can remain open until shortly before `toolCallTimeoutMs`.

Command resolution for each app target checks `apps.<target>.command`, then app-specific MCP config entries (`repoprompt-ce` / `rpce` for CE, `repoprompt-classic` / `rpclassic` for Classic), then the target app bundle command, then the fixed target CLI (`rpce-cli` or `rp-cli`). Automatic tab restoration and provisioning is driven by `autoBindOnStart` and `persistBinding`; there is no separate tab-only configuration surface. Adaptive diff layout applies only to RepoPrompt `git` and `apply_edits` outputs that arrive as fenced `diff` blocks; other rendered output stays on the existing text-based path.

## Readcache

When `readcacheReadFile` is enabled, the extension may persist UTF-8 file snapshots to an on-disk content-addressed store under `<repo-root>/.pi/readcache/objects` to compute diffs/unchanged markers across calls. Common secret filenames (e.g. `.env*`, `*.pem`) are excluded, but this is best-effort.

- If you need full content, use `bypass_cache: true` in `read_file` args
- Multi-root: use absolute or specific relative paths (MCP `read_file` has no `RootName:` disambiguation)

## Troubleshooting

### "Not connected to RepoPrompt"
- Check `/rp status` for the selected app target
- Ensure the selected RepoPrompt app is running, or switch with `/rp app ce` / `/rp app classic`
- Verify the selected target's MCP server executable resolution: `apps.<target>.command`, MCP config, `appPath`, or the target CLI executable (`rpce-cli` / `rp-cli`)
- Run `/rp reconnect`

### Pi becomes unresponsive after closing/restarting RepoPrompt
If the RepoPrompt MCP server stops responding (for example, if the RepoPrompt app is closed while Pi stays open), tool calls may time out. When that happens, the extension will drop the connection and you can recover with `/rp reconnect`.

If the selected RepoPrompt app is not running when Pi starts, the extension auto-pauses itself after a quick connection timeout. While paused, the `rp` tool returns a short error directing the agent to `/rp app` or `/rp reconnect`. Run `/rp reconnect` once the selected app is open, or switch targets with `/rp app ce` / `/rp app classic`.

If `apps.<target>.autoLaunchApp` is enabled, the extension will try to open that target's app bundle automatically before pausing. CE defaults to `/Applications/RepoPrompt CE.app`; Classic defaults to `/Applications/Repo Prompt.app`. After launching, the extension waits a few seconds and retries the connection once; if that also fails, it auto-pauses as usual.

### Switching between CE and Classic
Use `/rp app ce` or `/rp app classic` to switch the active target for the current Pi session. The switch resets the MCP connection and recovers extension-owned read selection through workspace root matching in the newly selected app; manual selections are not copied between apps. If no unique matching window exists, use `/rp bind` after switching.

The extension follows MCP tool-list change notifications and automatically refreshes the tools used by search, describe, status, and tool calls. Status identifies the tool list as fresh, stale, or unavailable. If a refresh fails, search and describe continue to show cached results marked as stale. Tools that act on a workspace or tab pause until a fresh compatible tool list is available. `/rp reconnect` forces a fresh connection and tool refresh.

### "No matching window found"
- Your `cwd` may not match any RepoPrompt workspace root
- Use `/rp windows` to list windows
- Use `/rp bind` to pick one

### Unsupported contract
- Read the diagnostic in `/rp status`; it names the selected target and the missing or incompatible routing operation
- Upgrade RepoPrompt or this package to a compatible version, then run `/rp reconnect`
- Cached search and description results remain available for diagnosis; tools that act on a workspace or tab remain blocked until a fresh compatible tool list is available

### Stale, unverified, or quarantined route
- Run `/rp reconnect` to establish the route from current live inventory
- Use `/rp bind` when you need to select the intended window or tab explicitly
- A quarantined diagnostic means the preceding routing mutation may have partially succeeded; inspect `/rp status` before binding

### Window listing or auto-bind fails
- Check `/rp status` for a routing-tool or window-inventory diagnostic
- Confirm the intended workspace is open in the selected RepoPrompt target
- If root observation is unavailable for a zero-tab window, create or open a tab in that workspace and run `/rp reconnect`

### Upgrade

```bash
pi update npm:pi-repoprompt-mcp
```

Restart Pi after upgrading so the updated package starts with a fresh RepoPrompt connection.

### Delete operation blocked
- Pass `allowDelete: true` on the `rp` call

## License

MIT
