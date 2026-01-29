---
disable-model-invocation: true
name: text-search
description: "Search indexed text corpora (sessions, docs, logs). Use instead of grep."
---

# text-search

Search indexed text using qmd (BM25 + vectors + hybrid). Better than grep: ranked results, semantic similarity, structured queries.

## What's Already Indexed

| Collection | Contents |
|------------|----------|
| `sessions` | Pi, Codex, and Claude Code session logs |

Sources: `~/.pi/agent/sessions`, `~/.codex/sessions`, `~/.claude/projects`

Check with `qmd status`. Helper scripts in this folder complement qmd searches.

## Reach for qmd Instead of grep When

- Searching anything in an indexed collection
- You want semantic similarity, not just keyword matching
- You need ranked results, not a wall of matches

## Guardrails

**Do not** use `grep`/`find`/`jq`/`cat` directly on indexed files to search content or extract meaning. Use qmd (or collection-specific scripts like `analyze-sessions.sh`) for discovery.

Legitimate shell usage that's fine:
- Piping tool output through grep/head/etc. for filtering
- Using find for file targeting, cleanup, or housekeeping
- Grepping non-indexed files (though consider indexing them)

## Indexing

```bash
# Add a collection (example: markdown docs)
qmd collection add /path --name docs --mask "**/*.md"

# Update index
qmd update

# Status
qmd status
```

## Search

```bash
# BM25 (keyword)
qmd search "query"

# Vector similarity (semantic)
qmd vsearch "query"

# Hybrid (usually best)
qmd query "query"

# Get a snippet (or use --full)
qmd get docs/path.md:10 -l 40
qmd get docs/path.md --full
```

### Useful options

```bash
-n NUM          # Number of results (default: 5)
--full          # Show full document instead of snippet
--files         # Output file paths only (for piping)
--line-numbers  # Add line numbers to output
--min-score N   # Filter by minimum similarity score
```

## Notes

- Embeddings/rerank use Ollama at `OLLAMA_URL` (default `http://localhost:11434`).
- Index lives under `~/.cache/qmd` by default.

---

# Sessions

Session logs are indexed as the `sessions` collection.

## Critical: Pass qmd:// paths directly to session-view

When qmd returns a path like `qmd://sessions/codex/2025/10/30/rollout-....jsonl`, pass it directly:

```bash
# ✓ CORRECT — pass qmd:// path directly
session-view "qmd://sessions/codex/2025/10/30/rollout-2025-10-30t15-36-39-....jsonl"

# ✗ WRONG — do not manually translate to filesystem paths
session-view ~/.pi/agent/sessions/codex/2025/10/30/...  # WILL FAIL - wrong path structure
```

session-view resolves qmd:// paths automatically. Manual path translation will fail because:
- Codex sessions live in `~/.codex/sessions/`, not `~/.pi/agent/sessions/codex/`
- Claude sessions live in `~/.claude/projects/`, not `~/.pi/agent/sessions/claude/`
- Case sensitivity differs between qmd paths and filesystem

## Hard constraint

**Do not** `grep`/`find`/`jq`/`cat` raw session JSONL to search or extract content. The format is nested, encoded, and unreadable — you'll waste cycles and get garbage.

