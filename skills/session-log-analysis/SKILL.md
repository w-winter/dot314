---
name: session-log-analysis
description: Search and analyze pi agent session logs using qmd (local semantic search). Use when asked about past agent behavior, finding examples, debugging issues, or identifying patterns.
---

# Session Log Analysis

Use **qmd** for searching session logs. It's already indexed as the `sessions` collection.

## Quick Start

```bash
# Keyword search (BM25)
qmd search "agent struggled with multiline edit"

# Vector similarity (semantic)
qmd vsearch "database connection timeout issues"

# Hybrid search (best results)
qmd query "how did the agent handle TypeErrors"

# Get full document
qmd get sessions/path-to-file.jsonl --full
```

## Common Queries

```bash
# Find edit failures
qmd search "search block not found"
qmd search "0 edits applied"

# Find agent struggle patterns
qmd search "let me try a different approach"
qmd search "I'll try again"

# Find sessions using specific tools
qmd search '"toolName":"rp_exec"'
qmd search '"toolName":"subagent"'

# Find errors
qmd search '"isError":true'
qmd search "Error:" -n 10

# Find sessions about a topic
qmd query "authentication flow implementation"

# Find sessions in specific project
qmd search "session-selector" --files | grep pi-mono
```

## Options

```bash
-n NUM          # Number of results (default: 5)
--full          # Show full document instead of snippet
--files         # Output file paths only (for piping)
--line-numbers  # Add line numbers to output
--min-score N   # Filter by minimum similarity score
```

## Maintenance

```bash
# Re-index after new sessions
qmd update

# Create/update embeddings for vector search
qmd embed

# Check index status
qmd status
```

## Collection Setup (already done)

```bash
# Sessions are indexed at:
qmd collection add ~/dot314/agent/sessions --name sessions --mask "**/*.jsonl"
```

## When qmd Isn't Enough

For time-based filtering or aggregation, use the helper script:

```bash
# Report for last 24 hours
./analyze-sessions.sh --hours 24 --report

# Edit struggles in last 36 hours
./analyze-sessions.sh --hours 36 --edit-struggles

# Pattern search with time filter
./analyze-sessions.sh --hours 48 --pattern "TypeError"
```

## Session Structure Reference

Each JSONL line has a `type` field:

| Type | Key Fields |
|------|------------|
| `message` | `role`, `content`, `toolCall` |
| `toolResult` | `toolName`, `isError`, `content` |
| `custom` | `customType`, `data` |

Useful search patterns:
- `"role":"user"` — user messages
- `"role":"assistant"` — agent responses  
- `"thinking":"` — agent reasoning
- `"toolName":"X"` — specific tool calls
- `"isError":true` — failures
