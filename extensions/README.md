# Extensions

| Symbol | Meaning |
|--------|-------------------------|
| ● | original |
| ◐ | forked & modified |
| ○ | republished unmodified |

- ● [`assistant-provenance/`](assistant-provenance/) ([README](./assistant-provenance/README.md))
  - Gives models awareness of mid-session model switches by injecting compact handoff notes into the provider context at transition boundaries
  - Handoff notes are token-efficient, do not invalidate cache, are not redundantly rendered in the TUI, and are not persisted to session files
  - Configurable `silentModelGroups` suppress transitions within the same model family (e.g. claude-opus → claude-sonnet)

- ● [`grounded-compaction/`](grounded-compaction/) ([README](./grounded-compaction/README.md))
  - Replaces Pi's compaction summarizer with configurable model presets, user-editable prompt contracts, and deterministic files-touched tracking that covers Pi native tools, RepoPrompt, recognized shell operations, and Codex `apply_patch`; also augments branch summarization during `/tree` with the same files-touched grounding and optional prompt customization
  - Supplies plaintext summaries to [`codex-compaction-coordinator`](codex-compaction-coordinator/) when another provider needs visible history covered by a native checkpoint
  - Uses the shared collector from [`_shared/files-touched-core.ts`](_shared/files-touched-core.ts); see [Pi compaction docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/compaction.md) for background

