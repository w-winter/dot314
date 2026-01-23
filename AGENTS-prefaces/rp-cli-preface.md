# Tool Protocol

The following instructions **override** generic tool guidance for **repo exploration, context building, and file editing** inside Pi.

RepoPrompt (via `rp_exec`) is the default for repo-scoped work because it materially improves context quality and reduces routing mistakes.

Backticked snippets in this doc are either an `rp_exec.cmd` string (what goes after `rp-cli -e`) or a full `rp-cli ...` shell command (explicitly prefixed with `rp-cli`). Pi native tools are explicitly labeled.

## Note on native tool disablement (rp-tools-lock)

Native repo-file tools (`read/write/edit/ls/find/grep`) may be disabled automatically when RepoPrompt is available. If a native tool call is blocked, use the RepoPrompt equivalents (`rp_exec` / `rp-cli`). Disable with `/rp-tools-lock off` only if you explicitly need the native tools.

---

## Mental Model

RepoPrompt (macOS app) organizes state as:
- **Workspaces** → one or more root folders
- **Windows** → each shows one workspace
- **Compose tabs** → each tab has a prompt + file selection (selection is what chat/review sees)

Integration layers:
- **rp-cli** → CLI client talking to the app's MCP server
- **rp_exec** (pi tool) → runs `rp-cli -e <cmd>` with safe defaults
- **rp_bind(windowId, tab)** (pi tool) → pins rp_exec to a specific window + tab

---

## Bind Before Operating

1. `windows`
2. `workspace tabs` (if needed)
3. `rp_bind(windowId, tab)` (usually `"Compose"`)
4. Then use `tree/search/read/select/context/structure/...`

Until bound, only run safe bootstrap commands: `windows`, `workspace list`, `workspace tabs`, `help`, `refresh`, or `workspace switch ... --new-window`.

If output looks wrong (0 matches / wrong files / empty results), check routing first (window/tab/workspace roots).

---

## Hard Constraints

Do not use bash for: `ls`, `find`, `grep`, `cat`, `wc`, `tree`, or similar file exploration.

Prefer `rp_exec` / `rp-cli` for repo-scoped work. The native repo-file tools (`read/write/edit/ls/find/grep`) may be disabled automatically when RepoPrompt is available.

Never switch workspaces in an existing window unless the user explicitly says it's safe. Switching clobbers selection, prompt, and context. Prefer `workspace switch <name> --new-window`.

Keep context intentional: select only what you need, prefer codemaps for reference files, use slices when only a portion matters, avoid `context --all` unless truly needed.

Always use the `questionnaire` tool when asking the user questions. Never embed questions in prose. If your questions involve multiple options, always include an additional "Other" free text option.

---

## Quick Start

Minimal orientation:
```
tree --folders
```

Typical discovery loop:
```
tree
search "Auth" src/
read path/to/file 1 160
select set src/auth/ && context
structure src/auth/
```

Each rp_exec call is a fresh connection. Use `&&` to chain deterministic sequences in one call.

---

## Tool Selection by Task

| Task | Tool | Why |
|------|------|-----|
| Repo structure | rp_exec `tree` | gitignore-aware, fast orientation |
| Code search | rp_exec `search` | extension filtering, context lines |
| API signatures | rp_exec `structure` | token-efficient, no native equivalent |
| Context curation | rp_exec `select`, `context` | selection is the chat/review input |
| Reading repo files | rp_exec `read` | workspace-scoped, supports tail reads |
| Code editing (preferred) | `rp-cli -c apply_edits -j '{...}'` | reliable JSON edits (multiline, multi-edit, rewrite) |
| Code editing (fallback) | pi native `edit` | use when direct rp-cli call mode isn't available |
| File create/move/delete | rp_exec `file create/move/delete` | workspace-aware |
| File creation with content | `rp-cli -c file_actions -j '{...}'` | create files with explicit content |

---

## Reading

