# Extensions

| Symbol | Meaning |
|--------|-------------------------|
| ● | original |
| ◐ | forked & modified |
| ○ | republished unmodified |

- ● [`grounded-compaction/`](grounded-compaction/) ([README](./grounded-compaction/README.md))
  - Replaces Pi's compaction summarizer with configurable model presets, user-editable prompt contracts, and deterministic files-touched tracking that covers Pi native tools, RepoPrompt, and bash-derived file operations; also augments branch summarization during `/tree` with the same files-touched grounding and optional prompt customization
  - Uses the shared collector from [`_shared/files-touched-core.ts`](_shared/files-touched-core.ts); see [Pi compaction docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/compaction.md) for background
  - ⚠ Hooks `session_before_compact` — incompatible with other extensions that do the same (e.g. `agentic-compaction`); having both active is a race condition

- ● [`model-aware-compaction/`](model-aware-compaction/) ([README](./model-aware-compaction/README.md))
  - Triggers Pi's **built-in auto-compaction** at per-model percent-used thresholds (0-100), configured via `config.json` (keyed by model ID, supports `*` wildcards)
  - Nudges Pi's native compaction pipeline rather than calling `ctx.compact()`, preserving the compaction UI and automatic queued-message flush
  - Requires `compaction.enabled: true` in settings; see README for `reserveTokens` tuning
  - Compatible with compaction-summary extensions (e.g. `agentic-compaction` via `session_before_compact`)

- ● [`session-ask/`](session-ask/) ([README](./session-ask/README.md))
  - `session_ask({ question, sessionPath? })` queries the current (or specified) session JSONL (including pre-compaction history) without bloating the current model context; `/session-ask ...` is a UI wrapper
  - `session_lineage({ ... })` returns fork ancestry (parentSession chain)
  - Internal `session_shell` uses a read-only just-bash virtual FS (`/conversation.json`, `/transcript.txt`, `/session.meta.json`) for precise extraction with `jq`/`rg`/`awk`/`wc`
  - Optional minimal fork-lineage system prompt injection via `injectForkHintSystemPrompt` (see README)
  - Configurable model/prompt via `config.json`, optionally pointing at an agent definition under `~/.pi/agent/agents/`