- ● [`codex-compaction-coordinator/`](codex-compaction-coordinator/) ([README](./codex-compaction-coordinator/README.md))
  - Makes visible history covered by durable OpenAI Responses V2 checkpoints available to other providers through reusable plaintext summaries, with lazy and prewarm modes
  - Works with [`@howaboua/pi-codex-conversion`](https://www.npmjs.com/package/@howaboua/pi-codex-conversion) and other compatible Responses V2 checkpoint extensions

- ● [`model-aware-compaction/`](model-aware-compaction/) ([README](./model-aware-compaction/README.md))
  - Triggers Pi's **built-in auto-compaction** at per-model percent-used thresholds (0-100), configured via `config.json` (keyed by model ID, supports `*` wildcards)
  - Nudges Pi's native compaction pipeline rather than calling `ctx.compact()`, preserving the compaction UI and automatic queued-message flush
  - Requires `compaction.enabled: true` in settings; see README for `reserveTokens` tuning

- ● [`context-limit-fallback/`](context-limit-fallback/) ([README](./context-limit-fallback/README.md))
  - Offers a per-session switch to a configured larger-context model at the first native reserve-token or valid model-aware percentage boundary
  - `/context-limit-fallback` stores a branch-local session choice; choices survive resume, follow fork ancestry, and are restored by `/tree` navigation
  - Loads immediately before `model-aware-compaction`, switches only on eligible completed runs, and leaves compaction behavior with Pi

- ● [`session-ask/`](session-ask/) ([README](./session-ask/README.md))
  - `session_ask({ question, sessionPath? })` queries the current (or specified) session JSONL (including pre-compaction history) without bloating the current model context; `/session-ask ...` is a UI wrapper
  - `session_lineage({ ... })` returns fork ancestry (parentSession chain)
  - Internal `session_shell` uses a read-only just-bash virtual FS (`/conversation.json`, `/transcript.txt`, `/session.meta.json`) for precise extraction with `jq`/`rg`/`awk`/`wc`
  - Optional minimal fork-lineage system prompt injection via `injectForkHintSystemPrompt` (see README)
  - Configurable model/prompt via `config.json`, optionally pointing at an agent definition under `~/.pi/agent/agents/`

- ● [`repoprompt-mcp/`](repoprompt-mcp/) ([README](./repoprompt-mcp/README.md))
  - Pi-compatible, token-efficient proxy for the RepoPrompt MCP server with:
    - Supports both RepoPrompt CE and Classic targets via `/rp app`
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

- ● [`pi-codex-apply-patch-display/`](pi-codex-apply-patch-display/) ([README](./pi-codex-apply-patch-display/README.md))
  - Adaptive split/unified diff rendering with word-level highlights for `@howaboua/pi-codex-conversion`'s `apply_patch`:

<p align="center">
  <img width="450" alt="apply_patch rendering example" src="https://github.com/user-attachments/assets/f84c793a-b74d-41e6-8069-ad25bf5b8508" />
</p>


- ● [`repoprompt-cli/`](repoprompt-cli/) ⚠ **Deprecated and not supported for Pi versions >0.64.0; use [`repoprompt-mcp/`](repoprompt-mcp/) instead.**
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
  - `/anycopy` mirrors all behaviors of Pi's native `/tree` while adding a live, syntax-highlighted preview of each node's content, the ability to copy any node(s) to the clipboard, and optional node creation timestamps
  - `Enter` navigates to focused node (same semantics as `/tree`, including the summary chooser and `branchSummary.skipPrompt` support)
  - `Shift+A` selects or deselects individual nodes, `Shift+R` adds an inclusive range, and `Shift+C` copies while retaining the selection. Tool-result previews and clipboard output include the originating call
  - An optional copy-only shortcut preserves the editor draft. `Tab` toggles tree-focused and preview-focused layouts. `?` shows available native tree and anycopy keybindings
  - `Shift+Up`/`Down` scroll preview by line, `Shift+PageUp`/`PageDown` page preview
  - Single-node copies use just the node's content; role prefixes are only added when copying 2+ nodes
  - Custom entries use readable labeled content in previews and clipboard output, with timestamps shown in the local time zone
  - Multi-selected nodes are auto-sorted chronologically (by tree position)
  - Configure the shortcut, hint mode, layout ratios, tree filter, fold persistence, and overlay keys in `anycopy/config.json`

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
  - If [pi-rewind-hook](https://github.com/nicobailon/pi-rewind-hook) is installed, it requests rewind's conversation-only fork mode ("keep current files") for that fork

- ● [`move-session.ts`](move-session.ts)
  - `/move-session <targetCwd>` moves the *current session* to a different working directory, intended for when you started pi in one folder but come to find that you need it in another after building up valuable context
  - `/move-session $main-worktree` moves the session to the repository's main Git worktree, useful when retiring a linked worktree after preserving a valuable session
  - Forks the session JSONL into the target cwd bucket (`SessionManager.forkFrom(...)`), clears the fork header's `parentSession` pointer, then relaunches `pi --session <fork>` with `cwd=<targetCwd>` so the footer + built-in tools resolve relative paths against the new directory
  - Uses `trash` to delete the old session file (best-effort); if `trash` isn't available, it leaves the old file in place
  - Supports `~` expansion (e.g. `/move-session ~/code/my-project`)

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

- ● [`protect-paths/`](protect-paths/) - standalone directory and command protection hooks that complement upstream [`@aliou/pi-guardrails`](https://github.com/aliou/pi-guardrails)
  - Hard blocks `.git/` and untrusted `node_modules/` access from file tools and Bash commands, plus Homebrew install and upgrade commands
  - Uses just-bash AST analysis to inspect nested command structures, including substitutions, functions, and conditionals
  - Confirms broad delete commands (`rm`/`rmdir`/`unlink`) and piped shell execution (`... | sh`)
  - Allows known read-only commands to inspect roots listed in `trustedReadPaths`; copy [`config.json.example`](protect-paths/config.json.example) to `config.json` and edit the absolute paths
  - Pair with `pi install npm:@aliou/pi-guardrails` for `.env` file protection

- ● `reverse-thinking.ts` - Adds backward (e.g. 'med' -> 'low') cycling movement through thinking levels via `shift+alt+tab`

- ● [`iterm-tab-color.ts`](iterm-tab-color.ts)
  - Uses iTerm2 OSC tab-color sequences to color each Pi tab's background per two configurable states (`runningColor` and `notRunningColor`, for when the agent is running or not running respectively); gracefully no-ops if another terminal emulator is used

- ● [`inline-shell.ts`](inline-shell.ts)
  - Expands inline `!{command}` snippets in normal messages before submit
  - Also routes leading `!command` / `!{command}` bash-mode execution through the resolved shell, so aliases from the active shell environment can work there too
  - Uses the current shell when supported; for zsh it prefers `~/.pi/agent/shell/pi-inline.zsh`, otherwise falls back to interactive zsh and `.zshrc`; unsupported or non-zsh cases fall back to bash
  - Sets `PI_INLINE_SHELL=1` in the spawned shell so shell startup can skip noisy prompt/plugin setup while still loading aliases/functions
  - Example starter file: [`../shell/pi-inline.zsh.example`](../shell/pi-inline.zsh.example)

- ● [`skill-templates/`](skill-templates/) ([README](./skill-templates/README.md))
  - Renders `SKILL.template.md` with Nunjucks for explicit skill invocations; `{% skill %}` recursively renders another skill body in the shared invocation context, while the final prompt keeps one root `<skill>` envelope and one root reference base

- ● [`subagent-bridge/`](subagent-bridge/) ([README](./subagent-bridge/README.md))
  - Gives subagents spawned or resumed in the current orchestrator short, stable handles usable with `subagent_resume` and `intercom` in place of `.jsonl` paths or session UUIDs; requires `pi-interactive-subagents` and `pi-intercom`
  - `subagent_resume({ sessionPath: "idle-worker" })` — handle is rewritten to the child's real session file path before upstream validation
  - `intercom({ to: "@idle-worker", ... })` (parent side) — handle is rewritten to the child's current intercom target, so the orchestrator can steer a running child with the same vocabulary used for resume
  - `intercom({ to: "@parent", ... })` (child side) — rewritten to the current orchestrator's intercom target; lighter alternative to `caller_ping` for clarification questions since the child keeps running while it waits for a reply
  - Handles derive from the display name with deterministic collision suffixing (`-2`, `-3`, ...) and are parent-local; the list is regenerated each turn from what this session has actually launched or resumed (not from agent definitions on disk)
  - Minimal factual `before_agent_start` hint surfaces only the affordances actually available; sidecar state lives at `<sessionDir>/subagent-bridge/<parentSessionId>/registry.json` (parent) and `<childSessionFile>.subagent-bridge.json` (child)

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

- ◐ [`files-touched.ts`](files-touched.ts) (upstream: [badlogic/pi-mono `.pi/extensions/files.ts`](https://github.com/badlogic/pi-mono/blob/main/.pi/extensions/files.ts))
  - `/files-touched` shows files read/written/edited in the active session branch and opens the selected file in VS Code
  - This version extends the upstream original to also detect file reads/edits/writes performed through the tools of `repoprompt-mcp` and `repoprompt-cli` (`rp`, `rp_exec`) and their `read_file` / `file_actions create` / `apply_edits` actions
  - Codex coverage includes recognized shell operations through `exec_command` and structured `apply_patch` changes
  - It also normalizes relative, root-prefixed, and absolute spellings of the same file before rendering, and carries touched paths through tracked file moves
  - Shared core ([`_shared/files-touched-core.ts`](_shared/files-touched-core.ts)) also tracks bash-level file operations: `sed -i` (edit), `cp`/`rsync` (write destination), `tee`/`touch` (write), `patch` (edit), `curl -o`/`wget -O` (write), and shell output redirections (`>`, `>>`)

- ◐ [`branch-out/`](branch-out/) ([README](branch-out/README.md)) (upstream: [davidgasquez/dotfiles](https://github.com/davidgasquez/dotfiles/blob/main/agents/pi/extensions/branch-term.ts))
  - `/branch [--model <query>] [message]` forks the current session into a new terminal split pane or tab; backend-aware routing across cmux, tmux, iTerm2, Terminal.app, Ghostty, and Orca; split direction is config-driven (`left/right/up/down`, or `clockwise`/`counterclockwise` layout policies for cmux/tmux) with comma-separated fallback lists for cross-backend configs; optional `--model` targets a different model in the child; optional `message` prefills the child editor with a 10-second auto-submit countdown

- ◐ [`btw/`](btw/) ([README](btw/README.md)) (upstream: [pasky/pi-amplike](https://github.com/pasky/pi-amplike/blob/main/extensions/btw.ts))
  - `/btw [--mode <name>] [--model <provider/id|partial>] <prompt>` runs a persisted child agent in the background while the current session continues working
  - Inherits upstream's live progress and result rendering, parent-linked child sessions, compaction continuation, optional child-extension loading, and non-interactive Amp permission enforcement
  - Uses conventional `--mode` and `--model` options instead of upstream's single-dash forms
  - Resolves exact or fuzzy model queries within the session's scoped models, preferring the current provider while trying ranked matches until one has usable request authentication
  - Passes the selected model's resolved API key, headers, and environment through Pi's current `ModelRuntime` request path, with a direct reauthentication error for missing OpenAI Codex OAuth
  - Gives the child Pi's complete projected session context, including active compaction and branch-summary state, instead of serializing only raw message entries
  - Parses compound Bash commands with `just-bash`; every simple command must resolve to `allow`, and unparseable commands are blocked unless `permissions.mode` is `yolo`

- ◐ [`pi-claude-bridge/`](pi-claude-bridge/) ([README](pi-claude-bridge/README.md)) (upstream: [Eli Dickinson's `vanillagreencom/kendex`](https://github.com/vanillagreencom/kendex/tree/main/pi-extensions/pi-claude-bridge))
  - Routes `pi-claude/*` models through a logged-in Claude Code account while Pi retains its terminal interface, tools, session history, effort controls, and optional connector access
  - Sends Pi's complete effective system prompt as the custom prompt supplied to the Claude Agent SDK on every query, including resumed sessions, instead of selectively appending context to Claude Code's preset prompt
  - Uses bridge-owned, trust-scoped `systemPrompt` settings for replacing the base prompt, optionally naming the active model, and preserving Pi-managed project context and skills
  - Removes upstream's selective prompt-forwarding controls, enables strict MCP configuration for every query, and loads none of Claude Code's filesystem settings by default unless connectors are enabled

- ◐ [`image-url-broker/`](image-url-broker/) ([README](image-url-broker/README.md)) (design source: [can1357/oh-my-pi blob broker](https://github.com/can1357/oh-my-pi/tree/main/packages/coding-agent/src/blob-broker))
  - Publishes JPEG, PNG, GIF, and WebP data to a configured static HTTPS directory and replaces repeated inline base64 in supported Anthropic and OpenAI provider requests with content-addressed URLs
  - Keeps ordinary base64 image data in Pi sessions and retries a failed Codex URL request once with inline image data

- ◐ [`pi-codex-goal/`](pi-codex-goal/) ([README](pi-codex-goal/README.md)) (upstream: [fitchmultz/pi-codex-goal](https://github.com/fitchmultz/pi-codex-goal))
  - Adds durable `/goal` tracking, model-callable goal tools, budget and elapsed-time accounting, automatic continuation, compaction recovery, and provider-limit recovery
  - This version schedules mid-run compaction at the next `context` event before a provider request after a qualifying turn that uses a tool, so Pi persists the complete tool call and result before compaction changes provider context
  - Updates the smoke test that exercises Pi's SDK runtime to use the `ModelRuntime` API

- ◐ [`pi-queue-steer/`](pi-queue-steer/) ([README](pi-queue-steer/README.md)) (upstream: [tmustier/pi-queue-steer](https://github.com/tmustier/pi-queue-steer))
  - Shows independent, editable steering and follow-up queues while preserving Pi's native delivery timing
  - Adds `/followup <message>`, `/steer <message>` while editing a follow-up, and symmetric `Option+Enter` conversion between queue lanes
  - Emits a content-free accepted-steering event used by `pi-repoprompt-mcp` to interrupt attended RepoPrompt waits as soon as Pi accepts steering

- ◐ [`screenshots-picker/`](screenshots-picker/) ([README](screenshots-picker/README.md)) (upstream: [Graffioh/pi-screenshots-picker](https://github.com/Graffioh/pi-screenshots-picker))
  - Browses and stages screenshots from configurable sources, then attaches them to the next prompt
  - Adds sent-screenshot previews that follow Pi's image visibility and resizing settings, plus metadata previews for Orca terminals
  - Uses `Ctrl+\`` to open the picker and `Ctrl+1` to clear staged screenshots, reports picker-based clears, opens files in the system image viewer, imports the current `@earendil-works` Pi packages, and updates `glob` to 13.0.6

- ◐ [`stash/`](stash/) ([README](stash/README.md)) (upstream: [saadjs/pi stash](https://github.com/saadjs/pi/tree/main/extensions/stash))
  - A configurable shortcut stashes the current editor text, restores it into an empty editor, or swaps it with another draft
  - Keeps one session-local text stash and shows its presence in the footer

- ◐ [`handover/`](handover/) ([README](./handover/README.md))
  - `/handover [optional purpose]` generates a rich handover / rehydration message, forks from the first user message, and prefills the child editor with the final draft plus an appended files-touched block
  - Borrows heavily from [pasky/pi-amplike](https://github.com/pasky/pi-amplike) and [damianpdr/pi-handoff](https://github.com/damianpdr/pi-handoff) (both inspired by Amp's /handoff feature), and [mitsuhiko's handoff prompt](https://github.com/mitsuhiko/agent-stuff/blob/main/commands/handoff.md)
  - Unique to this `handover`:
    - Draft is generated by the current session agent/model (via `pi.sendUserMessage(...)`) rather than a direct `complete()` call
    - Forks the session from its first message, creating parent-child lineage that helps with future discovery and tools like `session_lineage` and `session_ask`
    - Robust correlation: waits for a quiescent session + uses a per-run nonce to extract the correct assistant reply
    - Uses a more opinionated continuation prompt separating verified status, decisions, surprises, rejected paths, facts vs inferences, mandatory reading, and next steps, with guardrails against exhaustive file-list restatements
    - Adds prior compaction summaries from the current session JSONL when they exist
    - Gives the drafting model a deterministic files-touched list derived from [`_shared/files-touched-core.ts`](_shared/files-touched-core.ts) (which covers Pi native tools, RepoPrompt tools, recognized shell operations through `bash` and `exec_command`, and structured `apply_patch` changes) and appends that same list to the child draft
    - If [pi-rewind-hook](https://github.com/nicobailon/pi-rewind-hook) is installed, requests a conversation-only fork
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
    - Covers `rp_exec`, `rp-cli -e ...`, `rpce-cli -e ...`, and `rp` (repoprompt-mcp)

- ◐ [`session-switch/`](session-switch/) (upstream: [pi-thread-switcher](https://github.com/damianpdr/pi-thread-switcher))
  - Session switching via `/switch-session`, or the same picker after interactive startup via `pi --switch-session`, with a live preview of the highlighted session and its latest message time below the picker
  - `pi --switch-session` is an extension-driven relaunch workaround, not native pre-start `--resume`, so it does not provide native missing-cwd recovery or the normal in-process session-switch lifecycle / shutdown-hook cleanup semantics
  - `Shift+Up`/`Down` scroll preview by line, `Shift+PageUp`/`PageDown` page preview
  - Mirrors the native `/resume` picker's layout, behaviors, and keybindings

<p align="center">
  <img width="450" alt="/switch-session demo" src="https://raw.githubusercontent.com/w-winter/dot314/main/assets/switch-session-demo.gif" />
</p>

- ◐ [`tool-horizon/`](tool-horizon/) ([README](tool-horizon/README.md)) (upstream: [crstdr/diligent-pi `diligent-context`](https://github.com/crstdr/diligent-pi/tree/main/extensions/diligent-context))
  - Keeps user messages and assistant prose in model context while hiding older tool calls and their results before a selected horizon
  - Replaces the upstream flat, reverse-chronological payload picker with Pi's session-tree picker for the current branch in native tree order, initially focused on the newest selectable entry; adds a scrolling preview, filtering, unavailable-row explanations, right-aligned savings, and stale-selection rejection
  - Resolves tree rows against the exact outgoing payload, follows current Pi context projection and compaction semantics, and rebuilds caches across session starts, tree navigation, forks, switches, completed turns, and context transforms
  - Stores the horizon and its deterministic file-provenance checkpoint as adjacent branch-local entries; provenance covers Pi file tools, RepoPrompt, Codex filesystem tools, nested Code/Notebook calls, and literal `rp-cli` or `rpce-cli` commands
  - Restores all tool history after compaction by default, including compaction inside an active run, and can retain the horizon when `restoreAllAfterCompaction` is disabled

- ◐ [`tools/`](tools/) (upstream: [pi-mono examples](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/examples/extensions))
  - `/tools` interactive enable/disable UI
  - This version persists tool enablement globally ([`tools/tools.json`](tools/tools.json)) and per-session via session entries

- ◐ [`sandbox/`](sandbox/) - OS-level sandboxing using `@anthropic-ai/sandbox-runtime` with per-project config (upstream: [pi-mono examples](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/examples/extensions))
  - Configured in [`sandbox/sandbox.json`](sandbox/sandbox.json)
  - This version:
    - Sandboxes LLM `bash` calls via `tool_call` input mutation instead of re-registering `bash`, so it can coexist with renderer-only `bash` overrides such as [`MasuRii/pi-tool-display`](https://github.com/MasuRii/pi-tool-display)
    - Has a more minimalist statusline indicator
    - Allows toggling on/off via `/sandbox on` / `/sandbox off`, or `/sandbox` -> menu selection, or the keybinding `alt+S`

- ◐ [`cmux/`](cmux/) (upstream: [HazAT/pi-config](https://github.com/HazAT/pi-config/blob/main/extensions/cmux/index.ts))
  - cmux integration — pushes Pi agent state (model, thinking level, tokens, cost, tool activity) into the cmux sidebar; fire-and-forget, no-op when `CMUX_SOCKET_PATH` is unset
  - This version adds workspace auto-renaming: on `session_start` and `agent_end`, syncs the cmux workspace name to the Pi session name using `CMUX_WORKSPACE_ID` so concurrent cmux workspaces do not cross-rename (only when the workspace has exactly 1 pane and 1 surface)

- ● [`orca-session-tab-title/`](orca-session-tab-title/) — renames the containing Orca tab to the active named Pi session on session start and `/name`, using the durable leaf identity from `ORCA_PANE_KEY` to target the correct tab across split panes and Orca restarts

- ● [`computer-use-toggle.ts`](computer-use-toggle.ts) — `/computer-use-toggle on|off` toggles [`pi-computer-use`](https://github.com/injaneity/pi-computer-use) and reloads Pi resources, removing its tool descriptions from system context when off

- ○ [`interactive-shell.ts`](interactive-shell.ts) (upstream: [pi-mono examples](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/examples/extensions))
- ○ [`preset.ts`](preset.ts) (upstream: [pi-mono examples](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/examples/extensions))
- ○ [`status-line.ts`](status-line.ts) (upstream: [pi-mono examples](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/examples/extensions))
- ○ [`titlebar-spinner.ts`](titlebar-spinner.ts) (upstream: [pi-mono examples](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/examples/extensions))
- ○ [`code-actions/`](code-actions/) (upstream: [tmustier/pi-extensions](https://github.com/tmustier/pi-extensions))
  - `/code` to pick code blocks or inline code from recent assistant messages, then copy or insert
  - `run` now executes snippets in a just-bash OverlayFs sandbox by default on non-Windows (copy-on-write over cwd), with optional fallback to real shell when sandbox commands are unsupported
  - Type to search; enter to copy, right arrow to insert in the command line
- ○ `todos.ts` (upstream: [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff))
