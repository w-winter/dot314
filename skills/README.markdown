# Skills

- ● [`rp/`](rp/)
  - Guidance for agents that work in [RepoPrompt](https://repoprompt.com/docs) through the `rp` tool. Once the skill is loaded, the agent uses `rp` instead of shell or built-in file tools to read, search and edit repository files. It covers binding to the right RepoPrompt window and tab, checking that the target repository is one of the workspace's root folders before touching it, keeping unrelated repositories in separate workspaces, picking the RepoPrompt tool for each task, running independent read-only calls in parallel, and using RepoPrompt's Agent Mode, Context Builder and Oracle.
  - **Requires:** the RepoPrompt macOS app and the [`repoprompt-mcp`](../extensions/repoprompt-mcp/) extension, which provides the `rp` tool

- ● [`rp-deep-build/`](rp-deep-build/)
  - Goal-driven full build loop: plan (with or without multi-agent critique) → approve → implement (direct or orchestrated) → validate → review → fix until Ship. Rendered from `SKILL.template.md` with configurable planner (`deep`|`build`) and executor (`auto`|`direct`|`orchestrate`).
  - Composes RepoPrompt-managed skills: [`rp-build`](https://github.com/repoprompt/repoprompt-ce/blob/main/Sources/RepoPrompt/Infrastructure/AI/Prompts/Workflows/WorkflowPrompt%2BBuild.swift), [`rp-deep-plan`](https://github.com/repoprompt/repoprompt-ce/blob/main/Sources/RepoPrompt/Infrastructure/AI/Prompts/Workflows/WorkflowPrompt%2BDeepPlan.swift), [`rp-review`](https://github.com/repoprompt/repoprompt-ce/blob/main/Sources/RepoPrompt/Infrastructure/AI/Prompts/Workflows/WorkflowPrompt%2BReview.swift), [`rp-orchestrate`](https://github.com/repoprompt/repoprompt-ce/blob/main/Sources/RepoPrompt/Infrastructure/AI/Prompts/Workflows/WorkflowPrompt%2BOrchestrate.swift)
  - **Requires:** [`pi-codex-goal`](https://github.com/fitchmultz/pi-codex-goal) for durable `create_goal`/`update_goal` tools, and [`skill-templates`](../extensions/skill-templates/) for `SKILL.template.md` rendering

- ● [`prose-review/`](prose-review/)
  - Post-hoc review of docs, comments, and prompts (user-facing or agent-facing) for the curse-of-knowledge failure mode: models write as if the reader shares their context window, leaking local jargon, plan/changelog language, and orphaned deixis, while omitting definitions and grounding a cold reader needs. Names the intended reader per file, then fixes leakage and omission directly.

- ◐ [`text-search/`](text-search/)
  - Search indexed text corpora (sessions, docs, logs) using qmd. Use instead of grep.
  - Contents:
    - [`SKILL.md`](text-search/SKILL.md)
    - [`scripts/session-view`](text-search/scripts/session-view) — dispatcher for token-lightweight session views (auto-detects format, prose-only by default; opt in to full tool calls/results)
    - [`scripts/analyze-sessions.sh`](text-search/scripts/analyze-sessions.sh) — time-window filtering + aggregation/reporting
    - [`scripts/pi-session-extract-with-tools.py`](text-search/scripts/pi-session-extract-with-tools.py) — extract Pi sessions with tool calls
    - [`scripts/codex-session-extract-with-tools.py`](text-search/scripts/codex-session-extract-with-tools.py) — extract Codex sessions with tool calls
    - [`scripts/claude-session-extract-with-tools.py`](text-search/scripts/claude-session-extract-with-tools.py) — extract Claude Code sessions with tool calls
