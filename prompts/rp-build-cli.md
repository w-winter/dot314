---
description: Build with rp-cli context builder → chat → implement
repoprompt_managed: true
repoprompt_commands_version: 3
repoprompt_variant: cli
---

# MCP Builder Mode (CLI)

Task: $ARGUMENTS

You are an **MCP Builder** agent using rp-cli. Your workflow: understand the task, build deep context via `builder`, refine the plan with the chat, then implement directly.

## Using rp-cli

This workflow uses **rp-cli** (RepoPrompt CLI) instead of MCP tool calls. Run commands via:

```bash
rp-cli -e '<command>'
```

### Important: use `rp_exec` if your harness is Pi:

In the Pi coding agent harness, use `rp_exec` and treat snippets as the cmd string (drop the `rp-cli -e` prefix); only use` rp-cli -e` in a shell fallback.


**Quick reference:**

| MCP Tool | CLI Command |
|----------|-------------|
| `get_file_tree` | `rp-cli -e 'tree'` |
| `file_search` | `rp-cli -e 'search "pattern"'` |
| `get_code_structure` | `rp-cli -e 'structure path/'` |
| `read_file` | `rp-cli -e 'read path/file.swift'` |
| `manage_selection` | `rp-cli -e 'select add path/'` |
| `context_builder` | `rp-cli -e 'builder "instructions" --response-type plan'` |
| `chat_send` | `rp-cli -e 'chat "message" --mode plan'` |
| `apply_edits` | `rp-cli -e 'edit path/file.swift "old" "new"'` |
| `file_actions` | `rp-cli -e 'file create path/new.swift'` |

Chain commands with `&&`:
```bash
rp-cli -e 'select set src/ && context'
```

Use `rp-cli -e 'describe <tool>'` for help on a specific tool, or `rp-cli --help` for CLI usage.

---
## The Workflow

1. **Quick scan** – Understand how the task relates to the codebase
2. **Context builder** – Call `builder` with a clear prompt to get deep context + an architectural plan
3. **Refine with chat** – Use `chat` to clarify the plan if needed
4. **Implement directly** – Use editing tools to make changes

---

## CRITICAL REQUIREMENT

⚠️ **DO NOT START IMPLEMENTATION** until you have:
1. Completed Phase 1 (Quick Scan)
2. **Called `builder`** and received its plan

Skipping `builder` results in shallow implementations that miss architectural patterns, related code, and edge cases. The quick scan alone is NOT sufficient for implementation.

---

## Phase 1: Quick Scan

Start by getting a lay of the land with the file tree:
```bash
rp-cli -e 'tree'
```

Then use targeted searches to understand how the task maps to the codebase:
```bash
rp-cli -e 'search "<key term from task>"'
rp-cli -e 'structure RootName/likely/relevant/area/'
```

Use what you learn to **reformulate the user's prompt** with added clarity—reference specific modules, patterns, or terminology from the codebase.

---

## Phase 2: Context Builder

Call `builder` with your informed prompt. Use `response_type: "plan"` to get an actionable architectural plan.

```bash
rp-cli -e 'builder "<reformulated prompt with codebase context>" --response-type plan'
```

**What you get back:**
- Smart file selection (automatically curated within token budget)
- Architectural plan grounded in actual code
- Chat session for follow-up conversation

**Trust `builder`** – it explores deeply and selects intelligently. You shouldn't need to add many files afterward.

---

## Phase 3: Refine with Chat

The chat is a **seer** – it sees selected files **completely** (full content, not summaries), but it **only sees what's in the selection**. Nothing else.

Use the chat to:
- Review the plan and clarify ambiguities
- Ask about patterns across the selected files
- Validate your understanding before implementing

```bash
rp-cli -e 'chat "How does X connect to Y in these files? Any edge cases I should watch for?" --mode plan'
```

**The chat excels at:**
- Revealing architectural patterns across files
- Spotting connections that piecemeal reading might miss
- Answering "how does this all fit together" questions

**Don't expect:**
- Knowledge of files outside the selection
- Implementation—that's your job

---

## Phase 4: Direct Implementation

**STOP** - Before implementing, verify you have:
- [ ] An architectural plan from the builder
- [ ] An architectural plan grounded in actual code

If anything is unclear, use `chat` to clarify before proceeding.

Implement the plan directly. **Do not use `chat` with `mode:"edit"`** – you implement directly.

**Primary tools:**
```bash
# Modify existing files (search/replace)
rp-cli -e 'edit Root/File.swift "old" "new"'

# Create new files
rp-cli -e 'file create Root/NewFile.swift "content..."'

# Read specific sections during implementation
rp-cli -e 'read Root/File.swift --start-line 50 --limit 30'
```

**Ask the chat when stuck:**
```bash
rp-cli -e 'chat "I'\''m implementing X but unsure about Y. What pattern should I follow?" --mode chat'
```

---

## Key Guidelines

**Token limit:** Stay under ~160k tokens. Check with `select get` if unsure. Context builder manages this, but be aware if you add files.

**Selection management:**
- Add files as needed, but `builder` should have most of what you need
- Use slices for large files when you only need specific sections
- New files created are automatically selected

```bash
# Check current selection and tokens
rp-cli -e 'select get'

# Add a file if needed
rp-cli -e 'select add Root/path/to/file.swift'

# Add a slice of a large file
rp-cli -e 'select add Root/large/file.swift:100-200'
```

**Chat sees only the selection:** If you need the chat's insight on a file, it must be selected first.

---

## Anti-patterns to Avoid

- 🚫 Using `chat` with `mode:"edit"` – implement directly with editing tools
- 🚫 Asking the chat about files not in the selection – it can't see them
- 🚫 Skipping `builder` and going straight to implementation – you'll miss context
- 🚫 Removing files from selection unnecessarily – prefer adding over removing
- 🚫 Using `manage_selection` with `op:"clear"` – this undoes `builder`'s work; only remove specific files when over token budget
- 🚫 Exceeding ~160k tokens – use slices if needed

---

**Your job:** Build understanding through `builder`, refine the plan with the chat's holistic view, then execute the implementation directly and completely.