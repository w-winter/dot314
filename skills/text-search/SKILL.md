---
disable-model-invocation: true
name: text-search
description: "Search indexed text corpora with qmd. For indexed content, prefer qmd over grep."
---

# text-search

Use qmd to search indexed text corpora such as session logs, notes, docs, and logs. For indexed content, use qmd for discovery instead of raw `grep`.

## First checks

Before searching, confirm what is indexed:

```bash
qmd status
qmd collection list
qmd context list
```

Do not assume collection names, paths, or contexts.

## Core rule

For indexed corpora, use qmd for discovery.

Do **not** use `grep`/`find`/`jq`/`cat` directly on indexed files to search for meaning. This is especially important for session JSONL, which is noisy and hard to interpret raw.

Shell usage is still fine for:
- filtering tool output after discovery
- housekeeping and file targeting
- non-indexed content
- helper scripts in this skill

## Choose the right qmd command

For exact clues, start with `qmd search`.

- Use `qmd search` for exact clues: tool names, error strings, repo names, JSON fields, literal phrases
- Use `qmd query` when lexical search is weak, the request is conceptual, or you want hybrid retrieval + reranking
- Use `qmd vsearch` only when you specifically want pure semantic similarity

```bash
qmd search '"toolName":"rp_exec"'
qmd search 'apply_edits'
qmd query "OAuth redirect flow"
qmd vsearch "the session where we changed direction"
```

Operational notes:
- `qmd query` may trigger local model startup or model downloads, so it is not always the fastest first step
- For session discovery, prefer `--files` first so you get compact path output instead of long snippets

## Build better queries

### Use `--intent` when the request is ambiguous

`intent` is a steering hint. Use it when the same words could refer to multiple things or when the user remembers the topic better than the exact wording.

```bash
qmd query --intent "Pi/Codex/Claude agent sessions about repo editing failures" \
  -c sessions \
  "apply_edits error"
```

### Use structured query documents for important searches

Multi-line query documents are useful when you have both exact clues and fuzzy memory.

- `lex:` exact terms, phrases, identifiers, JSON fields
- `vec:` natural-language meaning
- `hyde:` what the answer likely looked like
- `intent:` optional steering context

```bash
qmd query $'intent: agent sessions about RepoPrompt edits and patch failures
lex: apply_edits rp_exec "search block not found"
vec: debugging failed file edits in agent sessions
hyde: The agent tried to edit a file several times, the edit did not match, and it switched to a narrower or different approach'
```

Operational details:
- The first typed query gets 2x fusion weight, so put the strongest signal first
- `expand:` must stand alone; do not mix it with typed lines
- lex queries support quoted phrases and exclusions such as `-sports` or `-"test data"`

### Useful output and tuning flags

```bash
qmd query --files -n 20 "agent session about flaky tests"
qmd query --json -n 10 "session where we redesigned the search flow"
qmd query --json --explain -c sessions "apply_edits error"
qmd query -C 20 --min-score 0.3 -c sessions "OAuth redirect flow"
```

Use:
- `--files` for compact discovery output and path-based follow-up
- `--json` for structured inspection when you need scores/snippets
- `--explain` when ranking looks wrong
- `-C, --candidate-limit` to reduce reranking work
- `--min-score` to drop weak matches
- `-c, --collection` to scope the search

For session hunting, `--files` is usually the best first output mode.

## Retrieval commands

```bash
qmd get "#abc123"
qmd multi-get "docs/*.md" --json
qmd ls sessions
qmd ls sessions/claude
```

Use `get`, `multi-get`, and `ls` to retrieve or browse content after discovery.

For session logs, use this inspection path:

```bash
qmd get "qmd://sessions/pi/...jsonl" --full | session-view - pi
qmd get "qmd://sessions/codex/...jsonl" --full | session-view - codex
qmd get "qmd://sessions/claude/...jsonl" --full | session-view - claude
```

This is the canonical, reliable path. Do not manually guess filesystem paths from `qmd://` paths.

## If qmd is missing

```bash
npm install -g @tobilu/qmd
qmd --version
qmd status
```

---

# Sessions

Session logs are indexed as the `sessions` collection.

## Required workflow

Use this two-step process:
1. **Discover** candidate sessions with qmd or `analyze-sessions.sh`
2. **Inspect** a chosen session with `session-view`

Do **not** try to understand a session from raw JSONL snippets alone.

## Inspecting `qmd://` session paths

Use one reliable inspection path:

```bash
qmd get "qmd://sessions/pi/users-ww-project/2026-01-20....jsonl" --full | session-view - pi
qmd get "qmd://sessions/codex/2025/10/30/rollout-....jsonl" --full | session-view - codex
qmd get "qmd://sessions/claude/1234....jsonl" --full | session-view - claude
```

