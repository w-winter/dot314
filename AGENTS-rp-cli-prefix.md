# **The Following Guidance Supersedes Your Prior Tool Guidance**

## RepoPrompt Tools (**You Are Required To Use These Preferentially**)

Before ANY file/repo exploration:
1. Run `rp-cli -e 'windows'` to list windows (if single-window mode: open another RepoPrompt window (⌘N), run `refresh`, then re-run `windows`)
2. Call `rp_bind(windowId, tab)` to bind
3. ONLY THEN proceed with `rp_exec` for all repo operations

DO NOT use `bash` for: ls, find, grep, cat, wc, tree, or any file exploration.
DO NOT use Pi's `grep`, `find`, `ls`, `write`, or `edit` tools.
DO NOT use Pi's `read` tool for any files except `*/SKILL.md`. Besides when encountering `*/SKILL.md`, do not use `read`.
Use the RepoPrompt tools instead, which are more effective and are required for our workflows.

**If you catch yourself typing `bash` + any file exploration command, STOP and use rp_exec instead.**

- Use the `rp_exec` tool for all RepoPrompt operations (it wraps `rp-cli` with safer defaults). ALWAYS use RepoPrompt tools instead of native shell tools for repo navigation, search, reading, and edits
- In environments where `rp-cli` is not exposed as a first-class tool, still use it by running it through the shell (e.g. via the `bash` tool): `rp-cli -e '…'`.
- Fallback to native shell/tools ONLY if (a) `rp-cli` is not installed / not on PATH, or (b) `rp-cli` fails for the specific action after 1 retry, or (c) reading a Skill file (`*/SKILL.md`) which must use the native file read tool.
  - To clarify that exception: for `*/SKILL.md` only, use the native `read` tool (not `rp-cli read`). Do not generalize this exception to other `.md` files.
  - Unexpected output (wrong files/paths/empty results) is usually a wrong workspace/window/tab issue, not a `rp-cli` failure. Do not fall back to native tools; fix routing/workspace first
- Prefer **high-level CLI commands** (`tree`, `search`, `read`, `structure`, `select`, `context`, `edit`) over raw tool calls (`call … {json}`). Use raw tool calls only when you need exact parameters or routing (`_windowID`, `_tabID`)
- Keep context small: select only what you need; avoid dumping huge trees or whole-repo contexts unless explicitly requested

### Window/Tab Routing

- **Bind first:** before any non-trivial work, call `rp_bind` to pin `rp_exec` to a specific RepoPrompt **window_id** and
  **compose tab** (ask the user if you’re unsure which to use)
- **If `rp_exec` is unbound:** only run `windows` / `workspace list` (and `workspace switch "<name>" --new-window` if needed) until you can bind; do not run `tree/search/read/edit`
- **Never switch workspaces in an existing window:** bind to a window already showing the workspace, or open it via `workspace switch "<name>" --new-window` (switching without `--new-window` clobbers selection/prompt/context and may disrupt other sessions). Only repurpose a window if the user explicitly says it’s safe
- **If results look wrong:** assume wrong workspace/root first (not “RepoPrompt is broken”). Run `tree` (no args) to confirm which root(s) you’re in, then open the correct workspace in a new window and bind before retrying
- **Single-window mode:** if `windows` reports single-window mode, avoid repurposing the only window. Ask the user to open a new window (⌘N) or open one via `workspace switch "<name>" --new-window`, then run `refresh`, re-run `windows`, and bind
- **Workspace/window lifecycle:** `workspace create/switch ... --new-window` may open a new window, and `workspace delete ... --close-window` may close one. If you open/close windows, re-run `windows` and re-bind `rp_exec` to the correct `window_id` + tab
- **Repo not in any workspace?:** RepoPrompt can only `tree/search/read` within workspace root folders. Use `workspace list` to find a workspace that already includes the folder, then prefer `workspace switch "<name>" --new-window`; otherwise use `workspace create "Temp" --folder-path /abs/path --new-window`
- **Manual bind shortcut:** you (the user) can run `/rpbind <window_id> <tab>` in pi to set the binding interactively
- **Avoid `bash` for rp-cli:** pi’s `bash` tool output is injected into the model context; prefer `rp_exec` so output is
  smaller and consistently formatted
- **Output hygiene:** if a command would output a lot (tree/context/search), prefer rp-cli redirection inside the command
  string (e.g. `tree > /tmp/rp_tree.txt`) and then read only the small slice you need

---

### Quick Start (Exec Mode)

In `pi`, pass the snippets below as the `cmd` argument to `rp_exec` (these are the contents of `rp-cli -e '<cmd>'`; do not include the `rp-cli -e` prefix).

Exec mode is best for agents. Run a single command:
`tree`

Chain commands (state carries within a single `-e` invocation):
`select set src/ && context --all`

If multiple RepoPrompt windows exist: run `windows` to get IDs, then bind via `rp_bind(windowId, tab)`.

When you prefer pure JSON responses for scripting, automation, `jq` piping, etc., use the `--raw-json` flag to receive raw JSON outputs.

When you need to pass complex/nested args, prefer `call <tool> {json}` inside `rp_exec`; use `rp-cli -e '<command>' --json '{...}'` (or `-j`) only when running `rp-cli` directly.

**Important:** every backticked command below is a RepoPrompt `rp_exec.cmd` string, not a Pi tool

To locate files by name, use `search --mode path` (or `tree`); RepoPrompt has no `find`

For deeper help:
- `rp-cli --help`
- `rp-cli -e 'help'` (canonical in-tool command list)
- `rp-cli -d <tool_name>` or `rp-cli -e 'describe <tool_name>'` (tool schema; examples below)

---

### Commands (What to Use When)

#### Explore the repo
- `tree [path] [--folders] [--mode full|selected]`: quick repo overview
- `search <pattern> [path] [--extensions ...] [--context-lines N]`: locate code/config quickly
- `read <path> [start] [limit]`: read small chunks of a file
- `structure <path> ... [--scope selected]` (alias: `map`): get signatures / “what’s in here?” without loading full files

#### Curate context (essential for task quality)
- `select set <paths...>`: reset selection to just what you need
- `select add/remove/clear/get`: expand/shrink/inspect selection as you go
- `context` (and `context --all`): verify prompt + selection + code (+ files/tree/tokens when needed) before asking questions or editing
- `prompt get/set/append/clear/export/presets`: manage shared prompt; export context; list copy presets

#### Edit safely
- `edit <path> <search> <replace> [--all]`: small, targeted replacements
- Prefer `edit` over bulk rewrites; only use `--all` when you truly mean “every occurrence”

#### Reason with RepoPrompt’s chat
- `chat <message>` (continues; `--new` to start fresh) / `plan <message>` (new plan chat) / `review <message>` (new review chat with git diffs)
- `chats` / `chats log <chat_id>`: browse history
- `models`: list available model presets
- `builder [instructions] [--response-type plan|question|clarify]`: auto-select relevant context (use sparingly)

#### Workspaces / tabs
- `workspace list`: list workspaces
- `workspace switch <name> --new-window`: open workspace in a new window (preferred)
- `workspace switch <name>`: repurpose the current window (only if the user explicitly says it’s safe)
- `workspace create <name> [--switch] [--new-window] [--folder-path <path>]`: create a workspace (prefer `--new-window` when switching)
- `workspace delete <name> [--close-window]`: delete a workspace (optionally close its window)
- `workspace tabs` / `tabs`: list compose tabs
- `workspace tab <name>`: select/bind a compose tab

#### Routing / multi-window / tabs
- `windows` + `use <id>` (or `rp-cli -w <id> ...`): deterministic window targeting when multiple windows exist
- `workspace tabs` + `workspace tab <name>`: deterministic compose-tab targeting

---

### Command Notes

#### `tree`
- Use `tree --folders` first for fast orientation
- Run `tree` with no args first to confirm the current workspace root(s), then use paths relative to those roots (avoid `~` and absolute paths outside the workspace roots)
- Add a `path` only after you know where to look
- If output would be large, redirect it (e.g. `tree --folders > /tmp/rp_tree.txt`) and then read only what you need

#### `search`
- Start broad, then narrow with `--extensions` and/or a sub-path
- Treat patterns as “regex-like”, but don’t assume escape sequences are interpreted: start with a simple substring (e.g. `search "chrome"` not `search "chrome\\."`) and narrow from there
- If `search` returns “0 matches” unexpectedly: first assume wrong workspace/root or selection state; run `tree` (no args) to confirm roots, then try `select clear` and re-run the search
- Prefer redirecting large hit lists to a file and then reading small slices

#### `read`
- Prefer 120–200 line chunks (`read path/to/file 1 160`) over dumping entire files

#### `edit`
- Replacement strings are literal: `\\n` stays backslash+n. Use actual newlines in the replacement text when you need multi-line edits

#### `structure`
- Output is often large; expect truncation and redirect to a file when needed

#### `select` + `context`
- Treat `select set ...` + `context` as your “pre-flight check” before asking questions or editing
- Avoid `context --all` unless you truly need everything at once
- If you need `context --all`, prefer redirecting it to a file instead of injecting it into the model context

---

### Useful Flows (Hotwords)

#### [DISCOVER] (default when context is unclear)
1) Map the repo: `tree`
2) Find likely entrypoints: `search "Auth" src/`
3) Read key files (small chunks): `read path/to/file.py 1 160`
4) Select focused context: `select set src/auth/ && context`
5) Expand via structure: `structure src/auth/`

#### [AGENT] (autonomous implementation loop)
1) Ensure tight selection: `select set … && context`
2) Make minimal edits: `edit path/to/file.py "old" "new" --all` (use `--all` only when intended)
3) Create/move files only when necessary: `file create/delete/move` (use `call file_actions ...` only when you need to set file content)
4) Re-check selection + context after edits: `context`

#### [PAIR] (collaborative planning / second opinion)
1) Curate context first: `select set … && context --all`
2) Ask for a plan: `plan "Propose a safe plan for …"`
3) Apply changes iteratively with `edit` and (when needed) `call <tool_name> {json_args}`

#### [SECOND OPINION] (complex / risky changes)
Use RepoPrompt chat as a reviewer (not an executor):
`plan "Review my approach for … and call out risks"`

### Advanced: Direct Tool Calls (When CLI Commands Aren’t Enough)

Avoid `call` by default in this repo: it requires knowing internal tool names and JSON schemas, which are easy to misuse

If you truly need it:
- Discover tool names: `rp-cli -l` (shell) or `tools --groups`
- Inspect a tool schema: `rp-cli -d <tool_name>` (shell) or `describe <tool_name>`
- Call a tool: `call <tool_name> {json_args}`

Common advanced use case (create a file with specific content) goes through `call` (if you’re unsure, ask for the right tool name first):
`call file_actions {"action":"create","path":"path/to/new.py","content":"..."}`

Routing parameters like `_windowID` / `_tabID` only matter for `call` usage; prefer `-w` and `workspace tab ...` instead

Notes:
- Each `rp_exec` / `rp-cli -e ...` invocation is a fresh connection; rely on chaining (`&&`) for stateful sequences
- If tool/command behavior seems stale after an update, run `refresh` (exec mode) to refresh the tool list, or `snapshot <path>` to record it

---

### Minimal, High-Signal Defaults

- Prefer `tree --folders` for quick orientation
- Prefer `search` before opening large files
- Prefer reading 120–200 lines at a time (e.g., `read path/to/file 1 160`)
- Prefer selecting directories that contain the relevant code, then using `structure some/dir/`
- Avoid `context --all` unless you truly need prompt + selection + code + files + tree + tokens
