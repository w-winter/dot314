# General (Non-Project-Specific) Section

## Tool Usage Guidelines

### RepoPrompt Tooling (Use These First)

- `get_file_tree type="files" [path="…"] [max_depth=2]`: quick project map.
- `get_file_tree type="files" mode="folders" [path="…"] [max_depth=2]`: directories-only overview.
- `get_code_structure paths=["services", "gardener"]`: directory-first overview; prefer directories before individual files.
- `file_search pattern="SystemPromptService" regex=false [mode="both|path|content"] [filter={paths:[…],extensions:[…],exclude:[…]}] [context_lines=5]`: locate symbols fast.
- `read_file path="…" start_line=1 limit=120`: read in small chunks.
- `manage_selection op="get|set|add|remove|clear|preview|promote|demote" [view="summary|files|content|codemaps"]`: actively curate the working set; keep under ~80k tokens.
  - Examples: `manage_selection op="get" view="files"`; `manage_selection op="set" paths=["gardener/analysis","services/shared"]`;
    `manage_selection op="set" slices=[{"path":"services/shared/storage.py","ranges":[{"start_line":1,"end_line":120}]}]`
- `apply_edits`: precise text edits; supports multi-edit and create-on-rewrite.
  - Examples: `apply_edits path="file.py" search="old" replace="new" all=true verbose=true`;
    `apply_edits {"path":"file.py","edits":[{"search":"a","replace":"b"},{"search":"c","replace":"d"}]}`;
    rewrite new file with `on_missing="create"`
- `file_actions`: create, move, or delete files.
  - Examples: `file_actions action="create" path="docs/new.md" content="# Title" if_exists="overwrite"`;
    `file_actions action="move" path="old.py" new_path="src/old.py"`;
    `file_actions action="delete" path="/abs/path/to/file"`
- `context_builder instructions="…" [response_type="plan|question|clarify"]`: run the Context Builder agent to explore the codebase and curate a focused file selection. Omit `response_type` (or use `"clarify"`) for context-only runs; use `"plan"` or `"question"` to also generate a plan or answer. When `response_type` is `"plan"` or `"question"`, it returns a `chat_id` you can reuse with `chat_send` for followup questions on the same curated context.
  - Best used during planning or when preparing a cross-tool/CLI handoff
  - May itself be token-costly, so should be invoked explicitly by me, the user (not automatically), although it may be appropriate to suggest it during planning stages
- `chat_send mode=chat|plan|edit|review [new_chat=true] [chat_name="…"] [selected_paths=[…]] [model="…"]`: plan discussions, second opinions, edits, or diff review.
- `chats action="list|log"`: list sessions or view a chat log.
- `list_models`: enumerate available model presets.
- `list_windows`: list open RepoPrompt windows (IDs for routing).
- `select_window window_id=<id>`: bind this MCP client to a specific window for subsequent calls.
- `workspace_context [include=["prompt","selection","tree"]]`: snapshot of workspace state (defaults include prompt, selection, code, tokens).
- `prompt op=get|set|append|clear|export|list_presets|select_preset`: manage the shared instructions/context; export/share clipboard; manage copy presets.
- `manage_workspaces action="list|switch|create|delete|add_folder|remove_folder|list_tabs|select_tab"`: advanced multi-workspace/multi-window control (supports opening new windows on create/switch, and closing windows on delete).

**(Important: Use the RepoPrompt MCP tools before trying your native tools!)**
  - *With only one exception: when reading Skill files (SKILL.md), use your native shell read tool*.

### MCP Flows & Hotwords

- [DISCOVER]: Use Discover flow to curate context and craft handoff.
`workspace_context` → `get_file_tree` → directory `get_code_structure` → `file_search` → targeted `read_file` → `manage_selection op="set"` → `prompt op="set"`.
  - For large/vague tasks or cross-CLI handoff, you may instead call `context_builder instructions="…" response_type="plan"` (or `"question"`) to run an automated context-building pass. This is token‑costly, so prefer explicit user invocation. Use the returned `chat_id` with `chat_send` (e.g., `chat_send mode="chat" new_chat=false chat_id="…"`) for chained followups on the same curated context.
- [AGENT]: Autonomous edit flow; favor RepoPrompt tools for navigation, reads, and edits.
  - Steps: start with [DISCOVER] if context is unclear; then `apply_edits`/`file_actions` with tight diffs.
- [PAIR]: Collaborative flow; discuss plan, then implement iteratively.
  - Use `chat_send mode=plan` to validate approach; then small, reversible edits.
- Complex or high-risk tasks: trigger a [SECOND OPINION] via `chat_send mode=plan` before applying broad changes.