- ● [`repoprompt-mcp/`](repoprompt-mcp/) ([README](./repoprompt-mcp/README.md))
  - Pi-compatible, token-efficient proxy for the RepoPrompt MCP server with:
    - Window and tab binding that prevents user/agent or agent/agent clobbering: auto-detects by `cwd`, binds to a blank existing tab or provisions a new background tab if the active tab is dirty, optional persistence and restoration per session, interactive binding resolution in case of multiple windows containing the required root, and manual selection via `/rp bind` (windows) or `/rp tab` (tabs)
      - Bindings are branch-safe across navigation of the session DAG via `/tree` and `/fork`ed sessions; forked sessions inherit the parent node's window, tab, and auto-selected context snapshot at fork time and diverge independently from there
      - On rewind or session restore, the bound tab for that session tree node is deterministically restored, or a fresh background tab is provisioned if needed
    - `/rp status` shows the currently bound tab name with a `[bound, in-focus]` or `[bound, out-of-focus]` label, plus selected file/token counts when available
    - `/rp oracle [--mode chat|plan|edit|review] ...` — send a message to RepoPrompt chat using the current selection context
    - Output rendering:
      - Syntax highlighting for code blocks and codemaps
      - Collapsed tool output summaries derived from request metadata for common non-mutating actions (`read_file`, `file_search`, `get_file_tree`, etc.)
      - Adaptive diff rendering for `git` and `apply_edits` outputs)
      - Token bloat prevented in the context window from outputs of `apply_edits` and `file_actions create/delete`, while their diffs are routed to Pi's `details.diff` so they are still displayed in full in the terminal
    - Safety guardrails: blocks deletes unless `allowDelete: true`, optional edit confirmation gate (`confirmEdits`)
    - Optional [Gurpartap/pi-readcache](https://github.com/Gurpartap/pi-readcache)-like caching for RepoPrompt `read_file` calls (returns unchanged markers/diffs on repeat reads to save on tokens and prevent context bloat)
    - Optional auto-selection (in the RP app, e.g. for use in RP Chat) of slices/files the agent has read; these selections are also branch-safe across `/tree` navigation and `/fork`ed sessions

- ● [`repoprompt-cli/`](repoprompt-cli/)
  - [RepoPrompt](https://repoprompt.com/docs) bridge for Pi: `rp_bind` + `rp_exec`
  - `rp_exec` wraps `rp-cli -e ...` with safe defaults (quiet, fail-fast, timeout, output truncation)
  - Safety features: blocks unbound usage, delete-like commands (unless `allowDelete=true`), and in-place workspace switching (unless explicitly allowed)
  - Uses just-bash AST parsing (requires `just-bash` >= 2) for command-chain inspection (better handling of quoting/escaping/chaining edge cases)
  - Syntax-highlights fenced code blocks; diff blocks use `delta` when installed (honoring the user's global git/delta color config, with graceful fallback)
  - Persists the current RepoPrompt window/tab binding across session; bindings are also branch-safe across navigation of the session DAG via `/tree` and across `/fork`ed sessions
  - Optional auto-selection (in the RP app, e.g. for use in RP Chat) of slices/files the agent has read; these selections are also branch-safe across `/tree` navigation and `/fork`ed session
  - Edit ergonomics: detects no-op edits and fails loudly by default (set `failOnNoopEdits=false` to allow intentional no-ops)
  - Includes optional [Gurpartap/pi-readcache](https://github.com/Gurpartap/pi-readcache)-like caching for RepoPrompt `read_file` calls (returns unchanged markers/diffs on repeat reads to save on tokens and prevent context bloat)
  - Used by [Pi × RP-CLI AGENTS.md guidance](../AGENTS-rp-cli-prefix.md), [RP-CLI prompts](../skills/repoprompt-tool-guidance-refresh/rp-cli-prompts/), and this [skill](../skills/repoprompt-tool-guidance-refresh/) for keeping it all up-to-date with new RepoPrompt versions

<p align="center">
  <img width="333" alt="repoprompt syntax highlighting example" src="https://github.com/user-attachments/assets/a416af2c-6f8e-4141-8040-abb8492eda7b" />
</p>

- ● [`rp-native-tools-lock/`](rp-native-tools-lock/)
  - Disables Pi native repo-file tools (`read`, `write`, `edit`, `ls`, `find`, `grep`) when RepoPrompt tools are available
  - Mode switch: `/rp-tools-lock off|auto`
    - `off`: no enforcement
    - `auto`: prefer `rp` (RepoPrompt MCP) if available; else `rp_exec` (RepoPrompt CLI); else behaves like `off`
  - Advanced modes (`rp-mcp`, `rp-cli`) are supported via config: [`rp-native-tools-lock/rp-native-tools-lock.json`](rp-native-tools-lock/rp-native-tools-lock.json)
  - Hotkey: `alt+L` toggles modes (off ↔ auto)
  - Footer status indicator while enforced: `RP 🔒`
  - Intended to complement the `/tools` extension without mutating `tools/tools.json`

<p align="center">
  <img width="225" alt="rp native tools lock" src="https://github.com/user-attachments/assets/881cb6f1-1258-4bd6-b8f3-532381ac1ab1" />
</p>

- ● [`anycopy/`](anycopy/) ([README](./anycopy/README.md))
  - `/anycopy` mirrors all behaviors of Pi's native `/tree` while adding a live, syntax-highlighted preview of each node's content and the ability to copy any node(s) to the clipboard
  - `Enter` navigates to focused node (same semantics as `/tree`, including the summary chooser and `branchSummary.skipPrompt` support)
  - `Space` select/unselect for copy, `Shift+C` copy (selected or focused), `Shift+X` clear selection, `Shift+L` label node
  - `Shift+Up`/`Down` scroll preview by line, `Shift+Left`/`Right` page preview
  - Single-node copies use just the node's content; role prefixes are only added when copying 2+ nodes
  - Multi-selected nodes are auto-sorted chronologically (by tree position)
  - Configurable in `anycopy/config.json`: `treeFilterMode` (initial filter mode), `keys` (overlay keybindings)

<p align="center">
  <img width="450" alt="anycopy demo" src="https://raw.githubusercontent.com/w-winter/dot314/main/assets/anycopy-demo.gif" />
</p>

- ● [`md.ts`](md.ts)
  - `/md` exports the current Pi session to a legible Markdown transcript in `~/.pi/agent/pi-sessions-extracted/`; tool calls and thinking blocks are excluded by default
  - `/md tc` includes tool calls (invocations + results); `/md tc -<toolname>` (e.g., `/md tc -bash -read`) excludes exact tool name(s); `/md tc +<toolname>` excludes all tool names except for the "whitelisted" exact tool name(s); filters are case-insensitive and require `tc`
  - `/md t` includes thinking blocks (also `think`, `thinking`)
  - `/md <N>` exports only the last **N turns** (a turn is `[user message → assistant message]`), e.g. `/md 2`, `/md tc t 2`
  - `/md all` (or `/md file`) exports the full session file instead of the current `/tree` branch; flags combine freely

- ● [`fork-from-first.ts`](fork-from-first.ts)
  - `/fork-from-first` forks the current session from its first user message and switches into the new fork immediately
  - If `rewind/` is installed, it requests rewind's conversation-only fork mode ("keep current files") for that fork

- ● [`move-session.ts`](move-session.ts)
  - `/session-move <targetCwd>` moves the *current session* to a different working directory, intended for when you started pi in one folder but come to find that you need it in another after building up valuable context
  - Forks the session JSONL into the target cwd bucket (`SessionManager.forkFrom(...)`), clears the fork header's `parentSession` pointer, then relaunches `pi --session <fork>` with `cwd=<targetCwd>` so the footer + built-in tools resolve relative paths against the new directory
  - Uses `trash` to delete the old session file (best-effort); if `trash` isn't available, it leaves the old file in place
  - Supports `~` expansion (e.g. `/session-move ~/code/my-project`)

- ● [`roam/`](roam/) ([README](./roam/README.md))
  - `/roam [window-name]` post-hoc moves the current live Pi session into a dedicated tmux server (`tmux -L pi`) for remote continuation (e.g. Termius over Tailscale) -- convenient if you find yourself wishing you had already started Pi inside tmux
  - Forks the session, clears the fork header's `parentSession` pointer, starts/joins tmux session `pi`, then best-effort trashes the original session file to avoid `/resume` duplicates
  - Writes/refreshes tmux config at `~/.config/pi-tmux/tmux.conf` with dual prefixes (`Ctrl+S` + `Ctrl+B`) and mobile-friendly defaults
  - Optional per-user Tailscale config at `~/.pi/agent/extensions/roam/config.json` (example: [`roam/config.json.example`](./roam/config.json.example)):
    - `tailscale.account`: run `tailscale switch <account>` before `tailscale up`
    - `tailscale.binary`: override Tailscale CLI path (default macOS app binary)

- ● [`command-center/`](command-center/) ([README](./command-center/README.md))
  - Scrollable widget above the editor displaying all /commands from extensions, prompts, and skills
  - Configure keybindings etc. via `config.json`

<p align="center">
  <img width="333" alt="command center demo" src="https://raw.githubusercontent.com/w-winter/dot314/main/assets/command-center-demo.gif" />
</p>

- ● [`ephemeral-mode.ts`](ephemeral-mode.ts)
  - `/ephemeral` toggles whether the current session file is deleted on exit (otherwise only possible via pre-committing `pi --no-session`), preventing throwaway sessions from cluttering `/resume`
  - Shortcut: `alt+e`

- ● [`model-sysprompt-appendix/`](model-sysprompt-appendix/)
  - Appends a per-model appendix to the system prompt (exact match or default), right before the "# Project Context" section that leads into the contents of AGENTS.md.  Helpful, for example, for Claude models with confused identities (e.g. Opus 4.5, without a system prompt guiding it otherwise, assuming itself to be Sonnet 3.5 and low in capability)
  - `/model-sysprompt-appendix reload|status`
  - Configurations stored in [`model-sysprompt-appendix/model-sysprompt-appendix.json`](model-sysprompt-appendix/model-sysprompt-appendix.json)

- ● [`poly-notify/`](poly-notify/)
  - Desktop / sound / Pushover notifications (e.g. to smart watch) when an agent turn completes and exceeds a duration threshold
  - Sound aliases include `random` (randomly picks from configured list of sounds)
  - Volume modes: `constant` or `timeScaled`
  - `/notify` interactive menu, plus quick toggles (`/notify on|off|popup|pushover|volume|<seconds>|<sound>`)
  - Config file lives at `poly-notify/notify.json` (example: [`poly-notify/notify.json.example`](poly-notify/notify.json.example))

<p align="center">
  <img width="270" alt="notify menu" src="https://github.com/user-attachments/assets/474af589-ee3e-423d-a800-4331f2517676" />
</p>

- ● [`brave-search/`](brave-search/) ([README](./brave-search/README.md))
  - 🔄 **For general-purpose agent web search, consider [pi-web-access](https://github.com/nicobailon/pi-web-access) instead** (Gemini search, AI-synthesized overview + citations). `brave-search` remains useful when you specifically need individual search results with per-result previews
  - Token-efficient Brave web search with optional content extraction/clipping for "read the docs / answer from sources" workflows
  - Manual command: `/ws <query> ... [--content]` (no model turn)
  - LLM tool: `brave_search({ query, count, country, freshness, fetchContent, format })`
  - With `fetchContent=true` / `--content`: extracts readable markdown, saves full content to `~/.pi/agent/extensions/brave-search/.clips/`, returns a preview + a `Saved:` path
  - Direct URL mode: if `query` is a URL (including `raw.githubusercontent.com/...`) and `fetchContent=true`, it fetches and clips directly (no search step)
  - Optional LLM tool: `brave_grounding({ question, enableResearch, enableCitations, enableEntities, maxAnswerChars })` (requires `BRAVE_API_KEY_AI_GROUNDING`)
  - Search results are shown to the user but filtered out of LLM context via the `context` hook
  - **Recommendation:** For general-purpose web search with agents, I now prefer [nicobailon/pi-web-access](https://github.com/nicobailon/pi-web-access) — it uses Gemini search which provides better indexing and returns an AI-synthesized overview alongside citations, which works better for agent workflows. `brave-search` remains useful when you specifically need individual search results with per-result previews

- ● [`protect-paths.ts`](protect-paths.ts) - standalone directory/command protection hooks that complement upstream [`@aliou/pi-guardrails`](https://github.com/aliou/pi-guardrails)
  - 🔄 **Replaces the directory protection and brew prevention hooks from the old `guardrails/` directory.** For `.env` file protection and AST-based dangerous command gates (the other components of the old `guardrails/`), install upstream: `pi install npm:@aliou/pi-guardrails`
  - Hard blocks: `.git/` and `node_modules/` directory access (file tools + bash command parsing), Homebrew install/upgrade commands
  - Uses just-bash AST analysis (requires `just-bash` >= 2) to inspect nested command structures (including substitutions/functions/conditionals)
  - Confirm gates: broad delete commands (`rm`/`rmdir`/`unlink`) and piped shell execution (`... | sh`)
  - Allowlist for Pi's Homebrew install path in `node_modules/` (read-only)

- ● `reverse-thinking.ts` - Adds backward (e.g. 'med' -> 'low') cycling movement through thinking levels via `shift+alt+tab`

- ● [`iterm-tab-color.ts`](iterm-tab-color.ts)
  - Uses iTerm2 OSC tab-color sequences to color each Pi tab's background per two configurable states (`runningColor` and `notRunningColor`, for when the agent is running or not running respectively); gracefully no-ops if another terminal emulator is used

- ◐ [`editor-enhancements/`](editor-enhancements/) ([README](./editor-enhancements/README.md))
  - Composite editor extension that makes multiple `setEditorComponent()`-based UX tweaks simultaneously compatible
  - Configurable via two sibling files in the extension folder:
    - `editor-enhancements/config.json` for editor-level behavior such as slash command remapping and `doubleEscapeCommand`
    - `editor-enhancements/file-picker.json` for file picker behavior such as `tabCompletionMode` (default: `"bestMatch"`)
  - Includes a merged, single-editor implementation of:
    - ◐ `file-picker` (upstream: [laulauland/dotfiles](https://github.com/laulauland/dotfiles))
       - type `@` to open an overlay file browser and insert `@path` refs
       - This version adds zsh support and enables compatibility with the other two
       - Search input now uses Pi's shared `Input` editing behavior
       - `space` queues files or enters directories; `enter` inserts the highlighted item plus queued selections; `esc` at the root inserts queued selections only
       - `shift+tab` (not `tab`) toggles the options panel
       - `tab` is configurable via `editor-enhancements/file-picker.json`:
         - `"segment"`: prefix-only candidate matching, then complete one word-part at a time
         - `"bestMatch"`: strongest scoped fuzzy match, applied in one step
       - In options mode, both `←/→` and `↑/↓` move between options
    - ◐ `shell-completions` (upstream: [laulauland/dotfiles](https://github.com/laulauland/dotfiles))
      - native shell completions in `!`/`!!` bash mode
      - This version adds zsh support and enables compatibility with the other two
    - ◐ `raw-paste` (upstream: [tmustier/pi-extensions](https://github.com/tmustier/pi-extensions))
      - `/paste` arms raw paste for the next paste operation
      - This version adds `alt+v` performing both arm + paste directly from the clipboard, preserving newlines and bypassing Pi's large-paste markers (e.g. `[paste #3 +122 lines]`)
  - When enabled, disable the standalone `shell-completions/`, `file-picker.ts`, and `raw-paste.ts` extensions to avoid editor-component conflicts

- ◐ [`rewind/`](rewind/) ([README](./rewind/README.md); upstream: [nicobailon/pi-rewind-hook](https://github.com/nicobailon/pi-rewind-hook))
  - Differences from the original:
    - Records exact file-state rewind points and offers restore options during `/fork` and `/tree` navigation, including undo
    - Rewind history survives across forks, resumes, tree navigation, and compaction; rewind points resolve across session lineage via `parentSession` links
    - Optional configurable retention (`maxSnapshots`, `maxAgeDays`, `pinLabeledEntries`); without it, exact history is kept indefinitely
    - Relocates "Keep current files" to the first option of the "Restore Options" menu of `/tree`, and relocates "Conversation only (keep current files)" to the first option of the "Restore Options" menu of `/fork`

- ◐ [`agentic-compaction/`](agentic-compaction/) ([README](./agentic-compaction/README.md); upstream: [laulauland/dotfiles](https://github.com/laulauland/dotfiles/tree/main/shared/.pi/agent/extensions/file-based-compaction))
  - Agentic compaction via a virtual filesystem: mounts `/conversation.json` and lets a summarizer model explore it with portable bash/zsh commands
  - Emphasizes deterministic, tool-result-verified modified-file tracking (native + `rp`), filters likely temp artifacts, supports `/compact <note>`, and can parallelize tool calls via `toolCallConcurrency`
  - ⚠ Hooks `session_before_compact` — incompatible with other extensions that do the same (e.g. `grounded-compaction`); having both active is a race condition

- ◐ [`files-touched.ts`](files-touched.ts) (upstream: [badlogic/pi-mono `.pi/extensions/files.ts`](https://github.com/badlogic/pi-mono/blob/main/.pi/extensions/files.ts))
  - `/files-touched` shows files read/written/edited in the active session branch and opens the selected file in VS Code
  - This version extends the upstream original to also detect file reads/edits/writes performed through the tools of `repoprompt-mcp` and `repoprompt-cli` (`rp`, `rp_exec`) and their `read_file` / `file_actions create` / `apply_edits` actions
  - It also normalizes relative, root-prefixed, and absolute spellings of the same file before rendering, and carries touched paths through tracked file moves
  - Shared core ([`_shared/files-touched-core.ts`](_shared/files-touched-core.ts)) also tracks bash-level file operations: `sed -i` (edit), `cp`/`rsync` (write destination), `tee`/`touch` (write), `patch` (edit), `curl -o`/`wget -O` (write), and shell output redirections (`>`, `>>`)

- ◐ [`branch-out/`](branch-out/) ([README](branch-out/README.md)) (upstream: [davidgasquez/dotfiles](https://github.com/davidgasquez/dotfiles/blob/main/agents/pi/extensions/branch-term.ts))
  - `/branch [--model <query>] [message]` forks the current session into a new terminal split pane or tab; backend-aware routing across cmux, tmux, iTerm2, Terminal.app, and Ghostty; split direction is config-driven (`left/right/up/down`, or `clockwise`/`counterclockwise` layout policies for cmux/tmux) with comma-separated fallback lists for cross-backend configs; optional `--model` targets a different model in the child; optional `message` prefills the child editor with a 10-second auto-submit countdown

- ◐ [`handover/`](handover/) ([README](./handover/README.md))
  - `/handover [optional purpose]` generates a rich handover / rehydration message, forks from the first user message, and prefills the child editor with the final draft plus an appended files-touched block
  - Borrows heavily from [pasky/pi-amplike](https://github.com/pasky/pi-amplike) and [damianpdr/pi-handoff](https://github.com/damianpdr/pi-handoff) (both inspired by Amp's /handoff feature), and [mitsuhiko's handoff prompt](https://github.com/mitsuhiko/agent-stuff/blob/main/commands/handoff.md)
  - Unique to this `handover`:
    - Draft is generated by the current session agent/model (via `pi.sendUserMessage(...)`) rather than a direct `complete()` call
    - Forks the session from its first message, creating parent-child lineage that helps with future discovery and tools like `session_lineage` and `session_ask`
    - Robust correlation: waits for a quiescent session + uses a per-run nonce to extract the correct assistant reply
    - Uses a more opinionated continuation prompt separating verified status, decisions, surprises, rejected paths, facts vs inferences, mandatory reading, and next steps, with guardrails against exhaustive file-list restatements
    - Adds prior compaction summaries from the current session JSONL when they exist
    - Gives the drafting model a deterministic files-touched list derived from [`_shared/files-touched-core.ts`](_shared/files-touched-core.ts) (which covers Pi native tools, RepoPrompt tools, and bash-level file operations) and appends that same list to the child draft
    - If [`rewind/`](rewind/) is installed, requests a conversation-only fork
  - Optional auto-submit countdown (typing or `Esc` cancels; `Enter` submits normally)
  - Plays well with [`session-ask/`](session-ask/) because the preserved fork lineage lets `session_ask` consult parent sessions when needed

- ◐ [`extension-stats.ts`](extension-stats.ts)
  - `/extension-stats` shows rolling 7/30/60/90-day usage metrics from session logs, grouped by extension and tool
  - Use ↑/↓ to page, press `m` to toggle whether the metric is based on count of tool calls or on tokens attributed to tool calls
  - Adapted from `session-breakdown.ts` of [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff)

<p align="center">
  <img width="720" alt="extension stats widget" src="https://github.com/user-attachments/assets/b1a2b8eb-0880-44f5-8ae2-2b8aa8221318" />
</p>

- ◐ [`plan-mode.ts`](plan-mode.ts) (upstream: [pi-mono examples](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/examples/extensions))
  - `/plan` (and `ctrl+alt+p`) toggles a read-only sandbox
  - No todo extraction or step execution prompting (planning stays on the user)
  - Removes Pi-native write tools from the active Pi tool list, blocks destructive shell commands, and blocks RepoPrompt write operations while leaving other available tools alone
  - Adds just-bash AST-backed bash command inspection (requires `just-bash` >= 2; regex fallback if parse fails)
    - Covers `rp_exec`, `rp-cli -e ...`, and `rp` (repoprompt-mcp)

- ◐ [`oracle.ts`](oracle.ts) (upstream: [hjanuschka/shitty-extensions](https://github.com/hjanuschka/shitty-extensions/tree/main))
  - `/oracle` queries an alternate model for a second opinion, with optional file inclusion (`-f`) and injection into the current conversation
  - This version adds a thinking-level picker and fixes text-overflow crashes (CJK-safe wrapping)

- ◐ [`session-switch.ts`](session-switch.ts) (upstream: [pi-thread-switcher](https://github.com/damianpdr/pi-thread-switcher))
  - Session switching (via `/switch-session` command) with a live preview of the highlighted session below the picker
  - `Shift+Up`/`Down` scroll preview by line, `Shift+Left`/`Right` page preview
  - This version mirrors the native `/resume` picker's layout, behaviors, and keybindings

<p align="center">
  <img width="450" alt="/switch-session demo" src="https://raw.githubusercontent.com/w-winter/dot314/main/assets/switch-session-demo.gif" />
</p>

- ◐ [`tools/`](tools/) (upstream: [pi-mono examples](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/examples/extensions))
  - `/tools` interactive enable/disable UI
  - This version persists tool enablement globally ([`tools/tools.json`](tools/tools.json)) and per-session via session entries

- ◐ [`usage-bar.ts`](usage-bar.ts) (upstream: [hjanuschka/shitty-extensions](https://github.com/hjanuschka/shitty-extensions/tree/main))
  - `/usage` quota overlay for multiple providers, with provider status polling and reset countdowns
  - This version:
    - Supports multiple Codex accounts with automatic workspace deduplication
    - Displays used percentage with 5-band color scale (0-49% green → 95%+ red) and proper label alignment
    - Provider status emoji hidden on fetch errors to avoid misleading indicators
    - Adds `alt+u` shortcut

- ◐ [`sandbox/`](sandbox/) - OS-level sandboxing using `@anthropic-ai/sandbox-runtime` with per-project config (upstream: [pi-mono examples](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/examples/extensions))
  - Configured in [`sandbox/sandbox.json`](sandbox/sandbox.json)
  - This version:
    - Sandboxes LLM `bash` calls via `tool_call` input mutation instead of re-registering `bash`, so it can coexist with renderer-only `bash` overrides such as [`MasuRii/pi-tool-display`](https://github.com/MasuRii/pi-tool-display)
    - Has a more minimalist statusline indicator
    - Allows toggling on/off via `/sandbox on` / `/sandbox off`, or `/sandbox` -> menu selection, or the keybinding `alt+S`

- ◐ [`cmux/`](cmux/) (upstream: [HazAT/pi-config](https://github.com/HazAT/pi-config/blob/main/extensions/cmux/index.ts))
  - cmux integration — pushes Pi agent state (model, thinking level, tokens, cost, tool activity) into the cmux sidebar; fire-and-forget, no-op when `CMUX_SOCKET_PATH` is unset
  - This version adds workspace auto-renaming: on `session_start`, `session_switch`, `session_fork`, and `agent_end`, syncs the cmux workspace name to the Pi session name using `CMUX_WORKSPACE_ID` so concurrent cmux workspaces do not cross-rename (only when the workspace has exactly 1 pane and 1 surface)

- ○ [`inline-bash.ts`](inline-bash.ts) (upstream: [pi-mono examples](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/examples/extensions))
- ○ [`interactive-shell.ts`](interactive-shell.ts) (upstream: [pi-mono examples](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/examples/extensions))
- ○ [`preset.ts`](preset.ts) (upstream: [pi-mono examples](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/examples/extensions))
- ○ [`status-line.ts`](status-line.ts) (upstream: [pi-mono examples](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/examples/extensions))
- ○ [`titlebar-spinner.ts`](titlebar-spinner.ts) (upstream: [pi-mono examples](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/examples/extensions))
- ○ [`skill-palette/`](skill-palette/) (upstream: [nicobailon/pi-skill-palette](https://github.com/nicobailon/pi-skill-palette))
- ○ [`subagent/`](subagent/) (upstream: [nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents))
- ○ [`pi-prompt-template-model/`](pi-prompt-template-model/) (upstream: [nicobailon/pi-prompt-template-model](https://github.com/nicobailon/pi-prompt-template-model))
- ○ [`code-actions/`](code-actions/) (upstream: [tmustier/pi-extensions](https://github.com/tmustier/pi-extensions))
  - `/code` to pick code blocks or inline code from recent assistant messages, then copy or insert
  - `run` now executes snippets in a just-bash OverlayFs sandbox by default on non-Windows (copy-on-write over cwd), with optional fallback to real shell when sandbox commands are unsupported
  - Type to search; enter to copy, right arrow to insert in the command line
- ○ `todos.ts` (upstream: [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff))