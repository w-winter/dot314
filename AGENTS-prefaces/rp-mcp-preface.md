# Tool Protocol

These instructions **override** generic tool guidance for **repo exploration, context building, and file editing** inside Pi.

RepoPrompt MCP is the default for repo-scoped work. Use `rp`:
- **Bind**: `rp({ windows: true })` → `rp({ bind: { window: N, tab: "Compose" } })`
- **Call tools**: `rp({ call: "<tool>", args: { ... } })` (unless explicitly labeled as a Pi native tool)

## Note on native tool disablement (rp-tools-lock)

In some sessions, Pi may automatically disable the native repo-file tools (`read/write/edit/ls/find/grep`) when RepoPrompt is available. If a native tool call is blocked, this is expected—use the RepoPrompt equivalents via `rp` (or disable the lock with `/rp-tools-lock off` only if you explicitly need the native tools).

## Mental Model

RepoPrompt (macOS app) organizes state as:
- **Workspaces** → one or more root folders
- **Windows** → each shows one workspace
- **Compose tabs** → each tab has a prompt + file selection (selection is what chat/review sees)

MCP tools operate directly against this state, but in Pi you invoke them through `rp`. Bind to a specific window (and optionally a compose tab) with `rp({ bind: { window: N, tab: "Compose" } })`, then call tools via `rp({ call: "<tool>", args: { ... } })`.

**Mandatory routing check:** Do not infer availability of any repo of interest from workspace/window titles; workspaces may have more roots available than the title implies. Before any repo-scoped work, confirm the target repo/root is (or isn’t) present by checking workspace roots (e.g. `get_file_tree`). If it’s not confirmed, pause and resolve routing (bind the right window/tab or open the repo).

---

## Workspace Hygiene (Session Start Priority)

When a task involves a repository that isn't loaded in any existing RepoPrompt window:

1. **Do NOT** use `manage_workspaces action="add_folder"` to add unrelated repositories to an existing workspace
2. **Instead**, either:
   - Use `manage_workspaces action="create" name="<repo-name>" folder_path="<path>" open_in_new_window=true`
   - Or **ask the user** which approach they prefer
3. Adding folders to existing workspaces is only appropriate when the folders are **related** (e.g., adding a shared library to a project that uses it)

Rationale: Keep workspaces coherent; mixing unrelated repos clutters selection and context.

---

## Hard Constraints

Do not use bash for: `ls`, `find`, `grep`, `cat`, `wc`, `tree`, or similar file exploration.

Prefer RepoPrompt MCP tools for repo-scoped work. The native repo-file tools (`read/write/edit/ls/find/grep`) may be disabled automatically when RepoPrompt is available.

Never switch workspaces in an existing window unless the user explicitly says it's safe. Switching clobbers selection, prompt, and context. Use `open_in_new_window=true`.

Keep context intentional: select only what you need, prefer codemaps for reference files, use slices when only a portion matters.

---

## Tool Selection by Task

| Task | MCP Tool | Notes |
|------|----------|-------|
| Repo structure | `get_file_tree type="files" [mode="folders"] [path="..."] [max_depth=N]` | gitignore-aware |
| Code search | `file_search pattern="..." [mode="both\|path\|content"] [filter={...}] [context_lines=N]` | regex auto-detected by default |
| API signatures | `get_code_structure paths=["dir/"] [scope="selected"]` | prefer directories first |
| Context curation | `manage_selection op="get\|set\|add\|remove\|clear" [view="summary\|files\|content\|codemaps"]` | selection drives chat |
| Snapshot | `workspace_context [include=["prompt","selection","code","tree","tokens"]]` | verify before chat |
| Reading files | `read_file path="..." [start_line=N] [limit=N]` | 120–200 line chunks |
| Code editing | `apply_edits path="..." search="..." replace="..." [all=true] [verbose=true]` | supports multi-edit, rewrite |
| File ops | `file_actions action="create\|move\|delete" path="..."` | absolute path for delete |
| Planning/review | `chat_send mode="chat\|plan\|edit\|review" [new_chat=true] [chat_name="..."]` | uses selection as context |
| List chats | `chats action="list\|log" [chat_id="..."]` | view sessions or history |
| Model presets | `list_models` | enumerate before chat_send |
| Prompt management | `prompt op="get\|set\|append\|clear\|export\|list_presets\|select_preset"` | manage instructions |
| Window routing | `rp({ windows: true })` then `rp({ bind: { window: N, tab: "Compose" } })` | bind before operating |
| Workspace/tab mgmt | `manage_workspaces action="list\|switch\|create\|delete\|add_folder\|list_tabs\|select_tab"` | see workspace hygiene |
| Auto context | `context_builder instructions="..." [response_type="clarify\|question\|plan\|review"]` | token-costly, invoke explicitly |
| Git operations | `git op="status\|diff\|log\|show\|blame" [compare="..."] [detail="..."]` | worktree support via `main`/`trunk` aliases, `@main:<branch>` |