**Do use:**
- `qmd` or `analyze-sessions.sh` → for discovery (finding which sessions match)
- `session-view` → for inspection (pass qmd:// paths directly)

Filtering session-view output is fine and encouraged:
```bash
session-view <path> | grep -iE 'USER:.*(error|bug)'
```

## Two-step workflow

1. **Discover** → find session paths using qmd or analyze-sessions.sh
2. **Inspect** → render with session-view to read actual content

Raw search results are JSONL fragments — timestamps, thinking signatures, encoded metadata. They tell you *which* sessions matched, not *what happened*. You cannot analyze sessions from search snippets alone.

## Before searching: interview when intent is vague

If the user's query is conceptual or imprecise, **ask clarifying questions before searching.** Useful clarifications: approximate timeframe, which tool/CLI produced the session, project or repo context, and any remembered phrases or error messages.

**After 2-3 unsuccessful searches, stop iterating on keywords and ask the user.** They likely have context that will narrow the search dramatically. Don't burn tokens on query variations when a single question could resolve it.

## Step 1: Discover

Two peer tools for different use cases:

**qmd** — when you don't know exact words, want semantic similarity, or need to search across long time ranges:
```bash
qmd search "apply_edits" -n 20          # keyword
qmd vsearch "investigated flaky tests"  # semantic
qmd query "OAuth redirect flow" -n 10   # hybrid (usually best)
```

### Choosing search vs vsearch vs query

| User's query looks like... | Use | Why |
|----------------------------|-----|-----|
| Exact keywords, tool names, error strings, JSON fields | `search` | Precise lexical matching; no embedding needed |
| Conceptual or fuzzy ("the session where I decided to pivot") | `vsearch` | Semantic similarity finds it even without exact words |
| Unclear, or you want both precision and recall | `query` | Hybrid combines lexical + vector ranking |

Default to `query` when unsure, but prefer `vsearch` for conceptual queries and `search` for exact patterns.

**analyze-sessions.sh** — when you know the pattern (regex, tool names, error flags) or want time-windowed operational reports:
```bash
./scripts/analyze-sessions.sh --hours 24 --report
./scripts/analyze-sessions.sh --hours 48 --pattern "error|failed"
./scripts/analyze-sessions.sh --hours 24 --tool-stats
```

Results give you session paths like `qmd://sessions/pi/users-ww-project/2026-01-20....jsonl`

## Step 2: Inspect with session-view

**session-view accepts qmd:// paths directly** — no manual path translation needed:

```bash
# Pass the qmd:// path from search results directly
session-view "qmd://sessions/codex/2025/10/30/rollout-2025-10-30t15-36-39-....jsonl"
session-view "qmd://sessions/pi/users-ww-project/2026-01-20....jsonl"
```

Filesystem paths also work if you already have them (e.g., from `--latest`):
```bash
session-view ~/.pi/agent/sessions/--Users-ww-project--/2026-01-20....jsonl
```

But for qmd search results, always use the qmd:// path directly.

Output:
```
USER: message

A: response text
  [tool_name] key_args

TOOL [name]: ✓ truncated_output
```

Shortcuts:
```bash
session-view --latest pi      # most recent Pi session
session-view --latest codex   # most recent Codex session
session-view --latest claude  # most recent Claude Code session
```

Located at `~/.pi/agent/skills/text-search/scripts/session-view`. Supports Pi, Codex, Claude Code formats (auto-detects from path or qmd:// prefix).

## Example workflow

```bash
# 1. Search
qmd query "git rebase gone wrong" -n 10
# → qmd://sessions/pi/users-ww-dot314/2026-01-21....jsonl

# 2. Read (pass qmd:// path directly)
session-view "qmd://sessions/pi/users-ww-dot314/2026-01-21....jsonl"
```

Both steps, every time. Manual path translation is not needed.

## Field-oriented searches

Structured queries for specific patterns:

```bash
qmd search '"role":"user"' -n 20         # user messages
qmd search '"toolName":"rp_exec"' -n 20  # specific tool usage
qmd search '"isError":true' -n 20        # tool errors
```

These return JSONL fragments — read matches with session-view.

## analyze-sessions.sh reference

Location: `~/.pi/agent/skills/text-search/scripts/analyze-sessions.sh`

Full option set:
```bash
# Report for last 24 hours
./analyze-sessions.sh --hours 24 --report

# Sessions matching a regex pattern (ranked by match count)
./analyze-sessions.sh --hours 48 --pattern "apply_edits|rp_exec"

# Edit-related activity diagnostics
./analyze-sessions.sh --hours 36 --edit-diagnostics

# Tool usage statistics
./analyze-sessions.sh --hours 24 --tool-stats

# Restrict to a project (derived from session path)
./analyze-sessions.sh --hours 72 --report --project pi-mono

# Restrict to sessions that used a specific tool
./analyze-sessions.sh --hours 72 --tool-stats --tool rp_exec
```

## Session JSONL structure (reference)

Each JSONL line has a `type` field:

| Type | Key Fields |
|------|------------|
| `message` | `role`, `content`, `toolCall` |
| `toolResult` | `toolName`, `isError`, `content` |
| `custom` | `customType`, `data` |
```