Format mapping:
- `qmd://sessions/pi/...` → `session-view - pi`
- `qmd://sessions/codex/...` → `session-view - codex`
- `qmd://sessions/claude/...` → `session-view - claude`

Do not manually guess a filesystem path from a `qmd://` session path.

Filtering rendered output is fine:

```bash
qmd get "qmd://sessions/pi/...jsonl" --full | session-view - pi | grep -iE 'USER:.*(error|bug|regression)'
```

## Session search playbook

### Ask for narrowing clues when memory is vague

If the request is fuzzy, ask for:
- approximate timeframe
- which agent/tool produced the session
- repo or project involved
- remembered phrase, error text, or tool name

After 2-3 bad searches, stop iterating blindly and ask for more context.

### Exact session search

Start here when you have hard clues. Use `--files` first to avoid wasting tokens on snippets. If lexical search returns an obvious hit, inspect it immediately instead of escalating to `query`.

```bash
qmd search -c sessions --files '"toolName":"rp_exec"' -n 20
qmd search -c sessions --files '"isError":true' -n 20
qmd search -c sessions --files '"role":"user"' -n 20
qmd search -c sessions --files 'apply_edits' -n 20
```

If lexical search returns many same-score candidates because the clue is broad or common, do not keep repeating broad lexical searches. Tighten the query with a more distinctive phrase, tool name, error string, or timeframe clue, or switch to `qmd query --intent ...`.

### Escalate when lexical search is weak

Use `query`, add `intent`, and scope to `sessions` when exact search is weak or the request is conceptual. Keep `--files` on unless you specifically need snippets.

```bash
qmd query --intent "Pi/Codex/Claude agent sessions about git trouble during implementation work" \
  -c sessions \
  --files \
  -n 10 \
  "git rebase gone wrong"
```

### Mixed exact + fuzzy session search

```bash
qmd query -c sessions --files $'intent: agent sessions about broken code edits in RepoPrompt workflows
lex: apply_edits rp_exec "oldText" "search block not found"
vec: session where file edits failed repeatedly and the agent had to retry'
```

### Browse after narrowing

```bash
qmd ls sessions
qmd ls sessions/claude
qmd ls sessions/pi
```

## Inspect with `session-view`

`session-view` lives at `~/.pi/agent/skills/text-search/scripts/session-view`.

Use this path:

```bash
qmd get "qmd://sessions/pi/users-ww-project/2026-01-20....jsonl" --full | session-view - pi
qmd get "qmd://sessions/codex/2025/10/30/rollout-2025-10-30t15-36-39-....jsonl" --full | session-view - codex
qmd get "qmd://sessions/claude/1234....jsonl" --full | session-view - claude
```

You can also inspect the latest local session directly:

```bash
session-view --latest pi
session-view --latest codex
session-view --latest claude
```

Rendered output looks like this:

```text
USER: message

A: response text
  [tool_name] key_args

TOOL [name]: ✓ truncated_output
```

## Example workflows

### Find a specific session with hard clues

```bash
# 1. Start with lexical search and compact path output
qmd search -c sessions --files 'git rebase' -n 20

# 2. Inspect a chosen result
qmd get "qmd://sessions/pi/users-ww-dot314/2026-01-21....jsonl" --full | session-view - pi
```

### Escalate when lexical search is weak

```bash
qmd query --intent "Pi/Codex/Claude sessions about git trouble during coding work" \
  -c sessions \
  --files \
  -n 20 \
  "git rebase gone wrong"
```

## Supplemental helper: `analyze-sessions.sh`

Location: `~/.pi/agent/skills/text-search/scripts/analyze-sessions.sh`

Use it for time-windowed or operational reporting rather than ranked corpus search.

```bash
~/.pi/agent/skills/text-search/scripts/analyze-sessions.sh --hours 24 --report
~/.pi/agent/skills/text-search/scripts/analyze-sessions.sh --hours 48 --pattern "apply_edits|rp_exec"
~/.pi/agent/skills/text-search/scripts/analyze-sessions.sh --hours 36 --edit-diagnostics
~/.pi/agent/skills/text-search/scripts/analyze-sessions.sh --hours 48 --tool-errors
~/.pi/agent/skills/text-search/scripts/analyze-sessions.sh --hours 24 --tool-stats
~/.pi/agent/skills/text-search/scripts/analyze-sessions.sh --hours 72 --report --project pi-mono
~/.pi/agent/skills/text-search/scripts/analyze-sessions.sh --hours 72 --tool-stats --tool rp_exec
```

Use qmd for ranked discovery across the corpus. Use `analyze-sessions.sh` for recent-window reports and regex-style operational triage.

## Session JSONL structure reference

Each JSONL line has a `type` field:

| Type | Key fields |
|------|------------|
| `message` | `role`, `content`, `toolCall` |
| `toolResult` | `toolName`, `isError`, `content` |
| `custom` | `customType`, `data` |
```