---

## Paths and roots

Paths may be absolute, `RootName:rel/path`, or unambiguous repo-relative (`rel/path`).
If a relative path could match multiple loaded roots, use `RootName:rel/path`.

Notes:
- `file_search filter.paths` accepts paths *or* a loaded root name (e.g. `"RepoPrompt"`)
- `get_code_structure` line numbers match `read_file` and refresh after edits

## Routing

If results look wrong, assume routing first—not tool failure.

1. `rp({ windows: true })` — list available windows
2. `rp({ bind: { window: N, tab: "Compose" } })` — bind to a window (and optionally a tab)
3. `manage_workspaces action="list_tabs"` — see tabs in that window
4. `manage_workspaces action="select_tab" tab="..."` — pin to a tab
5. `get_file_tree` — confirm workspace roots

RepoPrompt only operates within workspace root folders.

---

## Workflows (Hotwords)

### [DISCOVER] (default when context is unclear)

1. Map the repo: `get_file_tree`
2. Find entrypoints: `file_search pattern="Auth" filter={paths:["src/"]}`
3. Read key files: `read_file path="..." start_line=1 limit=160`
4. Get structure: `get_code_structure paths=["src/auth/"]`
5. Select context: `manage_selection op="set" paths=["src/auth/"]`
6. Verify: `workspace_context`

### [AGENT] (autonomous implementation)

1. Tight selection: `manage_selection op="set" paths=[...]`
2. Minimal edits: `apply_edits` (prefer single replacements)
3. File ops only when needed: `file_actions`
4. Re-verify after edits: `workspace_context`

### [PAIR] (collaborative planning)

1. Curate context: `manage_selection op="set" paths=[...]`
2. Plan: `chat_send mode="plan" message="Propose a safe plan for ..." new_chat=true chat_name="..."`
3. Apply iteratively with `apply_edits`

### [SECOND OPINION] (complex/risky changes)

Use RepoPrompt chat as reviewer:
`chat_send mode="plan" message="Review my approach for ... and call out risks" new_chat=true`

---

## Context Builder

`context_builder instructions="..." [response_type="clarify|question|plan|review"]`

Runs an agent to explore the codebase and curate file selection automatically.

- `response_type="clarify"` (default): Returns context only—for handoff or manual refinement
- `response_type="question"`: Answers using built context, returns `chat_id`
- `response_type="plan"`: Generates implementation plan, returns `chat_id`
- `response_type="review"`: Generates a code review with git diff context, returns `chat_id`

Use returned `chat_id` with `chat_send new_chat=false chat_id="..."` for followup.

Token-costly—invoke explicitly when user requests or during planning phases, not automatically.

---

## Start Here

When the task involves a repository, use `rp` as your toolkit for exploration, reading, editing, and file operations.

1. `rp({ windows: true })`
2. `rp({ bind: { window: N, tab: "Compose" } })`
3. Then use `get_file_tree`, `file_search`, `read_file`, `apply_edits`

Use Pi-native `ls/find/grep/read/edit/write` only when `rp` is unavailable after one retry.

Unexpected output is usually a routing issue—wrong workspace, wrong window, wrong tab—not a tool failure. Check routing before falling back.

---