### Default: rp_exec read
- `read <path> [start] [limit]` — prefer 120–200 line chunks
- Tail read via negative start: `read path/to/file -20` (last 20 lines)

### Edge case: files containing ``` fences
RepoPrompt output is fenced; rare collision if the file itself contains ``` lines. Workaround: use `rawJson=true` and call `read_file` directly: `read_file path=path/to/file start_line=1 limit=160`

---

## Editing

### Preferred: rp-cli call mode (`apply_edits`)

Use direct tool invocation with JSON args:

`rp-cli -w <id> -t <tab> -c apply_edits -j '{"path":"file.ts","search":"old","replace":"new"}'`

Use this when you need multiline edits, multiple edits in one call, diff previews (`verbose:true`), or full rewrites (`rewrite`).

### Fallback: pi native `edit`

If you can't invoke rp-cli call mode (for example, your harness only exposes `rp_exec` exec mode), use pi native `edit` for changes.

### File creation

Use rp_exec `file create/move/delete` for workspace-aware file ops.

If you need to create a file with full content in one step, call `file_actions` with JSON via rp-cli call mode:
`rp-cli -c file_actions -j '{"action":"create","path":"...","content":"..."}'`

---

## Routing and Multi-window Notes

If results look wrong:

1. Assume routing first (wrong window/tab)
2. `tree` (no args) to confirm workspace roots
3. `workspace tabs` then bind to the correct tab
4. Don't "fix" confusion by switching workspaces in-place

RepoPrompt only operates within workspace root folders. If the repo isn't in any workspace:

```
workspace create Temp --folder-path /abs/path --new-window
```

---

## Output Hygiene

Prefer:
- `tree --folders` for quick orientation
- `read` in 120–200 line chunks
- `structure` for signatures instead of whole-file reads

Redirect large outputs to a file, then read slices:
```
tree --folders > /tmp/rp_tree.txt
search TODO src/ > /tmp/rp_search.txt
read /tmp/rp_search.txt 1 160
```

---

## Fallback Rules

Fall back to pi native tools for repo exploration/reading only if:
1. rp-cli is not installed / not on PATH
2. a specific rp_exec command fails after one retry

For applying code changes, pi native `edit` is an acceptable fallback when rp-cli call mode isn't available.

---

## Useful Flows (Hotwords)

### [DISCOVER] (default when context is unclear)
1) Map the repo: `tree`
2) Find likely entrypoints: `search "Auth" src/`
3) Read key files (small chunks): `read path/to/file.py 1 160`
4) Select focused context: `select set src/auth/ && context`
5) Expand via structure: `structure src/auth/`

### [AGENT] (autonomous implementation loop)
1) Ensure tight selection: `select set … && context`
2) Apply edits (see **Editing** section): preferred `rp-cli -c apply_edits -j '{...}'`; fallback pi native `edit`
3) Create/move files only when necessary: `file create/delete/move` (for file content, use `rp-cli -c file_actions -j '{...}'`)
4) Re-check selection + context after edits: `context`

### [PAIR] (collaborative planning / second opinion)
1) Curate context first: `select set … && context --all` (full context justified for planning here)
2) Ask for a plan: `plan "Propose a safe plan for …"`
3) Apply changes iteratively (see **Editing** section) and re-run `context` after meaningful changes

### [SECOND OPINION] (complex / risky changes)
Use RepoPrompt chat as a reviewer (not an executor):
`plan "Review my approach for … and call out risks"`

---

## Advanced: Direct Tool Calls

Shell-level patterns:
- List tools: `rp-cli -l`
- Describe a tool: `rp-cli -d <tool>`
- Call a tool: `rp-cli -w <id> -t <tab> -c <tool> -j '{"param":"value"}'`

Common calls:
- `rp-cli -c apply_edits -j '{...}'` — complex edits (multi-edit, multiline, rewrite)
- `rp-cli -c file_actions -j '{...}'` — creating files with complex content
- `rp-cli -c git -j '{"op":"diff","detail":"files"}'` — token-efficient git operations

---
