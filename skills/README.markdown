# Skills

## New or locally modified

- ● [`rp-deep-build/`](rp-deep-build/)
  - Goal-driven full build loop: plan (with or without multi-agent critique) → approve → implement (direct or orchestrated) → validate → review → fix until Ship. Rendered from `SKILL.template.md` with configurable planner (`deep`|`build`) and executor (`auto`|`direct`|`orchestrate`).
  - Composes RepoPrompt-managed skills: [`rp-build`](https://github.com/repoprompt/repoprompt-ce/blob/main/Sources/RepoPrompt/Infrastructure/AI/Prompts/Workflows/WorkflowPrompt%2BBuild.swift), [`rp-deep-plan`](https://github.com/repoprompt/repoprompt-ce/blob/main/Sources/RepoPrompt/Infrastructure/AI/Prompts/Workflows/WorkflowPrompt%2BDeepPlan.swift), [`rp-review`](https://github.com/repoprompt/repoprompt-ce/blob/main/Sources/RepoPrompt/Infrastructure/AI/Prompts/Workflows/WorkflowPrompt%2BReview.swift), [`rp-orchestrate`](https://github.com/repoprompt/repoprompt-ce/blob/main/Sources/RepoPrompt/Infrastructure/AI/Prompts/Workflows/WorkflowPrompt%2BOrchestrate.swift)
  - **Requires:** [`pi-codex-goal`](https://github.com/fitchmultz/pi-codex-goal) for durable `create_goal`/`update_goal` tools, and [`skill-templates`](../extensions/skill-templates/) for `SKILL.template.md` rendering

- ● [`repoprompt-tool-guidance-refresh/`](repoprompt-tool-guidance-refresh/)
  - Two-phase workflow for updating RepoPrompt tool guidance across version upgrades:
    1. Invoke **before** upgrading → captures baseline (`rp-cli -l`, `rp-cli --help`)
    2. Invoke **after** upgrading → detects changes, generates diffs, updates docs
  - Contents:
    - [`SKILL.md`](repoprompt-tool-guidance-refresh/SKILL.md)
    - [`scripts/track-rp-version.sh`](repoprompt-tool-guidance-refresh/scripts/track-rp-version.sh) — version detection and diff generation of RepoPrompt MCP tool definitions and of the RepoPrompt CLI
    - [`rp-tool-defs/`](repoprompt-tool-guidance-refresh/rp-tool-defs/) — captured snapshots and diffs
    - [`rp-cli-prompts/`](repoprompt-tool-guidance-refresh/rp-cli-prompts/) — CLI-specific prompts maintained by this skill

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

- ◐ [`dev-browser/`](dev-browser/) (upstream: [SawyerHood/dev-browser](https://github.com/SawyerHood/dev-browser))
  - Browser automation that hooks into a running Chrome via the Dev Browser extension (Playwright-backed, persistent sessions)
  - This version includes a token-efficient CLI wrapper and an extended Skill covering that
    - [`devbrowse`](dev-browser/devbrowse)
    - [`src/cli.ts`](dev-browser/src/cli.ts)
    - [`dev-browser/SKILL.md`](dev-browser/SKILL.md)
  - **Recommendation:** I now prefer [`surf/`](surf/) for browsing and scraping (less setup and more ergonomic for those use cases), and [`agent-browser/`](agent-browser/) for structured web testing

- ○ [`surf/`](surf/) (upstream: [nicobailon/surf-cli](https://github.com/nicobailon/surf-cli))
  - Controls Chrome directly via CLI. Broad feature set: DevTools streaming, network/CPU emulation, AI queries (ChatGPT/Gemini/Perplexity/Grok) in addition to navigation, screenshots, and form filling
  - Requires global install: `npm install -g surf-cli`

- ○ [`agent-browser/`](agent-browser/) (upstream: [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser))
  - Launches its own Playwright browser instance with a ref-based interaction model: snapshot the page to get element refs (`@e1`, `@e2`), then click/fill/assert by ref. Good for repeatable test flows and form automation
  - Requires global install: `npm install -g agent-browser`

## Other skills

- ○ [`gdcli/`](gdcli/) (upstream: [badlogic/pi-skills](https://github.com/badlogic/pi-skills))
  - `SKILL.md`: Google Drive CLI usage

- ◐ [`xcodebuildmcp/`](xcodebuildmcp/) (upstream: [cameroncooke/XcodeBuildMCP](https://github.com/cameroncooke/XcodeBuildMCP))
  - `SKILL.md`: local CLI wrapper for XcodeBuildMCP
  - With CLI for Pi created with [mcporter](https://github.com/steipete/mcporter)
